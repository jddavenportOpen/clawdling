// A permanent regression test: the stand-in adversarial review (1.8, round 1) wrote it as a probe.
// Stand-in review r1, LOW-4: scanSafety keys `dirs` by path.resolve(dir), but auditSafety looks the
// folder up by the agent's raw `cwd` (safety-run.js placeOf: `cwd = a.repo` as org.json holds it;
// org.js normalizeAgent does not resolve `repo` on read). A repo path with a trailing separator (a
// hand-edited org.json; on Windows, forward slashes) finds no entry: the folder's settings, .mcp.json
// and skills are not part of the row at all, and an agent allowed WebFetch and curl shows GREEN.
//
// Fails on r18 HEAD ca03e6d; passes once the lookup (or placeOf) resolves the path the same way.
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
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  return file;
}
function rowFor(trailing) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-l4-')));
  temps.push(home);
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  const repo = path.join(home, 'code', 'app');
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(repo, '.claude', 'settings.json'), { permissions: { allow: ['WebFetch', 'Bash(curl:*)'] } });
  const dir = path.join(org, 'projects', 'app');
  fs.mkdirSync(dir, { recursive: true });
  const agents = [{ id: 'app', name: 'App', kind: 'project', dir, repo: trailing ? `${repo}${path.sep}` : repo, permission_mode: null }];
  const audit = runSafetyAudit({ agents, home: org, userHome: home, configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), env: {}, managed: [], channels: {} });
  return audit.rows.find((r) => r.id === 'app');
}

test('control: the repo path as Clawdling writes it: red', () => {
  assert.equal(rowFor(false).verdict, 'red');
});

test('the same repo with a trailing separator in org.json: its settings are never read', () => {
  const r = rowFor(true);
  assert.equal(r.verdict, 'red', `shown "${r.summary}", loading only ${JSON.stringify(r.loads)}`);
});
