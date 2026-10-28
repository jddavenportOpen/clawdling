// A permanent regression test: the stand-in adversarial review (1.8, round 1) wrote it as a probe.
// Stand-in review r1, MEDIUM-2: permission rule lists are cut at RULE_MAX (300) without a word
// (discover.js ruleList: `v.slice(0, RULE_MAX)`). Claude Code appends every "Yes, and don't ask again"
// to the END of `permissions.allow` (usually the repo's .claude/settings.local.json), so on a long-lived
// repo the newest approvals are exactly the ones the audit never reads. Here a project whose local
// settings hold 300 harmless approvals and then `WebFetch` and `Bash(curl:*)` (untrusted input and
// sends out; the org folder is private data) is shown GREEN, "No trifecta found by name". A repo can do
// the same on purpose: 300 dull rules first, the real ones after.
//
// Fails on r18 HEAD ca03e6d; passes once every rule is read, or a cut list is said (an "unknown"), so
// the row is never green on rules the audit did not read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runSafetyAudit } from '../../server/safety-run.js';

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
function world(prefix, allow) {
  const home = tmp(prefix);
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  const repo = path.join(home, 'code', 'app');
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(repo, '.gitignore'), '.claude/settings.local.json\n'); // ignored: no local_not_ignored risk
  write(path.join(repo, '.claude', 'settings.local.json'), { permissions: { allow } });
  const dir = path.join(org, 'projects', 'app');
  fs.mkdirSync(dir, { recursive: true });
  const agents = [{ id: 'app', name: 'App', kind: 'project', dir, repo, permission_mode: null }];
  const audit = runSafetyAudit({ agents, home: org, userHome: home, configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), env: {}, managed: [], channels: {} });
  return audit.rows.find((r) => r.id === 'app');
}

const filler = Array.from({ length: 300 }, (_, i) => `Bash(ls src/dir${i})`); // not in capabilities.json: no leg
const risky = ['WebFetch', 'Bash(curl:*)'];

test('control: WebFetch and curl approved FIRST make the project agent red', () => {
  const r = world('probe-m2-ctl-', [...risky, ...filler]);
  assert.equal(r.verdict, 'red');
});

test('the same two approvals after 300 others are not read, and nothing says so: the agent shows green', () => {
  const r = world('probe-m2-', [...filler, ...risky]);
  assert.notEqual(r.verdict, 'green', `an agent allowed WebFetch and curl (and the org folder) is shown "${r.summary}"; untrusted chips: ${JSON.stringify(r.chips.untrusted)}, unknown: ${JSON.stringify(r.unknown)}`);
});
