// The Check-up tab of an agent page (1.6, Verified done):
//   Ship check (project agents): a few commands the owner approves once (test, build, lint), run on
//     demand in a scratch copy of the repo. Each command is shown exactly, with what it does.
//   Check-up: five cases drafted from the agent's own CLAUDE.md and NOW.md, read and edited here,
//     then run as the agent lives, on the owner's plan, with the cost shown first and a hard cap.
//   Try a cheaper model: the same cases across model and effort settings; "Use this" sets the
//     agent's default in Clawdling's own agent.json, never in Claude Code's settings.
import { html } from '../lib/html.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { toast, errorToast } from '../lib/actions.js';
import { refreshOrg } from '../lib/live.js';
import { relTime, plural } from '../lib/util.js';
import { Modal } from './dialogs.js';
import { Icon } from './icons.js';

const POLL_MS = 1500;
const money = (x) => (x === null || x === undefined || !Number.isFinite(x) ? 'unknown' : x > 0 && x < 0.005 ? 'less than $0.01' : `$${x.toFixed(2)}`);
const listText = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
const secs = (ms) => (ms === null || ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
const ago = (iso, now) => {
  const r = relTime(iso, now);
  return !r ? '' : r === 'now' ? 'just now' : /^\d+[mhd]$/.test(r) ? `${r} ago` : r;
};

/** Poll a loader while `active` (a run in progress), else load once per `key`. */
function usePolled(load, key, active) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((d) => { if (live) { setData(d); setErr(''); } }).catch((e) => { if (live) setErr(e.message || 'Could not load.'); });
    return () => { live = false; };
  }, [key, tick]);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => { if (!document.hidden) setTick((x) => x + 1); }, POLL_MS);
    return () => clearInterval(t);
  }, [active]);
  return [data, err, () => setTick((x) => x + 1), setData];
}

export function CheckupTab({ id, agent, now }) {
  return html`<div class="checkup" data-testid="checkup-tab">
    ${agent.kind === 'project' ? html`<${ShipCheck} id=${id} name=${agent.name} now=${now} />` : null}
    <${AgentCheckup} id=${id} name=${agent.name} now=${now} />
  </div>`;
}

// ------------------------------------------------------------------------------------ ship check

function ShipCheck({ id, name, now }) {
  const [running, setRunning] = useState(false);
  const [v, err, reload, setV] = usePolled(() => api.checks(id), id, running);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (v) setRunning(!!v.running); }, [v]);
  if (err && !v) return html`<section class="cu-section"><h2 class="cu-h">Ship check</h2><p class="form-error" role="alert">Could not load the ship check: ${err}</p></section>`;
  if (!v) return html`<section class="cu-section"><h2 class="cu-h">Ship check</h2><div class="panel-skel" aria-label="Loading"></div></section>`;
  const run = async () => {
    try {
      await api.runChecks(id);
      setRunning(true);
      reload();
    } catch (e) {
      errorToast('Could not run the ship check', e);
    }
  };
  const set = v.exists && v.config;
  return html`<section class="cu-section" aria-labelledby="cu-ship-h" data-testid="ship-check">
    <h2 class="cu-h" id="cu-ship-h">Ship check</h2>
    <p class="cu-lede">A few commands you approve once (tests, build), which Clawdling runs in a scratch copy of the repo, never in the live one. A passing run is a receipt for ${name}'s "done".</p>
    ${!v.available ? html`<p class="rc-note">${v.why}</p>`
      : editing || !set ? html`<${ShipSetup} v=${v} id=${id} onDone=${(nv) => { setV(nv); setEditing(false); }} onCancel=${set ? () => setEditing(false) : null} />`
      : html`
        ${!v.approved ? html`<div class="cu-warn" role="alert"><${Icon} name="alert" size=${14} /> <span>checks.yaml changed since you approved it, so nothing runs until you review it.</span>
          <button type="button" class="btn btn-quiet btn-sm" onClick=${() => setEditing(true)}>Review</button></div>` : null}
        <ul class="cu-cmds" aria-label="Approved commands">
          ${(v.config.setup || []).map((s) => html`<li key=${`s-${s.run}`}><span class="cu-cmd-name">setup</span><code class="cu-cmd">${s.run}</code></li>`)}
          ${v.config.checks.map((c) => html`<li key=${c.name}><span class="cu-cmd-name">${c.name}</span><code class="cu-cmd">${c.run}</code></li>`)}
        </ul>
        <p class="rc-note">${v.notes.untracked}</p>
        <div class="cu-actions">
          <button type="button" class="btn btn-primary" onClick=${run} disabled=${!v.approved || !!v.running || v.busy} data-testid="ship-run"><${Icon} name="play" size=${13} /> ${v.running ? 'Running…' : 'Run ship check'}</button>
          <button type="button" class="btn btn-quiet" onClick=${() => setEditing(true)} disabled=${!!v.running}>Change commands</button>
        </div>
        ${v.busy ? html`<p class="rc-note">Another project's ship check is running; one runs at a time.</p>` : null}
        ${v.running ? html`<p class="cu-progress" role="status"><span class="cu-spinner" aria-hidden="true"></span> Running${v.running.current ? ` ${v.running.current}` : ''} in a scratch copy…</p>` : null}
        ${v.last ? html`<${ShipResult} r=${v.last} now=${now} />` : null}`}
  </section>`;
}

