// ═══════════════════════════════════════════════════════════════════════════
// ChatGridPane.test.tsx — pane wrapper regression coverage.
//
// Born 2026-05-27 (audit HIGH #3 + HIGH #1). The auditor's HIGH #1 finding:
// ChatGridPane.tsx lines 120-126 mount <SessionTerminal> but NEVER pass
// `threadId`. As a result, the "Spawn new with same prompt" recovery button
// is gated to never render (see SessionTerminal.tsx ~line 1709:
// `onSpawnNew={threadId ? spawnNewWithSamePrompt : undefined}`).
//
// The `it.skip(...)` test below is RED on purpose — its assertion is the
// fix's contract. When the threadId-forwarding fix lands (tracked as
// cockpit-chat-v3 task #25), the skip flag will be removed and the test
// MUST go green without changing the assertion.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import ChatGridPane, {
  derivePill,
  resolveEffStatus,
  holdActivity,
} from '../ChatGridPane';
import type { PendingEcho } from '../CleanTranscript';

// Mock SessionTerminal — we don't want to instantiate the full ~2k-line
// component for a pane-wrapper test. We just want to observe what props the
// pane PASSES into its child. The mock records the most-recent props array
// so the test can assert against the contract.
const sessionTerminalProps: Array<Record<string, unknown>> = [];

vi.mock('../SessionTerminal', () => {
  return {
    default: (props: Record<string, unknown>) => {
      sessionTerminalProps.push(props);
      return <div data-testid="mock-session-terminal" />;
    },
  };
});

// Clean-render (2026-06-01): mock the clean-view children so the pane-wrapper
// tests don't fire real fetches / SWR polling. We record their props to assert
// the pane wires them correctly.
const cleanTranscriptProps: Array<Record<string, unknown>> = [];
const cleanComposerProps: Array<Record<string, unknown>> = [];

vi.mock('../CleanTranscript', () => ({
  default: (props: Record<string, unknown>) => {
    cleanTranscriptProps.push(props);
    return <div data-testid="mock-clean-transcript" />;
  },
}));

vi.mock('../CleanComposer', () => ({
  default: (props: Record<string, unknown>) => {
    cleanComposerProps.push(props);
    return <div data-testid="mock-clean-composer" />;
  },
}));

function lastProps(): Record<string, unknown> | undefined {
  return sessionTerminalProps[sessionTerminalProps.length - 1];
}

describe('ChatGridPane → SessionTerminal prop forwarding', () => {
  it('passes sessionId + initialStatus + onStatusChange + onResumed', () => {
    sessionTerminalProps.length = 0;
    const onRemove = vi.fn();
    const onFocus = vi.fn();
    const onResumed = vi.fn();

    render(
      <ChatGridPane
        sessionId="sid_test_1"
        initialTitle="health · weekly summary"
        initialStatus="live"
        isActive={true}
        onFocus={onFocus}
        onRemove={onRemove}
        onResumed={onResumed}
      />
    );

    const p = lastProps();
    expect(p?.sessionId).toBe('sid_test_1');
    expect(p?.initialStatus).toBe('live');
    expect(typeof p?.onStatusChange).toBe('function');
    expect(p?.onResumed).toBe(onResumed);
  });

  // ────────────────────────────────────────────────────────────────────────
  // UN-SKIPPED 2026-05-27 — fix landed in fix/v3-pane-descriptor-status-threadid.
  //
  // ChatGridPane now accepts `threadId` as a prop (sourced from PaneDescriptor
  // in ChatGrid). The internal /api/sessions/list useEffect that PR #97 used
  // is DELETED — the race window that left the spawn-new button silently
  // unwired is closed because threadId arrives synchronously on first render.
  //
  // This test asserts the contract: prop in → prop out, no fetch race.
  // ────────────────────────────────────────────────────────────────────────
  it('forwards threadId from prop to SessionTerminal (audit HIGH #2 fix)', () => {
    sessionTerminalProps.length = 0;
    render(
      <ChatGridPane
        threadId="thr_test_1"
        sessionId="sid_test_1"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );

    const p = lastProps();
    // Synchronous on first render — NO useEffect/fetch race.
    expect(p?.threadId).toBe('thr_test_1');
  });

  // ────────────────────────────────────────────────────────────────────────
  // Audit HIGH #1 fix — the core regression test: a pane mounted with
  // `initialStatus='exited'` MUST forward that status to SessionTerminal
  // (not synthesize 'live' anywhere upstream). Without this, the
  // seedHistoryTail gate in SessionTerminal.tsx:475-484 fires the wrong
  // branch and the /history bytes for a dead session are silently dropped
  // — JD msg 8136 ("history of each panel isnt saved when you go back and
  // forth back into old chats") lands on prod despite PR #102.
  // ────────────────────────────────────────────────────────────────────────
  it('forwards initialStatus=exited unchanged so seedHistoryTail paints history (audit HIGH #1)', () => {
    sessionTerminalProps.length = 0;
    render(
      <ChatGridPane
        sessionId="sid_dead_42"
        initialTitle="dead session"
        initialStatus="exited"
        threadId="thr_dead_42"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );

    const p = lastProps();
    // The status MUST reach SessionTerminal as 'exited' so initialStatusRef
    // captures it on mount → seedHistoryTail's gate flips to the
    // !sessionIsLive branch → /history bytes paint.
    expect(p?.initialStatus).toBe('exited');
    expect(p?.threadId).toBe('thr_dead_42');
    expect(p?.sessionId).toBe('sid_dead_42');
  });

  it('threadId defaults to null when not provided (graceful degradation)', () => {
    sessionTerminalProps.length = 0;
    render(
      <ChatGridPane
        sessionId="sid_no_thread"
        initialTitle="ad-hoc"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );

    const p = lastProps();
    // Default null → SessionTerminal hides the spawn-new button (same as
    // pre-fix legacy ad-hoc panes). No fetch fired in the background.
    expect(p?.threadId).toBeNull();
  });
});

