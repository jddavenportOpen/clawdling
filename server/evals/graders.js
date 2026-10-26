// Graders for check-up runs (1.6), with `claude plugin eval`'s documented semantics:
//   regex        pattern over last_message | trace | files | {source: file, path}; match contains |
//                not_contains | count:N; flags are JS RegExp flags
//   tool_used    calls of `tool` (input_match: a regex over the call's input as JSON) within min..max
//                (min defaults to 1, max to unbounded)
//   tool_order   the first matching call of `before` comes before the first matching call of `after`
//   file_exists  a glob over the files the run created (paths only; files that existed before the
//                run do not count, even if changed)
//   llm          three judge votes, PASS when more than half pass
// A grader that cannot be evaluated fails with the reason, never passes by default.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const FOCUS_MAX = 100000;
const FILE_TEXT_MAX = 1024 * 1024;
const FOCUS_TAIL = 20000;
export const VOTES = 3;

/** plugin eval's glob: ** crosses folders, * stays within one, ? is one character. */
export function globRegex(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        if (glob.charAt(i + 2) === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i++;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '.';
    else if ('.+^${}()|[]\\'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`${out}$`);
}

/** The text a regex or llm grader reads, as plugin eval builds it. */
export function focusText(target, run) {
  if (target && typeof target === 'object' && target.source === 'file') {
    if (run.fileTexts && Object.hasOwn(run.fileTexts, target.path)) return run.fileTexts[target.path];
    if (!run.cwd) return { unavailable: `focus file ${target.path} does not exist` };
    const base = path.resolve(run.cwd);
    const file = path.resolve(base, target.path);
    if (!file.startsWith(base + path.sep)) return { unavailable: `focus file ${target.path} is outside the run folder` };
    try {
      const real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(base) + path.sep)) return { unavailable: `focus file ${target.path} leaves the run folder through a link` };
      if (fs.statSync(real).size > FILE_TEXT_MAX) return { unavailable: `focus file ${target.path} is over 1 MB` };
      const buf = fs.readFileSync(real);
      if (buf.includes(0)) return { unavailable: `focus file ${target.path} is not text` };
      return { text: buf.toString('utf8') };
    } catch {
      return { unavailable: `focus file ${target.path} does not exist` };
    }
  }
  if (target === 'last_message' || target === undefined) return { text: run.last_message || '' };
  if (target === 'files') return { text: (run.files || []).join('\n') };
  if (target === 'trace') return { text: (run.trace || []).map((e) => JSON.stringify(e)).join('\n') };
  return { unavailable: `unknown target ${JSON.stringify(target)}` };
}

/** The {source: file} texts a case's graders read, captured before the run folder is removed. */
export function fileTexts(graders, run) {
  const out = {};
  for (const g of graders || []) {
    const t = g.type === 'llm' ? g.focus : g.type === 'regex' ? g.target : null;
    if (t && typeof t === 'object' && t.source === 'file' && !Object.hasOwn(out, t.path)) out[t.path] = focusText(t, { ...run, fileTexts: null });
  }
  return out;
}

// Grader patterns are owner-approved but run over agent-written text: each runs in a vm context with a
// deadline, so a pattern that backtracks badly fails its grader instead of freezing the server.
const REGEX_MS = 1000;
const REGEX_INPUT_MAX = 4 * 1024 * 1024;
const REGEX_CODE = {
  test: 'new RegExp(p, f).test(t)',
  count: "(t.match(new RegExp(p, f.includes('g') ? f : f + 'g')) || []).length",
};
const regexBox = vm.createContext({});

/** Run a pattern over text in the sandbox: {value} or {error}. mode: test | count. */
export function runRegex(pattern, flags, text, mode = 'test', { timeoutMs = REGEX_MS } = {}) {
  regexBox.p = String(pattern);
  regexBox.f = String(flags || '');
  regexBox.t = String(text ?? '').slice(0, REGEX_INPUT_MAX);
  try {
    return { value: vm.runInContext(REGEX_CODE[mode], regexBox, { timeout: timeoutMs }) };
  } catch (err) {
    return { error: /timed out/i.test(String(err?.message)) ? `the pattern took more than ${timeoutMs / 1000} s (it backtracks badly on this text)` : `bad pattern: ${err?.message}` };
  } finally {
    regexBox.t = '';
  }
}

const fail = (g, why) => ({ name: g.name, type: g.type, passed: false, weight: g.weight, explanation: why });

export function gradeRegex(g, run) {
  const f = focusText(g.target, run);
  if (f.unavailable) return fail(g, f.unavailable);
  const label = typeof g.target === 'object' ? `file ${g.target.path}` : g.target || 'last_message';
  // Each mode compiles its own RegExp, so a `g` flag's lastIndex never carries between calls.
  if (g.match === 'contains' || !g.match) {
    const r = runRegex(g.pattern, g.flags, f.text);
    if (r.error) return fail(g, r.error);
    const ok = r.value === true;
    return { name: g.name, type: g.type, passed: ok, weight: g.weight, explanation: ok ? `matched ${g.pattern}` : `pattern not found in ${label}` };
  }
  if (g.match === 'not_contains') {
    const r = runRegex(g.pattern, g.flags, f.text);
    if (r.error) return fail(g, r.error);
    const ok = r.value !== true;
    return { name: g.name, type: g.type, passed: ok, weight: g.weight, explanation: ok ? 'pattern absent as expected' : 'pattern found (expected absent)' };
  }
  const m = /^count:(\d+)$/.exec(String(g.match));
  if (!m) return fail(g, `unknown match mode "${g.match}" (use contains | not_contains | count:N)`);
  const r = runRegex(g.pattern, g.flags, f.text, 'count');
  if (r.error) return fail(g, r.error);
  const n = r.value;
  return { name: g.name, type: g.type, passed: n === Number(m[1]), weight: g.weight, explanation: `found ${n} matches (expected ${m[1]})` };
}

