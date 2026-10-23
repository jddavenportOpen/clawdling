// Shown when the server answers 401: this browser has no cockpit token yet. It is the first thing a
// stranger sees in a second browser or after clearing cookies, and a LaunchAgent prints no link
// anywhere, so it leads with the one command that opens the cockpit signed in, spelled the way
// THIS computer runs Clawdling (the server's /api/health `cli`, public on purpose).
import { html } from '../lib/html.js';
import { useStore } from '../lib/store.js';
import { Mark, Icon } from './icons.js';
import { copyText, cliCmd } from '../lib/util.js';
import { load } from '../lib/prefs.js';
import { toast } from '../lib/actions.js';

export function AuthScreen({ onRetry }) {
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
        <p class="auth-text auth-small">On your phone? Open Settings in the cockpit on your computer and scan the code under “Use Clawdling on your phone”.</p>`}
      <div class="auth-actions">
        <button class="btn btn-quiet" onClick=${onRetry} disabled=${checking}><${Icon} name="refresh" size=${14} /> ${checking ? 'Checking…' : failed ? 'Try again' : 'I ran it, check again'}</button>
      </div>
    </div>
  </div>`;
}
