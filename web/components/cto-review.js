// The CTO seat's page (1.7): "Run this week's review" (the cost estimate first), and each week's
// review rendered from cto/reviews/<week>.md. Receipts or it didn't happen: every [R-…] citation is
// a link to its receipt, a bullet with none says "uncited", a citation to a receipt that does not
// exist says so, and a label the CTO changed shows Clawdling's own label and the CTO's reason. The
// decisions it asked and the messages it sent (or that were declined) come from its transcripts.
// Data: GET /api/cto, GET /api/cto/reviews/:week. The review text is the CTO's own words: it is
// rendered as text, never as HTML, and every link comes from Clawdling's receipt index.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { api } from '../lib/api.js';
import { errorToast, focusSession, openOverlay } from '../lib/actions.js';
import { relTime, longTime } from '../lib/util.js';
import { Modal } from './dialogs.js';
import { Icon } from './icons.js';
import { COST_NOTE, PRO_NOTE } from './report-card.js';

export const LABEL_TEXT = { at_risk: 'At risk', stalled: 'Stalled', on_track: 'On track', quiet: 'Quiet' };
const KIND_WORD = { session: 'session', claim: 'claim', check: 'ship check', checkup: 'check-up', cost: 'usage', needs: 'needs you', next: 'NOW.md', model: 'cheaper model', safety: 'setup safety' };
const CITE_RE = /\[?\b(R-(?:session|claim|check|checkup|cost|needs|next|model|safety)-[0-9a-f]{8})\b\]?/g;
const REFRESH_MS = 8000;
const money = (x) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : 'unknown');

export function StatusLabel({ label, computed = false }) {
  if (!label) return html`<span class="cto-label lbl-none">No label</span>`;
  return html`<span class=${`cto-label lbl-${label}`} title=${computed ? 'Computed by Clawdling from receipts' : undefined} data-label=${label}>${LABEL_TEXT[label] || label}</span>`;
}

