import { describe, it, expect } from 'vitest';
import { detectTuiMenu, keystrokesForOption } from '../tui-menu';

// The exact lines Claude Code's permission menu renders (reproduced from a
// live PTY 2026-06-01). The ❯ marks the highlighted/default row.
const PERMISSION_MENU = [
  '⏺ Write(proof.txt)',
  '  Create file proof.txt',
  '',
  'Do you want to create proof.txt?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  'Esc to cancel · Tab to amend',
];

describe('detectTuiMenu', () => {
  it('detects the Claude Code permission menu and its options', () => {
    const menu = detectTuiMenu(PERMISSION_MENU);
    expect(menu).not.toBeNull();
    expect(menu!.options).toHaveLength(3);
    expect(menu!.options[0]).toMatchObject({ number: 1, selected: true });
    expect(menu!.options[0].label).toMatch(/^Yes/);
    expect(menu!.options[1]).toMatchObject({ number: 2, selected: false });
    expect(menu!.options[2]).toMatchObject({ number: 3, selected: false });
    expect(menu!.selectedIndex).toBe(0);
    expect(menu!.prompt).toBe('Do you want to create proof.txt?');
  });

  it('tracks the cursor when it has moved to option 2', () => {
    const moved = PERMISSION_MENU.map((l) =>
      l.startsWith('❯ 1.')
        ? '  1. Yes'
        : l.includes('2. Yes, allow')
          ? '❯ 2. Yes, allow all edits during this session (shift+tab)'
          : l,
    );
    const menu = detectTuiMenu(moved);
    expect(menu!.selectedIndex).toBe(1);
    expect(menu!.options[1].selected).toBe(true);
    expect(menu!.options[0].selected).toBe(false);
  });

  it('returns null for ordinary streaming output (no menu)', () => {
    expect(
      detectTuiMenu([
        'Here is what I found:',
        '- the bridge writes raw bytes',
        '- the composer appends a carriage return',
        'Done.',
      ]),
    ).toBeNull();
  });

  it('does NOT trip on prose that merely contains a numbered list', () => {
    // A numbered list mid-paragraph with NO ❯ cursor and NO question prompt
    // must not be mistaken for a selection menu.
    expect(
      detectTuiMenu([
        'The steps are:',
        '1. first do this thing',
        '2. then do that thing',
        'and we are finished.',
      ]),
    ).toBeNull();
  });

  it('detects a 2-option menu with a cursor (minimum viable menu)', () => {
    const menu = detectTuiMenu([
      'Pick one:',
      '❯ 1. Continue',
      '  2. Abort',
    ]);
    expect(menu).not.toBeNull();
    expect(menu!.options).toHaveLength(2);
    expect(menu!.selectedIndex).toBe(0);
  });
});

describe('keystrokesForOption', () => {
  it('selects a non-default option via digit + Enter (the keeper fix)', () => {
    const menu = detectTuiMenu(PERMISSION_MENU)!;
    // JD taps option 3 ("No") — the OPPOSITE of the highlighted default.
    const keys = keystrokesForOption(menu, 2);
    expect(keys).toEqual([{ bytes: '3' }, { key: 'enter' }]);
  });

  it('selects option 2 via digit + Enter', () => {
    const menu = detectTuiMenu(PERMISSION_MENU)!;
    expect(keystrokesForOption(menu, 1)).toEqual([
      { bytes: '2' },
      { key: 'enter' },
    ]);
  });

  it('falls back to arrow navigation for >9 options', () => {
    const lines = ['Choose:'];
    for (let n = 1; n <= 12; n++) lines.push(`${n === 1 ? '❯ ' : '  '}${n}. opt${n}`);
    const menu = detectTuiMenu(lines)!;
    expect(menu.options).toHaveLength(12);
    // Tap option 11 (index 10) — digit shortcut can't express 11, so arrows.
    const keys = keystrokesForOption(menu, 10);
    expect(keys.filter((k) => k.key === 'down')).toHaveLength(10);
    expect(keys[keys.length - 1]).toEqual({ key: 'enter' });
  });

  it('returns empty for an out-of-range target', () => {
    const menu = detectTuiMenu(PERMISSION_MENU)!;
    expect(keystrokesForOption(menu, 99)).toEqual([]);
  });
});
