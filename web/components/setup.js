// "Your Claude Code setup": what every agent session inherits, because Claude Code loads it in
// every session (skills, subagents, commands, plugins, hooks, MCP servers, the global CLAUDE.md).
// GET /api/setup returns names and descriptions only: never an MCP key, an environment value or a
// hook command. Shown as a card in Settings and as a layer on the org map.
import { html } from '../lib/html.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { api } from '../lib/api.js';
import { refreshOrg } from '../lib/live.js';
import { navigate, toast, openOverlay } from '../lib/actions.js';
import { tildify, plural } from '../lib/util.js';
import { Icon, AgentIcon } from './icons.js';
import { SafetySection } from './safety.js';

const LIMIT = 6; // long lists show this many, then "Show all N"

export const PRIVACY_NOTE = 'Names and descriptions only. Clawdling never reads MCP keys or environment values or hook commands, and nothing here leaves your computer.';

// One entry per list in the setup, in the order people think of them.
export const KINDS = [
  { id: 'skills', title: 'Skills', chip: 'Skills', one: 'skill' },
  { id: 'agents', title: 'Subagents', chip: 'Subagents', one: 'subagent' },
  { id: 'commands', title: 'Commands', chip: 'Commands', one: 'command' },
  { id: 'plugins', title: 'Plugins', chip: 'Plugins', one: 'plugin' },
  { id: 'hooks', title: 'Hooks', chip: 'Hooks', one: 'hook' },
  { id: 'mcp', title: 'MCP servers', chip: 'MCP', one: 'MCP server' },
];
export const kindOf = (id) => KINDS.find((k) => k.id === id) || { id, title: id, chip: id, one: id };

// When each hook event fires, in plain words (the event names are Claude Code's own).
const HOOK_WHEN = {
  PreToolUse: 'before Claude uses a tool', PostToolUse: 'after Claude uses a tool', UserPromptSubmit: 'when you send a message',
  Stop: 'when Claude finishes a turn', SubagentStop: 'when a subagent finishes', SessionStart: 'when a session starts',
  SessionEnd: 'when a session ends', Notification: 'when Claude Code notifies you', PreCompact: 'before a long chat is compacted',
};
const MCP_SCOPE = { user: 'in every project', local: 'one folder, this computer only', project: 'shared in the repo' };

const list = (x) => (Array.isArray(x) ? x : []);
// The id the server gives an agent with this name (server/util.js slugify).
export const slugId = (name) => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
const RESERVED_IDS = new Set(['donna', 'scratch']); // server/org.js: never an agent you make

// How many a list holds. Hooks count every hook, not every event (one event can run several), so the
// map chip, the Settings card and the panel say the same number: "Hooks 4" over "PreToolUse (2)",
// "Stop (1)" and "SessionStart (1)".
export const hookCount = (h) => Number(h && h.count) || 1;
export const countOf = (kind, items) => (kind === 'hooks' ? list(items).reduce((n, h) => n + hookCount(h), 0) : list(items).length);

// What a repo adds on top of the person's own setup: anything Claude Code loads there.
export function repoAdds(p) {
  if (!p) return false;
  return !!(p.claude_md || p.agents_md || ['skills', 'agents', 'commands', 'hooks', 'mcp'].some((k) => list(p[k]).length));
}

// ---- data: one read per screen, shared by Settings and the map
// The setup's per-project part follows the org's project agents and their repos, so a project
// imported, re-linked or archived while a screen is open means a fresh read. This key is that set.
export function projectsKey(agents) {
  return list(agents).filter((a) => a && a.kind === 'project')
    .map((a) => [a.id, a.repo || '', ...list(a.repos)].join('\t')).sort().join('\n');
}
let cache = null;
let inflight = null; // {key, promise}: callers asking for the same key share one request
let latest = 0;
export function loadSetup(key = '') {
  if (inflight && inflight.key === key) return inflight.promise;
  const my = ++latest;
  const promise = api.setup().then((r) => {
    const d = r && typeof r === 'object' ? r : {};
    if (my === latest) cache = d; // an older read that lands late never replaces a newer one
    return d;
  }).finally(() => { if (inflight && inflight.promise === promise) inflight = null; });
  inflight = { key, promise };
  return promise;
}
export function useSetup(enabled = true) {
  const agents = useStore((s) => s.agents);
  const projects = useMemo(() => projectsKey(agents), [agents]);
  const [state, setS] = useState(() => ({ data: cache, err: '', loading: !cache, refreshing: false }));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setS((s) => ({ ...s, loading: !s.data, refreshing: true }));
    loadSetup(`${tick}\n${projects}`).then((d) => { if (live) setS({ data: d, err: '', loading: false, refreshing: false }); })
      .catch((e) => { if (live) setS((s) => ({ data: s.data, err: e && e.status === 404 ? 'unsupported' : (e && e.message) || 'unknown error', loading: false, refreshing: false })); });
    return () => { live = false; };
  }, [enabled, tick, projects]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

