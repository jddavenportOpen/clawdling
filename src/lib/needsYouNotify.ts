// ═══════════════════════════════════════════════════════════════════════════
// needsYouNotify — pure helpers for the "an agent needs you" notification.
//
// The bridge already exposes a per-session `activity` (working | waiting | idle)
// via /api/sessions/list (the same feed ThreadSidebar's amber "Needs you" dot
// reads). "waiting" = the agent finished its turn and is blocked on JD. This
// module turns the polled list into (a) the set of NEWLY-waiting sessions since
// the last poll — what we fire a notification for — and (b) the deck URL a
// notification click should open. Kept pure + side-effect-free so the firing
// rules are unit-tested without a DOM. (chat-vision loop, Iter 2)
// ═══════════════════════════════════════════════════════════════════════════

import { PANE_SOFT_CAP } from './cockpitCaps';

export interface WaitingSessionLite {
  /** bridge session id (sid) — the pane key. */
  id?: string;
  thread_id?: string;
  activity?: string | null;
  live?: boolean;
  // Best-effort label sources (all optional; route may supply any/none).
  title?: string | null;
  ai_title?: string | null;
  agent_name?: string | null;
}

/** A human label for the notification body. */
export function notifyLabel(s: WaitingSessionLite): string {
  return (s.title || s.ai_title || s.agent_name || 'An agent') as string;
}

/**
 * Given the set of session ids that were waiting at the last poll and the
 * current session list, return the sessions that transitioned INTO `waiting`
 * this poll (live + activity==='waiting' + not already waiting) plus the next
 * waiting-set to carry forward. A session that STAYS waiting does not re-fire;
 * one that goes waiting→working→waiting fires again (a genuinely new need).
 */
export function diffNewlyWaiting(
  prevWaiting: Set<string>,
  sessions: WaitingSessionLite[]
): { newly: WaitingSessionLite[]; next: Set<string> } {
  const next = new Set<string>();
  const newly: WaitingSessionLite[] = [];
  for (const s of sessions) {
    if (s.live && s.activity === 'waiting' && s.id) {
      next.add(s.id);
      if (!prevWaiting.has(s.id)) newly.push(s);
    }
  }
  return { newly, next };
}

/**
 * Build the /chat deck URL a notification click should open: append the sid to
 * the current `?panes=` deck (dedup, bump-oldest only at the shared
 * PANE_SOFT_CAP safety limit) and focus it, so clicking the alert drops JD
 * straight into the agent that needs him without evicting the rest of his deck.
 * Mirrors ThreadSidebar.openSidInDeck — and, post C5 (2026-06-10), shares the
 * SAME unified cap constant so the deck is unbounded and a "needs you" click
 * never silently evicts a working agent.
 */
export function buildNeedsYouUrl(currentSearch: string, sid: string): string {
  const sp = new URLSearchParams(currentSearch);
  const current = (sp.get('panes') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let next: string[];
  if (current.length === 0) next = [sid];
  else if (current.includes(sid)) next = current;
  else if (current.length >= PANE_SOFT_CAP) next = [...current.slice(1), sid];
  else next = [...current, sid];
  sp.set('panes', next.join(','));
  sp.set('focus', sid);
  return `/chat?${sp.toString()}`;
}
