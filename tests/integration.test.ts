import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createRoomServer } from '../server/app.js';
import { addAnnotation, annotations, editAnnotation, listAnnotations, removeAnnotation, tombstones, MAX_BODY, MAX_NOTES, DOCUMENT, newAnnotationId } from '../shared/document.js';

type Message = { type: string; code?: string; update?: string; requestId?: number; role?: string };
type Room = { room: string; ownerToken: string; readToken: string; writeToken: string };
class Peer {
  readonly doc = new Y.Doc(); socket?: WebSocket; private messages: Message[] = []; private waiters = new Set<() => void>(); private id = 0;
  async connect(url: string, room: string, token: string) {
    this.messages = [];
    const socket = new WebSocket(url.replace('http', 'ws') + '/ws'); this.socket = socket;
    socket.on('error', () => {});
    socket.on('message', raw => {
      const msg = JSON.parse(raw.toString()) as Message;
      if ((msg.type === 'sync' || msg.type === 'update') && msg.update) Y.applyUpdate(this.doc, Buffer.from(msg.update, 'base64'), 'remote');
      this.messages.push(msg); for (const notify of this.waiters) notify();
    });
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', room, token }));
    return this.next(['sync', 'error']);
  }
  next(types: string[]) {
    return new Promise<Message>((resolve, reject) => {
      const timeout = setTimeout(() => { this.waiters.delete(check); reject(new Error(`Timed out waiting for ${types}`)); }, 3000);
      const check = () => { const index = this.messages.findIndex(msg => types.includes(msg.type)); if (index >= 0) { clearTimeout(timeout); this.waiters.delete(check); resolve(this.messages.splice(index, 1)[0]); } };
      this.waiters.add(check); check();
    });
  }
  async push(update = Y.encodeStateAsUpdate(this.doc)) {
    this.socket!.send(JSON.stringify({ type: 'update', requestId: ++this.id, update: Buffer.from(update).toString('base64') }));
    return this.next(['ack', 'error']);
  }
  async until(predicate: () => boolean) {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { this.doc.off('update', changed); reject(new Error('Docs did not converge.')); }, 3000);
      const changed = () => { if (predicate()) { clearTimeout(timeout); this.doc.off('update', changed); resolve(); } };
      this.doc.on('update', changed); changed();
    });
  }
  async disconnect() { const socket = this.socket; this.socket = undefined; if (socket && socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, 'close'); socket.close(); await closed; } }
}
async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'margin-test-')), path = join(folder, 'state.sqlite');
  const app = createRoomServer({ database: path }), url = await app.listen();
  const create = async () => { const response = await fetch(url + '/api/rooms', { method: 'POST', body: '{}' }); assert.equal(response.status, 201); return response.json() as Promise<Room>; };
  return { app, url, folder, path, create };
}
async function cleanup(app: ReturnType<typeof createRoomServer>, folder: string, peers: Peer[]) { for (const peer of peers) { await peer.disconnect(); peer.doc.destroy(); } await app.close(); await rm(folder, { recursive: true, force: true }); }

test('independent offline edits converge; removal wins and acknowledged state survives SQLite reopen', async () => {
  const fixture = await setup(); let app = fixture.app; const a = new Peer(), b = new Peer(), c = new Peer();
  try {
    const room = await fixture.create();
    assert.equal((await a.connect(fixture.url, room.room, room.writeToken)).role, 'write');
    await b.connect(fixture.url, room.room, room.writeToken);
    const seed = listAnnotations(a.doc)[0].id;
    const shared = addAnnotation(a.doc, 65, 90, 'Shared thought.'); await a.push(); await b.until(() => annotations(b.doc).has(shared));
    await a.disconnect(); await b.disconnect();
    const aOnly = addAnnotation(a.doc, 100, 140, 'Written on the train.');
    const bOnly = addAnnotation(b.doc, 150, 170, 'Written without Wi-Fi.');
    (annotations(a.doc).get(shared)!.get('body') as Y.Text).insert(0, 'A: ');
    (annotations(b.doc).get(shared)!.get('body') as Y.Text).insert(0, 'B: ');
    removeAnnotation(a.doc, seed); editAnnotation(b.doc, seed, 'This offline edit must not resurrect the note.');
    await a.connect(fixture.url, room.room, room.writeToken); assert.equal((await a.push()).type, 'ack');
    await b.connect(fixture.url, room.room, room.writeToken); assert.equal((await b.push()).type, 'ack');
    await a.until(() => annotations(a.doc).has(bOnly));
    assert.deepEqual(listAnnotations(a.doc), listAnnotations(b.doc));
    assert.equal(tombstones(b.doc).get(seed), true); assert(annotations(b.doc).has(aOnly));
    const merged = listAnnotations(a.doc).find(note => note.id === shared)!.body;
    assert(merged.includes('A: ') && merged.includes('B: ') && merged.includes('Shared thought.'));
    const duplicate = Y.encodeStateAsUpdate(a.doc); const before = Buffer.from(app.store.snapshot(room.room)!);
    assert.equal((await a.push(duplicate)).type, 'ack'); assert.equal((await a.push(duplicate)).type, 'ack');
    assert.deepEqual(Buffer.from(app.store.snapshot(room.room)!), before);
    const expected = listAnnotations(a.doc);
    await a.disconnect(); await b.disconnect(); await app.close();
    app = createRoomServer({ database: fixture.path }); const restarted = await app.listen();
    await c.connect(restarted, room.room, room.readToken);
    assert.deepEqual(listAnnotations(c.doc), expected);
  } finally { await cleanup(app, fixture.folder, [a, b, c]); }
});

