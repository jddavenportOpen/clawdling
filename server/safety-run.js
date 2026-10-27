// The setup safety audit, put together: which folder each agent's sessions run in, the names-only
// scan of what they load (discover.scanSafety), Clawdling's own part (Donna's channel and allow-list,
// the CTO seat's rules) and the owner's local choices (risks accepted with a reason, capabilities
// tagged on an MCP server Clawdling does not know). Used by GET /api/setup/safety and by
// `clawdling discover --setup --safety`. Reads files only: no process, no socket.
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets, scanSafety } from './discover.js';
import { donnaAllowedTools } from './channels/donna.js';
import { managedSettingsPaths } from './otel.js';
import { ctoPermissions, CTO_ID } from './org.js';
import { auditSafety, CAPS, USER_ROW } from './safety.js';
import { badRequest, clampText, isValidAgentId, oneLine, readJson, writeJson } from './util.js';

const REASON_MAX = 300;
const SERVER_RE = /^[A-Za-z0-9][\w.@-]{0,99}$/;

/** The owner's local choices: `{accepted: {agentId: {reason, at}}, tags: {server: [caps]}}`. */
export class SafetyChoices {
  constructor(file) {
    this.file = file;
  }

  read() {
    const j = readJson(this.file, null);
    const accepted = j && typeof j.accepted === 'object' && j.accepted ? j.accepted : {};
    const tags = j && typeof j.tags === 'object' && j.tags ? j.tags : {};
    return { accepted, tags };
  }

  write(v) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJson(this.file, { schema: 1, accepted: v.accepted, tags: v.tags }, 0o600);
  }

  /** Accept (or, with `reason: null`, stop accepting) an agent's trifecta. A reason is required. */
  accept(id, reason, now = new Date()) {
    if (typeof id !== 'string' || (id !== USER_ROW && !isValidAgentId(id))) throw badRequest('invalid agent id');
    const v = this.read();
    if (reason === null || reason === undefined || reason === false) delete v.accepted[id];
    else {
      const r = oneLine(redactSecrets(clampText(String(reason), REASON_MAX * 2)), REASON_MAX).trim();
      if (r.length < 3) throw badRequest('say why you accept this risk (a few words)');
      v.accepted[id] = { reason: r, at: now.toISOString() };
    }
    this.write(v);
    return v;
  }

  /** Tag what an MCP server (or a plugin) can do (a subset of private, untrusted, sends), or clear it with null. */
  tag(server, caps) {
    if (typeof server !== 'string' || !SERVER_RE.test(server)) throw badRequest('invalid MCP server or plugin name');
    const v = this.read();
    if (caps === null) delete v.tags[server];
    else {
      if (!Array.isArray(caps) || caps.some((c) => !CAPS.includes(c))) throw badRequest(`caps must be a list of ${CAPS.join(', ')}`);
      v.tags[server] = [...new Set(caps)];
    }
    this.write(v);
    return v;
  }
}

/** The folder an agent's sessions run in (sessions.js resolveTarget) and its --add-dir folders. */
function placeOf(a, home) {
  let cwd = a.dir;
  if (a.kind === 'project' && a.repo) {
    try {
      if (fs.statSync(a.repo).isDirectory()) cwd = a.repo;
    } catch {
      // repo missing: the agent folder
    }
  }
  // The CTO seat reads the report, not the org folder; everyone else gets the org folder (Donna too).
  const addDirs = a.kind === 'cto' ? [] : cwd === home ? [] : [home];
  return { ...a, cwd, addDirs };
}

/**
 * The audit for an org. `agents` = org.agents(); `channels` = {telegram: status(), imessage:
 * status()} (or, offline, what org.json says); `home` = the org folder; `userHome` = the user's home.
 */
export function runSafetyAudit({ agents = [], home, userHome, configDir, claudeJsonPath, env = process.env, channels = {}, choices = null, managed, accounts = 0, platform = process.platform } = {}) {
  const placed = agents.filter((a) => a && typeof a.id === 'string').map((a) => placeOf(a, home));
  const scan = scanSafety({ configDir, claudeJsonPath, dirs: placed.map((a) => a.cwd), homedir: userHome, env, managed: managed || managedSettingsPaths(platform, env), orgHome: home });
  const cto = placed.find((a) => a.kind === 'cto' || a.id === CTO_ID);
  let ctoRules = null;
  if (cto) {
    try {
      ctoRules = ctoPermissions({ dir: cto.dir, home, platform });
    } catch {
      ctoRules = null;
    }
  }
  const { accepted, tags } = choices ? choices.read() : { accepted: {}, tags: {} };
  const audit = auditSafety({
    scan,
    agents: placed,
    org: { home, channels, donnaTools: donnaAllowedTools(home, platform), cto: ctoRules },
    accepted,
    tags,
    home: userHome,
    platform,
  });
  // Extra Claude accounts (1.0.1) are their own config folders, which Clawdling never reads.
  if (accounts > 0 && audit.rows[0]) audit.rows[0].notes.push(`Sessions you start on ${accounts === 1 ? 'your other Claude account' : `one of your ${accounts} other Claude accounts`} load that account's own settings, which Clawdling does not read.`);
  return audit;
}

/** Channels as org.json records them, for the CLI when the cockpit is not running. */
export function offlineChannels(o) {
  const tg = (o && o.channels && o.channels.telegram) || {};
  const im = (o && o.channels && o.channels.imessage) || {};
  const paired = tg.chat_id !== null && tg.chat_id !== undefined;
  return { telegram: { configured: paired || !!tg.enabled, enabled: !!tg.enabled, paired }, imessage: { enabled: !!im.enabled, saved: !!im.handle } };
}

export const PRIVACY = 'Names only, read from files on this computer: rule text (with anything secret-looking replaced by [redacted]), MCP server names, command and package names, plugin names. Never an env value, a header, a hook command or a URL past its host. Nothing is sent anywhere, no process is started, and nothing is changed: every fix is text for you to apply.';
