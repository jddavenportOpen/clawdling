// Git metadata read straight from .git: no git process, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { configRemotes, findGitRoot, gitDirOf, gitInfo, githubSlug, remoteKey, sanitizeRemote } from '../../server/git.js';
import { rmrf, tempHome } from '../helpers.mjs';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('sanitizeRemote drops userinfo, query and fragment; keeps scp git@ and local paths', () => {
  assert.equal(sanitizeRemote('https://x:y@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(sanitizeRemote('https://ghp_secret@github.com/a/b.git?token=abc#frag'), 'https://github.com/a/b.git');
  assert.equal(sanitizeRemote('HTTPS://user@GitHub.com/A/B'), 'https://GitHub.com/A/B', 'scheme lowercased, the rest kept');
  assert.equal(sanitizeRemote('ssh://git@github.com:22/a/b.git'), 'ssh://github.com:22/a/b.git');
  assert.equal(sanitizeRemote('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.equal(sanitizeRemote('alice@example.com:a/b.git'), 'example.com:a/b.git', 'a personal ssh user is dropped');
  assert.equal(sanitizeRemote('github.com:a/b.git?x=1'), 'github.com:a/b.git');
  assert.equal(sanitizeRemote('/srv/git/b.git'), '/srv/git/b.git');
  assert.equal(sanitizeRemote('C:\\repos\\b'), 'C:\\repos\\b', 'a Windows path is a local remote, not host "C"');
  for (const bad of ['', '   ', 'https://exa mple.com/x', 'nul\0l', 'relative/path', 'https:///nohost', null, 7, undefined]) {
    assert.equal(sanitizeRemote(bad), null, JSON.stringify(bad));
  }
});

test('remoteKey: https, ssh, scp and an ssh alias like github-work give one key', () => {
  const forms = [
    'https://github.com/Ada/Site.git',
    'https://token@github.com/ada/site',
    'http://github.com/ada/site/',
    'git@github.com:ada/site.git',
    'ssh://git@github.com/ada/site.git',
    'ssh://git@github.com:22/ada/site',
    'git@github-work:ada/site.git',
    'github_personal:ada/site',
  ];
  for (const f of forms) assert.equal(remoteKey(f), 'github.com/ada/site', f);
  assert.equal(remoteKey('https://gitlab.com/Group/Sub/Proj.git'), 'gitlab.com/group/sub/proj');
  assert.equal(remoteKey('git@bitbucket.org:team/repo.git'), 'bitbucket.org/team/repo');
  assert.notEqual(remoteKey('git@githubber:ada/site.git'), 'github.com/ada/site', 'only github / github-<x> aliases map to github.com');
  // Drive letters are not hosts; local paths have no key.
  assert.equal(remoteKey('C:\\repos\\site'), null);
  assert.equal(remoteKey('C:/repos/site'), null);
  assert.equal(remoteKey('/srv/git/site.git'), null);
  assert.equal(remoteKey('https://github.com'), null);
  assert.equal(remoteKey(''), null);
  assert.equal(githubSlug('git@github-work:Ada/Site.git'), 'ada/site');
  assert.equal(githubSlug('https://gitlab.com/ada/site'), null);
  assert.equal(githubSlug('https://github.com/ada/site/tree/main'), null, 'not a repo URL');
});

test('configRemotes reads [remote "x"] url entries in order, quoted or not', () => {
  const text = '[core]\n\turl = nope\n[remote "upstream"]\n\turl = "https://github.com/up/x.git"\n\tfetch = +refs/heads/*\n[branch "main"]\n\tremote = origin\n[remote "origin"]\n  url = git@github.com:me/x.git\n';
  assert.deepEqual(configRemotes(text), [
    { name: 'upstream', url: 'https://github.com/up/x.git' },
    { name: 'origin', url: 'git@github.com:me/x.git' },
  ]);
  assert.deepEqual(configRemotes(''), []);
});

test('gitInfo on a .git folder: origin first, branch from HEAD, last activity from logs/HEAD', () => {
  const dir = tempHome('cl-git-');
  try {
    write(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
    write(path.join(dir, '.git', 'config'), '[remote "upstream"]\n\turl = https://github.com/up/x.git\n[remote "origin"]\n\turl = https://me:ghp_tok@github.com/me/x.git\n');
    write(path.join(dir, '.git', 'index'), '');
    write(path.join(dir, '.git', 'logs', 'HEAD'), 'x\n');
    const when = new Date('2026-10-20T12:00:00.000Z');
    fs.utimesSync(path.join(dir, '.git', 'logs', 'HEAD'), when, when);
    assert.equal(gitDirOf(dir), path.join(dir, '.git'));
    assert.deepEqual(gitInfo(dir), { root: dir, remote: 'https://github.com/me/x.git', branch: 'feature/x', last_commit_at: when.toISOString() });

    // detached HEAD, no origin (the first remote), no reflog (falls back to the index)
    write(path.join(dir, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    write(path.join(dir, '.git', 'config'), '[remote "backup"]\n\turl = git@example.com:me/x.git\n');
    fs.rmSync(path.join(dir, '.git', 'logs'), { recursive: true });
    const idx = new Date('2026-09-01T00:00:00.000Z');
    fs.utimesSync(path.join(dir, '.git', 'index'), idx, idx);
    const info = gitInfo(dir);
    assert.equal(info.branch, 'detached');
    assert.equal(info.remote, 'git@example.com:me/x.git');
    assert.equal(info.last_commit_at, idx.toISOString());

    write(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n');
    assert.equal(gitInfo(dir).remote, null, 'no remote');
    assert.equal(gitInfo(path.join(dir, '.git')), null, 'the .git folder itself is not a repo root');
  } finally {
    rmrf(dir);
  }
});

test('gitInfo on a worktree: the .git file points at its gitdir, config comes from commondir', () => {
  const base = tempHome('cl-git-');
  try {
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    write(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(main, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:me/proj.git\n');
    const wtGit = path.join(main, '.git', 'worktrees', 'wt');
    write(path.join(wtGit, 'HEAD'), 'ref: refs/heads/import\n');
    write(path.join(wtGit, 'commondir'), '../..\n');
    write(path.join(wtGit, 'logs', 'HEAD'), '');
    write(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
    assert.equal(gitDirOf(wt), wtGit);
    const info = gitInfo(wt);
    assert.equal(info.root, wt);
    assert.equal(info.branch, 'import', 'HEAD is the worktree\'s own');
    assert.equal(info.remote, 'git@github.com:me/proj.git', 'remotes come from the shared config');
    assert.ok(info.last_commit_at);

    // a relative gitdir works too; a gitdir that does not exist is not a repo
    write(path.join(wt, '.git'), `gitdir: ${path.relative(wt, wtGit)}\n`);
    assert.equal(gitDirOf(wt), wtGit);
    write(path.join(wt, '.git'), 'gitdir: /no/such/place\n');
    assert.equal(gitDirOf(wt), null);
    assert.equal(gitInfo(wt), null);
    write(path.join(wt, '.git'), 'not a gitdir line\n');
    assert.equal(gitDirOf(wt), null);
  } finally {
    rmrf(base);
  }
});

test('findGitRoot walks up to the nearest repo and never above stopAt', () => {
  const base = tempHome('cl-git-');
  try {
    const repo = path.join(base, 'repo');
    const deep = path.join(repo, 'packages', 'ui', 'src');
    fs.mkdirSync(deep, { recursive: true });
    write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(findGitRoot(deep), repo);
    assert.equal(findGitRoot(repo), repo, 'a root is its own root');
    assert.equal(findGitRoot(deep, { stopAt: base }), repo);
    assert.equal(findGitRoot(deep, { stopAt: repo }), repo, 'stopAt itself is checked');
    assert.equal(findGitRoot(deep, { stopAt: path.join(repo, 'packages') }), null, 'the repo is above stopAt');
    const other = path.join(base, 'other');
    fs.mkdirSync(other);
    assert.equal(findGitRoot(other, { stopAt: base }), null);
    assert.equal(findGitRoot(other, { stopAt: repo }), null, 'a path outside stopAt stops at once');
  } finally {
    rmrf(base);
  }
});