test('capabilities are room-bound; readers cannot write; rotation rejects old links and closes guests', async () => {
  const f = await setup(); const writer = new Peer(), reader = new Peer(), stranger = new Peer(), owner = new Peer();
  try {
    const room = await f.create(), other = await f.create();
    assert.equal((await stranger.connect(f.url, other.room, room.writeToken)).code, 'unauthorized');
    await reader.connect(f.url, room.room, room.readToken); const before = Buffer.from(f.app.store.snapshot(room.room)!);
    addAnnotation(reader.doc, 0, 20, 'A read link must not save this.');
    assert.equal((await reader.push()).code, 'read_only'); assert.deepEqual(Buffer.from(f.app.store.snapshot(room.room)!), before);
    await writer.connect(f.url, room.room, room.writeToken); await owner.connect(f.url, room.room, room.ownerToken);
    const denied = await fetch(`${f.url}/api/rooms/${room.room}/invites`, { method: 'POST', headers: { Authorization: `Bearer ${room.writeToken}` } }); assert.equal(denied.status, 403);
    const rotated = await fetch(`${f.url}/api/rooms/${room.room}/invites`, { method: 'POST', headers: { Authorization: `Bearer ${room.ownerToken}` } }); assert.equal(rotated.status, 200);
    assert.equal((await writer.next(['error'])).code, 'revoked'); assert.equal((await reader.next(['error'])).code, 'revoked');
    await writer.disconnect(); assert.equal((await writer.connect(f.url, room.room, room.writeToken)).code, 'unauthorized');
    addAnnotation(owner.doc, 20, 40, 'Creator remains authorized.'); assert.equal((await owner.push()).type, 'ack');
    const fresh = await rotated.json() as { readToken: string }; await reader.disconnect();
    const clean = new Peer(); try { assert.equal((await clean.connect(f.url, room.room, fresh.readToken)).role, 'read'); assert(listAnnotations(clean.doc).some(note => note.body === 'Creator remains authorized.')); } finally { await clean.disconnect(); clean.doc.destroy(); }
  } finally { await cleanup(f.app, f.folder, [writer, reader, stranger, owner]); }
});

