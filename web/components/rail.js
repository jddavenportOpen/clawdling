// The rail: home, new session/agent, search, then Needs you / Live / Recent /
// Agents. Every row shows the session's real name; clicking one FOCUSES it in
// the workspace (adds it if it is not open) and never replaces the open set.
import { html } from '../lib/html.js';
import { useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon, Mark, AgentIcon } from './icons.js';
import { StatusGlyph } from './status.js';
import {
  focusSession, resumeSession, startSession, toggleRail, goHome, openOverlay, openMenu,
  setQuery, navigate, togglePalette,
} from '../lib/actions.js';
import {
  groupSessions, sessionName, agentLabel, statusText, sessionTime, agentStats, sortAgents, KIND_LABEL,
} from '../lib/model.js';
import { relTime, matches, MOD, longTime } from '../lib/util.js';

const RECENT_LIMIT = 8;

function useRailData() {
  const sessions = useStore((s) => s.sessions);
  const agents = useStore((s) => s.agents);
  const agentsById = useStore((s) => s.agentsById);
  const open = useStore((s) => s.open);
  const focused = useStore((s) => s.focused);
  const now = useStore((s) => s.now);
  const list = useMemo(() => Object.values(sessions), [sessions]);
  const groups = useMemo(() => groupSessions(list, now), [list, now]);
  return { list, groups, agents, agentsById, open, focused, now };
}

export function Rail() {
  const rail = useStore((s) => s.rail);
  const mobile = useStore((s) => s.mobile);
  if (rail === 'collapsed' && !mobile) return html`<${Strip} />`;
  return html`<${ExpandedRail} />`;
}

