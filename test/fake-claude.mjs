#!/usr/bin/env node
// A fake `claude` for tests. It never talks to any network service.
//
// Interactive mode (inside tmux): prints a banner, runs the hook commands from --settings with
// realistic JSON, echoes every input line back as "assistant: <line>", asks for "permission" when
// a line contains "permission?", and exits on "/exit". If the working directory contains a
// `.fake-claude-trust` file it first shows a folder-trust dialog shaped like the real one (focus on
// "No, exit"; arrow keys move; Enter chooses).
//
// Print mode (-p --output-format json): reads the prompt from stdin. If the owner's message
// mentions "health" it runs `clawdling spawn health "<message>"` through the real CLI on PATH,
// then prints {"type":"result","result":"Health agent is on it."}.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const log = (entry) => {
  if (!process.env.FAKE_CLAUDE_LOG) return;
  try {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...entry }) + '\n');
  } catch {
    // ignore
  }
};

if (argv[0] === '--version' || argv[0] === '-v') {
  console.log('2.1.999 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth') process.exit(0);

// ------------------------------------------------------------------ parse argv like the real CLI
const opts = { addDir: [], allowedTools: [] };
let prompt = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') {
    prompt = argv.slice(i + 1).join(' ');
    break;
  }
  const eq = a.startsWith('--') ? a.indexOf('=') : -1;
  const key = eq === -1 ? a : a.slice(0, eq);
  const val = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
  switch (key) {
    case '-p':
    case '--print':
      opts.print = true;
      break;
    case '--session-id':
      opts.sessionId = val();
      break;
    case '--resume':
    case '-r':
      opts.resume = val();
      break;
    case '--name':
    case '-n':
      opts.name = val();
      break;
    case '--settings':
      opts.settings = val();
      break;
    case '--model':
      opts.model = val();
      break;
    case '--permission-mode':
      opts.permissionMode = val();
      break;
    case '--output-format':
      opts.outputFormat = val();
      break;
    case '--append-system-prompt-file':
      opts.appendSystemPromptFile = val();
      break;
    case '--add-dir':
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) opts.addDir.push(argv[++i]);
      break;
    case '--allowedTools':
    case '--allowed-tools':
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) opts.allowedTools.push(argv[++i]);
      break;
    default:
      if (!a.startsWith('-')) prompt = prompt ? `${prompt} ${a}` : a;
  }
}
const sid = opts.resume || opts.sessionId || crypto.randomUUID();
log({ mode: opts.print ? 'print' : 'interactive', argv, opts, prompt, env: { CLAWDLING_SID: process.env.CLAWDLING_SID, CLAWDLING_HOME: process.env.CLAWDLING_HOME, CLAWDLING_DONNA: process.env.CLAWDLING_DONNA, CLAUDECODE: process.env.CLAUDECODE ?? null, PATH0: (process.env.PATH || '').split(':')[0] } });

// ------------------------------------------------------------------ print mode (Donna turns)
if (opts.print) {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const text = `${prompt}\n${input}`;
    const m = text.match(/<message>\n?([\s\S]*?)\n?<\/message>/);
    const message = (m ? m[1] : text).trim();
    if (/explode/i.test(message)) {
      process.stderr.write('fake claude: simulated failure\n');
      process.exit(1);
    }
    let result = `Noted: ${message.slice(0, 80)}`;
    if (/health/i.test(message)) {
      try {
        const out = execFileSync('clawdling', ['spawn', 'health', message], { encoding: 'utf8', env: process.env, timeout: 30000 });
        log({ mode: 'print-spawned', out });
        result = 'Health agent is on it.';
      } catch (e) {
        log({ mode: 'print-spawn-failed', error: String(e.stderr || e.message) });
        result = `Could not start the health agent: ${String(e.stderr || e.message).trim().slice(0, 120)}`;
      }
    }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: sid }) + '\n');
    process.exit(0);
  });
  process.stdin.resume();
} else {
  interactive().catch((err) => {
    process.stderr.write(`fake claude crashed: ${err.stack}\n`);
    process.exit(1);
  });
}

// ------------------------------------------------------------------ interactive mode
function hookCommands(event) {
  if (!opts.settings) return [];
  let s;
  try {
    s = JSON.parse(fs.readFileSync(opts.settings, 'utf8'));
  } catch {
    return [];
  }
  const groups = s?.hooks?.[event] || [];
  return groups.flatMap((g) => (g.hooks || []).filter((h) => h.type === 'command').map((h) => h.command));
}

