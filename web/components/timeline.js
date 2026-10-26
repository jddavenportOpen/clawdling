// The Timeline tab of a session pane (1.5): every prompt, every tool call (name, one line, how long
// it took, and whether it worked), the agent's words, subagents indented under the call that
// started them, and what each turn used. Built by the server from Claude Code's own transcript
// alone (GET /api/sessions/:sid/timeline, 500 entries a page), so it works for an ended session.
import { html } from '../lib/html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { usd } from './report-card.js';

const POLL_MS = 3000;

/** "0.4 s", "12 s", "2 min 5 s". */
export function duration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/**
 * The Timeline of one session. The first page at once, later pages on request ("Show the next
 * steps"). While the session runs and the tab is visible, everything shown is read again from the
 * start every 3 s: a tool that was still running gets its result and duration, a turn its full
 * cost, and a subagent's new steps land in the right place. Errors keep the last good list.
 */
export function useTimeline(sid, ended, enabled) {
  const [st, setSt] = useState({ entries: [], loaded: false, more: false, total: 0, transcript: null, summary: null, cost: null, error: '' });
  const ref = useRef({ sid, entries: [], busy: false, more: false });
  if (ref.current.sid !== sid) ref.current = { sid, entries: [], busy: false, more: false };

  const apply = (entries, res) => {
    const r = ref.current;
    r.entries = entries;
    r.more = !!(res && res.more);
    setSt({ entries, loaded: true, more: r.more, total: (res && res.total) || entries.length, transcript: res ? res.transcript : null, owner_title: res ? res.owner_title || null : null, summary: res ? res.summary || null : null, cost: res ? res.cost || null : null, error: '' });
  };
  const fail = (e) => setSt((x) => ({ ...x, loaded: true, error: e.message || 'Could not load the Timeline.' }));

  // Read from the start until as many entries as are shown now (at least one page) are back.
  const refresh = async () => {
    const r = ref.current;
    if (r.busy) return;
    r.busy = true;
    try {
      const want = Math.max(r.entries.length, 1);
      let after = -1;
      let out = [];
      let res = null;
      for (let page = 0; page < 20; page++) {
        res = await api.timeline(sid, after);
        const got = res && Array.isArray(res.entries) ? res.entries : [];
        out = out.concat(got);
        if (!res.more || !got.length || out.length >= want) break;
        after = got[got.length - 1].n;
      }
      apply(out, res);
    } catch (e) {
      fail(e);
    } finally {
      r.busy = false;
    }
  };
  // The next page, after what is shown.
  const loadMore = async () => {
    const r = ref.current;
    if (r.busy) return;
    r.busy = true;
    try {
      const after = r.entries.length ? r.entries[r.entries.length - 1].n : -1;
      const res = await api.timeline(sid, after);
      const got = (res && Array.isArray(res.entries) ? res.entries : []).filter((e) => e && Number.isInteger(e.n) && e.n > after);
      apply(r.entries.concat(got), res);
    } catch (e) {
      fail(e);
    } finally {
      r.busy = false;
    }
  };

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    refresh();
    if (ended) return () => { alive = false; };
    const t = setInterval(() => { if (alive && !document.hidden) refresh(); }, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [sid, ended, enabled]);

  return { ...st, loadMore };
}