function ShipSetup({ v, id, onDone, onCancel }) {
  // Proposals and the current list (when changing it), each ticked only by the owner.
  const initial = useMemo(() => {
    const cur = v.config ? [...(v.config.setup || []).map((s) => ({ ...s, setup: true })), ...v.config.checks.map((c) => ({ ...c, setup: false }))] : [];
    const rows = [];
    for (const c of cur) rows.push({ ...c, on: !!v.approved, what: (v.proposals.find((p) => p.run === c.run) || {}).what || 'From checks.yaml.' });
    for (const p of v.proposals) if (!rows.some((r) => r.run === p.run)) rows.push({ ...p, on: false });
    return rows;
  }, [v]);
  const [rows, setRows] = useState(initial);
  const [extra, setExtra] = useState({ name: '', run: '' });
  const [busy, setBusy] = useState(false);
  const ticked = rows.filter((r) => r.on);
  const checks = ticked.filter((r) => !r.setup);
  const toggle = (i) => setRows(rows.map((r, j) => (j === i ? { ...r, on: !r.on } : r)));
  const add = () => {
    if (!extra.run.trim()) return;
    setRows([...rows, { setup: false, name: extra.name.trim() || `check-${rows.length + 1}`, run: extra.run.trim(), what: 'A command you typed.', timeout: 600, on: true }]);
    setExtra({ name: '', run: '' });
  };
  const approve = async () => {
    setBusy(true);
    const setup = ticked.filter((r) => r.setup).map((r) => ({ run: r.run, timeout: r.timeout || 600 }));
    const list = checks.map((r) => ({ name: r.name, run: r.run, timeout: r.timeout || 600 }));
    try {
      const nv = await api.approveChecks(id, { setup, checks: list, shown: [...setup.map((s) => s.run), ...list.map((c) => c.run)] });
      toast('Ship check approved', { tone: 'ok', ms: 2200 });
      onDone(nv);
    } catch (e) {
      setBusy(false);
      errorToast('Could not approve these commands', e);
    }
  };
  const row = (r, i) => html`<li key=${`${r.setup ? 's' : 'c'}-${r.run}`} class=${`cu-pick ${r.on ? 'is-on' : ''}`}>
    <label class="cu-pick-label">
      <input type="checkbox" checked=${r.on} onChange=${() => toggle(i)} data-testid="ship-pick" data-run=${r.run} />
      <span class="cu-pick-body">
        <span class="cu-pick-top">${r.setup ? html`<span class="cu-cmd-name">setup</span>` : html`<span class="cu-cmd-name">${r.name}</span>`}<code class="cu-cmd">${r.run}</code></span>
        <span class="cu-what">${r.what}</span>
      </span>
    </label>
  </li>`;
  return html`<div class="cu-setup" data-testid="ship-setup">
    <div class="cu-warn"><${Icon} name="alert" size=${14} /> <span>${v.notes.scripts}</span></div>
    ${rows.some((r) => !r.setup) ? html`<h3 class="rc-sub-h">Checks</h3><ul class="cu-picks">${rows.map((r, i) => (r.setup ? null : row(r, i)))}</ul>`
      : html`<p class="rc-note">No test, build or lint command was found in this repo. Add one below.</p>`}
    ${rows.some((r) => r.setup) ? html`<h3 class="rc-sub-h">Setup <span class="rc-h-sub">runs first, off unless you tick it</span></h3>
      <p class="rc-note tone-amber-text">${v.notes.setup}</p>
      <ul class="cu-picks">${rows.map((r, i) => (r.setup ? row(r, i) : null))}</ul>` : null}
    <details class="cu-add"><summary>Add a command</summary>
      <div class="cu-add-row">
        <input class="input" placeholder="Name (tests)" value=${extra.name} onInput=${(e) => setExtra({ ...extra, name: e.currentTarget.value })} aria-label="Check name" />
        <input class="input mono" placeholder="Command (npm test)" value=${extra.run} onInput=${(e) => setExtra({ ...extra, run: e.currentTarget.value })} aria-label="Command" />
        <button type="button" class="btn btn-quiet btn-sm" onClick=${add} disabled=${!extra.run.trim()}>Add</button>
      </div></details>
    <p class="rc-note">${v.notes.untracked}</p>
    <div class="cu-actions">
      <button type="button" class="btn btn-primary" onClick=${approve} disabled=${!checks.length || busy} data-testid="ship-approve">${busy ? 'Approving…' : checks.length ? `Approve ${plural(ticked.length, 'command')}` : 'Tick at least one check'}</button>
      ${onCancel ? html`<button type="button" class="btn btn-quiet" onClick=${onCancel}>Cancel</button>` : null}
    </div>
    <p class="rc-note">Nothing runs until you approve. The list is saved in the agent's checks.yaml; changing a command needs your approval again.</p>
  </div>`;
}

