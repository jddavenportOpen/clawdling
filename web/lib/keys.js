// App shortcuts: ⌘K palette, ⌘\ rail, ⌘1..9 focus pane N (Ctrl on Windows/Linux).
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

export function shortcutOf(e, { inTerminal = false } = {}) {
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
