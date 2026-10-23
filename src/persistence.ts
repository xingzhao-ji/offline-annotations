import * as Y from 'yjs';

/** Small snapshot adapter: 'saved' is reported only after an IDB transaction commits. */
export class SnapshotStore {
  private database?: IDBDatabase;
  constructor(private factory: IDBFactory = indexedDB, private name = 'margin-notebooks-v1') {}
  async open() {
    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('documents'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onblocked = () => reject(new Error('Local storage is blocked by another tab.'));
    });
    this.database.onversionchange = () => this.database?.close();
  }
  async load(room: string): Promise<Uint8Array | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.database!.transaction('documents', 'readonly');
      const request = tx.objectStore('documents').get(room);
      request.onsuccess = () => resolve(request.result ? new Uint8Array(request.result) : undefined);
      request.onerror = () => reject(request.error);
    });
  }
  async save(room: string, snapshot: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.database!.transaction('documents', 'readwrite');
      const records = tx.objectStore('documents');
      // Read/merge/write in one serialized transaction: two offline tabs must not
      // overwrite one another's persisted snapshots with divergent local state.
      const current = records.get(room);
      current.onsuccess = () => {
        const merged = new Y.Doc();
        try {
          if (current.result) Y.applyUpdate(merged, new Uint8Array(current.result));
          Y.applyUpdate(merged, snapshot);
          records.put(Y.encodeStateAsUpdate(merged), room);
        } catch { tx.abort(); } finally { merged.destroy(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Local save was interrupted.'));
    });
  }
  close() { this.database?.close(); }
}