function ShipResult({ r, now }) {
  return html`<div class=${`cu-result ${r.ok ? 'tone-ok' : 'tone-bad'}`} data-testid="ship-result" data-ok=${r.ok ? 'true' : 'false'}>
    <p class="cu-result-h"><${Icon} name=${r.ok ? 'check' : 'alert'} size=${14} /> ${r.ok ? 'Passed' : 'Failed'} <span class="rc-when">${ago(r.started_at, now)} · ${secs(r.ms)}</span></p>
    ${r.error ? html`<p class="form-error">${r.error}</p>` : null}
    <ul class="cu-steps">${r.results.map((x) => html`<li key=${x.name} class=${x.ok ? 'is-ok' : 'is-bad'}>
      <details><summary><span class="cu-step-mark">${x.ok ? 'Pass' : 'Fail'}</span> <span class="cu-cmd-name">${x.setup ? 'setup' : x.name}</span> <code class="cu-cmd">${x.cmd}</code> <span class="rc-when">${secs(x.ms)}</span></summary>
        ${!x.ok && x.err1 ? html`<p class="cu-err mono">${x.err1}</p>` : null}
        <pre class="cu-tail" aria-label=${`Last ${x.tail.length} lines of output`}>${x.tail.join('\n')}</pre>
      </details></li>`)}</ul>
  </div>`;
}

// --------------------------------------------------------------------------------- the check-up

