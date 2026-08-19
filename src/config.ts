import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionState } from './types.ts';

export const STATE_DIR = process.env.AIMONITOR_DIR ?? join(homedir(), '.aimonitor');
export const SESSIONS_DIR = join(STATE_DIR, 'sessions');
export const CONFIG_PATH = join(STATE_DIR, 'config.json');

/** Paleta fija: es la dirección de arte, no se configura. */
export const PALETTE = {
  BG: '#090C10',
  TILE_OFF: '#131920',
  TILE_EDGE: '#202A35',
  INK_BRIGHT: '#D3DFEA',
  INK_DIM: '#627180',
  INK_FAINT: '#384450',
} as const;

export const STATE_COLOR: Record<SessionState, string> = {
  permiso: '#F5453D',
  espera: '#FFB020',
  listo: '#4DA3FF',
  activa: '#2E8A82',
  inactiva: '#2E8A82',
};

/**
 * Rótulo en versalitas de cada estado. Sin emoji a propósito: las fuentes son
 * DejaVu Condensed y Mono, que no traen glifos de emoji, así que cualquiera se
 * pinta como una caja vacía. El color y el peso ya dicen el estado.
 */
export const STATE_LABEL: Record<SessionState, string> = {
  permiso: 'Permiso',
  espera: 'Espera',
  listo: 'Listo',
  activa: 'Activa',
  inactiva: 'Inactiva',
};

/** Mayor número = más urgente. Ordena qué casilla se lleva el peso sólido. */
export const STATE_PRIORITY: Record<SessionState, number> = {
  permiso: 4,
  espera: 3,
  listo: 2,
  activa: 1,
  inactiva: 0,
};

/** Estados que reclaman al operador. */
export const CLAIMS: ReadonlySet<SessionState> = new Set<SessionState>(['permiso', 'espera', 'listo']);

