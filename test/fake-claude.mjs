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
//
// Check-ups (1.6): with --json-schema it answers the schema (five drafted cases, or a judge verdict:
// PASS for a non-empty answer that does not say WRONG; every answer with FAKE_CLAUDE_JUDGE=lenient);
// with --output-format stream-json it is an agent run: reads CLAUDE.md, answers from its context,
// and prints a result with total_cost_usd (FAKE_CLAUDE_RUN_COST, default 0.05; judges and drafts
// FAKE_CLAUDE_PRINT_COST, default 0.01). A prompt with "ask me" is denied AskUserQuestion, one with
// "sleep" sleeps 30 s, one with "write" writes created.txt.
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
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ppid: process.ppid, cwd: process.cwd(), ...entry }) + '\n');
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
    case '--json-schema':
      opts.jsonSchema = val();
      break;
    case '--max-budget-usd':
      opts.maxBudget = Number(val());
      break;
    case '--max-turns':
      opts.maxTurns = Number(val());
      break;
    case '--tools':
      opts.tools = val();
      break;
    case '--append-system-prompt':
      opts.appendSystemPrompt = val();
      break;
    case '--no-session-persistence':
    case '--disable-slash-commands':
    case '--verbose':
      opts[key.replace(/^--/, '')] = true;
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
log({ mode: opts.print ? 'print' : 'interactive', argv, opts, prompt, env: { CLAWDLING_SID: process.env.CLAWDLING_SID, CLAWDLING_HOME: process.env.CLAWDLING_HOME, CLAWDLING_DONNA: process.env.CLAWDLING_DONNA, CLAUDECODE: process.env.CLAUDECODE ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS ?? null, PATH0: (process.env.PATH || '').split(path.delimiter)[0] } });

