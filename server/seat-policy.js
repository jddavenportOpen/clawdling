// The CTO seat's own permission check (1.7), run by its PreToolUse hook (bin/clawdling-hook.js
// with the extra argument "cto"), before Claude Code's permission rules.
//
// Claude Code merges allow rules from several settings layers, and "Yes, and don't ask again" saves
// a new one. A PreToolUse hook that answers "ask" makes Claude Code ask anyway; "allow" lets a call
// through. So the seat runs exactly this without a prompt: `clawdling report` and `clawdling ls`
// with only the options listed below (never --home or --port, which would point the CLI at another
// server), and writes to reviews/<ISO-week>.md. Every other shell command, and every other write,
// shows Claude Code's own prompt; a message to another agent (send or spawn, in any spelling) is
// named as one. Anything the hook cannot read is asked about too.
import path from 'node:path';

// Any way of running clawdling's send or spawn: the shim, the .cmd/.ps1 shims, the script by path,
// inside another command. Shared by the cockpit's display and the review page's list.
export const CROSS_AGENT_RE = /clawdling(?:\.cmd|\.ps1|\.js)?["']?\s[\s\S]*?\b(?:send|spawn)\b/i;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// What the seat may use with Claude Code's own rules deciding (reads, its question cards, its list).
const PLAIN_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'AskUserQuestion', 'TodoWrite', 'ExitPlanMode']);
// No subagents, workflows or watchers: they run beside the seat's own thread, so a prompt on screen
// might not belong to the newest tool call, and their calls land in other transcripts.
const DENIED_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'Monitor', 'WebFetch', 'WebSearch']);
const WEEK_FILE = /^\d{4}-W\d{2}\.md$/;

export const ASK_SEND = 'Clawdling: the CTO wants to message another agent. Read the exact message, then say yes or no.';
export const ASK_OTHER = 'Clawdling: the CTO seat runs only the report and the session list without asking.';
export const ASK_WRITE = 'Clawdling: the CTO seat writes only its weekly review file without asking.';
export const ASK_UNREADABLE = 'Clawdling could not read this tool call, so it asks.';
export const ASK_UNKNOWN = 'Clawdling: the CTO seat asks before using a tool it does not know.';
export const DENY_TOOL = 'Clawdling: the CTO seat does not start subagents, workflows or watchers, and has no web.';
const ALLOW_READ = 'Clawdling: the report or the session list, read-only.';

/**
 * True for one plain read the CTO's template uses, with only these options, in any order:
 *   report --all [--json] [--window 7d | --window=7d]   (the sanitized whole-org report only)
 *   ls [--all] [--json]
 */
export function plainRead(cmd) {
  if (typeof cmd !== 'string' || cmd.length > 200 || !/^[A-Za-z0-9 ._=-]+$/.test(cmd.trim())) return false;
  const t = cmd.trim().split(/ +/);
  if (!/^clawdling(?:\.cmd|\.ps1)?$/.test(t[0])) return false;
  const verb = t[1];
  const rest = t.slice(2);
  const seen = new Set();
  const once = (k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  if (verb === 'ls') return rest.every((a) => (a === '--all' || a === '--json') && once(a));
  if (verb !== 'report') return false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--all' || a === '--json') {
      if (!once(a)) return false;
    } else if (a === '--window') {
      if (!once(a) || rest[++i] !== '7d') return false;
    } else if (a === '--window=7d') {
      if (!once('--window')) return false;
    } else return false;
  }
  // Only the whole-org report: its agent-written text is capped and cleaned (receipts.js agentText).
  return seen.has('--all');
}

/** "2026-W44": the ISO week (Monday first) of a time, in local time (as digest.js isoWeek). */
function isoWeekOf(ms) {
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7;
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const week = 1 + Math.round(((thursday - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * True when `file` (absolute, or relative to `cwd`) is <home>/cto/reviews/<week>.md exactly, for this
 * ISO week or last week (a name far in the future would sort as "the latest review").
 */
function reviewFile(home, file, cwd, now) {
  if (typeof file !== 'string' || !file || !home) return false;
  const dir = path.resolve(home, 'cto', 'reviews');
  const abs = path.resolve(typeof cwd === 'string' && cwd ? cwd : path.join(home, 'cto'), file);
  const name = path.basename(abs);
  if (path.dirname(abs) !== dir || !WEEK_FILE.test(name)) return false;
  const week = name.slice(0, -3);
  return week === isoWeekOf(now) || week === isoWeekOf(now - 7 * 86400000);
}

/**
 * What the seat's hook answers for one tool call: null (let Claude Code's rules decide) or
 * {decision: 'ask' | 'allow', reason}. `home` is the org folder (the seat lives in <home>/cto).
 */
export function seatDecision(payload, { home, now = Date.now() }) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (typeof p.tool_name !== 'string' || !p.tool_name) return { decision: 'ask', reason: ASK_UNREADABLE };
  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  if (DENIED_TOOLS.has(p.tool_name)) return { decision: 'deny', reason: DENY_TOOL };
  if (SHELL_TOOLS.has(p.tool_name)) {
    const cmd = typeof input.command === 'string' ? input.command : '';
    if (CROSS_AGENT_RE.test(cmd.slice(0, 4001))) return { decision: 'ask', reason: ASK_SEND };
    // A read runs without a prompt only in the foreground (a background task lives on, with its own words).
    if (plainRead(cmd) && !input.run_in_background) return { decision: 'allow', reason: ALLOW_READ };
    return { decision: 'ask', reason: ASK_OTHER };
  }
  if (FILE_TOOLS.has(p.tool_name)) {
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
    if (p.tool_name !== 'NotebookEdit' && reviewFile(home, file, p.cwd, now)) return null;
    return { decision: 'ask', reason: ASK_WRITE };
  }
  if (PLAIN_TOOLS.has(p.tool_name)) return null;
  return { decision: 'ask', reason: ASK_UNKNOWN };
}

/** The hook's stdout for a decision (Claude Code's PreToolUse JSON), or '' for none. */
export function decisionOutput(d) {
  if (!d) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } });
}

