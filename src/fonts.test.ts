import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { DEFAULT_CONFIG } from './config.ts';
import { MONO, measureTracked, registerFonts, wrapLines } from './fonts.ts';

/** Las medidas dependen de las fuentes reales; sin ellas no hay nada que probar. */
let ready = true;
try {
  registerFonts(DEFAULT_CONFIG);
} catch {
  ready = false;
}
const skip = ready ? false : 'faltan las fuentes DejaVu';

const ctx = createCanvas(100, 100).getContext('2d');
const opts = { size: 17, family: MONO } as const;
/** Ancho útil de una casilla estándar: 430 px menos los márgenes internos. */
const W = 430 - 18 - 18;

test('wrapLines: un texto corto se queda en una línea', { skip }, () => {
  assert.deepEqual(wrapLines(ctx, 'Stop', W, 3, opts), ['Stop']);
});

test('wrapLines: reparte un mensaje largo y ninguna línea desborda', { skip }, () => {
  const msg = 'Your Thermalright panel is working and the dashboard is now live with the adaptive vitals column';
  const lines = wrapLines(ctx, msg, W, 3, opts);
  assert.ok(lines.length > 1, 'debería repartirse');
  assert.ok(lines.length <= 3, 'y respetar el máximo');
  for (const l of lines) {
    assert.ok(measureTracked(ctx, l, opts) <= W, `"${l}" no cabe en ${W}px`);
  }
});

test('wrapLines: no parte palabras si puede evitarlo', { skip }, () => {
  const lines = wrapLines(ctx, 'alpha bravo charlie delta echo foxtrot golf hotel india', W, 3, opts);
  // Reconstruido debe seguir siendo el mismo texto, palabra a palabra.
  assert.ok(lines.join(' ').startsWith('alpha bravo'));
  for (const l of lines) assert.ok(!l.startsWith(' ') && !l.endsWith(' '));
});

test('wrapLines: la última línea lleva elipsis si aún sobra texto', { skip }, () => {
  const largo = 'palabra '.repeat(80).trim();
  const lines = wrapLines(ctx, largo, W, 2, opts);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.endsWith('…'), 'se avisa de que hay más');
  assert.ok(measureTracked(ctx, lines[1]!, opts) <= W);
});

test('wrapLines: una sola palabra más ancha que la línea se corta en duro', { skip }, () => {
  // Una ruta o una URL sin espacios: mejor partirla que dejar la línea vacía.
  const lines = wrapLines(ctx, '/etc/systemd/system/aimonitor-con-un-nombre-larguisimo.service', W, 3, opts);
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.ok(measureTracked(ctx, l, opts) <= W);
});

test('wrapLines: casos degenerados', { skip }, () => {
  assert.deepEqual(wrapLines(ctx, '', W, 3, opts), []);
  assert.deepEqual(wrapLines(ctx, '   ', W, 3, opts), []);
  assert.deepEqual(wrapLines(ctx, 'algo', W, 0, opts), []);
  assert.deepEqual(wrapLines(ctx, 'algo', 0, 3, opts), []);
});

test('wrapLines: colapsa saltos y espacios repetidos', { skip }, () => {
  assert.deepEqual(wrapLines(ctx, 'uno\n\ndos   tres', W, 3, opts), ['uno dos tres']);
});
