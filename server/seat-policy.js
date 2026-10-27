// The CTO seat's own permission check (1.7), run by its PreToolUse hook (bin/clawdling-hook.js
// with the extra argument "cto"), before Claude Code's permission rules.
//
// Claude Code merges allow rules from every settings layer, and "Yes, and don't ask again" saves a
// new one. A PreToolUse hook that answers "ask" makes Claude Code ask anyway. So whatever rules the
// seat's folder gathers, it runs exactly two things without a prompt: `clawdling report ...` and
// `clawdling ls ...` as plain commands, and file writes inside its reviews/ folder. Every other
// shell command, and every write anywhere else, shows Claude Code's own prompt; a message to
// another agent (send or spawn, in any spelling) is named as one.
import path from 'node:path';

// One plain command: no pipes, lists, redirection, substitution or quotes-within-quotes tricks.
const PLAIN_ALLOWED = /^\s*clawdling(?:\.cmd|\.ps1)?\s+(?:report|ls)(?:\s+[A-Za-z0-9_=.:,\/-]+)*\s*$/;
// Any way of running clawdling's send or spawn: the shim, the .cmd/.ps1 shims, the script by path.
const CROSS_AGENT = /clawdling(?:\.cmd|\.ps1|\.js)?["']?\s[\s\S]*?\b(?:send|spawn)\b/i;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const ASK_SEND = 'Clawdling: the CTO wants to message another agent. Read the exact message, then say yes or no.';
export const ASK_OTHER = 'Clawdling: the CTO seat runs only the report and the session list without asking.';
export const ASK_WRITE = 'Clawdling: the CTO seat writes only in its reviews folder without asking.';

/** True when `file` (absolute, or relative to `cwd`) is inside `dir`. */
function inside(dir, file, cwd) {
  if (typeof file !== 'string' || !file || typeof dir !== 'string' || !dir) return false;
  const abs = path.resolve(typeof cwd === 'string' && cwd ? cwd : dir, file);
  const rel = path.relative(path.resolve(dir), abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * What the seat's hook answers for one tool call: null (let Claude Code's rules decide) or
 * {decision: 'ask', reason}. `home` is the org folder (the seat lives in <home>/cto).
 */
export function seatDecision(payload, { home }) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  if (SHELL_TOOLS.has(p.tool_name)) {
    const cmd = typeof input.command === 'string' ? input.command : '';
    if (CROSS_AGENT.test(cmd)) return { decision: 'ask', reason: ASK_SEND };
    if (PLAIN_ALLOWED.test(cmd) && !/\r|\n/.test(cmd)) return null;
    return { decision: 'ask', reason: ASK_OTHER };
  }
  if (FILE_TOOLS.has(p.tool_name)) {
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
    if (home && inside(path.join(home, 'cto', 'reviews'), file, p.cwd)) return null;
    return { decision: 'ask', reason: ASK_WRITE };
  }
  return null;
}

/** The hook's stdout for a decision (Claude Code's PreToolUse JSON), or '' for none. */
export function decisionOutput(d) {
  if (!d) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } });
}
