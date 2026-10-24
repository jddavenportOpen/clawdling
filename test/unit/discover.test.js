// discover.js: Claude Code history folder names, frontmatter, redaction, candidate merging, the
// gh wrapper, the setup scan, and the promise that a planted secret never reaches any output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  claudeProjectFolders,
  decodeProjectDirName,
  defaultExec,
  defaultRoots,
  discover,
  encodeProjectPath,
  findGitRepos,
  findSubagent,
  githubRepos,
  isSystemPath,
  mergeCandidates,
  parseFrontmatter,
  redactSecrets,
  scanSetup,
} from '../../server/discover.js';
import { rmrf, tempHome } from '../helpers.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const daysAgo = (n) => NOW - n * DAY;
const isoDaysAgo = (n) => new Date(daysAgo(n)).toISOString();

const temps = [];
function tmp(prefix) {
  const d = tempHome(prefix);
  temps.push(d);
  return d;
}
after(() => temps.forEach(rmrf));

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
/** A repo made of plain files, the way gitInfo reads it (no git process). */
function makeRepo(dir, { remote, commitAt } = {}) {
  write(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n${remote ? `[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ''}`);
  const log = write(path.join(dir, '.git', 'logs', 'HEAD'), '0 1 A <a@example.com> 1 +0000\tcommit: x\n');
  if (commitAt) touch(log, commitAt);
  return dir;
}
const ghRepo = (nwo, extra = {}) => ({ name: nwo.split('/')[1], nameWithOwner: nwo, url: `https://github.com/${nwo}`, description: null, pushedAt: null, ...extra });
function canSymlink() {
  const d = tmp('cl-disc-ln-probe-');
  try {
    fs.writeFileSync(path.join(d, 't'), '');
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'));
    return true;
  } catch {
    return false;
  }
}
const NO_LINKS = canSymlink() ? false : 'this system does not let a test create symlinks';
/** A symlink at `p` pointing at `target` (relative targets are relative to p's folder). */
function link(target, p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.symlinkSync(target, p);
  return p;
}

// ------------------------------------------------------------------------------ history names

test('encodeProjectPath: every character outside [A-Za-z0-9] becomes -', () => {
  assert.equal(encodeProjectPath('/Users/ada/code/my_app'), '-Users-ada-code-my-app');
  assert.equal(encodeProjectPath('/Users/ada/agent-system/.claude/worktrees/x'), '-Users-ada-agent-system--claude-worktrees-x');
  assert.equal(encodeProjectPath('/a/my app/v1.2'), '-a-my-app-v1-2');
  assert.equal(encodeProjectPath('/a/café'), '-a-caf-');
  assert.equal(encodeProjectPath('C:\\Users\\x\\code\\app'), 'C--Users-x-code-app');
});

test('decodeProjectDirName walks the real filesystem: lossy names side by side, longest match, backtracking', () => {
  const t = tmp('cl-disc-dec-');
  const r = path.join(t, 'r');
  const leaves = { my_app: 'one', 'my.app': 'two', 'my app': 'three', 'my-app': 'four' };
  for (const [dir, leaf] of Object.entries(leaves)) mkdir(r, dir, leaf);
  for (const [dir, leaf] of Object.entries(leaves)) {
    const want = path.join(r, dir, leaf);
    assert.equal(decodeProjectDirName(encodeProjectPath(want)), want, `from the filesystem root: ${want}`);
    assert.equal(decodeProjectDirName(encodeProjectPath(want), { root: t }), want, `from a given root: ${want}`);
  }
  // All four encode alike: any one of them is a right answer.
  const ambiguous = decodeProjectDirName(encodeProjectPath(path.join(r, 'my_app')));
  assert.ok(Object.keys(leaves).map((d) => path.join(r, d)).includes(ambiguous), ambiguous);
  // `my-app` is the longest match but a dead end (no `src`): back up and take `my/app/src`.
  const b = path.join(t, 'b');
  mkdir(b, 'my-app');
  const deep = mkdir(b, 'my', 'app', 'src');
  assert.equal(decodeProjectDirName(encodeProjectPath(deep)), deep);
  assert.equal(decodeProjectDirName(encodeProjectPath(deep), { root: b }), deep);
  // Gone, malformed, outside the given root.
  assert.equal(decodeProjectDirName(encodeProjectPath(path.join(b, 'gone', 'x'))), null);
  assert.equal(decodeProjectDirName('not-a-path'), null);
  assert.equal(decodeProjectDirName(''), null);
  assert.equal(decodeProjectDirName('-a/../b'), null);
  assert.equal(decodeProjectDirName(encodeProjectPath(deep), { root: path.join(t, 'r') }), null);
});

test('decodeProjectDirName: the Windows form C--Users-x decodes from C:\\ (injected filesystem, any OS)', () => {
  const tree = new Set([
    'C:\\',
    'C:\\Users',
    'C:\\Users\\x',
    'C:\\Users\\x\\code',
    'C:\\Users\\x\\code\\my_app',
    'C:\\Users\\x\\code\\my',
    'C:\\Users\\x\\code\\my\\app',
    'C:\\Users\\x\\code\\my\\app\\web',
  ]);
  const readdir = (dir) => [...tree].filter((p) => p !== dir && path.win32.dirname(p) === dir).map((p) => path.win32.basename(p));
  const opts = { isDir: (p) => tree.has(p), readdir };
  assert.equal(decodeProjectDirName('C--Users-x-code-my-app', opts), 'C:\\Users\\x\\code\\my_app');
  // my_app has no `web`: back up to my\app\web.
  assert.equal(decodeProjectDirName('C--Users-x-code-my-app-web', opts), 'C:\\Users\\x\\code\\my\\app\\web');
  assert.equal(decodeProjectDirName('C--', opts), 'C:\\');
  assert.equal(decodeProjectDirName('C--Users-x-code-my-app', { ...opts, root: 'C:\\Users\\x' }), 'C:\\Users\\x\\code\\my_app');
  assert.equal(decodeProjectDirName('C--Users-x-code-my-app', { ...opts, root: 'C:\\' }), 'C:\\Users\\x\\code\\my_app');
  assert.equal(decodeProjectDirName('C--Users-nobody', opts), null);
  assert.equal(encodeProjectPath(decodeProjectDirName('C--Users-x-code-my-app-web', opts)), 'C--Users-x-code-my-app-web');
});

test('claudeProjectFolders: cwd of the newest transcript, else the decoded name; a gone folder is skipped, never re-pointed at a lossy sibling', () => {
  const t = tmp('cl-disc-cpf-');
  const cfg = path.join(t, 'cfg');
  const proj = path.join(cfg, 'projects');
  const app = mkdir(t, 'w', 'app', 'src');
  mkdir(t, 'w', 'my-app'); // exists, and encodes exactly like the deleted my_app below
  const gone = path.join(t, 'w', 'my_app');
  const plain = mkdir(t, 'w', 'plain');

  const f1 = mkdir(proj, encodeProjectPath(app));
  write(path.join(f1, 'old.jsonl'), JSON.stringify({ type: 'user', cwd: path.join(t, 'elsewhere') }) + '\n');
  write(path.join(f1, 'new.jsonl'), `${JSON.stringify({ type: 'summary', summary: 'not read' })}\n${JSON.stringify({ type: 'user', cwd: app, message: { content: 'hi' } })}\n{"truncated":`);
  touch(path.join(f1, 'old.jsonl'), daysAgo(9));
  touch(path.join(f1, 'new.jsonl'), daysAgo(3));
  const f2 = mkdir(proj, encodeProjectPath(gone));
  assert.equal(f2, path.join(proj, encodeProjectPath(path.join(t, 'w', 'my-app'))));
  write(path.join(f2, 's.jsonl'), JSON.stringify({ cwd: gone }) + '\n');
  const f3 = mkdir(proj, encodeProjectPath(plain)); // no transcript at all: decode the name
  mkdir(f3, 'subagents');
  touch(f3, daysAgo(20));
  write(path.join(proj, 'stray-file.txt'), 'x');

  assert.deepEqual(claudeProjectFolders({ configDir: cfg }), [
    { path: app, last_session_at: isoDaysAgo(3), sessions: 2 },
    { path: plain, last_session_at: isoDaysAgo(20), sessions: 0 },
  ]);
  assert.deepEqual(claudeProjectFolders({ configDir: cfg, skipName: (n) => n === encodeProjectPath(app) }).map((x) => x.path), [plain]);
  assert.deepEqual(claudeProjectFolders({ configDir: cfg, exclude: (p) => p === app }).map((x) => x.path), [plain]);
  assert.equal(claudeProjectFolders({ configDir: cfg, limit: 1 }).length, 1);
  assert.deepEqual(claudeProjectFolders({ configDir: path.join(t, 'none') }), []);
  assert.deepEqual(claudeProjectFolders({}), []);
});

// ------------------------------------------------------------------------------ frontmatter

test('parseFrontmatter: quoted, folded and literal values, continuations, lists, comments', () => {
  const text = [
    '---',
    'name: "deploy-site"',
    "title: 'It''s here'",
    'escaped: "say \\"hi\\""',
    'description: >',
    '  Deploys the site',
    '  to production.',
    '',
    '  Second paragraph.',
    'notes: |',
    '  line one',
    '  line two',
    'plain: first part',
    '  continues here',
    'tools: Read, Grep  # a comment',
    'list:',
    '  - Read',
    '  - "Bash"',
    'flow: [Edit, Write]',
    'empty:',
    '__proto__: polluted',
    '---',
    '# Body',
    'text',
  ].join('\r\n');
  const { data, body } = parseFrontmatter(text);
  assert.deepEqual(data, {
    name: 'deploy-site',
    title: "It's here",
    escaped: 'say "hi"',
    description: 'Deploys the site to production.\nSecond paragraph.',
    notes: 'line one\nline two',
    plain: 'first part continues here',
    tools: 'Read, Grep',
    list: 'Read, Bash',
    flow: 'Edit, Write',
    empty: '',
  });
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(body, '# Body\ntext');
  assert.deepEqual(parseFrontmatter('---\ndescription: >-\n  folded\n  strip\n---\n').data, { description: 'folded strip' });
  assert.deepEqual(parseFrontmatter('\uFEFF---\nname: bom\n---\nx').data, { name: 'bom' });
});

test('parseFrontmatter: no frontmatter, or an unterminated one, is all body', () => {
  assert.deepEqual(parseFrontmatter('# Title\nbody'), { data: {}, body: '# Title\nbody' });
  assert.deepEqual(parseFrontmatter('---\nname: x\nno closing fence'), { data: {}, body: '---\nname: x\nno closing fence' });
  assert.deepEqual(parseFrontmatter(''), { data: {}, body: '' });
  assert.deepEqual(parseFrontmatter(undefined), { data: {}, body: '' });
  assert.deepEqual(parseFrontmatter('text\n---\nname: x\n---'), { data: {}, body: 'text\n---\nname: x\n---' });
});

// ------------------------------------------------------------------------------ redaction

test('redactSecrets: every known token prefix', () => {
  const tokens = [
    'sk-ant-' + 'api03-AbCdEf123456_xyz',
    'sk-proj-abcdEFGH1234ijkl',
    'sk-abcdefghijklmnopqrstuvwx',
    'ghp_' + '0123456789abcdefABCDEF0123456789abcd',
    'gho_' + '16C7e42F292c6912E7710c838347Ae178B4a',
    'ghu_' + 'abcdefgh12345678',
    'ghs_' + 'abcdefgh12345678',
    'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnop',
    'xoxb-' + '123456789012-abcdefghij',
    'xoxa-' + '2-abcdefghij',
    'xoxp-' + '1234-5678',
    'xoxr-' + 'abcdef123',
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'AIza' + 'SyA-1234567890abcdefghijklmnopqrstu',
    'glpat-' + 'abcdefghij1234567890',
    'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
    'sk_live_' + 'abcdefghij123456',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ];
  for (const tok of tokens) assert.equal(redactSecrets(`use ${tok} here`), 'use [redacted] here', tok);
});

test('redactSecrets: key = value / key: value, Bearer and Basic, Authorization headers, URL userinfo, key blocks', () => {
  const cases = [
    ['token=abc123', 'token=[redacted]'],
    ['API_KEY=plainvalue', 'API_KEY=[redacted]'],
    ['export GITHUB_TOKEN = abcdef', 'export GITHUB_TOKEN = [redacted]'],
    ['password: hunter2', 'password: [redacted]'],
    ['db_password: "correct horse battery"', 'db_password: "[redacted]"'],
    ['{"apiKey": "zzz-111", "name": "x"}', '{"apiKey": "[redacted]", "name": "x"}'],
    ["client_secret='s3cr3t'", "client_secret='[redacted]'"],
    ['private_key: abcd1234efgh', 'private_key: [redacted]'],
    ['auth=xyz', 'auth=[redacted]'],
    ['passwd=x1', 'passwd=[redacted]'],
    ['https://api.example.com/v1?access_token=abc123&x=1', 'https://api.example.com/v1?access_token=[redacted]'],
    ['STRIPE_KEY=rk_abc', 'STRIPE_KEY=[redacted]'],
    ['secret: 0123456789abcdefgh', 'secret: [redacted]'],
    ['Authorization: Bearer abc.def-123_xyz', 'Authorization: Bearer [redacted]'],
    ['curl -H "Authorization: Basic dXNlcjpwYXNz"', 'curl -H "Authorization: Basic [redacted]"'],
    ['Bearer abcdef1234567890', 'Bearer [redacted]'],
    ['git clone https://ada:hunter2@github.com/ada/x.git', 'git clone https://[redacted]@github.com/ada/x.git'],
    ['https://0123456789abcdef0123@example.com/x', 'https://[redacted]@example.com/x'],
    ['key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nafter', 'key:\n[redacted]\nafter'],
  ];
  for (const [input, want] of cases) assert.equal(redactSecrets(input), want, input);
  assert.equal(redactSecrets(redactSecrets('token=abc')), 'token=[redacted]', 'idempotent');
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(''), '');
});

