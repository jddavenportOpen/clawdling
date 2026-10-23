// Settings (#/settings): your phone, appearance, workspace, shortcuts, and what the server reports.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { getThemePref, setThemePref } from '../lib/theme.js';
import { load, save } from '../lib/prefs.js';
import { terms } from '../lib/term.js';
import { closeAllPanes, toast } from '../lib/actions.js';
import { refreshHealth } from '../lib/live.js';
import { MOD, ALT, copyText, cliCmd } from '../lib/util.js';
import { ok } from '../lib/model.js';
import { api } from '../lib/api.js';
import { Icon } from './icons.js';

export function SettingsPage() {
  const health = useStore((s) => s.health);
  const open = useStore((s) => s.open);
  const [theme, setTheme] = useState(getThemePref());
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

  return html`<div class="page settings-page" data-testid="settings-page">
    <header class="page-bar"><div class="page-bar-main"><h1 class="page-title">Settings</h1>
      <p class="page-sub">Appearance and workspace are stored in this browser. Your org itself lives in files on disk.</p></div></header>
    <div class="settings-grid">
      <${PhoneCard} />
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
      <section class="card" aria-labelledby="set-server">
        <h2 id="set-server" class="card-title">Server <button class="link-btn" onClick=${refreshHealth}>Refresh</button></h2>
        ${health ? html`<dl class="facts">
          <div><dt>Clawdling</dt><dd class="mono">${health.version || 'unknown'}</dd></div>
          <div><dt>tmux</dt><dd class="mono">${health.tmux ? `${ok(health.tmux) ? 'ok' : 'missing'}${health.tmux.version ? ` · ${health.tmux.version}` : ''}` : 'unknown'}</dd></div>
          <div><dt>claude CLI</dt><dd class="mono">${health.claude ? `${ok(health.claude) ? 'ok' : 'missing'}${health.claude.version ? ` · ${health.claude.version}` : ''}` : 'unknown'}</dd></div>
          <div><dt>Org folder</dt><dd class="mono">${health.home || 'unknown'}</dd></div>
          <div><dt>Command</dt><dd class="mono" data-testid="server-cli">${cliCmd('', health)}</dd></div>
        </dl>` : html`<p class="panel-quiet">The server did not report its health.</p>`}
        <p class="set-note">Clawdling only ever starts the official <code>claude</code> binary you are signed into. It never reads or forwards your credentials.</p>
      </section>
    </div>
  </div>`;
}

const isLoopbackUrl = (u) => /^https?:\/\/(127\.|localhost[:/]|localhost$|\[::1\])/i.test(String(u || ''));

// "Use Clawdling on your phone". GET /api/pair -> {url, token, link, browser_link, lan, bind}.
// The phone's browser opens browser_link (the cockpit, signed in) from the QR at
// /api/pair/qr.svg?target=browser. The iPhone app pairs with `link` (/api/pair/qr.svg), but it is
// still in App Store review, so it is labelled "coming soon" and its code stays folded away.
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
          <span>Your phone can't reach this cockpit yet. Restart it with <code>${cliCmd('start --host 0.0.0.0', health)}</code> to reach it on the same Wi-Fi,
          or with <code>--host</code> set to this computer's Tailscale address (<code>tailscale ip -4</code>) to reach it from anywhere on your tailnet. Then reload this page.</span></p>`}
        <div class="phone-block phone-app" data-testid="pair-app">
          <h3 class="card-h">Clawdling iPhone app <span class="card-tag">coming soon</span></h3>
          <p class="set-note phone-lead">The iPhone app is waiting on App Store review. ${reachable ? "Once it's out, scan this code with the app." : "Once it's out, you'll pair it here."}</p>
          ${reachable ? html`<details class="app-qr">
            <summary>Show the app's pairing code</summary>
            <div class="qr-frame"><img class="qr" src="/api/pair/qr.svg" width="168" height="168" loading="lazy" alt="QR code that pairs the Clawdling iPhone app with this cockpit" data-testid="pair-app-qr" /></div>
          </details>` : null}
        </div>`}
  </section>`;
}
