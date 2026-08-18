/**
 * Capa de salida hacia el panel.
 *
 * El firmware LY del Trofeo Vision **descarta la imagen** y vuelve al logo de
 * fábrica pasados ~2-3 s sin recibir un frame. Es decir: no basta con pintar
 * cuando algo cambia, hay que mantener la imagen "clavada" reenviándola varias
 * veces por segundo.
 *
 * Y el interfaz USB es exclusivo: dos procesos de `trcc` no pueden hablarle a
 * la vez (`interface is in use by another process`). Por eso el reenvío no
 * puede ser un proceso aparte del que manda los frames nuevos.
 *
 * La solución es la API REST de `trcc serve`: un único proceso posee el USB y
 * serializa las dos cosas. Este módulo habla con esa API.
 *
 *   - `sendFrame`  → sólo cuando cambia algo (render caro, dirigido por eventos)
 *   - `pinFrame`   → bucle barato que reenvía el último frame cada 150 ms
 */
import type { Config } from './config.ts';

export interface Panel {
  /** Clave `VID:PID` del dispositivo. */
  key: string;
  width: number;
  height: number;
}

function base(cfg: Config): string {
  return cfg.trcc.api.url.replace(/\/+$/, '');
}

/** La clave lleva dos puntos, que hay que escapar en el path. */
function url(cfg: Config, key: string, suffix: string): string {
  return `${base(cfg)}/devices/${encodeURIComponent(key)}${suffix}`;
}

async function postJson(target: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${target}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** ¿Está `trcc serve` levantado? */
export async function serverAlive(cfg: Config): Promise<boolean> {
  try {
    const res = await fetch(`${base(cfg)}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pregunta al servidor qué panel hay y con qué resolución. Todo el renderizado
 * deriva de esto: el driver documenta 1920×462 y las tiendas anuncian 1920×480,
 * así que el dato lo pone el hardware, no una constante.
 */
export async function detectPanel(cfg: Config): Promise<Panel | null> {
  try {
    const res = await fetch(`${base(cfg)}/devices`, { signal: AbortSignal.timeout(cfg.trcc.timeoutMs) });
    if (!res.ok) return null;
    const data = (await res.json()) as { products?: { key?: string; native_resolution?: [number, number] }[] };
    const wanted = cfg.trcc.deviceKey;
    const list = data.products ?? [];
    const found = wanted ? list.find((p) => p.key === wanted) : list[0];
    if (!found?.key || !found.native_resolution) return null;
    const [width, height] = found.native_resolution;
    return { key: found.key, width, height };
  } catch {
    return null;
  }
}

/** Abre el dispositivo en el servidor. Sin esto los envíos se guardan pero no se pintan. */
export async function connectPanel(cfg: Config, key: string): Promise<void> {
  await postJson(url(cfg, key, '/connect'), {}, cfg.trcc.timeoutMs);
}

/** Sube un PNG y lo pinta. Lanza si el servidor responde error. */
export async function sendFrame(cfg: Config, key: string, png: Buffer): Promise<void> {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'frame.png');
  const target = url(cfg, key, '/display/send-image');
  const res = await fetch(target, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(cfg.trcc.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { ok?: boolean; message?: string };
  if (data.ok === false) throw new Error(data.message ?? 'el servidor rechazó el frame');
  // El servidor guarda el tema aunque el dispositivo no esté abierto; en ese
  // caso no se ha pintado nada y hay que enterarse.
  if (data.message && /not connected/i.test(data.message)) {
    throw new Error('el dispositivo no está conectado en el servidor');
  }
}

/**
 * Mantiene el último frame clavado en la pantalla.
 *
 * La petición es de larga duración: el servidor reenvía en bucle hasta que se
 * corta. Si se cae (reinicio de `trcc serve`, USB replugado), se vuelve a
 * lanzar sola. Reenvía **el último frame que haya recibido el servidor**, así
 * que un `sendFrame` posterior se propaga sin tocar este bucle.
 *
 * Devuelve la función que lo detiene.
 */
export function pinFrame(cfg: Config, key: string, onError: (msg: string) => void): () => void {
  let stopped = false;
  const controller = new AbortController();
  const { intervalS, burstS } = cfg.trcc.keepalive;
  // Ráfaga acotada y renovada, nunca `count: 0`. Ver el comentario de `burstS`.
  const count = Math.max(1, Math.round(burstS / intervalS));

  const loop = async () => {
    while (!stopped) {
      try {
        const res = await fetch(url(cfg, key, '/display/keepalive'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count, interval_s: intervalS }),
          signal: controller.signal,
        });
        if (!res.ok) {
          onError(`el keepalive devolvió HTTP ${res.status}; reintentando`);
          await new Promise((r) => setTimeout(r, 2000));
        }
        // Ráfaga completada: se encadena la siguiente sin pausa, para que la
        // imagen no quede desatendida ni un instante.
      } catch (err) {
        if (stopped) return;
        onError(`keepalive interrumpido: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  void loop();
  return () => {
    stopped = true;
    controller.abort();
  };
}