// Transcripts go where Claude Code puts them, but only under an explicit CLAUDE_CONFIG_DIR
// (tests set a temp dir), so the fake can never write into a real ~/.claude.
const transcriptPath = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)
  : path.join(os.tmpdir(), `fake-claude-${sid}.jsonl`);

function runHook(event, extra = {}) {
  const payload = JSON.stringify({ session_id: sid, transcript_path: transcriptPath, cwd: process.cwd(), permission_mode: opts.permissionMode || 'default', hook_event_name: event, ...extra });
  return Promise.all(
    hookCommands(event).map(
      (cmd) =>
        new Promise((resolve) => {
          const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          const t = setTimeout(() => child.kill('SIGKILL'), 5000);
          child.on('close', (code) => {
            clearTimeout(t);
            log({ mode: 'hook', event, code, stdout: out });
            resolve();
          });
          child.stdin.end(payload);
        })
    )
  );
}

function transcript(type, message, extra = {}) {
  try {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.appendFileSync(transcriptPath, JSON.stringify({ type, message, sessionId: sid, timestamp: new Date().toISOString(), isSidechain: false, cwd: process.cwd(), ...extra }) + '\n');
  } catch {
    // ignore
  }
}

async function trustDialog() {
  if (!fs.existsSync(path.join(process.cwd(), '.fake-claude-trust'))) return true;
  let sel = 0; // 0 = No, exit (focused first, like the real dialog); 1 = Yes
  const draw = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(`Accessing workspace:\r\n${process.cwd()}\r\n\r\n`);
    process.stdout.write('Quick safety check: Is this a project you created or one you trust?\r\n\r\n');
    process.stdout.write(`${sel === 0 ? '❯' : ' '} No, exit\r\n`);
    process.stdout.write(`${sel === 1 ? '❯' : ' '} Yes, I trust this folder\r\n`);
  };
  draw();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  return new Promise((resolve) => {
    const onData = (d) => {
      const s = d.toString('latin1');
      if (s.includes('\x1b[A') || s.includes('\x1b[B')) {
        sel = 1 - sel;
        draw();
        return;
      }
      if (s.includes('\r')) {
        process.stdin.off('data', onData);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        resolve(sel === 1);
      }
    };
    process.stdin.on('data', onData);
  });
}

async function interactive() {
  const trusted = await trustDialog();
  if (!trusted) {
    process.stdout.write('\r\nExiting.\r\n');
    process.exit(1);
  }
  process.stdout.write('\x1b[?2004h'); // ask for bracketed paste, like the real TUI
  process.stdout.write(`\x1b[1mFake Claude Code\x1b[0m | ${opts.name || 'unnamed'} | session ${sid}${opts.model ? ` | model ${opts.model}` : ''}\n`);
  process.stdout.write(`cwd ${process.cwd()}\n`);
  await runHook('SessionStart', { source: opts.resume ? 'resume' : 'startup', model: opts.model || 'fake' });
  let waitingPermission = false;
  const handle = async (raw) => {
    const text = raw.replace(/\x1b\[20[01]~/g, '').trim();
    if (!text) return;
    if (waitingPermission) {
      waitingPermission = false;
      process.stdout.write('assistant: permission answered, done\n> ');
      await runHook('Stop', { stop_hook_active: false, last_assistant_message: 'permission answered, done' });
      return;
    }
    if (text === '/exit') {
      await runHook('SessionEnd', { reason: 'prompt_input_exit' });
      process.exit(0);
    }
    await runHook('UserPromptSubmit', { prompt: text });
    transcript('user', { role: 'user', content: '<local-command-caveat>Caveat: plumbing the chat view must hide</local-command-caveat>' }, { isMeta: true });
    transcript('user', { role: 'user', content: text });
    if (text.includes('permission?')) {
      transcript('assistant', { role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'I need to run a command.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi', description: 'Say hi' } }] });
      transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi' }] });
      waitingPermission = true;
      process.stdout.write('Claude wants to run: echo hi. Allow? 1) yes 2) no\n');
      await runHook('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
      return;
    }
    process.stdout.write(`assistant: ${text}\n> `);
    transcript('assistant', { role: 'assistant', model: 'fake', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: `assistant: ${text}` }] });
    await runHook('Stop', { stop_hook_active: false, last_assistant_message: text });
  };
  let chain = Promise.resolve();
  if (prompt) chain = chain.then(() => handle(prompt));
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    chain = chain.then(() => handle(line));
  });
  rl.on('close', () => chain.then(() => process.exit(0)));
  process.on('SIGHUP', () => process.exit(0));
}
