// discover() end to end against a temp HOME: repos under ~/code (one nested, one linked worktree,
// one bare-repo worktree, a non-git folder, a node_modules tree that must not be walked), a Claude
// Code history folder whose transcripts carry `cwd`, and a fake `gh` on PATH
// (test/fixtures/fake-gh.mjs behind a generated sh shim, or gh.cmd on Windows).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { discover, encodeProjectPath, findSubagent, githubRepos, scanSetup } from '../../server/discover.js';
import { normalizePathKey } from '../../server/platform.js';
import { shq } from '../../server/util.js';
import { IS_WIN, ROOT, readLog, rmrf, tempHome } from '../helpers.mjs';

const FAKE_GH = path.join(ROOT, 'test', 'fixtures', 'fake-gh.mjs');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const ago = (n) => NOW - n * DAY;
const D = (n) => new Date(ago(n)).toISOString();

let T;
let H;
let CFG;
let ORG;
let CODE;
let BIN;
let EMPTY_BIN;
let DATA;
let LOG;
const P = {};
let AGENTS;

function mkdir(...parts) {
  const d = path.join(...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  return file;
}
function touch(p, ms) {
  fs.utimesSync(p, new Date(ms), new Date(ms));
}
function makeRepo(dir, { remote, commitAt } = {}) {
  write(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n${remote ? `[remote "origin"]\n\turl = ${remote}\n` : ''}`);
  const log = write(path.join(dir, '.git', 'logs', 'HEAD'), '0 1 A <a@example.com> 1 +0000\tcommit: x\n');
  if (commitAt) touch(log, commitAt);
  return dir;
}
/** A Claude Code history folder for `cwd` with transcripts [{name, mtime, lines}]; folder mtime last. */
function history(cwd, transcripts, folderMtime) {
  const dir = mkdir(CFG, 'projects', encodeProjectPath(cwd));
  for (const t of transcripts) {
    const f = write(path.join(dir, t.name), t.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    touch(f, t.mtime);
  }
  if (!transcripts.length) mkdir(dir, 'subagents');
  touch(dir, folderMtime ?? Math.max(...transcripts.map((t) => t.mtime)));
  return dir;
}

function writeGhShim(dir) {
  mkdir(dir);
  if (IS_WIN) fs.writeFileSync(path.join(dir, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "${FAKE_GH}" %*\r\n`);
  else fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(FAKE_GH)} "$@"\n`, { mode: 0o755 });
}

/** The inherited environment minus anything GitHub- or Claude-config-related, PATH = only `bin`. */
function envFor(bin, extra = {}) {
  const env = normalizePathKey(process.env);
  for (const k of Object.keys(env)) if (/^(GH_|GITHUB_|FAKE_GH_)|^CLAUDE_CONFIG_DIR$/i.test(k)) delete env[k];
  return { ...env, PATH: bin, CLAUDE_CONFIG_DIR: CFG, FAKE_GH_DATA: DATA, FAKE_GH_LOG: LOG, ...extra };
}

const run = (extra = {}, opts = {}) =>
  discover({ env: envFor(opts.bin || BIN, extra), homedir: H, orgHome: ORG, agents: AGENTS, now: NOW, tmpDirs: [path.join(H, 'scratch')], ...opts });

before(() => {
  T = tempHome('cl-discover-int-');
  H = mkdir(T, 'home');
  CFG = mkdir(H, '.config', 'claude'); // reached through CLAUDE_CONFIG_DIR, not ~/.claude
  ORG = mkdir(H, 'clawdling');
  CODE = mkdir(H, 'code');
  BIN = path.join(T, 'bin');
  EMPTY_BIN = mkdir(T, 'empty-bin');
  DATA = path.join(T, 'gh-data.json');
  LOG = path.join(T, 'gh-log.jsonl');
  writeGhShim(BIN);

  // ~/code/alpha: TypeScript, a remote with credentials in it, a CLAUDE.md, and a linked worktree.
  P.alpha = makeRepo(path.join(CODE, 'alpha'), { remote: 'https://ada:GITSECRET123@github.com/ada/alpha.git', commitAt: ago(10) });
  write(path.join(P.alpha, 'package.json'), { name: 'alpha', description: 'Alpha from package.json' });
  write(path.join(P.alpha, 'tsconfig.json'), '{}');
  write(path.join(P.alpha, 'CLAUDE.md'), '# alpha');
  P.alphaSrc = mkdir(P.alpha, 'src');
  P.alphaWt = mkdir(CODE, 'alpha-wt');
  const wtGit = mkdir(P.alpha, '.git', 'worktrees', 'alpha-wt');
  write(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n');
  write(path.join(wtGit, 'commondir'), '../..\n');
  write(path.join(P.alphaWt, '.git'), `gitdir: ${wtGit}\n`);

  // Nested: ~/code/clients/acme/portal (3 levels below the root, the deepest the walk goes).
  P.portal = makeRepo(path.join(CODE, 'clients', 'acme', 'portal'), { remote: 'git@github.com:acme-co/portal.git', commitAt: ago(20) });
  write(path.join(P.portal, 'pyproject.toml'), '[project]\nname = "portal"\ndescription = "Portal from pyproject"\n');

  // ~/code/solo: a worktree-style `.git` file whose repo is bare (so it is its own project).
  P.solo = mkdir(CODE, 'solo');
  const bare = mkdir(T, 'bare', 'solo.git');
  write(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(bare, 'config'), '[core]\n\tbare = true\n');
  const soloGit = mkdir(bare, 'worktrees', 'solo');
  write(path.join(soloGit, 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(soloGit, 'commondir'), '../..\n');
  touch(write(path.join(soloGit, 'logs', 'HEAD'), 'x\n'), ago(200));
  write(path.join(P.solo, '.git'), `gitdir: ${soloGit}\n`);
  write(path.join(P.solo, 'README.md'), '# Solo\n\nSolo is a tiny CLI. It does one thing.\n');
  write(path.join(P.solo, 'main.go'), 'package main\n');

  // Never projects: a non-git folder, repos inside node_modules / a dot-folder / too deep.
  write(path.join(CODE, 'notes', 'README.md'), '# Notes\n');
  makeRepo(path.join(CODE, 'node_modules', 'leftpad'), { remote: 'https://github.com/x/leftpad.git' });
  makeRepo(path.join(CODE, 'web', 'node_modules', 'dep'), { remote: 'https://github.com/x/dep.git' });
  makeRepo(path.join(CODE, '.hidden', 'repo'));
  makeRepo(path.join(CODE, 'deep', 'a', 'b', 'toodeep'));

  // Claude Code history.
  P.writing = mkdir(H, 'writing');
  write(path.join(P.writing, 'notes.txt'), 'words');
  P.scratch = mkdir(H, 'scratch', 'tmpwork');
  const health = mkdir(ORG, 'domains', 'health');
  history(P.alphaSrc, [
    { name: 'old.jsonl', mtime: ago(30), lines: [{ type: 'user', cwd: P.writing }] },
    { name: 'new.jsonl', mtime: ago(2), lines: [{ type: 'summary', summary: 'HISTORYSECRET42' }, { type: 'user', cwd: P.alphaSrc, message: { content: 'JSONLSECRET42' } }] },
  ]);
  history(path.join(H, 'gone'), [{ name: 's.jsonl', mtime: ago(1), lines: [{ cwd: path.join(H, 'gone') }] }]);
  history(P.writing, [{ name: 's.jsonl', mtime: ago(100), lines: [{ cwd: P.writing }] }]);
  history(health, [{ name: 's.jsonl', mtime: ago(1), lines: [{ cwd: health }] }]);
  history(H, [{ name: 's.jsonl', mtime: ago(1), lines: [{ cwd: H }] }]);
  history(CODE, [{ name: 's.jsonl', mtime: ago(1), lines: [{ cwd: CODE }] }]);
  history(P.scratch, [{ name: 's.jsonl', mtime: ago(1), lines: [{ cwd: P.scratch }] }]);
  history(P.solo, [], ago(150)); // no transcript: the folder name is decoded

  const repo = (owner, name, extra) => ({ name, nameWithOwner: `${owner}/${name}`, description: null, pushedAt: null, primaryLanguage: null, isPrivate: false, url: `https://github.com/${owner}/${name}`, isArchived: false, isFork: false, ...extra });
  write(DATA, {
    user: 'ada',
    orgs: ['acme-co'],
    repos: {
      ada: [
        repo('ada', 'alpha', { description: 'Alpha, the app', pushedAt: D(5), primaryLanguage: { name: 'TypeScript' }, isPrivate: true }),
        repo('ada', 'site', { description: 'Ada site', pushedAt: D(40), primaryLanguage: { name: 'HTML' } }),
        repo('ada', 'old-thing', { description: 'An old thing', pushedAt: D(400), primaryLanguage: { name: 'Ruby' }, isArchived: true, isFork: true }),
      ],
      'acme-co': [repo('acme-co', 'portal', { description: 'Acme customer portal', pushedAt: D(1), primaryLanguage: { name: 'Python' }, isPrivate: true })],
    },
  });
  AGENTS = [
    { id: 'portal', name: 'Portal', kind: 'project', repo: P.portal },
    { id: 'site', name: 'Site', kind: 'project', repo: null, source: { remote_key: 'github.com/ada/site' } },
    { id: 'health', name: 'Health', kind: 'domain', repo: null },
  ];
});

