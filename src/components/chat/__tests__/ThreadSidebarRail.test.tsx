// ═══════════════════════════════════════════════════════════════════════════
// ThreadSidebarRail.test.tsx — W6 persistent-domain-chats RAIL render contract.
//
// JD's locked model (2026-05-31): the chat rail shows exactly the 8 FIXED
// domain chats (always, persistent) + a Spawned section with ONLY ad-hoc CEO +
// project agents. Everything else (legacy specialist chats, old ad-hoc threads,
// domain-scoped thread rows) is ARCHIVED — hidden but recoverable. The ONLY
// spawn affordances are "+ CEO agent" and "+ Project agent". Domains are NOT
// spawnable (no generic/domain spawn picker).
//
// These render assertions FAIL on the old rail (which rendered Pinned/Spaces/
// Project Chats/Other Chats + a single unified "+ New session" picker offering
// Domains/Specialists/Launch-all) and PASS on the new one.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DOMAINS } from '@/config/domains';
import type { DbChatThread } from '@/lib/supabase';

// ── Mocks ──────────────────────────────────────────────────────────────────
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));
vi.mock('@/lib/useActiveThreads', () => ({
  useActiveThreads: () => new Set<string>(),
}));
vi.mock('@/lib/usePins', () => ({
  usePinnedIds: () => new Set<string>(),
  useIsPinned: () => false,
  togglePin: vi.fn(),
}));

// SWR is keyed by URL. /api/threads/meta → per-thread meta (cwd + session_id);
// /api/sessions/list → bridge liveness + persistent/domain. We return fixed
// data per key so the rail composition is deterministic.
const META_BY_KEY: Record<string, unknown> = {};
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (!key) return { data: undefined };
    if (key.startsWith('/api/threads/meta')) return { data: META_BY_KEY.meta };
    if (key === '/api/sessions/list') return { data: META_BY_KEY.list };
    return { data: undefined };
  },
}));

import ThreadSidebar from '../ThreadSidebar';

function thread(p: Partial<DbChatThread>): DbChatThread {
  return {
    id: p.id ?? 't',
    user_id: 'u',
    title: p.title ?? 'T',
    kind: (p.kind ?? 'project-session') as DbChatThread['kind'],
    ref_id: p.ref_id ?? null,
    created_at: '2026-05-31T00:00:00Z',
    last_message_at: p.last_message_at ?? '2026-05-31T00:00:00Z',
    archived_at: null,
    system_prompt: null,
    project_slug: p.project_slug ?? null,
  };
}

