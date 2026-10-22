// Shared overlay primitives: Modal (focus-trapped), the end-session confirm,
// the row kebab menu, and toasts.
import { html } from '../lib/html.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon } from './icons.js';
import {
  closeOverlay, endSession, closePane, closeMenu, focusSession, setRenaming, copyAttach, resumeSession, askEndSession,
} from '../lib/actions.js';
import { sessionName } from '../lib/model.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ label, labelledby, onClose, children, size = 'md', class: cls = '', align = 'center' }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Layout effect: Escape/Tab work from the very first frame the dialog exists.
  useLayoutEffect(() => {
    const prev = document.activeElement;
    const node = ref.current;
    const list = () => [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    requestAnimationFrame(() => {
      const el = node.querySelector('[data-autofocus]') || list()[0];
      if (el) el.focus();
    });
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      } else if (e.key === 'Tab') {
        const f = list();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
    };
  }, []);
  return html`<div class=${`modal-backdrop align-${align}`} onMouseDown=${(e) => { if (e.target === e.currentTarget) close.current(); }}>
    <div ref=${ref} class=${`modal modal-${size} ${cls}`} role="dialog" aria-modal="true" aria-label=${labelledby ? undefined : label}
      aria-labelledby=${labelledby}>${children}</div>
  </div>`;
}

export function EndDialog({ sid }) {
  const s = useStore((st) => st.sessions[sid]);
  const agentsById = useStore((st) => st.agentsById);
  const isOpen = useStore((st) => st.open.includes(sid));
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const name = sessionName(s, agentsById);
  const end = async () => {
    setBusy(true);
    await endSession(sid);
    setBusy(false);
    closeOverlay();
  };
  return html`<${Modal} labelledby="end-title" onClose=${closeOverlay} size="sm" class="confirm">
    <div class="modal-body">
      <h2 id="end-title" class="modal-title">End “${name}”?</h2>
      <p class="modal-text">The Claude Code process for this session stops. The conversation stays on disk, so you can resume it from Recent.</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-quiet" onClick=${closeOverlay}>Cancel</button>
      ${isOpen ? html`<button class="btn btn-quiet" onClick=${() => { closePane(sid); closeOverlay(); }} data-testid="confirm-hide">Hide pane, keep running</button>` : null}
      <button class="btn btn-danger" onClick=${end} disabled=${busy} data-autofocus data-testid="confirm-end">${busy ? 'Ending…' : 'End session'}</button>
    </div>
  </${Modal}>`;
}

export function Menu() {
  const menu = useStore((s) => s.menu);
  const sessions = useStore((s) => s.sessions);
  const open = useStore((s) => s.open);
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(menu.x - r.width, window.innerWidth - r.width - 8));
    let top = menu.y + 4;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, menu.y - r.height - 36);
    setPos({ left, top });
    const first = ref.current.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) closeMenu(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...ref.current.querySelectorAll('[role="menuitem"]')];
        const i = items.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        if (items[next]) items[next].focus();
      }
    };
    const onScroll = () => closeMenu();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [menu]);

  if (!menu) return null;
  let items = [];
  if (menu.type === 'session') {
    const s = sessions[menu.sid];
    if (!s) return null;
    const ended = s.status === 'ended';
    const isOpen = open.includes(s.sid);
    const act = (fn) => () => { closeMenu(); fn(); };
    items = [
      ended && s.resumable !== false ? { label: 'Resume', icon: 'play', run: act(() => resumeSession(s.sid)) } : null,
      { label: isOpen ? 'Focus pane' : 'Open in workspace', icon: 'layout-split', run: act(() => focusSession(s.sid)) },
      { label: 'Rename…', icon: 'more', run: act(() => { focusSession(s.sid); setTimeout(() => setRenaming(s.sid), 30); }) },
      { label: 'Copy attach command', icon: 'terminal', run: act(() => copyAttach(s)) },
      isOpen ? { label: 'Hide pane', icon: 'pane-hide', run: act(() => closePane(s.sid)) } : null,
      !ended ? { label: 'End session…', icon: 'x', danger: true, run: act(() => askEndSession(s.sid)) } : null,
    ].filter(Boolean);
  }
  return html`<div ref=${ref} class="menu" role="menu" aria-label="Session actions"
      style=${pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '-9999px', top: '0px' }}>
    ${items.map((it) => html`<button role="menuitem" class=${`menu-item ${it.danger ? 'is-danger' : ''}`} onClick=${it.run}>
      <${Icon} name=${it.icon} size=${14} /><span>${it.label}</span></button>`)}
  </div>`;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map((t) => html`<div key=${t.id} class=${`toast tone-${t.tone}`}>
      ${t.tone === 'error' ? html`<${Icon} name="alert" size=${14} />` : t.tone === 'ok' ? html`<${Icon} name="check" size=${14} />` : null}
      <span>${t.text}</span></div>`)}
  </div>`;
}
