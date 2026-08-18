import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sparkBars } from './sparkline.ts';

test('Sparkline: escala relativa al máximo de la serie', () => {
  const bars = sparkBars([1, 2, 4], 90, 40);
  assert.equal(bars.length, 3);
  assert.equal(bars[2]!.h, 40); // el máximo llena el alto
  assert.equal(bars[1]!.h, 20); // la mitad, la mitad
  assert.equal(bars[0]!.h, 10);
  assert.ok(bars[0]!.x < bars[1]!.x && bars[1]!.x < bars[2]!.x);
});

test('Sparkline: las barras crecen desde abajo', () => {
  for (const b of sparkBars([3, 9, 1], 60, 30)) {
    assert.equal(b.y + b.h, 30, 'el pie de cada barra toca la base del recuadro');
  }
});

test('Sparkline: una serie plana no divide por cero', () => {
  const bars = sparkBars([5, 5, 5], 60, 30);
  assert.equal(bars.length, 3);
  for (const b of bars) assert.ok(Number.isFinite(b.h) && b.h === 30);
});

test('Sparkline: todo ceros deja el alto mínimo, no NaN', () => {
  for (const b of sparkBars([0, 0], 60, 30)) {
    assert.equal(b.h, 1);
    assert.ok(Number.isFinite(b.y));
  }
});

test('Sparkline: casos degenerados no revientan', () => {
  assert.deepEqual(sparkBars([], 60, 30), []);
  assert.deepEqual(sparkBars([1, 2], 0, 30), []);
  assert.deepEqual(sparkBars([1, 2], 60, 0), []);
  assert.equal(sparkBars([7], 60, 30).length, 1);
});

test('Sparkline: con max explícito la escala es absoluta', () => {
  // Sin `max`, una máquina en reposo se vería saturada: el núcleo más ocupado
  // marcaría el 100 % aunque estuviera al 5 %.
  const relativo = sparkBars([0.05, 0.02], 60, 40);
  assert.equal(relativo[0]!.h, 40, 'sin max, el mayor llena');

  const absoluto = sparkBars([0.05, 0.02], 60, 40, { max: 1 });
  assert.equal(absoluto[0]!.h, 2);
  assert.equal(absoluto[1]!.h, 1);
});

test('Sparkline: con muchas barras se sacrifica el hueco, no la barra', () => {
  const bars = sparkBars(Array(60).fill(1), 100, 20);
  assert.equal(bars.length, 60);
  for (const b of bars) assert.ok(b.w >= 1, 'ninguna barra desaparece');
});
