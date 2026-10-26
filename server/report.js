// The report card (1.5): for every agent, in plain words, what got done, what needs the owner,
// what it used (a list-price equivalent, never a bill) and what it says it will do next.
//
// Built from Claude Code's own transcripts (server/ledger.js), the session registry, the agent's
// memory/NOW.md and `git log` in the agent's repos. No model call, nothing leaves the computer.
// Its JSON shape is a contract (`clawdling report --json`; the 1.7 CTO seat reads it): SCHEMA.
import fs from 'node:fs';
import path from 'node:path';
import { LedgerReader, LedgerStore, localDay, summarize, timeline } from './ledger.js';
import { badRequest, execFileP, isUuid, oneLine } from './util.js';

export const SCHEMA = 1;
export const WINDOWS = { today: 1, '7d': 7, '30d': 30 };
const DAY = 86400000;
const STALE_MS = 7 * DAY;
const LIVE_REFRESH_MS = 60000;
const NEXT_MAX = 1500;
const GIT_TIMEOUT = 5000;
// A commit counts for a session if it was made while the session ran (a minute of slack each side).
const COMMIT_SLACK = 60000;

/** {key, days, start, end, list: ['YYYY-MM-DD', ...]} for today / 7d / 30d, in local time. */
export function windowRange(key = '7d', now = Date.now()) {
  if (!Object.hasOwn(WINDOWS, key)) throw badRequest('window must be today, 7d or 30d');
  const days = WINDOWS[key];
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = new Date(midnight);
  start.setDate(start.getDate() - (days - 1));
  const list = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    list.push(localDay(d.getTime()));
  }
  return { key, days, start: start.getTime(), end: now, list };
}

// Waiting on the owner, exactly like the cockpit's rail (web/lib/model.js needsYou): Claude asked
// something or a turn failed (needs_you), or it finished a turn and waits for a reply (ready with a
// last message and no background work still running).
export function needsYouView(v) {
  if (!v || v.status === 'ended') return false;
  if (v.status === 'needs_you') return true;
  const watching = v.status === 'ready' && !!v.background && v.background.count > 0;
  return v.status === 'ready' && !!v.last_message && !watching;
}

const NEED_KIND = { permission_prompt: 'permission', elicitation_dialog: 'question', error: 'error', login: 'sign_in', trust: 'startup', imports: 'startup', startup: 'startup' };

/** What one waiting session needs, in a word: question, plan, permission, error, sign_in, startup, reply. */
export function needKind(v) {
  if (v.status !== 'needs_you') return 'reply';
  if (v.asking && (v.asking.kind === 'question' || v.asking.kind === 'plan')) return v.asking.kind;
  return NEED_KIND[v.waiting_on] || 'question';
}

/**
 * The "Next" part of NOW.md: the section under a heading that starts with "Next" ("## Next steps"),
 * else the first five lines. With when the file was last written, and whether that is over 7 days.
 */
