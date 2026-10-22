#!/usr/bin/env node
// Claude Code hook → Clawdling server. Registered for SessionStart, UserPromptSubmit, Stop,
// Notification and SessionEnd via the generated --settings file.
//
// Contract: never block or alter Claude. It prints nothing (stdout of some hooks is added to the
// conversation), always exits 0, and gives up after 1.5 seconds. If the server is down the event
// is appended to .clawdling/hook-spool.jsonl and replayed when the server starts again.
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
setTimeout(done, DEADLINE_MS).unref();

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

function spool(record) {
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
  };
  const record = { event, sid, payload: slim, ts: new Date().toISOString() };
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
      res.resume();
      res.on('end', done);
    }
  );
  req.on('timeout', () => {
    req.destroy();
    done();
  });
  req.on('error', (err) => {
    if (err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH')) spool(record);
    done();
  });
  req.end(body);
}

main().catch(done);