function AgentCheckup({ id, name, now }) {
  const [active, setActive] = useState(false);
  const [v, err, reload, setV] = usePolled(() => api.evals(id), id, active);
  const [dialog, setDialog] = useState(null); // {kind: 'draft' | 'run' | 'compare', estimate}
  const [drafting, setDrafting] = useState(false);
  const wasActive = useRef(false);
  useEffect(() => {
    if (!v) return;
    setActive(!!v.active);
    if (wasActive.current && !v.active) {
      const lr = v.last_run;
      if (lr && lr.error && !lr.result) errorToast('The check-up stopped', { message: lr.error });
      else toast('Check-up finished', { tone: 'ok', ms: 2200 });
    }
    wasActive.current = !!v.active;
  }, [v]);
  if (err && !v) return html`<section class="cu-section"><h2 class="cu-h">Check-up</h2><p class="form-error" role="alert">Could not load the check-up: ${err}</p></section>`;
  if (!v) return html`<section class="cu-section"><h2 class="cu-h">Check-up</h2><div class="panel-skel" aria-label="Loading"></div></section>`;
  const draft = async () => {
    setDialog(null);
    setDrafting(true);
    try {
      setV(await api.draftEvals(id));
      toast('Five cases drafted. Read them before the first run.', { tone: 'ok' });
    } catch (e) {
      errorToast('Could not draft the cases', e);
    } finally {
      setDrafting(false);
    }
  };
  const start = async (body) => {
    setDialog(null);
    try {
      await api.runEvals(id, body);
      setActive(true);
      reload();
    } catch (e) {
      errorToast('Could not start the check-up', e);
    }
  };
  const last = v.last;
  return html`<section class="cu-section" aria-labelledby="cu-eval-h" data-testid="agent-checkup">
    <h2 class="cu-h" id="cu-eval-h">Check-up</h2>
    <p class="cu-lede">Five questions drafted from ${name}'s own CLAUDE.md and NOW.md: does it know its job, its next step, what is not its job, its house rules, and its last handoff? Run as it really lives (its folder and memory, in a scratch copy) on your plan, with a cost cap.</p>
    ${!v.cases.length ? html`<div class="cu-empty">
        <button type="button" class="btn btn-primary" onClick=${() => setDialog({ kind: 'draft' })} disabled=${drafting || v.busy || !!v.active} data-testid="checkup-draft">${drafting ? 'Drafting the cases…' : `Give ${name} a check-up`}</button>
        ${drafting ? html`<p class="cu-progress" role="status"><span class="cu-spinner" aria-hidden="true"></span> One Claude Code run is writing five cases from ${name}'s files…</p>` : null}
      </div>`
      : html`
        ${v.active ? html`<${Progress} a=${v.active} />` : null}
        ${last ? html`<${Result} r=${last} now=${now} id=${id} onApplied=${reload} />` : null}
        <div class="cu-actions">
          <button type="button" class="btn btn-primary" disabled=${!v.runnable || !!v.active || v.busy} onClick=${() => setDialog({ kind: 'run', estimate: v.estimate, k: v.settings.runs, cap: v.settings.max_cost_usd })} data-testid="checkup-run"><${Icon} name="play" size=${13} /> ${v.active ? 'Running…' : `Run the check-up (${plural(v.runnable, 'case')})`}</button>
        </div>
        ${v.busy ? html`<p class="rc-note">Another agent's check-up is running; one runs at a time.</p>` : null}
        ${!v.runnable && v.cases.length ? html`<p class="rc-note tone-amber-text">Approve at least one case to run the check-up.</p>` : null}
        ${v.runnable ? html`<${Cheaper} v=${v} id=${id} onCompare=${(estimate, models) => setDialog({ kind: 'compare', estimate, models, k: v.settings.runs, cap: v.settings.max_cost_usd })} />` : null}
        <h3 class="rc-sub-h cu-cases-h">The cases</h3>
        <${CaseList} v=${v} id=${id} onChange=${setV} disabled=${!!v.active} />
        <${SuiteSettings} v=${v} id=${id} onChange=${setV} disabled=${!!v.active} />
        ${v.history.length > 1 ? html`<details class="cu-history"><summary>Earlier check-ups</summary><ul class="rc-rows">${v.history.slice(1).map((h) => html`<li key=${h.file}><span>${new Date(h.started_at).toLocaleString()}${h.cells && h.cells.length > 1 ? ' · comparison' : ''}</span><span class="rc-num">${h.judge_unreliable ? 'judge unreliable' : h.score === null ? 'no score' : pct(h.score)} · ${money(h.cost_usd)}</span></li>`)}</ul></details>` : null}`}
    ${dialog && dialog.kind === 'draft' ? html`<${DraftDialog} name=${name} onClose=${() => setDialog(null)} onGo=${draft} />` : null}
    ${dialog && (dialog.kind === 'run' || dialog.kind === 'compare') ? html`<${CostDialog} d=${dialog} v=${v} onClose=${() => setDialog(null)} onGo=${start} />` : null}
  </section>`;
}

function DraftDialog({ name, onClose, onGo }) {
  return html`<${Modal} labelledby="draft-title" onClose=${onClose} size="sm" class="confirm">
    <div class="modal-body">
      <h2 id="draft-title" class="modal-title">Give ${name} a check-up</h2>
      <p class="modal-text">One Claude Code run on your plan reads ${name}'s CLAUDE.md and NOW.md and writes five cases. It has no tools, and it is capped at <strong>$0.50</strong> (usually about $0.05 to $0.20, list-price equivalent, not a bill).</p>
      <p class="modal-text">Nothing runs on its own: you read and edit the cases here first.</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-quiet" onClick=${onClose} data-autofocus>Cancel</button>
      <button class="btn btn-primary" onClick=${onGo} data-testid="draft-go">Draft the cases</button>
    </div>
  </${Modal}>`;
}

