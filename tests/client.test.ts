import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { IDBFactory } from 'fake-indexeddb';
import * as Y from 'yjs';
import { createRoomServer } from '../server/app.js';
import { RoomClient, canEdit } from '../src/client.js';
import { SnapshotStore } from '../src/persistence.js';
import { addAnnotation, editAnnotation, listAnnotations, removeAnnotation } from '../shared/document.js';

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'margin-client-'));
  const app = createRoomServer({ database: join(folder, 'state.sqlite') });
  const url = new URL(await app.listen());
  const prior = { WebSocket: globalThis.WebSocket, location: globalThis.location, localStorage: globalThis.localStorage };
  const roles = new Map<string, string>();
  Object.assign(globalThis, { WebSocket, location: url, localStorage: { getItem: (key: string) => roles.get(key) ?? null, setItem: (key: string, value: string) => roles.set(key, value), removeItem: (key: string) => roles.delete(key) } });
  const room = await (await fetch(url + 'api/rooms', { method: 'POST', body: '{}' })).json() as { room: string; writeToken: string; readToken: string; ownerToken: string };
  const clients: RoomClient[] = [];
  return {
    app, url, room,
    client(token: string, store: SnapshotStore) { const client = new RoomClient(room.room, token, store); clients.push(client); return client; },
    durable() { const doc = new Y.Doc(); Y.applyUpdate(doc, app.store.snapshot(room.room)!); const notes = listAnnotations(doc); doc.destroy(); return notes; },
    async close() { await Promise.all(clients.map(client => client.destroy())); await app.close(); await rm(folder, { recursive: true, force: true }); Object.assign(globalThis, prior); },
  };
}

test('actual RoomClient reconnect uploads another closed offline tab’s durable edits without notifications', async () => {
  const f = await fixture(), factory = new IDBFactory();
  const a = f.client(f.room.writeToken, new SnapshotStore(factory, 'closed-tab', false));
  const b = f.client(f.room.writeToken, new SnapshotStore(factory, 'closed-tab', false));
  try {
    await Promise.all([a.start(), b.start()]);
    await waitFor(() => a.state.connection === 'synced' && b.state.connection === 'synced', 'initial sync');
    a.setOnline(false); b.setOnline(false);
    addAnnotation(b.doc, 13, 25, 'Active tab note.');
    await waitFor(() => b.state.local === 'saved', 'B local save');
    addAnnotation(a.doc, 0, 12, 'Closed tab note.');
    await waitFor(() => a.state.local === 'saved', 'A local save');
    assert(!listAnnotations(b.doc).some(note => note.body === 'Closed tab note.'), 'notification-free tab has not seen the new durable note yet');
    await a.destroy(); b.setOnline(true);
    await waitFor(() => b.state.connection === 'synced' && b.state.local === 'saved', 'B reconnect completion');
    assert(listAnnotations(b.doc).some(note => note.body === 'Closed tab note.'), 'live B must include saved closed-tab edits before reporting synced');
    assert.deepEqual(f.durable(), listAnnotations(b.doc), 'acknowledged live state must match server');
    assert(f.durable().some(note => note.body === 'Active tab note.'));
  } finally { await f.close(); }
});

test('cache notifications converge live offline clients, isolate capabilities, and do not loop saves', async () => {
  class CountingStore extends SnapshotStore {
    writes = 0;
    override save(key: string, state: Uint8Array) { this.writes++; return super.save(key, state); }
  }
  const f = await fixture(), factory = new IDBFactory();
  const stores = Array.from({ length: 3 }, () => new CountingStore(factory, 'tab-notifications'));
  const a = f.client(f.room.writeToken, stores[0]), b = f.client(f.room.writeToken, stores[1]), reader = f.client(f.room.readToken, stores[2]);
  try {
    await Promise.all([a.start(), b.start(), reader.start()]);
    await waitFor(() => [a, b, reader].every(c => c.state.connection === 'synced' && c.state.local === 'saved'), 'initial sync');
    a.setOnline(false); b.setOnline(false); reader.setOnline(false);
    const id = addAnnotation(a.doc, 0, 12, 'A locally propagated note.');
    await waitFor(() => a.state.local === 'saved' && listAnnotations(b.doc).some(note => note.id === id), 'committed cache reaches live B');
    assert.equal(listAnnotations(reader.doc).length, 1, 'a different invite does not receive this cache');
    editAnnotation(b.doc, id, 'Edited from the other offline tab.');
    await waitFor(() => listAnnotations(a.doc).find(note => note.id === id)?.body === 'Edited from the other offline tab.' && b.state.local === 'saved', 'text edit reaches live A');
    removeAnnotation(a.doc, id);
    await waitFor(() => listAnnotations(b.doc).find(note => note.id === id)?.deleted === true && a.state.local === 'saved', 'tombstone reaches live B');
    const writes = stores.map(store => store.writes);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(stores.map(store => store.writes), writes, 'cache-origin merges must not cause save/notification loops');
    assert.equal(listAnnotations(reader.doc).length, 1);
    await a.destroy(); b.setOnline(true);
    await waitFor(() => b.state.connection === 'synced', 'remaining client relays cached edits');
    assert.deepEqual(f.durable(), listAnnotations(b.doc));
    assert.equal(f.durable().find(note => note.id === id)?.deleted, true);
  } finally { await f.close(); }
});

