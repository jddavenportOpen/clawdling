// ═══════════════════════════════════════════════════════════════════════════
// ToolCallCard.test.tsx — compact, command-inline tool cards (cockpit-toolcards).
//
// Covers:
//   • toolInlineSummary extraction: command first-line / file path / query, for
//     both pre-summarized strings AND raw input objects (Bash/Read/Edit/Write).
//   • the row renders the inline summary, not just the tool name.
//   • clicking the row expands the full input.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import ToolCallCard, { toolInlineSummary } from '../ToolCallCard';

describe('toolInlineSummary', () => {
  it('returns a pre-summarized string as-is (whitespace-collapsed, truncated)', () => {
    expect(toolInlineSummary('git push origin main')).toBe('git push origin main');
    expect(toolInlineSummary('  ls   -la   state/  ')).toBe('ls -la state/');
  });

  it('takes the FIRST non-empty line of a multi-line command (Bash)', () => {
    expect(toolInlineSummary('\n\ngit add -A\ngit commit -m x')).toBe('git add -A');
  });

  it('pulls command from a raw Bash input object', () => {
    expect(
      toolInlineSummary({ command: 'git push origin main', description: 'push' })
    ).toBe('git push origin main');
  });

  it('pulls file_path from a raw Read/Edit/Write input object', () => {
    expect(toolInlineSummary({ file_path: 'src/lib/auth.ts' })).toBe('src/lib/auth.ts');
    expect(
      toolInlineSummary({ file_path: 'Composer.tsx', old_string: 'a', new_string: 'b' })
    ).toBe('Composer.tsx');
  });

  it('falls back to path/pattern/query/url when no command/file_path', () => {
    expect(toolInlineSummary({ pattern: 'TODO', path: 'src' })).toBe('src'); // path wins per priority? no — pattern after path
    expect(toolInlineSummary({ query: 'how to auth' })).toBe('how to auth');
    expect(toolInlineSummary({ url: 'https://x.dev/a' })).toBe('https://x.dev/a');
  });

  it('truncates long summaries with an ellipsis', () => {
    const long = 'echo ' + 'x'.repeat(200);
    const out = toolInlineSummary(long, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty / null input without throwing', () => {
    expect(toolInlineSummary(null)).toBe('');
    expect(toolInlineSummary({})).toBe('{}');
  });
});

describe('ToolCallCard — compact row', () => {
  it('renders the inline summary alongside the tool name', () => {
    const { getByTestId } = render(
      <ToolCallCard name="Bash" input="git push origin main" status="done" />
    );
    const card = getByTestId('tool-card');
    expect(card).toHaveTextContent('Bash');
    expect(card).toHaveTextContent('git push origin main');
    expect(card.getAttribute('data-status')).toBe('done');
  });

  it('expands the full input when the row is clicked', () => {
    const { getByTestId, getByRole, queryByText } = render(
      <ToolCallCard name="Read" input="src/lib/auth.ts" status="done" />
    );
    // Collapsed: no "input" detail label yet.
    expect(queryByText('input')).toBeNull();
    fireEvent.click(getByRole('button'));
    // Expanded: the detail section appears.
    expect(getByTestId('tool-card')).toHaveTextContent('input');
  });

  it('auto-expands an errored tool call', () => {
    const { getByTestId } = render(
      <ToolCallCard name="Bash" input="bad cmd" output="boom" status="error" />
    );
    const card = getByTestId('tool-card');
    expect(card.getAttribute('data-status')).toBe('error');
    expect(card).toHaveTextContent('output');
  });
});