export interface Config {
  /** Resolución de salida. El daemon la sobreescribe con la de `trcc detect`. */
  width: number;
  height: number;
  /** Carril de consumo a la derecha. */
  rail: { enabled: boolean; width: number };
  /** Ancho de casilla; con una sola sesión no se estira a todo el panel. */
  tile: {
    min: number;
    max: number;
    gap: number;
    /**
     * Líneas que puede ocupar el detalle antes de recortar con elipsis. Crecen
     * hacia arriba, hacia el hueco que dejaba el nombre del proyecto, así que
     * no empujan el contador de tiempo.
     */
    detailLines: number;
  };
  /** Márgenes y cabecera. */
  margin: number;
  headerHeight: number;
  /** Espina de color de las casillas "marcadas". */
  spineWidth: number;
  /** Desplazamiento de píxel contra retención de imagen. */
  pixelShift: { enabled: boolean; amplitude: number; periodMs: number };
  /** Sesión `activa` sin refrescar más de esto → zombi, se descarta. */
  zombieMs: number;
  /**
   * Cualquier sesión sin refrescar más de esto se descarta, esté en el estado
   * que esté. Es la red bajo `SessionEnd`, que no llega si el terminal muere de
   * mala manera. Súbelo si sueles dejar consolas esperando permiso muchas horas.
   */
  staleMs: number;
  /** Consumo. */
  usage: {
    mode: 'max' | 'api';
    /** Binario de `ccusage`. Se resuelve por PATH salvo que sea ruta absoluta. */
    bin: string;
    /** Topes en USD para el modo API. */
    dailyCap: number;
    monthlyCap: number;
    refreshMs: number;
    /**
     * Modo max: `ccusage` expone consumo pero **no** el límite del plan, así que
     * el 100% de las barras se calibra contra el propio histórico del usuario.
     * La barra responde a "cómo va esto contra mi sesión más cargada", no
     * contra un tope de Anthropic, que no es observable desde aquí.
     */
    calibration: {
      /** `cost` usa el coste equivalente (mejor proxy de quema de plan). */
      metric: 'cost' | 'tokens';
      /** Días de histórico a considerar; 0 = todo. */
      lookbackDays: number;
      /** Percentil del histórico que marca el 100%. 100 = máximo absoluto. */
      percentile: number;
    };
  };
  /** Umbrales del semáforo compartido por barras y casillas. */
  thresholds: { warn: number; alert: number };
  /**
   * Columna de vitales que rellena el ancho sobrante cuando hay pocas sesiones.
   * Con 4 o más casillas no sobra sitio y desaparece sola.
   */
  system: {
    enabled: boolean;
    /** Por debajo de este ancho no se dibuja: no cabe nada legible. */
    minWidth: number;
    /** Por debajo de este ancho se omiten las barras por núcleo. */
    perCoreMinWidth: number;
    /** Sistema de ficheros a vigilar. */
    diskPath: string;
    /**
     * Umbrales propios, más altos que los del consumo. Una RAM al 65 % o un
     * disco al 70 % son un martes cualquiera: con los umbrales del carril
     * (0,6/0,85) la columna viviría encendida en ámbar y competiría con las
     * consolas que sí reclaman al operador.
     */
    warn: number;
    alert: number;
    /** Umbrales de temperatura de CPU, en grados Celsius. */
    tempWarn: number;
    tempAlert: number;
  };
  /**
   * Aviso de la próxima reunión, leído de un calendario ICS publicado.
   *
   * Desactivado por defecto: requiere publicar el calendario en Outlook Web, y
   * la URL resultante **es un secreto portador** — quien la tenga lee la agenda
   * entera sin autenticarse. Va en config.json, que se crea con permisos 600.
   */
  calendar: {
    enabled: boolean;
    /**
     * URL del `.ics` publicado, o una lista de ellas para vigilar varios
     * calendarios a la vez (trabajo y personal, por ejemplo). Se funden en una
     * sola agenda y gana la reunión más próxima.
     *
     * Trátalas como contraseñas: cada una da acceso de lectura a esa agenda
     * entera sin autenticarse.
     */
    icsUrl: string | string[];
    refreshMs: number;
    timeoutMs: number;
    /** Se muestra el título; con `false`, sólo hora y cuenta atrás. */
    showTitle: boolean;
    /** El título se recorta con elipsis a partir de aquí. */
    titleMaxChars: number;
    /**
     * Asuntos que no son reuniones. Los bloques de concentración de Outlook van
     * marcados como «ocupado» y, sin esto, encenderían el panel media mañana.
     */
    ignorePatterns: string[];
    /**
     * Escalera de inminencia, en minutos restantes. Por encima de `grey` la
     * reunión se pinta apagada: informa, no reclama.
     */
    minutes: { grey: number; listo: number; espera: number; permiso: number };
  };
  /**
   * El guiño: cada cierto rato el panel deja el cuadro de mando y pone una
   * animación de plataformas de 8 bits.
   *
   * El dibujo que viene de serie es original. Si prefieres otra cosa, `source`
   * apunta a un vídeo o GIF **de tu disco**, que se despieza con `ffmpeg`; en
   * el paquete no viaja material de nadie más.
   */
  easterEgg: {
    enabled: boolean;
    /**
     * Cada cuánto sale, en ms. Va contra el reloj de pared: con 15 minutos
     * salta en punto, y cuarto, y media, no a los 15 minutos de arrancar.
     */
    everyMs: number;
    /**
     * Fotogramas por segundo. El bus del panel comprime cada frame, así que el
     * techo depende del contenido: ~12 fps con colores planos, ~5 con imagen
     * fotográfica. Pedir más de lo que da sólo hace que se tiren frames.
     */
    fps: number;
    /**
     * Vacío = la animación integrada. Si no, la ruta de un vídeo o GIF local,
     * o la de un **directorio** de clips del que se elige uno distinto cada
     * vez. Un directorio vacío vuelve a la animación integrada.
     */
    source: string;
    /**
     * Velocidad de reproducción. 1 = tiempo real; 0,5 = la mitad.
     *
     * El panel no pasa de unos 8 fps, así que a tiempo real cada frame se come
     * mucho movimiento y el desplazamiento lateral da tirones. Bajarla enseña
     * **todos** los frames del origen en vez de descartar: se ve más suave, a
     * cambio de que la escena dure más.
     *
     * El cociente `fps / speed` es la cadencia a la que se despieza, y debe
     * dividir de forma exacta a la del clip.
     */
    speed: number;
    /** Segundos que dura en el panel como mucho (no del clip: ver `speed`). */
    maxSeconds: number;
    /**
     * Escalar con vecino más próximo y por factor entero. Es lo correcto para
     * capturas de juegos retro; ponlo a `false` para vídeo de imagen real, que
     * con vecino sale dentado.
     */
    pixelated: boolean;
    /**
     * Recorte de ffmpeg (`ancho:alto:x:y`) aplicado antes de escalar.
     *
     * El panel es un 4,16:1 y una captura 4:3 sólo llena el 27 % del ancho.
     * Quedarse con una franja apaisada del original permite escalarla mucho
     * más. Vacío = sin recorte.
     */
    crop: string;
    /**
     * Clips despiezados que se guardan en `~/.aimonitor/easteregg/`. Cada uno
     * son decenas de MB en PNGs, así que un directorio con muchas partidas
     * grabadas se comería el disco sin este tope.
     */
    cacheClips: number;
    /**
     * No interrumpir cuando algo reclama al operador. Una sesión esperando
     * permiso o una reunión encima no son momento para ponerse a jugar.
     */
    skipWhenBusy: boolean;
  };
  /** Salida al panel, vía la API REST de `trcc serve`. */
  trcc: {
    bin: string;
    /** Clave `VID:PID` del panel. Vacío = coger el primero que reporte el servidor. */
    deviceKey: string;
    extraArgs: string[];
    timeoutMs: number;
    /**
     * El USB es de acceso exclusivo, así que un solo proceso (`trcc serve`)
     * posee el dispositivo y este daemon le habla por HTTP.
     */
    api: { url: string };
    /**
     * El firmware LY vuelve al logo de fábrica pasados ~2-3 s sin frame nuevo.
     * Este bucle reenvía el último frame para dejar la imagen fija; es barato
     * porque no vuelve a renderizar nada.
     */
    keepalive: {
      enabled: boolean;
      intervalS: number;
      /**
       * Duración de cada ráfaga. El bucle se pide acotado y se renueva, en vez
       * de abrirlo sin fin: una petición abierta sobrevive a la muerte del
       * daemon, deja al servidor con un bucle huérfano que bloquea todos los
       * GET, y entonces el daemon siguiente no puede ni detectar el panel.
       * Acotado, cualquier huérfano caduca solo en este plazo.
       */
      burstS: number;
    };
  };
  /** Sin sesiones, el panel se queda a negro (es el backlight lo que se gasta). */
  blankWhenIdle: boolean;
  fonts: { condensedBold: string; mono: string; monoBold: string };
}

