// Receipt ids (1.7): every item in the schema 2 report has a stable id, `R-<kind>-<8 hex>`, that the
// CTO cites in brackets and the review page turns into a link.
//
// An id is a hash of what the item IS (a session's id; a claim's session and time; a ship check's
// start time), never of what it says, so the same receipt keeps its id across reports. Each report
// for the whole org is also kept as an index for its ISO week (.clawdling/cto/receipts/<week>.json):
// an id the CTO cited on Monday still resolves on Thursday, when the 7-day window has moved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson } from './util.js';

export const KINDS = ['session', 'claim', 'check', 'checkup', 'cost', 'needs', 'next', 'model', 'safety'];
export const RECEIPT_RE = /\bR-(session|claim|check|checkup|cost|needs|next|model|safety)-[0-9a-f]{8}\b/g;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const INDEX_MAX = 5000; // receipts kept per week (a big org's week is a few hundred)
const WEEKS_KEEP = 26;

/** The id for one receipt: a hash of its kind and the parts that name it. */
export function receiptId(kind, ...parts) {
  if (!KINDS.includes(kind)) throw new Error(`unknown receipt kind ${kind}`);
  const h = crypto.createHash('sha256').update([kind, ...parts.map((p) => String(p ?? ''))].join('\u0000')).digest('hex');
  return `R-${kind}-${h.slice(0, 8)}`;
}

/** The ids cited in a piece of text, in order, each once. */
export function citedIds(text) {
  return [...new Set(String(text || '').match(RECEIPT_RE) || [])];
}

// Characters a person cannot see but a model reads: format characters (bidi, zero-width, BOM...),
// Unicode tags, variation selectors, private-use and unassigned code points, line separators.
export const INVISIBLE_RE = /[\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u2028\u2029]/gu;

// What can hide or reorder words, for text typed into any session (cleanInput) and for what the CTO
// seat may run or write (hiddenAt): control characters (but tab and line breaks), Unicode tags,
// bidi controls, private-use characters, the variation selectors no emoji uses, and every other
// format or default-ignorable character except the four real text needs one of at a time: the
// joiners (ZWJ, ZWNJ: emoji sequences, Persian, Indic scripts) and the emoji selectors (U+FE0E/F).
const KEEP = new Set(['‌', '‍', '︎', '️']);
const HIDE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}︀-︍\p{Co}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const HIDE_RE_G = new RegExp(HIDE_RE.source, 'gu');
// More than two joiners or selectors in a row carry bits, not text.
const RUN_RE = /[‌‍︎️]{3,}/u;

export function cleanInput(text) {
  return String(text ?? '')
    .replace(HIDE_RE_G, (c) => (KEEP.has(c) ? c : ''))
    .replace(new RegExp(RUN_RE.source, 'gu'), (m) => m.slice(0, 2));
}

/** The first character a person cannot see (or a hiding run), {index, code} or null. Tab and line breaks are fine. */
export function hiddenAt(text) {
  const s = String(text ?? '');
  for (const m of s.matchAll(HIDE_RE_G)) {
    if (KEEP.has(m[0])) continue;
    return { index: m.index, code: `U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` };
  }
  const run = RUN_RE.exec(s);
  return run ? { index: run.index, code: 'a run of joiners or selectors' } : null;
}

export function hasHidden(text) {
  return hiddenAt(text) !== null;
}

/**
 * Text written by an agent (a session title, its last line, NOW.md), made safe to hand the CTO: one
 * line, no control characters, capped, and no receipt-shaped "[R-" (a title cannot plant a citation).
 */
