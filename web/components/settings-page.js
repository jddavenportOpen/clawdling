// Settings (#/settings): your phone, appearance, workspace, shortcuts, what the server reports, and
// your own Claude Code setup (#/settings/setup scrolls to it).
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { useStore, getState } from '../lib/store.js';
import { getThemePref, setThemePref } from '../lib/theme.js';
import { load, save } from '../lib/prefs.js';
import { terms } from '../lib/term.js';
import { closeAllPanes, toast, errorToast, mergeSession, focusSession } from '../lib/actions.js';
import { refreshHealth } from '../lib/live.js';
import { MOD, ALT, copyText, cliCmd } from '../lib/util.js';
import { ok } from '../lib/model.js';
import { api } from '../lib/api.js';
import { Icon } from './icons.js';
import { SetupCard } from './setup.js';
import { RemoteCard } from './remote.js';
import { notifySupported, notifyOn, setNotify, setLabels } from '../lib/notify.js';

export function SettingsPage() {
  const health = useStore((s) => s.health);
  const open = useStore((s) => s.open);
  const section = useStore((s) => s.route.section);
  const [theme, setTheme] = useState(getThemePref());

  useEffect(() => {
    if (section !== 'setup') return undefined;
    const id = requestAnimationFrame(() => {
      const card = document.getElementById('setup');
      if (card) card.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(id);
  }, [section]);
  const [font, setFont] = useState(Number(load('termFontSize', 13)) || 13);
  const [reader, setReader] = useState(!!load('termScreenReader', false));

  const pickTheme = (t) => { setTheme(t); setThemePref(t); };
  const pickFont = (px) => {
    setFont(px);
    save('termFontSize', px);
    for (const v of terms.values()) v.setFontSize();
  };
  const pickReader = (on) => {
    setReader(on);
    save('termScreenReader', on);
    for (const v of terms.values()) v.setScreenReader(on);
  };
  // Where sessions run: tmux (they outlive the cockpit) or the built-in terminal (they end with it).
  const backend = health && health.backend;
  const sessionsText = !backend || !backend.kind ? null
    : backend.kind === 'tmux' ? `tmux · keep running when Clawdling stops`
    : `built-in terminal${backend.version ? ` (${backend.version})` : ''} · end when Clawdling stops; resume any time`;
  const tmuxText = !health || !health.tmux ? 'unknown'
    : ok(health.tmux) ? `ok${health.tmux.version ? ` · ${health.tmux.version}` : ''}`
    : health.tmux.optional ? `${health.tmux.error || 'not installed'} · optional`
    : 'missing';

  return html`<div class="page settings-page" data-testid="settings-page">
    <header class="page-bar"><div class="page-bar-main"><h1 class="page-title">Settings</h1>
      <p class="page-sub">Appearance and workspace are stored in this browser. Your org itself lives in files on disk.</p></div></header>
    <div class="settings-grid">
      <${RemoteCard} />
      ${health && health.remote ? null : html`<${PhoneCard} />`}
      <section class="card" aria-labelledby="set-look">
        <h2 id="set-look" class="card-title">Appearance</h2>
        <div class="set-row"><span class="set-label">Theme</span>
          <div class="seg" role="radiogroup" aria-label="Theme">
            ${[['system', 'System'], ['dark', 'Dark'], ['light', 'Light']].map(([v, l]) => html`<button role="radio" aria-checked=${theme === v ? 'true' : 'false'}
              class=${`seg-btn ${theme === v ? 'is-on' : ''}`} onClick=${() => pickTheme(v)}><span class="seg-label">${l}</span></button>`)}
          </div></div>
        <div class="set-row"><span class="set-label">Terminal text</span>
          <div class="seg" role="radiogroup" aria-label="Terminal font size">
            ${[12, 13, 14, 15, 16].map((px) => html`<button role="radio" aria-checked=${font === px ? 'true' : 'false'}
              class=${`seg-btn ${font === px ? 'is-on' : ''}`} onClick=${() => pickFont(px)}><span class="seg-label">${px}</span></button>`)}
          </div></div>
        <div class="set-row"><span class="set-label" id="set-reader-label">Screen reader support<span class="set-sub">Lets VoiceOver and other screen readers read what the terminals print.</span></span>
          <label class="switch"><input type="checkbox" checked=${reader} onChange=${(e) => pickReader(e.currentTarget.checked)}
            aria-labelledby="set-reader-label" data-testid="set-screen-reader" /><span class="switch-ui" aria-hidden="true"></span></label></div>
      </section>
      <section class="card" aria-labelledby="set-ws">
        <h2 id="set-ws" class="card-title">Workspace</h2>
        <div class="set-row"><span class="set-label">Open panes<span class="set-sub">${open.length} open. Closing panes never stops a session.</span></span>
          <button class="btn btn-quiet" onClick=${() => { closeAllPanes(); toast('All panes closed. Sessions are still running.', { tone: 'ok' }); }} disabled=${!open.length}>Close all panes</button></div>
      </section>
      <section class="card" aria-labelledby="set-keys">
        <h2 id="set-keys" class="card-title">Keyboard</h2>
        <dl class="keys">
          <div><dt><kbd>${MOD}</kbd><kbd>K</kbd></dt><dd>Jump to a session or agent, or run a command</dd></div>
          <div><dt><kbd>${MOD}</kbd><kbd>\\</kbd></dt><dd>Collapse or expand the sidebar</dd></div>
          <div><dt><kbd>${ALT}</kbd><kbd>1</kbd>–<kbd>9</kbd></dt><dd>Focus pane 1 to 9</dd></div>
          <div><dt><kbd>Shift</kbd><kbd>↵</kbd></dt><dd>New line in Claude Code's prompt</dd></div>
          <div><dt>Double-click a title</dt><dd>Rename the session</dd></div>
        </dl>
      </section>
      <${NotifyCard} />
      <${MondayCard} />
      <${CtoCard} />
      <${DetailedTimelineCard} />
      <${AccountsCard} />
      <section class="card" aria-labelledby="set-server">
        <h2 id="set-server" class="card-title">Server <button class="link-btn" onClick=${refreshHealth}>Refresh</button></h2>
        ${health ? html`<dl class="facts">
          <div><dt>Clawdling</dt><dd class="mono">${health.version || 'unknown'}</dd></div>
          ${sessionsText ? html`<div><dt>Sessions</dt><dd class="mono" data-testid="server-sessions">${sessionsText}</dd></div>` : null}
          <div><dt>tmux</dt><dd class="mono">${tmuxText}</dd></div>
          <div><dt>claude CLI</dt><dd class="mono">${health.claude ? `${ok(health.claude) ? 'ok' : 'missing'}${health.claude.version ? ` · ${health.claude.version}` : ''}` : 'unknown'}</dd></div>
          <div><dt>Org folder</dt><dd class="mono">${health.home || 'unknown'}</dd></div>
          <div><dt>Command</dt><dd class="mono" data-testid="server-cli">${cliCmd('', health)}</dd></div>
        </dl>` : html`<p class="panel-quiet">The server did not report its health.</p>`}
        <p class="set-note">Clawdling only ever starts the official <code>claude</code> binary you are signed into. It never reads or forwards your credentials.</p>
      </section>
      <${SetupCard} />
    </div>
  </div>`;
}

const isLoopbackUrl = (u) => /^https?:\/\/(127\.|localhost[:/]|localhost$|\[::1\])/i.test(String(u || ''));

// "Use Clawdling on your phone". GET /api/pair -> {url, token, link, browser_link, lan, bind}.
// The phone's browser opens browser_link (the cockpit, signed in) from the QR at
// /api/pair/qr.svg?target=browser. The iPhone app pairs with `link` (/api/pair/qr.svg). The app is in
// public beta on TestFlight (not yet on the App Store), so its code stays folded behind a disclosure.
function PhoneCard() {
  const health = useStore((s) => s.health);
  const [pair, setPair] = useState(null);
  const [err, setErr] = useState('');
  const [reveal, setReveal] = useState(false);
  const [qrFailed, setQrFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api.pair().then((r) => { if (live) setPair(r || {}); })
      .catch((e) => { if (live) setErr(e.status === 404 ? 'unsupported' : e.message); });
    return () => { live = false; };
  }, []);

  const token = pair && pair.token ? String(pair.token) : '';
  const link = pair ? String(pair.browser_link || (pair.url && token ? `${pair.url}/?t=${token}` : '')) : '';
  // The link carries the cockpit token: keep it masked on screen until asked.
  const shown = reveal || !token ? link : link.split(token).join(`${'•'.repeat(8)}${token.slice(-4)}`);
  const reachable = !!pair && !!pair.url && !isLoopbackUrl(pair.url);
  // Listening on every interface, but this computer has no network address right now.
  const offline = !!pair && !reachable && /^(0\.0\.0\.0|::)$/.test(String(pair.bind || ''));
  const others = pair && Array.isArray(pair.lan) ? pair.lan.filter((u) => u !== pair.url) : [];
  const copy = async () => {
    const copied = await copyText(link);
    toast(copied ? 'Link copied. Anyone with it can drive your agents, so keep it private.' : link, { tone: copied ? 'ok' : 'info', ms: copied ? 3200 : 8000 });
  };

  return html`<section class="card phone-card" aria-labelledby="set-phone" data-testid="phone-card">
    <h2 id="set-phone" class="card-title">Use Clawdling on your phone</h2>
    ${err === 'unsupported' ? html`<p class="panel-quiet">This Clawdling server does not offer phone pairing yet. Update it, then reload this page.</p>`
      : err ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${14} /> Could not load the phone link: ${err}</p>`
      : !pair ? html`<div class="panel-skel" aria-label="Loading"></div>`
      : html`
        ${reachable ? html`<div class="phone-block" data-testid="pair-browser">
          <h3 class="card-h">Open it in your phone's browser</h3>
          <div class="phone-grid">
            <div class="qr-frame">
              ${qrFailed ? html`<p class="panel-quiet">QR code unavailable. Use the link instead.</p>`
                : html`<img class="qr" src="/api/pair/qr.svg?target=browser" width="168" height="168" alt="QR code that opens this cockpit in your phone's browser, signed in"
                  onError=${() => setQrFailed(true)} data-testid="pair-qr" />`}
            </div>
            <div class="phone-text">
              <p class="set-note phone-lead">Scan it with your phone's camera, on the same network as this computer. The cockpit opens in your phone's browser, already signed in. Your agents keep running here.</p>
              <div class="copy-line" data-testid="pair-link">
                <code title=${reveal ? link : 'Hidden. Use Show to see the full link.'}>${shown}</code>
                ${token ? html`<button class="link-btn" onClick=${() => setReveal(!reveal)} aria-pressed=${reveal ? 'true' : 'false'}>${reveal ? 'Hide' : 'Show'}</button>` : null}
                <button class="icon-btn icon-btn-sm" aria-label="Copy the phone link" title="Copy" onClick=${copy} data-testid="pair-copy"><${Icon} name="copy" size=${14} /></button>
              </div>
              <p class="set-note">The link carries your private token: anyone who has it can drive your agents.</p>
              ${others.length ? html`<p class="set-note">This computer also answers at ${others.map((a, i) => html`${i ? ', ' : ''}<span class="mono">${a}</span>`)}.</p>` : null}
            </div>
          </div>
        </div>`
        : offline ? html`<p class="phone-warn" role="note" data-testid="pair-warning"><${Icon} name="alert" size=${14} />
          <span>Your phone can't reach this cockpit yet: this computer has no network address right now. Connect it to Wi-Fi, then reload this page.</span></p>`
        : html`<p class="phone-warn" role="note" data-testid="pair-warning"><${Icon} name="alert" size=${14} />
          <span>Your phone can't reach this cockpit yet. To use it from your phone anywhere, turn on “Use from anywhere” above.
          Or, on the same Wi-Fi only, restart it with <code>${cliCmd('start --host 0.0.0.0', health)}</code> and reload this page.</span></p>`}
        <div class="phone-block phone-app" data-testid="pair-app">
          <h3 class="card-h">Clawdling iPhone app <span class="card-tag">public beta</span></h3>
          <p class="set-note phone-lead">The iPhone app is in public beta on TestFlight: install TestFlight, then open <a href="https://testflight.apple.com/join/2MHukWQG" target="_blank" rel="noopener">testflight.apple.com/join/2MHukWQG</a> on your iPhone. ${reachable ? "Then scan this code with the app." : "Once this cockpit is reachable from your phone, you'll pair it here."}</p>
          ${reachable ? html`<details class="app-qr">
            <summary>Show the app's pairing code</summary>
            <div class="qr-frame"><img class="qr" src="/api/pair/qr.svg" width="168" height="168" loading="lazy" alt="QR code that pairs the Clawdling iPhone app with this cockpit" data-testid="pair-app-qr" /></div>
          </details>` : null}
        </div>`}
  </section>`;
}