export function nextOf(text, mtimeMs, now = Date.now()) {
  const updated_at = Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : null;
  const stale = Number.isFinite(mtimeMs) ? now - mtimeMs > STALE_MS : false;
  if (typeof text !== 'string' || !text.trim()) return { text: '', heading: null, updated_at, stale, empty: true };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m && /^next\b/i.test(m[2].replace(/[*_`]/g, '').trim())) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  let body;
  let heading = null;
  if (start !== -1) {
    heading = lines[start].replace(/^#+\s*/, '').trim();
    body = [];
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^(#{1,6})\s/.exec(lines[i]);
      if (m && m[1].length <= level) break;
      body.push(lines[i]);
    }
  } else {
    body = lines.filter((l) => l.trim()).slice(0, 5);
  }
  let out = body.join('\n').replace(/^\n+|\s+$/g, '');
  if (out.length > NEXT_MAX) out = `${out.slice(0, NEXT_MAX - 1)}…`;
  return { text: out, heading, updated_at, stale, empty: !out.trim() };
}

/**
 * `git log` for a window: subject lines only, no diffs. Arguments go as an array (no shell), and
 * the repo's own config cannot make it run another program (signature checks, pager, fsmonitor).
 */
export async function gitCommits(repo, sinceMs, { exec = execFileP, env = process.env, timeout = GIT_TIMEOUT } = {}) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) return { ok: false, error: 'no repo', commits: [] };
  try {
    if (!fs.statSync(repo).isDirectory()) return { ok: false, error: 'the repo folder is gone', commits: [] };
  } catch {
    return { ok: false, error: 'the repo folder is gone', commits: [] };
  }
  const args = [
    '-c', 'log.showSignature=false', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'color.ui=false',
    '-C', repo, 'log', '--no-show-signature', '--no-notes', '--no-color', `--since=${new Date(sinceMs).toISOString()}`,
    '--format=%H%x1f%s%x1f%aI', '-n', '200',
  ];
  try {
    const { stdout } = await exec('git', args, { timeout, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' } });
    const commits = [];
    for (const line of String(stdout).split('\n')) {
      const [hash, subject, when] = line.split('\x1f');
      if (!/^[0-9a-f]{7,64}$/.test(hash || '') || !when) continue;
      const at = Date.parse(when);
      if (!Number.isFinite(at)) continue;
      commits.push({ hash: hash.slice(0, 12), subject: oneLine(subject || '', 200), at: new Date(at).toISOString() });
    }
    return { ok: true, commits };
  } catch (err) {
    const msg = err && err.code === 'ENOENT' ? 'git is not installed' : /not a git repository/i.test(String(err?.stderr || '')) ? 'not a git repository' : 'git log failed';
    return { ok: false, error: msg, commits: [] };
  }
}

const round2 = (x) => Math.round(x * 100) / 100;

/** "about $4.10", "less than $0.01", the plain label every dollar figure carries. */
export function dollars(usd) {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return 'unknown';
  if (usd > 0 && usd < 0.005) return 'less than $0.01';
  return `about $${usd.toFixed(2)}`;
}
export const COST_LABEL = 'list-price equivalent, not a bill. On Pro and Max, usage is included in your plan.';

/**
 * Reports for one org. `sessions` is the SessionManager (records, views, transcript lookup).
 * Session summaries are cached in .clawdling/ledger (receipts that outlive transcripts).
 */
export class Reports {
  constructor({ paths, org, sessions, env = process.env, logger, exec = execFileP, now = () => Date.now(), reader = new LedgerReader() }) {
    Object.assign(this, { paths, org, sessions, env, logger, exec, now, reader });
    this.store = new LedgerStore(paths.ledger || path.join(paths.rt, 'ledger'));
    this.written = new Map(); // sid -> ms of the last write while live
    this.pruned = 0;
  }

  /** The session's transcript file, or null. */
  transcriptOf(rec) {
    try {
      return this.sessions.transcriptFile(rec);
    } catch {
      return null;
    }
  }

  /**
   * The summary for one session record: from its transcript when that changed since the last
   * receipt, else the receipt. A transcript that is gone keeps the receipt, marked so.
   */
  summary(rec, { force = false } = {}) {
    const prev = this.store.read(rec.sid);
    const file = this.transcriptOf(rec);
    const base = { v: 1, sid: rec.sid, agent: rec.agent, title: rec.title || null, status: rec.status, prompted: !!rec.prompted, account: rec.account || null, created_at: rec.created_at || null, ended_at: rec.ended_at || null, last_activity_at: rec.last_activity_at || null };
    if (!file) {
      if (prev) return { ...prev, ...base, transcript: 'gone' };
      return { ...base, transcript: 'missing', turns: 0, tools: 0, tool_errors: 0, files_changed: 0, cost: { usd: null, source: 'none', complete: false, unknown_models: [], models: {} }, days: {}, last_line: rec.last_message || null };
    }
    let size = null;
    let mtime = null;
    try {
      const st = fs.statSync(file);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      // raced away
    }
    const live = rec.status !== 'ended';
    if (!force && prev && prev.source && prev.source.size === size && prev.source.mtime_ms === mtime && prev.transcript === 'ok' && (!live || prev.status === rec.status)) {
      return { ...prev, ...base };
    }
    let s;
    try {
      s = summarize(this.reader.session(file));
    } catch (err) {
      this.logger?.warn?.(`report: could not read the transcript of ${rec.sid}: ${err.message}`);
      return prev ? { ...prev, ...base, transcript: 'gone' } : { ...base, transcript: 'unreadable', turns: 0, tools: 0, tool_errors: 0, files_changed: 0, cost: { usd: null, source: 'none', complete: false, unknown_models: [], models: {} }, days: {} };
    }
    const out = { ...base, ...s, transcript: 'ok', transcript_path: file, last_line: s.last_line || rec.last_message || null, updated_at: new Date(this.now()).toISOString() };
    // A running session is written at most once a minute; an ended one every time it changed.
    const last = this.written.get(rec.sid) || 0;
    if (!live || force || this.now() - last >= LIVE_REFRESH_MS || !prev) {
      try {
        this.store.write(out);
        this.written.set(rec.sid, this.now());
      } catch (err) {
        this.logger?.warn?.(`report: could not save the receipt of ${rec.sid}: ${err.message}`);
      }
    }
    return out;
  }

  /** A session ended (or was resumed): write its receipt now. */
  sessionEnded(rec) {
    try {
      this.summary(rec, { force: true });
      if (this.now() - this.pruned > 3600000) {
        this.pruned = this.now();
        this.store.prune(this.now());
      }
    } catch (err) {
      this.logger?.warn?.(`report: ${err.message}`);
    }
  }

  /** Summaries of every session (registry first, then receipts the registry has forgotten). */
  summaries({ agent } = {}) {
    const out = new Map();
    for (const rec of this.sessions.records.values()) {
      if (agent && rec.agent !== agent) continue;
      if (rec.purpose === 'signin') continue; // a sign-in session is not work
      out.set(rec.sid, this.summary(rec));
    }
    for (const r of this.store.list({ agent })) {
      if (!out.has(r.sid)) out.set(r.sid, { ...r, transcript: r.transcript_path && fs.existsSync(r.transcript_path) ? 'ok' : 'gone' });
    }
    return [...out.values()];
  }

  async agentReport(agentId, { window = '7d' } = {}) {
    const agent = this.org.require(agentId);
    const w = windowRange(window, this.now());
    const all = this.summaries({ agent: agentId });
    const inWindow = (iso) => {
      const t = Date.parse(iso || '');
      return Number.isFinite(t) && t >= w.start && t <= w.end + 60000;
    };
    const whenOf = (s) => (s.status === 'ended' ? s.ended_at || s.last_at || s.last_activity_at : s.last_activity_at || s.last_at);
    // Repos: commits by time, one git log per repo for the window.
    const repos = [agent.repo, ...(Array.isArray(agent.repos) ? agent.repos : [])].filter((r, i, a) => typeof r === 'string' && r && a.indexOf(r) === i);
    const git = [];
    for (const repo of repos.slice(0, 8)) git.push({ repo, ...(await gitCommits(repo, w.start, { exec: this.exec, env: this.env })) });
    const pool = git.flatMap((g) => g.commits.map((c) => ({ ...c, repo: g.repo })));
    const used = new Set();
    const done = [];
    for (const s of all) {
      if (!(s.turns > 0 || s.tools > 0) || !inWindow(whenOf(s))) continue;
      const from = Date.parse(s.started_at || s.created_at || '') - COMMIT_SLACK;
      const to = (s.status === 'ended' ? Date.parse(s.ended_at || s.last_at || '') : this.now()) + COMMIT_SLACK;
      const commits = repos.length ? pool.filter((c) => {
        const t = Date.parse(c.at);
        return Number.isFinite(from) && t >= from && t <= to;
      }) : null;
      if (commits) for (const c of commits) used.add(c.hash);
      done.push({
        sid: s.sid,
        title: s.title || null,
        line: s.last_line || null,
        files_changed: s.files_changed ?? 0,
        tool_errors: s.tool_errors ?? 0,
        turns: s.turns ?? 0,
        when: whenOf(s),
        live: s.status !== 'ended',
        status: s.status,
        commits: commits ? commits.slice(0, 20).map(({ hash, subject, at }) => ({ hash, subject, at })) : null,
        transcript: s.transcript,
      });
    }
    done.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
    const other = pool.filter((c) => !used.has(c.hash)).slice(0, 20).map(({ hash, subject, at }) => ({ hash, subject, at }));

    const needs = [];
    for (const rec of this.sessions.records.values()) {
      if (rec.agent !== agentId) continue;
      const v = this.sessions.view(rec);
      if (!needsYouView(v)) continue;
      needs.push({ sid: v.sid, title: v.title || null, kind: needKind(v), text: oneLine(v.status === 'needs_you' ? v.notification || '' : v.last_message || '', 240), since: v.last_activity_at });
    }
    needs.sort((a, b) => (a.kind === 'reply') - (b.kind === 'reply') || String(b.since || '').localeCompare(String(a.since || '')));

    const cost = this.costOf(all, w);
    let nowText = '';
    let mtime = NaN;
    try {
      const f = path.join(agent.dir, 'memory', 'NOW.md');
      nowText = fs.readFileSync(f, 'utf8');
      mtime = fs.statSync(f).mtimeMs;
    } catch {
      // no NOW.md
    }
    return {
      schema: SCHEMA,
      generated_at: new Date(this.now()).toISOString(),
      window: { key: w.key, from: new Date(w.start).toISOString(), to: new Date(w.end).toISOString(), days: w.list },
      agent: { id: agent.id, name: agent.name, kind: agent.kind, has_repo: repos.length > 0 },
      done,
      repo_commits: repos.length ? { other, errors: git.filter((g) => !g.ok).map((g) => ({ repo: g.repo, error: g.error })) } : null,
      needs,
      cost,
      next: nextOf(nowText, mtime, this.now()),
    };
  }

  /** Usage in a window: total, by day, by model, top three sessions; list-price equivalents. */
  costOf(summaries, w) {
    const byDay = Object.fromEntries(w.list.map((d) => [d, 0]));
    const byModel = {};
    const byAccount = {};
    const sessions = [];
    const unknown = new Set();
    let total = 0;
    let missing = 0;
    for (const s of summaries) {
      const days = s.days && typeof s.days === 'object' ? s.days : {};
      let share = 0;
      for (const d of w.list) if (Number.isFinite(days[d])) share += days[d];
      const touched = w.list.some((d) => Object.hasOwn(days, d));
      if (!touched) {
        // No usage on record in the window. A session active in it whose cost is unknown is counted.
        const t = Date.parse(s.last_activity_at || s.last_at || '');
        if (s.cost && s.cost.usd === null && Number.isFinite(t) && t >= w.start && (s.turns > 0 || s.prompted)) missing++;
        continue;
      }
      for (const d of w.list) if (Number.isFinite(days[d])) byDay[d] += days[d];
      total += share;
      const sessionTotal = Object.values(days).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      const k = sessionTotal > 0 ? share / sessionTotal : 0;
      for (const [m, usd] of Object.entries(s.cost?.models || {})) if (Number.isFinite(usd)) byModel[m] = (byModel[m] || 0) + usd * k;
      const acct = s.account && s.account !== 'default' ? s.account : 'default';
      byAccount[acct] = (byAccount[acct] || 0) + share;
      for (const m of s.cost?.unknown_models || []) unknown.add(m);
      sessions.push({ sid: s.sid, title: s.title || null, usd: share, account: s.account || null });
    }
    sessions.sort((a, b) => b.usd - a.usd);
    const r6 = (x) => Number(x.toFixed(6));
    return {
      total_usd: r6(total),
      label: COST_LABEL,
      complete: unknown.size === 0 && missing === 0,
      unknown_models: [...unknown].sort(),
      sessions_without_cost: missing,
      by_day: w.list.map((d) => ({ day: d, usd: r6(byDay[d]) })),
      by_model: Object.entries(byModel).map(([model, usd]) => ({ model, usd: r6(usd) })).sort((a, b) => b.usd - a.usd),
      by_account: Object.keys(byAccount).length > 1 ? Object.entries(byAccount).map(([account, usd]) => ({ account, usd: r6(usd) })) : [],
      top_sessions: sessions.slice(0, 3).map((x) => ({ ...x, usd: r6(x.usd) })),
    };
  }

  /** Per agent for the org map and the totals: cost and done counts over the window, last done. */
  orgReport({ window = '7d' } = {}) {
    const now = this.now();
    const w = windowRange(window, now);
    const today = windowRange('today', now);
    const week = windowRange('7d', now);
    const all = this.summaries();
    const byAgent = new Map();
    for (const s of all) {
      if (!byAgent.has(s.agent)) byAgent.set(s.agent, []);
      byAgent.get(s.agent).push(s);
    }
    const agents = [];
    for (const a of this.org.agents()) {
      const list = byAgent.get(a.id) || [];
      const c = this.costOf(list, w);
      let lastDone = null;
      let doneCount = 0;
      for (const s of list) {
        if (!(s.turns > 0 || s.tools > 0)) continue;
        const when = s.status === 'ended' ? s.ended_at || s.last_at : s.last_line_at || null;
        if (when && (!lastDone || when > lastDone)) lastDone = when;
        const t = Date.parse((s.status === 'ended' ? s.ended_at : s.last_activity_at) || s.last_at || '');
        if (Number.isFinite(t) && t >= w.start) doneCount++;
      }
      let needs = 0;
      for (const rec of this.sessions.records.values()) if (rec.agent === a.id && needsYouView(this.sessions.view(rec))) needs++;
      agents.push({ id: a.id, name: a.name, kind: a.kind, cost_usd: c.total_usd, cost_complete: c.complete, done: doneCount, needs, last_done_at: lastDone });
    }
    const tot = (win) => this.costOf(all, win);
    const t1 = tot(today);
    const t7 = tot(week);
    return {
      schema: SCHEMA,
      generated_at: new Date(now).toISOString(),
      window: { key: w.key, from: new Date(w.start).toISOString(), to: new Date(w.end).toISOString() },
      label: COST_LABEL,
      totals: { today_usd: t1.total_usd, week_usd: t7.total_usd, complete: t1.complete && t7.complete },
      agents,
    };
  }

  /** The session's Timeline, paged: entries after `after`, at most `limit`. */
  timeline(sid, { after = -1, limit = 500 } = {}) {
    if (!isUuid(sid)) throw badRequest('invalid session id');
    const rec = this.sessions.require(sid);
    const file = this.transcriptOf(rec);
    if (!file) {
      const kept = this.store.read(sid);
      return { entries: [], next: after, more: false, total: 0, transcript: kept ? 'gone' : 'missing', summary: kept ? { turns: kept.turns, tools: kept.tools, last_line: kept.last_line, cost: kept.cost } : null, status: rec.status };
    }
    const data = this.reader.session(file);
    const all = timeline(data);
    const page = all.filter((e) => e.n > after).slice(0, limit);
    const next = page.length ? page[page.length - 1].n : after;
    const s = summarize(data);
    return { entries: page, next, more: all.length > 0 && all[all.length - 1].n > next, total: all.length, transcript: 'ok', status: rec.status, cost: s.cost, label: COST_LABEL };
  }
}
