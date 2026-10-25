// "An agent needs you": an opt-in one-line message to the owner's own paired Donna channel
// (Telegram or iMessage) when a session starts waiting on them.
//
// Off by default (org.json `notify.needs_you`). It says which agent and what kind of wait, never
// the question, the session title or anything else from the conversation. It waits a few seconds
// first (an answer given in the cockpit meanwhile sends nothing), and it is rate-limited: one per
// session per 10 minutes, six an hour in all. It only ever goes to the chat or handle Donna is
// already paired with.
import { normalizeHandle, validHandle } from './channels/imessage.js';
import { oneLine } from './util.js';

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

/** The message: "Clawdling: Health needs you (a question). Open the cockpit to answer." */
export function pingText({ agentName, waitingOn, asking }) {
  const kind = (k) => (typeof k === 'string' && Object.hasOwn(WHAT, k) ? WHAT[k] : null);
  const what = kind(asking?.kind) || kind(waitingOn);
  const who = oneLine(agentName || 'An agent', 60);
  return `Clawdling: ${who} needs you${what ? ` (${what})` : ''}. Open the cockpit to answer.`;
}

/**
 * Which paired channel a ping can go to, or null: Telegram first (paired by a code sent from the
 * chat), then iMessage, only once the handle has proven itself by texting Donna (`verified`).
 */
export function pingChannel(org, { telegramReady = true, imessageReady = true } = {}) {
  const tg = org?.channels?.telegram || {};
  if (telegramReady && tg.enabled && tg.chat_id !== null && tg.chat_id !== undefined) return { channel: 'telegram', to: tg.chat_id };
  const im = org?.channels?.imessage || {};
  if (imessageReady && im.enabled && im.handle && validHandle(im.handle) && im.verified && im.verified === normalizeHandle(im.handle)) return { channel: 'imessage', to: im.handle };
  return null;
}

export class NeedsYouPinger {
  constructor({ org, sessions, telegram, imessage, events, logger, now = Date.now, delayMs = 4000, perSessionMs = 10 * 60000, perHour = 6 }) {
    Object.assign(this, { org, sessions, telegram, imessage, events, logger, now, delayMs, perSessionMs, perHour });
    this.lastBySid = new Map();
    this.sent = []; // times of recent pings
    this.timers = new Map();
  }

  enabled(org = this.org.read()) {
    return org?.notify?.needs_you === true;
  }

  status() {
    const org = this.org.read();
    const ch = this.channelFor(org);
    const im = org.channels?.imessage || {};
    // iMessage is set up but has not texted Donna yet: say so, so the owner knows what to do.
    const unverified = !ch && !!(im.enabled && im.handle) && im.verified !== normalizeHandle(im.handle);
    return { needs_you: this.enabled(org), channel: ch ? ch.channel : null, ...(unverified ? { imessage_unverified: true } : {}) };
  }

  setEnabled(on) {
    this.org.update((o) => {
      o.notify = { ...(o.notify || {}), needs_you: on === true };
      return o;
    });
    this.events?.record?.({ type: 'notify', needs_you: on === true });
    return this.status();
  }

  channelFor(org) {
    return pingChannel(org, {
      telegramReady: !!this.telegram?.token?.() && !this.telegram?.blocked,
      imessageReady: !!this.imessage?.supported?.() && !this.imessage?.blockedReason?.(),
    });
  }

  /** A session started waiting on its owner: maybe ping, a few seconds from now. */
  onNeedsYou(rec) {
    if (!rec || this.timers.has(rec.sid)) return;
    let enabled = false;
    try {
      enabled = this.enabled();
    } catch {
      enabled = false;
    }
    if (!enabled) return;
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
    const org = this.org.read();
    if (!this.enabled(org)) return { sent: false, why: 'off' };
    const t = this.now();
    for (const [k, at] of this.lastBySid) if (t - at >= this.perSessionMs) this.lastBySid.delete(k);
    if (this.lastBySid.has(sid)) return { sent: false, why: 'rate (session)' };
    this.sent = this.sent.filter((x) => t - x < 3600000);
    if (this.sent.length >= this.perHour) return { sent: false, why: 'rate (hour)' };
    const ch = this.channelFor(org);
    if (!ch) return { sent: false, why: 'no paired channel' };
    const text = pingText({ agentName: rec.agent_name || rec.agent, waitingOn: rec.waiting_on, asking: rec.asking });
    this.lastBySid.set(sid, t);
    this.sent.push(t);
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
