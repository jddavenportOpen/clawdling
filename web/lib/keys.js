// App shortcuts: ⌘K palette, ⌘\ rail (Ctrl on Windows/Linux), ⌥1..9 / Alt+1..9 focus pane N.
// Panes use Option/Alt because every browser keeps ⌘/Ctrl+1..9 for its own tabs and a page
// cannot take them back; ⌘/Ctrl+digit still works as a silent alias where the browser lets it.
// On a Mac, Ctrl+K and Ctrl+\ also work OUTSIDE a terminal; inside one they
// stay with the shell (kill-line, SIGQUIT), because that is what a terminal user expects.
import { isMac } from './util.js';

function isMod(e, inTerminal) {
  if (e.altKey) return false;
  if (isMac) {
    if (e.metaKey && !e.ctrlKey) return true;
    return !inTerminal && e.ctrlKey && !e.metaKey;
  }
  return e.ctrlKey && !e.metaKey;
}

export function shortcutOf(e, { inTerminal = false, inText = false } = {}) {
  // By physical key (e.code): on a Mac, Option+2 types "™", so e.key is no help. Not while typing
  // in a text field (Option+8 is how a Mac types "•"); the terminal has no such use for it.
  if (!inText && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code || '')) {
    return { type: 'pane', index: Number(e.code.slice(5)) - 1 };
  }
  if (!isMod(e, inTerminal)) return null;
  const k = e.key;
  if (!e.shiftKey && (k === 'k' || k === 'K')) return { type: 'palette' };
  if (k === '\\' || e.code === 'Backslash') return { type: 'rail' };
  if (!e.shiftKey && /^[1-9]$/.test(k)) return { type: 'pane', index: Number(k) - 1 };
  if (!e.shiftKey && /^Digit[1-9]$/.test(e.code || '')) return { type: 'pane', index: Number(e.code.slice(5)) - 1 };
  return null;
}

export function isAppShortcut(e) {
  return !!shortcutOf(e, { inTerminal: true });
}

export function eventInTerminal(e) {
  const t = e.target;
  return !!(t && typeof t.closest === 'function' && t.closest('.xterm'));
}

export function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
}
