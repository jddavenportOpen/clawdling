#!/usr/bin/env node
// Opt-in live smoke test (`npm run smoke:live`): the REAL `claude` CLI, the cheapest model.
//
// Proves the anti-amnesia contract end to end: a brand-new domain agent, spawned through the
// Clawdling server (tmux, or the built-in terminal with CLAWDLING_BACKEND=pty), answers with the
// mission from its CLAUDE.md and the marker from its memory/NOW.md without reading any files, i.e.
// both were preloaded into the session's context. It also reports what the real CLI showed on the
// way (folder-trust dialog, skills). Everything goes through the server's own API and terminal
// WebSocket, the way the cockpit does it, so the same script proves either backend.
//
// Costs a few cents of your Claude plan. Everything it starts is cleaned up; Claude Code keeps its
// own transcript of the run under ~/.claude/projects/ like for any other session.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Terminal } = createRequire(import.meta.url)('@xterm/headless');
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
let backend = null;
const COLS = 140;
const ROWS = 40;
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
  backend = health.backend?.kind || 'tmux';
  log(`server up on ${base}: claude ${health.claude.version}; sessions: ${backend}${backend === 'tmux' ? ` (${health.tmux.version})` : ` (${health.backend.version}, ${health.backend.reason})`}`);

  const s = await api('POST', '/api/sessions', { agent: 'archive', model: MODEL, prompt: PROMPT, cols: COLS, rows: ROWS });
  if (!s?.sid) throw new Error(`spawn failed: ${JSON.stringify(s)}`);
  log(`spawned ${s.tmux_name} (sid ${s.sid}) titled "${s.title}"; attach: ${s.attach_cmd}`);

  // A viewer like the cockpit's, rendered into a headless terminal: the screen, on either backend.
  const view = await openScreen(info.port, tok, s.sid);
  const capture = () => view.screen();
  const keys = (text) => view.ws.send(JSON.stringify({ t: 'in', data: text }));
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
      const yes = (cur.choices || []).find((c) => /yes, i trust this folder/i.test(c.label));
      if (!yes) {
        await sleep(300); // the choices arrive a moment after the status
        continue;
      }
      findings.push(`Claude Code showed its folder-trust dialog for the new org folder; Clawdling surfaced it as needs_you with choices ${JSON.stringify(cur.choices.map((c) => c.label))} and the smoke answered "${yes.label}" through POST /api/sessions/:sid/answer, the cockpit's button (it never edits ~/.claude.json).`);
      log(`trust dialog on screen:\n${capture().split('\n').filter((l) => /trust|exit|❯/i.test(l)).join('\n')}`);
      const r = await api('POST', `/api/sessions/${s.sid}/answer`, { option: yes.option });
      log(`answered option ${yes.option}: ${JSON.stringify(r.answered || r)}`);
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
  // "Ask before editing files" (the default) must be the mode Claude Code is really in: with no
  // --permission-mode, 2.1.283+ opens in auto mode. Its footer and its hooks both say which.
  const footer = capture();
  const shown = /auto mode on/i.test(footer) ? 'auto' : /manual mode on/i.test(footer) ? 'manual' : 'not shown';
  const okMode = shown !== 'auto' && cur.live_mode !== 'auto';
  findings.push(`Permission mode: footer ${shown}, hooks report ${cur.live_mode || 'nothing'} (wanted: asks before editing).`);

  // Skills: type "/handof" (no Enter) and look at Claude Code's own autocomplete.
  keys('/handof');
  await sleep(1500);
  const skillScreen = capture();
  const skillOk = /handoff/.test(skillScreen.split('\n').filter((l) => !l.includes('/handof│') && !/^\s*>\s*\/handof\s*$/.test(l)).join('\n'));
  findings.push(skillOk ? 'The /handoff skill shows up in the domain agent session (autocomplete).' : 'WARNING: /handoff did not show up in autocomplete for the domain agent session.');
  keys('\x1b');
  keys('\x15');
  view.ws.close();

  await api('DELETE', `/api/sessions/${s.sid}`);
  log(`mission phrase in answer: ${okMission ? 'yes' : 'NO'}; NOW.md marker in answer: ${okMarker ? 'yes' : 'NO'}`);
  for (const f of findings) log(f);
  if (!okMission || !okMarker) throw new Error('context/memory preload NOT proven');
  if (!okMode) throw new Error('the session runs in auto mode, though the agent asks before editing files');
  log('PASS: the agent knew its mission (CLAUDE.md) and its memory (memory/NOW.md) on the first turn');
}

/** A terminal viewer over the server's WebSocket, rendered into a headless terminal. */
async function openScreen(port, tok, sid) {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${sid}?t=${tok}&cols=${COLS}&rows=${ROWS}`);
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw));
      if ((m.t === 'snapshot' || m.t === 'out') && typeof m.data === 'string') term.write(m.data);
    } catch {
      // ignore
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const screen = () => {
    const b = term.buffer.active;
    const out = [];
    for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.baseY + i)?.translateToString(true) ?? '');
    return out.join('\n');
  };
  return { ws, screen };
}

async function cleanup() {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), sleep(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (backend !== 'pty') {
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
