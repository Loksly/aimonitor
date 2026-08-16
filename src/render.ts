import { freemem, totalmem } from 'node:os';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { PALETTE, STATE_COLOR, STATE_LABEL, STATE_PRIORITY, ratioColor, type Config } from './config.ts';
import { COND, MONO, MONO_BOLD, drawClipped, drawTracked, fitSize, registerFonts } from './fonts.ts';
import { clock, countdown, elapsed, money, percent, shortId, tokens } from './format.ts';
import { claims, plan, pruneZombies, type Tile } from './select.ts';
import type { SessionRecord, Shift, UsageSnapshot, Weight } from './types.ts';

export interface FrameInput {
  sessions: SessionRecord[];
  usage?: UsageSnapshot | null;
  config: Config;
  /** Momento del render, ms epoch. Inyectable para que el preview sea estable. */
  now?: number;
  /** Fuerza el desplazamiento de píxel (para depurar). */
  shift?: Shift;
}

/** Ciclo lento de posiciones; evita que un píxel apagado lo esté siempre. */
const SHIFT_CYCLE = [
  [0, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
] as const;

export function computeShift(now: number, cfg: Config): Shift {
  if (!cfg.pixelShift.enabled) return { x: 0, y: 0 };
  const step = SHIFT_CYCLE[Math.floor(now / cfg.pixelShift.periodMs) % SHIFT_CYCLE.length]!;
  const a = cfg.pixelShift.amplitude;
  return { x: Math.round(step[0] * a), y: Math.round(step[1] * a) };
}

/** Tinta según el peso visual de la casilla. */
function inks(weight: Weight, state: SessionRecord['state']) {
  if (weight === 'solido') {
    // Campo de color pleno, texto oscuro encima.
    return {
      strong: PALETTE.BG,
      mid: 'rgba(9,12,16,0.78)',
      faint: 'rgba(9,12,16,0.55)',
      rule: 'rgba(9,12,16,0.28)',
      accent: PALETTE.BG,
    };
  }
  if (weight === 'marcada') {
    return {
      strong: PALETTE.INK_BRIGHT,
      mid: PALETTE.INK_DIM,
      faint: PALETTE.INK_FAINT,
      rule: PALETTE.TILE_EDGE,
      accent: STATE_COLOR[state],
    };
  }
  return {
    strong: PALETTE.INK_DIM,
    mid: PALETTE.INK_FAINT,
    faint: PALETTE.INK_FAINT,
    rule: PALETTE.TILE_EDGE,
    accent: PALETTE.INK_FAINT,
  };
}

function hairline(ctx: SKRSContext2D, x: number, y: number, w: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, Math.round(y) + 0.0, w, 1);
}

function drawHeader(ctx: SKRSContext2D, cfg: Config, sessions: SessionRecord[], now: number): void {
  const m = cfg.margin;
  const waiting = sessions.filter(claims);
  const baseline = m + 30;
  const dot = ' · ';

  let x = m;
  const label = { size: 22, family: COND, tracking: 3.4, smallCaps: true } as const;
  const memUsed = Math.round((totalmem() - freemem()) / (1024 ** 3));
  const memTotal = Math.round(totalmem() / (1024 ** 3));
  const ramLabel = `RAM: ${memUsed}GB/${memTotal}GB`;
  x += drawTracked(ctx, ramLabel, x, baseline, { ...label, color: PALETTE.INK_BRIGHT });
  x += drawTracked(ctx, dot, x, baseline, { ...label, color: PALETTE.INK_FAINT });
  const n = sessions.length;
  x += drawTracked(ctx, `${n} ${n === 1 ? 'consola' : 'consolas'}`, x, baseline, { ...label, color: PALETTE.INK_DIM });
  x += drawTracked(ctx, dot, x, baseline, { ...label, color: PALETTE.INK_FAINT });
  // El estado más urgente tiñe el recuento: se lee de reojo si hay algo o no.
  const urgent = [...waiting].sort((a, b) => STATE_PRIORITY[b.state] - STATE_PRIORITY[a.state])[0];
  drawTracked(ctx, waiting.length ? `${waiting.length} te esperan` : 'nadie espera', x, baseline, {
    ...label,
    color: urgent ? STATE_COLOR[urgent.state] : PALETTE.INK_FAINT,
  });

  drawTracked(ctx, clock(new Date(now)), cfg.width - m, baseline + 2, {
    size: 30,
    family: MONO_BOLD,
    color: PALETTE.INK_BRIGHT,
    align: 'right',
  });

  hairline(ctx, m, cfg.headerHeight, cfg.width - 2 * m, PALETTE.TILE_EDGE);
}

