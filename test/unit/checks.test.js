// The ship check's isolation (1.6 review fixes): credential scrub, filters, the repo in the
// fingerprint, and steps that leave a background child behind.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Checks, checkEnv, filterDrivers, fingerprint, looksLikeCredential, realPathInside } from '../../server/checks.js';

const made = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-checks-'));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const hasGit = spawnSync('git', ['--version']).status === 0;

test('credential scrub: names with PASS, PWD or DSN and URLs with a password go; PWD and PATH stay', () => {
  const env = checkEnv({ PATH: '/bin', PWD: '/x', OLDPWD: '/y', PGPASSWORD: 'p', MYSQL_PWD: 'p', SENTRY_DSN: 'd', DATABASE_URL: 'postgres://u:secret@h/db', REDIS_URL: 'redis://h:6379', DB_PASS: 'p', GH_TOKEN: 't', BYPASS_CACHE: '1' });
  for (const k of ['PGPASSWORD', 'MYSQL_PWD', 'SENTRY_DSN', 'DATABASE_URL', 'DB_PASS', 'GH_TOKEN']) assert.equal(env[k], undefined, k);
  for (const k of ['PATH', 'PWD', 'OLDPWD', 'REDIS_URL', 'BYPASS_CACHE']) assert.ok(env[k], k);
  assert.equal(env.CI, 'true');
  assert.equal(looksLikeCredential('HTTPS_PROXY', 'http://me:pw@proxy:8080'), true);
});

test('filterDrivers: every driver name in git config -z output, dotted names included', () => {
  assert.deepEqual(filterDrivers('filter.lfs.clean\ngit-lfs clean -- %f\0filter.lfs.smudge\nx\0filter.my.tool.process\ny\0'), ['lfs', 'my.tool']);
  assert.deepEqual(filterDrivers(''), []);
  assert.throws(() => filterDrivers('filter.a=b.clean\nx\0'), /cannot switch off/);
});

test('fingerprint: the same commands approved for another repo need approval again', () => {
  const cfg = { setup: [], checks: [{ name: 'tests', run: 'npm test', timeout: 60 }] };
  const a = tmp();
  const b = tmp();
  assert.equal(fingerprint(cfg, a), fingerprint(cfg, a));
  assert.notEqual(fingerprint(cfg, a), fingerprint(cfg, b));
  assert.notEqual(fingerprint(cfg, a), fingerprint(cfg));
});

test('git filters from the repo config never run while the scratch worktree is made', { skip: !hasGit && 'no git' }, async () => {
  const repo = tmp();
  const marker = path.join(tmp(), 'ran');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  const cmd = `touch '${marker.replace(/\\/g, '/')}'; cat`; // git runs filters with sh, Git for Windows too
  git('config', 'filter.evil.smudge', cmd);
  git('config', 'filter.evil.clean', cmd);
  git('config', 'filter.evil.required', 'true');
  fs.appendFileSync(path.join(repo, 'a.txt'), 'changed\n');
  const rt = tmp();
  const checks = new Checks({ paths: { rt, env: path.join(rt, '.env') }, org: {} });
  const wt = path.join(tmp(), 'wt');
  await checks.git(repo, ['stash', 'create']);
  await checks.addWorktree(repo, wt, 'HEAD');
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'hello\n');
  assert.equal(fs.existsSync(marker), false, 'neither the clean nor the smudge filter ran');
  await checks.removeWorktreeAt(repo, wt);
});

test('a step that leaves a background child is done when its shell exits, and the child is ended', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
  const dir = tmp();
  const checks = new Checks({ paths: { rt: dir }, org: {} });
  const pidFile = path.join(dir, 'pid');
  const t0 = Date.now();
  const r = await checks.runOne(`sleep 30 & echo $! > '${pidFile}'; echo ok`, { cwd: dir, env: process.env, timeout: 20 });
  assert.equal(r.exit, 0);
  assert.equal(r.timedOut, false);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 200));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, 'the background sleep was ended with the step');
});