export function agentText(s, max) {
  if (typeof s !== 'string') return null;
  // Control, line-separator, bidi and zero-width characters: they can reorder or hide what is shown.
  let out = s.replace(INVISIBLE_RE, '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  out = out.replace(/\[(\s*)R-/gi, '($1R-').replace(/\bR-(session|claim|check|checkup|cost|needs|next|model|safety)-([0-9a-f]{8})\b/gi, 'R $1 $2');
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out || null;
}

/** Multi-line agent text (NOW.md "Next"): same rules, line breaks kept, capped. */
export function agentBlock(s, max) {
  if (typeof s !== 'string') return null;
  const lines = s.replace(/\r\n?/g, '\n').split('\n').map((l) => agentText(l, 300) || '').filter((l, i, a) => l || (i > 0 && a[i - 1]));
  let out = lines.join('\n').trim();
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out || null;
}

/** The receipt index of one ISO week: {id: {kind, agent, link, label}}. */
export class ReceiptIndex {
  constructor(dir) {
    this.dir = dir;
  }

  file(week) {
    if (!WEEK_RE.test(String(week))) throw new Error('bad week');
    return path.join(this.dir, `${week}.json`);
  }

  /** {receipts: {id: {...}}, labels: {agentId: [{at, label, name}]}} for one week ({} parts when none). */
  load(week) {
    try {
      const v = readJson(this.file(week), null);
      const ok = (x) => x && typeof x === 'object' && !Array.isArray(x);
      return { receipts: ok(v?.receipts) ? v.receipts : {}, labels: ok(v?.labels) ? v.labels : {} };
    } catch {
      return { receipts: {}, labels: {} };
    }
  }

  read(week) {
    return this.load(week).receipts;
  }

  /**
   * The computed label of each agent as it was at `atMs` (the newest record at or before it; else
   * the oldest one after it): {agentId: {label, name}}.
   */
  labelsAt(week, atMs = Infinity) {
    const out = {};
    for (const [id, list] of Object.entries(this.load(week).labels)) {
      if (!Array.isArray(list) || !list.length) continue;
      const sorted = list.filter((x) => x && typeof x.at === 'string').sort((a, b) => a.at.localeCompare(b.at));
      let pick = null;
      for (const x of sorted) if (Date.parse(x.at) <= atMs) pick = x;
      pick = pick || sorted[0];
      if (pick) out[id] = { label: pick.label, name: pick.name || id };
    }
    return out;
  }

  /** Add a report's receipts (and, with `labels`, each agent's computed label at `at`) to its week. */
  add(week, receipts, { labels = null, at = null } = {}) {
    const cur = this.load(week);
    for (const [id, r] of Object.entries(receipts)) cur.receipts[id] = r;
    const ids = Object.keys(cur.receipts);
    if (ids.length > INDEX_MAX) for (const id of ids.slice(0, ids.length - INDEX_MAX)) delete cur.receipts[id];
    if (labels && at) {
      for (const [id, l] of Object.entries(labels)) {
        const list = Array.isArray(cur.labels[id]) ? cur.labels[id] : [];
        const prev = list[list.length - 1];
        if (!prev || prev.label !== l.label || prev.name !== l.name) list.push({ at, label: l.label, name: l.name });
        cur.labels[id] = list.slice(-50);
      }
    }
    ensureDir(this.dir, 0o700);
    writeJson(this.file(week), { week, receipts: cur.receipts, labels: cur.labels }, 0o600);
    this.prune();
    return cur;
  }

  weeks() {
    try {
      return fs.readdirSync(this.dir).filter((f) => /^\d{4}-W\d{2}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
    } catch {
      return [];
    }
  }

  prune() {
    const w = this.weeks();
    for (const old of w.slice(0, Math.max(0, w.length - WEEKS_KEEP))) {
      try {
        fs.unlinkSync(this.file(old));
      } catch {
        // gone
      }
    }
  }
}

/** Every receipt in a schema 2 report, flattened: {id: {kind, agent, link, label}}. */
export function collectReceipts(report) {
  const out = {};
  const put = (r, kind, agent, label) => {
    if (r && typeof r.receipt === 'string') out[r.receipt] = { kind, agent, link: r.link || null, label: label || null };
  };
  for (const a of report.agents || []) {
    for (const d of a.done || []) put(d, 'session', a.id, d.title || 'a session');
    for (const n of a.needs || []) put(n, 'needs', a.id, n.title || 'waiting on you');
    for (const c of a.claims || []) put(c, 'claim', a.id, c.badge || c.label);
    put(a.cost, 'cost', a.id, `usage, ${report.window?.key || '7d'}`);
    put(a.next, 'next', a.id, 'NOW.md, Next');
    if (a.checks?.last) put(a.checks.last, 'check', a.id, `ship check ${a.checks.last.ok ? 'passed' : 'failed'}`);
    if (a.checkup?.last) put(a.checkup.last, 'checkup', a.id, 'check-up');
    if (a.checkup?.previous) put(a.checkup.previous, 'checkup', a.id, 'earlier check-up');
    if (a.cheaperModel?.last) put(a.cheaperModel.last, 'model', a.id, 'try a cheaper model');
    if (a.safety) put(a.safety, 'safety', a.id, `setup safety: ${a.safety.verdict}`);
  }
  return out;
}