after(() => rmrf(T));
beforeEach(() => fs.rmSync(LOG, { force: true }));

const HAS0 = { claude_md: false, agents_md: false, dot_claude: false, mcp_json: false };
const gh = (nwo, extra) => ({ nameWithOwner: nwo, url: `https://github.com/${nwo}`, private: false, description: null, pushed_at: null, archived: false, fork: false, ...extra });

function expectedLocal() {
  return {
    portal: { key: 'github.com/acme-co/portal', name: 'portal', path: P.portal, cloned: true, remote: 'git@github.com:acme-co/portal.git', github: null, language: 'Python', description: 'Portal from pyproject', git: true, last_activity_at: D(20), last_claude_session_at: null, sources: ['local'], recent: true, agent: { id: 'portal', name: 'Portal' }, has: HAS0, monorepo: false },
    alpha: { key: 'github.com/ada/alpha', name: 'alpha', path: P.alpha, cloned: true, remote: 'https://github.com/ada/alpha.git', github: null, language: 'TypeScript', description: 'Alpha from package.json', git: true, last_activity_at: D(2), last_claude_session_at: D(2), sources: ['claude', 'local'], recent: true, agent: null, has: { ...HAS0, claude_md: true }, monorepo: false },
    writing: { key: `path:${P.writing}`, name: 'writing', path: P.writing, cloned: true, remote: null, github: null, language: null, description: null, git: false, last_activity_at: D(100), last_claude_session_at: D(100), sources: ['claude'], recent: false, agent: null, has: HAS0, monorepo: false },
    solo: { key: `path:${P.solo}`, name: 'solo', path: P.solo, cloned: true, remote: null, github: null, language: 'Go', description: 'Solo is a tiny CLI.', git: true, last_activity_at: D(150), last_claude_session_at: D(150), sources: ['claude', 'local'], recent: false, agent: null, has: HAS0, monorepo: false },
  };
}

