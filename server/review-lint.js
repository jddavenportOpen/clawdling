// The review lint (1.7): "receipts or it didn't happen", checked by Clawdling, not by the model.
//
// A CTO review (cto/reviews/<ISO-week>.md) has a fixed shape:
//   # CTO review, <week>
//   Headline: <one line>
//   ## <agent name>: <label>
//   - <finding> [R-…]
//   - Override: <why the CTO disagrees with Clawdling's label> [R-…]
//   ## Decisions
//   1. <question>
// Every bullet must cite a receipt id that exists in that week's receipt index; every section's
// label must equal the one Clawdling computed, or carry an "Override:" bullet saying why.
import { LABEL_TEXT } from './status-rules.js';
import { citedIds } from './receipts.js';

const LABEL_BY_TEXT = Object.fromEntries(Object.entries(LABEL_TEXT).map(([k, v]) => [v.toLowerCase(), k]));
const HEADING_RE = /^##\s+(.+?)\s*:\s*(on track|at risk|stalled|quiet)\s*$/i;
const OVERRIDE_RE = /^\s*(override|overridden|i disagree)\b\s*[:,-]?\s*/i;
// "No receipts for that": the CTO saying it has nothing to cite, as its rules tell it to.
const NO_RECEIPTS_RE = /\bno receipts?\b/i;
export const REVIEW_MAX_BYTES = 256 * 1024;

/** The review's parts: {title, headline, sections: [{name, label, line, bullets}], decisions, other}. */
export function parseReview(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = { title: null, headline: null, sections: [], decisions: [], other: [] };
  let cur = null; // the section bullets go to
  let inDecisions = false;
  let fence = false;
  let last = null; // the bullet a continuation line belongs to
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const n = i + 1;
    if (!out.title && /^#\s+/.test(line)) {
      out.title = line.replace(/^#\s+/, '').trim();
      return;
    }
    const hl = /^\s*headline\s*:\s*(.*)$/i.exec(line);
    if (hl && !out.headline && !cur && !inDecisions) {
      out.headline = hl[1].trim();
      return;
    }
    if (/^##\s+/.test(line)) {
      last = null;
      const name = line.replace(/^##\s+/, '').trim();
      if (/^decisions\b/i.test(name)) {
        inDecisions = true;
        cur = null;
        return;
      }
      inDecisions = false;
      const m = HEADING_RE.exec(line);
      cur = m ? { name: m[1].trim(), label: LABEL_BY_TEXT[m[2].toLowerCase()], line: n, bullets: [] } : { name, label: null, line: n, bullets: [] };
      out.sections.push(cur);
      return;
    }
    if (inDecisions) {
      const d = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (d) out.decisions.push({ n: Number(d[1]), text: d[2].trim(), line: n, options: [] });
      else if (/^\s*[-*]\s+/.test(line) && out.decisions.length) out.decisions[out.decisions.length - 1].options.push(line.replace(/^\s*[-*]\s+/, '').trim());
      return;
    }
    const b = /^\s{0,3}[-*]\s+(.*)$/.exec(line);
    if (b) {
      last = { text: b[1].trim(), line: n };
      if (cur) cur.bullets.push(last);
      else out.other.push(last);
      return;
    }
    // An indented line right under a bullet continues it (a long finding wrapped by the model).
    if (last && /^\s{2,}\S/.test(line)) last.text = `${last.text} ${line.trim()}`;
    else if (line.trim()) last = null;
  });
  return out;
}

/**
 * Lint a review against its week's receipts and computed labels.
 *   receipts: {id: {...}} (the week's index); labels: {agentId: {label, name}} (computed, at the
 *   time the review was written); names map section headings to agents by name or id.
 * Returns {findings, cited, uncited[], unknown[], sections[], missing[], summary, clean}.
 */
export function lintReview(text, { receipts = {}, labels = {} } = {}) {
  const r = parseReview(text);
  const byName = new Map();
  for (const [id, l] of Object.entries(labels)) {
    byName.set(id.toLowerCase(), id);
    if (l && l.name) byName.set(String(l.name).toLowerCase(), id);
  }
  const uncited = [];
  const unknown = [];
  let findings = 0;
  let cited = 0;
  let none = 0;
  const check = (b, where) => {
    findings++;
    const ids = citedIds(b.text);
    if (!ids.length) {
      if (NO_RECEIPTS_RE.test(b.text)) {
        none++;
        return { ...b, ids, state: 'no_receipts' };
      }
      uncited.push({ line: b.line, text: b.text.slice(0, 300), where });
      return { ...b, ids, state: 'uncited' };
    }
    const bad = ids.filter((id) => !Object.hasOwn(receipts, id));
    if (bad.length) {
      for (const id of bad) unknown.push({ line: b.line, id, where });
      return { ...b, ids, state: 'unknown', bad };
    }
    cited++;
    return { ...b, ids, state: 'cited' };
  };
  const seen = new Set();
  const sections = r.sections.map((s) => {
    const agent = byName.get(s.name.toLowerCase()) || null;
    if (agent) seen.add(agent);
    const bullets = s.bullets.map((b) => check(b, s.name));
    const override = bullets.find((b) => OVERRIDE_RE.test(b.text));
    const computed = agent ? labels[agent].label : null;
    let state;
    if (!agent) state = 'unknown_agent';
    else if (!s.label) state = 'no_label';
    else if (s.label === computed) state = 'match';
    else state = override ? 'overridden' : 'mismatch';
    return {
      name: s.name,
      agent,
      line: s.line,
      label: s.label,
      computed,
      state,
      why: state === 'overridden' ? override.text.replace(OVERRIDE_RE, '').trim().slice(0, 400) : null,
      bullets,
    };
  });
  const other = r.other.map((b) => check(b, null));
  const missing = Object.entries(labels).filter(([id]) => !seen.has(id)).map(([id, l]) => ({ agent: id, name: l.name || id, label: l.label }));
  const mismatched = sections.filter((s) => s.state === 'mismatch' || s.state === 'no_label' || s.state === 'unknown_agent');
  const parts = [];
  if (!findings) parts.push('No findings yet');
  else if (!uncited.length && !unknown.length) parts.push(`${findings} finding${findings === 1 ? '' : 's'}, all cited${none ? ` (${none} say${none === 1 ? 's' : ''} "no receipts")` : ''}`);
  else {
    if (uncited.length) parts.push(`${uncited.length} uncited`);
    if (unknown.length) parts.push(`${unknown.length} citation${unknown.length === 1 ? '' : 's'} to a receipt that does not exist`);
  }
  const overridden = sections.filter((s) => s.state === 'overridden').length;
  if (overridden) parts.push(`${overridden} label${overridden === 1 ? '' : 's'} overridden by the CTO`);
  if (mismatched.length) parts.push(`${mismatched.length} section${mismatched.length === 1 ? '' : 's'} with a label Clawdling did not compute`);
  return {
    title: r.title,
    headline: r.headline,
    findings,
    cited,
    no_receipts: none,
    uncited,
    unknown,
    sections,
    other,
    decisions: r.decisions,
    missing,
    summary: parts.join(' · '),
    clean: findings > 0 && !uncited.length && !unknown.length && !mismatched.length,
  };
}