test('checks.yaml is read only as a plain small file: a link to a secret is refused, never echoed', () => {
  const dir = tmp();
  const repo = tmp();
  const secret = path.join(tmp(), '.env');
  fs.writeFileSync(secret, 'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
  const agent = { id: 'web', name: 'Web', kind: 'project', dir, repo };
  const checks = new Checks({ paths: { rt: tmp() }, org: { require: () => agent } });
  let linked = true;
  try {
    fs.symlinkSync(secret, path.join(dir, 'checks.yaml'));
  } catch {
    linked = false; // Windows without the right to make file links
  }
  if (linked) {
    const c = checks.config('web');
    assert.equal(c.config, null);
    assert.match(c.error, /link/);
    assert.ok(!JSON.stringify(c).includes('ghp_'), 'no part of the secret reaches the view');
    fs.rmSync(path.join(dir, 'checks.yaml'));
  }
  fs.writeFileSync(path.join(dir, 'checks.yaml'), `# ${'x'.repeat(70 * 1024)}\n`);
  assert.match(checks.config('web').error, /64 KB/);
});

test('a repo folder inside a monorepo: the ship check runs in that folder of the worktree, not at the top', { skip: !hasGit && 'no git' }, async () => {
  const top = tmp();
  const web = path.join(top, 'apps', 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'check.js'), "process.exit(require('fs').existsSync('web-only.txt') ? 0 : 3)\n");
  fs.writeFileSync(path.join(web, 'web-only.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-C', top, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('add', '.');
  git('commit', '-qm', 'init');
  const dir = tmp();
  const agent = { id: 'web', name: 'Web', kind: 'project', dir, repo: web };
  const checks = new Checks({ paths: { rt: tmp(), env: path.join(dir, '.env') }, org: { require: () => agent } });
  assert.equal(await checks.repoPrefix(web), 'apps/web/');
  checks.approve('web', { checks: [{ name: 'tests', run: 'node check.js', timeout: 60 }], shown: ['node check.js'] });
  const r = await checks.run('web');
  assert.equal(r.results[0].ok, true, JSON.stringify(r.results[0]));
});

test('a ship check that left new files out records how many, and is not claim evidence', { skip: !hasGit && 'no git' }, async () => {
  const repo = tmp();
  fs.writeFileSync(path.join(repo, 'check.js'), 'process.exit(0)\n');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'new-helper.js'), 'module.exports = 1\n');
  const dir = tmp();
  const agent = { id: 'web', name: 'Web', kind: 'project', dir, repo };
  const checks = new Checks({ paths: { rt: tmp(), env: path.join(dir, '.env') }, org: { require: () => agent } });
  checks.approve('web', { checks: [{ name: 'tests', run: 'node check.js', timeout: 60 }], shown: ['node check.js'] });
  const r = await checks.run('web');
  assert.equal(r.untracked, 1);
  assert.deepEqual(checks.evidence('web'), [], 'it says nothing about the claims');
  fs.rmSync(path.join(repo, 'new-helper.js'));
  await checks.run('web');
  assert.equal(checks.evidence('web').length, 1);
  assert.throws(() => checks.approve('web', { checks: [{ name: 'tests', run: 'node check.js‮', timeout: 60 }], shown: ['node check.js‮'] }), /invisible/);
});

test('review 5: a filter switched on only in worktrees (includeIf) never runs; submodules and new files anywhere are left-out counts', { skip: !hasGit && 'no git' }, async () => {
  const repo = tmp();
  const marker = path.join(tmp(), 'ran');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'apps', 'web', 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=wt\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  const head = String(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'])).trim();
  git('update-index', '--add', '--cacheinfo', `160000,${head},vendor/ui`);
  git('commit', '-qm', 'submodule');
  const cfg = path.join(tmp(), 'wt.cfg');
  fs.writeFileSync(cfg, `[filter "wt"]\n\tsmudge = touch '${marker.replace(/\\/g, '/')}'; cat\n\trequired = true\n`);
  git('config', 'includeIf.gitdir:**/worktrees/**.path', cfg.replace(/\\/g, '/'));
  const rt = tmp();
  const checks = new Checks({ paths: { rt, env: path.join(rt, '.env') }, org: {} });
  const wt = path.join(tmp(), 'wt');
  await checks.addWorktree(repo, wt, 'HEAD');
  assert.equal(fs.readFileSync(path.join(wt, 'apps', 'web', 'a.txt'), 'utf8'), 'hello\n');
  assert.equal(fs.existsSync(marker), false, 'the worktree-only filter did not run');
  fs.mkdirSync(path.join(repo, 'packages', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'shared', 'format.js'), 'x');
  const left = await checks.leftOut(path.join(repo, 'apps', 'web'), String(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'])).trim());
  assert.equal(left.untracked, 1, 'a new file in a sibling folder of a monorepo');
  assert.equal(left.submodules, 1);
  await checks.removeWorktreeAt(repo, wt);
});

test('review 5: scratch worktrees live in a private folder; a link in place of the repo folder is refused', () => {
  const t = tmp();
  const checks = new Checks({ paths: { rt: tmp() }, org: {}, tmpdir: t });
  const parent = fs.mkdtempSync(path.join(t, 'clawdling-check-web-'));
  assert.equal(checks.ours(path.join(parent, 'wt')), true);
  assert.equal(checks.ours(parent), false);
  assert.equal(checks.ours(path.join(t, 'other', 'wt')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(parent).mode & 0o077, 0, 'no access for other accounts');
  const root = tmp();
  fs.mkdirSync(path.join(root, 'apps'));
  fs.symlinkSync(tmp(), path.join(root, 'apps', 'web'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(realPathInside(root, path.join(root, 'apps', 'web')), false);
  assert.equal(realPathInside(root, path.join(root, 'apps')), true);
});
