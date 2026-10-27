// Claim receipts (1.6): when an agent's final message says the work is done ("fixed", "tests pass",
// "builds"), Clawdling checks the session's own record and labels the claim:
//   verified      a check ran after the agent's last file change and passed
//   contradicted  a check ran after the last change and failed (the first error line is quoted)
//   not_verified  no check ran after the last change: the default, never an accusation
//   no_changes    a completion claim in a session that changed no file (not a claim about code)
// Deterministic and local: regular expressions over the transcript, no model call. A model judging
// "is this really done" would be one more claim; the receipt is a fact from the record.
import fs from 'node:fs';
import path from 'node:path';
import { oneLine, stripAnsi } from './util.js';

const RAW = JSON.parse(fs.readFileSync(new URL('./claims-patterns.json', import.meta.url), 'utf8'));
const re = (s) => new RegExp(s, 'u');
export const PATTERNS = {
  version: RAW.version,
  idioms: RAW.idioms.map((x) => ({ re: new RegExp(x.re, 'gu'), with: x.with })),
  fixVerbs: new RegExp(RAW.fix_scope.verbs, 'gu'),
  fixWords: new RegExp(RAW.fix_scope.words, 'gu'),
  clauseEnd: re(RAW.fix_scope.clause_end),
  tests: RAW.tests.map((x) => ({ need: x.need, re: re(x.re) })),
  completion: RAW.completion.map((x) => ({ re: re(x.re) })),
  excludeAny: RAW.exclude_any.map(re),
  excludeBefore: RAW.exclude_before.map(re),
  clauseSplit: new RegExp(RAW.clause_split, 'u'),
  progress: re(RAW.progress.re),
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
    // A fix that did not happen ("could not fix", "tried to fix", "need to fix") names nothing fixed.
    if (/(\bnot|n't|\bnever|\bunable to|\bfailed to|\btried to|\btry to|\bneed to|\bneeds to|\bwill|\bgoing to|\bto)\s+(?:\w+\s+)?$/.test(s.slice(Math.max(0, m.index - 24), m.index))) continue;
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
  // A claim beside an admitted failure ("Done. One test fails.") stays a claim: the record decides.
  const list = sentences(text).map((s) => ({ ...s, t: rewrite(s.text) }));
  // Each clause on its own: "Done, but one test fails" holds a claim ("done") and an admission.
  const clauses = list.filter((s) => !s.question).flatMap((s) => s.t.split(PATTERNS.clauseSplit)).map((c) => (c || '').trim()).filter(Boolean);
  // Still working ("now fanning out four lanes", "I'm running the tests"): a progress update.
  if (clauses.some((c) => PATTERNS.progress.test(c))) return null;
  for (const t of clauses) {
    let hit = false;
    // "14 of 15 tests passed" admits a failure: a count short of the total is no test claim.
    const nm = /(\d+)\s*(?:of|\/|out of)\s*(\d+)/.exec(t);
    const short = !!nm && Number(nm[1]) < Number(nm[2]);
    for (const p of PATTERNS.tests) {
      if (short) break;
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
const FORMAT_VERIFY = /(^|\s)(--verify-no-changes|--set-exit-if-changed|--check-formatted|--check|--lint|--dry-run)(\s|$)/;
const MAKE_KIND = { test: 'test', tests: 'test', check: 'test', unittest: 'test', spec: 'test', e2e: 'test', build: 'build', all: 'build', compile: 'build', lint: 'lint', vet: 'lint', typecheck: 'lint', 'fmt-check': 'lint', 'format-check': 'lint', ci: 'check', verify: 'check' };

function scriptKind(name) {
  for (const [r, k] of KIND_BY_SCRIPT) if (r.test(String(name || '').toLowerCase())) return k;
  return null;
}

/** The kind of check one command's words run (test, build, lint or check), or null. */
/** The command a shell line really runs: the program's own name, past wrappers (time, env, npx, uv run...). */
export function unwrap(w) {
  if (!w.length) return null;
  // The program's own name: ./node_modules/.bin/vitest is vitest, ./gradlew is gradlew.
  let a = [w[0].replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|bat|ps1)$/i, ''), ...w.slice(1)];
  // Wrappers that run what follows: time, npx/pnpm dlx/bunx, python -m, uv run, poetry run, env.
  for (let n = 0; n < 4; n++) {
    const h = a[0];
    // `command -v pytest` and `type pytest` only look a program up.
    if (h === 'command' && /^-[vV]$/.test(a[1] || '')) return null;
    if (h === 'time' || h === 'command' || h === 'exec' || h === 'nice' || h === 'nohup' || h === 'xvfb-run') a = a.slice(1).filter((x, i) => !(i === 0 && /^-/.test(x)));
    else if ((h === 'timeout' || h === 'gtimeout') && a.length > 2) a = a.slice(1).filter((x, i, arr) => !(arr.slice(0, i + 1).every((y) => /^-|^\d+[smhd]?$/.test(y))));
    else if (h === 'cross-env' || h === 'cross-env-shell') a = a.slice(1).filter((x, i, arr) => !(arr.slice(0, i + 1).every((y) => /=/.test(y))));
    else if ((h === 'dotenv' || h === 'dotenvx') && a.includes('--')) a = a.slice(a.indexOf('--') + 1);
    else if (h === 'npm' && a[1] === 'exec') a = a.slice(2).filter((x, i) => !(i === 0 && /^-/.test(x)) && x !== '--');
    else if (h === 'env') a = a.slice(1).filter((x, i, arr) => !(arr.slice(0, i + 1).every((y) => /=/.test(y))));
    else if (h === 'npx' || h === 'bunx' || (h === 'pnpm' && (a[1] === 'exec' || a[1] === 'dlx')) || (h === 'yarn' && (a[1] === 'dlx' || a[1] === 'exec'))) a = a.slice(h === 'npx' || h === 'bunx' ? 1 : 2).filter((x, i) => !(i === 0 && /^-/.test(x)));
    else if ((h === 'uv' || h === 'poetry' || h === 'pipenv' || h === 'hatch' || h === 'pdm' || h === 'rye') && a[1] === 'run') a = a.slice(2);
    else if ((h === 'bundle') && a[1] === 'exec') a = a.slice(2);
    else if (/^python[\d.]*$|^py$/.test(h) && a[1] === '-m') a = a.slice(2);
    else break;
    if (!a.length) return null;
  }
  return a;
}

export function wordsKind(w) {
  const a = unwrap(w);
  if (!a) return null;
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
  if (h === 'vitest' && b === 'list') return null;
  if (h === 'ctest' && a.some((x) => x === '-N' || x === '--show-only' || /^--show-only=/.test(x))) return null;
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
  if (h === 'go') {
    // `go test -list .` lists, `-run '^$'` compiles and runs no test.
    if (b === 'test' && a.some((x, i) => x === '-list' || /^-list=/.test(x) || ((x === '-run' && /^['"]?\^\$['"]?$/.test(a[i + 1] || '')) || /^-run=['"]?\^\$['"]?$/.test(x)))) return null;
    return b === 'test' ? 'test' : b === 'build' ? 'build' : b === 'vet' ? 'lint' : null;
  }
  if (h === 'cargo') return b === 'test' || b === 'nextest' ? 'test' : b === 'build' || b === 'check' ? 'build' : b === 'clippy' ? 'lint' : null;
  if (h === 'make' || h === 'gmake' || h === 'just' || h === 'task' || h === 'mage') {
    const t = a.slice(1).find((x) => !x.startsWith('-') && !x.includes('='));
    return t ? MAKE_KIND[lc(t)] || scriptKind(t) : h === 'make' ? 'build' : null;
  }
  if (h === 'mvn' || h === 'mvnw' || h === 'gradle' || h === 'gradlew') {
    if (a.some((x) => /^-D(skipTests|maven\.test\.skip)(=true)?$/.test(x)) || a.includes('-x') && a[a.indexOf('-x') + 1] === 'test') {
      const t0 = a.slice(1).find((x) => !x.startsWith('-'));
      return t0 === 'build' || t0 === 'package' || t0 === 'compile' || t0 === 'assemble' || t0 === 'verify' || t0 === 'install' ? 'build' : null;
    }
    const t = a.slice(1).find((x) => !x.startsWith('-'));
    return t === 'test' || t === 'verify' || t === 'check' ? 'test' : t === 'build' || t === 'package' || t === 'compile' || t === 'assemble' ? 'build' : null;
  }
  // `dart format .` and friends rewrite files: a lint check only in their verify mode.
  if (['dotnet', 'swift', 'mix', 'flutter', 'dart', 'bazel', 'buck2', 'zig'].includes(h)) return b === 'test' ? 'test' : b === 'build' ? 'build' : b === 'analyze' || (b === 'format' && FORMAT_VERIFY.test(a.join(' '))) ? 'lint' : null;
  if (h === 'rake' && (b === 'test' || b === 'spec')) return 'test';
  if (h === 'composer' && b === 'test') return 'test';
  return null;
}

const NO_RUN = /^(--version|-V|--help|-h|--collect-only|--co|--list|--list-.*|--listTests|--list-tests|--showConfig|--dry-run|--no-run|--print-config|--fixtures|--fixtures-per-test|--markers|--setup-plan|--setup-only)$/;
// `-n` is a dry run only for these (`pytest -n auto` is pytest-xdist's worker count, a real run).
const DRY_N = new Set(['make', 'gmake', 'just', 'go']);
const runsNothing = (w) => {
  const a = unwrap(w) || w; // `time make -n test`, `/usr/bin/make -n` are make
  if (a[0] === 'go' && a[1] === 'test' && a.includes('-c')) return true; // compiles the test binary, runs nothing
  if (a[0] === 'cargo' && a[1] === 'nextest' && a[2] === 'list') return true;
  return w.some((x) => NO_RUN.test(x)) || (DRY_N.has(a[0]) && a.some((x) => x === '-n' || x === '--just-print' || x === '--recon'));
};
/** The approved command itself, or it with extra flags (`npm test -- --ci`), never another script. */
// Flags that select only some tests (`pytest -k cart`, `-kcart`, `jest -t adds`, `--lf`, `-Dtest=X`):
// a pass then says nothing about the rest. Attached values (`-k=cart`, `--grep=x`) included.
const TEST_SELECT = /^(-[ktgmoR](=|$|[^-\s].*)|--(grep|testNamePattern|test-name-pattern|testPathPattern|test-path-pattern|filter|tests|only|test-only|lf|last-failed|sw|stepwise|onlyChanged|only-changed|onlyFailures|only-failures|next-failure|changed|findRelatedTests|related|bail-on-first)(=.*)?|-Dtest=.*|-run=(?!['"]?\^\$).*)$/;
// Flags that make a test run run none (`mvn test -DskipTests`, `go test ./... -run=^$`, `jest
// --passWithNoTests`): never a test check, on any matching path.
const SKIP_EXTRA = /^(-DskipTests(=true)?|-Dmaven\.test\.skip(=true)?|-run=['"]?\^\$['"]?|-list(=.*)?|-N|--show-only(=.*)?|-x|--passWithNoTests)$/;
// Whole-suite positional arguments (`go test ./...`, `pytest .`): not a selection.
const WHOLE = new Set(['./...', '...', '.', './']);
/** How many leading words name the runner (and its subcommand) of a test command; the rest select. */
function runnerWords(a) {
  const [h, b] = a;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(h)) return b === 'run' || b === 'run-script' ? 3 : 2;
  if (['ruff', 'biome', 'golangci-lint', 'deno', 'bun', 'uv', 'poetry'].includes(h) && b && !b.startsWith('-')) return 2;
  if (['make', 'gmake', 'just'].includes(h)) return b && !b.startsWith('-') ? 2 : 1;
  if (['go', 'cargo', 'dotnet', 'swift', 'mix', 'flutter', 'dart', 'deno', 'make', 'gmake', 'just', 'rake', 'composer', 'mvn', 'mvnw', 'gradle', 'gradlew', 'bazel', 'buck2', 'zig', 'playwright', 'cypress', 'task', 'mage'].includes(h)) return 2;
  if (h === 'vitest' && b === 'run') return 2;
  if (/manage\.py$/.test(h)) return 2;
  if (/^python[\d.]*$/.test(h) && /manage\.py$/.test(b || '')) return 3;
  if (h === 'node') return a.indexOf('--test') + 1 || 1;
  return 1;
}
/** Does this test command run only some tests? `extra`: the words after an approved or detected command. */
function selects(a, { extra = null } = {}) {
  const rest = extra || a.slice(runnerWords(a));
  return rest.some((x, j) => TEST_SELECT.test(x) || (x === '-run' && !/^['"]?\^\$['"]?$/.test(rest[j + 1] || '')) || (!extra && !x.startsWith('-') && !WHOLE.has(x) && x !== '--' && !/^-/.test(rest[j - 1] || '')));
}
/** The same check, whatever extra flags it ran with: its words without flags, past wrappers. */
export function checkId(cmd) {
  const a = unwrap(words(String(cmd || '').trim())) || [];
  return a.filter((x) => !x.startsWith('-')).join(' ');
}
function sameOrFlags(cmd, base) {
  const a = words(String(cmd || '').trim());
  const b = words(String(base || '').trim());
  if (!b.length || a.length < b.length || b.some((x, i) => a[i] !== x)) return false;
  return a.slice(b.length).every((x) => x.startsWith('-') && !SKIP_EXTRA.test(x));
}
const NAME_KIND = { tests: 'test', test: 'test', unit: 'test', e2e: 'test', build: 'build', compile: 'build', lint: 'lint', typecheck: 'lint', types: 'lint', format: 'lint' };

/**
 * Is this shell command a check, and of what kind? `approved`: the project's approved checks.yaml
 * commands [{name, run}] (exact, or exact plus extra flags); `detected`: the stack's commands
 * [{kind, cmd}]; then the generic list. Returns {kind, masked} or null. `masked`: its exit code does
 * not reach the tool result (piped into another command, or followed by `|| ...` or `; ...`), so
 * pass or fail must come from its output.
 */
export function checkOf(cmd, { approved = [], detected = [] } = {}) {
  const segs = segments(cmd);
  let pipefail = false;
  let errexit = false;
  let found = null;
  const trivial = (w) => ['set', 'cd', 'pushd', 'popd', 'export', 'source', '.', 'echo', 'true', ':'].includes(w[0]);
  // The other commands of an && chain: a failure of the whole line may be theirs, not the check's.
  const meaningful = segs.filter((sg) => !trivial(words(sg.raw))).length;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const w = words(s.raw);
    if (w[0] === 'set') {
      // In order: `set -e` turns errexit on, `set +e` off; `-o`/`+o` name an option (pipefail, errexit).
      for (let j = 1; j < w.length; j++) {
        const x = w[j];
        if (/^[-+]o$/.test(x)) {
          const on = x[0] === '-';
          if (w[j + 1] === 'pipefail') pipefail = on;
          if (w[j + 1] === 'errexit') errexit = on;
          j++;
        } else if (/^[-+][a-zA-Z]+$/.test(x)) {
          const on = x[0] === '-';
          if (x.includes('e')) errexit = on;
          // `set -euo pipefail`: an o in the group takes the next word as its option name.
          if (x.includes('o') && w[j + 1]) {
            if (w[j + 1] === 'pipefail') pipefail = on;
            if (w[j + 1] === 'errexit') errexit = on;
            j++;
          }
        }
      }
      continue;
    }
    if (trivial(w)) continue;
    // Listing, help and version flags run nothing: never a check (`npx tsc --version`, `jest --listTests`).
    if (runsNothing(w)) continue;
    let kind = null;
    let base = null; // the approved or detected command it matched: the owner's definition of the check
    const trimmed = s.raw.trim();
    for (const ap of approved) {
      if (!ap || typeof ap.run !== 'string') continue;
      if (sameOrFlags(trimmed, ap.run)) {
        kind = NAME_KIND[String(ap.name || '').toLowerCase()] || wordsKind(words(ap.run)) || 'check';
        base = ap.run;
        break;
      }
    }
    if (!kind) {
      for (const d of detected) {
        if (d && typeof d.cmd === 'string' && sameOrFlags(trimmed, d.cmd)) {
          kind = d.kind === 'test' ? 'test' : d.kind === 'build' ? 'build' : d.kind === 'lint' || d.kind === 'typecheck' ? 'lint' : d.kind === 'check' ? 'check' : null;
          if (kind) {
            base = d.cmd;
            break;
          }
        }
      }
    }
    if (!kind) kind = wordsKind(w);
    if (!kind) continue;
    // The exit code that reaches the tool result: the last command's, unless a failure stops the chain.
    // Any later `||`, `;` (without set -e), `&` or pipe (without pipefail) can hide the check's own
    // exit (`npm test && npm run build || true`), not only the operator right after it.
    const rest = segs.slice(i);
    const ops = rest.map((x) => x.op).filter((op, j) => op && !(op === ';' && j === rest.length - 1)); // a trailing `;` hides nothing
    // set -e stops the line at a failed check only when the check is not followed by && or || before
    // that `;` (in `npm test && true; echo done` it does not stop).
    // Behind && or || itself, it may never have run, and set -e does not stop the line at the command
    // before it (`set -e; npm run build && npm test; echo done`): a later `;` then hides everything.
    const behind = i > 0 && (segs[i - 1].op === '&&' || segs[i - 1].op === '||');
    const masked = ops.some((op, j) => (op === '|' && !pipefail) || op === '||' || op === '&' || (op === ';' && (!errexit || behind || ops.slice(0, j).some((o) => o === '&&' || o === '||'))));
    // Other commands ran before it in the line: failure marks in the output may be theirs.
    const preceded = segs.slice(0, i).some((sg) => !trivial(words(sg.raw)));
    // Piped into a program that keeps only some lines: the failure (or the totals) can be cut off.
    // Only tail, cat and tee keep the end of the output whole; anything else down the pipe can drop it.
    let cut = false;
    for (let j = i; j < segs.length - 1 && segs[j].op === '|'; j++) {
      if (!/^(tail|cat|tee)$/.test((unwrap(words(segs[j + 1].raw)) || [''])[0])) cut = true;
    }
    // A later part of the line that can print (after ;, || or &&) could supply a pass of its own.
    const quiet = (w2) => !w2.length || ['true', ':', 'false', 'exit', 'return'].includes(w2[0]) || w2.every((y) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(y));
    const later = rest.slice(0, -1).some((x, j) => (x.op === ';' || x.op === '||' || x.op === '&&') && rest[j + 1] && !quiet(words(rest[j + 1].raw)));
    // Only some tests selected (`pytest -k cart`, `jest -t adds`, `go test -run TestCart`): a pass
    // says nothing about the rest, a failure still counts.
    // (An approved or detected command is the owner's definition of the check: only the flags added to
    // it can select. Otherwise any argument after the runner does: `jest src/a.test.js`, `cargo test cart`.)
    const partial = kind === 'test' && selects(unwrap(w) || w, { extra: base ? words(trimmed).slice(words(base).length) : null });
    found = { kind, masked, chained: !masked && meaningful > 1, preceded, behind, cut, later, partial, id: checkId(base || trimmed), cmd: trimmed };
    if (!masked) break; // an unmasked check decides
  }
  return found;
}

// A shell command that changes files counts as an edit ("the agent's last file change"): an output
// redirection to a file, or a program that writes (sed -i, mv, a formatter with --write, git apply...).
const WRITE_PROGRAMS = new Set(['mv', 'cp', 'rm', 'rmdir', 'touch', 'mkdir', 'ln', 'truncate', 'patch', 'rsync', 'install', 'unzip', 'tar']);
const GIT_WRITES = new Set(['apply', 'checkout', 'restore', 'reset', 'merge', 'rebase', 'cherry-pick', 'pull', 'am', 'mv', 'rm', 'revert', 'switch']);
const INLINE_CODE = /(^|[\s;&|(])(python[\d.]*|node|ruby|perl|php|deno|bun|Rscript)(\s+-[A-Za-z]*\s+|\s+)(-c\b|-e\b|-E\b|--eval\b|-(\s|$)|[^\n]*<<)/m;
const CODE_WRITES = /write|open\([^)]*['"][wax]|unlink|rename|remove|rmtree|rmdir|mkdir|replace\(|truncate|copyfile|shutil|os\.system|subprocess|spawn|execSync|fs\.|File\.(write|open|delete)|Path\(|chmod/i;
const PS_WRITES = new Set(['set-content', 'add-content', 'out-file', 'new-item', 'remove-item', 'move-item', 'copy-item', 'rename-item', 'clear-content', 'expand-archive', 'compress-archive', 'tee-object', 'sc', 'ac', 'ni', 'ri', 'mi', 'cpi', 'rni', 'del', 'erase', 'rd', 'move', 'copy', 'ren', 'md', 'mkdir', 'rm', 'mv', 'cp']);
const PKG_WRITES = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'version', 'dedupe', 'prune']);

function segmentWrites(raw) {
  // A redirection to a quoted file name (`> "a.js"`) writes too.
  for (const m of raw.matchAll(/(?:^|[^<>&\d])\d?>>?\s*(["'])([^"']*)\1/g)) if (!/^\/dev\//.test(m[2])) return true;
  // A redirection to a file (not 2>&1, not /dev/null), outside quotes.
  const bare = raw.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  for (const m of bare.matchAll(/(?:^|[^<>&\d])\d?>>?\s*([^\s&|;<>]+)/g)) {
    const target = m[1];
    if (!target.startsWith('&') && !/^\/dev\//.test(target) && target !== '""') return true;
  }
  return programWrites(words(raw), raw);
}

/** Does this program (its words) write files? Seen past wrappers, xargs and find -exec. */
function programWrites(w0, raw = '', depth = 0) {
  if (depth > 4 || !w0.length) return false;
  let w = w0[0] === 'sudo' ? w0.slice(1).filter((x, i) => !(i === 0 && x.startsWith('-'))) : w0;
  w = unwrap(w) || w; // uv run ruff format ., poetry run black ., python -m black ., pnpm exec eslint --fix
  const [h, b] = [String(w[0] || '').replace(/^.*[\\/]/, ''), w[1]];
  // xargs runs what follows on every input line (`grep -rl x src | xargs sed -i ...`).
  if (h === 'xargs') {
    let j = 1;
    while (j < w.length && w[j].startsWith('-')) j += /^-[IndPLaEs]$/.test(w[j]) ? 2 : 1;
    return programWrites(w.slice(j), raw, depth + 1);
  }
  // find deletes, or runs a program on each file it finds.
  if (h === 'find') {
    if (w.includes('-delete') || w.some((x) => /^-f(print|print0|ls|printf)$/.test(x))) return true;
    const e = w.findIndex((x) => /^-(exec|execdir|ok|okdir)$/.test(x));
    if (e !== -1) {
      const end = w.findIndex((x, j) => j > e && (x === ';' || x === '\\;' || x === '+'));
      return programWrites(w.slice(e + 1, end === -1 ? undefined : end), raw, depth + 1);
    }
    return false;
  }
  if (WRITE_PROGRAMS.has(h)) return true;
  // Read-only tools with a writing mode.
  if ((h === 'sort' && w.some((x) => x === '-o' || x.startsWith('--output'))) || (h === 'uniq' && w.slice(1).filter((x) => !x.startsWith('-')).length >= 2) || (h === 'xxd' && w.includes('-r') && w.slice(1).filter((x) => !x.startsWith('-')).length >= 2) || (h === 'tree' && w.includes('-o'))) return true;
  if ((h === 'awk' || h === 'gawk') && (w.some((x, j) => x === '-i' && w[j + 1] === 'inplace') || /system\s*\(|print[^|]*>/.test(raw))) return true;
  // Any tool asked to fix or write (`cargo clippy --fix`, `rubocop -A`, `golangci-lint run --fix`).
  if (w.some((x) => /^--(fix|write|apply|autocorrect|autocorrect-all|fix-only|unsafe-fixes)$/.test(x)) || (h === 'rubocop' && w.some((x) => x === '-a' || x === '-A'))) return true;
  // PowerShell's writing cmdlets and their aliases (any case), and .NET file writes.
  if (PS_WRITES.has(h.toLowerCase()) || /\[(System\.)?IO\.File\]::(Write|Append|Copy|Move|Delete|Create)/i.test(raw)) return true;
  if ((h === 'sed' || h === 'perl') && w.some((x) => /^-[A-Za-z0-9]*i/.test(x) || x === '-I' || x.startsWith('--in-place'))) return true;
  // `--fix` or `--write` passed to any package script (`npm run lint -- --fix`, `pnpm lint --fix`).
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(h) && w.some((x) => x === '--fix' || x === '--write')) return true;
  if (h === 'tee' && w.slice(1).some((x) => !x.startsWith('-'))) return true;
  if (h === 'git' && GIT_WRITES.has(b) || (h === 'git' && b === 'stash' && /^(pop|apply)$/.test(w[2] || ''))) return true;
  if ((h === 'npm' || h === 'pnpm' || h === 'yarn' || h === 'bun') && PKG_WRITES.has(b)) return true;
  if (h === 'prettier' && w.some((x) => x === '--write' || x === '-w')) return true;
  if ((h === 'eslint' || h === 'ruff' || h === 'biome' || h === 'stylelint') && w.some((x) => x === '--fix' || x === '--write' || x === '--apply')) return true;
  if (h === 'ruff' && b === 'format' && !w.includes('--check')) return true;
  // A formatter run (`npm run format`, `make fmt`, `dart format .`) rewrites files.
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(h) && /^(format|fmt|prettier|fix|lint:fix|lint-fix|format:write)$/.test(b === 'run' || b === 'run-script' ? w[2] || '' : b || '')) return true;
  if (['make', 'gmake', 'just'].includes(h) && w.slice(1).some((x) => /^(fmt|format|fix)$/.test(x))) return true;
  if (['dotnet', 'swift', 'mix', 'flutter', 'dart'].includes(h) && b === 'format' && !FORMAT_VERIFY.test(w.join(' '))) return true;
  if ((h === 'black' || h === 'isort' || h === 'autopep8') && !w.includes('--check') && !w.includes('--diff')) return true;
  if ((h === 'gofmt' || h === 'goimports') && w.includes('-w')) return true;
  if ((h === 'go' && b === 'fmt') || (h === 'cargo' && (b === 'fmt' || b === 'fix')) || h === 'rustfmt') return true;
  return false;
}

/**
 * Does this shell command change files? {writes, checkAfter}: checkAfter is true when a check runs
 * after the write in the same command line (`... > f && npm test`), so it still counts after the edit.
 */
export function writesFiles(cmd) {
  // Inline code for an interpreter (`python3 - <<'EOF'`, `node -e`, `ruby -e`) that touches files.
  if (INLINE_CODE.test(cmd) && CODE_WRITES.test(cmd)) return { writes: true, checkAfter: false };
  const segs = segments(cmd);
  let last = -1;
  segs.forEach((sg, i) => {
    if (segmentWrites(sg.raw)) last = i;
  });
  if (last === -1) return { writes: false, checkAfter: false };
  const after = segs.slice(last + 1).map((x) => x.raw).join(' ; ');
  const k = after ? checkOf(after) : null;
  return { writes: true, checkAfter: !!k && !k.masked };
}

// Agent memory notes (the /handoff), and files outside the session's folder, are not the work.
const MEMORY_FILE = /(^|[\\/])memory[\\/](NOW|LOG)\.md$/i;
function inside(dir, file) {
  if (!dir || !file || !path.isAbsolute(String(file))) return true;
  const key = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const under = (d, f) => f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
  // By path, and by real path: a folder under a link (~/clawdling -> a synced folder) is reached by
  // Claude Code through its real path.
  return under(key(path.resolve(dir)), key(path.resolve(String(file)))) || under(key(realOf(dir)), key(realOf(String(file))));
}

const realCache = new Map();
/** The real path of `p`, through its nearest existing parent (a file may be gone since). */
function realOf(p) {
  const abs = path.resolve(p);
  if (realCache.has(abs)) return realCache.get(abs);
  const rest = [];
  let cur = abs;
  let out = abs;
  for (;;) {
    try {
      out = path.join(fs.realpathSync.native(cur), ...rest);
      break;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) break;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
  if (realCache.size > 5000) realCache.clear();
  realCache.set(abs, out);
  return out;
}

/** Is this tool call a change to the work (an edit), for "after the last edit"? `roots`: where it counts. */
export function isWorkEdit(t, roots) {
  if (t.end === null || t.end === undefined) return false;
  // A shell command that writes and then fails (`sed -i ... && npm test`) still changed the files: for
  // shell tools an error is a non-zero exit, not "nothing was written". Only a call that never ran
  // (declined, blocked) changed nothing.
  // A command cut at 1,000 characters may write past the cut: it counts as a change.
  // (A write run in the background is a change too.)
  if (SHELL_TOOLS.has(t.name) && typeof t.cmd === 'string') return !(t.res && (t.res.denied || t.res.blocked)) && (t.cmdCut === true || writesFiles(t.cmd).writes);
  if (t.error === true) return false;
  if (CLAIM_EDIT_TOOLS.has(t.name)) {
    if (t.file && MEMORY_FILE.test(t.file)) return false;
    const list = Array.isArray(roots) ? roots : [roots];
    return !list.filter(Boolean).length || list.filter(Boolean).some((r) => inside(r, t.file));
  }
  return false;
}

// ---------------------------------------------------------------------------------- tool results

// Claude Code's own words for a call the person declined, or that was never run (exactly, at the
// start of the result): not a check. A command's own output saying "permission denied" is a failure.
const DENIED = /^(?:The user doesn't want to proceed with this tool use|\[Request interrupted by user|Permission to use \S+ (?:has been|was) denied|Claude requested permissions to )/;
const BLOCKED = /^<tool_use_error>/;
// A foreground command Claude Code moved to the background (a timeout, or Ctrl+B): not finished.
const BACKGROUNDED = /^Command running in background with ID:/m;
const ERROR_LINE = /(\berror\b|\berr!|\bfail(ed|ure|ing|s)?\b|✗|✕|×|\bassert(ion)?\b|\bexception\b|\bpanic(ked)?\b|\bnot ok\b|\btraceback\b|\bcannot\b|\bundefined\b|\bexpected\b)/i;
// Failure marks: the capitals test runners print (FAIL, ERROR:), and counts above zero.
const FAIL_UPPER = /(^|\s)(FAIL|FAILED|FAILURES?)\b|npm ERR!|^npm error\b|^not ok \d|^\s*\u2716|^\u2139 fail [1-9]|\btest result: FAILED|\bERROR:|\bBUILD FAILED\b/m;
const FAIL_COUNT = /\b([1-9]\d*) (tests? )?(failed|failing|failures?|errors?)\b|\bTests?:\s+[1-9]\d* failed|^# fail [1-9]|\bexit (code|status) [1-9]/im;
// Evidence that checks ran and failed: a runner's failure lines and counts, or compile errors. Not
// npm's own lines ("npm error Missing script"), not "command not found", not "No tests found":
// those say the check could not run, which is no contradiction.
const CHECK_FAILED = /(^|\s)(FAIL|FAILED|FAILURES?)\b|^not ok \d|^\s*\u2716|^\u2139 fail [1-9]|\btest result: FAILED|\bBUILD FAILED\b|\berror TS\d+|\berror\[E\d+\]|\bFailed to compile\b|\bBuild failed\b|\berror during build\b|^ERROR in |\[ERROR\]/m;
export const checkFailed = (t) => {
  const s = String(t).replace(/^\s*\u2716 \d+ problems? \(0 errors?, \d+ warnings?\)\s*$/gm, '');
  return CHECK_FAILED.test(s) || FAIL_COUNT.test(s.replace(/\bexit (code|status) [1-9]\d*/gi, ''));
};
// ESLint ends a warnings-only run with "✖ 2 problems (0 errors, 2 warnings)": not a failure.
const failMark = (t) => {
  const s = String(t).replace(/^\s*\u2716 \d+ problems? \(0 errors?, \d+ warnings?\)\s*$/gm, '');
  return FAIL_UPPER.test(s) || FAIL_COUNT.test(s);
};
// The totals a runner prints at the end. With a hidden exit code only these count: a per-test line
// (✔ adds, ok 1, PASS a.test.js) says nothing about the tests after it.
const PASS_SUMMARY = /\b[1-9]\d* (tests? )?(passed|passing)\b|\bTests?:\s+\d+ passed\b|^# pass [1-9]|^\u2139 pass [1-9]|\btest result: ok\b|\bBUILD SUCCESS(FUL)?\b|\bCompiled successfully\b|\bbuilt in \d|\bAll checks passed\b|\bFound 0 errors\b|\b0 problems\b/im;
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
  const head = text.trimStart().slice(0, 2000);
  const ran = /^Exit code \d+/.test(head);
  const denied = isError === true && !ran && DENIED.test(head);
  const blocked = isError === true && !ran && !denied && BLOCKED.test(head);
  const backgrounded = !ran && BACKGROUNDED.test(head);
  const m = /^Exit code (\d+)/.exec(text.trimStart());
  const exit = m ? Number(m[1]) : isError === true ? null : 0;
  // Pass and fail marks are read from the end of the output, where test runners print their totals;
  // never from Claude Code's own "Exit code N" header (that is the exit code, not the output).
  const tail = text.replace(/^\s*Exit code \d+\s*\n?/, '').slice(-16 * 1024);
  return {
    denied,
    blocked,
    backgrounded,
    exit,
    err1: isError === true || failMark(tail) ? firstErrorLine(text) : null,
    fail: failMark(tail),
    tfail: checkFailed(tail),
    pass: PASS_MARK.test(tail) && !failMark(tail),
    summary: PASS_SUMMARY.test(tail) && !failMark(tail),
  };
}

// -------------------------------------------------------------------------------------- evidence

const CLAIMS_MAX = 50;
const SHIP_WINDOW_MS = 24 * 3600 * 1000;
const CMDS_PER_CLAIM = 200;
// MCP tools whose names say they change something (filesystem write_file, serena replace_symbol...).
const WRITE_TOOL = /^mcp__.*(write|edit|create|update|delete|move|rename|replace|insert|apply|patch|save|put|remove|upload|modify|append|refactor)/i;
// Commands that only look (a single one, no redirection): never a check and never a change.
const LOOK = new Set(['ls', 'cat', 'grep', 'rg', 'find', 'head', 'tail', 'wc', 'pwd', 'which', 'file', 'stat', 'tree', 'du', 'df', 'date', 'whoami', 'type', 'echo', 'printf', 'less', 'more', 'diff']);
const GIT_LOOK = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'remote', 'describe', 'blame', 'config']);
function readOnly(cmd) {
  const segs = segments(String(cmd || ''));
  if (segs.length !== 1 || /[<>]/.test(segs[0].raw.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ''))) return false;
  const w = words(segs[0].raw);
  const looks = LOOK.has(w[0]) || (w[0] === 'git' && GIT_LOOK.has(w[1]) && !(w[1] === 'config' && w.length > 3));
  // (Only as sure as knownSafe: `find src -exec python3 fix.py {} +` is not a look.)
  return looks && knownSafe(cmd) && !checkOf(cmd);
}

/**
 * The evidence for every claim in one transcript (main file plus subagents), compact enough for a
 * receipt: for each final message that makes a claim, when it was said, the last file change
 * before it, and the shell commands that ran between that change and the claim (with what their
 * results said). Labels are given later (labelClaim), when the project's approved checks and its
 * ship checks are known.
 */
export function claimEvidence({ main, subs = [] }, { roots = null } = {}) {
  // Where a change counts: the session's folder, plus a group project agent's repos (--add-dir).
  const where = [...new Set([...(roots && roots.length ? roots : []), main.cwd])].filter(Boolean);
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
    let editsEnd = -Infinity; // when the last of them finished (edits and subagents can overlap)
    const editList = [];
    for (const x of before) {
      if (isWorkEdit(x.t, where)) {
        lastEdit = x;
        edits++;
        editsEnd = Math.max(editsEnd, x.t.end ?? x.t.ts);
        editList.push(x);
      }
    }
    // A command that writes and then runs a check (`... > f && npm test`) is the edit and, just after
    // it, the check.
    // The session's first change after the claim ends the time a ship check can speak for it.
    const nextEdit = all.find((x) => cmp(x.key, at) > 0 && isWorkEdit(x.t, where));
    const otherEditsEnd = before.filter((x) => x !== lastEdit && isWorkEdit(x.t, where)).reduce((m, x) => Math.max(m, x.t.end ?? x.t.ts), -Infinity);
    const selfChecked = lastEdit && SHELL_TOOLS.has(lastEdit.t.name) && writesFiles(lastEdit.t.cmd).checkAfter && lastEdit.t.ts >= otherEditsEnd;
    // A check runs after every edit: it started after the edit finished, or it comes later in the same
    // assistant message (Claude Code runs an edit and a shell command of one message in order, so
    // `Edit` + `npm test` sent together test the edited file).
    const afterEdits = (x) => editList.every((e) => (e.t.end ?? e.t.ts) <= x.t.ts || (x.t.msg && e.t.msg === x.t.msg && e.t.seq < x.t.seq));
    const after = before.filter((x) => (!lastEdit || (cmp(x.key, lastEdit.key) > 0 && afterEdits(x)) || (selfChecked && x === lastEdit)) && SHELL_TOOLS.has(x.t.name) && typeof x.t.cmd === 'string' && x.t.end !== null && x.t.res && !x.t.res.denied && !x.t.res.blocked);
    // A tool that may change files and that Clawdling cannot read (an MCP server's write or edit
    // tool): it ends what the checks before it say, like an unknown shell command.
    const toolsAfter = before.filter((x) => (!lastEdit || cmp(x.key, lastEdit.key) > 0) && WRITE_TOOL.test(String(x.t.name || '')));
    const toolFence = toolsAfter.length ? new Date(Math.max(...toolsAfter.map((x) => x.t.end ?? x.t.ts))).toISOString() : null;
    // The commands that can matter to a label (not a passing `git status` or `ls`), newest 200; when
    // there were more, the claim says so (an older failure could be among them).
    const matters = after.filter(({ t }) => t.error === true || !(t.res && t.res.exit === 0 && !t.res.fail) || !readOnly(t.cmd));
    // Shell commands not known to leave files alone, before the claim: a completion claim with no
    // edit is "No changes made" only when there are none.
    const maybe = edits ? 0 : before.filter((x) => (SHELL_TOOLS.has(x.t.name) && typeof x.t.cmd === 'string' && !(x.t.res && (x.t.res.denied || x.t.res.blocked)) && !knownSafe(x.t.cmd)) || WRITE_TOOL.test(String(x.t.name || ''))).length;
    // A completion claim with no edit is No changes made: its commands are never read.
    const kept = claim.kind === 'completion' && !edits && !maybe ? [] : matters.slice(-CMDS_PER_CLAIM);
    const cmds = kept.map(({ t }) => ({
      cmd: t.cmd,
      at: new Date(t.end ?? t.ts).toISOString(),
      error: t.error === true,
      exit: t.res.exit,
      err1: t.res.err1,
      fail: t.res.fail,
      pass: t.res.pass,
      summary: t.res.summary,
      tfail: t.res.tfail === true,
      ...(t.cmdCut ? { cut: true } : {}),
      ...(t.bg ? { bg: true } : {}),
    }));
    out.push({
      at: new Date(f.ts ?? 0).toISOString(),
      kind: claim.kind,
      needs: claim.needs,
      phrase: claim.phrase,
      edits,
      last_edit_at: lastEdit ? new Date(editsEnd).toISOString() : null,
      next_edit_at: nextEdit ? new Date(nextEdit.t.ts).toISOString() : null,
      cmds,
      ...(kept.length && matters.length > CMDS_PER_CLAIM ? { cmds_dropped: true } : {}),
      ...(maybe ? { maybe_changes: maybe } : {}),
      ...(toolFence ? { tool_fence_at: toolFence } : {}),
    });
  }
  return out.slice(-CLAIMS_MAX);
}

/** A command's outcome as a check: true (passed), false (failed) or null (cannot tell: not counted). */
function outcome(c, masked, chained = false, preceded = false, cut = false, later = false, behind = false) {
  const failed = !(c.error !== true && (c.exit === 0 || c.exit === null) ? !c.fail || c.exit === 0 : false);
  // Behind && (`cd app && npm test`, `source .venv/bin/activate && pytest`): a failure with no failure
  // marks may be the command before it, and the check never ran.
  if (!masked && behind && failed && !c.fail) return null;
  // In an && chain with other commands, the line's failure (and its failure marks: "npm ERR!" from
  // `npm ci`, "Found 2 errors" from a build) may be theirs: only a pass counts, which means every
  // command in it passed.
  if (!masked && chained && failed) return null;
  if (!masked) return !failed;
  // Masked exit code: only the output can say. A failure mark fails it (unless another command ran
  // before it in the line: then the mark may be that one's); otherwise it must say it passed.
  if (c.fail) return preceded ? null : false;
  if (cut || later) return null; // output cut by head/grep..., or a later command could have printed the pass
  if (c.summary) return true;
  return null;
}

/**
 * Label one claim. `approved`/`detected`: as for checkOf. `shipRuns`: this project's ship checks
 * [{at, results: [{name, cmd, kind, ok, tail}]}]; one that ran after the last change counts as a check
 * too. Returns {label, check: {cmd, at, ok, first_error_line, ship?}|null, needs}.
 */
export function labelClaim(c, { approved = [], detected = [], shipRuns = [], commitHooks = false } = {}) {
  if (!c || typeof c !== 'object') return { label: 'not_verified', check: null };
  if (c.kind === 'completion' && !(c.edits > 0)) return c.maybe_changes > 0 ? { label: 'not_verified', check: null } : { label: 'no_changes', check: null };
  const since = c.last_edit_at ? Date.parse(c.last_edit_at) : -Infinity;
  const said = Date.parse(c.at || '') || 0;
  // A ship check speaks for this claim only soon after it (24 h) and before the session changed
  // anything again (`until`, its next change): one check never relabels a week.
  const shipFrom = Math.max(since, said - 60000);
  const shipTo = Math.min(said + SHIP_WINDOW_MS, c.until ? Date.parse(c.until) : Infinity);
  // What the session's own commands say. Only a canonical run (one command: the project's check,
  // or a standard runner with harmless flags, its exit code visible) can verify or contradict. Any
  // other recognized check that shows a failure (piped, chained, `|| true`, only some tests...)
  // keeps the claim at Not verified: the record cannot tell whose failure it is, or what it covered.
  // Any command after a check that is not known to leave files alone (a script, a codegen, `cargo
  // clippy --fix`) may have changed the work: checks before it no longer speak for the claim.
  let fence = c.tool_fence_at ? Date.parse(c.tool_fence_at) || -Infinity : -Infinity;
  for (const x of Array.isArray(c.cmds) ? c.cmds : []) if (!x.cut && !knownSafe(x.cmd, { approved, detected, commitHooks })) fence = Math.max(fence, Date.parse(x.at) || 0);
  const checks = [];
  if (c.cmds_dropped) checks.push({ kinds: ['check'], id: null, canonical: false, ok: false, at: c.last_edit_at || c.at, cmd: '(older commands)', first_error_line: null });
  for (const x of Array.isArray(c.cmds) ? c.cmds : []) {
    if (x.cut) continue; // only its first 1,000 characters were kept (and it counts as a change)
    if (x.bg) continue; // run in the background: its result is not in the record (it only fences)
    const k = checkOf(x.cmd, { approved, detected });
    const failedExit = x.error === true || (x.exit !== null && x.exit !== undefined && x.exit !== 0);
    // Not a recognized check, but it failed with a runner's failure marks (`timeout 600 npm test`, a
    // script): a possible failure too.
    if (!k) {
      if (failedExit && x.fail === true) checks.push({ kinds: ['check'], id: null, canonical: false, ok: false, cmd: x.cmd, at: x.at, first_error_line: x.err1 || null });
      continue;
    }
    const canon = canonical(x.cmd, { approved, detected });
    const first = x.err1 || (x.exit ? `Exit code ${x.exit}` : null);
    if ((Date.parse(x.at) || 0) <= fence) {
      // Before an unknown command: a pass no longer counts, a failure is only a possible one.
      if (failedExit || x.fail === true) checks.push({ kinds: canon ? [canon.kind] : lineKinds(x.cmd, { approved, detected }), id: null, canonical: false, ok: false, cmd: x.cmd, at: x.at, first_error_line: first });
      continue;
    }
    if (canon) {
      // A `timeout` wrapper that cut the run off (124, or 137 for KILL): it did not finish.
      const timedOut = behindTimeout(x.cmd) && (x.exit === 124 || x.exit === 137);
      const exitShown = typeof x.exit === 'number' && !timedOut;
      // A canonical pass: exit 0 and no failure marks (a script that hides its own exit code prints them).
      if (!failedExit && !x.fail) checks.push({ kind: canon.kind, kinds: [canon.kind], id: canon.id, rid: canon.rid, canonical: true, ok: true, cmd: x.cmd, at: x.at });
      // A canonical failure: a visible non-zero exit AND output showing checks that ran and failed
      // (a missing script, a runner that never started, no tests found, a cut-off run: only possible).
      else if (failedExit && exitShown && x.exit !== 0 && (x.tfail === true || (x.tfail === undefined && x.fail === true))) checks.push({ kind: canon.kind, kinds: [canon.kind], id: canon.id, rid: canon.rid, canonical: true, ok: false, cmd: x.cmd, at: x.at, first_error_line: first });
      // Anything else (exit 0 with marks, an error with no exit code: a timeout) is a possible failure.
      else checks.push({ kinds: [canon.kind], id: null, canonical: false, ok: false, cmd: x.cmd, at: x.at, first_error_line: first });
    } else if (failedExit || x.fail === true) {
      // Whose failure it is cannot be told: it counts against every claim, as any of the line's kinds.
      checks.push({ kinds: lineKinds(x.cmd, { approved, detected }), id: null, canonical: false, ok: false, cmd: x.cmd, at: x.at, first_error_line: first });
    }
  }
  // Each ship-check run after the claim is one check: it passed only when every step passed. The
  // scratch copy is not the agent's environment (no packages unless a setup step installed them, no
  // .env, no secrets), so a ship check speaks one way only: a pass can verify a claim the session
  // left unchecked; a failure keeps it Not verified (never Contradicted, never discarded), and a pass
  // never overrides the session's own failures (tests skipped for a missing variable pass too).
  for (const r of Array.isArray(shipRuns) ? shipRuns : []) {
    const t = Date.parse(r.at || r.started_at || '');
    if (!Number.isFinite(t) || !(t > shipFrom) || !(t < shipTo)) continue;
    const steps = (Array.isArray(r.results) ? r.results : []).filter((x) => !x.setup);
    if (!steps.length) continue;
    const failed = steps.filter((x) => x.ok !== true);
    const bad = failed[0];
    checks.push({ ship: true, kinds: steps.map((x) => x.kind || 'check'), failedKinds: failed.map((x) => x.kind || 'check'), canonical: false, ok: !bad, cmd: bad ? bad.cmd : steps[steps.length - 1].cmd, at: new Date(t).toISOString(), first_error_line: bad ? bad.err1 || null : null });
  }
  checks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const needs = c.kind === 'tests' && Array.isArray(c.needs) && c.needs.length ? c.needs : null;
  // A canonical check counts for the claim's kinds; a failure whose owner cannot be told counts
  // against every claim.
  // (A failure of a general check, `make ci`, counts against a tests claim: it may be a test.)
  const counts = (x) => !needs || (x.ship ? (x.ok ? x.kinds : x.failedKinds).some((k) => needs.includes(k) || (!x.ok && k === 'check' && needs.includes('test'))) : !x.canonical || needs.includes(x.kind) || (!x.ok && x.kind === 'check' && needs.includes('test')));
  // A failure stands unless something after it settles it: a canonical session pass of the same
  // check (the same command and scope, whatever harmless flags) settles a canonical session failure;
  // a passing ship-check run with a step of every kind settles only an earlier ship-check failure.
  // A lint pass never settles a failed typecheck; a pass of part of a suite never settles anything.
  const shipCovers = (p, f) => f.failedKinds.every((k) => (k === 'check' ? p.kinds.includes('test') : p.kinds.includes(k)));
  const settles = (p, f) => p.ok && ((p.ship && f.ship && shipCovers(p, f)) || (p.canonical && !p.ship && f.canonical && !f.ship && p.id !== null && p.id === f.id));
  for (let i = 0; i < checks.length; i++) {
    const f = checks[i];
    if (!f.ok && f.canonical && !f.ship && checks.some((p, j) => j > i && p.ok && p.canonical && !p.ship && p.rid && p.rid === f.rid && p.id !== f.id)) f.canonical = false;
  }
  const standing = checks.filter((f, i) => !f.ok && counts(f) && !checks.some((p, j) => j > i && settles(p, f)));
  // The session's own failure, with a ship-check pass after it: the two disagree (an environment
  // difference, a flaky test). Not verified, never Contradicted, never Verified.
  for (const f of standing) if (f.canonical && !f.ship && checks.some((p) => p.ship && p.ok && Date.parse(p.at) >= Date.parse(f.at) && (p.kinds.includes(f.kind) || (f.kind === 'check' && p.kinds.includes('test'))))) f.canonical = false;
  // (A runner's glyph and timing are noise in a sentence: "✖ adds (0.44ms)" reads "adds".)
  const tidy = (line) => (line ? String(line).replace(/^[\u2716\u2718\u2717\u2715\u00d7]\s*/, '').replace(/\s*\(\d+(\.\d+)?\s*m?s\)\s*$/, '') || line : null);
  const strip = (x) => (x ? { cmd: oneLine(String(x.cmd || ''), 300), at: x.at, ok: x.ok, first_error_line: tidy(x.first_error_line), ...(x.ship ? { ship: true } : {}) } : null);
  const canonFail = standing.filter((x) => x.canonical).pop();
  if (canonFail) return { label: 'contradicted', check: strip(canonFail) };
  if (standing.length) return { label: 'not_verified', check: strip(standing[standing.length - 1]), unclear: true };
  const passes = checks.filter((x) => x.ok && counts(x));
  const enough = needs ? needs.every((n) => passes.some((x) => (x.ship ? x.kinds.includes(n) : x.kind === n))) : passes.length > 0;
  if (enough) return { label: 'verified', check: strip(passes[passes.length - 1]) };
  return { label: 'not_verified', check: null };
}

// Flags that change nothing about what a run covers: a run with only these is still the whole check.
// Long flags with one meaning everywhere; short flags only for the runners where they mean what we
// think (-v is verbose for pytest and go, but prints the version for npm, jest, tsc and eslint; -q
// and -i are question mode and ignore-errors for make).
const HARMLESS = /^(--quiet|--verbose|--ci|--color|--colors|--no-color|--no-colors|--color=\w+|--silent|--runInBand|--no-cache|--tb=\w+|--reporter=\S+|--maxWorkers=\d+%?|--exitfirst|--no-header|--durations=\d+|--race|--noEmit|--pretty|--pretty=\w+|--max-warnings=\d+|--format=\w+|--no-fund|--no-audit|--locked|--frozen|--offline|--no-watch|--watch=false|--run|--coverage|--cov|--cov-report=\S+|--forceExit|--detectOpenHandles)$/;
const SHORT_HARMLESS = {
  pytest: ['-q', '-qq', '-v', '-vv', '-vvv', '-s', '-x', '-rA', '-ra'],
  go: ['-v', '-race', '-count=1', '-x'],
  cargo: ['-q', '-v', '-vv'],
  jest: ['-i'],
  ruff: ['-q', '-v'],
  mypy: ['-q', '-v'],
  flake8: ['-q', '-v'],
  pylint: ['-q', '-v'],
  tox: ['-q', '-v'],
  swift: ['-v'],
  npm: ['-s'],
  pnpm: ['-s'],
  yarn: ['-s'],
};
// Where `.` means the whole project, and where --all means every member (cargo's workspace).
const WHOLE_DOT = new Set(['pytest', 'py.test', 'eslint', 'ruff', 'biome', 'stylelint', 'mypy', 'flake8', 'pylint', 'black', 'isort', 'prettier', 'oxlint', 'xo', 'standard']);
const SCOPE_RUNNERS = new Set(['cargo']);
/** A package script other than the main `test` (`npm run test:unit`, `pnpm e2e`). */
function subScript(a) {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(a[0])) return false;
  const script = a[1] === 'run' || a[1] === 'run-script' ? a[2] : a[1];
  return !!script && !['test', 't', 'tst'].includes(script) && !script.startsWith('-');
}
// Flags that change what a run covers (`cargo test --workspace`): part of the check's identity.
const SCOPE_FLAG = /^(--workspace|--all|--all-targets|--all-features|-p|--package(=.*)?|--recursive|-r)$/;
// Steps before the command that run no check: `cd app &&`, `export CI=1 &&`, `NODE_ENV=test`.
const SETUP_STEP = (w) => w[0] === 'cd' || w[0] === 'pushd' || w[0] === 'export' || (w.length > 0 && w.every((y) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(y)));

/**
 * Is this shell line a canonical run of a check? One command (after optional `cd x &&` style setup
 * steps; a trailing `2>&1` is fine): an approved or detected command exactly, or a standard runner
 * (npm test, pytest, go test ./..., cargo test, eslint ., tsc --noEmit...), with only harmless extra
 * flags. Returns {kind, id, setupFirst} or null.
 */
export function canonical(cmd, { approved = [], detected = [] } = {}) {
  const segs = segments(cmd);
  let i = 0;
  const dirs = [];
  while (i < segs.length - 1 && segs[i].op === '&&' && SETUP_STEP(words(segs[i].raw))) {
    const sw = words(segs[i].raw);
    if (sw[0] === 'cd' || sw[0] === 'pushd') dirs.push(sw.slice(1).join(' ') || '~');
    i++;
  }
  const last = segs.length - 1;
  if (i !== last && !(i === last - 1 && segs[i].op === ';' && !segs[last].raw.trim())) return null;
  if (segs[i].op && segs[i].op !== ';') return null;
  const raw = segs[i].raw.replace(/\s+2>&1\s*$/, '').trim();
  if (/[<>|&]/.test(raw.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ''))) return null;
  const w = words(raw);
  if (!w.length || runsNothing(w)) return null;
  // Its identity: where it ran (`cd packages/api &&`), what it is, and any scope flag it carried.
  // A second key, the runner with every wrapper removed: `pytest`, `python3 -m pytest` and
  // `uv run pytest` are one runner. A pass under another spelling cannot settle a failure, but it
  // means the failure may have been the spelling's (a missing venv), not the code's.
  const scope = (extra) => extra.filter((x, j) => SCOPE_FLAG.test(x) || ((extra[j - 1] === '-p' || extra[j - 1] === '--package') && !x.startsWith('-'))).map((x) => (x === '--all' ? '--workspace' : x));
  const rkey = (what, extra) => [dirs.length ? `in ${dirs.join('/')}` : null, (unwrap(words(String(what))) || []).join(' '), ...scope(extra)].filter(Boolean).join(' ');
  const bare = (what) => normId(what).split(' ').filter((x) => x !== '--' && !HARMLESS.test(x) && !Object.values(SHORT_HARMLESS).some((l) => l.includes(x))).join(' ');
  const ident = (what, extra) => [dirs.length ? `in ${dirs.join('/')}` : null, bare(what), ...extra.filter((x, j) => SCOPE_FLAG.test(x) || ((extra[j - 1] === '-p' || extra[j - 1] === '--package') && !x.startsWith('-'))).map((x) => (x === '--all' ? '--workspace' : x))].filter(Boolean).join(' ');
  // Only variables known not to change what runs (`CI=1`, `NO_COLOR=1`); any other (`PYTEST_ADDOPTS`,
  // `GOFLAGS`, `TEST=...` for rake, `TESTS=...` for make) may select tests: not the whole run.
  for (const v of assignedVars(cmd)) if (!SAFE_VARS.has(v)) return null;
  const harmlessFor = (runner) => (extra) => extra.every((x, j) => HARMLESS.test(x) || (SHORT_HARMLESS[runner] || []).includes(x) || (SCOPE_FLAG.test(x) && (SCOPE_RUNNERS.has(runner) || x !== '--all')) || x === '--' || (WHOLE_DOT.has(runner) && (x === '.' || x === './')) || (runner === 'go' && x === './...') || (j > 0 && (extra[j - 1] === '-p' || extra[j - 1] === '--package') && !x.startsWith('-')));
  const runnerOf = (b) => (unwrap(b) || b)[0];
  for (const ap of approved) {
    if (!ap || typeof ap.run !== 'string') continue;
    const b = words(ap.run.trim());
    if (b.length && w.length >= b.length && b.every((x, j) => w[j] === x) && harmlessFor(runnerOf(b))(w.slice(b.length))) return { kind: NAME_KIND[String(ap.name || '').toLowerCase()] || wordsKind(b) || 'check', id: ident(ap.run.trim(), w.slice(b.length)), rid: rkey(ap.run.trim(), w.slice(b.length)), setupFirst: i > 0 };
  }
  for (const d of detected) {
    if (!d || typeof d.cmd !== 'string') continue;
    const b = words(d.cmd.trim());
    const kind = d.kind === 'test' ? 'test' : d.kind === 'build' ? 'build' : d.kind === 'lint' || d.kind === 'typecheck' ? 'lint' : d.kind === 'check' ? 'check' : null;
    if (kind && !(kind === 'test' && subScript(unwrap(b) || b)) && b.length && w.length >= b.length && b.every((x, j) => w[j] === x) && harmlessFor(runnerOf(b))(w.slice(b.length))) return { kind, id: ident(d.cmd.trim(), w.slice(b.length)), rid: rkey(d.cmd.trim(), w.slice(b.length)), setupFirst: i > 0 };
  }
  const kind = wordsKind(w);
  const a = unwrap(w);
  if (!kind || !a) return null;
  const n = runnerWords(a);
  const extra = a.slice(n);
  // Bare `make` runs the default goal (sometimes `help`): not a check by itself. For a task runner,
  // only `test`, `tests` and `check` are the whole suite (`make test-unit` is a named part).
  if (['make', 'gmake', 'just'].includes(a[0]) && n === 1) return null;
  if (kind === 'test' && ['make', 'gmake', 'just', 'task', 'mage'].includes(a[0]) && !['test', 'tests', 'check'].includes(a[1])) return null;
  // node: every flag can select (`node --test-name-pattern=cart --test`).
  if (a[0] === 'node' && a.slice(1).some((x) => x !== '--test' && !HARMLESS.test(x))) return null;
  // A sub-script (`npm run test:unit`, `npm run lint:css`, `npm run build:docs`) is a named part of
  // the check: a selection (unless approved or detected, above).
  if (subScript(a) && !/^(lint|build|typecheck|type-check|types|check|tsc)$/.test(a[1] === 'run' || a[1] === 'run-script' ? a[2] : a[1])) return null;
  // go test/vet/build: only ./... is the whole module (`go test` alone tests one package).
  if (a[0] === 'go' && !extra.includes('./...')) return null;
  if (!harmlessFor(a[0])(extra)) return null;
  // (The id from the words as typed, past only harmless wrappers: `python3.11 -m pytest` keeps its interpreter.)
  return { kind, id: ident(w.slice(0, w.length - extra.length).join(' '), extra), rid: rkey(a.slice(0, n).join(' '), extra), setupFirst: i > 0 };
}

const SAFE_VARS = new Set(['CI', 'FORCE_COLOR', 'NO_COLOR', 'TERM', 'NODE_ENV', 'RUST_BACKTRACE', 'CARGO_TERM_COLOR', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'LANG', 'LC_ALL', 'TZ', 'COLUMNS', 'NPM_CONFIG_COLOR', 'npm_config_color']);
/** The variables a line sets: `X=1 cmd`, `export X=1`, `env X=1`, `cross-env X=1`. */
function assignedVars(cmd) {
  const out = [];
  for (const sg of segments(String(cmd))) {
    const toks = sg.raw.trim().split(/\s+/);
    let j = 0;
    if (['export', 'env', 'cross-env'].includes(toks[0])) j = 1;
    for (; j < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[j]); j++) out.push(toks[j].split('=')[0]);
    // `timeout 60 env X=1 ...`: assignments after a wrapper too.
    const e = toks.indexOf('env');
    if (e > 0) for (let k = e + 1; k < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[k]); k++) out.push(toks[k].split('=')[0]);
  }
  return out;
}

/** One spelling for one check: past wrappers, `npm t` and `npm run test` are `npm test`. */
function normId(cmd) {
  let a = words(String(cmd));
  // Only wrappers that do not change what runs are dropped; `./api/test.sh` keeps its folder and
  // `python3.11 -m pytest` its interpreter.
  for (let n = 0; n < 4 && a.length; n++) {
    const h = a[0];
    if (['time', 'command', 'exec', 'nice', 'nohup', 'xvfb-run', 'npx', 'bunx'].includes(h)) a = a.slice(1).filter((x, i) => !(i === 0 && x.startsWith('-')));
    else if ((h === 'timeout' || h === 'gtimeout') && a.length > 2) a = a.slice(1).filter((x, i, arr) => !(arr.slice(0, i + 1).every((y) => /^-|^\d+[smhd]?$/.test(y))));
    else if (h === 'env' || h === 'cross-env') a = a.slice(1).filter((x, i, arr) => !(arr.slice(0, i + 1).every((y) => /=/.test(y))));
    else if ((h === 'npm' || h === 'pnpm' || h === 'yarn') && (a[1] === 'exec' || a[1] === 'dlx')) a = a.slice(2).filter((x) => x !== '--');
    else break;
  }
  // npm's own aliases (not bun's: `bun run test` is the script, `bun test` Bun's runner).
  if (['npm', 'pnpm', 'yarn'].includes(a[0]) && (a[1] === 't' || a[1] === 'tst' || ((a[1] === 'run' || a[1] === 'run-script') && a[2] === 'test'))) a = [a[0], 'test', ...a.slice(a[1] === 't' || a[1] === 'tst' ? 2 : 3)];
  return a.join(' ');
}

// Programs that do not change files (with no output redirection: writesFiles decides that first).
const SAFE_PROGRAMS = new Set(['cd', 'pushd', 'popd', 'pwd', 'echo', 'printf', 'true', 'false', ':', 'sleep', 'wait', 'which', 'type', 'printenv', 'ps', 'jobs', 'kill', 'pkill', 'pgrep', 'lsof', 'uptime', 'id', 'hostname', 'uname', 'export', 'unset', 'set', 'alias', 'clear', 'tput', 'date', 'whoami', 'ls', 'cat', 'grep', 'rg', 'find', 'head', 'tail', 'wc', 'file', 'stat', 'tree', 'du', 'df', 'less', 'more', 'diff', 'sort', 'uniq', 'cut', 'tr', 'awk', 'jq', 'column', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'seq', 'nl', 'od', 'xxd', 'md5', 'md5sum', 'shasum', 'sha256sum']);
const GIT_SAFE = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'remote', 'describe', 'blame', 'add', 'commit', 'push', 'fetch', 'tag', 'grep', 'shortlog', 'reflog', 'config']);
/**
 * Is this shell line known to leave files alone? Read-only programs, git's look/record commands,
 * recognized checks run without a fixing flag. Anything else may have changed the work.
 */
export function knownSafe(cmd, { approved = [], detected = [], commitHooks = false } = {}) {
  if (writesFiles(cmd).writes) return false;
  for (const sg of segments(String(cmd))) {
    const w = words(sg.raw);
    if (!w.length) continue;
    const u = unwrap(w);
    if (!u) continue; // command -v: only looks a program up
    const h = u[0].replace(/^.*[\\/]/, '');
    // (git commit runs the repo's pre-commit hooks, which may fix files: safe only without hooks, or
    // with --no-verify.)
    if (h === 'git' && u[1] === 'commit' && commitHooks && !u.includes('--no-verify') && !u.includes('-n')) return false;
    if (h === 'git' && GIT_SAFE.has(u[1]) && !(u[1] === 'config' && u.length > 3) && !(u[1] === 'branch' && u.some((x) => /^-[dDmM]$/.test(x)))) continue;
    // Tools that only report (or act elsewhere, never on the files here).
    if (h === 'gh' && !/^(checkout|clone|download|install|extension)$/.test(u[2] || '') && u[1] !== 'repo' ? true : h === 'gh' && u[1] === 'repo' && /^(view|list)$/.test(u[2] || '')) continue;
    if (['npm', 'pnpm', 'yarn'].includes(h) && /^(view|info|ls|list|outdated|whoami|explain|why|search|help|audit)$/.test(u[1] || '') && !u.includes('fix')) continue;
    if (['pip', 'pip3', 'uv'].includes(h) && /^(list|show|freeze|check)$/.test(u[1] === 'pip' ? u[2] || '' : u[1] || '')) continue;
    if (h === 'docker' && /^(ps|logs|images|inspect|version|info)$/.test(u[1] || '')) continue;
    if (h === 'brew' && /^(list|info|search|outdated)$/.test(u[1] || '')) continue;
    if (h === 'curl' && !u.some((x) => /^(-o|-O|--output|--remote-name|-D|--dump-header)$/.test(x) || /^-[a-zA-Z]*[oO]/.test(x))) continue;
    if (h === 'find' && !u.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint)/.test(x))) continue;
    if (SAFE_PROGRAMS.has(h) && h !== 'find') continue;
    // `--version` or `-h` alone: only looks (on an arbitrary script, `--version 1.4.0` may write).
    if (runsNothing(w) && (w.length === 2 || checkOf(sg.raw, { approved, detected }))) continue;
    // A check is safe only when nothing says it fixes: its name (`lint:fix`, `make lint-fix`), its
    // flags (`ktlint -F`, `swiftlint autocorrect`), or its detected script (`"lint": "eslint . --fix"`).
    const fixes = u.some((x) => /(^|[:_-])(fix|autofix|format|fmt|write|autocorrect)([:_-]|$)/i.test(x) || x === '-F' || /^--auto-?correct/.test(x)) || detected.some((d) => d && d.kind === 'format' && sg.raw.trim().startsWith(String(d.cmd || '\0')));
    if (!fixes && checkOf(sg.raw, { approved, detected })) continue;
    return false;
  }
  return true;
}

/** Is the command run behind timeout/gtimeout (past assignments and time/nice/env/cross-env)? */
function behindTimeout(cmd) {
  return segments(String(cmd)).some((sg) => {
    let w = sg.raw.trim().split(/\s+/);
    for (let n = 0; n < 6 && w.length; n++) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || ['time', 'nice', 'env', 'cross-env', 'command', 'exec'].includes(w[0])) w = w.slice(1);
      else break;
    }
    return w[0] === 'timeout' || w[0] === 'gtimeout';
  });
}

/** Every kind of check a shell line contains (a failure in it could be any of them). */
function lineKinds(cmd, { approved = [], detected = [] } = {}) {
  const kinds = new Set();
  for (const sg of segments(cmd)) {
    const k = checkOf(sg.raw, { approved, detected });
    if (k) kinds.add(k.kind);
  }
  return kinds.size ? [...kinds] : ['check'];
}

/** The one message "Ask the agent to fix it" sends, exactly as shown to the owner first. */
export function fixMessage(check) {
  const cmd = oneLine(String(check?.cmd || 'the check'), 200).replace(/`/g, "'");
  const line = oneLine(String(check?.first_error_line || 'it failed'), 200).replace(/`/g, "'");
  return `Your last check failed: \`${cmd}\` → \`${line}\`. Please fix it and re-run the check.`;
}

/** The words a badge shows, e.g. "Verified: `npm test` passed at 14:02, after the last edit". */
/** "14:02", or "Oct 3, 14:02" when it is not today: a month-old pass never reads like today's. */
export function whenText(iso, now = Date.now()) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
}

export function badgeText(l, { time = (iso) => whenText(iso) } = {}) {
  if (!l) return '';
  if (l.label === 'verified') return `Verified: \`${l.check.cmd}\` passed at ${time(l.check.at)}, after the last edit${l.check.ship ? ' (ship check)' : ''}`;
  if (l.label === 'contradicted') return `Contradicted: \`${l.check.cmd}\` failed at ${time(l.check.at)}${l.check.first_error_line ? `: ${l.check.first_error_line}` : ''}`;
  if (l.label === 'no_changes') return 'No changes made';
  if (l.unclear && l.check && l.check.ship) return `Not verified: the ship check at ${time(l.check.at)} failed in the scratch copy (\`${l.check.cmd}\`${l.check.first_error_line ? `: ${l.check.first_error_line}` : ''})`;
  if (l.unclear && l.check) return `Not verified: \`${l.check.cmd}\` at ${time(l.check.at)} showed a failure that cannot be tied to this claim`;
  if (l.unclear) return 'Not verified: a check after the last edit showed a failure that cannot be tied to this claim';
  return 'Not verified: no check ran after the last edit';
}
