/**
 * El guiño: cada cierto rato el panel deja el cuadro de mando y pone una
 * animación de plataformas.
 *
 * Dos fuentes posibles:
 *
 *   - Sin configurar nada, la animación dibujada en `src/platformer.ts`.
 *   - `easterEgg.source` apuntando a un vídeo o GIF local, o a un **directorio**
 *     de clips del que se elige uno distinto cada vez. Se despiezan con
 *     `ffmpeg`.
 *
 * Lo segundo existe porque la respuesta a "¿y no puede salir el Mario de
 * verdad?" es que los sprites de Nintendo no pueden viajar dentro de un
 * paquete publicado en npm. Un fichero en tu propio disco es otra cosa, así
 * que el guiño acepta que le pongas el tuyo.
 *
 * Aviso de rendimiento: el bus del panel comprime cada frame, así que el
 * contenido decide los fps. Medido a 1920x462: arte plano ~83 KB por frame y
 * 12 fps; imagen fotográfica ~517 KB y 5 fps. Un clip grabado se arrastra.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { STATE_DIR, type Config } from './config.ts';
import { animation, fateFor } from './platformer.ts';

const execFileAsync = promisify(execFile);

const CACHE_DIR = join(STATE_DIR, 'easteregg');

/** Contenedores que `ffmpeg` sabe abrir y que tiene sentido poner aquí. */
const VIDEO_EXT = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.gif'];

/**
 * Elige un clip del directorio.
 *
 * La semilla es el número de franja horaria, pero no se usa tal cual: `slot %
 * n` recorre los ficheros siempre en el mismo orden, y con un directorio
 * pequeño acabas viendo el mismo clip a la misma hora todos los días. Un
 * revuelto barato rompe ese patrón sin renunciar a ser determinista.
 */
export function pickClip(files: string[], seed: number): string {
  // Finalizador de MurmurHash3. Una sola multiplicación no reparte: con tres
  // clips daba «b c b c b c» y el primero no salía jamás.
  let h = seed >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return files[(h >>> 0) % files.length]!;
}

/** Tamaño y cadencia del vídeo: hacen falta los dos para no introducir tirones. */
async function probeStream(src: string): Promise<{ w: number; h: number; fps: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate',
        '-of', 'csv=p=0:s=x',
        src,
      ],
      { timeout: 15_000 },
    );
    const [w = 0, h = 0, rate = ''] = stdout.trim().split('x');
    const [num = 0, den = 1] = String(rate).split('/').map(Number);
    const fps = den ? num / den : 0;
    return Number(w) > 0 && Number(h) > 0 ? { w: Number(w), h: Number(h), fps } : null;
  } catch {
    return null;
  }
}

/**
 * Cadencia a la que se despieza, y aviso si va a temblar.
 *
 * El origen tiene que ser un **múltiplo entero** de lo que se reproduce. Si no,
 * ffmpeg reparte los descartes de forma desigual —de 12 a 8 tira uno de cada
 * tres, y el hueco entre frames alterna 1/12 y 2/12 de segundo— y eso se ve
 * como tirones mucho más que un framerate bajo pero regular.
 */
function extractionFps(cfg: Config, source: { fps: number } | null): number {
  const wanted = cfg.easterEgg.fps / Math.max(0.01, cfg.easterEgg.speed);
  if (source && source.fps > 0) {
    const ratio = source.fps / wanted;
    if (Math.abs(ratio - Math.round(ratio)) > 0.01) {
      console.warn(
        `Advertencia: el clip va a ${source.fps.toFixed(2)} fps y se despieza a ${wanted.toFixed(2)}; ` +
          `al no ser múltiplo exacto, los descartes salen irregulares y la imagen dará tirones. ` +
          `Prueba con fps/speed que divida a ${source.fps.toFixed(2)}.`,
      );
    }
  }
  return wanted;
}

/**
 * Cadena de filtros que encaja el clip en el panel.
 *
 * Con `pixelated` se escala por un **factor entero** y con vecino más próximo:
 * es la diferencia entre un pixel art nítido y una foto borrosa de un pixel
 * art. Un factor no entero reparte los píxeles de forma desigual (unos salen
 * de 2 px y otros de 3) y produce un temblor muy visible al desplazarse.
 *
 * Si ni siquiera cabe al doble, se vuelve al encaje normal: preferible a
 * enseñar el clip a tamaño original perdido en mitad del panel.
 *
 * `crop` existe por la proporción: el panel es 4,16:1 y una captura 4:3 sólo
 * llena el 27 % del ancho. Recortando una franja apaisada de la imagen se
 * puede escalar mucho más y llenar bastante más panel.
 */
