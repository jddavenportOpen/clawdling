// ═══════════════════════════════════════════════════════════════════════════
// CleanTranscript.test.tsx — clean chat-bubble rendering regression coverage.
//
// Centerpiece clean-render (2026-06-01). CleanTranscript reads the bridge's
// structured-transcript endpoint and renders normalized turns as clean bubbles
// (user / assistant / tool_use) instead of the raw terminal. We mock SWR so
// the test is deterministic (no real fetch / polling) and assert that each
// turn kind renders the right surface.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { TranscriptTurn, PendingEcho } from '../CleanTranscript';

// Mock SWR to feed a fixed transcript payload.
let swrData: unknown = undefined;
let swrError: unknown = undefined;
const mutate = vi.fn();

vi.mock('swr', () => ({
  default: () => ({
    data: swrData,
    error: swrError,
    isLoading: swrData === undefined && swrError === undefined,
    mutate,
  }),
}));

// MarkdownBubble pulls in react-markdown + prism — mock to a plain text node so
// this test stays a unit test of CleanTranscript's turn→surface mapping.
vi.mock('../MarkdownBubble', () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="md-bubble">{content}</div>
  ),
}));

vi.mock('../ToolCallCard', () => ({
  default: ({ name, input }: { name: string; input: unknown }) => (
    <div data-testid="tool-card">
      {name}:{String(input)}
    </div>
  ),
  // ToolRunGroup imports this named helper for the collapsed-header teaser.
  toolInlineSummary: (v: unknown) => String(v ?? ''),
}));

import CleanTranscript, {
  isPlumbingTurn,
  filterPlumbing,
} from '../CleanTranscript';

function payload(turns: TranscriptTurn[]) {
  return {
    sid: 'sid_x',
    cc_session_id: 'cc_x',
    exists: true,
    count: turns.length,
    turns,
  };
}