export function TimelineView({ s, ended }) {
  const t = useTimeline(s.sid, ended, true);
  const tools = t.entries.filter((e) => e.kind === 'tool');
  const failed = tools.filter((e) => e.ok === false).length;
  return html`<div class="timeline-view" data-testid="timeline" role="region" aria-label="Timeline">
    <header class="tl-head">
      <p class="tl-sum">${t.loaded && t.transcript === 'ok' ? html`${t.total} ${t.total === 1 ? 'step' : 'steps'} · ${tools.length}${t.more ? '+' : ''} tool ${tools.length === 1 ? 'call' : 'calls'}${failed ? html` · <span class="tone-amber-text">${failed} failed</span>` : null}${t.cost && Number.isFinite(t.cost.usd) ? html` · ${usd(t.cost.usd)} of usage${t.cost.complete ? '' : ' plus some with an unknown cost'}` : null}` : 'Timeline'}</p>
      <p class="tl-label">Dollar figures are a list-price equivalent, not a bill.</p>
    </header>
    ${!t.loaded ? html`<div class="panel-skel" aria-label="Loading the Timeline"></div>`
      : t.transcript === 'gone' ? html`<p class="tl-empty" data-testid="timeline-gone">Claude Code deleted this session's transcript (its own clean-up of old sessions). Clawdling kept its summary${t.summary ? `: ${t.summary.turns} ${t.summary.turns === 1 ? 'turn' : 'turns'}, ${t.summary.tools} tool calls${t.summary.cost && Number.isFinite(t.summary.cost.usd) ? `, ${usd(t.summary.cost.usd)} of usage` : ''}` : ''}.</p>`
      : t.transcript === 'elsewhere' ? html`<p class="tl-empty" data-testid="timeline-elsewhere">This conversation was continued in another session${t.owner_title ? ` (“${t.owner_title}”)` : ''}, so its steps are shown there.</p>`
      : t.transcript !== 'ok' ? html`<p class="tl-empty">The Timeline appears once Claude Code starts and writes its transcript.</p>`
      : !t.entries.length ? html`<p class="tl-empty">Nothing yet. Each prompt and tool call shows up here as it happens.</p>`
      : html`<ol class="tl-list">${t.entries.map((e) => html`<${Entry} key=${e.n} e=${e} />`)}</ol>`}
    ${t.more ? html`<div class="tl-more"><button type="button" class="btn btn-quiet btn-sm" onClick=${t.loadMore} data-testid="timeline-more">Show the next steps (${t.total - t.entries.length} more)</button></div>` : null}
    ${t.error ? html`<p class="tl-empty" role="alert">${t.error}</p>` : null}
  </div>`;
}

function Entry({ e }) {
  const pad = { '--depth': String(Math.min(e.depth || 0, 6)) };
  if (e.kind === 'prompt') {
    return html`<li class="tl-row tl-prompt" style=${pad} data-kind="prompt">
      <span class="tl-who">You</span><span class="tl-text">${e.text}</span>
      ${e.api ? html`<span class="tl-api" title="Requests to Claude in this turn (detailed timeline)">${e.api.requests} ${e.api.requests === 1 ? 'request' : 'requests'}, ${duration(e.api.ms)}</span>` : null}
      <span class="tl-cost" title="What this turn used, at list price">${e.cost === null ? 'cost unknown' : usd(e.cost)}${e.cost !== null && !e.cost_complete ? '+' : ''}</span></li>`;
  }
  if (e.kind === 'say') return html`<li class="tl-row tl-say" style=${pad} data-kind="say"><span class="tl-text">${e.text}</span></li>`;
  if (e.kind === 'subagent') {
    return html`<li class="tl-row tl-sub" style=${pad} data-kind="subagent"><span class="tl-who">Subagent</span><span class="tl-text">${e.description}</span></li>`;
  }
  const state = e.ok === true ? 'ok' : e.ok === false ? 'error' : e.stopped ? 'stopped' : 'running';
  return html`<li class=${`tl-row tl-tool is-${state}`} style=${pad} data-kind="tool" data-tool=${e.name} data-ok=${state}>
    <span class="tl-mark" aria-label=${state === 'ok' ? 'worked' : state === 'error' ? 'failed' : state === 'stopped' ? 'did not finish' : 'still running'} role="img">${state === 'ok' ? '✓' : state === 'error' ? '✕' : state === 'stopped' ? '–' : '…'}</span>
    <span class="tl-name mono">${e.name}</span><span class="tl-text">${e.summary}</span>
    ${e.approval && e.approval.text ? html`<span class="tl-approval" title="Who let this tool run (detailed timeline)">${e.approval.text}</span>` : null}
    <span class="tl-dur">${state === 'stopped' ? 'did not finish' : duration(e.ms)}</span></li>`;
}
