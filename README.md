# Margin · offline annotations

A small shared reading room. Select a passage, leave a note, disconnect, and keep
writing. Reconnecting merges independent annotations and concurrent note text
through **Yjs**. React renders the reading interface; IndexedDB keeps local
snapshots; a Node 24 WebSocket server authorizes room capabilities and commits
accepted state to SQLite before acknowledging it.

This is a **0.1.0 portfolio implementation**, not a claim of production use. The
document is one fixed, synthetic plain-text essay. No private project source or
personal records are included. No AI service, account, or paid API is required.

## Run it

Requires Node **24 or newer** and npm. Node's built-in `node:sqlite` supplies the
database; there is no separate database service.

```sh
npm ci
npm run build
npm start
```

Open **http://localhost:3044**. The built server serves both the frontend and the
WebSocket endpoint. Click **Create a reading room**, then **Share room** to copy a
read or edit invite into a second tab or browser. Keep the creator URL private.

For frontend development, run these in separate terminals:

```sh
npm run dev:server
npm run dev
```

Vite listens on **5176** and proxies `/api` and `/ws` to **3044**. It binds to
`0.0.0.0` for LAN/preview testing and permits the `terminal.local` preview host.
The built application binds to loopback unless `HOST` is set explicitly.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3044` | Built server / development API port |
| `HOST` | `127.0.0.1` | Server bind address |
| `DATABASE_PATH` | `data/margin.sqlite` | SQLite file, including room secrets' hashes |
| `PUBLIC_ORIGIN` | unset | Exact browser origin, e.g. `https://notes.example.org`; otherwise Origin host must equal Host |

Serve public deployments over HTTPS with a reverse proxy that supports WebSocket
upgrades, set `PUBLIC_ORIGIN`, and persist the database directory. Capability links
are bearer credentials; HTTP LAN preview is only for synthetic testing. Browser
service workers require HTTPS or localhost. Note IDs use `crypto.getRandomValues`
when `randomUUID` is unavailable on HTTP previews; never `Math.random`.

### Docker

```sh
docker compose up --build
```

Open http://localhost:3044. The Compose file binds only to loopback and keeps the
SQLite database in a named volume. The container runs as the non-root `node` user.
Docker packaging is supplied; see [verification](docs/VERIFICATION.md) for what
was actually executed.

## A two-window walkthrough

1. Create a room in window A. Copy **Can edit** from Share room into window B.
2. Select a passage in A, or choose **Annotate the opening**, and add a note.
   It appears in B after the server accepts it.
3. Click **Disconnect** in both windows. Add different notes and edit an existing
   note in each. Wait for **Saved on this device**; this means an IndexedDB
   transaction completed, not that the server received the changes.
4. Remove a note in A while editing that same note in offline B. Reconnect both.
   Independent notes and note-text edits merge. The removed note stays removed.
5. Reload a window. Local notes load from IndexedDB; the server then reconciles
   them. Stop and restart the server to exercise SQLite recovery.
6. Open a **Can read** link. The editor controls are absent; a forged update is
   also rejected by the server. The creator can **Replace guest links** to close
   current guest connections and revoke their old invitations.

**Disconnect** stops the sync socket. It does not simulate the entire browser
going offline. The built site's service worker separately caches the application
shell and its bundled assets after a successful installation; after that, the
existing room can be reopened without network access. Vite development does not
register the worker. Actual storage availability/eviction is browser-controlled.

## Data model and conflict rules

- The essay is immutable application text, outside the CRDT. Annotation anchors
  are immutable UTF-16 `[start, end)` offsets into that exact text. Changing the
  essay in a future version requires an explicit document/version migration.
- `annotations: Y.Map<Y.Map>` contains UUID-keyed annotations. Each annotation has
  `start`, `end`, and a plain-text `body: Y.Text`. Different notes merge
  independently. Concurrent insertion order follows Yjs, not wall-clock time.
- `deleted: Y.Map<boolean>` is a monotonic tombstone set. Only `true` is valid.
  The server refuses removal of an existing marker or annotation identity.
  An edit can merge into the hidden note, but cannot resurrect it. Deletion is
  intentionally permanent; creating a new note uses a new ID.
- Client textarea edits translate to a minimal prefix/suffix Y.Text splice.
  This is not a rich-text editor or a new CRDT algorithm. Overlapping text edits
  can produce an awkward merged sentence that people must revise.
