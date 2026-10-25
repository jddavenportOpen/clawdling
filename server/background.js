// Watching: which background tasks a Claude Code session still has running, read from its own
// transcript JSONL (and its sub-agents'), plus the CLI's own process record. Read-only, local.
//
// Why: a session reads Ready between turns while Monitor watchers, `run_in_background` shells,
// background agents or workflows it started are still running. Ready should mean done. The
// transcript is the one place every launch and every ending is written down.
//
// Shapes (Claude Code 2.1.283):
//   LAUNCH, read from the tool_result line's top-level `toolUseResult`, never from the tool_use
//   input (an Agent with no run_in_background is async by default, and a foreground Bash moves to
//   the background when it outlives its timeout):
//     Bash      backgroundTaskId                    -> shell
//     Agent     status 'async_launched' + agentId   -> agent
//     Workflow  status 'async_launched' + taskId    -> workflow
//     Monitor   taskId (+ timeoutMs, persistent)    -> watcher
//   END, matched by id, never by order (the CLI can log an end before the launch's own result):
//     - a <task-notification> whose header <status> is completed|failed|killed|stopped (the CLI
//       writes each notice up to three times; only the first counts);
//     - a Monitor event "[Monitor expired after …]";
//     - a TaskStop / KillShell result, or a TaskOutput result whose task is in a terminal status;
//     - a watcher passing its own timeout (plus a minute of grace).
//   RESUME: a SendMessage result with resumedAgentId reopens a rested agent until its next end.
//   PROCESS: background work dies with the CLI process: a task launched before the session's
//   current process started does not count.
//   THE CLI'S PROCESS RECORD (<config>/sessions/<pid>.json: status busy|idle|shell): "idle" means
//   no shell or watcher is running, whatever the transcript says (a stop from the task panel
//   leaves no marker); "shell" with none found adds one generic "Background command". Agents and
//   workflows stay transcript-only. Only the *.json records are read, and only the fields named
//   below; nothing else in that folder.
//
// Unknown is null, never zero: no transcript or no process start means no claim.
//
// Rewritten in plain JS from the background-task detector of a sibling cockpit by the same
// author (2026-10-24); the shapes above were checked against real transcripts there.
import fs from 'node:fs';
import path from 'node:path';

/** Every Claude Code literal this decides on. */
export const CLI = {
  notificationTag: 'task-notification',
  taskIdTag: 'task-id',
  toolUseIdTag: 'tool-use-id',
  statusTag: '<status>',
  eventTag: '<event>',
  monitorExpired: 'Monitor expired after',
  queueOperation: 'queue-operation',
  toolUseResult: 'toolUseResult',
  backgroundTaskId: 'backgroundTaskId',
  asyncLaunched: 'async_launched',
  agentId: 'agentId',
  taskId: 'taskId',
  timeoutMs: 'timeoutMs',
  persistent: 'persistent',
  resumedAgentId: 'resumedAgentId',
  stopTaskId: 'task_id',
  stopShellId: 'shell_id',
  toolBash: 'Bash',
  toolAgent: 'Agent',
  toolWorkflow: 'Workflow',
  toolMonitor: 'Monitor',
  toolTaskStop: 'TaskStop',
  toolKillShell: 'KillShell',
  toolTaskOutput: 'TaskOutput',
  toolSendMessage: 'SendMessage',
  statusCompleted: 'completed',
  statusFailed: 'failed',
  statusKilled: 'killed',
  statusStopped: 'stopped',
  processStatusIdle: 'idle',
  processStatusShell: 'shell',
};

const TERMINAL_STATUSES = new Set([CLI.statusCompleted, CLI.statusFailed, CLI.statusKilled, CLI.statusStopped]);
/** Slack on the process-start comparison (clocks and the first write differ by a beat). */
export const PROCESS_START_SLACK_MS = 5000;
/** A watcher with a timeout counts as ended this long after it, notice or not. */
export const WATCHER_EXPIRY_GRACE_MS = 60000;
/** The most tasks a session view carries (count is always the full number). */
export const MAX_TASKS = 20;
const DESCRIPTION_MAX = 120;
const PENDING_CAP = 400; // tool calls waiting for a result (an interrupted turn never gets one)
const SEEN_ENDS_CAP = 5000;

