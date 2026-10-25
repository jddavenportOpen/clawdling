// iMessage channel (macOS, experimental): poll ~/Library/Messages/chat.db read-only for new
// messages from the owner's handle, route them to Donna, reply through Messages via osascript.
// The reply text is passed to AppleScript as an argv item, never spliced into script source.
import os from 'node:os';
import path from 'node:path';
import { badRequest, clampText, execFileP, oneLine, readJson, writeJson } from '../util.js';
import { isTestMode } from '../paths.js';

export const SEND_SCRIPT = [
  'on run argv',
  'set targetHandle to item 1 of argv',
  'set messageText to item 2 of argv',
  'tell application "Messages"',
  'set targetService to 1st account whose service type = iMessage',
  'set targetBuddy to participant targetHandle of targetService',
  'send messageText to targetBuddy',
  'end tell',
  'end run',
];

export function osascriptArgs(handle, text) {
  const a = [];
  for (const line of SEND_SCRIPT) a.push('-e', line);
  a.push('--', String(handle), String(text)); // '--': a handle or text starting with "-" is never an option
  return a;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9(][0-9 ().-]{4,23}$/;

export function validHandle(h) {
  const s = String(h ?? '').trim();
  return EMAIL_RE.test(s) || (PHONE_RE.test(s) && s.replace(/\D/g, '').length >= 5);
}

/**
 * Is `sender` (as Messages recorded it) exactly the configured `handle`? Stricter than
 * normalizeHandle: all the digits, except that a 10-digit number typed without its country code
 * matches the same number with one.
 */
export function sameSender(sender, handle) {
  const a = String(sender ?? '').trim().toLowerCase();
  const b = String(handle ?? '').trim().toLowerCase();
  if (!a || !b) return false;
  if (a.includes('@') || b.includes('@')) return a === b;
  const da = a.replace(/\D/g, '');
  const db = b.replace(/\D/g, '');
  if (db.length < 5) return false;
  return da === db || (db.length === 10 && da.length > 10 && da.endsWith(db));
}

/** Compare handles the way Messages stores them: emails case-insensitive, phones by last 10 digits. */
export function normalizeHandle(h) {
  const s = String(h ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@')) return s;
  const digits = s.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Best-effort text from an attributedBody typedstream blob (newer macOS leaves `text` NULL). */
export function decodeAttributedBody(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const buf = Buffer.from(hex, 'hex');
  const marker = buf.indexOf(Buffer.from('NSString'));
  if (marker === -1) return null;
  const plus = buf.indexOf(0x2b, marker + 8);
  if (plus === -1 || plus - marker > 24) return null;
  let i = plus + 1;
  if (i >= buf.length) return null;
  let len = buf[i++];
  if (len === 0x81) {
    if (i + 2 > buf.length) return null;
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > buf.length) return null;
    len = buf.readUInt32LE(i);
    i += 4;
  }
  if (i + len > buf.length) return null;
  return buf.toString('utf8', i, i + len);
}

export function pollSql(lastRowid) {
  const last = Number.isSafeInteger(lastRowid) && lastRowid > 0 ? lastRowid : 0;
  return (
    'SELECT m.ROWID AS rowid, m.text AS text, hex(m.attributedBody) AS body_hex, m.is_from_me AS is_from_me, h.id AS handle ' +
    'FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id ' +
    `WHERE m.ROWID > ${last} AND m.is_from_me = 0 ORDER BY m.ROWID ASC LIMIT 50;`
  );
}

export class IMessageGateway {
  constructor({ paths, org, donna, events, logger, env = process.env, platform = process.platform }) {
    Object.assign(this, { paths, org, donna, events, logger, env, platform });
    this.timer = null;
    this.polling = false;
    this.lastError = null;
    this.onChange = null;
    this.pollMs = Number(env.CLAWDLING_IMESSAGE_POLL_MS) || 3000;
  }

  supported() {
    return this.platform === 'darwin';
  }

  chatDb() {
    return this.env.CLAWDLING_CHATDB_PATH || path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
  }

  sqliteBin() {
    return this.env.CLAWDLING_SQLITE_BIN || '/usr/bin/sqlite3';
  }

  osascriptBin() {
    return this.env.CLAWDLING_OSASCRIPT_BIN || '/usr/bin/osascript';
  }

  /** In test mode refuse to touch the real Messages database or the real osascript. */
  blockedReason() {
    if (!isTestMode(this.env)) return null;
    if (!this.env.CLAWDLING_CHATDB_PATH || !this.env.CLAWDLING_OSASCRIPT_BIN) return 'test mode: set CLAWDLING_CHATDB_PATH and CLAWDLING_OSASCRIPT_BIN to fixtures';
    return null;
  }

  status(org = this.org.read()) {
    const im = org.channels.imessage;
    return { supported: this.supported(), enabled: !!im.enabled, handle: im.handle || null, polling: !!this.timer, error: this.blockedReason() || this.lastError };
  }

  changed() {
    try {
      this.onChange?.();
    } catch {
      // ignore
    }
  }

  async configure({ handle, enabled } = {}) {
    if (handle !== undefined && handle !== null && handle !== '' && !validHandle(handle)) throw badRequest('handle must be an email address or phone number');
    this.org.update((o) => {
      const cur = o.channels.imessage;
      o.channels.imessage = {
        ...cur,
        handle: handle !== undefined ? (handle ? String(handle).trim() : null) : cur.handle,
        enabled: enabled !== undefined ? !!enabled : cur.enabled,
      };
    });
    const im = this.org.read().channels.imessage;
    if (im.enabled && !im.handle) throw badRequest('set a handle (the phone number or email you text from) before enabling iMessage');
    this.stop();
    this.start();
    this.changed();
  }

  start() {
    if (this.timer || !this.supported() || this.blockedReason()) return;
    const im = this.org.read().channels.imessage;
    if (!im.enabled || !im.handle) return;
    const tick = () => {
      this.poll().catch((err) => {
        this.lastError = oneLine(err.message, 200);
      });
    };
    this.timer = setInterval(tick, this.pollMs);
    this.timer.unref?.();
    tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async query(sql) {
    const { stdout } = await execFileP(this.sqliteBin(), ['-json', '-readonly', this.chatDb(), sql], { timeout: 10000 });
    const t = stdout.trim();
    return t ? JSON.parse(t) : [];
  }

  async poll() {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const im = this.org.read().channels.imessage;
      if (!im.enabled || !im.handle) return 0;
      const st = readJson(this.paths.imessageState, {}) || {};
      if (!Number.isSafeInteger(st.last_rowid) || st.db !== this.chatDb()) {
        // First run: start from now, never replay history.
        const rows = await this.query('SELECT MAX(ROWID) AS max FROM message;');
        st.last_rowid = Number(rows[0]?.max) || 0;
        st.db = this.chatDb();
        writeJson(this.paths.imessageState, st, 0o600);
        return 0;
      }
      const rows = await this.query(pollSql(st.last_rowid));
      if (this.lastError) {
        this.lastError = null;
        this.changed();
      }
      let n = 0;
      const want = normalizeHandle(im.handle);
      for (const row of rows) {
        const id = Number(row.rowid);
        if (Number.isSafeInteger(id) && id > st.last_rowid) st.last_rowid = id;
        writeJson(this.paths.imessageState, st, 0o600);
        if (Number(row.is_from_me) !== 0) continue;
        if (normalizeHandle(row.handle) !== want) continue;
        const text = (row.text && String(row.text)) || decodeAttributedBody(row.body_hex);
        if (!text || !text.trim()) continue;
        n++;
        // A message from the handle proves it is the owner's: only then may Clawdling text it first
        // (the "an agent needs you" ping, needs-you.js). Kept in server-only state, for this exact
        // handle as configured: any change to the handle has to prove itself again.
        if (st.verified_for !== im.handle && sameSender(row.handle, im.handle)) {
          st.verified_for = im.handle;
          writeJson(this.paths.imessageState, st, 0o600);
        }
        this.events.record({ type: 'channel', channel: 'imessage', direction: 'in', text: clampText(text, 500) });
        this.events.publish('channel', { channel: 'imessage', direction: 'in', text: clampText(text, 500), ts: new Date().toISOString() });
        await this.dispatch(im.handle, text);
      }
      return n;
    } catch (err) {
      const msg = /authorization denied|unable to open|operation not permitted/i.test(String(err.stderr || err.message))
        ? 'cannot read the Messages database: give the app that runs Clawdling Full Disk Access (System Settings > Privacy & Security)'
        : oneLine(err.stderr || err.message, 200);
      if (msg !== this.lastError) {
        this.lastError = msg;
        this.changed();
      }
      throw err;
    } finally {
      this.polling = false;
    }
  }

  async dispatch(handle, text) {
    let reply;
    try {
      reply = await this.donna.handle({ channel: 'imessage', text });
    } catch (err) {
      reply = `Donna hit an error: ${oneLine(err.message, 200)}`;
    }
    await this.send(handle, reply || 'Done.');
  }

  /** The configured handle, if a message from it has proven it is the owner's (see poll). */
  verifiedHandle(org = this.org.read()) {
    const im = org.channels.imessage;
    const st = readJson(this.paths.imessageState, {}) || {};
    return im.handle && validHandle(im.handle) && st.verified_for === im.handle ? im.handle : null;
  }

  async send(handle, text) {
    const blocked = this.blockedReason();
    if (blocked) throw new Error(blocked);
    for (let i = 0; i < text.length || i === 0; i += 4000) {
      await execFileP(this.osascriptBin(), osascriptArgs(handle, text.slice(i, i + 4000)), { timeout: 20000 });
      if (text.length === 0) break;
    }
    this.events.record({ type: 'channel', channel: 'imessage', direction: 'out', text: clampText(text, 500) });
    this.events.publish('channel', { channel: 'imessage', direction: 'out', text: clampText(text, 500), ts: new Date().toISOString() });
  }
}