// ---- pieces
function ItemText({ kind, item }) {
  if (kind === 'hooks') {
    const when = HOOK_WHEN[item.event];
    return html`<span class="setup-name mono">${item.event} (${hookCount(item)})</span><span class="setup-desc">${when ? `Runs ${when}` : 'Runs on this event'}</span>`;
  }
  if (kind === 'mcp') return html`<span class="setup-name mono">${item.name}</span><span class="setup-desc">${MCP_SCOPE[item.scope] || item.scope || ''}</span>`;
  if (kind === 'plugins') {
    return html`<span class="setup-name mono">${item.name}</span><span class="setup-desc">${item.marketplace ? `from ${item.marketplace}` : ''}${item.enabled === false ? html` <span class="card-tag">Off</span>` : ''}</span>`;
  }
  return html`<span class="setup-name mono">${kind === 'commands' ? `/${item.name}` : item.name}</span>${item.description ? html`<span class="setup-desc">${item.description}</span>` : null}`;
}

// The standing agent made from this subagent. The server records which subagent (and scope) it
// copied in the agent's `source`; an agent that only shares the name (the built-in Health domain
// next to a subagent called "health") is not it.
export const madeFrom = (agents, sub, scope = 'user') => list(agents).find((a) => a && a.source && a.source.subagent === sub.name
  && (a.source.subagent_scope || 'user') === scope) || null;

// A Claude Code subagent helps inside one session; a standing agent has its own memory, sessions
// and place on the org map. The server copies the subagent's instructions (found by name, never by
// a path from here) into a new domain agent; the subagent itself does not change. When the name's
// id is taken by another agent, "Use another name" sends `as` (the new agent's name; its id is
// that name's slug).
export function PromoteButton({ sub, scope = 'user', repo }) {
  const agents = useStore((s) => s.agents);
  const agentsById = useStore((s) => s.agentsById);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);
  const [err, setErr] = useState('');
  const [clash, setClash] = useState(false); // the server said the id is taken (409)
  const [renaming, setRenaming] = useState(false);
  const [as, setAs] = useState('');
  const field = useRef(null);
  useEffect(() => { if (renaming && field.current) field.current.focus(); }, [renaming]);
  const openAgent = (id) => navigate(`#/agent/${encodeURIComponent(id)}`);
  const from = madeFrom(agents, sub, scope) || (made ? agentsById[made.id] || made : null);
  if (from) {
    return html`<span class="setup-made" data-testid="setup-made"><${Icon} name="check" size=${12} /> Standing agent: <button class="link-btn"
      onClick=${() => openAgent(from.id)}>${from.name}</button></span>`;
  }
  const id = slugId(sub.name);
  const holder = agentsById[id];
  const taken = clash || !!holder || RESERVED_IDS.has(id);
  const promote = async (name) => {
    setBusy(true);
    setErr('');
    try {
      const a = await api.promoteSubagent({ scope, ...(repo ? { repo } : {}), name: sub.name, ...(name ? { as: name } : {}) });
      await refreshOrg();
      setMade(a);
      setRenaming(false);
      toast(`${a.name} is now a standing agent, with its own memory and sessions.`, { tone: 'ok', ms: 7000, action: { label: 'Open', run: () => openAgent(a.id) } });
    } catch (e) {
      if (e && e.status === 409) {
        if (name) setErr(`An agent called "${name}" already exists. Try another name.`);
        else setClash(true);
      } else setErr((e && e.message) || 'Could not make the agent.');
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const name = as.trim().replace(/\s+/g, ' ');
    const sid = slugId(name);
    if (!name) { setErr('Give the standing agent a name.'); return; }
    if (!sid) { setErr('Use at least one letter or number in the name.'); return; }
    if (agentsById[sid] || RESERVED_IDS.has(sid)) { setErr(`An agent called "${(agentsById[sid] || {}).name || name}" already exists. Try another name.`); return; }
    promote(name);
  };
  const cancel = () => { setRenaming(false); setAs(''); setErr(''); };
  if (taken) {
    return html`<span class="setup-promote" data-testid="setup-taken">
      <span class="setup-taken">An agent called <strong>${holder ? holder.name : sub.name}</strong> already exists.${renaming ? ' Give the new agent another name; the subagent keeps its own.' : ''}</span>
      ${renaming ? html`<form class="inline-form setup-as" onSubmit=${(e) => { e.preventDefault(); submit(); }}>
          <input ref=${field} type="text" value=${as} maxLength="60" placeholder="Another name" autocomplete="off" data-own-escape
            aria-label=${`Name for the standing agent made from ${sub.name}`} data-testid="setup-as"
            onInput=${(e) => { setAs(e.currentTarget.value); if (err) setErr(''); }}
            onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } }} />
          <button type="submit" class="btn btn-quiet" disabled=${busy} data-testid="setup-as-submit">${busy ? 'Making…' : 'Make it'}</button>
          <button type="button" class="btn btn-quiet" onClick=${cancel}>Cancel</button>
        </form>`
        : html`<button class="btn btn-quiet btn-sm" onClick=${() => { setRenaming(true); setErr(''); }} aria-label=${`Use another name to make ${sub.name} a standing agent`}
          data-testid="setup-rename">Use another name</button>`}
      ${err ? html`<span class="form-error" role="alert">${err}</span>` : null}
    </span>`;
  }
  return html`<span class="setup-promote">
    <button class="btn btn-quiet btn-sm" onClick=${() => promote()} disabled=${busy} aria-label=${`Make ${sub.name} a standing agent`} data-testid="setup-promote">
      ${busy ? 'Making…' : 'Make it a standing agent'}</button>
    ${err ? html`<span class="form-error" role="alert">${err}</span>` : null}
  </span>`;
}

