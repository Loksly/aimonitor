import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL, LEVEL_WIDTH, fateFor, gapGroups, simulate } from './platformer.ts';

const W = 1920;
const T = 66;
const GROUND = 6 * T;
/** Mitad del ancho y alto del corredor, en píxeles. Ver HERO_PX en el módulo. */
const HERO_HALF = 42;
const HERO_H = 112;

/** Semillas suficientes para cubrir todos los destinos del reparto. */
const SEEDS = Array.from({ length: 14 }, (_, i) => i);

test('Nivel: el salto llega a todos los huecos', () => {
  // Si un hueco fuese más ancho que el alcance, el corredor se caería siempre
  // y el guiño se convertiría en un tipo muriéndose en bucle.
  for (const [from, to] of gapGroups()) {
    assert.ok(to - from + 1 <= 3, `el hueco ${from}-${to} mide ${to - from + 1} tiles y el salto no da para tanto`);
  }
});

test('Nivel: las tuberías son de un tile de alto', () => {
  // A 12 fps el vuelo pasa por encima de 132 px de altura durante 1,87 tiles,
  // menos que los 2 que mide una tubería de ancho: una de dos tiles de alto no
  // se puede cruzar por arriba.
  for (const p of LEVEL.pipes) assert.equal(6 - p.top, 1, `la tubería de la columna ${p.col} es demasiado alta`);
});

test('Destino: `completa` llega al castillo y los demás se caen', () => {
  for (const seed of SEEDS) {
    const fate = fateFor(seed);
    const frames = simulate(W, seed);
    const murio = frames.some((f) => f.phase === 'muere');
    const llego = frames.some((f) => f.phase === 'hold');
    if (fate.kind === 'completa') {
      assert.ok(llego && !murio, `la semilla ${seed} debía completar el nivel`);
    } else {
      assert.ok(murio, `la semilla ${seed} debía fallar en ${fate.kind}`);
    }
  }
});

test('Destino: el reparto da victorias, pero pocas', () => {
  const wins = SEEDS.filter((s) => fateFor(s).kind === 'completa').length;
  assert.ok(wins > 0, 'nunca completarlo quita la gracia de completarlo');
  assert.ok(wins < SEEDS.length / 2, 'completarlo siempre lo vuelve rutina');
});

test('Corredor: sólo se cae cuando le toca caerse', () => {
  // El fallo tiene que venir del destino elegido, no de un disparador de salto
  // mal calibrado.
  for (const seed of SEEDS) {
    if (fateFor(seed).kind !== 'completa') continue;
    for (const f of simulate(W, seed)) {
      assert.ok(f.heroY <= GROUND + 1, `la semilla ${seed} se cayó en el frame ${f.index}`);
    }
  }
});

test('Corredor: no anda por el aire al salir de una tubería', () => {
  for (const seed of SEEDS) {
    for (const f of simulate(W, seed)) {
      if (f.phase !== 'run' || f.airborne || f.heroY >= GROUND - 1) continue;
      const sobreTuberia = LEVEL.pipes.some((p) => f.heroX >= p.col * T && f.heroX < (p.col + 2) * T);
      assert.ok(sobreTuberia, `frame ${f.index} de la semilla ${seed}: en el suelo, en alto y sin tubería debajo`);
    }
  }
});

test('Corredor: no atraviesa ladrillos', () => {
  for (const seed of SEEDS) {
    for (const f of simulate(W, seed)) {
      if (f.phase !== 'run') continue;
      for (const b of LEVEL.blocks) {
        if (b.kind === '#') continue;
        const solapa =
          f.heroX + HERO_HALF > b.col * T + 4 &&
          f.heroX - HERO_HALF < (b.col + 1) * T - 4 &&
          f.heroY > b.row * T + 4 &&
          f.heroY - HERO_H < (b.row + 1) * T - 4;
        assert.ok(!solapa, `la semilla ${seed} atraviesa el bloque de la columna ${b.col} en el frame ${f.index}`);
      }
    }
  }
});

test('Cámara: nunca se sale del nivel', () => {
  for (const seed of SEEDS) {
    for (const f of simulate(W, seed)) {
      assert.ok(f.camera >= 0 && f.camera <= LEVEL_WIDTH - W, `cámara fuera de sitio en el frame ${f.index}`);
    }
  }
});

test('Simulación: determinista', () => {
  const a = simulate(W, 3).map((f) => `${f.heroX}|${f.heroY}|${f.phase}`);
  const b = simulate(W, 3).map((f) => `${f.heroX}|${f.heroY}|${f.phase}`);
  assert.deepEqual(a, b);
});

test('Simulación: dura lo suficiente para verla y lo bastante poco para no cansar', () => {
  for (const seed of SEEDS) {
    const s = simulate(W, seed).length / 12;
    assert.ok(s > 5, `la semilla ${seed} dura ${s.toFixed(1)} s, no da tiempo ni a mirar`);
    assert.ok(s < 40, `la semilla ${seed} dura ${s.toFixed(1)} s, demasiado`);
  }
});
