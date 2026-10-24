// ⌘K / Ctrl+K: jump to any session or agent, start a session for any agent,
// create an agent, or go anywhere. Keyboard-first: type, ↑↓, Enter.
import { html } from '../lib/html.js';
import { useMemo, useRef, useState, useEffect } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Modal } from './dialogs.js';
import { Icon, AgentIcon } from './icons.js';
import { StatusGlyph } from './status.js';
import {
  closeOverlay, focusSession, resumeSession, startSession, navigate, openOverlay, toggleRail, setLayout, goHome,
} from '../lib/actions.js';
import { sessionName, agentLabel, statusText, groupSessions, sortAgents, KIND_LABEL } from '../lib/model.js';
import { score, relTime } from '../lib/util.js';

export function Palette() {
  const sessions = useStore((s) => s.sessions);
  const agents = useStore((s) => s.agents);
  const agentsById = useStore((s) => s.agentsById);
  const open = useStore((s) => s.open);
  const now = useStore((s) => s.now);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef(null);

  const items = useMemo(() => {
    const g = groupSessions(Object.values(sessions), now);
    const run = (fn) => () => { closeOverlay(); fn(); };
    const out = [];
    const ordered = [...g.needs, ...g.live, ...g.recent];
    for (const s of ordered) {
      const name = sessionName(s, agentsById);
      const ended = s.status === 'ended';
      out.push({
        id: `s:${s.sid}`, group: 'Sessions', label: name,
        hint: `${agentLabel(s, agentsById)} · ${ended ? 'Ended' : statusText(s)}${open.includes(s.sid) ? ' · on screen' : ''}`,
        extra: `${agentLabel(s, agentsById)} ${s.agent} ${s.model || ''} ${ended ? 'ended recent resume' : 'live'}`,
        glyph: s.status, right: ended ? 'Resume' : relTime(s.last_activity_at || s.created_at, now),
        run: run(() => (ended && s.resumable !== false ? resumeSession(s.sid) : focusSession(s.sid))),
        sid: s.sid,
      });
    }
    for (const a of sortAgents(agents)) {
      out.push({
        id: `n:${a.id}`, group: 'New session', label: `New session with ${a.name}`, agent: a,
        hint: a.mission || KIND_LABEL[a.kind], extra: `${a.id} start spawn new session ${KIND_LABEL[a.kind]}`,
        right: 'Start', run: run(() => startSession(a.id).catch(() => {})),
      });
    }
    for (const a of sortAgents(agents)) {
      out.push({
        id: `a:${a.id}`, group: 'Agents', label: a.name, agent: a, hint: `${KIND_LABEL[a.kind] || a.kind} · context, memory, sessions`,
        extra: `${a.id} agent page memory context claude.md now.md ${a.mission || ''}`, right: 'Open',
        run: run(() => navigate(`#/agent/${encodeURIComponent(a.id)}`)),
      });
    }
    const go = [
      ['Go to Cockpit', 'home', () => goHome(), 'home workspace panes'],
      ['Go to Org map', 'map', () => navigate('#/map'), 'map org graph'],
      ['Go to Donna', 'chat', () => navigate('#/donna'), 'telegram imessage channels chief'],
      ['Go to Settings', 'sliders', () => navigate('#/settings'), 'preferences theme'],
      ['New session…', 'plus', () => openOverlay({ type: 'new-session' }), 'start spawn'],
      ['New agent…', 'user-plus', () => openOverlay({ type: 'wizard' }), 'create domain project wizard'],
      ['Bring in your projects…', 'import', () => openOverlay({ type: 'import' }), 'import repo repos github clone find discover folders new agent project'],
      ['Your Claude Code setup', 'layers', () => navigate('#/settings/setup'), 'skills subagents mcp hooks plugins commands settings'],
      ['New scratch session', 'terminal', () => startSession('scratch').catch(() => {}), 'plain claude no agent'],
      ['Toggle sidebar', 'chevrons-left', () => toggleRail(), 'rail collapse expand'],
      ['Layout: Focus', 'layout-focus', () => setLayout('focus'), 'view'],
      ['Layout: Split', 'layout-split', () => setLayout('split'), 'view'],
      ['Layout: Grid', 'layout-grid', () => setLayout('grid'), 'view'],
    ];
    for (const [label, icon, fn, extra] of go) {
      const isNew = label.endsWith('…');
      out.push({ id: `g:${label}`, group: 'Go to', label, icon, extra, run: isNew ? () => fn() : run(fn) });
    }
    return out;
  }, [sessions, agents, agentsById, open, now]);

  const results = useMemo(() => {
    const query = q.trim();
    if (!query) {
      // No query: sessions first (needs-you on top), then a few starters and the go-to list.
      const sess = items.filter((i) => i.group === 'Sessions').slice(0, 8);
      const starts = items.filter((i) => i.group === 'New session').slice(0, 4);
      const go = items.filter((i) => i.group === 'Go to');
      return [...sess, ...starts, ...go];
    }
    return items
      .map((i) => ({ i, sc: score(query, i.label, `${i.hint || ''} ${i.extra || ''}`) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 40)
      .map((x) => x.i);
  }, [items, q]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    const el = listRef.current && listRef.current.querySelector('[aria-selected="true"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [sel, results]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(results.length - 1, x + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = results[sel]; if (it) it.run(); }
  };

  // Group headers in result order.
  let lastGroup = null;
  return html`<${Modal} label="Command palette" onClose=${closeOverlay} size="lg" class="palette" align="top">
    <div class="pal-input-row">
      <${Icon} name="search" />
      <input class="pal-input" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} onKeyDown=${onKey} data-autofocus
        placeholder="Jump to a session or agent, or type a command" aria-label="Search sessions, agents and commands"
        role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant=${results[sel] ? `pal-${sel}` : undefined}
        data-testid="palette-input" />
      <kbd class="pal-esc">esc</kbd>
    </div>
    <ul id="pal-list" class="pal-list" role="listbox" ref=${listRef} aria-label="Results">
      ${results.length === 0 ? html`<li class="pal-empty">Nothing matches “${q.trim()}”.</li>` : null}
      ${results.map((it, idx) => {
        const header = it.group !== lastGroup ? it.group : null;
        lastGroup = it.group;
        return html`${header ? html`<li class="pal-group" role="presentation">${header}</li>` : null}
          <li id=${`pal-${idx}`} role="option" aria-selected=${idx === sel ? 'true' : 'false'} class=${`pal-item ${idx === sel ? 'is-sel' : ''}`}
            onMouseMove=${() => setSel(idx)} onClick=${() => it.run()} data-sid=${it.sid}>
            <span class="pal-lead">${it.glyph ? html`<${StatusGlyph} status=${it.glyph} label=${false} />`
              : it.agent ? html`<${AgentIcon} agent=${it.agent} size=${14} />` : html`<${Icon} name=${it.icon || 'chevron-right'} size=${14} />`}</span>
            <span class="pal-text"><span class="pal-label">${it.label}</span>${it.hint ? html`<span class="pal-hint">${it.hint}</span>` : null}</span>
            ${it.right ? html`<span class="pal-right">${it.right}</span>` : null}
          </li>`;
      })}
    </ul>
    <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
  </${Modal}>`;
}