export function scaleFilter(
  opts: { pixelated: boolean; crop: string },
  size: { w: number; h: number } | null,
  width: number,
  height: number,
): string {
  const pad = `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
  const crop = opts.crop ? `crop=${opts.crop},` : '';
  // Recortar cambia el tamaño de partida, y de ahí sale el factor entero.
  const cropped = opts.crop ? parseCrop(opts.crop) ?? size : size;
  if (opts.pixelated && cropped) {
    const factor = Math.floor(Math.min(width / cropped.w, height / cropped.h));
    if (factor >= 2) return `${crop}scale=${cropped.w * factor}:${cropped.h * factor}:flags=neighbor,${pad}`;
  }
  const flags = opts.pixelated ? ':flags=neighbor' : '';
  return `${crop}scale=${width}:${height}:force_original_aspect_ratio=decrease${flags},${pad}`;
}

/**
 * Todo lo que se le pide a ffmpeg para este clip.
 *
 * La clave de la caché se calcula **a partir de esto**, no de una lista de
 * campos escrita a mano. Esa lista ya se quedó atrás una vez —le faltaban
 * `pixelated`, `crop` y `speed`— y el síntoma era silencioso: cambiabas una
 * opción y se seguían pintando los frames viejos.
 */
export function ffmpegRecipe(
  cfg: Config,
  probed: { w: number; h: number; fps: number } | null,
  width: number,
  height: number,
): { filter: string; seconds: number } {
  return {
    filter: `fps=${extractionFps(cfg, probed)},${scaleFilter(cfg.easterEgg, probed, width, height)}`,
    // `maxSeconds` es lo que dura en el panel, no lo que dura el clip: a media
    // velocidad, medio clip llena el mismo rato de pantalla.
    seconds: cfg.easterEgg.maxSeconds * cfg.easterEgg.speed,
  };
}

/** `ancho:alto:x:y` de un recorte de ffmpeg, si viene en números literales. */
function parseCrop(expr: string): { w: number; h: number } | null {
  const [w, h] = expr.split(':').map(Number);
  return w && h && Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
}

/**
 * Segundos que un fichero debe llevar quieto para considerarlo terminado.
 *
 * Un clip a medio escribir se despieza igual: ffmpeg saca los frames que haya y
 * sale con éxito, así que la animación saldría truncada sin que nada fallara.
 */
const SETTLE_MS = 30_000;

/** Lista los vídeos ya terminados de un directorio, en orden estable. */
function clipsIn(dir: string, now = Date.now()): string[] {
  return readdirSync(dir)
    .filter((f) => VIDEO_EXT.some((e) => f.toLowerCase().endsWith(e)))
    .map((f) => join(dir, f))
    .filter((f) => now - statSync(f).mtimeMs > SETTLE_MS)
    .sort();
}

/**
 * Deja en la caché sólo los últimos `keep` clips despiezados.
 *
 * Un clip de 20 s a 1920x462 son del orden de 60 MB en PNGs. Sin poda, un
 * directorio con veinte partidas grabadas se come el disco en silencio.
 */
function pruneCache(keep: number): void {
  if (!existsSync(CACHE_DIR)) return;
  const dirs = readdirSync(CACHE_DIR)
    // Un despiece en curso no cuenta todavía como clip cacheado.
    .filter((d) => !d.includes('.parcial-'))
    .map((d) => join(CACHE_DIR, d))
    .filter((d) => statSync(d).isDirectory())
    .map((d) => ({ d, at: statSync(d).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { d } of dirs.slice(Math.max(1, keep))) rmSync(d, { recursive: true, force: true });
}

/** Una animación lista para mandar al panel, frame a frame. */
export interface Playable {
  count: number;
  /** Para el log: de dónde sale y, si aplica, cómo acaba. */
  label: string;
  frame(index: number): Promise<Buffer>;
}

/**
 * ¿Toca guiño?
 *
 * La cuenta va contra el reloj de pared, no contra "han pasado N ms desde el
 * último": así con `everyMs` de 15 minutos salta en punto, y cuarto, y media,
 * en vez de ir derivando según cuándo se arrancó el daemon.
 */
export function isDue(cfg: Config, now: number, lastPlayed: number | null): boolean {
  if (!cfg.easterEgg.enabled) return false;
  const slot = Math.floor(now / cfg.easterEgg.everyMs);
  if (lastPlayed === null) return false; // el arranque no cuenta: nadie quiere esto al encender
  return slot !== Math.floor(lastPlayed / cfg.easterEgg.everyMs);
}

/** Semilla de la pasada: una por franja de reloj, para que cada una sea distinta. */
export function seedFor(cfg: Config, now: number): number {
  return Math.floor(now / cfg.easterEgg.everyMs);
}

/**
 * Despieza un vídeo o GIF en PNGs del tamaño del panel, y lo cachea.
 *
 * La clave incluye tamaño y fecha del fichero: si cambias el clip por otro con
 * el mismo nombre, se vuelve a extraer solo.
 */
async function framesFromSource(cfg: Config, width: number, height: number, seed: number): Promise<Playable | null> {
  const configured = cfg.easterEgg.source;
  if (!existsSync(configured)) throw new Error(`no existe la ruta de easterEgg.source: ${configured}`);

  let src = configured;
  if (statSync(configured).isDirectory()) {
    const clips = clipsIn(configured);
    // Un directorio vacío no es un error: se cae con elegancia a la animación
    // integrada mientras vas dejando clips dentro.
    if (clips.length === 0) return null;
    src = pickClip(clips, seed);
  }

  const st = statSync(src);
  // Se sondea siempre, también al acertar en caché: cuesta unos milisegundos y
  // es lo que hace que la clave dependa de la receta completa.
  const recipe = ffmpegRecipe(cfg, await probeStream(src), width, height);
  const key = createHash('sha1')
    .update([src, st.size, st.mtimeMs, recipe.filter, recipe.seconds].join('|'))
    .digest('hex')
    .slice(0, 16);
  const dir = join(CACHE_DIR, key);

  if (!existsSync(dir) || readdirSync(dir).length === 0) {
    console.log(`Guiño: despiezando ${src} con ffmpeg...`);
    // Se extrae aparte y se renombra al terminar. Si ffmpeg muere a medias
    // —o alguien borra la caché mientras trabaja—, lo que queda es un
    // directorio temporal huérfano y no media animación haciéndose pasar por
    // completa, que es lo que se reproduciría para siempre.
    const tmp = `${dir}.parcial-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      await execFileAsync(
        'ffmpeg',
        ['-loglevel', 'error', '-i', src, '-t', String(recipe.seconds), '-vf', recipe.filter, '-f', 'image2', join(tmp, '%05d.png')],
        { timeout: 120_000 },
      );
      if (readdirSync(tmp).length === 0) throw new Error('no produjo ningún frame');
      mkdirSync(CACHE_DIR, { recursive: true });
      renameSync(tmp, dir);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      // La pista útil está en stderr, no en «Command failed» seguido de 300
      // caracteres de comando. Sin esto, diagnosticar un fallo aquí es adivinar.
      const e = err as { stderr?: string; message?: string; code?: string };
      const detail = (e.stderr ?? '').trim().split('\n').slice(-3).join('; ') || e.message || String(err);
      throw new Error(
        e.code === 'ENOENT'
          ? 'hace falta `ffmpeg` para usar easterEgg.source (apt install ffmpeg), o deja source vacío para la animación integrada'
          : `ffmpeg no pudo despiezar ${src}: ${detail}`,
      );
    }
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => join(dir, f));
  if (files.length === 0) throw new Error(`la caché de ${src} está vacía`);
  pruneCache(cfg.easterEgg.cacheClips);
  return {
    count: files.length,
    label: `${src} (${files.length} frames en caché)`,
    // Se leen del disco al vuelo: un clip largo en memoria son cientos de MB.
    async frame(i: number) {
      return readFileSync(files[i]!);
    },
  };
}

