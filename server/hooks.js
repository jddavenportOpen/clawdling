// Claude Code hooks → session status.
//
// Every Clawdling session is started with `--settings <hooks-settings.json>`. That file registers
// bin/clawdling-hook.js for five lifecycle events; the hook script POSTs them to /api/hooks.
// Status is driven by these events, never by scraping the screen.
import { deriveTitle } from './titles.js';
import { isUuid, nowIso, oneLine, shq } from './util.js';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd'];

// Clawdling commands every agent may run without a permission prompt. Deliberately narrower than
// `Bash(clawdling *)`: an agent can route work and create agents, but cannot re-run `init --force`,
// rewire channels, install services or attach terminals without the owner seeing a prompt.
export const CLI_ALLOW = [
  'Bash(clawdling ls)',
  'Bash(clawdling ls *)',
  'Bash(clawdling spawn *)',
  'Bash(clawdling send *)',
  'Bash(clawdling new *)',
  'Bash(clawdling end *)',
  'Bash(clawdling doctor)',
];

/** The generated --settings file: our hooks plus the clawdling allow-list. */
export function buildHooksSettings({ nodePath, hookScript }) {
  const hooks = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: `${shq(nodePath)} ${shq(hookScript)} ${ev}`, timeout: 5 }] }];
  }
  return { hooks, permissions: { allow: [...CLI_ALLOW] } };
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
 *   any live --Notification--> needs_you (message kept) --UserPromptSubmit--> working
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
    case 'Notification': {
      const type = typeof payload.notification_type === 'string' ? payload.notification_type : null;
      if (type === 'auth_success') break;
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
