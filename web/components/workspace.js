// The workspace: an ordered open set of panes in Focus / Split / Grid.
// Panes keep a stable DOM order (the open-set order); layouts only change CSS,
// so switching layout or focus never tears down a terminal.
import { html } from '../lib/html.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon, AgentIcon } from './icons.js';
import { StatusGlyph } from './status.js';
import { Pane } from './pane.js';
import { setLayout, focusSession, startSession, togglePalette, openOverlay } from '../lib/actions.js';
import { sessionName, groupSessions, sortAgents, KIND_LABEL, agentStats, statusText, agentLabel } from '../lib/model.js';
import { MOD, plural } from '../lib/util.js';
import { setState } from '../lib/store.js';

// Pick a grid that keeps terminals wide enough for Claude Code's UI.
export function gridShape(n, W, H) {
  if (n <= 1 || !W || !H) return { cols: 1, rows: 1 };
  let best = null;
  for (let cols = 1; cols <= Math.min(n, 4); cols += 1) {
    const rows = Math.ceil(n / cols);
    const w = W / cols;
    const h = H / rows;
    const ratio = w / h;
    const s = Math.min(w / 600, 1) * 1.2 + Math.min(h / 300, 1) - Math.abs(Math.log(ratio / 1.4)) * 0.35;
    if (!best || s > best.s) best = { cols, rows, s };
  }
  return { cols: best.cols, rows: best.rows };
}

const LAYOUT_OPTS = [
  { id: 'focus', label: 'Focus', icon: 'layout-focus', hint: 'One big pane, the rest as tabs' },
  { id: 'split', label: 'Split', icon: 'layout-split', hint: 'Two panes side by side' },
  { id: 'grid', label: 'Grid', icon: 'layout-grid', hint: 'Every open pane at once' },
];

export function Workspace({ hidden }) {
  const open = useStore((s) => s.open);
  const focused = useStore((s) => s.focused);
  const layout0 = useStore((s) => s.layout);
  const splitPair = useStore((s) => s.splitPair);
  const mobile = useStore((s) => s.mobile);
  const sessions = useStore((s) => s.sessions);
  const sessionsLoaded = useStore((s) => s.sessionsLoaded);
  const panesRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const node = panesRef.current;
    if (!node) return undefined;
    const ro = new ResizeObserver(() => setBox({ w: node.clientWidth, h: node.clientHeight }));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const layout = mobile ? 'focus' : (open.length <= 1 ? 'focus' : layout0);
  const focusedSid = open.includes(focused) ? focused : open[open.length - 1];

  let visible;
  if (layout === 'focus') visible = focusedSid ? [focusedSid] : [];
  else if (layout === 'split') {
    const pair = (splitPair || []).filter((x) => open.includes(x));
    visible = pair.length === 2 ? pair : [...new Set([focusedSid, ...pair, ...[...open].reverse()])].filter(Boolean).slice(0, 2);
  } else visible = open;

  const shape = layout === 'grid' ? gridShape(open.length, box.w, box.h) : { cols: layout === 'split' ? 2 : 1, rows: 1 };
  const empty = shape.cols * shape.rows - open.length;
  const firstSpan = layout === 'grid' && empty > 0 && shape.rows > 1 ? Math.min(shape.rows, empty + 1) : 1;

  const panesStyle = { '--cols': String(shape.cols), '--rows': String(shape.rows) };
  const needsCount = useMemo(() => Object.values(sessions).filter((s) => s.status === 'needs_you' || s.status === 'ready').length, [sessions]);

  return html`<main class=${`workspace ${hidden ? 'is-under' : ''}`} inert=${hidden ? true : undefined} aria-hidden=${hidden ? 'true' : undefined}
      aria-label="Workspace" data-layout=${layout} data-open-count=${open.length}>
    <header class="ws-bar">
      ${mobile ? html`<button class="icon-btn" aria-label="All sessions" onClick=${() => setState({ mobileView: 'list' })}><${Icon} name="arrow-left" /></button>` : null}
      <h1 class="ws-title">Cockpit</h1>
      <span class="ws-sub" aria-live="polite">${open.length ? `${plural(open.length, 'pane')} open` : 'No panes open'}${needsCount ? html` · <span class="tone-amber-text">${needsCount} waiting on you</span>` : null}</span>
      <span class="ws-spacer"></span>
      ${mobile ? null : html`<div class="seg" role="radiogroup" aria-label="Layout">
        ${LAYOUT_OPTS.map((o) => html`<button role="radio" aria-checked=${layout0 === o.id ? 'true' : 'false'} class=${`seg-btn ${layout0 === o.id ? 'is-on' : ''}`}
          onClick=${() => setLayout(o.id)} title=${o.hint} data-layout-btn=${o.id}><${Icon} name=${o.icon} /><span class="seg-label">${o.label}</span></button>`)}
      </div>`}
      <button class="btn btn-quiet jump-btn" onClick=${togglePalette} aria-label=${`Jump to a session or agent (${MOD}K)`}>
        <${Icon} name="search" /><span class="jump-label">Jump to…</span><span class="kbd-pair"><kbd>${MOD}</kbd><kbd>K</kbd></span>
      </button>
    </header>

    ${(layout === 'focus' || layout === 'split') && open.length > 1 ? html`<${TabStrip} open=${open} visible=${visible} focused=${focusedSid} />` : null}

    <div class="panes" ref=${panesRef} data-layout=${layout} style=${panesStyle}>
      ${open.map((sid, i) => {
        const vis = visible.includes(sid);
        const order = layout === 'split' ? visible.indexOf(sid) : i;
        return html`<${Pane} key=${sid} sid=${sid} index=${i} hidden=${!vis} order=${order < 0 ? 99 : order}
          span=${i === 0 ? firstSpan : 1} layout=${layout} solo=${open.length <= 1} />`;
      })}
      ${open.length === 0 && sessionsLoaded ? html`<${EmptyState} />` : null}
    </div>
  </main>`;
}

