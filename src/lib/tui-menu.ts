// ═══════════════════════════════════════════════════════════════════════════
// TUI selection-menu detection for the cockpit pane.
//
// fix/cockpit-interactive-prompts (2026-06-01). When a live Claude Code PTY
// shows a numbered SELECTION MENU (the permission prompt), the cockpit pane
// renders the options as TAPPABLE BUTTONS. This module is the pure parser:
// given the lines currently rendered in the xterm buffer, decide whether a
// menu is on screen and extract its options + which one the ❯ cursor is on.
//
// Why parse the RENDERED screen (not the raw byte stream): the bridge streams
// raw ANSI; xterm already interprets it into a clean grid of text lines via
// `term.buffer.active` + `line.translateToString()`. Parsing the rendered
// lines is far more robust than trying to reconstruct the menu from interleaved
// repaint escapes (the menu redraws as the ❯ cursor moves).
//
// The canonical Claude Code permission menu (reproduced 2026-06-01) renders as:
//
//     Do you want to create proof.txt?
//     ❯ 1. Yes
//       2. Yes, allow all edits during this session (shift+tab)
//       3. No
//     Esc to cancel · Tab to amend
//
// The ❯ marks the highlighted row. Options are `<n>. <label>`. We detect the
// block by: ≥2 consecutive numbered option lines (1..N in order) where exactly
// one carries the ❯ cursor marker.
// ═══════════════════════════════════════════════════════════════════════════

export interface TuiMenuOption {
  /** 1-based option number as shown (the digit shortcut). */
  number: number;
  /** The option label, ❯/number stripped. */
  label: string;
  /** True if the ❯ cursor is currently on this row (the default on Enter). */
  selected: boolean;
}

export interface TuiMenu {
  /** The prompt question line above the options, if found (e.g. "Do you want…"). */
  prompt: string | null;
  options: TuiMenuOption[];
  /** Index into `options` of the ❯-highlighted row, or -1 if none marked. */
  selectedIndex: number;
}

// The cursor glyph Claude Code uses to mark the highlighted row. We match a
// leading ❯ (U+2771) possibly preceded by whitespace.
const CURSOR_RE = /^[\s ]*❯/;
// An option line: optional ❯ cursor, then `<digit(s)>.` then a label.
// Examples: "❯ 1. Yes", "  2. Yes, allow all edits …", "  3. No"
const OPTION_RE = /^[\s ]*(❯[\s ]*)?(\d{1,2})[.)]\s+(.*\S)\s*$/;

/**
 * Parse the visible terminal lines for a Claude Code numbered selection menu.
 *
 * `lines` should be the rendered text of each row currently on screen
 * (xterm's `buffer.active.getLine(i).translateToString(true)`), top-to-bottom.
 *
 * Returns a `TuiMenu` if a coherent numbered menu is detected, else `null`.
 * Detection is conservative: it requires ≥2 options whose numbers are a strict
 * 1..N run (so prose like "1. first 2. second" mid-paragraph doesn't trip it),
 * AND at least one ❯-marked row OR an explicit prompt — so we only show buttons
 * when we're confident a real menu is up. The raw-key control row (part A) is
 * always available as the fallback when this returns null.
 */
export function detectTuiMenu(lines: string[]): TuiMenu | null {
  // Find the LAST contiguous run of option lines (the menu is the most recent
  // thing painted; earlier numbered lists in scrollback shouldn't win).
  let bestStart = -1;
  let bestEnd = -1; // exclusive
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(OPTION_RE);
    if (m && Number(m[2]) === 1) {
      // Potential menu start at a "1." line. Walk the contiguous run.
      let j = i;
      let expected = 1;
      while (j < lines.length) {
        const mm = lines[j].match(OPTION_RE);
        if (!mm) break;
        if (Number(mm[2]) !== expected) break;
        expected += 1;
        j += 1;
      }
      const count = j - i;
      if (count >= 2) {
        bestStart = i;
        bestEnd = j;
      }
      i = j > i ? j : i + 1;
    } else {
      i += 1;
    }
  }

  if (bestStart < 0) return null;

  const options: TuiMenuOption[] = [];
  let selectedIndex = -1;
  for (let k = bestStart; k < bestEnd; k++) {
    const m = lines[k].match(OPTION_RE);
    if (!m) continue;
    const hasCursor = CURSOR_RE.test(lines[k]) || Boolean(m[1]);
    const number = Number(m[2]);
    const label = m[3].trim();
    if (hasCursor) selectedIndex = options.length;
    options.push({ number, label, selected: hasCursor });
  }

  // Require confidence: at least one ❯-marked row OR a recognizable prompt line
  // immediately above the options. Without either, this is likely prose.
  let prompt: string | null = null;
  for (let p = bestStart - 1; p >= 0 && p >= bestStart - 3; p--) {
    const t = lines[p].trim();
    if (!t) continue;
    // A question or "Do you want…" line is a strong prompt signal.
    if (/\?\s*$/.test(t) || /^do you want|^select|^choose|^how would/i.test(t)) {
      prompt = t;
    }
    break;
  }

  if (selectedIndex < 0 && prompt === null) {
    // No cursor AND no prompt → not confident enough; let the raw-key row
    // handle it rather than render misleading buttons.
    return null;
  }

  return { prompt, options, selectedIndex };
}

/**
 * Given a detected menu and the option the user TAPPED, compute the keystroke
 * sequence(s) to select it. Two strategies:
 *
 *   1. Digit shortcut — if the menu accepts bare digits (it does for the
 *      permission menu), send the digit then Enter. Simplest + most robust;
 *      no dependence on where the cursor currently sits.
 *   2. Arrow navigation — fallback when digits aren't trusted: send
 *      down/up from the current selectedIndex to the target, then Enter.
 *
 * We default to the DIGIT strategy (verified 2026-06-01 to select correctly),
 * falling back to arrows only when the menu has no usable cursor AND >9 options
 * (digit shortcuts only go 1-9 in Claude Code). Returns an ordered list of
 * `{ key?, bytes? }` payloads for POST /api/sessions/<sid>/key.
 */
export function keystrokesForOption(
  menu: TuiMenu,
  targetIndex: number,
): Array<{ key?: string; bytes?: string }> {
  const opt = menu.options[targetIndex];
  if (!opt) return [];

  // Digit strategy (preferred). Claude Code numbered menus accept the bare
  // digit as a jump-and-stage; an Enter then confirms. 1-9 only.
  if (opt.number >= 1 && opt.number <= 9) {
    return [{ bytes: String(opt.number) }, { key: 'enter' }];
  }

  // Arrow fallback for >9 options or no digit support: navigate from the
  // current cursor row to the target, then Enter.
  const from = menu.selectedIndex >= 0 ? menu.selectedIndex : 0;
  const delta = targetIndex - from;
  const steps: Array<{ key?: string; bytes?: string }> = [];
  const dirKey = delta >= 0 ? 'down' : 'up';
  for (let n = 0; n < Math.abs(delta); n++) steps.push({ key: dirKey });
  steps.push({ key: 'enter' });
  return steps;
}
