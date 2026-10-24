// Bring in your projects (overlay `import`). GET /api/discover finds folders from Claude Code's
// history, repos on this computer and, through the user's own `gh`, their GitHub repos. The person
// ticks the ones they want and each becomes a project agent: one POST /api/import per row, in
// order, so every row shows its own progress. Nothing here writes into a repo; the server only
// writes the new agent's folder (and clones a GitHub repo the person ticked).
import { html } from '../lib/html.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Modal } from './dialogs.js';
import { Icon } from './icons.js';
import { api } from '../lib/api.js';
import { refreshOrg } from '../lib/live.js';
import { closeOverlay, openOverlay, navigate, startSession, toast } from '../lib/actions.js';
import { tildify, matches, plural, relTime, longTime, toMs, coarsePointer } from '../lib/util.js';
import { DAY } from '../lib/model.js';
import { BLOCKED_TITLE, useStartBlocked } from './health-banner.js';

// What Deep onboard types into the new session: the onboard-project skill every project agent has.
export const ONBOARD_PROMPT = '/onboard-project';
const SLOW_MS = 2500; // after this, say it is still looking and offer to skip GitHub
const NEW = '__new'; // the domain picker's "New domain…": an inline name field is open
const GROUP_MAX = 12;

// "just now", "3h ago", "yesterday", "5d ago", "3 weeks ago", "4 months ago", "2 years ago"
export function ago(ts, now = Date.now()) {
  const t = toMs(ts);
  if (!t) return '';
  const days = (now - t) / DAY;
  if (days < 14) {
    const r = relTime(t, now);
    return r === 'now' ? 'just now' : r === 'yesterday' ? r : `${r} ago`;
  }
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const y = Math.round(days / 365);
  return y === 1 ? 'a year ago' : `${y} years ago`;
}

// The project agent that already has this candidate's folder (as its repo or one of its repos) or
// its remote, in `agents`: the live org, so a repo imported in another window or by the CLI while
// this screen is open stops being offered.
export function ownerIn(agents, c) {
  if (!c || !Array.isArray(agents)) return null;
  return agents.find((a) => a && (
    (c.path && (a.repo === c.path || (Array.isArray(a.repos) && a.repos.includes(c.path))))
    || (c.key && a.source && a.source.remote_key && a.source.remote_key === c.key))) || null;
}

// Recent (90 days), not archived, no agent yet, and already on this computer: ticked from the
// start. A GitHub repo that is not cloned waits for the person to tick it, because ticking it
// means downloading it.
const preChecked = (c) => !!c.recent && !c.agent && !!c.cloned && !(c.github && c.github.archived);

// Domain choices: `d:<id>` an existing domain, `n:<name>` a domain to create, NEW the inline field.
function defaultChoice(domains) {
  const work = domains.find((d) => d.id === 'work' || String(d.name).toLowerCase() === 'work');
  return work ? `d:${work.id}` : 'n:Work';
}
// A new name that now exists (made by an earlier row) is that domain.
function normChoice(v, domains) {
  if (!v || !v.startsWith('n:')) return v;
  const name = v.slice(2).toLowerCase();
  const d = domains.find((x) => String(x.name).toLowerCase() === name);
  return d ? `d:${d.id}` : v;
}
function choiceLabel(v, domains) {
  const n = normChoice(v, domains);
  if (n && n.startsWith('d:')) { const d = domains.find((x) => x.id === n.slice(2)); return d ? d.name : n.slice(2); }
  if (n && n.startsWith('n:')) return `${n.slice(2)} (new)`;
  return '';
}
function domainFields(v, domains) {
  const n = normChoice(v, domains);
  if (n && n.startsWith('d:')) return { domain: n.slice(2) };
  if (n && n.startsWith('n:')) return { new_domain: n.slice(2) };
  return {};
}

// Where a clone goes, as the server names it: <clone_root>/<name>, in clone_root's own separator.
const cloneDest = (root, name) => `${root}${root.includes('\\') && !root.includes('/') ? '\\' : '/'}${name}`;

// The body for one row. A GitHub repo that is not on this computer is cloned first (clone: true).
function itemBody(c, choice, domains) {
  const body = {};
  if (c.cloned && c.path) body.path = c.path;
  else { body.clone = true; body.url = c.remote || (c.github && c.github.url) || undefined; }
  if (c.github && c.github.nameWithOwner) body.github = c.github.nameWithOwner;
  return { ...body, ...domainFields(choice, domains) };
}

function useFocusOnPhase(phase, scope) {
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const root = scope.current && scope.current.closest('.modal');
      const el = root && root.querySelector('[data-phase-focus]');
      if (!el) return;
      // On a touch screen a focused field raises the keyboard over the list: focus the dialog.
      if (coarsePointer() && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) root.focus();
      else el.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [phase]);
}