const TOOL_TASK = 'Task'; // the Agent tool's older name
const TOOL_KILL_BASH = 'KillBash'; // KillShell's older name
const TRACKED_TOOLS = new Set([CLI.toolBash, CLI.toolAgent, TOOL_TASK, CLI.toolWorkflow, CLI.toolMonitor, CLI.toolTaskStop, CLI.toolKillShell, TOOL_KILL_BASH, CLI.toolTaskOutput, CLI.toolSendMessage]);

export const KIND_LABEL = { watcher: 'Watcher', shell: 'Background command', agent: 'Background agent', workflow: 'Workflow' };

/** A fresh parse state for one transcript. `sidechain`: a sub-agent's own file (every line is a sidechain line). */
export function newTaskState({ sidechain = false } = {}) {
  return { sidechain, seq: 0, pending: new Map(), tasks: new Map(), endByTask: new Map(), endByToolUse: new Map(), seenEnds: new Set() };
}

const isRec = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}
function clip(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > DESCRIPTION_MAX ? `${t.slice(0, DESCRIPTION_MAX - 1)}…` : t;
}
function parseTs(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function markEnd(map, id, seq) {
  if ((map.get(id) ?? -1) < seq) map.set(id, seq);
}

const closeTag = (open) => open.replace('<', '</');
const NOTIFICATION_RE = new RegExp(`<${CLI.notificationTag}>([\\s\\S]*?)</${CLI.notificationTag}>`, 'g');
const TASK_ID_RE = new RegExp(`<${CLI.taskIdTag}>([^<]*)</${CLI.taskIdTag}>`, 'g');
const TOOL_USE_ID_RE = new RegExp(`<${CLI.toolUseIdTag}>([^<]*)</${CLI.toolUseIdTag}>`, 'g');
const STATUS_RE = new RegExp(`${CLI.statusTag}([^<]*)${closeTag(CLI.statusTag)}`);
const EVENT_RE = new RegExp(`${CLI.eventTag}([\\s\\S]*?)${closeTag(CLI.eventTag)}`);
// The CLI's header tags come first, free text (an agent's <result>, a Monitor's <event> output,
// the <summary>, a <note>) after. Ids and the status are read from the header only, so text that
// merely quotes another task's id or status cannot end it.
const BODY_START_RE = /<(summary|event|result|note)>/;

/** The notice's header when it says its task(s) ended, else null. */
function endHeader(block) {
  const cut = block.search(BODY_START_RE);
  const header = cut === -1 ? block : block.slice(0, cut);
  const status = STATUS_RE.exec(header)?.[1]?.trim();
  if (status && TERMINAL_STATUSES.has(status)) return header;
  const event = EVENT_RE.exec(block)?.[1]?.trimStart() ?? '';
  if (event.startsWith(`[${CLI.monitorExpired}`) || event.startsWith(CLI.monitorExpired)) return `${header}\u0000expired`;
  return null;
}

function ingestNotifications(state, text, seq) {
  for (const m of text.matchAll(NOTIFICATION_RE)) {
    const header = endHeader(m[1]);
    if (header === null) continue;
    const key = header.replace(/\s+/g, ' ').trim();
    if (state.seenEnds.has(key)) continue;
    state.seenEnds.add(key);
    if (state.seenEnds.size > SEEN_ENDS_CAP) state.seenEnds.delete(state.seenEnds.values().next().value);
    for (const t of header.matchAll(TASK_ID_RE)) if (t[1].trim()) markEnd(state.endByTask, t[1].trim(), seq);
    for (const t of header.matchAll(TOOL_USE_ID_RE)) if (t[1].trim()) markEnd(state.endByToolUse, t[1].trim(), seq);
  }
}

function ingestToolUses(state, content, seq) {
  for (const b of content) {
    if (!isRec(b) || b.type !== 'tool_use') continue;
    const id = str(b.id);
    const name = str(b.name);
    if (!id || !name || !TRACKED_TOOLS.has(name)) continue;
    const input = isRec(b.input) ? b.input : {};
    state.pending.set(id, { name, description: str(input.description) ?? '', stopTarget: str(input[CLI.stopTaskId]) ?? str(input[CLI.stopShellId]), useSeq: seq });
    if (state.pending.size > PENDING_CAP) state.pending.delete(state.pending.keys().next().value);
  }
}

function launch(state, id, kind, description, toolUseId, seq, tsMs, timeoutMs = null, persistent = false) {
  state.tasks.set(id, { id, kind, description: clip(description) || KIND_LABEL[kind], startedAtMs: tsMs, toolUseIds: [toolUseId], timeoutMs, persistent, startSeq: seq, resumed: false });
}

function applyResult(state, use, toolUseId, r, seq, tsMs) {
  switch (use.name) {
    case CLI.toolBash: {
      const id = str(r[CLI.backgroundTaskId]);
      if (id) launch(state, id, 'shell', use.description, toolUseId, seq, tsMs);
      return;
    }
    case CLI.toolAgent:
    case TOOL_TASK: {
      const id = str(r[CLI.agentId]);
      if (id && r.status === CLI.asyncLaunched) launch(state, id, 'agent', use.description, toolUseId, seq, tsMs);
      return;
    }
    case CLI.toolWorkflow: {
      const id = str(r[CLI.taskId]);
      if (id && r.status === CLI.asyncLaunched) launch(state, id, 'workflow', str(r.workflowName) ?? str(r.summary) ?? use.description, toolUseId, seq, tsMs);
      return;
    }
    case CLI.toolMonitor: {
      const id = str(r[CLI.taskId]);
      if (id) launch(state, id, 'watcher', use.description, toolUseId, seq, tsMs, num(r[CLI.timeoutMs]), r[CLI.persistent] === true);
      return;
    }
    case CLI.toolTaskStop:
    case CLI.toolKillShell:
    case TOOL_KILL_BASH: {
      const id = str(r[CLI.stopTaskId]) ?? str(r[CLI.stopShellId]) ?? use.stopTarget;
      if (id) markEnd(state.endByTask, id, seq);
      return;
    }
    case CLI.toolTaskOutput: {
      const task = isRec(r.task) ? r.task : null;
      const id = task ? str(task[CLI.stopTaskId]) : null;
      if (id && TERMINAL_STATUSES.has(String(task.status ?? ''))) markEnd(state.endByTask, id, seq);
      return;
    }
    case CLI.toolSendMessage: {
      const id = str(r[CLI.resumedAgentId]);
      const task = id ? state.tasks.get(id) : undefined;
      if (task) {
        // A resume starts at the SendMessage call, not its result: an end logged between the two
        // belongs to the run it started.
        task.startSeq = use.useSeq;
        task.resumed = true;
        task.startedAtMs = tsMs ?? task.startedAtMs;
        task.toolUseIds.push(toolUseId);
      }
      return;
    }
    default:
  }
}

function ingestToolResults(state, line, content, seq, tsMs) {
  const results = content.filter((b) => isRec(b) && b.type === 'tool_result');
  if (!results.length) return;
  // One tool_result per line carries its structured payload beside it. A line with several
  // results cannot say whose the payload is, so it launches nothing (its ends still count).
  const payload = results.length === 1 && isRec(line[CLI.toolUseResult]) ? line[CLI.toolUseResult] : null;
  for (const b of results) {
    const toolUseId = str(b.tool_use_id);
    if (!toolUseId) continue;
    const use = state.pending.get(toolUseId);
    if (!use) continue;
    state.pending.delete(toolUseId);
    if (b.is_error === true || !payload) continue;
    applyResult(state, use, toolUseId, payload, seq, tsMs);
  }
}

/** Feed ONE transcript line (no trailing newline), in file order. */
export function ingestLine(state, line) {
  const seq = ++state.seq;
  const mayNotify = line.includes(CLI.notificationTag);
  if (!mayNotify && !line.includes('"tool_use"') && !line.includes(CLI.toolUseResult)) return;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRec(obj)) return;
  if (obj.isSidechain === true && !state.sidechain) return;
  const type = obj.type;
  if (type === CLI.queueOperation) {
    if (mayNotify && typeof obj.content === 'string') ingestNotifications(state, obj.content, seq);
    return;
  }
  const content = isRec(obj.message) ? obj.message.content : undefined;
  if (type === 'assistant') {
    if (Array.isArray(content)) ingestToolUses(state, content, seq); // its text can quote a notice
    return;
  }
  if (type !== 'user') return;
  if (typeof content === 'string') {
    if (mayNotify) ingestNotifications(state, content, seq);
    return;
  }
  if (!Array.isArray(content)) return;
  ingestToolResults(state, obj, content, seq, parseTs(obj.timestamp));
  if (mayNotify) for (const b of content) if (isRec(b) && b.type === 'text' && typeof b.text === 'string') ingestNotifications(state, b.text, seq);
}

