// A permanent regression test: the stand-in adversarial review (1.8, round 2) wrote it as a probe.
// Stand-in review r2, LOW-3: round 1's "a project in a repo subfolder is in that repo" fix stops at the
// home folder, so a monorepo kept outside it (an external drive, /Volumes/Code, /workspaces, /srv) is
// still "not a repo" and its repo risks disappear.
//
// scanSafety() finds the repo root with findGitRoot(dir, { stopAt: home }). findGitRoot (git.js) returns
// null as soon as the next parent is not inside `stopAt`, so for a folder outside the home folder it never
// looks past the folder itself. in_repo is false, `repo` is false on the folder's settings layers, and
// risksFor() drops what applies to a repo: the SessionStart hook ("runs a command whenever a session
// starts"), repo_grants, a subagent's repo_mcp, local_not_ignored. The same monorepo under the home
// folder gets them. With nothing else to review the row turns green.
//
// It FAILS while the outside-home row has no session_start risk, and passes once the walk up to the repo
// root is bounded by the filesystem (or the volume) instead of the home folder when the folder is not
// under home (home's own .git, the dotfiles case, still counts only for folders under home).
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

/** A monorepo at `root` with a project in `app/` whose own settings register a SessionStart hook. */
function monorepo(root) {
  write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(root, '.gitignore'), '.claude/settings.local.json\n');
  const app = path.join(root, 'app');
  write(path.join(app, '.claude', 'settings.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node scripts/setup.js' }] }] } });
  return app;
}

test('a project in a subfolder of a repo outside the home folder keeps its repo risks', () => {
  const base = tmp('probe-r2-l3-');
  const home = path.join(base, 'home');
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  const inside = monorepo(path.join(home, 'code', 'mono'));
  const outside = monorepo(path.join(base, 'Volumes', 'Code', 'mono'));
  for (const id of ['inside', 'outside']) fs.mkdirSync(path.join(org, 'projects', id), { recursive: true });

  const audit = runSafetyAudit({
    agents: [
      { id: 'inside', name: 'Inside', kind: 'project', dir: path.join(org, 'projects', 'inside'), repo: inside, permission_mode: null },
      { id: 'outside', name: 'Outside', kind: 'project', dir: path.join(org, 'projects', 'outside'), repo: outside, permission_mode: null },
    ],
    home: org,
    userHome: home,
    configDir: cfg,
    claudeJsonPath: path.join(home, '.claude.json'),
    env: {},
    managed: [],
    channels: {},
  });
  const ins = audit.rows.find((r) => r.id === 'inside');
  const out = audit.rows.find((r) => r.id === 'outside');
  // Precondition: under the home folder, round 1's fix works.
  assert.ok(ins.risks.some((k) => k.id === 'session_start'), 'precondition: the in-home monorepo project shows its SessionStart hook');
  assert.ok(out.risks.some((k) => k.id === 'session_start'), `the same monorepo outside the home folder loses its SessionStart risk (verdict ${out.verdict}: ${out.summary})`);
});