describe('CleanTranscript', () => {
  beforeEach(() => {
    swrData = undefined;
    swrError = undefined;
    mutate.mockReset();
  });

  it('renders a user turn as a right-aligned plain bubble (no markdown)', () => {
    swrData = payload([
      { kind: 'user', ts: '2026-06-01T10:00:00Z', id: 'u1', text: 'Hello there' },
    ]);
    const { getByText, queryByTestId } = render(
      <CleanTranscript sessionId="sid_x" pollMs={0} />
    );
    expect(getByText('Hello there')).toBeInTheDocument();
    // User text is NOT markdown-rendered (avoids escaping pasted code).
    expect(queryByTestId('md-bubble')).toBeNull();
  });

  it('renders an assistant turn through MarkdownBubble', () => {
    swrData = payload([
      { kind: 'assistant', ts: '2026-06-01T10:00:01Z', id: 'a1', text: '**Done**' },
    ]);
    const { getByTestId } = render(<CleanTranscript sessionId="sid_x" pollMs={0} />);
    expect(getByTestId('md-bubble')).toHaveTextContent('**Done**');
  });

  it('renders a tool_use turn as a ToolCallCard with the summarized input', () => {
    swrData = payload([
      {
        kind: 'tool_use',
        ts: '2026-06-01T10:00:02Z',
        id: 'tool_1',
        tool: { name: 'Bash', input_summary: 'ls -la state/' },
      },
    ]);
    const { getByTestId } = render(<CleanTranscript sessionId="sid_x" pollMs={0} />);
    const card = getByTestId('tool-card');
    expect(card).toHaveTextContent('Bash');
    expect(card).toHaveTextContent('ls -la state/');
  });

  it('shows an empty-state hint when the transcript exists but has no turns', () => {
    swrData = payload([]);
    const { getByText } = render(<CleanTranscript sessionId="sid_x" pollMs={0} />);
    expect(getByText(/No conversation yet/i)).toBeInTheDocument();
  });

  it('falls back to a raw-terminal hint when no structured transcript exists', () => {
    swrData = {
      sid: 'sid_x',
      cc_session_id: null,
      exists: false,
      count: 0,
      turns: [],
    };
    const { getByText } = render(<CleanTranscript sessionId="sid_x" pollMs={0} />);
    expect(getByText(/switch to the raw\s+terminal/i)).toBeInTheDocument();
  });

  // ── CAT-04: dead-session empty-state (Resume / Spawn-new, not a dead-end) ──
  it('renders a "session ended" empty-state with a Resume action on a dead 404 transcript', () => {
    // 404 from the transcript fetch → SWR error, no data. With isDead the pane
    // shows the recovery card, NOT the "switch to raw" dead-end (raw is also
    // empty on a dead sid).
    swrError = new Error('transcript 404');
    swrData = undefined;
    const onResume = vi.fn();
    const { getByText, getByTestId } = render(
      <CleanTranscript sessionId="sid_dead" pollMs={0} isDead onResume={onResume} />
    );
    expect(getByText(/this session has ended/i)).toBeInTheDocument();
    // The transient "switch to raw" message must NOT render for a dead pane.
    expect(
      document.body.textContent?.match(/couldn’t load the clean transcript/)
    ).toBeNull();
    getByTestId('clean-transcript-resume').click();
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('shows the dead empty-state instead of "switch to raw" when a dead session returns exists:false', () => {
    swrData = {
      sid: 'sid_x',
      cc_session_id: null,
      exists: false,
      count: 0,
      turns: [],
    };
    const { getByText } = render(
      <CleanTranscript sessionId="sid_dead2" pollMs={0} isDead onResume={() => {}} />
    );
    expect(getByText(/this session has ended/i)).toBeInTheDocument();
    expect(
      document.body.textContent?.match(/No structured transcript/)
    ).toBeNull();
  });

  it('a LIVE session with a transient transcript error still shows "switch to raw" (no false "ended")', () => {
    // Inverse guard: a transient flap on a live session is NOT a dead session.
    swrError = new Error('transcript 503');
    swrData = undefined;
    const { getByText } = render(
      <CleanTranscript sessionId="sid_live" pollMs={0} isDead={false} />
    );
    expect(getByText(/switch to the raw\s+terminal/i)).toBeInTheDocument();
    expect(document.body.textContent?.match(/this session has ended/i)).toBeNull();
  });

  // ── Optimistic echo (cockpit-chat-ux #1) ─────────────────────────────────
  it('renders a pending "sending" echo bubble', () => {
    swrData = payload([]);
    const echoes: PendingEcho[] = [
      { id: 1, text: 'spin up the report', state: 'sending', ts: Date.now() },
    ];
    const { getByText, getByTestId } = render(
      <CleanTranscript sessionId="sid_x" pollMs={0} echoes={echoes} />
    );
    expect(getByText('spin up the report')).toBeInTheDocument();
    expect(getByTestId('echo-bubble-sending')).toBeInTheDocument();
  });

  it('renders a failed echo with a retry button that calls onRetryEcho', () => {
    swrData = payload([]);
    const onRetryEcho = vi.fn();
    const echoes: PendingEcho[] = [
      { id: 7, text: 'try again', state: 'failed', ts: Date.now() },
    ];
    const { getByTestId } = render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        echoes={echoes}
        onRetryEcho={onRetryEcho}
      />
    );
    getByTestId('echo-bubble-failed');
    getByTestId('echo-retry-7').click();
    expect(onRetryEcho).toHaveBeenCalledWith(7, 'try again');
  });

  it('reconciles (drops) an echo once a matching real user turn lands', async () => {
    // The real user turn carries the same text the echo previewed → the parent
    // is told to drop the echo so JD's message isn't shown twice.
    swrData = payload([
      { kind: 'user', ts: null, id: 'u1', text: 'spin up the report' },
    ]);
    const onEchoReconciled = vi.fn();
    const echoes: PendingEcho[] = [
      { id: 1, text: 'spin up the report', state: 'sent', ts: Date.now() },
    ];
    render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        echoes={echoes}
        onEchoReconciled={onEchoReconciled}
      />
    );
    await waitFor(() => expect(onEchoReconciled).toHaveBeenCalledWith(1));
  });

  it('renders a delivered echo with the single-check ✓ delivered receipt', () => {
    // feat/read-receipts: 'sent' (2xx /input, verified-submit) reads as
    // DELIVERED — Telegram's single check. ✓✓ Read comes later on the
    // persisted bubble.
    swrData = payload([]);
    const echoes: PendingEcho[] = [
      { id: 4, text: 'deliver me', state: 'sent', ts: Date.now() },
    ];
    const { getByTestId } = render(
      <CleanTranscript sessionId="sid_x" pollMs={0} echoes={echoes} />
    );
    expect(getByTestId('echo-bubble-sent')).toBeInTheDocument();
    expect(getByTestId('receipt-delivered')).toBeInTheDocument();
    expect(getByTestId('receipt-delivered').textContent).toContain('delivered');
  });

  it('shows ✓✓ Read under the real user turn once its echo reconciles', async () => {
    // feat/read-receipts (JD: "say read when the agent sees it like
    // telegram"): the reconcile moment — the user turn exists in the agent's
    // own JSONL — IS the read event. The receipt renders under the PERSISTED
    // bubble that replaced the optimistic echo.
    swrData = payload([
      { kind: 'user', ts: null, id: 'u9', text: 'mark me read' },
    ]);
    const onEchoReconciled = vi.fn();
    const echoes: PendingEcho[] = [
      { id: 9, text: 'mark me read', state: 'sent', ts: Date.now() },
    ];
    const { getByTestId } = render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        echoes={echoes}
        onEchoReconciled={onEchoReconciled}
      />
    );
    await waitFor(() => expect(onEchoReconciled).toHaveBeenCalledWith(9));
    await waitFor(() =>
      expect(getByTestId('receipt-read')).toBeInTheDocument()
    );
    expect(getByTestId('receipt-read').textContent).toContain('Read');
  });

  it('shows NO read receipt on a user turn that never had an echo (history)', () => {
    // Session-local semantics: pre-existing transcript turns (page reload,
    // other-device sends) carry no ✓✓ — exactly like a fresh Telegram login.
    swrData = payload([
      { kind: 'user', ts: null, id: 'u1', text: 'old message' },
    ]);
    const { queryByTestId } = render(
      <CleanTranscript sessionId="sid_x" pollMs={0} echoes={[]} />
    );
    expect(queryByTestId('receipt-read')).toBeNull();
  });

  it('does NOT reconcile a failed echo (kept for retry)', async () => {
    swrData = payload([
      { kind: 'user', ts: null, id: 'u1', text: 'do the thing' },
    ]);
    const onEchoReconciled = vi.fn();
    const echoes: PendingEcho[] = [
      { id: 2, text: 'do the thing', state: 'failed', ts: Date.now() },
    ];
    render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        echoes={echoes}
        onEchoReconciled={onEchoReconciled}
      />
    );
    // Give the reconciliation effect a tick; it must NOT fire for a failed echo.
    await new Promise((r) => setTimeout(r, 30));
    expect(onEchoReconciled).not.toHaveBeenCalled();
  });

  it('matches an echo with attachment labels against a plain real user turn', async () => {
    // Echo previews "📎 file.pdf\nanalyze this"; the recorded user turn is just
    // the body. normForMatch strips the attachment line so they still match.
    swrData = payload([
      { kind: 'user', ts: null, id: 'u1', text: 'analyze this' },
    ]);
    const onEchoReconciled = vi.fn();
    const echoes: PendingEcho[] = [
      { id: 3, text: '📎 file.pdf\nanalyze this', state: 'sent', ts: Date.now() },
    ];
    render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        echoes={echoes}
        onEchoReconciled={onEchoReconciled}
      />
    );
    await waitFor(() => expect(onEchoReconciled).toHaveBeenCalledWith(3));
  });

  // ── CAT-17: 1:1 echo↔turn pairing (duplicate-text correctness) ────────────
  it('reconciles ONLY ONE of two duplicate-text echoes when only ONE real turn exists', async () => {
    // Send "ok" twice. The agent's JSONL has recorded only the FIRST so far.
    // The old Set-based reconcile dropped BOTH echoes the instant one turn
    // landed (losing a bubble before its turn persisted). 1:1 pairing consumes
    // the single turn for the oldest echo and KEEPS the second echo until its
    // own turn lands.
    swrData = payload([{ kind: 'user', ts: null, id: 'u1', text: 'ok' }]);
    const onEchoReconciled = vi.fn();
    const echoes: PendingEcho[] = [
      { id: 1, text: 'ok', state: 'sent', ts: Date.now() },
      { id: 2, text: 'ok', state: 'sent', ts: Date.now() + 1 },
    ];
    render(
      <CleanTranscript
        sessionId="sid_dup"
        pollMs={0}
        echoes={echoes}
        onEchoReconciled={onEchoReconciled}
      />
    );
    // Exactly one reconcile fires, and it's the OLDEST echo (id 1).
    await waitFor(() => expect(onEchoReconciled).toHaveBeenCalledWith(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(onEchoReconciled).toHaveBeenCalledTimes(1);
    expect(onEchoReconciled).not.toHaveBeenCalledWith(2);
  });

  it('reconciles BOTH duplicate-text echoes once BOTH real turns land (1:1)', async () => {
    // Now the JSONL has both "ok" turns → each echo pairs with one turn.
    swrData = payload([
      { kind: 'user', ts: null, id: 'u1', text: 'ok' },
      { kind: 'user', ts: null, id: 'u2', text: 'ok' },
    ]);
    const reconciled: number[] = [];
    const onEchoReconciled = vi.fn((id: number) => reconciled.push(id));
    const echoes: PendingEcho[] = [
      { id: 1, text: 'ok', state: 'sent', ts: Date.now() },
      { id: 2, text: 'ok', state: 'sent', ts: Date.now() + 1 },
    ];
    render(
      <CleanTranscript
        sessionId="sid_dup2"
        pollMs={0}
        echoes={echoes}
        onEchoReconciled={onEchoReconciled}
      />
    );
    await waitFor(() => expect(reconciled.sort()).toEqual([1, 2]));
  });

  it('does NOT reconcile a "queued" echo (it has not been sent yet)', async () => {
    // A 'queued' echo (CAT-14) is still waiting its FIFO turn — no /input has
    // fired, so no JSONL turn can correspond to it. It must never reconcile
    // against a coincidentally-identical real turn from an earlier send.
    swrData = payload([{ kind: 'user', ts: null, id: 'u1', text: 'same text' }]);
    const onEchoReconciled = vi.fn();
    const echoes: PendingEcho[] = [
      { id: 5, text: 'same text', state: 'queued', ts: Date.now() },
    ];
    render(
      <CleanTranscript
        sessionId="sid_queued"
        pollMs={0}
        echoes={echoes}
        onEchoReconciled={onEchoReconciled}
      />
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(onEchoReconciled).not.toHaveBeenCalled();
  });

  it('renders a "queued" echo bubble (visible while it waits — CAT-14)', () => {
    swrData = payload([]);
    const echoes: PendingEcho[] = [
      { id: 8, text: 'waiting my turn', state: 'queued', ts: Date.now() },
    ];
    const { getByText, getByTestId } = render(
      <CleanTranscript sessionId="sid_x" pollMs={0} echoes={echoes} />
    );
    expect(getByText('waiting my turn')).toBeInTheDocument();
    expect(getByTestId('echo-bubble-queued')).toBeInTheDocument();
  });

  it('collapses consecutive tool calls into one "N commands" run group', () => {
    // A burst of 3 Bash calls in a row must NOT render 3 fat cards — they fold
    // into a single collapsible run so the agent's text stays readable.
    swrData = payload([
      { kind: 'assistant', ts: null, id: 'a1', text: 'shipping' },
      { kind: 'tool_use', ts: null, id: 't1', tool: { name: 'Bash', input_summary: 'git add -A' } },
      { kind: 'tool_use', ts: null, id: 't2', tool: { name: 'Bash', input_summary: 'git commit -m x' } },
      { kind: 'tool_use', ts: null, id: 't3', tool: { name: 'Bash', input_summary: 'git push' } },
    ]);
    const { getByTestId, queryAllByTestId } = render(
      <CleanTranscript sessionId="sid_x" pollMs={0} />
    );
    const group = getByTestId('tool-run-group');
    expect(group.getAttribute('data-tool-count')).toBe('3');
    expect(group).toHaveTextContent('3 commands');
    // Collapsed by default → the (mocked) individual cards aren't mounted.
    expect(queryAllByTestId('tool-card')).toHaveLength(0);
    // The agent's text is still rendered above the collapsed run.
    expect(getByTestId('md-bubble')).toHaveTextContent('shipping');
  });

  it('renders a lone tool call as a single inline card (not a group)', () => {
    swrData = payload([
      { kind: 'tool_use', ts: null, id: 't1', tool: { name: 'Read', input_summary: 'a.ts' } },
    ]);
    const { getByTestId, queryByTestId } = render(
      <CleanTranscript sessionId="sid_x" pollMs={0} />
    );
    expect(queryByTestId('tool-run-group')).toBeNull();
    expect(getByTestId('tool-card')).toHaveTextContent('Read');
  });

  it('renders a mixed conversation in order (user → assistant → tool)', () => {
    swrData = payload([
      { kind: 'user', ts: null, id: 'u1', text: 'do the thing' },
      { kind: 'assistant', ts: null, id: 'a1', text: 'on it' },
      {
        kind: 'tool_use',
        ts: null,
        id: 't1',
        tool: { name: 'Read', input_summary: '/etc/hosts' },
      },
    ]);
    const { getByText, getByTestId } = render(
      <CleanTranscript sessionId="sid_x" pollMs={0} />
    );
    expect(getByText('do the thing')).toBeInTheDocument();
    expect(getByTestId('md-bubble')).toHaveTextContent('on it');
    expect(getByTestId('tool-card')).toHaveTextContent('Read');
  });

  // ── AskUserQuestion (feat/cockpit-askuserquestion) ───────────────────────
  const askTurn = (
    id: string,
    overrides: Partial<TranscriptTurn['tool']> = {}
  ): TranscriptTurn => ({
    kind: 'tool_use',
    ts: null,
    id,
    tool: {
      name: 'AskUserQuestion',
      input_summary: 'What time do you actually wake up?',
      ask: {
        questions: [
          {
            header: 'Wake time',
            question: 'What time do you actually wake up?',
            multiSelect: false,
            options: [
              { label: '6:00', description: 'early' },
              { label: '7:00', description: 'standard' },
            ],
          },
        ],
      },
      answer: null,
      ...overrides,
    },
  });

  it('renders an AskUserQuestion as a question card, NOT a raw tool card', () => {
    swrData = payload([askTurn('ask1')]);
    const { getByTestId, queryByTestId, getByText } = render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        liveStatus="live"
        liveActivity="waiting"
      />
    );
    // It's the AskUserQuestion card, never the generic ToolCallCard / run group.
    expect(getByTestId('ask-card')).toBeInTheDocument();
    expect(queryByTestId('tool-card')).toBeNull();
    expect(queryByTestId('tool-run-group')).toBeNull();
    // Header + question render in plain text; options are buttons.
    expect(getByText('Wake time')).toBeInTheDocument();
    expect(getByText('What time do you actually wake up?')).toBeInTheDocument();
    expect(getByTestId('ask-option-1')).toHaveTextContent('6:00');
    expect(getByTestId('ask-option-2')).toHaveTextContent('7:00');
  });

  it('shows the LIVE "needs your answer" state when the agent is waiting', () => {
    swrData = payload([askTurn('ask1')]);
    const { getByTestId } = render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        liveStatus="live"
        liveActivity="waiting"
      />
    );
    expect(getByTestId('ask-card')).toHaveAttribute('data-state', 'needs-answer');
    expect(getByTestId('ask-needs-answer')).toBeInTheDocument();
  });

  it('renders an ANSWERED question read-only with the chosen answer', () => {
    swrData = payload([askTurn('ask1', { answer: '7:00' })]);
    const { getByTestId } = render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        liveStatus="live"
        liveActivity="waiting"
      />
    );
    expect(getByTestId('ask-card')).toHaveAttribute('data-state', 'answered');
    expect(getByTestId('ask-answer')).toHaveTextContent('7:00');
  });

  it('renders an unanswered-but-no-longer-live question as "defaulted"', () => {
    // A later assistant turn means the agent moved on → not the live prompt.
    swrData = payload([
      askTurn('ask1'),
      { kind: 'assistant', ts: null, id: 'a9', text: 'moving on' },
    ]);
    const { getByTestId } = render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        liveStatus="live"
        liveActivity="waiting"
      />
    );
    expect(getByTestId('ask-card')).toHaveAttribute('data-state', 'defaulted');
    expect(getByTestId('ask-answer')).toHaveTextContent('defaulted');
  });

  it('stays LIVE even when bridge activity reports "working" (parked on prompt)', () => {
    // cockpit-ask-working-gate: while Claude Code is parked on an
    // AskUserQuestion prompt the bridge reports activity='working' (the menu
    // render churns the PTY). The card must NOT gate on that — an unanswered
    // ask as the last turn of a live session IS the prompt, so it must remain
    // answerable. Previously this asserted 'defaulted' and JD couldn't select.
    swrData = payload([askTurn('ask1')]);
    const { getByTestId } = render(
      <CleanTranscript
        sessionId="sid_x"
        pollMs={0}
        liveStatus="live"
        liveActivity="working"
      />
    );
    expect(getByTestId('ask-card')).toHaveAttribute('data-state', 'needs-answer');
    expect(getByTestId('ask-needs-answer')).toBeInTheDocument();
  });

  // ── Plumbing filter (cockpit-batch-a FIX 3) ──────────────────────────────
  describe('plumbing filter — pure detection', () => {
    const t = (text: string, kind: TranscriptTurn['kind'] = 'user'): TranscriptTurn =>
      ({ kind, ts: null, id: 'x', text });

    it('detects every plumbing marker class', () => {
      expect(isPlumbingTurn(t('<task-notification>bg task done</task-notification>'))).toBe(true);
      expect(isPlumbingTurn(t('<local-command-caveat>caveat text</local-command-caveat>'))).toBe(true);
      expect(isPlumbingTurn(t('<command-name>/compact</command-name>'))).toBe(true);
      expect(isPlumbingTurn(t('<command-message>compact</command-message>'))).toBe(true);
      expect(isPlumbingTurn(t('<local-command-stdout>compaction summary…</local-command-stdout>'))).toBe(true);
      expect(isPlumbingTurn(t('No response requested.'))).toBe(true);
      expect(isPlumbingTurn(t('no response requested'))).toBe(true);
    });

    it('does NOT drop real conversation that merely mentions a marker word', () => {
      // A real message that talks about /compact or "no response" stays.
      expect(isPlumbingTurn(t('can you run /compact for me?'))).toBe(false);
      expect(isPlumbingTurn(t('No response from the API — should we retry?'))).toBe(false);
      expect(isPlumbingTurn(t('Here is the <task-notification> tag explained inline.'))).toBe(false);
    });

    it('never drops tool_use turns (those are real tool cards)', () => {
      expect(
        isPlumbingTurn({
          kind: 'tool_use',
          ts: null,
          id: 't',
          tool: { name: 'Bash', input_summary: 'ls' },
        })
      ).toBe(false);
    });

    it('filterPlumbing keeps real turns and drops only the noise', () => {
      const kept = filterPlumbing([
        { kind: 'user', ts: null, id: 'u1', text: 'real question' },
        { kind: 'assistant', ts: null, id: 'a1', text: '<task-notification>done</task-notification>' },
        { kind: 'assistant', ts: null, id: 'a2', text: 'real answer' },
        { kind: 'user', ts: null, id: 'u2', text: 'No response requested.' },
      ]);
      expect(kept.map((x) => x.id)).toEqual(['u1', 'a2']);
    });
  });

  it('hides plumbing turns from the rendered transcript but keeps real ones', () => {
    swrData = payload([
      { kind: 'user', ts: null, id: 'u1', text: 'do the thing' },
      {
        kind: 'assistant',
        ts: null,
        id: 'noise1',
        text: '<task-notification>background task completed</task-notification>',
      },
      { kind: 'assistant', ts: null, id: 'a1', text: 'on it' },
      { kind: 'user', ts: null, id: 'noise2', text: 'No response requested.' },
    ]);
    const { getByText, getByTestId, queryByText } = render(
      <CleanTranscript sessionId="sid_x" pollMs={0} />
    );
    // Real turns survive.
    expect(getByText('do the thing')).toBeInTheDocument();
    expect(getByTestId('md-bubble')).toHaveTextContent('on it');
    // Plumbing is gone — the raw XML / sentinel never appears.
    expect(queryByText(/task-notification/)).toBeNull();
    expect(queryByText('No response requested.')).toBeNull();
  });
});
