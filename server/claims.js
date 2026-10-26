// Claim receipts (1.6): when an agent's final message says the work is done ("fixed", "tests pass",
// "builds"), Clawdling checks the session's own record and labels the claim:
//   verified      a check ran after the agent's last file change and passed
//   contradicted  a check ran after the last change and failed (the first error line is quoted)
//   not_verified  no check ran after the last change: the default, never an accusation
//   no_changes    a completion claim in a session that changed no file (not a claim about code)
// Deterministic and local: regular expressions over the transcript, no model call. A model judging
// "is this really done" would be one more claim; the receipt is a fact from the record.
import fs from 'node:fs';
import { oneLine, stripAnsi } from './util.js';

const RAW = JSON.parse(fs.readFileSync(new URL('./claims-patterns.json', import.meta.url), 'utf8'));
const re = (s) => new RegExp(s, 'u');
export const PATTERNS = {
  version: RAW.version,
  idioms: RAW.idioms.map((x) => ({ re: new RegExp(x.re, 'gu'), with: x.with })),
  fixVerbs: new RegExp(RAW.fix_scope.verbs, 'gu'),
  fixWords: new RegExp(RAW.fix_scope.words, 'gu'),
  clauseEnd: re(RAW.fix_scope.clause_end),
  cancel: re(RAW.message_cancel.re),
  tests: RAW.tests.map((x) => ({ need: x.need, re: re(x.re) })),
  completion: RAW.completion.map((x) => ({ re: re(x.re) })),
  excludeAny: RAW.exclude_any.map(re),
  excludeBefore: RAW.exclude_before.map(re),
};

export const LABELS = ['verified', 'not_verified', 'contradicted', 'no_changes'];
export const CLAIM_WINDOW = 600;
// Tools that change files, for "the agent's last file change" (apply_patch: other agent CLIs'
// transcripts sometimes use it; Claude Code's own are the first four).
export const CLAIM_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * The sentences of a final message worth reading: fenced code removed (pasted output is not a
 * claim), the last 600 characters, Markdown marks and emoji gone, lower-cased, each with whether
 * it was a question.
 */
