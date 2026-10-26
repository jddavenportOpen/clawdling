// The session ledger (1.5): what a session did and what it used, read from Claude Code's own
// transcript JSONL. transcripts.js keeps only the chat; this reads the records it drops: tool
// results, subagents, usage and the CLI's own cost-state. Read-only and local; no model call.
//
// Record shapes (Claude Code 2.1.283, checked 2026-10-25; undocumented, so test/fixtures/
// transcripts/ pins them):
//   assistant  message.{id, model, usage, content[]}, requestId, timestamp, isSidechain
//   user       a prompt (text), or tool_result blocks {tool_use_id, is_error} plus toolUseResult
//   cost-state {totalCostUSD, hasUnknownModelCost, modelUsage{model: {costUSD}}, ...}: cumulative,
//              written when a session exits or resumes (not while it runs)
//   subagents  <session>/subagents/agent-*.jsonl, each with agent-*.meta.json {toolUseId,
//              description}; workflow agents under subagents/workflows/<id>/ have no toolUseId
import fs from 'node:fs';
import path from 'node:path';
import { toolSummary, transcriptEntry } from './transcripts.js';
import { isUuid, oneLine } from './util.js';

export const PRICES = JSON.parse(fs.readFileSync(new URL('./prices.json', import.meta.url), 'utf8'));
// The tools that change a file, by file_path. Paths are counted, never sent anywhere.
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const TEXT_MAX = 300;
const PROMPT_MAX = 500;
const SUB_FILES_MAX = 500;
// Where the CLI's own number and the repriced one differ by more than this, the CLI's number is
// shown and the gap is counted (a price table out of date, or a record shape that changed).
const GAP = 0.02;
export const costGaps = { count: 0, last: null };

/** A model's list prices, or null when it is not in the table (its cost is unknown, never 0). */
export function priceFor(model, prices = PRICES) {
  if (typeof model !== 'string' || !model) return null;
  const id = model.toLowerCase().trim().replace(/\[[^\]]*\]$/, '').replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '');
  let best = null;
  for (const p of prices.models) {
    if (!id.startsWith(p.match)) continue;
    const rest = id.slice(p.match.length);
    if (rest && !/^(?:-\d{8}|@.*|-v\d.*)$/.test(rest)) continue; // claude-opus-5 is not claude-opus-5-6
    if (!best || p.match.length > best.match.length) best = p;
  }
  return best;
}

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/** List-price dollars for one API message's usage, or null for a model not in the table. */
export function usageCost(model, u, prices = PRICES) {
  const p = priceFor(model, prices);
  if (!p || !u || typeof u !== 'object') return p ? 0 : null;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  let w5 = num(cc?.ephemeral_5m_input_tokens);
  let w1 = num(cc?.ephemeral_1h_input_tokens);
  // No 5-minute / 1-hour split (older versions): all cache writes at the 5-minute price.
  if (w5 + w1 === 0) w5 = num(u.cache_creation_input_tokens);
  return (num(u.input_tokens) * p.input + num(u.output_tokens) * p.output + w5 * p.input * prices.cache.write_5m + w1 * p.input * prices.cache.write_1h + num(u.cache_read_input_tokens) * p.cache_read) / 1e6;
}