test('an online RoomClient forwards committed edits from an offline tab and waits for server acknowledgement', async () => {
  const f = await fixture(), factory = new IDBFactory();
  const a = f.client(f.room.writeToken, new SnapshotStore(factory, 'online-relay'));
  const b = f.client(f.room.writeToken, new SnapshotStore(factory, 'online-relay'));
  try {
    await Promise.all([a.start(), b.start()]);
    await waitFor(() => a.state.connection === 'synced' && b.state.connection === 'synced', 'initial sync');
    a.setOnline(false);
    let sawSyncing = false;
    const stop = b.subscribe(() => { if (listAnnotations(b.doc).some(note => note.body === 'Saved by a disconnected tab.') && b.state.connection === 'syncing') sawSyncing = true; });
    addAnnotation(a.doc, 0, 12, 'Saved by a disconnected tab.');
    await waitFor(() => b.state.connection === 'synced' && listAnnotations(b.doc).some(note => note.body === 'Saved by a disconnected tab.'), 'online tab includes offline save');
    stop(); assert(sawSyncing);
    assert.deepEqual(f.durable(), listAnnotations(b.doc), 'synced status follows a durable server acknowledgement');
  } finally { await f.close(); }
});

test('rejected aggregate text remains editable locally and a shortened repair syncs; revoked invites stay locked', async () => {
  const f = await fixture(), factory = new IDBFactory();
  const a = f.client(f.room.writeToken, new SnapshotStore(factory, 'aggregate'));
  const b = f.client(f.room.ownerToken, new SnapshotStore(factory, 'aggregate'));
  try {
    await Promise.all([a.start(), b.start()]);
    await waitFor(() => a.state.connection === 'synced' && b.state.connection === 'synced', 'initial sync');
    const id = listAnnotations(a.doc)[0].id;
    a.setOnline(false); b.setOnline(false);
    editAnnotation(a.doc, id, 'A'.repeat(1500)); editAnnotation(b.doc, id, 'B'.repeat(1500));
    await waitFor(() => a.state.local === 'saved' && b.state.local === 'saved', 'offline text saves');
    a.setOnline(true); await waitFor(() => a.state.connection === 'synced', 'A accepted');
    b.setOnline(true); await waitFor(() => b.state.connection === 'error' && b.state.local === 'saved', 'B aggregate rejected');
    assert.equal(listAnnotations(b.doc)[0].body.length, 3000);
    assert.equal(f.durable()[0].body.length, 1500, 'rejection must leave server state untouched');
    assert.equal(b.state.online, false); assert.equal(b.state.recoverable, true); assert.equal(canEdit(b.state), true);
    const retained = listAnnotations(b.doc)[0].body;
    editAnnotation(b.doc, id, retained.slice(0, 2500));
    assert.throws(() => editAnnotation(b.doc, id, retained.slice(0, 2501)), /Shorten/);
    editAnnotation(b.doc, id, retained.slice(0, 1900));
    assert.equal(b.state.connection, 'error', 'editing a rejected local copy must never imply it synced');
    b.setOnline(true); await waitFor(() => b.state.connection === 'synced' && b.state.local === 'saved', 'repaired text accepted');
    assert.deepEqual(f.durable(), listAnnotations(b.doc)); assert.equal(f.durable()[0].body.length, 1900);
    const rotated = await fetch(`${f.url}api/rooms/${f.room.room}/invites`, { method: 'POST', headers: { Authorization: `Bearer ${f.room.ownerToken}` } });
    assert.equal(rotated.status, 200);
    await waitFor(() => a.state.connection === 'error', 'guest revoked');
    assert.equal(a.state.recoverable, false); assert.equal(canEdit(a.state), false);
    a.setOnline(false); assert.equal(canEdit(a.state), false, 'offline toggle cannot revive an observed revoked role');
    a.setOnline(true); await waitFor(() => a.state.connection === 'error', 'revoked reconnect denied');
    assert.equal(canEdit(a.state), false);
  } finally { await f.close(); }
});