export function ImportScreen() {
  const agents = useStore((s) => s.agents);
  const agentsById = useStore((s) => s.agentsById);
  const now = useStore((s) => s.now);
  const domains = useMemo(() => agents.filter((a) => a.kind === 'domain'), [agents]);
  const projects = useMemo(() => agents.filter((a) => a.kind === 'project'), [agents]);
  const [phase, setPhase] = useState('loading'); // loading | error | pick | running | done
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [slow, setSlow] = useState(false);
  const [askedGh, setAskedGh] = useState(true);
  const [rows, setRowsState] = useState({}); // key -> {checked, domain, prev, status, error, agent, cloned, reason}
  const rowsRef = useRef(rows);
  const [newNames, setNewNames] = useState(() => (defaultChoice(domains).startsWith('n:') ? ['Work'] : []));
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(null); // null = recent only, unless nothing is recent
  const [grouping, setGrouping] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupDomain, setGroupDomain] = useState('');
  const [run, setRun] = useState(null); // {keys, group: {name, domain}|null, at: index}
  const [onboarded, setOnboarded] = useState({});
  const [stopping, setStopping] = useState(false);
  const seq = useRef(0);
  const stop = useRef(false);
  const body = useRef(null);
  const blocked = useStartBlocked();

  const setRows = (fn) => {
    const next = typeof fn === 'function' ? fn(rowsRef.current) : fn;
    rowsRef.current = next;
    setRowsState(next);
  };
  const patchRow = (key, patch) => setRows((r) => ({ ...r, [key]: { ...r[key], ...patch } }));

  const load = async ({ refresh = false, github = true, keep = true } = {}) => {
    const my = ++seq.current;
    setPhase('loading');
    setSlow(false);
    setErr('');
    setAskedGh(github);
    const timer = setTimeout(() => { if (seq.current === my && github) setSlow(true); }, SLOW_MS);
    try {
      const r = await api.discover({ github, refresh });
      if (seq.current !== my) return;
      const list = Array.isArray(r && r.candidates) ? r.candidates : [];
      const dflt = defaultChoice(domains);
      const prev = keep ? rowsRef.current : {};
      const next = {};
      for (const c of list) {
        const p = prev[c.key];
        next[c.key] = p && !p.status ? p : { checked: preChecked(c), domain: dflt, status: null };
      }
      setRows(next);
      setData({ ...r, candidates: list });
      setPhase('pick');
    } catch (e) {
      if (seq.current !== my) return;
      setErr(e && e.status === 404 ? 'unsupported' : (e && e.message) || 'unknown error');
      setPhase('error');
    } finally {
      clearTimeout(timer);
    }
  };
  useEffect(() => { load(); return () => { seq.current += 1; }; }, []);
  useFocusOnPhase(phase, body);

  const all = data ? data.candidates : [];
  const recentCount = all.filter((c) => c.recent).length;
  const wide = showAll === null ? recentCount === 0 : showAll;
  // The agent a row already has: what discovery said, or what the live org says now.
  const ownerOf = (c) => (c.agent ? agentsById[c.agent.id] || c.agent : ownerIn(projects, c));
  const isAgent = (c) => !!ownerOf(c) || (rows[c.key] && (rows[c.key].status === 'created' || rows[c.key].status === 'skipped'));
  const picked = all.filter((c) => rows[c.key] && rows[c.key].checked && !isAgent(c));
  const searching = !!q.trim();
  const visible = phase === 'running' || phase === 'done'
    ? all.filter((c) => run && run.keys.includes(c.key))
    : searching ? all.filter((c) => matches(q, c.name, c.path && tildify(c.path), c.github && c.github.nameWithOwner, c.description, c.language))
    : wide ? all : all.filter((c) => c.recent || (rows[c.key] && rows[c.key].checked));
  const hiddenPicked = picked.filter((c) => !visible.includes(c)).length;
  const groupable = picked.length >= 2 && picked.length <= GROUP_MAX && picked.every((c) => c.cloned && c.path);
  const cloneRoot = tildify((data && data.clone_root) || '') || '~/code';

  // A repo that became an agent somewhere else while this screen is open: untick it (its row is
  // disabled and says "Already an agent: <name>"), so it is not made twice.
  useEffect(() => {
    if (phase !== 'pick') return;
    const r = rowsRef.current;
    const gone = all.filter((c) => r[c.key] && r[c.key].checked && ownerIn(projects, c));
    if (!gone.length) return;
    setRows((x) => {
      const next = { ...x };
      for (const c of gone) next[c.key] = { ...next[c.key], checked: false };
      return next;
    });
  }, [projects, phase, data]);
  // "One agent for these N" needs 2 or more ticked: close its form when that stops being true.
  useEffect(() => { if (grouping && !groupable) setGrouping(false); }, [grouping, groupable]);

  const toggle = (c, on) => patchRow(c.key, { checked: on });
  const choose = (c, v) => {
    const r = rowsRef.current[c.key];
    if (v === NEW) patchRow(c.key, { domain: NEW, prev: r.domain });
    else patchRow(c.key, { domain: v, prev: null });
  };
  const commitNew = (c, name) => {
    const r = rowsRef.current[c.key];
    const n = name.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!n) { patchRow(c.key, { domain: r.prev || defaultChoice(domains), prev: null }); return; }
    const existing = domains.find((d) => String(d.name).toLowerCase() === n.toLowerCase());
    if (!existing && !newNames.some((x) => x.toLowerCase() === n.toLowerCase())) setNewNames([...newNames, n]);
    patchRow(c.key, { domain: existing ? `d:${existing.id}` : `n:${n}`, prev: null });
  };

  // ---- creating
  const importRow = async (c, choice) => {
    patchRow(c.key, { status: c.cloned ? 'creating' : 'cloning', error: '' });
    try {
      const res = await api.importProject(itemBody(c, choice, domains));
      if (res && res.skipped) patchRow(c.key, { status: 'skipped', agent: res.agent || null, reason: res.reason || '' });
      else patchRow(c.key, { status: 'created', agent: (res && res.agent) || null, cloned: !!(res && res.cloned) });
    } catch (e) {
      patchRow(c.key, { status: 'failed', error: (e && e.message) || 'Something went wrong.' });
    }
  };

  const create = async () => {
    const list = picked;
    if (!list.length) return;
    stop.current = false;
    setStopping(false);
    setGrouping(false);
    setRun({ keys: list.map((c) => c.key), group: null, at: 0 });
    setRows((r) => {
      const next = { ...r };
      for (const c of list) next[c.key] = { ...next[c.key], status: 'waiting', error: '' };
      return next;
    });
    setPhase('running');
    for (let i = 0; i < list.length; i += 1) {
      if (stop.current) break;
      setRun((x) => ({ ...x, at: i }));
      await importRow(list[i], rowsRef.current[list[i].key].domain);
    }
    await refreshOrg();
    setPhase('done');
  };

  const openGroup = () => {
    setGrouping(true);
    setGroupDomain(rowsRef.current[picked[0].key].domain || defaultChoice(domains));
  };
  const createGroup = async () => {
    const name = groupName.trim();
    const list = picked;
    if (!name || !groupable) return;
    stop.current = false;
    setGrouping(false);
    setRun({ keys: list.map((c) => c.key), group: { name, domain: groupDomain }, at: 0 });
    setRows((r) => {
      const next = { ...r };
      for (const c of list) next[c.key] = { ...next[c.key], status: 'creating', error: '' };
      return next;
    });
    setPhase('running');
    await runGroup(list, name, groupDomain);
    await refreshOrg();
    setPhase('done');
  };
  // Every repo in the group already has an agent: nothing is made, and each row points at the
  // agent that has its repo. The server answers 200 {skipped, agent, agents}; an older one answered
  // 409, so then the live org says which agents they are (Results looks again after the refresh).
  const skippedFor = (res) => {
    const known = [...(Array.isArray(res.agents) ? res.agents : []), ...(res.agent ? [res.agent] : [])];
    return (c) => ({ status: 'skipped', reason: res.reason || '', agent: ownerIn(known, c) || ownerIn(projects, c) || null });
  };
  const runGroup = async (list, name, domain) => {
    let patchFor;
    try {
      const res = await api.importProject({ group: { name, ...domainFields(domain, domains) }, items: list.map((c) => ({ path: c.path })) });
      if (res && res.skipped) patchFor = skippedFor(res);
      else { const p = { status: 'created', agent: (res && res.agent) || null }; patchFor = () => p; }
    } catch (e) {
      if (e && e.status === 409) patchFor = skippedFor({ reason: e.message });
      else { const p = { status: 'failed', error: (e && e.message) || 'Something went wrong.' }; patchFor = () => p; }
    }
    setRows((r) => {
      const next = { ...r };
      for (const c of list) next[c.key] = { ...next[c.key], ...patchFor(c) };
      return next;
    });
  };

  const retry = async (c) => {
    if (run && run.group) {
      const list = all.filter((x) => run.keys.includes(x.key));
      setRows((r) => {
        const next = { ...r };
        for (const x of list) next[x.key] = { ...next[x.key], status: 'creating', error: '' };
        return next;
      });
      await runGroup(list, run.group.name, run.group.domain);
    } else {
      await importRow(c, rowsRef.current[c.key].domain);
    }
    refreshOrg();
  };

  const again = () => {
    setRun(null);
    setOnboarded({});
    setQ('');
    load({ refresh: true, keep: false });
  };

  const close = () => {
    if (phase === 'running') {
      stop.current = true;
      toast('Stopped after the project being made right now. Agents already made stay in your org.', { ms: 5200 });
    }
    closeOverlay();
  };

  const onboard = async (agent, single) => {
    setOnboarded((o) => ({ ...o, [agent.id]: 'starting' }));
    if (single) closeOverlay();
    try {
      await startSession(agent.id, { prompt: ONBOARD_PROMPT, title: 'Deep onboard' });
      setOnboarded((o) => ({ ...o, [agent.id]: 'started' }));
      if (!single) toast(`Deep onboard started for ${agent.name}. Its session is in the cockpit.`, { tone: 'ok', ms: 4200 });
    } catch {
      setOnboarded((o) => ({ ...o, [agent.id]: null })); // the toast already says why
    }
  };
  const open = (id) => { closeOverlay(); navigate(`#/agent/${encodeURIComponent(id)}`); };

  // ---- render
  const runRows = run ? all.filter((c) => run.keys.includes(c.key)) : [];
  const current = phase === 'running' && run ? runRows[run.at] : null;

  if (phase === 'done' && run) {
    return html`<${Modal} labelledby="imp-title" onClose=${close} size="xl" class="import-screen">
      <${Results} run=${run} runRows=${runRows} rows=${rows} agentsById=${agentsById} lookup=${(c) => ownerIn(projects, c)} onboarded=${onboarded} blocked=${blocked}
        onOpen=${open} onOnboard=${onboard} onRetry=${retry} onAgain=${again} onDone=${closeOverlay} scope=${body} />
    </${Modal}>`;
  }

  return html`<${Modal} labelledby="imp-title" onClose=${close} size="xl" class=${`import-screen ${phase === 'pick' ? 'is-picking' : ''}`}>
    <div class="modal-head imp-head" ref=${body}>
      <h2 id="imp-title" class="modal-title">${phase === 'running' ? 'Creating your project agents' : 'Bring in your projects'}</h2>
      <p class="modal-text">${phase === 'running'
        ? 'One at a time. Each agent gets notes drafted from its repo. Nothing in your repos changes.'
        : 'Tick the projects you want an agent for. Each agent knows its repo, how to run it and what changed lately. Nothing in your repos changes.'}</p>
    </div>
    <div class="modal-body imp-body" data-testid="import-screen" data-phase=${phase}>
      ${phase === 'loading' ? html`<${Loading} slow=${slow} github=${askedGh} onSkip=${() => load({ github: false })} />`
        : phase === 'error' ? html`<div class="imp-error-box" role="alert">
            <p class="form-error"><${Icon} name="alert" size=${14} /> ${err === 'unsupported'
              ? "This Clawdling server can't look for projects yet. Update Clawdling, then try again."
              : `Couldn't look for your projects: ${err}`}</p>
            <button class="btn btn-quiet" onClick=${() => load({ refresh: true })} data-phase-focus data-testid="imp-try-again">Try again</button>
          </div>`
        : html`
          ${phase === 'pick' ? html`<${Sources} data=${data} asked=${askedGh} onRefresh=${() => load({ refresh: true })} />` : null}
          ${phase === 'pick' && all.length ? html`<div class="imp-toolbar">
            <div class="imp-search">
              <${Icon} name="search" />
              <input type="search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} placeholder="Search by name or folder"
                aria-label="Search your projects" data-own-escape=${searching ? true : undefined} data-phase-focus data-testid="imp-search"
                onKeyDown=${(e) => { if (e.key === 'Escape' && searching) { e.preventDefault(); setQ(''); } }} />
            </div>
            <span class="imp-count" aria-live="polite" data-testid="imp-count">${searching ? `${plural(visible.length, 'match', 'matches')} in all ${all.length}`
              : wide ? (recentCount ? `All ${all.length} projects` : `Nothing from the last 90 days, so all ${all.length} projects`)
              : `${plural(recentCount, 'project')} active in the last 90 days`}</span>
            ${!searching && recentCount && recentCount < all.length ? html`<button class="link-btn" onClick=${() => setShowAll(!wide)} data-testid="imp-show-all">
              ${wide ? 'Recent only' : `Show all ${all.length}`}</button>` : null}
          </div>` : null}
          ${phase === 'pick' && !all.length ? html`<div class="notice imp-none" data-testid="imp-none">
            <p>Clawdling didn't find any projects in the places above.</p>
            <p>You can still make a project agent by hand and point it at any folder.</p>
            <button class="btn btn-quiet" onClick=${() => openOverlay({ type: 'wizard' })} data-phase-focus><${Icon} name="user-plus" /> New agent</button>
          </div>` : null}
          ${visible.length ? html`<div class=${`imp-list-wrap ${phase === 'running' ? 'is-running' : ''}`}>
            <div class="imp-cols" aria-hidden="true"><span>Project</span><span>Last active</span><span>Domain</span>${phase === 'running' ? html`<span>Status</span>` : null}</div>
            <ul class="imp-list" aria-label="Projects">
              ${visible.map((c) => html`<${CandidateRow} key=${c.key} c=${c} row=${rows[c.key] || {}} phase=${phase} now=${now}
                domains=${domains} newNames=${newNames} cloneRoot=${cloneRoot} owner=${phase === 'pick' ? ownerOf(c) : null} agentsById=${agentsById}
                onToggle=${toggle} onChoose=${choose} onCommitNew=${commitNew} onOpen=${open} />`)}
            </ul>
          </div>` : phase === 'pick' && all.length ? html`<p class="panel-quiet imp-nomatch">Nothing matches “${q.trim()}”.</p>` : null}`}
    </div>
    ${grouping && phase === 'pick' && groupable ? html`<${GroupForm} n=${picked.length} names=${picked.map((c) => c.name)} name=${groupName} setName=${setGroupName}
      domain=${groupDomain} setDomain=${setGroupDomain} domains=${domains} newNames=${newNames} onBack=${() => setGrouping(false)} onCreate=${createGroup} />`
      : html`<div class="modal-foot imp-foot">
        <span class="imp-foot-note" role="status" aria-live="polite" data-testid="imp-progress">${phase === 'running'
          ? (run.group ? `Creating ${run.group.name} for ${plural(runRows.length, 'project')}`
            : stopping ? `Stopping after ${current ? current.name : 'this one'}…`
            : current ? `${current.cloned ? 'Creating' : 'Cloning and creating'} ${run.at + 1} of ${runRows.length}: ${current.name}` : '')
          : phase === 'pick' ? (picked.length ? `${plural(picked.length, 'project')} ticked${hiddenPicked ? ` (${hiddenPicked} not shown)` : ''}` : all.length ? 'Tick at least one project' : '')
          : ''}</span>
        ${phase === 'running' ? html`<button class="btn btn-quiet" onClick=${() => { stop.current = true; setStopping(true); }} disabled=${!!(run && run.group) || stopping}
            data-phase-focus data-testid="imp-stop">${stopping ? 'Stopping…' : 'Stop after this one'}</button>
          <button class="btn btn-primary" disabled>Creating…</button>`
        : html`<button class="btn btn-quiet" onClick=${close}>Cancel</button>
          ${phase === 'pick' && picked.length >= 2 ? html`<button class="btn btn-quiet" onClick=${openGroup} disabled=${!groupable} data-testid="imp-group"
            title=${groupable ? 'One project agent that works across all of these repos' : picked.length > GROUP_MAX ? `One agent can hold up to ${GROUP_MAX} repos` : 'Works only when every ticked project is already on this computer'}>
            One agent for these ${picked.length}</button>` : null}
          ${phase === 'pick' ? html`<button class="btn btn-primary" onClick=${create} disabled=${!picked.length} data-testid="imp-create">
            Create ${picked.length || ''} project ${picked.length === 1 ? 'agent' : 'agents'}</button>` : null}`}
      </div>`}
  </${Modal}>`;
}

