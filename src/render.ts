import { freemem, totalmem } from 'node:os';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { PALETTE, STATE_COLOR, STATE_LABEL, STATE_PRIORITY, ratioColor, tempColor, vitalColor, type Config } from './config.ts';
import { COND, MONO, MONO_BOLD, drawClipped, drawTracked, fitSize, registerFonts, wrapLines } from './fonts.ts';
import { clock, countdown, elapsed, gigabytes, money, percent, shortId, tokens } from './format.ts';
import { claims, plan, pruneZombies, spareWidth, type Tile } from './select.ts';
import { sparkBars } from './sparkline.ts';
import type { SessionRecord, Shift, SystemSnapshot, UsageSnapshot, Weight } from './types.ts';

export interface FrameInput {
  sessions: SessionRecord[];
  usage?: UsageSnapshot | null;
  /** Vitales de la máquina. Inyectable para que fixtures y preview sean estables. */
  system?: SystemSnapshot | null;
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
  drawTracked(ctx, r.startsAt === undefined ? STATE_LABEL[r.state] : 'Reunión', cx, y + 32, labelOpts);
  const provIdLabel =
    r.startsAt === undefined
      ? `${r.provider.toUpperCase()} · ${shortId(r.session_id)}`
      : clock(new Date(r.startsAt));
  drawTracked(ctx, provIdLabel, x + w - 18, y + 31, {
    size: 15,
    family: MONO,
    color: ink.faint,
    align: 'right',
  });

  // 2. Regla fina
  hairline(ctx, cx, y + 46, cw, ink.rule);

  // 5. El número grande, abajo. En una consola es cuánto lleva así; en una
  //    reunión es cuánto queda, que es la misma pregunta mirando al revés.
  const footerBase = y + h - 16;
  const elapsedSize = Math.round(Math.min(60, Math.max(38, h * 0.14)));
  const elapsedBase = footerBase - 26;
  const big =
    r.startsAt === undefined
      ? elapsed(now - r.since)
      : r.startsAt <= now
        ? 'ahora'
        : countdown(r.startsAt - now);
  drawTracked(ctx, big, cx, elapsedBase, {
    size: elapsedSize,
    family: MONO_BOLD,
    color: ink.strong,
    tracking: -1,
  });

  // 4. Detalle técnico, justo encima del tiempo. Se reparte en varias líneas:
  //    con una sola, un mensaje de asistente se cortaba a media frase y no se
  //    entendía de qué iba la consola. Las líneas crecen hacia arriba, hacia el
  //    aire que dejaba el nombre del proyecto, y el contador no se mueve.
  const detailOpts = { size: 17, family: MONO, color: ink.mid } as const;
  const detailLead = Math.round(detailOpts.size * 1.35);
  const detailLines = wrapLines(ctx, r.detail, cw, Math.max(1, cfg.tile.detailLines), detailOpts);
  const detailBase = elapsedBase - elapsedSize * 0.8 - 14;
  detailLines.forEach((line, i) => {
    drawTracked(ctx, line, cx, detailBase - (detailLines.length - 1 - i) * detailLead, detailOpts);
  });
  const detailTop = detailBase - Math.max(0, detailLines.length - 1) * detailLead;

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
  const midBottom = detailTop - 24;
  const projBase = Math.round((midTop + midBottom) / 2 + projOpts.size * 0.36);
  drawClipped(ctx, r.project, cx, projBase, cw, projOpts);

