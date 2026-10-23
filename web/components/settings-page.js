// Settings (#/settings): appearance, workspace, shortcuts, and what the server reports.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { getThemePref, setThemePref } from '../lib/theme.js';
import { load, save } from '../lib/prefs.js';
import { terms } from '../lib/term.js';
import { closeAllPanes, toast } from '../lib/actions.js';
import { refreshHealth } from '../lib/live.js';
import { MOD, copyText } from '../lib/util.js';
import { api } from '../lib/api.js';
import { Icon } from './icons.js';

export function SettingsPage() {
  const health = useStore((s) => s.health);
  const open = useStore((s) => s.open);
  const [theme, setTheme] = useState(getThemePref());
  const [font, setFont] = useState(Number(load('termFontSize', 13)) || 13);

  const pickTheme = (t) => { setTheme(t); setThemePref(t); };
  const pickFont = (px) => {
    setFont(px);
    save('termFontSize', px);
    for (const v of terms.values()) v.setFontSize();
  };
  const ok = (x) => x && (x.ok === true || x.ok === 'true');
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
      <p class="page-sub">Stored in this browser. Your org itself lives in files on disk.</p></div></header>
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
          <div><dt><kbd>${MOD}</kbd><kbd>1</kbd>–<kbd>9</kbd></dt><dd>Focus pane 1 to 9</dd></div>
          <div><dt><kbd>Shift</kbd><kbd>↵</kbd></dt><dd>New line in Claude Code's prompt</dd></div>
          <div><dt>Double-click a title</dt><dd>Rename the session</dd></div>
        </dl>
      </section>
      <section class="card" aria-labelledby="set-server">
        <h2 id="set-server" class="card-title">Server <button class="link-btn" onClick=${refreshHealth}>Refresh</button></h2>
        ${health ? html`<dl class="facts">
          <div><dt>Clawdling</dt><dd class="mono">${health.version || 'unknown'}</dd></div>
          ${sessionsText ? html`<div><dt>Sessions</dt><dd class="mono" data-testid="server-sessions">${sessionsText}</dd></div>` : null}
          <div><dt>tmux</dt><dd class="mono">${tmuxText}</dd></div>
          <div><dt>claude CLI</dt><dd class="mono">${health.claude ? `${ok(health.claude) ? 'ok' : 'missing'}${health.claude.version ? ` · ${health.claude.version}` : ''}` : 'unknown'}</dd></div>
          <div><dt>Org folder</dt><dd class="mono">${health.home || 'unknown'}</dd></div>
        </dl>` : html`<p class="panel-quiet">The server did not report its health.</p>`}
        <p class="set-note">Clawdling only ever starts the official <code>claude</code> binary you are signed into. It never reads or forwards your credentials.</p>
      </section>
    </div>
  </div>`;
}

// "Connect your phone": the chat-only iPhone app pairs by scanning this QR.
// GET /api/pair -> {url, token, link, lan, bind}; GET /api/pair/qr.svg -> the QR.
function PhoneCard() {
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

  const link = pair && pair.link ? String(pair.link) : '';
  const token = pair && pair.token ? String(pair.token) : '';
  // The link carries the cockpit token: keep it masked on screen until asked.
  const shown = reveal || !token ? link : link.split(token).join(`${'•'.repeat(8)}${token.slice(-4)}`);
  const local = pair && /^(127\.0\.0\.1|localhost|::1)$/.test(String(pair.bind || ''));
  const copy = async () => {
    const ok = await copyText(link);
    toast(ok ? 'Pairing link copied. Anyone with it can drive your agents, so keep it private.' : link, { tone: ok ? 'ok' : 'info', ms: ok ? 3200 : 8000 });
  };

  return html`<section class="card phone-card" aria-labelledby="set-phone" data-testid="phone-card">
    <h2 id="set-phone" class="card-title">Connect your phone</h2>
    ${err === 'unsupported' ? html`<p class="panel-quiet">This Clawdling server does not offer phone pairing yet. Update it, then reload this page.</p>`
      : err ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${14} /> Could not load the pairing link: ${err}</p>`
      : !pair ? html`<div class="panel-skel" aria-label="Loading"></div>`
      : html`<div class="phone-grid">
        <div class="qr-frame">
          ${qrFailed ? html`<p class="panel-quiet">QR code unavailable. Use the link instead.</p>`
            : html`<img class="qr" src="/api/pair/qr.svg" width="168" height="168" alt="QR code that pairs the Clawdling iPhone app with this cockpit"
              onError=${() => setQrFailed(true)} data-testid="pair-qr" />`}
        </div>
        <div class="phone-text">
          <p class="set-note phone-lead">Open the Clawdling app on your iPhone and scan this code, or send yourself the link. You chat with your agents from the phone; they keep running here.</p>
          <div class="copy-line" data-testid="pair-link">
            <code title=${reveal ? link : 'Hidden. Use Show to see the full link.'}>${shown}</code>
            ${token ? html`<button class="link-btn" onClick=${() => setReveal(!reveal)} aria-pressed=${reveal ? 'true' : 'false'}>${reveal ? 'Hide' : 'Show'}</button>` : null}
            <button class="icon-btn icon-btn-sm" aria-label="Copy the pairing link" title="Copy" onClick=${copy} data-testid="pair-copy"><${Icon} name="copy" size=${14} /></button>
          </div>
          ${Array.isArray(pair.lan) && pair.lan.length ? html`<p class="set-note">This computer on your network: ${pair.lan.map((a, i) => html`${i ? ', ' : ''}<span class="mono">${a}</span>`)}</p>` : null}
          ${local ? html`<p class="phone-warn" role="note" data-testid="pair-warning"><${Icon} name="alert" size=${14} />
            <span>Your phone can't reach this cockpit yet: restart with <code>clawdling start --host 0.0.0.0</code> (same Wi-Fi) or use Tailscale.</span></p>` : null}
        </div>
      </div>`}
  </section>`;
}
