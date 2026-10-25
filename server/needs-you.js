// "An agent needs you": an opt-in one-line message to the owner's own paired Donna channel
// (Telegram or iMessage) when a session starts waiting on them.
//
// Off by default. It says which agent and what kind of wait, never the question, the session title
// or anything else from the conversation. It waits a few seconds first (an answer given in the
// cockpit meanwhile sends nothing), and it is rate-limited: one per session per 10 minutes, six an
// hour in all, across restarts.
//
// Who it may go to, and whether it is on at all, is decided only from server-only state under
// .clawdling/ (agents' file tools are denied there), never from org.json alone, which agents can
// edit: the Telegram chat must be the one that sent the pairing code (telegram.json; a pairing from
// before 1.4 has no record and must pair again), and an iMessage handle must be the one the owner
// set in the cockpit and must have texted Donna since (imessage.json). The on/off switch and the
// send history live in .clawdling/notify.json.
import { runtimeDeny } from './hooks.js';
import { badRequest, readJson, writeJson, oneLine } from './util.js';

const WHAT = {
  question: 'a question',
  plan: 'a plan to approve',
  permission_prompt: 'a permission',
  elicitation_dialog: 'a question',
  login: 'a sign-in',
  error: 'an error',
  trust: 'a question before it starts',
  imports: 'a question before it starts',
  startup: 'a question before it starts',
};
const HOUR = 3600000;