  // 6. Pie: ficheros pendientes de commit
  if (r.dirty !== undefined) {
    const txt = r.dirty === 0 ? 'git limpio' : `git ${r.dirty} sin commit`;
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

/**
 * Alto que consume `drawBar`, con y sin nota al pie. Se declara aquí, pegado a
 * la función, para que quien mida antes de dibujar no tenga que deducirlo.
 */
export const BAR_SLOT = 68;
export const BAR_SLOT_WITH_NOTE = 82;

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
  /** Por defecto el semáforo de las casillas; la columna de sistema pasa el suyo. */
  colorFn: (r: number, t: Config['thresholds']) => string = ratioColor,
): number {
  const color = colorFn(Math.min(1, ratio), cfg.thresholds);
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


/** Una cifra grande con su rótulo debajo. */
function drawStat(ctx: SKRSContext2D, x: number, y: number, value: string, label: string, color: string, size: number): void {
  drawTracked(ctx, value, x, y, { size, family: MONO_BOLD, color, tracking: -0.5 });
  drawTracked(ctx, label, x, y + 17, {
    size: 13,
    family: COND,
    tracking: 2.4,
    smallCaps: true,
    color: PALETTE.INK_FAINT,
  });
}

/**
 * Columna de vitales que ocupa el ancho sobrante cuando hay pocas sesiones.
 *
 * Toda la tinta es apagada (`INK_DIM`/`INK_FAINT`) mientras las cosas van bien:
 * quien tiene que reclamar la atención es una consola bloqueada, no el disco.
 * Sólo al cruzar los umbrales aparece el ámbar o el rojo, y entonces sí compite,
 * que es justo lo que se quiere.
 */
function drawSystem(
  ctx: SKRSContext2D,
  sys: SystemSnapshot,
  usage: UsageSnapshot | null | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  cfg: Config,
): void {
  ctx.fillStyle = PALETTE.TILE_EDGE;
  ctx.fillRect(x - 18, y + 6, 1, h - 12);

  drawTracked(ctx, 'Sistema', x, y + 20, {
    size: 19,
    family: COND,
    tracking: 3.4,
    smallCaps: true,
    color: PALETTE.INK_DIM,
  });
  hairline(ctx, x, y + 34, w, PALETTE.TILE_EDGE);

  // 1. Cifras. Sólo se listan las que se han podido leer: en un sistema que no
  //    sea Linux faltarán varias y la columna se adapta sin huecos.
  const stats: { value: string; label: string; color: string }[] = [];
  if (sys.cpuTemp !== undefined) {
    stats.push({ value: `${Math.round(sys.cpuTemp)}°`, label: w < 380 ? 'temp' : 'temp cpu', color: tempColor(sys.cpuTemp, cfg.system) });
  }
  if (sys.cpuUsage !== undefined) {
    stats.push({ value: percent(sys.cpuUsage), label: 'cpu', color: vitalColor(sys.cpuUsage, cfg.system) });
  }
  if (sys.mem) {
    const r = sys.mem.used / sys.mem.total;
    stats.push({ value: percent(r), label: 'ram', color: vitalColor(r, cfg.system) });
  }
  if (sys.disk) {
    const r = sys.disk.used / sys.disk.total;
    stats.push({ value: percent(r), label: 'disco', color: vitalColor(r, cfg.system) });
  }

  const wide = w >= cfg.system.perCoreMinWidth;
  const narrow = w < 380;
  const perRow = narrow ? 2 : Math.min(4, stats.length);
  const statSize = wide ? 40 : narrow ? 26 : 32;
  const colW = perRow > 0 ? w / perRow : w;
  let statsBottom = y + 40;
  stats.forEach((st, i) => {
    const row = Math.floor(i / perRow);
    const baseline = y + 82 + row * (statSize + 30);
    drawStat(ctx, x + (i % perRow) * colW, baseline, st.value, st.label, st.color, statSize);
    statsBottom = Math.max(statsBottom, baseline + 24);
  });

  // 3. Sparkline anclada abajo; se reserva su espacio antes de repartir el resto.
  const points = usage?.blockHistory ?? [];
  const sparkH = points.length ? 110 : 0;
  const sparkTop = y + h - sparkH;

  if (points.length) {
    const labelBase = sparkTop - 14;
    hairline(ctx, x, labelBase - 20, w, PALETTE.TILE_EDGE);
    // En estrecho no caben rótulo y pico a la vez: se sacrifica el pico, que
    // es contexto, y no el rótulo, que dice qué se está mirando.
    drawTracked(ctx, narrow ? 'Bloques 5 h' : 'Gasto por bloque (5 h)', x, labelBase, {
      size: 15,
      family: COND,
      tracking: narrow ? 1.8 : 2.6,
      smallCaps: true,
      color: PALETTE.INK_DIM,
    });
    if (!narrow) {
      const peak = Math.max(...points.map((p) => p.cost));
      drawTracked(ctx, `pico ${money(peak)}`, x + w, labelBase, {
        size: 14,
        family: MONO,
        color: PALETTE.INK_FAINT,
        align: 'right',
      });
    }
    for (const bar of sparkBars(points.map((p) => p.cost), w, sparkH, { gap: 3 })) {
      // El bloque en curso se destaca subiendo un escalón de tinta, no con un
      // color de estado: el semáforo es el idioma de las consolas.
      ctx.fillStyle = points[bar.index]?.active ? PALETTE.INK_DIM : PALETTE.INK_FAINT;
      ctx.fillRect(x + bar.x, sparkTop + bar.y, bar.w, bar.h);
    }
  }

  // 2. Barras por núcleo, sólo si sobra ancho y hay delta que mostrar. En el
  //    primer render no hay muestra previa de /proc/stat y `cores` viene vacío.
  // Banda acotada: con la máquina en reposo son 16 carriles casi vacíos, y
  // estirarlos a toda la altura libre sería cambiar negro por gris sin añadir
  // información. El sobrante se lo queda la sparkline, que sí varía.
  const coresTop = statsBottom + 16;
  const coresH = Math.min(110, sparkTop - 34 - coresTop);
  const canShowCores = wide && !!sys.cores?.length && coresH >= 30;

  // Nivel intermedio: no hay ancho para 16 carriles, pero sí para las dos
  // barras que de verdad importan. Se reutiliza `drawBar`, el mismo primitivo
  // del carril de consumo, con el color apagado de los vitales.
  if (!canShowCores) {
    // Sólo el disco. La RAM ya sale dos veces (cabecera y fila de cifras) y una
    // tercera barra no añadiría nada; el llenado del disco, en cambio, no está
    // en ningún otro sitio y es el vital que más pronto da un disgusto.
    const bandTop = coresTop + 6;
    const bandBottom = sparkTop - 34;
    if (sys.disk && bandTop + BAR_SLOT <= bandBottom) {
      const r = sys.disk.used / sys.disk.total;
      const note =
        bandTop + BAR_SLOT_WITH_NOTE <= bandBottom
          ? `${gigabytes(sys.disk.used)} de ${gigabytes(sys.disk.total)} · quedan ${gigabytes(sys.disk.total - sys.disk.used)}`
          : null;
      drawBar(ctx, x, bandTop, w, `Disco ${sys.disk.path}`, percent(r), r, note, cfg, (v) => vitalColor(v, cfg.system));
    }
  }

  if (canShowCores && sys.cores) {
    // A la derecha: bajo la primera cifra ya está su propio rótulo y se pisaban.
    drawTracked(ctx, `${sys.cores.length} núcleos`, x + w, coresTop - 6, {
      size: 14,
      family: COND,
      tracking: 2.4,
      smallCaps: true,
      color: PALETTE.INK_FAINT,
      align: 'right',
    });
    const barsTop = coresTop + 6;
    const barsH = coresH - 6;
    // Escala absoluta contra el 100 %: normalizar contra el núcleo más ocupado
    // haría parecer saturada una máquina en reposo.
    for (const bar of sparkBars(sys.cores, w, barsH, { gap: 3, max: 1 })) {
      ctx.fillStyle = PALETTE.TILE_OFF;
      ctx.fillRect(x + bar.x, barsTop, bar.w, barsH);
      ctx.fillStyle = vitalColor(sys.cores[bar.index] ?? 0, cfg.system);
      ctx.fillRect(x + bar.x, barsTop + bar.y, bar.w, bar.h);
    }
  }
}

/** Dibuja el frame completo en un canvas. Único camino de render: preview y panel comparten esto. */
export function renderCanvas(input: FrameInput): Canvas {
  const cfg = input.config;
  const now = input.now ?? Date.now();
  registerFonts(cfg);

  const canvas = createCanvas(cfg.width, cfg.height);
  const ctx = canvas.getContext('2d');

  const sessions = pruneZombies(input.sessions, now, cfg.zombieMs, cfg.staleMs);

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

  // Con pocas casillas sobra un hueco considerable (1088 px con una sola
  // sesión). Se rellena con los vitales de la máquina. Cuando hay desbordamiento
  // el sobrante es cero, así que esta columna y el resumen de sesiones no pueden
  // coincidir: son excluyentes por construcción.
  const usedW = p.tiles.length * p.tileWidth + Math.max(0, p.tiles.length - 1) * cfg.tile.gap;
  const spare = spareWidth(p, available, cfg);
  if (cfg.system.enabled && input.system && spare >= cfg.system.minWidth) {
    const sx = m + usedW + cfg.tile.gap + 18;
    // Se respira 20 px antes del separador del carril: si no, las barras y el
    // rótulo del pico quedan pegados a la línea y parece un error de recorte.
    drawSystem(ctx, input.system, input.usage, sx, bodyTop, spare - cfg.tile.gap - 38, bodyH, cfg);
  }

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
