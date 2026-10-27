// Setup safety (1.8): the lethal trifecta per agent, on the Setup card in Settings, and as a small
// shield on the org map and on each report card. GET /api/setup/safety is names only, read from
// files on this computer; nothing is sent and nothing is changed. Fixes are text to apply yourself.
// Two local choices are the owner's alone (the server refuses them from the CLI): accept a risk
// with a reason (red becomes amber), and say what an unknown MCP server can do.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { api } from '../lib/api.js';
import { navigate, toast, errorToast } from '../lib/actions.js';
import { AgentIcon } from './icons.js';

export const USER_ROW = '_user';
export const CAP_TITLE = { private: 'Private data', untrusted: 'Untrusted input', sends: 'Sends out' };
const CAP_HINT = {
  private: 'what it can read that is yours',
  untrusted: 'what it reads that someone else wrote',
  sends: 'how it can send data out',
};
export const SHIELD_WORD = { red: 'Lethal trifecta', amber: 'Review', green: 'No trifecta found by name' };
const LINK = 'https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/';

// ---- data: one read shared by Settings, the map and the report cards
let cache = null;
let inflight = null;
const listeners = new Set();
function publish(d) {
  cache = d;
  for (const fn of listeners) fn(d);
}
export function loadSafety({ force = false } = {}) {
  if (inflight && !force) return inflight;
  const p = api.safety().then((d) => {
    publish(d && typeof d === 'object' ? d : { rows: [] });
    return cache;
  }).finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}