export const DEFAULT_CONFIG: Config = {
  // 1920x462 es el máximo que documenta el driver; las tiendas anuncian 480.
  // Un layout de 462 hace letterbox en un panel de 480; al revés se recorta.
  width: 1920,
  height: 462,
  rail: { enabled: true, width: 356 },
  // min 320 => 4 casillas con carril (5 sin él) sobre 1920 px, incluso
  // reservando la columna de resumen cuando hay desbordamiento.
  tile: { min: 320, max: 430, gap: 12, detailLines: 3 },
  margin: 14,
  headerHeight: 60,
  spineWidth: 7,
  pixelShift: { enabled: true, amplitude: 2, periodMs: 8 * 60_000 },
  zombieMs: 15 * 60_000,
  staleMs: 2 * 60 * 60_000,
  usage: {
    mode: 'max',
    bin: 'ccusage',
    dailyCap: 25,
    monthlyCap: 400,
    refreshMs: 60_000,
    calibration: { metric: 'cost', lookbackDays: 30, percentile: 100 },
  },
  thresholds: { warn: 0.6, alert: 0.85 },
  system: {
    enabled: true,
    minWidth: 190,
    perCoreMinWidth: 700,
    diskPath: '/',
    warn: 0.85,
    alert: 0.95,
    tempWarn: 85,
    tempAlert: 95,
  },
  calendar: {
    enabled: false,
    icsUrl: '',
    refreshMs: 5 * 60_000,
    timeoutMs: 20_000,
    showTitle: true,
    titleMaxChars: 34,
    ignorePatterns: ['tiempo de concentración', 'focus time'],
    minutes: { grey: 120, listo: 30, espera: 10, permiso: 3 },
  },
  easterEgg: {
    enabled: true,
    everyMs: 15 * 60_000,
    fps: 12,
    speed: 1,
    source: '',
    maxSeconds: 30,
    pixelated: true,
    crop: '',
    cacheClips: 3,
    skipWhenBusy: true,
  },
  trcc: {
    bin: 'trcc',
    deviceKey: '',
    extraArgs: [],
    timeoutMs: 20_000,
    api: { url: 'http://127.0.0.1:8099' },
    keepalive: { enabled: true, intervalS: 0.15, burstS: 30 },
  },
  blankWhenIdle: true,
  fonts: {
    condensedBold: '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
    mono: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    monoBold: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
  },
};

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Mezcla superficial y recursiva; los arrays se reemplazan enteros. */
function merge<T>(base: T, patch: unknown): T {
  if (!isPlain(patch) || !isPlain(base)) return (patch === undefined ? base : (patch as T));
  const out: Plain = { ...(base as Plain) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out && isPlain(out[k]) ? merge(out[k], v) : v;
  }
  return out as T;
}