// Extra Claude logins. Clawdling never touches credentials: an added account is only a folder
// (~/.clawdling-accounts/<name>) passed to claude as CLAUDE_CONFIG_DIR, and the user signs in
// inside Claude Code itself. GET /api/accounts -> [{id, name, default, dir}].
// "Tell me when an agent needs me": this browser (a system notification while the tab is hidden)
// and, opt-in, one line to the Telegram or iMessage chat Donna is paired with.
function NotifyCard() {
  const [browser, setBrowser] = useState(() => notifyOn());
  const [denied, setDenied] = useState(() => notifySupported() && window.Notification.permission === 'denied');
  const [srv, setSrv] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.notify().then(setSrv).catch(() => setSrv({ needs_you: false, channel: null, error: true })); }, []);
  const pickBrowser = async (on) => {
    const byId = getState().agentsById || {};
    const st = await setNotify(on, Object.fromEntries(Object.entries(byId).map(([id, a]) => [id, (a && a.name) || id])));
    setBrowser(st === 'on');
    setDenied(st === 'denied');
    if (st === 'denied') toast('The browser blocked notifications for this page. Allow them in the site settings, then try again.', { ms: 5200 });
  };
  const pickServer = async (on) => {
    setBusy(true);
    try {
      const r = await api.setNotify(on);
      setSrv(r);
      setLabels(r && r.labels);
    } catch (e) {
      errorToast('Could not change that', e);
    }
    setBusy(false);
  };
  const [code, setCode] = useState(null);
  const getCode = async () => {
    try {
      const r = await api.telegram({ pair: true });
      setCode(r && r.pairing_code);
    } catch (e) {
      errorToast('Could not get a pairing code', e);
    }
  };
  const channel = srv && srv.channel === 'telegram' ? 'Telegram' : srv && srv.channel === 'imessage' ? 'iMessage' : null;
  return html`<section class="card" aria-labelledby="set-notify" data-testid="notify-card">
    <h2 id="set-notify" class="card-title">When an agent needs you</h2>
    <div class="set-row"><span class="set-label" id="set-notify-browser">Notify this browser<span class="set-sub">${!notifySupported() ? 'This browser cannot show notifications.'
      : denied ? 'Blocked by the browser. Allow notifications for this page in its site settings.' : 'A system notification when this tab is in the background and a session starts waiting on you.'}</span></span>
      <label class="switch"><input type="checkbox" checked=${browser} disabled=${!notifySupported()} onChange=${(e) => pickBrowser(e.currentTarget.checked)}
        aria-labelledby="set-notify-browser" data-testid="notify-browser" /><span class="switch-ui" aria-hidden="true"></span></label></div>
    <div class="set-row"><span class="set-label" id="set-notify-msg">Message me${channel ? ` on ${channel}` : ''}<span class="set-sub">${!srv ? 'Checking…'
      : srv.unprotected ? "Off here: this org folder's path has characters (like ( ) ' or accents) that keep Clawdling from locking agents out of its own settings."
      : channel ? `One line to the ${channel} chat Donna is paired with: which agent needs you, never what it asked. At most one per session every 10 minutes.`
      : srv.unprotected ? "Off here: this org folder's path has characters (like ( ) ' or accents) that keep Clawdling from locking agents out of its own settings."
      : srv.telegram_repair ? html`Pair your Telegram chat once more: Clawdling only messages the chat that sent it a pairing code, and this pairing is older than that record.
          ${code ? html` Send <strong class="mono" data-testid="notify-pair-code">/pair ${code}</strong> to your bot.` : html` <button type="button" class="link-btn" onClick=${getCode} data-testid="notify-pair">Get a pairing code</button>`}`
      : srv.imessage_unverified ? html`Save your handle on the <a href="#/donna">Donna page</a>, then text Donna once from it, so Clawdling knows that number or address is yours (a phone number needs its country code).`
      : html`Pair Donna with Telegram or iMessage first (<a href="#/donna">Donna</a>).`}</span></span>
      <label class="switch"><input type="checkbox" checked=${!!(srv && srv.needs_you)} disabled=${!srv || busy || (!(srv && srv.needs_you) && (!channel || srv.unprotected))} onChange=${(e) => pickServer(e.currentTarget.checked)}
        aria-labelledby="set-notify-msg" data-testid="notify-message" /><span class="switch-ui" aria-hidden="true"></span></label></div>
    ${srv && !srv.needs_you && channel && !srv.unprotected && srv.preview_labels ? html`<p class="set-note" data-testid="notify-preview">Turning this on approves these agent names for messages: ${Object.values(srv.preview_labels).join(', ') || 'none'}.</p>` : null}
    ${srv && srv.needs_you ? html`<p class="set-note" data-testid="notify-labels">Messages and notifications name these agents, as they were named when you turned this on: ${Object.values(srv.labels || {}).join(', ') || 'none'}. Others say "An agent". Turn it off and on to update the list.</p>` : null}
  </section>`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hourText = (h) => new Date(2026, 0, 5, h).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// The Monday report (1.5): off by default; the exact message is shown before it can be turned on.
