// The Monday report (1.5, opt-in): one message a week to the owner's own paired Donna channel
// (Telegram or iMessage), per agent: how many sessions got work done, how many need the owner, and
// the usage over 7 days as a list-price equivalent; plus the agents with the most and least usage.
//
// Off by default. It carries counts, agent names and dollar figures only: no session title (titles
// are made from the first prompt), no prompt, no file. Agent names are the ones the owner approved
// when turning it on (an agent can rename itself; a new name never reaches a message). It goes out
// through the 1.4 needs-you ping's channel path (NeedsYouPinger.deliver); there is no new sender.
// Schedule: an in-process timer checked every 10 minutes against .clawdling/digest.json; once per
// ISO week; a Clawdling that was not running at 08:00 on Monday sends at its next start that week.
import { safeName } from './needs-you.js';
import { HttpError, badRequest, readJson, writeJson } from './util.js';

export const CHECK_MS = 10 * 60000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_LINES = 12;

/** "2026-W43": the ISO week (Monday first) of a time, in local time. */
export function isoWeek(ms) {
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7; // Monday 0
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const week = 1 + Math.round(((thursday - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** This ISO week's send time: its `day` (0 Sunday .. 6 Saturday, ISO order Monday first) at `hour`. */
export function weekSendTime(ms, { day = 1, hour = 8 } = {}) {
  const d = new Date(ms);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7), hour, 0, 0, 0);
  const offset = (day + 6) % 7; // Monday 0 .. Sunday 6
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset, hour, 0, 0, 0).getTime();
}

const money = (x) => (!Number.isFinite(x) ? 'unknown' : x === 0 ? '$0' : x > 0 && x < 0.005 ? 'less than $0.01' : `about $${x.toFixed(2)}`);

/**
 * The message, exactly as sent. `org` is Reports.orgReport({window: '7d'}); `labels` maps agent id
 * to its approved name. Agents with nothing done, nothing waiting and no usage are counted, not listed.
 */
export function digestText(org, { labels = {} } = {}) {
  const name = (a) => (Object.hasOwn(labels, a.id) ? safeName(labels[a.id]) : 'Another agent');
  const active = (org.agents || []).filter((a) => a.done > 0 || a.needs > 0 || a.cost_usd > 0);
  active.sort((a, b) => b.cost_usd - a.cost_usd || b.done - a.done);
  const lines = ['Clawdling: your week, the last 7 days.'];
  if (!active.length) lines.push('No agent did any work this week.');
  for (const a of active.slice(0, MAX_LINES)) {
    lines.push(`- ${name(a)}: ${a.done} done, ${a.needs} need${a.needs === 1 ? 's' : ''} you, ${money(a.cost_usd)}${a.cost_complete ? '' : ' (part unknown)'}`);
  }
  if (active.length > MAX_LINES) lines.push(`- and ${active.length - MAX_LINES} more`);
  const quiet = (org.agents || []).length - active.length;
  if (quiet > 0 && active.length) lines.push(`${quiet} other agent${quiet === 1 ? ' was' : 's were'} quiet.`);
  const used = active.filter((a) => a.cost_usd > 0);
  if (used.length >= 2) {
    const top = used[0];
    const low = used[used.length - 1];
    lines.push(`Most usage: ${name(top)} (${money(top.cost_usd)}). Least: ${name(low)} (${money(low.cost_usd)}).`);
  }
  lines.push(`Total: ${money(org.totals?.week_usd ?? 0)}${org.totals && org.totals.complete === false ? ' (part unknown)' : ''}. Usage is a list-price equivalent, not a bill: on Pro and Max it is included in your plan. Open the cockpit for the details.`);
  return lines.join('\n');
}

export class Digest {
  constructor({ paths, org, reports, pinger, events, logger, now = Date.now }) {
    Object.assign(this, { paths, org, reports, pinger, events, logger, now });
    this.timer = null;
    this.sending = false;
  }

  state() {
    const st = readJson(this.paths.digest, {}) || {};
    return {
      enabled: st.enabled === true,
      day: Number.isInteger(st.day) && st.day >= 0 && st.day <= 6 ? st.day : 1,
      hour: Number.isInteger(st.hour) && st.hour >= 0 && st.hour <= 23 ? st.hour : 8,
      labels: st.labels && typeof st.labels === 'object' ? st.labels : {},
      last_sent_week: typeof st.last_sent_week === 'string' ? st.last_sent_week : null,
      last_sent_at: typeof st.last_sent_at === 'string' ? st.last_sent_at : null,
      last_error: typeof st.last_error === 'string' ? st.last_error : null,
    };
  }

  save(st) {
    writeJson(this.paths.digest, st, 0o600);
  }

  /** Today's names, as the owner sees them, for approval. */
  currentLabels() {
    const out = {};
    for (const a of this.org.agents?.() || []) if (a && typeof a.id === 'string') out[a.id] = safeName(a.name || a.id);
    return out;
  }

  status() {
    const st = this.state();
    const ch = this.pinger.channelFor(this.org.read());
    const labels = st.enabled ? st.labels : this.currentLabels();
    const now = this.now();
    let next = weekSendTime(now, st);
    if (st.last_sent_week === isoWeek(now) || now > next + 6 * 86400000) next = weekSendTime(now + 7 * 86400000, st);
    let preview = null;
    try {
      preview = digestText(this.reports.orgReport({ window: '7d' }), { labels });
    } catch (err) {
      preview = null;
      this.logger?.warn?.(`monday report preview: ${err.message}`);
    }
    return {
      enabled: st.enabled,
      day: st.day,
      day_name: DAYS[st.day],
      hour: st.hour,
      channel: ch ? ch.channel : null,
      preview,
      labels: st.enabled ? st.labels : {},
      ...(st.enabled ? {} : { preview_labels: labels }),
      last_sent_at: st.last_sent_at,
      last_error: st.last_error,
      next_at: st.enabled ? new Date(next).toISOString() : null,
      ...(this.pinger.guarded() ? {} : { unprotected: true }),
    };
  }

  /**
   * {enabled?, day?, hour?, labels?}. Turning it on approves the agent names the owner was shown:
   * `labels` must equal today's names (the preview's preview_labels), or nothing changes and the
   * owner is asked to look again; off forgets them.
   */
  configure(b = {}) {
    const st = this.state();
    if (b.day !== undefined) {
      if (!Number.isInteger(b.day) || b.day < 0 || b.day > 6) throw badRequest('day must be 0 (Sunday) to 6 (Saturday)');
      st.day = b.day;
    }
    if (b.hour !== undefined) {
      if (!Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23) throw badRequest('hour must be 0 to 23');
      st.hour = b.hour;
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw badRequest('enabled must be true or false');
      if (b.enabled && !this.pinger.guarded()) throw badRequest("Clawdling cannot keep agents out of its own settings in a folder whose path has characters like ( ) ' or accents, so it will not message you from here");
      if (b.enabled && !this.pinger.channelFor(this.org.read())) throw badRequest('Pair Telegram or iMessage with Donna first: the Monday report goes to that chat.');
      if (b.enabled && !st.enabled) {
        const now = this.currentLabels();
        const shown = b.labels && typeof b.labels === 'object' && !Array.isArray(b.labels) ? b.labels : null;
        const same = shown && Object.keys(now).length === Object.keys(shown).length && Object.entries(now).every(([k, v]) => shown[k] === v);
        if (!same) {
          const e = new HttpError(409, 'The agent names changed since this page showed them. Look at the message again, then turn it on.');
          e.body = { preview_labels: now };
          throw e;
        }
        st.labels = now;
        // Turned on mid-week after this week's send time: the first report waits for next week.
        if (this.now() >= weekSendTime(this.now(), st)) st.last_sent_week = isoWeek(this.now());
      }
      if (!b.enabled) st.labels = {};
      st.enabled = b.enabled;
    }
    this.save(st);
    this.events?.record?.({ type: 'digest', enabled: st.enabled });
    return this.status();
  }

  /** Send if it is on, it is due this ISO week, and this week's report has not gone out. */
  async check() {
    if (this.sending) return { sent: false, why: 'busy' };
    const st = this.state();
    if (!st.enabled) return { sent: false, why: 'off' };
    if (!this.pinger.guarded()) return { sent: false, why: 'unprotected' };
    const now = this.now();
    const week = isoWeek(now);
    if (st.last_sent_week === week) return { sent: false, why: 'sent this week' };
    if (now < weekSendTime(now, st)) return { sent: false, why: 'not yet' };
    const text = digestText(this.reports.orgReport({ window: '7d' }), { labels: st.labels });
    this.sending = true;
    // Counted before sending, like the needs-you ping: a failed send never turns into a retry storm.
    st.last_sent_week = week;
    st.last_sent_at = new Date(now).toISOString();
    st.last_error = null;
    this.save(st);
    // Only the result is written afterwards, onto the state as it is then: a change the owner made
    // while the message was on its way (turning it off) is never undone.
    const result = (error) => {
      const now = this.state();
      now.last_error = error;
      this.save(now);
    };
    try {
      const r = await this.pinger.deliver(text);
      if (!r.sent) {
        result(r.why);
        return { sent: false, why: r.why };
      }
      this.events?.record?.({ type: 'digest_sent', channel: r.channel, week });
      return { sent: true, channel: r.channel, text };
    } catch (err) {
      const why = String(err.message || err).slice(0, 200);
      result(why);
      this.logger?.warn?.(`monday report: ${why}`);
      return { sent: false, why };
    } finally {
      this.sending = false;
    }
  }

  start(intervalMs = CHECK_MS) {
    const run = () => this.check().catch((err) => this.logger?.warn?.(`monday report: ${err.message}`));
    setTimeout(run, 5000).unref?.();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