export function sentences(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  t = t.replace(/```[\s\S]*?(```|$)/g, '\n').replace(/~~~[\s\S]*?(~~~|$)/g, '\n');
  if (t.length > CLAIM_WINDOW) t = t.slice(-CLAIM_WINDOW);
  t = t
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/[*_#>|]+/g, ' ')
    .replace(/[✅✔✓☑\u{1F389}\u{1F680}\u{1F44D}\u{1F7E2}✨]/gu, ' ')
    .replace(/’/g, "'");
  const out = [];
  for (const line of t.split('\n')) {
    // A sentence ends at . ! ? or ; followed by a space (not inside "e.g." or "1.5").
    const parts = line.split(/(?<=[!?;])\s+|(?<=[a-z0-9)"'\]][.])\s+(?=\S)/iu);
    for (let p of parts) {
      p = p.replace(/^\s*(?:[-+]|\d+[.)])\s+/, '').trim();
      if (!p) continue;
      const question = /\?\s*$/.test(p);
      out.push({ text: p.toLowerCase().replace(/[.!;:,\s]+$/, ''), question });
    }
  }
  return out;
}

/** Neutralize what a fix verb fixed: failure words after it, up to the end of its clause. */
function fixScope(s) {
  let out = '';
  let i = 0;
  for (const m of s.matchAll(PATTERNS.fixVerbs)) {
    if (m.index < i) continue;
    const from = m.index + m[0].length;
    const rest = s.slice(from);
    const end = PATTERNS.clauseEnd.exec(rest);
    const stop = end ? from + end.index : s.length;
    out += s.slice(i, from) + s.slice(from, stop).replace(PATTERNS.fixWords, 'item');
    i = stop;
  }
  return out + s.slice(i);
}

function rewrite(s) {
  let t = fixScope(s);
  for (const { re: r, with: w } of PATTERNS.idioms) t = t.replace(r, w);
  return t.replace(/\s+/g, ' ').trim();
}

function excluded(s, at) {
  if (PATTERNS.excludeAny.some((r) => r.test(s))) return true;
  const before = s.slice(0, at);
  return PATTERNS.excludeBefore.some((r) => r.test(before));
}

/**
 * The claim a final message makes, or null: {kind: 'tests'|'completion', needs: ['test'|'build'|
 * 'lint'], phrase}. `tests` claims name what must have passed; a completion claim accepts any check.
 */
export function detectClaim(text) {
  const needs = new Set();
  let phrase = null;
  let testPhrase = null;
  let completion = false;
  const list = sentences(text).map((s) => ({ ...s, t: rewrite(s.text) }));
  // A message that admits a current failure anywhere makes no claim, whatever else it says.
  if (list.some((s) => !s.question && PATTERNS.cancel.test(s.t))) return null;
  for (const s of list) {
    if (s.question) continue;
    const t = s.t;
    if (!t) continue;
    let hit = false;
    for (const p of PATTERNS.tests) {
      const m = p.re.exec(t);
      if (m && !excluded(t, m.index)) {
        needs.add(p.need);
        testPhrase = testPhrase || m[0].trim();
        hit = true;
      }
    }
    if (hit) continue;
    for (const p of PATTERNS.completion) {
      const m = p.re.exec(t);
      if (m && !excluded(t, m.index)) {
        completion = true;
        phrase = phrase || m[0].trim();
        break;
      }
    }
  }
  if (needs.size) return { kind: 'tests', needs: ['test', 'build', 'lint'].filter((n) => needs.has(n)), phrase: oneLine(testPhrase, 80) };
  if (completion) return { kind: 'completion', needs: [], phrase: oneLine(phrase, 80) };
  return null;
}

// ------------------------------------------------------------------------------- shell commands

/** Split a shell command line into simple commands, with the operator that follows each one. */
export function segments(cmd) {
  const s = String(cmd || '');
  const out = [];
  let cur = '';
  let q = null;
  const push = (op) => {
    if (cur.trim()) out.push({ raw: cur.trim(), op });
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (q === '"' && c === '\\') cur += s[++i] ?? '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      i++;
      cur += ' ';
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push(two);
      i++;
    } else if (c === '|' && s[i + 1] !== '|') {
      push('|');
      if (s[i + 1] === '&') i++;
    } else if (c === ';' || c === '\n') push(';');
    else if (c === '&' && s[i + 1] !== '>' && s[i - 1] !== '>' && s[i - 1] !== '<') push('&');
    else cur += c;
  }
  push(null);
  return out;
}

/** The words of one simple command (quotes removed), without leading NAME=value assignments. */
export function words(raw) {
  const out = [];
  let cur = '';
  let had = false;
  let q = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === '\\') cur += raw[++i] ?? '';
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      had = true;
    } else if (/\s/.test(c)) {
      if (cur || had) out.push(cur);
      cur = '';
      had = false;
    } else cur += c;
  }
  if (cur || had) out.push(cur);
  // Redirections are not words of the command.
  const clean = [];
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    if (/^\d?[<>]{1,2}&?\d?$/.test(w)) {
      i++;
      continue;
    }
    if (/^\d?[<>]{1,2}/.test(w)) continue;
    clean.push(w);
  }
  while (clean.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(clean[0])) clean.shift();
  return clean;
}

