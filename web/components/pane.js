// One workspace pane: header (status, editable title, agent, model, live
// activity trace, actions), a needs-you bar, and the live terminal.
import { html } from '../lib/html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon, AgentIcon } from './icons.js';
import { StatusGlyph } from './status.js';
import { TerminalView } from './terminal.js';
import { terms, onTraceTick } from '../lib/term.js';
import {
  touchFocus, toggleMaximize, askEndSession, copyAttach, renameSession, mergeSession, resumeSession,
  closePane, setRenaming,
} from '../lib/actions.js';
import { sessionName, agentLabel, statusText, STATUS_LABEL, sessionTime } from '../lib/model.js';
import { relTime, prefersReducedMotion, MOD } from '../lib/util.js';
import { getState, setState } from '../lib/store.js';

export function Pane({ sid, index, hidden, order, span, layout, solo }) {
  const s = useStore((st) => st.sessions[sid]);
  const agentsById = useStore((st) => st.agentsById);
  const focused = useStore((st) => st.focused === sid);
  const focusTick = useStore((st) => st.focusTick);
  const renaming = useStore((st) => st.renaming === sid);
  const mobile = useStore((st) => st.mobile);
  const now = useStore((st) => st.now);
  const [conn, setConn] = useState('connecting');
  const [flash, setFlash] = useState(false);
  const el = useRef(null);
  // A pane that mounts already focused (just opened, or restored on reload) takes the keyboard too.
  const lastTick = useRef(focused ? -1 : focusTick);

  // A rail click / palette jump / ⌘N targets this pane: reveal it, flash it,
  // and put the keyboard in its terminal. Nothing else in the workspace moves.
  useEffect(() => {
    if (!focused || focusTick === lastTick.current) { lastTick.current = focusTick; return; }
    lastTick.current = focusTick;
    const node = el.current;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      const v = terms.get(sid);
      // Never pull the keyboard out of a dialog or menu opened since the jump.
      const busy = getState().overlay || getState().menu || (document.activeElement && document.activeElement.closest('.modal, .menu'));
      if (v && !busy) v.focus();
      setFlash(true);
      setTimeout(() => setFlash(false), 650);
    });
  }, [focused, focusTick]);

  if (!s) {
    return html`<section class=${`pane is-missing ${hidden ? 'is-hidden' : ''}`} data-pane=${sid} style=${{ order: String(order) }}>
      <div class="pane-missing"><p>This session is no longer on the server.</p>
      <button class="btn btn-quiet" onClick=${() => closePane(sid)}>Close pane</button></div>
    </section>`;
  }

  const name = sessionName(s, agentsById);
  const agent = agentsById[s.agent];
  const ended = s.status === 'ended';
  const maximized = layout === 'focus';

  const onStatus = (status) => { if (status && status !== s.status) mergeSession({ sid, status }); };
  const onEnded = () => {
    const cur = getState().sessions[sid];
    if (cur && cur.status !== 'ended') mergeSession({ sid, status: 'ended', ended_at: new Date().toISOString() });
  };

  const style = { order: String(order) };
  if (span > 1) style.gridRow = `span ${span}`;

  return html`<section ref=${el}
      class=${`pane st-${s.status} ${focused ? 'is-focused' : ''} ${hidden ? 'is-hidden' : ''} ${flash ? 'is-flash' : ''}`}
      data-pane=${sid} data-status=${s.status} data-focused=${focused ? 'true' : 'false'} style=${style}
      role="region" aria-label=${`${name} (${agentLabel(s, agentsById)})`}
      onMouseDown=${() => touchFocus(sid)} onFocusIn=${() => touchFocus(sid)}>
    <header class="pane-head">
      <span class="pane-glyph" title=${STATUS_LABEL[s.status] || s.status}><${StatusGlyph} status=${s.status} /></span>
      <${PaneTitle} sid=${sid} name=${name} title=${s.title} editing=${renaming} />
      <span class="pane-chip" title=${agent && agent.mission ? agent.mission : agentLabel(s, agentsById)}>
        <span class="chip-icon" aria-hidden="true"><${AgentIcon} agent=${agent || { name: agentLabel(s, agentsById) }} size=${12} /></span>${agentLabel(s, agentsById)}
      </span>
      ${s.model ? html`<span class="pane-model" title="Model">${s.model}</span>` : null}
      <${Trace} sid=${sid} status=${s.status} />
      <span class="pane-spacer"></span>
      ${conn === 'reconnecting' && !ended ? html`<span class="pane-conn" role="status">Reconnecting…</span>` : null}
      ${!solo && index < 9 ? html`<span class="pane-index" aria-hidden="true" title=${`Focus with ${MOD}${index + 1}`}>${MOD}${index + 1}</span>` : null}
      <div class="pane-actions">
        <button class="icon-btn" onClick=${() => copyAttach(s)} aria-label="Copy attach command" title=${`Copy: tmux -L clawdling attach -t ${s.tmux_name || ''}`} data-testid="pane-attach"><${Icon} name="terminal" /></button>
        <button class="icon-btn" onClick=${() => closePane(sid)} aria-label="Hide pane (keeps running)" title="Hide pane. The session keeps running." data-testid="pane-hide"><${Icon} name="pane-hide" /></button>
        ${mobile || solo ? null : html`<button class="icon-btn" onClick=${() => toggleMaximize(sid)} aria-label=${maximized ? 'Restore layout' : 'Maximize pane'} aria-pressed=${maximized ? 'true' : 'false'}
          title=${maximized ? 'Restore layout' : 'Maximize'} data-testid="pane-max"><${Icon} name=${maximized ? 'restore' : 'maximize'} /></button>`}
        ${ended ? html`<button class="icon-btn" onClick=${() => closePane(sid)} aria-label="Close pane" title="Close pane" data-testid="pane-end"><${Icon} name="x" /></button>`
          : html`<button class="icon-btn icon-danger" onClick=${() => askEndSession(sid)} aria-label="End session" title="End session…" data-testid="pane-end"><${Icon} name="x" /></button>`}
      </div>
    </header>
    ${s.status === 'needs_you' ? html`<button class="pane-alert" onClick=${() => { const v = terms.get(sid); if (v) v.focus(); }}>
      <${StatusGlyph} status="needs_you" label=${false} /><span class="alert-label">Needs you</span><span class="alert-text">${s.notification || 'Claude is waiting for your answer in the terminal.'}</span>
    </button>` : null}
    <div class="pane-body">
      <${TerminalView} sid=${sid} ended=${ended} onConn=${setConn} onStatus=${onStatus} onEnded=${onEnded} />
      ${ended ? html`<div class="pane-ended" role="group" aria-label="Session ended">
        <div class="ended-card">
          <p class="ended-title"><${StatusGlyph} status="ended" label=${false} /> Session ended ${relTime(sessionTime(s), now) === 'now' ? 'just now' : `${relTime(sessionTime(s), now)} ago`}</p>
          ${s.resumable === false ? html`<p class="ended-sub">This session can't be resumed.</p>`
            : html`<p class="ended-sub">Resume reopens the same conversation with <code>claude --resume</code>.</p>`}
          <div class="ended-actions">
            ${s.resumable === false ? null : html`<button class="btn btn-primary" onClick=${() => resumeSession(sid)} data-testid="pane-resume"><${Icon} name="play" /> Resume</button>`}
            <button class="btn btn-quiet" onClick=${() => closePane(sid)}>Close pane</button>
          </div>
        </div>
      </div>` : null}
    </div>
  </section>`;
}