test('redactSecrets leaves ordinary prose alone', () => {
  const prose = [
    'Reviews pull requests for bugs, security issues and style.',
    'Deploys the site to production after the tests pass.',
    'Handles OAuth: sign-in, sign-out and session refresh.',
    'Explains how token budgets work and why max_tokens=4096 matters.',
    'Ask before touching passwords or secrets.',
    'Bearer tokens expire after an hour; Basic Authentication is off.',
    'Password: reset flows live in auth/reset.ts',
    'Credentials: rotation, storage and audit.',
    'author: Ada Lovelace',
    'Uses scikit-learn and sk-learn style pipelines.',
    'See https://github.com/ada/site and git@github.com:ada/site.git for details.',
    'Run npm_' + 'config_cache=/tmp npm test.',
    'Note: the API key lives in the keychain, never in this repo.',
  ];
  for (const p of prose) assert.equal(redactSecrets(p), p);
});

test('redactSecrets: newer token formats, private key blocks, webhook URLs, Azure keys, netrc, cookies, env-style names', () => {
  const tokens = [
    'hf_' + 'abcdefghijklmnopqrstuvwxyzABCDEFGH',
    'SG.' + 'abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    'pypi-' + 'AgEIcHlwaS5vcmcCJGFiY2RlZmdoLTEyMzQ1Njc4',
    'ASIA' + 'IOSFODNN7EXAMPLE',
    'ya29.' + 'a0AfH6SMBx-abcdefghijklmnop',
    'xoxc-' + '1234567890-abcdefghij',
    'xoxs-' + '1234567890-abcdefghij',
    'GOCSPX-' + 'abcdefghijklmnopqrstuvwxyz12',
    'whsec_' + 'abcdefghijklmnopqrstuvwxyz012345',
    'dop_v1_' + '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'shpat_' + '0123456789abcdef0123456789abcdef',
    'shpss_' + '0123456789abcdef0123456789abcdef',
    'AGE-SECRET-KEY-' + '1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQY',
  ];
  for (const tok of tokens) assert.equal(redactSecrets(`use ${tok} here`), 'use [redacted] here', tok);
  const cases = [
    ['a\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF0abc\n=XyZ1\n-----END PGP PRIVATE KEY BLOCK-----\nb', 'a\n[redacted]\nb'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', '[redacted]'],
    ['-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0BBQ0w\n-----END ENCRYPTED PRIVATE KEY-----', '[redacted]'],
    [`x -----BEGIN PRIVATE KEY-----\n${'A'.repeat(40000)}\nKEYTAILSECRET no end marker`, 'x [redacted]'],
    ['post to https://hooks.slack.com/services/' + 'T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX now', 'post to https://hooks.slack.com/services/[redacted] now'],
    ['https://discord.com/api/webhooks/' + '123456789012345678/abcDEF-ghiJKL_mno', 'https://discord.com/api/webhooks/[redacted]'],
    ['https://discordapp.com/api/webhooks/' + '123456789012345678/abcDEFghiJKL', 'https://discordapp.com/api/webhooks/[redacted]'],
    ['DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=' + 'abc123DEF456ghi789+/==;EndpointSuffix=core.windows.net', 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=[redacted];EndpointSuffix=core.windows.net'],
    ['BlobEndpoint=https://a.blob.core.windows.net/;SharedAccessSignature=' + 'sv=2020-08-04&ss=b&sig=' + 'abcDEF123%2B%3D', 'BlobEndpoint=https://a.blob.core.windows.net/;SharedAccessSignature=[redacted]&ss=b&sig=[redacted]'],
    ['https://a.blob.core.windows.net/c/f?sv=2020-08-04&sp=r&sig=' + 'abcDEF123%2B%3D', 'https://a.blob.core.windows.net/c/f?sv=2020-08-04&sp=r&sig=[redacted]'],
    ['machine github.com login ada password hunter2', 'machine github.com login ada password [redacted]'],
    ['machine github.com\n  login ada\n  password correcthorse', 'machine github.com\n  login ada\n  password [redacted]'],
    ['Cookie: session=abc123def456; theme=dark', 'Cookie: [redacted]'],
    ['curl -H "cookie: sid=s%3Aabc123.def" https://x', 'curl -H "cookie: [redacted]" https://x'],
    ['DB_PASS=hunter2', 'DB_PASS=[redacted]'],
    ['MYSQL_PWD=hunter2', 'MYSQL_PWD=[redacted]'],
    ['SMTP_PASSWD=hunter2', 'SMTP_PASSWD=[redacted]'],
    ['APP_SECRET=hunter2', 'APP_SECRET=[redacted]'],
    ['GH_TOKEN=hunter2', 'GH_TOKEN=[redacted]'],
    ['DEPLOY_KEY: hunter2', 'DEPLOY_KEY: [redacted]'],
    ['DB_PASS="two words here"', 'DB_PASS="[redacted]"'],
    ['password:\n  hunter2abc', 'password:\n  [redacted]'],
    ['token =\nabc123', 'token =\n[redacted]'],
    ['password: `hunter2`', 'password: `[redacted]`'],
    ['api_key: <sk_abc123>', 'api_key: <[redacted]>'],
    ['secret: [hunter2]', 'secret: [[redacted]]'],
    [`token: "${'a1'.repeat(400)}"`, 'token: "[redacted]"'],
    [`password = '${'x'.repeat(600)} y'`, "password = '[redacted]'"],
    ['git clone https://ada:tok/123@github.com/a/b.git', 'git clone https://[redacted]@github.com/a/b.git'],
  ];
  for (const [input, want] of cases) {
    assert.equal(redactSecrets(input), want, input.slice(0, 80));
    assert.equal(redactSecrets(want), want, `idempotent: ${want.slice(0, 80)}`);
  }
  const prose = [
    'Password reset flows live in auth/reset.ts',
    'Set the password in the keychain.',
    'Cookie: banners are off by default.',
    'The DB_PASS variable holds it.',
    'API_KEY: see the docs',
    'See https://github.com/ada/site@main and https://localhost:8080/x@y for details.',
    'Uses hf_' + 'hub_download and pypi-' + 'publish.',
  ];
  for (const p of prose) assert.equal(redactSecrets(p), p);
});

test('redactSecrets stays linear on hostile 64 KB input (no catastrophic backtracking)', () => {
  const n = 64 * 1024;
  const inputs = ['a.'.repeat(n / 2), 'a'.repeat(n), 'sk-'.repeat(n / 3), 'x://'.repeat(n / 4), '-----BEGIN PRIVATE KEY-----'.repeat(n / 27), 'password: '.repeat(n / 10), 'Bearer '.repeat(n / 7), 'A_KEY'.repeat(n / 5), `${'a-'.repeat(n / 4)}token=`, `https://${'a'.repeat(n)}@x`, 'token="'.repeat(n / 7), 'auth.'.repeat(n / 5), 'password '.repeat(n / 9), 'login a password '.repeat(n / 17), 'cookie: a='.repeat(n / 10), `token: "${'a'.repeat(n)}`, 'DB_PASS="'.repeat(n / 9), `-----BEGIN PRIVATE KEY-----${'-----END PRIVATE KEY-----'.repeat(n / 25)}`, 'x://a:b/'.repeat(n / 8), 'sig='.repeat(n / 4), 'token:\n'.repeat(n / 7)];
  for (const input of inputs) {
    const t0 = performance.now();
    redactSecrets(input);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `${JSON.stringify(input.slice(0, 16))}...: ${Math.round(ms)} ms`);
  }
});

// ------------------------------------------------------------------------------ local repos

test('defaultRoots: only the usual code folders that exist', () => {
  const h = tmp('cl-disc-roots-');
  mkdir(h, 'code');
  mkdir(h, 'Documents', 'GitHub');
  write(path.join(h, 'projects'), 'a file, not a folder');
  assert.deepEqual(defaultRoots(h), [path.join(h, 'code'), path.join(h, 'Documents', 'GitHub')]);
  assert.deepEqual(defaultRoots(path.join(h, 'nobody')), []);
});

test('findGitRepos: skips crowded folders, stops at the entry cap and the depth cap', () => {
  const t = tmp('cl-disc-walk-');
  const root = mkdir(t, 'root');
  const a = makeRepo(path.join(root, 'a'));
  const crowded = mkdir(root, 'crowded');
  for (let i = 0; i < 12; i++) mkdir(crowded, `d${i}`);
  makeRepo(path.join(crowded, 'zz'));
  makeRepo(path.join(root, 'x', 'y', 'z', 'deep'));
  assert.deepEqual(findGitRepos({ roots: [root], maxDirEntries: 10 }).map((r) => r.path), [a]);
  assert.equal(findGitRepos({ roots: [root] }).length, 2, 'a and crowded/zz; x/y/z/deep is below maxDepth');
  assert.equal(findGitRepos({ roots: [root], maxDepth: 4 }).length, 3);
  assert.ok(findGitRepos({ roots: [root], maxEntries: 1 }).length <= 1);
  assert.deepEqual(findGitRepos({ roots: [a] }), [{ path: a }], 'a root that is itself a repo');
  assert.deepEqual(findGitRepos({ roots: [path.join(t, 'missing')] }), []);
});

// ------------------------------------------------------------------------------ merge

test('mergeCandidates: a Claude Code folder inside a repo counts for the repo root (a monorepo is one agent)', () => {
  const home = mkdir(tmp('cl-disc-m1-'), 'home');
  const repo = makeRepo(path.join(home, 'code', 'mono'), { remote: 'https://github.com/ada/mono.git', commitAt: daysAgo(30) });
  write(path.join(repo, 'package.json'), { description: 'The mono repo', workspaces: ['packages/*'] });
  const web = mkdir(repo, 'packages', 'web');
  const api = mkdir(repo, 'packages', 'api');
  const out = mergeCandidates({ claude: [{ path: web, last_session_at: isoDaysAgo(3) }, { path: api, last_session_at: isoDaysAgo(1) }], home, tmpDirs: [], now: NOW });
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.path, repo);
  assert.equal(c.key, 'github.com/ada/mono');
  assert.equal(c.name, 'mono');
  assert.deepEqual(c.sources, ['claude']);
  assert.equal(c.last_claude_session_at, isoDaysAgo(1));
  assert.equal(c.last_activity_at, isoDaysAgo(1));
  assert.equal(c.remote, 'https://github.com/ada/mono.git');
  assert.equal(c.description, 'The mono repo');
  assert.equal(c.monorepo, true);
  assert.equal(c.git, true);
  assert.equal(c.recent, true);
});