const KIND_BY_SCRIPT = [
  [/^(test|tests|t|spec|specs|e2e|vitest|jest|mocha|ava|unit|integration)([:_.-].*)?$|^(test|e2e)\b/, 'test'],
  [/^(build|compile|bundle|dist|package)([:_.-].*)?$/, 'build'],
  [/^(lint|eslint|stylelint|format[:_-]check|fmt[:_-]check|prettier[:_-]check|typecheck|type-check|types|check-types|tsc|check:types|lint[:_-].*)$/, 'lint'],
  [/^(check|verify|ci|validate|precommit|pre-commit)([:_.-].*)?$/, 'check'],
];
const MAKE_KIND = { test: 'test', tests: 'test', check: 'test', unittest: 'test', spec: 'test', e2e: 'test', build: 'build', all: 'build', compile: 'build', lint: 'lint', vet: 'lint', typecheck: 'lint', fmt: 'lint', 'fmt-check': 'lint', format: 'lint', ci: 'check', verify: 'check' };

function scriptKind(name) {
  for (const [r, k] of KIND_BY_SCRIPT) if (r.test(String(name || '').toLowerCase())) return k;
  return null;
}

/** The kind of check one command's words run (test, build, lint or check), or null. */
export function wordsKind(w) {
  if (!w.length) return null;
  // The program's own name: ./node_modules/.bin/vitest is vitest, ./gradlew is gradlew.
  let a = [w[0].replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|bat|ps1)$/i, ''), ...w.slice(1)];
  // Wrappers that run what follows: time, npx/pnpm dlx/bunx, python -m, uv run, poetry run, env.
  for (let n = 0; n < 4; n++) {
    const h = a[0];
    if (h === 'time' || h === 'command' || h === 'exec' || h === 'nice' || h === 'nohup') a = a.slice(1);
    else if (h === 'env') a = a.slice(1).filter((x, i, arr) => !(arr.slice(0, i + 1).every((y) => /=/.test(y))));
    else if (h === 'npx' || h === 'bunx' || (h === 'pnpm' && (a[1] === 'exec' || a[1] === 'dlx')) || (h === 'yarn' && (a[1] === 'dlx' || a[1] === 'exec'))) a = a.slice(h === 'npx' || h === 'bunx' ? 1 : 2).filter((x, i) => !(i === 0 && /^-/.test(x)));
    else if ((h === 'uv' || h === 'poetry' || h === 'pipenv' || h === 'hatch' || h === 'pdm' || h === 'rye') && a[1] === 'run') a = a.slice(2);
    else if ((h === 'bundle') && a[1] === 'exec') a = a.slice(2);
    else if (/^python[\d.]*$|^py$/.test(h) && a[1] === '-m') a = a.slice(2);
    else break;
    if (!a.length) return null;
  }
  const [h, b, c] = a;
  const lc = (x) => String(x || '').toLowerCase();
  if (h === 'npm' || h === 'pnpm' || h === 'yarn' || h === 'bun') {
    if (b === 'test' || b === 't' || b === 'tst') return 'test';
    if (b === 'run' || b === 'run-script' || b === 'rum' || b === 'urn') return scriptKind(c);
    if (h === 'bun' && b === 'test') return 'test';
    if ((h === 'pnpm' || h === 'yarn') && b && !b.startsWith('-')) return scriptKind(b);
    if (h === 'npm' && (b === 'ci' || b === 'install')) return null;
    return null;
  }
  if (h === 'node' && (b === '--test' || a.includes('--test'))) return 'test';
  if (h === 'deno' && b === 'test') return 'test';
  if (h === 'deno' && (b === 'lint' || b === 'check')) return 'lint';
  if (h === 'deno' && b === 'task') return scriptKind(c);
  if (['vitest', 'jest', 'mocha', 'ava', 'tap', 'uvu', 'karma', 'jasmine', 'pytest', 'py.test', 'nosetests', 'tox', 'nox', 'rspec', 'phpunit', 'ctest', 'unittest', 'behave', 'cucumber-js'].includes(lc(h))) return 'test';
  if (h === 'playwright' && b === 'test') return 'test';
  if (h === 'cypress' && b === 'run') return 'test';
  if (h === 'tsc') return a.includes('--noEmit') || a.includes('--noemit') ? 'lint' : 'build';
  if (h === 'vue-tsc' || h === 'svelte-check') return 'lint';
  if (['eslint', 'ruff', 'flake8', 'pylint', 'mypy', 'pyright', 'golangci-lint', 'rubocop', 'shellcheck', 'stylelint', 'standard', 'xo', 'oxlint', 'hadolint', 'markdownlint', 'swiftlint', 'ktlint', 'black', 'isort'].includes(lc(h))) {
    if ((h === 'black' || h === 'isort') && !a.includes('--check')) return null;
    if (h === 'ruff' && b === 'format' && !a.includes('--check')) return null;
    return 'lint';
  }
  if (h === 'biome' && (b === 'lint' || b === 'check' || b === 'ci')) return 'lint';
  if (h === 'prettier' && (a.includes('--check') || a.includes('-c'))) return 'lint';
  if (h === 'manage.py' || (h === 'django-admin')) return b === 'test' ? 'test' : null;
  if (/^python[\d.]*$/.test(h) && /manage\.py$/.test(b || '') && c === 'test') return 'test';
  if (h === 'go') return b === 'test' ? 'test' : b === 'build' ? 'build' : b === 'vet' ? 'lint' : null;
  if (h === 'cargo') return b === 'test' || b === 'nextest' ? 'test' : b === 'build' || b === 'check' ? 'build' : b === 'clippy' ? 'lint' : null;
  if (h === 'make' || h === 'gmake' || h === 'just' || h === 'task' || h === 'mage') {
    const t = a.slice(1).find((x) => !x.startsWith('-') && !x.includes('='));
    return t ? MAKE_KIND[lc(t)] || scriptKind(t) : h === 'make' ? 'build' : null;
  }
  if (h === 'mvn' || h === 'mvnw' || h === 'gradle' || h === 'gradlew') {
    const t = a.slice(1).find((x) => !x.startsWith('-'));
    return t === 'test' || t === 'verify' || t === 'check' ? 'test' : t === 'build' || t === 'package' || t === 'compile' || t === 'assemble' ? 'build' : null;
  }
  if (['dotnet', 'swift', 'mix', 'flutter', 'dart', 'bazel', 'buck2', 'zig'].includes(h)) return b === 'test' ? 'test' : b === 'build' ? 'build' : b === 'analyze' || b === 'format' ? 'lint' : null;
  if (h === 'rake' && (b === 'test' || b === 'spec')) return 'test';
  if (h === 'composer' && b === 'test') return 'test';
  return null;
}

