// Permission modes: what an agent's setting means, and the --permission-mode value that says it.
//
// An agent's `permission_mode` is one of:
//   null / 'ask'   Ask before editing files: Clawdling's default, and what every org made by 1.1.0
//                  stores for that answer. Passed EXPLICITLY, because a Claude Code started with no
//                  --permission-mode uses its own default, which on current versions is auto mode
//                  ("Auto mode is now Claude Code's default permission mode", seen on 2.1.283-2.1.309).
//                  'default' and 'manual' mean the same: they are Claude Code's own names for it.
//   'acceptEdits'  Auto-accept file edits.
//   'plan'         Plan mode.
//   'inherit'      The owner's own Claude Code setting: no flag at all.
// The ask-first mode's name differs between Claude Code versions (`manual` on 2.1.229-2.1.309,
// `default` before), so the names come from `claude --help`, read once at startup.

export const ASK_MODE_NAMES = ['manual', 'default']; // newest first
const KNOWN = new Set(['ask', 'acceptEdits', 'plan', 'inherit']);

export const PERMISSION_LABEL = {
  ask: 'Ask before editing files',
  acceptEdits: 'Auto-accept file edits',
  plan: 'Plan mode',
  inherit: 'Your Claude Code setting',
};

/** The stored setting, normalized: 'ask' | 'acceptEdits' | 'plan' | 'inherit'. */
export function permissionSetting(stored) {
  if (stored === null || stored === undefined || stored === '' || stored === 'manual' || stored === 'default') return 'ask';
  return KNOWN.has(stored) ? stored : 'ask';
}

/**
 * The --permission-mode choices a `claude --help` text lists, e.g. ["acceptEdits", "auto",
 * "bypassPermissions", "manual", "dontAsk", "plan"], or null if the help does not list them.
 */
export function parseModeChoices(help) {
  const text = String(help || '');
  const at = text.search(/--permission-mode\b/);
  if (at === -1) return null;
  const m = /\(choices:\s*([^)]*)\)/.exec(text.slice(at, at + 600));
  if (!m) return null;
  const names = [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]);
  return names.length ? names : null;
}

/**
 * The value for --permission-mode, or null for no flag (the owner's own Claude Code setting).
 * `choices` is parseModeChoices() of the installed claude, or null when it is not known: then the
 * ask-first mode is `default`, which every Claude Code version so far accepts.
 */
export function cliPermissionMode(stored, choices) {
  const setting = permissionSetting(stored);
  if (setting === 'inherit') return null;
  if (setting !== 'ask') return setting;
  const list = Array.isArray(choices) ? choices : [];
  return ASK_MODE_NAMES.find((n) => list.includes(n)) || 'default';
}
