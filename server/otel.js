// Detailed timeline (1.5, beta, off by default): Claude Code's own OpenTelemetry, sent by the
// sessions Clawdling starts to this server on 127.0.0.1, so the Timeline can show who approved each
// tool and how long each API request took. Nothing is sent off the computer.
//
// Verified on Claude Code 2.1.283 and 2.1.308 (2026-10-25):
//   - the user's own settings `env` overrides the spawn environment, and a --settings file's `env`
//     overrides the user's settings (it even turns exporters set to `none` back on); managed
//     settings override everything. So Clawdling never turns this on where the user (or their
//     organization) already has telemetry settings: it would redirect or re-enable them.
//   - every record carries `session.id`, which equals the --session-id Clawdling passes.
//   - with the content gates unset (OTEL_LOG_USER_PROMPTS, OTEL_LOG_TOOL_DETAILS,
//     OTEL_LOG_TOOL_CONTENT), prompt and response attributes arrive as "<REDACTED>"; they are
//     dropped at ingest anyway, with the account identifiers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUuid, readJson, writeJson } from './util.js';

export const INGEST_MAX_BYTES = 1024 * 1024;
export const INGEST_PER_SECOND = 50;
export const TRACE_KEEP_DAYS = 14;
export const TRACE_MAX_BYTES = 50 * 1024 * 1024;
export const SECRET_HEADER = 'x-clawdling-otlp';
export const KINDS = { '/otlp/v1/logs': 'logs', '/otlp/v1/metrics': 'metrics', '/otlp/v1/traces': 'traces' };

/** A settings or environment key that means the user already decided something about telemetry. */
export function telemetryKey(name) {
  return typeof name === 'string' && (name === 'CLAUDE_CODE_ENABLE_TELEMETRY' || name === 'DISABLE_TELEMETRY' || name === 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA' || /^OTEL_/i.test(name));
}
// Top-level settings keys that configure telemetry outside `env`.
const SETTINGS_KEYS = new Set(['otelHeadersHelper']);

/** Claude Code's managed settings files for this OS (and their .d drop-in folders). */
export function managedSettingsPaths(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (platform === 'win32') {
    const pf = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const pd = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
    return [path.win32.join(pf, 'ClaudeCode', 'managed-settings.json'), path.win32.join(pd, 'ClaudeCode', 'managed-settings.json')];
  }
  return ['/etc/claude-code/managed-settings.json'];
}

// A policy pushed by device management (macOS configuration profile): its values are not read, but
// its presence keeps the detailed timeline off.
const MANAGED_PROFILES = { darwin: ['/Library/Managed Preferences/com.anthropic.claudecode.plist'] };
/** The device-level and this user's own configuration profiles (macOS), if any. */
export function managedProfiles(platform = process.platform) {
  const list = [...(MANAGED_PROFILES[platform] || [])];
  if (platform === 'darwin') {
    let user = null;
    try {
      user = os.userInfo().username;
    } catch {
      user = null;
    }
    if (user && /^[A-Za-z0-9._-]+$/.test(user)) list.push(`/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`);
  }
  return list;
}

/** The key names in a settings file's `env`, plus telemetry keys at its top level. Never values. */
function settingsKeyNames(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null; // no file
  }
  // Never follow a link or read a device, and never more than 1 MB: anything else keeps it off.
  if (!st.isFile() || st.size > 1024 * 1024) return ['(a settings file Clawdling could not read)'];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return ['(a settings file Clawdling could not read)'];
  }
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    return ['(a settings file Clawdling could not read)'];
  }
  if (!o || typeof o !== 'object') return [];
  const names = [];
  if (o.env && typeof o.env === 'object') names.push(...Object.keys(o.env));
  for (const k of Object.keys(o)) if (SETTINGS_KEYS.has(k)) names.push(k);
  return names;
}

/**
 * Can the detailed timeline be turned on? Reads key NAMES only, never values, from: Clawdling's own
 * launch environment, the user's Claude Code settings (each Claude login Clawdling uses), the
 * settings of the org folder and of every agent's repo (a --settings env block overrides those
 * too), and the managed settings for this OS. {clear, found: [{where, key}]}.
 */