/** Lee ~/.aimonitor/config.json si existe. Nunca lanza: sin fichero, defaults. */
export function loadConfig(path = CONFIG_PATH): Config {
  try {
    return merge(DEFAULT_CONFIG, JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Color del semáforo para una razón 0..1, el mismo que usan las casillas. */
export function ratioColor(ratio: number, t = DEFAULT_CONFIG.thresholds): string {
  if (ratio >= t.alert) return STATE_COLOR.permiso;
  if (ratio >= t.warn) return STATE_COLOR.espera;
  return STATE_COLOR.listo;
}

/**
 * Color de un vital de la máquina.
 *
 * No sirve `ratioColor`: ése devuelve azul (el color de `listo`) por debajo del
 * 60 %, y la columna de sistema brillaría en reposo compitiendo con las casillas
 * que sí reclaman al operador. Aquí la normalidad es apagada, y sólo se enciende
 * al cruzar los umbrales.
 */
export function vitalColor(ratio: number, t: { warn: number; alert: number } = DEFAULT_CONFIG.system): string {
  if (ratio >= t.alert) return STATE_COLOR.permiso;
  if (ratio >= t.warn) return STATE_COLOR.espera;
  return PALETTE.INK_DIM;
}

/** Lo mismo para la temperatura, que va en grados y no en razón 0..1. */
export function tempColor(celsius: number, cfg: Config['system']): string {
  if (celsius >= cfg.tempAlert) return STATE_COLOR.permiso;
  if (celsius >= cfg.tempWarn) return STATE_COLOR.espera;
  return PALETTE.INK_DIM;
}

/**
 * Estado de una reunión según lo que falte para empezar, para que herede el
 * mismo semáforo que las consolas en lugar de inventar un idioma nuevo.
 *
 * Por encima de `grey` se pinta como `inactiva`: aparece, informa, pero no
 * reclama. Una reunión ya empezada es lo más urgente que puede haber en la
 * pantalla, porque es lo único que no espera.
 */
export function meetingState(minutesLeft: number, m: Config['calendar']['minutes']): SessionState {
  if (minutesLeft <= m.permiso) return 'permiso';
  if (minutesLeft <= m.espera) return 'espera';
  if (minutesLeft <= m.listo) return 'listo';
  if (minutesLeft <= m.grey) return 'activa';
  return 'inactiva';
}
