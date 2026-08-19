import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';
import { ffmpegRecipe, isDue, pickClip, play, scaleFilter, seedFor, type Playable } from './easteregg.ts';

function cfg(patch: Record<string, unknown> = {}) {
  const c = loadConfig();
  c.easterEgg = { ...c.easterEgg, enabled: true, everyMs: 900_000, ...patch };
  return c;
}

const HORA = new Date('2026-08-18T12:00:00Z').getTime();

test('Guiño: no salta al arrancar', () => {
  assert.equal(isDue(cfg(), HORA, null), false);
});

test('Guiño: salta al cambiar de franja, no a los N ms del anterior', () => {
  const c = cfg();
  // Misma franja de cuarto de hora: todavía no.
  assert.equal(isDue(c, HORA + 60_000, HORA), false);
  // Franja siguiente: ahora sí, aunque hayan pasado sólo unos segundos.
  const casi = HORA + 899_000;
  assert.equal(isDue(c, casi + 2_000, casi), true);
});

test('Guiño: apagado no salta nunca', () => {
  const c = cfg({ enabled: false });
  assert.equal(isDue(c, HORA + 900_000, HORA), false);
});

test('Guiño: cada franja lleva su propia semilla', () => {
  const c = cfg();
  assert.notEqual(seedFor(c, HORA), seedFor(c, HORA + 900_000));
  assert.equal(seedFor(c, HORA), seedFor(c, HORA + 60_000));
});

/** Animación de mentira, para no rasterizar nada en las pruebas. */
function fake(count: number): Playable {
  return { count, label: 'prueba', frame: async (i) => Buffer.from([i]) };
}

test('Reproducción: manda todos los frames cuando da tiempo', async () => {
  const vistos: number[] = [];
  // 100 fps son 10 ms por frame: de sobra para un envío instantáneo, y sin
  // acercarse al margen donde el propio temporizador ya cuenta como retraso.
  const stats = await play(fake(5), 100, async (b) => void vistos.push(b[0]!));
  assert.equal(stats.sent, 5);
  assert.equal(stats.dropped, 0);
  assert.deepEqual(vistos, [0, 1, 2, 3, 4]);
});

test('Reproducción: si va tarde descarta frames en vez de ir a cámara lenta', async () => {
  // Un envío que tarda mucho más que el hueco entre frames: la animación tiene
  // que acabar en su tiempo, aunque llegue con huecos.
  const stats = await play(fake(20), 100, async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.ok(stats.dropped > 0, 'debería haber descartado frames');
  assert.equal(stats.sent + stats.dropped, 20);
});

test('Reproducción: se puede abortar a mitad', async () => {
  let n = 0;
  const stats = await play(fake(100), 100, async () => void n++, { abort: () => n >= 3 });
  assert.equal(stats.sent, 3);
});

test('Clips: el reparto llega a todos los ficheros', () => {
  // Con una mezcla de bits floja, `slot % n` recorre siempre el mismo ciclo
  // corto y algunos clips no salen nunca.
  for (const n of [2, 3, 4, 5, 7, 10]) {
    const files = Array.from({ length: n }, (_, i) => `clip-${i}.mp4`);
    const vistos = new Set(Array.from({ length: n * 30 }, (_, s) => pickClip(files, s)));
    assert.equal(vistos.size, n, `con ${n} clips sólo salieron ${vistos.size}`);
  }
});

test('Clips: la elección es determinista', () => {
  const files = ['a.mp4', 'b.mp4', 'c.mp4'];
  assert.equal(pickClip(files, 42), pickClip(files, 42));
});

test('Escalado: el pixel art va por factor entero y vecino más próximo', () => {
  // 256x224 (NES con el overscan recortado) entra justo al doble en 462 px de
  // alto: 448, con siete píxeles de negro arriba y abajo.
  const f = scaleFilter({ pixelated: true, crop: '' }, { w: 256, h: 224 }, 1920, 462);
  assert.match(f, /scale=512:448:flags=neighbor/);
  assert.match(f, /pad=1920:462/);
});

test('Escalado: si no cabe ni al doble, se encaja en vez de dejarlo diminuto', () => {
  // 256x240 no llega: 480 > 462. Escalar por factor 1 dejaría el clip perdido
  // en mitad del panel, así que se encaja aunque el factor no sea entero.
  const f = scaleFilter({ pixelated: true, crop: '' }, { w: 256, h: 240 }, 1920, 462);
  assert.match(f, /force_original_aspect_ratio=decrease:flags=neighbor/);
});

test('Escalado: la imagen real no se escala con vecino', () => {
  const f = scaleFilter({ pixelated: false, crop: '' }, { w: 1920, h: 1080 }, 1920, 462);
  assert.doesNotMatch(f, /neighbor/);
});

test('Escalado: sin poder medir el origen, se encaja y ya', () => {
  assert.match(scaleFilter({ pixelated: true, crop: '' }, null, 1920, 462), /force_original_aspect_ratio=decrease/);
});

test('Escalado: el recorte manda sobre el tamaño de origen al buscar el factor', () => {
  // Una franja apaisada de 256x115 entra al cuádruple: 1024x460, más del doble
  // de ancho que los 512 px que daría el fotograma 4:3 entero.
  const f = scaleFilter({ pixelated: true, crop: '256:115:0:100' }, { w: 256, h: 240 }, 1920, 462);
  assert.match(f, /^crop=256:115:0:100,/);
  assert.match(f, /scale=1024:460:flags=neighbor/);
});

test('Caché: la receta cambia con cada opción que afecta al resultado', () => {
  // La clave de la caché se deriva de la receta. Si una opción no la cambiara,
  // tocarla reutilizaría los frames viejos sin decir nada.
  const base = loadConfig();
  const probed = { w: 1920, h: 462, fps: 12 };
  const recipe = (patch: Record<string, unknown>) => {
    const c = loadConfig();
    c.easterEgg = { ...base.easterEgg, fps: 6, speed: 1, pixelated: true, crop: '', maxSeconds: 30, ...patch };
    return JSON.stringify(ffmpegRecipe(c, probed, 1920, 462));
  };
  const original = recipe({});
  for (const [campo, patch] of [
    ['fps', { fps: 8 }],
    ['speed', { speed: 0.5 }],
    ['pixelated', { pixelated: false }],
    ['crop', { crop: '256:115:0:110' }],
    ['maxSeconds', { maxSeconds: 20 }],
  ] as const) {
    assert.notEqual(recipe(patch), original, `cambiar ${campo} debe invalidar la caché`);
  }
});

test('Cadencia: la velocidad decide a qué ritmo se despieza', () => {
  const c = loadConfig();
  c.easterEgg = { ...c.easterEgg, fps: 6, speed: 0.5, pixelated: true, crop: '', maxSeconds: 40 };
  const r = ffmpegRecipe(c, { w: 1920, h: 462, fps: 12 }, 1920, 462);
  // A media velocidad se despieza al doble de la tasa de reproducción, para
  // enseñar todos los frames del origen en vez de descartar uno de cada dos.
  assert.match(r.filter, /^fps=12,/);
  // Y hace falta la mitad de clip para llenar el mismo rato de panel.
  assert.equal(r.seconds, 20);
});
