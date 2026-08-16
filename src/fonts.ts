import { GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import type { Config } from './config.ts';

/**
 * Alias propios: fontconfig reporta la condensada como familia compuesta
 * ("DejaVu Sans,DejaVu Sans Condensed"), así que registramos por ruta absoluta
 * y nos referimos siempre a estos nombres.
 */
export const COND = 'LcdCond';
export const MONO = 'LcdMono';
export const MONO_BOLD = 'LcdMonoBold';

let registered = false;

export function registerFonts(cfg: Config): void {
  if (registered) return;
  const missing: string[] = [];
  if (!GlobalFonts.registerFromPath(cfg.fonts.condensedBold, COND)) missing.push(cfg.fonts.condensedBold);
  if (!GlobalFonts.registerFromPath(cfg.fonts.mono, MONO)) missing.push(cfg.fonts.mono);
  if (!GlobalFonts.registerFromPath(cfg.fonts.monoBold, MONO_BOLD)) missing.push(cfg.fonts.monoBold);
  if (missing.length) {
    throw new Error(
      `No se pudieron cargar fuentes: ${missing.join(', ')}\n` +
        'Instala el paquete fonts-dejavu-core o ajusta "fonts" en la configuración.',
    );
  }
  registered = true;
}

export interface TextOpts {
  size: number;
  family?: string;
  color?: string;
  /** Espaciado extra entre caracteres, en px. */
  tracking?: number;
  /** Versalitas: todo en caja alta, las minúsculas de origen más pequeñas. */
  smallCaps?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Factor de altura de las versalitas respecto a la mayúscula. */
  capRatio?: number;
}

interface Glyph {
  ch: string;
  size: number;
  width: number;
}

function glyphs(ctx: SKRSContext2D, text: string, o: TextOpts): Glyph[] {
  const family = o.family ?? COND;
  const small = o.smallCaps === true;
  const capSize = o.size * (o.capRatio ?? 0.76);
  const out: Glyph[] = [];
  for (const ch of text) {
    // Una minúscula en versalitas se dibuja en caja alta y a menor cuerpo.
    const isLower = small && ch !== ch.toUpperCase() && ch === ch.toLowerCase();
    const size = isLower ? capSize : o.size;
    const draw = small ? ch.toUpperCase() : ch;
    ctx.font = `${size}px "${family}"`;
    out.push({ ch: draw, size, width: ctx.measureText(draw).width });
  }
  return out;
}

function advance(gs: Glyph[], tracking: number): number {
  if (!gs.length) return 0;
  // El tracking va entre caracteres, no después del último.
  return gs.reduce((a, g) => a + g.width, 0) + tracking * (gs.length - 1);
}

/** Ancho que ocuparía el texto con este tracking, sin dibujarlo. */
export function measureTracked(ctx: SKRSContext2D, text: string, o: TextOpts): number {
  return advance(glyphs(ctx, text, o), o.tracking ?? 0);
}

/**
 * Dibuja carácter a carácter para poder aplicar tracking y versalitas,
 * que la API de canvas no ofrece. `y` es la línea base. Devuelve el ancho.
 */
export function drawTracked(ctx: SKRSContext2D, text: string, x: number, y: number, o: TextOpts): number {
  const family = o.family ?? COND;
  const tracking = o.tracking ?? 0;
  const gs = glyphs(ctx, text, o);
  const total = advance(gs, tracking);
  let cursor = o.align === 'right' ? x - total : o.align === 'center' ? x - total / 2 : x;
  if (o.color) ctx.fillStyle = o.color;
  ctx.textBaseline = 'alphabetic';
  for (const g of gs) {
    ctx.font = `${g.size}px "${family}"`;
    ctx.fillText(g.ch, cursor, y);
    cursor += g.width + tracking;
  }
  return total;
}

/** Recorta con elipsis hasta que quepa en `maxWidth`. */
export function truncate(ctx: SKRSContext2D, text: string, maxWidth: number, o: TextOpts): string {
  if (measureTracked(ctx, text, o) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1) {
    chars.pop();
    const candidate = chars.join('').trimEnd() + '…';
    if (measureTracked(ctx, candidate, o) <= maxWidth) return candidate;
  }
  return '…';
}

/**
 * Mayor cuerpo que hace caber el texto entero, sin bajar de `minSize`.
 * El nombre del proyecto identifica la consola: encogerlo es mejor que cortarlo.
 */
export function fitSize(ctx: SKRSContext2D, text: string, maxWidth: number, o: TextOpts, minSize: number): number {
  let size = o.size;
  while (size > minSize && measureTracked(ctx, text, { ...o, size }) > maxWidth) size -= 1;
  return size;
}

/** Dibuja recortando al ancho disponible. */
export function drawClipped(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  o: TextOpts,
): number {
  return drawTracked(ctx, truncate(ctx, text, maxWidth, o), x, y, o);
}
