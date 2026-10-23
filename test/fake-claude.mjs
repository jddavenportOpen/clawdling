#!/usr/bin/env node
// A fake `claude` for tests. It never talks to any network service.
//
// Interactive mode (in a tmux pane or a pty): prints a banner, runs the hook commands from
// --settings with realistic JSON (shell form through /bin/sh, exec form directly, like Claude Code),
// echoes every input line back as "assistant: <line>", asks for "permission" when a line contains
// "permission?", and exits on "/exit". If the working directory contains a `.fake-claude-trust` file
// it first shows a folder-trust dialog shaped like the real one (focus on "No, exit"; arrow keys
// move; Enter chooses). A `.fake-claude-login` file makes it stop at the sign-in screen of a Claude
// Code that is not logged in ("Select login method:"), for good. It logs its terminal size at start
// and on every resize ({mode: "size"}).
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
// The --permission-mode line of `claude --help`, as 2.1.283 prints it. FAKE_CLAUDE_MODES picks
// the choices (comma-separated), to test a Claude Code that names them differently.
if (argv[0] === '--help' || argv[0] === '-h') {
  const modes = (process.env.FAKE_CLAUDE_MODES || 'acceptEdits,auto,bypassPermissions,manual,dontAsk,plan').split(',');
  console.log(`Usage: claude [options] [command] [prompt]\n\nOptions:\n  --permission-mode <mode>              Permission mode to use for the session\n                                        (choices: ${modes.map((m) => `"${m}"`).join(', ')})\n  -h, --help                            Display help for command`);
  process.exit(0);
}

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
    case '--effort':
      opts.effort = val();
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
    case '--setting-sources':
      opts.settingSources = val();
      break;
    case '--strict-mcp-config':
      opts.strictMcpConfig = true;
      break;
    case '--add-dir':
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) opts.addDir.push(argv[++i]);
      break;
    case '--disallowedTools':
    case '--disallowed-tools':
      opts.disallowedTools = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) opts.disallowedTools.push(argv[++i]);
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
log({ mode: opts.print ? 'print' : 'interactive', argv, opts, prompt, env: { CLAWDLING_SID: process.env.CLAWDLING_SID, CLAWDLING_HOME: process.env.CLAWDLING_HOME, CLAWDLING_DONNA: process.env.CLAWDLING_DONNA, CLAUDECODE: process.env.CLAUDECODE ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, PATH0: (process.env.PATH || '').split(path.delimiter)[0] } });

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
        // Through a shell, like Claude Code's own shell tool (on Windows: cmd.exe and the .cmd shim).
        const out = process.platform === 'win32'
          ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"clawdling spawn health "${message.replace(/["%^&|<>!]/g, '')}""`], { encoding: 'utf8', env: process.env, timeout: 30000, windowsVerbatimArguments: true, windowsHide: true })
          : execFileSync('clawdling', ['spawn', 'health', message], { encoding: 'utf8', env: process.env, timeout: 30000 });
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
  return groups.flatMap((g) => (g.hooks || []).filter((h) => h.type === 'command'));
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
      (h) =>
        new Promise((resolve) => {
          // Exec form (`args`) spawns the program directly; shell form goes to sh -c.
          const child = Array.isArray(h.args)
            ? spawn(h.command, h.args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true })
            : spawn('/bin/sh', ['-c', h.command], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
          child.on('error', (err) => {
            log({ mode: 'hook', event, code: null, error: err.message, stdout: '' });
            resolve();
          });
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

/**
 * A select list drawn like Claude Code's: "❯" on the chosen line, arrows move, Enter chooses.
 * With numbered choices (permission prompts) a digit chooses at once; the folder-trust dialog
 * hides its numbers and ignores digits, as the real one does (claude 2.1.283).
 */
function select({ header, choices, focus = 0, numbered = false }) {
  return new Promise((resolve) => {
    let sel = focus;
    let drawn = 0;
    const draw = () => {
      if (drawn) process.stdout.write(`\x1b[${drawn}A\r\x1b[J`);
      const lines = [...header, ...choices.map((c, i) => ` ${i === sel ? '\u276f' : ' '} ${numbered ? `${i + 1}. ` : ''}${c}`), '', ' Enter to confirm \u00b7 Esc to cancel'];
      process.stdout.write(lines.join('\r\n') + '\r\n');
      drawn = lines.length;
    };
    draw();
    const raw = process.stdin.isTTY && !process.stdin.isRaw;
    if (raw) process.stdin.setRawMode(true);
    const onData = (d) => {
      const s = d.toString('latin1');
      let chosen = -1;
      if (s.includes('\x1b[A')) {
        sel = Math.max(0, sel - 1);
        draw();
      } else if (s.includes('\x1b[B')) {
        sel = Math.min(choices.length - 1, sel + 1);
        draw();
      } else if (s.includes('\r')) chosen = sel;
      else if (numbered && /^[1-9]$/.test(s) && Number(s) <= choices.length) chosen = Number(s) - 1;
      if (chosen === -1) return;
      process.stdin.off('data', onData);
      if (raw) process.stdin.setRawMode(false);
      resolve(chosen);
    };
    process.stdin.on('data', onData);
  });
}

async function trustDialog() {
  if (!fs.existsSync(path.join(process.cwd(), '.fake-claude-trust'))) return true;
  process.stdout.write('\x1b[2J\x1b[H');
  const header = [' Accessing workspace:', '', ` ${process.cwd()}`, '', ' Quick safety check: Is this a project you created or one you trust?', ''];
  // Focus starts on "No, exit", like the real dialog.
  const choice = await select({ header, choices: ['No, exit', 'Yes, I trust this folder'], focus: 0 });
  return choice === 1;
}

function logSize() {
  log({ mode: 'size', sid, cols: process.stdout.columns ?? null, rows: process.stdout.rows ?? null });
}

// Claude Code 2.1.283 when it is not signed in: the login-method list before anything else.
async function loginScreen() {
  if (!fs.existsSync(path.join(process.cwd(), '.fake-claude-login'))) return;
  process.stdout.write('\x1b[2J\x1b[H');
  const header = [' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.', '', ' Select login method:', ''];
  await select({ header, choices: ['Claude account with subscription · Pro, Max, Team, or Enterprise', 'Anthropic Console account · API usage billing'], focus: 0, numbered: true });
  await new Promise(() => {}); // the real one opens a browser; the fake waits until the session ends
}

async function interactive() {
  logSize();
  process.stdout.on('resize', logSize);
  await loginScreen();
  const trusted = await trustDialog();
  if (!trusted) {
    process.stdout.write('\r\nExiting.\r\n');
    process.exit(1);
  }
  process.stdout.write('\x1b[?2004h'); // ask for bracketed paste, like the real TUI
  process.stdout.write(`\x1b[1mFake Claude Code\x1b[0m | ${opts.name || 'unnamed'} | session ${sid}${opts.model ? ` | model ${opts.model}` : ''}\n`);
  process.stdout.write(`cwd ${process.cwd()}\n`);
  await runHook('SessionStart', { source: opts.resume ? 'resume' : 'startup', model: opts.model || 'fake' });
  let inSelect = false;
  const handle = async (raw) => {
    const text = raw.replace(/\x1b\[20[01]~/g, '').trim();
    if (!text) return;
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
      inSelect = true;
      const asked = select({
        header: [' Bash command', '   echo hi', '   Say hi', '', ' Do you want to proceed?'],
        choices: ['Yes', "Yes, and don't ask again for echo commands", 'No, and tell Claude what to do differently (esc)'],
        numbered: true,
      });
      await runHook('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
      const choice = await asked;
      inSelect = false;
      const answer = ['yes', 'yes, always', 'no'][choice];
      process.stdout.write(`assistant: permission answered (${answer}), done\n> `);
      await runHook('Stop', { stop_hook_active: false, last_assistant_message: `permission answered (${answer}), done` });
      return;
    }
    // "fail: <error>" ends the turn the way an API error does in Claude Code 2.1.229+: StopFailure, no Stop.
    const failed = /^fail: (\w+)/.exec(text);
    if (failed) {
      const message = failed[1] === 'authentication_failed' ? 'Not logged in · Please run /login' : `API Error: ${failed[1]}`;
      process.stdout.write(`  ⎿  ${message}\n> `);
      await runHook('StopFailure', { error: failed[1], ...(failed[1] === 'rate_limit' ? { error_details: "You've hit your limit · resets 3pm" } : {}), last_assistant_message: message });
      return;
    }
    process.stdout.write(`assistant: ${text}\n> `);
    transcript('assistant', { role: 'assistant', model: 'fake', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: `assistant: ${text}` }] });
    await runHook('Stop', { stop_hook_active: false, last_assistant_message: text });
  };
  let chain = Promise.resolve();
  if (prompt) chain = chain.then(() => handle(prompt));
  if (process.platform === 'win32' && process.stdin.isTTY) {
    // Like Claude Code, read keys in raw mode: a cooked Windows console treats ESC (the start of a
    // bracketed-paste marker) as "clear the line". Echo and assemble lines here.
    process.stdin.setRawMode(true);
    let line = '';
    process.stdin.on('data', (d) => {
      if (inSelect) return; // keys meant for a select list, not a prompt
      const keys = d.toString('utf8').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO./g, '');
      for (const ch of keys) {
        if (ch === '\r' || ch === '\n') {
          process.stdout.write('\r\n');
          const l = line;
          line = '';
          chain = chain.then(() => handle(l));
        } else if (ch === '\x7f' || ch === '\b') {
          if (line) {
            line = line.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch === '\x03') process.exit(130);
        else if (ch >= ' ') {
          line += ch;
          process.stdout.write(ch);
        }
      }
    });
    process.stdin.on('end', () => chain.then(() => process.exit(0)));
  } else {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (inSelect) return; // keys meant for a select list, not a prompt
      chain = chain.then(() => handle(line));
    });
    rl.on('close', () => chain.then(() => process.exit(0)));
  }
  process.on('SIGHUP', () => process.exit(0));
}
