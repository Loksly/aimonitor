import { CLAIMS, STATE_PRIORITY, type Config } from './config.ts';
import type { SessionRecord, Weight } from './types.ts';

export interface Tile {
  record: SessionRecord;
  weight: Weight;
}

/** ¿Esta sesión me reclama? */
export function claims(r: SessionRecord): boolean {
  return CLAIMS.has(r.state);
}

/**
 * Descarta sesiones zombi: `activa` sin refrescar en mucho tiempo significa
 * que el proceso murió sin llegar a emitir SessionEnd.
 */
export function pruneZombies(records: SessionRecord[], now: number, zombieMs: number): SessionRecord[] {
  return records.filter((r) => !(r.state === 'activa' && now - r.updated > zombieMs));
}

/**
 * Orden de presentación: primero las que reclaman, por prioridad de estado y,
 * a igual estado, la que lleva más tiempo esperando. Después el resto, por
 * actividad reciente.
 */
export function order(records: SessionRecord[]): SessionRecord[] {
  return [...records].sort((a, b) => {
    const ca = claims(a) ? 1 : 0;
    const cb = claims(b) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const pa = STATE_PRIORITY[a.state];
    const pb = STATE_PRIORITY[b.state];
    if (pa !== pb) return pb - pa;
    if (ca === 1) return a.since - b.since; // la que lleva más parada, delante
    return b.updated - a.updated;
  });
}

/**
 * Reparte los tres pesos visuales. Regla que sostiene todo el diseño:
 * **como mucho una casilla sólida**, la más urgente de las que reclaman.
 * Si se encendieran varias a la vez, ninguna ganaría.
 */
export function assignWeights(ordered: SessionRecord[]): Tile[] {
  let solidUsed = false;
  return ordered.map((record) => {
    if (!claims(record)) return { record, weight: 'quieta' as Weight };
    if (!solidUsed) {
      solidUsed = true;
      return { record, weight: 'solido' as Weight };
    }
    return { record, weight: 'marcada' as Weight };
  });
}

export interface Plan {
  tiles: Tile[];
  /** Sesiones que no caben y se resumen en la columna final. */
  overflow: SessionRecord[];
  tileWidth: number;
  summaryWidth: number;
}

/**
 * Decide cuántas casillas caben en `available` px respetando los anchos
 * mínimo y máximo, y qué queda para la columna de resumen.
 */
export function plan(records: SessionRecord[], available: number, cfg: Config): Plan {
  const { min, max, gap } = cfg.tile;
  const all = assignWeights(order(records));
  const summaryWidth = 150;

  const fits = (n: number, reserve: number) => (available - reserve - (n - 1) * gap) / n >= min;

  let visible = all.length;
  let reserve = 0;
  while (visible > 1 && !fits(visible, reserve)) {
    visible--;
    reserve = summaryWidth + gap; // en cuanto sobra alguna, hay que resumirla
  }
  if (visible < all.length && reserve === 0) reserve = summaryWidth + gap;

  const tileWidth = Math.min(max, Math.floor((available - reserve - (visible - 1) * gap) / Math.max(1, visible)));
  return {
    tiles: all.slice(0, visible),
    overflow: all.slice(visible).map((t) => t.record),
    tileWidth,
    summaryWidth: visible < all.length ? summaryWidth : 0,
  };
}

/**
 * Ancho que sobra a la derecha de las casillas, donde cabe la columna de
 * vitales. Se saca aquí, fuera del render, para poder comprobarlo sin dibujar.
 *
 * Cuando hay desbordamiento el resumen ya se come el sobrante, así que la
 * columna y el resumen no pueden coincidir nunca.
 */
export function spareWidth(p: Plan, available: number, cfg: Config): number {
  const used = p.tiles.length * p.tileWidth + Math.max(0, p.tiles.length - 1) * cfg.tile.gap;
  return available - used - (p.summaryWidth ? p.summaryWidth + cfg.tile.gap : 0);
}
