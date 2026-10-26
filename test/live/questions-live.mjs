#!/usr/bin/env node
// Opt-in live check (`node test/live/questions-live.mjs`): question cards with the REAL `claude`
// CLI, the cheapest model, through the Clawdling server's own API (the route the cockpit's cards
// use). Two sessions in a throwaway org:
//
//   1. "Use AskUserQuestion to ask me which of three colors I like, then say my answer back."
//      The session must report `asking` (a question), the transcript must carry the question and
//      its options, the card's answer {tool_id, answers} must pick the second option, and Claude
//      must say that color back.
//   2. A plan-mode agent asked for a two-step plan: `asking` (a plan) with Claude Code's own
//      choices; the card sends it back with "Tell Claude what to change", and Claude revises it.
//
// The harness answers the folder-trust question and NOTHING else: any other permission prompt
// fails the run (it never approves a tool). Costs a few cents of your Claude plan; everything it
// starts is cleaned up.
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
const log = (...a) => console.log('[questions]', ...a);

if ((process.env.CLAWDLING_CLAUDE_BIN || '').includes('fake-claude') || process.env.CLAWDLING_TEST === '1') {
  console.error('[questions] refusing: this needs the real claude (unset CLAWDLING_CLAUDE_BIN / CLAWDLING_TEST)');
  process.exit(2);
}

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-questions-')));
const socket = `clawdling-questions-${process.pid}`;
const env = { ...process.env, CLAWDLING_HOME: home, CLAWDLING_TMUX_SOCKET: socket };
for (const k of ['CLAWDLING_TEST', 'CLAWDLING_CLAUDE_BIN', 'CLAWDLING_SID', 'CLAWDLING_PORT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) delete env[k];
let server;
const results = [];

async function main() {
  fs.writeFileSync(path.join(home, 'answers.json'), JSON.stringify({ owner: 'Question Tester', about: 'Runs the live question-card check.', domains: [{ name: 'Colors', mission: 'Help with colors' }, { name: 'Planner', mission: 'Plan small tasks' }] }));
  execFileSync(process.execPath, [CLI, 'init', '--answers', path.join(home, 'answers.json')], { env, stdio: 'ignore' });
  // The planner agent starts in plan mode (its own agent.json, in this throwaway org).
  const pj = path.join(home, 'domains', 'planner', 'agent.json');
  fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), permission_mode: 'plan' }, null, 2));

  server = spawn(process.execPath, [CLI, 'start', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  let info = null;
  for (let i = 0; i < 200 && !info; i++) {
    await sleep(100);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, '.clawdling', 'server.json'), 'utf8'));
      if (j.pid === server.pid) info = j;
    } catch {
      // not yet
    }
    if (server.exitCode !== null) throw new Error(`server exited: ${out}`);
  }
  if (!info) throw new Error(`server did not start: ${out}`);
  const tok = fs.readFileSync(path.join(home, '.clawdling', 'token'), 'utf8').trim();
  const base = `http://127.0.0.1:${info.port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'x-clawdling-token': tok, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text}`);
    return data;
  };
  const health = await api('GET', '/api/health');
  log(`server up: claude ${health.claude.version}; sessions: ${health.backend?.kind}`);

  /** Wait for `pred(session)`, answering only the folder-trust question on the way. */
  async function until(sid, pred, label) {
    const t0 = Date.now();
    let lastSeen = null;
    for (;;) {
      if (Date.now() - t0 > TIMEOUT_MS && lastSeen && lastSeen.tmux_name) {
        try {
          log(`screen:\n${execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', `=${lastSeen.tmux_name}:`], { encoding: 'utf8' })}`);
        } catch {
          // no tmux pane
        }
      }
      if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(lastSeen && { status: lastSeen.status, waiting_on: lastSeen.waiting_on, notification: lastSeen.notification, last_message: String(lastSeen.last_message || '').slice(0, 200), asking: lastSeen.asking })})`);
      await sleep(1000);
      const s = await api('GET', `/api/sessions/${sid}`);
      lastSeen = s;
      if (pred(s)) return s;
      if (s.status === 'ended') throw new Error(`session ended while waiting for ${label}: ${s.notification || ''}`);
      if (s.status === 'needs_you' && s.waiting_on === 'trust') {
        const yes = (s.choices || []).find((c) => /yes, i trust this folder/i.test(c.label));
        if (yes) {
          await api('POST', `/api/sessions/${sid}/answer`, { option: yes.option });
          log('answered the folder-trust question (the only prompt this harness ever approves)');
        }
        continue;
      }
      if (s.status === 'needs_you' && s.waiting_on === 'permission_prompt' && !s.asking) {
        await sleep(8000); // a question's `asking` follows its notification within a moment
        const again = await api('GET', `/api/sessions/${sid}`);
        if (again.status === 'needs_you' && !again.asking) {
          const m = await api('GET', `/api/sessions/${sid}/messages`).catch(() => null);
          log(`diagnostics: transcript_path=${again.transcript_path}; entries=${JSON.stringify((m?.messages || []).map((e) => [e.role, (e.tools || []).map((t) => `${t.name}${t.ask ? '+ask' : ''}${t.id ? '#' : ''}`)]))}`);
          throw new Error(`a permission prompt that is not a question; declining to approve it: ${again.notification}`);
        }
      }
    }
  }
  const pendingTool = async (sid, toolId) => (await api('GET', `/api/sessions/${sid}/messages`)).messages.flatMap((m) => m.tools || []).find((t) => t.id === toolId);

  // 1. AskUserQuestion
  const q = await api('POST', '/api/sessions', { agent: 'colors', model: MODEL, prompt: 'Use AskUserQuestion to ask me which of three colors I like, then say my answer back.' });
  let s = await until(q.sid, (x) => x.asking && x.asking.kind === 'question', 'a question');
  log(`asking: ${JSON.stringify(s.asking)}; notice: ${s.notification}`);
  const tool = await pendingTool(q.sid, s.asking.tool_id);
  const opts = tool.ask.questions[0].options.map((o) => o.label);
  log(`the card: "${tool.ask.questions[0].question}" options ${JSON.stringify(opts)}`);
  const pick = opts[1];
  const r = await api('POST', `/api/sessions/${q.sid}/answer`, { tool_id: s.asking.tool_id, answers: [{ choices: [1] }] });
  log(`answered: ${JSON.stringify(r.answered)}`);
  s = await until(q.sid, (x) => x.status === 'ready' && x.last_message, 'the reply');
  const msgs = (await api('GET', `/api/sessions/${q.sid}/messages`)).messages;
  const ans = msgs.find((m) => m.role === 'answer' && m.tool_id === r.answered.tool_id);
  log(`answer entry: ${JSON.stringify(ans && ans.answers)}; Claude said: ${s.last_message}`);
  const ok1 = !!ans && Object.values(ans.answers || {})[0] === pick && s.last_message.toLowerCase().includes(pick.toLowerCase());
  results.push({ check: 'AskUserQuestion answered from the card', ok: ok1, picked: pick, said: s.last_message });
  await api('DELETE', `/api/sessions/${q.sid}`);

  // 1b. A typed answer that starts with a digit: the digit must not jump to an option.
  const t = await api('POST', '/api/sessions', { agent: 'colors', model: MODEL, prompt: 'Use AskUserQuestion to ask me which of three colors I like, then say my answer back word for word.' });
  s = await until(t.sid, (x) => x.asking && x.asking.kind === 'question', 'a second question');
  const typed = '2 shades of teal';
  await api('POST', `/api/sessions/${t.sid}/answer`, { tool_id: s.asking.tool_id, answers: [{ text: typed }] });
  s = await until(t.sid, (x) => x.status === 'ready' && x.last_message, 'the reply to a typed answer');
  const tAns = (await api('GET', `/api/sessions/${t.sid}/messages`)).messages.find((m) => m.role === 'answer');
  log(`typed answer entry: ${JSON.stringify(tAns && tAns.answers)}; Claude said: ${s.last_message}`);
  results.push({ check: 'a typed answer starting with a digit arrives as typed', ok: !!tAns && Object.values(tAns.answers || {})[0] === typed && /teal/i.test(s.last_message) });
  await api('DELETE', `/api/sessions/${t.sid}`);

  // 2. Plan approval: send it back with what to change.
  const p = await api('POST', '/api/sessions', { agent: 'planner', model: MODEL, prompt: 'Write a two-step plan to create hello.txt containing the word hi. Do not research or read anything; call ExitPlanMode with the plan right away.' });
  s = await until(p.sid, (x) => x.asking && x.asking.kind === 'plan' && Array.isArray(x.choices) && x.choices.length, 'a plan');
  log(`plan choices: ${JSON.stringify(s.choices.map((c) => c.label))}`);
  // The card has the plan itself: from the session (its hook) and from the transcript. With 2.1.308
  // the ExitPlanMode input is empty and the plan is Claude Code's plan file (issue #21).
  const cardPlan = (s.asking.card && s.asking.card.plan) || '';
  log(`plan card (from the session): ${cardPlan.replace(/\n/g, ' ').slice(0, 160)}`);
  results.push({ check: 'the plan card shows the plan (not empty)', ok: /hello\.txt/i.test(cardPlan) });
  const fb = s.choices.find((c) => /tell claude what to change/i.test(c.label));
  const first = s.asking.tool_id;
  await api('POST', `/api/sessions/${p.sid}/answer`, { option: fb.option, text: 'Add a third step that prints the file.', tool_id: first });
  s = await until(p.sid, (x) => x.asking && x.asking.kind === 'plan' && x.asking.tool_id !== first, 'the revised plan');
  const revised = await pendingTool(p.sid, s.asking.tool_id);
  const fbEntry = (await api('GET', `/api/sessions/${p.sid}/messages`)).messages.find((m) => m.role === 'answer' && m.tool_id === first);
  log(`feedback entry: ${JSON.stringify(fbEntry && fbEntry.feedback)}; revised plan: ${revised.ask.plan.replace(/\n/g, ' ').slice(0, 200)}`);
  const ok2 = !!fbEntry && /third step/i.test(fbEntry.feedback || '') && /print|cat|display|show/i.test(revised.ask.plan);
  if (!ok2) log(`revised plan in full:\n${revised.ask.plan}`);
  results.push({ check: 'plan sent back from the card and revised', ok: ok2 });
  await api('DELETE', `/api/sessions/${p.sid}`);
}

async function cleanup() {
  // CLAWDLING_LIVE_KEEP=<dir>: keep the run's transcripts and plan files (for a contract fixture),
  // only when HOME is a throwaway folder, never a real one.
  const keep = process.env.CLAWDLING_LIVE_KEEP;
  const throwaway = [os.tmpdir(), '/tmp/', '/private/tmp/'].some((d) => os.homedir().startsWith(d));
  if (keep && throwaway) {
    try {
      fs.cpSync(path.join(os.homedir(), '.claude', 'projects'), path.join(keep, 'projects'), { recursive: true });
      fs.cpSync(path.join(os.homedir(), '.claude', 'plans'), path.join(keep, 'plans'), { recursive: true });
    } catch (err) {
      log(`could not keep the transcripts: ${err.message}`);
    }
  }
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
  console.error(`[questions] FAIL: ${err.message}`);
  code = 1;
} finally {
  await cleanup();
}
for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'} ${r.check}${r.picked ? ` (picked ${r.picked})` : ''}`);
if (results.some((r) => !r.ok) || !results.length) code = 1;
process.exit(code);
