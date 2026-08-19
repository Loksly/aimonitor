import type { BlockPoint, Provider, SessionRecord, SessionState, SystemSnapshot, UsageSnapshot } from './types.ts';

/** Instante fijo: los previews deben ser reproducibles byte a byte. */
export const T0 = Date.parse('2026-08-16T17:42:00');

const s = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;

interface Spec {
  id: string;
  project: string;
  state: SessionState;
  detail: string;
  provider?: Provider;
  /** Hace cuánto entró en el estado. */
  ago: number;
  dirty?: number;
  /** Hace cuánto se escribió el registro; por defecto, igual que `ago`. */
  updatedAgo?: number;
}

function rec(spec: Spec, now = T0): SessionRecord {
  return {
    session_id: spec.id,
    provider: spec.provider ?? 'claude',
    state: spec.state,
    detail: spec.detail,
    project: spec.project,
    cwd: `/home/loksly/dev/${spec.project}`,
    since: now - spec.ago,
    updated: now - (spec.updatedAgo ?? spec.ago),
    event: 'PreToolUse',
    dirty: spec.dirty,
  };
}

/**
 * Vitales fijos. El disco va al 91 % a propósito: es el único vital encendido,
 * y sirve para comprobar de un vistazo que la columna sólo se ilumina cuando
 * algo se sale de rango y no por defecto.
 */
export const SYSTEM: SystemSnapshot = {
  cpuTemp: 71,
  cpuUsage: 0.23,
  cores: [0.62, 0.18, 0.41, 0.07, 0.93, 0.12, 0.05, 0.33, 0.28, 0.02, 0.51, 0.09, 0.16, 0.04, 0.71, 0.11],
  load: 0.23,
  mem: { used: 26 * 1024 ** 3, total: 62 * 1024 ** 3 },
  disk: { used: 240 * 1024 ** 3, total: 265 * 1024 ** 3, path: '/datos' },
  uptime: 836 * 3600,
};

/** Doce bloques de 5 h con forma reconocible; el último es el que está en curso. */
const BLOCKS: BlockPoint[] = [18.4, 46.2, 3.1, 31.7, 29.5, 1.2, 12.8, 9.4, 22.6, 5.7, 38.9, 14.3].map((cost, i, all) => ({
  cost,
  startTime: T0 - (all.length - 1 - i) * 5 * 3_600_000,
  active: i === all.length - 1,
}));

export const USAGE_MAX: UsageSnapshot = {
  mode: 'max',
  windows: [
    { label: 'Ventana 5 h', ratio: 0.42, resetsAt: T0 + min(134) },
    { label: 'Semana', ratio: 0.88, resetsAt: T0 + min(3_180) },
  ],
  blockHistory: BLOCKS,
  tokensToday: 4_230_000,
  byModel: [
    { model: 'opus-5', tokens: 2_900_000 },
    { model: 'sonnet-5', tokens: 1_100_000 },
    { model: 'haiku-4.5', tokens: 230_000 },
  ],
};

export const USAGE_API: UsageSnapshot = {
  mode: 'api',
  spend: [
    { label: 'Hoy', amount: 11.4, cap: 25 },
    { label: 'Mes', amount: 268, cap: 400 },
  ],
  blockHistory: BLOCKS,
  tokensToday: 4_230_000,
  byModel: [
    { model: 'opus-5', tokens: 2_900_000 },
    { model: 'sonnet-5', tokens: 1_330_000 },
  ],
};

/**
 * Escenarios de prueba. El que manda es `tres-reclaman`: es el caso para el que
 * existen los tres pesos visuales.
 */