/** An agent's name as it may appear in a message: letters, digits, spaces and hyphens, 40 at most. */
export function safeName(name) {
  const s = oneLine(String(name || ''), 200).replace(/[^\p{L}\p{N} -]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return (s.length > 40 ? s.slice(0, 40).trim() : s) || 'An agent';
}

/** The message: "Clawdling: Health needs you (a question). Open the cockpit to answer." */
export function pingText({ agentName, waitingOn, asking }) {
  const kind = (k) => (typeof k === 'string' && Object.hasOwn(WHAT, k) ? WHAT[k] : null);
  const what = kind(asking?.kind) || kind(waitingOn);
  return `Clawdling: ${safeName(agentName)} needs you${what ? ` (${what})` : ''}. Open the cockpit to answer.`;
}

/**
 * Which paired channel a ping can go to, or null: Telegram first, then iMessage.
 * `pairedChatId`: the chat that sent the pairing code (server-only); `verifiedHandle`: the iMessage
 * handle that has texted Donna, or null.
 */
export function pingChannel(org, { pairedChatId = null, verifiedHandle = null, telegramReady = true, imessageReady = true } = {}) {
  const tg = org?.channels?.telegram || {};
  if (telegramReady && tg.enabled && tg.chat_id !== null && tg.chat_id !== undefined && pairedChatId !== null && pairedChatId !== undefined && String(tg.chat_id) === String(pairedChatId)) {
    return { channel: 'telegram', to: pairedChatId };
  }
  const im = org?.channels?.imessage || {};
  if (imessageReady && im.enabled && im.handle && verifiedHandle && im.handle === verifiedHandle) return { channel: 'imessage', to: im.handle };
  return null;
}

export class NeedsYouPinger {
  constructor({ paths, org, sessions, telegram, imessage, events, logger, now = Date.now, delayMs = 4000, perSessionMs = 10 * 60000, perHour = 6, platform = process.platform }) {
    Object.assign(this, { paths, org, sessions, telegram, imessage, events, logger, now, delayMs, perSessionMs, perHour, platform });
    this.timers = new Map();
  }

  state() {
    const st = readJson(this.paths.notify, {}) || {};
    return {
      needs_you: st.needs_you === true,
      sent: Array.isArray(st.sent) ? st.sent.filter((t) => Number.isFinite(t)) : [],
      last: st.last && typeof st.last === 'object' ? st.last : {},
    };
  }

  save(st) {
    writeJson(this.paths.notify, st, 0o600);
  }

  /**
   * Can agents be kept out of .clawdling here? Their file tools are denied it by path rules, which
   * cannot be written for every folder name (runtimeDeny). Without them this stays off.
   */
  guarded() {
    return !this.paths.home || runtimeDeny(this.paths.home, this.platform).length > 0;
  }

  enabled() {
    return this.guarded() && this.state().needs_you;
  }

  status() {
    const org = this.org.read();
    const ch = this.channelFor(org);
    const im = org.channels?.imessage || {};
    const tg = org.channels?.telegram || {};
    let paired = null;
    try {
      paired = this.telegram?.state?.()?.paired_chat_id ?? null;
    } catch {
      paired = null;
    }
    // Set up, but not proven yet: say what to do.
    const repair = !ch && tg.enabled && tg.chat_id !== null && tg.chat_id !== undefined && String(tg.chat_id) !== String(paired);
    const unverified = !ch && !!(im.enabled && im.handle) && !this.imessage?.verifiedHandle?.(org);
    return { needs_you: this.enabled(), channel: ch ? ch.channel : null, ...(this.guarded() ? {} : { unprotected: true }), ...(repair ? { telegram_repair: true } : {}), ...(unverified ? { imessage_unverified: true } : {}) };
  }

  setEnabled(on) {
    if (on === true && !this.guarded()) throw badRequest("Clawdling cannot keep agents out of its own settings in a folder whose path has characters like ( ) ' or accents, so it will not message you from here");
    const st = this.state();
    st.needs_you = on === true;
    this.save(st);
    this.events?.record?.({ type: 'notify', needs_you: on === true });
    return this.status();
  }

  channelFor(org) {
    let pairedChatId = null;
    try {
      pairedChatId = this.telegram?.state?.()?.paired_chat_id ?? null;
    } catch {
      pairedChatId = null;
    }
    return pingChannel(org, {
      pairedChatId,
      verifiedHandle: this.imessage?.verifiedHandle?.(org) ?? null,
      telegramReady: !!this.telegram?.token?.() && !this.telegram?.blocked,
      imessageReady: !!this.imessage?.supported?.() && !this.imessage?.blockedReason?.(),
    });
  }

  /** A session started waiting on its owner: maybe ping, a few seconds from now. */
  onNeedsYou(rec) {
    if (!rec || this.timers.has(rec.sid)) return;
    let on = false;
    try {
      on = this.enabled();
    } catch {
      on = false;
    }
    if (!on) return;
    const t = setTimeout(() => {
      this.timers.delete(rec.sid);
      this.check(rec.sid).catch((err) => this.logger?.warn?.(`needs-you ping: ${err.message}`));
    }, this.delayMs);
    t.unref?.();
    this.timers.set(rec.sid, t);
  }

  async check(sid) {
    const rec = this.sessions.get(sid);
    if (!rec || rec.status !== 'needs_you') return { sent: false, why: 'answered' };
    const st = this.state();
    if (!st.needs_you || !this.guarded()) return { sent: false, why: 'off' };
    const t = this.now();
    st.sent = st.sent.filter((x) => t - x < HOUR && x <= t);
    for (const [k, at] of Object.entries(st.last)) if (!(t - at < this.perSessionMs)) delete st.last[k];
    if (st.last[sid] !== undefined) return { sent: false, why: 'rate (session)' };
    if (st.sent.length >= this.perHour) return { sent: false, why: 'rate (hour)' };
    const org = this.org.read();
    const ch = this.channelFor(org);
    if (!ch) return { sent: false, why: 'no paired channel' };
    const text = pingText({ agentName: rec.agent_name || rec.agent, waitingOn: rec.waiting_on, asking: rec.asking });
    st.last[sid] = t;
    st.sent.push(t);
    this.save(st); // counted before sending: a failed send still counts
    if (ch.channel === 'telegram') await this.telegram.reply(ch.to, text);
    else await this.imessage.send(ch.to, text);
    this.events?.record?.({ type: 'ping', sid, agent: rec.agent, channel: ch.channel });
    return { sent: true, channel: ch.channel, text };
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