const firstTwo = (cmd) => words(String(cmd || '').trim()).slice(0, 2).join(' ');
const NAME_KIND = { tests: 'test', test: 'test', unit: 'test', e2e: 'test', build: 'build', compile: 'build', lint: 'lint', typecheck: 'lint', types: 'lint', format: 'lint' };

/**
 * Is this shell command a check, and of what kind? `approved`: the project's approved checks.yaml
 * commands [{name, run}] (exact, or the same first two words); `detected`: the stack's commands
 * [{kind, cmd}]; then the generic list. Returns {kind, masked} or null. `masked`: its exit code does
 * not reach the tool result (piped into another command, or followed by `|| ...` or `; ...`), so
 * pass or fail must come from its output.
 */
export function checkOf(cmd, { approved = [], detected = [] } = {}) {
  const segs = segments(cmd);
  let pipefail = false;
  let errexit = false;
  let found = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const w = words(s.raw);
    if (w[0] === 'set') {
      if (w.some((x) => /^-[a-z]*o?$/.test(x) && x.includes('e')) || w.includes('errexit')) errexit = true;
      if (w.includes('pipefail')) pipefail = true;
      continue;
    }
    if (w[0] === 'cd' || w[0] === 'pushd' || w[0] === 'popd' || w[0] === 'export' || w[0] === 'source' || w[0] === '.' || w[0] === 'echo') continue;
    let kind = null;
    const trimmed = s.raw.trim();
    for (const ap of approved) {
      if (!ap || typeof ap.run !== 'string') continue;
      if (trimmed === ap.run.trim() || (firstTwo(trimmed) && firstTwo(trimmed) === firstTwo(ap.run) && words(trimmed).length >= 2)) {
        kind = NAME_KIND[String(ap.name || '').toLowerCase()] || wordsKind(words(ap.run)) || 'check';
        break;
      }
    }
    if (!kind) {
      for (const d of detected) {
        if (d && typeof d.cmd === 'string' && (trimmed === d.cmd || trimmed.startsWith(`${d.cmd} `))) {
          kind = d.kind === 'test' ? 'test' : d.kind === 'build' ? 'build' : d.kind === 'lint' || d.kind === 'typecheck' || d.kind === 'format' ? 'lint' : d.kind === 'check' ? 'check' : null;
          if (kind) break;
        }
      }
    }
    if (!kind) kind = wordsKind(w);
    if (!kind) continue;
    // The exit code that reaches the tool result: the last command's, unless a failure stops the chain.
    const rest = segs.slice(i);
    const op = s.op;
    const masked = (op === '|' && !pipefail) || op === '||' || op === '&' || (op === ';' && !errexit && rest.length > 1);
    found = { kind, masked, cmd: trimmed };
    if (!masked) break; // an unmasked check decides
  }
  return found;
}