export function preflight({ env = process.env, configDirs: cd = [], projectDirs: pd = [], managed = managedSettingsPaths(), profiles = managedProfiles() } = {}) {
  let configDirs = Array.isArray(cd) ? cd : [];
  let projectDirs = Array.isArray(pd) ? pd : [];
  const found = [];
  for (const k of Object.keys(env || {})) if (telemetryKey(k)) found.push({ where: "Clawdling's own environment", key: k });
  const check = (file, where) => {
    const names = settingsKeyNames(file);
    if (!names) return;
    for (const k of names) if (telemetryKey(k) || SETTINGS_KEYS.has(k) || k.startsWith('(')) found.push({ where, key: k, file });
  };
  configDirs = configDirs.filter((d) => typeof d === 'string' && d);
  projectDirs = projectDirs.filter((d) => typeof d === 'string' && d);
  for (const d of [...new Set(configDirs)]) check(path.join(d, 'settings.json'), 'your Claude Code settings');
  for (const d of [...new Set(projectDirs)]) {
    check(path.join(d, '.claude', 'settings.json'), 'a project\'s Claude Code settings');
    check(path.join(d, '.claude', 'settings.local.json'), 'a project\'s Claude Code settings');
  }
  for (const f of managed) {
    check(f, 'managed settings on this computer');
    let extra = [];
    try {
      extra = fs.readdirSync(path.join(path.dirname(f), 'managed-settings.d')).filter((n) => n.endsWith('.json')).sort();
    } catch {
      // no drop-in folder
    }
    for (const n of extra) check(path.join(path.dirname(f), 'managed-settings.d', n), 'managed settings on this computer');
  }
  for (const f of profiles) if (fs.existsSync(f)) found.push({ where: 'a Claude Code policy from device management', key: '(managed profile)', file: f });
  return { clear: found.length === 0, found };
}