/** YYYY-MM-DD of a time, in this computer's time zone. */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const cut = (s, max) => {
  const t = oneLine(String(s || ''), max + 1);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The agent's own last words, trimmed to `max` characters at a sentence end when there is one
 * in reach ("Done." beats "Done. I also…"), else at a word.
 */
export function lastLine(text, max = 160) {
  const t = oneLine(String(text || '').replace(/[`*_#>]+/g, ''), 4000).trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (stop >= max * 0.25) return head.slice(0, stop + 1);
  const sp = head.lastIndexOf(' ');
  return `${head.slice(0, sp > max * 0.5 ? sp : max - 1)}…`;
}

function newState(file, ino) {
  return {
    file, ino, offset: 0, rest: Buffer.alloc(0), seq: 0,
    items: [], // in transcript order: {k: 'prompt'|'say'|'tool', ...}
    tools: new Map(), // tool_use id -> {id, name, summary, file, ts, end, error, turn, depth}
    usage: new Map(), // message.id + requestId -> {model, usage, ts, turn}
    turn: 0, prompts: 0, lastText: null, costState: null,
    firstTs: null, lastTs: null, records: 0, assistants: 0, issues: new Set(), meta: null,
  };
}

function readMeta(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return m && typeof m === 'object' ? { toolUseId: typeof m.toolUseId === 'string' ? m.toolUseId : null, description: typeof m.description === 'string' ? cut(m.description, 120) : '', agentType: typeof m.agentType === 'string' ? cut(m.agentType, 60) : '' } : null;
  } catch {
    return null;
  }
}

/** Apply one parsed record to a file's state. `sub`: this file is a subagent's transcript. */
export function applyRecord(st, o, { sub = false } = {}) {
  if (!o || typeof o !== 'object') return;
  st.records++;
  st.seq++;
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (Number.isFinite(ts)) {
    if (st.firstTs === null || ts < st.firstTs) st.firstTs = ts;
    if (st.lastTs === null || ts > st.lastTs) st.lastTs = ts;
  }
  const at = Number.isFinite(ts) ? ts : st.lastTs;
  if (o.type === 'cost-state') {
    st.costState = {
      total: Number.isFinite(o.totalCostUSD) ? o.totalCostUSD : null,
      unknown: o.hasUnknownModelCost === true,
      modelUsage: o.modelUsage && typeof o.modelUsage === 'object' ? o.modelUsage : {},
      apiMs: num(o.totalAPIDuration), toolMs: num(o.totalToolDuration),
      linesAdded: num(o.totalLinesAdded), linesRemoved: num(o.totalLinesRemoved),
      at: st.lastTs, // it has no timestamp of its own: as of the newest record before it
    };
    if (st.costState.total === null) st.issues.add('cost-state without totalCostUSD');
    return;
  }
  const side = sub || o.isSidechain === true;
  if (o.type === 'assistant') {
    st.assistants++;
    const msg = o.message;
    if (!msg || typeof msg !== 'object') {
      st.issues.add('assistant record without message');
      return;
    }
    const model = typeof msg.model === 'string' ? msg.model : null;
    if (model === '<synthetic>') return; // Claude Code's own placeholder: no API call, no usage
    if (msg.usage && typeof msg.usage === 'object') {
      const id = typeof msg.id === 'string' ? msg.id : '';
      const req = typeof o.requestId === 'string' ? o.requestId : '';
      // One API message is often split across several records that repeat its usage: count it once.
      const key = id || req ? `${id}\u0000${req}` : `#${st.seq}`;
      const prev = st.usage.get(key);
      st.usage.set(key, { model: model || prev?.model || null, usage: msg.usage, ts: at, turn: prev ? prev.turn : st.turn });
    } else if (!sub && model) st.issues.add('assistant record without usage');
    const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
    if (!Array.isArray(msg.content) && typeof msg.content !== 'string') st.issues.add('assistant message without content');
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        if (!side) st.lastText = { text: b.text, ts: at };
        st.items.push({ k: 'say', ts: at, text: cut(b.text, TEXT_MAX), side });
      } else if (b.type === 'tool_use' && typeof b.id === 'string') {
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        const name = typeof b.name === 'string' ? b.name.slice(0, 80) : 'tool';
        const t = { id: b.id.slice(0, 100), name, summary: toolSummary(input), file: EDIT_TOOLS.has(name) && typeof input.file_path === 'string' ? input.file_path : EDIT_TOOLS.has(name) && typeof input.notebook_path === 'string' ? input.notebook_path : null, ts: at, end: null, error: null, turn: st.turn, side };
        // A subagent written into the main file (older versions): under the newest open Agent call.
        if (side && !sub) t.parent = st.openAgent || null;
        if (!st.tools.has(t.id)) {
          st.tools.set(t.id, t);
          st.items.push({ k: 'tool', id: t.id, ts: at, side });
        }
        if (AGENT_TOOLS.has(name) && !side) st.openAgent = t.id;
      }
    }
    return;
  }
  if (o.type === 'user') {
    const msg = o.message;
    const content = msg && typeof msg === 'object' ? msg.content : null;
    if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
      for (const b of content) {
        if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const t = st.tools.get(b.tool_use_id);
        if (!t) continue;
        t.end = at;
        t.error = b.is_error === true;
        const r = o.toolUseResult;
        if (r && typeof r === 'object' && typeof r.agentId === 'string') t.agentId = r.agentId.slice(0, 60);
        if (st.openAgent === t.id) st.openAgent = null;
      }
      return;
    }
    if (side) return;
    const e = transcriptEntry(o);
    if (e && e.role === 'user') {
      st.turn++;
      st.prompts++;
      st.items.push({ k: 'prompt', ts: at, text: cut(e.text, PROMPT_MAX), turn: st.turn });
    }
  }
}

