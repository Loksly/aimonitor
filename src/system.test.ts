import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, vitalColor, tempColor, STATE_COLOR, PALETTE } from './config.ts';
import { readSystem, resetCpuSampling } from './system.ts';

test('vitalColor: en normalidad la columna está apagada', () => {
  // Ésta es la regla que sostiene la dirección de arte: quien reclama al
  // operador es una consola bloqueada, no una RAM al 70 %.
  const t = DEFAULT_CONFIG.system;
  assert.equal(vitalColor(0, t), PALETTE.INK_DIM);
  assert.equal(vitalColor(0.7, t), PALETTE.INK_DIM);
  assert.equal(vitalColor(0.84, t), PALETTE.INK_DIM);
});

test('vitalColor: sólo se enciende al cruzar los umbrales', () => {
  const t = DEFAULT_CONFIG.system;
  assert.equal(vitalColor(0.85, t), STATE_COLOR.espera);
  assert.equal(vitalColor(0.94, t), STATE_COLOR.espera);
  assert.equal(vitalColor(0.95, t), STATE_COLOR.permiso);
  assert.equal(vitalColor(1, t), STATE_COLOR.permiso);
});

test('vitalColor es más permisivo que el semáforo del consumo', () => {
  // Con los umbrales del carril (0,6/0,85) una RAM al 70 % saldría en ámbar y
  // la columna viviría encendida.
  const t = DEFAULT_CONFIG.system;
  assert.ok(t.warn > DEFAULT_CONFIG.thresholds.warn);
  assert.ok(t.alert > DEFAULT_CONFIG.thresholds.alert);
});

test('tempColor: umbrales en grados, no en razón', () => {
  const s = DEFAULT_CONFIG.system;
  assert.equal(tempColor(60, s), PALETTE.INK_DIM);
  assert.equal(tempColor(84, s), PALETTE.INK_DIM);
  assert.equal(tempColor(85, s), STATE_COLOR.espera);
  assert.equal(tempColor(96, s), STATE_COLOR.permiso);
});

test('readSystem: sin muestra previa no revienta y omite el uso por núcleo', () => {
  // Es el caso del primer frame del daemon y el de `--preview`: /proc/stat da
  // contadores acumulados, así que una sola lectura no permite calcular tasas.
  resetCpuSampling();
  const snap = readSystem(DEFAULT_CONFIG);
  assert.equal(snap.cores, undefined, 'no se inventan valores por núcleo');
  assert.ok(typeof snap.cpuUsage === 'number', 'se cae a una estimación por carga');
  assert.ok(snap.cpuUsage >= 0 && snap.cpuUsage <= 1);
});

test('readSystem: la segunda lectura ya da uso por núcleo', { skip: process.platform !== 'linux' }, () => {
  resetCpuSampling();
  readSystem(DEFAULT_CONFIG);
  const snap = readSystem(DEFAULT_CONFIG);
  assert.ok(snap.cores && snap.cores.length > 0, 'hay delta, hay núcleos');
  for (const c of snap.cores!) assert.ok(c >= 0 && c <= 1, `uso acotado a 0..1, era ${c}`);
});

test('readSystem: un diskPath inexistente no tumba el render', () => {
  const cfg = { ...DEFAULT_CONFIG, system: { ...DEFAULT_CONFIG.system, diskPath: '/no/existe/jamas' } };
  const snap = readSystem(cfg);
  assert.equal(snap.disk, undefined);
  assert.ok(snap.mem, 'el resto de vitales siguen leyéndose');
});