// ------------------------------------------------------------------ print mode (Donna turns)
if (opts.print && (opts.jsonSchema || opts.outputFormat === 'stream-json')) {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => checkupPrint(input).catch((err) => {
    process.stderr.write(`fake claude: ${err.stack}\n`);
    process.exit(1);
  }));
  process.stdin.resume();
} else if (opts.print) {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const text = `${prompt}\n${input}`;
    log({ mode: 'print-input', input: input.slice(0, 20000) });
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
function hookCommands(event, toolName = null) {
  if (!opts.settings) return [];
  let s;
  try {
    s = JSON.parse(fs.readFileSync(opts.settings, 'utf8'));
  } catch {
    return [];
  }
  // Tool events run only the groups whose matcher matches the tool, like Claude Code.
  const groups = (s?.hooks?.[event] || []).filter((g) => !toolName || !g.matcher || new RegExp(`^(?:${g.matcher})$`).test(toolName));
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
    hookCommands(event, extra.tool_name || null).map(
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

// What the "work?" turns used, for the cost-state record written at /exit.
const usd = { total: 0, turns: 0, input: 0, output: 0, read: 0, write: 0 };

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

// ------------------------------------------------ AskUserQuestion and plan approval, as 2.1.283 draws them
const RULE = '─'.repeat(72);
const DOTS = '╌'.repeat(70);

/** A full-screen list the way Claude Code's question and plan prompts behave: arrows move, Enter
 * acts, printable keys type into a free-text line. `view(state)` returns the lines; `key(state, k)`
 * returns a result to finish, or undefined to keep going. */
function screenUi(state, view, key) {
  return new Promise((resolve) => {
    let drawn = 0;
    const draw = () => {
      if (drawn) process.stdout.write(`\x1b[${drawn}A\r\x1b[J`);
      const lines = view(state);
      process.stdout.write(lines.join('\r\n') + '\r\n');
      drawn = lines.length;
    };
    draw();
    const raw = process.stdin.isTTY && !process.stdin.isRaw;
    if (raw) process.stdin.setRawMode(true);
    const onData = (d) => {
      const s = d.toString('utf8');
      let out;
      for (const k of s.match(/\x1b\[[A-D]|\x1b\[20[01]~|\x1b|\r|\x7f|\x08|[^\x1b\r\x7f\x08]/gu) || []) {
        if (/^\x1b\[20[01]~$/.test(k)) continue;
        out = key(state, k);
        if (out !== undefined) break;
      }
      draw();
      if (out === undefined) return;
      process.stdin.off('data', onData);
      if (raw) process.stdin.setRawMode(false);
      resolve(out);
    };
    process.stdin.on('data', onData);
  });
}

function questionView(questions, qi) {
  const q = questions[qi];
  const multi = questions.length > 1;
  return (st) => {
    const n = q.options.length;
    const lines = [RULE];
    lines.push(multi ? `←  ${questions.map((x, i) => `${i < qi ? '☒' : '☐'} ${x.header}`).join('  ')}  ✔ Submit  →` : ` ☐ ${q.header}`);
    lines.push('', q.question, '');
    const box = (i) => (q.multiSelect ? `[${st.checked.has(i) ? '✔' : ' '}] ` : '');
    q.options.forEach((o, i) => {
      lines.push(`${st.sel === i ? '❯' : ' '} ${i + 1}. ${box(i)}${o.label}`);
      if (o.description) lines.push(`${q.multiSelect ? '         ' : '     '}${o.description}`);
    });
    lines.push(`${st.sel === n ? '❯' : ' '} ${n + 1}. ${q.multiSelect ? '[ ] ' : ''}${st.typed || (q.multiSelect ? 'Type something' : 'Type something.')}`);
    if (q.multiSelect) lines.push(`${st.sel === n + 1 ? '❯' : ' '}    Submit`);
    lines.push(RULE, `  ${n + 2}. Chat about this`, '', 'Enter to select · ↑/↓ to navigate · Esc to cancel');
    return lines;
  };
}

function questionKey(q) {
  const n = q.options.length;
  const last = q.multiSelect ? n + 1 : n;
  return (st, k) => {
    if (k === '\x1b[A') st.sel = Math.max(0, st.sel - 1);
    else if (k === '\x1b[B') st.sel = Math.min(last, st.sel + 1);
    else if (k === '\x1b') return { cancel: true };
    else if (k === '\r') {
      if (q.multiSelect) {
        if (st.sel < n) {
          if (st.checked.has(st.sel)) st.checked.delete(st.sel);
          else st.checked.add(st.sel);
        } else if (st.sel === last) return { answer: [...st.checked].sort().map((i) => q.options[i].label).join(', ') };
        return undefined;
      }
      if (st.sel < n) return { answer: q.options[st.sel].label };
      if (st.typed) return { answer: st.typed };
    } else if (k === '\x7f' || k === '\x08') {
      if (st.sel === n) st.typed = st.typed.slice(0, -1);
    } else if (st.sel === n && k >= ' ') st.typed += k;
    return undefined;
  };
}

async function askUserQuestion(questions) {
  const id = `toolu_ask${crypto.randomBytes(5).toString('hex')}`;
  // Like Claude Code 2.1.283: PreToolUse first; the tool_use line reaches the transcript only once
  // it is answered (a real session showed nothing in the transcript while the question was open).
  await runHook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: id });
  const late = () => transcript('assistant', { role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] });
  process.stdout.write('\x1b[2J\x1b[H');
  const notified = runHook('Notification', { message: 'Claude needs your permission', notification_type: 'permission_prompt' });
  const answers = {};
  let cancelled = false;
  for (let qi = 0; qi < questions.length && !cancelled; qi++) {
    const q = questions[qi];
    const r = await screenUi({ sel: 0, typed: '', checked: new Set() }, questionView(questions, qi), questionKey(q));
    if (r.cancel) cancelled = true;
    else answers[q.question] = r.answer;
  }
  if (!cancelled && questions.length > 1) {
    const review = (st) => [RULE, `←  ${questions.map((x) => `☒ ${x.header}`).join('  ')}  ✔ Submit  →`, '', 'Review your answers', '',
      ...questions.flatMap((q) => [` ● ${q.question}`, `   → ${answers[q.question]}`]), '', 'Ready to submit your answers?', '',
      `${st.sel === 0 ? '❯' : ' '} 1. Submit answers`, `${st.sel === 1 ? '❯' : ' '} 2. Cancel`];
    const r = await screenUi({ sel: 0 }, review, (st, k) => {
      if (k === '\x1b[A') st.sel = 0;
      else if (k === '\x1b[B') st.sel = 1;
      else if (k === '\r') return st.sel === 0 ? {} : { cancel: true };
      return undefined;
    });
    if (r.cancel) cancelled = true;
  }
  await notified;
  late();
  if (cancelled) {
    transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: "The user doesn't want to proceed with this tool use." }] }, { toolUseResult: 'User rejected tool use' });
    return null;
  }
  await runHook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: id });
  const said = Object.entries(answers).map(([k, v]) => `"${k}"="${v}"`).join(', ');
  transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: ${said}. You can now continue with these answers in mind.` }] }, { toolUseResult: { questions, answers, annotations: {} } });
  return answers;
}

const PLAN_CHOICES = ['Yes, auto-accept edits', 'Yes, manually approve edits', 'Tell Claude what to change'];

async function planApproval(plan, { file = false } = {}) {
  const id = `toolu_plan${crypto.randomBytes(5).toString('hex')}`;
  // "planfile?": Claude Code 2.1.308's shape (issue #21): the plan goes to its plan file,
  // <config dir>/plans/<slug>.md, with a Write, and ExitPlanMode is called with an empty input.
  let input = { plan };
  if (file && process.env.CLAUDE_CONFIG_DIR) {
    const planFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'plans', 'fake-hopping-plan.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, plan);
    const wid = `toolu_w${crypto.randomBytes(5).toString('hex')}`;
    transcript('assistant', { role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id: wid, name: 'Write', input: { file_path: planFile, content: plan } }] });
    transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: wid, content: `File created successfully at: ${planFile}` }] });
    input = {};
  }
  await runHook('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: input, tool_use_id: id });
  process.stdout.write('\x1b[2J\x1b[H');
  const notified = runHook('Notification', { message: 'Claude Code needs your approval for the plan', notification_type: 'permission_prompt' });
  const view = (st) => [`  ${RULE}`, '   Ready to code?', "   Here is Claude's plan:", `  ${DOTS}`, ...plan.split('\n').filter(Boolean).map((l) => `   ${l.replace(/^#+\s*/, '')}`), `  ${DOTS}`,
    `  ${RULE}`, '   Claude has written up a plan and is ready to execute. Would you like to proceed?', '',
    ...PLAN_CHOICES.map((c, i) => `   ${st.sel === i ? '❯' : ' '} ${i + 1}. ${i === 2 && st.typed ? st.typed : c}`), '      shift+tab to approve with this feedback', '', '   ctrl+g to edit in Vim'];
  const r = await screenUi({ sel: 0, typed: '' }, view, (st, k) => {
    if (k === '\x1b[A') st.sel = Math.max(0, st.sel - 1);
    else if (k === '\x1b[B') st.sel = Math.min(2, st.sel + 1);
    else if (k === '\r') {
      if (st.sel < 2) return { approve: st.sel };
      if (st.typed) return { feedback: st.typed };
    } else if (k === '\x7f' || k === '\x08') {
      if (st.sel === 2) st.typed = st.typed.slice(0, -1);
    } else if (st.sel === 2 && k >= ' ') st.typed += k;
    return undefined;
  });
  await notified;
  transcript('assistant', { role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input }] });
  // A plan sent back is a rejected tool call: Claude Code runs no PostToolUse for it (only for a
  // tool that went through).
  if (r.feedback === undefined) await runHook('PostToolUse', { tool_name: 'ExitPlanMode', tool_use_id: id });
  if (r.feedback !== undefined) {
    transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${r.feedback}` }] }, { toolUseResult: `Error: The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\n${r.feedback}` });
    return { feedback: r.feedback };
  }
  transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `User has approved your plan. You can now start coding.\n\n## Approved Plan:\n${plan}` }] }, { toolUseResult: { plan, isAgent: false } });
  return { approved: PLAN_CHOICES[r.approve] };
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
      // Like Claude Code: the cumulative cost-state record when the session exits.
      if (usd.total > 0) transcript('cost-state', undefined, { totalCostUSD: usd.total, hasUnknownModelCost: false, totalAPIDuration: 1200, totalToolDuration: 300, totalLinesAdded: 3, totalLinesRemoved: 0, totalDuration: 5000, startTime: Date.now() - 5000, modelUsage: { 'claude-sonnet-5': { inputTokens: usd.input, outputTokens: usd.output, cacheReadInputTokens: usd.read, cacheCreationInputTokens: usd.write, costUSD: usd.total } }, timestamp: undefined });
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
    // "ask?" / "ask2?": AskUserQuestion (one question; or two, the second multiSelect). "plan?": ExitPlanMode.
    if (text.includes('ask?') || text.includes('ask2?') || text.includes('plan?') || text.includes('planperm?') || text.includes('planfile?')) {
      inSelect = true;
      let said;
      if (text.includes('plan?') || text.includes('planperm?') || text.includes('planfile?')) {
        const r = await planApproval('# Make hello.txt\n\n## Plan\n1. Create hello.txt.\n2. Write hi into it.', { file: text.includes('planfile?') });
        said = r.feedback !== undefined ? `plan feedback: ${r.feedback}` : `plan approved (${r.approved})`;
        // "planperm?": sent back, Claude carries on in the same turn and asks to run a command.
        if (text.includes('planperm?') && r.feedback !== undefined) {
          process.stdout.write('\x1b[2J\x1b[H');
          const asked = select({ header: [' Bash command', '   ls', '   List files', '', ' Do you want to proceed?'], choices: ['Yes', "Yes, and don't ask again for ls commands", 'No, and tell Claude what to do differently (esc)'], numbered: true });
          await runHook('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
          const choice = await asked;
          said = `plan feedback, then permission ${['yes', 'yes, always', 'no'][choice]}`;
        }
      } else {
        const questions = [{ question: 'Which color do you like best?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'A warm, bold color.' }, { label: 'Green', description: 'A calm, natural color.' }, { label: 'Blue', description: 'A cool, steady color.' }] }];
        if (text.includes('ask2?')) questions.push({ question: 'Which pets do you like?', header: 'Pets', multiSelect: true, options: [{ label: 'Cat', description: 'Independent.' }, { label: 'Dog', description: 'Loyal.' }, { label: 'Fish', description: 'Quiet.' }] });
        const answers = await askUserQuestion(questions);
        said = answers ? `you chose ${Object.values(answers).join(' / ')}` : 'you declined to answer';
      }
      inSelect = false;
      transcript('assistant', { role: 'assistant', model: 'fake', content: [{ type: 'text', text: `assistant: ${said}` }] });
      process.stdout.write(`assistant: ${said}\n> `);
      await runHook('Stop', { stop_hook_active: false, last_assistant_message: said });
      return;
    }
    // "watch?": start a background shell and a 10-minute Monitor; "unwatch?": both end.
    if (text.includes('unwatch?')) {
      for (const [tid, tu] of [['bfakesh01', 'toolu_bgsh'], ['bfakemo01', 'toolu_bgmo']]) {
        transcript('queue-operation', undefined, { operation: 'enqueue', content: `<task-notification>\n<task-id>${tid}</task-id>\n<tool-use-id>${tu}</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>` });
      }
    } else if (text.includes('watch?')) {
      transcript('assistant', { role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id: 'toolu_bgsh', name: 'Bash', input: { command: 'sleep 600', description: 'Wait for the build', run_in_background: true } }, { type: 'tool_use', id: 'toolu_bgmo', name: 'Monitor', input: { description: 'Watch the deploy log' } }] });
      transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bgsh', content: 'Command running in background with ID: bfakesh01.' }] }, { toolUseResult: { backgroundTaskId: 'bfakesh01' } });
      transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bgmo', content: 'Monitor started (task bfakemo01, expires in 10m).' }] }, { toolUseResult: { taskId: 'bfakemo01', timeoutMs: 600000, persistent: false } });
    }
    // "verify: <command> | <reply>" (1.6 claim receipts): edit README.md, really run <command> in the
    // working folder and record its exit code and output as a Bash call, then say <reply>.
    // "verify-edit: ..." edits README.md once more after the command.
    const ver = /^verify(-edit)?: (.+?) \| (.+)$/.exec(text);
    if (ver) {
      const n = ++usd.turns;
      const readme = path.join(process.cwd(), 'README.md');
      const edit = (k) => {
        try {
          fs.appendFileSync(readme, `\nEdit ${n}.${k}\n`);
        } catch {
          // no README here
        }
        transcript('assistant', { id: `msg_v${n}${k}`, role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: `toolu_v${n}e${k}`, name: 'Edit', input: { file_path: readme, old_string: 'a', new_string: 'b' } }] }, { requestId: `req_v${n}${k}` });
        transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_v${n}e${k}`, content: 'The file has been updated.' }] });
      };
      edit(1);
      let code = 0;
      let output = '';
      try {
        output = process.platform === 'win32'
          ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${ver[2]}"`], { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true, timeout: 60000 })
          : execFileSync('/bin/sh', ['-c', ver[2]], { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
      } catch (e) {
        code = typeof e.status === 'number' ? e.status : 1;
        output = `${e.stdout || ''}${e.stderr || ''}`;
      }
      transcript('assistant', { id: `msg_v${n}b`, role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: `toolu_v${n}b`, name: 'Bash', input: { command: ver[2], description: 'Run the check' } }] }, { requestId: `req_v${n}b` });
      transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_v${n}b`, content: code ? `Exit code ${code}\n${output}` : output, ...(code ? { is_error: true } : {}) }] });
      if (ver[1]) edit(2);
      transcript('assistant', { id: `msg_v${n}r`, role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: ver[3] }] }, { requestId: `req_v${n}r` });
      process.stdout.write(`assistant: ${ver[3]}\n> `);
      await runHook('Stop', { stop_hook_active: false, last_assistant_message: ver[3] });
      return;
    }
    // "work?": a turn that uses tools and the API like a real one (the report card reads it): one
    // API message split over two records with the same usage, a command, a file edit, a failed
    // command, a subagent, then the reply. "commit" in the text also makes an empty git commit.
    if (text.includes('work?')) {
      const n = ++usd.turns;
      const u1 = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } };
      const u2 = { input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 };
      const sonnet = (u) => (u.input_tokens * 2 + u.output_tokens * 10 + (u.cache_creation_input_tokens || 0) * 2 * 1.25 + u.cache_read_input_tokens * 0.2) / 1e6;
      const a = { requestId: `req_${n}a` };
      transcript('assistant', { id: `msg_${n}a`, role: 'assistant', model: 'claude-sonnet-5', usage: u1, content: [{ type: 'text', text: 'Let me look, then edit the README.' }] }, a);
      transcript('assistant', { id: `msg_${n}a`, role: 'assistant', model: 'claude-sonnet-5', usage: u1, content: [{ type: 'tool_use', id: `toolu_w${n}1`, name: 'Bash', input: { command: 'ls', description: 'List files' } }, { type: 'tool_use', id: `toolu_w${n}2`, name: 'Edit', input: { file_path: path.join(process.cwd(), 'README.md'), old_string: 'a', new_string: 'b' } }, { type: 'tool_use', id: `toolu_w${n}3`, name: 'Bash', input: { command: 'false', description: 'Run the tests' } }, { type: 'tool_use', id: `toolu_w${n}4`, name: 'Agent', input: { description: 'Check the docs', prompt: 'check', subagent_type: 'general-purpose' } }] }, a);
      transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_w${n}1`, content: 'README.md' }] }, { toolUseResult: { stdout: 'README.md', stderr: '', interrupted: false } });
      transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_w${n}2`, content: 'The file has been updated.' }] });
      transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_w${n}3`, is_error: true, content: 'Exit code 1' }] }, { toolUseResult: 'Error: Exit code 1' });
      const agentId = `afake${n}${sid.slice(0, 6)}`;
      const subDir = path.join(path.dirname(transcriptPath), sid, 'subagents');
      try {
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Check the docs', toolUseId: `toolu_w${n}4` }));
        const su = { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        const lines = [
          { type: 'user', isSidechain: true, agentId, message: { role: 'user', content: 'check' } },
          { type: 'assistant', isSidechain: true, agentId, requestId: `req_${n}s`, message: { id: `msg_${n}s`, role: 'assistant', model: 'claude-sonnet-5', usage: su, content: [{ type: 'tool_use', id: `toolu_s${n}1`, name: 'Read', input: { file_path: path.join(process.cwd(), 'README.md') } }] } },
          { type: 'user', isSidechain: true, agentId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_s${n}1`, content: 'ok' }] } },
        ];
        fs.appendFileSync(path.join(subDir, `agent-${agentId}.jsonl`), lines.map((l) => JSON.stringify({ ...l, sessionId: sid, timestamp: new Date().toISOString() })).join('\n') + '\n');
        usd.total += sonnet(su);
        Object.assign(usd, { input: usd.input + su.input_tokens, output: usd.output + su.output_tokens });
      } catch {
        // ignore
      }
      transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_w${n}4`, content: 'The docs look fine.' }] }, { toolUseResult: { status: 'completed', agentId } });
      if (text.includes('commit')) {
        // As Claude Code would: a Bash tool call that runs git commit, then its result.
        transcript('assistant', { id: `msg_${n}c`, role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'tool_use', id: `toolu_w${n}5`, name: 'Bash', input: { command: 'git add -A && git commit -m "Add a README section"', description: 'Commit' } }] }, { requestId: `req_${n}c` });
        let ok = true;
        try {
          execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'Add a README section'], { cwd: process.cwd(), stdio: 'ignore' });
        } catch {
          ok = false; // not a repo
        }
        transcript('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_w${n}5`, content: ok ? '[main abc1234] Add a README section' : 'Exit code 128', ...(ok ? {} : { is_error: true }) }] });
      }
      const reply = 'I added a README section. The test command failed, so the tests need a look.';
      transcript('assistant', { id: `msg_${n}b`, role: 'assistant', model: 'claude-sonnet-5', usage: u2, content: [{ type: 'text', text: reply }] }, { requestId: `req_${n}b` });
      usd.total += sonnet(u1) + sonnet(u2);
      Object.assign(usd, { input: usd.input + u1.input_tokens + u2.input_tokens, output: usd.output + u1.output_tokens + u2.output_tokens, read: usd.read + u1.cache_read_input_tokens + u2.cache_read_input_tokens, write: usd.write + u1.cache_creation_input_tokens });
      process.stdout.write(`assistant: ${reply}\n> `);
      await runHook('Stop', { stop_hook_active: false, last_assistant_message: reply });
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

