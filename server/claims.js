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
const MAKE_KIND = { test: 'test', tests: 'test', check: 'test', unittest: 'test', spec: 'test', e2e: 'test', build: 'build', all: 'build', compile: 'build', lint: 'lint', vet: 'lint', typecheck: 'lint', fmt: 'lint', 'fmt-check': 'lint', format: 'lint', ci: 'check', verify: 'check' };

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
    if (h === 'time' || h === 'command' || h === 'exec' || h === 'nice' || h === 'nohup') a = a.slice(1);
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
  if (['dotnet', 'swift', 'mix', 'flutter', 'dart', 'bazel', 'buck2', 'zig'].includes(h)) return b === 'test' ? 'test' : b === 'build' ? 'build' : b === 'analyze' || b === 'format' ? 'lint' : null;
  if (h === 'rake' && (b === 'test' || b === 'spec')) return 'test';
  if (h === 'composer' && b === 'test') return 'test';
  return null;
}

const NO_RUN = /^(--version|-V|--help|-h|--collect-only|--co|--list|--list-.*|--listTests|--list-tests|--showConfig|--dry-run|--no-run|--print-config)$/;
// `-n` is a dry run only for these (`pytest -n auto` is pytest-xdist's worker count, a real run).
const DRY_N = new Set(['make', 'gmake', 'just', 'go']);
const runsNothing = (w) => {
  const a = unwrap(w) || w; // `time make -n test`, `/usr/bin/make -n` are make
  return w.some((x) => NO_RUN.test(x)) || (DRY_N.has(a[0]) && a.some((x) => x === '-n' || x === '--just-print' || x === '--recon'));
};
/** The approved command itself, or it with extra flags (`npm test -- --ci`), never another script. */
const TEST_SELECT = /^(-k|-t|-g|-m|--grep(=.*)?|--testNamePattern(=.*)?|--test-name-pattern(=.*)?|--testPathPattern(=.*)?|--test-path-pattern(=.*)?|--filter(=.*)?|--only|-run=(?!['"]?\^\$).*|--test-only)$/;
// Extra flags that turn a test run into one that runs none (`mvn test -DskipTests`, `go test ./... -run=^$`).
const SKIP_EXTRA = /^(-DskipTests(=true)?|-Dmaven\.test\.skip(=true)?|-run=['"]?\^\$['"]?|-list(=.*)?|-N|--show-only(=.*)?|-x|--passWithNoTests)$/;
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
    const trimmed = s.raw.trim();
    for (const ap of approved) {
      if (!ap || typeof ap.run !== 'string') continue;
      if (sameOrFlags(trimmed, ap.run)) {
        kind = NAME_KIND[String(ap.name || '').toLowerCase()] || wordsKind(words(ap.run)) || 'check';
        break;
      }
    }
    if (!kind) {
      for (const d of detected) {
        if (d && typeof d.cmd === 'string' && sameOrFlags(trimmed, d.cmd)) {
          kind = d.kind === 'test' ? 'test' : d.kind === 'build' ? 'build' : d.kind === 'lint' || d.kind === 'typecheck' || d.kind === 'format' ? 'lint' : d.kind === 'check' ? 'check' : null;
          if (kind) break;
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
    const masked = ops.some((op, j) => (op === '|' && !pipefail) || op === '||' || op === '&' || (op === ';' && (!errexit || ops.slice(0, j).some((o) => o === '&&' || o === '||'))));
    // Other commands ran before it in the line: failure marks in the output may be theirs.
    const preceded = segs.slice(0, i).some((sg) => !trivial(words(sg.raw)));
    // Piped into a program that keeps only some lines: the failure (or the totals) can be cut off.
    let cut = false;
    for (let j = i; j < segs.length - 1 && segs[j].op === '|'; j++) {
      if (/^(head|grep|egrep|fgrep|rg|sed|awk|cut|less|more|jq|perl|python[\d.]*|node)$/.test((unwrap(words(segs[j + 1].raw)) || [''])[0])) cut = true;
    }
    // A later part of the line that can print (after ;, || or &&) could supply a pass of its own.
    const quiet = (w2) => !w2.length || ['true', ':', 'false', 'exit', 'return'].includes(w2[0]) || w2.every((y) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(y));
    const later = rest.slice(0, -1).some((x, j) => (x.op === ';' || x.op === '||' || x.op === '&&') && rest[j + 1] && !quiet(words(rest[j + 1].raw)));
    // Only some tests selected (`pytest -k cart`, `jest -t adds`, `go test -run TestCart`): a pass
    // says nothing about the rest, a failure still counts.
    const partial = kind === 'test' && (unwrap(w) || w).some((x, j, arr) => TEST_SELECT.test(x) || (x === '-run' && !/^['"]?\^\$['"]?$/.test(arr[j + 1] || '')));
    found = { kind, masked, chained: !masked && meaningful > 1, preceded, cut, later, partial, cmd: trimmed };
    if (!masked) break; // an unmasked check decides
  }
  return found;
}

// A shell command that changes files counts as an edit ("the agent's last file change"): an output
// redirection to a file, or a program that writes (sed -i, mv, a formatter with --write, git apply...).
const WRITE_PROGRAMS = new Set(['mv', 'cp', 'rm', 'rmdir', 'touch', 'mkdir', 'ln', 'truncate', 'patch', 'rsync', 'install', 'unzip', 'tar']);
const GIT_WRITES = new Set(['apply', 'checkout', 'restore', 'reset', 'merge', 'rebase', 'cherry-pick', 'pull', 'am', 'mv', 'rm', 'revert', 'switch']);
const PKG_WRITES = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'version', 'dedupe', 'prune']);

function segmentWrites(raw) {
  // A redirection to a file (not 2>&1, not /dev/null), outside quotes.
  const bare = raw.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  for (const m of bare.matchAll(/(?:^|[^<>&\d])\d?>>?\s*([^\s&|;<>]+)/g)) {
    const target = m[1];
    if (!target.startsWith('&') && !/^\/dev\//.test(target) && target !== '""') return true;
  }
  let w = words(raw);
  if (w[0] === 'sudo' || w[0] === 'command' || w[0] === 'time' || w[0] === 'env') w = w.slice(1).filter((x) => !/^[A-Za-z_]\w*=/.test(x));
  if (w[0] === 'npx' || w[0] === 'bunx') w = w.slice(1);
  const [h, b] = [String(w[0] || '').replace(/^.*[\\/]/, ''), w[1]];
  if (WRITE_PROGRAMS.has(h)) return true;
  if ((h === 'sed' || h === 'perl') && w.some((x) => /^-[a-z]*i/.test(x) || x.startsWith('--in-place'))) return true;
  if (h === 'tee' && w.slice(1).some((x) => !x.startsWith('-'))) return true;
  if (h === 'git' && GIT_WRITES.has(b) || (h === 'git' && b === 'stash' && /^(pop|apply)$/.test(w[2] || ''))) return true;
  if ((h === 'npm' || h === 'pnpm' || h === 'yarn' || h === 'bun') && PKG_WRITES.has(b)) return true;
  if (h === 'prettier' && w.some((x) => x === '--write' || x === '-w')) return true;
  if ((h === 'eslint' || h === 'ruff' || h === 'biome' || h === 'stylelint') && w.some((x) => x === '--fix' || x === '--write' || x === '--apply')) return true;
  if (h === 'ruff' && b === 'format' && !w.includes('--check')) return true;
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
  const d = key(path.resolve(dir));
  const f = key(path.resolve(String(file)));
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** Is this tool call a change to the work (an edit), for "after the last edit"? `roots`: where it counts. */
export function isWorkEdit(t, roots) {
  if (t.end === null || t.end === undefined) return false;
  // A shell command that writes and then fails (`sed -i ... && npm test`) still changed the files: for
  // shell tools an error is a non-zero exit, not "nothing was written". Only a call that never ran
  // (declined, blocked) changed nothing.
  if (SHELL_TOOLS.has(t.name) && typeof t.cmd === 'string' && !t.bg) return !(t.res && (t.res.denied || t.res.blocked)) && writesFiles(t.cmd).writes;
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
const failMark = (t) => FAIL_UPPER.test(t) || FAIL_COUNT.test(t);
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
    pass: PASS_MARK.test(tail) && !failMark(tail),
    summary: PASS_SUMMARY.test(tail) && !failMark(tail),
  };
}

// -------------------------------------------------------------------------------------- evidence

const CLAIMS_MAX = 50;
const SHIP_WINDOW_MS = 24 * 3600 * 1000;
const CMDS_PER_CLAIM = 30;

/**
 * The evidence for every claim in one transcript (main file plus subagents), compact enough for a
 * receipt: for each final message that makes a claim, when it was said, the last file change
 * before it, and the shell commands that ran between that change and the claim (with what their
 * results said). Labels are given later (labelClaim), when the project's approved checks and its
 * ship checks are known.
 */
export function claimEvidence({ main, subs = [] }, { roots = null } = {}) {
  // Where a change counts: the session's folder, plus a group project agent's repos (--add-dir).
  const where = (roots && roots.length ? roots : [main.cwd]).filter(Boolean);
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
    for (const x of before) {
      if (isWorkEdit(x.t, where)) {
        lastEdit = x;
        edits++;
        editsEnd = Math.max(editsEnd, x.t.end ?? x.t.ts);
      }
    }
    // A command that writes and then runs a check (`... > f && npm test`) is the edit and, just after
    // it, the check.
    // The session's first change after the claim ends the time a ship check can speak for it.
    const nextEdit = all.find((x) => cmp(x.key, at) > 0 && isWorkEdit(x.t, where));
    const otherEditsEnd = before.filter((x) => x !== lastEdit && isWorkEdit(x.t, where)).reduce((m, x) => Math.max(m, x.t.end ?? x.t.ts), -Infinity);
    const selfChecked = lastEdit && SHELL_TOOLS.has(lastEdit.t.name) && writesFiles(lastEdit.t.cmd).checkAfter && lastEdit.t.ts >= otherEditsEnd;
    const after = before.filter((x) => (!lastEdit || (cmp(x.key, lastEdit.key) > 0 && x.t.ts >= editsEnd) || (selfChecked && x === lastEdit)) && SHELL_TOOLS.has(x.t.name) && typeof x.t.cmd === 'string' && x.t.end !== null && !x.t.bg && x.t.res && !x.t.res.denied && !x.t.res.blocked);
    const cmds = after.slice(-CMDS_PER_CLAIM).map(({ t }) => ({
      cmd: t.cmd,
      at: new Date(t.end ?? t.ts).toISOString(),
      error: t.error === true,
      exit: t.res.exit,
      err1: t.res.err1,
      fail: t.res.fail,
      pass: t.res.pass,
      summary: t.res.summary,
      ...(t.cmdCut ? { cut: true } : {}),
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
    });
  }
  return out.slice(-CLAIMS_MAX);
}

/** A command's outcome as a check: true (passed), false (failed) or null (cannot tell: not counted). */
function outcome(c, masked, chained = false, preceded = false, cut = false, later = false) {
  const failed = !(c.error !== true && (c.exit === 0 || c.exit === null) ? !c.fail || c.exit === 0 : false);
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
export function labelClaim(c, { approved = [], detected = [], shipRuns = [] } = {}) {
  if (!c || typeof c !== 'object') return { label: 'not_verified', check: null };
  if (c.kind === 'completion' && !(c.edits > 0)) return { label: 'no_changes', check: null };
  const since = c.last_edit_at ? Date.parse(c.last_edit_at) : -Infinity;
  const said = Date.parse(c.at || '') || 0;
  // A ship check speaks for this claim only soon after it (24 h) and before the session changed
  // anything again (`until`, the next claim's last edit): one check never relabels a week.
  const shipFrom = Math.max(since, said - 60000);
  const shipTo = Math.min(said + SHIP_WINDOW_MS, c.until ? Date.parse(c.until) : Infinity);
  const checks = [];
  for (const x of Array.isArray(c.cmds) ? c.cmds : []) {
    if (x.cut) continue; // only its first 1,000 characters were kept: the rest could hide its exit
    const k = checkOf(x.cmd, { approved, detected });
    if (!k) continue;
    let ok = outcome(x, k.masked, k.chained, k.preceded, k.cut, k.later);
    if (ok === true && k.partial) ok = null;
    if (ok === null) continue;
    checks.push({ kind: k.kind, cmd: x.cmd, at: x.at, ok, first_error_line: ok ? null : x.err1 || (x.exit ? `Exit code ${x.exit}` : null) });
  }
  for (const r of Array.isArray(shipRuns) ? shipRuns : []) {
    const t = Date.parse(r.at || r.started_at || '');
    if (!Number.isFinite(t) || !(t > shipFrom) || !(t < shipTo)) continue;
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
    // The latest check of each kind decides: a failed test is not cancelled by a lint that passed
    // after it (nor a failed ship-check step by a later step of the same run).
    const l = latest(() => true);
    if (!l) return { label: 'not_verified', check: null };
    const kinds = [...new Set(checks.map((x) => x.kind))];
    const bad = kinds.map((k) => latest((x) => x.kind === k)).filter((x) => !x.ok).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).pop();
    if (bad) return { label: 'contradicted', check: strip(bad) };
    return { label: 'verified', check: strip(l) };
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
  return 'Not verified: no check ran after the last edit';
}