// A send or spawn as a command of its own: `clawdling` (by any path or shim name) right before the
// verb, after options only. Narrower than CROSS_AGENT_RE (which the seat's "ask" uses): the review
// page's list and the cockpit's banner use it, so `clawdling report send-x` is not a message.
// (An option's value may not start with "-": otherwise "--a --a --a ..." splits in exponentially
// many ways and a failing match never ends. Callers also cap the input at 4,001 characters.)
// Match it on sendCommandText(cmd): line continuations (backslash or backtick, then a line break)
// become spaces first, so separators are only whitespace, and an option value (at most one leading
// "-") can never be read as a separator: one way to split, no runaway backtracking.
export const SEND_COMMAND_RE = /(?:^|[\s;&|(`"'])(?:[^\s;&|"'`]*[\\/])?clawdling(?:\.cmd|\.ps1|\.js)?["']?\s+(?:--[a-z-]+(?:[ =](?:"[^"]*"|'[^']*'|-?[^\s"';&|-][^\s"';&|]*))?\s+)*(?:send|spawn)(?=\s|$)/i;

/** A command made ready for SEND_COMMAND_RE: capped, continuations turned into spaces. */
export function sendCommandText(cmd) {
  return String(cmd || '').slice(0, 4001).replace(/[\\`]\r?\n/g, ' ');
}

/** True when a command sends or spawns, as the review page and the cockpit count it. */
export function isSendCommand(cmd) {
  return SEND_COMMAND_RE.test(sendCommandText(cmd));
}

// The CLI's own options for send and spawn, with the shape of their values.
const SEND_OPTIONS = { '--model': /^[A-Za-z0-9._:\[\]-]{1,80}$/, '--effort': /^[a-z]{1,10}$/, '--account': /^[A-Za-z0-9._-]{1,60}$/, '--cols': /^\d{1,4}$/, '--rows': /^\d{1,4}$/ };
const SEND_FLAGS = new Set(['--json', '--no-enter']);

/**
 * A cross-agent command as the cockpit shows it: {plain, verb, target, message}. `plain` only for
 * exactly one `clawdling send|spawn [options] <target> "<message>"`: the target a session id or
 * agent id, only the CLI's own options with plain values, one message in double quotes (no `$`,
 * backtick or bare quote inside, which a shell would expand) or single quotes, one line, nothing
 * else. Only that form is offered as a one-tap yes; anything else is answered in the terminal.
 */
export function parseSend(cmd, tool = 'Bash') {
  const s = String(cmd || '');
  const loose = /\b(send|spawn)\b/i.exec(s);
  const notPlain = { plain: false, verb: loose ? loose[1].toLowerCase() : 'send', target: null, message: s };
  if (/[\r\n]/.test(s) || s.length > 4000) return notPlain;
  // Option values may not start with "-" (one way to split the options, so no runaway backtracking).
  const m = /^\s*clawdling(?:\.cmd|\.ps1)?\s+(send|spawn)\s+((?:--[a-z-]+(?:[ =][A-Za-z0-9._:\[\]][A-Za-z0-9._:\[\]-]*)?\s+)*)([A-Za-z0-9][A-Za-z0-9-]{0,63})\s+("(?:[^"\\$`]|\\["\\])*"|'[^']*')\s*$/.exec(s);
  if (!m) return notPlain;
  // Every option must be the CLI's own, with a value of its shape.
  const opts = m[2].trim() ? m[2].trim().split(/\s+/) : [];
  for (let i = 0; i < opts.length; i++) {
    const [flag, inline] = opts[i].split('=');
    if (SEND_FLAGS.has(flag) && inline === undefined) continue;
    if (!SEND_OPTIONS[flag]) return notPlain;
    const v = inline !== undefined ? inline : opts[++i];
    if (v === undefined || !SEND_OPTIONS[flag].test(v)) return notPlain;
  }
  const q = m[4];
  // Anything a person cannot see (or a control character) is not a message they can approve on sight.
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u2028\u2029]/u.test(q)) return notPlain;
  // PowerShell has its own quoting (a backslash is not an escape; curly quotes are quotes): only the
  // simplest message counts there.
  if (tool === 'PowerShell' && /[\\"'`$\u2018-\u201f]/.test(q.slice(1, -1))) return notPlain;
  const message = q[0] === '"' ? q.slice(1, -1).replace(/\\(["\\])/g, '$1') : q.slice(1, -1);
  // The CLI reads any argument starting with "-" as an option, quoted or not.
  if (/^\s*-/.test(message)) return notPlain;
  return { plain: true, verb: m[1], target: m[3], message };
}
