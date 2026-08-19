#!/usr/bin/env node
/**
 * Daemon principal para aimonitor.
 * Vigila el directorio ~/.aimonitor/sessions/, actualiza estados de git,
 * consulta periódicamente el consumo con ccusage y renderiza frames hacia trcc.
 */
import { watch, readdirSync, readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, meetingState, SESSIONS_DIR, type Config } from './config.ts';
import { fetchUsage } from './usage.ts';
import { renderFrame } from './render.ts';
import { readSystem } from './system.ts';
import { nextMeeting } from './calendar.ts';
import { buildPlayable, isDue, play, seedFor } from './easteregg.ts';
import { pruneZombies } from './select.ts';
import { serverAlive, detectPanel, connectPanel, sendFrame, pinFrame } from './panel.ts';
import type { Meeting, SessionRecord, UsageSnapshot } from './types.ts';

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
async function sendOrThrow(png: Buffer): Promise<void> {
  const key = config.trcc.deviceKey;
  if (!key) throw new Error('no hay ningún panel detectado');
  try {
    await sendFrame(config, key, png);
    return;
  } catch {
    // Un replug del USB o un reinicio de `trcc serve` dejan al servidor sin el
    // dispositivo abierto: entonces guarda el tema pero no pinta nada. Se
    // reabre y se reintenta una vez, que es lo que hace falta para que el panel
    // se recupere solo en vez de quedarse en el logo hasta que alguien mire.
  }
  await connectPanel(config, key);
  await sendFrame(config, key, png);
  console.log('Panel reconectado.');
}