test('mergeCandidates: a local repo and its GitHub repo (ssh vs https, any case) are one candidate', () => {
  const home = mkdir(tmp('cl-disc-m2-'), 'home');
  const site = makeRepo(path.join(home, 'code', 'site'), { remote: 'git@github.com:Ada/Site.git', commitAt: daysAgo(50) });
  const gh = [ghRepo('Ada/Site', { description: 'Ada site', pushedAt: isoDaysAgo(10), language: 'HTML', isPrivate: true })];
  const out = mergeCandidates({ local: [{ path: site }], github: { repos: gh }, home, tmpDirs: [], now: NOW });
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.key, 'github.com/ada/site');
  assert.deepEqual(c.sources, ['local', 'github']);
  assert.equal(c.path, site);
  assert.equal(c.cloned, true);
  assert.equal(c.remote, 'git@github.com:Ada/Site.git');
  assert.deepEqual(c.github, { nameWithOwner: 'Ada/Site', url: 'https://github.com/Ada/Site', private: true, description: 'Ada site', pushed_at: isoDaysAgo(10), archived: false, fork: false });
  assert.equal(c.description, 'Ada site');
  assert.equal(c.language, 'HTML', 'no manifest: GitHub language');
  assert.equal(c.last_activity_at, isoDaysAgo(10));
});

test('mergeCandidates: two clones of one remote stay two candidates with unique keys; a worktree folds into its main checkout', () => {
  const home = mkdir(tmp('cl-disc-m3-'), 'home');
  const one = makeRepo(path.join(home, 'code', 'site'), { remote: 'https://github.com/ada/site.git', commitAt: daysAgo(40) });
  const two = makeRepo(path.join(home, 'code', 'site-copy'), { remote: 'git@github.com:ada/site.git', commitAt: daysAgo(2) });
  const out = mergeCandidates({ local: [one, two], github: [ghRepo('ada/site', { pushedAt: isoDaysAgo(2) })], home, tmpDirs: [], now: NOW });
  assert.equal(out.length, 2);
  const byPath = Object.fromEntries(out.map((c) => [c.path, c]));
  assert.equal(byPath[two].key, 'github.com/ada/site', 'the most active clone holds the remote key');
  assert.equal(byPath[two].github.nameWithOwner, 'ada/site');
  assert.equal(byPath[one].key, `path:${one}`);
  assert.equal(byPath[one].github, null);

  const main = makeRepo(path.join(home, 'code', 'app'), { remote: 'https://github.com/ada/app.git', commitAt: daysAgo(30) });
  const wt = mkdir(home, 'code', 'app-feature');
  const wtGit = mkdir(main, '.git', 'worktrees', 'app-feature');
  write(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n');
  write(path.join(wtGit, 'commondir'), '../..\n');
  write(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  const sub = mkdir(wt, 'src');
  const out2 = mergeCandidates({ local: [main, wt], claude: [{ path: sub, last_session_at: isoDaysAgo(1) }], home, tmpDirs: [], now: NOW });
  assert.equal(out2.length, 1);
  assert.equal(out2[0].path, main);
  assert.deepEqual(out2[0].sources, ['claude', 'local']);
  assert.equal(out2[0].last_claude_session_at, isoDaysAgo(1));
});

test('mergeCandidates: an existing project agent is matched by realpath repo, by repos[], and by source.remote_key', () => {
  const home = mkdir(tmp('cl-disc-m4-'), 'home');
  const a = makeRepo(path.join(home, 'code', 'a'), { remote: 'https://github.com/ada/a.git' });
  const b = makeRepo(path.join(home, 'code', 'b'), { remote: 'https://github.com/ada/b.git' });
  const c = makeRepo(path.join(home, 'code', 'c'));
  const e = makeRepo(path.join(home, 'code', 'e'));
  const agents = [
    { id: 'alpha', name: 'Alpha', kind: 'project', repo: `${a}${path.sep}` },
    { id: 'bee', name: 'Bee', kind: 'project', repo: path.join(home, 'elsewhere'), source: { remote_key: 'github.com/ada/b' } },
    { id: 'group', name: 'Group', kind: 'project', repo: null, repos: [c] },
    { id: 'dee', name: 'Dee', kind: 'project', repo: null, source: { remote_key: 'github.com/ada/d' } },
    { id: 'health', name: 'Health', kind: 'domain', repo: e },
  ];
  const out = mergeCandidates({ local: [a, b, c, e], github: [ghRepo('ada/d')], agents, home, tmpDirs: [], now: NOW });
  const agentOf = Object.fromEntries(out.map((x) => [x.name, x.agent]));
  assert.deepEqual(agentOf, { a: { id: 'alpha', name: 'Alpha' }, b: { id: 'bee', name: 'Bee' }, c: { id: 'group', name: 'Group' }, d: { id: 'dee', name: 'Dee' }, e: null });
});

test('mergeCandidates: excludes the org home and its children, the accounts folder, home, /, temp folders, the config dir and container folders', () => {
  const t = tmp('cl-disc-m5-');
  const home = mkdir(t, 'home');
  const org = mkdir(home, 'clawdling');
  const cfg = mkdir(t, 'cfgdir');
  const tmpRoot = mkdir(t, 'tmproot');
  const root = mkdir(home, 'code');
  const keep = mkdir(home, 'Documents', 'thesis');
  const keepRepo = makeRepo(path.join(root, 'real'));
  const s = isoDaysAgo(1);
  const claude = [
    org,
    mkdir(org, 'domains', 'health'),
    mkdir(home, '.clawdling-accounts', 'work'),
    cfg,
    mkdir(cfg, 'x'),
    mkdir(tmpRoot, 'scratch'),
    home,
    mkdir(home, '.claude', 'y'),
    root,
    path.join(home, 'Documents'),
    mkdir(home, 'Desktop'),
    path.parse(home).root,
    keep,
    path.join(home, 'deleted-folder'),
  ].map((p) => ({ path: p, last_session_at: s }));
  const local = [makeRepo(path.join(org, 'projects', 'x')), makeRepo(path.join(tmpRoot, 'r')), keepRepo];
  const out = mergeCandidates({ claude, local, home, orgHome: org, configDir: cfg, tmpDirs: [tmpRoot], roots: [root], now: NOW });
  assert.deepEqual(out.map((c) => c.path).sort(), [keep, keepRepo].sort());
  const thesis = out.find((c) => c.path === keep);
  assert.equal(thesis.git, false);
  assert.equal(thesis.key, `path:${keep}`);
  assert.equal(thesis.remote, null);
});

test('mergeCandidates: a home folder that lives inside a temp folder still has its projects', () => {
  const t = tmp('cl-disc-m7-');
  const home = mkdir(t, 'home');
  const repo = makeRepo(path.join(home, 'code', 'app'));
  const elsewhere = makeRepo(path.join(t, 'elsewhere'));
  const out = mergeCandidates({ local: [repo], claude: [{ path: path.join(home, 'code', 'app'), last_session_at: isoDaysAgo(1) }], home, tmpDirs: [t], now: NOW });
  assert.deepEqual(out.map((c) => c.path), [repo]);
  const otherHome = tmp('cl-disc-m7-home-'); // not inside t
  assert.deepEqual(mergeCandidates({ local: [repo, elsewhere], home: otherHome, tmpDirs: [t], now: NOW }), [], 'a home outside the temp folder: temp paths are excluded');
});

test('mergeCandidates: recent is inclusive at exactly 90 days; newest first, then by name, undated last', () => {
  const home = mkdir(tmp('cl-disc-m6-'), 'home');
  const gh = [
    ghRepo('ada/edge', { pushedAt: new Date(NOW - 90 * DAY).toISOString() }),
    ghRepo('ada/past', { pushedAt: new Date(NOW - 90 * DAY - 1000).toISOString() }),
    ghRepo('ada/never'),
    ghRepo('ada/new', { pushedAt: isoDaysAgo(1) }),
    ghRepo('ada/b-tie', { pushedAt: isoDaysAgo(5) }),
    ghRepo('ada/a-tie', { pushedAt: isoDaysAgo(5) }),
  ];
  const out = mergeCandidates({ github: gh, home, tmpDirs: [], now: NOW });
  assert.deepEqual(out.map((c) => c.name), ['new', 'a-tie', 'b-tie', 'edge', 'past', 'never']);
  assert.deepEqual(out.map((c) => c.recent), [true, true, true, true, false, false]);
  const n = out[0];
  assert.deepEqual(
    { key: n.key, path: n.path, cloned: n.cloned, remote: n.remote, git: n.git, sources: n.sources, has: n.has, last_claude_session_at: n.last_claude_session_at },
    { key: 'github.com/ada/new', path: null, cloned: false, remote: 'https://github.com/ada/new', git: true, sources: ['github'], has: { claude_md: false, agents_md: false, dot_claude: false, mcp_json: false }, last_claude_session_at: null }
  );
  // `now` may be a function, a Date or ms.
  assert.equal(mergeCandidates({ github: gh, home, tmpDirs: [], now: () => NOW }).find((c) => c.name === 'past').recent, false);
  assert.equal(mergeCandidates({ github: gh, home, tmpDirs: [], now: new Date(NOW - 1000) }).find((c) => c.name === 'past').recent, true);
});

// ------------------------------------------------------------------------------ gh

function ghFake(handlers) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const line = args.join(' ');
    for (const [re, fn] of handlers) if (re.test(line)) return fn(args, opts);
    throw Object.assign(new Error('Command failed'), { code: 1, stderr: `unknown command "${line}" for "gh"\n` });
  };
  return { exec, calls };
}
const ghError = (stderr, extra = {}) => Object.assign(new Error(`Command failed: gh\n${stderr}`), { code: 1, stderr, stdout: '', ...extra });
const out = (stdout) => ({ stdout, stderr: '' });
const rawRepo = (nwo, extra = {}) => ({ name: nwo.split('/')[1], nameWithOwner: nwo, description: null, pushedAt: '2026-10-01T00:00:00Z', primaryLanguage: { name: 'Go' }, isPrivate: false, url: `https://github.com/${nwo}`, isArchived: false, isFork: false, ...extra });