test('discover: the whole body, with GitHub through a fake gh on PATH', async () => {
  const body = await run();
  assert.equal(typeof body.took_ms, 'number');
  assert.ok(body.took_ms >= 0 && body.took_ms < 20000, `took ${body.took_ms} ms`);
  delete body.took_ms;
  const L = expectedLocal();
  assert.deepEqual(body, {
    candidates: [
      { ...L.portal, github: gh('acme-co/portal', { private: true, description: 'Acme customer portal', pushed_at: D(1) }), description: 'Acme customer portal', last_activity_at: D(1), sources: ['local', 'github'] },
      { ...L.alpha, github: gh('ada/alpha', { private: true, description: 'Alpha, the app', pushed_at: D(5) }), description: 'Alpha, the app', sources: ['claude', 'local', 'github'] },
      { key: 'github.com/ada/site', name: 'site', path: null, cloned: false, remote: 'https://github.com/ada/site', github: gh('ada/site', { description: 'Ada site', pushed_at: D(40) }), language: 'HTML', description: 'Ada site', git: true, last_activity_at: D(40), last_claude_session_at: null, sources: ['github'], recent: true, agent: { id: 'site', name: 'Site' }, has: HAS0, monorepo: false },
      L.writing,
      L.solo,
      { key: 'github.com/ada/old-thing', name: 'old-thing', path: null, cloned: false, remote: 'https://github.com/ada/old-thing', github: gh('ada/old-thing', { description: 'An old thing', pushed_at: D(400), archived: true, fork: true }), language: 'Ruby', description: 'An old thing', git: true, last_activity_at: D(400), last_claude_session_at: null, sources: ['github'], recent: false, agent: null, has: HAS0, monorepo: false },
    ],
    sources: {
      claude: { dir: path.join('~', '.config', 'claude', 'projects'), found: 3 },
      local: { roots: [path.join('~', 'code')], found: 3 },
      github: { installed: true, authed: true, user: 'ada', found: 4, error: null },
    },
    clone_root: CODE,
  });
  const text = JSON.stringify(body);
  for (const s of ['GITSECRET123', 'JSONLSECRET42', 'HISTORYSECRET42', 'ada:']) assert.ok(!text.includes(s), `${s} leaked`);

  // gh was asked exactly these things, with no prompts, no update check, and no token.
  const calls = readLog(LOG);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 3).join(' ')).sort(), ['api user --jq', 'api user/orgs --jq', 'repo list --json', 'repo list acme-co'].sort());
  for (const c of calls) {
    assert.equal(c.prompt, '1');
    assert.equal(c.notifier, '1');
    assert.deepEqual(c.tokenVars, []);
    assert.ok(!c.args.some((a) => /token/i.test(a)), c.args.join(' '));
  }
});