/** Ended according to another of the session's transcripts (line numbers do not compare across files). */
function endedElsewhere(others, task) {
  return others.some((o) => o.endByTask.has(task.id) || task.toolUseIds.some((tu) => o.endByToolUse.has(tu)));
}

function isEnded(state, task) {
  let endSeq = state.endByTask.get(task.id);
  for (const tu of task.toolUseIds) {
    const s = state.endByToolUse.get(tu);
    if (s !== undefined && (endSeq === undefined || s > endSeq)) endSeq = s;
  }
  if (endSeq === undefined) return false;
  // A first launch: any end counts (it can be logged before the launch result). A resumed agent:
  // only an end after the resume.
  return task.resumed ? endSeq > task.startSeq : true;
}

/** The tasks still running in the session's current process, oldest first. */
export function activeTasks(state, { nowMs, processStartMs }, others = []) {
  const out = [];
  for (const task of state.tasks.values()) {
    if (isEnded(state, task) || endedElsewhere(others, task)) continue;
    if (task.startedAtMs === null || task.startedAtMs < processStartMs - PROCESS_START_SLACK_MS) continue;
    let expiresAtMs = null;
    if (task.kind === 'watcher' && !task.persistent && task.timeoutMs !== null) {
      expiresAtMs = task.startedAtMs + task.timeoutMs;
      if (nowMs > expiresAtMs + WATCHER_EXPIRY_GRACE_MS) continue;
    }
    out.push({ id: task.id, kind: task.kind, description: task.description, started_at: new Date(task.startedAtMs).toISOString(), expires_at: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString() });
  }
  return out.sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
}

