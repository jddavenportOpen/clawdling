// Sessions = real Claude Code processes, run by a session backend: Clawdling's tmux server
// (server/tmux.js) or a pseudo-terminal per session (server/pty.js). Both offer the same surface.
//
// One registry (sessions.json) + one control client per live session. Output is fanned out to
// WebSocket viewers; input from viewers goes back to the session. Status comes from Claude Code
// hooks (see hooks.js). With tmux, sessions outlive the Clawdling server: on start we reconcile the
// registry with `tmux ls` and reattach. With pty, they end when it stops and stay resumable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_EVENTS, applyHookEvent, isLive } from './hooks.js';
import { which } from './paths.js';
import { prependPath } from './platform.js';
import { CLEAR, ModeTracker, OutputFilter, buildSnapshot } from './termfilter.js';
import { cleanTitle, deriveTitle } from './titles.js';
import {
  HttpError,
  badRequest,
  conflict,
  isUuid,
  isValidAgentId,
  isValidEffort,
  isValidModel,
  notFound,
  nowIso,
  oneLine,
  readJson,
  shq,
  sleep,
  stripAnsi,
  writeFileAtomic,
  writeJson,
} from './util.js';

export { buildSnapshot }; // moved to termfilter.js (the tmux backend builds snapshots now)

const RING_MAX = 256 * 1024;
const ENDED_VISIBLE_MS = 14 * 24 * 3600 * 1000;
const ENDED_KEEP_MS = 30 * 24 * 3600 * 1000;
const STARTUP_STALL_MS = 20000;
const PROMPT_MAX = 100 * 1024;
const WS_HIGH_WATER = 16 * 1024 * 1024;