test('githubRepos: user, own repos and org repos through gh only, deduplicated and validated; no token anywhere', async () => {
  const { exec, calls } = ghFake([
    [/^api user --jq \.login$/, () => out('ada\n')],
    [/^api user\/orgs/, () => out('acme-co\nada\nnot an org!\n--help\n')],
    [/^repo list --json/, () => out(JSON.stringify([rawRepo('ada/site', { description: 'My site', isPrivate: true }), rawRepo('ada/../etc'), rawRepo('-x/y'), { junk: true }]))],
    [/^repo list acme-co --json/, () => out(JSON.stringify([rawRepo('acme-co/portal'), rawRepo('ada/site')]))],
  ]);
  const r = await githubRepos({ exec, env: { PATH: '/nowhere', HOME: '/h' } });
  assert.equal(r.installed, true);
  assert.equal(r.authed, true);
  assert.equal(r.user, 'ada');
  assert.equal(r.error, null);
  assert.deepEqual(r.repos.map((x) => x.nameWithOwner), ['ada/site', 'acme-co/portal']);
  assert.deepEqual(r.repos[0], { name: 'site', nameWithOwner: 'ada/site', description: 'My site', pushedAt: '2026-10-01T00:00:00.000Z', language: 'Go', isPrivate: true, url: 'https://github.com/ada/site', isArchived: false, isFork: false });
  assert.ok(calls.every((c) => c.file === 'gh'), 'only gh is ever run');
  assert.ok(calls.every((c) => !c.args.some((a) => /token/i.test(a))), 'no token argument');
  assert.ok(calls.every((c) => c.opts.env.GH_PROMPT_DISABLED === '1' && c.opts.env.GH_NO_UPDATE_NOTIFIER === '1' && c.opts.env.HOME === '/h'), 'inherited env + no prompts');
  assert.ok(calls.every((c) => c.opts.timeout > 0 && c.opts.timeout <= 15000));
  assert.deepEqual(calls.find((c) => c.args[2] === 'acme-co').args, ['repo', 'list', 'acme-co', '--json', 'name,nameWithOwner,description,pushedAt,primaryLanguage,isPrivate,url,isArchived,isFork', '--limit', '50']);
  assert.ok(!calls.some((c) => c.args.includes('not an org!') || c.args.includes('--help')), 'org names are validated before use');
});

test('githubRepos: gh missing, gh not signed in, gh offline', async () => {
  const missing = ghFake([[/./, () => Promise.reject(Object.assign(new Error('gh is not installed'), { code: 'ENOENT' }))]]);
  assert.deepEqual(await githubRepos({ exec: missing.exec }), { installed: false, authed: false, user: null, repos: [], error: null });
  const unauth = ghFake([[/./, () => Promise.reject(ghError('To get started with GitHub CLI, please run:  gh auth login\n', { code: 4 }))]]);
  assert.deepEqual(await githubRepos({ exec: unauth.exec }), { installed: true, authed: false, user: null, repos: [], error: null });
  const offline = ghFake([[/./, () => Promise.reject(ghError('error connecting to api.github.com\ncheck your internet connection\n'))]]);
  assert.deepEqual(await githubRepos({ exec: offline.exec }), { installed: true, authed: null, user: null, repos: [], error: 'error connecting to api.github.com' });
});

test('githubRepos: an old gh without isArchived/isFork is asked again without them', async () => {
  const { exec, calls } = ghFake([
    [/^api user --jq/, () => out('ada\n')],
    [/^api user\/orgs/, () => out('acme-co\n')],
    [/isArchived/, () => Promise.reject(ghError('Unknown JSON field: "isArchived"\nAvailable fields:\n  name\n'))],
    [/^repo list --json/, () => out(JSON.stringify([{ name: 'site', nameWithOwner: 'ada/site', url: 'https://github.com/ada/site' }]))],
    [/^repo list acme-co/, () => out(JSON.stringify([{ name: 'portal', nameWithOwner: 'acme-co/portal', url: 'https://github.com/acme-co/portal' }]))],
  ]);
  const r = await githubRepos({ exec });
  assert.equal(r.authed, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.repos.map((x) => [x.nameWithOwner, x.isArchived, x.isFork]), [['ada/site', false, false], ['acme-co/portal', false, false]]);
  const lists = calls.filter((c) => c.args[1] === 'list').map((c) => c.args.join(' '));
  assert.equal(lists.filter((l) => l.includes('isArchived')).length, 1, 'the org list goes straight to the old fields');
  assert.equal(lists.length, 3);
});

test('githubRepos: one slow or broken call is never fatal, and the whole run is bounded', async () => {
  const { exec } = ghFake([
    [/^api user --jq/, () => out('ada\n')],
    [/^api user\/orgs/, () => out('slow-org\nbroken-org\n')],
    [/^repo list --json/, () => out(JSON.stringify([rawRepo('ada/site')]))],
    [/^repo list slow-org/, () => Promise.reject(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }))],
    [/^repo list broken-org/, () => out('<html>not json</html>')],
  ]);
  const r = await githubRepos({ exec });
  assert.deepEqual([r.authed, r.user, r.error, r.repos.map((x) => x.nameWithOwner)], [true, 'ada', null, ['ada/site']]);
  // A gh that never answers: the budget ends it.
  const never = async () => new Promise(() => {});
  const started = Date.now();
  const hung = await Promise.race([githubRepos({ exec: never, budget: 0 }), new Promise((res) => setTimeout(() => res('hung'), 2000))]);
  assert.notEqual(hung, 'hung');
  assert.deepEqual(hung, { installed: true, authed: null, user: null, repos: [], error: 'gh did not answer in time' });
  assert.ok(Date.now() - started < 2000);
});

test('defaultExec runs only gh, and reports a missing gh as ENOENT', async () => {
  await assert.rejects(defaultExec('git', ['status']), /discover only runs gh/);
  await assert.rejects(defaultExec('claude', ['-p', 'x']), /discover only runs gh/);
  const empty = tmp('cl-disc-nogh-');
  await assert.rejects(defaultExec('gh', ['--version'], { env: { PATH: empty } }), (err) => err.code === 'ENOENT');
});

