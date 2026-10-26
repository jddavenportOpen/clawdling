#!/usr/bin/env node
// Opt-in live check (`node test/live/donna-live.mjs`): Donna answers "What got done today, and what
// needs me?" from the report card, with the REAL `claude` CLI. In a throwaway org: a project agent
// makes one small change (one real session, which then ends), then Donna is asked through the
// cockpit's own chat route (the same headless turn a Telegram or iMessage text gets).
//
// Passes when her reply names the change, does not say her access was denied, and her turn denied
// no tool call. The harness answers the folder-trust question and NOTHING else. Costs a few cents
// of your Claude plan; everything it starts is cleaned up. Run it with a throwaway HOME.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'clawdling.js');
const MODEL = process.env.SMOKE_MODEL || 'haiku';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 240000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[donna]', ...a);

if ((process.env.CLAWDLING_CLAUDE_BIN || '').includes('fake-claude') || process.env.CLAWDLING_TEST === '1') {
  console.error('[donna] refusing: this needs the real claude (unset CLAWDLING_CLAUDE_BIN / CLAWDLING_TEST)');
  process.exit(2);
}

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-donna-')));
const repo = path.join(home, 'code', 'garden-notes');
const socket = `clawdling-donna-${process.pid}`;
const env = { ...process.env, CLAWDLING_HOME: path.join(home, 'org'), CLAWDLING_TMUX_SOCKET: socket };
for (const k of ['CLAWDLING_TEST', 'CLAWDLING_CLAUDE_BIN', 'CLAWDLING_SID', 'CLAWDLING_PORT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) delete env[k];
let server;
const results = [];

async function main() {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# Garden notes\n\nWhat grows where.\n');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=Maya', '-c', 'user.email=maya@example.invalid', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'First notes');
  fs.writeFileSync(path.join(home, 'answers.json'), JSON.stringify({ owner: 'Maya', about: 'Runs a small garden shop; checks in from her phone.', domains: [{ name: 'Shop' }], donna: { channel: 'later' } }));
  execFileSync(process.execPath, [CLI, 'init', '--answers', path.join(home, 'answers.json')], { env, stdio: 'ignore' });
  server = spawn(process.execPath, [CLI, 'start', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  let info = null;
  for (let i = 0; i < 200 && !info; i++) {
    await sleep(100);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(env.CLAWDLING_HOME, '.clawdling', 'server.json'), 'utf8'));
      if (j.pid === server.pid) info = j;
    } catch {
      // not yet
    }
  }
  if (!info) throw new Error(`server did not start: ${out}`);
  const token = fs.readFileSync(path.join(env.CLAWDLING_HOME, '.clawdling', 'token'), 'utf8').trim();
  const base = `http://127.0.0.1:${info.port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'x-clawdling-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  log(`server up: claude ${(await api('GET', '/api/health')).claude.version}`);
  const imp = await api('POST', '/api/import', { path: repo });
  const agent = imp.agent.id;
  // The owner's own setting for this agent: file edits without asking (commands would still ask).
  const aj = path.join(env.CLAWDLING_HOME, 'projects', agent, 'agent.json');
  fs.writeFileSync(aj, JSON.stringify({ ...JSON.parse(fs.readFileSync(aj, 'utf8')), permission_mode: 'acceptEdits' }, null, 2));

  // One real session does one small piece of work, then ends.
  const s = await api('POST', '/api/sessions', { agent, model: MODEL, prompt: 'Add one line at the end of README.md: "Tomatoes go in the south bed." Use your Edit tool only, run no commands, then tell me in one sentence that it is done.' });
  const t0 = Date.now();
  let v;
  for (;;) {
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`timed out waiting for the work session (last: ${v && v.status} ${v && v.waiting_on})`);
    await sleep(1000);
    v = await api('GET', `/api/sessions/${s.sid}`);
    if (v.status === 'needs_you' && v.waiting_on === 'trust') {
      const yes = (v.choices || []).find((c) => /yes, i trust this folder/i.test(c.label));
      if (yes) {
        await api('POST', `/api/sessions/${s.sid}/answer`, { option: yes.option });
        log('answered the folder-trust question (the only prompt this harness ever approves)');
      }
      continue;
    }
    if (v.status === 'needs_you' && v.waiting_on !== 'startup') throw new Error(`a prompt this harness does not approve: ${v.notification}`);
    if (v.status === 'ready' && v.last_message) break;
  }
  log(`the agent said: ${v.last_message}`);
  await api('POST', `/api/sessions/${s.sid}/send`, { text: '/exit', enter: true });
  for (let i = 0; i < 60 && (await api('GET', `/api/sessions/${s.sid}`)).status !== 'ended'; i++) await sleep(1000);
  results.push({ check: 'the work session changed README.md', ok: /south bed/.test(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')) });

  // Donna, asked exactly the question from the demo.
  const q = 'What got done today, and what needs me?';
  const r = await api('POST', '/api/donna/chat', { text: q });
  const reply = String(r.reply || r.text || r.message || JSON.stringify(r));
  log(`Donna: ${reply}`);
  results.push({ check: 'Donna names what got done (the README change)', ok: /readme|south bed|tomato/i.test(reply) });
  results.push({ check: 'Donna does not say her access was denied', ok: !/denied|no access|couldn.t (pull|read|run|get|check)|unable to (read|run|access)/i.test(reply) });
  // Her own transcript: no tool call she was refused.
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let denied = 0;
  let ranReport = false;
  for (const d of fs.existsSync(projects) ? fs.readdirSync(projects).filter((x) => /donna$/.test(x)) : []) {
    for (const f of fs.readdirSync(path.join(projects, d)).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of fs.readFileSync(path.join(projects, d, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const o = JSON.parse(line);
        for (const b of o.message?.content || []) {
          if (b?.type === 'tool_use' && /clawdling report/.test(b.input?.command || '')) ranReport = true;
          if (b?.type === 'tool_result' && b.is_error && /permission|denied|not allowed|requested permissions/i.test(JSON.stringify(b.content))) denied++;
        }
      }
    }
  }
  log(`Donna's turn: ${denied} denied tool call(s); ran clawdling report: ${ranReport}`);
  results.push({ check: 'Donna\'s turn was denied no tool call', ok: denied === 0 });
}

async function cleanup() {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), sleep(6000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // none
  }
  fs.rmSync(home, { recursive: true, force: true });
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error(`[donna] FAIL: ${err.message}`);
  code = 1;
} finally {
  await cleanup();
}
for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'} ${r.check}`);
if (results.some((r) => !r.ok) || !results.length) code = 1;
process.exit(code);
