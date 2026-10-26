// The ship check's isolation (1.6 review fixes): credential scrub, filters, the repo in the
// fingerprint, and steps that leave a background child behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Checks, checkEnv, filterDrivers, fingerprint, looksLikeCredential } from '../../server/checks.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-checks-'));
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