test('discover: gh not installed shows the folders on this computer only', async () => {
  const body = await run({}, { bin: EMPTY_BIN });
  const L = expectedLocal();
  assert.deepEqual(body.sources.github, { installed: false, authed: false, user: null, found: 0, error: null });
  assert.deepEqual(body.candidates, [L.alpha, L.portal, L.writing, L.solo]);
  assert.deepEqual(readLog(LOG), []);
});

test('discover: gh installed but not signed in', async () => {
  const body = await run({ FAKE_GH_MODE: 'unauth' });
  const L = expectedLocal();
  assert.deepEqual(body.sources.github, { installed: true, authed: false, user: null, found: 0, error: null });
  assert.deepEqual(body.candidates, [L.alpha, L.portal, L.writing, L.solo]);
});

test('discover: an old gh ("Unknown JSON field") is asked again without isArchived/isFork', async () => {
  const body = await run({ FAKE_GH_MODE: 'old' });
  assert.deepEqual(body.sources.github, { installed: true, authed: true, user: 'ada', found: 4, error: null });
  const old = body.candidates.find((c) => c.name === 'old-thing');
  assert.equal(old.github.archived, false, 'unknown to an old gh');
  assert.equal(body.candidates.find((c) => c.name === 'alpha').github.nameWithOwner, 'ada/alpha');
  const lists = readLog(LOG).filter((c) => c.args[1] === 'list');
  assert.equal(lists.filter((c) => c.args.join(' ').includes('isArchived')).length, 1);
  assert.ok(lists.some((c) => c.args[2] === 'acme-co' && !c.args.join(' ').includes('isArchived')));
});

test('discover: github=false never runs gh', async () => {
  const body = await run({}, { github: false });
  assert.deepEqual(body.sources.github, { installed: null, authed: null, user: null, found: 0, error: null, skipped: true });
  assert.equal(body.candidates.length, 4);
  assert.deepEqual(readLog(LOG), []);
});