export function SetupList({ kind, items, scope = 'user', repo, promote = false, limit = LIMIT }) {
  const [all, setAll] = useState(false);
  const rows = list(items);
  if (!rows.length) return html`<p class="panel-quiet">None.</p>`;
  const shown = all ? rows : rows.slice(0, limit);
  return html`<ul class="setup-list" data-list=${kind}>
      ${shown.map((item) => html`<li class="setup-item" data-item=${item.name || item.event}>
        <span class="setup-item-text"><${ItemText} kind=${kind} item=${item} /></span>
        ${promote && kind === 'agents' ? html`<${PromoteButton} sub=${item} scope=${scope} repo=${repo} />` : null}
      </li>`)}
    </ul>
    ${rows.length > limit ? html`<button class="link-btn setup-more" onClick=${() => setAll(!all)} aria-expanded=${all ? 'true' : 'false'} data-testid="setup-more">
      ${all ? 'Show fewer' : `Show all ${rows.length}${kind === 'hooks' ? ' events' : ''}`}</button>` : null}`;
}

// What one repo adds: its own CLAUDE.md / AGENTS.md and its .claude/ and .mcp.json entries.
export function RepoAdds({ p, promote = false }) {
  if (!repoAdds(p)) return html`<p class="panel-quiet">Nothing beyond your own setup.</p>`;
  const files = [p.claude_md ? 'CLAUDE.md' : null, p.agents_md ? 'AGENTS.md' : null].filter(Boolean);
  return html`<div class="repo-adds">
    ${files.length ? html`<p class="repo-files">Its own ${files.map((f, i) => html`${i ? ' and ' : ''}<code>${f}</code>`)}, which Claude Code reads in every session there.</p>` : null}
    ${KINDS.filter((k) => k.id !== 'plugins' && list(p[k.id]).length).map((k) => html`<div class="repo-adds-sec" data-adds=${k.id}>
      <h5 class="repo-adds-h">${k.title} <span class="sec-count">${countOf(k.id, p[k.id])}</span></h5>
      <${SetupList} kind=${k.id} items=${p[k.id]} scope="repo" repo=${p.path} promote=${promote} limit=${4} />
    </div>`)}
  </div>`;
}

