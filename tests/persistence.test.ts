import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import * as Y from 'yjs';
import { SnapshotStore } from '../src/persistence.js';
import { addAnnotation, editAnnotation, listAnnotations } from '../shared/document.js';

test('IndexedDB adapter commits snapshots and loads them into a fresh Y.Doc after reopen', async () => {
  const factory = new IDBFactory(), first = new SnapshotStore(factory, 'test-store'); await first.open();
  const original = new Y.Doc(), id = addAnnotation(original, 0, 20, 'A note saved offline.');
  await first.save('room-a', Y.encodeStateAsUpdate(original)); first.close();
  const reopened = new SnapshotStore(factory, 'test-store'); await reopened.open();
  const restored = new Y.Doc(); Y.applyUpdate(restored, (await reopened.load('room-a'))!);
  assert.deepEqual(listAnnotations(restored), listAnnotations(original)); assert.equal(await reopened.load('room-b'), undefined);
  editAnnotation(restored, id, 'Edited after reopening.'); await reopened.save('room-a', Y.encodeStateAsUpdate(restored));
  const final = new Y.Doc(); Y.applyUpdate(final, (await reopened.load('room-a'))!); assert.equal(listAnnotations(final)[0].body, 'Edited after reopening.');
  reopened.close(); original.destroy(); restored.destroy(); final.destroy();
});

test('local saves reject when their database connection is closed', async () => {
  const store = new SnapshotStore(new IDBFactory(), 'closed-store'); await store.open(); store.close();
  await assert.rejects(store.save('room', new Uint8Array([0, 0])));
});

test('two offline tabs serialize and merge writes instead of losing a divergent snapshot', async () => {
  const factory = new IDBFactory(), leftStore = new SnapshotStore(factory, 'two-tabs'), rightStore = new SnapshotStore(factory, 'two-tabs');
  await leftStore.open(); await rightStore.open();
  const left = new Y.Doc(), right = new Y.Doc();
  addAnnotation(left, 0, 15, 'Left tab offline.'); addAnnotation(right, 20, 40, 'Right tab offline.');
  await Promise.all([leftStore.save('shared-invite', Y.encodeStateAsUpdate(left)), rightStore.save('shared-invite', Y.encodeStateAsUpdate(right))]);
  const restored = new Y.Doc(); Y.applyUpdate(restored, (await leftStore.load('shared-invite'))!);
  assert.deepEqual(listAnnotations(restored).map(note => note.body), ['Left tab offline.', 'Right tab offline.']);
  assert.equal(await leftStore.load('different-invite'), undefined);
  leftStore.close(); rightStore.close(); left.destroy(); right.destroy(); restored.destroy();
});
