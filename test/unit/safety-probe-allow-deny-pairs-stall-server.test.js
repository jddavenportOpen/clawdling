// A permanent regression test: the stand-in adversarial review (1.8, round 2) wrote it as a probe.
// Stand-in review r2, MEDIUM-1: a cloned repo's own settings stall the cockpit server again, through
// the allow x deny comparison (not the chip de-duplication round 1 fixed).
//
// capsFor() (server/safety.js) keeps an allow rule only after `deny.find((dd) => denies(dd, x.parsed))`:
// every allow rule is compared with every deny rule, and denies() runs several regular expressions and
// string copies per pair. Round 1 raised RULE_MAX (discover.js) from 300 to 5,000 rules per list and
// GRANT_RULES_MAX to 5,000 per folder, so one repo can now bring
//   .claude/settings.json        5,000 allow + 5,000 deny
//   .claude/settings.local.json  5,000 allow + 5,000 deny   (a repo can commit it)
//   .claude/commands/*.md        5,000 allowed-tools rules
// = 15,000 allows x 10,000 denies = 1.5e8 denies() calls per capsFor, and capsFor runs twice per
// project agent (the cross-agent pass and finish()). runSafetyAudit is synchronous on the server's main
// thread for every GET /api/setup/safety (the org map fetches it on every load) and every report
// (reports.safetyInfo, which any agent reaches with `clawdling report`, allowed without a prompt).
// The files are about half a megabyte in total, far under every size limit.
//
// The audit runs in a worker so this probe can stop it. It FAILS while the audit of this one repo is
// still running after BUDGET_MS, and passes once the deny matching is indexed (deny rules grouped by tool,
// whole-tool denies and exact rules in Sets, prefix denies looked up by the allow's word-boundary
// prefixes) or the pairs are bounded and said as "unknown: review".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { after, test } from 'node:test';
import { runSafetyAudit } from '../../server/safety-run.js';

const MOD = new URL('../../server/safety-run.js', import.meta.url).href;
// The same generous bar as round 1's stall probe (the project's own bar: 200 agents well under 3 s).
const BUDGET_MS = 10000;
const N = 5000; // discover.js RULE_MAX (per list) and GRANT_RULES_MAX (per folder)

const temps = [];
after(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix) {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(d);
  return d;
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
  return file;
}
const list = (n, f) => Array.from({ length: n }, (_, i) => f(i));

function auditInWorker(args, budget, scratch) {
  return new Promise((resolve) => {
    const file = path.join(scratch, 'audit-worker.mjs');
    fs.writeFileSync(file, [
      "import { parentPort, workerData } from 'node:worker_threads';",
      `import { runSafetyAudit } from ${JSON.stringify(MOD)};`,
      'const t0 = Date.now();',
      'const audit = runSafetyAudit(workerData);',
      'parentPort.postMessage({ ms: Date.now() - t0, rows: audit.rows.length });',
      '',
    ].join('\n'));
    const w = new Worker(pathToFileURL(file), { workerData: args });
    let done = false;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.terminate().then(() => resolve(v), () => resolve(v));
    };
    timer = setTimeout(() => finish({ timedOut: true }), budget);
    w.on('message', finish);
    w.on('error', (e) => finish({ error: String((e && e.stack) || e) }));
    w.on('exit', (c) => finish({ error: `the worker exited (${c}) before answering` }));
  });
}

test(`one repo with ${N} allow and ${N} deny rules per settings file: the audit finishes within ${BUDGET_MS} ms`, async () => {
  const home = tmp('probe-r2-m1-');
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  const repo = path.join(home, 'code', 'app');
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const dir = path.join(org, 'projects', 'app');
  fs.mkdirSync(dir, { recursive: true });
  const args = {
    agents: [{ id: 'app', name: 'App', kind: 'project', dir, repo, permission_mode: null }],
    home: org,
    userHome: home,
    configDir: cfg,
    claudeJsonPath: path.join(home, '.claude.json'),
    env: {},
    managed: [],
    channels: {},
  };
  const projectFile = path.join(repo, '.claude', 'settings.json');
  const localFile = path.join(repo, '.claude', 'settings.local.json');

  // Precondition (fast on r18): the repo's allow AND deny rules are read and compared, so the fixture
  // means what it says. `Bash(curl a0:*)` is taken away by its identical deny; `Bash(curl a1:*)` stays.
  write(projectFile, { permissions: { allow: ['Bash(curl a0:*)', 'Bash(curl a1:*)'], deny: ['Bash(curl a0:*)', 'Bash(wget b0:*)'] } });
  const one = runSafetyAudit(args).rows.find((r) => r.id === 'app');
  assert.ok(one, 'precondition: the project row is there');
  assert.ok(one.chips.sends.some((x) => x.text.includes('Bash(curl a1:*)')), 'precondition: the repo allow rule is classified');
  assert.ok(!one.chips.sends.some((x) => x.text.includes('Bash(curl a0:*)')), 'precondition: the identical deny takes the allow away');
  assert.ok(one.notes.some((n) => n.includes('Bash(curl a0:*)')), 'precondition: the row says what the deny took');

  // The hostile repo: every list at the cap, no deny matching any allow (so every pair is compared).
  write(projectFile, { permissions: { allow: list(N, (i) => `Bash(curl a${i}:*)`), deny: list(N, (i) => `Bash(wget b${i}:*)`) } });
  write(localFile, { permissions: { allow: list(N, (i) => `Bash(curl c${i}:*)`), deny: list(N, (i) => `Bash(wget d${i}:*)`) } });
  for (let k = 0; k < 5; k++) {
    const rules = list(N / 5, (i) => `Bash(curl g${k}x${i}:*)`).join(' ');
    write(path.join(repo, '.claude', 'commands', `c${k}.md`), `---\ndescription: c${k}\nallowed-tools: ${rules}\n---\nDo it.\n`);
  }

  const res = await auditInWorker(args, BUDGET_MS, home);
  assert.ok(!res.error, `the audit threw: ${res.error}`);
  assert.ok(!res.timedOut, `the audit of ONE cloned repo (about half a megabyte of settings and commands) was still running after ${BUDGET_MS} ms (stopped by this probe). In the cockpit it runs on the server's main thread for every GET /api/setup/safety and every report: the server answers nothing else meanwhile.`);
});