// ------------------------------------------------------------------------------ setup scan

test('scanSetup: skills, subagents, commands (a:b), plugins, hook events, MCP names by scope, per-project setup', () => {
  const t = tmp('cl-disc-setup-');
  const home = mkdir(t, 'home');
  const cfg = mkdir(home, '.claude');
  write(path.join(cfg, 'CLAUDE.md'), ['# Rules', '', ...Array.from({ length: 12 }, (_, i) => `rule ${i + 1}`)].join('\n'));
  write(path.join(cfg, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: >\n  Deploys the site\n  to production.\n---\nbody');
  write(path.join(cfg, 'skills', 'unnamed', 'SKILL.md'), 'no frontmatter');
  mkdir(cfg, 'skills', 'no-skill-file');
  const huge = write(path.join(cfg, 'skills', 'huge', 'SKILL.md'), '---\nname: huge\n---\n');
  fs.truncateSync(huge, 21 * 1024 * 1024); // over 20 MB: skipped, never read
  write(path.join(cfg, 'agents', 'cr.md'), '---\nname: code-reviewer\ndescription: "Reviews code"\ntools: Read, Grep\nmodel: sonnet\n---\nYou review code.\n');
  write(path.join(cfg, 'agents', 'helper.md'), 'Just a prompt.');
  write(path.join(cfg, 'agents', 'notes.txt'), 'not an agent');
  write(path.join(cfg, 'commands', 'review.md'), '---\ndescription: Review the diff\n---\nReview it.');
  write(path.join(cfg, 'commands', 'frontend', 'component.md'), '# Make a component\n\nSteps...');
  write(path.join(cfg, 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }, { matcher: 'Edit', hooks: [{ type: 'command', command: 'c' }] }], Stop: [{ hooks: [{ type: 'command', command: 'd' }] }], 'bad event!': [{}] }, enabledPlugins: { 'superpowers@obra': true, 'extra@mkt': false } });
  write(path.join(cfg, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'superpowers@obra': [{ scope: 'user', installPath: '/x' }], 'telegram@claude-plugins-official': [{ scope: 'user' }] } });
  const repo = mkdir(t, 'repo');
  const repo2 = mkdir(t, 'repo2');
  write(path.join(repo, 'CLAUDE.md'), '# repo');
  write(path.join(repo, '.mcp.json'), { mcpServers: { db: { command: 'psql' }, search: { url: 'https://x' } } });
  write(path.join(repo, '.claude', 'agents', 'helper.md'), '---\nname: helper\ndescription: Repo helper\n---\nx');
  write(path.join(repo, '.claude', 'skills', 'ship', 'SKILL.md'), '---\ndescription: Ships it\n---\n');
  write(path.join(repo, '.claude', 'commands', 'fix.md'), 'Fix the bug');
  write(path.join(repo, '.claude', 'settings.json'), { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
  write(path.join(repo, '.claude', 'settings.local.json'), { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'y' }] }], Stop: [{ hooks: [{ type: 'command', command: 'z' }] }] } });
  write(path.join(repo2, '.claude', 'CLAUDE.md'), '# in .claude');
  write(path.join(repo2, 'AGENTS.md'), '# agents');
  const claudeJson = write(path.join(home, '.claude.json'), { mcpServers: { github: { command: 'x' }, linear: { url: 'y' } }, projects: { [repo]: { mcpServers: { localdb: {} } }, [repo2]: { mcpServers: {} } } });

  const agents = [
    { id: 'repo', kind: 'project', repo },
    { id: 'pair', kind: 'project', repo: null, repos: [repo2, path.join(t, 'missing')] },
    { id: 'health', kind: 'domain', repo: null },
  ];
  const s = scanSetup({ configDir: cfg, claudeJsonPath: claudeJson, agents, homedir: home });
  assert.equal(s.config_dir, path.join('~', '.claude'));
  assert.deepEqual(s.claude_md, { exists: true, lines: ['# Rules', 'rule 1', 'rule 2', 'rule 3', 'rule 4', 'rule 5', 'rule 6', 'rule 7'] });
  assert.deepEqual(s.skills, [
    { name: 'deploy', description: 'Deploys the site to production.', source: 'user' },
    { name: 'unnamed', description: null, source: 'user' },
  ]);
  // helper.md has no frontmatter `name`: Claude Code does not load it as a subagent, so neither do we.
  assert.deepEqual(s.agents, [{ name: 'code-reviewer', description: 'Reviews code', file: 'cr.md', source: 'user' }]);
  assert.deepEqual(s.commands, [
    { name: 'frontend:component', description: 'Make a component' },
    { name: 'review', description: 'Review the diff' },
  ]);
  assert.deepEqual(s.plugins, [
    { name: 'extra', marketplace: 'mkt', enabled: false },
    { name: 'superpowers', marketplace: 'obra', enabled: true },
    { name: 'telegram', marketplace: 'claude-plugins-official', enabled: false },
  ]);
  assert.deepEqual(s.hooks, [{ event: 'PreToolUse', count: 3 }, { event: 'Stop', count: 1 }]);
  assert.deepEqual(s.mcp, [{ name: 'github', scope: 'user' }, { name: 'linear', scope: 'user' }]);
  assert.deepEqual(s.projects, [
    {
      path: repo,
      agent: 'repo',
      claude_md: true,
      agents_md: false,
      skills: [{ name: 'ship', description: 'Ships it', source: 'project' }],
      agents: [{ name: 'helper', description: 'Repo helper', file: 'helper.md', source: 'project' }],
      commands: [{ name: 'fix', description: 'Fix the bug' }],
      hooks: [{ event: 'PostToolUse', count: 2 }, { event: 'Stop', count: 1 }],
      mcp: [{ name: 'db', scope: 'project' }, { name: 'search', scope: 'project' }, { name: 'localdb', scope: 'local' }],
    },
    { path: repo2, agent: 'pair', claude_md: true, agents_md: true, skills: [], agents: [], commands: [], hooks: [], mcp: [] },
  ]);
  // Nothing configured at all: an empty, well-formed answer.
  const bare = scanSetup({ configDir: path.join(t, 'none'), claudeJsonPath: path.join(t, 'none.json'), homedir: home });
  assert.deepEqual(bare, { config_dir: path.join(t, 'none'), claude_md: { exists: false, lines: [] }, skills: [], agents: [], commands: [], plugins: [], hooks: [], mcp: [], projects: [] });
});

test('findSubagent: by frontmatter name only; never a path from the name; repo scope honours the allow-list', () => {
  const t = tmp('cl-disc-sub-');
  const cfg = mkdir(t, 'cfg');
  write(path.join(cfg, 'agents', 'cr.md'), '---\nname: code-reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: sonnet\n---\n\nYou review code.\nBe kind.\n');
  write(path.join(cfg, 'agents', 'helper.md'), 'Just help.');
  write(path.join(cfg, 'agents', 'nameless.md'), '---\ndescription: No name\n---\nBody.');
  write(path.join(t, 'outside.md'), '---\nname: outside\n---\nnope');
  assert.deepEqual(findSubagent({ configDir: cfg, scope: 'user', name: 'code-reviewer' }), { name: 'code-reviewer', description: 'Reviews code', file: 'cr.md', path: path.join(cfg, 'agents', 'cr.md'), body: 'You review code.\nBe kind.', tools: 'Read, Grep', model: 'sonnet' });
  // No frontmatter `name`, no subagent (it used to fall back to the file name, so any .md was promotable).
  assert.equal(findSubagent({ configDir: cfg, scope: 'user', name: 'helper' }), null);
  assert.equal(findSubagent({ configDir: cfg, scope: 'user', name: 'nameless' }), null);
  assert.equal(findSubagent({ configDir: cfg, scope: 'user', name: 'cr' }), null, 'a frontmatter name wins over the file name');
  for (const name of ['../outside', '../../outside', 'outside', '', 'x'.repeat(300), null]) assert.equal(findSubagent({ configDir: cfg, scope: 'user', name }), null, String(name));
  const repo = mkdir(t, 'repo');
  write(path.join(repo, '.claude', 'agents', 'r.md'), '---\nname: repo-helper\n---\nHelp in the repo.');
  assert.equal(findSubagent({ scope: 'repo', repo, name: 'repo-helper' }).body, 'Help in the repo.');
  assert.equal(findSubagent({ scope: 'repo', repo, name: 'repo-helper', repos: [repo] }).file, 'r.md');
  assert.equal(findSubagent({ scope: 'repo', repo, name: 'repo-helper', repos: [cfg] }), null);
  assert.equal(findSubagent({ scope: 'repo', repo: 'relative/repo', name: 'repo-helper' }), null);
  assert.equal(findSubagent({ scope: 'other', configDir: cfg, name: 'helper' }), null);
});

// ------------------------------------------------------------------------------ symlinks, walks, names

