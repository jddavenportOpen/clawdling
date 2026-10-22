#!/usr/bin/env node
// Opt-in live smoke test (`npm run smoke:live`): the REAL `claude` CLI, the cheapest model.
//
// Proves the anti-amnesia contract end to end: a brand-new domain agent, spawned through the
// Clawdling server into tmux, answers with the mission from its CLAUDE.md and the marker from its
// memory/NOW.md without reading any files, i.e. both were preloaded into the session's context.
// It also reports what the real CLI showed on the way (folder-trust dialog, skills).
//
// Costs a few cents of your Claude plan. Everything it starts is cleaned up; Claude Code keeps its
// own transcript of the run under ~/.claude/projects/ like for any other session.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'clawdling.js');
const MODEL = process.env.SMOKE_MODEL || 'haiku';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 240000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

if ((process.env.CLAWDLING_CLAUDE_BIN || '').includes('fake-claude') || process.env.CLAWDLING_TEST === '1') {
  console.error('[smoke] refusing: this test needs the real claude (unset CLAWDLING_CLAUDE_BIN / CLAWDLING_TEST)');
  process.exit(2);
}

const rand = crypto.randomBytes(3).toString('hex');
const token = `quokka-lantern-${rand}`;
const mission = `Catalogue the ${token} archive`;
const marker = `NOWMARK-${rand.toUpperCase()}`;
const PROMPT = 'In one sentence, what is your mission? Then say what memory/NOW.md says. Answer from the context you already have; do not use any tools.';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-smoke-')));
const socket = `clawdling-smoke-${process.pid}`;
const env = { ...process.env, CLAWDLING_HOME: home, CLAWDLING_TMUX_SOCKET: socket };
for (const k of ['CLAWDLING_TEST', 'CLAWDLING_CLAUDE_BIN', 'CLAWDLING_SID', 'CLAWDLING_PORT']) delete env[k];

let server;
const findings = [];

