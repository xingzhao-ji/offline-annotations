import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRoomServer } from '../build/server/app.js';

const folder = await mkdtemp(join(tmpdir(), 'margin-smoke-'));
const app = createRoomServer({ database: join(folder, 'smoke.sqlite'), staticDir: resolve('dist') });
try {
  const url = await app.listen();
  const health = await fetch(url + '/api/health'); assert.equal(health.status, 200);
  const response = await fetch(url); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await response.text(); assert.match(html, /Margin/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"<>]+)"/g)].map(match => match[1]); assert(assets.length >= 2);
  for (const asset of assets) assert.equal((await fetch(url + asset)).status, 200);
  assert.equal((await fetch(url + '/sw.js')).status, 200);
  assert.equal((await fetch(url + '/%2e%2e/package.json')).status, 404);
  const created = await fetch(url + '/api/rooms', { method: 'POST', body: '{}' }); assert.equal(created.status, 201); const data = await created.json(); assert.equal(data.ownerToken.length, 43);
  console.log('Built HTTP smoke passed: health, HTML, bundled assets, service worker, traversal rejection, and room creation.');
} finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