function drawTile(ctx: SKRSContext2D, t: Tile, x: number, y: number, w: number, h: number, now: number, cfg: Config): void {
  const { record: r, weight } = t;
  const color = STATE_COLOR[r.state];
  const ink = inks(weight, r.state);

  if (weight === 'solido') {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  } else {
    ctx.fillStyle = PALETTE.TILE_OFF;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = PALETTE.TILE_EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (weight === 'marcada') {
      // Espina a sangre en el canto izquierdo.
      ctx.fillStyle = color;
      ctx.fillRect(x, y, cfg.spineWidth, h);
    }
  }

  const padL = weight === 'marcada' ? cfg.spineWidth + 15 : 18;
  const cx = x + padL;
  const cw = w - padL - 18;

  // 1. Rótulo de estado + id corto (incluyendo proveedor)
  const labelOpts = { size: 21, family: COND, tracking: 3.6, smallCaps: true, color: ink.accent } as const;
  drawTracked(ctx, STATE_LABEL[r.state], cx, y + 32, labelOpts);
  const provIdLabel = `${r.provider.toUpperCase()} · ${shortId(r.session_id)}`;
  drawTracked(ctx, provIdLabel, x + w - 18, y + 31, {
    size: 15,
    family: MONO,
    color: ink.faint,
    align: 'right',
  });

  // 2. Regla fina
  hairline(ctx, cx, y + 46, cw, ink.rule);

  // 5. Tiempo transcurrido, abajo y grande: la pregunta real es cuánto lleva así.
  const footerBase = y + h - 16;
  const elapsedSize = Math.round(Math.min(60, Math.max(38, h * 0.14)));
  const elapsedBase = footerBase - 26;
  drawTracked(ctx, elapsed(now - r.since), cx, elapsedBase, {
    size: elapsedSize,
    family: MONO_BOLD,
    color: ink.strong,
    tracking: -1,
  });

  // 4. Detalle técnico, justo encima del tiempo
  const detailBase = elapsedBase - elapsedSize * 0.8 - 14;
  drawClipped(ctx, r.detail, cx, detailBase, cw, { size: 17, family: MONO, color: ink.mid });

  // 3. Nombre del proyecto: lo que identifica la consola. Se encoge hasta
  //    donde haga falta antes de aceptar un recorte con elipsis.
  const projOpts = {
    size: Math.round(Math.min(56, Math.max(34, h * 0.13))),
    family: COND,
    color: ink.strong,
    tracking: 0.5,
  };
  projOpts.size = fitSize(ctx, r.project, cw, projOpts, 26);
  const midTop = y + 54;
  const midBottom = detailBase - 24;
  const projBase = Math.round((midTop + midBottom) / 2 + projOpts.size * 0.36);
  drawClipped(ctx, r.project, cx, projBase, cw, projOpts);

  // 6. Pie: ficheros pendientes de commit
  if (r.dirty !== undefined) {
    const txt = r.dirty === 0 ? '📁 git limpio' : `📁 git ${r.dirty} sin commit`;
    drawClipped(ctx, txt, cx, footerBase, cw, { size: 16, family: MONO, color: ink.faint });
  }
}

function drawSummary(ctx: SKRSContext2D, rest: SessionRecord[], x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = PALETTE.TILE_OFF;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PALETTE.TILE_EDGE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const cx = x + 16;
  drawTracked(ctx, `+${rest.length} más`, cx, y + 32, {
    size: 21,
    family: COND,
    tracking: 3.6,
    smallCaps: true,
    color: PALETTE.INK_DIM,
  });
  hairline(ctx, cx, y + 46, w - 32, PALETTE.TILE_EDGE);

  const counts = new Map<SessionRecord['state'], number>();
  for (const r of rest) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);

  let ry = y + 78;
  for (const [state, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    ctx.fillStyle = STATE_COLOR[state];
    ctx.fillRect(cx, ry - 9, 9, 9);
    drawTracked(ctx, STATE_LABEL[state], cx + 17, ry, {
      size: 16,
      family: COND,
      tracking: 2,
      smallCaps: true,
      color: PALETTE.INK_DIM,
    });
    drawTracked(ctx, String(n), x + w - 16, ry, { size: 17, family: MONO_BOLD, color: PALETTE.INK_DIM, align: 'right' });
    ry += 28;
  }
}

function drawBar(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  label: string,
  right: string,
  ratio: number,
  note: string | null,
  cfg: Config,
): number {
  const color = ratioColor(Math.min(1, ratio), cfg.thresholds);
  drawTracked(ctx, label, x, y, { size: 18, family: COND, tracking: 3, smallCaps: true, color: PALETTE.INK_DIM });
  drawTracked(ctx, right, x + w, y, { size: 20, family: MONO_BOLD, color, align: 'right' });

  const barY = y + 12;
  const barH = 16;
  ctx.fillStyle = PALETTE.TILE_OFF;
  ctx.fillRect(x, barY, w, barH);
  ctx.fillStyle = color;
  ctx.fillRect(x, barY, Math.max(2, Math.round(w * Math.min(1, Math.max(0, ratio)))), barH);
  ctx.strokeStyle = PALETTE.TILE_EDGE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, barY + 0.5, w - 1, barH - 1);

  let next = barY + barH + 20;
  if (note) {
    drawTracked(ctx, note, x, next, { size: 14, family: MONO, color: PALETTE.INK_FAINT });
    next += 14;
  }
  return next + 20;
}

