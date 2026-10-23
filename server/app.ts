import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { MAX_STATE_BYTES, validateDocument } from '../shared/document.js';
import { RoomStore, type Grant } from './store.js';

const ROOM = /^[A-Za-z0-9_-]{16}$/;
const WIRE_LIMIT = 360 * 1024;
const send = (socket: WebSocket, value: unknown) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > WIRE_LIMIT * 2) { socket.close(1013, 'Slow connection; reconnect to resync'); return; }
  socket.send(JSON.stringify(value));
};
const error = (socket: WebSocket, code: string, message: string) => send(socket, { type: 'error', code, message });
function decode(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_STATE_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid update encoding.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_STATE_BYTES || bytes.toString('base64') !== value) throw new Error('Update too large or noncanonical.');
  return bytes;
}
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('Request too large.'); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

export function createRoomServer(options: { database: string; staticDir?: string; publicOrigin?: string }) {
  const store = new RoomStore(options.database);
  const peers = new Map<WebSocket, { grant?: Grant; count: number; window: number }>();
  const creationBuckets = new Map<string, { count: number; until: number }>();
  const validOrigin = (req: IncomingMessage) => {
    if (!req.headers.origin) return true; // Non-browser clients still need a capability.
    try { return options.publicOrigin ? req.headers.origin === options.publicOrigin : new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { status: 'ok' });
      if (!validOrigin(req)) return json(res, 403, { error: 'Origin is not allowed.' });
      if (req.method === 'POST' && path === '/api/rooms') {
        const payload = await body(req);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) return json(res, 400, { error: 'Send an empty JSON object.' });
        const key = req.socket.remoteAddress ?? 'unknown', now = Date.now();
        for (const [ip, bucket] of creationBuckets) if (bucket.until < now) creationBuckets.delete(ip);
        const bucket = creationBuckets.get(key) ?? { count: 0, until: now + 3_600_000 };
        if (bucket.count >= 10 || creationBuckets.size >= 10_000) return json(res, 429, { error: 'Room creation limit reached. Try again later.' });
        bucket.count++; creationBuckets.set(key, bucket);
        return json(res, 201, store.create());
      }
      const rotate = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16})\/invites$/);
      if (req.method === 'POST' && rotate) {
        const grant = store.authorize(rotate[1], req.headers.authorization?.replace(/^Bearer /, ''));
        if (grant?.role !== 'owner') return json(res, 403, { error: 'Only the room creator can replace invite links.' });
        await body(req);
        const invites = store.rotate(rotate[1]);
        for (const [peer, state] of peers) if (state.grant?.room === rotate[1] && !store.active(state.grant)) { error(peer, 'revoked', 'This invite was revoked. Ask the creator for a new link.'); peer.close(1008, 'Capability revoked'); }
        return json(res, 200, invites);
      }
      if (path.startsWith('/api/') || req.method !== 'GET') return json(res, 404, { error: 'Not found.' });
      if (!options.staticDir) return json(res, 404, { error: 'Start the Vite client or build the frontend.' });
      const root = resolve(options.staticDir), target = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!target.startsWith(root + sep)) return json(res, 404, { error: 'Not found.' });
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      if (!types[extname(target)] || !(await stat(target)).isFile()) return json(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': types[extname(target)], 'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(await readFile(target));
    } catch (failure) { if (!res.headersSent) json(res, failure instanceof SyntaxError ? 400 : 400, { error: 'Request could not be completed.' }); else res.end(); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: WIRE_LIMIT, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !validOrigin(req) || peers.size >= 200) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, peer => wss.emit('connection', peer));
  });
  wss.on('connection', socket => {
    const state: { grant?: Grant; count: number; window: number } = { count: 0, window: Date.now() };
    peers.set(socket, state);
    const helloTimer = setTimeout(() => socket.close(1008, 'Handshake required'), 5000);
    socket.on('error', () => {}); // ws already closes malformed/oversized frames.
    socket.on('close', () => { clearTimeout(helloTimer); peers.delete(socket); });
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('JSON messages required.');
        if (Date.now() - state.window > 60_000) { state.window = Date.now(); state.count = 0; }
        if (++state.count > 600) { error(socket, 'rate_limit', 'Too many updates. Reconnect in a minute.'); socket.close(1008, 'Rate limit'); return; }
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('Invalid message.');
        if (!state.grant) {
          if (msg.type !== 'hello' || typeof msg.room !== 'string' || !ROOM.test(msg.room) || Object.keys(msg).some(k => !['type', 'room', 'token'].includes(k))) throw new Error('Invalid handshake.');
          const grant = store.authorize(msg.room, msg.token);
          if (!grant) { error(socket, 'unauthorized', 'This invite is invalid or revoked.'); socket.close(1008, 'Unauthorized'); return; }
          if ([...peers.values()].filter(p => p.grant?.room === grant.room).length >= 32) { error(socket, 'capacity', 'This room is full.'); socket.close(1008, 'Room full'); return; }
          clearTimeout(helloTimer); state.grant = grant;
          send(socket, { type: 'sync', role: grant.role, update: Buffer.from(store.snapshot(grant.room)!).toString('base64') });
          return;
        }
        if (!store.active(state.grant)) { error(socket, 'revoked', 'This invite is revoked.'); socket.close(1008, 'Revoked'); return; }
        if (msg.type !== 'update' || Object.keys(msg).some(k => !['type', 'update', 'requestId'].includes(k)) || !Number.isSafeInteger(msg.requestId) || msg.requestId < 0) throw new Error('Invalid update message.');
        if (state.grant.role === 'read') { error(socket, 'read_only', 'This link allows reading only.'); return; }
        const update = decode(msg.update);
        const previous = new Y.Doc(), candidate = new Y.Doc();
        try {
          const snapshot = store.snapshot(state.grant.room)!;
          Y.applyUpdate(previous, snapshot); Y.applyUpdate(candidate, snapshot); Y.applyUpdate(candidate, update);
          validateDocument(candidate, previous);
          // Synchronous SQLite commit precedes both acknowledgement and fan-out.
          store.save(state.grant.room, Y.encodeStateAsUpdate(candidate));
          send(socket, { type: 'ack', requestId: msg.requestId });
          for (const [peer, other] of peers) if (peer !== socket && other.grant?.room === state.grant.room && store.active(other.grant)) send(peer, { type: 'update', update: msg.update });
        } finally { previous.destroy(); candidate.destroy(); }
      } catch { error(socket, 'invalid_update', 'The update was rejected: malformed data, immutable anchor, removal marker, or room limit.'); }
    });
  });
  return {
    server, store,
    async listen(port = 0, host = '127.0.0.1') { await new Promise<void>(resolve => server.listen(port, host, resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listening address.'); return `http://${host}:${address.port}`; },
    async close() { for (const socket of peers.keys()) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); }
  };
}