// ---------------------------------------------------------------------------------- tool results

const DENIED = /doesn't want to proceed|does not want to proceed|tool use was rejected|user rejected|was denied|permission (to use .* )?(has been |was )?denied|requested permissions|interrupted by user|\[Request interrupted/i;
const BLOCKED = /^\s*<tool_use_error>|^\s*Error: Blocked|hook (error|blocked)|blocked by (a )?hook/i;
const ERROR_LINE = /(\berror\b|\berr!|\bfail(ed|ure|ing|s)?\b|✗|✕|×|\bassert(ion)?\b|\bexception\b|\bpanic(ked)?\b|\bnot ok\b|\btraceback\b|\bcannot\b|\bundefined\b|\bexpected\b)/i;
// Failure marks: the capitals test runners print (FAIL, ERROR:), and counts above zero.
const FAIL_UPPER = /(^|\s)(FAIL|FAILED|FAILURES?)\b|npm ERR!|^not ok \d|\btest result: FAILED|\bERROR:|\bBUILD FAILED\b/m;
const FAIL_COUNT = /\b([1-9]\d*) (tests? )?(failed|failing|failures?|errors?)\b|\bTests?:\s+[1-9]\d* failed|^# fail [1-9]|\bexit (code|status) [1-9]/im;
const failMark = (t) => FAIL_UPPER.test(t) || FAIL_COUNT.test(t);
const PASS_MARK = /\b([1-9]\d* )?(tests? )?(passed|passing)\b|\bTests?:\s+\d+ passed\b|^ok\s+\S+|^# pass [1-9]|\bPASS\b|\u2713|\u2714|\btest result: ok\b|\bBUILD SUCCESS(FUL)?\b|\bCompiled successfully\b|\bbuilt in \d|\bAll checks passed\b|\bFound 0 errors\b|\b0 problems\b/im;

/** The text of a tool_result block's content (a string, or text blocks). */
export function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

/** The first line of output that reads as an error, trimmed and safe to show (no ANSI, one line). */
export function firstErrorLine(text) {
  const lines = stripAnsi(String(text || '')).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/^Exit code \d+$/.test(l));
  const hit = lines.find((l) => ERROR_LINE.test(l) && !/^(at |\s*\d+ \|)/.test(l)) || lines[0] || '';
  return oneLine(hit.replace(/[\u0000-\u001f\u007f]/g, ' '), 200);
}

