# Verification record

Environment: Node **24.19.0**, npm **11.9.0**, Linux. The implementation was checked
with a fresh lockfile install. No live employer, user account, or third-party
application was accessed.

| Command | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | Passed; dependencies restored from the committed lockfile |
| `npm test` | 15 tests passed; no failures or skips |
| `npm run build` | TypeScript checks, Vite production bundle, and server compilation passed |
| `npm run smoke` | Compiled HTTP server served health, HTML, JS/CSS, service worker; traversal rejected; room created |
| `git diff --cached --check` | Passed before the implementation commit |

The network tests use real WebSockets and temporary SQLite files. Two separate
Y.Doc clients edit while disconnected, reconnect, and converge, including
concurrent insertions and removal versus edit. Reopening the SQLite file restores
acknowledged state. Access tests cover read-only writes, credentials used against
another room, owner-only invite rotation, active guest disconnection, and reuse
of a revoked invite. Input tests cover malformed JSON/base64/updates, oversized
frames, unknown shared roots, rich-text embeds, excessive notes, immutable
anchors, and attempts to undo deletion. Large valid snapshots are also accepted.

Local persistence tests use **fake-indexeddb**, then reopen the adapter into a new
Y.Doc. They test IDB transaction completion, two-tab merge-before-write, and failure reporting; they are not
evidence of a real browser's quota, eviction, or offline-cache behavior.

Four additional tests instantiate the actual RoomClient with real WebSockets and
fake-indexeddb. They cover a same-invite offline tab saving and closing before
another tab reconnects (with notifications disabled), live notification delivery
of notes/edits/tombstones, per-invite cache isolation, absence of save loops, an
online tab relaying an offline tab's committed work, and server state matching
the client when it reports synced. Concurrent 1,500-character edits merge to an
invalid 3,000-character note; the client retains editable, visibly unsynced state,
accepts incremental shortening, and successfully reconnects after repair. A
revoked guest remains non-editable even after toggling offline and reconnecting.

The closed-tab test was first run against the original implementation and failed
with `live B must include saved closed-tab edits before reporting synced`. The
fixed implementation passes the same scenario without BroadcastChannel support.

Limits of this verification:

- The implementing agent did not run a live browser. Root-level browser review
  is a separate check; no screenshots or browser accessibility audit are claimed
  here.
- Docker is not installed in the implementation environment. Dockerfile and
  Compose definitions were not built/run.
- Restart coverage closes and reopens the server/SQLite file. It does not inject
  filesystem corruption, power loss, or process termination during an fsync.
- No load/performance benchmark, public hosting, multi-process operation, user
  trial, or production reliability claim is made.
- The 120 ms client batching, service-worker app-shell install, and browser quota
  UI require real-browser checks in addition to the tested protocol/adapter.

An early test fixture treated a valid empty Yjs update as malformed. It was
corrected to truncated update bytes; the server correctly accepts no-op updates.
The `tsx` CLI's IPC socket was unavailable in the runner, so scripts use the
supported `node --import tsx` entry point instead.