/** A finding's text with each citation as a link to its receipt (or marked when it does not exist). */
export function Cited({ text, receipts }) {
  const out = [];
  let last = 0;
  for (const m of String(text || '').matchAll(CITE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const id = m[1];
    const r = receipts[id];
    out.push(r && r.link
      ? html`<a class="cite" href=${r.link} title=${`${id}${r.label ? `: ${r.label}` : ''}`} data-receipt=${id}>${KIND_WORD[r.kind] || 'receipt'}</a>`
      : html`<span class="cite is-bad" title=${`${id} is not a receipt Clawdling knows for this week`} data-receipt=${id}>no such receipt</span>`);
    last = m.index + m[0].length;
  }
  if (last < String(text || '').length) out.push(text.slice(last));
  return out;
}

export function CtoPage({ id }) {
  const sessionsMap = useStore((s) => s.sessions);
  const now = useStore((s) => s.now);
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  const [week, setWeek] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.cto().then((x) => { if (live) { setV(x); setErr(''); } }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [tick]);
  // While a review runs, keep the page current (its file and decisions change as it works).
  const running = v && v.running ? sessionsMap[v.running] : null;
  useEffect(() => {
    if (!running || running.status === 'ended') return undefined;
    const t = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, [running && running.sid, running && running.status]);
  // A week later than this one is never the default (a steered CTO could name one).
  const shown = week || (v && (v.reviews.find((r) => !r.future) || v.reviews[0])?.week) || null;

  if (err) return html`<p class="form-error" role="alert">Could not load the CTO: ${err}</p>`;
  if (!v) return html`<div class="panel-skel tall" aria-label="Loading"></div>`;
  const waiting = running && running.status === 'needs_you';
  return html`<div class="cto-page" data-testid="cto-page">
    <section class="card cto-run" aria-labelledby="cto-run-h">
      <div class="cto-run-text">
        <h2 id="cto-run-h" class="card-title">This week's review <span class="card-h-sub">${v.week}</span></h2>
        <p class="rc-label">Your CTO reads every agent's report card and its receipts, writes one page, and asks you up to three decisions. The status labels are computed by Clawdling from receipts, not by the model. A message to another agent is only sent once you say yes to it.</p>
        ${v.schedule && v.schedule.last_skip ? html`<p class="cto-notice" role="status" data-testid="cto-skip"><${Icon} name="alert" size=${13} /> ${v.schedule.last_skip.why}</p>` : null}
      </div>
      <div class="cto-run-actions">
        ${running && running.status !== 'ended'
          ? html`<button class="btn btn-primary" onClick=${() => focusSession(running.sid)} data-testid="cto-open-run">${waiting ? 'It is asking you: open it' : 'A review is running: open it'}</button>`
          : html`<button class="btn btn-primary" onClick=${() => setDialog('run')} data-testid="cto-run"><${Icon} name="play" size=${13} /> Run this week's review</button>`}
        <button class="btn btn-quiet" onClick=${() => openOverlay({ type: 'new-session', agent: id })} data-testid="cto-ask">Ask the CTO something…</button>
      </div>
    </section>
    ${v.reviews.length ? html`<div class="cto-weeks" role="tablist" aria-label="Reviews by week">
      ${v.reviews.map((r) => html`<button role="tab" aria-selected=${r.week === shown ? 'true' : 'false'} class=${`tab-btn ${r.week === shown ? 'is-on' : ''}`} onClick=${() => setWeek(r.week)} data-week=${r.week}>${r.week}</button>`)}
    </div>
    <${ReviewView} key=${shown} week=${shown} tick=${tick} now=${now} />`
      : html`<div class="notice" data-testid="cto-empty"><p>No reviews yet. Run the first one: it takes a few minutes, and the CTO asks before it messages any agent.</p></div>`}
    ${dialog === 'run' ? html`<${RunDialog} onClose=${() => setDialog(null)} onGo=${async () => {
      setDialog(null);
      try {
        const s = await api.ctoReview();
        setTick((x) => x + 1);
        focusSession(s.sid);
      } catch (e) {
        if (e.status === 409 && e.body && e.body.sid) focusSession(e.body.sid);
        else errorToast("Could not start this week's review", e);
      }
    }} />` : null}
  </div>`;
}

/** The cost first (US-81): a range, list-price equivalent, before anything starts. */
function RunDialog({ onClose, onGo }) {
  const [est, setEst] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.ctoEstimate().then((x) => { if (live) setEst(x); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, []);
  return html`<${Modal} labelledby="cto-cost-title" onClose=${onClose} size="sm" class="confirm cost-dialog">
    <div class="modal-body" data-testid="cto-cost-dialog">
      <h2 id="cto-cost-title" class="modal-title">Run this week's review</h2>
      ${est ? html`<p class="cost-line" data-testid="cto-cost-line">This starts <strong>one Claude Code session</strong> on your plan, about <strong>${money(est.low_usd)} to ${money(est.high_usd)}</strong> list-price equivalent.</p>
        <p class="modal-text">Based on ${est.based_on}.</p>`
        : err ? html`<p class="form-error" role="alert">Could not estimate the cost: ${err}</p>` : html`<p class="modal-text">Estimating…</p>`}
      <p class="modal-text">It reads the report only (no files, no web), writes this week's review, and asks you its decisions as cards. Each message to another agent waits for your yes.</p>
      <p class="cost-pro"><${Icon} name="alert" size=${13} /> ${PRO_NOTE}</p>
      <p class="rc-label">${COST_NOTE}</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-quiet" onClick=${onClose} data-autofocus>Cancel</button>
      <button class="btn btn-primary" disabled=${!est} onClick=${onGo} data-testid="cto-cost-go">Start the review</button>
    </div>
  </${Modal}>`;
}

function ReviewView({ week, tick, now }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  const [raw, setRaw] = useState(false);
  // A refresh keeps what is on screen until the new copy arrives (no flash, no lost scroll).
  useEffect(() => {
    let live = true;
    if (!week) return undefined;
    api.ctoReviewFor(week).then((x) => { if (live) { setR(x); setErr(''); } }).catch((e) => { if (live && !r) setErr(e.message); });
    return () => { live = false; };
  }, [week, tick]);
  if (err) return html`<p class="form-error" role="alert">Could not load the review for ${week}: ${err}</p>`;
  if (!r) return html`<div class="panel-skel tall" aria-label="Loading"></div>`;
  const l = r.lint;
  const findings = l.sections.reduce((n, s) => n + s.bullets.length, 0) + l.other.length;
  return html`<article class="cto-review" aria-labelledby="cto-review-h" data-testid="cto-review" data-week=${week}>
    <header class="cto-review-head">
      <h2 id="cto-review-h" class="cto-title">${l.title || `CTO review, ${week}`}</h2>
      <p class="rc-when" title=${longTime(r.updated_at)}>Written ${relTime(r.updated_at, now) === 'now' ? 'just now' : relTime(r.updated_at, now)}</p>
    </header>
    <p class=${`cto-lint ${l.clean ? 'is-clean' : 'is-flagged'}`} role="status" data-testid="cto-lint">
      <${Icon} name=${l.clean ? 'check' : 'alert'} size=${14} /> ${l.summary || 'No findings yet'}${l.clean ? '' : findings ? '. Flagged lines are marked below.' : ''}</p>
    ${l.headline ? html`<p class="cto-headline" data-testid="cto-headline">${l.headline}</p>` : null}
    ${l.sections.map((s) => html`<${Section} s=${s} receipts=${r.receipts} />`)}
    ${l.other.length ? html`<section class="cto-sec"><h3 class="cto-sec-h">Other notes</h3><ul class="cto-bullets">${l.other.map((b) => html`<${Bullet} b=${b} receipts=${r.receipts} />`)}</ul></section>` : null}
    ${l.missing.length ? html`<p class="rc-note" data-testid="cto-missing">No section for ${l.missing.map((m) => `${m.name} (${LABEL_TEXT[m.label] || m.label})`).join(', ')}.</p>` : null}
    <${Decisions} r=${r} />
    <${Deliveries} list=${r.deliveries} />
    <${Commands} list=${r.commands} />
    <p class="cto-raw"><button class="link-btn" onClick=${() => setRaw(!raw)} aria-expanded=${raw ? 'true' : 'false'}>${raw ? 'Hide the file' : 'Show the file'}</button> <span class="rc-label">cto/reviews/${week}.md</span></p>
    ${raw ? html`<pre class="cto-file" data-testid="cto-file">${r.text}</pre>` : null}
  </article>`;
}

function Section({ s, receipts }) {
  const changed = s.state === 'overridden' || s.state === 'mismatch';
  return html`<section class=${`cto-sec state-${s.state}`} data-agent=${s.agent || ''} data-testid="cto-section">
    <h3 class="cto-sec-h">${s.agent ? html`<a href=${`#/agent/${encodeURIComponent(s.agent)}`}>${s.name}</a>` : s.name}
      <${StatusLabel} label=${s.label} computed=${s.state === 'match'} />
      ${s.state === 'match' ? html`<span class="cto-sec-note">Computed by Clawdling</span>` : null}</h3>
    ${s.state === 'overridden' ? html`<p class="cto-override" data-testid="cto-override">Overridden by the CTO, here is why: <${Cited} text=${s.why} receipts=${receipts} /> <span class="cto-was">Clawdling computed <${StatusLabel} label=${s.computed} computed /></span></p>` : null}
    ${s.state === 'mismatch' ? html`<p class="cto-override is-bad" data-testid="cto-mismatch">The CTO wrote "${LABEL_TEXT[s.label]}" but gave no reason. <span class="cto-was">Clawdling computed <${StatusLabel} label=${s.computed} computed /></span></p>` : null}
    ${s.state === 'unknown_agent' ? html`<p class="cto-override is-bad">There is no agent called "${s.name}" in this week's report.</p>` : null}
    ${s.state === 'no_label' ? html`<p class="cto-override is-bad">This heading has no status label.</p>` : null}
    <ul class="cto-bullets">${s.bullets.filter((b) => !(changed && /^\s*(override|overridden|i disagree)\b/i.test(b.text))).map((b) => html`<${Bullet} b=${b} receipts=${receipts} />`)}</ul>
  </section>`;
}

function Bullet({ b, receipts }) {
  return html`<li class=${`cto-bullet is-${b.state}`} data-state=${b.state} data-testid="cto-bullet">
    <span class="cto-bullet-text"><${Cited} text=${b.text} receipts=${receipts} /></span>
    ${b.state === 'uncited' ? html`<span class="cto-flag" title="No receipt is cited for this line">uncited</span>` : null}
    ${b.state === 'no_receipts' ? html`<span class="cto-flag is-none" title="The CTO says it has no receipt for this, as its rules ask">no receipts</span>` : null}
  </li>`;
}

function Decisions({ r }) {
  const asked = r.decisions || [];
  if (!asked.length && !(r.lint.decisions || []).length) return null;
  const rows = [];
  for (const d of asked) {
    (d.questions || []).forEach((q, i) => rows.push({ key: `${d.id}-${i}`, q, d, answer: d.answers ? d.answers[q.question] : null }));
  }
  return html`<section class="cto-sec cto-decisions" aria-labelledby="cto-dec-h" data-testid="cto-decisions">
    <h3 id="cto-dec-h" class="cto-sec-h">Decisions</h3>
    ${rows.length ? html`<ul class="cto-dec-list">${rows.map(({ key, q, d, answer }) => html`<li key=${key} class=${`cto-dec is-${d.state}`} data-state=${d.state}>
      <p class="cto-dec-q">${q.question}</p>
      ${q.options.length ? html`<p class="rc-label">Options: ${q.options.join(' · ')}</p>` : null}
      ${d.state === 'answered' ? html`<p class="cto-dec-a">You chose: <strong>${answer || 'answered'}</strong></p>`
        : d.state === 'declined' ? html`<p class="cto-dec-a">Not answered: dismissed, or the CTO's turn stopped before you saw it.</p>`
        : html`<p class="cto-dec-a"><span class="tone-amber-text">Waiting for you.</span> <button class="btn btn-quiet btn-sm" onClick=${() => focusSession(d.sid)} data-testid="cto-answer">Answer it</button></p>`}
    </li>`)}</ul>`
      : html`<ol class="cto-dec-list">${r.lint.decisions.map((d) => html`<li class="cto-dec"><p class="cto-dec-q">${d.text}</p></li>`)}</ol>`}
  </section>`;
}

const COMMAND_STATE = { sent: ['ok', 'You said yes: it ran'], declined: ['bad', 'You said no: it did not run'], failed: ['bad', 'It ran and failed'], asking: ['wait', 'Waiting for your yes or no'], pending: ['wait', 'Not answered yet, or still running'] };

/** Every other shell command the CTO asked to run (not a message the page can read as one). */
function Commands({ list }) {
  if (!list || !list.length) return null;
  return html`<section class="cto-sec" aria-labelledby="cto-cmd-h" data-testid="cto-commands">
    <h3 id="cto-cmd-h" class="cto-sec-h">Other commands it asked to run</h3>
    <ul class="cto-del-list">${list.map((d, i) => {
      const [tone, text] = COMMAND_STATE[d.state] || COMMAND_STATE.pending;
      return html`<li key=${d.id || i} class=${`cto-del tone-${tone}`} data-state=${d.state}>
        <p class="cto-del-top"><span class=${`pill pill-${tone === 'ok' ? 'ok' : tone === 'wait' ? 'wait' : 'bad'}`}><span class="pill-dot"></span>${text}</span></p>
        <code class="cto-del-msg cto-del-cmd">${d.command}</code>
      </li>`;
    })}</ul>
  </section>`;
}

const DELIVERY = {
  sent: ['ok', (d) => (d.verb === 'spawn' ? `Started a session of ${d.to || 'an agent'}` : 'Sent')],
  declined: ['bad', () => 'You declined it: not sent'],
  failed: ['bad', () => 'It did not go through'],
  asking: ['wait', () => 'Waiting for your yes or no'],
  pending: ['wait', () => 'Not answered'],
};

function Deliveries({ list }) {
  if (!list || !list.length) return null;
  return html`<section class="cto-sec" aria-labelledby="cto-del-h" data-testid="cto-deliveries">
    <h3 id="cto-del-h" class="cto-sec-h">Messages to agents</h3>
    <ul class="cto-del-list">${list.map((d, i) => {
      const [tone, text] = DELIVERY[d.state] || DELIVERY.pending;
      return html`<li key=${d.id || i} class=${`cto-del tone-${tone}`} data-state=${d.state}>
        <p class="cto-del-top"><span class=${`pill pill-${tone === 'ok' ? 'ok' : tone === 'wait' ? 'wait' : 'bad'}`}><span class="pill-dot"></span>${text(d)}</span>
          <span class="rc-label">${!d.to ? 'Recipient unclear: the full command is below' : d.verb === 'spawn' ? `New session of ${d.to}` : `To session ${d.to}`}</span>
          ${d.state === 'asking' ? html`<button class="btn btn-quiet btn-sm" onClick=${() => focusSession(d.sid)}>Answer it</button>` : null}</p>
        <blockquote class="cto-del-msg">${d.plain && typeof d.message === 'string' ? d.message : d.command}</blockquote>
      </li>`;
    })}</ul>
  </section>`;
}