function ExpandedRail() {
  const { list, groups, agents, agentsById, open, focused, now } = useRailData();
  const query = useStore((s) => s.query);
  const conn = useStore((s) => s.conn);
  const route = useStore((s) => s.route);
  const mobile = useStore((s) => s.mobile);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const searchRef = useRef(null);

  const liveCount = groups.needs.length + groups.live.length;
  const f = (s) => matches(query, sessionName(s, agentsById), agentLabel(s, agentsById), statusText(s), s.model, s.agent);
  const needs = groups.needs.filter(f);
  const live = groups.live.filter(f);
  const recentAll = groups.recent.filter(f);
  const recent = query || showAllRecent ? recentAll : recentAll.slice(0, RECENT_LIMIT);
  const sortedAgents = sortAgents(agents).filter((a) => matches(query, a.name, a.id, a.mission, KIND_LABEL[a.kind]));
  const searching = !!query.trim();
  const nothing = searching && !needs.length && !live.length && !recentAll.length && !sortedAgents.length;

  const row = (s, section) => html`<${SessionRow} key=${s.sid} s=${s} section=${section} agentsById=${agentsById}
    onScreen=${open.includes(s.sid)} focused=${focused === s.sid && open.includes(s.sid)} now=${now} />`;

  return html`<nav class="rail" aria-label="Sessions and agents" data-rail="expanded">
    <div class="rail-head">
      <button class=${`home-btn ${route.name === 'cockpit' ? 'is-here' : ''}`} onClick=${goHome}
        aria-label=${`Cockpit, ${liveCount} live`} data-testid="cockpit-home" title="Back to the cockpit with every open pane">
        <span class="home-mark"><${Mark} size=${18} /></span>
        <span class="home-label">Cockpit</span>
        <span class="count-pill" aria-hidden="true">${liveCount}<span class="count-unit"> live</span></span>
      </button>
      ${mobile ? null : html`<button class="icon-btn" onClick=${() => toggleRail('collapsed')} aria-label="Collapse sidebar"
        aria-expanded="true" title=${`Collapse sidebar (${MOD}\\)`} data-testid="rail-collapse"><${Icon} name="chevrons-left" /></button>`}
    </div>

    <div class="rail-actions">
      <button class="btn btn-primary btn-block" onClick=${() => openOverlay({ type: 'new-session' })} data-testid="new-session">
        <${Icon} name="plus" /> New session
      </button>
      <button class="btn btn-quiet btn-square" onClick=${() => openOverlay({ type: 'wizard' })} aria-label="New agent"
        title="New agent" data-testid="new-agent"><${Icon} name="user-plus" /></button>
    </div>

    <div class="rail-search">
      <${Icon} name="search" />
      <input ref=${searchRef} type="search" value=${query} placeholder="Filter" aria-label="Filter sessions and agents"
        onInput=${(e) => setQuery(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} data-testid="rail-search" />
      ${query ? html`<button class="icon-btn icon-btn-sm" aria-label="Clear filter" onClick=${() => { setQuery(''); searchRef.current && searchRef.current.focus(); }}><${Icon} name="x" size=${14} /></button>`
        : html`<button class="kbd-btn" onClick=${togglePalette} aria-label=${`Open command palette (${MOD}K)`} title="Command palette"><kbd>${MOD}</kbd><kbd>K</kbd></button>`}
    </div>

    <div class="rail-scroll">
      ${nothing ? html`<p class="rail-empty">Nothing matches “${query.trim()}”.</p>` : null}

      ${(!searching || needs.length) ? html`<section class="rail-sec sec-needs" aria-labelledby="sec-needs" data-section="needs">
        <h2 id="sec-needs" class="sec-title"><span>Needs you</span>${needs.length ? html`<span class="sec-count tone-amber">${needs.length}</span>` : null}</h2>
        ${needs.length ? html`<ul class="rows">${needs.map((s) => row(s, 'needs'))}</ul>`
          : html`<p class="sec-quiet">${liveCount ? 'Nothing is waiting on you.' : 'Sessions that need you show up here.'}</p>`}
      </section>` : null}

      ${(!searching || live.length) ? html`<section class="rail-sec" aria-labelledby="sec-live" data-section="live">
        <h2 id="sec-live" class="sec-title"><span>Live</span>${live.length ? html`<span class="sec-count">${live.length}</span>` : null}</h2>
        ${live.length ? html`<ul class="rows">${live.map((s) => row(s, 'live'))}</ul>`
          : html`<p class="sec-quiet">No agent is working right now.</p>`}
      </section>` : null}

      ${recentAll.length ? html`<section class="rail-sec" aria-labelledby="sec-recent" data-section="recent">
        <h2 id="sec-recent" class="sec-title"><span>Recent</span><span class="sec-count">${recentAll.length}</span></h2>
        <ul class="rows">${recent.map((s) => row(s, 'recent'))}</ul>
        ${!searching && recentAll.length > RECENT_LIMIT ? html`<button class="link-btn sec-more" onClick=${() => setShowAllRecent(!showAllRecent)}>
          ${showAllRecent ? 'Show fewer' : `Show all ${recentAll.length}`}</button>` : null}
      </section>` : null}

      ${sortedAgents.length ? html`<section class="rail-sec" aria-labelledby="sec-agents" data-section="agents">
        <h2 id="sec-agents" class="sec-title"><span>Agents</span><span class="sec-count">${sortedAgents.length}</span></h2>
        <ul class="rows">${sortedAgents.map((a) => html`<${AgentRow} key=${a.id} a=${a} stats=${agentStats(a.id, list)} />`)}</ul>
      </section>` : null}
    </div>

    <div class="rail-foot">
      <a class=${`foot-link ${route.name === 'map' ? 'is-here' : ''}`} href="#/map" aria-current=${route.name === 'map' ? 'page' : undefined}><${Icon} name="map" /> Org map</a>
      <a class=${`foot-link ${route.name === 'donna' ? 'is-here' : ''}`} href="#/donna" aria-current=${route.name === 'donna' ? 'page' : undefined}><${Icon} name="chat" /> Donna</a>
      <a class=${`foot-link ${route.name === 'settings' ? 'is-here' : ''}`} href="#/settings" aria-label="Settings" title="Settings" aria-current=${route.name === 'settings' ? 'page' : undefined}><${Icon} name="sliders" /></a>
      <span class=${`conn conn-${conn}`} role="status" title=${conn === 'live' ? 'Live updates connected' : 'Reconnecting to the server'}>
        <span class="conn-dot" aria-hidden="true"></span>${conn === 'live' ? 'Live' : 'Reconnecting'}
      </span>
    </div>
  </nav>`;
}