async function main() {
  log(`org home ${home}, tmux socket ${socket}, model ${MODEL}`);
  fs.writeFileSync(path.join(home, 'answers.json'), JSON.stringify({ owner: 'Smoke Tester', about: 'Runs the Clawdling live smoke test.', domains: [{ name: 'Archive', mission }] }));
  execFileSync(process.execPath, [CLI, 'init', '--answers', path.join(home, 'answers.json')], { env, stdio: 'inherit' });
  const nowFile = path.join(home, 'domains', 'archive', 'memory', 'NOW.md');
  fs.writeFileSync(nowFile, `# NOW: Archive\n_Last updated: today_\n\n## State\n- Marker: ${marker}\n- Shelf 3 is half catalogued.\n\n## Next steps\n- Finish shelf 3.\n`);

  server = spawn(process.execPath, [CLI, 'start', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOut = '';
  server.stdout.on('data', (d) => (serverOut += d));
  server.stderr.on('data', (d) => (serverOut += d));
  let info = null;
  for (let i = 0; i < 200 && !info; i++) {
    await sleep(100);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, '.clawdling', 'server.json'), 'utf8'));
      if (j.pid === server.pid) info = j;
    } catch {
      // not yet
    }
    if (server.exitCode !== null) throw new Error(`server exited: ${serverOut}`);
  }
  if (!info) throw new Error(`server did not start: ${serverOut}`);
  const tok = fs.readFileSync(path.join(home, '.clawdling', 'token'), 'utf8').trim();
  const base = `http://127.0.0.1:${info.port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'x-clawdling-token': tok, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  const health = await api('GET', '/api/health');
  log(`server up on ${base}: claude ${health.claude.version}, ${health.tmux.version}`);

  const s = await api('POST', '/api/sessions', { agent: 'archive', model: MODEL, prompt: PROMPT });
  if (!s?.sid) throw new Error(`spawn failed: ${JSON.stringify(s)}`);
  log(`spawned ${s.tmux_name} (sid ${s.sid}) titled "${s.title}"`);

  const capture = () => execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', `=${s.tmux_name}:`], { encoding: 'utf8' });
  const keys = (...k) => execFileSync('tmux', ['-L', socket, 'send-keys', '-t', `=${s.tmux_name}:`, ...k]);
  const seen = new Set();
  let trustAnswered = false;
  const started = Date.now();
  let cur = s;
  for (;;) {
    if (Date.now() - started > TIMEOUT_MS) throw new Error(`timed out; last status ${cur.status}; screen:\n${capture()}`);
    await sleep(1000);
    cur = await api('GET', `/api/sessions/${s.sid}`);
    if (!seen.has(cur.status)) {
      seen.add(cur.status);
      log(`status -> ${cur.status}${cur.notification ? ` (${cur.notification})` : ''}`);
    }
    if (cur.status === 'ended') throw new Error(`session ended: ${cur.notification || '(no notice)'}\n${serverOut}`);
    if (cur.status === 'needs_you' && /trust this folder/.test(cur.notification || '') && !trustAnswered) {
      findings.push('Claude Code showed its folder-trust dialog for the new org folder; Clawdling surfaced it as needs_you and the smoke answered it in the terminal like a user (it never edits ~/.claude.json).');
      await sleep(1500); // the dialog ignores keys for a moment after it opens
      for (let i = 0; i < 4; i++) {
        const screen = capture();
        const sel = screen.split('\n').find((l) => l.includes('❯'));
        if (sel && /Yes, I trust this folder/.test(sel)) break;
        keys('Down');
        await sleep(400);
      }
      log(`trust dialog, answering on:\n${capture().split('\n').filter((l) => /trust|exit|❯/i.test(l)).join('\n')}`);
      keys('Enter');
      trustAnswered = true;
      continue;
    }
    if (cur.status === 'needs_you' && !/trust/.test(cur.notification || '')) {
      throw new Error(`unexpected prompt in the session: ${cur.notification}\n${capture()}`);
    }
    if (cur.status === 'ready' && cur.last_message) break;
  }
  log(`turn finished in ${Math.round((Date.now() - started) / 1000)}s`);

  // The answer, from Claude Code's own transcript JSONL.
  const msgs = await api('GET', `/api/sessions/${s.sid}/messages`);
  const transcript = cur.transcript_path;
  const raw = transcript && fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8') : '';
  const assistant = msgs.messages.filter((m) => m.role === 'assistant');
  const answer = assistant.map((m) => m.text).join('\n');
  const toolUses = assistant.flatMap((m) => m.tools);
  log(`transcript: ${transcript}`);
  log(`answer: ${answer.replace(/\n/g, ' ')}`);
  const okMission = answer.toLowerCase().includes(token);
  const okMarker = answer.includes(marker) && raw.includes(marker);
  if (toolUses.length) findings.push(`WARNING: the model used tools (${toolUses.map((t) => t.name).join(', ')}) so preload is not strictly proven`);

  // Skills: type "/handof" (no Enter) and look at Claude Code's own autocomplete.
  keys('-l', '/handof');
  await sleep(1500);
  const skillScreen = capture();
  const skillOk = /handoff/.test(skillScreen.split('\n').filter((l) => !l.includes('/handof│') && !/^\s*>\s*\/handof\s*$/.test(l)).join('\n'));
  findings.push(skillOk ? 'The /handoff skill shows up in the domain agent session (autocomplete).' : 'WARNING: /handoff did not show up in autocomplete for the domain agent session.');
  keys('Escape');
  keys('C-u');

  await api('DELETE', `/api/sessions/${s.sid}`);
  log(`mission phrase in answer: ${okMission ? 'yes' : 'NO'}; NOW.md marker in answer: ${okMarker ? 'yes' : 'NO'}`);
  for (const f of findings) log(f);
  if (!okMission || !okMarker) throw new Error('context/memory preload NOT proven');
  log('PASS: the agent knew its mission (CLAUDE.md) and its memory (memory/NOW.md) on the first turn');
}

async function cleanup() {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), sleep(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // already gone
  }
  try {
    fs.unlinkSync(`${process.env.TMUX_TMPDIR || '/tmp'}/tmux-${process.getuid()}/${socket}`);
  } catch {
    // gone
  }
  fs.rmSync(home, { recursive: true, force: true });
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error(`[smoke] FAIL: ${err.message}`);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