describe('ThreadSidebar rail — W6 persistent-domain-chats model', () => {
  beforeEach(() => {
    pushMock.mockReset();
    META_BY_KEY.meta = { threads: [] };
    META_BY_KEY.list = { sessions: [] };
  });

  it('renders exactly the FIXED domain chats even with no sessions', () => {
    render(<ThreadSidebar threads={[]} activeThreadId={null} />);
    const domainRows = DOMAINS.map((d) => screen.getByTestId(`rail-domain-${d.id}`));
    expect(domainRows).toHaveLength(DOMAINS.length);
    // Every domain id is present and labelled.
    for (const d of DOMAINS) {
      expect(screen.getByTestId(`rail-domain-${d.id}`)).toBeTruthy();
    }
  });

  it('the ONLY spawn affordances are CEO agent + Project agent', () => {
    render(<ThreadSidebar threads={[]} activeThreadId={null} />);
    expect(screen.getByTestId('spawn-ceo-agent')).toBeTruthy();
    expect(screen.getByTestId('spawn-project-agent')).toBeTruthy();
    // The old unified "+ New session" entry point is gone.
    expect(screen.queryByLabelText('New session')).toBeNull();
  });

  it('does NOT offer a generic/domain spawn picker (domains are not spawnable)', () => {
    render(<ThreadSidebar threads={[]} activeThreadId={null} />);
    // The picker is closed by default and its domain rows never render.
    expect(screen.queryByTestId('picker-row-domain-work')).toBeNull();
    expect(screen.queryByTestId('picker-row-launch-all')).toBeNull();
    expect(screen.queryByTestId('picker-row-adhoc')).toBeNull();
  });

  it('Spawned section shows ONLY *live* ceo + project agents; archives the rest', () => {
    // RAIL-PURGE (2026-06-01): ceo-thr is LIVE, proj-thr is DEAD (exited).
    // The default rail must show ONLY the live one in SPAWNED — the dead one
    // is hidden (recoverable behind the ENDED chip), not piled into the
    // default view (JD's "junk drawer of ~71 dead sessions" complaint).
    const threads = [
      thread({ id: 'ceo-thr', kind: 'ad-hoc', last_message_at: '2026-05-31T03:00:00Z' }),
      thread({ id: 'proj-thr', kind: 'project-session', project_slug: 'cockpit-v4', last_message_at: '2026-05-31T02:00:00Z' }),
      thread({ id: 'dom-thr', kind: 'project-session', last_message_at: '2026-05-31T01:00:00Z' }),
      thread({ id: 'legacy-agent', kind: 'agent', title: 'Researcher chat' }),
      thread({ id: 'old-adhoc', kind: 'ad-hoc', title: 'random old chat' }),
    ];
    META_BY_KEY.meta = {
      threads: [
        { id: 'ceo-thr', cwd: '/state/root', session_id: 's-ceo', session_status: 'live', agent_name: 'Ad-hoc CEO', title: 'T', kind: 'ad-hoc', ref_id: null, project_slug: null, exited_at: null, exit_code: null },
        { id: 'proj-thr', cwd: '/opt/adjutant/data/projects/demo', session_id: 's-proj', session_status: 'exited', agent_name: 'cockpit-v4', title: 'T', kind: 'project-session', ref_id: null, project_slug: 'cockpit-v4', exited_at: null, exit_code: 0 },
        { id: 'dom-thr', cwd: '/state/domains/work', session_id: 's-dom', session_status: 'exited', agent_name: 'Work', title: 'T', kind: 'project-session', ref_id: null, project_slug: null, exited_at: null, exit_code: 0 },
        { id: 'legacy-agent', cwd: null, session_id: null, session_status: null, agent_name: null, title: 'T', kind: 'agent', ref_id: 'researcher', project_slug: null, exited_at: null, exit_code: null },
        { id: 'old-adhoc', cwd: null, session_id: null, session_status: null, agent_name: null, title: 'T', kind: 'ad-hoc', ref_id: null, project_slug: null, exited_at: null, exit_code: null },
      ],
    };
    // ceo-thr is the only one the bridge reports LIVE.
    META_BY_KEY.list = {
      sessions: [
        { id: 's-ceo', thread_id: 'ceo-thr', activity: null, live: true, persistent: false, domain: null },
      ],
    };
    render(<ThreadSidebar threads={threads} activeThreadId={null} />);

    const spawned = screen.getByTestId('rail-spawned');
    expect(spawned.textContent).toMatch(/Spawned/);
    // The LIVE ceo agent is present in Spawned.
    expect(spawned.textContent).toContain('Ad-hoc CEO');
    // The DEAD project agent is NOT in the default Spawned view (hidden, junk-
    // drawer fix). It is recoverable behind the ENDED filter.
    expect(spawned.textContent).not.toContain('cockpit-v4');
    // The domain-scoped row is NOT a standalone Spawned row (folded into the
    // fixed Work domain entry instead).
    expect(spawned.textContent).not.toContain('Work');
    // Legacy specialist + old ad-hoc are ARCHIVED (hidden) — not rendered.
    expect(screen.queryByText('Researcher chat')).toBeNull();
    expect(screen.queryByText('random old chat')).toBeNull();
    // …but they're counted as archived (recoverable, not deleted).
    expect(screen.getByTestId('rail-archived-note').textContent).toMatch(/2 archived/);
  });

  it('RAIL-PURGE: dead spawned sessions are HIDDEN by default, surfaced under the ENDED chip', () => {
    // Two DEAD spawned agents + a junk legacy thread. Bridge reports NOTHING
    // live. Default rail: SPAWNED is absent (no live spawned agents). Click
    // ENDED → both dead spawned agents appear in the Ended section.
    const threads = [
      thread({ id: 'dead-ceo', kind: 'ad-hoc', last_message_at: '2026-05-30T03:00:00Z' }),
      thread({ id: 'dead-proj', kind: 'project-session', project_slug: 'cockpit-v4', last_message_at: '2026-05-30T02:00:00Z' }),
    ];
    META_BY_KEY.meta = {
      threads: [
        { id: 'dead-ceo', cwd: '/state/root', session_id: 's-dceo', session_status: 'exited', agent_name: 'Dead CEO', title: 'T', kind: 'ad-hoc', ref_id: null, project_slug: null, exited_at: '2026-05-30T03:30:00Z', exit_code: 0 },
        { id: 'dead-proj', cwd: '/opt/adjutant/data/projects/demo', session_id: 's-dproj', session_status: 'exited', agent_name: 'Dead Project', title: 'T', kind: 'project-session', ref_id: null, project_slug: 'cockpit-v4', exited_at: '2026-05-30T02:30:00Z', exit_code: 0 },
      ],
    };
    META_BY_KEY.list = { sessions: [] }; // bridge: nothing live
    render(<ThreadSidebar threads={threads} activeThreadId={null} />);

    // DEFAULT (all) view: no live spawned agents → no SPAWNED section, and the
    // dead ones are NOT shown (the junk drawer is gone).
    expect(screen.queryByTestId('rail-spawned')).toBeNull();
    expect(screen.queryByText('Dead CEO')).toBeNull();
    expect(screen.queryByText('Dead Project')).toBeNull();

    // Click the ENDED filter chip → the dead spawned sessions surface.
    fireEvent.click(screen.getByText('ended'));
    const ended = screen.getByTestId('rail-spawned-ended');
    expect(ended.textContent).toContain('Dead CEO');
    expect(ended.textContent).toContain('Dead Project');
  });

  it('marks a domain entry LIVE + 🧠 when its persistent brain is running', () => {
    META_BY_KEY.list = {
      sessions: [
        { id: 'sid-h', thread_id: 'thr-h', activity: null, live: true, persistent: true, domain: 'work' },
      ],
    };
    render(<ThreadSidebar threads={[]} activeThreadId={null} />);
    const work = screen.getByTestId('rail-domain-work');
    expect(work.getAttribute('data-live')).toBe('1');
    expect(screen.getByTestId('domain-brain-badge-work')).toBeTruthy();
    // a cold domain has no brain badge
    expect(screen.queryByTestId('domain-brain-badge-personal')).toBeNull();
    expect(screen.getByTestId('rail-domain-personal').getAttribute('data-live')).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// W9 named-live-tabs — rail declutter: the redundant LIVE *section* is removed
// (live sessions are now named cockpit tabs), BUT every live derivation stays:
//   - the Live filter chip + its count still render
//   - a waiting domain still shows its amber dot in DOMAINS
//   - the ALL/LIVE/NEEDS-YOU/ENDED filter row is intact
// ═══════════════════════════════════════════════════════════════════════════
describe('ThreadSidebar rail — W9 LIVE-section removal (declutter)', () => {
  beforeEach(() => {
    pushMock.mockReset();
    META_BY_KEY.meta = { threads: [] };
    META_BY_KEY.list = { sessions: [] };
  });

  function liveWorkThread(): DbChatThread {
    return thread({ id: 'thr-h', kind: 'project-session', last_message_at: '2026-05-31T03:00:00Z' });
  }

  it('does NOT re-list a live brain as a separate LIVE-section row (no duplication)', () => {
    META_BY_KEY.meta = {
      threads: [
        { id: 'thr-h', cwd: '/state/domains/work', session_id: 'sid-h', session_status: 'live', agent_name: 'Work', title: 'T', kind: 'project-session', ref_id: null, project_slug: null, exited_at: null, exit_code: null },
      ],
    };
    META_BY_KEY.list = {
      sessions: [
        { id: 'sid-h', thread_id: 'thr-h', activity: null, live: true, persistent: true, domain: 'work' },
      ],
    };
    render(<ThreadSidebar threads={[liveWorkThread()]} activeThreadId={null} />);

    // The Work brain appears as its fixed DOMAINS row (always-present),
    // marked live — that's the ONE home now.
    const domainRow = screen.getByTestId('rail-domain-work');
    expect(domainRow.getAttribute('data-live')).toBe('1');

    // The OLD LIVE section re-listed the SAME live brain as an emerald/amber
    // ThreadRow keyed `live::<id>` (a SECOND "Work" in the body). With the
    // section removed, "Work" appears exactly ONCE — in the DOMAINS row.
    // (Pre-W9 this would be 2: the domain row + the LIVE-section row.)
    const workHits = screen.getAllByText('Work');
    expect(workHits).toHaveLength(1);
    // …and the single hit lives inside the DOMAINS row, not a LIVE section.
    expect(domainRow.contains(workHits[0])).toBe(true);
  });

  it('KEEPS the Live filter chip with its live count (derivation survives)', () => {
    META_BY_KEY.meta = {
      threads: [
        { id: 'thr-h', cwd: '/state/domains/work', session_id: 'sid-h', session_status: 'live', agent_name: 'Work', title: 'T', kind: 'project-session', ref_id: null, project_slug: null, exited_at: null, exit_code: null },
      ],
    };
    META_BY_KEY.list = {
      sessions: [
        { id: 'sid-h', thread_id: 'thr-h', activity: null, live: true, persistent: true, domain: 'work' },
      ],
    };
    render(<ThreadSidebar threads={[liveWorkThread()]} activeThreadId={null} />);
    // The filter row's Live chip renders with the live count "Live 1".
    expect(screen.getByText(/^Live 1$/)).toBeTruthy();
  });

  it('KEEPS the ALL / LIVE / NEEDS-YOU / ENDED filter row intact', () => {
    render(<ThreadSidebar threads={[]} activeThreadId={null} />);
    expect(screen.getByText('all')).toBeTruthy();
    expect(screen.getByText(/^Live/)).toBeTruthy();
    expect(screen.getByText(/^Needs you/)).toBeTruthy();
    expect(screen.getByText('ended')).toBeTruthy();
  });

  it('opening a live domain door APPENDS to the deck (CEO-disappear root-cause fix)', () => {
    // A pane is already open in the URL. Pre-W9 the rail did a naive
    // router.push('/chat?panes=<newsid>') that WIPED the prior pane — the
    // actual "I spawned a 2nd agent and the first disappeared" bug. Now the
    // handler appends: the push URL must carry BOTH sids + focus the new one.
    window.history.replaceState({}, '', '/chat?panes=sid_existing');
    META_BY_KEY.meta = {
      threads: [
        { id: 'thr-h', cwd: '/state/domains/work', session_id: 'sid-h', session_status: 'live', agent_name: 'Work', title: 'T', kind: 'project-session', ref_id: null, project_slug: null, exited_at: null, exit_code: null },
      ],
    };
    META_BY_KEY.list = {
      sessions: [
        { id: 'sid-h', thread_id: 'thr-h', activity: null, live: true, persistent: true, domain: 'work' },
      ],
    };
    render(
      <ThreadSidebar
        threads={[thread({ id: 'thr-h', kind: 'project-session' })]}
        activeThreadId={null}
      />
    );
    // Click the live Work door → openDomainBrain(entry.live) → openSidInDeck.
    fireEvent.click(screen.getByTestId('rail-domain-work'));
    expect(pushMock).toHaveBeenCalled();
    const pushedUrl = String(pushMock.mock.calls.at(-1)?.[0] ?? '');
    // The prior pane survives AND the new sid is appended.
    expect(pushedUrl).toContain('sid_existing');
    expect(pushedUrl).toContain('sid-h');
    // …and the new one is focused.
    expect(pushedUrl).toContain('focus=sid-h');
    window.history.replaceState({}, '', '/');
  });

  it('a waiting domain still shows its attention status-glyph in DOMAINS (needs-you not lost)', () => {
    META_BY_KEY.meta = {
      threads: [
        { id: 'thr-h', cwd: '/state/domains/work', session_id: 'sid-h', session_status: 'live', agent_name: 'Work', title: 'T', kind: 'project-session', ref_id: null, project_slug: null, exited_at: null, exit_code: null },
      ],
    };
    META_BY_KEY.list = {
      sessions: [
        { id: 'sid-h', thread_id: 'thr-h', activity: 'waiting', live: true, persistent: true, domain: 'work' },
      ],
    };
    render(<ThreadSidebar threads={[liveWorkThread()]} activeThreadId={null} />);
    const work = screen.getByTestId('rail-domain-work');
    // Critic round-3 FIX #4: the saturated `bg-amber-400` waiting dot is gone.
    // The needs-you cue is now the bespoke StatusGlyph `attention` state — a
    // pulsing geometric ring in the MUTED warm-graphite state set (the one
    // sanctioned eye-demand), not a neon dot. Intent unchanged: a waiting domain
    // still surfaces its needs-you cue in DOMAINS, just via the state machine.
    // The `attention` state renders the pulsing filled glyph (the .glyph-attention
    // class is state-driven), inside an SVG that exposes the waiting title.
    expect(work.querySelector('.glyph-attention')).toBeTruthy();
    expect(
      work.querySelector('svg[aria-label*="waiting for you"]')
    ).toBeTruthy();
    // and the banned saturated dot is fully retired from the row.
    expect(work.querySelector('.bg-amber-400')).toBeNull();
  });
});