function MondayCard() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.digest().then(setSt).catch(() => setSt({ enabled: false, error: true })); }, []);
  const change = async (body) => {
    setBusy(true);
    try {
      // Turning it on approves exactly the names this card showed.
      setSt(await api.setDigest(body.enabled === true ? { ...body, labels: (st && st.preview_labels) || {} } : body));
    } catch (e) {
      if (e.status === 409) { toast(e.message, { ms: 5200 }); api.digest().then(setSt).catch(() => {}); }
      else errorToast('Could not change the Monday report', e);
    }
    setBusy(false);
  };
  const channel = st && st.channel === 'telegram' ? 'Telegram' : st && st.channel === 'imessage' ? 'iMessage' : null;
  const canOn = !!(st && channel && !st.unprotected);
  return html`<section class="card" aria-labelledby="set-monday" data-testid="monday-card">
    <h2 id="set-monday" class="card-title">Monday report</h2>
    <div class="set-row"><span class="set-label" id="set-monday-on">Send me a weekly report${channel ? ` on ${channel}` : ''}<span class="set-sub">${!st ? 'Checking…'
      : st.error ? 'Could not load this setting.'
      : st.unprotected ? "Off here: this org folder's path has characters (like ( ) ' or accents) that keep Clawdling from locking agents out of its own settings."
      : channel ? `Once a week, to the ${channel} chat Donna is paired with: for each agent, how much got done, what needs you and its usage. Counts, agent names and dollar figures only: never a session title, a prompt or a file.`
      : html`Pair Donna with Telegram or iMessage first (<a href="#/donna">Donna</a>).`}</span></span>
      <label class="switch"><input type="checkbox" checked=${!!(st && st.enabled)} disabled=${!st || busy || (!(st && st.enabled) && !canOn)} onChange=${(e) => change({ enabled: e.currentTarget.checked })}
        aria-labelledby="set-monday-on" data-testid="monday-switch" /><span class="switch-ui" aria-hidden="true"></span></label></div>
    ${st && !st.error ? html`<div class="set-row"><span class="set-label" id="set-monday-when">When<span class="set-sub">${st.enabled && st.next_at ? `Next one: ${new Date(st.next_at).toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' })}. If Clawdling is not running then, it sends when it next starts that week.` : 'Your computer\'s local time.'}</span></span>
      <span class="monday-when">
        <select class="select" aria-label="Day" value=${String(st.day)} disabled=${busy} onChange=${(e) => change({ day: Number(e.currentTarget.value) })} data-testid="monday-day">
          ${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<option value=${String(d)}>${DAY_NAMES[d]}</option>`)}</select>
        <select class="select" aria-label="Hour" value=${String(st.hour)} disabled=${busy} onChange=${(e) => change({ hour: Number(e.currentTarget.value) })} data-testid="monday-hour">
          ${Array.from({ length: 24 }, (_, h) => html`<option value=${String(h)}>${hourText(h)}</option>`)}</select>
      </span></div>` : null}
    ${st && st.preview ? html`<p class="set-note">${st.enabled ? 'This is the message it would send right now:' : 'Before you turn it on, this is exactly the message it would send right now:'}</p>
      <pre class="monday-preview" data-testid="monday-preview">${st.preview}</pre>` : null}
    ${st && !st.enabled && canOn && st.preview_labels ? html`<p class="set-note">Turning it on approves these agent names for the report: ${Object.values(st.preview_labels).join(', ') || 'none'}. An agent added later is called "Another agent" until you turn it off and on.</p>` : null}
    ${st && st.last_sent_at ? html`<p class="set-note">Last sent ${new Date(st.last_sent_at).toLocaleString()}${st.last_error ? ` (it did not go through: ${st.last_error})` : ''}.</p>` : null}
  </section>`;
}

// The CTO seat (1.7): the weekly review (off by default; the estimate shown before it is on, a
// weekly cap), its line in the Monday report (its own opt-in, previewed), and the status thresholds.
const THRESHOLDS = [
  ['stalled_days', 'Stalled after', 'days with nothing finished and NOW.md untouched'],
  ['needs_hours', 'At risk when something waits on you for', 'hours'],
  ['checkup_drop', 'At risk when the check-up score falls by', 'points'],
  ['cost_rise_pct', 'At risk when usage rises by', '% week over week, with no more finished work'],
  ['cost_min_usd', '…counting only weeks over', 'dollars of usage'],
];

function CtoCard() {
  const health = useStore((s) => s.health);
  const [v, setV] = useState(null);
  const [est, setEst] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState('');
  const remote = !!(health && health.remote);
  useEffect(() => { api.cto().then((x) => { setV(x); setCap(String(x.schedule.weekly_cap_usd)); }).catch(() => setV({ error: true })); }, []);
  useEffect(() => {
    if (!v || !v.exists || v.schedule.enabled) return undefined;
    let live = true;
    api.ctoEstimate().then((x) => { if (live) setEst(x); }).catch(() => {});
    return () => { live = false; };
  }, [v && v.exists, v && v.schedule && v.schedule.enabled]);
  const change = async (body) => {
    setBusy(true);
    try {
      const x = await api.setCto(body);
      setV(x);
      setCap(String(x.schedule.weekly_cap_usd));
    } catch (e) {
      errorToast('Could not change the CTO settings', e);
    }
    setBusy(false);
  };
  const capN = Number(cap);
  const capOk = Number.isFinite(capN) && capN > 0 && capN <= 100;
  if (!v) return html`<section class="card" aria-labelledby="set-cto"><h2 id="set-cto" class="card-title">CTO</h2><p class="set-note">Checking…</p></section>`;
  if (v.error) return html`<section class="card" aria-labelledby="set-cto"><h2 id="set-cto" class="card-title">CTO</h2><p class="set-note">Could not load the CTO settings.</p></section>`;
  if (!v.exists) {
    return html`<section class="card" aria-labelledby="set-cto" data-testid="cto-card">
      <h2 id="set-cto" class="card-title">CTO</h2>
      <p class="set-note">A CTO reads every project's receipts each week and asks you up to three decisions. Add one from the <a href="#/map">org map</a> ("Add a CTO").</p>
    </section>`;
  }
  const sc = v.schedule;
  return html`<section class="card" aria-labelledby="set-cto" data-testid="cto-card">
    <h2 id="set-cto" class="card-title">CTO</h2>
    <div class="set-row"><span class="set-label" id="set-cto-on">Run the CTO review every ${DAY_NAMES[sc.day]} at ${hourText(sc.hour)}<span class="set-sub">${remote ? 'Turn this on or off at the computer Clawdling runs on.'
      : sc.enabled ? `Next one: ${sc.next_at ? new Date(sc.next_at).toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' }) : 'next week'}. At most once a week; if Clawdling is not running then, it runs when it next starts that week.`
      : est ? `Off. Turned on, it starts one Claude Code session a week on your plan, about ${est.low_usd.toFixed(2) === est.high_usd.toFixed(2) ? `$${est.high_usd.toFixed(2)}` : `$${est.low_usd.toFixed(2)} to $${est.high_usd.toFixed(2)}`} each time (list-price equivalent, not a bill), and skips a week that would go over your weekly cap.`
      : 'Off. Estimating what a weekly review costs…'}</span></span>
      <label class="switch"><input type="checkbox" checked=${!!sc.enabled} disabled=${busy || remote || (!sc.enabled && !capOk)} onChange=${(e) => change(e.currentTarget.checked ? { enabled: true, weekly_cap_usd: capN } : { enabled: false })}
        aria-labelledby="set-cto-on" data-testid="cto-schedule-switch" /><span class="switch-ui" aria-hidden="true"></span></label></div>
    <div class="set-row is-stacked"><span class="set-label" id="set-cto-when">When and how much<span class="set-sub">Your computer's local time. Before each run, what the CTO used this week plus the high end of the estimate must fit under the weekly cap.</span></span>
      <span class="monday-when cto-when">
        <select class="select" aria-label="Day" value=${String(sc.day)} disabled=${busy || remote} onChange=${(e) => change({ day: Number(e.currentTarget.value) })} data-testid="cto-day">
          ${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<option value=${String(d)}>${DAY_NAMES[d]}</option>`)}</select>
        <select class="select" aria-label="Hour" value=${String(sc.hour)} disabled=${busy || remote} onChange=${(e) => change({ hour: Number(e.currentTarget.value) })} data-testid="cto-hour">
          ${Array.from({ length: 24 }, (_, h) => html`<option value=${String(h)}>${hourText(h)}</option>`)}</select>
        <label class="cto-cap">Weekly cap $<input class="input" inputmode="decimal" value=${cap} disabled=${busy || remote} onInput=${(e) => setCap(e.currentTarget.value)}
          onBlur=${() => { if (capOk && capN !== sc.weekly_cap_usd) change({ weekly_cap_usd: capN }); }} aria-label="Weekly cap in dollars" data-testid="cto-cap" /></label>
      </span></div>
    ${sc.last_skip ? html`<p class="set-note tone-amber-text" data-testid="cto-card-skip">${sc.last_skip.why}</p>` : null}
    <p class="set-note">Used by the CTO this week: $${(sc.spent_this_week.usd || 0).toFixed(2)}${sc.spent_this_week.complete ? '' : ' (part unknown)'} (list-price equivalent).</p>
    <div class="set-row"><span class="set-label" id="set-cto-digest">Add the CTO's headline to the Monday report<span class="set-sub">Off by default. Only the headline line and how many decisions wait go to your paired chat, never the review. Links are removed.</span></span>
      <label class="switch"><input type="checkbox" checked=${!!v.headline_in_digest} disabled=${busy || remote} onChange=${(e) => change({ headline_in_digest: e.currentTarget.checked })}
        aria-labelledby="set-cto-digest" data-testid="cto-digest-switch" /><span class="switch-ui" aria-hidden="true"></span></label></div>
    ${v.headline_preview ? html`<p class="set-note">${v.headline_in_digest ? 'The Monday report adds this line now:' : 'Turned on, the Monday report would add exactly this line now:'}</p><pre class="monday-preview" data-testid="cto-digest-preview">${v.headline_preview}</pre>` : null}
    <details class="cto-thresholds">
      <summary>Status rules</summary>
      <p class="set-note">Clawdling computes each agent's status from receipts with fixed rules; you can tune the numbers.</p>
      ${THRESHOLDS.map(([k, label, unit]) => html`<label class="cto-th"><span>${label}</span>
        <input class="input" type="number" min="0" step="any" value=${String(v.thresholds[k])} disabled=${busy || remote} aria-label=${`${label} ${unit}`}
          onChange=${(e) => change({ thresholds: { [k]: Number(e.currentTarget.value) } })} data-testid=${`cto-th-${k}`} /><span class="rc-label">${unit}</span></label>`)}
    </details>
  </section>`;
}

