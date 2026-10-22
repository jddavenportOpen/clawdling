import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inlineText, parseInline, parseMarkdown, safeHref, type Block, type Inline } from '../../src/markdown';

function only<T extends Block['t']>(blocks: Block[], t: T): Extract<Block, { t: T }> {
  assert.equal(blocks.length, 1, `expected one block, got ${JSON.stringify(blocks)}`);
  assert.equal(blocks[0].t, t);
  return blocks[0] as Extract<Block, { t: T }>;
}

describe('blocks', () => {
  it('splits paragraphs on blank lines and keeps single newlines', () => {
    const b = parseMarkdown('First line\nsecond line\n\nNext paragraph');
    assert.equal(b.length, 2);
    assert.equal(b[0].t, 'p');
    assert.equal(inlineText((b[0] as Extract<Block, { t: 'p' }>).c), 'First line\nsecond line');
  });

  it('reads fenced code with a language, untouched by inline rules', () => {
    const code = only(parseMarkdown('```tsx\nconst a = **b**;\n<Link href={x} />\n```'), 'code');
    assert.equal(code.lang, 'tsx');
    assert.equal(code.v, 'const a = **b**;\n<Link href={x} />');
  });

  it('keeps an unterminated fence to the end (a reply still streaming)', () => {
    const code = only(parseMarkdown('```\nnpm test'), 'code');
    assert.equal(code.v, 'npm test');
  });

  it('reads bullet lists with nesting and continuation lines', () => {
    const ul = only(parseMarkdown('- one\n- two\n  still two\n  - nested'), 'ul');
    assert.equal(ul.items.length, 3);
    assert.equal(inlineText(ul.items[1].c), 'two\nstill two');
    assert.equal(ul.items[2].depth, 1);
  });

  it('reads numbered lists and their start number', () => {
    const ol = only(parseMarkdown('3. three\n4. four'), 'ol');
    assert.equal(ol.start, 3);
    assert.equal(ol.items.length, 2);
  });

  it('ends a paragraph when a list starts on the next line', () => {
    const b = parseMarkdown("Here's the plan:\n1. First\n2. Second");
    assert.deepEqual(b.map((x) => x.t), ['p', 'ol']);
  });

  it('keeps a list going across a blank line', () => {
    const ul = only(parseMarkdown('- a\n\n- b'), 'ul');
    assert.equal(ul.items.length, 2);
  });

  it('reads headings, quotes and rules', () => {
    const b = parseMarkdown('# Title\n> quoted\n> more\n\n---\n#### small');
    assert.deepEqual(b.map((x) => x.t), ['h', 'quote', 'hr', 'h']);
    assert.equal((b[0] as Extract<Block, { t: 'h' }>).level, 1);
    assert.equal((b[3] as Extract<Block, { t: 'h' }>).level, 3);
    assert.equal(inlineText((b[1] as Extract<Block, { t: 'quote' }>).c), 'quoted\nmore');
  });

  it('reads tables and pads short rows', () => {
    const t = only(parseMarkdown('| Day | Focus |\n|---|:---:|\n| Mon | Upper |\n| Tue |'), 'table');
    assert.deepEqual(t.header.map(inlineText), ['Day', 'Focus']);
    assert.deepEqual(t.rows.map((r) => r.map(inlineText)), [
      ['Mon', 'Upper'],
      ['Tue', ''],
    ]);
  });

  it('does not mistake numbers or arithmetic for lists', () => {
    assert.deepEqual(parseMarkdown('3.5 million users').map((x) => x.t), ['p']);
    assert.deepEqual(parseMarkdown('2 * 3 * 4 = 24').map((x) => x.t), ['p']);
  });

  it('handles empty and whitespace-only input', () => {
    assert.deepEqual(parseMarkdown(''), []);
    assert.deepEqual(parseMarkdown('\n\n  \n'), []);
  });
});

function kinds(nodes: Inline[]): string[] {
  return nodes.map((n) => n.t);
}

describe('inline', () => {
  it('reads code, bold, italic and strikethrough', () => {
    const n = parseInline('Run `npm test` then **ship** it *today* ~~maybe~~');
    assert.deepEqual(kinds(n), ['text', 'code', 'text', 'bold', 'text', 'italic', 'text', 'strike']);
  });

  it('leaves snake_case and lone stars alone', () => {
    assert.deepEqual(kinds(parseInline('my_var_name and 2 * 3')), ['text']);
    assert.equal(inlineText(parseInline('my_var_name and 2 * 3')), 'my_var_name and 2 * 3');
  });

  it('does not read emphasis inside code', () => {
    const n = parseInline('`a **b** c`');
    assert.deepEqual(n, [{ t: 'code', v: 'a **b** c' }]);
  });

  it('honours backslash escapes', () => {
    assert.equal(inlineText(parseInline('\\*not italic\\*')), '*not italic*');
  });

  it('links http(s) and mailto, and refuses javascript: and file: links', () => {
    const good = parseInline('[docs](https://example.com/a) and [mail](mailto:a@b.co)');
    assert.deepEqual(kinds(good), ['link', 'text', 'link']);
    const bad = parseInline('[click](javascript:alert(1)) [f](file:///etc/passwd) [rel](/settings)');
    assert.ok(bad.every((n) => n.t !== 'link'), JSON.stringify(bad));
    assert.equal(inlineText(bad), 'click f rel');
  });

  it('auto-links bare URLs without swallowing punctuation', () => {
    const n = parseInline('See https://example.com/path. Or (https://example.org/x)!');
    const links = n.filter((x): x is Extract<Inline, { t: 'link' }> => x.t === 'link').map((l) => l.href);
    assert.deepEqual(links, ['https://example.com/path', 'https://example.org/x']);
  });

  it('keeps a link label formatted', () => {
    const [link] = parseInline('[**bold** label](https://example.com)');
    assert.equal(link.t, 'link');
    if (link.t === 'link') assert.deepEqual(kinds(link.c), ['bold', 'text']);
  });

  it('safeHref only lets http(s) and mailto through', () => {
    assert.equal(safeHref('https://x.y'), 'https://x.y');
    assert.equal(safeHref(' HTTP://x.y '), 'HTTP://x.y');
    assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
    assert.equal(safeHref('javascript:alert(1)'), null);
    assert.equal(safeHref('JaVaScRiPt:alert(1)'), null);
    assert.equal(safeHref('data:text/html,x'), null);
    assert.equal(safeHref('http://has space'), null);
    assert.equal(safeHref(''), null);
  });
});
