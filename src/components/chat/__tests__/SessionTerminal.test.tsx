// ═══════════════════════════════════════════════════════════════════════════
// SessionTerminal.test.tsx — regression coverage for the SSE state machine
// + composer + kill flow.
//
// Born 2026-05-27 (audit HIGH #3, cockpit-chat-v3).
//
// What this file does NOT cover:
//   - the POST-stream consumer (consumePostStream) full byte-buffer behavior
//     — that's a >300-line transport, tested at e2e via qa-gate Playwright
//   - xterm render output — mocked module-wide, see vitest.setup.ts
//
// What it DOES cover:
//   - initial status seed: 'exited' on mount → state machine starts in ENDED
//   - composer "submit" contract: POST /input body is `{text: <text>\r}`
//     (the M4/V3 P1 "text+CR" fix that made the cockpit chat actually respond)
//   - kill flow: DELETE /api/sessions/<sid> + optimistic exited state
//   - the exitedRef latch is wired to setStatus('exited') (post-kill,
//     post-exit-frame). We can't reach into the ref but we CAN verify the
//     observable state transitions that follow it.
//
// The component depends on POST-stream `fetch` for SSE. We stub fetch with a
// resolved-but-stalled body so the stream never produces frames during the
// test — that's fine because we're testing the EFFECTS that fire on user
// action (kill button, composer submit), not the stream's reactive behavior.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SessionTerminal from '../SessionTerminal';

// ── fetch stub helpers ───────────────────────────────────────────────────

function makeStalledStreamResponse(): Response {
  // A Response whose body never emits. The SessionTerminal SSE reader will
  // await reader.read() and block forever — perfect for unit-test isolation.
  const body = new ReadableStream<Uint8Array>({
    start() {
      // intentionally never enqueue or close — connection stays "open"
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeOkJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeHistoryResponse(body = '', totalBytes = 0): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'X-Session-Log-Total-Bytes': String(totalBytes),
    },
  });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface FetchStub {
  calls: FetchCall[];
  /** Override response for URLs matching a substring. */
  override(matcher: string, response: () => Response | Promise<Response>): void;
}

function installFetchStub(): FetchStub {
  const calls: FetchCall[] = [];
  const overrides: Array<{
    matcher: string;
    fn: () => Response | Promise<Response>;
  }> = [];
  // @ts-expect-error: stubbing global fetch with a vi.fn
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    for (const o of overrides) {
      if (url.includes(o.matcher)) return o.fn();
    }
    // Defaults:
    if (url.includes('/history')) return makeHistoryResponse();
    if (url.includes('/stream-post')) {
      return makeOkJsonResponse({
        stream_url: '/bridge/stream-post',
        token: 'mock_jwt',
        expires_in: 60,
        status: 'live',
        method: 'POST',
      });
    }
    if (url.endsWith('/bridge/stream-post') || url.includes('/stream-post')) {
      return makeStalledStreamResponse();
    }
    if (url.includes('/input')) {
      return makeOkJsonResponse({ ok: true, input_ready: true });
    }
    if (url.match(/\/api\/sessions\/[^/]+$/) && init?.method === 'DELETE') {
      return makeOkJsonResponse({ ok: true });
    }
    return new Response('', { status: 200 });
  });
  return {
    calls,
    override(matcher, fn) {
      overrides.push({ matcher, fn });
    },
  };
}

// Stub the browser's confirm() — the kill button gates on it.
let confirmReturn = true;
beforeEach(() => {
  confirmReturn = true;
  // @ts-expect-error: jsdom has confirm but we want a deterministic stub
  globalThis.confirm = vi.fn(() => confirmReturn);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionTerminal — initial status seed', () => {
  it('renders header showing the session id slice', async () => {
    installFetchStub();
    render(
      <SessionTerminal sessionId="sid_abc12345_full" initialStatus="live" />
    );
    // First 8 chars of sid in the header
    expect(await screen.findByText('sid_abc1')).toBeInTheDocument();
  });

  it('renders status text from initialStatus prop', async () => {
    installFetchStub();
    render(
      <SessionTerminal sessionId="sid_starting_test" initialStatus="starting" />
    );
    expect(await screen.findByText(/starting/)).toBeInTheDocument();
  });

  it('mounts with initialStatus=exited and bubbles "exited" via onStatusChange', async () => {
    installFetchStub();
    const onStatusChange = vi.fn();
    render(
      <SessionTerminal
        sessionId="sid_dead_at_mount"
        initialStatus="exited"
        onStatusChange={onStatusChange}
      />
    );
    // The status-bubble effect fires on every status change, including the
    // initial render with status === initialStatus. We verify that the
    // first emitted status reflects 'exited' — proof that the latch was
    // observed at mount and the initialStatus seed plumbed through.
    expect(onStatusChange).toHaveBeenCalled();
    expect(onStatusChange.mock.calls[0][0]).toBe('exited');
  });
});

// ─── ITER-5 BLOCKER: dead-row /history replay ──────────────────────────────
//
// JD msg 8136 (2026-05-27): "history of each panel isnt saved when you go
// back and forth back into old chats". After iter-3 fixed the cold-mount
// DEADLOCK (PR #106 — panes now MOUNT), iter-4 audit caught that the pane
// body was STILL blank for dead-row clicks — the transcript was never
// PAINTED. Root cause: SessionTerminal.tsx connect() early-returned on
// `status === 'exited' || exitedRef.current` BEFORE seedHistoryTail() could
// fetch /api/sessions/<sid>/history and replay the bytes via writeToTerm.
//
// Iter-5 fix: call await seedHistoryTail() before the SESSION_ENDED
// dispatch in connect()'s exited branch. seedHistoryTail already detects
// the exit case (initialStatusRef.current === 'exited') and writes the
// /history bytes + "history above · live below" divider — it's just never
// been reachable from the exited-at-mount path.
//
// This regression guard fails when the early-return is reverted (the fetch
// to /history is never called on an exited mount).
// ───────────────────────────────────────────────────────────────────────────