function drawRail(
  ctx: SKRSContext2D,
  usage: UsageSnapshot | null | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  now: number,
  cfg: Config,
): void {
  ctx.fillStyle = PALETTE.TILE_EDGE;
  ctx.fillRect(x - 18, y + 6, 1, h - 12);

  drawTracked(ctx, 'Consumo', x, y + 20, {
    size: 19,
    family: COND,
    tracking: 3.4,
    smallCaps: true,
    color: PALETTE.INK_DIM,
  });

  if (!usage || usage.stale) {
    drawTracked(ctx, 'sin datos de ccusage', x, y + 52, { size: 15, family: MONO, color: PALETTE.INK_FAINT });
    return;
  }

  // Como mucho dos barras: por debajo va el pie, y una tercera lo pisaría.
  let cy = y + 62;
  if (usage.mode === 'max') {
    for (const win of (usage.windows ?? []).slice(0, 2)) {
      const note = win.resetsAt ? `reinicia en ${countdown(win.resetsAt - now)}` : null;
      cy = drawBar(ctx, x, cy, w, win.label, percent(win.ratio), win.ratio, note, cfg);
    }
  } else {
    for (const s of (usage.spend ?? []).slice(0, 2)) {
      const ratio = s.cap > 0 ? s.amount / s.cap : 0;
      const note = `de ${money(s.cap)}`;
      cy = drawBar(ctx, x, cy, w, s.label, money(s.amount), ratio, note, cfg);
    }
  }

  // Pie común, anclado abajo: tokens del día y reparto por modelo.
  const models = (usage.byModel ?? []).slice(0, 3);
  const rowH = 22;
  const footerTop = y + h - (30 + rowH * models.length + 14);
  hairline(ctx, x, footerTop, w, PALETTE.TILE_EDGE);

  let fy = footerTop + 26;
  drawTracked(ctx, 'Tokens hoy', x, fy, {
    size: 17,
    family: COND,
    tracking: 2.6,
    smallCaps: true,
    color: PALETTE.INK_DIM,
  });
  drawTracked(ctx, tokens(usage.tokensToday ?? 0), x + w, fy, {
    size: 18,
    family: MONO_BOLD,
    color: PALETTE.INK_BRIGHT,
    align: 'right',
  });

  fy += 26;
  for (const m of models) {
    drawClipped(ctx, m.model, x, fy, w - 80, { size: 14, family: MONO, color: PALETTE.INK_FAINT });
    drawTracked(ctx, tokens(m.tokens), x + w, fy, { size: 14, family: MONO, color: PALETTE.INK_FAINT, align: 'right' });
    fy += rowH;
  }
}

/** Dibuja el frame completo en un canvas. Único camino de render: preview y panel comparten esto. */
export function renderCanvas(input: FrameInput): Canvas {
  const cfg = input.config;
  const now = input.now ?? Date.now();
  registerFonts(cfg);

  const canvas = createCanvas(cfg.width, cfg.height);
  const ctx = canvas.getContext('2d');

  const sessions = pruneZombies(input.sessions, now, cfg.zombieMs);

  // Apagado en reposo: lo que se gasta con las horas es el backlight.
  if (sessions.length === 0 && cfg.blankWhenIdle) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, cfg.width, cfg.height);
    return canvas;
  }

  ctx.fillStyle = PALETTE.BG;
  ctx.fillRect(0, 0, cfg.width, cfg.height);

  const shift = input.shift ?? computeShift(now, cfg);
  ctx.save();
  ctx.translate(shift.x, shift.y);

  drawHeader(ctx, cfg, sessions, now);

  const m = cfg.margin;
  const bodyTop = cfg.headerHeight + 14;
  const bodyH = cfg.height - m - bodyTop;
  const railGap = 18;
  const railW = cfg.rail.enabled ? cfg.rail.width : 0;
  const available = cfg.width - 2 * m - (cfg.rail.enabled ? railW + railGap : 0);

  const p = plan(sessions, available, cfg);
  let tx = m;
  for (const tile of p.tiles) {
    drawTile(ctx, tile, tx, bodyTop, p.tileWidth, bodyH, now, cfg);
    tx += p.tileWidth + cfg.tile.gap;
  }
  if (p.overflow.length) drawSummary(ctx, p.overflow, tx, bodyTop, p.summaryWidth, bodyH);

  if (cfg.rail.enabled) {
    drawRail(ctx, input.usage, cfg.width - m - railW, bodyTop, railW, bodyH, now, cfg);
  }

  ctx.restore();
  return canvas;
}

/** PNG listo para escribir a fichero o para pasárselo a `trcc send`. */
export function renderFrame(input: FrameInput): Buffer {
  return renderCanvas(input).toBuffer('image/png');
}