/** Read what was appended to a file since the last call (offset, inode, partial last line). */
function advance(st) {
  let fstat;
  try {
    fstat = fs.statSync(st.file);
  } catch {
    st.gone = true;
    return st;
  }
  st.gone = false;
  if (fstat.size < st.offset || fstat.ino !== st.ino) Object.assign(st, newState(st.file, fstat.ino), { meta: st.meta, isSub: st.isSub });
  st.size = fstat.size;
  st.mtimeMs = fstat.mtimeMs;
  if (fstat.size === st.offset) return st;
  const fd = fs.openSync(st.file, 'r');
  try {
    const buf = Buffer.alloc(fstat.size - st.offset);
    fs.readSync(fd, buf, 0, buf.length, st.offset);
    st.offset = fstat.size;
    const all = st.rest.length ? Buffer.concat([st.rest, buf]) : buf;
    const nl = all.lastIndexOf(0x0a);
    const complete = nl === -1 ? '' : all.subarray(0, nl).toString('utf8');
    st.rest = Buffer.from(nl === -1 ? all : all.subarray(nl + 1));
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        st.issues.add('a line that is not JSON');
        continue;
      }
      applyRecord(st, o, { sub: !!st.meta || st.isSub });
    }
  } finally {
    fs.closeSync(fd);
  }
  return st;
}

/** Every subagent transcript beside a session's file: <dir>/<sid>/subagents/**.jsonl. */
export function subagentFiles(mainFile) {
  const root = path.join(path.dirname(mainFile), path.basename(mainFile, '.jsonl'), 'subagents');
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3 || out.length >= SUB_FILES_MAX) return;
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (out.length >= SUB_FILES_MAX) return;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(f);
    }
  };
  walk(root, 0);
  return out.sort();
}

/** Incremental reader of whole sessions (main transcript plus its subagents), cached per file. */
export class LedgerReader {
  constructor({ maxFiles = 256 } = {}) {
    this.cache = new Map();
    this.maxFiles = maxFiles;
  }

  state(file, sub) {
    let st = this.cache.get(file);
    if (!st) {
      st = newState(file, null);
      if (sub) {
        st.isSub = true;
        st.meta = readMeta(file) || { toolUseId: null, description: '', agentType: '' };
      }
    } else this.cache.delete(file);
    this.cache.set(file, st);
    return advance(st);
  }

  /** {main, subs[]} for a session's transcript file, read up to now. */
  session(mainFile) {
    const main = this.state(mainFile, false);
    const subs = main.gone ? [] : subagentFiles(mainFile).map((f) => this.state(f, true));
    while (this.cache.size > this.maxFiles) this.cache.delete(this.cache.keys().next().value);
    return { main, subs };
  }
}

/**
 * The session's totals. Cost rules (SPEC-1.5 3.1): usage is counted once per API message; the
 * CLI's own cost-state total is used when it is current (nothing used after it) and knows every
 * model; else the usage is repriced with prices.json, and a model not in it makes the total
 * incomplete ("cost unknown for model X"), never 0.
 */
