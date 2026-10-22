// Sessions = real Claude Code processes in Clawdling's tmux server.
//
// One registry (sessions.json) + one tmux control-mode client per live session. Output is fanned
// out to WebSocket viewers; input from viewers becomes `send-keys -H`. Status comes from Claude
// Code hooks (see hooks.js). Sessions outlive the Clawdling server: on start we reconcile the
// registry with `tmux ls` and reattach.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_EVENTS, applyHookEvent, isLive } from './hooks.js';
import { which } from './paths.js';
import { ModeTracker, OutputFilter } from './termfilter.js';
import { cleanTitle, deriveTitle } from './titles.js';
import {
  HttpError,
  badRequest,
  conflict,
  isUuid,
  isValidAgentId,
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

const RING_MAX = 256 * 1024;
const ENDED_VISIBLE_MS = 14 * 24 * 3600 * 1000;
const ENDED_KEEP_MS = 30 * 24 * 3600 * 1000;
const STARTUP_STALL_MS = 20000;
const PROMPT_MAX = 100 * 1024;
const WS_HIGH_WATER = 16 * 1024 * 1024;

const TRUST_RE = /Yes, I trust this folder|Quick safety check: Is this a project|Do you trust the files in this folder/i;
const IMPORTS_RE = /Allow external CLAUDE\.md file imports/i;
export const TRUST_NOTICE =
  'Claude Code is asking whether you trust this folder. In the terminal, choose "Yes, I trust this folder" (arrow keys, then Enter). Trust your org folder once from a Scratch session and no agent will ask again.';
export const IMPORTS_NOTICE = 'Claude Code is asking whether to allow CLAUDE.md imports from outside this folder. Answer in the terminal.';
export const STALL_NOTICE = 'Claude Code has not finished starting. It may be waiting for an answer in the terminal.';

/**
 * Positional prompts go after `--` so a leading dash is never parsed as an option. A prompt that is
 * one bare word gets a trailing space so it can never be dispatched as a claude subcommand
 * (`claude -- update` would otherwise run `claude update`).
 */
export function safePositional(prompt) {
  return /\s/.test(prompt) ? prompt : `${prompt} `;
}

export function buildClaudeArgs({ sid, resume = false, resumeId, name, settingsPath, model, permissionMode, addDirs = [], appendSystemPromptFile, prompt }) {
  const a = [];
  if (resume) a.push('--resume', resumeId || sid);
  else a.push('--session-id', sid);
  if (name) a.push(`--name=${name}`);
  if (settingsPath) a.push('--settings', settingsPath);
  if (model) a.push(`--model=${model}`);
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

/** Snapshot = clear + captured lines + cursor position + replayed terminal modes. */
export function buildSnapshot(lines, cursorInfo, modes) {
  const parts = String(cursorInfo || '').trim().split(/\s+/).map(Number);
  const [cx, cy, , , cursorFlag, alt] = parts;
  let s = '\x1b[0m\x1b[H\x1b[2J\x1b[3J';
  if (alt === 1) s += '\x1b[?1049h\x1b[H\x1b[2J';
  s += (lines || []).join('\r\n') + '\x1b[0m';
  if (Number.isFinite(cx) && Number.isFinite(cy)) s += `\x1b[${cy + 1};${cx + 1}H`;
  if (modes) s += modes.replay();
  if (cursorFlag === 0) s += '\x1b[?25l';
  return s;
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
  constructor({ paths, org, events, tmux, claudeBin, socket, shimDir, env, logger, getPort }) {
    this.paths = paths;
    this.home = paths.home;
    this.org = org;
    this.events = events;
    this.tmux = tmux;
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
    writeJson(this.paths.sessions, { version: 1, sessions: [...this.records.values()] }, 0o600);
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
      permission_mode: rec.permission_mode,
      cwd: rec.cwd,
      tmux_name: rec.tmux_name,
      created_at: rec.created_at,
      last_activity_at: rec.last_activity_at,
      ended_at: rec.ended_at,
      notification: rec.notification,
      resumable: rec.status === 'ended',
      last_message: rec.last_message,
      transcript_path: rec.transcript_path,
      attach_cmd: `tmux -L ${this.socket} attach -t ${rec.tmux_name}`,
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
    const live = await this.tmux.listSessions();
    const recs = [...this.records.values()];
    const { attach, ended, orphans } = reconcileRecords(recs, live);
    for (const rec of ended) this.events.record({ type: 'end', sid: rec.sid, agent: rec.agent, reason: 'gone at startup' });
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
          this.applyHook(e.event, e.sid, e.payload || {});
          n++;
        }
      } catch {
        // skip torn line
      }
    }
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

  async spawn({ agent, prompt, model, title, cols, rows } = {}) {
    if (typeof agent !== 'string' || !agent) throw badRequest('agent is required');
    const target = this.resolveTarget(agent);
    if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') throw badRequest('prompt must be a string');
    const text = typeof prompt === 'string' ? prompt.replace(/\0/g, '').slice(0, PROMPT_MAX).trim() : '';
    if (model !== undefined && model !== null && model !== '' && !isValidModel(model)) throw badRequest('invalid model');
    if (!this.claudeAbs()) throw new HttpError(500, `claude CLI not found (looked for "${this.claudeBin}" on PATH). Install Claude Code and sign in.`);
    const sid = crypto.randomUUID();
    const rec = newRecord({
      sid,
      agent: target.id,
      agent_name: target.name,
      kind: target.kind,
      title: cleanTitle(title) || (text ? deriveTitle(text) : null),
      model: model || target.model || null,
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
      permissionMode: rec.permission_mode,
      addDirs: rec.cwd === this.home ? [] : [this.home],
      appendSystemPromptFile: ctxFile,
      prompt,
    });
    const claude = this.claudeAbs();
    if (!claude) throw new HttpError(500, `claude CLI not found (looked for "${this.claudeBin}" on PATH)`);
    const script = buildLauncherScript({
      cwd: rec.cwd,
      env: {
        CLAWDLING_SID: rec.sid,
        CLAWDLING_HOME: this.home,
        CLAWDLING_PORT: String(this.getPort()),
        CLAWDLING_TMUX_SOCKET: this.socket,
        COLORTERM: 'truecolor',
        PATH: `${this.shimDir}:${this.env.PATH || '/usr/bin:/bin'}`,
      },
      argv: [claude, ...args],
      comment: `Clawdling launcher for session ${rec.sid} (agent ${rec.agent}). Safe to delete after the session ends.`,
    });
    const scriptPath = path.join(this.paths.run, `${rec.sid}.sh`);
    writeFileAtomic(scriptPath, script, 0o700);
    if (await this.tmux.hasSession(rec.tmux_name)) throw conflict(`tmux session ${rec.tmux_name} already exists`);
    const { paneId } = await this.tmux.newSession({ name: rec.tmux_name, cols: c, rows: r, command: ['/bin/sh', scriptPath] });
    rec.pane_id = paneId || null;
    rec.status = 'starting';
    rec.ended_at = null;
    rec.notification = null;
    rec.waiting_on = null;
    rec.hooked = false;
    rec.launched_at = nowIso();
    await this.tmux.setOptions(rec.tmux_name, [
      ['window-size', 'manual'],
      ['@clawdling_sid', rec.sid],
      ['@clawdling_agent', rec.agent],
    ]);
    const rt = this.rt(rec.sid);
    rt.gen++;
    rt.launchedAt = Date.now();
    rt.size = { cols: c, rows: r };
    this.attachControl(rec);
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
    const cc = this.tmux.control(rec.tmux_name, rec.pane_id);
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

  detectDialogs(rec, rt) {
    const tail = stripAnsi(this.ringText(rt, 8000));
    let waiting = null;
    let notice = null;
    if (TRUST_RE.test(tail)) {
      waiting = 'trust';
      notice = TRUST_NOTICE;
    } else if (IMPORTS_RE.test(tail)) {
      waiting = 'imports';
      notice = IMPORTS_NOTICE;
    }
    if (waiting && rec.waiting_on !== waiting) {
      rec.status = 'needs_you';
      rec.waiting_on = waiting;
      rec.notification = notice;
      this.onStatusChange(rec);
    }
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
    const alive = await this.tmux.hasSession(rec.tmux_name);
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

  applyHook(event, sid, payload = {}) {
    if (!HOOK_EVENTS.includes(event)) throw badRequest('unknown hook event');
    const rec = this.require(sid);
    rec.hooked = true;
    const rt = this.runtime.get(sid);
    if (rt) clearTimeout(rt.stallTimer);
    const { statusChanged, titleChanged } = applyHookEvent(rec, event, payload && typeof payload === 'object' ? payload : {});
    if (titleChanged) this.events.record({ type: 'rename', sid, title: rec.title, auto: true });
    if (statusChanged) this.onStatusChange(rec);
    else {
      this.scheduleSave();
      this.publish(rec);
    }
    return this.view(rec);
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
    if (rec.status === 'ended' && !(await this.tmux.hasSession(rec.tmux_name))) return this.view(rec);
    await this.tmux.killSession(rec.tmux_name);
    this.markEnded(rec, { notice: null });
    return this.view(rec);
  }

  async resume(sid, { cols, rows } = {}) {
    const rec = this.require(sid);
    if (await this.tmux.hasSession(rec.tmux_name)) {
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

  /** Type text into a session (Donna routing, the CLI). Uses tmux's paste so multi-line text is one paste. */
  async send(sid, text, enter = true) {
    const rec = this.require(sid);
    if (!isLive(rec.status)) throw conflict('that session has ended; resume it first');
    if (typeof text !== 'string') throw badRequest('text must be a string');
    const clean = text.replace(/\0/g, '').slice(0, PROMPT_MAX);
    if (!rec.hooked) await this.waitFor(() => rec.hooked || rec.waiting_on || !isLive(rec.status), 15000);
    if (rec.waiting_on === 'trust' || rec.waiting_on === 'imports' || rec.waiting_on === 'startup') {
      throw conflict('Claude Code is waiting for an answer in the terminal (folder trust); answer it in the cockpit first');
    }
    if (!isLive(rec.status)) throw conflict('that session has ended');
    const target = rec.pane_id || `=${rec.tmux_name}:`;
    if (clean) await this.tmux.paste(target, clean);
    if (enter !== false) {
      if (clean) await sleep(150);
      await this.tmux.sendKeysHex(target, Buffer.from('\r'));
    }
  }

  // ---------------------------------------------------------------- terminal viewers

  attachViewer(sid, ws) {
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
      else if (msg?.t === 'resize') this.resize(sid, msg.cols, msg.rows);
    });
    if (!rt.control || rt.control.closed) {
      sendWs(ws, { t: 'snapshot', data: '\x1b[0m\x1b[H\x1b[2J\x1b[3J' + this.ringText(rt).replace(/\r?\n/g, '\r\n') });
      sendWs(ws, { t: 'status', status: rec.status });
      if (!isLive(rec.status)) sendWs(ws, { t: 'ended' });
      rt.viewers.add(ws);
      return;
    }
    this.snapshotTo(rec, rt, ws, { register: true });
  }

  /** Capture through the control client so the snapshot is an exact cut of the output stream. */
  snapshotTo(rec, rt, ws, { register }) {
    const cc = rt.control;
    if (!cc || cc.closed) return;
    const target = rec.pane_id || `=${rec.tmux_name}:`;
    let captured = null;
    cc.command(`capture-pane -p -e -J -S -2000 -t ${target}`, (err, lines) => {
      captured = err ? null : lines;
    });
    cc.command(`display-message -p -t ${target} '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{cursor_flag} #{alternate_on}'`, (err, lines) => {
      this.flushOutput(rec, rt); // output before the cut goes only to existing viewers
      const data = captured ? buildSnapshot(captured, err ? '' : lines[0], rt.modes) : '\x1b[0m\x1b[H\x1b[2J\x1b[3J' + this.ringText(rt);
      sendWs(ws, { t: 'snapshot', data });
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

  resize(sid, cols, rows) {
    const rec = this.records.get(sid);
    const rt = this.runtime.get(sid);
    if (!rec || !rt) return;
    const c = Math.floor(Number(cols));
    const r = Math.floor(Number(rows));
    if (!(c >= 10 && c <= 500 && r >= 3 && r <= 200)) return;
    rt.size = { cols: c, rows: r };
    clearTimeout(rt.resizeTimer);
    rt.resizeTimer = setTimeout(() => {
      if (!isLive(rec.status)) return;
      this.tmux.resizeWindow(rec.tmux_name, c, r);
      rt.control?.resize(c, r);
    }, 40);
  }

  async shutdown() {
    this.closing = true;
    for (const [sid, rt] of this.runtime) {
      const rec = this.records.get(sid);
      if (rec) this.flushOutput(rec, rt);
      for (const t of ['flushTimer', 'carryTimer', 'stallTimer', 'resizeTimer']) clearTimeout(rt[t]);
      rt.control?.close();
      for (const ws of rt.viewers) {
        try {
          ws.close(1001, 'Clawdling is restarting; sessions keep running');
        } catch {
          // ignore
        }
      }
    }
    this.save();
  }
}
