import { test } from 'node:test';
import assert from 'node:assert';
import { claims, pruneZombies, order, assignWeights, plan } from './select.ts';
import type { SessionRecord } from './types.ts';
import { DEFAULT_CONFIG } from './config.ts';

const t0 = Date.now();

const mockRecord = (id: string, state: SessionRecord['state'], sinceOffset: number, updatedOffset = sinceOffset): SessionRecord => ({
  session_id: id,
  provider: 'claude',
  state,
  detail: 'test tool',
  project: 'test-project',
  since: t0 - sinceOffset,
  updated: t0 - updatedOffset,
  event: 'Notification',
});

test('Selection: claims detection', () => {
  assert.strictEqual(claims(mockRecord('1', 'permiso', 0)), true);
  assert.strictEqual(claims(mockRecord('2', 'espera', 0)), true);
  assert.strictEqual(claims(mockRecord('3', 'listo', 0)), true);
  assert.strictEqual(claims(mockRecord('4', 'activa', 0)), false);
  assert.strictEqual(claims(mockRecord('5', 'inactiva', 0)), false);
});

test('Selection: pruneZombies drops idle active sessions', () => {
  const records = [
    mockRecord('active-fresh', 'activa', 5000),
    mockRecord('active-stale', 'activa', 60000, 45000), // last updated 45s ago
    mockRecord('permiso-stale', 'permiso', 60000, 45000), // permiso never pruned
  ];
  
  const pruned = pruneZombies(records, t0, 30000); // 30s threshold
  assert.strictEqual(pruned.length, 2);
  assert.strictEqual(pruned.some(r => r.session_id === 'active-stale'), false);
  assert.strictEqual(pruned.some(r => r.session_id === 'active-fresh'), true);
  assert.strictEqual(pruned.some(r => r.session_id === 'permiso-stale'), true);
});

test('Selection: ordering sessions by priority and time waiting', () => {
  const r1 = mockRecord('r1', 'espera', 10000); // waits 10s
  const r2 = mockRecord('r2', 'permiso', 5000);  // higher state priority
  const r3 = mockRecord('r3', 'espera', 20000); // same priority, waits longer (20s)
  const r4 = mockRecord('r4', 'activa', 1000);   // inactive state
  
  const ordered = order([r1, r2, r3, r4]);
  
  assert.strictEqual(ordered[0]?.session_id, 'r2'); // permiso (permiso > espera)
  assert.strictEqual(ordered[1]?.session_id, 'r3'); // espera waiting 20s (older first)
  assert.strictEqual(ordered[2]?.session_id, 'r1'); // espera waiting 10s
  assert.strictEqual(ordered[3]?.session_id, 'r4'); // activa (non-claiming)
});

test('Selection: assignWeights assigns solid to at most one claiming tile', () => {
  const records = [
    mockRecord('1', 'permiso', 5000),
    mockRecord('2', 'espera', 5000),
    mockRecord('3', 'activa', 5000),
  ];
  
  const tiles = assignWeights(records);
  
  assert.strictEqual(tiles[0]?.weight, 'solido');  // First claiming gets solid
  assert.strictEqual(tiles[1]?.weight, 'marcada'); // Second claiming gets marked
  assert.strictEqual(tiles[2]?.weight, 'quieta');  // Non-claiming gets quieta
});

test('Selection: layout planning fits tiles or collapses to overflow', () => {
  const records = [
    mockRecord('1', 'permiso', 1000),
    mockRecord('2', 'espera', 1000),
    mockRecord('3', 'listo', 1000),
    mockRecord('4', 'activa', 1000),
    mockRecord('5', 'inactiva', 1000),
  ];
  
  // Available width is large, everything fits
  const pLarge = plan(records, 1920, DEFAULT_CONFIG);
  assert.strictEqual(pLarge.tiles.length, 5);
  assert.strictEqual(pLarge.overflow.length, 0);
  assert.strictEqual(pLarge.summaryWidth, 0);
  
  // Available width is tight, some move to overflow and summary columns is added
  const pTight = plan(records, 800, DEFAULT_CONFIG);
  assert.strictEqual(pTight.tiles.length < 5, true);
  assert.strictEqual(pTight.overflow.length > 0, true);
  assert.strictEqual(pTight.summaryWidth > 0, true);
});
