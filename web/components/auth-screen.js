// Shown when the server answers 401: this browser has no cockpit token yet.
import { html } from '../lib/html.js';
import { useStore } from '../lib/store.js';
import { Mark, Icon } from './icons.js';
import { copyText } from '../lib/util.js';
import { toast } from '../lib/actions.js';

export function AuthScreen({ onRetry }) {
  const auth = useStore((s) => s.auth);
  const authError = useStore((s) => s.authError);
  const checking = auth === 'checking';
  const failed = auth === 'error';
  const copy = async (t) => toast((await copyText(t)) ? 'Copied' : t, { tone: 'ok', ms: 1600 });
  return html`<div class="auth" data-testid="auth-screen">
    <div class="auth-card" role="main">
      <div class="auth-brand"><span class="auth-mark"><${Mark} size=${28} /></span><span class="auth-word">Clawdling</span></div>
      ${failed ? html`
        <h1 class="auth-title">Can't reach the Clawdling server</h1>
        <p class="auth-text">${authError || 'The cockpit page loaded, but its API did not answer.'}</p>
        <p class="auth-text">Check that <code>clawdling start</code> is still running in your terminal, then try again.</p>`
      : html`
        <h1 class="auth-title">Open the cockpit from your terminal</h1>
        <p class="auth-text auth-lead" data-testid="auth-message">Open the link printed by <code>clawdling start</code> (or run <code>clawdling open</code>).</p>
        <p class="auth-text">That link carries a private token, so only you can drive your agents from this browser. It is exchanged for a cookie and removed from the address bar.</p>
        <div class="auth-cmds">
          <button class="auth-cmd" onClick=${() => copy('clawdling open')}><${Icon} name="terminal" size=${14} /><code>clawdling open</code><span class="auth-copy">Copy</span></button>
        </div>`}
      <div class="auth-actions">
        <button class="btn btn-quiet" onClick=${onRetry} disabled=${checking}><${Icon} name="refresh" size=${14} /> ${checking ? 'Checking…' : 'I opened the link, check again'}</button>
      </div>
    </div>
  </div>`;
}
