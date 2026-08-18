/** Proveedores de servicios de inteligencia artificial. */
export type Provider = 'claude' | 'gemini';

/** Estados posibles de una sesión, tal y como los deriva el hook. */
export type SessionState = 'permiso' | 'espera' | 'listo' | 'activa' | 'inactiva';

/** Registro que el hook escribe en ~/.aimonitor/sessions/<session_id>.json */
export interface SessionRecord {
  session_id: string;
  provider: Provider;
  state: SessionState;
  /** Nombre de herramienta o mensaje, truncado. */
  detail: string;
  /** basename de cwd. */
  project: string;
  /** Ruta completa de cwd; el daemon la usa para consultar git, no se pinta. */
  cwd?: string;
  /** Instante (ms epoch) en que entró en el estado actual. */
  since: number;
  /** Última escritura (ms epoch). */
  updated: number;
  /** Nombre del evento de hook que produjo el registro. */
  event: string;
  /** Ficheros pendientes de commit; lo rellena el daemon, no el hook. */
  dirty?: number;
}

/**
 * Snapshot de consumo, independiente del formato de `ccusage`.
 * El adaptador de src/usage.ts es el único que conoce ese JSON.
 */
export interface UsageSnapshot {
  mode: 'max' | 'api';
  /** Modo Max: ventanas de límite. */
  windows?: UsageWindow[];
  /** Modo API: gasto contra topes configurados. */
  spend?: { label: string; amount: number; cap: number }[];
  /** Histórico reciente de bloques de 5 h, para la sparkline. */
  blockHistory?: BlockPoint[];
  /** Pie común. */
  tokensToday?: number;
  byModel?: { model: string; tokens: number }[];
  /** Marcado si los datos no se pudieron leer. */
  stale?: boolean;
}

/** Un bloque de facturación de 5 h ya cerrado o en curso. */
export interface BlockPoint {
  /** Coste equivalente en USD. */
  cost: number;
  /** Inicio del bloque (ms epoch). */
  startTime: number;
  /** El bloque en curso, que se pinta destacado. */
  active?: boolean;
}

export interface UsageWindow {
  label: string;
  /** 0..1 */
  ratio: number;
  /** Instante (ms epoch) del próximo reinicio, si se conoce. */
  resetsAt?: number;
}

export interface Shift {
  x: number;
  y: number;
}

/** Peso visual asignado a cada casilla. Solo una puede ser 'solido'. */
export type Weight = 'solido' | 'marcada' | 'quieta';

/**
 * Vitales de la máquina. Todos los campos son opcionales: se leen de /proc,
 * /sys y `os`, que no existen igual en todos los sistemas, y lo que no se pueda
 * leer sencillamente no se pinta.
 */
export interface SystemSnapshot {
  /** Temperatura del paquete de CPU, en grados Celsius. */
  cpuTemp?: number;
  /** Uso global de CPU, 0..1. */
  cpuUsage?: number;
  /** Uso por núcleo, 0..1. Ausente en el primer render (no hay delta todavía). */
  cores?: number[];
  /** Carga a 1 minuto, ya dividida entre el número de núcleos (0..1+). */
  load?: number;
  /** Memoria en bytes. */
  mem?: { used: number; total: number };
  /** Disco vigilado, en bytes. */
  disk?: { used: number; total: number; path: string };
  /** Segundos desde el arranque. */
  uptime?: number;
}
