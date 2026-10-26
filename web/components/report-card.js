// The Overview tab of an agent page (1.5): the agent's report card, in plain words, for someone
// who never opens a terminal. Four blocks: Done (what got done, from the sessions' own last words
// and the repo's commits), Needs you (exactly the rail's needs-you sessions), Cost (a list-price
// equivalent, never a bill) and Next (the agent's own NOW.md). Data: GET /api/agents/:id/report.
import { html } from '../lib/html.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { api } from '../lib/api.js';
import { focusSession, navigate } from '../lib/actions.js';
import { needsYou, isBlocked, sessionName } from '../lib/model.js';
import { parseMarkdown } from '../lib/markdown.js';
import { relTime, longTime, plural, prefersReducedMotion } from '../lib/util.js';
import { load, save } from '../lib/prefs.js';
import { renderBlock } from './chat-view.js';
import { StatusGlyph } from './status.js';
import { Icon } from './icons.js';

export const WINDOWS = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']];
const IN_WINDOW = { today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days' };
export const COST_NOTE = 'List-price equivalent, not a bill. On Pro and Max, usage is included in your plan.';
export const PRO_NOTE = "On Pro, your plan's usage limits are smaller than Max's, so a busy week reaches them sooner.";
const REFRESH_MS = 30000;

/** "about $4.10", "less than $0.01": every dollar figure on the card reads as an estimate. */
export function usd(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'unknown';
  if (x === 0) return '$0.00';
  if (x > 0 && x < 0.005) return 'less than $0.01';
  return `about $${x.toFixed(2)}`;
}

/** "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5"; others as they are. */
export function modelName(id) {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(id || ''));
  if (!m) return String(id || 'Unknown model');
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** What a waiting session needs, in plain words. */
export function needLabel(s) {
  if (!isBlocked(s)) return 'Finished and waiting for your reply';
  if (s.asking && s.asking.kind === 'plan') return 'Wants a plan approved';
  if (s.asking && s.asking.kind === 'question') return 'Asked you a question';
  switch (s.waiting_on) {
    case 'permission_prompt': return 'Wants your permission';
    case 'elicitation_dialog': return 'Asked you a question';
    case 'error': return 'A turn failed';
    case 'login': return 'Needs you to sign in';
    case 'trust': case 'imports': case 'startup': return 'Has a question before it starts';
    default: return 'Waiting on you';
  }
}

/** "just now", "3h ago", "yesterday", "Oct 3": when something happened, as a phrase. */
export function agoText(ts, now = Date.now()) {
  const r = relTime(ts, now);
  if (!r) return '';
  if (r === 'now') return 'just now';
  return /^\d+[mhd]$/.test(r) ? `${r} ago` : r;
}

function dayLabel(day, key) {
  const d = new Date(`${day}T12:00:00`);
  if (key === '7d') return d.toLocaleDateString(undefined, { weekday: 'short' });
  return String(d.getDate());
}

export function ReportCard({ id, agent }) {
  const sessionsMap = useStore((s) => s.sessions);
  const agentsById = useStore((s) => s.agentsById);
  const now = useStore((s) => s.now);
  const [win, setWinState] = useState(() => { const w = load('reportWindow', '7d'); return WINDOWS.some(([k]) => k === w) ? w : '7d'; });
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  const setWin = (w) => { save('reportWindow', w); setWinState(w); };

  // Needs you comes from the live session store, so it always matches the rail's badges.
  const mine = useMemo(() => Object.values(sessionsMap).filter((s) => s.agent === id), [sessionsMap, id]);
  const needs = useMemo(() => mine.filter(needsYou).sort((a, b) => (isBlocked(b) - isBlocked(a)) || String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || ''))), [mine]);
  // Refetch a moment after this agent's sessions change (a turn finished, one ended).
  const stamp = mine.map((s) => `${s.sid}:${s.status}:${s.last_activity_at}`).join('|');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    const t = setTimeout(() => setTick((x) => x + 1), 1500);
    return () => clearTimeout(t);
  }, [stamp]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) setTick((x) => x + 1); }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let live = true;
    api.agentReport(id, win).then((d) => { if (live) { setData(d); setErr(''); } }).catch((e) => { if (live) setErr(e.message || 'Could not load the report card.'); });
    return () => { live = false; };
  }, [id, win, tick]);

  const name = agent ? agent.name : id;
  const fresh = data && data.window && data.window.key === win ? data : null;
  const go = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    const h = el.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  };

  return html`<div class="report" data-testid="report-card" data-window=${win}>
    <div class="report-bar">
      <p class="report-lede">What ${name} got done, what it needs from you, and what it used, in plain words.</p>
      <div class="seg" role="group" aria-label="Time window">
        ${WINDOWS.map(([k, label]) => html`<button type="button" class=${`seg-btn ${win === k ? 'is-on' : ''}`} aria-pressed=${win === k ? 'true' : 'false'}
          onClick=${() => setWin(k)} data-window-btn=${k}>${label}</button>`)}
      </div>
    </div>
    ${err && !fresh ? html`<div class="notice" role="alert"><p>Could not load the report card: ${err}</p>
      <button class="btn btn-quiet btn-sm" onClick=${() => setTick((x) => x + 1)}>Try again</button></div>` : null}
    ${!fresh && !err ? html`<div class="report-grid" aria-busy="true"><div class="panel-skel tall" aria-label="Loading the report card"></div></div>` : null}
    ${fresh ? html`
      <ul class="report-glance" aria-label="At a glance">
        <li><button type="button" class="glance" onClick=${() => go('#rc-done')}><span class="glance-n">${fresh.done.length}</span><span class="glance-l">${fresh.done.length === 1 ? 'session' : 'sessions'} with work done</span></button></li>
        <li><button type="button" class=${`glance ${needs.length ? 'tone-needs' : ''}`} onClick=${() => go('#rc-needs')}><span class="glance-n">${needs.length}</span><span class="glance-l">${needs.length === 1 ? 'thing needs' : 'things need'} you</span></button></li>
        <li><button type="button" class="glance" onClick=${() => go('#rc-cost')}><span class="glance-n">${!fresh.cost.total_usd && !fresh.cost.complete ? 'Unknown' : `${usd(fresh.cost.total_usd).replace(/^about /, '')}${fresh.cost.complete ? '' : '+'}`}</span><span class="glance-l">of usage at list price${fresh.cost.complete ? '' : ', plus some unknown'}</span></button></li>
        <li><button type="button" class=${`glance ${fresh.next.stale ? 'tone-needs' : ''}`} onClick=${() => go('#rc-next')}><span class="glance-n">${fresh.next.empty ? 'None' : agoText(fresh.next.updated_at, now) || 'Written'}</span><span class="glance-l">${fresh.next.empty ? 'next steps written yet' : 'next steps last updated'}</span></button></li>
      </ul>
      <div class="report-grid">
        <${DoneBlock} r=${fresh} win=${win} name=${name} now=${now} agentsById=${agentsById} />
        <div class="report-side">
          <${NeedsBlock} needs=${needs} name=${name} now=${now} agentsById=${agentsById} />
          <${CostBlock} c=${fresh.cost} win=${win} name=${name} />
          <${NextBlock} n=${fresh.next} id=${id} name=${name} now=${now} />
        </div>
      </div>` : null}
  </div>`;
}

