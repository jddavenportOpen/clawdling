// ═══════════════════════════════════════════════════════════════════════════
// CleanComposer.test.tsx — composer min-height regression (cockpit-batch-a FIX 1).
//
// The composer textarea rendered clipped (zero-height) on a fresh-chat first
// paint because the auto-grow measurement raced the layout. The robust fix is a
// CSS `min-height` FLOOR that the auto-grow's inline height can never push below
// — so the box is full-height from frame one regardless of JS timing. This test
// asserts the floor is present on the textarea so the fix can't silently regress.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

// VoiceRecorder pulls in the MediaRecorder/Web Audio stack — mock to a stub so
// this stays a unit test of the textarea's layout floor.
vi.mock('../VoiceRecorder', () => ({
  default: () => <div data-testid="voice-recorder-stub" />,
}));

import CleanComposer, { COMPOSER_MIN_H } from '../CleanComposer';

describe('CleanComposer — min-height floor (FIX 1)', () => {
  it('exports a non-empty min-height constant', () => {
    expect(typeof COMPOSER_MIN_H).toBe('string');
    expect(COMPOSER_MIN_H.length).toBeGreaterThan(0);
    // It must resolve to a positive length (rem/px), never 0.
    expect(COMPOSER_MIN_H).not.toMatch(/^0(\D|$)/);
  });

  it('applies the min-height floor to the textarea so it can never clip', () => {
    const { getByTestId } = render(<CleanComposer sessionId="sid_x" />);
    const ta = getByTestId('clean-composer-input') as HTMLTextAreaElement;
    // The floor is set inline (un-purgeable + deterministic to read).
    expect(ta.style.minHeight).toBe(COMPOSER_MIN_H);
  });

  it('renders the textarea + send affordance on first paint (no click needed)', () => {
    const { getByTestId } = render(<CleanComposer sessionId="sid_x" />);
    // Both the input and the send button are present immediately — the box is
    // not gated behind a focus/measure pass.
    expect(getByTestId('clean-composer-input')).toBeInTheDocument();
    expect(getByTestId('clean-composer-send')).toBeInTheDocument();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-01 / BUG-13 — the `disabled` prop (passed by ChatGridPane on a resolved-
// dead pane) must actually lock the input + send so JD can't type into a void.
// ────────────────────────────────────────────────────────────────────────────
describe('CleanComposer — disabled gate (CAT-01 / BUG-13)', () => {
  it('disables the textarea and send button when disabled=true', () => {
    const { getByTestId } = render(
      <CleanComposer sessionId="sid_dead" disabled />
    );
    expect(
      (getByTestId('clean-composer-input') as HTMLTextAreaElement).disabled
    ).toBe(true);
    expect(
      (getByTestId('clean-composer-send') as HTMLButtonElement).disabled
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-03 — a send to a dead/reaped session 404s on /input. The error surfaced
// to JD must be HUMANIZED ("This session has ended…"), NOT the raw HTTP body
// `404: {"error":"Session not found"}`.
// ────────────────────────────────────────────────────────────────────────────
describe('CleanComposer — humanized dead-session send error (CAT-03)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('shows a plain-English ended message on a 404 /input, not the raw JSON body', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response('{"error":"Session not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    );
    // @ts-expect-error install mock
    globalThis.fetch = fetchSpy;

    const { getByTestId, findByText } = render(
      <CleanComposer sessionId="sid_reaped" />
    );
    const ta = getByTestId('clean-composer-input') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello?' } });
    fireEvent.click(getByTestId('clean-composer-send'));

    // The humanized copy renders; the raw status/JSON body never does.
    const msg = await findByText(/this session has ended/i);
    expect(msg).toBeInTheDocument();
    await waitFor(() => {
      expect(msg.textContent).not.toMatch(/404/);
      expect(msg.textContent).not.toMatch(/Session not found/);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-10 — autoFocus is DESKTOP-ONLY. On a phone, focusing the textarea on mount
// pops the soft keyboard before JD reads anything (and pre-CAT-07 shoves the
// composer under the keyboard). The gate reads matchMedia('(min-width:768px)')
// once at mount.
// ────────────────────────────────────────────────────────────────────────────
describe('CleanComposer — desktop-only autoFocus (CAT-10)', () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  function stubMatchMedia(isDesktop: boolean) {
    // Match the min-width:768px query to the desired surface; everything else
    // false. The component only queries the one breakpoint.
    window.matchMedia = ((query: string) => ({
      matches: /min-width:\s*768px/.test(query) ? isDesktop : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  // NB: React applies `autoFocus` imperatively (it calls .focus() on mount and
  // does NOT reflect the `autofocus` IDL attribute), so we assert on which
  // element actually holds focus after render — the user-observable behavior.
  it('does NOT auto-focus the textarea on a phone (keyboard stays down)', () => {
    stubMatchMedia(false);
    const { getByTestId } = render(<CleanComposer sessionId="sid_mobile" />);
    const ta = getByTestId('clean-composer-input') as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(ta);
  });

  it('auto-focuses the textarea on desktop (≥768px)', () => {
    stubMatchMedia(true);
    const { getByTestId } = render(<CleanComposer sessionId="sid_desktop" />);
    const ta = getByTestId('clean-composer-input') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(ta);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-13 — queue-drain double-send race. The drain effect must consult the
// SYNCHRONOUS inFlightRef, not just the async `sending` state, so two queued
// items can never fire concurrent /input POSTs (interleaving text+\r into one
// garbled TUI line). Each queued message must drain EXACTLY ONCE, in order.
// ────────────────────────────────────────────────────────────────────────────
describe('CleanComposer — queue drain double-send guard (CAT-13)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('fires exactly ONE /input POST per message and preserves FIFO order under rapid sends', async () => {
    // Gate every /input behind a manually-resolved promise so we control the
    // in-flight window precisely and can stack up the queue while one send is
    // unresolved — exactly the race window the bug lived in.
    const gates: Array<ReturnType<typeof deferred<Response>>> = [];
    const sentBodies: string[] = [];
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
      sentBodies.push(String(init?.body ?? ''));
      const g = deferred<Response>();
      gates.push(g);
      return g.promise;
    });
    // @ts-expect-error install mock
    globalThis.fetch = fetchSpy;

    const { getByTestId } = render(<CleanComposer sessionId="sid_q" />);
    const ta = getByTestId('clean-composer-input') as HTMLTextAreaElement;
    const send = getByTestId('clean-composer-send');

    // First send starts in flight (gate 0 open). The next two are queued while
    // it's unresolved.
    fireEvent.change(ta, { target: { value: 'one' } });
    fireEvent.click(send);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    fireEvent.change(ta, { target: { value: 'two' } });
    fireEvent.click(send);
    fireEvent.change(ta, { target: { value: 'three' } });
    fireEvent.click(send);

    // Still only ONE POST in flight — the two queued items have NOT fired.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Resolve send #1 → drains exactly one (two), not both.
    gates[0].resolve(new Response('{}', { status: 200 }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    // Critically: it did NOT jump to 3 — no concurrent double-drain.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    gates[1].resolve(new Response('{}', { status: 200 }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));

    gates[2].resolve(new Response('{}', { status: 200 }));
    // Each message sent once, in FIFO order, with the submit \r.
    await waitFor(() => expect(sentBodies.length).toBe(3));
    expect(sentBodies[0]).toContain('one');
    expect(sentBodies[1]).toContain('two');
    expect(sentBodies[2]).toContain('three');
    // No body sent twice (no double-send).
    expect(new Set(sentBodies).size).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-14 — the "clear" button must NOT silently destroy queued input. Queued
// messages echo immediately (state 'queued', visible), and clear marks them
// 'failed' (kept on screen with Retry) instead of vanishing.
// ────────────────────────────────────────────────────────────────────────────
describe('CleanComposer — queue clear does not silently destroy input (CAT-14)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function neverResolves() {
    // Keep send #1 in flight forever so #2 stays queued.
    return new Promise<Response>(() => {});
  }

  it('echoes a queued message immediately as "queued" and marks it "failed" on clear', async () => {
    const fetchSpy = vi.fn(() => neverResolves());
    // @ts-expect-error install mock
    globalThis.fetch = fetchSpy;

    // Track the echo lifecycle the parent would see.
    const echoEvents: Array<{ id: number; state: string }> = [];
    let nextId = 0;
    const onEcho = vi.fn((_text: string) => {
      nextId += 1;
      echoEvents.push({ id: nextId, state: 'sending' });
      return nextId;
    });
    const onEchoState = vi.fn((id: number, state: string) => {
      echoEvents.push({ id, state });
    });

    const { getByTestId, queryByTestId } = render(
      <CleanComposer
        sessionId="sid_clear"
        onEcho={onEcho}
        onEchoState={onEchoState}
      />
    );
    const ta = getByTestId('clean-composer-input') as HTMLTextAreaElement;
    const send = getByTestId('clean-composer-send');

    // Send #1 — goes in flight (never resolves).
    fireEvent.change(ta, { target: { value: 'first' } });
    fireEvent.click(send);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // Send #2 — QUEUED behind #1. It must get an echo immediately, marked
    // 'queued' (visible the whole time it waits — not an invisible string).
    fireEvent.change(ta, { target: { value: 'queued message' } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(
        echoEvents.some((e) => e.state === 'queued')
      ).toBe(true)
    );
    // The queue pill + clear button are present.
    expect(getByTestId('clean-composer-clear-queue')).toBeInTheDocument();

    // Tap clear. The queued echo must be marked 'failed' (Retry affordance),
    // NEVER silently dropped.
    fireEvent.click(getByTestId('clean-composer-clear-queue'));
    await waitFor(() =>
      expect(
        echoEvents.some((e) => e.state === 'failed')
      ).toBe(true)
    );
    // The queue is now empty (pill gone) but the message survived as a failed
    // echo the parent still holds — not destroyed without a trace.
    await waitFor(() =>
      expect(queryByTestId('clean-composer-clear-queue')).toBeNull()
    );
  });
});
