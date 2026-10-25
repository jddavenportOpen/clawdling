// Shown when the server answers 401: this browser has no cockpit token yet. It is the first thing a
// stranger sees in a second browser or after clearing cookies, and a LaunchAgent prints no link
// anywhere, so it leads with the one command that opens the cockpit signed in, spelled the way
// THIS computer runs Clawdling (the server's /api/health `cli`, public on purpose).
// Through a remote address (Use from anywhere) there is no terminal to run it in: a device signs in
// with a one-time pairing link (/?pair=<code>) made in Settings on the computer.
import { html } from '../lib/html.js';
import { useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { api } from '../lib/api.js';
import { Mark, Icon } from './icons.js';
import { copyText, cliCmd } from '../lib/util.js';
import { load } from '../lib/prefs.js';
import { toast } from '../lib/actions.js';

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

/** Opened through a remote address (https, not this computer's own names)? */
export function isRemotePage(loc = location) {
  return loc.protocol === 'https:' && !LOCAL_HOST.test(loc.hostname);
}

export function pairCodeFrom(search = location.search) {
  const c = new URLSearchParams(search).get('pair');
  return c && /^[A-Za-z0-9_-]{32}$/.test(c) ? c : null;
}

export function AuthScreen({ onRetry }) {
  const health0 = useStore((s) => s.health);
  if ((health0 && health0.remote) || isRemotePage() || pairCodeFrom()) return html`<${RemoteAuth} onRetry=${onRetry} />`;
  return html`<${LocalAuth} onRetry=${onRetry} />`;
}

function RemoteAuth({ onRetry }) {
  const auth = useStore((s) => s.auth);
  const authError = useStore((s) => s.authError);
  const [code, setCode] = useState(pairCodeFrom());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const failed = auth === 'error' && !code;
  const pair = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.remotePair(code);
      history.replaceState(null, '', location.pathname + location.hash);
      setCode(null);
      onRetry();
    } catch (e) {
      setErr(e && e.message ? e.message : 'Could not sign in this device.');
      if (e && e.status === 401) {
        history.replaceState(null, '', location.pathname + location.hash);
        setCode(null);
      }
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="auth" data-testid="auth-screen">
    <div class="auth-card" role="main">
      <div class="auth-brand"><span class="auth-mark"><${Mark} size=${28} /></span><span class="auth-word">Clawdling</span></div>
      ${code ? html`
        <h1 class="auth-title">Sign in this device</h1>
        <p class="auth-text auth-lead" data-testid="auth-pair">This opens your cockpit on this device. The link works once.</p>
        <div class="auth-actions auth-actions-lead">
          <button class="btn btn-primary" onClick=${pair} disabled=${busy} data-testid="auth-pair-btn">${busy ? 'Signing in…' : 'Sign in this device'}</button>
        </div>`
      : failed ? html`
        <h1 class="auth-title">Can't reach your cockpit</h1>
        <p class="auth-text">${authError || 'The page loaded, but the cockpit did not answer.'}</p>
        <p class="auth-text" data-testid="auth-down">Use from anywhere may be turned off, or the computer it runs on may be asleep or offline.</p>`
      : html`
        <h1 class="auth-title">Sign in this device</h1>
        <p class="auth-text auth-lead" data-testid="auth-message">On the computer Clawdling runs on, open Settings, “Use from anywhere”, press “Add a device”, and scan the code with this device.</p>
        <p class="auth-text auth-small">Each code works once, for 10 minutes, and signs in only the device that uses it.</p>`}
      ${err ? html`<p class="form-error" role="alert" data-testid="auth-pair-error"><${Icon} name="alert" size=${14} /> ${err}</p>` : null}
      ${code ? null : html`<div class="auth-actions">
        <button class="btn btn-quiet" onClick=${onRetry} disabled=${auth === 'checking'}><${Icon} name="refresh" size=${14} /> ${auth === 'checking' ? 'Checking…' : 'Check again'}</button>
      </div>`}
    </div>
  </div>`;
}

function LocalAuth({ onRetry }) {
  const auth = useStore((s) => s.auth);
  const authError = useStore((s) => s.authError);
  const health = useStore((s) => s.health);
  // The server may be down: then the spelling it last reported to this browser.
  const known = health && health.cli ? health : { cli: load('cli', '') };
  const checking = auth === 'checking';
  const failed = auth === 'error';
  const openCmd = cliCmd('open', known);
  const copy = async (t) => {
    const copied = await copyText(t);
    toast(copied ? 'Copied. Paste it in a terminal on this computer.' : t, { tone: copied ? 'ok' : 'info', ms: copied ? 2200 : 8000 });
  };
  return html`<div class="auth" data-testid="auth-screen">
    <div class="auth-card" role="main">
      <div class="auth-brand"><span class="auth-mark"><${Mark} size=${28} /></span><span class="auth-word">Clawdling</span></div>
      ${failed ? html`
        <h1 class="auth-title">Can't reach the Clawdling server</h1>
        <p class="auth-text">${authError || 'The cockpit page loaded, but its API did not answer.'}</p>
        <p class="auth-text" data-testid="auth-down">Start it again in a terminal on this computer with <code>${cliCmd('start', known)}</code>
          (<code>${cliCmd('doctor', known)}</code> says what is wrong), then try again.</p>`
      : html`
        <h1 class="auth-title">Open the cockpit from your terminal</h1>
        <p class="auth-text auth-lead" data-testid="auth-message">Run this in a terminal on this computer. It opens the cockpit already signed in.</p>
        <div class="auth-cmds">
          <button class="auth-cmd" onClick=${() => copy(openCmd)} data-testid="auth-copy"><${Icon} name="terminal" size=${14} /><code data-testid="auth-command">${openCmd}</code><span class="auth-copy">Copy</span></button>
        </div>
        <p class="auth-text auth-small">The link carries a private token, so only you can drive your agents from this browser.</p>
        <p class="auth-text auth-small">On your phone? Open Settings in the cockpit on your computer: “Use from anywhere” pairs it from any network, “Use Clawdling on your phone” on the same Wi-Fi.</p>`}
      <div class="auth-actions">
        <button class="btn btn-quiet" onClick=${onRetry} disabled=${checking}><${Icon} name="refresh" size=${14} /> ${checking ? 'Checking…' : failed ? 'Try again' : 'I ran it, check again'}</button>
      </div>
    </div>
  </div>`;
}