// The detailed timeline (1.5, beta): Claude Code's own OpenTelemetry, kept on this computer.
function DetailedTimelineCard() {
  const health = useStore((s) => s.health);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.otel().then(setSt).catch(() => setSt({ enabled: false, error: true })); }, []);
  const remote = !!(health && health.remote);
  const pick = async (on) => {
    setBusy(true);
    try {
      setSt(await api.setOtel(on));
    } catch (e) {
      if (e.body && e.body.found) setSt((x) => ({ ...(x || {}), blocked: true, reason: e.message, found: e.body.found }));
      else errorToast('Could not change the detailed timeline', e);
    }
    setBusy(false);
  };
  return html`<section class="card" aria-labelledby="set-otel" data-testid="otel-card">
    <h2 id="set-otel" class="card-title">Detailed timeline <span class="card-tag">beta</span></h2>
    <div class="set-row"><span class="set-label" id="set-otel-on">Collect Claude Code's own telemetry<span class="set-sub">${!st ? 'Checking…'
      : st.error ? 'Could not load this setting.'
      : st.blocked ? `${st.reason}${st.enabled ? ' It is switched on, but no session gets it while this is so; switch it off to forget it.' : ''}`
      : remote ? 'Turn this on or off at the computer Clawdling runs on.'
      : 'The Timeline then also shows who approved each tool and how long each request to Claude took. It stays on this computer: Claude Code sends it to Clawdling on 127.0.0.1, never to anyone else, and never your prompts or file contents.'}</span></span>
      <label class="switch"><input type="checkbox" checked=${!!(st && st.enabled)} disabled=${!st || busy || remote || (st.blocked && !st.enabled)} onChange=${(e) => pick(e.currentTarget.checked)}
        aria-labelledby="set-otel-on" data-testid="otel-switch" /><span class="switch-ui" aria-hidden="true"></span></label></div>
    ${st && st.blocked && Array.isArray(st.found) && st.found.length ? html`<p class="set-note" data-testid="otel-found">Found: ${st.found.map((f) => `${f.key} (${f.where})`).join(', ')}. Clawdling read only these names, not their values. The report card works the same without it.</p>` : null}
    ${st && !st.blocked && !st.error ? html`<p class="set-note">${st.note} The report card works the same with it off.</p>` : null}
  </section>`;
}