function Loading({ slow, github, onSkip }) {
  return html`<div class="imp-loading" role="status" aria-live="polite" data-testid="imp-loading">
    <p class="imp-loading-title"><span class="imp-spin" aria-hidden="true"></span> Looking for your projects…</p>
    <p class="panel-quiet">Reading Claude Code's history and the folders on this computer${github ? ', and asking GitHub through gh' : ''}. Nothing leaves this computer.</p>
    ${slow ? html`<p class="imp-slow" data-testid="imp-slow">Still looking… Asking GitHub can take a few seconds. <button class="link-btn" onClick=${onSkip} data-phase-focus data-testid="imp-skip-github">Skip GitHub this time</button></p>` : null}
    <div class="imp-skel" aria-hidden="true">${[0, 1, 2, 3].map(() => html`<div class="panel-skel imp-skel-row"></div>`)}</div>
  </div>`;
}

// Where it looked, in plain words, and what to do about GitHub when it is not connected.
function Sources({ data, asked, onRefresh }) {
  const s = (data && data.sources) || {};
  const claude = s.claude || {};
  const local = s.local || {};
  const gh = s.github;
  const roots = Array.isArray(local.roots) ? local.roots.map(tildify) : [];
  let ghTone = 'ok';
  let ghText;
  const showing = 'Showing folders on this computer.';
  if (!asked || !gh || gh.skipped) {
    ghTone = 'off';
    ghText = html`skipped this time. <button class="link-btn" onClick=${onRefresh}>Ask GitHub</button> to see repos you haven't cloned.`;
  } else if (gh.installed === false) {
    ghTone = 'warn';
    ghText = html`not connected. Install <a href="https://cli.github.com" target="_blank" rel="noopener">GitHub CLI</a> and run <code>gh auth login</code> to see repos you haven't cloned. ${showing}`;
  } else if (gh.authed === false) {
    ghTone = 'warn';
    ghText = html`GitHub CLI is installed but not signed in. Run <code>gh auth login</code> in a terminal, then Look again, to see repos you haven't cloned. ${showing}`;
  } else if (gh.error) {
    ghTone = 'warn';
    ghText = html`couldn't list your repos (${gh.error}). ${showing}`;
  } else {
    ghText = html`signed in as <strong>${gh.user || 'you'}</strong> · ${plural(Number(gh.found) || 0, 'repo')}`;
  }
  return html`<section class="imp-sources" aria-label="Where Clawdling looked" data-testid="imp-sources">
    <ul>
      <li class="src-ok" data-source="claude"><span class="src-icon"><${Icon} name="clock" size=${14} /></span>
        <span><strong>Claude Code</strong>: ${Number(claude.found) ? `${plural(Number(claude.found), 'folder')} you've worked in` : "no folders you've worked in yet"}</span></li>
      <li class=${roots.length ? 'src-ok' : 'src-off'} data-source="local"><span class="src-icon"><${Icon} name="monitor" size=${14} /></span>
        <span><strong>This computer</strong>: ${roots.length ? html`${plural(Number(local.found) || 0, 'repo')} in ${roots.map((r, i) => html`${i ? ', ' : ''}<code>${r}</code>`)}`
          : html`none of the usual code folders exist (like <code>~/code</code> or <code>~/projects</code>)`}</span></li>
      <li class=${`src-${ghTone}`} data-source="github" data-gh=${ghTone}><span class="src-icon"><${Icon} name="cloud" size=${14} /></span>
        <span><strong>GitHub</strong>: ${ghText}</span></li>
    </ul>
    <button class="btn btn-quiet btn-sm imp-refresh" onClick=${onRefresh} data-testid="imp-refresh"><${Icon} name="refresh" size=${14} /> Look again</button>
  </section>`;
}

function DomainPicker({ value, domains, newNames, onChoose, onCommitNew, label, testid = 'imp-domain' }) {
  if (value === NEW) return html`<${NewDomainField} label=${label} onCommit=${onCommitNew} />`;
  const norm = normChoice(value, domains);
  const extra = newNames.filter((n) => !domains.some((d) => String(d.name).toLowerCase() === n.toLowerCase()));
  return html`<select class="imp-select" value=${norm} onChange=${(e) => onChoose(e.currentTarget.value)} aria-label=${label} data-testid=${testid}>
    ${domains.map((d) => html`<option value=${`d:${d.id}`}>${d.name}</option>`)}
    ${extra.map((n) => html`<option value=${`n:${n}`}>${n} (new)</option>`)}
    ${norm && norm.startsWith('n:') && !extra.some((n) => `n:${n}` === norm) ? html`<option value=${norm}>${norm.slice(2)} (new)</option>` : null}
    <option value=${NEW}>New domain…</option>
  </select>`;
}

// "New domain…": type the name right in the row. Enter or leaving the field keeps it; Escape or
// an empty name goes back to what was picked before.
function NewDomainField({ label, onCommit }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => { if (ref.current) ref.current.focus(); }, []);
  const finish = (value) => { if (done.current) return; done.current = true; onCommit(value); };
  return html`<input ref=${ref} class="imp-new-domain" value=${text} maxLength="60" placeholder="Name the new domain"
    aria-label=${`${label}: name of the new domain`} data-own-escape data-testid="imp-new-domain" autocomplete="off"
    onInput=${(e) => setText(e.currentTarget.value)} onBlur=${() => finish(text)}
    onKeyDown=${(e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(text); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(''); }
    }} />`;
}

const STATUS_TEXT = { waiting: 'Waiting', cloning: 'Cloning…', creating: 'Creating…', created: 'Created', skipped: 'Already an agent', failed: "Didn't work" };

// `owner`: the agent this repo already has (while picking), from discovery or the live org.
function CandidateRow({ c, row, phase, now, domains, newNames, cloneRoot, owner, agentsById, onToggle, onChoose, onCommitNew, onOpen }) {
  const id = `imp-${c.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const picking = phase === 'pick';
  const gh = c.github;
  const status = row.status;
  // Once made, the folder the agent really got (a clone may land in <name>-2).
  const madeAt = status === 'created' && row.agent && row.agent.repo;
  const where = madeAt ? html`<span class="mono">${tildify(madeAt)}</span>${row.cloned ? ' · cloned just now' : ''}`
    : c.cloned && c.path ? html`<span class="mono">${tildify(c.path)}</span>`
    : html`GitHub · not on this computer yet · will clone to <span class="mono">${cloneDest(cloneRoot, c.name)}</span>`;
  const busy = status === 'cloning' || status === 'creating';
  return html`<li class=${`imp-row ${row.checked && !owner ? 'is-checked' : ''} ${owner ? 'is-agent' : ''}`} data-candidate=${c.name}
      data-key=${c.key} data-status=${status || ''}>
    <label class="imp-main">
      <input type="checkbox" checked=${!!row.checked && !owner} disabled=${!picking || !!owner} aria-label=${c.name}
        aria-describedby=${`${id}-where`} onChange=${(e) => onToggle(c, e.currentTarget.checked)} data-testid="imp-check" />
      <span class="imp-text">
        <span class="imp-name-line">
          <span class="imp-name">${c.name}</span>
          ${c.language ? html`<span class="imp-badge">${c.language}</span>` : null}
          ${gh ? html`<span class="imp-badge" title=${gh.private ? 'Only you (and people you invite) can see it on GitHub' : 'Anyone can see it on GitHub'}>${gh.private ? 'Private' : 'Public'}</span>` : null}
          ${(c.sources || []).includes('claude') ? html`<span class="imp-badge is-claude" title=${`You've used Claude Code here${c.last_claude_session_at ? `, last ${ago(c.last_claude_session_at, now)}` : ''}`}>Claude Code</span>` : null}
          ${c.has && c.has.claude_md ? html`<span class="imp-badge" title="It has its own CLAUDE.md, which Claude Code reads in every session there">CLAUDE.md</span>` : null}
          ${c.monorepo ? html`<span class="imp-badge" title="Several packages in one repo: one agent for all of it">Monorepo</span>` : null}
          ${gh && gh.archived ? html`<span class="imp-badge is-muted" title="Archived on GitHub: read-only">Archived</span>` : null}
          ${gh && gh.fork ? html`<span class="imp-badge is-muted">Fork</span>` : null}
        </span>
        <span class="imp-where" id=${`${id}-where`}>${where}</span>
        ${c.description ? html`<span class="imp-desc" title=${c.description}>${c.description}</span>` : null}
      </span>
    </label>
    <span class="imp-when" title=${c.last_activity_at ? `Last activity ${longTime(c.last_activity_at)}` : undefined}>${ago(c.last_activity_at, now)}</span>
    <span class="imp-domain">
      ${owner ? html`<span class="imp-agent" data-testid="imp-agent">Already an agent: <button class="link-btn" onClick=${() => onOpen(owner.id)}>${owner.name}</button></span>`
        : picking && row.checked ? html`<${DomainPicker} value=${row.domain} domains=${domains} newNames=${newNames} label=${`Domain for ${c.name}`}
            onChoose=${(v) => onChoose(c, v)} onCommitNew=${(v) => onCommitNew(c, v)} />`
        : picking ? null
        : html`<span class="imp-domain-text">${status === 'created' || status === 'skipped' ? (agentsById[row.agent && row.agent.domain] || {}).name || choiceLabel(row.domain, domains) : choiceLabel(row.domain, domains)}</span>`}
    </span>
    ${phase === 'running' ? html`<span class=${`imp-status st-${status || 'none'}`} data-testid="imp-status">
      ${busy ? html`<span class="imp-spin" aria-hidden="true"></span>` : status === 'created' ? html`<${Icon} name="check" size=${14} />` : status === 'failed' ? html`<${Icon} name="alert" size=${14} />` : null}
      <span>${STATUS_TEXT[status] || ''}</span>
    </span>` : null}
    ${phase === 'running' && status === 'failed' && row.error ? html`<p class="imp-row-error" role="alert">${row.error}</p>` : null}
  </li>`;
}

