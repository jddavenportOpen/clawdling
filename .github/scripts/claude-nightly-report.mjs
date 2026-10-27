#!/usr/bin/env node
// The last step of .github/workflows/claude-nightly.yml: read each OS's `doctor --contract --json`,
// then either open a pull request that bumps maxChecked in server/claude-compat.json (every check
// passed on a version newer than maxChecked), or open (or comment on) an issue titled
// "Claude Code <version> breaks <check>". Runs `git` and `gh` only, never through a shell; every
// value it passes on comes from the workflow's own outputs (the version is checked to be x.y.z).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { VERSION, CHECKED, RESULT, BASE, RUN_URL } = process.env;
const COMPAT = 'server/claude-compat.json';
const WORDS = {
  version: 'the version range', flags: 'flags', hidden_flags: 'hidden flags', hook_events: 'hook events',
  transcript: 'the transcript format', print_flags: 'check-up flags',
};
const DRY = /^guard-dryrun\//.test(BASE || '');

if (!/^\d+\.\d+\.\d+$/.test(VERSION || '')) throw new Error(`not a version: ${VERSION}`);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();
const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

/** {os: {ok, lines}} from results/contract-<os>/contract-<os>.json. */
function results() {
  const out = {};
  const root = 'results';
  if (!fs.existsSync(root)) return out;
  for (const d of fs.readdirSync(root)) {
    const m = /^contract-(\w+)$/.exec(d);
    if (!m) continue;
    try {
      out[m[1]] = JSON.parse(fs.readFileSync(path.join(root, d, `${d}.json`), 'utf8'));
    } catch (err) {
      out[m[1]] = { ok: false, lines: [], error: `no readable result (${err.message})` };
    }
  }
  return out;
}

const r = results();
const oses = Object.keys(r);
const allOk = RESULT === 'success' && oses.length === 3 && oses.every((o) => r[o].ok === true);

if (allOk) {
  if (cmp(VERSION, CHECKED) <= 0) {
    console.log(`Claude Code ${VERSION} passes; maxChecked is already ${CHECKED}: nothing to bump.`);
    process.exit(0);
  }
  const branch = `claude-compat/${VERSION}`;
  if (sh('git', ['ls-remote', '--heads', 'origin', branch])) {
    console.log(`${branch} is already proposed.`);
    process.exit(0);
  }
  const j = JSON.parse(fs.readFileSync(COMPAT, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  j.maxChecked = VERSION;
  j.checkedAt = today;
  j.history = [...(Array.isArray(j.history) ? j.history : []), { version: VERSION, checkedAt: today, ok: true, by: 'claude-nightly' }].slice(-30);
  fs.writeFileSync(COMPAT, `${JSON.stringify(j, null, 2)}\n`);
  sh('git', ['config', 'user.name', 'github-actions[bot]']);
  sh('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  sh('git', ['checkout', '-b', branch]);
  sh('git', ['commit', '-am', `Claude Code ${VERSION}: checked, bump maxChecked\n\nclawdling doctor --contract passed on ${oses.sort().join(', ')}: ${RUN_URL}`]);
  sh('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const lines = (r.Linux && r.Linux.lines) || [];
  const body = [
    `\`clawdling doctor --contract\` passed with Claude Code ${VERSION} on ${oses.sort().join(', ')} (no model call). This moves \`maxChecked\` from ${CHECKED} to ${VERSION}, so the cockpit stops saying this version is newer than the last one checked.`,
    '',
    ...lines.map((l) => `- ${l.status}: ${l.text}`),
    '',
    `Run: ${RUN_URL}`,
    'Opened with the workflow\'s own token, so other workflows do not run on it: the run above is its check.',
  ].join('\n');
  const url = sh('gh', ['pr', 'create', '--base', BASE, '--head', branch, '--title', `${DRY ? '[dry run] ' : ''}Claude Code ${VERSION}: checked, bump maxChecked`, '--body', body]);
  console.log(`Opened ${url}`);
  // At most one bump open at a time: an older one is superseded by this one.
  const open = JSON.parse(sh('gh', ['pr', 'list', '--state', 'open', '--json', 'number,headRefName', '--limit', '50']));
  for (const p of open) {
    if (p.headRefName.startsWith('claude-compat/') && p.headRefName !== branch) {
      sh('gh', ['pr', 'close', String(p.number), '--delete-branch', '--comment', `Superseded by ${url} (Claude Code ${VERSION}).`]);
    }
  }
  process.exit(0);
}

// A failure: which checks broke, on which OS, in plain lines.
const failing = [];
for (const o of oses.sort()) {
  const res = r[o];
  if (res.error) failing.push({ os: o, id: 'run', text: res.error });
  for (const l of res.lines || []) if (l.status === 'fail') failing.push({ os: o, id: l.id, text: l.text });
}
const ids = [...new Set(failing.map((f) => f.id).filter((id) => WORDS[id]))];
const what = ids.length ? ids.map((id) => WORDS[id]).join(', ') : 'the contract checks';
const title = `${DRY ? '[dry run] ' : ''}Claude Code ${VERSION} breaks ${what}`;
const body = [
  `The nightly update guard ran \`clawdling doctor --contract\` against Claude Code ${VERSION} (the last version checked is ${CHECKED}).`,
  '',
  ...(failing.length ? failing.map((f) => `- **${f.os}** (${f.id}): ${f.text}`) : [`- The run did not finish on every OS (${oses.length ? oses.join(', ') : 'no results'}): see the log.`]),
  '',
  `Run: ${RUN_URL}`,
].join('\n');
const existing = JSON.parse(sh('gh', ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '100'])).find((i) => i.title === title);
if (existing) {
  sh('gh', ['issue', 'comment', String(existing.number), '--body', `Still failing.\n\n${body}`]);
  console.log(`Commented on #${existing.number}: ${title}`);
} else {
  const url = sh('gh', ['issue', 'create', '--title', title, '--body', body]);
  console.log(`Opened ${url}: ${title}`);
}
process.exit(1);
