// First-run and "can't read the org" blocks, shared by the empty workspace, the phone's list view
// and the org map.
import { html } from '../lib/html.js';
import { useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon } from './icons.js';
import { startSession } from '../lib/actions.js';
import { tildify } from '../lib/util.js';
import { BLOCKED_TITLE, useStartBlocked } from './health-banner.js';

// Claude Code asks once per folder whether to trust it, and trusting a folder covers everything
// inside it. So trusting the ORG folder once, from a Scratch session (the only one that runs in
// the org root), means no agent inside the org asks again. The question itself is answered from
// the trust banner of the pane that opens.
export function FirstTrust() {
  const home = useStore((s) => tildify(s.health && s.health.home));
  const blocked = useStartBlocked();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await startSession('scratch', { title: 'Trust the org folder' });
    } catch { /* the toast already says why */ }
    setBusy(false);
  };
  return html`<section class="first-trust" aria-labelledby="ft-title" data-testid="first-trust">
    <div class="ft-text">
      <h3 id="ft-title" class="ft-title">First, trust your org folder</h3>
      <p class="ft-sub">Claude Code asks once per folder whether to trust it. Trust <code>${home || 'your org folder'}</code> now and no agent inside it will ask again.</p>
    </div>
    <button class="btn btn-primary ft-go" onClick=${go} disabled=${blocked || busy} title=${blocked ? BLOCKED_TITLE : undefined}
      data-testid="first-trust-go">${busy ? 'Starting…' : 'Trust my org folder'}</button>
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
