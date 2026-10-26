// The report card (1.5): for every agent, in plain words, what got done, what needs the owner,
// what it used (a list-price equivalent, never a bill) and what it says it will do next.
//
// Built from Claude Code's own transcripts (server/ledger.js), the session registry, the agent's
// memory/NOW.md and `git log` in the agent's repos. No model call, nothing leaves the computer.
// Its JSON shape is a contract (`clawdling report --json`; the 1.7 CTO seat reads it): SCHEMA.
import fs from 'node:fs';
import path from 'node:path';
import { LedgerReader, LedgerStore, localDay, subagentFiles, summarize, timeline } from './ledger.js';
import { badRequest, execFileP, isUuid, oneLine } from './util.js';

export const SCHEMA = 1;
export const WINDOWS = { today: 1, '7d': 7, '30d': 30 };
const DAY = 86400000;
const STALE_MS = 7 * DAY;
const LIVE_REFRESH_MS = 60000;
const NEXT_MAX = 1500;
const GIT_TIMEOUT = 5000;
// A commit counts for a session that ran `git commit` within two minutes of it (see agentReport).
const COMMIT_SLACK = 2 * 60000;

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
  if (typeof text !== 'string' || !text.trim()) return { text: '', heading: null, updated_at, stale: false, empty: true }; // nothing to be stale
  // No terminal control characters (the CLI prints this), and headings inside code fences are text.
  const lines = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').split('\n');
  const fenced = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    fenced.push(inFence);
  }
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
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
      const m = !fenced[i] && /^(#{1,6})\s/.exec(lines[i]);
      if (m && m[1].length <= level) break;
      body.push(lines[i]);
    }
  } else {
    body = lines.filter((l) => l.trim()).slice(0, 5);
  }
  let out = body.join('\n').replace(/^\n+|\s+$/g, '');
  if (out.length > NEXT_MAX) out = `${out.slice(0, NEXT_MAX - 1)}…`;
  return { text: out, heading, updated_at, stale: stale && !!out.trim(), empty: !out.trim() };
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
  // protocol.allow=never and GIT_NO_LAZY_FETCH: a partial clone whose config names a promisor
  // remote cannot make `git log` fetch (and so run a transport the repo's config chose).
  const args = [
    '-c', 'log.showSignature=false', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'color.ui=false', '-c', 'protocol.allow=never',
    // A repo's own protocol.<name>.allow beats protocol.allow; these command-line values beat it.
    ...['ext', 'file', 'ssh', 'git', 'http', 'https'].flatMap((p) => ['-c', `protocol.${p}.allow=never`]),
    '-C', repo, 'log', '--no-show-signature', '--no-notes', '--no-color', `--since=${new Date(sinceMs).toISOString()}`,
    '--format=%H%x1f%s%x1f%cI', '-n', '200',
  ];
  try {
    const { stdout } = await exec('git', args, { timeout, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_NO_LAZY_FETCH: '1', GIT_PROTOCOL_FROM_USER: '0' } });
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
  if (usd === 0) return '$0.00';
  if (usd > 0 && usd < 0.005) return 'less than $0.01';
  return `about $${usd.toFixed(2)}`;
}
export const COST_LABEL = 'list-price equivalent, not a bill. On Pro and Max, usage is included in your plan.';

/** Every surface's one rule: an amount with nothing known behind it is "unknown", never $0. */
export function costText(usd, complete = true) {
  if (!complete && !(usd > 0)) return 'cost unknown';
  return `${dollars(usd)}${complete ? '' : ' plus some unknown'}`;
}

/** What decides whether a transcript changed: the main file and its subagent files. */
export function sourceKey(file) {
  const key = { size: null, mtime_ms: null, subs: 0, subs_size: 0, subs_mtime: 0 };
  try {
    const st = fs.statSync(file);
    key.size = st.size;
    key.mtime_ms = st.mtimeMs;
  } catch {
    // raced away
  }
  for (const f of subagentFiles(file)) {
    try {
      const st = fs.statSync(f);
      key.subs++;
      key.subs_size += st.size;
      key.subs_mtime = Math.max(key.subs_mtime, st.mtimeMs);
    } catch {
      // gone
    }
  }
  return key;
}
const sameKey = (a, b) => !!a && !!b && ['size', 'mtime_ms', 'subs', 'subs_size', 'subs_mtime'].every((k) => a[k] === b[k]);

