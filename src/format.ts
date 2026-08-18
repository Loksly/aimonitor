const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Tiempo transcurrido, en grande. Granularidad de minuto a propósito: el panel
 * solo se redibuja cuando cambia algo, más una vez por minuto, así que unos
 * segundos en pantalla estarían mintiendo con precisión falsa. Además "18 min"
 * se lee de reojo mejor que "18:07".
 */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'ahora';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}`;
  return `${Math.floor(h / 24)}d ${pad(h % 24)}h`;
}

/** Cuenta atrás compacta para los reinicios de ventana. */
export function countdown(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m >= 60) return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  return `${m}m`;
}

export function clock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Id corto y estable para reconocer la consola en la casilla. */
export function shortId(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}

export function money(n: number): string {
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Tamaño en GB, que es la unidad en la que se piensa la RAM y el disco. */
export function gigabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)}GB`;
}