/** The cost, before anything starts: "This starts N Claude Code runs on your plan, about $X, capped at $Y". */
function CostDialog({ d, v, onClose, onGo }) {
  const e = d.estimate;
  const [cap, setCap] = useState(String(d.cap));
  const [k, setK] = useState(d.k);
  const [est, setEst] = useState(e);
  useEffect(() => {
    if (k === d.k) { setEst(e); return undefined; }
    let live = true;
    api.evalEstimate(v.agent.id, { k, models: d.models || '' }).then((x) => { if (live) setEst(x); }).catch(() => {});
    return () => { live = false; };
  }, [k]);
  const capN = Number(cap);
  const ok = Number.isFinite(capN) && capN > 0 && capN <= 50;
  return html`<${Modal} labelledby="cost-title" onClose=${onClose} size="sm" class="confirm cost-dialog">
    <div class="modal-body" data-testid="cost-dialog">
      <h2 id="cost-title" class="modal-title">${d.kind === 'compare' ? 'Try a cheaper model' : 'Run the check-up'}</h2>
      ${est ? html`<p class="cost-line" data-testid="cost-line">This starts <strong>${plural(est.runs, 'Claude Code run')}</strong> on your plan, about <strong>${money(est.low_usd)} to ${money(est.high_usd)}</strong> list-price equivalent, capped at <strong>${ok ? money(capN) : '…'}</strong>.</p>`
        : html`<p class="modal-text">Estimating…</p>`}
      ${est ? html`<p class="modal-text">Based on ${est.based_on}, plus ${plural(est.judge_votes, 'judge vote')} (the judge also grades an empty answer and each reference, to catch a judge that passes anything).</p>` : null}
      <p class="cost-pro" data-testid="cost-pro"><${Icon} name="alert" size=${13} /> ${v.notes.pro}</p>
      <div class="cost-fields">
        <label>Runs per case <select class="input" value=${String(k)} onChange=${(x) => setK(Number(x.currentTarget.value))} data-testid="cost-k">
          <option value="1">1 (cheapest)</option><option value="3">3 (shows flaky cases)</option></select></label>
        <label>Cost cap, dollars <input class="input" inputmode="decimal" value=${cap} onInput=${(x) => setCap(x.currentTarget.value)} data-testid="cost-cap" /></label>
      </div>
      <p class="rc-label">${v.notes.cost} The cap is checked before every run starts; a run already going may finish past it.</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-quiet" onClick=${onClose} data-autofocus>Cancel</button>
      <button class="btn btn-primary" disabled=${!ok} onClick=${() => onGo({ k, maxCostUsd: capN, ...(d.models ? { models: d.models } : {}) })} data-testid="cost-go">Start</button>
    </div>
  </${Modal}>`;
}

function Progress({ a }) {
  const p = a.total ? Math.round((a.done / a.total) * 100) : 0;
  return html`<div class="cu-run" role="status" data-testid="checkup-progress">
    <p><span class="cu-spinner" aria-hidden="true"></span> ${a.phase === 'controls' ? 'Checking the judge first (an empty answer must fail, each reference must pass)…' : `Run ${Math.min(a.done + 1, a.total)} of ${a.total}${a.current ? `: ${a.current}` : ''}`}</p>
    <div class="cu-bar" aria-hidden="true"><span style=${{ width: `${p}%` }}></span></div>
    <p class="rc-note">${money(a.spent_usd)} used so far, capped at ${money(a.cap_usd)}.</p>
  </div>`;
}

const CASE_STATE = (c) => (c.error ? ['bad', 'Has an error'] : c.approved ? ['ok', 'Approved'] : ['needs', 'Needs your review']);