async function sendToPanel(png: Buffer): Promise<void> {
  try {
    await sendOrThrow(png);
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

/** Próxima reunión conocida, en crudo; se refresca en segundo plano. */
let meeting: Meeting | null = null;
let lastMeetingFetch = 0;
let meetingInFlight = false;

/**
 * Refresca la próxima reunión sin bloquear el frame. La descarga del ICS son
 * ~350 KB y va por red: esperarla aquí retrasaría el repintado.
 */
function maybeRefreshMeeting(now: number): void {
  if (!config.calendar.enabled || meetingInFlight) return;
  if (now - lastMeetingFetch <= config.calendar.refreshMs) return;
  meetingInFlight = true;
  nextMeeting(config, now)
    .then((m) => {
      meeting = m;
      triggerRender();
    })
    .catch((err) => warnOnce(`no se pudo leer el calendario: ${err instanceof Error ? err.message : err}`))
    .finally(() => {
      lastMeetingFetch = Date.now();
      meetingInFlight = false;
    });
}

/**
 * Convierte la reunión en una casilla más. Va como `SessionRecord` a propósito:
 * así hereda el orden, el reparto de anchos y los pesos visuales sin duplicar
 * nada de esa lógica.
 */
function toRecord(m: Meeting, now: number): SessionRecord {
  const minutesLeft = (m.startsAt - now) / 60_000;
  const cfgCal = config.calendar;
  const hide = m.private || !cfgCal.showTitle;
  const title = hide ? 'Reunión' : m.title || 'Reunión';
  return {
    session_id: `meeting-${m.startsAt}`,
    provider: 'claude',
    state: meetingState(minutesLeft, cfgCal.minutes),
    detail: m.tentative ? 'provisional' : '',
    project: title.length > cfgCal.titleMaxChars ? `${title.slice(0, cfgCal.titleMaxChars - 1)}…` : title,
    since: m.startsAt,
    updated: now,
    event: 'Meeting',
    startsAt: m.startsAt,
  };
}

/**
 * Guiño: cada cuarto de hora el panel se toma un descanso.
 *
 * `null` hasta el primer chequeo, que sólo sirve para fijar la franja actual:
 * arrancar el daemon no debe disparar la animación de golpe.
 */
let lastEggAt: number | null = null;
let eggPlaying = false;

/** ¿Hay algo reclamando al operador? Entonces no es momento de ponerse a jugar. */
function operatorBusy(sessions: SessionRecord[], now: number): boolean {
  if (sessions.some((r) => r.state === 'permiso' || r.state === 'espera')) return true;
  // Una reunión ya coloreada tampoco se tapa: es justo lo que hay que ver.
  if (meeting && meeting.endsAt > now && meeting.startsAt - now < config.calendar.minutes.grey * 60_000) return true;
  return false;
}

async function maybePlayEasterEgg(): Promise<void> {
  if (eggPlaying || previewPath || !detected) return;
  const now = Date.now();
  if (lastEggAt === null) {
    lastEggAt = now;
    return;
  }
  if (!isDue(config, now, lastEggAt)) return;

  // A partir de aquí toca de verdad, así que ya se puede pagar el leer las
  // sesiones: esto ocurre una vez por franja, no en cada chequeo.
  const sessions = reapDead(await loadSessions(), now);
  if (config.easterEgg.skipWhenBusy && operatorBusy(sessions, now)) {
    // Se marca la franja igualmente: si no, reintentaría cada pocos segundos
    // durante los quince minutos siguientes.
    lastEggAt = now;
    console.log('Guiño aplazado: hay algo esperando en el panel.');
    return;
  }

  await playEasterEgg(seedFor(config, now));
}

/** Reproduce una pasada, pase lo que pase. Las condiciones las mira quien llama. */
async function playEasterEgg(seed: number, restoreAfter = true): Promise<void> {
  eggPlaying = true;
  try {
    const playable = await buildPlayable(config, config.width, config.height, seed);
    console.log(`Guiño: ${playable.label} — ${playable.count} frames a ${config.easterEgg.fps} fps.`);
    // El keepalive posee el USB y compite con el envío de frames. A la
    // velocidad de la animación no hace falta: el firmware no llega a los
    // ~2-3 s de abandono que le hacen volver al logo.
    unpin?.();
    unpin = null;
    const stats = await play(playable, config.easterEgg.fps, sendOrThrow);
    console.log(`Guiño terminado: ${stats.sent} frames, ${stats.dropped} descartados, ${(stats.ms / 1000).toFixed(1)}s.`);
  } catch (err) {
    warnOnce(`no se pudo pintar el guiño: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    eggPlaying = false;
    lastEggAt = Date.now();
    // Devuelve el cuadro de mando y, con él, el keepalive. En el disparo manual
    // no: se sale acto seguido, y arrancar un keepalive para abandonarlo deja
    // al servidor ocupado justo cuando vuelve el servicio de verdad.
    if (restoreAfter) triggerRender();
  }
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
/**
 * `--guino [n]` reproduce n pasadas y sale, para probar clips sin esperar al
 * cuarto de hora. Hay que parar el servicio antes: el keepalive del daemon en
 * marcha posee el USB y se pelearía con los frames de la animación.
 */
const eggIndex = args.indexOf('--guino');
const eggOnce = eggIndex !== -1;
const eggCount = Math.max(1, Number(args[eggIndex + 1]) || 1);

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

/**
 * Poda las sesiones muertas y **borra su fichero**.
 *
 * Ignorarlas bastaría para pintar bien, pero entonces se acumulan en
 * `~/.aimonitor/sessions/` para siempre y cada frame paga un `git status` por
 * cada cadáver. Borrar es seguro: si la sesión resucita, el siguiente evento
 * del hook vuelve a crear el fichero.
 */
function reapDead(sessions: SessionRecord[], now: number): SessionRecord[] {
  const vivas = pruneZombies(sessions, now, config.zombieMs, config.staleMs);
  if (vivas.length === sessions.length) return vivas;
  const supervivientes = new Set(vivas.map((r) => r.session_id));
  for (const r of sessions) {
    if (supervivientes.has(r.session_id)) continue;
    try {
      rmSync(join(SESSIONS_DIR, `${r.session_id}.json`), { force: true });
      console.log(`Sesión huérfana descartada: ${r.project} (${r.state}, sin señales desde hace ${Math.round((now - r.updated) / 60_000)} min).`);
    } catch {
      // Si no se puede borrar, con haberla filtrado ya se pinta bien.
    }
  }
  return vivas;
}

/** Renderiza y envía el frame */
async function renderAndSend() {
  // Mientras corre el guiño el panel es suyo. Al terminar se pide un
  // repintado, así que no se pierde nada de lo que haya pasado entretanto.
  if (eggPlaying) return;
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
    const sessions = reapDead(await loadSessions(), now);

    // La reunión se recalcula en cada frame a partir del instante guardado: su
    // color depende de lo que falte, así que tiene que ir subiendo de tono
    // aunque no haya llegado ningún dato nuevo del calendario.
    if (previewPath) {
      // Se avisa en vez de tragarse el error: si el calendario está activado y
      // falta la dependencia opcional, quedarse callado deja al usuario sin
      // reunión y sin saber por qué.
      const m = await nextMeeting(config, now).catch((err) => {
        warnOnce(`no se pudo leer el calendario: ${err instanceof Error ? err.message : err}`);
        return null;
      });
      if (m) sessions.push(toRecord(m, now));
    } else {
      maybeRefreshMeeting(now);
      // Se descarta al terminar: una reunión pasada ya no reclama nada.
      if (meeting && meeting.endsAt > now) sessions.push(toRecord(meeting, now));
    }

    // Renderizar frame. Los vitales se leen aquí, en cada frame: son lecturas de
    // ficheros locales (microsegundos) y así el uso de CPU refleja el intervalo
    // real entre renders.
    const pngBuffer = renderFrame({
      sessions,
      usage: currentUsage,
      system: readSystem(config, { blockingSample: Boolean(previewPath) }),
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

  if (eggOnce) {
    if (!detected) {
      console.error('No hay panel: ¿está `trcc serve` levantado y el aimonitor.service parado?');
      process.exit(1);
    }
    // Semillas consecutivas: dentro de una misma franja horaria `seedFor`
    // devuelve siempre lo mismo, así que sin el desplazamiento saldría el
    // mismo clip n veces seguidas.
    const base = seedFor(config, Date.now());
    for (let i = 0; i < eggCount; i++) await playEasterEgg(base + i, false);
    process.exit(0);
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

  // El guiño se comprueba más a menudo que el repintado: con `everyMs` de 15
  // minutos hay que mirar con bastante más frecuencia que la franja para no
  // entrar tarde en ella.
  const eggTimer = setInterval(() => void maybePlayEasterEgg(), 5000);

  // Manejo de salida limpia para apagar pantalla si procede
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Deteniendo daemon y limpiando recursos...');
    watcher.close();
    clearInterval(timer);
    clearInterval(eggTimer);

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
