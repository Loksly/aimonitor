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

/**
 * Recorta con elipsis hasta que quepa en `maxWidth`.
 *
 * La búsqueda es binaria y no carácter a carácter: medir es caro (se recorre
 * glifo a glifo para poder aplicar tracking), así que el bucle ingenuo es
 * cuadrático. Con detalles de 240 caracteres eso costaba cientos de
 * milisegundos por frame.
 */
export function truncate(ctx: SKRSContext2D, text: string, maxWidth: number, o: TextOpts): string {
  if (measureTracked(ctx, text, o) <= maxWidth) return text;
  const chars = [...text];
  const candidate = (n: number) => `${chars.slice(0, n).join('').trimEnd()}…`;
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureTracked(ctx, candidate(mid), o) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? candidate(lo) : '…';
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

/**
 * Mayor prefijo de `text` que cabe en `maxWidth`, retrocediendo al último
 * espacio para no partir palabras. Si una sola palabra ya no cabe, corta duro:
 * más vale partir una ruta larga que dejar la línea vacía.
 *
 * La búsqueda es binaria porque medir es caro: `measureTracked` recorre carácter
 * a carácter para poder aplicar tracking.
 */
function fitPrefix(ctx: SKRSContext2D, text: string, maxWidth: number, o: TextOpts): number {
  if (measureTracked(ctx, text, o) <= maxWidth) return text.length;
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureTracked(ctx, text.slice(0, mid), o) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const space = text.lastIndexOf(' ', lo);
  return space > 0 ? space : lo;
}

/**
 * Reparte el texto en como mucho `maxLines` líneas que quepan en `maxWidth`.
 * La última se recorta con elipsis si aún sobra texto, así que nunca desborda.
 */
export function wrapLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  o: TextOpts,
): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || maxLines < 1 || maxWidth <= 0) return [];

  const lines: string[] = [];
  let rest = clean;
  while (rest && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      lines.push(truncate(ctx, rest, maxWidth, o));
      break;
    }
    const cut = fitPrefix(ctx, rest, maxWidth, o);
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return lines;
}
