import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomClient } from './client.js';
import { DOCUMENT, TITLE, MAX_BODY, addAnnotation, editAnnotation, listAnnotations, removeAnnotation, type Annotation } from '../shared/document.js';
import './style.css';

type Invite = { room: string; token: string };
type Shares = { readToken: string; writeToken: string };
const inviteFromURL = (): Invite | null => {
  const params = new URLSearchParams(location.hash.slice(1)), room = params.get('room'), token = params.get('cap');
  return room && token && /^[A-Za-z0-9_-]{16}$/.test(room) && /^[A-Za-z0-9_-]{43}$/.test(token) ? { room, token } : null;
};
const inviteURL = (room: string, token: string) => `${location.origin}/#room=${room}&cap=${token}`;
function Icon({ name }: { name: 'mark' | 'arrow' | 'share' | 'wifi' | 'close' }) {
  const paths = { mark: <><path d="M5 3h14v18l-7-4-7 4z"/><path d="M9 8h6M9 12h4"/></>, arrow: <><path d="M4 12h15m-6-6 6 6-6 6"/></>, share: <><path d="M12 15V3m-4 4 4-4 4 4M5 11v9h14v-9"/></>, wifi: <><path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r=".5"/></>, close: <path d="m6 6 12 12M6 18 18 6"/> };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function App() {
  const [invite, setInvite] = useState(inviteFromURL), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [shares, setShares] = useState<Shares | null>(null);
  useEffect(() => { const onHash = () => { setInvite(inviteFromURL()); setShares(null); }; addEventListener('hashchange', onHash); return () => removeEventListener('hashchange', onHash); }, []);
  async function create() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      history.replaceState(null, '', `#room=${data.room}&cap=${data.ownerToken}`);
      setShares({ readToken: data.readToken, writeToken: data.writeToken }); setInvite({ room: data.room, token: data.ownerToken });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not create a room.'); } finally { setBusy(false); }
  }
  return <><header className="site-header"><a className="brand" href="/" aria-label="Margin home"><Icon name="mark"/><span>margin<span className="brand-dot">.</span></span></a><span className="header-caption">A shared reading room</span><a className="header-link" href="https://docs.yjs.dev/" target="_blank" rel="noreferrer">Built for coming back</a></header>
    {invite ? <Notebook key={`${invite.room}-${invite.token}`} invite={invite} shares={shares} setShares={setShares}/> : <main className="landing"><div className="eyebrow"><span className="tiny-line"/> THINK TOGETHER, AT YOUR OWN PACE</div><h1>Good ideas<br/>leave a <em>mark.</em></h1><p className="landing-intro">A quiet place to read, leave a thought, and pick up where you left off. Your notes stay with you, even when your connection doesn’t.</p><button className="primary" onClick={create} disabled={busy}>{busy ? 'Opening your room…' : 'Create a reading room'}<Icon name="arrow"/></button>{error && <p className="error" role="alert">{error}</p>}<div className="landing-proof"><span>01 / Read a passage</span><span>02 / Add your perspective</span><span>03 / Bring it together</span></div><div className="preview" aria-label="Example of an annotated passage"><span className="eyebrow">FROM THE READING ROOM</span><p>“A question in the margin can be more useful than <mark>a polished answer.</mark>”</p><div className="preview-note"><span className="note-dot"/> Make space for the unfinished thought.</div><span className="preview-label">A small note. A new way of seeing.</span></div></main>}
    <footer><span>Room for a different perspective.</span><span>Plain text. Shared thoughts.</span></footer></>;
}
function Notebook({ invite, shares, setShares }: { invite: Invite; shares: Shares | null; setShares: (shares: Shares) => void }) {
  const [client] = useState(() => new RoomClient(invite.room, invite.token));
  const [, rerender] = useState(0), [selection, setSelection] = useState<{ start: number; end: number } | null>(null), [draft, setDraft] = useState(''), [active, setActive] = useState(''), [localError, setLocalError] = useState(''), [shareOpen, setShareOpen] = useState(false);
  const paper = useRef<HTMLDivElement>(null), draftInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const unsubscribe = client.subscribe(() => rerender(v => v + 1)); void client.start(); return () => { unsubscribe(); client.destroy(); }; }, [client]);
  const state = client.state, notes = listAnnotations(client.doc), visible = notes.filter(note => !note.deleted), removed = notes.length - visible.length;
  const canEdit = state.loaded && state.connection !== 'error' && (state.role === 'write' || state.role === 'owner');
  function captureSelection() {
    const range = window.getSelection();
    if (!range?.rangeCount || range.isCollapsed || !paper.current?.contains(range.anchorNode) || !paper.current.contains(range.focusNode)) return;
    const selected = range.getRangeAt(0), prefix = selected.cloneRange();
    prefix.selectNodeContents(paper.current); prefix.setEnd(selected.startContainer, selected.startOffset);
    const start = prefix.toString().length, end = start + selected.toString().length;
    if (end <= DOCUMENT.length && end > start) setSelection({ start, end });
  }
  function add() {
    if (!selection || !canEdit || !draft.trim()) return;
    try { const id = addAnnotation(client.doc, selection.start, selection.end, draft.trim()); setActive(id); setDraft(''); setSelection(null); setLocalError(''); window.getSelection()?.removeAllRanges(); } catch (failure) { setLocalError((failure as Error).message); }
  }
  function chooseOpening() { setSelection({ start: 0, end: DOCUMENT.indexOf('.') + 1 }); draftInput.current?.focus(); }
  const boundaries = [...new Set([0, DOCUMENT.length, ...visible.flatMap(note => [note.start, note.end])])].sort((a, b) => a - b);
  const connectionLabel = { connecting: 'Connecting…', offline: state.online ? 'Reconnecting…' : 'Working offline', syncing: 'Syncing changes…', synced: 'All changes synced', error: 'Sync needs attention' }[state.connection];
  return <main className="workspace"><section className="workspace-heading"><div><div className="eyebrow">YOUR READING ROOM <span className="room-id">/ {invite.room.slice(0, 6)}</span></div><h1>Thoughts in the margin.</h1><p>Read closely. Leave a thought. Find a little more together.</p></div><div className="room-actions"><button className="subtle" onClick={() => client.setOnline(!state.online)}><Icon name="wifi"/>{state.online ? 'Disconnect' : 'Reconnect'}</button><button className="dark-button" onClick={() => setShareOpen(true)}><Icon name="share"/>Share room</button></div></section>
    <div className="status-bar" role="status"><span className={`status-dot ${state.connection === 'synced' ? 'green' : ''}`}/><span>{connectionLabel}</span><span className="status-divider">/</span><span>{state.local === 'saved' ? 'Saved on this device' : state.local === 'saving' ? 'Saving on this device…' : state.local === 'error' ? 'Local save unavailable' : 'Loading local notes…'}</span><span className="role">{state.role === 'read' ? 'READ ONLY' : state.role === 'unknown' ? 'CONNECTING' : 'EDITING'}</span></div>
    {(state.error || localError) && <div className="error notice" role="alert">{state.error || localError}</div>}
    {!state.online && <div className="offline-notice">You’re working on this device. Your notes will come together with everyone else’s when you reconnect.</div>}
    <div className="reading-grid"><section className="paper"><div className="paper-meta"><span>FIELD NOTES · 001</span><span>2 MIN READ</span></div><h2>{TITLE}</h2><p className="byline">A short reflection for a shared notebook</p><div className="document" ref={paper} onMouseUp={captureSelection} onTouchEnd={captureSelection} onKeyUp={captureSelection} tabIndex={0} aria-label="Document text. Select a passage to annotate.">{boundaries.slice(0, -1).map((start, index) => { const end = boundaries[index + 1], note = visible.find(note => note.start <= start && note.end >= end); return note ? <mark key={start} className={note.id === active ? 'active-highlight' : ''} onClick={() => setActive(note.id)}>{DOCUMENT.slice(start, end)}</mark> : <React.Fragment key={start}>{DOCUMENT.slice(start, end)}</React.Fragment>; })}</div><div className="paper-bottom"><span className="paper-number">01</span><p>{canEdit ? 'Select any passage to begin an annotation.' : 'Read the passage and explore the shared notes.'}</p>{canEdit && <button className="text-button" onClick={chooseOpening}>Annotate the opening <span aria-hidden="true">↗</span></button>}</div></section>
      <aside className="notes-pane"><div className="notes-title"><h2>In the margins <span>{visible.length.toString().padStart(2, '0')}</span></h2><span className="little-star" aria-hidden="true">✳</span></div><p className="notes-caption">Different perspectives, one shared page.</p>
      {canEdit && <section className={`composer ${selection ? 'has-selection' : ''}`} aria-labelledby="composer-title"><h3 id="composer-title">{selection ? 'Your selected passage' : 'Leave a thought'}</h3>{selection ? <blockquote>{DOCUMENT.slice(selection.start, selection.end)}</blockquote> : <p>Select text on the page, or start with the opening.</p>}<label className="sr-only" htmlFor="draft">Your new annotation</label><textarea id="draft" ref={draftInput} value={draft} maxLength={MAX_BODY} placeholder="What does this bring to mind?" onChange={event => setDraft(event.target.value)} rows={3}/><div className="composer-bottom"><span>{draft.length}/{MAX_BODY}</span><button className="small-primary" disabled={!selection || !draft.trim()} onClick={add}>Add note <span aria-hidden="true">+</span></button></div></section>}
      <div className="note-list">{visible.map((note, index) => <Note key={note.id} note={note} index={index} active={note.id === active} editable={canEdit} onFocus={() => setActive(note.id)} onEdit={text => editAnnotation(client.doc, note.id, text)} onRemove={() => removeAnnotation(client.doc, note.id)}/>)}{!visible.length && <div className="empty-notes"><Icon name="mark"/><h3>The margins are open.</h3><p>{canEdit ? 'Select a passage and add the first thought.' : 'Shared notes will appear here.'}</p></div>}</div>{removed > 0 && <p className="removed-note">{removed} {removed === 1 ? 'note has' : 'notes have'} been removed. Offline edits won’t bring them back.</p>}</aside></div>
    {shareOpen && <ShareDialog invite={invite} shares={shares} owner={state.role === 'owner'} setShares={setShares} onClose={() => setShareOpen(false)}/>}
  </main>;
}
function Note({ note, index, active, editable, onFocus, onEdit, onRemove }: { note: Annotation; index: number; active: boolean; editable: boolean; onFocus: () => void; onEdit: (text: string) => void; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return <article className={`note ${active ? 'active-note' : ''}`} onFocus={onFocus}><div className="note-top"><span className="note-dot"/><span>NOTE {(index + 1).toString().padStart(2, '0')}</span><span className="shared-label">Shared</span></div><blockquote>{DOCUMENT.slice(note.start, note.end)}</blockquote>{editable ? <><label className="sr-only" htmlFor={`note-${note.id}`}>Edit note {index + 1}</label><textarea id={`note-${note.id}`} value={note.body} maxLength={MAX_BODY} onChange={event => onEdit(event.target.value)} rows={Math.min(8, Math.max(2, Math.ceil(note.body.length / 40)))}/><div className="note-footer"><span>Edits save automatically</span><button className="text-button remove-button" onClick={() => setConfirm(!confirm)}>{confirm ? 'Keep note' : 'Remove'}</button></div>{confirm && <div className="remove-confirm"><p>Remove this note for everyone? This cannot be undone.</p><button className="danger-button" onClick={onRemove}>Remove note</button></div>}</> : <p className="note-body">{note.body}</p>}</article>;
}
function ShareDialog({ invite, shares, owner, setShares, onClose }: { invite: Invite; shares: Shares | null; owner: boolean; setShares: (shares: Shares) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), [error, setError] = useState(''), [copied, setCopied] = useState(''), [busy, setBusy] = useState(false), [confirmRotate, setConfirmRotate] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function rotate() {
    setBusy(true); setError('');
    try { const res = await fetch(`/api/rooms/${invite.room}/invites`, { method: 'POST', headers: { Authorization: `Bearer ${invite.token}` } }); const data = await res.json(); if (!res.ok) throw new Error(data.error); setShares(data); setConfirmRotate(false); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  async function copy(label: string, url: string) { try { await navigator.clipboard.writeText(url); setCopied(label); } catch { setError('Copy is unavailable. Select the link below and copy it manually.'); } }
  const links = owner ? shares ? [{ label: 'Can edit', description: 'Add, edit, and remove shared notes.', token: shares.writeToken }, { label: 'Can read', description: 'Read shared notes without changing them.', token: shares.readToken }] : [] : [{ label: 'Your invite', description: 'This link gives the same access you received.', token: invite.token }];
  return <dialog ref={dialog} className="share-dialog" onCancel={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}><div className="dialog-heading"><span className="eyebrow">MAKE ROOM FOR SOMEONE ELSE</span><button className="icon-button" aria-label="Close sharing" onClick={onClose}><Icon name="close"/></button></div><h2>Another perspective<br/>starts with an invite.</h2><p>Anyone with a link can use its access. Share it with people you trust.</p>{links.map(link => <div className="share-option" key={link.label}><div><h3>{link.label}</h3><p>{link.description}</p></div><button className="small-primary" onClick={() => copy(link.label, inviteURL(invite.room, link.token))}>{copied === link.label ? 'Copied' : 'Copy link'}</button><input aria-label={`${link.label} invitation link`} readOnly value={inviteURL(invite.room, link.token)} onFocus={event => event.target.select()}/></div>)}{owner && <div className="rotation"><p>{shares ? 'Replacing links disconnects existing guests. It cannot erase notes already downloaded to their devices.' : 'Your creator link stays private. Generate new guest links to invite readers and editors; previously shared links will stop working.'}</p>{confirmRotate || !shares ? <button className="subtle" disabled={busy} onClick={rotate}>{busy ? 'Replacing…' : 'Replace guest links'}</button> : <button className="text-button" onClick={() => setConfirmRotate(true)}>Replace existing guest links</button>}</div>}{error && <p className="error" role="alert">{error}</p>}</dialog>;
}

createRoot(document.getElementById('root')!).render(<App/>);
if ('serviceWorker' in navigator && !location.port.startsWith('517')) addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}); });
