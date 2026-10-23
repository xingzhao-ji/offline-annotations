import * as Y from 'yjs';
import { SnapshotStore } from './persistence.js';

export type Role = 'read' | 'write' | 'owner' | 'unknown';
export type ClientState = { connection: 'connecting' | 'offline' | 'syncing' | 'synced' | 'error'; local: 'loading' | 'saving' | 'saved' | 'error'; role: Role; error: string; loaded: boolean; online: boolean };
function encode(bytes: Uint8Array) { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function decode(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }

export class RoomClient {
  readonly doc = new Y.Doc();
  state: ClientState = { connection: 'connecting', local: 'loading', role: 'unknown', error: '', loaded: false, online: true };
  private listeners = new Set<() => void>();
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private flush?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private terminal = false;
  private request = 0;
  private pending = new Set<number>();
  private saving = Promise.resolve();
  private version = 0;
  constructor(readonly room: string, readonly token: string, private persistence = new SnapshotStore()) {
    // A cached role only enables offline UI; the server reauthorizes every update.
    try { const role = localStorage.getItem(`margin-role:${room}:${token}`); if (role === 'read' || role === 'write' || role === 'owner') this.state.role = role; } catch { /* Storage can be disabled. */ }
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private update(patch: Partial<ClientState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  async start() {
    try {
      await this.persistence.open();
      const snapshot = await this.persistence.load(`${this.room}:${this.token}`);
      if (this.disposed) return;
      if (snapshot) Y.applyUpdate(this.doc, snapshot, 'load');
      this.update({ local: snapshot ? 'saved' : 'loading' });
    } catch { this.update({ local: 'error', error: 'Local storage is unavailable. Keep this tab open to preserve unsynced work.' }); }
    if (this.disposed) return;
    this.doc.on('update', this.onUpdate);
    this.update({ loaded: true });
    this.save();
    this.connect();
  }
  private onUpdate = (_update: Uint8Array, origin: unknown) => {
    this.save();
    if (origin !== 'remote' && this.state.online && this.socket?.readyState === WebSocket.OPEN && this.state.role !== 'read') {
      this.update({ connection: 'syncing' });
      clearTimeout(this.flush);
      this.flush = setTimeout(() => this.sendSnapshot(), 120);
    } else this.update({});
  };
  private save() {
    const snapshot = Y.encodeStateAsUpdate(this.doc), version = ++this.version;
    this.update({ local: 'saving' });
    this.saving = this.saving.catch(() => {}).then(() => this.persistence.save(`${this.room}:${this.token}`, snapshot)).then(() => {
      if (version === this.version && !this.disposed) this.update({ local: 'saved' });
    }).catch(() => { if (!this.disposed) this.update({ local: 'error', error: 'Your browser could not save this notebook. Keep the tab open and reconnect.' }); });
  }
  setOnline(online: boolean) {
    this.update({ online }); clearTimeout(this.retry); clearTimeout(this.flush);
    if (!online) { this.socket?.close(); this.socket = undefined; this.pending.clear(); this.update({ connection: 'offline' }); }
    else { this.terminal = false; this.connect(); }
  }
  private connect() {
    if (this.disposed || !this.state.online || this.terminal || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.update({ connection: 'connecting', error: this.state.local === 'error' ? this.state.error : '' });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', room: this.room, token: this.token }));
    ws.onmessage = event => {
      if (this.socket !== ws || this.disposed) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sync') {
          Y.applyUpdate(this.doc, decode(msg.update), 'remote');
          this.update({ role: msg.role, connection: msg.role === 'read' ? 'synced' : 'syncing' });
          try { localStorage.setItem(`margin-role:${this.room}:${this.token}`, msg.role); } catch { /* UI role caching is optional. */ }
          this.save();
          if (msg.role !== 'read') this.sendSnapshot();
        } else if (msg.type === 'update') { Y.applyUpdate(this.doc, decode(msg.update), 'remote'); }
        else if (msg.type === 'ack') {
          this.pending.delete(msg.requestId);
          if (!this.pending.size && !this.flush) this.update({ connection: 'synced' });
        } else if (msg.type === 'error') {
          this.terminal = true;
          this.update({ connection: 'error', error: msg.message, online: false });
          ws.close();
        }
      } catch { this.terminal = true; this.update({ connection: 'error', error: 'The sync response could not be read. Your local notes are retained.' }); }
    };
    ws.onclose = () => {
      if (this.socket !== ws || this.disposed) return;
      this.socket = undefined; this.pending.clear();
      if (!this.terminal) { this.update({ connection: 'offline' }); if (this.state.online) this.retry = setTimeout(() => this.connect(), 2000); }
    };
    ws.onerror = () => {}; // close handles retry and state.
  }
  private sendSnapshot() {
    clearTimeout(this.flush); this.flush = undefined;
    if (this.socket?.readyState !== WebSocket.OPEN || this.state.role === 'read' || this.terminal) return;
    const requestId = ++this.request; this.pending.add(requestId);
    this.socket.send(JSON.stringify({ type: 'update', requestId, update: encode(Y.encodeStateAsUpdate(this.doc)) }));
    this.update({ connection: 'syncing' });
  }
  destroy() {
    this.disposed = true; clearTimeout(this.retry); clearTimeout(this.flush);
    this.socket?.close(); this.doc.off('update', this.onUpdate);
    void this.saving.finally(() => { this.persistence.close(); this.doc.destroy(); });
  }
}