/**
 * What a shell tool call's result says: {denied, blocked, exit, err1, fail, pass}. Read once, when
 * the result arrives; the output itself is not kept (only the first error line).
 */
export function resultInfo(content, isError) {
  const text = resultText(content).slice(0, 256 * 1024);
  const denied = isError === true && DENIED.test(text.slice(0, 2000));
  const blocked = !denied && BLOCKED.test(text.slice(0, 2000));
  const m = /^Exit code (\d+)/.exec(text.trimStart());
  const exit = m ? Number(m[1]) : isError === true ? null : 0;
  // Pass and fail marks are read from the end of the output, where test runners print their totals.
  const tail = text.slice(-16 * 1024);
  return {
    denied,
    blocked,
    exit,
    err1: isError === true || failMark(tail) ? firstErrorLine(text) : null,
    fail: failMark(tail),
    pass: PASS_MARK.test(tail) && !failMark(tail),
  };
}

// -------------------------------------------------------------------------------------- evidence

const CLAIMS_MAX = 50;
const CMDS_PER_CLAIM = 30;

/**
 * The evidence for every claim in one transcript (main file plus subagents), compact enough for a
 * receipt: for each final message that makes a claim, when it was said, the last file change
 * before it, and the shell commands that ran between that change and the claim (with what their
 * results said). Labels are given later (labelClaim), when the project's approved checks and its
 * ship checks are known.
 */
export function claimEvidence({ main, subs = [] }) {
  const finals = main.finals instanceof Map ? [...main.finals.values()] : [];
  if (!finals.length) return [];
  const all = [];
  const add = (st, fileRank) => {
    for (const t of st.tools.values()) {
      if (t.ts === null || t.ts === undefined) continue;
      all.push({ t, key: [t.ts, fileRank, t.seq ?? 0] });
    }
  };
  add(main, 1);
  subs.forEach((s) => add(s, 0));
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  all.sort((x, y) => cmp(x.key, y.key));
  const out = [];
  for (const f of finals) {
    const claim = detectClaim(f.text);
    if (!claim) continue;
    const at = [f.ts ?? 0, 1, f.seq ?? 0];
    const before = all.filter((x) => cmp(x.key, at) < 0);
    let lastEdit = null;
    let edits = 0;
    for (const x of before) {
      if (CLAIM_EDIT_TOOLS.has(x.t.name) && x.t.end !== null && x.t.error !== true) {
        lastEdit = x;
        edits++;
      }
    }
    const after = before.filter((x) => (!lastEdit || cmp(x.key, lastEdit.key) > 0) && SHELL_TOOLS.has(x.t.name) && typeof x.t.cmd === 'string' && x.t.end !== null && !x.t.bg && x.t.res && !x.t.res.denied && !x.t.res.blocked);
    const cmds = after.slice(-CMDS_PER_CLAIM).map(({ t }) => ({
      cmd: t.cmd,
      at: new Date(t.end ?? t.ts).toISOString(),
      error: t.error === true,
      exit: t.res.exit,
      err1: t.res.err1,
      fail: t.res.fail,
      pass: t.res.pass,
    }));
    out.push({
      at: new Date(f.ts ?? 0).toISOString(),
      kind: claim.kind,
      needs: claim.needs,
      phrase: claim.phrase,
      edits,
      last_edit_at: lastEdit ? new Date(lastEdit.t.end ?? lastEdit.t.ts).toISOString() : null,
      cmds,
    });
  }
  return out.slice(-CLAIMS_MAX);
}

/** A command's outcome as a check: true (passed), false (failed) or null (cannot tell: not counted). */
function outcome(c, masked) {
  if (!masked) return c.error !== true && (c.exit === 0 || c.exit === null) ? !c.fail || c.exit === 0 : false;
  // Masked exit code: only the output can say. A failure mark fails it; otherwise it must say it passed.
  if (c.fail) return false;
  if (c.pass) return true;
  return null;
}

