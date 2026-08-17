#!/usr/bin/env node
/**
 * Daemon principal para aimonitor.
 * Vigila el directorio ~/.aimonitor/sessions/, actualiza estados de git,
 * consulta periódicamente el consumo con ccusage y renderiza frames hacia trcc.
 */
import { watch, readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, SESSIONS_DIR, type Config } from './config.ts';
import { fetchUsage } from './usage.ts';
import { renderFrame } from './render.ts';
import { serverAlive, detectPanel, connectPanel, sendFrame, pinFrame } from './panel.ts';
import type { SessionRecord, UsageSnapshot } from './types.ts';

const execAsync = promisify(exec);

// Variables de estado
let config = loadConfig();
let currentUsage: UsageSnapshot | null = null;
let lastUsageFetch = 0;
let isRendering = false;
let pendingRender = false;
/** Última causa de fallo de `trcc`, para no repetir el mismo aviso cada minuto. */
let lastSendError = '';
/** Lo que reportó el servidor sobre el panel; manda sobre la config del fichero. */
let detected: { key: string; width: number; height: number } | null = null;
/** Corta el bucle de keepalive. Null mientras no se haya llegado a arrancar. */
let unpin: (() => void) | null = null;

/**
 * Detecta el panel, reintentando en cada frame hasta conseguirlo.
 *
 * No se puede detectar una sola vez al arrancar: al iniciar sesión systemd
 * levanta este daemon y `trcc serve` a la vez, y uvicorn tarda ~10 s en
 * escuchar. `Wants=`/`After=` ordenan el arranque, no la *disponibilidad*, así
 * que la primera detección casi siempre llega demasiado pronto. Si eso fuera
 * definitivo, el panel se quedaría en el logo hasta que alguien reiniciara el
 * servicio a mano.
 */
async function ensurePanel(): Promise<boolean> {
  if (detected) return true;
  const panel = await detectPanel(config);
  if (!panel) return false;
  detected = panel;
  refreshConfig();
  console.log(`Panel detectado: ${panel.key} a ${panel.width}x${panel.height}`);
  return true;
}

/**
 * Arranca el reenvío que mantiene la imagen fija. Idempotente, y sólo se llama
 * tras un envío correcto: el servidor responde 400 si se le pide keepalive sin
 * ningún frame en caché.
 */
function startPinning(): void {
  if (unpin || !config.trcc.keepalive.enabled || !config.trcc.deviceKey) return;
  unpin = pinFrame(config, config.trcc.deviceKey, (msg) => warnOnce(msg));
  console.log(`Imagen fijada: reenvío cada ${config.trcc.keepalive.intervalS}s (el firmware LY la descarta a los ~2-3s)`);
}

/**
 * Recarga config.json y vuelve a imponer lo detectado por hardware. La config
 * se relee en cada frame para poder tocarla en caliente, así que la detección
 * tiene que reaplicarse o el fichero la pisaría.
 */
function refreshConfig(): void {
  config = loadConfig();
  if (detected) {
    config.width = detected.width;
    config.height = detected.height;
    config.trcc.deviceKey = detected.key;
  }
}

/**
 * Envía el PNG al panel a través de la API de `trcc serve`.
 *
 * No se invoca la CLI: el USB es de acceso exclusivo y el bucle de keepalive
 * que mantiene la imagen fija ya tiene el dispositivo abierto. Un `trcc display
 * send-image` desde fuera fallaría con "interface is in use by another
 * process". Ver src/panel.ts.
 */
