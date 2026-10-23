// App shortcuts. Panes are Option/Alt+1..9 because every browser keeps Cmd/Ctrl+1..9 for its own
// tabs and a page cannot take them back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppShortcut, shortcutOf } from '../../web/lib/keys.js';
import { isMac } from '../../web/lib/util.js';

const key = (over) => ({ key: '', code: '', altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...over });
const mod = isMac ? { metaKey: true } : { ctrlKey: true };

test('Option/Alt+digit focuses pane N, by physical key (Option+2 types "™" on a Mac)', () => {
  assert.deepEqual(shortcutOf(key({ altKey: true, code: 'Digit2', key: '™' })), { type: 'pane', index: 1 });
  assert.deepEqual(shortcutOf(key({ altKey: true, code: 'Digit9', key: '9' })), { type: 'pane', index: 8 });
  assert.equal(shortcutOf(key({ altKey: true, code: 'Digit0', key: '0' })), null);
  assert.equal(shortcutOf(key({ altKey: true, shiftKey: true, code: 'Digit2' })), null);
  assert.equal(shortcutOf(key({ altKey: true, ctrlKey: true, code: 'Digit2' })), null);
});

test('not while typing in a text field: Option+8 is how a Mac types "•"', () => {
  assert.equal(shortcutOf(key({ altKey: true, code: 'Digit8', key: '•' }), { inText: true }), null);
  // The terminal has no such use for it: the app takes it there too.
  assert.equal(isAppShortcut(key({ altKey: true, code: 'Digit3' })), true);
});

test('Cmd/Ctrl shortcuts still work, and Cmd/Ctrl+digit stays a silent alias', () => {
  assert.deepEqual(shortcutOf(key({ ...mod, key: 'k', code: 'KeyK' })), { type: 'palette' });
  assert.deepEqual(shortcutOf(key({ ...mod, key: '\\', code: 'Backslash' })), { type: 'rail' });
  assert.deepEqual(shortcutOf(key({ ...mod, key: '1', code: 'Digit1' })), { type: 'pane', index: 0 });
  assert.equal(shortcutOf(key({ key: 'k', code: 'KeyK' })), null);
});
