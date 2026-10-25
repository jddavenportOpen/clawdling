// "Watching · N": a session whose turn is over but whose background work (watchers, background
// commands, agents, workflows) is still running. The pill opens a list: kind, what it is for, age.
import { html } from '../lib/html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { TASK_KIND_LABEL, isWatching } from '../lib/model.js';
import { relTime } from '../lib/util.js';
import { StatusGlyph } from './status.js';

export function WatchingPill({ s, now = Date.now() }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const onFocus = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); document.removeEventListener('focusin', onFocus, true); };
  }, [open]);
  const watching = isWatching(s);
  useEffect(() => { if (!watching) setOpen(false); }, [watching]); // closed again when it stops
  if (!watching) return null;
  const { count, tasks = [] } = s.background;
  const label = `Watching · ${count}`;
  return html`<span class="watch-wrap" ref=${wrap}>
    <button type="button" class="watch-pill" aria-expanded=${open ? 'true' : 'false'} aria-controls=${`watch-${s.sid}`} data-testid="watching-pill"
      title="Claude's turn is over, but background work it started is still running"
      onClick=${(e) => { e.stopPropagation(); setOpen(!open); }}>
      <${StatusGlyph} status="watching" size=${11} label=${false} /><span>${label}</span>
    </button>
    ${open ? html`<div class="watch-pop" id=${`watch-${s.sid}`} role="region" aria-label="Background work" data-testid="watching-pop">
      <p class="watch-head">Still running in this session. Claude picks it up when each one reports.</p>
      <ul class="watch-list">
        ${tasks.map((t) => html`<li key=${t.id} class="watch-item" data-kind=${t.kind} data-testid="watching-task">
          <span class="watch-kind">${TASK_KIND_LABEL[t.kind] || 'Task'}</span>
          <span class="watch-desc">${t.description || TASK_KIND_LABEL[t.kind] || 'Background task'}</span>
          <span class="watch-age">${t.started_at ? `started ${relTime(t.started_at, now) === 'now' ? 'just now' : `${relTime(t.started_at, now)} ago`}` : ''}${t.expires_at ? ` · ends by itself ${new Date(t.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
        </li>`)}
        ${count > tasks.length ? html`<li class="watch-item watch-more">and ${count - tasks.length} more</li>` : null}
      </ul>
    </div>` : null}
  </span>`;
}
