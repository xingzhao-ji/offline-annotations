import * as Y from 'yjs';
import { SnapshotStore } from './persistence.js';

export type Role = 'read' | 'write' | 'owner' | 'unknown';
export type ClientState = {
  connection: 'connecting' | 'offline' | 'syncing' | 'synced' | 'error';
  local: 'loading' | 'saving' | 'saved' | 'error';
  role: Role; error: string; loaded: boolean; online: boolean; recoverable: boolean;
};
export function canEdit(state: ClientState) {
  return state.loaded && (state.connection !== 'error' || state.recoverable) && (state.role === 'write' || state.role === 'owner');
}
function encode(bytes: Uint8Array) { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function decode(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }

export class RoomClient {
  readonly doc = new Y.Doc();
  state: ClientState = { connection: 'connecting', local: 'loading', role: 'unknown', error: '', loaded: false, online: true, recoverable: false };
  private listeners = new Set<() => void>();
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private flush?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private terminal = false;
  private authenticated = false;
  private connecting?: object;
  private sending = false;
  private cacheReads = 0;
  private request = 0;
  private revision = 0;
  private acknowledged = -1;
  private pending = new Map<number, number>();
  private saving = Promise.resolve();
  private version = 0;
  private unsubscribeCache?: () => void;
  private closing?: Promise<void>;
  private get key() { return `${this.room}:${this.token}`; }
  constructor(readonly room: string, readonly token: string, private persistence = new SnapshotStore()) {
    // A cached role only enables offline UI; the server reauthorizes every update.
    try { const role = localStorage.getItem(`margin-role:${room}:${token}`); if (role === 'read' || role === 'write' || role === 'owner') this.state.role = role; } catch { /* Storage can be disabled. */ }
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private update(patch: Partial<ClientState>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); } }
  async start() {
    try {
      await this.persistence.open();
      if (this.disposed) { this.persistence.close(); return; }
      this.unsubscribeCache = this.persistence.subscribe(this.key, () => { void this.reconcileCache(); });
      const snapshot = await this.persistence.load(this.key);
      if (this.disposed) return;
      if (snapshot) Y.applyUpdate(this.doc, snapshot, 'load');
      this.update({ local: snapshot ? 'saved' : 'loading' });
    } catch { this.update({ local: 'error', error: 'Local storage is unavailable. Keep this tab open to preserve unsynced work.' }); }
    if (this.disposed) return;
    this.doc.on('update', this.onUpdate);
    this.update({ loaded: true });
    this.save();
    void this.connect();
  }
  private onUpdate = (_update: Uint8Array, origin: unknown) => {
    // Cache updates already committed. Writing them again creates notification
    // loops, and can falsely turn a durable imported note into a pending save.
    if (origin !== 'cache') this.save();
    if (origin !== 'remote') { this.revision++; this.scheduleSend(); }
    this.update({});
  };
  private save() {
    const snapshot = Y.encodeStateAsUpdate(this.doc), version = ++this.version;
    this.update({ local: 'saving' });
    this.saving = this.saving.catch(() => {}).then(() => this.persistence.save(this.key, snapshot)).then(merged => {
      if (this.disposed) return;
      Y.applyUpdate(this.doc, merged, 'cache');
      if (version === this.version) this.update({ local: 'saved' });
    }).catch(() => { this.update({ local: 'error', error: 'Your browser could not save this notebook. Keep the tab open and reconnect.' }); });
  }
  private async reconcileCache() {
    if (this.disposed) return;
    this.cacheReads++;
    if (this.authenticated && this.state.online && !this.terminal) this.update({ connection: 'syncing' });
    try {
      await this.saving;
      if (this.disposed) return;
      const snapshot = await this.persistence.load(this.key);
      if (snapshot && !this.disposed) Y.applyUpdate(this.doc, snapshot, 'cache');
    } catch { this.update({ local: 'error', error: 'Your browser could not read saved notes. Keep this tab open to preserve unsynced work.' }); }
    finally { this.cacheReads--; this.maybeSynced(); }
  }
  setOnline(online: boolean) {
    this.update({ online }); clearTimeout(this.retry); clearTimeout(this.flush); this.flush = undefined;
    this.connecting = undefined;
    if (!online) {
      this.authenticated = false; this.socket?.close(); this.socket = undefined; this.pending.clear();
      this.update({ connection: 'offline' });
    } else { this.terminal = false; void this.connect(); }
  }
  private async connect() {
    if (this.disposed || !this.state.online || this.terminal || this.connecting || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    const attempt = {}; this.connecting = attempt;
    this.update({ connection: 'connecting', error: this.state.local === 'error' ? this.state.error : '' });
    // BroadcastChannel is an optimization, not a durability dependency. A tab
    // may have closed, suspended, or saved while notifications were unavailable.
    await this.reconcileCache();
    if (this.disposed || !this.state.online || this.terminal || this.connecting !== attempt) return;
    this.connecting = undefined;
    this.authenticated = false; this.acknowledged = -1; this.pending.clear();
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.socket = ws;
    ws.onopen = () => { if (this.socket === ws) ws.send(JSON.stringify({ type: 'hello', room: this.room, token: this.token })); };
    ws.onmessage = event => {
      if (this.socket !== ws || this.disposed) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sync') {
          Y.applyUpdate(this.doc, decode(msg.update), 'remote');
          this.authenticated = true;
          this.update({ role: msg.role, connection: 'syncing', recoverable: false });
          try { localStorage.setItem(`margin-role:${this.room}:${this.token}`, msg.role); } catch { /* UI role caching is optional. */ }
          this.save();
          if (msg.role !== 'read') void this.sendSnapshot();
          else this.maybeSynced();
        } else if (msg.type === 'update') { Y.applyUpdate(this.doc, decode(msg.update), 'remote'); }
        else if (msg.type === 'ack') {
          const revision = this.pending.get(msg.requestId);
          if (revision !== undefined) this.acknowledged = Math.max(this.acknowledged, revision);
          this.pending.delete(msg.requestId); this.maybeSynced();
        } else if (msg.type === 'error') {
          this.terminal = true; this.authenticated = false;
          const recoverable = msg.code === 'invalid_update' && (this.state.role === 'write' || this.state.role === 'owner');
          if (msg.code === 'revoked' || msg.code === 'unauthorized' || msg.code === 'read_only') {
            this.update({ role: msg.code === 'read_only' ? 'read' : 'unknown' });
            try { localStorage.removeItem(`margin-role:${this.room}:${this.token}`); } catch { /* Best-effort cached role invalidation. */ }
          }
          this.update({ connection: 'error', error: recoverable ? `${msg.message} Your edits remain on this device. Shorten overlong notes and reconnect, or export a copy before starting a new room.` : msg.message, online: false, recoverable });
          ws.close();
        }
      } catch {
        this.terminal = true; this.authenticated = false;
        this.update({ connection: 'error', error: 'The sync response could not be read. Your local notes are retained.', online: false, recoverable: false });
        ws.close();
      }
    };
    ws.onclose = () => {
      if (this.socket !== ws || this.disposed) return;
      this.socket = undefined; this.authenticated = false; this.pending.clear();
      if (!this.terminal) { this.update({ connection: 'offline' }); if (this.state.online) this.retry = setTimeout(() => { void this.connect(); }, 2000); }
    };
    ws.onerror = () => {}; // close handles retry and state.
  }
  private scheduleSend() {
    if (!this.state.online || !this.authenticated || this.state.role === 'read' || this.terminal) return;
    this.update({ connection: 'syncing' }); clearTimeout(this.flush);
    this.flush = setTimeout(() => { this.flush = undefined; void this.sendSnapshot(); }, 120);
  }
  private maybeSynced() {
    if (!this.disposed && this.state.online && this.authenticated && !this.terminal && !this.cacheReads && !this.sending && !this.flush && !this.pending.size && (this.state.role === 'read' || this.acknowledged >= this.revision)) this.update({ connection: 'synced' });
  }
  private async sendSnapshot() {
    clearTimeout(this.flush); this.flush = undefined;
    if (this.sending || !this.authenticated || this.socket?.readyState !== WebSocket.OPEN || this.state.role === 'read' || this.terminal) return;
    const ws = this.socket; this.sending = true;
    this.update({ connection: 'syncing' });
    try {
      await this.reconcileCache();
      if (this.disposed || this.socket !== ws || !this.state.online || !this.authenticated || this.terminal) return;
      // Cache reconciliation can schedule a redundant debounce. This snapshot
      // includes that revision; only a later change needs another request.
      clearTimeout(this.flush); this.flush = undefined;
      const requestId = ++this.request; this.pending.set(requestId, this.revision);
      ws.send(JSON.stringify({ type: 'update', requestId, update: encode(Y.encodeStateAsUpdate(this.doc)) }));
    } finally {
      this.sending = false;
      // A reconnect may authenticate while an older connection's cache read ends.
      if (this.socket !== ws && this.authenticated) this.scheduleSend();
      this.maybeSynced();
    }
  }
  destroy(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true; clearTimeout(this.retry); clearTimeout(this.flush);
    this.connecting = undefined; this.unsubscribeCache?.(); this.socket?.close(); this.doc.off('update', this.onUpdate);
    this.closing = this.saving.finally(() => { this.persistence.close(); this.doc.destroy(); });
    return this.closing;
  }
}