/** Prepara la pasada de este momento. */
export async function buildPlayable(cfg: Config, width: number, height: number, seed: number): Promise<Playable> {
  if (cfg.easterEgg.source) {
    const fromDisk = await framesFromSource(cfg, width, height, seed);
    if (fromDisk) return fromDisk;
  }
  const a = animation(width, height, seed);
  const fate = fateFor(seed);
  const how =
    fate.kind === 'completa' ? 'se lo pasa' : fate.kind === 'hueco' ? `se cae en la columna ${fate.col}` : 'se lo come un bicho';
  return { count: a.count, label: `animación integrada, ${how}`, frame: (i) => a.frame(i) };
}

export interface PlayStats {
  sent: number;
  dropped: number;
  ms: number;
}

/**
 * Manda la animación al panel al ritmo pedido.
 *
 * Mientras dura no hace falta keepalive: a 12 fps el firmware nunca llega a
 * los ~2-3 s de abandono que le hacen volver al logo. Quien llama debe haber
 * parado el reenvío antes, porque compite por el mismo USB.
 *
 * Si se va de tiempo tira frames en lugar de estirar la animación: perder
 * fluidez se nota menos que verla a cámara lenta.
 *
 * El frame siguiente se dibuja **mientras viaja el actual**. En serie, los
 * ~26 ms de rasterizado se sumaban a los ~80 del envío y se pasaban del
 * presupuesto de 83 ms por frame a 12 fps: se descartaba uno de cada diez sin
 * necesidad. Solapados, el dibujo cabe entero debajo del envío.
 */
export async function play(
  playable: Playable,
  fps: number,
  send: (png: Buffer) => Promise<void>,
  opts: { abort?: () => boolean } = {},
): Promise<PlayStats> {
  const step = 1000 / fps;
  const t0 = Date.now();
  let sent = 0;
  let dropped = 0;
  // Nunca hay más de un `frame()` en vuelo: se espera el actual antes de pedir
  // el siguiente. El rasterizador comparte un único lienzo y dos llamadas a la
  // vez se pisarían.
  let pending: Promise<Buffer> | null = playable.count > 0 ? playable.frame(0) : null;
  for (let i = 0; i < playable.count; i++) {
    if (opts.abort?.()) break;
    const png = await pending!;
    pending = i + 1 < playable.count ? playable.frame(i + 1) : null;
    const due = t0 + i * step;
    if (Date.now() - due > step) {
      dropped++;
      continue;
    }
    await send(png);
    sent++;
    const wait = due + step - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return { sent, dropped, ms: Date.now() - t0 };
}