function TabStrip({ open, visible, focused }) {
  const sessions = useStore((s) => s.sessions);
  const agentsById = useStore((s) => s.agentsById);
  return html`<div class="tabstrip" role="tablist" aria-label="Open sessions">
    ${open.map((sid, i) => {
      const s = sessions[sid];
      if (!s) return null;
      const on = visible.includes(sid);
      return html`<button key=${sid} role="tab" aria-selected=${focused === sid ? 'true' : 'false'}
        class=${`tab ${on ? 'is-visible' : ''} ${focused === sid ? 'is-focused' : ''}`} data-tab=${sid}
        onClick=${() => focusSession(sid)} title=${`${sessionName(s, agentsById)} · ${statusText(s)}`}>
        <${StatusGlyph} status=${s.status} label=${false} /><span class="tab-label">${sessionName(s, agentsById)}</span>${i < 9 ? html`<span class="tab-key" aria-hidden="true">${i + 1}</span>` : null}
      </button>`;
    })}
  </div>`;
}

function EmptyState() {
  const agents = useStore((s) => s.agents);
  const sessions = useStore((s) => s.sessions);
  const agentsById = useStore((s) => s.agentsById);
  const now = useStore((s) => s.now);
  const list = useMemo(() => Object.values(sessions), [sessions]);
  const g = useMemo(() => groupSessions(list, now), [list, now]);
  const waiting = [...g.needs, ...g.live];
  const first = list.length === 0;

  return html`<div class="empty" data-testid="empty-state">
    <div class="empty-inner">
      <h2 class="empty-title">${first ? 'Start your first session' : 'Pick an agent to start a session'}</h2>
      <p class="empty-sub">${first
        ? 'Every agent is the real claude CLI, opened in its own folder with its own CLAUDE.md and memory. Pick one.'
        : 'Open panes come back when you reload. Live sessions keep running in tmux even with no pane open.'}</p>
      ${waiting.length ? html`<div class="empty-block">
        <h3 class="empty-h">Running now</h3>
        <ul class="empty-live">
          ${waiting.slice(0, 6).map((s) => html`<li key=${s.sid}><button class="empty-live-row" onClick=${() => focusSession(s.sid)}>
            <${StatusGlyph} status=${s.status} label=${false} /><span class="elr-title">${sessionName(s, agentsById)}</span>
            <span class="elr-meta">${agentLabel(s, agentsById)} · ${statusText(s)}</span></button></li>`)}
        </ul>
      </div>` : null}
      <div class="empty-block">
        <h3 class="empty-h">Start a session with</h3>
        <ul class="agent-cards">
          ${sortAgents(agents).map((a) => {
            const st = agentStats(a.id, list);
            return html`<li key=${a.id}><button class="agent-card" onClick=${() => startSession(a.id).catch(() => {})} data-agent-card=${a.id}>
              <span class="ac-icon" style=${a.color ? { '--agent': a.color } : undefined}><${AgentIcon} agent=${a} size=${16} /></span>
              <span class="ac-text"><span class="ac-name">${a.name}</span><span class="ac-kind">${KIND_LABEL[a.kind] || a.kind}${st.live ? ` · ${st.live} live` : ''}</span>
              ${a.mission ? html`<span class="ac-mission">${a.mission}</span>` : null}</span>
            </button></li>`;
          })}
          <li><button class="agent-card agent-card-new" onClick=${() => openOverlay({ type: 'wizard' })}>
            <span class="ac-icon"><${Icon} name="user-plus" /></span>
            <span class="ac-text"><span class="ac-name">New agent</span><span class="ac-kind">A domain or a project</span></span>
          </button></li>
        </ul>
      </div>
    </div>
  </div>`;
}
