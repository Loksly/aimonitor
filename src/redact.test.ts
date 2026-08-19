import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './redact.ts';

test('Hook: el secreto desaparece, no basta con que salga la etiqueta', () => {
  // La comprobación es que **el secreto ya no está**. Mirar sólo si aparece
  // «<oculto>» deja pasar el caso en que se tapa la palabra de al lado: así se
  // ocultaba «Bearer» dejando el token entero a la vista, con el test en verde.
  const casos: [string, string][] = [
    [
      'curl https://calendar.google.com/calendar/ical/x%40gmail.com/private-5c5ef16e0539aeed2b150db640e04380/basic.ics',
      '5c5ef16e0539aeed2b150db640e04380',
    ],
    ['curl -H "Authorization: Bearer abc123def456ghi789"', 'abc123def456ghi789'],
    ['curl -H "Authorization: abc123def456ghi789"', 'abc123def456ghi789'],
    ['curl --header "X-Auth: Bearer abc123def456ghi789"', 'abc123def456ghi789'],
    ['export API_KEY=sk-abcdefghijklmnopqrstuvwx', 'sk-abcdefghijklmnopqrstuvwx'],
    ['psql https://usuario:contrasena@db.example.com/x', 'contrasena'],
    ['git push https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/x', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
    ['aws --key AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['TOKEN=ghs_muylargoysecretoaqui1234 npm publish', 'ghs_muylargoysecretoaqui1234'],
  ];
  for (const [entrada, secreto] of casos) {
    const salida = redact(entrada);
    assert.ok(!salida.includes(secreto), `el secreto sobrevivió: ${salida}`);
    assert.ok(salida.includes('<oculto>'), `no marcó el tapado: ${salida}`);
  }
});

test('Hook: no tapa de más — el panel tiene que seguir siendo legible', () => {
  // Tapar de más convierte los mensajes en ruido y quita al panel su sentido.
  for (const limpio of [
    'Edit src/render.ts',
    'Bash: npm run build && systemctl --user restart aimonitor.service',
    'Read /datos/claude-screen/src/private-notes.md',
    'Grep "registerFromPath" en src/',
  ]) {
    assert.equal(redact(limpio), limpio, `tapó algo que no debía: ${limpio}`);
  }
});

test('Hook: tapa antes de recortar, para que no se cuele medio secreto', async () => {
  const largo = `curl ${'x'.repeat(300)} private-5c5ef16e0539aeed2b150db640e04380`;
  assert.ok(!redact(largo).includes('5c5ef16e0539aeed2b150db640e04380'));
});