function PaneTitle({ sid, name, title, editing }) {
  const [value, setValue] = useState(title || '');
  const input = useRef(null);
  const done = useRef(false);

  useEffect(() => {
    if (editing) {
      done.current = false;
      setValue(title || '');
      requestAnimationFrame(() => { if (input.current) { input.current.focus(); input.current.select(); } });
    }
  }, [editing]);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    setRenaming(null);
    renameSession(sid, value);
  };
  const cancel = () => {
    done.current = true;
    setRenaming(null);
    const v = terms.get(sid);
    if (v) v.focus();
  };

  if (editing) {
    return html`<input ref=${input} class="pane-title-input" value=${value} maxLength="120" aria-label="Session title"
      placeholder=${name} onInput=${(e) => setValue(e.currentTarget.value)} onBlur=${commit} onMouseDown=${(e) => e.stopPropagation()}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); const v = terms.get(sid); if (v) v.focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }} data-testid="pane-title-input" />`;
  }
  return html`<h3 class="pane-title" onDblClick=${() => setRenaming(sid)} title=${`${name} (double-click to rename)`} data-testid="pane-title">
    <span class="pane-title-text">${name}</span>
  </h3>`;
}

// Signature detail: a hairline trace of real terminal output over the last 40 s,
// so "working" and "actually producing output" are no longer the same claim.
function Trace({ sid, status }) {
  const line = useRef(null);
  const wrap = useRef(null);
  useEffect(() => onTraceTick(() => {
    const v = terms.get(sid);
    if (!v || !line.current) return;
    line.current.setAttribute('points', v.tracePoints(48, 14));
    if (wrap.current) {
      wrap.current.classList.toggle('is-active', v.recentlyActive());
      wrap.current.classList.toggle('is-idle', !v.anyActivity());
    }
  }), [sid]);
  return html`<span class="pane-trace is-idle" ref=${wrap} title="Terminal output, last 40 seconds" aria-hidden="true">
    <svg width="48" height="14" viewBox="0 0 48 14" focusable="false">
      <line x1="0" y1="13" x2="48" y2="13" class="trace-base" />
      <polyline ref=${line} points="0,13 48,13" class=${`trace-line st-${status}`} />
    </svg>
  </span>`;
}
