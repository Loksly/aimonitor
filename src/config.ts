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
  tile: { min: number; max: number; gap: number };
  /** Márgenes y cabecera. */
  margin: number;
  headerHeight: number;
  /** Espina de color de las casillas "marcadas". */
  spineWidth: number;
  /** Desplazamiento de píxel contra retención de imagen. */
  pixelShift: { enabled: boolean; amplitude: number; periodMs: number };
  /** Sesión `activa` sin refrescar más de esto → zombi, se descarta. */
  zombieMs: number;
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
    keepalive: { enabled: boolean; intervalS: number };
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
  tile: { min: 320, max: 430, gap: 12 },
  margin: 14,
  headerHeight: 60,
  spineWidth: 7,
  pixelShift: { enabled: true, amplitude: 2, periodMs: 8 * 60_000 },
  zombieMs: 15 * 60_000,
  usage: {
    mode: 'max',
    bin: 'ccusage',
    dailyCap: 25,
    monthlyCap: 400,
    refreshMs: 60_000,
    calibration: { metric: 'cost', lookbackDays: 30, percentile: 100 },
  },
  thresholds: { warn: 0.6, alert: 0.85 },
  trcc: {
    bin: 'trcc',
    deviceKey: '',
    extraArgs: [],
    timeoutMs: 20_000,
    api: { url: 'http://127.0.0.1:8099' },
    keepalive: { enabled: true, intervalS: 0.15 },
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
