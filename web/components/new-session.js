// New session: pick the agent (Donna, a domain, a project), optionally give it
// a first message and a model, and it opens focused in the workspace.
import { html } from '../lib/html.js';
import { useMemo, useState, useRef } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Modal } from './dialogs.js';
import { AgentIcon, Icon } from './icons.js';
import { closeOverlay, startSession, openOverlay } from '../lib/actions.js';
import { sortAgents, KIND_LABEL, agentStats } from '../lib/model.js';
import { matches, isMac } from '../lib/util.js';
import { BLOCKED_TITLE, useStartBlocked } from './health-banner.js';

const GROUPS = [['chief', 'Chief of staff'], ['domain', 'Domains'], ['project', 'Projects'], ['scratch', 'No agent']];
// A plain claude in the org folder, no agent context: for one-off questions.
const SCRATCH = { id: 'scratch', kind: 'scratch', name: 'Scratch', icon: 'terminal', mission: 'A plain claude in your org folder, with no agent context or memory.' };

export function NewSessionDialog({ agent: preset }) {
  const agents = useStore((s) => s.agents);
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(sessions), [sessions]);
  const sorted = useMemo(() => [...sortAgents(agents), SCRATCH], [agents]);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(preset || (sorted[0] && sorted[0].id) || null);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const promptRef = useRef(null);
  const blocked = useStartBlocked();

  const visible = sorted.filter((a) => matches(q, a.name, a.id, a.mission, KIND_LABEL[a.kind]));
  const current = sorted.find((a) => a.id === pick);

  const go = async (id = pick) => {
    if (!id || busy || blocked) return;
    setBusy(true);
    try {
      await startSession(id, { prompt, model });
      closeOverlay();
    } catch {
      setBusy(false);
    }
  };

  const onListKey = (e) => {
    const ids = visible.map((a) => a.id);
    const i = ids.indexOf(pick);
    if (e.key === 'ArrowDown') { e.preventDefault(); setPick(ids[Math.min(ids.length - 1, i + 1)] || ids[0]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPick(ids[Math.max(0, i - 1)] || ids[0]); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  };

  return html`<${Modal} labelledby="ns-title" onClose=${closeOverlay} size="md" class="new-session">
    <div class="modal-head">
      <h2 id="ns-title" class="modal-title">New session</h2>
      <p class="modal-text">A fresh <code>claude</code> in the agent's folder, with its CLAUDE.md and memory already loaded.</p>
    </div>
    <div class="ns-filter">
      <${Icon} name="search" />
      <input value=${q} onInput=${(e) => { setQ(e.currentTarget.value); }} onKeyDown=${onListKey} placeholder="Filter agents"
        aria-label="Filter agents" data-autofocus data-testid="ns-filter" />
    </div>
    <div class="ns-list" role="listbox" aria-label="Agent" tabindex="-1" onKeyDown=${onListKey}>
      ${GROUPS.map(([kind, label]) => {
        const rows = visible.filter((a) => a.kind === kind);
        if (!rows.length) return null;
        return html`<div class="ns-group" role="group" aria-label=${label}>
          <div class="ns-group-label">${label}</div>
          ${rows.map((a) => {
            const st = agentStats(a.id, list);
            return html`<div role="option" aria-selected=${pick === a.id ? 'true' : 'false'} tabindex="-1"
              class=${`ns-row ${pick === a.id ? 'is-sel' : ''}`} onClick=${() => setPick(a.id)} onDblClick=${() => go(a.id)} data-agent-option=${a.id}>
              <span class="ns-icon"><${AgentIcon} agent=${a} size=${14} /></span>
              <span class="ns-text"><span class="ns-name">${a.name}</span>${a.mission ? html`<span class="ns-mission">${a.mission}</span>` : null}</span>
              ${st.live ? html`<span class="badge">${st.live} live</span>` : null}
            </div>`;
          })}
        </div>`;
      })}
      ${visible.length === 0 ? html`<p class="ns-none">No agent matches. <button class="link-btn" onClick=${() => openOverlay({ type: 'wizard', name: q })}>Create “${q}”</button></p>` : null}
    </div>
    <div class="ns-fields">
      <label class="field">
        <span class="field-label">First message <span class="field-opt">optional</span></span>
        <textarea ref=${promptRef} rows="3" value=${prompt} onInput=${(e) => setPrompt(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } }}
          placeholder=${current ? `What should ${current.name} work on?` : 'What should it work on?'} data-testid="ns-prompt"></textarea>
      </label>
      <label class="field field-inline">
        <span class="field-label">Model</span>
        <input class="mono" list="ns-models" value=${model} onInput=${(e) => setModel(e.currentTarget.value)}
          placeholder=${current && current.model ? current.model : 'agent default'} aria-label="Model (optional)" />
        <datalist id="ns-models"><option value="sonnet" /><option value="opus" /><option value="haiku" /></datalist>
      </label>
    </div>
    <div class="modal-foot">
      <span class="foot-hint"><kbd>${isMac ? '⌘' : 'Ctrl'}</kbd><kbd>↵</kbd> to start from the message box</span>
      <button class="btn btn-quiet" onClick=${closeOverlay}>Cancel</button>
      <button class="btn btn-primary" onClick=${() => go()} disabled=${!pick || busy || blocked} title=${blocked ? BLOCKED_TITLE : undefined} data-testid="ns-start">
        ${busy ? 'Starting…' : current ? `Start with ${current.name}` : 'Start session'}
      </button>
    </div>
  </${Modal}>`;
}