function GroupForm({ n, names, name, setName, domain, setDomain, domains, newNames, onBack, onCreate }) {
  const [localNew, setLocalNew] = useState([]);
  const ref = useRef(null);
  useEffect(() => { const id = requestAnimationFrame(() => { if (ref.current && !coarsePointer()) ref.current.focus(); }); return () => cancelAnimationFrame(id); }, []);
  const ok = name.trim().length > 0;
  return html`<form class="imp-group" data-testid="imp-group-form" onSubmit=${(e) => { e.preventDefault(); if (ok) onCreate(); }}>
    <p class="imp-group-lead"><strong>One agent for ${n} projects.</strong> Its sessions open with all of them: ${names.join(', ')}.</p>
    <div class="imp-group-fields">
      <label class="field">
        <span class="field-label">Name</span>
        <input ref=${ref} value=${name} onInput=${(e) => setName(e.currentTarget.value)} maxLength="60" placeholder="e.g. Online shop"
          data-own-escape data-testid="imp-group-name" autocomplete="off"
          onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); onBack(); } }} />
      </label>
      <label class="field">
        <span class="field-label">Domain</span>
        <${DomainPicker} value=${domain} domains=${domains} newNames=${[...newNames, ...localNew]} label="Domain for the one agent" testid="imp-group-domain"
          onChoose=${setDomain} onCommitNew=${(v) => { const t = v.trim(); if (t) { setLocalNew([...localNew, t]); setDomain(`n:${t}`); } else setDomain(defaultChoice(domains)); }} />
      </label>
    </div>
    <div class="imp-group-actions">
      <button type="button" class="btn btn-quiet" onClick=${onBack}>Back</button>
      <button type="submit" class="btn btn-primary" disabled=${!ok} data-testid="imp-group-create">Create one agent</button>
    </div>
  </form>`;
}