/** The `env` block for Clawdling's own --settings file while the detailed timeline is on. */
export function envBlock({ port }) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/otlp`,
    // OTEL_EXPORTER_OTLP_HEADERS is NOT here: each session gets its own (sessionHeaders) in its own
    // environment, which this settings block does not override because it does not set that key.
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_TRACES_EXPORT_INTERVAL: '2000',
    // The content gates (OTEL_LOG_USER_PROMPTS, OTEL_LOG_TOOL_DETAILS, OTEL_LOG_TOOL_CONTENT) stay unset.
  };
}

// Dropped at ingest: who the user is, and anything that could carry a prompt, a response or a tool's
// content (they arrive "<REDACTED>" with the gates unset; dropped anyway).
const DROP = new Set(['user.email', 'user.account_uuid', 'user.account_id', 'user.id', 'organization.id', 'prompt', 'prompt_text', 'response', 'response_text', 'user_prompt', 'content', 'tool_input', 'tool_parameters', 'llm_request.context', 'host.name']);
export const droppedKey = (k) => DROP.has(k) || /\.(prompt|content|response)$/i.test(k) || /^(user|organization)\.(email|id|account)/i.test(k);
const MAX_ATTRS = 40;
const MAX_STR = 300;

function anyValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue.slice(0, MAX_STR);
  if (typeof v.intValue === 'string' || typeof v.intValue === 'number') {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v.doubleValue === 'number') return v.doubleValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  return undefined; // arrays and maps are not kept
}

function attrsOf(list) {
  const out = {};
  let n = 0;
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.key !== 'string' || a.key.length > 100 || droppedKey(a.key)) continue;
    const v = anyValue(a.value);
    if (v === undefined) continue;
    out[a.key] = v;
    if (++n >= MAX_ATTRS) break;
  }
  return out;
}

// Only strings and numbers are ever coerced: a hostile object ({"toString": 1}) is just ignored.
const nanoIso = (n) => {
  if (typeof n !== 'string' && typeof n !== 'number') return null;
  const digits = String(n).replace(/\D/g, '').slice(0, 20);
  if (!digits) return null;
  const ms = Number(BigInt(digits) / 1000000n);
  return ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;
};
const str = (v, fallback, max = 80) => (typeof v === 'string' ? v.slice(0, max) : fallback);
const numOf = (v) => (typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN);

/**
 * OTLP/JSON (logs, metrics or traces) -> [{sid, rec}] with rec {k, name, ts, attrs, ...}. Records
 * without a valid session.id are dropped (they belong to no session Clawdling knows).
 */
export const MAX_RECORDS = 5000;

export function normalize(kind, body, { only = null, max = MAX_RECORDS } = {}) {
  const out = [];
  let seen = 0;
  const more = () => ++seen <= max; // at most `max` records looked at per request
  const push = (rec, attrs, res) => {
    const sid = attrs['session.id'] ?? res['session.id'];
    if (!isUuid(sid) || (only && !only.has(sid))) return;
    delete attrs['session.id'];
    out.push({ sid, rec });
  };
  if (!body || typeof body !== 'object') return out;
  if (kind === 'logs') {
    for (const r of Array.isArray(body.resourceLogs) ? body.resourceLogs : []) {
      const res = attrsOf(r?.resource?.attributes);
      for (const s of Array.isArray(r?.scopeLogs) ? r.scopeLogs : []) {
        for (const l of Array.isArray(s?.logRecords) ? s.logRecords : []) {
          if (!more()) return out;
          const attrs = attrsOf(l?.attributes);
          const name = typeof attrs['event.name'] === 'string' ? attrs['event.name'] : typeof l?.body?.stringValue === 'string' ? l.body.stringValue.replace(/^claude_code\./, '').slice(0, 80) : 'event';
          push({ k: 'log', name, ts: typeof attrs['event.timestamp'] === 'string' ? attrs['event.timestamp'] : nanoIso(l?.timeUnixNano), attrs }, attrs, res);
        }
      }
    }
  } else if (kind === 'metrics') {
    for (const r of Array.isArray(body.resourceMetrics) ? body.resourceMetrics : []) {
      const res = attrsOf(r?.resource?.attributes);
      for (const s of Array.isArray(r?.scopeMetrics) ? r.scopeMetrics : []) {
        for (const m of Array.isArray(s?.metrics) ? s.metrics : []) {
          const data = m?.sum || m?.gauge || null;
          for (const p of Array.isArray(data?.dataPoints) ? data.dataPoints : []) {
            if (!more()) return out;
            const attrs = attrsOf(p?.attributes);
            const value = p.asDouble !== undefined ? numOf(p.asDouble) : numOf(p.asInt);
            push({ k: 'metric', name: str(m?.name, 'metric'), ts: nanoIso(p?.timeUnixNano), value: Number.isFinite(value) ? value : null, attrs }, attrs, res);
          }
        }
      }
    }
  } else if (kind === 'traces') {
    for (const r of Array.isArray(body.resourceSpans) ? body.resourceSpans : []) {
      const res = attrsOf(r?.resource?.attributes);
      for (const s of Array.isArray(r?.scopeSpans) ? r.scopeSpans : []) {
        for (const sp of Array.isArray(s?.spans) ? s.spans : []) {
          if (!more()) return out;
          const attrs = attrsOf(sp?.attributes);
          const start = nanoIso(sp?.startTimeUnixNano);
          const end = nanoIso(sp?.endTimeUnixNano);
          push({ k: 'span', name: str(sp?.name, 'span').replace(/^claude_code\./, ''), ts: start, dur_ms: start && end ? Date.parse(end) - Date.parse(start) : null, attrs }, attrs, res);
        }
      }
    }
  }
  return out;
}

/** A session's own telemetry credential: its sid and an HMAC of it under the org's secret. */
export function sessionCredential(secret, sid) {
  return `${sid}.${crypto.createHmac('sha256', secret).update(sid).digest('hex')}`;
}

/** The OTEL_EXPORTER_OTLP_HEADERS value for one session. */
export function sessionHeaders(secret, sid) {
  return `${SECRET_HEADER}=${sessionCredential(secret, sid)}`;
}

/** At most `max` requests in any one second. */
export class RateLimit {
  constructor(max = INGEST_PER_SECOND, now = () => Date.now()) {
    this.max = max;
    this.now = now;
    this.sec = 0;
    this.count = 0;
  }

  /** One budget per key (a session), so one session cannot use up another's. */
  allow(key = '') {
    const s = Math.floor(this.now() / 1000);
    if (s !== this.sec) {
      this.sec = s;
      this.counts = new Map();
    }
    this.counts ||= new Map();
    const n = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, n);
    return n <= this.max;
  }
}

/** On/off and the header secret: .clawdling/otel.json (server-only; agents' file tools are denied it). */
export class OtelState {
  constructor(file) {
    this.file = file;
  }

  read() {
    const o = readJson(this.file, {}) || {};
    return { enabled: o.enabled === true && typeof o.secret === 'string' && /^[0-9a-f]{64}$/.test(o.secret), secret: typeof o.secret === 'string' ? o.secret : null, enabled_at: o.enabled_at || null };
  }

  /** Turning it on makes a new secret; off forgets it, so a session started earlier is refused. */
  set(on) {
    if (on) writeJson(this.file, { enabled: true, secret: crypto.randomBytes(32).toString('hex'), enabled_at: new Date().toISOString() }, 0o600);
    else writeJson(this.file, { enabled: false }, 0o600);
    return this.read();
  }

  /**
   * The session a telemetry header belongs to, or null: "<sid>.<hmac>", checked in constant time.
   * A session can only ever send records for itself.
   */
  sidFor(header) {
    const st = this.read();
    if (!st.enabled || typeof header !== 'string') return null;
    const m = /^([0-9a-f-]{36})\.[0-9a-f]{64}$/.exec(header);
    if (!m || !isUuid(m[1])) return null;
    const a = Buffer.from(header);
    const b = Buffer.from(sessionCredential(st.secret, m[1]));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
  }
}

/** .clawdling/traces/<sid>.jsonl, append-only; 14 days, 50 MB in all (oldest files first). */
export class TraceStore {
  constructor(dir, { keepDays = TRACE_KEEP_DAYS, maxBytes = TRACE_MAX_BYTES } = {}) {
    Object.assign(this, { dir, keepDays, maxBytes });
    this.total = null;
  }

  file(sid) {
    if (!isUuid(sid)) throw new Error('invalid session id');
    return path.join(this.dir, `${sid}.jsonl`);
  }

  sizes() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(n)) continue;
      try {
        const st = fs.statSync(path.join(this.dir, n));
        out.push({ f: path.join(this.dir, n), size: st.size, t: st.mtimeMs });
      } catch {
        // gone
      }
    }
    return out;
  }

  append(items) {
    if (!items.length) return 0;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const by = new Map();
    const at = Date.now(); // when this computer received it: what retention goes by
    for (const { sid, rec } of items) {
      if (!by.has(sid)) by.set(sid, []);
      by.get(sid).push(JSON.stringify({ ...rec, at }));
    }
    if (this.total === null) this.total = this.sizes().reduce((s, x) => s + x.size, 0);
    let wrote = 0;
    for (const [sid, lines] of by) {
      const text = `${lines.join('\n')}\n`;
      fs.appendFileSync(this.file(sid), text, { mode: 0o600 });
      wrote += Buffer.byteLength(text);
    }
    this.total += wrote;
    if (this.total > this.maxBytes) this.prune();
    return wrote;
  }

  /** Drop records older than the retention from files still being written to. */
  trim(now = Date.now()) {
    const cutoff = now - this.keepDays * 86400000;
    for (const x of this.sizes()) {
      if (x.t < cutoff) continue; // prune() deletes the whole file
      let text;
      try {
        text = fs.readFileSync(x.f, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n').filter(Boolean);
      const keep = lines.filter((l) => {
        try {
          const o = JSON.parse(l);
          const t = Number.isFinite(o.at) ? o.at : Date.parse(o.ts || '');
          return Number.isFinite(t) && t >= cutoff;
        } catch {
          return false;
        }
      });
      if (keep.length === lines.length) continue;
      try {
        if (!keep.length) fs.unlinkSync(x.f);
        else {
          fs.writeFileSync(`${x.f}.tmp`, `${keep.join('\n')}\n`, { mode: 0o600 });
          fs.renameSync(`${x.f}.tmp`, x.f);
        }
      } catch {
        // try again next time
      }
    }
    this.total = null;
  }

  prune(now = Date.now()) {
    const files = this.sizes().sort((a, b) => a.t - b.t);
    let total = files.reduce((s, x) => s + x.size, 0);
    let removed = 0;
    for (const x of files) {
      if (now - x.t <= this.keepDays * 86400000 && total <= this.maxBytes) break;
      try {
        fs.unlinkSync(x.f);
        total -= x.size;
        removed++;
      } catch {
        // gone
      }
    }
    this.total = total;
    return removed;
  }

  /** Size and mtime of a session's file: what decides whether its records changed. */
  stamp(sid) {
    try {
      const st = fs.statSync(this.file(sid));
      return `${st.size}/${st.mtimeMs}`;
    } catch {
      return '';
    }
  }

  /** A session's records (the newest 5 MB at most). */
  read(sid) {
    let text = '';
    try {
      const f = this.file(sid);
      const st = fs.statSync(f);
      const max = 5 * 1024 * 1024;
      if (st.size > max) {
        const fd = fs.openSync(f, 'r');
        try {
          const buf = Buffer.alloc(max);
          fs.readSync(fd, buf, 0, max, st.size - max);
          text = buf.toString('utf8');
          text = text.slice(text.indexOf('\n') + 1);
        } finally {
          fs.closeSync(fd);
        }
      } else text = fs.readFileSync(f, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn line
      }
    }
    return out;
  }
}

// Who let a tool run (tool_decision.source), in plain words.
const SOURCE_TEXT = { config: 'your settings allowed it', user_permanent: 'you allowed it (always)', user_temporary: 'you allowed it once', user_abort: 'you stopped it', user_reject: 'you said no', hook: 'a hook decided', mode: 'the permission mode allowed it', classifier: "Claude Code's auto mode allowed it" };
export const sourceText = (s) => (typeof s === 'string' ? SOURCE_TEXT[s] || s.replace(/_/g, ' ') : null);

/**
 * Add what the telemetry says to Timeline entries: on each tool call who approved it (matched by
 * tool_use_id), on each prompt the turn's API requests (count and time). Mutates `entries`.
 */
export function enrich(entries, records) {
  if (!records.length) return entries;
  const decisions = new Map();
  const api = [];
  for (const r of records) {
    if (r.k !== 'log') continue;
    if (r.name === 'tool_decision' && typeof r.attrs.tool_use_id === 'string') decisions.set(r.attrs.tool_use_id, r.attrs);
    else if (r.name === 'api_request' && r.ts) api.push({ t: Date.parse(r.ts), ms: Number(r.attrs.duration_ms) || 0 });
  }
  const prompts = entries.filter((e) => e.kind === 'prompt' && e.depth === 0 && e.ts);
  for (const e of entries) {
    if (e.kind === 'tool' && decisions.has(e.id)) {
      const d = decisions.get(e.id);
      e.approval = { decision: typeof d.decision === 'string' ? d.decision : null, source: typeof d.source === 'string' ? d.source : null, text: sourceText(d.source) };
    }
  }
  for (let i = 0; i < prompts.length; i++) {
    const from = Date.parse(prompts[i].ts);
    const to = i + 1 < prompts.length ? Date.parse(prompts[i + 1].ts) : Infinity;
    const mine = api.filter((a) => a.t >= from && a.t < to);
    if (mine.length) prompts[i].api = { requests: mine.length, ms: mine.reduce((s, a) => s + a.ms, 0) };
  }
  return entries;
}