export function summarize({ main, subs }, { prices = PRICES } = {}) {
  const parentTurn = new Map();
  for (const t of main.tools.values()) parentTurn.set(t.id, t.turn);
  const all = [];
  for (const u of main.usage.values()) all.push(u);
  for (const s of subs) {
    const turn = s.meta?.toolUseId && parentTurn.has(s.meta.toolUseId) ? parentTurn.get(s.meta.toolUseId) : null;
    for (const u of s.usage.values()) all.push({ ...u, turn: turn ?? u.turn });
  }
  let repriced = 0;
  const byModel = {};
  const unknown = new Set();
  const priced = []; // {ts, usd}
  let newest = null;
  for (const u of all) {
    const usd = usageCost(u.model, u.usage, prices);
    if (u.ts !== null && (newest === null || u.ts > newest)) newest = u.ts;
    if (usd === null) {
      if (u.model) unknown.add(u.model);
      else unknown.add('unknown model');
      continue;
    }
    repriced += usd;
    const m = u.model || 'unknown model';
    byModel[m] = (byModel[m] || 0) + usd;
    priced.push({ ts: u.ts, usd, turn: u.turn });
  }
  const cs = main.costState;
  const current = !!cs && cs.total !== null && (newest === null || (cs.at !== null && newest <= cs.at));
  let cost;
  if (current && !cs.unknown) {
    const models = {};
    for (const [m, v] of Object.entries(cs.modelUsage)) if (v && Number.isFinite(v.costUSD)) models[m] = v.costUSD;
    cost = { usd: cs.total, source: 'cli', complete: true, unknown_models: [], models: Object.keys(models).length ? models : byModel };
    if (repriced > 0 && Math.abs(cs.total - repriced) / Math.max(cs.total, repriced) > GAP) {
      costGaps.count++;
      costGaps.last = { cli: cs.total, repriced, at: new Date().toISOString() };
    }
  } else {
    cost = { usd: repriced, source: 'repriced', complete: unknown.size === 0, unknown_models: [...unknown].sort(), models: byModel };
  }
  // By day, in this computer's time zone. With the CLI's own total, each message's share of the
  // repriced cost carries the same share of the CLI's number, so the days add up to the total.
  const factor = cost.source === 'cli' && repriced > 0 ? cost.usd / repriced : 1;
  const days = {};
  for (const p of priced) {
    if (p.ts === null) continue;
    const d = localDay(p.ts);
    days[d] = (days[d] || 0) + p.usd * factor;
  }
  if (cost.source === 'cli' && repriced === 0 && cost.usd > 0) {
    const t = main.lastTs ?? Date.now();
    days[localDay(t)] = cost.usd;
  }
  const tools = [...main.tools.values(), ...subs.flatMap((s) => [...s.tools.values()])];
  const changed = new Set();
  for (const t of tools) if (t.file && t.error !== true && t.end !== null) changed.add(t.file);
  const issues = new Set(main.issues);
  for (const s of subs) for (const i of s.issues) issues.add(`subagent: ${i}`);
  // A transcript with records but no turn, tool or usage this parser knows is a format it has not seen.
  const unseen = main.records > 0 && main.assistants === 0 && main.prompts === 0 && !main.costState;
  if (unseen) issues.add('no record this version of Clawdling knows');
  return {
    turns: main.prompts,
    tools: tools.length,
    tool_errors: tools.filter((t) => t.error === true).length,
    files_changed: changed.size,
    subagents: subs.length,
    cost,
    days,
    last_line: main.lastText ? lastLine(main.lastText.text) : null,
    last_line_at: main.lastText ? new Date(main.lastText.ts ?? main.lastTs ?? Date.now()).toISOString() : null,
    started_at: main.firstTs !== null ? new Date(main.firstTs).toISOString() : null,
    last_at: main.lastTs !== null ? new Date(main.lastTs).toISOString() : null,
    cli: cs ? { api_ms: cs.apiMs, tool_ms: cs.toolMs, lines_added: cs.linesAdded, lines_removed: cs.linesRemoved } : null,
    format: { ok: issues.size === 0, issues: [...issues].slice(0, 10) },
    source: { size: main.size ?? null, mtime_ms: main.mtimeMs ?? null, subs: subs.length },
  };
}

/**
 * The Timeline: every prompt, tool call (name, one-line summary, duration, ok or error), the
 * agent's words, and subagents nested under the call that started them; cost per turn on each
 * prompt (always repriced: the CLI keeps no per-turn number). Entries are numbered for paging.
 */