function Block({ id, title, count, tone, sub, children, testid }) {
  return html`<section class="rc-block" id=${id} aria-labelledby=${`${id}-h`} data-testid=${testid}>
    <h2 class="rc-h" id=${`${id}-h`}>${title}${count !== undefined ? html`<span class=${`sec-count ${tone ? `tone-${tone}` : ''}`}>${count}</span>` : null}
      ${sub ? html`<span class="rc-h-sub">${sub}</span>` : null}</h2>
    ${children}
  </section>`;
}

function DoneBlock({ r, win, name, now, agentsById }) {
  const other = r.repo_commits && Array.isArray(r.repo_commits.other) ? r.repo_commits.other : [];
  return html`<${Block} id="rc-done" title="Done" count=${r.done.length} sub=${IN_WINDOW[win]} testid="rc-done">
    ${r.done.length ? html`<ul class="rc-list">${r.done.map((d) => html`<li key=${d.sid} class="rc-done-item">
      <button type="button" class="rc-item" onClick=${() => focusSession(d.sid)} data-sid=${d.sid} title="Open this session">
        <span class="rc-item-top">
          <span class="rc-item-title">${d.title || sessionName({ agent: r.agent.id }, agentsById)}</span>
          <span class=${`rc-when ${d.live ? 'is-live' : ''}`} title=${longTime(d.when)}>${d.live ? 'Still running' : `Ended ${agoText(d.when, now)}`}</span>
          <span class="rc-open" aria-hidden="true"><${Icon} name="chevron-right" size=${12} /></span>
        </span>
        ${d.line ? html`<span class="rc-line">${d.line}</span>` : html`<span class="rc-line is-empty">It finished without a closing message.</span>`}
        <span class="rc-facts">
          <span>${plural(d.files_changed, 'file')} changed</span>
          ${d.commits && (d.commits.length || !d.live) ? html`<span>${plural(d.commits.length, 'commit')}</span>` : null}
          ${d.tool_errors ? html`<span class="tone-amber-text">${plural(d.tool_errors, 'step')} hit an error along the way</span>` : null}
          ${d.transcript === 'gone' ? html`<span class="rc-gone" title="Claude Code deleted this session's transcript (its retention cleanup). Clawdling kept its summary.">Transcript gone, kept summary only</span>` : null}
        </span>
      </button>
      ${d.commits && d.commits.length ? html`<ul class="rc-commits rc-commits-in" aria-label=${`Commits from ${d.title || 'this session'}`}>${d.commits.slice(0, 5).map((c) => html`<li key=${c.hash}><${Icon} name="check" size=${12} /> ${c.subject}</li>`)}
        ${d.commits.length > 5 ? html`<li class="rc-more">and ${d.commits.length - 5} more</li>` : null}</ul>` : null}
    </li>`)}</ul>`
      : html`<p class="rc-empty">Nothing done ${IN_WINDOW[win]} yet. When a session of ${name} finishes some work, it shows up here with its own closing words${r.agent.has_repo ? ' and the commits it made' : ''}.</p>`}
    ${other.length ? html`<div class="rc-other"><h3 class="rc-sub-h">Also committed in the repo <span class="rc-h-sub">outside these sessions</span></h3>
      <ul class="rc-commits">${other.slice(0, 8).map((c) => html`<li key=${c.hash} title=${longTime(c.at)}><${Icon} name="check" size=${12} /> ${c.subject}</li>`)}</ul></div>` : null}
    ${r.repo_commits && r.repo_commits.errors && r.repo_commits.errors.length ? html`<p class="rc-note">Commits could not be read: ${r.repo_commits.errors.map((e) => e.error).join('; ')}.</p>` : null}
  </${Block}>`;
}

