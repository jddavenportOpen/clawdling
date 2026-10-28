// A permanent regression test: the stand-in adversarial review (1.8, round 1) wrote it as a probe.
// Stand-in review r1, MEDIUM-3: a cloned repo can stall the cockpit server for minutes.
// GET /api/setup/safety (fetched by the org map on every cockpit load and every org change) and the
// report's safetyInfo run runSafetyAudit SYNCHRONOUSLY on the server's main thread. A repo's
// `.claude/agents/` may hold 500 subagent files (LIST_MAX), each with 300 `allowed-tools` rules
// (RULE_MAX): 150,000 allow layers' rules for the one project agent. capsFor() de-duplicates chips with
// `chips[cap].some(...)` keyed by (text, source), and every grant is its own source, so adding them is
// quadratic (about 1e10 comparisons per leg, per capsFor call, and capsFor runs twice per agent: the
// cross-agent pass and finish()). The 500 files here are hard links to one 5 KB file: the clone is tiny.
//
// The audit runs in a worker so this probe can stop it: it FAILS on r18 HEAD ca03e6d when the audit of
// this one repo is still running after BUDGET_MS, and passes once the work is bounded (a total budget of
// grant files or rules per folder, said as a cut, and an O(1) de-duplication), so one repo cannot hold
// the main thread.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { after, test } from 'node:test';
import { runSafetyAudit } from '../../server/safety-run.js';

const MOD = new URL('../../server/safety-run.js', import.meta.url).href;
// Generous on purpose (the project's own bar is "200 agents well under 3 seconds"): r18 needs minutes
// here (about 4.5e10 string comparisons), while a bounded, linear audit of these 150,000 rules takes a
// few seconds even without a rule budget.
const BUDGET_MS = 10000;
const FILES = 500; // discover.js LIST_MAX
const RULES = 300; // discover.js RULE_MAX

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
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  return file;
}

/** runSafetyAudit(args) in a worker: {ms} when it finishes, {timedOut: true} past `budget`, or {error}. */
function auditInWorker(args, budget, scratch) {
  return new Promise((resolve) => {
    // A tiny ES module worker, written into this probe's own temp folder.
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

test(`one repo with ${FILES} subagents x ${RULES} allowed-tools rules: the audit finishes within ${BUDGET_MS} ms`, async () => {
  const home = tmp('probe-m3-');
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
  // One 5 KB subagent file: 300 short, distinct, classified rules (`Bash(curl N:*)`: sends out, untrusted input).
  const rules = Array.from({ length: RULES }, (_, i) => `Bash(curl ${i}:*)`).join(' ');
  const proto = write(path.join(repo, 'proto.md'), `---\nname: helper\ndescription: helps\nallowed-tools: ${rules}\n---\nHelp.\n`);
  const agentsDir = path.join(repo, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const link = (i) => {
    const f = path.join(agentsDir, `a${i}.md`);
    try {
      fs.linkSync(proto, f);
    } catch {
      fs.copyFileSync(proto, f);
    }
  };

  // Precondition (fast on r18): one such file is read and classified, so the fixture means what it says.
  link(0);
  const one = runSafetyAudit(args).rows.find((r) => r.id === 'app');
  assert.ok(one.chips.sends.length >= RULES, `precondition: one subagent's rules are classified (${one.chips.sends.length} sends chips)`);
  assert.ok(one.risks.some((k) => k.id === 'repo_grants'), 'precondition: the repo grant is a risk');

  for (let i = 1; i < FILES; i++) link(i);
  const res = await auditInWorker(args, BUDGET_MS, home);
  assert.ok(!res.error, `the audit threw: ${res.error}`);
  assert.ok(!res.timedOut, `the audit of ONE cloned repo was still running after ${BUDGET_MS} ms (stopped by this probe). In the cockpit this runs on the server's main thread for every GET /api/setup/safety and every report: the server answers nothing else meanwhile.`);
});
