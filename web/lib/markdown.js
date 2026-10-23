// A small, safe Markdown reader for the chat view. Pure (no DOM): text in, a tree of plain
// objects out, rendered to Preact elements by the chat view. It never produces HTML, so raw
// HTML in a message stays text, and only http(s) links become links.
//
// Blocks: {type:'p', inline} | {type:'h', level, inline} | {type:'code', lang, text}
//   | {type:'table', align, head:[inline], rows:[[inline]]} | {type:'list', ordered, start, items:[inline]}
//   | {type:'quote', blocks} | {type:'hr'}
// Inline: {type:'text', text} | {type:'code', text} | {type:'strong', children} | {type:'em', children}
//   | {type:'link', href, children} | {type:'br'}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function safeHref(url) {
  const u = String(url || '').trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(u) ? u : null;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')
  && (lines[i + 1].includes('|') || splitRow(lines[i]).length === 1);

const startsBlock = (lines, i) => {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || BULLET.test(l) || ORDERED.test(l) || QUOTE.test(l) || isTableStart(lines, i);
};

export function parseMarkdown(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  return parseLines(lines, 0);
}

function parseLines(lines, depth) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = line.match(FENCE);
    if (m) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && /^\s*[`~]+\s*$/.test(lines[i]))) { body.push(lines[i]); i++; }
      i++; // closing fence (or end of text: an unclosed fence runs to the end)
      blocks.push({ type: 'code', lang: m[2] || '', text: body.join('\n') });
      continue;
    }
    m = line.match(HEADING);
    if (m) { blocks.push({ type: 'h', level: m[1].length, inline: parseInline(m[2]) }); i++; continue; }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, k) => parseInline(cells[k] || '')));
        i++;
      }
      blocks.push({ type: 'table', align: head.map((_, k) => align[k] || null), head: head.map(parseInline), rows });
      continue;
    }
    if (QUOTE.test(line) && depth < 4) {
      const body = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) { body.push(lines[i].match(QUOTE)[1]); i++; }
      blocks.push({ type: 'quote', blocks: parseLines(body, depth + 1) });
      continue;
    }
    const ordered = ORDERED.test(line);
    if (ordered || BULLET.test(line)) {
      const re = ordered ? ORDERED : BULLET;
      const items = [];
      const start = ordered ? Number(line.match(ORDERED)[1]) : 1;
      while (i < lines.length) {
        const l = lines[i];
        const mm = l.match(re);
        if (mm) { items.push([ordered ? mm[2] : mm[1]]); i++; continue; }
        // A continuation line (indented, not blank, not a new block) joins the item before it.
        if (l.trim() && /^\s+/.test(l) && items.length && !FENCE.test(l)) { items[items.length - 1].push(l.trim()); i++; continue; }
        break;
      }
      blocks.push({ type: 'list', ordered, start, items: items.map((parts) => parseInline(parts.join('\n'))) });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) { para.push(lines[i]); i++; }
    blocks.push({ type: 'p', inline: parseInline(para.map((l) => l.trim()).join('\n')) });
  }
  return blocks;
}

// Inline: the earliest token wins; anything that is not a token is text.
const INLINE = [
  ['code', /(`+)([\s\S]*?[^`])\1(?!`)/],
  ['link', /\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/],
  ['auto', /<(https?:\/\/[^\s<>]+)>/i],
  ['url', /\bhttps?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_]/i],
  ['strong', /\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/],
  ['em', /\*(?=[^\s*])([^*]*?[^\s*])\*|(?<![\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])/],
  ['br', /\n/],
];

export function parseInline(src, depth = 0) {
  const out = [];
  let s = String(src == null ? '' : src);
  const text = (t) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.type === 'text') last.text += t;
    else out.push({ type: 'text', text: t });
  };
  while (s) {
    let best = null;
    for (const [kind, re] of INLINE) {
      const m = re.exec(s);
      if (m && (!best || m.index < best.m.index)) best = { kind, m };
    }
    if (!best) { text(s); break; }
    const { kind, m } = best;
    text(s.slice(0, m.index));
    s = s.slice(m.index + m[0].length);
    const inner = (t) => (depth < 6 ? parseInline(t, depth + 1) : [{ type: 'text', text: t }]);
    if (kind === 'code') {
      const t = m[2];
      out.push({ type: 'code', text: /^ .* $/.test(t) ? t.slice(1, -1) : t });
    } else if (kind === 'link') {
      const href = safeHref(m[2]);
      if (href) out.push({ type: 'link', href, children: inner(m[1]) });
      else text(m[0]); // not http(s): shown as the text it was, never a link
    } else if (kind === 'auto' || kind === 'url') {
      const url = kind === 'auto' ? m[1] : m[0];
      const href = safeHref(url);
      if (href) out.push({ type: 'link', href, children: [{ type: 'text', text: url }] });
      else text(m[0]);
    } else if (kind === 'strong') {
      out.push({ type: 'strong', children: inner(m[1] != null ? m[1] : m[2]) });
    } else if (kind === 'em') {
      out.push({ type: 'em', children: inner(m[1] != null ? m[1] : m[2]) });
    } else if (kind === 'br') {
      out.push({ type: 'br' });
    }
  }
  return out;
}
