// ═══════════════════════════════════════════════════════════════════════════
// needsYouNotify.test.ts — firing rules for the "an agent needs you" alert.
//
// Locks the contract NeedsYouNotifier relies on: only NEWLY-waiting sessions
// fire, a steady wait doesn't re-fire, waiting→working→waiting fires again, and
// the click URL appends-to/focuses the deck without evicting it. (Iter 2)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  diffNewlyWaiting,
  buildNeedsYouUrl,
  notifyLabel,
  type WaitingSessionLite,
} from '../needsYouNotify';
import { PANE_SOFT_CAP } from '@/lib/cockpitCaps';

const sess = (over: Partial<WaitingSessionLite>): WaitingSessionLite => ({
  id: 's1',
  thread_id: 't1',
  activity: 'working',
  live: true,
  ...over,
});

describe('diffNewlyWaiting', () => {
  it('flags a session that transitions into waiting', () => {
    const { newly, next } = diffNewlyWaiting(new Set(), [
      sess({ id: 'a', activity: 'waiting' }),
      sess({ id: 'b', activity: 'working' }),
    ]);
    expect(newly.map((s) => s.id)).toEqual(['a']);
    expect([...next]).toEqual(['a']);
  });

  it('does NOT re-fire a session that was already waiting', () => {
    const { newly, next } = diffNewlyWaiting(new Set(['a']), [
      sess({ id: 'a', activity: 'waiting' }),
    ]);
    expect(newly).toHaveLength(0); // steady wait → silent
    expect([...next]).toEqual(['a']);
  });

  it('re-fires on waiting→working→waiting', () => {
    // working again clears it from the carried set...
    const step1 = diffNewlyWaiting(new Set(['a']), [sess({ id: 'a', activity: 'working' })]);
    expect(step1.newly).toHaveLength(0);
    expect([...step1.next]).toEqual([]);
    // ...so the next waiting is a genuinely new need.
    const step2 = diffNewlyWaiting(step1.next, [sess({ id: 'a', activity: 'waiting' })]);
    expect(step2.newly.map((s) => s.id)).toEqual(['a']);
  });

  it('ignores non-live, idle, and id-less rows', () => {
    const { newly } = diffNewlyWaiting(new Set(), [
      sess({ id: 'dead', activity: 'waiting', live: false }),
      sess({ id: 'idle', activity: 'idle' }),
      sess({ id: undefined, activity: 'waiting' }),
    ]);
    expect(newly).toHaveLength(0);
  });
});

describe('buildNeedsYouUrl', () => {
  it('opens a fresh deck when none exists', () => {
    expect(buildNeedsYouUrl('', 'a')).toBe('/chat?panes=a&focus=a');
  });

  it('appends to an existing deck and focuses the new pane (no eviction)', () => {
    expect(buildNeedsYouUrl('?panes=x,y', 'a')).toBe('/chat?panes=x%2Cy%2Ca&focus=a');
  });

  it('does not duplicate a pane already in the deck', () => {
    expect(buildNeedsYouUrl('?panes=x,a', 'a')).toBe('/chat?panes=x%2Ca&focus=a');
  });

  it('C5 no-cap: a 10-deep deck APPENDS (no eviction past the old 10-cap)', () => {
    // Under the old MAX_PANES=10 a "needs you" click on an 11th waiting agent
    // evicted the oldest pane. With C5 no-cap the deck is unbounded — clicking
    // the alert adds the 11th named pane and keeps all the others.
    const ten = Array.from({ length: 10 }, (_, i) => `p${i}`).join(',');
    const url = buildNeedsYouUrl(`?panes=${ten}`, 'new');
    const panes = new URLSearchParams(url.split('?')[1]).get('panes')!.split(',');
    expect(panes).toHaveLength(11);
    expect(panes[0]).toBe('p0'); // oldest survived — NOT bumped
    expect(panes[10]).toBe('new');
  });

  it('C5 no-cap: bumps the oldest only at the shared PANE_SOFT_CAP safety limit', () => {
    // The bump-oldest branch still exists as a defensive clamp — it fires only
    // at PANE_SOFT_CAP (the SAME constant openSidInDeck/openInGrid use), never
    // at an arbitrary 6 or 10. Build a deck AT the cap and confirm the next
    // click bumps exactly one (the oldest).
    const full = Array.from({ length: PANE_SOFT_CAP }, (_, i) => `p${i}`).join(',');
    const url = buildNeedsYouUrl(`?panes=${full}`, 'new');
    const panes = new URLSearchParams(url.split('?')[1]).get('panes')!.split(',');
    expect(panes).toHaveLength(PANE_SOFT_CAP);
    expect(panes[0]).toBe('p1'); // p0 bumped at the safety limit
    expect(panes[PANE_SOFT_CAP - 1]).toBe('new');
  });
});

describe('notifyLabel', () => {
  it('prefers title, then ai_title, then agent_name, then a default', () => {
    expect(notifyLabel({ title: 'T', ai_title: 'A', agent_name: 'N' })).toBe('T');
    expect(notifyLabel({ ai_title: 'A', agent_name: 'N' })).toBe('A');
    expect(notifyLabel({ agent_name: 'N' })).toBe('N');
    expect(notifyLabel({})).toBe('An agent');
  });
});
