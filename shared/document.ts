import * as Y from 'yjs';

export const TITLE = 'A place to think together';
export const DOCUMENT = 'A good shared space leaves room for unfinished thoughts. A question in the margin can be more useful than a polished answer. It invites someone else to notice what we missed.\n\nWorking together does not always mean working at the same time. We read on the train, lose a connection, close a laptop, and return later. Our tools should make those pauses ordinary, without asking us to choose which person’s work to keep.\n\nThe most useful record is not a perfect transcript. It is a small collection of observations that helps us see the next step. Keep the passage, add a thought, and leave enough space for the conversation to continue.';
export const MAX_NOTES = 128;
export const MAX_BODY = 2000;
export const MAX_STATE_BYTES = 256 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type Annotation = { id: string; start: number; end: number; body: string; deleted: boolean };

/** randomUUID is secure-context-only; getRandomValues is also available on LAN HTTP. */
export function newAnnotationId(source: { randomUUID?: () => string; getRandomValues?: (array: Uint8Array) => Uint8Array } = globalThis.crypto): string {
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') throw new Error('This browser cannot create secure note IDs. Open the room in a current browser using HTTPS or localhost.');
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function annotations(doc: Y.Doc) { return doc.getMap<Y.Map<unknown>>('annotations'); }
export function tombstones(doc: Y.Doc) { return doc.getMap<boolean>('deleted'); }
export function listAnnotations(doc: Y.Doc): Annotation[] {
  return [...annotations(doc)].map(([id, item]) => ({ id, start: item.get('start') as number, end: item.get('end') as number, body: (item.get('body') as Y.Text).toString(), deleted: tombstones(doc).get(id) === true })).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
export function addAnnotation(doc: Y.Doc, start: number, end: number, body: string, id = newAnnotationId()): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > DOCUMENT.length || body.length > MAX_BODY || !UUID.test(id)) throw new Error('Choose a passage and keep notes under 2,000 characters.');
  if (annotations(doc).size >= MAX_NOTES || annotations(doc).has(id)) throw new Error('This room has reached its 128-note limit.');
  doc.transact(() => {
    const item = new Y.Map<unknown>();
    item.set('start', start); item.set('end', end); item.set('body', new Y.Text(body));
    annotations(doc).set(id, item);
  }, 'local');
  return id;
}
export function editAnnotation(doc: Y.Doc, id: string, next: string): void {
  if (tombstones(doc).get(id)) return;
  const body = annotations(doc).get(id)?.get('body');
  if (!(body instanceof Y.Text)) throw new Error('Note is unavailable.');
  const previous = body.toString();
  // Concurrent valid offline edits can merge above the body limit. Allow
  // incremental shortening so users can repair their retained local copy.
  if (next.length > MAX_BODY && next.length >= previous.length) throw new Error('Notes are limited to 2,000 characters. Shorten this note to sync.');
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = 0;
  while (end < previous.length - start && end < next.length - start && previous[previous.length - 1 - end] === next[next.length - 1 - end]) end++;
  doc.transact(() => {
    body.delete(start, previous.length - start - end);
    body.insert(start, next.slice(start, next.length - end));
  }, 'local');
}
export function removeAnnotation(doc: Y.Doc, id: string): void {
  if (annotations(doc).has(id)) tombstones(doc).set(id, true);
}

/** Validate on an isolated candidate, so rejected updates never mutate live state. */
export function validateDocument(candidate: Y.Doc, previous?: Y.Doc): void {
  const notes = annotations(candidate), deleted = tombstones(candidate);
  if ([...candidate.share.keys()].some(key => key !== 'annotations' && key !== 'deleted')) throw new Error('Unknown shared type.');
  if (notes.size > MAX_NOTES || deleted.size > MAX_NOTES) throw new Error('Room note limit reached.');
  for (const [id, item] of notes) {
    if (!UUID.test(id) || !(item instanceof Y.Map) || item.size !== 3) throw new Error('Invalid annotation.');
    const start = item.get('start'), end = item.get('end'), body = item.get('body');
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > DOCUMENT.length || !(body instanceof Y.Text) || body.length > MAX_BODY) throw new Error('Invalid passage or note body.');
    if ([...item.keys()].some(key => !['start', 'end', 'body'].includes(key))) throw new Error('Invalid annotation fields.');
    // Rich-text attributes and embeds are deliberately unsupported.
    if (body.toDelta().some((part: { insert?: unknown; attributes?: unknown }) => typeof part.insert !== 'string' || part.attributes)) throw new Error('Notes must be plain text.');
    const before = previous && annotations(previous).get(id);
    if (before && (before.get('start') !== start || before.get('end') !== end)) throw new Error('Passage anchors are immutable.');
  }
  for (const [id, value] of deleted) if (value !== true || !notes.has(id)) throw new Error('Invalid removal marker.');
  if (previous) {
    for (const id of annotations(previous).keys()) if (!notes.has(id)) throw new Error('Use a removal marker; do not erase annotation identity.');
    for (const id of tombstones(previous).keys()) if (!deleted.get(id)) throw new Error('Removed notes cannot be restored.');
  }
  if (Y.encodeStateAsUpdate(candidate).byteLength > MAX_STATE_BYTES) throw new Error('Room history limit reached.');
}
