// The CTO seat (1.7): a normal Claude Code session that reads `clawdling report --all --json`
// each week, writes cto/reviews/<ISO-week>.md, and asks the owner up to three decisions.
//
// What Clawdling does around it, all deterministic:
//   - the seat's launch settings: Clawdling's hooks (plus one that reports each tool call, so the
//     cockpit can show a cross-agent message beside Claude Code's prompt), the narrow allow-list,
//     ASK rules for `clawdling send` / `clawdling spawn`, and denies for the web and its own files;
//   - the cost estimate before a run; the review page (lint, receipt links, decision cards, and
//     what was sent or declined, read from the seat's own transcripts); the optional weekly run,
//     off by default, once per ISO week, skipped when it would pass the owner's weekly cap.
import fs from 'node:fs';
import path from 'node:path';
import { isoWeek, weekSendTime } from './digest.js';
import { buildHooksSettings } from './hooks.js';
import { PRICES, localDay, priceFor } from './ledger.js';
import { CTO_ID, CTO_UNGUARDED, ctoPermissions } from './org.js';
import { runtimeDeny } from './hooks.js';
import { COST_LABEL } from './report.js';
import { REVIEW_MAX_BYTES, lintReview } from './review-lint.js';
import { INVISIBLE_RE, ReceiptIndex } from './receipts.js';
import { checkThresholds, normalizeThresholds } from './status-rules.js';
import { isSendCommand, parseSend, plainRead } from './seat-policy.js';
import { HttpError, badRequest, conflict, notFound, oneLine, readJson, writeJson } from './util.js';

export const CHECK_MS = 10 * 60000;
export const REVIEW_PROMPT = "Run this week's review.";
const WEEK_RE = /^\d{4}-W\d{2}$/;
const DEFAULT_CAP = 2;
const TRANSCRIPT_MAX = 32 * 1024 * 1024;
const BUSY = new Set(['starting', 'working', 'needs_you']);

/**
 * The seat's --settings file: Clawdling's hooks, with the tool hooks for every tool (the hook
 * script forwards only a tool's name and id, and the command of a cross-agent message), and the
 * seat's permissions. Written by Clawdling into its own runtime folder, which no agent can read or
 * edit; the copy in the seat's folder is for the owner to read.
 */
export function ctoLaunchSettings({ nodePath, hookScript, stopFailure, home, dir, platform = process.platform }) {
  const s = buildHooksSettings({ nodePath, hookScript, platform, stopFailure, home });
  for (const ev of ['PreToolUse', 'PostToolUse']) s.hooks[ev] = s.hooks[ev].map((g) => ({ hooks: g.hooks })); // no matcher: every tool
  // The seat's PreToolUse also answers for it (server/seat-policy.js): "ask" for any command but the
  // report and the session list, and for any write outside reviews/, whatever allow rules exist.
  for (const g of s.hooks.PreToolUse) {
    for (const h of g.hooks) {
      if (Array.isArray(h.args)) h.args.push('cto');
      else h.command = `${h.command} cto`;
    }
  }
  const { allow, ask, deny } = ctoPermissions({ dir, home, platform });
  s.permissions = { allow, ask, deny };
  // No settings layer may switch the seat's hooks off (its own check lives in them).
  s.disableAllHooks = false;
  return s;
}