test('SYMLINKS: a cloned repo cannot pull a private file into a candidate, the setup scan or a subagent', { skip: NO_LINKS }, () => {
  const t = tmp('cl-disc-ln-repo-');
  const home = mkdir(t, 'home');
  const cfg = mkdir(home, '.claude');
  const netrc = write(path.join(home, '.netrc'), 'machine github.com login ada password NETRCSECRET0001\n');
  const priv = mkdir(t, 'private');
  write(path.join(priv, 'pkg.json'), { description: 'PKGLINKSECRET0002' });
  write(path.join(priv, 'agent.md'), '---\nname: linked-agent\ndescription: LINKEDAGENT0003\n---\nLINKEDBODY0004');
  write(path.join(priv, 'skill', 'SKILL.md'), '---\nname: linked-skill\ndescription: LINKEDSKILL0005\n---\n');
  write(path.join(priv, 'settings.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
  write(path.join(priv, 'mcp.json'), { mcpServers: { linkedmcp: {} } });
  write(path.join(priv, 'CLAUDE.md'), '# outside');
  write(path.join(priv, 'cmd.md'), '---\ndescription: LINKEDCMD0006\n---\n');
  const code = mkdir(home, 'code');

  // README.md -> ../../.netrc
  const a = makeRepo(path.join(code, 'a'), { commitAt: daysAgo(1) });
  link(path.relative(a, netrc), path.join(a, 'README.md'));
  // Every other file the scans read, each a symlink out of the repo.
  const b = makeRepo(path.join(code, 'b'), { commitAt: daysAgo(2) });
  link(path.join(priv, 'pkg.json'), path.join(b, 'package.json'));
  link(path.join(priv, 'CLAUDE.md'), path.join(b, 'CLAUDE.md'));
  link(path.join(priv, 'mcp.json'), path.join(b, '.mcp.json'));
  link(netrc, path.join(b, 'AGENTS.md'));
  link(path.join('..', '..', '..', '..', '.netrc'), path.join(b, '.claude', 'agents', 'helper.md')); // the audit's example
  link(path.join(priv, 'agent.md'), path.join(b, '.claude', 'agents', 'linked.md'));
  link(path.join(priv, 'skill'), path.join(b, '.claude', 'skills', 'linked'));
  link(netrc, path.join(b, '.claude', 'commands', 'netrc.md'));
  link(path.join(priv, 'cmd.md'), path.join(b, '.claude', 'commands', 'linked.md'));
  link(priv, path.join(b, '.claude', 'commands', 'sub'));
  link(path.join(priv, 'settings.json'), path.join(b, '.claude', 'settings.json'));
  // A repo whose whole .claude is the user's own config dir.
  const c = makeRepo(path.join(code, 'c'), { commitAt: daysAgo(3) });
  write(path.join(cfg, 'agents', 'mine.md'), '---\nname: mine\ndescription: My own agent\n---\nMine.');
  link(cfg, path.join(c, '.claude'));
  // Symlinks that stay inside the repo are fine.
  const d = makeRepo(path.join(code, 'd'), { commitAt: daysAgo(4) });
  write(path.join(d, 'docs', 'README.md'), '# D\n\nD is fine.\n');
  link(path.join('docs', 'README.md'), path.join(d, 'README.md'));
  write(path.join(d, 'shared', 'real.md'), '---\nname: real\ndescription: Real one\n---\nReal.');
  link(path.join('..', '..', 'shared', 'real.md'), path.join(d, '.claude', 'agents', 'real.md'));

  const cands = mergeCandidates({ local: [a, b, c, d], home, tmpDirs: [], now: NOW });
  const setup = scanSetup({ configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), repos: [a, b, c, d], homedir: home });
  const subs = [
    findSubagent({ scope: 'repo', repo: b, name: 'helper' }),
    findSubagent({ scope: 'repo', repo: b, name: 'linked-agent' }),
    findSubagent({ scope: 'repo', repo: c, name: 'mine' }),
  ];
  const text = JSON.stringify({ cands, setup, subs });
  for (const s of ['NETRCSECRET0001', 'machine github', 'PKGLINKSECRET0002', 'LINKEDAGENT0003', 'LINKEDBODY0004', 'LINKEDSKILL0005', 'LINKEDCMD0006', 'linkedmcp', 'SessionStart']) {
    assert.ok(!text.includes(s), `${s} came through a symlink out of a repo`);
  }
  assert.deepEqual(subs, [null, null, null]);
  const by = Object.fromEntries(cands.map((x) => [x.name, x]));
  assert.equal(by.a.description, null);
  assert.equal(by.b.description, null);
  assert.deepEqual(by.b.has, { claude_md: false, agents_md: false, dot_claude: true, mcp_json: false });
  assert.equal(by.c.has.dot_claude, false, 'a .claude that is a symlink out of the repo');
  assert.equal(by.d.description, 'D is fine.');
  const empty = { agent: null, claude_md: false, agents_md: false, skills: [], agents: [], commands: [], hooks: [], mcp: [] };
  const proj = Object.fromEntries(setup.projects.map((p) => [path.basename(p.path), p]));
  assert.deepEqual(proj.b, { path: b, ...empty });
  assert.deepEqual(proj.c, { path: c, ...empty });
  assert.deepEqual(proj.d.agents, [{ name: 'real', description: 'Real one', file: 'real.md', source: 'project' }]);
  assert.equal(findSubagent({ scope: 'repo', repo: d, name: 'real' }).body, 'Real.');
  assert.deepEqual(setup.agents, [{ name: 'mine', description: 'My own agent', file: 'mine.md', source: 'user' }], 'the user scope still lists it');
});

test('SYMLINKS: the user config dir may link to a dotfiles repo, but a linked file never gives its first line, and only a named file is a subagent', { skip: NO_LINKS }, () => {
  const t = tmp('cl-disc-ln-cfg-');
  const home = mkdir(t, 'home');
  const dots = mkdir(t, 'dotfiles');
  const cfg = mkdir(home, '.claude');
  const netrc = write(path.join(home, '.netrc'), 'machine x login ada password NETRCSECRET0007\n');
  write(path.join(dots, 'agents', 'dotted.md'), '---\nname: dotted\ndescription: From my dotfiles\n---\nDotted body.');
  link(path.join(dots, 'agents', 'dotted.md'), path.join(cfg, 'agents', 'dotted.md'));
  link(netrc, path.join(cfg, 'agents', 'helper.md'));
  write(path.join(cfg, 'agents', 'plain.md'), 'Just a prompt, no frontmatter.');
  write(path.join(dots, 'commands', 'deploy.md'), 'Deploy everything now.');
  write(path.join(dots, 'commands', 'ship.md'), '---\ndescription: Ship it\n---\n');
  link(path.join(dots, 'commands', 'deploy.md'), path.join(cfg, 'commands', 'deploy.md'));
  link(path.join(dots, 'commands', 'ship.md'), path.join(cfg, 'commands', 'ship.md'));
  link(netrc, path.join(cfg, 'commands', 'creds.md'));
  write(path.join(cfg, 'commands', 'own.md'), 'Own command first line.');
  write(path.join(dots, 'team', 'review.md'), '---\ndescription: Team review\n---\n');
  link(path.join(dots, 'team'), path.join(cfg, 'commands', 'team')); // a linked subfolder is still walked

  const s = scanSetup({ configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), homedir: home });
  assert.deepEqual(s.agents, [{ name: 'dotted', description: 'From my dotfiles', file: 'dotted.md', source: 'user' }]);
  assert.deepEqual(s.commands, [
    { name: 'creds', description: null },
    { name: 'deploy', description: null },
    { name: 'own', description: 'Own command first line.' },
    { name: 'ship', description: 'Ship it' },
    { name: 'team:review', description: 'Team review' },
  ]);
  assert.ok(!JSON.stringify(s).includes('NETRCSECRET0007'));
  assert.equal(findSubagent({ configDir: cfg, scope: 'user', name: 'helper' }), null);
  assert.equal(findSubagent({ configDir: cfg, scope: 'user', name: 'plain' }), null);
  assert.equal(findSubagent({ configDir: cfg, scope: 'user', name: 'dotted' }).body, 'Dotted body.');
  // The config dir itself linked from dotfiles: its own files are inside it.
  write(path.join(dots, 'claude', 'commands', 'x.md'), 'First line here.');
  const linkedCfg = link(path.join(dots, 'claude'), path.join(home, '.claude-linked'));
  assert.deepEqual(scanSetup({ configDir: linkedCfg, claudeJsonPath: path.join(home, '.claude.json'), homedir: home }).commands, [{ name: 'x', description: 'First line here.' }]);
});

test('setup scan: directory symlink loops in commands cost nothing (no N^4 walk), in the config dir and in a repo', { skip: NO_LINKS }, () => {
  const t = tmp('cl-disc-fan-');
  const cfg = mkdir(t, 'cfg');
  const cmds = mkdir(cfg, 'commands');
  write(path.join(cmds, 'x.md'), '---\ndescription: X\n---\n');
  const repo = mkdir(t, 'repo');
  const rc = mkdir(repo, '.claude', 'commands');
  write(path.join(rc, 'y.md'), '---\ndescription: Y\n---\n');
  // N symlinks to a folder of N symlinks to itself, with no command file in it: the old walk
  // followed every one to depth 3 (N^3 folders, N^4 entries) with nothing to stop it.
  for (const d of [cmds, rc]) {
    mkdir(d, 'e');
    for (let i = 0; i < 30; i++) {
      link('e', path.join(d, `l${i}`));
      link('.', path.join(d, 'e', `l${i}`));
    }
  }
  link('..', path.join(rc, 'up')); // .claude, inside the repo
  link(path.join('..', '..', '..'), path.join(rc, 'out')); // above the repo
  const t0 = performance.now();
  const s = scanSetup({ configDir: cfg, claudeJsonPath: path.join(t, 'none.json'), repos: [repo], homedir: t });
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `the scan took ${Math.round(ms)} ms`);
  assert.deepEqual(s.commands, [{ name: 'x', description: 'X' }]);
  assert.deepEqual(s.projects[0].commands, [{ name: 'y', description: 'Y' }]);
});

