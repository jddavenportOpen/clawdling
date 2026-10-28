// Source checks for the cockpit that a browser test cannot see well: copy rules, CSS tokens and
// the safe-area rules a notched phone needs (2026-10-22 UX review).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const webSources = () => ['lib', 'components'].flatMap((d) => fs.readdirSync(path.join(ROOT, 'web', d)).filter((f) => f.endsWith('.js')).map((f) => [`web/${d}/${f}`, read('web', d, f)]));
const css = read('web', 'styles.css');

test('no bare `clawdling <command>` in the cockpit: every command comes from cliCmd() (P0-3)', () => {
  const bare = /(^|[>`'"(])clawdling (start|open|ls|doctor|donna|service|spawn|send|attach|end|resume|init|new)\b/;
  const hits = webSources().filter(([, src]) => bare.test(src)).map(([f]) => f);
  assert.deepEqual(hits, []);
});

test('"Pair your phone" is gone: Telegram pairing and the phone card have their own names (P1-14)', () => {
  const all = [...webSources().map(([, s]) => s), read('web', 'index.html')].join('\n');
  assert.doesNotMatch(all, /Pair your phone/);
  assert.match(all, /Pair your Telegram chat/);
  assert.match(all, /Use Clawdling on your phone/);
});

test('raw hex colours live only in the theme blocks and the QR frame (P2-17)', () => {
  const outside = css
    .replace(/:root\s*\{[\s\S]*?\n\}/, '')
    .replace(/@media \(prefers-color-scheme: light\)\s*\{[\s\S]*?\n\}\n/, '')
    .replace(/:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/, '')
    .split('\n')
    .filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l) && !/^\.qr-frame/.test(l));
  assert.deepEqual(outside, []);
});

test('contrast tokens: dark secondary text is #8b929d and placeholders are not faded (P1-10)', () => {
  assert.match(css, /--text-3: #8b929d;/);
  assert.doesNotMatch(css, /::placeholder[^}]*opacity: 0\.\d/);
});

test('safe areas: nothing sits under the notch or the home indicator (P1-9)', () => {
  const rule = (sel) => (css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`)) || [''])[0];
  assert.match(rule('.app'), /padding: env\(safe-area-inset-top\) env\(safe-area-inset-right\) 0 env\(safe-area-inset-left\)/);
  assert.match(rule('.rail-foot'), /padding-bottom: max\(8px, env\(safe-area-inset-bottom\)\)/);
  assert.match(rule('.toasts'), /bottom: calc\(16px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(rule('.toasts'), /right: calc\(16px \+ env\(safe-area-inset-right\)\)/);
  assert.match(rule('.pane-composer'), /env\(safe-area-inset-bottom\)/);
  assert.match(read('web', 'index.html'), /viewport-fit=cover/);
});

test('buttons have a pressed state that does not move the layout (P2-16)', () => {
  assert.match(css, /\.btn:not\(:disabled\):active[^{]*\{ transform: translateY\(1px\); \}/);
});

test('README promises no limit it cannot keep (P2-21)', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /only limit/);
  assert.doesNotMatch(readme, /unlimited|no session caps/i);
  assert.match(readme, /your Claude plan's usage limits\s+apply as usual/);
});