/**
 * Label one claim. `approved`/`detected`: as for checkOf. `shipRuns`: this project's ship checks
 * [{at, results: [{name, cmd, kind, ok, tail}]}]; one that ran after the last change counts as a check
 * too. Returns {label, check: {cmd, at, ok, first_error_line, ship?}|null, needs}.
 */
export function labelClaim(c, { approved = [], detected = [], shipRuns = [] } = {}) {
  if (!c || typeof c !== 'object') return { label: 'not_verified', check: null };
  if (c.kind === 'completion' && !(c.edits > 0)) return { label: 'no_changes', check: null };
  const since = c.last_edit_at ? Date.parse(c.last_edit_at) : -Infinity;
  const checks = [];
  for (const x of Array.isArray(c.cmds) ? c.cmds : []) {
    const k = checkOf(x.cmd, { approved, detected });
    if (!k) continue;
    const ok = outcome(x, k.masked);
    if (ok === null) continue;
    checks.push({ kind: k.kind, cmd: x.cmd, at: x.at, ok, first_error_line: ok ? null : x.err1 || (x.exit ? `Exit code ${x.exit}` : null) });
  }
  for (const r of Array.isArray(shipRuns) ? shipRuns : []) {
    const t = Date.parse(r.at || r.started_at || '');
    if (!Number.isFinite(t) || !(t > since)) continue;
    for (const x of Array.isArray(r.results) ? r.results : []) {
      if (x.setup) continue;
      checks.push({ kind: x.kind || 'check', cmd: x.cmd, at: new Date(t).toISOString(), ok: x.ok === true, first_error_line: x.ok ? null : x.err1 || null, ship: true });
    }
  }
  checks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = (pred) => {
    const list = checks.filter(pred);
    return list.length ? list[list.length - 1] : null;
  };
  const needs = c.kind === 'tests' && Array.isArray(c.needs) && c.needs.length ? c.needs : null;
  const strip = (x) => (x ? { cmd: oneLine(String(x.cmd || ''), 300), at: x.at, ok: x.ok, first_error_line: x.first_error_line || null, ...(x.ship ? { ship: true } : {}) } : null);
  if (!needs) {
    const l = latest(() => true);
    if (!l) return { label: 'not_verified', check: null };
    return { label: l.ok ? 'verified' : 'contradicted', check: strip(l) };
  }
  // A tests claim names what passed: each one needs a check of that kind.
  const per = needs.map((n) => latest((x) => x.kind === n));
  const bad = per.find((x) => x && !x.ok);
  if (bad) return { label: 'contradicted', check: strip(bad) };
  if (per.every((x) => x && x.ok)) return { label: 'verified', check: strip(per[per.length - 1]) };
  return { label: 'not_verified', check: null };
}

/** The one message "Ask the agent to fix it" sends, exactly as shown to the owner first. */
export function fixMessage(check) {
  const cmd = oneLine(String(check?.cmd || 'the check'), 200).replace(/`/g, "'");
  const line = oneLine(String(check?.first_error_line || 'it failed'), 200).replace(/`/g, "'");
  return `Your last check failed: \`${cmd}\` → \`${line}\`. Please fix it and re-run the check.`;
}

/** The words a badge shows, e.g. "Verified: `npm test` passed at 14:02, after the last edit". */
export function badgeText(l, { time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } = {}) {
  if (!l) return '';
  if (l.label === 'verified') return `Verified: \`${l.check.cmd}\` passed at ${time(l.check.at)}, after the last edit${l.check.ship ? ' (ship check)' : ''}`;
  if (l.label === 'contradicted') return `Contradicted: \`${l.check.cmd}\` failed at ${time(l.check.at)}${l.check.first_error_line ? `: ${l.check.first_error_line}` : ''}`;
  if (l.label === 'no_changes') return 'No changes made';
  return 'Not verified: no check ran after the last edit';
}