test('setup scan: hook keys that are not Claude Code event names are never printed; every other name is redacted', () => {
  const t = tmp('cl-disc-names-');
  const home = mkdir(t, 'home');
  const cfg = mkdir(home, '.claude');
  const N = {
    hook: 'ghp_' + 'HOOKNAME0123456789abcdefABCDEF0123',
    hook2: 'HOOKNAMESECRET0002',
    hook3: 'sk-ant-' + 'api03-HOOKKEY0003',
    mcp: 'ghp_' + 'MCPNAME0123456789abcdefABCDEF01234',
    plugin: 'sk-ant-' + 'api03-PLUGINNAME0005',
    market: 'glpat-' + 'MARKETPLACE0006abcdef',
    skill: 'glpat-' + 'SKILLDIR0007abcdefgh',
    agentName: 'xoxb-' + '123456789012-AGENTNAME0008',
    agentFile: 'npm_' + 'AGENTFILE0009abcdefghijkl',
    command: 'ghs_' + 'COMMANDFILE0010abcdef',
    repoMcp: 'AKIA' + 'REPOMCPNAME00011',
  };
  const hook = [{ hooks: [{ type: 'command', command: 'x' }] }];
  write(path.join(cfg, 'settings.json'), { hooks: { PreToolUse: hook, [N.hook]: hook, [N.hook2]: hook, [N.hook3]: hook, x: hook }, enabledPlugins: { [`${N.plugin}@mkt`]: true, [`ok@${N.market}`]: true } });
  const claudeJson = write(path.join(home, '.claude.json'), { mcpServers: { [N.mcp]: {}, github: {} } });
  write(path.join(cfg, 'skills', N.skill, 'SKILL.md'), 'no frontmatter');
  write(path.join(cfg, 'agents', `${N.agentFile}.md`), `---\nname: ${N.agentName}\ndescription: d\n---\n`);
  write(path.join(cfg, 'commands', `${N.command}.md`), '---\ndescription: c\n---\n');
  const repo = mkdir(t, 'repo');
  write(path.join(repo, '.mcp.json'), { mcpServers: { [N.repoMcp]: {} } });
  write(path.join(repo, '.claude', 'settings.json'), { hooks: { Stop: hook, [N.hook]: hook } });
  const s = scanSetup({ configDir: cfg, claudeJsonPath: claudeJson, repos: [repo], homedir: home });
  const text = JSON.stringify(s);
  for (const [k, v] of Object.entries(N)) assert.ok(!text.includes(v), `${k} (${v}) printed raw`);
  assert.deepEqual(s.hooks, [{ event: 'PreToolUse', count: 1 }]);
  assert.deepEqual(s.projects[0].hooks, [{ event: 'Stop', count: 1 }]);
  assert.ok(s.mcp.some((m) => m.name === 'github'));
});

test('setup scan: a single-line field is collapsed before it is redacted', () => {
  const t = tmp('cl-disc-flat-');
  const cfg = mkdir(t, 'cfg');
  write(path.join(cfg, 'skills', 'nl', 'SKILL.md'), `---\nname: nl\ndescription: |\n  Deploys.\n  token:\n${'\n'.repeat(10)}  NLSECRET0001abc\n---\n`);
  write(path.join(cfg, 'agents', 'b.md'), `---\nname: b\ndescription: "Uses Bearer${' '.repeat(12)}BEARERSECRET0002abc"\n---\n`);
  const s = scanSetup({ configDir: cfg, claudeJsonPath: path.join(t, 'none.json'), homedir: t });
  const text = JSON.stringify(s);
  assert.ok(!text.includes('NLSECRET0001abc') && !text.includes('BEARERSECRET0002abc'), text);
  assert.equal(s.skills.find((x) => x.name === 'nl').description, 'Deploys. token: [redacted]');
  assert.equal(s.agents.find((x) => x.name === 'b').description, 'Uses Bearer [redacted]');
});

test('setup scan: 100 skills with 62 KB descriptions stay cheap (a field is clamped before it is redacted)', () => {
  const t = tmp('cl-disc-huge-');
  const cfg = mkdir(t, 'cfg');
  const desc = 'sk-'.repeat(20700); // ~62 KB of a token prefix: the slowest shape for the redactor
  for (let i = 0; i < 100; i++) write(path.join(cfg, 'skills', `big${i}`, 'SKILL.md'), `---\nname: big${i}\ndescription: ${desc}\n---\n`);
  const t0 = performance.now();
  const s = scanSetup({ configDir: cfg, claudeJsonPath: path.join(t, 'none.json'), homedir: t });
  const ms = performance.now() - t0;
  assert.equal(s.skills.length, 100);
  assert.ok(s.skills.every((x) => !x.description || x.description.length <= 300));
  assert.ok(ms < 1000, `100 skills with 62 KB descriptions took ${Math.round(ms)} ms`);
});

test('findSubagent reads only the head of each candidate to match, and at most 100 KB of the match', () => {
  const t = tmp('cl-disc-subcap-');
  const cfg = mkdir(t, 'cfg');
  write(path.join(cfg, 'agents', 'big.md'), `---\nname: big\ndescription: Big\n---\n${'line of the prompt\n'.repeat(20000)}`);
  write(path.join(cfg, 'agents', 'late.md'), `---\nname: late\n${'tools: Read\n'.repeat(7000)}---\nx`); // closing fence past 64 KB
  const sub = findSubagent({ configDir: cfg, scope: 'user', name: 'big' });
  assert.ok(sub.body.startsWith('line of the prompt\nline'));
  assert.ok(sub.body.length <= 100 * 1024, `body is ${sub.body.length} chars`);
  assert.equal(findSubagent({ configDir: cfg, scope: 'user', name: 'late' }), null);
});

test('isSystemPath: system trees (POSIX and Windows), minus one that holds the home folder', () => {
  const posix = { platform: 'linux', home: '/home/ada' };
  for (const p of ['/etc', '/etc/nginx', '/usr/bin', '/bin', '/sbin', '/var/log', '/private/etc', '/private/var/db', '/System/Library', '/Library/Caches', '/Applications/X.app', '/opt/homebrew/Cellar', '/proc/1', '/dev']) assert.equal(isSystemPath(p, posix), true, p);
  for (const p of ['/home/ada/code/app', '/srv/app', '/workspace', '/opt/myapp', '/Volumes/x/code', '/etcetera', '/usrlocal']) assert.equal(isSystemPath(p, posix), false, p);
  assert.equal(isSystemPath('/var/folders/x/home/code/app', { platform: 'linux', home: '/var/folders/x/home' }), false, 'a sandbox HOME under /var keeps /var');
  assert.equal(isSystemPath('/etc', { platform: 'linux', home: '/var/folders/x/home' }), true);
  const win = { platform: 'win32', home: 'C:\\Users\\ada' };
  for (const p of ['C:\\Windows', 'c:\\windows\\System32', 'C:\\Program Files\\Git', 'C:\\Program Files (x86)\\X', 'C:\\ProgramData\\y']) assert.equal(isSystemPath(p, win), true, p);
  for (const p of ['C:\\Users\\ada\\code', 'D:\\code\\app', 'C:\\work\\site', 'C:\\Windows-projects']) assert.equal(isSystemPath(p, win), false, p);
});

test('mergeCandidates: history folders in system trees and dot-folders under home are not projects; folders elsewhere still are', () => {
  const t = tmp('cl-disc-sys-');
  const home = mkdir(t, 'home');
  const keep = mkdir(t, 'work', 'app'); // outside home, not a system folder
  const notes = mkdir(home, 'notes');
  const s = isoDaysAgo(1);
  const system = ['/etc', '/usr/bin', '/bin', '/dev', '/System/Library', '/Library', '/private/etc'].filter((p) => fs.existsSync(p));
  const dots = [mkdir(home, '.ssh'), mkdir(home, '.config', 'gh'), mkdir(home, '.aws')];
  const claude = [...system, ...dots, keep, notes].map((p) => ({ path: p, last_session_at: s }));
  const out = mergeCandidates({ claude, home, tmpDirs: [], now: NOW });
  assert.deepEqual(out.map((c) => c.path).sort(), [keep, notes].sort());
  // discover() asks claudeProjectFolders to drop them too.
  const cfg = mkdir(home, '.claude');
  for (const p of [...system, ...dots, notes]) write(path.join(cfg, 'projects', encodeProjectPath(p), 's.jsonl'), `${JSON.stringify({ cwd: p })}\n`);
  return discover({ env: { PATH: '' }, homedir: home, configDir: cfg, github: false, roots: [], tmpDirs: [], now: NOW }).then((body) => {
    assert.deepEqual(body.candidates.map((c) => c.path), [notes]);
  });
});

test('mergeCandidates: the GitHub listing of the org folder, or of a repo inside it or the Claude config dir, is not offered to clone', () => {
  const t = tmp('cl-disc-orggh-');
  const home = mkdir(t, 'home');
  const org = makeRepo(path.join(home, 'clawdling'), { remote: 'git@github.com:ada/my-org.git' });
  const inner = makeRepo(path.join(org, 'projects', 'inner'), { remote: 'https://github.com/ada/inner.git' });
  const cfg = makeRepo(path.join(home, '.claude'), { remote: 'https://github.com/ada/claude-config.git' });
  const tmpRoot = mkdir(t, 'tmproot');
  const scratch = makeRepo(path.join(tmpRoot, 'site'), { remote: 'https://github.com/ada/site.git' });
  const gh = ['ada/my-org', 'ada/inner', 'ada/claude-config', 'ada/site', 'ada/other'].map((n) => ghRepo(n, { pushedAt: isoDaysAgo(1) }));
  const claude = [{ path: mkdir(org, 'domains', 'health'), last_session_at: isoDaysAgo(1) }];
  const out = mergeCandidates({ local: [inner, scratch], claude, github: gh, home, orgHome: org, configDir: cfg, tmpDirs: [tmpRoot], now: NOW });
  // A scratch clone in a temp folder is not the org: its repo can still be cloned for real.
  assert.deepEqual(out.map((c) => [c.key, c.cloned]).sort(), [['github.com/ada/other', false], ['github.com/ada/site', false]]);
});

test('mergeCandidates and discover: a HOME under a temp folder reached through a symlink (macOS /var -> /private/var) keeps its repos', { skip: NO_LINKS }, async () => {
  const t = tmp('cl-disc-varlink-');
  const realTmp = mkdir(t, 'private', 'var', 'folders');
  const linkTmp = link(realTmp, path.join(t, 'var-folders')); // like /var/folders -> /private/var/folders
  const home = mkdir(realTmp, 'xy', 'home'); // HOME as its realpath, the way macOS hands it out
  const repo = makeRepo(path.join(home, 'code', 'app'), { commitAt: daysAgo(1) });
  assert.deepEqual(mergeCandidates({ local: [repo], home, tmpDirs: [linkTmp], now: NOW }).map((c) => c.path), [repo]);
  const body = await discover({ env: { PATH: '' }, homedir: home, configDir: path.join(home, '.claude'), github: false, roots: [path.join(home, 'code')], tmpDirs: [linkTmp], now: NOW });
  assert.deepEqual(body.candidates.map((c) => c.path), [repo]);
  // The real thing on macOS: os.tmpdir() is /var/folders/..., a temp HOME its realpath under /private/var.
  if (process.platform === 'darwin') {
    const h = mkdir(tmp('cl-disc-varreal-'), 'home');
    assert.ok(h.startsWith('/private/var/') && os.tmpdir().startsWith('/var/'), `${h} / ${os.tmpdir()}`);
    const r = makeRepo(path.join(h, 'code', 'app'), { commitAt: daysAgo(1) });
    assert.deepEqual(mergeCandidates({ local: [r], home: h, tmpDirs: [os.tmpdir(), '/var/folders'], now: NOW }).map((c) => c.path), [r]);
  }
});