- Updates are applied to an isolated candidate document, validated, committed to
  SQLite with WAL and `synchronous=FULL`, then acknowledged and broadcast. Failed
  validation never changes the durable snapshot. Duplicate updates are safe
  because Yjs updates are idempotent.
- Reconnect sends the durable server snapshot; an authorized writer merges it
  with its local document and sends its merged state back. The small-room protocol
  sends full state on client updates, batched by 120 ms; it is not optimized for
  large documents or high fan-out.
- IndexedDB stores snapshots per room/capability, so a read-only invite does not
  inherit another invite's unsent local edits. Read/merge/write uses one serialized
  IndexedDB transaction, preserving divergent snapshots from two offline tabs.

Yjs references: [document updates](https://docs.yjs.dev/api/document-updates),
[Y.Map](https://docs.yjs.dev/api/shared-types/y.map), and
[Y.Text](https://docs.yjs.dev/api/shared-types/y.text).

## Access and bounds

Room creation returns an owner capability plus distinct read/write capabilities.
Secrets are 256-bit random values, stored only as SHA-256 hashes on the server.
Invite URLs keep credentials in the fragment; the browser sends them in the first
WebSocket message, not the request URL. The server binds each credential to its
room and derives the role from SQLite, never from a client role claim. The owner
can replace guest links through an authenticated HTTP endpoint. Active guests are
disconnected, and every subsequent update rechecks authorization.

Revocation **cannot erase already downloaded data**, browser caches, or offline
notes. Revoked clients retain local work but cannot synchronize it. Offline UI
uses a previously server-confirmed role cached for that exact capability; it is
provisional and never grants server access. Anyone with an edit link can edit or
remove any annotation in that room. There are no user accounts or authorship
claims, per-note ownership, capability expiry, or end-to-end encryption.

Limits are explicit: 128 total note identities (including removed notes), 2,000
characters per note, 256 KiB encoded room history/update, 360 KiB WebSocket
messages, 32 connections per room, 200 connections per process, 600 messages per
connection/minute, 10 new rooms per source IP/hour, and 1,000 rooms per database.
Slow receivers are disconnected when queued output exceeds the bound. HTML,
embeds and rich-text attributes are rejected; React renders note strings as text.

Concurrent offline edits may exceed the aggregate limits even when each local
edit fits. Rejected work remains local and is visibly marked unsynced. Limits,
in-memory rate limits, and candidate validation reduce resource exposure; they
are not a substitute for a production abuse-control system. Do not store sensitive
material in a public demo. A single Node process owns the database and all room
fan-out; multiple replicas sharing SQLite are **not supported**.

## Verification

```sh
npm test
npm run build
npm run smoke
```

The integration suite uses independently instantiated `Y.Doc`s, real WebSockets,
and temporary on-disk SQLite databases. It exercises disconnected edits,
same-note concurrent text inserts, delete-vs-edit, duplicate delivery, database
reopen, read-only/cross-room access, guest revocation, malformed/oversized frames,
immutable anchors, tombstones and plain-text validation. IndexedDB adapter tests
use `fake-indexeddb`; they verify transaction/reopen behavior without claiming to
replace real-browser testing. `smoke` starts the compiled server and requests the
built HTML, assets, health endpoint, and room creation API.

See [verification record](docs/VERIFICATION.md) and [short implementation plan](docs/PLAN.md).

## Source map

| Path | Responsibility |
| --- | --- |
| `shared/document.ts` | Fixed essay, CRDT schema/helpers, validation, UUID fallback |
| `server/store.ts` | SQLite snapshots and hashed room capabilities |
| `server/app.ts` | HTTP, WebSockets, access checks, bounds, durable update protocol |
| `server/main.ts` | Configuration and graceful shutdown |
| `src/client.ts` | Browser synchronization/reconnect and honest save state |
| `src/persistence.ts` | IndexedDB snapshot transactions |
| `src/main.tsx`, `src/style.css` | Responsive reading, annotation and sharing UI |
| `public/sw.js` | Built-site app-shell cache |
| `tests/` | Network/persistence/permission regressions and built HTTP smoke |

Local caches retain capability roles and notebook data on the current browser
profile. Use a separate browser profile on a shared machine. Clearing site data
removes the local copy; it does not delete the room from the server.