test('malformed, excessive and invalid-schema updates leave the durable snapshot untouched', async () => {
  const f = await setup(); const peer = new Peer();
  try {
    const room = await f.create(); await peer.connect(f.url, room.room, room.writeToken); const before = Buffer.from(f.app.store.snapshot(room.room)!);
    for (const raw of ['{', 'null', JSON.stringify({ type: 'update', requestId: 1, update: 'not-base64' }), JSON.stringify({ type: 'update', requestId: 2, update: '/w==' }), JSON.stringify({ type: 'update', requestId: 3, update: 'A'.repeat(350_000) })]) {
      peer.socket!.send(raw); assert.equal((await peer.next(['error'])).code, 'invalid_update'); assert.deepEqual(Buffer.from(f.app.store.snapshot(room.room)!), before);
    }
    const invalid = new Y.Doc(); Y.applyUpdate(invalid, before);
    const id = listAnnotations(invalid)[0].id;
    annotations(invalid).get(id)!.set('start', DOCUMENT.length + 1);
    assert.equal((await peer.push(Y.encodeStateAsUpdate(invalid))).code, 'invalid_update'); invalid.destroy();
    const huge = new Y.Doc(); Y.applyUpdate(huge, before); (annotations(huge).get(id)!.get('body') as Y.Text).insert(0, 'x'.repeat(MAX_BODY + 1));
    assert.equal((await peer.push(Y.encodeStateAsUpdate(huge))).code, 'invalid_update'); huge.destroy();
    const root = new Y.Doc(); root.getMap('unauthorized-root').set('x', true);
    assert.equal((await peer.push(Y.encodeStateAsUpdate(root))).code, 'invalid_update'); root.destroy();
    assert.deepEqual(Buffer.from(f.app.store.snapshot(room.room)!), before);
    const close = once(peer.socket!, 'close'); peer.socket!.send('x'.repeat(400_000));
    const [code] = await close; assert.equal(code, 1009); assert.deepEqual(Buffer.from(f.app.store.snapshot(room.room)!), before);
  } finally { await cleanup(f.app, f.folder, [peer]); }
});

test('permanent removal markers, immutable anchors, and text-only bodies are enforced', async () => {
  const f = await setup(); const peer = new Peer();
  try {
    const room = await f.create(); await peer.connect(f.url, room.room, room.writeToken);
    const id = listAnnotations(peer.doc)[0].id; removeAnnotation(peer.doc, id); assert.equal((await peer.push()).type, 'ack');
    const before = Buffer.from(f.app.store.snapshot(room.room)!);
    for (const mutate of [
      (d: Y.Doc) => tombstones(d).delete(id),
      (d: Y.Doc) => tombstones(d).set(id, false),
      (d: Y.Doc) => annotations(d).delete(id),
      (d: Y.Doc) => annotations(d).get(id)!.set('end', 20),
      (d: Y.Doc) => (annotations(d).get(id)!.get('body') as Y.Text).insertEmbed(0, { html: '<script>alert(1)</script>' }),
    ]) {
      const bad = new Y.Doc(); Y.applyUpdate(bad, before); mutate(bad);
      assert.equal((await peer.push(Y.encodeStateAsUpdate(bad))).code, 'invalid_update'); bad.destroy();
      assert.deepEqual(Buffer.from(f.app.store.snapshot(room.room)!), before);
    }
  } finally { await cleanup(f.app, f.folder, [peer]); }
});

test('HTTP input and browser origin checks reject unsupported requests', async () => {
  const f = await setup();
  try {
    assert.equal((await fetch(f.url + '/api/rooms', { method: 'POST', body: '{' })).status, 400);
    assert.equal((await fetch(f.url + '/api/rooms', { method: 'POST', body: JSON.stringify({ title: 'arbitrary document' }) })).status, 400);
    assert.equal((await fetch(f.url + '/api/rooms', { method: 'POST', body: '{}', headers: { Origin: 'https://unrelated.example' } })).status, 403);
    const ws = new WebSocket(f.url.replace('http', 'ws') + '/ws', { origin: 'https://unrelated.example' });
    const failure = await new Promise<Error>(resolve => ws.on('error', resolve)); assert.match(failure.message, /403/);
  } finally { await cleanup(f.app, f.folder, []); }
});

test('large valid snapshots work up to the explicit note count, then the next identity is rejected', async () => {
  const f = await setup(); const peer = new Peer();
  try {
    const room = await f.create(); await peer.connect(f.url, room.room, room.writeToken);
    for (let index = 1; index < MAX_NOTES; index++) addAnnotation(peer.doc, 0, 10, 'x'.repeat(1000));
    assert(Y.encodeStateAsUpdate(peer.doc).byteLength > 128_000);
    assert.equal((await peer.push()).type, 'ack');
    const before = Buffer.from(f.app.store.snapshot(room.room)!);
    const item = new Y.Map<unknown>(); item.set('start', 0); item.set('end', 1); item.set('body', new Y.Text('Overflow'));
    annotations(peer.doc).set(newAnnotationId(), item);
    assert.equal((await peer.push()).code, 'invalid_update'); assert.deepEqual(Buffer.from(f.app.store.snapshot(room.room)!), before);
  } finally { await cleanup(f.app, f.folder, [peer]); }
});
