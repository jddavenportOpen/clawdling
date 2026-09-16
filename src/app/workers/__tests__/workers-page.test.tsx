// ═══════════════════════════════════════════════════════════════════════════
// /workers page — the resolvers, and the two things the screen must never get
// wrong.
//
// Pins:
//   - elapsed time reads as time, including past an hour;
//   - a stream-json frame is summarised, and an UNRECOGNISED frame is shown
//     raw rather than swallowed (a log view that silently hides a line it
//     cannot parse is lying about what the worker did);
//   - a run WITHOUT worktree isolation says so on screen. That is the one
//     property a worker row can get wrong in a way that costs work: if the
//     operator believes a run is isolated when it is not, they let two of
//     them loose on the same checkout.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import WorkersPage, { __workersInternals__ } from '../page';

const { formatElapsed, describeEventLine, STATUS_TONE } = __workersInternals__;

function run(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run-aaa',
    name: 'nightly-notes',
    objective: 'Summarise every markdown file into NOTES.md.',
    status: 'running',
    exit_code: null,
    cwd: '/w/demo',
    base_cwd: '/w/demo',
    isolation: 'worktree',
    isolated: true,
    isolation_note: null,
    worktree: '/w/.clawdling-workers/worktrees/run-aaa',
    branch: 'clawdling/worker-run-aaa',
    workplan: '/w/.clawdling-workers/worktrees/run-aaa/WORKPLAN.md',
    domain: 'work',
    model: null,
    max_runtime_sec: 1800,
    elapsed_sec: 42,
    created_at: '2026-09-16T17:00:00Z',
    ended_at: null,
    summary: null,
    detail: null,
    ...overrides,
  };
}

function mockList(payload: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

/** Render with a FRESH SWR cache and no request de-duplication.
 *  SWR's cache and its 2s dedupingInterval are global and keyed by URL, so
 *  without this every test after the first is served the first test's payload
 *  and never refetches - the page looks empty for reasons that have nothing to
 *  do with the page. */
function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WorkersPage />
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatElapsed', () => {
  it('reads as mm:ss below an hour', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(9)).toBe('00:09');
    expect(formatElapsed(65)).toBe('01:05');
    expect(formatElapsed(599.9)).toBe('09:59');
  });

  it('switches to hours past 3600s and never renders a negative', () => {
    expect(formatElapsed(3600)).toBe('1h 00m');
    expect(formatElapsed(7_845)).toBe('2h 10m');
    expect(formatElapsed(-5)).toBe('00:00');
  });
});

describe('describeEventLine', () => {
  it('summarises a result frame with its subtype and text', () => {
    expect(
      describeEventLine(
        JSON.stringify({ type: 'result', subtype: 'success', result: 'notes are tidy' })
      )
    ).toBe('result (success) notes are tidy');
  });

  it('flattens assistant content blocks, naming tool calls', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'reading the plan' },
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_result' },
        ],
      },
    });
    expect(describeEventLine(line)).toBe('assistant: reading the plan [tool: Read] [tool result]');
  });

  it('shows an unparseable line RAW instead of hiding it', () => {
    expect(describeEventLine('not json at all')).toBe('not json at all');
    expect(describeEventLine('')).toBe('');
  });
});

describe('STATUS_TONE', () => {
  it('maps every worker status to a state-pill tone', () => {
    expect(Object.keys(STATUS_TONE).sort()).toEqual(
      ['done', 'failed', 'killed', 'running', 'timeout'].sort()
    );
    expect(STATUS_TONE.running).toBe('working');
    expect(STATUS_TONE.done).toBe('ready');
    expect(STATUS_TONE.failed).toBe('error');
    // A timeout is not a crash - it is a deadline. Amber, not red.
    expect(STATUS_TONE.timeout).toBe('attention');
  });
});

describe('WorkersPage', () => {
  it('renders the empty state when the bridge knows of no runs', async () => {
    mockList({ workers: [], running: 0, max_workers: 4 });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No workers yet/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/0 \/ 4 running/)).toBeInTheDocument();
  });

  it('renders a run with its status, elapsed time, and branch', async () => {
    mockList({ workers: [run()], running: 1, max_workers: 4 });
    renderPage();
    await waitFor(() => expect(screen.getByText('nightly-notes')).toBeInTheDocument());
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('00:42 / 30:00')).toBeInTheDocument();
    expect(screen.getByText('clawdling/worker-run-aaa')).toBeInTheDocument();
    expect(screen.getByTestId('worker-stop-run-aaa')).toBeInTheDocument();
  });

  it('SAYS SO when a run got no worktree isolation, and gives the reason', async () => {
    mockList({
      workers: [
        run({
          isolated: false,
          isolation: 'none',
          branch: null,
          worktree: null,
          isolation_note: 'the working directory is not a git repository',
        }),
      ],
      running: 1,
      max_workers: 4,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/no worktree isolation/i)).toBeInTheDocument()
    );
    expect(
      screen.getByText(/not a git repository/i)
    ).toBeInTheDocument();
  });

  it('hides the stop control on a finished run', async () => {
    mockList({
      workers: [run({ status: 'done', exit_code: 0, summary: 'objective complete' })],
      running: 0,
      max_workers: 4,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument());
    expect(screen.queryByTestId('worker-stop-run-aaa')).toBeNull();
    expect(screen.getByText('objective complete')).toBeInTheDocument();
  });
});
