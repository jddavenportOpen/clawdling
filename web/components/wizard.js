// New agent wizard: kind → name → mission/goal → (project) repo + parent domain
// → Create → optional "Start a session to flesh this out".
import { html } from '../lib/html.js';
import { useState, useMemo, useEffect, useRef } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Modal } from './dialogs.js';
import { Icon } from './icons.js';
import { closeOverlay, startSession, navigate, toast } from '../lib/actions.js';
import { api } from '../lib/api.js';
import { refreshOrg } from '../lib/live.js';
import { agentFolder } from '../lib/model.js';

export function fleshOutPrompt(agent) {
  const what = agent.kind === 'project' ? 'project' : 'domain';
  return [
    `You are the newly created ${agent.name} agent (a ${what} agent) in this Clawdling org.`,
    'Interview me briefly to flesh yourself out: ask at most 3 short questions, one at a time, about what you should own,',
    'what good looks like, and how I want you to work.',
    'Then improve your own CLAUDE.md (mission, how you work, what to watch for) and write memory/NOW.md with the current state and next steps.',
    'Keep both files short and concrete.',
  ].join(' ');
}

export function Wizard({ name: presetName = '' }) {
  const agents = useStore((s) => s.agents);
  const domains = useMemo(() => agents.filter((a) => a.kind === 'domain'), [agents]);
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState(null);
  const [name, setName] = useState(presetName);
  const [mission, setMission] = useState('');
  const [repo, setRepo] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const body = useRef(null);

  // Each step (and the done screen) puts the keyboard straight into its main control.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const scope = created ? document.querySelector('.wizard') : body.current;
      const el = scope && scope.querySelector('[data-autofocus]');
      if (el) el.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [step, created]);

  const steps = kind === 'project' ? ['Kind', 'Name', 'Goal', 'Repo'] : ['Kind', 'Name', 'Mission'];
  const last = steps.length - 1;
  const isProject = kind === 'project';

  const canNext = [
    !!kind,
    name.trim().length > 0,
    mission.trim().length > 0,
    true,
  ][step];

  const create = async () => {
    setBusy(true);
    setError('');
    const body = { kind, name: name.trim(), mission: mission.trim() };
    if (isProject && repo.trim()) body.repo = repo.trim();
    if (isProject && domain) body.domain = domain;
    try {
      const agent = await api.createAgent(body);
      await refreshOrg();
      setCreated(agent && agent.id ? agent : { ...body, id: agent && agent.id });
      setStep(steps.length);
    } catch (e) {
      setError(e.message || 'Could not create the agent');
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (!canNext || busy) return;
    if (step >= last) create();
    else setStep(step + 1);
  };
  const back = () => setStep(Math.max(0, step - 1));
  const onEnter = (e) => { if (e.key === 'Enter' && !e.shiftKey && e.currentTarget.tagName !== 'TEXTAREA') { e.preventDefault(); next(); } };
  const onEnterArea = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); next(); } };

  if (created) {
    const flesh = async () => {
      closeOverlay();
      try {
        await startSession(created.id, { prompt: fleshOutPrompt(created), title: `Set up ${created.name}` });
      } catch { /* toast already shown */ }
    };
    return html`<${Modal} labelledby="wz-title" onClose=${closeOverlay} size="md" class="wizard">
      <div class="modal-head wz-done">
        <span class="wz-done-icon"><${Icon} name="check" size=${18} /></span>
        <h2 id="wz-title" class="modal-title">${created.name} is ready</h2>
        <p class="modal-text">Created <code>${created.dir ? created.dir.replace(/^\/(Users|home)\/[^/]+/, '~') : agentFolder(created)}</code> with its own CLAUDE.md and a memory folder. Every session of ${created.name} starts from those files.</p>
      </div>
      <div class="wz-next">
        <button class="wz-option is-primary" onClick=${flesh} data-autofocus data-testid="wz-flesh">
          <span class="wz-opt-icon"><${Icon} name="chat" /></span>
          <span class="wz-opt-text"><span class="wz-opt-title">Start a session to flesh this out</span>
          <span class="wz-opt-sub">Claude asks you up to 3 quick questions, then rewrites its own CLAUDE.md and NOW.md.</span></span>
        </button>
        <button class="wz-option" onClick=${() => { closeOverlay(); navigate(`#/agent/${encodeURIComponent(created.id)}`); }}>
          <span class="wz-opt-icon"><${Icon} name="book" /></span>
          <span class="wz-opt-text"><span class="wz-opt-title">Open the agent page</span><span class="wz-opt-sub">Read and edit its context and memory yourself.</span></span>
        </button>
      </div>
      <div class="modal-foot"><button class="btn btn-quiet" onClick=${() => { closeOverlay(); toast(`${created.name} added to your org`, { tone: 'ok' }); }}>Done</button></div>
    </${Modal}>`;
  }

  return html`<${Modal} labelledby="wz-title" onClose=${closeOverlay} size="md" class="wizard">
    <div class="modal-head">
      <h2 id="wz-title" class="modal-title">New agent</h2>
      <ol class="wz-steps" aria-label="Steps">
        ${steps.map((label, i) => html`<li class=${`wz-step ${i === step ? 'is-on' : ''} ${i < step ? 'is-done' : ''}`} aria-current=${i === step ? 'step' : undefined}>
          <span class="wz-step-n">${i < step ? html`<${Icon} name="check" size=${10} />` : i + 1}</span>${label}</li>`)}
      </ol>
    </div>
    <div class="modal-body wz-body" key=${step} ref=${body}>
      ${step === 0 ? html`<div class="wz-kinds" role="radiogroup" aria-label="Kind of agent">
        ${[
          ['domain', 'briefcase', 'Domain', 'An area of your life or work that never ends: Health, Money, a team, a client.'],
          ['project', 'folder', 'Project', 'Something with a goal and a finish line: a launch, a repo, a move, a trip.'],
        ].map(([k, icon, title, sub], i) => html`<button role="radio" aria-checked=${kind === k ? 'true' : 'false'}
            class=${`wz-kind ${kind === k ? 'is-on' : ''}`} data-autofocus=${i === 0 && !kind ? true : kind === k ? true : undefined}
            onClick=${() => { setKind(k); setStep(1); }} data-kind=${k}>
          <span class="wz-kind-icon"><${Icon} name=${icon} size=${18} /></span>
          <span class="wz-kind-title">${title}</span><span class="wz-kind-sub">${sub}</span>
        </button>`)}
      </div>` : null}

      ${step === 1 ? html`<label class="field">
        <span class="field-label">${isProject ? 'Project name' : 'Domain name'}</span>
        <input value=${name} onInput=${(e) => setName(e.currentTarget.value)} onKeyDown=${onEnter} maxLength="60" data-autofocus
          placeholder=${isProject ? 'e.g. Launch the website' : 'e.g. Fitness'} data-testid="wz-name" />
        <span class="field-help">Shown in the cockpit and in every session title, like “${name.trim() || (isProject ? 'Launch the website' : 'Fitness')}: new session”.</span>
      </label>` : null}

      ${step === 2 ? html`<label class="field">
        <span class="field-label">${isProject ? 'Goal' : 'Mission'}</span>
        <textarea rows="3" value=${mission} onInput=${(e) => setMission(e.currentTarget.value)} onKeyDown=${onEnterArea} maxLength="400" data-autofocus
          placeholder=${isProject ? 'e.g. Ship the new marketing site by November 15 with a working signup form.' : 'e.g. Keep my training, sleep and nutrition on track for a spring half marathon.'}
          data-testid="wz-mission"></textarea>
        <span class="field-help">One sentence. ${name.trim() || 'The agent'} reads it at the start of every session. You can rewrite it any time on the agent page.</span>
      </label>` : null}

      ${step === 3 && isProject ? html`<div class="wz-two">
        <label class="field">
          <span class="field-label">Code repo <span class="field-opt">optional</span></span>
          <input class="mono" value=${repo} onInput=${(e) => setRepo(e.currentTarget.value)} onKeyDown=${onEnter} data-autofocus
            placeholder="/absolute/path/to/repo" spellcheck="false" autocapitalize="off" data-testid="wz-repo" />
          <span class="field-help">Sessions open in this folder, with the agent's context and memory added.</span>
        </label>
        <label class="field">
          <span class="field-label">Parent domain <span class="field-opt">optional</span></span>
          <select value=${domain} onChange=${(e) => setDomain(e.currentTarget.value)} data-testid="wz-domain">
            <option value="">None</option>
            ${domains.map((d) => html`<option value=${d.id}>${d.name}</option>`)}
          </select>
          <span class="field-help">Where it sits on the org map.</span>
        </label>
      </div>` : null}

      ${error ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${14} /> ${error}</p>` : null}
    </div>
    <div class="modal-foot">
      ${step > 0 ? html`<button class="btn btn-quiet" onClick=${back}>Back</button>` : html`<button class="btn btn-quiet" onClick=${closeOverlay}>Cancel</button>`}
      <span class="foot-spacer"></span>
      ${step > 0 ? html`<button class="btn btn-primary" onClick=${next} disabled=${!canNext || busy} data-testid="wz-next">
        ${step >= last ? (busy ? 'Creating…' : `Create ${isProject ? 'project' : 'domain'}`) : 'Next'}</button>` : null}
    </div>
  </${Modal}>`;
}