function AccountsCard() {
  const [accounts, setAccounts] = useState(null);
  const [unsupported, setUnsupported] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const reload = () => api.accounts().then((r) => { setAccounts(r); setUnsupported(false); })
    .catch(() => setUnsupported(true));
  useEffect(() => { reload(); }, []);

  const cancel = () => { setAdding(false); setName(''); setErr(''); };
  const add = async () => {
    const n = name.trim();
    if (!n) { setErr('Give the account a name, like "work".'); return; }
    setBusy('add');
    setErr('');
    try {
      const a = await api.addAccount(n);
      cancel();
      await reload();
      toast(`Added ${(a && a.name) || n}. Sign in to it once to use it.`, { tone: 'ok' });
    } catch (e) {
      setErr(e && e.message ? e.message : 'Could not add the account.');
    } finally {
      setBusy('');
    }
  };
  const signIn = async (a) => {
    setBusy(a.id);
    try {
      const s = await api.signIn(a.id);
      if (s && s.sid) { mergeSession(s); focusSession(s.sid); }
      toast(`Sign in to ${a.name} in the new session: Claude Code walks you through it.`, { tone: 'ok', ms: 5200 });
    } catch (e) {
      errorToast(`Could not start the sign-in for ${a.name}`, e);
    } finally {
      setBusy('');
    }
  };

  return html`<section class="card accounts-card" aria-labelledby="set-accounts" data-testid="accounts-card">
    <h2 id="set-accounts" class="card-title">Accounts</h2>
    <p class="set-note acct-lead">Clawdling runs your own <code>claude</code>. To use another Claude plan, add an account: it gets its own folder, and you sign in to it once inside Claude Code.</p>
    ${unsupported ? null : !accounts ? html`<div class="panel-skel" aria-label="Loading"></div>` : html`
      <ul class="acct-list">
        ${accounts.map((a) => html`<li class="set-row acct-row" data-testid="account-row" data-account=${a.id} key=${a.id}>
          <span class="set-label acct-label">
            <span class="acct-name">${a.default ? 'Your Claude login' : a.name}${a.default ? html` <span class="card-tag">Default</span>` : null}</span>
            ${a.default ? html`<span class="set-sub">The login <code>claude</code> already uses on this computer.</span>`
              : a.dir ? html`<span class="set-sub mono acct-dir">${a.dir}</span>` : null}
          </span>
          ${a.default ? null : html`<button class="btn btn-quiet" data-testid="account-signin" disabled=${!!busy}
            onClick=${() => signIn(a)}>${busy === a.id ? 'Starting...' : 'Sign in'}</button>`}
        </li>`)}
      </ul>
      ${adding ? html`<form class="inline-form acct-form" onSubmit=${(e) => { e.preventDefault(); add(); }}
          onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } }}>
          <input type="text" value=${name} placeholder="work" maxLength="32" aria-label="Account name" autoFocus
            autocomplete="off" autocapitalize="off" spellcheck="false" data-testid="account-name"
            onInput=${(e) => { setName(e.currentTarget.value); if (err) setErr(''); }} />
          <button type="submit" class="btn btn-primary" disabled=${busy === 'add'} data-testid="account-add-submit">Add</button>
          <button type="button" class="btn btn-quiet" onClick=${cancel}>Cancel</button>
        </form>
        ${err ? html`<p class="form-error" role="alert" data-testid="account-error"><${Icon} name="alert" size=${14} /> ${err}</p>` : null}`
      : html`<button class="btn btn-quiet acct-add" data-testid="account-add" onClick=${() => setAdding(true)}>Add another Claude account</button>`}`}
  </section>`;
}
