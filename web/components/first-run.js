// First-run and "can't read the org" blocks, shared by the empty workspace, the phone's list view
// and the org map.
import { html } from '../lib/html.js';
import { useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon } from './icons.js';
import { startSession, focusSession, answerDialog, toast } from '../lib/actions.js';
import { dialogAnswers } from '../lib/dialogs.js';
import { tildify } from '../lib/util.js';
import { BLOCKED_TITLE, useStartBlocked } from './health-banner.js';

/**
 * Should the "First, trust your org folder" card show, and is a trust question for the org folder
 * waiting right now? It stays until the server says the org folder is trusted (a reload no longer
 * hides it). A server that does not say (older than 1.1.1) shows it only before the first session.
 */
export function useTrustStep() {
  const sessionsLoaded = useStore((s) => s.sessionsLoaded);
  const orgError = useStore((s) => s.orgError);
  const orgTrusted = useStore((s) => s.orgTrusted);
  const home = useStore((s) => s.health && s.health.home);
  const sessions = useStore((s) => s.sessions);
  const list = Object.values(sessions);
  const show = !!sessionsLoaded && !orgError && (orgTrusted === null || orgTrusted === undefined ? list.length === 0 : !orgTrusted);
  const pending = show && home ? list.find((s) => s.cwd === home && !s.account && s.status === 'needs_you' && s.waiting_on === 'trust') || null : null;
  return { show, pending };
}

// Claude Code asks once per folder whether to trust it, and trusting a folder covers everything
// inside it. So trusting the ORG folder once, from a Scratch session (the only one that runs in
// the org root), means no agent inside the org asks again. The question itself is answered from
// the trust banner of the pane that opens, or right here once it is waiting.
export function FirstTrust() {
  const home = useStore((s) => tildify(s.health && s.health.home));
  const blocked = useStartBlocked();
  const { pending } = useTrustStep();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await startSession('scratch', { title: 'Trust the org folder' });
    } catch { /* the toast already says why */ }
    setBusy(false);
  };
  if (pending) return html`<${TrustWaiting} s=${pending} home=${home} />`;
  return html`<section class="first-trust" aria-labelledby="ft-title" data-testid="first-trust">
    <div class="ft-text">
      <h3 id="ft-title" class="ft-title">First, trust your org folder</h3>
      <p class="ft-sub">Claude Code asks once per folder whether to trust it. Trust ${home ? html`<code>${home}</code>` : 'your org folder'} now and no agent inside it will ask again.</p>
    </div>
    <button class="btn btn-primary ft-go" onClick=${go} disabled=${blocked || busy} title=${blocked ? BLOCKED_TITLE : undefined}
      data-testid="first-trust-go">${busy ? 'Starting…' : 'Trust my org folder'}</button>
  </section>`;
}

// The trust question is already on screen in a session (say, the page was reloaded before it was
// answered): answer it here, or jump to it. Until it is answered, every agent would ask again.
function TrustWaiting({ s, home }) {
  const opts = dialogAnswers(s.choices);
  const [busy, setBusy] = useState(false);
  const yes = async () => {
    setBusy(true);
    const answered = await answerDialog(s.sid, opts.yes);
    setBusy(false);
    if (answered) toast(`Trusted ${home || 'your org folder'}. Sessions in it won't ask again.`, { tone: 'ok', ms: 4200 });
  };
  return html`<section class="first-trust" aria-labelledby="ft-title" data-testid="first-trust" data-pending=${s.sid}>
    <div class="ft-text">
      <h3 id="ft-title" class="ft-title">Claude Code is waiting: do you trust your org folder?</h3>
      <p class="ft-sub">Answer once and no agent inside ${home ? html`<code>${home}</code>` : 'your org folder'} will ask again.</p>
    </div>
    <span class="ft-actions">
      <button class="btn btn-quiet" onClick=${() => focusSession(s.sid)} data-testid="first-trust-show">Show the question</button>
      ${opts ? html`<button class="btn btn-primary ft-go" onClick=${yes} disabled=${busy} data-testid="first-trust-yes">${busy ? 'Answering…' : 'Yes, trust it'}</button>` : null}
    </span>
  </section>`;
}

// A failed read of the org is not an empty org: say so instead of "it's just you and Donna".
export function OrgError() {
  const error = useStore((s) => s.orgError);
  const home = useStore((s) => tildify(s.health && s.health.home)) || '~/clawdling';
  if (!error) return null;
  return html`<div class="org-error" role="alert" data-testid="org-error">
    <${Icon} name="alert" size=${16} />
    <p>Couldn't read your org: ${error}. Check that <code>${home}/org.json</code> exists and is valid JSON, then reload this page.</p>
  </div>`;
}