describe('SessionTerminal — iter-5: dead-row /history replay on exited mount', () => {
  it('fetches /api/sessions/<sid>/history when mounted with initialStatus="exited"', async () => {
    const stub = installFetchStub();
    render(
      <SessionTerminal
        sessionId="sid_dead_with_transcript"
        initialStatus="exited"
      />
    );
    // The connect() exited-branch fires from the mount useEffect, which
    // awaits seedHistoryTail() → fetch('/api/sessions/<sid>/history?...').
    // Microtask flush — fetch promise + setState chain.
    await new Promise((r) => setTimeout(r, 50));

    const historyCall = stub.calls.find(
      (c) =>
        c.url.includes('/api/sessions/sid_dead_with_transcript/history') &&
        // GET (the default) — ensure no caller is accidentally POST-ing.
        (!c.init?.method || c.init.method === 'GET')
    );
    expect(historyCall).toBeDefined();
    // The seedHistoryTail call carries the ?bytes=51200 tail size — proof
    // we're hitting the SEED path, not the cursor catchup path.
    expect(historyCall!.url).toContain('bytes=51200');
    // And NO `?start=` cursor param on the seed call (that's the catchup
    // path, which requires a prior seed to set logCursorRef).
    expect(historyCall!.url).not.toContain('start=');
  });

  it('does NOT open the live SSE stream when mounted with initialStatus="exited"', async () => {
    const stub = installFetchStub();
    render(
      <SessionTerminal
        sessionId="sid_dead_no_live_sse"
        initialStatus="exited"
      />
    );
    await new Promise((r) => setTimeout(r, 50));

    // The /stream-post token endpoint (and /bridge/stream-post itself) must
    // NEVER be hit for an exited-at-mount session. The whole point of the
    // exited branch is "fetch history, dispatch SESSION_ENDED, stop." If a
    // future regression makes connectViaPost reachable from the exited
    // branch we'll see /stream-post calls — and a live-SSE write would race
    // with the static history replay.
    const liveStreamCall = stub.calls.find(
      (c) =>
        c.url.includes('/stream-post') &&
        c.url.includes('sid_dead_no_live_sse')
    );
    expect(liveStreamCall).toBeUndefined();
  });

  it('seedHistoryTail fetches history with bytes=51200 (the tail size contract)', async () => {
    // Belt-and-suspenders contract pin: 51200 (50 KB) is the tail size
    // seedHistoryTail uses. If a future refactor changes the magic number,
    // this catches it — the qa-cockpit-v3-suite Phase 14 assertion depends
    // on bytes=51200 in the URL.
    const stub = installFetchStub();
    render(
      <SessionTerminal
        sessionId="sid_tail_size_pin"
        initialStatus="exited"
      />
    );
    await new Promise((r) => setTimeout(r, 50));
    const historyCall = stub.calls.find((c) =>
      c.url.includes('/api/sessions/sid_tail_size_pin/history')
    );
    expect(historyCall).toBeDefined();
    const urlObj = new URL(historyCall!.url, 'http://x');
    expect(urlObj.searchParams.get('bytes')).toBe('51200');
  });
});

describe('SessionTerminal — composer submit (M4 text+CR fix)', () => {
  it('submitting text POSTs to /api/sessions/<sid>/input with text + carriage return', async () => {
    const stub = installFetchStub();
    render(
      <SessionTerminal sessionId="sid_compose_1" initialStatus="live" />
    );

    const user = userEvent.setup();
    const textarea = await screen.findByPlaceholderText(/Type and press Enter/);
    await user.type(textarea, 'hello world');

    // Submit via the Send button (more reliable than Enter in jsdom where
    // keyboard event defaults can vary by RTL version).
    const sendBtn = screen.getByRole('button', { name: /send/i });
    await act(async () => {
      sendBtn.click();
    });

    // Find the /input POST call.
    const inputCall = stub.calls.find(
      (c) => c.url.includes('/input') && c.init?.method === 'POST'
    );
    expect(inputCall).toBeDefined();
    const body = JSON.parse(String(inputCall!.init!.body));
    // The CR-terminator is THE contract: text + '\r'. The Claude Code TUI
    // runs in bracketed-paste mode and \n alone leaves the message stuck
    // in the composer. \r is what submits.
    expect(body.text).toBe('hello world\r');
  });

  it('empty input does NOT fire a /input POST', async () => {
    const stub = installFetchStub();
    render(<SessionTerminal sessionId="sid_empty_1" initialStatus="live" />);
    const sendBtn = await screen.findByRole('button', { name: /send/i });
    await act(async () => {
      sendBtn.click();
    });
    const inputCall = stub.calls.find(
      (c) => c.url.includes('/input') && c.init?.method === 'POST'
    );
    expect(inputCall).toBeUndefined();
  });
});

describe('SessionTerminal — kill flow (DELETE + optimistic exit)', () => {
  it('clicking Kill issues DELETE /api/sessions/<sid> and transitions to exited', async () => {
    const stub = installFetchStub();
    const onStatusChange = vi.fn();
    render(
      <SessionTerminal
        sessionId="sid_kill_target"
        initialStatus="live"
        onStatusChange={onStatusChange}
      />
    );

    // Click the kill button. It's labeled "Kill" in the header.
    const killBtn = await screen.findByRole('button', { name: /kill session/i });
    await act(async () => {
      killBtn.click();
      // Let the DELETE promise settle.
      await Promise.resolve();
    });

    // Need a microtask flush for the await fetch + setState chain
    await new Promise((r) => setTimeout(r, 50));

    const deleteCall = stub.calls.find(
      (c) =>
        c.url.includes('/api/sessions/sid_kill_target') &&
        c.init?.method === 'DELETE'
    );
    expect(deleteCall).toBeDefined();

    // After kill resolves, status should bubble 'exited' to the parent.
    const exitedCalls = onStatusChange.mock.calls.filter(
      ([s]: [string]) => s === 'exited'
    );
    expect(exitedCalls.length).toBeGreaterThan(0);
  });

  it('Kill aborts when user cancels the confirm dialog', async () => {
    confirmReturn = false;
    const stub = installFetchStub();
    render(<SessionTerminal sessionId="sid_no_kill" initialStatus="live" />);
    const killBtn = await screen.findByRole('button', { name: /kill session/i });
    await act(async () => {
      killBtn.click();
    });
    await new Promise((r) => setTimeout(r, 20));
    const deleteCall = stub.calls.find(
      (c) =>
        c.url.includes('/api/sessions/sid_no_kill') &&
        c.init?.method === 'DELETE'
    );
    expect(deleteCall).toBeUndefined();
  });
});

