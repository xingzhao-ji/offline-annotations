import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newAnnotationId, UUID } from '../shared/document.js';

test('note IDs work when randomUUID is absent on an HTTP LAN origin', () => {
  let usedRandomValues = false;
  const id = newAnnotationId({ getRandomValues: bytes => { usedRandomValues = true; bytes.fill(255); return bytes; } });
  assert(usedRandomValues); assert(UUID.test(id)); assert.equal(id, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});
test('missing secure randomness gives an actionable error, never an insecure fallback', () => {
  assert.throws(() => newAnnotationId({}), /current browser using HTTPS or localhost/);
});