export function SetupCard() {
  const { data, err, loading, reload } = useSetup(true);
  const agentsById = useStore((s) => s.agentsById);
  const configDir = (data && data.config_dir) || '~/.claude';
  const md = (data && data.claude_md) || {};
  const projects = list(data && data.projects);
  return html`<section class="card setup-card" id="setup" aria-labelledby="set-setup" data-testid="setup-card">
    <h2 id="set-setup" class="card-title">Your Claude Code setup <button class="link-btn" onClick=${reload}>Refresh</button></h2>
    <p class="set-note setup-lead">Every agent session loads these, because Claude Code loads them in every session.</p>
    <${SafetySection} />
    ${err === 'unsupported' ? html`<p class="panel-quiet">This Clawdling server can't show your setup yet. Update it, then reload this page.</p>`
      : err && !data ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${14} /> Couldn't read your Claude Code setup: ${err}</p>`
      : loading && !data ? html`<div class="panel-skel" aria-label="Loading"></div>`
      : html`
        <div class="setup-md" data-testid="setup-claude-md">
          <h3 class="card-h">Your CLAUDE.md <span class="card-h-sub mono">${tildify(configDir)}/CLAUDE.md</span></h3>
          ${md.exists && list(md.lines).length ? html`<pre class="setup-lines">${list(md.lines).join('\n')}</pre>
            <p class="set-note setup-md-note">The first lines. Claude Code reads the whole file at the start of every session.</p>`
            : html`<p class="panel-quiet">You don't have one. It is optional: rules you put there apply to every Claude Code session, agents included.</p>`}
        </div>
        <div class="setup-grid">
          ${KINDS.map((k) => html`<section class="setup-sec" data-setup=${k.id} aria-labelledby=${`setup-h-${k.id}`}>
            <h3 class="card-h" id=${`setup-h-${k.id}`}>${k.title} <span class="sec-count">${countOf(k.id, data[k.id])}</span></h3>
            ${k.id === 'agents' && list(data.agents).length ? html`<p class="set-note setup-sec-note">A subagent helps inside one session. Make it a standing agent and it gets its own memory, sessions and place on the org map. The subagent itself does not change.</p>` : null}
            <${SetupList} kind=${k.id} items=${data[k.id]} promote=${k.id === 'agents'} />
          </section>`)}
        </div>
        <h3 class="card-h setup-per">Per project <span class="card-h-sub">what each project agent's repo adds on top</span></h3>
        ${projects.length ? html`<div class="setup-projects">
          ${projects.map((p) => {
            const a = agentsById[p.agent];
            return html`<section class="setup-project" data-project=${p.agent} key=${`${p.agent}:${p.path}`}>
              <h4 class="setup-project-title">
                <span class="setup-project-icon">${a ? html`<${AgentIcon} agent=${a} size=${14} />` : html`<${Icon} name="folder" size=${14} />`}</span>
                ${a ? html`<button class="link-btn setup-project-name" onClick=${() => navigate(`#/agent/${encodeURIComponent(a.id)}`)}>${a.name}</button>` : html`<span>${p.agent}</span>`}
                <span class="mono setup-project-path">${tildify(p.path)}</span>
              </h4>
              <${RepoAdds} p=${p} promote=${true} />
            </section>`;
          })}
        </div>` : html`<p class="panel-quiet">No project agent has a repo yet. <button class="link-btn" onClick=${() => openOverlay({ type: 'import' })}>Bring in your projects</button> and what each repo adds shows here.</p>`}`}
    <p class="set-note setup-privacy" data-testid="setup-privacy"><${Icon} name="key" size=${14} /> <span>${PRIVACY_NOTE}</span></p>
  </section>`;
}

// For the map's chip panel: the one list behind a chip, with where to see the rest.
export function SetupKindPanelBody({ kind, data }) {
  const k = kindOf(kind);
  const items = list(data && data[kind]);
  const n = countOf(kind, items);
  return html`<p class="panel-text">${n
      ? `${plural(n, k.one)} from your own Claude Code setup. Claude Code loads ${n === 1 ? 'it' : 'them'} in every session, so every agent has ${n === 1 ? 'it' : 'them'}.`
      : `No ${k.title.toLowerCase()} in your own Claude Code setup.`}</p>
    <${SetupList} kind=${kind} items=${items} promote=${kind === 'agents'} limit=${12} />
    <div class="panel-actions setup-panel-actions"><button class="btn btn-quiet btn-sm" onClick=${() => navigate('#/settings/setup')}>See all of it in Settings</button></div>
    <p class="set-note">${PRIVACY_NOTE}</p>`;
}
