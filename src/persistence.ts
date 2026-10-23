import * as Y from 'yjs';

/** 'Saved' means the read/merge/write transaction committed, including other tabs' work. */
export class SnapshotStore {
  private database?: IDBDatabase;
  private channel?: BroadcastChannel;
  private listeners = new Map<string, Set<() => void>>();
  constructor(private factory: IDBFactory = indexedDB, private name = 'margin-notebooks-v1', private broadcast = true) {}
  async open() {
    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('documents'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onblocked = () => reject(new Error('Local storage is blocked by another tab.'));
    });
    this.database.onversionchange = () => this.database?.close();
    if (this.broadcast && typeof BroadcastChannel !== 'undefined') {
      try { this.channel = new BroadcastChannel(`margin-cache:${this.name}`); } catch { return; } // Reconnect still reconciles if channels are blocked.
      this.channel.onmessage = event => {
        // Invalidation only: never trust state supplied by a channel sender. The
        // exact room/capability cache key also keeps guest caches separate.
        if (typeof event.data !== 'string') return;
        for (const listener of this.listeners.get(event.data) ?? []) listener();
      };
    }
  }
  subscribe(key: string, listener: () => void) {
    let listeners = this.listeners.get(key);
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  async load(key: string): Promise<Uint8Array | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.database!.transaction('documents', 'readonly');
      const request = tx.objectStore('documents').get(key);
      request.onsuccess = () => resolve(request.result ? new Uint8Array(request.result) : undefined);
      request.onerror = () => reject(request.error);
    });
  }
  async save(key: string, snapshot: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const tx = this.database!.transaction('documents', 'readwrite');
      const records = tx.objectStore('documents');
      let committed: Uint8Array;
      // Serialize divergent tab writes, then give the merged state back to the
      // live client. Merging on disk alone is insufficient for reconnect.
      const current = records.get(key);
      current.onsuccess = () => {
        const merged = new Y.Doc();
        try {
          if (current.result) Y.applyUpdate(merged, new Uint8Array(current.result));
          Y.applyUpdate(merged, snapshot);
          committed = Y.encodeStateAsUpdate(merged);
          records.put(committed, key);
        } catch { tx.abort(); } finally { merged.destroy(); }
      };
      tx.oncomplete = () => { this.channel?.postMessage(key); resolve(committed); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Local save was interrupted.'));
    });
  }
  close() { this.channel?.close(); this.channel = undefined; this.listeners.clear(); this.database?.close(); }
}