/** Monday 00:00 (local) of the ISO week holding `now`, to now: the window of "this week's spend". */
export function isoWeekRange(now) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7), 0, 0, 0, 0);
  const list = [];
  for (let t = new Date(start); t.getTime() <= now; t.setDate(t.getDate() + 1)) list.push(localDay(t.getTime()));
  return { key: 'week', days: list.length, start: start.getTime(), end: now, list };
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Cross-agent messages and decisions in one transcript (the seat's own JSONL): every Bash or
 * PowerShell call to `clawdling send|spawn` with what became of it, and every AskUserQuestion with
 * its answers. Read line by line; nothing else is kept.
 */
export function scanTranscript(file) {
  const out = { deliveries: [], decisions: [], commands: [] };
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > TRANSCRIPT_MAX) return out;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  const sends = new Map();
  const others = new Map();
  const asks = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use') && !line.includes('tool_result')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(o?.message?.content) ? o.message.content : [];
    for (const c of content) {
      if (o.type === 'assistant' && c.type === 'tool_use' && typeof c.id === 'string') {
        const cmd = typeof c.input?.command === 'string' ? c.input.command : null;
        if ((c.name === 'Bash' || c.name === 'PowerShell') && cmd && isSendCommand(cmd)) {
          const ps = parseSend(cmd, c.name);
          if (!sends.has(c.id)) sends.set(c.id, { id: c.id, at: o.timestamp || null, verb: ps.verb, command: cmd.slice(0, 4000), plain: ps.plain, message: ps.plain ? ps.message : null, state: 'pending', note: null });
        } else if ((c.name === 'Bash' || c.name === 'PowerShell') && cmd && !plainRead(cmd)) {
          // Any other command it was asked to run (a send in a spelling the page does not read is one).
          if (!others.has(c.id)) others.set(c.id, { id: c.id, at: o.timestamp || null, command: cmd.slice(0, 4000), state: 'pending', note: null });
        } else if (c.name === 'AskUserQuestion' && Array.isArray(c.input?.questions)) {
          if (!asks.has(c.id)) asks.set(c.id, { id: c.id, at: o.timestamp || null, questions: c.input.questions.slice(0, 4).map((q) => ({ question: oneLine(String(q?.question || ''), 300), options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((x) => oneLine(String(x?.label || ''), 120)) })), answers: null, state: 'waiting' });
        }
      } else if (o.type === 'user' && c.type === 'tool_result' && typeof c.tool_use_id === 'string') {
        const result = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '';
        const s = sends.get(c.tool_use_id) || others.get(c.tool_use_id);
        if (s) {
          // Claude Code's own rejection texts, at the start of an error result (a sent message whose
          // output mentions "rejected" is still sent).
          const declined = !!c.is_error && /^\s*(?:Error:\s*)?(?:The user doesn't want to proceed with this tool use|Permission to use \w+ (?:with command [\s\S]*? )?has been denied|User rejected tool use)/.test(result);
          s.state = declined ? 'declined' : c.is_error ? 'failed' : 'sent';
          s.note = oneLine(result, 200);
        }
        const a = asks.get(c.tool_use_id);
        if (a) {
          const tur = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : null;
          if (c.is_error) a.state = 'declined';
          else {
            a.state = 'answered';
            a.answers = tur && tur.answers && typeof tur.answers === 'object' ? Object.fromEntries(Object.entries(tur.answers).slice(0, 4).map(([k, v]) => [oneLine(k, 300), oneLine(String(v), 300)])) : null;
          }
        }
      }
    }
  }
  out.deliveries = [...sends.values()];
  // "sent" reads as "ran" for these; the page words it so.
  out.commands = [...others.values()];
  out.decisions = [...asks.values()];
  return out;
}

/**
 * The CTO's headline made safe for a chat app: one line, 160 characters, no link a phone would make
 * tappable (any "scheme:" token becomes "[link removed]"; a dot inside a word, as in a domain name,
 * becomes a one-dot leader so it reads the same but is not a link), no invisible characters.
 */
