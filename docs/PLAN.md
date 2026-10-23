# Implementation plan

Build one small, real shared reading room. The sample document is fixed plain text;
annotations use UUID keys, immutable UTF-16 offsets, and Y.Text bodies. Independent
annotations live in a Y.Map. A separate monotonic tombstone map makes removal win
over simultaneous offline edits. Yjs supplies the merge algorithm.

1. Shared schema, bounds, and CRDT helpers; SQLite room/capability store.
2. WebSocket handshake, candidate-document validation, durable-before-ack writes,
   room-bound read/write/owner access and invite revocation.
3. React reading UI, IndexedDB snapshot persistence, honest local/sync state,
   explicit disconnect/reconnect, and share controls.
4. Real WebSocket two-client tests, restart/reopen tests, malformed/bounds/access
   tests, and IndexedDB adapter tests; build, CI and Docker packaging.

This is a single-process service and a small-room demonstration. No invented CRDT,
production adoption, multi-region consistency, or end-to-end encryption claim.
Capabilities are bearer secrets; the creator can rotate shared read/write links.
Offline edits are provisional until accepted by the server. Revoked clients retain
previously downloaded data and their local work; revocation cannot erase it.