export function timeline({ main, subs }, { prices = PRICES } = {}) {
  const turnCost = new Map();
  const turnUnknown = new Set();
  const parentTurn = new Map();
  for (const t of main.tools.values()) parentTurn.set(t.id, t.turn);
  const addCost = (u, turn) => {
    const usd = usageCost(u.model, u.usage, prices);
    if (usd === null) turnUnknown.add(turn);
    else turnCost.set(turn, (turnCost.get(turn) || 0) + usd);
  };
  for (const u of main.usage.values()) addCost(u, u.turn);
  const byParent = new Map();
  const loose = [];
  for (const s of subs) {
    const p = s.meta?.toolUseId;
    const turn = p && parentTurn.has(p) ? parentTurn.get(p) : null;
    for (const u of s.usage.values()) addCost(u, turn ?? u.turn);
    if (p && main.tools.has(p)) {
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(s);
    } else loose.push(s);
  }
  const out = [];
  const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
  const toolEntry = (st, t, depth) => ({
    kind: 'tool', id: t.id, name: t.name, summary: t.summary, ts: iso(t.ts), depth,
    ms: t.end !== null && t.ts !== null ? Math.max(0, t.end - t.ts) : null,
    ok: t.end === null ? null : !t.error,
    ...(t.parent ? { parent: t.parent } : {}),
  });
  const emit = (st, depth, seen) => {
    for (const it of st.items) {
      const d = depth + (it.side && !st.isSub ? 1 : 0);
      if (it.k === 'prompt') {
        out.push({ kind: 'prompt', ts: iso(it.ts), text: it.text, turn: it.turn, depth: d, cost: turnUnknown.has(it.turn) && !turnCost.has(it.turn) ? null : Number((turnCost.get(it.turn) || 0).toFixed(6)), cost_complete: !turnUnknown.has(it.turn) });
      } else if (it.k === 'say') {
        out.push({ kind: 'say', ts: iso(it.ts), text: it.text, depth: d });
      } else if (it.k === 'tool') {
        const t = st.tools.get(it.id);
        if (!t) continue;
        out.push(toolEntry(st, t, d));
        for (const s of byParent.get(t.id) || []) {
          if (seen.has(s)) continue;
          seen.add(s);
          out.push({ kind: 'subagent', ts: iso(s.firstTs), description: s.meta?.description || t.summary || 'Subagent', agent_type: s.meta?.agentType || '', depth: d + 1, parent: t.id });
          emit(s, d + 1, seen);
        }
      }
    }
  };
  const seen = new Set();
  emit(main, 0, seen);
  // Workflow agents (no parent call on record): by when they started, each under its own header.
  if (loose.length) {
    for (const s of loose.sort((a, b) => (a.firstTs ?? 0) - (b.firstTs ?? 0))) {
      const block = [{ kind: 'subagent', ts: iso(s.firstTs), description: s.meta?.description || 'Background agent', agent_type: s.meta?.agentType || '', depth: 0, parent: null }];
      const before = out.length;
      emit(s, 1, seen);
      block.push(...out.splice(before));
      const at = s.firstTs ?? Infinity;
      let i = out.findIndex((e) => e.ts && Date.parse(e.ts) > at && e.depth === 0);
      if (i === -1) i = out.length;
      out.splice(i, 0, ...block);
    }
  }
  for (let i = 0; i < out.length; i++) out[i].n = i;
  return out;
}

// ------------------------------------------------------------------ receipts (.clawdling/ledger)

export const LEDGER_KEEP_DAYS = 180;
export const LEDGER_MAX_BYTES = 20 * 1024 * 1024;

/**
 * One small summary per session under .clawdling/ledger/<sid>.json, so the report card stays
 * truthful after Claude Code deletes old transcripts. No prompt or file text beyond the trimmed
 * last line; plain files, no database. 180 days, at most 20 MB (oldest first).
 */
export class LedgerStore {
  constructor(dir, { keepDays = LEDGER_KEEP_DAYS, maxBytes = LEDGER_MAX_BYTES } = {}) {
    this.dir = dir;
    this.keepDays = keepDays;
    this.maxBytes = maxBytes;
  }

  file(sid) {
    if (!isUuid(sid)) throw new Error('invalid session id');
    return path.join(this.dir, `${sid}.json`);
  }

  read(sid) {
    try {
      const o = JSON.parse(fs.readFileSync(this.file(sid), 'utf8'));
      return o && typeof o === 'object' && o.sid === sid ? o : null;
    } catch {
      return null;
    }
  }

  write(rec) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this.file(rec.sid);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  /** Every summary (optionally one agent's), newest first by end. */
  list({ agent } = {}) {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      const sid = n.endsWith('.json') ? n.slice(0, -5) : null;
      if (!sid || !isUuid(sid)) continue;
      const r = this.read(sid);
      if (r && (!agent || r.agent === agent)) out.push(r);
    }
    return out.sort((a, b) => String(b.ended_at || b.last_at || '').localeCompare(String(a.ended_at || a.last_at || '')));
  }

  /** Drop summaries older than the retention, then the oldest until the folder fits the cap. */
  prune(now = Date.now()) {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    const files = [];
    for (const n of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(n)) continue;
      const f = path.join(this.dir, n);
      try {
        const st = fs.statSync(f);
        files.push({ f, size: st.size, t: st.mtimeMs });
      } catch {
        // gone
      }
    }
    files.sort((a, b) => a.t - b.t);
    let total = files.reduce((s, x) => s + x.size, 0);
    let removed = 0;
    for (const x of files) {
      if (now - x.t <= this.keepDays * 86400000 && total <= this.maxBytes) break;
      try {
        fs.unlinkSync(x.f);
        total -= x.size;
        removed++;
      } catch {
        // already gone
      }
    }
    return removed;
  }
}