// ------------------------------------------------------------------------------ the secret test

test('SECRETS: no planted credential reaches scanSetup, discover or findSubagent output, while the names do', async () => {
  const t = tmp('cl-disc-secret-');
  const home = mkdir(t, 'home');
  const cfg = mkdir(home, '.claude');
  const S = {
    primaryApiKey: 'sk-ant-' + 'api03-PRIMARYKEYSECRET0001',
    oauthEmail: 'oauth-secret-person@example.com',
    oauthUuid: 'OAUTHUUIDSECRET-1234',
    mcpEnv: 'MCPENVSECRET0002',
    mcpHeader: 'MCPHEADERSECRET0003',
    mcpArg: 'MCPARGSECRET0004',
    mcpCommand: 'MCPCOMMANDSECRET0005',
    mcpUrl: 'MCPURLSECRET0006',
    localEnv: 'LOCALMCPSECRET0007',
    history: 'CLAUDEJSONHISTORYSECRET0008',
    hookCmd: 'HOOKCOMMANDSECRET0009',
    settingsEnv: 'SETTINGSENVSECRET0010',
    repoHook: 'REPOHOOKSECRET0011',
    mcpJsonEnv: 'MCPJSONSECRET0012',
    mcpJsonArg: 'MCPJSONARGSECRET0013',
    skill: 'SKILLSECRET0014abc',
    subagent: 'SUBAGENTSECRET0015def',
    subagentBody: 'sk-ant-' + 'api03-SUBAGENTBODY0016',
    claudeMd: 'CLAUDEMDSECRET0017',
    claudeMdToken: 'ghp_' + 'CLAUDEMDTOKEN0018abcdefghijklmnop',
    command: 'COMMANDSECRET0019xyz',
    gitConfig: 'GITCONFIGSECRET0020',
    pkgDesc: 'PKGDESCSECRET0021',
    pluginPath: 'PLUGINPATHSECRET0022',
    transcript: 'TRANSCRIPTSECRET0023',
    ghDesc: 'ghp_' + 'GHDESCRIPTION0024abcdefghij',
    ghUrl: 'GHURLSECRET0025',
    repoAgent: 'REPOAGENTSECRET0026ghi',
    repoSkill: 'REPOSKILLSECRET0027',
    readme: 'READMESECRET0028xyz',
  };
  const code = mkdir(home, 'code');
  const repo = makeRepo(path.join(code, 'shop'), { remote: `https://deploy:${S.gitConfig}@github.com/ada/shop.git`, commitAt: daysAgo(3) });
  const notes = makeRepo(path.join(code, 'notes'), { commitAt: daysAgo(4) });
  write(path.join(notes, 'README.md'), `# Notes\n\nMy notes, password=${S.readme} is old. More text.\n`);
  const tool = makeRepo(path.join(code, 'tool'), { commitAt: daysAgo(5) });
  write(path.join(tool, 'package.json'), { name: 'tool', description: `Tool app. auth_token: ${S.pkgDesc}` });
  const claudeJson = write(path.join(home, '.claude.json'), {
    primaryApiKey: S.primaryApiKey,
    oauthAccount: { emailAddress: S.oauthEmail, accountUuid: S.oauthUuid },
    mcpServers: {
      github: { command: `npx-${S.mcpCommand}`, args: ['--token', S.mcpArg], env: { API_KEY: S.mcpEnv } },
      remote: { type: 'http', url: `https://mcp.example.com/sse?token=${S.mcpUrl}`, headers: { Authorization: `Bearer ${S.mcpHeader}` } },
    },
    projects: { [repo]: { mcpServers: { db: { command: 'psql', env: { PGPASSWORD: S.localEnv } } }, history: [{ display: S.history }] } },
  });
  write(path.join(cfg, 'settings.json'), {
    env: { ANTHROPIC_API_KEY: S.settingsEnv },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `curl -H "X-Key: ${S.hookCmd}" https://x` }, { type: 'command', command: 'echo 2' }] }],
      Stop: [{ hooks: [{ type: 'command', command: `notify ${S.hookCmd}` }] }],
    },
    enabledPlugins: { 'superpowers@obra': true },
  });
  write(path.join(cfg, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'superpowers@obra': [{ scope: 'user', installPath: `/x/${S.pluginPath}`, version: '1.0' }] } });
  write(path.join(cfg, 'skills', 'deploy', 'SKILL.md'), `---\nname: deploy\ndescription: Deploys the site. token=${S.skill}\n---\nBody with ${S.skill}\n`);
  write(path.join(cfg, 'agents', 'reviewer.md'), `---\nname: reviewer\ndescription: Reviews code. Uses api_key: ${S.subagent}\ntools: Read\n---\nYou review. Key ${S.subagentBody}\n`);
  write(path.join(cfg, 'commands', 'review.md'), `---\ndescription: Review with Bearer ${S.command}\n---\nprompt`);
  write(path.join(cfg, 'CLAUDE.md'), `# My rules\npassword: ${S.claudeMd}\nThe token ${S.claudeMdToken} is old\n`);
  write(path.join(repo, '.mcp.json'), { mcpServers: { db: { command: 'psql', args: ['--password', S.mcpJsonArg], env: { PGPASSWORD: S.mcpJsonEnv } } } });
  write(path.join(repo, '.claude', 'settings.json'), { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: `lint ${S.repoHook}` }] }] } });
  write(path.join(repo, '.claude', 'agents', 'helper.md'), `---\nname: helper\ndescription: Helps. secret: "${S.repoAgent}"\n---\nx`);
  write(path.join(repo, '.claude', 'skills', 'ship', 'SKILL.md'), `---\ndescription: Ships. ANTHROPIC_API_KEY=${S.repoSkill}\n---\n`);
  write(path.join(repo, 'package.json'), { name: 'shop', description: `Shop app. auth_token: ${S.pkgDesc}` }); // GitHub's description wins here
  const hist = mkdir(cfg, 'projects', encodeProjectPath(repo));
  write(path.join(hist, 's.jsonl'), `${JSON.stringify({ type: 'user', cwd: repo, message: { content: `here is my key ${S.transcript}` } })}\n`);

  const setup = scanSetup({ configDir: cfg, claudeJsonPath: claudeJson, repos: [{ path: repo, agent: 'shop' }], homedir: home });
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === 'api' && args[1] === 'user') return out('ada\n');
    if (args[0] === 'api' && args[1] === 'user/orgs') return out('');
    if (args[0] === 'repo' && args[1] === 'list') {
      return out(JSON.stringify([
        rawRepo('ada/shop', { description: `Shop. ${S.ghDesc}`, url: `https://x:${S.ghUrl}@github.com/ada/shop`, pushedAt: isoDaysAgo(1) }),
        rawRepo('ada/other', { description: `password: ${S.ghDesc}`, url: `https://tok:${S.ghUrl}@github.com/ada/other`, pushedAt: isoDaysAgo(2) }),
      ]));
    }
    throw ghError('unexpected');
  };
  const disc = await discover({ env: { PATH: '' }, homedir: home, configDir: cfg, orgHome: path.join(home, 'clawdling'), exec, now: NOW, tmpDirs: [] });
  const sub = findSubagent({ configDir: cfg, scope: 'user', name: 'reviewer' });
  const text = JSON.stringify({ setup, disc, sub });
  for (const [k, v] of Object.entries(S)) assert.ok(!text.includes(v), `planted secret ${k} (${v}) leaked`);
  assert.ok(!/deploy:|tok:|x:GH/.test(text), 'no URL userinfo');
  assert.ok(calls.every((c) => c.file === 'gh'));

  // ...while the names and the harmless parts do appear.
  assert.deepEqual(setup.mcp, [{ name: 'github', scope: 'user' }, { name: 'remote', scope: 'user' }]);
  assert.deepEqual(setup.hooks, [{ event: 'PreToolUse', count: 2 }, { event: 'Stop', count: 1 }]);
  assert.deepEqual(setup.plugins, [{ name: 'superpowers', marketplace: 'obra', enabled: true }]);
  assert.deepEqual(setup.skills, [{ name: 'deploy', description: 'Deploys the site. token=[redacted]', source: 'user' }]);
  assert.deepEqual(setup.agents, [{ name: 'reviewer', description: 'Reviews code. Uses api_key: [redacted]', file: 'reviewer.md', source: 'user' }]);
  assert.deepEqual(setup.commands, [{ name: 'review', description: 'Review with Bearer [redacted]' }]);
  assert.deepEqual(setup.claude_md.lines, ['# My rules', 'password: [redacted]', 'The token [redacted] is old']);
  const p = setup.projects[0];
  assert.deepEqual(p.mcp, [{ name: 'db', scope: 'project' }, { name: 'db', scope: 'local' }]);
  assert.deepEqual(p.hooks, [{ event: 'PostToolUse', count: 1 }]);
  assert.deepEqual(p.agents.map((a) => a.description), ['Helps. secret: "[redacted]"']);
  assert.deepEqual(p.skills.map((a) => a.description), ['Ships. ANTHROPIC_API_KEY=[redacted]']);
  assert.equal(sub.body, 'You review. Key [redacted]');

  const shop = disc.candidates.find((c) => c.name === 'shop');
  assert.equal(shop.remote, 'https://github.com/ada/shop.git');
  assert.equal(shop.github.url, 'https://github.com/ada/shop');
  assert.equal(shop.description, 'Shop. [redacted]');
  assert.deepEqual(shop.sources, ['claude', 'local', 'github']);
  const other = disc.candidates.find((c) => c.name === 'other');
  assert.equal(other.remote, 'https://github.com/ada/other');
  assert.equal(other.description, 'password: [redacted]');
  assert.equal(disc.candidates.find((c) => c.name === 'notes').description, 'My notes, password=[redacted] is old.');
  assert.equal(disc.candidates.find((c) => c.name === 'tool').description, 'Tool app. auth_token: [redacted]');
});