const PART_FIELDS = ['turns', 'tools', 'tool_errors', 'files_changed', 'subagents', 'cost', 'days', 'unknown_days', 'commit_times', 'last_line', 'last_line_at', 'started_at', 'last_at', 'format', 'claims'];

/** The per-file fields a receipt keeps (no prompt text: the last line is the agent's own words). */
function partOf(s) {
  if (!s) return { turns: 0, tools: 0, tool_errors: 0, files_changed: 0, subagents: 0, cost: { usd: null, source: 'none', complete: false, unknown_models: [], models: {} }, days: {}, unknown_days: {}, commit_times: [], last_line: null, last_line_at: null, started_at: null, last_at: null, format: { ok: false, issues: ['unreadable'] }, claims: [] };
  return Object.fromEntries(PART_FIELDS.map((k) => [k, s[k] ?? null]));
}

/** A receipt from before parts existed (one file). */
function legacyPart(r) {
  return { path: r.transcript_path, ...Object.fromEntries(PART_FIELDS.map((k) => [k, r[k] ?? null])), source: r.source || null };
}

/** A session's figures from its parts. */
export function mergeParts(parts) {
  const out = { turns: 0, tools: 0, tool_errors: 0, files_changed: 0, subagents: 0, days: {}, unknown_days: {}, commit_times: [], last_line: null, last_line_at: null, started_at: null, last_at: null, claims: [] };
  const cost = { usd: 0, source: null, complete: true, unknown_models: new Set(), models: {} };
  let priced = 0;
  const issues = new Set();
  let ok = true;
  for (const p of parts) {
    for (const k of ['turns', 'tools', 'tool_errors', 'files_changed', 'subagents']) out[k] += Number(p[k]) || 0;
    const c = p.cost || {};
    if (Number.isFinite(c.usd)) {
      cost.usd += c.usd;
      priced++;
    } else cost.complete = false;
    if (c.complete === false) cost.complete = false;
    for (const m of c.unknown_models || []) cost.unknown_models.add(m);
    for (const [m, v] of Object.entries(c.models || {})) if (Number.isFinite(v)) cost.models[m] = (cost.models[m] || 0) + v;
    cost.source = cost.source === null ? c.source || 'none' : cost.source === c.source ? cost.source : 'mixed';
    for (const [d, v] of Object.entries(p.days || {})) if (Number.isFinite(v)) out.days[d] = (out.days[d] || 0) + v;
    for (const [d, ms] of Object.entries(p.unknown_days || {})) out.unknown_days[d] = [...new Set([...(out.unknown_days[d] || []), ...ms])].sort();
    out.commit_times.push(...(Array.isArray(p.commit_times) ? p.commit_times : []));
    out.claims.push(...(Array.isArray(p.claims) ? p.claims : []));
    if (p.last_line && (!out.last_line_at || String(p.last_line_at || '') >= out.last_line_at)) {
      out.last_line = p.last_line;
      out.last_line_at = p.last_line_at || out.last_line_at;
    }
    if (p.started_at && (!out.started_at || p.started_at < out.started_at)) out.started_at = p.started_at;
    if (p.last_at && (!out.last_at || p.last_at > out.last_at)) out.last_at = p.last_at;
    if (p.format && p.format.ok === false) ok = false;
    for (const i of p.format?.issues || []) issues.add(i);
  }
  out.claims = out.claims.sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))).slice(-50);
  // No part with a known cost (unreadable transcripts): unknown, never $0.
  out.cost = { usd: priced || !parts.length ? cost.usd : null, source: cost.source || 'none', complete: cost.complete, unknown_models: [...cost.unknown_models].sort(), models: cost.models };
  out.format = { ok, issues: [...issues].slice(0, 10) };
  return out;
}

