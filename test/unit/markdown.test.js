// The chat view's Markdown reader (web/lib/markdown.js): blocks, inline marks, and the safety
// rules (only http(s) links, raw HTML stays text).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkdown, parseInline, safeHref } from '../../web/lib/markdown.js';

const flat = (nodes) => nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : n.children ? flat(n.children) : n.type === 'br' ? '\n' : '')).join('');

test('a fenced code block keeps its language and its text verbatim', () => {
  const b = parseMarkdown('Here:\n\n```js\nconst a = 1;\n  if (a) { **not bold** }\n```\nafter');
  assert.equal(b.length, 3);
  assert.deepEqual(b[1], { type: 'code', lang: 'js', text: 'const a = 1;\n  if (a) { **not bold** }' });
  assert.equal(b[2].type, 'p');
  // An unclosed fence runs to the end of the text.
  assert.deepEqual(parseMarkdown('```\nx'), [{ type: 'code', lang: '', text: 'x' }]);
});

test('a GFM pipe table: header, alignment, rows, inline marks in cells', () => {
  const [t] = parseMarkdown('| Name | Size |\n|:-----|-----:|\n| `a.js` | 12 |\n| **b** | 3 |');
  assert.equal(t.type, 'table');
  assert.deepEqual(t.align, ['left', 'right']);
  assert.deepEqual(t.head.map(flat), ['Name', 'Size']);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0][0], [{ type: 'code', text: 'a.js' }]);
  assert.equal(t.rows[1][0][0].type, 'strong');
});

test('bullet and numbered lists, headings, quotes, rules', () => {
  const b = parseMarkdown('# Title\n\n- one\n- two\n  more\n\n3. three\n4. four\n\n> quoted\n> line\n\n---');
  assert.deepEqual(b.map((x) => x.type), ['h', 'list', 'list', 'quote', 'hr']);
  assert.equal(b[0].level, 1);
  assert.equal(b[1].ordered, false);
  assert.deepEqual(b[1].items.map(flat), ['one', 'two\nmore']);
  assert.equal(b[2].ordered, true);
  assert.equal(b[2].start, 3);
  assert.equal(b[3].blocks[0].type, 'p');
});

test('inline: bold, italic, code and http links', () => {
  const n = parseInline('a **bold** and *it* with `x*y` see [docs](https://example.com/a?b=1)');
  assert.deepEqual(n.map((x) => x.type), ['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'link']);
  assert.equal(n[5].text, 'x*y');
  assert.equal(n[7].href, 'https://example.com/a?b=1');
  assert.deepEqual(flat(n[7].children), 'docs');
  // snake_case is not italic; a bare URL is linked without its trailing period.
  assert.deepEqual(parseInline('my_var_name'), [{ type: 'text', text: 'my_var_name' }]);
  const u = parseInline('Go to https://x.dev/p.');
  assert.equal(u[1].href, 'https://x.dev/p');
  assert.equal(u[2].text, '.');
});

test('unsafe links are never links: javascript:, data:, relative', () => {
  for (const src of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](/etc/passwd)', '<javascript:alert(1)>']) {
    const n = parseInline(src);
    assert.ok(!n.some((x) => x.type === 'link'), src);
  }
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('JAVASCRIPT://x'), null);
  assert.equal(safeHref('https://ok.example'), 'https://ok.example');
});

test('raw HTML stays text', () => {
  const b = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.deepEqual(b.map((x) => x.type), ['p', 'p']);
  assert.deepEqual(b[0].inline, [{ type: 'text', text: '<script>alert(1)</script>' }]);
  assert.equal(flat(b[1].inline), '<img src=x onerror=alert(1)>');
});

test('empty and odd input never throws', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(null), []);
  assert.ok(Array.isArray(parseMarkdown('**unclosed *and `open')));
  assert.ok(Array.isArray(parseMarkdown('|\n|-|')));
});