export function plainHeadline(text) {
  return oneLine(String(text || ''), 160)
    .replace(INVISIBLE_RE, '')
    .replace(/\b[a-z][a-z0-9+.-]{1,20}:(?:\/\/)?[^\s]*/gi, (m) => (/^(?:https?|ftp|file|mailto|tel|sms|javascript|data|tg|imessage|facetime):/i.test(m) || m.includes('//') ? '[link removed]' : m))
    .replace(/[.\u3002\uff0e\uff61](?=\S)/g, '\u2024')
    // A Telegram @name, a /command (a tap would send it to the bot as you), a #tag; a phone number.
    .replace(/(^|[^\p{L}\p{N}_])[@/#]+(?=[\p{L}\p{N}_])/gu, '$1')
    .replace(/\+?\d[\d ().-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 && !/^\d{4}-\d{2}-\d{2}$/.test(m) ? '[number removed]' : m))
    .replace(/[<>]/g, '')
    .trim();
}

/** Who a delivery went to: the agent id of a spawn, the session of a send; null when unclear. */
export function deliveryTarget(command) {
  return parseSend(command).target;
}

export class Cto {
  constructor({ paths, org, sessions, reports, events, logger, now = () => Date.now() }) {
    Object.assign(this, { paths, org, sessions, reports, events, logger, now });
    this.file = path.join(paths.rt, 'cto.json');
    this.index = new ReceiptIndex(path.join(paths.rt, 'cto', 'receipts'));
    this.timer = null;
    this.running = false;
  }

  // ------------------------------------------------------------------------------------- state

  state() {
    const st = readJson(this.file, {}) || {};
    return {
      enabled: st.enabled === true,
      day: Number.isInteger(st.day) && st.day >= 0 && st.day <= 6 ? st.day : 1,
      hour: Number.isInteger(st.hour) && st.hour >= 0 && st.hour <= 23 ? st.hour : 8,
      weekly_cap_usd: Number.isFinite(st.weekly_cap_usd) && st.weekly_cap_usd > 0 ? st.weekly_cap_usd : DEFAULT_CAP,
      last_run_week: typeof st.last_run_week === 'string' ? st.last_run_week : null,
      last_run_at: typeof st.last_run_at === 'string' ? st.last_run_at : null,
      last_run_sid: typeof st.last_run_sid === 'string' ? st.last_run_sid : null,
      last_skip: st.last_skip && typeof st.last_skip === 'object' ? st.last_skip : null,
      watch_sid: typeof st.watch_sid === 'string' ? st.watch_sid : null,
      thresholds: normalizeThresholds(st.thresholds),
      headline_in_digest: st.headline_in_digest === true,
    };
  }

  save(st) {
    writeJson(this.file, st, 0o600);
  }

  require() {
    const a = this.org.cto();
    if (!a) throw notFound('This org has no CTO yet. Add one from the org map.');
    return a;
  }

  // -------------------------------------------------------------------------------- the seat

  create() {
    const a = this.org.createCto();
    this.events?.record?.({ type: 'agent', action: 'created', id: a.id });
    return a;
  }

  /** The seat's launch settings file, written fresh before every start (sessions.seatLaunch). */
  launchSettings(rec, target, { nodePath, hookScript, stopFailure }) {
    if (!ctoPermissions({ dir: target.dir, home: this.paths.home }).fileRules || !runtimeDeny(this.paths.home).length) throw new HttpError(409, CTO_UNGUARDED);
    // Its folder holds only what Clawdling wrote: no link for reviews/ or .claude/, and nothing in
    // .claude/ but its settings (no skills, commands, agents or local settings to load).
    const odd = [];
    for (const d of ['', 'reviews', '.claude']) {
      try {
        if (fs.lstatSync(path.join(target.dir, d)).isSymbolicLink()) odd.push(d || 'the CTO folder');
      } catch {
        // not there yet
      }
    }
    try {
      for (const n of fs.readdirSync(path.join(target.dir, '.claude'))) if (n !== 'settings.json' && n !== 'settings.json.old') odd.push(`.claude/${n}`);
    } catch {
      // no .claude yet: refreshCtoSettings writes it
    }
    // reviews/ holds plain files with one name each: no link through which a review write lands elsewhere.
    try {
      for (const n of fs.readdirSync(path.join(target.dir, 'reviews'))) {
        const st = fs.lstatSync(path.join(target.dir, 'reviews', n));
        if (!st.isFile() || st.nlink !== 1) odd.push(`reviews/${n}`);
      }
    } catch {
      // no reviews yet
    }
    if (odd.length) throw new HttpError(409, `The CTO will not start: its folder has ${odd.map((x) => `"${x}"`).join(', ')}, which Clawdling did not put there. Remove ${odd.length === 1 ? 'it' : 'them'}, then start it again.`);
    // The folder's own settings file, this version's, at every start (an edited copy is kept as .old).
    this.org.refreshCtoSettings();
    const file = path.join(this.paths.rt, 'cto-launch-settings.json');
    writeJson(file, ctoLaunchSettings({ nodePath, hookScript, stopFailure, home: this.paths.home, dir: target.dir }), 0o600);
    return { settingsPath: file };
  }

  // ---------------------------------------------------------------------------- the estimate

  /**
   * What a review costs, before it runs: the median of the seat's own past sessions when it has
   * some, else from the prompt's size (Claude Code's own context, the CTO's CLAUDE.md and today's
   * report, over a handful of turns) at the model's list price. A range, never a bill.
   */
  async estimate() {
    const a = this.org.cto();
    const past = [];
    try {
      // Weekly reviews only: a short chat between reviews says nothing about what a review costs.
      const reviewSids = new Set(this.ctoSessions().filter((x) => x.review_week).map((x) => x.sid));
      for (const s of this.reports.summaries({ agent: CTO_ID })) if (reviewSids.has(s.sid) && s.turns > 0 && s.cost && s.cost.usd > 0 && s.cost.complete !== false) past.push(s.cost.usd);
    } catch {
      // no receipts
    }
    past.sort((x, y) => x - y);
    if (past.length) {
      const mid = past[Math.floor(past.length / 2)];
      return { low_usd: round2(mid * 0.6), high_usd: round2(Math.max(mid * 1.6, 0.01)), based_on: `the median of the CTO's last ${past.length} weekly review${past.length === 1 ? '' : 's'} (about $${mid.toFixed(2)})`, label: COST_LABEL };
    }
    let reportBytes = 20000;
    try {
      reportBytes = JSON.stringify(await this.reports.allReport({ window: '7d', thresholds: this.state().thresholds, index: false })).length;
    } catch {
      // keep the default
    }
    let mdBytes = 4000;
    try {
      if (a) mdBytes = fs.statSync(path.join(a.dir, 'CLAUDE.md')).size;
    } catch {
      // keep the default
    }
    // No model set: the account's own default, which may be the top tier; price it as the top tier.
    const model = (a && a.model) || 'opus';
    const alias = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5' };
    // A model missing from the price table is priced as the top tier (never below what it may cost).
    const p = priceFor(alias[model] || model) || priceFor('claude-opus-5-5');
    const base = 25000; // Claude Code's own system prompt and tools, roughly
    const ctx = base + Math.ceil((reportBytes + mdBytes) / 3.5);
    const turns = 6;
    const write = (PRICES.cache?.write_5m || 1.25) * p.input;
    const usd = (ctx * write + ctx * (turns - 1) * p.cache_read + 6000 * p.output) / 1e6;
    return { low_usd: round2(usd * 0.5), high_usd: round2(Math.max(usd * 1.5, 0.01)), based_on: `the size of the CTO's prompt (about ${Math.round(ctx / 1000)}k tokens: the report, its CLAUDE.md and Claude Code's own context) at ${model} list prices`, label: COST_LABEL };
  }

  // ----------------------------------------------------------------------------- the reviews

  reviewsDir() {
    return path.join(this.require().dir, 'reviews');
  }

  /** [{week, bytes, updated_at}], newest first. Only plain files named <ISO-week>.md, no links. */
  reviews() {
    const a = this.org.cto();
    if (!a) return [];
    const dir = path.join(a.dir, 'reviews');
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      const m = /^(\d{4}-W\d{2})\.md$/.exec(n);
      if (!m) continue;
      try {
        const st = fs.lstatSync(path.join(dir, n));
        if (st.isFile()) out.push({ week: m[1], bytes: st.size, updated_at: new Date(st.mtimeMs).toISOString(), ...(m[1] > isoWeek(this.now()) ? { future: true } : {}) });
      } catch {
        // raced away
      }
    }
    return out.sort((x, y) => y.week.localeCompare(x.week));
  }

  /** The review file's text, read without following a link out of reviews/, capped. */
  readReview(week) {
    if (!WEEK_RE.test(String(week))) throw badRequest('week looks like 2026-W44');
    const dir = this.reviewsDir();
    const file = path.join(dir, `${week}.md`);
    // reviews/ itself must be a real folder in the seat's folder, and the file a plain file read
    // without following a link (O_NOFOLLOW where the OS has it), checked again once open.
    try {
      if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== path.join(fs.realpathSync(this.require().dir), 'reviews')) throw new Error('moved');
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound(`No review for ${week} yet.`);
      throw new HttpError(422, 'The reviews folder is not a plain folder in the CTO folder.');
    }
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      throw notFound(`No review for ${week} yet.`);
    }
    if (!st.isFile()) throw new HttpError(422, 'The review is not a plain file.');
    if (st.size > REVIEW_MAX_BYTES) throw new HttpError(413, 'The review is larger than 256 KB.');
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.size > REVIEW_MAX_BYTES) throw new HttpError(422, 'The review is not a plain file.');
      const buf = Buffer.alloc(fst.size);
      fs.readSync(fd, buf, 0, fst.size, 0);
      return { text: buf.toString('utf8'), mtimeMs: fst.mtimeMs };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, 'The review is not a plain file.');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  /** The CTO's sessions, newest first. */
  ctoSessions() {
    // Every record the registry keeps (30 days), not only the cockpit's 14-day list.
    const recs = this.sessions.records ? [...this.sessions.records.values()] : [];
    return recs.filter((r) => r.agent === CTO_ID).map((r) => this.sessions.view(r)).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  /**
   * Decisions and deliveries for one ISO week, from the seat's own transcripts: a review session's
   * items go to the week in its title ("CTO review, 2026-W44"), any other session's to the week each
   * item happened. Final states are also kept in .clawdling/cto/activity/<week>.json, so the record
   * outlives the sessions and their transcripts.
   */
  activity(week) {
    const decisions = [];
    const deliveries = [];
    const commands = [];
    const weekOf = (iso) => {
      const t = Date.parse(iso || '');
      return Number.isFinite(t) ? isoWeek(t) : null;
    };
    for (const s of this.ctoSessions()) {
      // A review session (marked by the server, not by its title) belongs to its week.
      const titled = s.review_week || null;
      if (titled && titled !== week) continue;
      // Any other session only if its life touches the week.
      if (!titled && (weekOf(s.created_at) > week || (weekOf(s.last_activity_at || s.created_at) || week) < week)) continue;
      const rec = this.sessions.get(s.sid);
      if (!rec) continue;
      let file = null;
      try {
        file = this.sessions.transcriptFile(rec);
      } catch {
        file = null;
      }
      const scan = file ? this.scan(file) : { deliveries: [], decisions: [], commands: [] };
      const mine = (it) => (titled ? true : weekOf(it.at) === week);
      for (const d of scan.decisions) if (mine(d)) decisions.push({ ...d, sid: s.sid });
      for (const d of scan.deliveries) if (mine(d)) deliveries.push({ ...d, sid: s.sid, to: deliveryTarget(d.command) });
      for (const d of scan.commands || []) if (mine(d)) commands.push({ ...d, sid: s.sid });
      const nowWeek = isoWeek(this.now()) === week;
      // A question on screen now that the transcript does not have yet (Claude Code writes it once answered).
      const ask = s.status === 'needs_you' && s.asking && s.asking.kind === 'question' && s.asking.card ? s.asking : null;
      if (ask && (titled || nowWeek) && !scan.decisions.some((d) => d.id === ask.tool_id)) {
        decisions.push({ id: ask.tool_id, sid: s.sid, at: s.last_activity_at, state: 'waiting', answers: null, questions: (ask.card.questions || []).map((q) => ({ question: oneLine(String(q.question || ''), 300), options: (q.options || []).map((o) => oneLine(String(o.label || ''), 120)) })) });
      }
      // A message waiting for the owner's yes or no right now.
      if (s.pending_cmd && (titled || nowWeek)) {
        if (s.pending_cmd_send !== false) {
          if (!deliveries.some((d) => d.command === s.pending_cmd && d.state === 'pending')) {
            const ps = parseSend(s.pending_cmd);
            deliveries.push({ id: null, sid: s.sid, at: s.last_activity_at, verb: ps.verb, command: s.pending_cmd, plain: ps.plain && s.pending_cmd_plain !== false, message: ps.plain ? ps.message : null, to: ps.target, state: 'asking', note: null });
          }
        } else {
          // Another command waiting for your yes or no: shown once, as asking.
          const same = commands.find((c) => c.command === s.pending_cmd && c.state === 'pending');
          if (same) same.state = 'asking';
          else commands.push({ id: null, sid: s.sid, at: s.last_activity_at, command: s.pending_cmd, state: 'asking', note: null });
        }
      }
    }
    // Keep the final states; merge what was kept before (sessions end, transcripts go).
    const file = path.join(this.paths.rt, 'cto', 'activity', `${week}.json`);
    const kept = readJson(file, null) || {};
    const FINAL = new Set(['answered', 'declined', 'sent', 'failed']);
    const merge = (now, old) => {
      const byId = new Map();
      for (const x of Array.isArray(old) ? old : []) if (x && x.id) byId.set(x.id, x);
      for (const x of now) if (x.id) byId.set(x.id, x);
      return [...byId.values(), ...now.filter((x) => !x.id)];
    };
    const allDecisions = merge(decisions, kept.decisions);
    const allDeliveries = merge(deliveries, kept.deliveries);
    const allCommands = merge(commands, kept.commands);
    const fin = (list) => list.filter((x) => x.id && FINAL.has(x.state)).slice(-50);
    const keep = { decisions: fin(allDecisions), deliveries: fin(allDeliveries), commands: fin(allCommands) };
    if (JSON.stringify(keep) !== JSON.stringify({ decisions: kept.decisions || [], deliveries: kept.deliveries || [], commands: kept.commands || [] })) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeJson(file, keep, 0o600);
      } catch (err) {
        this.logger?.warn?.(`cto: could not keep the week's activity: ${err.message}`);
      }
    }
    const byAt = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));
    return { decisions: allDecisions.sort(byAt), deliveries: allDeliveries.sort(byAt), commands: allCommands.sort(byAt) };
  }

  /** A transcript's decisions and deliveries, read again only when the file changed. */
  scan(file) {
    this.scans = this.scans || new Map();
    let key = null;
    try {
      const st = fs.statSync(file);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      return { deliveries: [], decisions: [] };
    }
    const hit = this.scans.get(file);
    if (hit && hit.key === key) return hit.result;
    const result = scanTranscript(file);
    this.scans.delete(file);
    this.scans.set(file, { key, result });
    while (this.scans.size > 64) this.scans.delete(this.scans.keys().next().value);
    return result;
  }

  /** A CTO turn ended (Stop, SessionEnd): keep its week's record now, not only when a page asks. */
  record(rec) {
    try {
      const now = this.now();
      this.activity(rec.review_week || isoWeek(now));
      // A chat that began last week (a send late on Sunday, its turn ending on Monday).
      const began = Date.parse(rec.created_at || '');
      if (!rec.review_week && Number.isFinite(began) && isoWeek(began) !== isoWeek(now)) this.activity(isoWeek(began));
    } catch (err) {
      this.logger?.warn?.(`cto: could not keep the record: ${err.message}`);
    }
  }

  /** One review for its page: the text, the lint, receipt links, computed labels, decisions, deliveries. */
  review(week) {
    const { text, mtimeMs } = this.readReview(week);
    const receipts = this.index.read(week);
    const labels = this.index.labelsAt(week, mtimeMs);
    const lint = lintReview(text, { receipts, labels });
    const cited = new Set();
    for (const s of lint.sections) for (const b of s.bullets) for (const id of b.ids) cited.add(id);
    for (const b of lint.other) for (const id of b.ids) cited.add(id);
    return {
      week,
      updated_at: new Date(mtimeMs).toISOString(),
      text,
      lint,
      labels,
      receipts: Object.fromEntries([...cited].filter((id) => Object.hasOwn(receipts, id)).map((id) => [id, receipts[id]])),
      ...this.activity(week),
    };
  }

  /** The latest review's headline and how many decisions wait on the owner (the Monday report line). */
  latest() {
    const thisWeek = isoWeek(this.now());
    const r = this.reviews().find((x) => x.week <= thisWeek); // a name in the future is not the latest
    if (!r) return null;
    let headline = null;
    try {
      headline = lintReview(this.readReview(r.week).text).headline;
    } catch {
      headline = null;
    }
    const waiting = this.activity(r.week).decisions.filter((d) => d.state === 'waiting').reduce((n, d) => n + (d.questions?.length || 1), 0);
    return { week: r.week, headline: headline ? oneLine(headline, 160) : null, decisions_waiting: waiting };
  }

  /**
   * The Monday report's CTO line, when the owner turned it on: "CTO: <headline>. 3 decisions waiting
   * in Clawdling." The headline is the CTO's own words: one line, capped, links removed, so a review
   * written under a prompt injection cannot put a link on the owner's phone.
   */
  digestLine({ preview = false } = {}) {
    if ((!preview && !this.state().headline_in_digest) || !this.org.cto()) return null;
    const l = this.latest();
    // Only this week's review or last week's, and it says which (the report may go out first).
    const now = this.now();
    if (!l || (l.week !== isoWeek(now) && l.week !== isoWeek(now - 7 * 86400000))) return null;
    let h = l.headline ? plainHeadline(l.headline) : '';
    h = h.trim();
    const n = l.decisions_waiting;
    const tail = n ? `${n} decision${n === 1 ? '' : 's'} waiting in Clawdling.` : '';
    if (!h && !tail) return null;
    return `CTO, week ${Number(l.week.slice(6))}: ${h ? `${h}${/[.!?]$/.test(h) ? '' : '.'}${tail ? ' ' : ''}` : ''}${tail}`;
  }

  // ------------------------------------------------------------------------------ the run

  /** A review session still at work or waiting on the owner (a finished one is "ready"). */
  busyReview() {
    return this.ctoSessions().find((s) => BUSY.has(s.status) && s.review_week) || null;
  }

  /**
   * Start this week's review (the owner's click, or the schedule): a new CTO session. A review still
   * at work, or waiting on the owner, is not doubled; earlier reviews that finished are ended first
   * (they stay resumable), so weekly runs do not pile up idle Claude Code sessions.
   */
  async startReview({ scheduled = false, week: forWeek = null } = {}) {
    this.require();
    const live = this.busyReview();
    if (live) {
      const e = conflict('A review is still running or waiting for you. Open it to answer its questions.');
      e.body = { sid: live.sid };
      throw e;
    }
    for (const s of this.ctoSessions()) {
      if (s.status === 'ready' && s.review_week) {
        try {
          this.activity(s.review_week); // keep its record first
          await this.sessions.end(s.sid);
        } catch (err) {
          this.logger?.warn?.(`cto: could not end the earlier review ${s.sid}: ${err.message}`);
        }
      }
    }
    const week = forWeek || isoWeek(this.now());
    const s = await this.sessions.spawn({ agent: CTO_ID, prompt: `${REVIEW_PROMPT} The week is ${week}.`, title: `CTO review, ${week}`, reviewWeek: week });
    this.events?.record?.({ type: 'cto', action: scheduled ? 'scheduled-review' : 'review', sid: s.sid, week });
    return s;
  }

  /** The CTO's spend so far this ISO week (list-price equivalent from its receipts). */
  weekSpend() {
    try {
      const c = this.reports.costOf(this.reports.summaries({ agent: CTO_ID }), isoWeekRange(this.now()));
      return { usd: c.total_usd, complete: c.complete, unknown_models: c.unknown_models || [], partly: (c.sessions_partly_unknown || 0) + (c.sessions_counting || 0), missing: c.sessions_without_cost || 0 };
    } catch {
      return { usd: 0, complete: false, error: true };
    }
  }

  // --------------------------------------------------------------------------- the schedule

  async view() {
    const a = this.org.cto();
    const st = this.state();
    const now = this.now();
    let next = weekSendTime(now, st);
    if ((st.last_run_week && st.last_run_week >= isoWeek(now)) || now > next + 6 * 86400000) next = weekSendTime(now + 7 * 86400000, st);
    let perms = null;
    if (a) {
      const p = ctoPermissions({ dir: a.dir, home: this.paths.home });
      perms = { allow: p.allow, ask: p.ask, deny: p.deny, file_rules: p.fileRules };
    }
    const sessions = a ? this.ctoSessions().slice(0, 10) : [];
    return {
      exists: !!a,
      agent: a ? { id: a.id, name: a.name, dir: a.dir, model: a.model } : null,
      week: isoWeek(now),
      reviews: this.reviews(),
      latest: a ? this.latest() : null,
      running: a ? this.busyReview()?.sid || null : null,
      permissions: perms,
      schedule: {
        enabled: st.enabled,
        day: st.day,
        hour: st.hour,
        weekly_cap_usd: st.weekly_cap_usd,
        last_run_week: st.last_run_week,
        last_run_at: st.last_run_at,
        last_skip: st.last_skip,
        next_at: st.enabled ? new Date(next).toISOString() : null,
        spent_this_week: this.weekSpend(),
      },
      thresholds: st.thresholds,
      headline_in_digest: st.headline_in_digest,
      // Exactly the line the Monday report would add now (shown before it is turned on).
      headline_preview: a ? this.digestLine({ preview: true }) : null,
      label: COST_LABEL,
    };
  }

  /**
   * {enabled?, day?, hour?, weekly_cap_usd?, thresholds?, headline_in_digest?}. Turning the
   * schedule on needs a seat and a cap; the estimate it shows comes with the view.
   */
  configure(b = {}) {
    const st = this.state();
    if (b.day !== undefined) {
      if (!Number.isInteger(b.day) || b.day < 0 || b.day > 6) throw badRequest('day must be 0 (Sunday) to 6 (Saturday)');
      st.day = b.day;
    }
    if (b.hour !== undefined) {
      if (!Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23) throw badRequest('hour must be 0 to 23');
      st.hour = b.hour;
    }
    if (b.weekly_cap_usd !== undefined) {
      if (typeof b.weekly_cap_usd !== 'number' || !Number.isFinite(b.weekly_cap_usd) || b.weekly_cap_usd <= 0 || b.weekly_cap_usd > 100) throw badRequest('weekly_cap_usd must be more than 0 and at most 100');
      st.weekly_cap_usd = round2(b.weekly_cap_usd);
    }
    if (b.thresholds !== undefined) {
      try {
        st.thresholds = checkThresholds({ ...st.thresholds, ...b.thresholds });
      } catch (err) {
        throw badRequest(err.message);
      }
    }
    if (b.headline_in_digest !== undefined) {
      if (typeof b.headline_in_digest !== 'boolean') throw badRequest('headline_in_digest must be true or false');
      st.headline_in_digest = b.headline_in_digest;
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw badRequest('enabled must be true or false');
      if (b.enabled && !this.org.cto()) throw badRequest('Add a CTO first.');
      // Turned on after this week's run time: the first scheduled run is next week (no surprise run now).
      if (b.enabled && !st.enabled && this.now() >= weekSendTime(this.now(), st) && !(st.last_run_week && st.last_run_week >= isoWeek(this.now()))) st.last_run_week = isoWeek(this.now());
      st.enabled = b.enabled;
    }
    this.save(st);
    this.events?.record?.({ type: 'cto', action: 'configured', enabled: st.enabled });
    return st;
  }

  /**
   * Run the weekly review if the schedule is on, it is due this ISO week, it has not run this week,
   * and it fits under the weekly cap (spent this week plus the high end of the estimate). A run that
   * would not fit is skipped, once, with a notice; it never retries that week.
   */
  async check() {
    if (this.running) return { ran: false, why: 'busy' };
    const st = this.state();
    if (!st.enabled) return { ran: false, why: 'off' };
    if (!this.org.cto()) return { ran: false, why: 'no seat' };
    const now = this.now();
    const week = isoWeek(now);
    // ISO-week names sort in order: a clock set back never runs an earlier week again.
    if (st.last_run_week && st.last_run_week >= week) return { ran: false, why: 'ran this week' };
    if (now < weekSendTime(now, st)) return { ran: false, why: 'not yet' };
    this.running = true;
    try {
      const est = await this.estimate();
      // The owner may have changed the schedule while the estimate was built: decide on the fresh state.
      const fresh = this.state();
      // The week may have turned while the estimate was built: the run belongs to the week it starts in.
      if (isoWeek(this.now()) !== week) return { ran: false, why: 'the week changed' };
      if (!fresh.enabled || (fresh.last_run_week && fresh.last_run_week >= week) || this.now() < weekSendTime(this.now(), fresh)) return { ran: false, why: !fresh.enabled ? 'off' : 'changed' };
      Object.assign(st, fresh);
      const spent = this.weekSpend();
      // Counted before starting, like the Monday report: a failure never turns into a retry storm.
      st.last_run_week = week;
      st.last_run_at = new Date(now).toISOString();
      if (spent.error || spent.complete === false) {
        st.last_skip = { week, at: st.last_run_at, why: "This week's CTO review was skipped: Clawdling could not fully count what the CTO has used this week, so it could not check the weekly cap." };
        this.save(st);
        this.events?.record?.({ type: 'cto', action: 'skipped', week });
        return { ran: false, why: 'spend unknown', notice: st.last_skip.why };
      }
      if (spent.usd + est.high_usd > st.weekly_cap_usd) {
        st.last_skip = { week, at: st.last_run_at, why: `This week's CTO review was skipped: it could cost up to $${est.high_usd.toFixed(2)}, and the CTO has used $${spent.usd.toFixed(2)} of its $${st.weekly_cap_usd.toFixed(2)} weekly cap.` };
        this.save(st);
        this.events?.record?.({ type: 'cto', action: 'skipped', week });
        this.events?.publish?.('cto', { action: 'skipped', week, why: st.last_skip.why });
        return { ran: false, why: 'cap', notice: st.last_skip.why };
      }
      this.save(st);
      const s = await this.startReview({ scheduled: true, week });
      const after = this.state();
      after.last_run_sid = s.sid;
      after.watch_sid = s.sid; // its spend is watched while it runs unattended (watchSpend)
      after.last_skip = null;
      this.save(after);
      return { ran: true, sid: s.sid };
    } catch (err) {
      const why = String(err.message || err).slice(0, 200);
      const cur = this.state();
      cur.last_skip = { week, at: new Date(now).toISOString(), why: `This week's CTO review could not start: ${why}` };
      this.save(cur);
      this.logger?.warn?.(`cto: scheduled review: ${why}`);
      return { ran: false, why };
    } finally {
      this.running = false;
    }
  }

  /** Whether a session is ended and its claude is no longer running. */
  async gone(rec) {
    if (!rec) return true;
    if (rec.status !== 'ended') return false;
    return !(await Promise.resolve(this.sessions.backend?.hasSession?.(rec.tmux_name)).catch(() => false));
  }

  /** The owner acted in the scheduled review (sent, answered, typed, resumed): from now on it is theirs. */
  handOver(sid) {
    const cur = this.state();
    if (!sid || cur.watch_sid !== sid) return;
    cur.watch_sid = null;
    this.save(cur);
  }

  /**
   * A scheduled review runs unattended, and an interactive Claude Code turn has no budget flag: while
   * it works, its spend is checked every minute, and past the weekly cap the session is ended (it
   * stays resumable) with a notice. A review you start yourself is yours to stop.
   */
  async watchSpend() {
    const st = this.state();
    const sid = st.watch_sid;
    const rec = sid ? this.sessions.get(sid) : null;
    if (!rec) return { stopped: false };
    // Watched in every live status until the owner acts in it (handOver): a status alone is not a
    // hand-over (Clawdling itself can mark a slow start "needs you" while it runs on unattended).
    // Ended means gone: a session marked ended while its claude still runs (a timed-out check) stays watched.
    if (await this.gone(rec)) {
      const cur = this.state();
      if (cur.watch_sid === sid) {
        cur.watch_sid = null;
        this.save(cur);
      }
      return { stopped: false };
    }
    // Idle on the owner (its turn ended, or a question a hook reported): it spends nothing, so the
    // owner's own CTO chats passing the cap must not end it (its decisions would vanish). A slow
    // start Clawdling itself marked "needs you" may be running, so it is checked.
    if (rec.status === 'ready' || (rec.status === 'needs_you' && rec.waiting_on && rec.waiting_on !== 'startup')) return { stopped: false };
    const spent = this.weekSpend();
    // Spend that cannot be counted (a model missing from the price table, unreadable usage) stops it
    // too: unpriced usage adds $0 and would never pass the cap. A fresh session gets two minutes.
    const age = this.now() - Date.parse(rec.launched_at || rec.created_at || 0);
    const uncounted = spent.error || spent.unknown_models.length > 0 || spent.partly > 0 || (spent.missing > 0 && age > 2 * 60000);
    if (!(spent.usd > st.weekly_cap_usd) && !uncounted) return { stopped: false };
    try {
      await this.sessions.end(sid);
    } catch (err) {
      this.logger?.warn?.(`cto: could not stop the scheduled review: ${err.message}`);
    }
    // Recorded as stopped only once it is: otherwise it stays watched, and the next minute tries again.
    if (!(await this.gone(this.sessions.get(sid)))) return { stopped: false, retry: true };
    const now = this.state();
    now.watch_sid = null;
    now.last_skip = { week: isoWeek(this.now()), at: new Date(this.now()).toISOString(), why: uncounted && !(spent.usd > st.weekly_cap_usd)
      ? "This week's scheduled CTO review was stopped: Clawdling could not count what it was using (a model it has no price for?), so it could not hold the weekly cap. Resume it yourself if you want it to finish."
      : `This week's scheduled CTO review was stopped: it had used $${spent.usd.toFixed(2)}, past its $${st.weekly_cap_usd.toFixed(2)} weekly cap. Resume it yourself if you want it to finish.` };
    this.save(now);
    this.events?.record?.({ type: 'cto', action: 'stopped-over-cap', sid });
    this.events?.publish?.('cto', { action: 'stopped', why: now.last_skip.why });
    return { stopped: true };
  }

  start(intervalMs = CHECK_MS, spendMs = 60000) {
    const run = () => this.check().catch((err) => this.logger?.warn?.(`cto: ${err.message}`));
    setTimeout(run, 6000).unref?.();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
    this.spendTimer = setInterval(() => this.watchSpend().catch((err) => this.logger?.warn?.(`cto: ${err.message}`)), spendMs);
    this.spendTimer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.spendTimer);
    this.timer = null;
    this.spendTimer = null;
  }
}