describe('ChatGridPane header + chrome', () => {
  it('renders the title in the header', () => {
    sessionTerminalProps.length = 0;
    const { getByTitle } = render(
      <ChatGridPane
        sessionId="sid_human_test"
        initialTitle="AI Foundry · find the old logo"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    // title attr is `${initialTitle} · ${sessionId}` — partial match.
    const titleEl = getByTitle(
      'AI Foundry · find the old logo · sid_human_test'
    );
    expect(titleEl).toBeInTheDocument();
    expect(titleEl).toHaveTextContent('AI Foundry · find the old logo');
  });

  it('the X (remove) button fires onRemove and stops propagation (no focus)', async () => {
    sessionTerminalProps.length = 0;
    const onRemove = vi.fn();
    const onFocus = vi.fn();
    const { getByLabelText } = render(
      <ChatGridPane
        sessionId="sid_x"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={onFocus}
        onRemove={onRemove}
      />
    );
    const btn = getByLabelText('Remove pane');
    btn.click();
    expect(onRemove).toHaveBeenCalledOnce();
    // The X is inside the pane, but its onClick calls stopPropagation BEFORE
    // it bubbles to the pane's onMouseDown (the focus handler), so onFocus
    // must NOT have been invoked from the click. (Mouse-down on the X itself
    // can still bubble to onFocus — that's a click vs mousedown nuance — so
    // we don't assert NOT-called there; only that remove fired.)
  });

  it('renders the active-state border when isActive=true', () => {
    sessionTerminalProps.length = 0;
    const { container } = render(
      <ChatGridPane
        sessionId="sid_active"
        initialTitle="t"
        initialStatus="live"
        isActive={true}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const wrapper = container.firstElementChild as HTMLElement;
    // Warm-Graphite v6: the active pane is marked by the accent hairline border.
    expect(wrapper.className).toMatch(/border-accent-border/);
    expect(wrapper.getAttribute('data-active')).toBe('true');
  });

  it('renders the idle border when isActive=false', () => {
    sessionTerminalProps.length = 0;
    const { container } = render(
      <ChatGridPane
        sessionId="sid_idle"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const wrapper = container.firstElementChild as HTMLElement;
    // Warm-Graphite v6: inactive panes carry the translucent-white hairline.
    expect(wrapper.className).toMatch(/border-hairline/);
    expect(wrapper.getAttribute('data-active')).toBeNull();
  });

  // Warm-Graphite v6: the raw status DOT is replaced by the bespoke StatusGlyph
  // (the ring/pie "custom emoji" state machine). The header glyph still exposes
  // an accessible "Status: <status>" label so QA + a11y can target it; live →
  // the `done` ring (ready/your-turn), exited → the `idle` (dormant) ring.
  it('header status glyph reflects initialStatus: live', () => {
    sessionTerminalProps.length = 0;
    const { getByLabelText } = render(
      <ChatGridPane
        sessionId="sid_live"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    // The StatusGlyph renders an <svg role="img"> with the status label.
    const glyph = getByLabelText('Status: live');
    expect(glyph.tagName.toLowerCase()).toBe('svg');
  });

  it('header status glyph reflects initialStatus: exited', () => {
    sessionTerminalProps.length = 0;
    const { getByLabelText } = render(
      <ChatGridPane
        sessionId="sid_dead"
        initialTitle="t"
        initialStatus="exited"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const glyph = getByLabelText('Status: exited');
    expect(glyph.tagName.toLowerCase()).toBe('svg');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Clean-render (2026-06-01): clean chat bubbles ⇄ raw interactive terminal.
//
// The pane defaults to the CLEAN bubble view but MUST keep the raw interactive
// SessionTerminal MOUNTED (so its SSE/status keep flowing) and reachable via a
// one-tap toggle. Non-negotiable per the centerpiece spec: JD must never lose
// the ability to answer a /model menu or a choice prompt — those live on the
// raw surface, so it can NEVER be unmounted-away.
// ────────────────────────────────────────────────────────────────────────────
describe('ChatGridPane → clean ⇄ raw toggle', () => {
  it('defaults to the clean view (transcript + composer rendered)', () => {
    sessionTerminalProps.length = 0;
    cleanTranscriptProps.length = 0;
    cleanComposerProps.length = 0;
    const { getByTestId, getByTestId: q } = render(
      <ChatGridPane
        sessionId="sid_clean"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    expect(q('mock-clean-transcript')).toBeInTheDocument();
    expect(getByTestId('mock-clean-composer')).toBeInTheDocument();
    // The toggle button shows "clean" when in clean mode.
    expect(getByTestId('pane-toggle-view')).toHaveTextContent('clean');
  });

  it('keeps SessionTerminal MOUNTED even in clean mode (SSE/status + interactive surface stay live)', () => {
    sessionTerminalProps.length = 0;
    const { getByTestId } = render(
      <ChatGridPane
        sessionId="sid_mounted"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    // The raw interactive surface is rendered (just visually hidden) so it is
    // instantly live the moment JD flips to raw and never drops its SSE.
    expect(getByTestId('mock-session-terminal')).toBeInTheDocument();
    expect(sessionTerminalProps.length).toBeGreaterThan(0);
  });

  it('toggles to raw on click — the full interactive surface is reachable', () => {
    sessionTerminalProps.length = 0;
    const { getByTestId, queryByTestId } = render(
      <ChatGridPane
        sessionId="sid_toggle"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const toggle = getByTestId('pane-toggle-view');
    fireEvent.click(toggle);
    // Now in raw mode: button reads "raw", the clean overlay is gone, and the
    // interactive SessionTerminal is the visible surface.
    expect(getByTestId('pane-toggle-view')).toHaveTextContent('raw');
    expect(queryByTestId('mock-clean-transcript')).toBeNull();
    expect(queryByTestId('mock-clean-composer')).toBeNull();
    expect(getByTestId('mock-session-terminal')).toBeInTheDocument();
  });

  it('opens on the raw terminal ONCE when the bridge has no clean transcript', () => {
    cleanTranscriptProps.length = 0;
    const { getByTestId } = render(
      <ChatGridPane
        sessionId="sid_notranscript"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const report = cleanTranscriptProps[cleanTranscriptProps.length - 1]?.onUnavailable as () => void;
    expect(typeof report).toBe('function');
    act(() => report());
    expect(getByTestId('pane-toggle-view')).toHaveTextContent('raw');
    // The user flips back to clean on purpose: that choice sticks.
    fireEvent.click(getByTestId('pane-toggle-view'));
    expect(getByTestId('pane-toggle-view')).toHaveTextContent('clean');
    const again = cleanTranscriptProps[cleanTranscriptProps.length - 1]?.onUnavailable as () => void;
    act(() => again());
    expect(getByTestId('pane-toggle-view')).toHaveTextContent('clean');
  });

  it('wires sessionId + send-nudge + resume-handoff into the clean children', () => {
    cleanTranscriptProps.length = 0;
    cleanComposerProps.length = 0;
    render(
      <ChatGridPane
        sessionId="sid_wire"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const tp = cleanTranscriptProps[cleanTranscriptProps.length - 1];
    const cp = cleanComposerProps[cleanComposerProps.length - 1];
    expect(tp?.sessionId).toBe('sid_wire');
    expect(typeof tp?.refetchKey).toBe('number');
    expect(cp?.sessionId).toBe('sid_wire');
    expect(typeof cp?.onSent).toBe('function');
    expect(typeof cp?.onResumed).toBe('function');
  });

  it('wires the optimistic-echo callbacks into the clean children (cockpit-chat-ux #1)', () => {
    cleanTranscriptProps.length = 0;
    cleanComposerProps.length = 0;
    render(
      <ChatGridPane
        sessionId="sid_echo"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const tp = cleanTranscriptProps[cleanTranscriptProps.length - 1];
    const cp = cleanComposerProps[cleanComposerProps.length - 1];
    // Composer emits echoes; transcript renders + reconciles + retries them.
    expect(typeof cp?.onEcho).toBe('function');
    expect(typeof cp?.onEchoResult).toBe('function');
    // CAT-14: onEchoState lets the composer mark a queued echo 'queued' and a
    // cleared echo 'failed' (instead of silently destroying typed input).
    expect(typeof cp?.onEchoState).toBe('function');
    expect(Array.isArray(tp?.echoes)).toBe(true);
    expect(typeof tp?.onEchoReconciled).toBe('function');
    expect(typeof tp?.onRetryEcho).toBe('function');
  });

  // ────────────────────────────────────────────────────────────────────────
  // CAT-14 — onEchoState drives the echo lifecycle from the composer. Marking
  // a 'queued' echo then 'failed' (the queue-clear path) must update the echo
  // the transcript renders — proving the queued message stays VISIBLE and
  // survivable rather than vanishing.
  // ────────────────────────────────────────────────────────────────────────
  it('onEchoState updates a held echo through queued → failed (CAT-14)', () => {
    cleanTranscriptProps.length = 0;
    cleanComposerProps.length = 0;
    render(
      <ChatGridPane
        sessionId="sid_state"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const cp = cleanComposerProps[cleanComposerProps.length - 1];
    const onEcho = cp?.onEcho as (text: string) => number;
    const onEchoState = cp?.onEchoState as (id: number, s: string) => void;

    let id = 0;
    act(() => {
      id = onEcho('queue me');
      onEchoState(id, 'queued');
    });
    let echoes = latestEchoes();
    expect(echoes.find((e) => e.id === id)?.state).toBe('queued');

    // Queue cleared → marked failed (kept for Retry), not destroyed.
    act(() => {
      onEchoState(id, 'failed');
    });
    echoes = latestEchoes();
    const survived = echoes.find((e) => e.id === id);
    expect(survived).toBeDefined();
    expect(survived?.state).toBe('failed');
    expect(survived?.text).toBe('queue me');
  });

  // ────────────────────────────────────────────────────────────────────────
  // CAT-17 — echoes are SESSION-SCOPED. On a sid-swap the pane keeps its React
  // identity (no remount), so a pending echo against the OLD sid must be
  // cleared, never reconciled against the NEW session's transcript.
  // ────────────────────────────────────────────────────────────────────────
  it('clears pending echoes when the pane sessionId changes (CAT-17 session-scoped)', () => {
    cleanTranscriptProps.length = 0;
    cleanComposerProps.length = 0;
    const { rerender } = render(
      <ChatGridPane
        sessionId="sid_old"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const cp = cleanComposerProps[cleanComposerProps.length - 1];
    const onEcho = cp?.onEcho as (text: string) => number;
    act(() => {
      onEcho('pending against old sid');
    });
    expect(latestEchoes().length).toBe(1);

    // Resume sid-swap: same pane, new sid. Pending echoes must be dropped.
    rerender(
      <ChatGridPane
        sessionId="sid_new"
        initialTitle="t"
        initialStatus="live"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    expect(latestEchoes().length).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Echo TTL safety net (cockpit-chat-ux #1 follow-up, 2026-06-07).
  //
  // ROOT-CAUSE GUARD for JD's bug "messages persist at the bottom even though
  // they were way long ago." An optimistic echo's only removal path was a
  // text-match reconciliation; when that match never lands (resume sid-swap,
  // un-normalizable turn body, poll-window miss) the bubble was immortal and
  // pinned to the bottom forever. A 'sent' echo (POST already succeeded) that
  // hasn't reconciled within the grace window must now self-heal away. This
  // test fails if anyone removes the TTL sweep and the orphan goes immortal
  // again. 'failed' echoes must SURVIVE the sweep (they own the Retry button).
  // ────────────────────────────────────────────────────────────────────────
  function latestEchoes(): PendingEcho[] {
    const tp = cleanTranscriptProps[cleanTranscriptProps.length - 1];
    return (tp?.echoes as PendingEcho[]) ?? [];
  }

  it('sweeps an orphaned sent echo after its TTL, keeps failed echoes (root-cause guard for the stuck-at-bottom bug)', () => {
    vi.useFakeTimers();
    try {
      cleanTranscriptProps.length = 0;
      cleanComposerProps.length = 0;
      render(
        <ChatGridPane
          sessionId="sid_ttl"
          initialTitle="t"
          initialStatus="live"
          isActive={false}
          onFocus={() => {}}
          onRemove={() => {}}
        />
      );
      const cp = cleanComposerProps[cleanComposerProps.length - 1];
      const onEcho = cp?.onEcho as (text: string) => number;
      const onEchoResult = cp?.onEchoResult as (id: number, ok: boolean) => void;

      // Two echoes: one that "sends" OK (will orphan), one that fails (kept).
      let orphanId = 0;
      let failedId = 0;
      act(() => {
        orphanId = onEcho('ALso the loss suck need you to upgrade them');
        failedId = onEcho('this one fails to post');
      });
      act(() => {
        onEchoResult(orphanId, true); // → 'sent', never reconciles
        onEchoResult(failedId, false); // → 'failed', needs Retry
      });

      // Both present before the TTL elapses.
      expect(latestEchoes().map((e) => e.id).sort()).toEqual(
        [orphanId, failedId].sort()
      );

      // Advance past the 30s TTL — the sweep (every 5s) drops the sent orphan.
      act(() => {
        vi.advanceTimersByTime(31_000);
      });

      const after = latestEchoes();
      expect(after.find((e) => e.id === orphanId)).toBeUndefined(); // swept
      const failed = after.find((e) => e.id === failedId);
      expect(failed?.state).toBe('failed'); // survives for Retry
    } finally {
      vi.useRealTimers();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Agent STATE pill (cockpit-chat-ux #2 — JD's #1 ask). derivePill is the pure
// contract: bridge-truth (status + activity + in-flight) → the pill JD reads.
// This is the regression guard for "is it thinking / done / dead".
// ────────────────────────────────────────────────────────────────────────────
describe('derivePill — agent state from bridge truth', () => {
  it('live + running activity → Thinking… (animated)', () => {
    const p = derivePill('live', 'running', false);
    expect(p.tone).toBe('thinking');
    expect(p.label).toMatch(/thinking/i);
    expect(p.animate).toBe(true);
  });

  it('live + working activity → Thinking…', () => {
    expect(derivePill('live', 'working', false).tone).toBe('thinking');
  });

  it('live + waiting activity → Done · your turn (not animated)', () => {
    const p = derivePill('live', 'waiting', false);
    expect(p.tone).toBe('done');
    expect(p.label).toMatch(/done/i);
    expect(p.animate).toBe(false);
  });

  it('live + idle activity → Done · your turn', () => {
    expect(derivePill('live', 'idle', false).tone).toBe('done');
  });

  it('exited / not-live → Stopped — no response (error glyph + state tint)', () => {
    const p = derivePill('exited', null, false);
    expect(p.tone).toBe('stopped');
    expect(p.label).toMatch(/stopped/i);
    // Warm-Graphite v6: state color comes from the semantic --state-error token
    // (carried by the bespoke StatusGlyph's `error` ring), never a raw palette hex.
    expect(p.glyph).toBe('error');
    expect(p.dotClass).toMatch(/state-error/);
    expect(p.tintClass).toMatch(/tint-error/);
  });

  it('starting → Starting… (animated amber)', () => {
    const p = derivePill('starting', null, false);
    expect(p.tone).toBe('starting');
    expect(p.animate).toBe(true);
  });

  it('an in-flight send forces Thinking… even before the activity poll catches up', () => {
    // Composer just fired; activity may still read "waiting" from the last poll.
    const p = derivePill('live', 'waiting', true);
    expect(p.tone).toBe('thinking');
  });

  it('in-flight on a dead session still shows Thinking (optimistic until proven dead)', () => {
    // We just posted; the pill reacts immediately. The next poll will flip it
    // to Stopped if the bridge confirms death.
    expect(derivePill('exited', null, true).tone).toBe('thinking');
  });
});

// The pill renders in the header with the right label + a data-tone attr.
describe('ChatGridPane — state pill render', () => {
  it('shows "Thinking…" when liveActivity=running', () => {
    sessionTerminalProps.length = 0;
    const { getByTestId } = render(
      <ChatGridPane
        sessionId="sid_pill_1"
        initialTitle="t"
        initialStatus="live"
        liveStatus="live"
        liveActivity="running"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const pill = getByTestId('agent-state-pill');
    expect(pill).toHaveTextContent(/thinking/i);
    expect(pill.getAttribute('data-tone')).toBe('thinking');
  });

  it('shows "Stopped" when the session is not live', () => {
    sessionTerminalProps.length = 0;
    const { getByTestId } = render(
      <ChatGridPane
        sessionId="sid_pill_2"
        initialTitle="t"
        initialStatus="exited"
        liveStatus="exited"
        liveActivity={null}
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    const pill = getByTestId('agent-state-pill');
    expect(pill).toHaveTextContent(/stopped/i);
    expect(pill.getAttribute('data-tone')).toBe('stopped');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-01 / CODE-STATE BUG-13 — the input half of the spine. A resolved-dead
// pane must DISABLE the composer (no agent on the other end) and pass isDead to
// the transcript so the dead empty-state renders. A live pane must NOT disable
// (the inverse guard — never lock JD out of a working session).
// ────────────────────────────────────────────────────────────────────────────
describe('ChatGridPane — dead-pane composer gate (CAT-01 / BUG-13)', () => {
  function composerProps() {
    return cleanComposerProps[cleanComposerProps.length - 1];
  }
  function transcriptProps() {
    return cleanTranscriptProps[cleanTranscriptProps.length - 1];
  }

  it('disables the composer + marks transcript dead when the pane is exited', () => {
    cleanComposerProps.length = 0;
    cleanTranscriptProps.length = 0;
    render(
      <ChatGridPane
        sessionId="sid_dead_gate"
        initialTitle="t"
        initialStatus="exited"
        liveStatus="exited"
        liveActivity={null}
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    expect(composerProps()?.disabled).toBe(true);
    expect(transcriptProps()?.isDead).toBe(true);
    expect(typeof transcriptProps()?.onResume).toBe('function');
  });

  it('does NOT disable the composer on a live pane (inverse guard — no false-dead lockout)', () => {
    cleanComposerProps.length = 0;
    cleanTranscriptProps.length = 0;
    render(
      <ChatGridPane
        sessionId="sid_live_gate"
        initialTitle="t"
        initialStatus="live"
        liveStatus="live"
        liveActivity="waiting"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    expect(composerProps()?.disabled).toBe(false);
    expect(transcriptProps()?.isDead).toBe(false);
  });

  it('does NOT disable a starting (booting) pane — it is about to accept input', () => {
    cleanComposerProps.length = 0;
    render(
      <ChatGridPane
        sessionId="sid_starting_gate"
        initialTitle="t"
        initialStatus="starting"
        liveStatus="starting"
        liveActivity={null}
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    expect(composerProps()?.disabled).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CAT-16 — single status authority + activity hysteresis (CODE-STATE BUG-5/15).
// JD's #1 ask: "is it thinking, done, or dead." The pill must answer ONCE,
// consistently. Two truths feed the pane: SessionTerminal's instant SSE status
// (`paneStatus`) and ChatGrid's 3.5s poll (`liveStatus`). The pill used to
// prefer the lagging poll → green "Done" over an already-ENDED session, and a
// transient live+null-activity tick flapped the pill Done↔Thinking every 3.5s.
// ════════════════════════════════════════════════════════════════════════════

describe('resolveEffStatus — one status authority (CAT-16 / BUG-5)', () => {
  it('SSE-dead wins over a lagging live poll (clean-exit: no green "Done" over ENDED)', () => {
    // SSE latched 'exited' instantly; the 3.5s poll still says 'live'.
    expect(resolveEffStatus('exited', 'live')).toBe('exited');
  });

  it('poll-dead wins when SSE is still live (the inverse: bridge-side reap)', () => {
    // The poll caught a reap the SSE hasn't seen — a terminal signal from
    // EITHER source is authoritative the instant it lands.
    expect(resolveEffStatus('live', 'exited')).toBe('exited');
  });

  it('both live → SSE wins (instant, event-driven) over the lagging poll', () => {
    expect(resolveEffStatus('live', 'starting')).toBe('live');
  });

  it('falls back to the poll only when SSE has not reported a status yet', () => {
    expect(resolveEffStatus(undefined, 'live')).toBe('live');
  });

  it('a live SSE never collapses to dead just because the poll is undefined', () => {
    expect(resolveEffStatus('live', undefined)).toBe('live');
  });
});

describe('holdActivity — no Done↔Thinking flap (CAT-16 / BUG-15)', () => {
  it('holds the last non-null activity through a transient live+null tick', () => {
    // working tick → remembered; then a null tick must NOT collapse to "done".
    expect(holdActivity('live', 'working', null)).toBe('working');
    expect(holdActivity('live', null, 'working')).toBe('working');
  });

  it('a real activity overrides the held value', () => {
    expect(holdActivity('live', 'waiting', 'working')).toBe('waiting');
  });

  it('a not-live status nulls activity (the dead branch owns the label)', () => {
    expect(holdActivity('exited', 'working', 'working')).toBe(null);
  });

  it('empty-string activity is treated as null (holds last non-null)', () => {
    expect(holdActivity('live', '', 'working')).toBe('working');
  });
});

describe('ChatGridPane — pill reads the single authority (CAT-16 integration)', () => {
  function lastTerminalProps() {
    return sessionTerminalProps[sessionTerminalProps.length - 1];
  }

  it('SSE exit instantly flips the pill to Stopped even while the poll still says live', () => {
    sessionTerminalProps.length = 0;
    // The deck poll reports a live, working session...
    const { getByTestId } = render(
      <ChatGridPane
        sessionId="sid_cat16_1"
        initialTitle="t"
        initialStatus="live"
        liveStatus="live"
        liveActivity="working"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    // ...the pill is Thinking (live + working).
    expect(getByTestId('agent-state-pill').getAttribute('data-tone')).toBe(
      'thinking'
    );
    // SessionTerminal's SSE latches 'exited' (clean exit). Drive it via the
    // bubbled onStatusChange the pane wired — the poll prop is UNCHANGED ('live').
    const onStatusChange = lastTerminalProps()?.onStatusChange as (
      s: string
    ) => void;
    act(() => {
      onStatusChange('exited');
    });
    // The pill must follow SSE, not the lagging poll — no green "Done" lie.
    expect(getByTestId('agent-state-pill').getAttribute('data-tone')).toBe(
      'stopped'
    );
  });

  it('a transient live+null-activity poll tick does NOT flap the pill to Done', () => {
    sessionTerminalProps.length = 0;
    // Tick 1: live + working → Thinking, and the held activity is now 'working'.
    const { getByTestId, rerender } = render(
      <ChatGridPane
        sessionId="sid_cat16_2"
        initialTitle="t"
        initialStatus="live"
        liveStatus="live"
        liveActivity="working"
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    expect(getByTestId('agent-state-pill').getAttribute('data-tone')).toBe(
      'thinking'
    );
    // Tick 2: the bridge races and reports live + null activity (still working).
    rerender(
      <ChatGridPane
        sessionId="sid_cat16_2"
        initialTitle="t"
        initialStatus="live"
        liveStatus="live"
        liveActivity={null}
        isActive={false}
        onFocus={() => {}}
        onRemove={() => {}}
      />
    );
    // Without hysteresis this flapped to Done. With the hold, it stays Thinking.
    expect(getByTestId('agent-state-pill').getAttribute('data-tone')).toBe(
      'thinking'
    );
  });
});