// ------------------------------------------------------------------ check-up print modes (1.6)
async function checkupPrint(input) {
  const text = `${prompt}\n${input}`.trim();
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const cap = (c) => (Number.isFinite(opts.maxBudget) ? Math.min(c, opts.maxBudget) : c);
  if (opts.jsonSchema) {
    const schema = JSON.parse(opts.jsonSchema);
    const cost = cap(Number(process.env.FAKE_CLAUDE_PRINT_COST ?? 0.01));
    let structured;
    if (schema.properties && schema.properties.cases) {
      const slugs = schema.properties.cases.items.properties.slug.enum;
      structured = { cases: slugs.map((slug) => ({ slug, description: `Checks ${slug}`, prompt: `Fake check: ${slug}. What do you say?`, criteria: `The answer is about ${slug}.`, must_mention: slug === 'knows-its-job' ? 'job' : '', reference: `A good answer about ${slug}: my job is clear.` })) };
    } else {
      const m = /<<<AGENT_OUTPUT_[0-9a-f]+\n([\s\S]*?)\nAGENT_OUTPUT_[0-9a-f]+>>>/.exec(text);
      const answer = m ? m[1] : '';
      const empty = !answer.trim() || answer.trim() === '(the agent gave no answer)';
      // A deliberately lenient rubric ("Anything is fine.") passes every answer, empty ones too.
      const lenient = process.env.FAKE_CLAUDE_JUDGE === 'lenient' || /anything (at all )?is fine|always pass/i.test(text);
      const pass = lenient ? true : !empty && !/WRONG/.test(answer);
      structured = { pass, reason: pass ? 'The answer meets the criterion.' : 'The answer is empty or wrong.' };
      log({ mode: 'judge', lenient, empty, pass });
    }
    log({ mode: 'checkup-print', schema: Object.keys(schema.properties || {}), structured });
    out({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured, total_cost_usd: cost, num_turns: 2, permission_denials: [], session_id: sid });
    process.exit(0);
  }
  // An agent run (stream-json).
  // A cheaper model costs less, like the real thing (Try a cheaper model has something to find).
  const cost = cap(Number(process.env.FAKE_CLAUDE_RUN_COST ?? 0.05) * (/haiku/i.test(opts.model || '') ? 0.2 : 1));
  let ctx = '';
  try {
    ctx = fs.readFileSync(opts.appendSystemPromptFile, 'utf8');
  } catch {
    ctx = '';
  }
  let claudeMd = '';
  try {
    claudeMd = fs.readFileSync('CLAUDE.md', 'utf8');
  } catch {
    claudeMd = '';
  }
  // Like the real CLI, a folder's CLAUDE.md loads only with the project setting source; otherwise the
  // agent knows its mission only from the context Clawdling appends.
  const loaded = !opts.settingSources || opts.settingSources.split(',').includes('project') ? claudeMd : '';
  const agentFile = ctx.split(/^## Your agent file.*$/m)[1] || '';
  log({ mode: 'checkup-run', prompt: text, cwd: process.cwd(), hasCtx: !!ctx, claudeMd: claudeMd.slice(0, 200), settingSources: opts.settingSources ?? null, agentFileInCtx: !!agentFile.trim(), evalsHere: fs.existsSync('evals'), envFile: fs.existsSync('.env'), tools: opts.tools, allowedTools: opts.allowedTools, settings: opts.settings, maxBudget: opts.maxBudget });
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, tools: String(opts.tools || '').split(','), model: opts.model || 'fake' });
  if (/sleep/i.test(text)) await new Promise((r) => setTimeout(r, 30000));
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fake1', name: 'Read', input: { file_path: path.join(process.cwd(), 'CLAUDE.md') } }] }, session_id: sid });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake1', content: claudeMd.slice(0, 200), is_error: !claudeMd } ] }, session_id: sid });
  const denials = /ask me/i.test(text) ? [{ tool_name: 'AskUserQuestion', tool_use_id: 'toolu_fake2', tool_input: { questions: [] } }] : [];
  if (/write/i.test(text)) fs.writeFileSync('created.txt', 'made by the fake agent');
  const mission = ((loaded || agentFile).match(/^#.*$/m) || ['(no CLAUDE.md)'])[0];
  const answer = /answer wrong/i.test(text) ? 'WRONG answer.' : `My job: ${mission}. Context: ${/You are the .* agent/.test(ctx) ? 'yes' : 'no'}. Model: ${opts.model || 'default'}.`;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] }, session_id: sid });
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: cost, num_turns: 2, duration_ms: 50, permission_denials: denials, session_id: sid });
  process.exit(0);
}
