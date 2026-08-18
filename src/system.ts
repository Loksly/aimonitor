/**
 * Vitales de la máquina, leídos directamente de `/proc`, `/sys` y `os`.
 *
 * Deliberadamente **no** se usa la API de `trcc`, que también expone sensores:
 * con el bucle de keepalive corriendo esa API sólo atiende los POST de envío de
 * frames, y un GET se queda colgado indefinidamente. Leer ficheros locales
 * cuesta microsegundos y no depende de que el servidor esté sano.
 *
 * Nada de aquí lanza. En un sistema que no sea Linux (o dentro de un contenedor
 * recortado) los campos que no se puedan leer quedan `undefined` y el render
 * sencillamente no los pinta.
 */
import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import type { Config } from './config.ts';
import type { SystemSnapshot } from './types.ts';

/** Contadores acumulados de /proc/stat por núcleo. */
interface CpuSample {
  /** Jiffies totales por núcleo. */
  total: number[];
  /** Jiffies ociosos (idle + iowait) por núcleo. */
  idle: number[];
}

/**
 * Muestra anterior, para poder calcular el uso como delta.
 *
 * /proc/stat da contadores acumulados desde el arranque, así que una sola
 * lectura no dice nada del momento actual: hace falta comparar dos. El daemon
 * es un proceso largo y renderiza al menos una vez por minuto, así que la
 * muestra del render anterior sirve de referencia.
 */
let previous: CpuSample | null = null;

/** Reinicia el estado entre pruebas. */
export function resetCpuSampling(): void {
  previous = null;
}

function readCpuSample(): CpuSample | null {
  try {
    const total: number[] = [];
    const idle: number[] = [];
    for (const line of readFileSync('/proc/stat', 'utf8').split('\n')) {
      if (!/^cpu\d+ /.test(line)) continue;
      const n = line.trim().split(/\s+/).slice(1).map(Number);
      // Campos: user nice system idle iowait irq softirq steal ...
      total.push(n.reduce((a, b) => a + b, 0));
      idle.push((n[3] ?? 0) + (n[4] ?? 0));
    }
    return total.length ? { total, idle } : null;
  } catch {
    return null;
  }
}

/** Temperatura del paquete de CPU. Se prefiere `x86_pkg_temp`, que es la real. */
function readCpuTemp(): number | undefined {
  const preferred = ['x86_pkg_temp', 'coretemp'];
  let fallback: number | undefined;
  try {
    for (const zone of readdirSync('/sys/class/thermal')) {
      if (!zone.startsWith('thermal_zone')) continue;
      const base = `/sys/class/thermal/${zone}`;
      let type: string;
      let milli: number;
      try {
        type = readFileSync(`${base}/type`, 'utf8').trim();
        milli = Number(readFileSync(`${base}/temp`, 'utf8'));
      } catch {
        continue;
      }
      if (!Number.isFinite(milli)) continue;
      const celsius = milli / 1000;
      if (preferred.includes(type)) return celsius;
      // `acpitz` suele marcar la caja, no el die: sólo vale si no hay nada mejor.
      fallback ??= celsius;
    }
  } catch {
    return undefined;
  }
  return fallback;
}

function readDisk(path: string): SystemSnapshot['disk'] {
  try {
    const s = statfsSync(path);
    const total = Number(s.blocks) * Number(s.bsize);
    // `bavail` es lo libre para un usuario normal, que es lo que de verdad
    // queda; `bfree` incluye la reserva de root y engaña al alza.
    const free = Number(s.bavail) * Number(s.bsize);
    if (!Number.isFinite(total) || total <= 0) return undefined;
    return { used: total - free, total, path };
  } catch {
    return undefined;
  }
}

/**
 * Espera bloqueante corta. Sólo para el modo `--preview`, que es un disparo
 * único: sin una segunda muestra de /proc/stat no habría delta y el frame
 * saldría sin uso por núcleo, que es justo lo que se quiere enseñar.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface ReadOptions {
  /**
   * Si no hay muestra previa, tomar una segunda tras una pausa corta en lugar
   * de renunciar al uso por núcleo. El daemon NO lo usa: sus renders sucesivos
   * ya dan el delta gratis y bloquear el frame sería peor.
   */
  blockingSample?: boolean;
}

export function readSystem(cfg: Config, opts: ReadOptions = {}): SystemSnapshot {
  const snap: SystemSnapshot = {};

  snap.cpuTemp = readCpuTemp();

  const cores = cpus().length || 1;
  snap.load = loadavg()[0]! / cores;
  snap.uptime = uptime();

  const total = totalmem();
  snap.mem = { used: total - freemem(), total };
  snap.disk = readDisk(cfg.system.diskPath);

  if (opts.blockingSample && !previous) {
    previous = readCpuSample();
    if (previous) sleepSync(120);
  }

  const sample = readCpuSample();
  if (sample) {
    if (previous && previous.total.length === sample.total.length) {
      const per: number[] = [];
      for (let i = 0; i < sample.total.length; i++) {
        const dTotal = sample.total[i]! - previous.total[i]!;
        const dIdle = sample.idle[i]! - previous.idle[i]!;
        // Sin tiempo transcurrido no hay tasa que calcular.
        per.push(dTotal > 0 ? Math.min(1, Math.max(0, 1 - dIdle / dTotal)) : 0);
      }
      snap.cores = per;
      snap.cpuUsage = per.reduce((a, b) => a + b, 0) / per.length;
    }
    previous = sample;
  }

  // Primer render: todavía no hay delta, así que no hay uso por núcleo. Se deja
  // `cores` sin definir (el render omite esas barras) y se estima el uso global
  // con la carga, que sí es un valor absoluto.
  snap.cpuUsage ??= Math.min(1, snap.load);

  return snap;
}
