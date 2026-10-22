// Telegram channel: long-poll getUpdates, pair one private chat with a 6-digit code, route that
// chat's messages to Donna, reply in plain text. Every other chat is ignored without a reply.
import crypto from 'node:crypto';
import { tokenEquals } from '../auth.js';
import { readEnvFile, writeEnvVar } from '../envfile.js';
import { badRequest, clampText, maskTail, oneLine, readJson, sleep, writeJson } from '../util.js';

export const BOT_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{20,80}$/;
export const MAX_MESSAGE = 4000;
const PAIRING_TTL_MS = 30 * 60 * 1000;
const MAX_PAIR_ATTEMPTS = 5;

/** Split text into Telegram-sized chunks, preferring paragraph, line, then word boundaries. */
export function chunkText(text, max = MAX_MESSAGE) {
  const s = String(text ?? '');
  if (s.length <= max) return [s];
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export function pairingCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

export class TelegramGateway {
  constructor({ paths, org, donna, events, logger, apiBase, pollTimeoutSec = 25, blocked = null }) {
    Object.assign(this, { paths, org, donna, events, logger, apiBase, pollTimeoutSec, blocked });
    this.running = false;
    this.abort = null;
    this.lastError = null;
    this.botUsername = null;
    this.onChange = null;
    this.loopPromise = null;
  }

  token() {
    const t = readEnvFile(this.paths.env).TELEGRAM_BOT_TOKEN;
    return t && BOT_TOKEN_RE.test(t) ? t : null;
  }

  state() {
    return readJson(this.paths.telegramState, {}) || {};
  }

  saveState(st) {
    writeJson(this.paths.telegramState, st, 0o600);
  }

  pendingPairing(st = this.state()) {
    const p = st.pairing;
    if (!p || !p.code || Date.now() > Date.parse(p.expires_at)) return null;
    return p;
  }

  status(org = this.org.read()) {
    const tg = org.channels.telegram;
    const paired = tg.chat_id !== null && tg.chat_id !== undefined;
    const st = this.state();
    const p = this.pendingPairing(st);
    return {
      configured: !!this.token(),
      enabled: !!tg.enabled,
      paired,
      chat_id_masked: paired ? maskTail(tg.chat_id) : null,
      bot_username: this.botUsername || st.bot_username || null,
      pairing_code: p ? p.code : null,
      pairing_expires_at: p ? p.expires_at : null,
      polling: this.running,
      error: this.blocked || this.lastError,
    };
  }

  changed() {
    try {
      this.onChange?.();
    } catch {
      // ignore
    }
  }

  async configure({ token, enabled, pair } = {}) {
    const st = this.state();
    if (token !== undefined && token !== null && token !== '') {
      const t = String(token).trim();
      if (!BOT_TOKEN_RE.test(t)) throw badRequest('that does not look like a bot token from @BotFather (digits:letters)');
      if (t !== this.token()) {
        // Ask Telegram who this bot is before storing the token: a rejected token is refused here,
        // and the reply can name the bot (@username) the owner has to open.
        let me = null;
        try {
          me = await this.api('getMe', {}, 8000, t);
        } catch (err) {
          if (err.status === 401 || err.status === 404) throw badRequest('Telegram rejected that bot token. Copy it again from @BotFather.');
          this.lastError = err.message; // offline or blocked: keep the token, polling retries
        }
        writeEnvVar(this.paths.env, 'TELEGRAM_BOT_TOKEN', t);
        st.offset = 0;
        this.botUsername = me?.username || null;
        if (this.botUsername) st.bot_username = this.botUsername;
        else delete st.bot_username;
        this.org.update((o) => {
          o.channels.telegram = { ...o.channels.telegram, chat_id: null, enabled: enabled === false ? false : true };
        });
      }
    }
    if (enabled !== undefined && enabled !== null) {
      this.org.update((o) => {
        o.channels.telegram = { ...o.channels.telegram, enabled: !!enabled };
      });
    }
    const org = this.org.read();
    const paired = org.channels.telegram.chat_id !== null && org.channels.telegram.chat_id !== undefined;
    if (this.token() && (token || pair === true || !paired) && !this.pendingPairing(st)) {
      const now = Date.now();
      st.pairing = { code: pairingCode(), created_at: new Date(now).toISOString(), expires_at: new Date(now + PAIRING_TTL_MS).toISOString(), attempts: 0 };
    } else if (this.token() && pair === true) {
      st.pairing = { ...st.pairing, expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString() };
    }
    this.saveState(st);
    this.restart();
    this.changed();
    const p = this.pendingPairing(st);
    return { pairing_code: p ? p.code : null };
  }

  shouldPoll() {
    if (this.blocked || !this.token()) return false;
    const tg = this.org.read().channels.telegram;
    return !!tg.enabled || !!this.pendingPairing();
  }

  start() {
    if (this.running) return;
    if (!this.shouldPoll()) {
      if (this.blocked && this.token()) this.logger?.warn?.(`telegram: ${this.blocked}`);
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.loop().catch((err) => this.logger?.warn?.(`telegram loop stopped: ${err.message}`));
  }

  stop() {
    this.running = false;
    this.abort?.abort();
  }

  restart() {
    this.stop();
    const prev = this.loopPromise;
    const go = () => this.start();
    if (prev) prev.finally(go);
    else go();
  }

  async api(method, params = {}, timeoutMs = 15000, tokenOverride = null) {
    const token = tokenOverride || this.token();
    if (!token) throw new Error('no Telegram bot token configured');
    if (this.blocked) throw new Error(this.blocked);
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (this.abort && !tokenOverride) signals.push(this.abort.signal);
    // The URL contains the token: never log it or put it in an error message.
    const res = await fetch(`${this.apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0],
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // non-JSON answer
    }
    if (!res.ok || !data.ok) {
      const err = new Error(`Telegram ${method} failed (${res.status}${data.description ? `: ${oneLine(data.description, 120)}` : ''})`);
      err.status = res.status;
      throw err;
    }
    return data.result;
  }

  async loop() {
    let backoff = 1000;
    try {
      const me = await this.api('getMe', {}, 10000);
      this.botUsername = me?.username || null;
      const st = this.state();
      st.bot_username = this.botUsername;
      this.saveState(st);
    } catch (err) {
      if (!this.running) return;
      this.lastError = err.message;
      if (err.status === 401 || err.status === 404) {
        this.running = false;
        this.changed();
        return;
      }
    }
    this.changed();
    while (this.running) {
      if (!this.shouldPoll()) break;
      try {
        const st = this.state();
        const updates = await this.api('getUpdates', { offset: st.offset || 0, timeout: this.pollTimeoutSec, allowed_updates: ['message'] }, (this.pollTimeoutSec + 15) * 1000);
        if (this.lastError) {
          this.lastError = null;
          this.changed();
        }
        backoff = 1000;
        for (const u of Array.isArray(updates) ? updates : []) {
          const cur = this.state();
          cur.offset = Math.max(cur.offset || 0, (u.update_id || 0) + 1);
          this.saveState(cur);
          try {
            await this.handleUpdate(u);
          } catch (err) {
            this.logger?.warn?.(`telegram update failed: ${err.message}`);
          }
        }
      } catch (err) {
        if (!this.running) break;
        this.lastError = err.message;
        this.changed();
        if (err.status === 401 || err.status === 404) {
          this.logger?.warn?.('telegram: the bot token was rejected; stopping until it is reconfigured');
          break;
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
    this.running = false;
  }

  async handleUpdate(u) {
    const msg = u?.message;
    if (!msg?.chat) return;
    const chatId = msg.chat.id;
    const text = typeof msg.text === 'string' ? msg.text : null;
    const pair = text && text.trim().match(/^\/(?:pair|start)(?:@[A-Za-z0-9_]+)?\s+(\d{6})$/);
    if (pair) return this.tryPair(msg.chat, pair[1]);
    const org = this.org.read();
    const tg = org.channels.telegram;
    if (tg.chat_id === null || tg.chat_id === undefined || String(chatId) !== String(tg.chat_id)) return; // strangers: silence
    if (!tg.enabled) return;
    if (!text || !text.trim()) {
      await this.reply(chatId, 'I can only read text messages for now.');
      return;
    }
    if (/^\/start\b/.test(text.trim())) {
      await this.reply(chatId, `Hi, I'm Donna, ${org.owner}'s chief of staff. Tell me what you need.`);
      return;
    }
    this.events.record({ type: 'channel', channel: 'telegram', direction: 'in', text: clampText(text, 500) });
    this.events.publish('channel', { channel: 'telegram', direction: 'in', text: clampText(text, 500), ts: new Date().toISOString() });
    this.dispatch(chatId, text);
  }

  async tryPair(chat, code) {
    const st = this.state();
    const p = this.pendingPairing(st);
    if (!p || chat.type !== 'private') return;
    if (!tokenEquals(code, p.code)) {
      p.attempts = (p.attempts || 0) + 1;
      if (p.attempts >= MAX_PAIR_ATTEMPTS) delete st.pairing;
      else st.pairing = p;
      this.saveState(st);
      return;
    }
    delete st.pairing;
    this.saveState(st);
    const org = this.org.update((o) => {
      o.channels.telegram = { ...o.channels.telegram, enabled: true, chat_id: chat.id };
    });
    this.events.record({ type: 'channel', channel: 'telegram', event: 'paired', chat: maskTail(chat.id) });
    this.changed();
    await this.reply(chat.id, `Paired. This chat now reaches Donna, ${org.owner}'s chief of staff. Try: "what's going on?"`);
  }

  dispatch(chatId, text) {
    const typing = () => this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    typing();
    const timer = setInterval(typing, 4500);
    this.donna
      .handle({ channel: 'telegram', text })
      .then((reply) => this.reply(chatId, reply || 'Done.'))
      .catch((err) => {
        this.logger?.warn?.(`donna turn failed: ${err.message}`);
        this.events.record({ type: 'channel', channel: 'telegram', event: 'error', text: clampText(err.message, 300) });
        return this.reply(chatId, `Donna hit an error: ${oneLine(err.message, 200)}`);
      })
      .catch((err) => this.logger?.warn?.(`telegram reply failed: ${err.message}`))
      .finally(() => clearInterval(timer));
  }

  async reply(chatId, text) {
    for (const part of chunkText(text)) {
      await this.api('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true });
    }
    this.events.record({ type: 'channel', channel: 'telegram', direction: 'out', text: clampText(text, 500) });
    this.events.publish('channel', { channel: 'telegram', direction: 'out', text: clampText(text, 500), ts: new Date().toISOString() });
  }
}
