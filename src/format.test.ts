import { test } from 'node:test';
import assert from 'node:assert';
import { elapsed, countdown, shortId, tokens, money, percent } from './format.ts';

test('Formatters: elapsed time formatting', () => {
  assert.strictEqual(elapsed(0), 'ahora');
  assert.strictEqual(elapsed(45 * 1000), 'ahora');
  assert.strictEqual(elapsed(90 * 1000), '1 min');
  assert.strictEqual(elapsed(15 * 60 * 1000), '15 min');
  assert.strictEqual(elapsed(3 * 3600 * 1000 + 4 * 60 * 1000), '3h 04');
  assert.strictEqual(elapsed(2 * 24 * 3600 * 1000 + 5 * 3600 * 1000), '2d 05h');
});

test('Formatters: countdown formatting', () => {
  assert.strictEqual(countdown(45 * 1000), '1m');
  assert.strictEqual(countdown(15 * 60 * 1000), '15m');
  assert.strictEqual(countdown(2 * 3600 * 1000 + 10 * 60 * 1000), '2h 10m');
});

test('Formatters: shortId generation', () => {
  assert.strictEqual(shortId('a1b2c3d4-1111-2222-3333-444455556666'), 'A1B2C3');
  assert.strictEqual(shortId('abc-def-ghi'), 'ABCDEF');
});

test('Formatters: tokens formatting', () => {
  assert.strictEqual(tokens(450), '450');
  assert.strictEqual(tokens(2500), '3k');
  assert.strictEqual(tokens(1350000), '1.4M');
  assert.strictEqual(tokens(2900000000), '2.90B');
});

test('Formatters: money formatting', () => {
  assert.strictEqual(money(0.45), '$0.45');
  assert.strictEqual(money(12.5), '$12.50');
  assert.strictEqual(money(125.75), '$126');
});

test('Formatters: percent formatting', () => {
  assert.strictEqual(percent(0.42), '42%');
  assert.strictEqual(percent(0.88), '88%');
});