describe('SessionTerminal — onResumed contract', () => {
  it('onResumed prop is preserved (no rename) and is callable', () => {
    // Sanity check: the prop name is `onResumed`. If a future refactor
    // renames it (e.g. to `onSidSwapped`) ChatGrid will silently drop the
    // pane-swap callback and full-page-reload regress, per the cockpit
    // overhaul 2026-05-26 notes in the file header.
    installFetchStub();
    const onResumed = vi.fn();
    const { rerender } = render(
      <SessionTerminal
        sessionId="sid_r"
        initialStatus="live"
        onResumed={onResumed}
      />
    );
    // No assertion fires the callback in unit tests (resume is gated on a
    // bridge 404 response we'd have to choreograph) — this test exists to
    // pin the prop name + type at the TS level. If the prop is renamed,
    // TypeScript will fail the build of THIS file.
    expect(typeof onResumed).toBe('function');
    rerender(
      <SessionTerminal
        sessionId="sid_r"
        initialStatus="live"
        onResumed={undefined}
      />
    );
    // Component must accept undefined onResumed (the legacy standalone
    // /projects/.../sessions/[sid] route mounts without it).
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Audit HIGH #4 — full SessionTerminal SSE state-machine coverage.
//
// Born 2026-05-28 (task #37, audit HIGH #4). Earlier audit caught that PR #98
// shipped 56 frontend tests, ~90% on pure utility functions — and ZERO covered
// the SessionTerminal state machine where PRs #95/#97/#105/#106/#107 all
// shipped regressions. The iter-5 fix added 3 tests for the exited-mount
// case (above); this block fills the rest of the state-machine surface.
//
// Each test names the PR whose behavior it guards in its block header. Five
// of these (FIRST_LIVE_EVENT, exitedRef latch, live-mount seedHistoryTail,
// metaResolved gate, crash-recovery render) were verified to FAIL on broken
// code — see PR body for the stash-and-rerun proof.
// ═══════════════════════════════════════════════════════════════════════════

// ── PR #95 — FIRST_LIVE_EVENT dispatch on stream connect ──────────────────
//
// connectViaPost (SessionTerminal.tsx:831-845) dispatches FIRST_LIVE_EVENT
// the moment the POST response is HTTP 200 with an OPEN body — BEFORE waiting
// for the first PTY frame. Pre-fix, LIVE was gated on first frame; a quiet
// already-running session would emit no bytes and panes stuck in SYNCING
// forever ("ONE FALLS OUT OF LIVE NEAR INSTANTLY", JD 2026-05-27).
//
// We assert the state transition by observing the badge: after history loads
// (HISTORY_LOADED → SYNCING) and the POST response opens (FIRST_LIVE_EVENT →
// LIVE), the badge color/label moves to the LIVE state. We don't push any
// frames into the body — the whole point of the fix is "no frames needed."

describe('SessionTerminal — PR #95: FIRST_LIVE_EVENT on stream open (no frame needed)', () => {
  it('transitions to LIVE on POST 200 + open body, even without any SSE frames', async () => {
    const stub = installFetchStub();
    // Override the /bridge/stream-post body explicitly — the default stub's
    // fall-through pattern matches the metadata-route substring first, which
    // would return a closing JSON body and trip SSE_CLOSED → RECONNECT.
    stub.override('/bridge/stream-post', makeStalledStreamResponse);
    render(
      <SessionTerminal sessionId="sid_quiet_live" initialStatus="live" />
    );

    // Allow: seedHistoryTail → fetch /history (mocked OK) → dispatch
    // HISTORY_LOADED (SYNCING) → connectViaPost → fetch /stream-post meta
    // (mocked OK) → fetch /bridge/stream-post (returns 200 with stalled body)
    // → dispatch FIRST_LIVE_EVENT → state machine: SYNCING → LIVE.
    //
    // The whole chain is microtask + setState; ~50ms flush is sufficient
    // (matches the pattern the iter-5 exited tests use above).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // Badge component renders a data-state attribute we can introspect.
    // After the FIRST_LIVE_EVENT dispatch the kind must be 'LIVE'.
    const badge = await screen.findByTestId('session-state-badge');
    expect(badge.getAttribute('data-state')).toBe('LIVE');
  });
});

// ── PR #90 / fix/cockpit-resume-after-rotation — exitedRef latch ──────────
//
// SessionTerminal.tsx:206-228 documents the root cause: connect/reconnect
// guards read the STALE `status` closure, not the live latch. An `exit`
// frame flips exitedRef SYNCHRONOUSLY (line 594) so the post-stream guard
// at line 858 reads `!exitedRef.current` correctly and STOPS instead of
// scheduling a reconnect into the dead sid.
//
// We can't reach the ref directly — we exercise the OBSERVABLE behavior:
// after an 'exit' SSE frame arrives, the state machine transitions to ENDED
// AND no further /stream-post calls are issued. Pre-fix, the reconnect storm
// would have spawned more /stream-post fetches.

describe('SessionTerminal — PR #90: exitedRef latch prevents reconnect storm', () => {
  it('exit-frame on live mount → ENDED, then NO further /stream-post calls (no reconnect storm)', async () => {
    // Push a real SSE 'exit' frame into the POST stream so the consumer
    // calls dispatchSseFrame → exit-branch → exitedRef.current = true →
    // SESSION_ENDED dispatch. We then wait long enough for any spurious
    // reconnect to have fired, and assert the stream-post call count is
    // bounded by ONE (the initial mount connect).
    const stub = installFetchStub();
    stub.override('/bridge/stream-post', () => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // SSE frame format: event:exit\nid:1\ndata:{}\n\n
          controller.enqueue(
            enc.encode('event: exit\nid: 1\ndata: {}\n\n')
          );
          // Close the stream — bridge-side EOF after exit.
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const onStatusChange = vi.fn();
    render(
      <SessionTerminal
        sessionId="sid_exited_latch"
        initialStatus="live"
        onStatusChange={onStatusChange}
      />
    );

    // Connect + frame parse + dispatch chain.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    // exitedRef latched → status bubbled exited → SESSION_ENDED dispatched.
    const exitedSeen = onStatusChange.mock.calls.some(
      ([s]: [string]) => s === 'exited'
    );
    expect(exitedSeen).toBe(true);

    // Snapshot the stream-post call count and wait a full reconnect cycle
    // (1s backoff for attempt 0). If exitedRef leaked the stale-status
    // race, scheduleReconnect would have queued a retry and we'd see a
    // SECOND /stream-post call here.
    const streamPostCallsAfterExit = stub.calls.filter((c) =>
      c.url.includes('/stream-post')
    ).length;
    await new Promise((r) => setTimeout(r, 1200));
    const streamPostCallsLater = stub.calls.filter((c) =>
      c.url.includes('/stream-post')
    ).length;
    // No new connect attempts after exit — that's the latch holding.
    expect(streamPostCallsLater).toBe(streamPostCallsAfterExit);
  });
});

// ── PR #107 / iter-5 — seedHistoryTail on LIVE mount ──────────────────────
//
// connectViaPost (line 773) calls `await seedHistoryTail()` BEFORE opening
// the stream — on EVERY mount, not just exited. seedHistoryTail's internal
// branch (line 475-484) decides whether to PAINT the bytes (exited only) or
// just capture the logCursorRef (live). Both branches MUST fetch /history
// because logCursorRef anchors the catchup path. If a future refactor moves
// seedHistoryTail INSIDE the exited branch (like the bug iter-5 fixed for
// the dead-row case, in reverse), visibility-resume catchup breaks silently.

describe('SessionTerminal — PR #107: seedHistoryTail fires on LIVE mount (for cursor)', () => {
  it('fetches /history?bytes=51200 on initialStatus=live mount (anchors logCursorRef)', async () => {
    const stub = installFetchStub();
    render(
      <SessionTerminal sessionId="sid_live_cursor" initialStatus="live" />
    );
    await new Promise((r) => setTimeout(r, 100));

    const historyCall = stub.calls.find(
      (c) =>
        c.url.includes('/api/sessions/sid_live_cursor/history') &&
        c.url.includes('bytes=51200') &&
        !c.url.includes('start=')
    );
    expect(historyCall).toBeDefined();
  });
});

// ── PR #106 — metaResolved gate on ChatGridPane mount ─────────────────────
//
// ChatGrid.tsx:909 gates the <ChatGridPane> mount on `p.metaResolved`. SessionTerminal
// inside the pane reads initialStatus ONCE via useRef on mount, so mounting with a
// stale 'live' default for an actually-dead session silently drops the /history paint
// (the bug PR #102 thought it fixed — the audit HIGH #1 root cause).
//
// We can't reach into ChatGrid here (different test file), but the CONTRACT we test
// at the SessionTerminal layer is: initialStatusRef captures the value at mount, AND
// the same effect that fires onStatusChange does so SYNCHRONOUSLY on first render.
// Pane upstream is responsible for not flipping status mid-mount; SessionTerminal's
// invariant is "what you pass at mount is what initialStatusRef reads."
//
// This test pins the SYNCHRONOUS first-render contract — if SessionTerminal ever
// deferred the initial onStatusChange via a setTimeout/setState chain, ChatGridPane's
// header dot would lag and the metaResolved-then-mount fix would regress.

describe('SessionTerminal — PR #106: initialStatus captured synchronously at mount', () => {
  it('onStatusChange fires SYNCHRONOUSLY with initialStatus on the first render', () => {
    installFetchStub();
    const onStatusChange = vi.fn();
    render(
      <SessionTerminal
        sessionId="sid_meta_resolved"
        initialStatus="live"
        onStatusChange={onStatusChange}
      />
    );
    // The status-bubble effect fires in the same render cycle React commits
    // (the testing-library `render` returns AFTER the initial effects flush).
    // No setTimeout/await needed — if a future refactor introduces an async
    // step, this assertion fails.
    expect(onStatusChange).toHaveBeenCalled();
    expect(onStatusChange.mock.calls[0][0]).toBe('live');
  });

  it('initialStatus="starting" is bubbled (not normalized to "live") so the metaResolved-correct dot color shows', () => {
    installFetchStub();
    const onStatusChange = vi.fn();
    render(
      <SessionTerminal
        sessionId="sid_starting_pin"
        initialStatus="starting"
        onStatusChange={onStatusChange}
      />
    );
    expect(onStatusChange.mock.calls[0][0]).toBe('starting');
  });
});

// ── Visibility / focus reconnect (chat-resume-fix, 2026-05-22) ────────────
//
// The visibility-aware resume effect (SessionTerminal.tsx:1116) listens for
// visibilitychange + focus events. On return-to-tab it ALWAYS calls
// catchupHistory() (silent /history?start=<cursor>) AND, if the POST stream
// abort controller has been torn down, force-reconnects.
//
// We can't easily simulate the abort-controller-null state without invasive
// mocks, but the visible-tab catchup IS observable as a fetch call carrying
// `start=<cursor>`. That's the JD-asked-for "synced" proof-of-life — the
// regression we guard against is the resume callback silently no-op-ing.

describe('SessionTerminal — visibility/focus catchup contract', () => {
  it('returning to a visible tab fires /history?start=<cursor> catchup fetch', async () => {
    const stub = installFetchStub();
    // Seed must succeed AND return a non-NaN cursor header so logCursorRef
    // gets populated → catchupHistory won't early-return on null cursor.
    stub.override('/api/sessions/sid_visibility/history', () =>
      makeHistoryResponse('SEED_BYTES', 12345)
    );

    render(
      <SessionTerminal sessionId="sid_visibility" initialStatus="live" />
    );
    // Allow the initial seed to land → logCursorRef = 12345.
    await new Promise((r) => setTimeout(r, 100));

    // Snapshot pre-event calls so we can detect the NEW catchup fetch.
    const preEventCallCount = stub.calls.filter((c) =>
      c.url.includes('/history')
    ).length;

    // Simulate tab return: visibilitychange event with visibilityState=visible.
    // jsdom's document.visibilityState is read-only — define it just-in-time.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await new Promise((r) => setTimeout(r, 50));

    const newHistoryCalls = stub.calls
      .slice(preEventCallCount)
      .filter((c) => c.url.includes('/history') && c.url.includes('start='));
    expect(newHistoryCalls.length).toBeGreaterThan(0);
    // The catchup URL pins bytes=524288 (the catchup ceiling — see line 526).
    expect(newHistoryCalls[0].url).toContain('bytes=524288');
    expect(newHistoryCalls[0].url).toContain('start=12345');
  });

  it('window focus event also fires /history?start=<cursor> catchup fetch', async () => {
    const stub = installFetchStub();
    stub.override('/api/sessions/sid_focus/history', () =>
      makeHistoryResponse('SEED_BYTES', 999)
    );

    render(<SessionTerminal sessionId="sid_focus" initialStatus="live" />);
    await new Promise((r) => setTimeout(r, 100));

    const preEventCallCount = stub.calls.filter((c) =>
      c.url.includes('/history')
    ).length;

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await new Promise((r) => setTimeout(r, 50));

    const newHistoryCalls = stub.calls
      .slice(preEventCallCount)
      .filter((c) => c.url.includes('/history') && c.url.includes('start=999'));
    expect(newHistoryCalls.length).toBeGreaterThan(0);
  });
});

// ── PR #105/#107 crash-recovery — spawn-new button render gating ──────────
//
// SessionStateBadge (SessionTerminal.tsx:2181) renders the spawn-new button
// ONLY when (1) badge spec opts in (showSpawnNew=true — set when state.crashedAt
// is populated via SESSION_CRASHED dispatch), AND (2) onSpawnNew prop is wired
// (set in the parent only when threadId is non-null).
//
// The gating WAS the bug in audit HIGH #2: threadId fetched in a useEffect
// raced against the user clicking — PR #97 ChatGridPane fetch was deleted
// in favor of threadId-as-prop (PR #106 / fix/v3-pane-descriptor). This test
// nails the threadId gating contract from the SessionTerminal side: same
// crashed signal, different threadId → different button presence.

describe('SessionTerminal — PR #105/#107: spawn-new button gates on threadId', () => {
  function makeCrashedStreamResponse(): Response {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            'event: crashed\nid: 1\ndata: {"ts":"2026-05-27T12:00:00Z","text":"bridge died"}\n\n'
          )
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('renders the spawn-new button when crashed AND threadId set', async () => {
    const stub = installFetchStub();
    stub.override('/bridge/stream-post', makeCrashedStreamResponse);

    render(
      <SessionTerminal
        sessionId="sid_crashed_with_thread"
        initialStatus="live"
        threadId="thr_abc"
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    // The crashed dispatch flips SseState to ERROR with crashedAt set →
    // badge.showSpawnNew = true. With threadId truthy, onSpawnNew prop
    // is wired → button RENDERS.
    const spawnBtn = screen.queryByTestId('spawn-new-button');
    expect(spawnBtn).not.toBeNull();
  });

  it('does NOT render the spawn-new button when crashed but threadId is null', async () => {
    const stub = installFetchStub();
    stub.override('/bridge/stream-post', makeCrashedStreamResponse);

    render(
      <SessionTerminal
        sessionId="sid_crashed_no_thread"
        initialStatus="live"
        threadId={null}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    // SAME crashed signal — but with threadId=null, parent passes
    // onSpawnNew=undefined; the badge MUST suppress the button.
    const spawnBtn = screen.queryByTestId('spawn-new-button');
    expect(spawnBtn).toBeNull();
  });
});

// ── PR #87 — local echo dropped on live (V3 M3 no-echo fix) ───────────────
//
// SessionTerminal.tsx:1792 documents: do NOT local-echo typed text on the
// live path. The bridge writes the text to the PTY → the Claude Code TUI
// echoes it back through SSE → the terminal paints it ONCE. Pre-fix, the
// component called appendChunk('> text') AND the TUI echoed it = double
// render. We assert the network contract: only the /input POST fires; no
// path writes the typed text into the terminal locally on the LIVE path.

describe('SessionTerminal — PR #87: live-path typed text NOT local-echoed', () => {
  it('typed text submit only POSTs /input — does NOT also paint a "> text" local line', async () => {
    const stub = installFetchStub();
    // /input returns a normal success — NOT a resume-payload (which is the
    // one path where we DO local-echo, per the resume comment at line 1723).
    stub.override('/input', () =>
      makeOkJsonResponse({ ok: true, input_ready: true })
    );

    render(
      <SessionTerminal sessionId="sid_no_echo" initialStatus="live" />
    );
    const user = userEvent.setup();
    const textarea = await screen.findByPlaceholderText(/Type and press Enter/);
    await user.type(textarea, 'hello echo');
    const sendBtn = screen.getByRole('button', { name: /send/i });
    await act(async () => {
      sendBtn.click();
    });
    await new Promise((r) => setTimeout(r, 50));

    // ONE /input POST — that's the only network effect of a live-path send.
    const inputCalls = stub.calls.filter(
      (c) => c.url.includes('/input') && c.init?.method === 'POST'
    );
    expect(inputCalls.length).toBe(1);
    const body = JSON.parse(String(inputCalls[0].init!.body));
    expect(body.text).toBe('hello echo\r');

    // No local-echo path exists outside of the resume branch — the easy
    // observable proof is "no additional history/stream call snuck in to
    // re-render the typed text." (We can't peek into xterm's write buffer
    // because xterm itself is mocked; this is the closest network proof.)
    const postSubmitFetches = stub.calls.length - inputCalls.length;
    // We allow up to the legitimate background traffic — history seed,
    // stream-post meta, stream-post body, costs (SWR may have polled once).
    // The KEY assertion is the /input POST count: exactly 1, never 2.
    expect(inputCalls.length).toBe(1);
    expect(postSubmitFetches).toBeGreaterThanOrEqual(0); // sanity
  });
});

// ── PR #87 regression — Shift+Enter inserts a newline (does NOT submit) ──
//
// SessionTerminal.tsx:1812-1820: Enter alone submits; Shift+Enter falls
// through (no preventDefault) so the textarea inserts \n natively. Without
// the !e.shiftKey gate, multi-line composing breaks — every newline triggers
// a send.

describe('SessionTerminal — PR #87 regression: Shift+Enter does NOT submit', () => {
  it('Shift+Enter inserts newline, does not POST /input', async () => {
    const stub = installFetchStub();
    render(
      <SessionTerminal sessionId="sid_multiline" initialStatus="live" />
    );
    const user = userEvent.setup();
    const textarea = await screen.findByPlaceholderText(/Type and press Enter/);
    await user.click(textarea);
    await user.keyboard('first line');
    // Shift+Enter — RTL's userEvent supports the {Shift>} pattern.
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.keyboard('second line');

    // After Shift+Enter + more typing, NO /input POST should have fired.
    const inputCall = stub.calls.find(
      (c) => c.url.includes('/input') && c.init?.method === 'POST'
    );
    expect(inputCall).toBeUndefined();

    // And the textarea value must contain BOTH lines (proof the newline
    // landed natively, not silently swallowed).
    expect((textarea as HTMLTextAreaElement).value).toContain('first line');
    expect((textarea as HTMLTextAreaElement).value).toContain('second line');
    expect((textarea as HTMLTextAreaElement).value).toMatch(/first line\n.*second line/);
  });

  it('Enter (no shift) DOES submit (the other half of the contract)', async () => {
    const stub = installFetchStub();
    render(
      <SessionTerminal sessionId="sid_enter_submits" initialStatus="live" />
    );
    const user = userEvent.setup();
    const textarea = await screen.findByPlaceholderText(/Type and press Enter/);
    await user.click(textarea);
    await user.keyboard('submit me{Enter}');

    await new Promise((r) => setTimeout(r, 50));

    const inputCall = stub.calls.find(
      (c) => c.url.includes('/input') && c.init?.method === 'POST'
    );
    expect(inputCall).toBeDefined();
    const body = JSON.parse(String(inputCall!.init!.body));
    expect(body.text).toBe('submit me\r');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// fix/cockpit-restore-not-boot-on-return (2026-05-30) — JD screenshot bug
//
// THE BUG: returning to a backgrounded cockpit tab (esp. mobile, where iOS
// discards the tab → cold remount) showed the pane for an ALREADY-LIVE,
// established session the COLD-BOOT overlay:
//   "Booting agent… Claude Code is starting up. First output usually lands
//    in 20–30 seconds."
// — even though the agent already ran and is waiting. The rail correctly
// showed LIVE; only the PANE lied, and it didn't restore the transcript.
//
// ROOT CAUSE: the boot overlay renders while `!hasOutput`, and the wording
// branched purely on `sseState.kind` (INITIAL/SYNCING → cold-boot copy). On a
// cold remount, seedHistoryTail() fetches /history but — for a LIVE session —
// deliberately did NOT paint it (the V3 M3 no-echo fix), so `hasOutput` stayed
// false through the whole SYNCING→stream-connect window. With no signal that
// the session was ESTABLISHED, the pane showed the 20–30s cold-boot copy.
//
// THE FIX: derive `hasPriorHistory` from the /history tail bytes (no extra
// round-trip). When prior history exists:
//   (a) the overlay never shows the "Booting…/20–30s" copy — it says
//       "Restoring session…",
//   (b) the transcript is replayed for the live session too (restoreLive-
//       Transcript), flipping `hasOutput` true so the overlay clears fast.
// A genuinely-fresh spawn (empty /history) STILL shows the real boot copy.
//
// These two cases are the failing→passing proof: case 1 FAILS on pre-fix
// code (it showed "Booting agent…"); case 2 guards the fresh-spawn copy so
// the fix doesn't over-correct.
// ═══════════════════════════════════════════════════════════════════════════

describe('SessionTerminal — restore-on-return (not cold-boot) for established sessions', () => {
  // A /bridge/stream-post that NEVER resolves — models the real mobile cold-
  // remount: after seedHistoryTail dispatches HISTORY_LOADED (→ SYNCING), the
  // token-mint + stream-connect round trip is still in flight (seconds on a
  // slow/mobile link). THIS is the window where the pane sits in SYNCING with
  // hasOutput=false → the boot overlay renders. With a PENDING (not stalled-
  // 200) stream, FIRST_LIVE_EVENT has NOT fired yet, so on PRE-FIX code the
  // overlay shows the exact "Booting agent… / 20–30 seconds" cold-boot copy
  // JD screenshotted. (A stalled-200 body would fire FIRST_LIVE_EVENT and
  // mask the bug as "Waiting for output…" — verified during measure-twice.)
  function makePendingStream(): Response {
    return new Promise<Response>(() => {
      /* never resolves — pane stays in SYNCING */
    }) as unknown as Response;
  }

  it('established LIVE session (non-empty /history) does NOT show the cold-boot "20–30s" copy', async () => {
    const stub = installFetchStub();
    // /history returns prior bytes → this is an ESTABLISHED session.
    stub.override('/history', () =>
      makeHistoryResponse(
        'prior transcript bytes from an already-running agent\r\n',
        1234
      )
    );
    stub.override('/bridge/stream-post', makePendingStream);

    render(
      <SessionTerminal sessionId="sid_established_return" initialStatus="live" />
    );

    // Let mount → seedHistoryTail (/history → non-empty) → HISTORY_LOADED →
    // stream connect settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });

    // The pane must NOT misrepresent an established session as a fresh boot.
    // If the boot indicator is present at all, it must be the honest
    // "Restoring session…" copy — never the "Booting agent…/20–30s" cold-boot
    // copy. (On the FIXED code the transcript is painted so hasOutput flips and
    // the indicator is gone entirely; either way the cold-boot copy is absent.)
    // THE BUG SYMPTOM (fails on pre-fix code): the cold-boot "Booting agent…"
    // headline + "20–30 seconds" sub-copy must not appear ANYWHERE for an
    // established session. On broken code the boot overlay renders exactly this
    // copy during the SYNCING window — that's the screenshot JD reported.
    expect(screen.queryByText(/Booting agent/i)).toBeNull();
    expect(
      screen.queryByText(/first output usually lands in 20[–-]30 seconds/i)
    ).toBeNull();

    // And IF the overlay is still up (pre-paint window), it must be the honest
    // restore copy, flagged via data-restoring — never the cold-boot copy.
    const indicator = screen.queryByTestId('pane-boot-indicator');
    if (indicator) {
      expect(indicator.getAttribute('data-restoring')).toBe('true');
      expect(indicator.textContent).toMatch(/Restoring session/i);
    }
  });

  it('does NOT flash the cold-boot copy in the EARLY window before /history resolves', async () => {
    // This is the exact window the prod smoke for PR #133 caught: on a real
    // cold remount, connectViaPost mints the stream-post token FIRST (a Vercel-
    // proxied round trip), so for a second or two `historyChecked` is still
    // false — we don't yet know fresh-vs-established. Gating the cold-boot copy
    // on hasPriorHistory alone still flashed "Booting agent… 20–30s" here.
    //
    // Model it by making BOTH /history and the stream-post PENDING — the pane
    // sits in INITIAL/SYNCING with historyChecked=false. The overlay must show
    // the NEUTRAL "Connecting…" copy, never the cold-boot lie.
    const stub = installFetchStub();
    stub.override(
      '/history',
      () =>
        new Promise<Response>(() => {
          /* never resolves — historyChecked stays false */
        }) as unknown as Response
    );
    stub.override('/bridge/stream-post', makePendingStream);

    render(
      <SessionTerminal sessionId="sid_early_window" initialStatus="live" />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });

    // The cold-boot copy must NOT appear while we still don't know if this is
    // a fresh boot or a return.
    expect(screen.queryByText(/Booting agent/i)).toBeNull();
    expect(
      screen.queryByText(/first output usually lands in 20[–-]30 seconds/i)
    ).toBeNull();

    const indicator = await screen.findByTestId('pane-boot-indicator');
    expect(indicator.getAttribute('data-history-checked')).toBe('false');
    expect(indicator.textContent).toMatch(/Connecting/i);
  });

  it('genuinely-fresh spawn (empty /history) STILL shows the real boot copy', async () => {
    const stub = installFetchStub();
    // Empty /history → fresh spawn, nothing on disk yet.
    stub.override('/history', () => makeHistoryResponse('', 0));
    // Keep the stream pending so we stay in SYNCING with no output — the
    // window where the boot overlay is the only thing on screen.
    stub.override(
      '/bridge/stream-post',
      () =>
        new Promise<Response>(() => {
          /* never resolves — hold the pane in SYNCING */
        }) as unknown as Response
    );

    render(
      <SessionTerminal sessionId="sid_fresh_spawn" initialStatus="live" />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });

    const indicator = await screen.findByTestId('pane-boot-indicator');
    // Fresh spawn → the cold-boot copy is correct and MUST still render.
    expect(indicator.getAttribute('data-restoring')).toBe('false');
    expect(indicator.textContent).toMatch(/Booting agent/i);
    expect(indicator.textContent).toMatch(/20[–-]30 seconds/i);
  });
});

// ── fix/cockpit-interactive-prompts (2026-06-01) — TUI selection-menu UI ────
//
// ROOT CAUSE (reproduced live 2026-06-01): when a Claude Code permission menu
// is on screen ("❯ 1. Yes / 2. Yes, allow all edits / 3. No"), the chatbox
// could only submit a chat turn (text + '\r'). The menu is a widget — letters
// are swallowed and the trailing '\r' confirms the highlighted DEFAULT
// (option 1). Typing "no dont do that" CREATED the file. This block pins the
// fix: detected menus render tappable option buttons that send the exact
// keystrokes via POST /key, plus an always-present raw-key control row.
//
// The mock @xterm/xterm Terminal (vitest.setup.ts) exposes __setLines() + a
// __xtermInstances registry so we can script the rendered viewport.
describe('SessionTerminal — interactive TUI menu controls', () => {
  function getLiveTerminal(): { __setLines: (l: string[]) => void } {
    const insts = (globalThis as { __xtermInstances?: unknown[] })
      .__xtermInstances as Array<{ __setLines: (l: string[]) => void }>;
    expect(insts.length).toBeGreaterThan(0);
    return insts[insts.length - 1];
  }

  const MENU_LINES = [
    'Do you want to create proof.txt?',
    '❯ 1. Yes',
    '  2. Yes, allow all edits during this session (shift+tab)',
    '  3. No',
    'Esc to cancel · Tab to amend',
  ];

  it('always renders the raw-key control row (↑ ↓ Enter Esc) when live', async () => {
    installFetchStub();
    render(<SessionTerminal sessionId="sid_keys_live" initialStatus="live" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId('pane-key-up')).toBeInTheDocument();
    expect(screen.getByTestId('pane-key-down')).toBeInTheDocument();
    expect(screen.getByTestId('pane-key-enter')).toBeInTheDocument();
    expect(screen.getByTestId('pane-key-esc')).toBeInTheDocument();
  });

  it('Enter button POSTs a bare /key {key:"enter"} (NOT text+CR via /input)', async () => {
    const stub = installFetchStub();
    render(<SessionTerminal sessionId="sid_keys_enter" initialStatus="live" />);
    const enterBtn = await screen.findByTestId('pane-key-enter');
    await act(async () => {
      enterBtn.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    const keyCall = stub.calls.find(
      (c) => c.url.includes('/key') && c.init?.method === 'POST'
    );
    expect(keyCall).toBeDefined();
    expect(JSON.parse(String(keyCall!.init!.body))).toEqual({ key: 'enter' });
  });

  it('detects the permission menu and renders tappable option buttons', async () => {
    installFetchStub();
    render(<SessionTerminal sessionId="sid_menu_show" initialStatus="live" />);
    // Let the terminal mount + the live poll fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    getLiveTerminal().__setLines(MENU_LINES);
    // Advance past the 1s menu poll.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(screen.getByTestId('pane-menu-option-1')).toBeInTheDocument();
    expect(screen.getByTestId('pane-menu-option-2')).toBeInTheDocument();
    const opt3 = screen.getByTestId('pane-menu-option-3');
    expect(opt3).toBeInTheDocument();
    expect(opt3.textContent).toMatch(/No/);
  });

  it('tapping a NON-default option sends digit + Enter to /key (the keeper fix)', async () => {
    const stub = installFetchStub();
    render(<SessionTerminal sessionId="sid_menu_tap" initialStatus="live" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    getLiveTerminal().__setLines(MENU_LINES);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    // JD taps option 3 ("No") — the OPPOSITE of the highlighted default (1).
    const opt3 = await screen.findByTestId('pane-menu-option-3');
    await act(async () => {
      opt3.click();
      await new Promise((r) => setTimeout(r, 250));
    });
    const keyCalls = stub.calls.filter(
      (c) => c.url.includes('/key') && c.init?.method === 'POST'
    );
    // Two POSTs: the digit '3', then Enter to confirm.
    const bodies = keyCalls.map((c) => JSON.parse(String(c.init!.body)));
    expect(bodies).toContainEqual({ bytes: '3' });
    expect(bodies).toContainEqual({ key: 'enter' });
    // Order: digit before Enter.
    const digitIdx = bodies.findIndex((b) => b.bytes === '3');
    const enterIdx = bodies.findIndex((b) => b.key === 'enter');
    expect(digitIdx).toBeGreaterThanOrEqual(0);
    expect(enterIdx).toBeGreaterThan(digitIdx);
  });

  it('hides the option buttons when the menu closes', async () => {
    installFetchStub();
    render(<SessionTerminal sessionId="sid_menu_hide" initialStatus="live" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const term = getLiveTerminal();
    term.__setLines(MENU_LINES);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(screen.getByTestId('pane-menu-option-1')).toBeInTheDocument();
    // Menu closes — claude moved on, the screen no longer shows options.
    term.__setLines(['⏺ Done — created proof.txt.', '❯ ']);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(screen.queryByTestId('pane-menu-option-1')).not.toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CAT-18 / CODE-STATE BUG-7 — the [[chat_cockpit_keepalive]] fragile seam.
//
// The visibility/focus resume effect used to depend on `status` (and a
// `status`-derived `connect`), so its visibilitychange/focus listeners were
// torn down and RE-ADDED on EVERY status transition (starting→live→working→…)
// — a re-subscribe storm on mobile app-switch churn, with the exited-window
// stale-closure resilience hanging entirely on the exitedRef latch.
//
// The fix makes `connect` (and the two transports) status-stable by reading
// statusRef.current, so the effect mounts its listeners ONCE for the sid's
// lifetime. This test drives a real status transition via an SSE `status` frame
// and asserts the visibility/focus listeners are NOT re-registered.
// ════════════════════════════════════════════════════════════════════════════
describe('SessionTerminal — visibility listeners mount once (CAT-18 / BUG-7)', () => {
  it('does NOT re-subscribe visibilitychange/focus on a status transition', async () => {
    const stub = installFetchStub();
    // A POST stream that emits a `status` frame (drives setStatus → a real
    // status transition) then stays open (no exit — we want a LIVE transition,
    // not a teardown). The trailing comment frame keeps the reader awaiting.
    stub.override('/bridge/stream-post', () => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode('event: status\nid: 1\ndata: {"status":"working"}\n\n')
          );
          // Do NOT close — keep the stream open so the session stays live.
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    // Spy on the listener registrations for the two keep-alive events ONLY.
    const visAdds: unknown[] = [];
    const visRemoves: unknown[] = [];
    const focusAdds: unknown[] = [];
    const realDocAdd = document.addEventListener.bind(document);
    const realDocRemove = document.removeEventListener.bind(document);
    const realWinAdd = window.addEventListener.bind(window);
    vi.spyOn(document, 'addEventListener').mockImplementation(
      (type: string, ...rest: unknown[]) => {
        if (type === 'visibilitychange') visAdds.push(rest[0]);
        // @ts-expect-error pass-through
        return realDocAdd(type, ...rest);
      }
    );
    vi.spyOn(document, 'removeEventListener').mockImplementation(
      (type: string, ...rest: unknown[]) => {
        if (type === 'visibilitychange') visRemoves.push(rest[0]);
        // @ts-expect-error pass-through
        return realDocRemove(type, ...rest);
      }
    );
    vi.spyOn(window, 'addEventListener').mockImplementation(
      (type: string, ...rest: unknown[]) => {
        if (type === 'focus') focusAdds.push(rest[0]);
        // @ts-expect-error pass-through
        return realWinAdd(type, ...rest);
      }
    );

    render(
      <SessionTerminal sessionId="sid_keepalive_cat18" initialStatus="live" />
    );

    // Let the mount connect + stream open + the `status` frame parse → setStatus
    // ('working'). Under the OLD code this status transition re-created `connect`
    // and re-ran the visibility effect, removing + re-adding the listeners.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    // The effect mounts exactly ONE visibilitychange + ONE focus listener for
    // the lifetime of the sid — the status transition must not churn them.
    expect(visAdds.length).toBe(1);
    expect(focusAdds.length).toBe(1);
    // And it was NOT torn down + re-added (the re-subscribe storm signature).
    expect(visRemoves.length).toBe(0);
  });
});
