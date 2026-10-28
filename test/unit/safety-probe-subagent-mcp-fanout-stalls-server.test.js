// A permanent regression test: the stand-in adversarial review (1.8, round 2) wrote it as a probe.
// Stand-in review r2, MEDIUM-2: a cloned repo's subagents can define a quarter of a million inline MCP
// servers, and risksFor() de-duplicates their risks with a linear scan: the cockpit server hangs.
//
// toolGrants() (discover.js) keeps up to LIST_MAX (500) subagent files per folder, and subagentServers()
// keeps up to LIST_MAX (500) inline `mcpServers` entries PER FILE. A bare key line (`  s1:`) is a server
// (mcpFacts keeps every key), so one 4 KB file holds 500 of them, and no total budget applies across files
// (unlike allowed-tools rules, GRANT_RULES_MAX). auditSafety() turns them into 500 x 500 = 250,000 MCP
// entries on the repo's project agent:
//   - capsFor() classifies each one by name (about 160 word checks, each normalizing both strings) and,
//     as none is known, pushes 250,000 "unknown: review" items; it runs twice per project agent;
//   - risksFor() adds a `repo_mcp` risk per server through `risks.some(...)` (a linear scan), so the
//     de-duplication alone is about 3e10 comparisons. Round 1 fixed the same pattern for chips only.
// runSafetyAudit is synchronous on the server's main thread for every GET /api/setup/safety (the org map
// fetches it on every load) and every report (reports.safetyInfo; any agent runs `clawdling report`).
// The 500 files here are hard links to one 4 KB file: the clone is tiny.
//
// The audit runs in a worker so this probe can stop it. It FAILS while the audit of this one repo is
// still running after BUDGET_MS, and passes once the inline servers have a total budget per folder (said
// as "unknown: review", like the other cuts) and risks are de-duplicated in constant time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { after, test } from 'node:test';
import { runSafetyAudit } from '../../server/safety-run.js';

const MOD = new URL('../../server/safety-run.js', import.meta.url).href;
const BUDGET_MS = 10000; // the same generous bar as round 1's stall probe
const FILES = 500; // discover.js LIST_MAX: subagent files kept per folder
const SERVERS = 500; // discover.js LIST_MAX: inline servers kept per subagent file

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

test(`one repo with ${FILES} subagents x ${SERVERS} inline MCP servers: the audit finishes within ${BUDGET_MS} ms`, async () => {
  const home = tmp('probe-r2-m2-');
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
  // One 4 KB subagent: 500 inline servers, each a bare key line.
  const servers = Array.from({ length: SERVERS }, (_, i) => `  s${i}:`).join('\n');
  const proto = write(path.join(repo, 'proto.md'), `---\nname: helper\ndescription: helps\nmcpServers:\n${servers}\n---\nHelp.\n`);
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

  // Precondition (fast on r18): one such file gives SERVERS repo MCP servers, each an unknown and a risk.
  link(0);
  const one = runSafetyAudit(args).rows.find((r) => r.id === 'app');
  assert.ok(one, 'precondition: the project row is there');
  // (Since the fix, a folder's inline servers are read up to a budget, and the rest is said as unknown.)
  assert.ok(one.risks.filter((k) => k.id === 'repo_mcp').length >= 1, 'precondition: an inline server of one subagent is a repo_mcp risk');
  assert.ok(one.unknown.some((u) => /Clawdling did not read/.test(u.text)), 'the servers past the budget are said, never silent');
  assert.ok(one.unknown.some((u) => u.text === 's0 MCP server'), 'precondition: an inline server is "unknown: review"');

  for (let i = 1; i < FILES; i++) link(i);
  const res = await auditInWorker(args, BUDGET_MS, home);
  assert.ok(!res.error, `the audit threw: ${res.error}`);
  assert.ok(!res.timedOut, `the audit of ONE cloned repo (${FILES} hard-linked 4 KB subagent files) was still running after ${BUDGET_MS} ms (stopped by this probe). In the cockpit it runs on the server's main thread for every GET /api/setup/safety and every report: the server answers nothing else meanwhile.`);
});