// `lookup(c)`: the live org's agent for a row, for a skipped row whose answer did not name one.
function Results({ run, runRows, rows, agentsById, lookup, onboarded, blocked, onOpen, onOnboard, onRetry, onAgain, onDone, scope }) {
  const created = [];
  const skipped = [];
  const failed = [];
  const seen = new Set();
  for (const c of runRows) {
    const r = rows[c.key] || {};
    if (r.status === 'failed') { failed.push({ c, r }); continue; }
    if (r.status !== 'created' && r.status !== 'skipped') continue;
    const agent = r.agent || (r.status === 'skipped' && lookup ? lookup(c) : null);
    const id = agent ? agent.id : `?${c.key}`;
    if (seen.has(id)) continue; // a group makes one agent for every row
    seen.add(id);
    if (r.status === 'created' && agent) created.push({ c, r });
    else if (r.status === 'skipped') skipped.push({ c, r, agent });
  }
  const working = runRows.some((c) => rows[c.key] && (rows[c.key].status === 'creating' || rows[c.key].status === 'cloning'));
  const stopped = runRows.filter((c) => rows[c.key] && rows[c.key].status === 'waiting');
  const n = created.length;
  const title = run.group ? (n ? `${created[0].r.agent.name} is ready` : skipped.length && !failed.length ? 'Already in your org' : `Couldn't make ${run.group.name}`)
    : n === 0 ? (failed.length ? 'No agent was made' : stopped.length ? 'Stopped before any agent was made' : 'Already in your org')
    : failed.length || stopped.length ? [`${plural(n, 'project agent')} ${n === 1 ? 'is' : 'are'} ready`,
      failed.length ? `${failed.length} didn't work` : '', stopped.length ? `${stopped.length} stopped` : ''].filter(Boolean).join(', ')
    : n === 1 ? `${created[0].r.agent.name} is ready` : `${n} project agents are ready`;
  const single = n === 1 && !failed.length;
  return html`
    <div class="modal-head wz-done imp-done-head" ref=${scope}>
      <span class=${`wz-done-icon ${n ? '' : 'is-warn'}`}><${Icon} name=${n ? 'check' : 'alert'} size=${18} /></span>
      <h2 id="imp-title" class="modal-title" tabindex="-1" data-phase-focus data-testid="imp-done-title">${title}</h2>
      <p class="modal-text">${n
        ? `${n === 1 ? 'It starts' : 'Each one starts'} with notes drafted from ${run.group ? 'its repos' : 'its repo'}: what it is, how to run it and what changed lately. Nothing in your repos changed.`
        : failed.length ? 'Nothing was made. The reason is under each project; fix it and try again.' : 'Each of these projects is already an agent. Nothing new was made.'}</p>
    </div>
    <div class="modal-body imp-body" data-testid="import-screen" data-phase="done">
      ${n ? html`<p class="imp-onboard-note" id="imp-onboard-note"><${Icon} name="spark" size=${14} />
        <span><strong>Deep onboard</strong> starts a Claude Code session that reads the repo and improves this agent's notes. Uses your Claude plan.</span></p>` : null}
      <ul class="imp-results" aria-label="Results">
        ${created.map(({ c, r }) => {
          const a = agentsById[r.agent.id] || r.agent;
          const dom = a.domain && agentsById[a.domain];
          const state = onboarded[a.id];
          return html`<li class="imp-result" data-result=${a.id} key=${a.id}>
            <span class="imp-result-icon"><${Icon} name="folder" size=${16} /></span>
            <span class="imp-result-text">
              <span class="imp-result-name">${a.name}</span>
              <span class="imp-result-meta">${dom ? `in ${dom.name} · ` : ''}${run.group ? plural(runRows.length, 'repo')
                : html`<span class="mono" data-testid="imp-result-repo">${tildify(r.agent.repo || a.repo || c.path || '')}</span>${r.cloned ? ' · cloned just now' : ''}`}</span>
            </span>
            <span class="imp-result-actions">
              <button class="btn btn-quiet btn-sm" onClick=${() => onOpen(a.id)} data-testid="imp-open">Open</button>
              <button class="btn btn-quiet btn-sm" onClick=${() => onOnboard(a, single)} disabled=${blocked || !!state}
                title=${blocked ? BLOCKED_TITLE : undefined} aria-describedby="imp-onboard-note" data-testid="imp-onboard">
                ${state === 'started' ? html`<${Icon} name="check" size=${12} /> Started` : state === 'starting' ? 'Starting…' : 'Deep onboard'}</button>
            </span>
          </li>`;
        })}
        ${skipped.map(({ c, agent }) => html`<li class="imp-result is-skipped" data-result=${agent ? agent.id : undefined} data-skipped=${c.name}
            key=${`s-${agent ? agent.id : c.key}`}>
          <span class="imp-result-icon"><${Icon} name="folder" size=${16} /></span>
          <span class="imp-result-text"><span class="imp-result-name">${agent ? (agentsById[agent.id] || agent).name : c.name}</span>
            <span class="imp-result-meta">Already an agent: ${agent ? (agentsById[agent.id] || agent).name : c.name}. Nothing new was made.</span></span>
          ${agent ? html`<span class="imp-result-actions"><button class="btn btn-quiet btn-sm" onClick=${() => onOpen(agent.id)}>Open</button></span>` : null}
        </li>`)}
        ${(run.group ? failed.slice(0, 1) : failed).map(({ c, r }) => html`<li class="imp-result is-failed" data-failed=${run.group ? run.group.name : c.name} key=${`f-${c.key}`}>
          <span class="imp-result-icon"><${Icon} name="alert" size=${16} /></span>
          <span class="imp-result-text"><span class="imp-result-name">${run.group ? run.group.name : c.name}</span>
            <span class="imp-result-error" role="alert" data-testid="imp-error">${r.error}</span></span>
          <span class="imp-result-actions"><button class="btn btn-quiet btn-sm" onClick=${() => onRetry(c)} disabled=${working} data-testid="imp-retry">
            <${Icon} name="refresh" size=${12} /> Try again</button></span>
        </li>`)}
        ${working ? html`<li class="imp-result is-working" role="status"><span class="imp-spin" aria-hidden="true"></span><span class="imp-result-meta">Trying again…</span></li>` : null}
        ${stopped.length ? html`<li class="imp-result is-skipped"><span class="imp-result-icon"><${Icon} name="x" size=${16} /></span>
          <span class="imp-result-text"><span class="imp-result-meta">Stopped before ${stopped.map((c) => c.name).join(', ')}.</span></span></li>` : null}
      </ul>
    </div>
    <div class="modal-foot">
      <button class="btn btn-quiet" onClick=${onAgain} disabled=${working} data-testid="imp-again">Bring in more</button>
      <span class="foot-spacer"></span>
      <button class="btn btn-primary" onClick=${onDone} data-testid="imp-done">Done</button>
    </div>`;
}
