import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as Y from 'yjs';
import { addAnnotation } from '../shared/document.js';

export type Role = 'read' | 'write' | 'owner';
export type Grant = { room: string; role: Role; hash: string };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export class RoomStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, snapshot BLOB NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capabilities (hash TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id), role TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS capabilities_room ON capabilities(room);`);
  }
  create() {
    if ((this.db.prepare('SELECT COUNT(*) AS count FROM rooms').get() as { count: number }).count >= 1000) throw new Error('Room capacity reached.');
    const room = randomBytes(12).toString('base64url');
    const ownerToken = secret(), readToken = secret(), writeToken = secret();
    const doc = new Y.Doc();
    addAnnotation(doc, 0, 60, 'What makes a space feel welcoming to an unfinished thought?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO rooms VALUES (?, ?, ?)').run(room, Y.encodeStateAsUpdate(doc), new Date().toISOString());
      this.add(room, 'owner', ownerToken); this.add(room, 'read', readToken); this.add(room, 'write', writeToken);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; } finally { doc.destroy(); }
    return { room, ownerToken, readToken, writeToken };
  }
  private add(room: string, role: Role, token: string) {
    this.db.prepare('INSERT INTO capabilities (hash, room, role) VALUES (?, ?, ?)').run(hash(token), room, role);
  }
  authorize(room: string, token: unknown): Grant | undefined {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const tokenHash = hash(token);
    const row = this.db.prepare('SELECT room, role FROM capabilities WHERE hash = ? AND room = ? AND revoked = 0').get(tokenHash, room) as { room: string; role: Role } | undefined;
    return row ? { ...row, hash: tokenHash } : undefined;
  }
  active(grant: Grant): boolean { return !!this.db.prepare('SELECT 1 FROM capabilities WHERE hash = ? AND room = ? AND revoked = 0').get(grant.hash, grant.room); }
  snapshot(room: string): Uint8Array | undefined {
    const row = this.db.prepare('SELECT snapshot FROM rooms WHERE id = ?').get(room) as { snapshot: Uint8Array } | undefined;
    return row?.snapshot;
  }
  save(room: string, update: Uint8Array) { this.db.prepare('UPDATE rooms SET snapshot = ? WHERE id = ?').run(update, room); }
  rotate(room: string) {
    const readToken = secret(), writeToken = secret();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Only current capabilities are needed. Existing sockets are checked and closed
      // after this transaction; old secrets can never authorize again.
      this.db.prepare("DELETE FROM capabilities WHERE room = ? AND role != 'owner'").run(room);
      this.add(room, 'read', readToken); this.add(room, 'write', writeToken);
      this.db.exec('COMMIT');
      return { readToken, writeToken };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
