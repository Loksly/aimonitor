/**
 * Geometría de la sparkline de consumo.
 *
 * Sólo cálculo: no toca el canvas, para poder probarlo sin renderizar nada.
 * Se dibuja con barras y no con una línea porque el resto del panel ya habla
 * ese idioma (las barras del carril), y a este tamaño una línea de 1 px sobre
 * fondo oscuro se pierde.
 */

export interface SparkBar {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Posición en la serie original. */
  index: number;
  value: number;
}

export interface SparkOptions {
  /** Separación entre barras. */
  gap?: number;
  /** Altura mínima para que un valor de cero siga marcando su hueco. */
  minHeight?: number;
  /**
   * Denominador fijo en lugar del máximo de la serie. Necesario cuando los
   * valores ya son una razón con significado propio: el uso por núcleo se mide
   * contra el 100 %, y normalizarlo contra el núcleo más ocupado haría parecer
   * saturada una máquina en reposo.
   */
  max?: number;
}

/**
 * Reparte `values` en `w` × `h`, con el origen en la esquina superior izquierda
 * del recuadro (las barras crecen hacia arriba desde abajo).
 *
 * La escala es siempre relativa al máximo de la serie: interesa la forma
 * —"¿hoy voy disparado o como siempre?"— y no el valor absoluto, que ya está
 * escrito al lado en cifras.
 */
export function sparkBars(values: number[], w: number, h: number, opts: SparkOptions = {}): SparkBar[] {
  const n = values.length;
  if (n === 0 || w <= 0 || h <= 0) return [];

  const gap = opts.gap ?? 2;
  const minHeight = opts.minHeight ?? 1;

  // Con muchas barras el hueco se come el ancho; se sacrifica antes el hueco
  // que la barra, que es lo que porta el dato.
  const effGap = n > 1 && (w - gap * (n - 1)) / n < 1 ? 0 : gap;
  const barW = Math.max(1, (w - effGap * (n - 1)) / n);

  const max = opts.max ?? Math.max(...values);
  return values.map((value, index) => {
    // Serie plana (o todo ceros): sin denominador válido, todas al mínimo. Una
    // división por cero pintaría NaN y el canvas se lo tragaría en silencio.
    const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    const barH = Math.max(minHeight, Math.round(h * ratio));
    return {
      x: Math.round(index * (barW + effGap)),
      y: Math.round(h - barH),
      w: Math.max(1, Math.round(barW)),
      h: barH,
      index,
      value,
    };
  });
}