function SessionRow({ s, section, agentsById, onScreen, focused, now }) {
  const name = sessionName(s, agentsById);
  const agent = agentLabel(s, agentsById);
  const ended = s.status === 'ended';
  const canResume = ended && s.resumable !== false;
  const meta = ended ? (canResume ? 'Ended · click to resume' : 'Ended') : statusText(s);
  const when = relTime(sessionTime(s), now);
  const click = () => (canResume ? resumeSession(s.sid) : focusSession(s.sid));
  const more = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu({ type: 'session', sid: s.sid, x: r.right, y: r.bottom });
  };
  return html`<li class=${`row-wrap ${onScreen ? 'on-screen' : ''} ${focused ? 'is-focused' : ''}`} data-sid=${s.sid} data-section=${section}
      data-status=${s.status} data-onscreen=${onScreen ? 'true' : 'false'} data-focused=${focused ? 'true' : 'false'}>
    <button class="row" onClick=${click} aria-current=${focused ? 'true' : undefined}
      title=${`${name}\n${agent} · ${ended ? 'Ended' : statusText(s)} · ${longTime(sessionTime(s))}`}
      aria-label=${`${name}, ${agent}, ${ended ? (canResume ? 'ended, resume' : 'ended') : statusText(s)}${onScreen ? ', on screen' : ''}`}>
      <span class="row-glyph"><${StatusGlyph} status=${s.status} label=${false} /></span>
      <span class="row-main">
        <span class="row-title" data-testid="row-title">${name}</span>
        <span class=${`row-meta st-text-${s.status}`}><span class="row-agent">${agent}</span><span class="row-dot" aria-hidden="true">·</span><span class="row-status">${meta}</span></span>
      </span>
      <span class="row-side">
        <time class="row-time">${when}</time>
        ${onScreen ? html`<span class="on-screen-mark" title="On screen" aria-hidden="true"><${Icon} name="layout-split" size=${12} /></span>` : null}
      </span>
    </button>
    <button class="row-more" onClick=${more} aria-label=${`More actions for ${name}`} aria-haspopup="menu" title="More"><${Icon} name="more" size=${14} /></button>
  </li>`;
}

