// ═══════════════════════════════════════════════════════════════════════════
// ToolRunGroup.test.tsx — run-grouping of consecutive tool calls (cockpit-toolcards).
//
// Covers:
//   • groupTurns folds CONSECUTIVE tool_use turns into one tool_run block, while
//     non-tool turns stay their own block (so the agent's TEXT isn't buried).
//   • a run of 1 renders the inline card directly (single tool stays visible).
//   • a run of N≥2 collapses to a "N commands ▸" header that expands to the list.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { groupTurns, type TranscriptTurn } from '../CleanTranscript';
import ToolRunGroup from '../ToolRunGroup';

const user = (id: string, text: string): TranscriptTurn => ({
  kind: 'user',
  ts: null,
  id,
  text,
});
const asst = (id: string, text: string): TranscriptTurn => ({
  kind: 'assistant',
  ts: null,
  id,
  text,
});
const tool = (id: string, name: string, summary: string): TranscriptTurn => ({
  kind: 'tool_use',
  ts: null,
  id,
  tool: { name, input_summary: summary },
});

describe('groupTurns', () => {
  it('folds consecutive tool calls into ONE tool_run block', () => {
    const blocks = groupTurns([
      asst('a1', 'on it'),
      tool('t1', 'Bash', 'git add -A'),
      tool('t2', 'Bash', 'git commit -m x'),
      tool('t3', 'Bash', 'git push'),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('turn');
    expect(blocks[1].kind).toBe('tool_run');
    if (blocks[1].kind === 'tool_run') expect(blocks[1].tools).toHaveLength(3);
  });

  it('keeps non-tool turns as their own blocks between tool runs', () => {
    const blocks = groupTurns([
      user('u1', 'do X'),
      tool('t1', 'Read', 'a.ts'),
      asst('a1', 'found it'), // breaks the run
      tool('t2', 'Edit', 'a.ts'),
      tool('t3', 'Write', 'b.ts'),
    ]);
    // user | run(1) | assistant | run(2)
    expect(blocks.map((b) => b.kind)).toEqual([
      'turn',
      'tool_run',
      'turn',
      'tool_run',
    ]);
    if (blocks[1].kind === 'tool_run') expect(blocks[1].tools).toHaveLength(1);
    if (blocks[3].kind === 'tool_run') expect(blocks[3].tools).toHaveLength(2);
  });

  it('handles an all-tool transcript as a single run', () => {
    const blocks = groupTurns([
      tool('t1', 'Bash', 'a'),
      tool('t2', 'Bash', 'b'),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('tool_run');
  });
});

describe('ToolRunGroup — render', () => {
  it('renders a SINGLE tool call as an inline card (no collapsible group)', () => {
    const { queryByTestId, getByTestId } = render(
      <ToolRunGroup tools={[tool('t1', 'Read', 'src/lib/auth.ts')]} />
    );
    expect(queryByTestId('tool-run-group')).toBeNull();
    expect(getByTestId('tool-card')).toHaveTextContent('src/lib/auth.ts');
  });

  it('collapses N≥2 tool calls into a "N commands" header by default', () => {
    const { getByTestId, queryAllByTestId } = render(
      <ToolRunGroup
        tools={[
          tool('t1', 'Bash', 'git add -A'),
          tool('t2', 'Bash', 'git commit -m x'),
          tool('t3', 'Bash', 'git push origin main'),
        ]}
      />
    );
    const group = getByTestId('tool-run-group');
    expect(group.getAttribute('data-tool-count')).toBe('3');
    expect(group.getAttribute('data-open')).toBe('false');
    expect(group).toHaveTextContent('3 commands');
    // Collapsed → individual cards not mounted yet.
    expect(queryAllByTestId('tool-card')).toHaveLength(0);
  });

  it('expands to the full list of inline cards when the header is clicked', () => {
    const { getByTestId, queryAllByTestId } = render(
      <ToolRunGroup
        tools={[
          tool('t1', 'Bash', 'git add -A'),
          tool('t2', 'Bash', 'git commit -m x'),
        ]}
      />
    );
    expect(queryAllByTestId('tool-card')).toHaveLength(0);
    fireEvent.click(getByTestId('tool-run-toggle'));
    expect(getByTestId('tool-run-group').getAttribute('data-open')).toBe('true');
    expect(queryAllByTestId('tool-card')).toHaveLength(2);
  });
});