function CaseList({ v, id, onChange, disabled }) {
  const [busy, setBusy] = useState(false);
  const pending = v.cases.filter((c) => !c.error && !c.approved);
  const approveAll = async () => {
    setBusy(true);
    try {
      onChange(await api.approveCases(id, { cases: pending.map((c) => ({ id: c.id, hash: c.hash })) }));
      toast(`${plural(pending.length, 'case')} approved`, { tone: 'ok', ms: 2200 });
    } catch (e) {
      errorToast('Could not approve', e);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="cu-cases">
    <p class="cu-count">${plural(v.cases.length, 'case')} · ${v.runnable} approved${pending.length ? ` · ${pending.length} waiting for your review` : ''}${v.broken ? ` · ${v.broken} with an error` : ''}</p>
    ${pending.length ? html`<div class="cu-warn"><${Icon} name="alert" size=${14} /> <span>Read ${pending.length === 1 ? 'this case' : 'these cases'} before the first run: the prompt is what ${v.agent.name} is asked, the criteria are what a good answer must do.</span>
      <button type="button" class="btn btn-quiet btn-sm" onClick=${approveAll} disabled=${busy || disabled} data-testid="cases-approve">${pending.length === v.cases.length ? 'Approve all as shown' : `Approve ${plural(pending.length, 'case')}`}</button></div>` : null}
    <ul class="cu-case-list">${v.cases.map((c) => html`<${CaseCard} key=${`${c.id}:${c.hash}`} c=${c} id=${id} onChange=${onChange} disabled=${disabled} />`)}</ul>
  </div>`;
}

function CaseCard({ c, id, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState(() => ({ ...c.files }));
  const [busy, setBusy] = useState(false);
  const [tone, label] = CASE_STATE(c);
  const graderKeys = Object.keys(files).filter((k) => k.startsWith('graders/')).sort();
  const dirty = JSON.stringify(files) !== JSON.stringify(c.files);
  const save = async () => {
    setBusy(true);
    const graders = {};
    for (const k of graderKeys) graders[k.slice('graders/'.length).replace(/\.md$/, '')] = files[k];
    try {
      onChange(await api.saveCase(id, c.id, { prompt: files['prompt.md'] || '', graders, reference: files['reference.md'] ?? null }));
      toast(`${c.name} saved and approved`, { tone: 'ok', ms: 2200 });
    } catch (e) {
      errorToast(`Could not save ${c.name}`, e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      onChange(await api.removeCase(id, c.id));
    } catch (e) {
      errorToast(`Could not remove ${c.name}`, e);
    }
  };
  const area = (k, labelText) => html`<label class="cu-file"><span class="cu-file-name mono">${labelText || k}</span>
    <textarea class="editor-area mono cu-area" value=${files[k] ?? ''} spellcheck="false" onInput=${(e) => setFiles({ ...files, [k]: e.currentTarget.value })} data-testid=${`case-file-${k}`}></textarea></label>`;
  return html`<li class="cu-case" data-case=${c.id} data-testid="case-card">
    <button type="button" class="cu-case-head" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen((x) => !x)}>
      <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} size=${12} />
      <span class="cu-case-name">${c.name}</span>
      <span class=${`cu-chip tone-${tone}`} data-state=${c.error ? 'error' : c.approved ? 'approved' : 'review'}>${label}</span>
      ${c.description ? html`<span class="cu-case-desc">${c.description}</span>` : null}
    </button>
    ${open ? html`<div class="cu-case-body">
      ${c.error ? html`<p class="form-error" role="alert">${c.error}</p>` : null}
      ${area('prompt.md', 'prompt.md · what the agent is asked')}
      ${graderKeys.map((k) => area(k, `${k} · how the answer is graded`))}
      ${area('reference.md', 'reference.md · a good answer (used only to check the judge)')}
      <div class="cu-actions">
        <button type="button" class="btn btn-primary btn-sm" onClick=${save} disabled=${busy || disabled || (!dirty && c.approved)} data-testid="case-save">${dirty ? 'Save and approve' : c.approved ? 'Saved' : 'Approve as shown'}</button>
        ${dirty ? html`<button type="button" class="btn btn-quiet btn-sm" onClick=${() => setFiles({ ...c.files })}>Revert</button>` : null}
        <button type="button" class="btn btn-quiet btn-sm" onClick=${remove} disabled=${disabled}>Remove case</button>
      </div>
      <p class="rc-note">These files use the format of Anthropic's <code>claude plugin eval</code>. A grader of type <code>llm</code> is judged by a model (three votes); <code>regex</code>, <code>tool_used</code>, <code>tool_order</code> and <code>file_exists</code> are checked without one.</p>
    </div>` : null}
  </li>`;
}

function SuiteSettings({ v, id, onChange, disabled }) {
  const [s, setS] = useState(v.settings);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(v.settings);
  const save = async () => {
    setBusy(true);
    try {
      onChange(await api.saveEvalSettings(id, { runs: Number(s.runs), judge_model: s.judge_model, max_cost_usd: Number(s.max_cost_usd) }));
      toast('Check-up settings saved', { tone: 'ok', ms: 2000 });
    } catch (e) {
      errorToast('Could not save the settings', e);
    } finally {
      setBusy(false);
    }
  };
  return html`<details class="cu-settings"><summary>Settings: ${plural(v.settings.runs, 'run')} per case, judge ${v.settings.judge_model}, cap ${money(v.settings.max_cost_usd)}</summary>
    ${v.settings_error ? html`<p class="form-error">${v.settings_error}</p>` : null}
    <div class="cost-fields">
      <label>Runs per case <select class="input" value=${String(s.runs)} onChange=${(e) => setS({ ...s, runs: Number(e.currentTarget.value) })}><option value="1">1</option><option value="3">3</option></select></label>
      <label>Judge model <input class="input mono" value=${s.judge_model} onInput=${(e) => setS({ ...s, judge_model: e.currentTarget.value })} /></label>
      <label>Cost cap, dollars <input class="input" inputmode="decimal" value=${String(s.max_cost_usd)} onInput=${(e) => setS({ ...s, max_cost_usd: e.currentTarget.value })} /></label>
    </div>
    <button type="button" class="btn btn-quiet btn-sm" onClick=${save} disabled=${!dirty || busy || disabled}>Save settings</button>
  </details>`;
}

function Result({ r, now, id, onApplied }) {
  const cells = r.cells || [];
  const cur = cells.find((c) => c.current) || cells[0];
  return html`<div class="cu-result-eval" data-testid="checkup-result">
    <h3 class="rc-sub-h cu-last-h">Last check-up <span class="rc-h-sub">${ago(r.started_at, now)}</span></h3>
    ${r.judge_unreliable ? html`<div class="cu-warn tone-bad" data-testid="judge-unreliable"><${Icon} name="alert" size=${14} /> <span><strong>Judge unreliable.</strong> The judge passed an empty answer or failed a good one, so a score would mean nothing. No agent run was spent. Make the criteria concrete (what a good answer must say), then run it again.</span></div>
      <ul class="cu-controls">${r.controls.filter((x) => !x.ok).map((x) => html`<li key=${`${x.case}-${x.grader}-${x.kind}`}>${x.case} / ${x.grader}: ${x.kind === 'empty' ? 'passed an empty answer' : 'failed the reference answer'}${x.reasons && x.reasons[0] ? ` ("${x.reasons[0]}")` : ''}</li>`)}</ul>`
      : html`<p class="cu-score" data-testid="checkup-score">${r.score === null ? html`<span class="tone-amber-text">${r.capped ? 'Stopped at the cost cap before every case ran, so there is no score.' : r.error || 'No score.'}</span>` : html`<span class="cu-score-n">${pct(r.score)}</span> <span class="cu-score-l">of the graders passed${cur ? `, ${cur.passes} of ${cur.cases.length} cases fully` : ''}</span>`}</p>
        ${cur && r.k === 3 && cur.pass_at_3 !== undefined ? html`<p class="rc-note">pass@3 ${pct(cur.pass_at_3)} (a case passed at least once in 3 runs) · pass^3 ${pct(cur.pass_hat_3)} (it passed all 3)</p>` : null}`}
    <p class="rc-note">Cost: ${money(r.cost_usd)} (${money(r.judge_cost_usd)} of it the judge). ${r.label}${r.capped ? ' The cost cap stopped it.' : ''}</p>
    ${cur && cells.length === 1 ? html`<${CaseResults} cell=${cur} k=${r.k} />` : null}
    ${cells.length > 1 ? html`<${Comparison} r=${r} id=${id} onApplied=${onApplied} />` : null}
  </div>`;
}

function CaseResults({ cell, k }) {
  return html`<ul class="cu-case-results">${cell.cases.map((c) => {
    const ok = c.runs.length && c.runs.every((x) => x.passed);
    // With 3 runs, a case that passed some and failed others is flaky: say so (pass@3 vs pass^3).
    const flaky = k > 1 && c.runs.some((x) => x.passed) && c.runs.some((x) => !x.passed);
    return html`<li key=${c.id} class=${ok ? 'is-ok' : 'is-bad'} data-testid="case-result" data-case=${c.id}>
      <details><summary><span class="cu-step-mark">${ok ? 'Pass' : 'Fail'}</span> ${c.name} <span class="rc-when">${pct(c.score)}${k > 1 ? ` · ${c.runs.filter((x) => x.passed).length}/${c.runs.length} runs` : ''}</span>${flaky ? html`<span class="cu-chip tone-needs" data-testid="case-flaky" title="It passed some runs and failed others: the answer, or the judge, is not stable.">flip-flops</span>` : null}</summary>
        ${c.runs.map((run) => html`<div class="cu-run-detail" key=${run.n}>
          ${k > 1 ? html`<p class="cu-file-name">Run ${run.n}</p>` : null}
          ${run.error ? html`<p class="form-error">${run.error}</p>` : null}
          <ul class="cu-graders">${run.graders.map((g) => html`<li key=${g.name} class=${g.passed ? 'is-ok' : 'is-bad'}><strong>${g.passed ? 'Pass' : 'Fail'}</strong> ${g.name} (${g.type}): ${g.explanation}
            ${g.reasons && g.reasons.length ? html`<ul class="cu-reasons">${g.reasons.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul>` : null}</li>`)}</ul>
          ${run.denials && run.denials.length ? html`<p class="rc-note">Not allowed during the run: ${run.denials.map((d) => d.tool).join(', ')}</p>` : null}
          <details class="cu-answer"><summary>The answer</summary><p class="cu-answer-text">${run.last_message || '(no answer)'}</p></details>
          <details class="cu-timeline"><summary>Timeline (${plural(run.steps.length, 'step')}${run.num_turns ? `, ${plural(run.num_turns, 'turn')}` : ''}, ${money(run.cost_usd)})</summary>
            <ol class="cu-steps-list">${run.steps.map((st, i) => html`<li key=${i}>${st.kind === 'tool' ? html`<span class=${st.ok === false ? 'tone-bad' : ''}>${st.name}</span>${st.summary ? html` <span class="mono">${st.summary}</span>` : null}` : html`<span class="cu-say">${st.text}</span>`}</li>`)}</ol></details>
        </div>`)}
      </details></li>`;
  })}</ul>`;
}

function Comparison({ r, id, onApplied }) {
  const [busy, setBusy] = useState(false);
  const rec = r.recommendation;
  const apply = async () => {
    setBusy(true);
    try {
      const a = await api.applyModel(id, { model: rec.model, effort: rec.effort });
      toast(`New sessions use ${a.model || 'your default model'}${a.effort ? ` · ${a.effort}` : ''}. Clawdling's own setting; your Claude Code settings are unchanged.`, { tone: 'ok', ms: 5000 });
      refreshOrg();
      onApplied();
    } catch (e) {
      errorToast('Could not set the model', e);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="cu-compare" data-testid="checkup-compare">
    <table class="cu-table"><thead><tr><th scope="col">Setting</th><th scope="col">Score</th><th scope="col">Cost a run</th></tr></thead>
      <tbody>${r.cells.map((c) => html`<tr key=${c.label} class=${rec && rec.label === c.label ? 'is-rec' : ''}>
        <th scope="row">${c.label}${c.current ? html` <span class="rc-h-sub">current</span>` : null}</th>
        <td>${pct(c.score)}${c.passes !== undefined ? ` (${c.passes}/${c.cases.length})` : ''}</td><td>${money(c.cost_per_run)}</td></tr>`)}</tbody></table>
    ${rec ? rec.current ? html`<p class="cu-rec" data-testid="checkup-rec">Keep the current setting: no cheaper one held up within the noise rule.</p>`
      : html`<p class="cu-rec" data-testid="checkup-rec"><strong>${rec.label}</strong> held up and costs about ${rec.saves_pct}% less a run.
        <button type="button" class="btn btn-primary btn-sm" onClick=${apply} disabled=${busy} data-testid="checkup-use">Use this</button></p>
        <p class="rc-note">"Use this" sets ${rec.label} as the default for new sessions of this agent, in Clawdling's own agent.json. Running sessions keep theirs.</p>`
      : html`<p class="rc-note">No recommendation${r.capped ? ': the cost cap stopped the comparison' : r.judge_unreliable ? ': the judge was unreliable' : ''}.</p>`}
    <p class="rc-note">"Holds" means at most one case worse than the current setting (with 1 run per case), or inside the 95% interval of its pass rate (with 3).</p>
  </div>`;
}

function Cheaper({ v, id, onCompare }) {
  const [est, setEst] = useState(null);
  const models = v.matrix.map((c) => `${c.current ? 'current' : c.model || 'default'}:${c.effort || ''}`.replace(/:$/, '')).join(',');
  useEffect(() => {
    let live = true;
    api.evalEstimate(id, { k: v.settings.runs, models: 'default' }).then((x) => { if (live) setEst(x); }).catch(() => {});
    return () => { live = false; };
  }, [id, v.runnable, v.settings.runs]);
  if (v.matrix.length < 2) return null;
  return html`<details class="cu-cheaper" data-testid="checkup-cheaper"><summary>Try a cheaper model</summary>
    <p class="rc-note">Runs the same cases with ${listText(v.matrix.map((c) => c.label))}, then recommends the cheapest that holds up. Nothing changes until you click "Use this".</p>
    <button type="button" class="btn btn-quiet btn-sm" disabled=${!est || !!v.active || v.busy} onClick=${() => onCompare(est, models)} data-testid="checkup-compare-run">Compare ${plural(v.matrix.length, 'setting')}</button>
  </details>`;
}

