// ═══════════════════════════════════════════════════════════════════════════
// SessionHistoryPanel.test.tsx — reopen-dead-chat history view
// (feat/cockpit-naming-history, 2026-06-02).
//
// Pins the load-bearing behavior:
//   - renders past chats by their resolved label (title), newest-first as
//     ordered by the API.
//   - clicking a LIVE row reconnects (openSidInDeck with the SAME sid; NO
//     rehydrate POST — JD's rule: rail-click reconnects, never duplicate-spawns).
//   - clicking a PARKED row POSTs /rehydrate (r-cockpit C3 — the spine rehydrates
//     a live resumable session from the durable agent_runs, then the bridge
//     brings the PTY up) then opens the returned (possibly NEW) sid in the deck.
//   - a rehydratable parked row is badged (⟳) so JD knows the click re-enters a
//     LIVE session, not a read-only transcript.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SessionHistoryPanel, { type HistorySession } from '../SessionHistoryPanel';

function row(over: Partial<HistorySession>): HistorySession {
  return {
    sid: 'sid1',
    thread_id: 't1',
    cc_session_id: 'sid1',
    title: 'Refactor Auth Flow',
    label: 'Refactor Auth Flow',
    domain: null,
    project_slug: null,
    cwd: '/state/root',
    live: false,
    status: 'ended',
    last_activity: Date.now() / 1000 - 120,
    agent_name: 'CEO agent',
    ...over,
  };
}

const LIVE = row({ sid: 'live1', label: 'Live Chat', live: true, status: 'live' });
const PARKED = row({ sid: 'parked1', label: 'Parked Topic', live: false, rehydratable: true });

function mockFetch(history: HistorySession[], rehydrateSid = 'resumed-sid') {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes('/api/sessions/history')) {
      return {
        ok: true,
        json: async () => ({ sessions: history }),
      } as unknown as Response;
    }
    if (url.includes('/rehydrate')) {
      return {
        ok: true,
        json: async () => ({ session_id: rehydrateSid, rehydrated: true }),
      } as unknown as Response;
    }
    return { ok: false, json: async () => ({}) } as unknown as Response;
  });
}

describe('SessionHistoryPanel', () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders past chats by their label and expands to show rows', async () => {
    fetchSpy = mockFetch([LIVE, PARKED]);
    vi.stubGlobal('fetch', fetchSpy);
    const openSidInDeck = vi.fn();
    render(<SessionHistoryPanel openSidInDeck={openSidInDeck} />);

    // Header shows the count once loaded.
    await waitFor(() => expect(screen.getByTestId('rail-history')).toBeTruthy());
    fireEvent.click(screen.getByTestId('rail-history-toggle'));
    expect(screen.getByText('Live Chat')).toBeTruthy();
    expect(screen.getByText('Parked Topic')).toBeTruthy();
  });

  it('clicking a LIVE row reconnects without a revive POST', async () => {
    fetchSpy = mockFetch([LIVE]);
    vi.stubGlobal('fetch', fetchSpy);
    const openSidInDeck = vi.fn();
    render(<SessionHistoryPanel openSidInDeck={openSidInDeck} />);

    await waitFor(() => expect(screen.getByTestId('rail-history')).toBeTruthy());
    fireEvent.click(screen.getByTestId('rail-history-toggle'));
    fireEvent.click(screen.getByText('Live Chat'));

    await waitFor(() => expect(openSidInDeck).toHaveBeenCalledWith('live1'));
    // No dive-in POST was made — the only fetches are history loads.
    const diveInCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/rehydrate')
    );
    expect(diveInCalls).toHaveLength(0);
  });

  it('clicking a PARKED row REHYDRATES then opens the returned sid', async () => {
    fetchSpy = mockFetch([PARKED], 'new-resumed-sid');
    vi.stubGlobal('fetch', fetchSpy);
    const openSidInDeck = vi.fn();
    render(<SessionHistoryPanel openSidInDeck={openSidInDeck} />);

    await waitFor(() => expect(screen.getByTestId('rail-history')).toBeTruthy());
    fireEvent.click(screen.getByTestId('rail-history-toggle'));
    fireEvent.click(screen.getByText('Parked Topic'));

    await waitFor(() =>
      expect(openSidInDeck).toHaveBeenCalledWith('new-resumed-sid')
    );
    // The dive-in goes through /rehydrate (C3 durable resume), NOT the old
    // bridge-only /revive.
    const rehydrateCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/api/sessions/parked1/rehydrate')
    );
    expect(rehydrateCalls.length).toBeGreaterThanOrEqual(1);
    const reviveCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).match(/\/api\/sessions\/parked1\/revive$/)
    );
    expect(reviveCalls).toHaveLength(0);
  });

  it('badges a rehydratable parked row so dive-in reads as a LIVE re-entry', async () => {
    fetchSpy = mockFetch([PARKED]);
    vi.stubGlobal('fetch', fetchSpy);
    render(<SessionHistoryPanel openSidInDeck={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('rail-history')).toBeTruthy());
    fireEvent.click(screen.getByTestId('rail-history-toggle'));
    // The ⟳ badge marks the row as rehydratable (durable resumable session).
    expect(screen.getByTestId('rail-history-rehydrate-badge')).toBeTruthy();
    const r = screen.getByTestId('rail-history-row');
    expect(r.getAttribute('data-rehydratable')).toBe('true');
  });

  it('a NON-rehydratable parked row shows no badge but still dives in (bridge fallback)', async () => {
    const legacy = row({ sid: 'legacy1', label: 'Legacy Topic', live: false, rehydratable: false });
    fetchSpy = mockFetch([legacy], 'legacy-resumed');
    vi.stubGlobal('fetch', fetchSpy);
    const openSidInDeck = vi.fn();
    render(<SessionHistoryPanel openSidInDeck={openSidInDeck} />);

    await waitFor(() => expect(screen.getByTestId('rail-history')).toBeTruthy());
    fireEvent.click(screen.getByTestId('rail-history-toggle'));
    expect(screen.queryByTestId('rail-history-rehydrate-badge')).toBeNull();
    // Still dives in via /rehydrate (which soft-degrades to the bridge revive).
    fireEvent.click(screen.getByText('Legacy Topic'));
    await waitFor(() => expect(openSidInDeck).toHaveBeenCalledWith('legacy-resumed'));
  });

  it('renders nothing when there is no history', async () => {
    fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = render(
      <SessionHistoryPanel openSidInDeck={vi.fn()} />
    );
    await waitFor(() => {
      // history fetch fired
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-testid="rail-history"]')).toBeNull();
  });
});
