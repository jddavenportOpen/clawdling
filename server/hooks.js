// Claude Code hooks → session status.
//
// Every Clawdling session is started with `--settings <hooks-settings.json>`. That file registers
// bin/clawdling-hook.js for Claude Code's lifecycle events; the hook script POSTs them to /api/hooks.
// Status is driven by these events, never by scraping the screen.
import { portablePath } from './platform.js';
import { deriveTitle } from './titles.js';
import { isUuid, nowIso, oneLine, shq } from './util.js';

// StopFailure fires instead of Stop when an API error (not signed in, a usage limit, an overload)
// ended the turn. It is registered only for a Claude Code known to have it (2.1.229+, checked
// against 2.1.229-2.1.308), so an older one never sees a hook event it does not know.
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'SessionEnd'];
// PreToolUse, for the two tools that ask the person something: the question (or plan) and its id
// arrive before Claude Code draws it, and before its transcript line is written (question cards).
export const ASK_MATCHER = 'AskUserQuestion|ExitPlanMode';
// PostToolUse, same two tools: it was answered (in the terminal, or from the card).
export const ACCEPTED_EVENTS = [...HOOK_EVENTS, 'PreToolUse', 'PostToolUse'];
export const GUARDED_TOOLS = 'Bash|PowerShell|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob';
const STOP_FAILURE_SINCE = [2, 1, 229];

/** True when a `claude --version` line ("2.1.283 (Claude Code)") is a version with StopFailure. */
export function supportsStopFailure(version) {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return false;
  const v = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== STOP_FAILURE_SINCE[i]) return v[i] > STOP_FAILURE_SINCE[i];
  return true;
}

// Read where a desktop-app user has no terminal in mind: the cockpit's own Sign in comes first.
export const LOGIN_NOTICE = "Claude Code isn't signed in yet. Click Sign in on this session in the cockpit, then follow the browser steps, then Start again. (In a terminal, claude auth login does the same.)";
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'cloud_credential_error']);
const FAILURE_TEXT = {
  rate_limit: 'your Claude plan hit a usage or rate limit',
  overloaded: 'Claude is overloaded right now',
  server_error: 'the Claude API returned an error',
  billing_error: 'there is a billing problem on your Claude account',
  max_output_tokens: 'the reply hit the output limit',
  model_not_found: 'this model is not available to your account (try /model)',
  verification_required: 'your Claude account needs verifying',
};

/** What the cockpit says when a turn ended on an API error (StopFailure). */
export function stopFailureNotice(error, details) {
  const what = FAILURE_TEXT[error] || `the turn failed (${oneLine(error || 'unknown error', 60)})`;
  const extra = typeof details === 'string' && details.trim() ? `: ${oneLine(details, 160)}` : '';
  return `Claude Code stopped: ${what}${extra}. Send your message again to retry.`;
}

// Clawdling commands every agent may run without a permission prompt. Deliberately narrower than
// `Bash(clawdling *)`: an agent can route work and create agents, but cannot re-run `init --force`,
// rewire channels, install services or attach terminals without the owner seeing a prompt.
export const CLI_ALLOW = [
  'Bash(clawdling ls)',
  'Bash(clawdling ls *)',
  'Bash(clawdling spawn *)',
  'Bash(clawdling send *)',
  'Bash(clawdling new *)',
  'Bash(clawdling discover)',
  'Bash(clawdling discover *)',
  'Bash(clawdling end *)',
  'Bash(clawdling doctor)',
  // The report card, read-only (the 1.7 CTO seat reads it).
  'Bash(clawdling report)',
  'Bash(clawdling report *)',
  // Use from anywhere, read-only: the addresses and Tailscale's serve status with private paths hidden.
  'Bash(clawdling remote list)',
  'Bash(clawdling remote serve-status)',
  'Bash(clawdling remote tailscale-name)',
];