const TRUST_RE = /Yes, I trust this folder|Quick safety check: Is this a project|Do you trust the files in this folder/i;
const IMPORTS_RE = /Allow external CLAUDE\.md file imports/i;
// Claude Code 2.1.283 before it is signed in: the first-run setup ("Let's get started.", then
// "Select login method:"), or a sign-in error ("Not logged in · Please run /login", "Invalid API key").
const LOGIN_RE = /Select login method|Let['’]s get started\.|Please run \/login|Not logged in|Invalid API key/i;
/** What to answer when Claude Code's folder-trust dialog is on screen. */
export function trustNotice(folder) {
  return (
    `Claude Code asks whether you trust ${folder}. Answer 2 ("Yes, I trust this folder") to start the session; ` +
    '1 ("No, exit") ends it. In the terminal: arrow down to "Yes, I trust this folder", then Enter. ' +
    'Trusting your org folder once covers every agent inside it; a project agent whose code lives elsewhere asks once for its repo.'
  );
}
export const TRUST_NOTICE = trustNotice('this folder');
export const IMPORTS_NOTICE = 'Claude Code asks whether to allow CLAUDE.md imports from outside this folder. Answer in the terminal (or with the choices shown).';
export const LOGIN_NOTICE = 'Claude Code is not signed in on this computer (or not set up yet). Open a terminal, run claude, finish its setup and sign-in, then end this session and start it again.';
export const STALL_NOTICE = 'Claude Code has not started after 20 seconds. Check the terminal: it may be asking you to sign in or to answer a question.';
export const STOPPED_NOTICE = 'Clawdling stopped, so this session ended (without tmux, sessions run inside Clawdling). Resume it to pick up where it left off.';
// What tells a program which terminal it is in. A pty session's terminal is Clawdling's, not the
// one `clawdling start` ran in, so these are not passed on (tmux sets its own).
const TERMINAL_IDENTITY = /^(TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|TERMINAL_EMULATOR|COLORFGBG|ITERM_[A-Z_]+|LC_TERMINAL(_VERSION)?|WT_SESSION|WT_PROFILE_ID|KITTY_[A-Z_]+|ALACRITTY_[A-Z_]+|WEZTERM_[A-Z_]+|GHOSTTY_[A-Z_]+|KONSOLE_[A-Z_]+|VTE_VERSION|VSCODE_[A-Z_]+|TMUX|TMUX_PANE|STY|WINDOWID)$/;
const ANSWER_IN_TERMINAL = new Set(['trust', 'imports', 'login', 'startup', 'permission_prompt', 'elicitation_dialog']);
// Questions POST /api/sessions/:sid/answer may answer: Claude Code's own select lists.
const ANSWERABLE = new Set(['trust', 'imports', 'permission_prompt']);
const POINTER = '\u276f'; // the "❯" Claude Code puts in front of the selected choice
const KEY = { up: Buffer.from('\x1b[A'), down: Buffer.from('\x1b[B'), enter: Buffer.from('\r') };
const DIALOG_ARM_MS = 1500; // Claude Code ignores keys for a moment after a dialog opens
// When to look for a question's choices after its Notification (ms): the list may draw late.
const CHOICE_RETRY_MS = [300, 1000, 2500, 5000, 9000];

/**
 * The choices of a Claude Code select list on screen, in screen order, and which one has the
 * pointer. The live question is the lowest list on screen (older answered ones, or a past prompt
 * line, can still show a "❯" higher up). Wrapped (deeper-indented) lines continue the choice above
 * them. Null if no list is on screen.
 */
export function parseChoices(screen) {
  const lines = String(screen || '').split('\n');
  const pointer = new RegExp(`^\\s*${POINTER}\\s+\\S`);
  for (let sel = lines.length - 1; sel >= 0; sel--) {
    if (!pointer.test(lines[sel])) continue;
    const found = choicesAround(lines, sel);
    if (found) return found;
  }
  return null;
}

function choicesAround(lines, sel) {
  const col = lines[sel].indexOf(POINTER);
  const textCol = lines[sel].slice(col + 1).search(/\S/) + col + 1;
  const indent = (l) => (l.trim() ? l.search(/\S/) : -1);
  const kind = (l) => {
    if (!l || !l.trim()) return 'stop';
    if (l.indexOf(POINTER) === col && indent(l) === col) return 'option';
    const i = indent(l);
    if (i === textCol) return 'option';
    if (i > textCol) return 'more';
    return 'stop';
  };
  let top = sel;
  while (top > 0 && kind(lines[top - 1]) !== 'stop') top--;
  while (top < sel && kind(lines[top]) === 'more') top++;
  const labels = [];
  let selected = -1;
  for (let i = top; i < lines.length; i++) {
    const k = kind(lines[i]);
    if (k === 'stop') break;
    if (k === 'more') {
      if (labels.length) labels[labels.length - 1] += ` ${lines[i].trim()}`;
      continue;
    }
    if (i === sel) selected = labels.length;
    labels.push(lines[i].slice(textCol).trim());
  }
  if (labels.length < 2 || selected === -1) return null;
  return { labels, selected };
}

/** Which startup dialog (if any) a rendered screen shows. Whitespace-insensitive. */
export function dialogFromScreen(screen) {
  const flat = String(screen || '').replace(/\s+/g, ' ');
  const tight = flat.replace(/ /g, '').toLowerCase();
  if (TRUST_RE.test(flat) || tight.includes('yes,itrustthisfolder') || tight.includes('quicksafetycheck:isthisaproject')) return { waiting: 'trust', notice: TRUST_NOTICE };
  // (callers replace the generic notice with trustNotice(<session folder>))
  if (IMPORTS_RE.test(flat) || tight.includes('allowexternalclaude.mdfileimports')) return { waiting: 'imports', notice: IMPORTS_NOTICE };
  if (LOGIN_RE.test(flat) || tight.includes('selectloginmethod')) return { waiting: 'login', notice: LOGIN_NOTICE };
  return null;
}

/**
 * Positional prompts go after `--` so a leading dash is never parsed as an option. A prompt that is
 * one bare word gets a trailing space so it can never be dispatched as a claude subcommand
 * (`claude -- update` would otherwise run `claude update`).
 */
export function safePositional(prompt) {
  return /\s/.test(prompt) ? prompt : `${prompt} `;
}

export function buildClaudeArgs({ sid, resume = false, resumeId, name, settingsPath, model, effort, permissionMode, addDirs = [], appendSystemPromptFile, prompt }) {
  const a = [];
  if (resume) a.push('--resume', resumeId || sid);
  else a.push('--session-id', sid);
  if (name) a.push(`--name=${name}`);
  if (settingsPath) a.push('--settings', settingsPath);
  if (model) a.push(`--model=${model}`);
  if (effort) a.push(`--effort=${effort}`);
  if (permissionMode && permissionMode !== 'default') a.push('--permission-mode', permissionMode);
  for (const d of addDirs) a.push('--add-dir', d);
  if (appendSystemPromptFile) a.push('--append-system-prompt-file', appendSystemPromptFile);
  if (prompt) a.push('--', safePositional(prompt));
  return a;
}

/** A /bin/sh launcher: cd, export env, exec argv. Every value is single-quoted. */
export function buildLauncherScript({ cwd, env = {}, argv, comment = 'Clawdling session launcher' }) {
  const lines = ['#!/bin/sh', `# ${oneLine(comment, 200)}`];
  lines.push(`cd ${shq(cwd)} || exit 1`);
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid environment variable name ${k}`);
    lines.push(`${k}=${shq(v)}; export ${k}`);
  }
  lines.push(`exec ${argv.map(shq).join(' ')}`);
  return lines.join('\n') + '\n';
}

/** A viewer's terminal size (WS ?cols=&rows= or a resize message), or null if out of range. */
export function validSize(cols, rows) {
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isInteger(c) || !Number.isInteger(r)) return null;
  if (c < 20 || c > 500 || r < 4 || r > 200) return null;
  return { cols: c, rows: r };
}

/**
 * Pure reconcile of registry rows against `tmux ls`. Live rows whose tmux session is gone become
 * ended; rows whose tmux session exists are (re)attached; tagged orphans are adopted.
 */
export function reconcileRecords(records, live, now = nowIso()) {
  const byName = new Map(live.map((s) => [s.name, s]));
  const attach = [];
  const ended = [];
  for (const rec of records) {
    const t = byName.get(rec.tmux_name);
    if (t) {
      byName.delete(rec.tmux_name);
      if (t.pane) rec.pane_id = t.pane;
      if (rec.status === 'ended') {
        rec.status = 'ready';
        rec.ended_at = null;
      }
      attach.push(rec);
    } else if (rec.status !== 'ended') {
      rec.status = 'ended';
      rec.ended_at = now;
      rec.waiting_on = null;
      ended.push(rec);
    }
  }
  const orphans = [...byName.values()].filter((t) => t.name.startsWith('cl-') && isUuid(t.sid) && !records.some((r) => r.sid === t.sid));
  return { attach, ended, orphans };
}

function newRecord(fields) {
  const now = nowIso();
  return {
    sid: fields.sid,
    agent: fields.agent,
    agent_name: fields.agent_name,
    kind: fields.kind,
    title: fields.title ?? null,
    status: fields.status ?? 'starting',
    model: fields.model ?? null,
    effort: fields.effort ?? null,
    account: fields.account ?? null,
    purpose: fields.purpose ?? null,
    permission_mode: fields.permission_mode ?? null,
    cwd: fields.cwd,
    tmux_name: fields.tmux_name,
    pane_id: fields.pane_id ?? null,
    created_at: fields.created_at ?? now,
    last_activity_at: fields.last_activity_at ?? now,
    ended_at: null,
    notification: null,
    waiting_on: null,
    prompted: !!fields.prompted,
    pending_prompt: !!fields.pending_prompt,
    hooked: false,
    claude_session_id: fields.sid,
    resumed_from: null,
    transcript_path: null,
    last_message: null,
    modes: [],
  };
}

function sendWs(ws, msg) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > WS_HIGH_WATER) {
    ws.close(1013, 'viewer too slow; reconnect for a fresh snapshot');
    return;
  }
  ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

export class SessionManager {
  constructor({ paths, org, events, backend, tmux, claudeBin, socket, shimDir, env, logger, getPort, accounts }) {
    this.accounts = accounts || null;
    this.paths = paths;
    this.home = paths.home;
    this.org = org;
    this.events = events;
    this.backend = backend || tmux; // tmux or pty (see server/backend.js); `tmux` is the old name
    this.claudeBin = claudeBin;
    this.socket = socket;
    this.shimDir = shimDir;
    this.env = env;
    this.logger = logger;
    this.getPort = getPort;
    this.records = new Map();
    this.runtime = new Map();
    this.closing = false;
    this.saveTimer = null;
  }

  // ---------------------------------------------------------------- persistence

  load() {
    const data = readJson(this.paths.sessions, { sessions: [] });
    const cutoff = Date.now() - ENDED_KEEP_MS;
    for (const r of Array.isArray(data?.sessions) ? data.sessions : []) {
      if (!r || !isUuid(r.sid) || !r.tmux_name) continue;
      if (r.status === 'ended' && r.ended_at && Date.parse(r.ended_at) < cutoff) continue;
      this.records.set(r.sid, { ...newRecord(r), ...r });
    }
  }

  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    for (const [sid, rt] of this.runtime) {
      const rec = this.records.get(sid);
      if (rec) rec.modes = rt.modes.list();
    }
    writeJson(this.paths.sessions, { version: 1, backend: this.backend.kind || 'tmux', socket: this.socket, sessions: [...this.records.values()] }, 0o600);
  }

  scheduleSave() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 500);
  }

  // ---------------------------------------------------------------- views

  view(rec) {
    return {
      sid: rec.sid,
      agent: rec.agent,
      agent_name: rec.agent_name,
      kind: rec.kind,
      title: rec.title,
      name: `${rec.agent_name}: ${rec.title || 'new session'}`,
      status: rec.status,
      model: rec.model,
      effort: rec.effort || null,
      account: rec.account || null,
      purpose: rec.purpose || null,
      permission_mode: rec.permission_mode,
      cwd: rec.cwd,
      tmux_name: rec.tmux_name,
      created_at: rec.created_at,
      last_activity_at: rec.last_activity_at,
      ended_at: rec.ended_at,
      notification: rec.notification,
      waiting_on: rec.status === 'needs_you' ? rec.waiting_on || null : null,
      choices: rec.status === 'needs_you' && ANSWERABLE.has(rec.waiting_on) && Array.isArray(rec.choices) ? rec.choices : null,
      resumable: rec.status === 'ended',
      last_message: rec.last_message,
      transcript_path: rec.transcript_path,
      attach_cmd: this.backend.attachCommand ? this.backend.attachCommand(rec) : `tmux -L ${this.socket} attach -t ${rec.tmux_name}`,
    };
  }

  list() {
    const cutoff = Date.now() - ENDED_VISIBLE_MS;
    return [...this.records.values()]
      .filter((r) => r.status !== 'ended' || !r.ended_at || Date.parse(r.ended_at) >= cutoff)
      .sort((a, b) => (b.last_activity_at || b.created_at).localeCompare(a.last_activity_at || a.created_at))
      .map((r) => this.view(r));
  }

  get(sid) {
    return this.records.get(sid) || null;
  }

  require(sid) {
    if (!isUuid(sid)) throw badRequest('invalid session id');
    const rec = this.records.get(sid);
    if (!rec) throw notFound('no such session');
    return rec;
  }

  /** {agentId: {live, needs_you, last_activity_at}} for the org view. */
  agentStats() {
    const out = {};
    for (const r of this.records.values()) {
      const s = (out[r.agent] ||= { live: 0, needs_you: 0, last_activity_at: null });
      if (isLive(r.status)) s.live++;
      if (r.status === 'needs_you' || r.status === 'ready') s.needs_you++;
      const t = r.last_activity_at || r.created_at;
      if (!s.last_activity_at || t > s.last_activity_at) s.last_activity_at = t;
    }
    return out;
  }

  publish(rec) {
    this.events.publish('session', this.view(rec));
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    this.load();
    await this.reconcile();
    this.replaySpool();
  }

  async reconcile() {
    const live = await this.backend.listSessions();
    const recs = [...this.records.values()];
    const { attach, ended, orphans } = reconcileRecords(recs, live);
    for (const rec of ended) {
      if (this.backend.persistent === false) rec.notification = STOPPED_NOTICE;
      this.events.record({ type: 'end', sid: rec.sid, agent: rec.agent, reason: 'gone at startup' });
    }
    for (const t of orphans) {
      let target;
      try {
        target = this.resolveTarget(isValidAgentId(t.agent) ? t.agent : 'scratch');
      } catch {
        target = this.resolveTarget('scratch');
      }
      const rec = newRecord({ sid: t.sid, agent: target.id, agent_name: target.name, kind: target.kind, cwd: target.cwd, tmux_name: t.name, pane_id: t.pane, status: 'ready', prompted: true });
      rec.hooked = true;
      this.records.set(rec.sid, rec);
      attach.push(rec);
    }
    for (const rec of attach) {
      rec.hooked = true; // it was running before we started; don't scan old output for dialogs
      this.attachControl(rec);
    }
    this.save();
    return { attached: attach.length, ended: ended.length, adopted: orphans.length };
  }

  /** Apply hook events the hook script spooled while the server was down. */
  replaySpool() {
    const file = this.paths.hookSpool;
    const tmp = `${file}.replay-${process.pid}`;
    let text = '';
    try {
      fs.renameSync(file, tmp);
      text = fs.readFileSync(tmp, 'utf8');
      fs.unlinkSync(tmp);
    } catch {
      return 0;
    }
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (isUuid(e.sid) && this.records.has(e.sid) && HOOK_EVENTS.includes(e.event)) {
          this.applyHook(e.event, e.sid, e.payload || {}, e.ts);
          n++;
        }
      } catch {
        // skip torn line
      }
    }
    if (n) this.save();
    return n;
  }

  resolveTarget(agentId) {
    if (agentId === 'scratch') {
      return { id: 'scratch', kind: 'scratch', name: 'Scratch', dir: this.home, cwd: this.home, model: null, permission_mode: null, repo: null };
    }
    if (!isValidAgentId(agentId)) throw badRequest('invalid agent id');
    const a = this.org.agent(agentId);
    if (!a) throw notFound(`no agent "${agentId}"`);
    let cwd = a.dir;
    if (a.kind === 'project' && a.repo) {
      try {
        if (fs.statSync(a.repo).isDirectory()) cwd = a.repo;
      } catch {
        // repo missing: work in the agent folder
      }
    }
    return { ...a, cwd };
  }

  /** Per-agent context file passed with --append-system-prompt-file (me.md, and for repo-rooted
   * project agents also the org + agent CLAUDE.md and NOW.md, which do not load from a repo). */
  writeContextFile(target) {
    const read = (f, max = 60000) => {
      try {
        const t = fs.readFileSync(f, 'utf8');
        return t.length > max ? t.slice(0, max) + '\n[truncated]' : t;
      } catch {
        return '';
      }
    };
    let owner = 'the owner';
    try {
      owner = this.org.read().owner || owner;
    } catch {
      // fall back
    }
    const lines = ['# Clawdling session context', '', `You are running inside Clawdling, ${owner}'s org of Claude Code agents. Org folder: ${this.home}`];
    if (target.kind === 'scratch') {
      lines.push('This is a Scratch session at the org root, not tied to one agent.');
    } else {
      lines.push(`You are the ${target.name} agent (kind: ${target.kind}, id: ${target.id}). Your agent folder: ${target.dir}`);
      lines.push(`Your memory files: ${path.join(target.dir, 'memory', 'NOW.md')} and ${path.join(target.dir, 'memory', 'LOG.md')}. Update them before you finish (the /handoff skill).`);
    }
    lines.push('', `## About ${owner} (me.md)`, '', read(this.paths.meMd).trim() || '(me.md is empty)');
    if (target.kind === 'project' && target.cwd !== target.dir) {
      const agentMd = read(path.join(target.dir, 'CLAUDE.md')).replace(/^@memory\/NOW\.md\s*$/m, '(see "Current state" below)');
      lines.push('', '## Org rules (the org CLAUDE.md)', '', read(this.paths.orgClaudeMd).trim());
      lines.push('', `## Your agent file (${path.join(target.dir, 'CLAUDE.md')})`, '', agentMd.trim());
      lines.push('', '## Current state (memory/NOW.md)', '', read(path.join(target.dir, 'memory', 'NOW.md')).trim());
    }
    const file = path.join(this.paths.ctx, `${target.id}.md`);
    writeFileAtomic(file, lines.join('\n') + '\n', 0o600);
    return file;
  }

  claudeAbs() {
    return which(this.claudeBin, this.env.PATH || '');
  }

  async spawn({ agent, prompt, model, effort, account, purpose, title, cols, rows } = {}) {
    if (typeof agent !== 'string' || !agent) throw badRequest('agent is required');
    const target = this.resolveTarget(agent);
    if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') throw badRequest('prompt must be a string');
    const text = typeof prompt === 'string' ? prompt.replace(/\0/g, '').slice(0, PROMPT_MAX).trim() : '';
    if (model !== undefined && model !== null && model !== '' && !isValidModel(model)) throw badRequest('invalid model');
    if (effort !== undefined && effort !== null && effort !== '' && !isValidEffort(effort)) throw badRequest('effort must be low, medium, high, xhigh or max');
    const accountId = account && account !== 'default' ? account : null;
    if (accountId) this.accountDir(accountId); // unknown or invalid account: 400/404 before anything starts
    if (!this.claudeAbs()) throw new HttpError(500, `claude CLI not found (looked for "${this.claudeBin}" on PATH). Install Claude Code and sign in.`);
    const missing = this.backend.missing ? this.backend.missing(this.env.PATH || '') : null;
    if (missing) throw new HttpError(500, missing);
    const sid = crypto.randomUUID();
    const rec = newRecord({
      sid,
      agent: target.id,
      agent_name: target.name,
      kind: target.kind,
      title: cleanTitle(title) || (text ? deriveTitle(text) : null),
      model: model || target.model || null,
      effort: effort || null,
      account: accountId,
      purpose: purpose === 'signin' ? 'signin' : null,
      permission_mode: target.permission_mode || null,
      cwd: target.cwd,
      tmux_name: `cl-${target.id}-${sid.slice(0, 6)}`,
      prompted: !!text,
      pending_prompt: !!text,
    });
    this.records.set(sid, rec);
    this.save(); // registry row exists before anything is launched
    try {
      await this.launch(rec, { prompt: text, resume: false, cols, rows });
    } catch (err) {
      rec.status = 'ended';
      rec.ended_at = nowIso();
      rec.notification = `Could not start: ${oneLine(err.stderr || err.message, 200)}`;
      this.save();
      this.publish(rec);
      throw err instanceof HttpError ? err : new HttpError(500, rec.notification);
    }
    this.events.record({ type: 'spawn', sid, agent: rec.agent, title: rec.title });
    this.publish(rec);
    return this.view(rec);
  }

  async launch(rec, { prompt = '', resume = false, cols, rows } = {}) {
    const target = this.resolveTarget(rec.agent);
    rec.cwd = target.cwd;
    rec.agent_name = target.name;
    const c = Number.isInteger(cols) && cols >= 20 && cols <= 500 ? cols : 140;
    const r = Number.isInteger(rows) && rows >= 5 && rows <= 200 ? rows : 40;
    const ctxFile = this.writeContextFile(target);
    const args = buildClaudeArgs({
      sid: rec.sid,
      resume,
      resumeId: rec.claude_session_id || rec.sid,
      name: `${rec.agent_name}: ${rec.title || 'new session'}`,
      settingsPath: this.paths.hooksSettings,
      model: rec.model,
      effort: rec.effort,
      permissionMode: rec.permission_mode,
      addDirs: rec.cwd === this.home ? [] : [this.home],
      appendSystemPromptFile: ctxFile,
      prompt,
    });
    const claude = this.claudeAbs();
    if (!claude) throw new HttpError(500, `claude CLI not found (looked for "${this.claudeBin}" on PATH)`);
    const sessionEnv = {
      CLAWDLING_SID: rec.sid,
      CLAWDLING_HOME: this.home,
      CLAWDLING_PORT: String(this.getPort()),
      CLAWDLING_TMUX_SOCKET: this.socket,
      COLORTERM: 'truecolor',
    };
    // A second Claude account is only its own config folder, handed to this session's claude.
    const accountDir = this.accountDir(rec.account);
    if (accountDir) sessionEnv.CLAUDE_CONFIG_DIR = accountDir;
    let how;
    if (this.backend.launcher) {
      // tmux: a /bin/sh launcher, so tmux only ever sees our own safe strings.
      const script = buildLauncherScript({
        cwd: rec.cwd,
        env: { ...sessionEnv, PATH: `${this.shimDir}:${this.env.PATH || '/usr/bin:/bin'}` },
        argv: [claude, ...args],
        comment: `Clawdling launcher for session ${rec.sid} (agent ${rec.agent}). Safe to delete after the session ends.`,
      });
      const scriptPath = path.join(this.paths.run, `${rec.sid}.sh`);
      writeFileAtomic(scriptPath, script, 0o700);
      how = { command: ['/bin/sh', scriptPath] };
    } else {
      // pty: claude is spawned directly with its argv (no shell on any OS) and the full environment.
      const env = prependPath(this.env, this.shimDir);
      for (const k of Object.keys(env)) if (TERMINAL_IDENTITY.test(k)) delete env[k];
      how = { launch: { cwd: rec.cwd, env: { ...env, ...sessionEnv }, argv: [claude, ...args] } };
    }
    if (await this.backend.hasSession(rec.tmux_name)) throw conflict(`session ${rec.tmux_name} already exists`);
    const { paneId } = await this.backend.newSession({ name: rec.tmux_name, cols: c, rows: r, ...how });
    rec.pane_id = paneId || null;
    rec.status = 'starting';
    rec.ended_at = null;
    rec.notification = null;
    rec.waiting_on = null;
    rec.hooked = false;
    rec.launched_at = nowIso();
    await this.backend.setOptions(rec.tmux_name, [
      ['window-size', 'manual'],
      ['@clawdling_sid', rec.sid],
      ['@clawdling_agent', rec.agent],
    ]);
    const rt = this.rt(rec.sid);
    rt.gen++;
    rt.launchedAt = Date.now();
    rt.size = { cols: c, rows: r };
    // A control client of the previous run may still be open (ConPTY reports an exit about a second
    // late): drop it, or attachControl would keep it and the new process would have no viewers.
    if (rt.control) {
      const old = rt.control;
      rt.control = null;
      old.close();
    }
    this.attachControl(rec);
    // One look at the screen even if no output follows: a dialog drawn in the few ms before the
    // control client attached produces no output event (seen on fast Linux CI runners).
    this.detectDialogs(rec, rt);
    clearTimeout(rt.stallTimer);
    rt.stallTimer = setTimeout(() => {
      if (!rec.hooked && rec.status === 'starting') {
        rec.status = 'needs_you';
        rec.waiting_on = 'startup';
        rec.notification = STALL_NOTICE;
        this.onStatusChange(rec);
      }
    }, STARTUP_STALL_MS);
    rt.stallTimer.unref?.();
    this.save();
  }

  rt(sid) {
    let rt = this.runtime.get(sid);
    if (!rt) {
      const rec = this.records.get(sid);
      rt = {
        control: null,
        viewers: new Set(),
        pending: '',
        flushTimer: null,
        carryTimer: null,
        stallTimer: null,
        resizeTimer: null,
        ring: [],
        ringBytes: 0,
        filter: new OutputFilter(),
        modes: new ModeTracker(rec?.modes || []),
        gen: 0,
        reattach: 0,
        lastActivityMark: 0,
        lastPublish: 0,
        launchedAt: 0,
        size: null,
      };
      this.runtime.set(sid, rt);
    }
    return rt;
  }

  attachControl(rec) {
    const rt = this.rt(rec.sid);
    if (rt.control && !rt.control.closed) return rt.control;
    const cc = this.backend.control(rec.tmux_name, rec.pane_id);
    const gen = rt.gen;
    rt.control = cc;
    cc.on('output', (text) => this.onOutput(rec, rt, text));
    cc.on('close', (info) => {
      this.onControlClose(rec, rt, cc, gen, info).catch((err) => this.logger?.warn?.(`control close: ${err.message}`));
    });
    // Tell any viewers already connected (e.g. after a resume) what the screen looks like now.
    for (const ws of rt.viewers) this.snapshotTo(rec, rt, ws, { register: false });
    return cc;
  }

  onOutput(rec, rt, raw) {
    rt.lastOutputAt = Date.now();
    const text = rt.filter.push(raw);
    if (rt.filter.carry && !rt.carryTimer) {
      rt.carryTimer = setTimeout(() => {
        rt.carryTimer = null;
        const rest = rt.filter.flush();
        if (rest) this.onFiltered(rec, rt, rest);
      }, 60);
    }
    if (text) this.onFiltered(rec, rt, text);
  }

  onFiltered(rec, rt, text) {
    rt.modes.feed(text);
    rt.ring.push(text);
    rt.ringBytes += text.length;
    while (rt.ringBytes > RING_MAX && rt.ring.length > 1) rt.ringBytes -= rt.ring.shift().length;
    rt.pending += text;
    if (!rt.flushTimer) rt.flushTimer = setTimeout(() => this.flushOutput(rec, rt), 10);
    const now = Date.now();
    if (now - rt.lastActivityMark > 2000) {
      rt.lastActivityMark = now;
      rec.last_activity_at = new Date(now).toISOString();
      this.scheduleSave();
      if (now - rt.lastPublish > 10000) {
        rt.lastPublish = now;
        this.publish(rec);
      }
    }
    if (!rec.hooked && (rec.status === 'starting' || rec.status === 'needs_you')) this.detectDialogs(rec, rt);
  }

  ringText(rt, max = RING_MAX) {
    const s = rt.ring.join('');
    return s.length > max ? s.slice(-max) : s;
  }

  /**
   * Claude Code's startup dialogs (folder trust, external imports) appear before any hook can
   * run. Look at the screen tmux actually rendered (Ink draws with cursor moves, so the raw stream
   * is not reliable text) a moment after output arrives, until the first hook comes in.
   */
  detectDialogs(rec, rt) {
    if (rt.dialogTimer) return;
    rt.dialogTimer = setTimeout(async () => {
      rt.dialogTimer = null;
      if (rec.hooked || !(rec.status === 'starting' || rec.status === 'needs_you')) return;
      let screen;
      try {
        screen = await this.backend.screenText(rec.pane_id || `=${rec.tmux_name}:`);
      } catch {
        screen = stripAnsi(this.ringText(rt, 8000));
      }
      if (rec.hooked) return;
      const d = dialogFromScreen(screen);
      if (d && rec.waiting_on !== d.waiting) {
        rec.status = 'needs_you';
        rec.waiting_on = d.waiting;
        rec.notification = d.waiting === 'trust' ? trustNotice(rec.cwd) : d.notice;
        const c = parseChoices(screen);
        rec.choices = c ? c.labels.map((label, i) => ({ option: i + 1, label })) : null;
        rt.dialogSeenAt = Date.now();
        this.onStatusChange(rec);
      }
    }, 250);
    rt.dialogTimer.unref?.();
  }

  flushOutput(rec, rt) {
    if (rt.flushTimer) {
      clearTimeout(rt.flushTimer);
      rt.flushTimer = null;
    }
    if (!rt.pending) return;
    const msg = JSON.stringify({ t: 'out', data: rt.pending });
    rt.pending = '';
    for (const ws of rt.viewers) sendWs(ws, msg);
  }

  async onControlClose(rec, rt, cc, gen, info) {
    if (rt.control === cc) rt.control = null;
    if (this.closing) return;
    this.flushOutput(rec, rt);
    if (rt.gen !== gen) return; // a newer launch owns this session name now
    const alive = await this.backend.hasSession(rec.tmux_name);
    if (rt.gen !== gen || this.closing) return;
    if (alive) {
      if (rt.reattach++ < 5) {
        setTimeout(() => {
          if (!this.closing && rt.gen === gen) this.attachControl(rec);
        }, 250 * rt.reattach).unref?.();
      } else {
        this.logger?.warn?.(`giving up reattaching to ${rec.tmux_name}: ${oneLine(info?.stderr || '', 200)}`);
      }
      return;
    }
    this.markEnded(rec);
  }

  markEnded(rec, { notice } = {}) {
    const rt = this.rt(rec.sid);
    if (rec.status !== 'ended') rec.status = 'ended';
    if (!rec.ended_at) rec.ended_at = nowIso();
    const first = rt.endedGen !== rt.gen;
    rt.endedGen = rt.gen;
    rec.waiting_on = null;
    clearTimeout(rt.stallTimer);
    if (notice !== undefined) rec.notification = notice;
    else if (first && !rec.hooked && rt.launchedAt && Date.now() - rt.launchedAt < 15000) {
      const lastLines = stripAnsi(this.ringText(rt, 4000)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' / ');
      rec.notification = `Claude Code exited right after starting${lastLines ? `: ${oneLine(lastLines, 240)}` : ''}`;
    } else if (first) {
      rec.notification = null;
    }
    try {
      fs.unlinkSync(path.join(this.paths.run, `${rec.sid}.sh`));
    } catch {
      // already gone
    }
    this.flushOutput(rec, rt);
    if (first) {
      for (const ws of rt.viewers) {
        sendWs(ws, { t: 'status', status: 'ended' });
        sendWs(ws, { t: 'ended' });
      }
      this.events.record({ type: 'end', sid: rec.sid, agent: rec.agent });
    }
    this.save();
    this.publish(rec);
  }

  onStatusChange(rec) {
    const rt = this.runtime.get(rec.sid);
    if (rec.status === 'ended') {
      this.markEnded(rec, { notice: rec.notification });
      return;
    }
    if (rt) for (const ws of rt.viewers) sendWs(ws, { t: 'status', status: rec.status });
    this.events.record({ type: 'status', sid: rec.sid, agent: rec.agent, status: rec.status, ...(rec.notification ? { notification: rec.notification } : {}) });
    this.scheduleSave();
    this.publish(rec);
  }

  /**
   * Apply one hook event. `ts` is when the hook fired: events older than the newest one already
   * applied are dropped, so a spooled event replayed after a newer live one (the hook timed out
   * but the server had in fact received it) cannot roll a session back to "working".
   */
  applyHook(event, sid, payload = {}, ts) {
    if (!HOOK_EVENTS.includes(event)) throw badRequest('unknown hook event');
    const rec = this.require(sid);
    const at = typeof ts === 'string' ? Date.parse(ts) : NaN;
    if (Number.isFinite(at)) {
      if (rec.last_hook_ms && at < rec.last_hook_ms) return this.view(rec);
      rec.last_hook_ms = at;
    }
    rec.hooked = true;
    const rt = this.runtime.get(sid);
    if (rt) clearTimeout(rt.stallTimer);
    const { statusChanged, titleChanged } = applyHookEvent(rec, event, payload && typeof payload === 'object' ? payload : {});
    if (event === 'Notification' && rec.waiting_on === 'permission_prompt') {
      rec.choices = null;
      if (rt) rt.dialogSeenAt = Date.now();
      this.captureChoices(rec); // the numbered choices, for clients that answer with buttons
    }
    if (titleChanged) this.events.record({ type: 'rename', sid, title: rec.title, auto: true });
    if (statusChanged) this.onStatusChange(rec);
    else {
      this.scheduleSave();
      this.publish(rec);
    }
    return this.view(rec);
  }

  /**
   * Read the numbered choices off the screen. Claude Code can send the Notification hook before it
   * has drawn the list (a real AskUserQuestion or permission prompt), so look again a few times.
   */
  captureChoices(rec, delays = CHOICE_RETRY_MS) {
    const asking = () => rec.status === 'needs_you' && ANSWERABLE.has(rec.waiting_on);
    const attempt = (i) => {
      if (i >= delays.length) return;
      setTimeout(async () => {
        if (!asking() || rec.choices) return;
        try {
          const c = parseChoices(await this.backend.screenText(rec.pane_id || `=${rec.tmux_name}:`));
          if (c && asking() && !rec.choices) {
            rec.choices = c.labels.map((label, n) => ({ option: n + 1, label }));
            this.publish(rec);
            return;
          }
        } catch {
          // the session may be gone
        }
        attempt(i + 1);
      }, delays[i] - (i ? delays[i - 1] : 0)).unref?.();
    };
    attempt(0);
  }

  rename(sid, title) {
    const rec = this.require(sid);
    if (title !== null && typeof title !== 'string') throw badRequest('title must be a string');
    rec.title = cleanTitle(title);
    this.events.record({ type: 'rename', sid, title: rec.title });
    this.save();
    this.publish(rec);
    return this.view(rec);
  }

  async end(sid) {
    const rec = this.require(sid);
    if (rec.status === 'ended' && !(await this.backend.hasSession(rec.tmux_name))) return this.view(rec);
    await this.backend.killSession(rec.tmux_name);
    this.markEnded(rec, { notice: null });
    return this.view(rec);
  }

  async resume(sid, { cols, rows } = {}) {
    const rec = this.require(sid);
    if (await this.backend.hasSession(rec.tmux_name)) {
      if (rec.status === 'ended') {
        rec.status = 'ready';
        rec.ended_at = null;
        this.attachControl(rec);
        this.onStatusChange(rec);
      }
      return this.view(rec);
    }
    this.resolveTarget(rec.agent); // the agent must still exist
    rec.pending_prompt = false;
    await this.launch(rec, { resume: !!rec.prompted, cols, rows });
    this.events.record({ type: 'resume', sid, agent: rec.agent });
    this.publish(rec);
    return this.view(rec);
  }

  async waitFor(pred, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (pred()) return true;
      await sleep(100);
    }
    return pred();
  }

  /** CLAUDE_CONFIG_DIR for a session's account, or null for the user's own default login. */
  accountDir(account) {
    if (!account || account === 'default') return null;
    if (!this.accounts) throw badRequest('accounts are not available on this server');
    return this.accounts.configDir(account);
  }

  /** The config folder this session's claude writes its transcripts under. */
  configDirFor(rec, fallback) {
    try {
      return this.accountDir(rec.account) || fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Switch a live session's model or effort (the pane chips). Only between turns (status ready).
   * The session's claude is restarted on the same conversation with --resume and the new
   * --model / --effort flags, which apply to this session only. Typing /model or /effort instead
   * would also save the choice as the user's default for every new session (Claude Code 2.1.283
   * says so on screen), and Clawdling never changes the user's Claude settings.
   */
  async settings(sid, { model, effort } = {}) {
    const rec = this.require(sid);
    const m = model === undefined || model === null || model === '' ? null : model;
    const e = effort === undefined || effort === null || effort === '' ? null : effort;
    if (!m && !e) throw badRequest('send {model} or {effort}');
    if (m && !isValidModel(m)) throw badRequest('invalid model');
    if (e && !isValidEffort(e)) throw badRequest('effort must be low, medium, high, xhigh or max');
    if (rec.status !== 'ready') throw conflict('wait for your turn: model and effort change between turns');
    await this.end(sid);
    // resume() re-attaches to a session that still exists, so wait until the old claude is gone.
    for (let i = 0; i < 50 && (await this.backend.hasSession(rec.tmux_name)); i++) await sleep(100);
    if (await this.backend.hasSession(rec.tmux_name)) throw new HttpError(500, 'the session did not stop; try again');
    if (m) rec.model = m;
    if (e) rec.effort = e;
    this.events.record({ type: 'settings', sid, agent: rec.agent, ...(m ? { model: m } : {}), ...(e ? { effort: e } : {}) });
    return this.resume(sid);
  }

  /** Type text into a session (Donna routing, the CLI). A paste, so multi-line text is one paste. */
  async send(sid, text, enter = true) {
    const rec = this.require(sid);
    if (!isLive(rec.status)) throw conflict('that session has ended; resume it first');
    if (typeof text !== 'string') throw badRequest('text must be a string');
    const clean = text.replace(/\0/g, '').slice(0, PROMPT_MAX);
    if (!rec.hooked) await this.waitFor(() => rec.hooked || rec.waiting_on || !isLive(rec.status), 15000);
    // Never type into a dialog: Enter would answer it (folder trust defaults to "No, exit"; a
    // permission prompt defaults to "Yes"). Those answers belong to the owner, in the terminal.
    if (rec.status === 'needs_you' && rec.waiting_on === 'login') throw conflict(LOGIN_NOTICE); // nothing to answer here
    if (rec.status === 'needs_you' && ANSWER_IN_TERMINAL.has(rec.waiting_on)) {
      throw conflict(`the session is waiting for your answer in the terminal (${rec.notification || rec.waiting_on}); answer it in the cockpit first`);
    }
    if (!isLive(rec.status)) throw conflict('that session has ended');
    const target = rec.pane_id || `=${rec.tmux_name}:`;
    if (clean) await this.backend.paste(target, clean);
    if (enter !== false) {
      if (clean) await sleep(150);
      await this.backend.sendKeysHex(target, Buffer.from('\r'));
    }
  }

  /**
   * Answer the question Claude Code is showing (folder trust, external imports, a permission
   * prompt) with choice `option` (1-based, in the order shown on screen; see `choices`).
   *
   * Claude Code 2.1.283's folder-trust dialog hides its numbers and ignores digit keys (verified),
   * so the answer is given the way a person would: read the screen, move the pointer with the arrow
   * keys onto the chosen line, check it is there, then press Enter.
   */
  async answer(sid, option) {
    const rec = this.require(sid);
    if (rec.status !== 'needs_you' || !ANSWERABLE.has(rec.waiting_on)) {
      throw conflict('this session is not waiting on a question that can be answered here');
    }
    const n = Number(option);
    if (!Number.isInteger(n) || n < 1 || n > 9) throw badRequest('option must be the number of a choice (1 or 2)');
    const rt = this.rt(sid);
    const target = rec.pane_id || `=${rec.tmux_name}:`;
    const wait = (rt.dialogSeenAt || 0) + DIALOG_ARM_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const kind = rec.waiting_on;
    let chosen = null;
    for (let attempt = 0; attempt < 8 && !chosen; attempt++) {
      const c = parseChoices(await this.backend.screenText(target));
      if (!c) {
        if (attempt < 3) {
          await sleep(250);
          continue;
        }
        throw conflict('the question is no longer on screen');
      }
      if (n > c.labels.length) throw badRequest(`there are only ${c.labels.length} choices`);
      const moves = n - 1 - c.selected;
      if (moves === 0) {
        await this.backend.sendKeysHex(target, KEY.enter);
        chosen = c.labels[n - 1];
        break;
      }
      const key = moves > 0 ? KEY.down : KEY.up;
      for (let i = 0; i < Math.abs(moves); i++) await this.backend.sendKeysHex(target, key);
      await sleep(200);
    }
    if (!chosen) throw new HttpError(500, 'could not move the selection onto that choice');
    this.events.record({ type: 'answer', sid, agent: rec.agent, question: kind, option: n, label: chosen });
    rec.choices = null;
    rec.notification = null;
    rec.waiting_on = null;
    // A permission answer lets the turn continue. After a startup dialog Claude Code starts up (the
    // SessionStart hook moves it to ready) or exits; if the dialog is still there it is re-detected.
    rec.status = kind === 'permission_prompt' ? 'working' : 'starting';
    if (kind !== 'permission_prompt') this.detectDialogs(rec, rt);
    this.onStatusChange(rec);
    return { ...this.view(rec), answered: { option: n, label: chosen } };
  }

  // ---------------------------------------------------------------- terminal viewers

  /**
   * Attach a WebSocket viewer. With {cols, rows} (the client's terminal size) the tmux window is
   * resized first and the snapshot is cut at that geometry: a window taller than the viewer would
   * otherwise push the real content off the viewer's screen.
   */
  attachViewer(sid, ws, { cols, rows } = {}) {
    const rec = this.records.get(sid);
    if (!rec) {
      ws.close(1008, 'no such session');
      return;
    }
    const rt = this.rt(sid);
    ws.on('close', () => rt.viewers.delete(ws));
    ws.on('error', () => rt.viewers.delete(ws));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg?.t === 'in' && typeof msg.data === 'string') this.input(sid, msg.data);
      else if (msg?.t === 'resize') this.resize(sid, msg.cols, msg.rows, ws);
    });
    const size = validSize(cols, rows);
    if (size && isLive(rec.status) && rt.control && !rt.control.closed) {
      rt.size = size;
      this.applySize(rec, rt, size, () => this.snapshotTo(rec, rt, ws, { register: true }));
      return;
    }
    this.snapshotTo(rec, rt, ws, { register: true });
  }

  /**
   * Make the session's terminal `size`. Calls done(changed) once the backend has applied it and
   * the app has had a moment to redraw for the new size. With tmux everything goes through the
   * control client, so it is ordered with the snapshot capture that follows.
   */
  applySize(rec, rt, { cols, rows }, done) {
    const cc = rt.control;
    if (!cc || cc.closed) {
      done(false);
      return;
    }
    cc.fit(cols, rows, (changed) => (changed ? this.settle(rt, () => done(true)) : done(false)));
  }

  /** Wait until the pane has been quiet for 50 ms (at least 60 ms, at most 400 ms). */
  settle(rt, then, { min = 60, quiet = 50, max = 400 } = {}) {
    const start = Date.now();
    const tick = () => {
      const now = Date.now();
      if (now - start >= max || (now - start >= min && now - (rt.lastOutputAt || 0) >= quiet)) then();
      else setTimeout(tick, 15);
    };
    setTimeout(tick, 15);
  }

  /** Snapshot through the control client, so it is an exact cut of the output stream. */
  snapshotTo(rec, rt, ws, { register }) {
    if (ws.readyState !== 1) return;
    const cc = rt.control;
    if (!cc || cc.closed) {
      sendWs(ws, { t: 'snapshot', data: CLEAR + this.ringText(rt).replace(/\r?\n/g, '\r\n') });
      sendWs(ws, { t: 'status', status: rec.status });
      if (!isLive(rec.status)) sendWs(ws, { t: 'ended' });
      if (register) rt.viewers.add(ws);
      return;
    }
    cc.snapshot(rt.modes, (data) => {
      if (ws.readyState !== 1) return;
      this.flushOutput(rec, rt); // output before the cut goes only to existing viewers
      sendWs(ws, { t: 'snapshot', data: data || CLEAR + this.ringText(rt) });
      sendWs(ws, { t: 'status', status: rec.status });
      if (register) rt.viewers.add(ws);
    });
  }

  input(sid, data) {
    const rec = this.records.get(sid);
    const rt = this.runtime.get(sid);
    if (!rec || !rt?.control || rt.control.closed || !data) return;
    rt.control.sendBytes(Buffer.from(data.slice(0, 65536), 'utf8'));
    if (rec.status === 'needs_you' && (rec.waiting_on === 'permission_prompt' || rec.waiting_on === 'elicitation_dialog') && /\r|^[1-9]$|^\x1b$/.test(data)) {
      rec.status = 'working';
      rec.notification = null;
      rec.waiting_on = null;
      this.onStatusChange(rec);
    }
  }

  /** A viewer's explicit resize. If the window size changes, that viewer gets a fresh snapshot. */
  resize(sid, cols, rows, ws) {
    const rec = this.records.get(sid);
    const rt = this.runtime.get(sid);
    if (!rec || !rt) return;
    const size = validSize(cols, rows);
    if (!size) return;
    rt.size = size;
    clearTimeout(rt.resizeTimer);
    rt.resizeTimer = setTimeout(() => {
      if (!isLive(rec.status)) return;
      this.applySize(rec, rt, size, (changed) => {
        if (changed && ws && rt.viewers.has(ws)) this.snapshotTo(rec, rt, ws, { register: false });
      });
    }, 40);
  }

  async shutdown() {
    this.closing = true;
    const persistent = this.backend.persistent !== false;
    const wasLive = [...this.records.values()].filter((r) => isLive(r.status));
    for (const [sid, rt] of this.runtime) {
      const rec = this.records.get(sid);
      if (rec) this.flushOutput(rec, rt);
      for (const t of ['flushTimer', 'carryTimer', 'stallTimer', 'resizeTimer', 'dialogTimer']) clearTimeout(rt[t]);
      rt.control?.close(true); // now: the process exits right after this
      for (const ws of rt.viewers) {
        try {
          ws.close(1001, persistent ? 'Clawdling is restarting; sessions keep running' : 'Clawdling stopped; resume the session to continue');
        } catch {
          // ignore
        }
      }
    }
    if (!persistent) {
      // pty sessions live in this process: end them now, cleanly, and say so in the registry.
      await this.backend.shutdown?.();
      const now = nowIso();
      for (const rec of wasLive) {
        rec.status = 'ended';
        rec.ended_at = rec.ended_at || now;
        rec.waiting_on = null;
        rec.notification = STOPPED_NOTICE;
        this.events.record({ type: 'end', sid: rec.sid, agent: rec.agent, reason: 'server stopped' });
      }
    }
    this.save();
  }
}