function canSymlink() {
  const d = tempHome('cl-discover-ln-');
  try {
    fs.writeFileSync(path.join(d, 't'), '');
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    rmrf(d);
  }
}

test('discover + setup: symlinks out of a repo, system folders and dot-folders never reach the body; the org repo is not offered from GitHub', { skip: canSymlink() ? false : 'no symlinks here' }, async () => {
  const t = tempHome('cl-discover-int2-');
  try {
    const home = mkdir(t, 'home');
    const cfg = mkdir(home, '.claude');
    const netrc = write(path.join(home, '.netrc'), 'machine github.com login ada password NETRCSECRET9001\n');
    const code = mkdir(home, 'code');
    const evil = makeRepo(path.join(code, 'evil'), { remote: 'https://github.com/mallory/evil.git', commitAt: ago(1) });
    fs.symlinkSync(path.relative(evil, netrc), path.join(evil, 'README.md'));
    fs.symlinkSync(netrc, path.join(evil, 'package.json'));
    mkdir(evil, '.claude', 'agents');
    fs.symlinkSync(path.join('..', '..', '..', '..', '.netrc'), path.join(evil, '.claude', 'agents', 'helper.md'));
    // The org folder is itself a repo pushed to GitHub.
    const org = makeRepo(path.join(home, 'clawdling'), { remote: 'git@github.com:ada/my-org.git' });
    // Claude Code was once run in /etc, ~/.ssh and the repo.
    const ssh = mkdir(home, '.ssh');
    const sys = fs.existsSync('/etc') ? '/etc' : null;
    const hist = (cwd) => write(path.join(cfg, 'projects', encodeProjectPath(cwd), 's.jsonl'), `${JSON.stringify({ cwd })}\n`);
    for (const cwd of [ssh, evil, ...(sys ? [sys] : [])]) hist(cwd);
    const data = path.join(t, 'gh.json');
    const r = (nwo) => ({ name: nwo.split('/')[1], nameWithOwner: nwo, description: null, pushedAt: D(1), primaryLanguage: null, isPrivate: false, url: `https://github.com/${nwo}`, isArchived: false, isFork: false });
    write(data, { user: 'ada', orgs: [], repos: { ada: [r('ada/my-org'), r('ada/site')] } });

    const body = await discover({ env: envFor(BIN, { CLAUDE_CONFIG_DIR: cfg, FAKE_GH_DATA: data }), homedir: home, configDir: cfg, orgHome: org, now: NOW, tmpDirs: [] });
    const setup = scanSetup({ configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), repos: [{ path: evil, agent: 'evil' }], homedir: home });
    const sub = findSubagent({ scope: 'repo', repo: evil, name: 'helper', repos: [evil] });
    const text = JSON.stringify({ body, setup, sub });
    for (const s of ['NETRCSECRET9001', 'machine github', 'my-org']) assert.ok(!text.includes(s), `${s} reached the output`);
    assert.deepEqual(body.candidates.map((c) => c.key).sort(), ['github.com/ada/site', 'github.com/mallory/evil']);
    const e = body.candidates.find((c) => c.path === evil);
    assert.deepEqual([e.description, e.sources], [null, ['claude', 'local']]);
    assert.deepEqual(setup.projects[0].agents, []);
    assert.equal(sub, null);
  } finally {
    rmrf(t);
  }
});

test('githubRepos: a gh call that hangs times out without sinking the rest', async () => {
  const started = Date.now();
  const r = await githubRepos({ env: envFor(BIN, { FAKE_GH_SLOW: 'acme-co' }), timeout: 1500 });
  assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
  assert.equal(r.authed, true);
  assert.equal(r.user, 'ada');
  assert.equal(r.error, null);
  assert.deepEqual(r.repos.map((x) => x.nameWithOwner), ['ada/alpha', 'ada/site', 'ada/old-thing']);
});