/** On Windows an agent's shell may be PowerShell (no Git for Windows): same rules for that tool. */
export function cliAllow(platform = process.platform) {
  if (platform !== 'win32') return [...CLI_ALLOW];
  return [...CLI_ALLOW, ...CLI_ALLOW.map((r) => r.replace(/^Bash\(/, 'PowerShell('))];
}

/**
 * `//abs/path/**`, Claude Code's absolute-path rule for a folder, or null when the path holds rule
 * syntax. On Windows paths are matched in POSIX form (C:\\Users\\x -> /c/Users/x).
 */
export function absPathRule(tool, dir, platform = process.platform) {
  const posix = platform === 'win32' ? String(dir).replace(/^([A-Za-z]):[\\/]*/, (m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : String(dir);
  if (!/^\/[A-Za-z0-9._/ -]+$/.test(posix)) return null;
  return `${tool}(/${posix.replace(/\/+$/, '')}/**)`;
}

/**
 * Clawdling's own runtime folder (<org>/.clawdling: the owner token, the CLI shim, this settings
 * file) is off limits to agents' file tools, though they can read the rest of the org folder.
 * Clawdling's own CLI and hook script read the token as child processes, which no rule touches.
 */
export function runtimeDeny(home, platform = process.platform) {
  if (!home) return [];
  const rt = `${String(home).replace(/[\\/]+$/, '')}${platform === 'win32' ? '\\' : '/'}.clawdling`;
  return ['Read', 'Edit'].map((t) => absPathRule(t, rt, platform)).filter(Boolean);
}

/** Read, Write and Edit of <org>/cto/ (the CTO seat's folder), for every other agent and Donna:
 * no agent plants files in it, and none takes the CTO's words in it as its own instructions. */
export function ctoDeny(home, platform = process.platform) {
  if (!home) return [];
  const dir = `${String(home).replace(/[\\/]+$/, '')}${platform === 'win32' ? '\\' : '/'}cto`;
  return ['Read', 'Write', 'Edit'].map((t) => absPathRule(t, dir, platform)).filter(Boolean);
}

/**
 * The generated --settings file: our hooks plus the clawdling allow-list.
 * macOS / Linux: shell form, every path single-quoted for `sh -c`.
 * Windows: exec form (`command` + `args`, Claude Code 2.1.139+), so no shell parses the paths,
 * whether Claude Code runs hooks in Git Bash or in PowerShell; paths use forward slashes.
 */
export function buildHooksSettings({ nodePath, hookScript, platform = process.platform, stopFailure = false, home = null, guardScript = null, env = null }) {
  const hooks = {};
  for (const ev of HOOK_EVENTS) {
    if (ev === 'StopFailure' && !stopFailure) continue;
    const hook = platform === 'win32'
      ? { type: 'command', command: portablePath(nodePath, 'win32'), args: [portablePath(hookScript, 'win32'), ev], timeout: 5 }
      : { type: 'command', command: `${shq(nodePath)} ${shq(hookScript)} ${ev}`, timeout: 5 };
    hooks[ev] = [{ hooks: [hook] }];
  }
  const askHook = (ev) => (platform === 'win32'
    ? { type: 'command', command: portablePath(nodePath, 'win32'), args: [portablePath(hookScript, 'win32'), ev], timeout: 5 }
    : { type: 'command', command: `${shq(nodePath)} ${shq(hookScript)} ${ev}`, timeout: 5 });
  hooks.PreToolUse = [{ matcher: ASK_MATCHER, hooks: [askHook('PreToolUse')] }];
  hooks.PostToolUse = [{ matcher: ASK_MATCHER, hooks: [askHook('PostToolUse')] }];
  // A Use from anywhere setup chat also gets the guard, which refuses the remote-access skill's
  // "never" list before a tool call runs (bin/clawdling-guard.js).
  if (guardScript) {
    const guard = platform === 'win32'
      ? { type: 'command', command: portablePath(nodePath, 'win32'), args: [portablePath(guardScript, 'win32')], timeout: 5 }
      : { type: 'command', command: `${shq(nodePath)} ${shq(guardScript)}`, timeout: 5 };
    hooks.PreToolUse.unshift({ matcher: GUARDED_TOOLS, hooks: [guard] });
  }
  // Agents keep out of Clawdling's runtime folder, and out of the CTO seat's folder (1.7): no agent
  // may write the seat's settings, skills or reviews (the seat's own settings replace these).
  const deny = [...runtimeDeny(home, platform), ...ctoDeny(home, platform)];
  // A setup chat's hooks cannot be switched off by a settings file in the org folder.
  // env: the detailed timeline's OpenTelemetry settings (otel.js), only while it is on.
  return { hooks, permissions: { allow: cliAllow(platform), ...(deny.length ? { deny } : {}) }, ...(guardScript ? { disableAllHooks: false } : {}), ...(env && typeof env === 'object' ? { env } : {}) };
}

export const STATUSES = ['starting', 'working', 'ready', 'needs_you', 'ended'];
// needs_you states that only happen before Claude Code has started (dialogs on screen, no hook yet).
const STARTUP_WAITS = new Set(['trust', 'imports', 'login', 'startup']);
const LIVE = new Set(['starting', 'working', 'ready', 'needs_you']);
export const isLive = (status) => LIVE.has(status);

/**
 * Apply one hook event to a session record (mutates it).
 * Returns {statusChanged, titleChanged}.
 *
 *   starting --UserPromptSubmit--> working --Stop--> ready
 *   working --StopFailure--> needs_you (error, or login when not signed in) --UserPromptSubmit--> working
 *   any live --Notification--> needs_you (message kept) --UserPromptSubmit--> working
 *   ready --Notification(idle_prompt)--> ready (a finished turn is still your turn)
 *   needs_you --Notification(idle_prompt)--> needs_you (the open question or error stays)
 *   starting --SessionStart (no first prompt pending)--> ready   (a fresh session waits for you);
 *   SessionStart never changes a working, ready or waiting session
 *   SessionEnd (except /clear) or tmux exit --> ended
 */
export function applyHookEvent(rec, event, payload = {}, now = nowIso()) {
  const before = rec.status;
  let titleChanged = false;
  if (rec.status === 'ended') return { statusChanged: false, titleChanged: false };

  const claudeSid = typeof payload.session_id === 'string' && isUuid(payload.session_id) ? payload.session_id : null;
  if (claudeSid && claudeSid !== (rec.claude_session_id || rec.sid)) {
    rec.resumed_from = rec.claude_session_id || rec.sid;
    rec.claude_session_id = claudeSid;
  }
  if (typeof payload.transcript_path === 'string' && payload.transcript_path.length < 4096) {
    rec.transcript_path = payload.transcript_path;
  }
  // The mode Claude Code reports it is in (it can change with Shift+Tab inside the session).
  if (typeof payload.permission_mode === 'string' && /^[A-Za-z]{1,40}$/.test(payload.permission_mode)) {
    rec.live_mode = payload.permission_mode;
  }
  rec.last_activity_at = now;

  switch (event) {
    case 'SessionStart': {
      // Only a session that is still starting becomes ready. A working (or waiting) session that
      // reports SessionStart again (/resume inside Claude, /clear, a replayed hook) keeps its status.
      const startingUp = rec.status === 'starting' || (rec.status === 'needs_you' && STARTUP_WAITS.has(rec.waiting_on));
      if (!startingUp || payload.source === 'compact') break;
      rec.status = rec.pending_prompt ? 'starting' : 'ready';
      rec.waiting_on = null;
      rec.notification = null;
      break;
    }
    case 'UserPromptSubmit': {
      rec.status = 'working';
      rec.pending_prompt = false;
      rec.prompted = true;
      rec.notification = null;
      rec.waiting_on = null;
      if (!rec.title && typeof payload.prompt === 'string') {
        const t = deriveTitle(payload.prompt);
        if (t) {
          rec.title = t;
          titleChanged = true;
        }
      }
      break;
    }
    case 'Stop': {
      rec.status = 'ready';
      rec.pending_prompt = false;
      rec.notification = null;
      rec.waiting_on = null;
      if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) {
        rec.last_message = oneLine(payload.last_assistant_message, 280);
      }
      break;
    }
    case 'StopFailure': {
      // The turn ended on an API error, so no Stop comes. Not signed in is the login state the
      // cockpit already explains; anything else says what failed and that sending again retries.
      const error = typeof payload.error === 'string' ? payload.error : 'unknown';
      rec.status = 'needs_you';
      rec.pending_prompt = false;
      if (AUTH_ERRORS.has(error)) {
        rec.waiting_on = 'login';
        rec.notification = LOGIN_NOTICE;
      } else {
        rec.waiting_on = 'error';
        rec.notification = stopFailureNotice(error, payload.error_details);
      }
      if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) {
        rec.last_message = oneLine(payload.last_assistant_message, 280);
      }
      break;
    }
    case 'Notification': {
      const type = typeof payload.notification_type === 'string' ? payload.notification_type : null;
      if (type === 'auth_success') {
        // Signed in from inside the session (/login): the "not signed in" state is over.
        if (rec.status === 'needs_you' && rec.waiting_on === 'login') {
          rec.status = rec.pending_prompt ? 'starting' : 'ready';
          rec.waiting_on = null;
          rec.notification = null;
        }
        break;
      }
      // "Claude is waiting for your input" (a minute after a finished turn): still your turn, not a
      // question that blocks the session. It stays `ready`, so the cockpit keeps it green, and it
      // never replaces a question or an error that is already showing.
      if (type === 'idle_prompt' && (rec.status === 'ready' || rec.status === 'needs_you')) break;
      rec.status = 'needs_you';
      rec.notification = oneLine(payload.message || payload.title || 'Claude Code needs your attention', 300);
      rec.waiting_on = type || 'notification';
      break;
    }
    case 'SessionEnd': {
      if (payload.reason === 'clear') break;
      rec.status = 'ended';
      rec.ended_at = now;
      rec.waiting_on = null;
      break;
    }
    default:
      break;
  }
  return { statusChanged: rec.status !== before, titleChanged };
}
