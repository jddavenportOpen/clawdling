// Claim receipts (1.6): when an agent says "done" or "tests pass", a badge under its message says
// what the record shows: Verified (a check passed after the last edit), Not verified (no check ran
// after it: the default, not an accusation), Contradicted (a check after it failed) or No changes
// made. Every badge opens its evidence; a Contradicted one can ask the agent to fix it, with the
// exact message shown before anything is sent.
import { html } from '../lib/html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { toast, errorToast } from '../lib/actions.js';
import { Modal } from './dialogs.js';
import { Icon } from './icons.js';

export const LABEL = {
  verified: { text: 'Verified', icon: 'check', tone: 'ok' },
  contradicted: { text: 'Contradicted', icon: 'alert', tone: 'bad' },
  not_verified: { text: 'Not verified', icon: 'dot', tone: 'quiet' },
  no_changes: { text: 'No changes made', icon: 'dot', tone: 'quiet' },
};

const time = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
};

/** The plain sentence under a label: what the record shows. */
export function evidenceText(c) {
  if (!c) return '';
  const k = c.check;
  if (c.label === 'verified') return `\`${k.cmd}\` passed at ${time(k.at)}, after the last edit${k.ship ? ' (ship check)' : ''}.`;
  if (c.label === 'contradicted') return `\`${k.cmd}\` failed at ${time(k.at)}${k.first_error_line ? `: ${k.first_error_line}` : '.'}`;
  if (c.label === 'no_changes') return 'This session changed no file, so there was nothing to check.';
  return c.kind === 'tests' ? `No ${c.needs && c.needs.length ? c.needs.join(' or ') : 'test'} check ran after the last edit.` : 'No check ran after the last edit.';
}

/** A small label pill (report card rows, map), with the evidence in its title. */
export function ClaimPill({ claim, compact = false }) {
  if (!claim) return null;
  const l = LABEL[claim.label] || LABEL.not_verified;
  return html`<span class=${`claim-pill tone-${l.tone}`} data-claim=${claim.label} title=${evidenceText(claim)}><${Icon} name=${l.icon} size=${11} />${compact ? null : ' '}${compact ? html`<span class="sr-only">${l.text}</span>` : l.text}</span>`;
}

/** The claims of one session, re-read when its transcript grows (a moment after). */
export function useClaims(sid, version, enabled = true) {
  const [claims, setClaims] = useState([]);
  const timer = useRef(0);
  useEffect(() => {
    if (!enabled || !sid) return undefined;
    let live = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.sessionClaims(sid).then((r) => { if (live) setClaims(Array.isArray(r?.claims) ? r.claims : []); }).catch(() => {});
    }, version ? 400 : 0);
    return () => { live = false; clearTimeout(timer.current); };
  }, [sid, version, enabled]);
  return [claims, () => api.sessionClaims(sid).then((r) => setClaims(Array.isArray(r?.claims) ? r.claims : [])).catch(() => {})];
}

/** The claim made by a message, matched by when it was said. */
export function claimFor(claims, m) {
  if (!m || m.role !== 'assistant' || !m.ts || !claims.length) return null;
  const t = Date.parse(m.ts);
  return claims.find((c) => Math.abs(Date.parse(c.at) - t) < 1000) || null;
}

/** The badge under a message in the chat view. */
export function ClaimBadge({ claim, sid, onSent }) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const l = LABEL[claim.label] || LABEL.not_verified;
  return html`<div class=${`claim-badge tone-${l.tone}`} data-testid="claim-badge" data-claim=${claim.label}>
    <button type="button" class="claim-head" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen((x) => !x)}>
      <${Icon} name=${l.icon} size=${13} /><span class="claim-label">${l.text}</span>
      <span class="claim-why">${evidenceText(claim)}</span>
      <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} size=${12} />
    </button>
    ${open ? html`<div class="claim-detail" data-testid="claim-detail">
      <p>The agent said <q>${claim.phrase || 'done'}</q>. ${claim.label === 'not_verified' ? 'That is not an accusation: nothing in the session checked it after the last change. ' : ''}Clawdling read this from the session's own record; no model judged it.</p>
      ${claim.check ? html`<dl class="claim-dl">
        <dt>Check</dt><dd class="mono">${claim.check.cmd}</dd>
        <dt>When</dt><dd>${new Date(claim.check.at).toLocaleString()}${claim.check.ship ? ' (the ship check)' : ''}</dd>
        <dt>Result</dt><dd>${claim.check.ok ? 'Passed' : 'Failed'}</dd>
        ${claim.check.first_error_line ? html`<dt>First error</dt><dd class="mono">${claim.check.first_error_line}</dd>` : null}
      </dl>` : null}
      ${claim.label === 'not_verified' ? html`<p class="claim-hint">To get a receipt, ask the agent to run the tests, or run the ship check from the agent's Check-up tab.</p>` : null}
    </div>` : null}
    ${claim.fix ? html`<button type="button" class="btn btn-quiet btn-sm claim-fix" onClick=${() => setAsking(true)} data-testid="claim-fix">Ask the agent to fix it</button>` : null}
    ${asking ? html`<${FixDialog} sid=${sid} text=${claim.fix} onClose=${() => setAsking(false)} onSent=${onSent} />` : null}
  </div>`;
}

/** Shows the exact message, then sends it (the server checks it is still the right one). */
export function FixDialog({ sid, text, onClose, onSent, ended = false }) {
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.sendFix(sid, text);
      toast('Sent to the agent', { tone: 'ok', ms: 2200 });
      onClose();
      if (onSent) onSent();
    } catch (e) {
      setBusy(false);
      errorToast('Could not send it', e);
    }
  };
  return html`<${Modal} labelledby="fix-title" onClose=${onClose} size="sm" class="confirm">
    <div class="modal-body">
      <h2 id="fix-title" class="modal-title">Ask the agent to fix it</h2>
      <p class="modal-text">${ended ? 'This session has ended. Clawdling resumes it, then sends' : 'Clawdling sends'} exactly this message into the session:</p>
      <blockquote class="fix-quote" data-testid="fix-text">${text}</blockquote>
    </div>
    <div class="modal-foot">
      <button class="btn btn-quiet" onClick=${onClose} data-autofocus>Cancel</button>
      <button class="btn btn-primary" onClick=${send} disabled=${busy} data-testid="fix-send">${busy ? 'Sending…' : 'Send it'}</button>
    </div>
  </${Modal}>`;
}