async function sendToPanel(png: Buffer): Promise<void> {
  const key = config.trcc.deviceKey;
  if (!key) {
    warnOnce('No hay panel detectado: no se envía el frame.');
    return;
  }
  try {
    await sendFrame(config, key, png);
    lastSendError = '';
    startPinning();
    return;
  } catch {
    // Un replug del USB o un reinicio de `trcc serve` dejan al servidor sin el
    // dispositivo abierto: entonces guarda el tema pero no pinta nada. Se
    // reabre y se reintenta una vez, que es lo que hace falta para que el panel
    // se recupere solo en vez de quedarse en el logo hasta que alguien mire.
  }
  try {
    await connectPanel(config, key);
    await sendFrame(config, key, png);
    console.log('Panel reconectado.');
    lastSendError = '';
    startPinning();
  } catch (err) {
    warnOnce(`No se pudo enviar el frame al panel: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Evita repetir el mismo aviso en cada tick del reloj. */
function warnOnce(message: string): void {
  if (message === lastSendError) return;
  lastSendError = message;
  console.warn(`Advertencia: ${message}`);
}

/** Hay una consulta a `ccusage` en vuelo; no se lanzan dos a la vez. */
let usageInFlight = false;

/**
 * Lanza el refresco de consumo sin bloquear el frame. Cuando llega el dato
 * nuevo se pide un redibujado, que es lo que exige el diseño: repintar cuando
 * algo cambia, no a N fps.
 */
function maybeRefreshUsage(now: number): void {
  if (usageInFlight) return;
  if (currentUsage && now - lastUsageFetch <= config.usage.refreshMs) return;
  usageInFlight = true;
  fetchUsage(config)
    .then((snap) => {
      currentUsage = snap;
      triggerRender();
    })
    .catch((err) => {
      console.warn('Advertencia: no se pudo leer el consumo:', err instanceof Error ? err.message : err);
    })
    .finally(() => {
      // Se marca al terminar, no al empezar: así el periodo cuenta desde que
      // hay dato y una consulta lenta no se relanza en bucle.
      lastUsageFetch = Date.now();
      usageInFlight = false;
    });
}

// Comprobar argumentos CLI
const args = process.argv.slice(2);
const previewIndex = args.indexOf('--preview');
const previewPath = previewIndex !== -1 ? args[previewIndex + 1] : null;

/** Ejecuta git status --porcelain en el cwd de la sesión para rellenar la propiedad dirty */
async function getGitDirtyCount(cwd: string): Promise<number | undefined> {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd, timeout: 2000 });
    const lines = stdout.trim().split('\n').filter(line => line.trim().length > 0);
    return lines.length;
  } catch {
    return undefined; // No es un repositorio de git o ha fallado
  }
}

/** Lee todas las sesiones activas en ~/.claude-lcd/sessions/ */
async function loadSessions(): Promise<SessionRecord[]> {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    return [];
  }

  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const list: SessionRecord[] = [];

  for (const file of files) {
    const filepath = join(SESSIONS_DIR, file);
    try {
      const content = readFileSync(filepath, 'utf8');
      const rec = JSON.parse(content) as SessionRecord;
      
      // Intentar actualizar el contador de git de forma asíncrona pero sin bloquear la carga inicial
      if (rec.cwd && existsSync(rec.cwd)) {
        rec.dirty = await getGitDirtyCount(rec.cwd);
      }
      list.push(rec);
    } catch {
      // Ignorar archivos corruptos o ilegibles
    }
  }

  return list;
}

/** Renderiza y envía el frame */
async function renderAndSend() {
  if (isRendering) {
    pendingRender = true;
    return;
  }
  isRendering = true;

  try {
    // Recargar config por si ha cambiado config.json
    refreshConfig();

    // Refrescar consumo en segundo plano. `ccusage` tarda varios segundos en
    // recorrer los JSONL, y esperarlo aquí retrasaría el frame justo cuando una
    // sesión acaba de pedir permiso. El carril se pinta con el último dato
    // conocido y se redibuja solo cuando llega uno nuevo.
    const now = Date.now();
    // Reintento barato (un GET) mientras no haya panel: cubre el arranque en
    // frío, un `trcc serve` reiniciado y el panel enchufado en caliente.
    if (!previewPath && !detected) await ensurePanel();

    if (previewPath) {
      // El preview es un disparo único y sale en cuanto escribe el PNG, así que
      // aquí sí hay que esperar el dato o el carril saldría vacío.
      currentUsage = await fetchUsage(config).catch(() => null);
    } else {
      maybeRefreshUsage(now);
    }

    // Leer sesiones actuales y resolver git
    const sessions = await loadSessions();

    // Renderizar frame
    const pngBuffer = renderFrame({
      sessions,
      usage: currentUsage,
      config,
      now,
    });

    if (previewPath) {
      // Si estamos en modo de un solo preview, escribir el archivo y salir
      writeFileSync(previewPath, pngBuffer);
      console.log(`[Preview] Frame renderizado con éxito en ${previewPath}`);
      process.exit(0);
    } else {
      await sendToPanel(pngBuffer);
    }
  } catch (err) {
    console.error('Error crítico en el renderizado del daemon:', err);
  } finally {
    isRendering = false;
    if (pendingRender) {
      pendingRender = false;
      // Esperar un instante antes de procesar el render pendiente
      setTimeout(renderAndSend, 100);
    }
  }
}

// Debounce para agrupar múltiples eventos de fs en ráfagas
let debounceTimeout: NodeJS.Timeout | null = null;
function triggerRender() {
  if (debounceTimeout) clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(renderAndSend, 150);
}

async function start() {
  console.log('Iniciando daemon de aimonitor...');

  // Asegurar directorios
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  // El renderizado debe derivar de la resolución que reporte el panel, no de una
  // constante. En modo preview no se pregunta al hardware: no hace falta.
  if (!previewPath) {
    // Esperar a que `trcc serve` escuche. Al iniciar sesión arrancan los dos a
    // la vez y uvicorn tarda unos segundos; sin esta espera el primer frame se
    // retrasaría hasta el siguiente tick del reloj.
    for (let i = 0; i < 30 && !(await serverAlive(config)); i++) {
      if (i === 0) console.log(`Esperando a \`trcc serve\` en ${config.trcc.api.url}...`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!(await serverAlive(config))) {
      console.warn(
        `Advertencia: no hay ningún \`trcc serve\` escuchando en ${config.trcc.api.url}.\n` +
          `  El panel necesita un proceso que posea el USB y reenvíe el frame cada ${config.trcc.keepalive.intervalS}s,\n` +
          `  o el firmware LY vuelve al logo de fábrica a los 2-3 segundos.\n` +
          `  Arráncalo con:  systemctl --user start trcc-serve.service\n` +
          `  Se seguirá reintentando en cada ciclo.`,
      );
    }

    // El dispositivo NO se abre aquí. `/connect` no es idempotente: si el
    // servidor ya lo tenía abierto responde "interface is in use" y, de paso,
    // deja inservible la conexión anterior. Se abre sólo cuando un envío falla
    // (ver sendToPanel), que es justo cuando de verdad hace falta.
    if (!(await ensurePanel())) {
      console.warn(
        `Advertencia: todavía no hay panel. Se renderiza a ${config.width}x${config.height} ` +
          `y se reintenta la detección en cada ciclo.`,
      );
    }
  }

  // Primer render inmediato
  await renderAndSend();

  if (previewPath) {
    // En modo preview, ya habremos salido en renderAndSend
    return;
  }

  // El keepalive lo arranca `startPinning()` tras el primer envío correcto: el
  // bucle reenvía "el último frame" y el servidor responde 400 si aún no hay
  // ninguno en caché.

  // Escuchar cambios en la carpeta de sesiones
  console.log(`Vigilando cambios en: ${SESSIONS_DIR}`);
  const watcher = watch(SESSIONS_DIR, (eventType, filename) => {
    if (filename && filename.endsWith('.json')) {
      triggerRender();
    }
  });

  // Intervalo periódico cada minuto (para reloj, pixel shift, zombis y ccusage)
  const timer = setInterval(() => {
    triggerRender();
  }, 60000);

  // Manejo de salida limpia para apagar pantalla si procede
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Deteniendo daemon y limpiando recursos...');
    watcher.close();
    clearInterval(timer);

    // Apagar panel en reposo si blankWhenIdle está habilitado: lo que se gasta
    // con las horas es el backlight, así que al salir se deja a negro. El
    // keepalive sigue vivo mientras tanto para que el negro se quede fijo en
    // lugar de volver al logo; se corta justo después.
    if (config.blankWhenIdle) {
      try {
        const canvas = renderFrame({ sessions: [], config, now: Date.now() });
        await sendToPanel(canvas);
      } catch {}
    }
    unpin?.();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

start().catch(err => {
  console.error('Error iniciando el daemon:', err);
  process.exit(1);
});