/** Across a session's transcripts (main + sub-agents): an end in any file ends a task from any file. */
export function activeTasksAcross(states, opts) {
  const seen = new Set();
  const out = [];
  for (const st of states) {
    for (const t of activeTasks(st, opts, states.filter((o) => o !== st))) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out.sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
}

/** The oldest CLI version whose process record is known to mean what applyCliStatus assumes. */
export const CLI_STATUS_MIN_VERSION = '2.1.283';
const LOCAL_BASH_KINDS = new Set(['shell', 'watcher']);

function versionAtLeast(v, min) {
  const a = String(v ?? '').split('.').map((x) => Number.parseInt(x, 10));
  const b = min.split('.').map((x) => Number.parseInt(x, 10));
  if (a.length < 3 || a.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** Reconcile the transcript's tasks with the CLI's process status (see the top of this file). */
export function applyCliStatus(tasks, cli) {
  if (!cli || !versionAtLeast(cli.version, CLI_STATUS_MIN_VERSION)) return tasks;
  if (cli.status === CLI.processStatusIdle) return tasks.filter((t) => !LOCAL_BASH_KINDS.has(t.kind));
  if (cli.status === CLI.processStatusShell && !tasks.some((t) => LOCAL_BASH_KINDS.has(t.kind))) {
    return [...tasks, { id: 'cli-local-bash', kind: 'shell', description: KIND_LABEL.shell, started_at: cli.statusUpdatedAtMs === null ? null : new Date(cli.statusUpdatedAtMs).toISOString(), expires_at: null }];
  }
  return tasks;
}

// ------------------------------------------------------------------------------- the file reader

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECORD_FILE = /^\d{1,10}\.json$/; // <pid>.json only: never anything else in that folder
const READ_CHUNK = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const CURSOR_IDLE_MS = 30 * 60000;
const RECORDS_TTL_MS = 3000;
const SUBAGENT_LIST_TTL_MS = 10000;
const SUBAGENT_FILES_MAX = 60;
const SUBAGENT_FILE_RE = /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/;

/**
 * Reads transcripts incrementally (only the bytes appended since the last call; each line is
 * parsed once per server process) and the CLI's process records, synchronously and cheaply.
 */
export class BackgroundReader {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.cursors = new Map();
    this.records = new Map(); // configDir -> {at, list}
    this.subLists = new Map();
  }

  /** The CLI's process record for `sessionId` under `configDir`: {startedAtMs, status, statusUpdatedAtMs, version} or null. */
  processRecord(configDir, sessionIds) {
    const want = new Set(sessionIds.filter((id) => typeof id === 'string' && SAFE_ID.test(id)));
    if (!want.size || !configDir) return null;
    let cached = this.records.get(configDir);
    if (!cached || this.now() - cached.at >= RECORDS_TTL_MS) {
      const list = [];
      const dir = path.join(configDir, 'sessions');
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => RECORD_FILE.test(n));
      } catch {
        names = [];
      }
      for (const n of names.slice(0, 500)) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
          if (!isRec(r) || typeof r.sessionId !== 'string' || typeof r.startedAt !== 'number') continue;
          list.push({ sessionId: r.sessionId, startedAtMs: r.startedAt, status: typeof r.status === 'string' ? r.status : null, statusUpdatedAtMs: typeof r.statusUpdatedAt === 'number' ? r.statusUpdatedAt : null, version: typeof r.version === 'string' ? r.version : null });
        } catch {
          // being written, or not a record
        }
      }
      cached = { at: this.now(), list };
      this.records.set(configDir, cached);
    }
    let best = null;
    for (const r of cached.list) if (want.has(r.sessionId) && (!best || r.startedAtMs > best.startedAtMs)) best = r;
    return best;
  }

  advance(file, sidechain = false) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      this.cursors.delete(file);
      return null;
    }
    let cur = this.cursors.get(file);
    if (!cur || cur.ino !== st.ino || st.size < cur.offset) {
      cur = { ino: st.ino, offset: 0, carry: null, skipping: false, state: newTaskState({ sidechain }), lastUsed: 0 };
      this.cursors.set(file, cur);
    }
    cur.lastUsed = this.now();
    if (cur.offset >= st.size) return cur.state;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      while (cur.offset < st.size) {
        const len = Math.min(READ_CHUNK, st.size - cur.offset);
        const chunk = Buffer.allocUnsafe(len);
        const got = fs.readSync(fd, chunk, 0, len, cur.offset);
        if (got <= 0) break;
        cur.offset += got;
        this.feed(cur, chunk.subarray(0, got));
      }
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return cur.state;
  }

  feed(cur, data) {
    const buf = cur.carry ? Buffer.concat([cur.carry, data]) : data;
    cur.carry = null;
    let start = 0;
    for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
      if (cur.skipping) cur.skipping = false;
      else ingestLine(cur.state, buf.toString('utf8', start, nl));
      start = nl + 1;
    }
    if (start < buf.length) {
      const rest = buf.subarray(start);
      if (cur.skipping || rest.length > MAX_LINE_BYTES) cur.skipping = true;
      else cur.carry = Buffer.from(rest);
    }
  }

  /** A session's sub-agent transcripts touched since `sinceMs`, newest first. */
  subagentFiles(mainFile, sinceMs) {
    const dir = path.join(mainFile.replace(/\.jsonl$/, ''), 'subagents');
    let listed = this.subLists.get(dir);
    if (!listed || this.now() - listed.at >= SUBAGENT_LIST_TTL_MS) {
      const files = [];
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => SUBAGENT_FILE_RE.test(n));
      } catch {
        names = [];
      }
      for (const n of names) {
        try {
          files.push({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs });
        } catch {
          // gone
        }
      }
      listed = { at: this.now(), files };
      this.subLists.set(dir, listed);
    }
    return listed.files.filter((f) => f.mtime >= sinceMs - PROCESS_START_SLACK_MS).sort((a, b) => b.mtime - a.mtime).slice(0, SUBAGENT_FILES_MAX).map((f) => f.file);
  }

  /**
   * A session's background work: {count, tasks} or null when unknown.
   * @param {{file: string|null, configDir: string, sessionIds: string[], launchedAtMs: number|null}} ref
   */
  summarize({ file, configDir, sessionIds, launchedAtMs = null }) {
    this.sweep();
    if (!file) return null;
    const rec = this.processRecord(configDir, sessionIds);
    // The CLI's own start time when it has one; else when Clawdling launched it.
    const processStartMs = rec?.startedAtMs ?? launchedAtMs ?? null;
    if (processStartMs === null) return null;
    const main = this.advance(file);
    if (!main) return null;
    const subs = [];
    for (const f of this.subagentFiles(file, processStartMs)) {
      const st = this.advance(f, true);
      if (st) subs.push(st);
    }
    const tasks = applyCliStatus(activeTasksAcross([main, ...subs], { nowMs: this.now(), processStartMs }), rec);
    return { count: tasks.length, tasks: tasks.slice(0, MAX_TASKS) };
  }

  sweep() {
    const t = this.now();
    for (const [file, cur] of this.cursors) if (cur.lastUsed < t - CURSOR_IDLE_MS) this.cursors.delete(file);
    for (const [k, l] of this.subLists) if (l.at < t - CURSOR_IDLE_MS) this.subLists.delete(k);
    for (const [k, l] of this.records) if (l.at < t - CURSOR_IDLE_MS) this.records.delete(k);
  }
}