export const SCENARIOS: Record<string, SessionRecord[]> = {
  vacio: [],

  una: [rec({ id: 'a1b2c3d4-1111', project: 'aimonitor', state: 'activa', detail: 'Edit src/render.ts', ago: s(12), dirty: 4 })],

  'tres-reclaman': [
    rec({ id: 'a1b2c3d4-1111', project: 'trcc-linux', state: 'permiso', detail: 'Bash: sudo udevadm control --reload', ago: min(3) + s(41), dirty: 2 }),
    rec({ id: 'b2c3d4e5-2222', project: 'aimonitor', state: 'espera', detail: 'esperando entrada del usuario', ago: min(18) + s(7), dirty: 11, provider: 'gemini' }),
    rec({ id: 'c3d4e5f6-3333', project: 'panel-api', state: 'listo', detail: 'Stop', ago: min(1) + s(4), dirty: 0, provider: 'gemini' }),
    rec({ id: 'd4e5f6a7-4444', project: 'dotfiles', state: 'activa', detail: 'Grep "registerFromPath"', ago: s(9), dirty: 1 }),
  ],

  /** Dos casillas: la columna cabe pero no llega para las barras por núcleo. */
  dos: [
    rec({ id: 'a1b2c3d4-1111', project: 'aimonitor', state: 'permiso', detail: 'Bash: npm publish', ago: min(2) + s(18), dirty: 3 }),
    rec({ id: 'b2c3d4e5-2222', project: 'trcc-linux', state: 'activa', detail: 'Read src/adapters/device/transport.py', ago: s(24), dirty: 0 }),
  ],

  /** Reunión a 4 minutos: se lleva el peso sólido por delante del permiso. */
  reunion: [
    {
      session_id: 'meeting-1', provider: 'claude', state: 'espera',
      detail: '', project: 'Comité de arquitectura',
      since: T0 + min(4), updated: T0, event: 'Meeting', startsAt: T0 + min(4),
    },
    rec({ id: 'a1b2c3d4-1111', project: 'aimonitor', state: 'permiso', detail: 'Bash: npm publish', ago: min(2), dirty: 3 }),
    rec({ id: 'b2c3d4e5-2222', project: 'trcc-linux', state: 'activa', detail: 'Read transport.py', ago: s(24), dirty: 0 }),
  ],

  'nombre-largo': [
    rec({ id: 'e5f6a7b8-5555', project: 'infra-terraform-produccion', state: 'permiso', detail: 'Write /etc/systemd/system/claude-lcd.service con contenido muy largo', ago: min(7) + s(22), dirty: 37 }),
    rec({ id: 'f6a7b8c9-6666', project: 'monorepo-frontend-cliente', state: 'listo', detail: 'SubagentStop', ago: min(2), dirty: 0, provider: 'gemini' }),
    rec({ id: 'a7b8c9d0-7777', project: 'x', state: 'activa', detail: 'Read package.json', ago: s(3), dirty: 0 }),
  ],

  'sin-reclamos': [
    rec({ id: 'b8c9d0e1-8888', project: 'aimonitor', state: 'activa', detail: 'Bash npm run build', ago: s(31), dirty: 6 }),
    rec({ id: 'c9d0e1f2-9999', project: 'trcc-linux', state: 'inactiva', detail: 'SessionStart', ago: min(42), dirty: 0, provider: 'gemini' }),
  ],

  desbordado: [
    rec({ id: 'd0e1f2a3-aaaa', project: 'trcc-linux', state: 'permiso', detail: 'Bash: lsusb -d 0416:5408 -v', ago: min(5) + s(13), dirty: 2 }),
    rec({ id: 'e1f2a3b4-bbbb', project: 'aimonitor', state: 'espera', detail: 'idle_prompt', ago: min(11), dirty: 11, provider: 'gemini' }),
    rec({ id: 'f2a3b4c5-cccc', project: 'panel-api', state: 'espera', detail: 'permission needed for MCP', ago: min(4) + s(51), dirty: 3 }),
    rec({ id: 'a3b4c5d6-dddd', project: 'dotfiles', state: 'listo', detail: 'Stop', ago: s(48), dirty: 1, provider: 'gemini' }),
    rec({ id: 'b4c5d6e7-eeee', project: 'notas', state: 'listo', detail: 'Stop', ago: min(3), dirty: 0 }),
    rec({ id: 'c5d6e7f8-ffff', project: 'scraper', state: 'activa', detail: 'WebFetch anthropic.com', ago: s(6), dirty: 0, provider: 'gemini' }),
    rec({ id: 'd6e7f8a9-0001', project: 'bench', state: 'activa', detail: 'Bash pytest -q', ago: s(22), dirty: 4 }),
    rec({ id: 'e7f8a9b0-0002', project: 'archivo', state: 'inactiva', detail: 'SessionStart', ago: min(30), dirty: 0, provider: 'gemini' }),
  ],

  /** La zombi (activa, 40 min sin refrescar) debe desaparecer del render. */
  zombi: [
    rec({ id: 'f8a9b0c1-0003', project: 'aimonitor', state: 'listo', detail: 'Stop', ago: min(2), dirty: 5 }),
    rec({ id: 'a9b0c1d2-0004', project: 'sesion-muerta', state: 'activa', detail: 'Bash tail -f log', ago: min(40), updatedAgo: min(40), dirty: 0, provider: 'gemini' }),
  ],
};
