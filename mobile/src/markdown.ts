// A small Markdown reader for chat bubbles: paragraphs (single newlines kept), headings, fenced
// code, bullet and numbered lists, quotes, tables, rules, and inline code / bold / italic /
// strikethrough / links. It never produces HTML, and links are limited to http(s) and mailto, so a
// message can never smuggle a javascript: or file: link onto the screen. Pure, unit-tested.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'strike'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export interface ListItem {
  depth: number;
  c: Inline[];
}

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'ul'; items: ListItem[] }
  | { t: 'ol'; start: number; items: ListItem[] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Only links a phone may safely open: http(s) and mailto. Everything else becomes plain text. */
export function safeHref(href: string): string | null {
  const h = String(href ?? '').trim();
  if (/^https?:\/\/[^\s]+$/i.test(h)) return h;
  if (/^mailto:[^\s]+$/i.test(h)) return h;
  return null;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  if (FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)) return true;
  if (ITEM_RE.test(line)) return true;
  return isTableStart(lines, i);
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_SEP_RE.test(lines[i + 1]);
}

export function parseMarkdown(src: string): Block[] {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trim();
        if (t.startsWith(marker[0].repeat(marker.length)) && t.replace(new RegExp(`\\${marker[0]}`, 'g'), '') === '') {
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      blocks.push({ t: 'code', lang, v: body.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      blocks.push({ t: 'h', level, c: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        const row = header.map((_, ci) => parseInline(cells[ci] ?? ''));
        rows.push(row);
        i++;
      }
      blocks.push({ t: 'table', header, rows });
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const q = QUOTE_RE.exec(lines[i]);
        if (q) body.push(q[1]);
        else if (startsBlock(lines, i)) break;
        else body.push(lines[i].trim());
        i++;
      }
      blocks.push({ t: 'quote', c: parseInline(body.join('\n')) });
      continue;
    }

    const first = ITEM_RE.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]);
      const baseIndent = first[1].replace(/\t/g, '    ').length;
      const items: ListItem[] = [];
      const texts: string[] = [];
      let start = ordered ? parseInt(first[2], 10) : 1;
      if (!Number.isFinite(start)) start = 1;
      while (i < lines.length) {
        const l = lines[i];
        const m = ITEM_RE.exec(l);
        if (m) {
          const indent = m[1].replace(/\t/g, '    ').length;
          const isOrdered = /\d/.test(m[2]);
          // A different list type at the base level ends this list.
          if (indent <= baseIndent && isOrdered !== ordered) break;
          items.push({ depth: Math.min(3, Math.max(0, Math.floor((indent - baseIndent) / 2))), c: [] });
          texts.push(m[3]);
          i++;
          continue;
        }
        if (isBlank(l)) {
          // A blank line continues the list only if another item follows.
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j])) j++;
          const nm = j < lines.length ? ITEM_RE.exec(lines[j]) : null;
          if (nm && /\d/.test(nm[2]) === ordered) {
            i = j;
            continue;
          }
          break;
        }
        if (/^\s+\S/.test(l) && texts.length && !FENCE_RE.test(l)) {
          texts[texts.length - 1] += `\n${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      items.forEach((it, k) => {
        it.c = parseInline(texts[k]);
      });
      blocks.push(ordered ? { t: 'ol', start, items } : { t: 'ul', items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i])) {
      if (para.length && startsBlock(lines, i)) break;
      para.push(lines[i].replace(/\s+$/, ''));
      i++;
    }
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return blocks;
}

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.v += v;
  else out.push({ t: 'text', v });
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

function findClosingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findClosingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (c === '\n') return -1;
  }
  return -1;
}

/** Find a closing emphasis delimiter for an opener at `from` (content starts at from + len). */
function findCloser(s: string, from: number, delim: string): number {
  const len = delim.length;
  let i = from + len;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > 0) {
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith(delim, i) && i > from + len) {
      const before = s[i - 1];
      const after = s[i + len];
      const flanking = before !== undefined && !/\s/.test(before);
      const notLonger = after !== delim[0] || len === 2;
      const underscoreOk = delim[0] !== '_' || !isWordChar(after);
      if (flanking && notLonger && underscoreOk) return i;
    }
    i++;
  }
  return -1;
}

const TRAILING_PUNCT = /[.,;:!?'"]+$/;

function trimUrl(url: string): string {
  let u = url.replace(TRAILING_PUNCT, '');
  // Drop a closing paren that has no opening partner inside the URL: "(see https://x.y/z)".
  while (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
  return u.replace(TRAILING_PUNCT, '');
}

export function parseInline(src: string): Inline[] {
  const s = String(src ?? '');
  const out: Inline[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(s[i + 1])) {
      pushText(out, s[i + 1]);
      i += 2;
      continue;
    }

    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = s.indexOf(fence, i + run);
      if (close > 0) {
        let v = s.slice(i + run, close);
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ')) v = v.slice(1, -1);
        out.push({ t: 'code', v });
        i = close + run;
        continue;
      }
      pushText(out, fence);
      i += run;
      continue;
    }

    if (c === '[') {
      const close = findClosingBracket(s, i);
      if (close > i && s[close + 1] === '(') {
        const end = findClosingParen(s, close + 1);
        if (end > close) {
          const label = s.slice(i + 1, close);
          const target = s.slice(close + 2, end).trim().split(/\s+/)[0].replace(/^<|>$/g, '');
          const href = safeHref(target);
          if (href) out.push({ t: 'link', href, c: parseInline(label) });
          else for (const node of parseInline(label)) node.t === 'text' ? pushText(out, node.v) : out.push(node);
          i = end + 1;
          continue;
        }
      }
    }

    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(s.slice(i));
      if (m) {
        const href = safeHref(m[1]);
        if (href) {
          out.push({ t: 'link', href, c: [{ t: 'text', v: m[1] }] });
          i += m[0].length;
          continue;
        }
      }
    }

    if ((c === 'h' || c === 'H') && (i === 0 || /[\s([{"'*_]/.test(s[i - 1]))) {
      const m = /^https?:\/\/[^\s<>"'`]+/i.exec(s.slice(i));
      if (m) {
        const url = trimUrl(m[0]);
        if (url.length > 'https://'.length - 1 && safeHref(url)) {
          out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] });
          i += url.length;
          continue;
        }
      }
    }

    if (c === '*' || c === '_') {
      const prev = s[i - 1];
      const leftOk = c === '*' || !isWordChar(prev);
      const double = s[i + 1] === c;
      if (double) {
        const next = s[i + 2];
        if (leftOk && next !== undefined && !/\s/.test(next)) {
          const close = findCloser(s, i, c + c);
          if (close > 0) {
            out.push({ t: 'bold', c: parseInline(s.slice(i + 2, close)) });
            i = close + 2;
            continue;
          }
        }
      } else {
        const next = s[i + 1];
        if (leftOk && next !== undefined && !/\s/.test(next)) {
          const close = findCloser(s, i, c);
          if (close > 0) {
            out.push({ t: 'italic', c: parseInline(s.slice(i + 1, close)) });
            i = close + 1;
            continue;
          }
        }
      }
      // Not emphasis: keep the whole delimiter run as text.
      let run = 1;
      while (s[i + run] === c) run++;
      pushText(out, c.repeat(run));
      i += run;
      continue;
    }

    if (c === '~' && s[i + 1] === '~' && s[i + 2] !== undefined && !/\s/.test(s[i + 2])) {
      const close = findCloser(s, i, '~~');
      if (close > 0) {
        out.push({ t: 'strike', c: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    pushText(out, c);
    i++;
  }
  return out;
}

/** Plain text of inline nodes (for accessibility labels and previews). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : inlineText(n.c))).join('');
}