/** The indexes of the calls matching {tool, input_match}, or {error} when the pattern failed (never "no match"). */
function matching(calls, spec) {
  const out = [];
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].name !== spec.tool) continue;
    if (spec.input_match) {
      const r = runRegex(spec.input_match, '', calls[i].inputText);
      if (r.error) return { error: `input_match: ${r.error}` };
      if (r.value !== true) continue;
    }
    out.push(i);
  }
  return { list: out };
}

export function gradeToolUsed(g, run) {
  const m = matching(run.tool_calls || [], g);
  if (m.error) return fail(g, m.error);
  const n = m.list.length;
  const min = g.min ?? 1;
  const max = g.max ?? Infinity;
  return { name: g.name, type: g.type, passed: n >= min && n <= max, weight: g.weight, explanation: `${g.tool} called ${n}x (expected ${min}..${max === Infinity ? '∞' : max})` };
}

export function gradeToolOrder(g, run) {
  const calls = run.tool_calls || [];
  const mb = matching(calls, g.before);
  const ma = matching(calls, g.after);
  if (mb.error || ma.error) return fail(g, mb.error || ma.error);
  const b = mb.list.length ? mb.list[0] : -1;
  const a = ma.list.length ? ma.list[0] : -1;
  if (b === -1) return fail(g, `"before" tool ${g.before.tool} never called`);
  if (a === -1) return fail(g, `"after" tool ${g.after.tool} never called`);
  const ok = b < a;
  return { name: g.name, type: g.type, passed: ok, weight: g.weight, explanation: ok ? `${g.before.tool}@${b} precedes ${g.after.tool}@${a}` : `${g.before.tool}@${b} does NOT precede ${g.after.tool}@${a}` };
}

export function gradeFileExists(g, run) {
  const re = globRegex(g.path);
  const found = (run.files || []).some((f) => re.test(f.trim()));
  const ok = found === g.exists;
  return { name: g.name, type: g.type, passed: ok, weight: g.weight, explanation: ok ? `${g.path} ${g.exists ? 'exists' : 'absent'} as expected` : `${g.path} ${found ? 'exists' : 'missing'} (expected ${g.exists ? 'present' : 'absent'})` };
}

/** The focus text for an llm judge, long text cut in the middle the way plugin eval does. */
export function judgeText(text) {
  const t = String(text ?? '');
  if (t.length <= FOCUS_MAX) return t;
  const head = FOCUS_MAX - FOCUS_TAIL;
  return `${t.slice(0, head)}\n[…${t.length - head - FOCUS_TAIL} chars elided…]\n${t.slice(-FOCUS_TAIL)}`;
}

/**
 * An llm grader: three votes from `judge({criteria, text, focus})` -> {pass, reason, cost_usd}.
 * PASS when more than half pass. A vote that errors counts as FAIL and says why.
 */
export async function gradeLlm(g, run, judge, { votes = VOTES } = {}) {
  const f = g.focus === 'trace' ? { text: (run.trace || []).map((e) => JSON.stringify(e)).join('\n') } : focusText(g.focus, run);
  if (f.unavailable) return fail(g, f.unavailable);
  const text = f.text === '' && g.focus === 'files' ? '(no file changes)' : f.text;
  const label = typeof g.focus === 'object' ? `file ${g.focus.path}` : g.focus || 'last_message';
  const results = [];
  for (let i = 0; i < votes; i++) {
    try {
      results.push(await judge({ criteria: g.criteria, text: judgeText(text), focus: label }));
    } catch (err) {
      if (err && err.cap) throw err; // the cost cap: skipped, never a FAIL vote
      results.push({ pass: false, reason: `judge call failed: ${err.message}`, cost_usd: 0, error: true });
    }
  }
  const passes = results.filter((r) => r.pass === true).length;
  const ok = passes > results.length / 2;
  return {
    name: g.name,
    type: g.type,
    passed: ok,
    weight: g.weight,
    explanation: `judge votes: ${results.map((r) => (r.pass ? 'PASS' : 'FAIL')).join(' ')}`,
    judge_votes: results.map((r) => r.pass === true),
    reasons: results.map((r) => String(r.reason || '').slice(0, 600)),
    cost_usd: results.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0),
    judge_errors: results.filter((r) => r.error).length,
  };
}

/** Run one grader. */
export async function grade(g, run, judge) {
  try {
    switch (g.type) {
      case 'regex':
        return gradeRegex(g, run);
      case 'tool_used':
        return gradeToolUsed(g, run);
      case 'tool_order':
        return gradeToolOrder(g, run);
      case 'file_exists':
        return gradeFileExists(g, run);
      case 'llm':
        if (run.skipPaid) return fail(g, 'skipped: cost cap reached');
        if (run.skipJudge) return fail(g, 'skipped: the run failed, so it scores 0');
        return await gradeLlm(g, run, judge);
      default:
        return fail(g, `unsupported grader type ${g.type}`);
    }
  } catch (err) {
    if (err && err.cap) throw err;
    return fail(g, `grader threw: ${err.message}`);
  }
}

/** A case's score for one run: the weighted share of graders passed (0 for a run that errored). */
export function caseScore(results, { error = null } = {}) {
  if (error) return 0;
  const total = results.reduce((s, r) => s + (r.weight || 1), 0);
  if (!total) return 0;
  return results.reduce((s, r) => s + (r.passed ? r.weight || 1 : 0), 0) / total;
}
