// A permanent regression test: the stand-in adversarial review (1.8, round 1) wrote it as a probe.
// Stand-in review r1, LOW-3: a project imported from a SUBFOLDER of a repo (importer.js supports it:
// "A subfolder of a repo does not stand for the whole repo") runs its sessions in that subfolder, but
// scanSafety sets `in_repo: !!gitDirOf(dir)`, which only looks for `<dir>/.git`. In a monorepo's
// apps/web there is none, so the repo-owned risks are never raised there: a SessionStart hook planted in
// apps/web/.claude/settings.json (the npm-worm vector), a `.mcp.json` server, a repo skill's
// allowed-tools, a committed settings.local.json. The row is GREEN where the repo root would be amber.
//
// Fails on r18 HEAD ca03e6d; passes once in_repo walks up to the enclosing git root (git.js findGitRoot).
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
const HOOK = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node scripts/boot.js' }] }] } };

function rowFor(sub) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-l3-')));
  temps.push(home);
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  const mono = path.join(home, 'code', 'mono');
  write(path.join(mono, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const repo = sub ? path.join(mono, 'apps', 'web') : mono;
  write(path.join(repo, '.claude', 'settings.json'), HOOK);
  const dir = path.join(org, 'projects', 'web');
  fs.mkdirSync(dir, { recursive: true });
  const agents = [{ id: 'web', name: 'Web', kind: 'project', dir, repo, permission_mode: null }];
  const audit = runSafetyAudit({ agents, home: org, userHome: home, configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), env: {}, managed: [], channels: {} });
  return audit.rows.find((r) => r.id === 'web');
}

test('control: the hook at the repo root is the SessionStart risk', () => {
  assert.ok(rowFor(false).risks.some((k) => k.id === 'session_start'));
});

test('the same hook in apps/web/.claude/settings.json of that repo is not a risk: the project imported from apps/web shows green', () => {
  const r = rowFor(true);
  assert.ok(r.risks.some((k) => k.id === 'session_start'), `no SessionStart risk (verdict ${r.verdict}): ${JSON.stringify(r.risks)}`);
});
