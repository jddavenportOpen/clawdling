#!/usr/bin/env node
// Claude Code hook → Clawdling server. Registered for SessionStart, UserPromptSubmit, Stop,
// Notification and SessionEnd via the generated --settings file, and for PreToolUse of the two
// tools that ask the person something (AskUserQuestion, ExitPlanMode: the chat's question cards).
//
// Contract: never block or alter Claude. It prints nothing (stdout of some hooks is added to the
// conversation), always exits 0, and gives up after 1.5 seconds. If the event is not delivered
// (server down, starting, erroring or slow) it is appended to .clawdling/hook-spool.jsonl and
// replayed when the server starts; the server drops replayed events older than what it has.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const DEADLINE_MS = 1500;
const done = () => process.exit(0);
process.on('uncaughtException', done);
process.on('unhandledRejection', done);

const event = process.argv[2];
const sid = process.env.CLAWDLING_SID;
const home = process.env.CLAWDLING_HOME;
if (!sid || !home || !event) done();
let inFlight = null; // the record being delivered, spooled if the deadline hits first
setTimeout(() => {
  if (inFlight) spool(inFlight);
  done();
}, DEADLINE_MS).unref();

const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= 2 * 1024 * 1024) chunks.push(c);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 800).unref();
  });
}

let spooled = false;
function spool(record) {
  if (spooled) return;
  spooled = true;
  try {
    const file = path.join(home, '.clawdling', 'hook-spool.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) return;
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {
    // nothing else to do
  }
}

async function main() {
  let payload = {};
  try {
    const raw = await readStdin();
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  // Only what the server needs; keep the request small and fast.
  const slim = {
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    source: payload.source,
    reason: payload.reason,
    prompt: clip(payload.prompt, 2000),
    message: clip(payload.message, 500),
    title: clip(payload.title, 200),
    notification_type: payload.notification_type,
    last_assistant_message: clip(payload.last_assistant_message, 1000),
    error: clip(payload.error, 80),
    error_details: clip(payload.error_details, 500),
    permission_mode: clip(payload.permission_mode, 40), // the mode the session is in now
  };
  // A question or a plan Claude is about to show: its id and input (only these two tools, bounded).
  if ((event === 'PreToolUse' || event === 'PostToolUse') && (payload.tool_name === 'AskUserQuestion' || payload.tool_name === 'ExitPlanMode')) {
    slim.tool_name = payload.tool_name;
    slim.tool_use_id = clip(payload.tool_use_id, 100);
    const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : null;
    if (event === 'PreToolUse' && input && JSON.stringify(input).length <= 64 * 1024) slim.tool_input = input;
  }
  // The CTO seat (1.7) reports every tool call: its id and name, and the command only when it is a
  // cross-agent message (`clawdling send` / `clawdling spawn`), which the cockpit shows beside
  // Claude Code's own prompt. No other command or input is forwarded.
  if ((event === 'PreToolUse' || event === 'PostToolUse') && !slim.tool_name && typeof payload.tool_name === 'string') {
    slim.tool_name = clip(payload.tool_name, 100);
    slim.tool_use_id = clip(payload.tool_use_id, 100);
    const cmd = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : '';
    if (event === 'PreToolUse' && (payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell') && /^\s*clawdling(?:\.cmd|\.ps1)?\s+(?:send|spawn)\b/.test(cmd)) slim.tool_input = { command: clip(cmd, 4000) };
  }
  const record = { event, sid, payload: slim, ts: new Date().toISOString(), ...(process.env.CLAWDLING_LAUNCH ? { launch: process.env.CLAWDLING_LAUNCH } : {}) };
  let token = '';
  let port = Number(process.env.CLAWDLING_PORT) || 0;
  try {
    token = fs.readFileSync(path.join(home, '.clawdling', 'token'), 'utf8').trim();
  } catch {
    spool(record);
    return done();
  }
  try {
    // The server may have restarted on another port since this session started.
    const info = JSON.parse(fs.readFileSync(path.join(home, '.clawdling', 'server.json'), 'utf8'));
    if (Number.isInteger(info.port) && info.port > 0) port = info.port;
  } catch {
    // fall back to CLAWDLING_PORT
  }
  if (!port) {
    spool(record);
    return done();
  }
  const body = JSON.stringify(record);
  inFlight = record;
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/hooks',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-clawdling-token': token },
      timeout: DEADLINE_MS - 200,
    },
    (res) => {
      // Anything but a 2xx (a 503 while the server starts, a 5xx) is replayed later.
      if (res.statusCode < 200 || res.statusCode > 299) spool(record);
      inFlight = null;
      res.resume();
      res.on('end', done);
    }
  );
  req.on('timeout', () => {
    // The server may still have applied it; replay drops events older than what it has.
    spool(record);
    req.destroy();
    done();
  });
  req.on('error', () => {
    spool(record);
    done();
  });
  req.end(body);
}

main().catch(done);