function AgentRow({ a, stats }) {
  const start = () => startSession(a.id).catch(() => {});
  return html`<li class="row-wrap agent-row" data-agent=${a.id}>
    <button class="row" onClick=${start} aria-label=${`New session with ${a.name}${stats.live ? `, ${stats.live} live` : ''}`}
      title=${`${a.name}: start a new session${a.mission ? `\n${a.mission}` : ''}`}>
      <span class="row-icon" style=${a.color ? { '--agent': a.color } : undefined}><${AgentIcon} agent=${a} size=${14} /></span>
      <span class="row-main">
        <span class="row-title">${a.name}</span>
        <span class="row-meta"><span class="row-status">${KIND_LABEL[a.kind] || a.kind}</span></span>
      </span>
      <span class="row-side">
        ${stats.needs ? html`<span class="badge tone-amber" title=${`${stats.needs} need you`}>${stats.live}</span>`
          : stats.live ? html`<span class="badge" title=${`${stats.live} live`}>${stats.live}</span>` : null}
        <span class="row-plus" aria-hidden="true"><${Icon} name="plus" size=${14} /></span>
      </span>
    </button>
    <button class="row-more" onClick=${() => navigate(`#/agent/${encodeURIComponent(a.id)}`)} aria-label=${`Open ${a.name}'s page`} title="Open agent page">
      <${Icon} name="chevron-right" size=${14} />
    </button>
  </li>`;
}

// ---------- collapsed strip (56px, still useful) ----------
function Strip() {
  const { groups, agentsById, open, focused } = useRailData();
  const route = useStore((s) => s.route);
  const [tip, setTip] = useState(null);
  const live = [...groups.needs, ...groups.live];

  const showTip = (e, text) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ text, top: r.top + r.height / 2 });
  };
  const hide = () => setTip(null);
  const tipProps = (text) => ({
    onMouseEnter: (e) => showTip(e, text), onMouseLeave: hide,
    onFocus: (e) => showTip(e, text), onBlur: hide,
  });

  return html`<nav class="strip" aria-label="Sidebar (collapsed)" data-rail="collapsed">
    <button class="strip-btn" onClick=${() => { hide(); toggleRail('expanded'); }} aria-label="Expand sidebar" aria-expanded="false"
      data-testid="rail-expand" ...${tipProps(`Expand sidebar (${MOD}\\)`)}><${Icon} name="chevrons-right" /></button>
    <button class=${`strip-btn ${route.name === 'cockpit' ? 'is-here' : ''}`} onClick=${goHome} aria-label="Cockpit"
      data-testid="cockpit-home" ...${tipProps('Cockpit')}><${Icon} name="home" /></button>
    <button class="strip-btn" onClick=${() => openOverlay({ type: 'new-session' })} aria-label="New session"
      data-testid="new-session" ...${tipProps('New session')}><${Icon} name="plus" /></button>
    <button class="strip-btn" onClick=${togglePalette} aria-label=${`Search and jump (${MOD}K)`}
      ...${tipProps(`Search and jump (${MOD}K)`)}><${Icon} name="search" /></button>
    <div class="strip-sep" role="separator"></div>
    <ul class="strip-sessions" aria-label="Live sessions">
      ${live.map((s) => {
        const name = sessionName(s, agentsById);
        const agent = agentLabel(s, agentsById);
        const isOpen = open.includes(s.sid);
        const isFocused = isOpen && focused === s.sid;
        return html`<li key=${s.sid}>
          <button class=${`strip-dot st-${s.status} ${isOpen ? 'on-screen' : ''} ${isFocused ? 'is-focused' : ''}`} data-sid=${s.sid}
            data-status=${s.status} aria-current=${isFocused ? 'true' : undefined}
            aria-label=${`${name} (${agent}, ${statusText(s)})`} onClick=${() => focusSession(s.sid)} ...${tipProps(`${name} · ${statusText(s)}`)}>
            <span class="dot-initial" aria-hidden="true">${agent.charAt(0).toUpperCase()}</span>
            <span class="dot-status" aria-hidden="true"><${StatusGlyph} status=${s.status} size=${10} label=${false} /></span>
          </button>
        </li>`;
      })}
    </ul>
    <div class="strip-foot">
      <a class=${`strip-btn ${route.name === 'map' ? 'is-here' : ''}`} href="#/map" aria-label="Org map" ...${tipProps('Org map')}><${Icon} name="map" /></a>
      <a class=${`strip-btn ${route.name === 'donna' ? 'is-here' : ''}`} href="#/donna" aria-label="Donna" ...${tipProps('Donna')}><${Icon} name="chat" /></a>
      <a class=${`strip-btn ${route.name === 'settings' ? 'is-here' : ''}`} href="#/settings" aria-label="Settings" ...${tipProps('Settings')}><${Icon} name="sliders" /></a>
    </div>
    ${tip ? html`<div class="strip-tip" role="tooltip" style=${{ top: `${tip.top}px` }}>${tip.text}</div>` : null}
  </nav>`;
}