export function useSafety(enabled = true) {
  const agents = useStore((s) => s.agents);
  const [state, setS] = useState(() => ({ data: cache, err: '' }));
  useEffect(() => {
    const fn = (d) => setS({ data: d, err: '' });
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  // The org changed (an agent added, a repo linked): read again.
  const key = (Array.isArray(agents) ? agents : []).map((a) => `${a.id}:${a.repo || ''}:${a.permission_mode || ''}`).join('|');
  useEffect(() => {
    if (!enabled) return;
    loadSafety({ force: true }).catch((e) => setS((s) => ({ ...s, err: e && e.status === 404 ? 'unsupported' : (e && e.message) || 'unknown error' })));
  }, [enabled, key]);
  return { ...state, reload: () => loadSafety({ force: true }).catch((e) => errorToast(e)) };
}
export const rowFor = (data, id) => ((data && Array.isArray(data.rows)) ? data.rows.find((r) => r.id === id) : null) || null;

// ---- the shield: a small mark with a word for screen readers
export function Shield({ verdict, size = 14, title }) {
  if (!verdict) return null;
  const t = title || `Setup safety: ${SHIELD_WORD[verdict]}`;
  return html`<svg class=${`shield shield-${verdict}`} width=${size} height=${size} viewBox="0 0 16 16" role="img" aria-label=${t} data-shield=${verdict}>
    <title>${t}</title>
    <path d="M8 1.2 2.5 3.3v4.1c0 3.4 2.3 6.1 5.5 7.4 3.2-1.3 5.5-4 5.5-7.4V3.3z" />
    ${verdict === 'green' ? html`<path class="shield-mark" d="m5.4 8 1.8 1.8 3.4-3.6" />`
      : verdict === 'red' ? html`<path class="shield-mark" d="M8 4.8v3.8M8 10.8v.3" />`
      : html`<path class="shield-mark" d="M5.6 8h4.8" />`}
  </svg>`;
}

/** The map's version: an SVG group at (x, y) inside the node. */
export function MapShield({ verdict, x, y }) {
  if (!verdict) return null;
  return html`<g class=${`map-shield shield-${verdict}`} transform=${`translate(${x - 6} ${y - 6})`} data-map-shield=${verdict}>
    <title>Setup safety: ${SHIELD_WORD[verdict]}</title>
    <path d="M6 0.6 1.6 2.3v3.2c0 2.6 1.8 4.7 4.4 5.8 2.6-1.1 4.4-3.2 4.4-5.8V2.3z" />
  </g>`;
}

/** A line that may hold `code` spans (backticks), shown as code. */
function Txt({ t }) {
  const parts = String(t || '').split('`');
  return html`${parts.map((p, i) => (i % 2 ? html`<code>${p}</code>` : p))}`;
}

function Chip({ cap, items }) {
  const on = items.length > 0;
  return html`<div class=${`safety-chip cap-${cap} ${on ? 'is-on' : 'is-off'}`} data-cap=${cap} data-on=${on ? 'true' : 'false'}>
    <div class="safety-chip-head"><span class="safety-chip-dot" aria-hidden="true"></span><span class="safety-chip-title">${CAP_TITLE[cap]}</span>
      <span class="safety-chip-n">${on ? items.length : 'none found'}</span></div>
    ${on ? html`<ul class="safety-chip-list">${items.map((x) => html`<li><span class="safety-what"><${Txt} t=${x.text} /></span><span class="safety-src mono">${x.source}</span></li>`)}</ul>`
      : html`<p class="safety-chip-none">${CAP_HINT[cap]}: nothing by name</p>`}
  </div>`;
}

function AcceptForm({ row, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (row.accepted) {
    const undo = async () => {
      setBusy(true);
      try {
        publish(await api.acceptSafety({ agent: row.id, reason: null }));
        onDone && onDone();
      } catch (e) { errorToast(e); } finally { setBusy(false); }
    };
    return html`<p class="safety-accepted" data-testid="safety-accepted">You accepted this risk: “${row.accepted.reason}”.
      <button class="link-btn" onClick=${undo} disabled=${busy}>Stop accepting it</button></p>`;
  }
  if (!open) return html`<button class="btn btn-quiet btn-sm" onClick=${() => setOpen(true)} data-testid="safety-accept-open">Accept this risk…</button>`;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      publish(await api.acceptSafety({ agent: row.id, reason }));
      toast('Accepted: kept on this computer, shown amber.', { tone: 'ok' });
      setOpen(false);
    } catch (x) { setErr((x && x.message) || 'could not save it'); } finally { setBusy(false); }
  };
  return html`<form class="inline-form safety-accept" onSubmit=${submit}>
    <label class="sr-only" for=${`acc-${row.id}`}>Why you accept this risk</label>
    <input id=${`acc-${row.id}`} type="text" maxLength="300" value=${reason} placeholder="Why (kept on this computer)" autocomplete="off"
      onInput=${(e) => setReason(e.currentTarget.value)} data-testid="safety-accept-reason" />
    <button type="submit" class="btn btn-quiet btn-sm" disabled=${busy || reason.trim().length < 3} data-testid="safety-accept-save">Accept</button>
    <button type="button" class="btn btn-quiet btn-sm" onClick=${() => setOpen(false)}>Cancel</button>
    ${err ? html`<span class="form-error" role="alert">${err}</span>` : null}
  </form>`;
}

const CAPS = ['private', 'untrusted', 'sends'];
function TagForm({ name }) {
  const [open, setOpen] = useState(false);
  const [caps, setCaps] = useState([]);
  const [busy, setBusy] = useState(false);
  if (!open) return html`<button class="link-btn safety-tag-open" onClick=${() => setOpen(true)} data-testid="safety-tag-open">Say what it can do</button>`;
  const save = async () => {
    setBusy(true);
    try {
      publish(await api.tagSafety({ server: name, caps }));
      setOpen(false);
    } catch (e) { errorToast(e); } finally { setBusy(false); }
  };
  return html`<span class="safety-tag" role="group" aria-label=${`What ${name} can do`}>
    ${CAPS.map((c) => html`<label class="safety-tag-opt"><input type="checkbox" checked=${caps.includes(c)}
      onChange=${(e) => setCaps(e.currentTarget.checked ? [...caps, c] : caps.filter((x) => x !== c))} /> ${CAP_TITLE[c]}</label>`)}
    <button class="btn btn-quiet btn-sm" onClick=${save} disabled=${busy} data-testid="safety-tag-save">${caps.length ? 'Save' : 'None of these'}</button>
  </span>`;
}

const mcpName = (text) => {
  const m = /^(.+?) MCP server/.exec(String(text || ''));
  return m ? m[1] : null;
};

export function SafetyRow({ row, agent, open, onToggle }) {
  const chipsOn = CAPS.filter((c) => row.chips[c].length).length;
  const sum = row.trifecta && !row.accepted ? 'Lethal trifecta' : row.summary;
  return html`<li class=${`safety-row verdict-${row.verdict} ${open ? 'is-open' : ''}`} data-safety-row=${row.id} data-verdict=${row.verdict}>
    <button class="safety-row-head" onClick=${onToggle} aria-expanded=${open ? 'true' : 'false'} aria-controls=${`safety-body-${row.id}`}>
      <${Shield} verdict=${row.verdict} size=${16} />
      <span class="safety-row-name">${agent ? html`<span class="safety-row-icon"><${AgentIcon} agent=${agent} size=${13} /></span>` : null}${row.name}</span>
      <span class="safety-row-sum">${sum}</span>
      <span class="safety-row-legs" aria-label=${`${chipsOn} of 3`}>${CAPS.map((c) => html`<span class=${`leg cap-${c} ${row.chips[c].length ? 'is-on' : ''}`} title=${CAP_TITLE[c]} aria-hidden="true"></span>`)}</span>
    </button>
    ${open ? html`<div class="safety-row-body" id=${`safety-body-${row.id}`}>
      ${row.mode ? html`<p class="safety-mode">Runs in <strong>${row.mode}</strong> mode.</p>` : null}
      ${row.sentence ? html`<p class="safety-sentence" data-testid="safety-sentence"><strong>Lethal trifecta.</strong> ${row.sentence}</p>` : null}
      <div class="safety-chips">${CAPS.map((c) => html`<${Chip} cap=${c} items=${row.chips[c]} />`)}</div>
      ${row.fixes.length ? html`<div class="safety-fixes" data-testid="safety-fixes"><h5 class="safety-h">${row.fixes.length === 1 ? 'The cheapest fix' : 'Fixes, cheapest first'}</h5>
        <ol>${row.fixes.map((f) => html`<li><${Txt} t=${f} /></li>`)}</ol>
        <p class="set-note">Clawdling changes nothing: copy the change into the file yourself, then press Refresh.</p></div>` : null}
      ${row.trifecta ? html`<${AcceptForm} row=${row} />` : null}
      ${row.risks.length ? html`<div class="safety-risks" data-testid="safety-risks"><h5 class="safety-h">Setup risks</h5>
        <ul>${row.risks.map((k) => html`<li data-risk=${k.id}><${Txt} t=${k.text} /> <span class="safety-src mono">${k.file}</span></li>`)}</ul></div>` : null}
      ${row.unknown.length ? html`<div class="safety-unknown" data-testid="safety-unknown"><h5 class="safety-h">Unknown: review</h5>
        <ul>${row.unknown.map((u) => html`<li><span><${Txt} t=${u.text} /></span> <span class="safety-src mono">${u.source}</span>
          ${mcpName(u.text) ? html`<${TagForm} name=${mcpName(u.text)} />` : null}</li>`)}</ul></div>` : null}
      ${row.notes.length ? html`<ul class="safety-notes">${row.notes.map((n) => html`<li><${Txt} t=${n} /></li>`)}</ul>` : null}
    </div>` : null}
  </li>`;
}

export function SafetySection() {
  const { data, err, reload } = useSafety(true);
  const agentsById = useStore((s) => s.agentsById);
  const [openIds, setOpen] = useState(null);
  const rows = (data && Array.isArray(data.rows)) ? data.rows : [];
  // Red rows start open; the rest start folded.
  const isOpen = (r) => (openIds ? openIds.includes(r.id) : r.verdict === 'red');
  const toggle = (r) => {
    const cur = openIds || rows.filter((x) => x.verdict === 'red').map((x) => x.id);
    setOpen(cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id]);
  };
  const n = { red: rows.filter((r) => r.verdict === 'red').length, amber: rows.filter((r) => r.verdict === 'amber').length };
  return html`<section class="safety-sec" id="safety" aria-labelledby="safety-h" data-testid="safety-section">
    <h3 class="card-h" id="safety-h">Safety <span class="card-h-sub">the lethal trifecta, per agent</span> <button class="link-btn" onClick=${reload}>Check again</button></h3>
    <p class="set-note safety-lead">An agent that can read your <strong>private data</strong>, read <strong>untrusted input</strong> and <strong>send data out</strong> can be tricked by the second into leaking the first through the third.
      <a href=${LINK} target="_blank" rel="noopener noreferrer">Simon Willison's “lethal trifecta”</a>. Checked by name, on this computer${data && Number.isFinite(data.took_ms) ? ` in ${data.took_ms < 1 ? 'under 1' : Math.round(data.took_ms)} ms` : ''}.</p>
    ${err === 'unsupported' ? html`<p class="panel-quiet">This Clawdling server can't check setup safety yet. Update it, then reload this page.</p>`
      : err && !data ? html`<p class="form-error" role="alert">Couldn't check: ${err}</p>`
      : !data ? html`<div class="panel-skel" aria-label="Loading"></div>`
      : html`<p class="safety-tally" data-testid="safety-tally">${n.red ? `${n.red} with the lethal trifecta` : 'No lethal trifecta found by name'}${n.amber ? ` · ${n.amber} to review` : ''} · ${rows.length} checked</p>
        <ul class="safety-rows">${rows.map((r) => html`<${SafetyRow} key=${r.id} row=${r} agent=${agentsById[r.id]} open=${isOpen(r)} onToggle=${() => toggle(r)} />`)}</ul>
        <p class="set-note safety-privacy">${data.privacy || ''} Green means no trifecta found by name, not “secure”.</p>`}
  </section>`;
}

/** The report card's line: the shield, what it means, and where to read more. */
export function SafetyLine({ agentId }) {
  const { data } = useSafety(true);
  const r = rowFor(data, agentId);
  if (!r) return null;
  return html`<button class=${`safety-line verdict-${r.verdict}`} onClick=${() => navigate('#/settings/safety')} data-testid="report-safety" data-verdict=${r.verdict}>
    <${Shield} verdict=${r.verdict} size=${14} /><span>Setup safety: ${r.trifecta && !r.accepted ? 'Lethal trifecta' : r.summary}</span></button>`;
}
