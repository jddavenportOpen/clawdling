// ═══════════════════════════════════════════════════════════════════════════
// AskUserQuestionCard.test.tsx — the answerable-question card + answer routing.
//
// feat/cockpit-askuserquestion (2026-06-02). Guards both halves of the fix:
//   (a) render — single-select buttons, multiSelect checkboxes + Submit,
//       "Other / type your own", needs-answer vs answered/defaulted states.
//   (b) answer-routing (the critical half) — tapping an option POSTs the exact
//       keys to /api/sessions/<sid>/key (digit + Enter), multiSelect POSTs
//       digit+space per checked + a final Enter, and custom text POSTs to
//       /input. These are the SAME bridge endpoints the /model choice buttons
//       use — verified here so the answer actually lands on the live prompt.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import AskUserQuestionCard, {
  singleSelectKeys,
  multiSelectKeys,
} from '../AskUserQuestionCard';
import type { AskPayload } from '../CleanTranscript';

const single: AskPayload = {
  questions: [
    {
      header: 'Wake time',
      question: 'What time do you actually wake up?',
      multiSelect: false,
      options: [
        { label: '6:00', description: 'early' },
        { label: '7:00', description: 'standard' },
        { label: '8:00', description: 'slow' },
      ],
    },
  ],
};

const multi: AskPayload = {
  questions: [
    {
      header: 'Domains',
      question: 'Which domains should I include?',
      multiSelect: true,
      options: [
        { label: 'Health', description: '' },
        { label: 'Family', description: '' },
        { label: 'Work', description: '' },
      ],
    },
  ],
};

// Capture every fetch call so we can assert URL + body precisely.
type Call = { url: string; body: unknown };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return { ok: true, status: 200, text: async () => '{}' } as Response;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('keystroke builders', () => {
  it('single-select → digit + Enter (routes by absolute option number)', () => {
    expect(singleSelectKeys(2)).toEqual([{ bytes: '2' }, { key: 'enter' }]);
  });
  it('single-select >9 falls back to arrow-down navigation', () => {
    const keys = singleSelectKeys(11);
    expect(keys.filter((k) => k.key === 'down')).toHaveLength(10);
    expect(keys[keys.length - 1]).toEqual({ key: 'enter' });
  });
  it('multiSelect → digit+space per checked, then one Enter', () => {
    expect(multiSelectKeys([1, 3])).toEqual([
      { bytes: '1' },
      { key: 'space' },
      { bytes: '3' },
      { key: 'space' },
      { key: 'enter' },
    ]);
  });
});

describe('AskUserQuestionCard — single-select', () => {
  it('routes a tapped option to /key as digit + Enter', async () => {
    const { getByTestId } = render(
      <AskUserQuestionCard sessionId="sid_x" ask={single} isLive />
    );
    fireEvent.click(getByTestId('ask-option-2'));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[0].url).toBe('/api/sessions/sid_x/key');
    expect(calls[0].body).toEqual({ bytes: '2' });
    expect(calls[1].url).toBe('/api/sessions/sid_x/key');
    expect(calls[1].body).toEqual({ key: 'enter' });
  });

  it('routes a custom typed answer to /input (verified submit, trailing \\r)', async () => {
    const { getByTestId } = render(
      <AskUserQuestionCard sessionId="sid_x" ask={single} isLive />
    );
    fireEvent.click(getByTestId('ask-other-toggle'));
    fireEvent.change(getByTestId('ask-custom-input'), {
      target: { value: '5:30am' },
    });
    fireEvent.click(getByTestId('ask-custom-submit'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].url).toBe('/api/sessions/sid_x/input');
    expect(calls[0].body).toEqual({ text: '5:30am\r' });
  });
});

describe('AskUserQuestionCard — multiSelect', () => {
  it('renders checkboxes + a Submit, and routes the selected set to /key', async () => {
    const { getByTestId } = render(
      <AskUserQuestionCard sessionId="sid_x" ask={multi} isLive />
    );
    // Checkbox affordance, not single tap-to-answer.
    expect(getByTestId('ask-options-multi')).toBeInTheDocument();
    expect(getByTestId('ask-multi-submit')).toBeInTheDocument();
    fireEvent.click(getByTestId('ask-checkbox-1')); // Health
    fireEvent.click(getByTestId('ask-checkbox-3')); // Work
    fireEvent.click(getByTestId('ask-multi-submit'));
    await waitFor(() => expect(calls.length).toBe(5));
    expect(calls.map((c) => c.body)).toEqual([
      { bytes: '1' },
      { key: 'space' },
      { bytes: '3' },
      { key: 'space' },
      { key: 'enter' },
    ]);
    expect(calls.every((c) => c.url === '/api/sessions/sid_x/key')).toBe(true);
  });
});

describe('AskUserQuestionCard — states', () => {
  it('answered → read-only with the chosen answer, no controls', () => {
    const { getByTestId, queryByTestId } = render(
      <AskUserQuestionCard
        sessionId="sid_x"
        ask={single}
        answer="7:00"
        isLive={false}
      />
    );
    expect(getByTestId('ask-card')).toHaveAttribute('data-state', 'answered');
    expect(getByTestId('ask-answer')).toHaveTextContent('7:00');
    expect(queryByTestId('ask-option-1')).toBeNull();
  });

  it('not-live + unanswered → "defaulted", no controls', () => {
    const { getByTestId, queryByTestId } = render(
      <AskUserQuestionCard sessionId="sid_x" ask={single} isLive={false} />
    );
    expect(getByTestId('ask-card')).toHaveAttribute('data-state', 'defaulted');
    expect(getByTestId('ask-answer')).toHaveTextContent('defaulted');
    expect(queryByTestId('ask-option-1')).toBeNull();
  });

  it('live → needs-answer state with active option controls', () => {
    const { getByTestId } = render(
      <AskUserQuestionCard sessionId="sid_x" ask={single} isLive />
    );
    expect(getByTestId('ask-card')).toHaveAttribute('data-state', 'needs-answer');
    expect(getByTestId('ask-needs-answer')).toBeInTheDocument();
    expect(getByTestId('ask-option-1')).toBeEnabled();
  });
});