function NeedsBlock({ needs, name, now, agentsById }) {
  return html`<${Block} id="rc-needs" title="Needs you" count=${needs.length} tone=${needs.length ? 'amber' : ''} testid="rc-needs">
    ${needs.length ? html`<ul class="rc-list">${needs.map((s) => html`<li key=${s.sid}>
      <button type="button" class="rc-item rc-need" onClick=${() => focusSession(s.sid)} data-sid=${s.sid} title="Open this session">
        <span class="rc-item-top"><${StatusGlyph} status=${s.status} label=${false} />
          <span class="rc-item-title">${needLabel(s)}</span><span class="rc-when">${relTime(s.last_activity_at, now)}</span>
          <span class="rc-open" aria-hidden="true">${isBlocked(s) ? 'Answer' : 'Open'} <${Icon} name="chevron-right" size=${12} /></span></span>
        <span class="rc-line">${sessionName(s, agentsById)}${isBlocked(s) && s.notification ? `: ${s.notification}` : !isBlocked(s) && s.last_message ? `: ${String(s.last_message).replace(/`|\*\*/g, '')}` : ''}</span>
      </button></li>`)}</ul>`
      : html`<p class="rc-empty">Nothing is waiting on you. When ${name} asks a question, wants permission, or a turn fails, it shows up here.</p>`}
  </${Block}>`;
}

function CostBlock({ c, win, name }) {
  const max = Math.max(0, ...c.by_day.map((d) => d.usd));
  const unknown = !c.complete;
  return html`<${Block} id="rc-cost" title="Cost" sub=${IN_WINDOW[win]} testid="rc-cost">
    <p class="rc-big"><span class="rc-big-n" data-testid="rc-cost-total">${!c.total_usd && !c.complete ? 'Cost unknown' : usd(c.total_usd)}</span> <span class="rc-big-l">${!c.total_usd && !c.complete ? 'for this window' : 'of usage at list price'}</span></p>
    ${c.sessions_counting ? html`<p class="rc-note" data-testid="rc-counting">Still reading ${plural(c.sessions_counting, 'older session')}; this figure will grow.</p>` : null}
    ${unknown && !c.sessions_counting ? html`<p class="rc-note tone-amber-text">${c.unknown_models.length ? `Plus usage with an unknown cost (${c.unknown_models.map(modelName).join(', ')} is not in Clawdling's price table).` : ''}${c.sessions_without_cost ? ` ${plural(c.sessions_without_cost, 'session')} had no transcript to read, so ${c.sessions_without_cost === 1 ? 'its' : 'their'} usage is unknown.` : ''}${c.sessions_partly_unknown ? ` Part of the usage of ${plural(c.sessions_partly_unknown, 'session')} could not be read.` : ''}</p>` : null}
    <p class="rc-label" data-testid="rc-cost-label">${COST_NOTE}</p>
    ${c.total_usd > 0 && win !== 'today' ? html`<div class="rc-bars" role="img" aria-label=${`Usage by day: ${c.by_day.filter((d) => d.usd > 0).map((d) => `${new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${usd(d.usd)}`).join(', ') || 'none'}`}>
      ${c.by_day.map((d) => html`<span class="rc-bar" key=${d.day} title=${`${d.day}: ${usd(d.usd)}`}>
        ${win === '7d' ? html`<span class="rc-bar-v" aria-hidden="true">${d.usd > 0 ? (d.usd < 0.005 ? '<$0.01' : `$${d.usd < 10 ? d.usd.toFixed(2) : Math.round(d.usd)}`) : '$0'}</span>` : null}
        <span class="rc-bar-fill" style=${{ height: `${max > 0 ? Math.max(d.usd > 0 ? 4 : 0, Math.round((d.usd / max) * 85)) : 0}%` }}></span>
        <span class="rc-bar-l" aria-hidden="true">${win === '7d' || d.day.endsWith('-01') || Number(d.day.slice(8)) % 5 === 0 ? dayLabel(d.day, win) : ''}</span></span>`)}
    </div>` : null}
    ${c.total_usd > 0 && win !== 'today' ? html`<details class="rc-days"><summary>Each day</summary><ul class="rc-rows">
      ${[...c.by_day].reverse().filter((d) => d.usd > 0).map((d) => html`<li key=${d.day}><span>${new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span><span class="rc-num">${usd(d.usd)}</span></li>`)}
      ${c.by_day.some((d) => !(d.usd > 0)) ? html`<li class="rc-days-rest"><span>Every other day</span><span class="rc-num">$0.00</span></li>` : null}
    </ul></details>` : null}
    ${c.by_model.length ? html`<h3 class="rc-sub-h">By model</h3><ul class="rc-rows">${c.by_model.map((m) => html`<li key=${m.model}><span>${modelName(m.model)}</span><span class="rc-num">${usd(m.usd)}</span></li>`)}</ul>` : null}
    ${c.by_account && c.by_account.length ? html`<h3 class="rc-sub-h">By Claude login</h3><ul class="rc-rows">${c.by_account.map((a) => html`<li key=${a.account}><span>${a.account === 'default' ? 'Your own login' : a.account}</span><span class="rc-num">${usd(a.usd)}</span></li>`)}</ul>` : null}
    ${c.top_sessions.length ? html`<h3 class="rc-sub-h">Top sessions</h3><ul class="rc-rows">${c.top_sessions.map((t) => html`<li key=${t.sid}>
      <button type="button" class="link-btn rc-row-btn" onClick=${() => focusSession(t.sid)}>${t.title || 'Untitled session'}</button><span class="rc-num">${usd(t.usd)}</span></li>`)}</ul>` : null}
    ${!c.total_usd && c.complete ? html`<p class="rc-empty">No usage ${IN_WINDOW[win]}. When ${name} works, its usage shows here.</p>` : null}
    <p class="rc-note">${PRO_NOTE} For one session's own numbers, type <code>/usage</code> in Claude Code.</p>
  </${Block}>`;
}

function NextBlock({ n, id, name, now }) {
  const blocks = useMemo(() => parseMarkdown(n.text || ''), [n.text]);
  return html`<${Block} id="rc-next" title="Next" sub=${n.updated_at ? `from memory/NOW.md, updated ${agoText(n.updated_at, now)}` : null} testid="rc-next">
    ${n.stale ? html`<p class="rc-note tone-amber-text" data-testid="rc-next-stale">This note is over a week old, so it may be out of date.</p>` : null}
    ${n.empty ? html`<p class="rc-empty">Nothing written yet. ${name} writes its next steps in memory/NOW.md when it hands off a piece of work.</p>`
      : html`<div class="rc-next chat-body">${blocks.map(renderBlock)}</div>`}
    <button type="button" class="link-btn" onClick=${() => navigate(`#/agent/${encodeURIComponent(id)}/memory`)}>Open memory</button>
  </${Block}>`;
}

/**
 * The org's report (7 days: per agent, and the totals for today and 7 days), refreshed every
 * `everyMs` while the page is visible and whenever `key` changes (agents added or removed).
 */
/** "about $4.10", "about $4.10+" (part unknown), or "unknown" (nothing known): one rule everywhere. */
export function usdOrUnknown(x, complete = true) {
  if (!complete && !(x > 0)) return 'unknown';
  return `${usd(x)}${complete ? '' : '+'}`;
}

export function useOrgReport(key = '', everyMs = 30000) {
  const [rep, setRep] = useState(null);
  useEffect(() => {
    let live = true;
    const get = () => { if (!document.hidden) api.orgReport('7d').then((r) => { if (live) setRep(r); }).catch(() => {}); };
    get();
    const t = setInterval(get, everyMs);
    return () => { live = false; clearInterval(t); };
  }, [key, everyMs]);
  return rep;
}
