// "Your Claude Code setup": what every agent session inherits, because Claude Code loads it in
// every session (skills, subagents, commands, plugins, hooks, MCP servers, the global CLAUDE.md).
// GET /api/setup returns names and descriptions only: never an MCP key, an environment value or a
// hook command. Shown as a card in Settings and as a layer on the org map.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { api } from '../lib/api.js';
import { refreshOrg } from '../lib/live.js';
import { navigate, toast, openOverlay } from '../lib/actions.js';
import { tildify, plural } from '../lib/util.js';
import { Icon, AgentIcon } from './icons.js';

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
export const slugId = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// What a repo adds on top of the person's own setup: anything Claude Code loads there.
export function repoAdds(p) {
  if (!p) return false;
  return !!(p.claude_md || p.agents_md || ['skills', 'agents', 'commands', 'hooks', 'mcp'].some((k) => list(p[k]).length));
}

// ---- data: one read per screen, shared by Settings and the map
let cache = null;
let inflight = null;
export function loadSetup() {
  if (!inflight) inflight = api.setup().then((r) => { cache = r && typeof r === 'object' ? r : {}; return cache; }).finally(() => { inflight = null; });
  return inflight;
}
export function useSetup(enabled = true) {
  const [state, setS] = useState(() => ({ data: cache, err: '', loading: !cache }));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setS((s) => ({ ...s, loading: !s.data }));
    loadSetup().then((d) => { if (live) setS({ data: d, err: '', loading: false }); })
      .catch((e) => { if (live) setS((s) => ({ data: s.data, err: e && e.status === 404 ? 'unsupported' : (e && e.message) || 'unknown error', loading: false })); });
    return () => { live = false; };
  }, [enabled, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

// ---- pieces
function ItemText({ kind, item }) {
  if (kind === 'hooks') {
    const when = HOOK_WHEN[item.event];
    return html`<span class="setup-name mono">${item.event}</span><span class="setup-desc">${when ? `Runs ${when}` : 'Runs on this event'}${Number(item.count) > 1 ? ` · ${item.count} hooks` : ''}</span>`;
  }
  if (kind === 'mcp') return html`<span class="setup-name mono">${item.name}</span><span class="setup-desc">${MCP_SCOPE[item.scope] || item.scope || ''}</span>`;
  if (kind === 'plugins') {
    return html`<span class="setup-name mono">${item.name}</span><span class="setup-desc">${item.marketplace ? `from ${item.marketplace}` : ''}${item.enabled === false ? html` <span class="card-tag">Off</span>` : ''}</span>`;
  }
  return html`<span class="setup-name mono">${kind === 'commands' ? `/${item.name}` : item.name}</span>${item.description ? html`<span class="setup-desc">${item.description}</span>` : null}`;
}

// A Claude Code subagent helps inside one session; a standing agent has its own memory, sessions
// and place on the org map. The server copies the subagent's instructions (found by name, never by
// a path from here) into a new domain agent; the subagent itself does not change.
export function PromoteButton({ sub, scope = 'user', repo }) {
  const agentsById = useStore((s) => s.agentsById);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);
  const [err, setErr] = useState('');
  const same = agentsById[slugId(sub.name)];
  const agent = made || (same && same.kind === 'domain' ? same : null);
  const openAgent = (id) => navigate(`#/agent/${encodeURIComponent(id)}`);
  if (agent) {
    const a = agentsById[agent.id] || agent;
    return html`<span class="setup-made" data-testid="setup-made"><${Icon} name="check" size=${12} /> Standing agent: <button class="link-btn"
      onClick=${() => openAgent(a.id)}>${a.name}</button></span>`;
  }
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const a = await api.promoteSubagent({ scope, ...(repo ? { repo } : {}), name: sub.name });
      await refreshOrg();
      setMade(a);
      toast(`${a.name} is now a standing agent, with its own memory and sessions.`, { tone: 'ok', ms: 7000, action: { label: 'Open', run: () => openAgent(a.id) } });
    } catch (e) {
      setErr(e && e.status === 409 ? `An agent called "${slugId(sub.name)}" already exists.` : (e && e.message) || 'Could not make the agent.');
    } finally {
      setBusy(false);
    }
  };
  return html`<span class="setup-promote">
    <button class="btn btn-quiet btn-sm" onClick=${go} disabled=${busy} aria-label=${`Make ${sub.name} a standing agent`} data-testid="setup-promote">
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
      ${all ? 'Show fewer' : `Show all ${rows.length}`}</button>` : null}`;
}

// What one repo adds: its own CLAUDE.md / AGENTS.md and its .claude/ and .mcp.json entries.
export function RepoAdds({ p, promote = false }) {
  if (!repoAdds(p)) return html`<p class="panel-quiet">Nothing beyond your own setup.</p>`;
  const files = [p.claude_md ? 'CLAUDE.md' : null, p.agents_md ? 'AGENTS.md' : null].filter(Boolean);
  return html`<div class="repo-adds">
    ${files.length ? html`<p class="repo-files">Its own ${files.map((f, i) => html`${i ? ' and ' : ''}<code>${f}</code>`)}, which Claude Code reads in every session there.</p>` : null}
    ${KINDS.filter((k) => k.id !== 'plugins' && list(p[k.id]).length).map((k) => html`<div class="repo-adds-sec" data-adds=${k.id}>
      <h5 class="repo-adds-h">${k.title} <span class="sec-count">${list(p[k.id]).length}</span></h5>
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
            <h3 class="card-h" id=${`setup-h-${k.id}`}>${k.title} <span class="sec-count">${list(data[k.id]).length}</span></h3>
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
  return html`<p class="panel-text">${items.length
      ? `${plural(items.length, k.one)} from your own Claude Code setup. Claude Code loads ${items.length === 1 ? 'it' : 'them'} in every session, so every agent has ${items.length === 1 ? 'it' : 'them'}.`
      : `No ${k.title.toLowerCase()} in your own Claude Code setup.`}</p>
    <${SetupList} kind=${kind} items=${items} promote=${kind === 'agents'} limit=${12} />
    <div class="panel-actions setup-panel-actions"><button class="btn btn-quiet btn-sm" onClick=${() => navigate('#/settings/setup')}>See all of it in Settings</button></div>
    <p class="set-note">${PRIVACY_NOTE}</p>`;
}