/**
 * Reports for one org. `sessions` is the SessionManager (records, views, transcript lookup).
 * Session summaries are cached in .clawdling/ledger (receipts that outlive transcripts).
 */
export class Reports {
  constructor({ paths, org, sessions, env = process.env, logger, exec = execFileP, now = () => Date.now(), reader = new LedgerReader() }) {
    Object.assign(this, { paths, org, sessions, env, logger, exec, now, reader });
    this.store = new LedgerStore(paths.ledger || path.join(paths.rt, 'ledger'));
    this.written = new Map(); // sid -> ms of the last write while live
    this.timelines = new Map(); // sid -> {stamp, all, cost}: the Timeline, built once per change
    this.backfilling = false;
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
   * The summary for one session record. A record can use several transcript files over its life
   * (`/clear` starts a new one): each is a "part" of its receipt, summarized from its file when that
   * changed (the main file or any subagent file) and kept as it was once the file is gone. The
   * session's figures are the parts added up.
   */
  /**
   * Who owns each conversation id: of the sessions that use it (as their own id, or as their Claude
   * Code id after a /clear or a /resume), the one active most recently. One owner each, so a
   * transcript is never counted twice, and work resumed today shows under today's session.
   */
  owners() {
    const map = new Map();
    const rank = new Map(); // id -> [is it their current conversation, last activity]
    const claim = (id, r, current) => {
      if (!id) return;
      const t = String(r.last_activity_at || r.created_at || '');
      const prev = rank.get(id);
      // A session using it now always beats one that used it before (and moved on with /clear).
      if (!prev || (current && !prev[0]) || (current === prev[0] && t > prev[1])) {
        map.set(id, r.sid);
        rank.set(id, [current, t]);
      }
    };
    for (const r of this.sessions.records.values()) {
      const now = r.claude_session_id || r.sid;
      claim(now, r, true);
      if (r.sid !== now) claim(r.sid, r, false);
      // Every conversation the session used in between (each /clear), from its receipt's parts.
      if (r.resumed_from) claim(r.resumed_from, r, false);
      for (const p of this.store.read(r.sid)?.parts || []) {
        const id = path.basename(String(p.path || ''), '.jsonl');
        if (id !== now && id !== r.sid) claim(id, r, false);
      }
    }
    return map;
  }

  summary(rec, { force = false, lazy = false, also = null, owners = null } = {}) {
    const prev = this.store.read(rec.sid);
    const own = owners || this.owners();
    // A transcript whose conversation another Clawdling session owns (a `/resume <it>` typed inside
    // this pane) is counted under that session only.
    const foreign = (f) => {
      const owner = own.get(path.basename(String(f), '.jsonl'));
      return !!owner && owner !== rec.sid;
    };
    const mine = this.transcriptOf(rec);
    const file = mine && !foreign(mine) ? mine : null;
    const base = { v: 1, sid: rec.sid, agent: rec.agent, title: rec.title || null, status: rec.status, prompted: !!rec.prompted, account: rec.account || null, created_at: rec.created_at || null, ended_at: rec.ended_at || null, last_activity_at: rec.last_activity_at || null };
    const parts = Array.isArray(prev?.parts) ? prev.parts.map((p) => ({ ...p })) : prev && prev.transcript_path ? [legacyPart(prev)] : [];
    let changed = false;
    // The files this session used before (a /clear) are read again if they changed since.
    // Conversations this session owns but has no part for yet (its own first one, or one it resumed),
    // found beside any file it has: read too, so an ownership change never loses usage.
    const dirs = new Set([mine, ...parts.map((p) => p.path), also].filter((f) => typeof f === 'string' && f).map((f) => path.dirname(f)));
    const ownedIds = [rec.sid, rec.resumed_from].filter((id) => isUuid(id) && own.get(id) === rec.sid);
    const extra = [];
    for (const d of dirs) for (const id of ownedIds) extra.push(path.join(d, `${id}.jsonl`));
    // Parts are never deleted: one another session owns now is kept, marked, and left out of the sums.
    const earlier = new Set([...parts.map((p) => p.path), ...(also ? [also] : []), ...extra].filter((f) => typeof f === 'string' && f !== file && !foreign(f)));
    for (const f of earlier) {
      if (!/[\\/]projects[\\/][^\\/]+[\\/][0-9a-f-]{36}\.jsonl$/.test(f) || !fs.existsSync(f)) continue;
      const key = sourceKey(f);
      const i = parts.findIndex((p) => p.path === f);
      // A part from before claim receipts (1.6) is read once more, while its transcript is there.
      if (i !== -1 && sameKey(parts[i].source, key) && Array.isArray(parts[i].claims)) continue;
      try {
        const part = { path: f, ...partOf(summarize(this.reader.session(f))), source: key };
        if (i === -1) parts.push(part);
        else parts[i] = part;
        changed = true;
        this.reader.forget(f);
      } catch (err) {
        this.logger?.warn?.(`report: could not read an earlier transcript of ${rec.sid}: ${err.message}`);
      }
    }
    if (file) {
      const key = sourceKey(file);
      const i = parts.findIndex((p) => p.path === file);
      const stale = force || i === -1 || !sameKey(parts[i].source, key) || !Array.isArray(parts[i].claims);
      // While the start-up backfill runs, a request never parses an ended session's transcript: it
      // uses the receipt it has, or says the session is still being counted.
      if (stale && lazy && this.backfilling && rec.status === 'ended') {
        if (!parts.length) return { ...base, transcript: 'counting', counting: true, parts: [], ...mergeParts([]), cost: { usd: null, source: 'none', complete: false, unknown_models: [], models: {} }, last_line: rec.last_message || null };
      } else if (stale) {
        let part;
        try {
          part = { path: file, ...partOf(summarize(this.reader.session(file))), source: key };
        } catch (err) {
          this.logger?.warn?.(`report: could not read the transcript of ${rec.sid}: ${err.message}`);
          // Kept, so it is not parsed again on every request until the file changes.
          part = { path: file, unreadable: true, ...partOf(null), source: null }; // retried next time
        }
        if (i === -1) parts.push(part);
        else parts[i] = part;
        changed = true;
        if (rec.status === 'ended') this.reader.forget(file); // its totals now live in the receipt
      }
    }
    const elsewhere = mine && !file ? own.get(path.basename(mine, '.jsonl')) : null;
    if (!parts.length) {
      // Its conversation is counted under the session that used it last: nothing here, nothing unknown.
      if (elsewhere) return { ...base, transcript: 'elsewhere', owner_sid: elsewhere, parts: [], ...mergeParts([]), cost: { usd: 0, source: 'none', complete: true, unknown_models: [], models: {} }, last_line: null };
      return { ...base, transcript: 'missing', parts: [], ...mergeParts([]), cost: { usd: null, source: 'none', complete: false, unknown_models: [], models: {} }, last_line: rec.last_message || null };
    }
    parts.sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
    for (const p of parts) {
      const f = foreign(p.path);
      if (!!p.foreign !== f) {
        p.foreign = f;
        changed = true;
      }
    }
    const merged = mergeParts(parts.filter((p) => !p.foreign));
    const current = file ? parts.find((p) => p.path === file) : null;
    const out = {
      ...base,
      ...merged,
      parts,
      // A live session whose new transcript is not written yet (just after /clear) is not "gone".
      transcript: elsewhere ? 'elsewhere' : !file ? (rec.status === 'ended' ? 'gone' : 'waiting') : current?.unreadable ? 'unreadable' : 'ok',
      ...(elsewhere ? { owner_sid: elsewhere } : {}),
      transcript_path: file || parts[parts.length - 1].path,
      last_line: merged.last_line || rec.last_message || null,
      updated_at: changed ? new Date(this.now()).toISOString() : prev?.updated_at || null,
    };
    const baseChanged = !prev || ['status', 'title', 'ended_at', 'agent'].some((k) => prev[k] !== out[k]);
    if (!changed && !baseChanged) return out;
    // A running session is written at most once a minute; an ended one every time it changed.
    const live = rec.status !== 'ended';
    const last = this.written.get(rec.sid) || 0;
    if (!live || force || !prev || this.now() - last >= LIVE_REFRESH_MS) {
      try {
        this.store.write(out);
        this.written.set(rec.sid, this.now());
      } catch (err) {
        this.logger?.warn?.(`report: could not save the receipt of ${rec.sid}: ${err.message}`);
      }
    }
    return out;
  }

  /**
   * Build the receipts the registry's sessions do not have yet (an upgrade, or a cold start), one
   * session per event-loop turn, so a first report does not stall the server.
   */
  backfill() {
    const recs = [...this.sessions.records.values()].filter((r) => r.purpose !== 'signin');
    const owners = this.owners();
    let i = 0;
    this.backfilling = recs.length > 0;
    const step = () => {
      if (i >= recs.length || this.stopped) {
        this.backfilling = false;
        return;
      }
      try {
        this.summary(recs[i++], { owners });
      } catch (err) {
        this.logger?.warn?.(`report: ${err.message}`);
      }
      setImmediate(step).unref?.();
    };
    setImmediate(step).unref?.();
  }

  /** The session moved to a new transcript (/clear): keep the one it left in its receipt, now. */
  transcriptSwitched(rec, oldPath) {
    try {
      this.summary(rec, { force: true, also: oldPath });
    } catch (err) {
      this.logger?.warn?.(`report: ${err.message}`);
    }
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
    const owners = this.owners(); // once per report
    for (const rec of this.sessions.records.values()) {
      if (agent && rec.agent !== agent) continue;
      if (rec.purpose === 'signin') continue; // a sign-in session is not work
      out.set(rec.sid, this.summary(rec, { lazy: true, owners }));
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
    // A commit is credited to a session only when that session ran a successful `git commit` within
    // a minute of it (from its own transcript), and to one session at most.
    const owner = new Map();
    for (const s of all) {
      for (const iso of Array.isArray(s.commit_times) ? s.commit_times : []) {
        const t = Date.parse(iso);
        for (const c of pool) {
          const d = Math.abs(Date.parse(c.at) - t);
          if (!Number.isFinite(d) || d > COMMIT_SLACK) continue;
          const cur = owner.get(c.hash);
          if (!cur || d < cur.d) owner.set(c.hash, { sid: s.sid, d });
        }
      }
    }
    for (const s of all) {
      if (!(s.turns > 0 || s.tools > 0) || !inWindow(whenOf(s))) continue;
      const commits = repos.length ? pool.filter((c) => owner.get(c.hash)?.sid === s.sid) : null;
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
      const st = fs.statSync(f);
      if (st.isFile()) {
        mtime = st.mtimeMs;
        const fd = fs.openSync(f, 'r');
        try {
          const buf = Buffer.alloc(Math.min(st.size, 256 * 1024));
          fs.readSync(fd, buf, 0, buf.length, 0);
          nowText = buf.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      }
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
    const dayUnknown = new Set(); // days with usage whose cost is unknown
    const byModel = {};
    const byAccount = {};
    const sessions = [];
    const unknown = new Set();
    let total = 0;
    let missing = 0;
    let counting = 0;
    let partial = 0;
    for (const s of summaries) {
      if (s.counting) {
        const t = Date.parse(s.ended_at || s.last_activity_at || '');
        if (Number.isFinite(t) && t >= w.start) counting++;
        continue;
      }
      // A cost Clawdling could not read (no model to blame): that session's usage is unknown, or
      // part of it is (an earlier transcript, or files past the subagent cap).
      const unreadable = s.cost && s.cost.complete === false && !(s.cost.unknown_models || []).length;
      const days = s.days && typeof s.days === 'object' ? s.days : {};
      // Usage in the window on a model with no price: the total is incomplete, never a quiet $0.
      const udays = s.unknown_days && typeof s.unknown_days === 'object' ? s.unknown_days : {};
      for (const d of w.list) for (const m of udays[d] || []) { unknown.add(m); dayUnknown.add(d); }
      let share = 0;
      for (const d of w.list) if (Number.isFinite(days[d])) share += days[d];
      const touched = w.list.some((d) => Object.hasOwn(days, d));
      if (!touched) {
        // No priced usage in the window. A session active in it whose cost is unknown is counted.
        const t = Date.parse(s.last_activity_at || s.last_at || '');
        const active = Number.isFinite(t) && t >= w.start && (s.turns > 0 || s.prompted);
        if (active && s.cost && s.cost.usd === null) missing++;
        else if (active && unreadable) partial++;
        else if (active && s.cost && s.cost.complete === false && !w.list.some((d) => (udays[d] || []).length)) for (const m of s.cost.unknown_models || []) unknown.add(m);
        continue;
      }
      for (const d of w.list) if (Number.isFinite(days[d])) byDay[d] += days[d];
      if (unreadable) partial++;
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
      complete: unknown.size === 0 && missing === 0 && counting === 0 && partial === 0,
      unknown_models: [...unknown].sort(),
      sessions_without_cost: missing,
      sessions_partly_unknown: partial,
      sessions_counting: counting,
      by_day: w.list.map((d) => ({ day: d, usd: r6(byDay[d]), ...(dayUnknown.has(d) ? { complete: false } : {}) })),
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
      totals: { today_usd: t1.total_usd, week_usd: t7.total_usd, today_complete: t1.complete, week_complete: t7.complete, complete: t1.complete && t7.complete },
      agents,
    };
  }

  /** The session's Timeline, paged: entries after `after`, at most `limit`. */
  timeline(sid, { after = -1, limit = 500, enrich = null, enrichStamp = null } = {}) {
    if (!isUuid(sid)) throw badRequest('invalid session id');
    const rec = this.sessions.require(sid);
    const found = this.transcriptOf(rec);
    const owner = found ? this.owners().get(path.basename(found, '.jsonl')) : null;
    // A conversation another session used more recently: its steps are shown there, like the card.
    if (found && owner && owner !== rec.sid) return { entries: [], next: after, more: false, total: 0, transcript: 'elsewhere', owner_sid: owner, owner_title: this.sessions.get(owner)?.title || null, status: rec.status };
    const file = found;
    if (!file) {
      const kept = this.store.read(sid);
      return { entries: [], next: after, more: false, total: 0, transcript: kept && rec.status === 'ended' ? 'gone' : 'missing', summary: kept ? { turns: kept.turns, tools: kept.tools, last_line: kept.last_line, cost: kept.cost } : null, status: rec.status };
    }
    const data = this.reader.session(file);
    // Built once per change (paging a live session reads the same list several times in a row).
    const stamp = `${file}:${data.main.size}:${data.main.mtimeMs}:${data.subs.map((x) => `${x.size}/${x.mtimeMs}`).join(',')}:${rec.status}:${enrichStamp ? enrichStamp() : ''}`;
    let memo = this.timelines.get(sid);
    if (!memo || memo.stamp !== stamp) {
      const all = timeline(data, { ended: rec.status === 'ended' });
      // Telemetry (the detailed timeline) is matched against the whole list, then paged.
      if (enrich) enrich(all);
      memo = { stamp, all, cost: summarize(data).cost };
      this.timelines.delete(sid);
      this.timelines.set(sid, memo);
      while (this.timelines.size > 16) this.timelines.delete(this.timelines.keys().next().value);
    }
    const { all } = memo;
    const page = all.filter((e) => e.n > after).slice(0, limit);
    const next = page.length ? page[page.length - 1].n : after;
    const s = { cost: memo.cost };
    return { entries: page, next, more: all.length > 0 && all[all.length - 1].n > next, total: all.length, transcript: 'ok', status: rec.status, cost: s.cost, label: COST_LABEL };
  }
}
