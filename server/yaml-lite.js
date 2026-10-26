// A small YAML subset, enough for the files 1.6 reads and writes: checks.yaml, the plugin-eval
// frontmatter of prompt.md and graders/*.md, and .clawdling-suite.yaml. No dependency, no code
// execution, no anchors, aliases or tags (they are refused, never guessed at).
//
// Supported: mappings (`key: value`, nested by indentation), block sequences (`- item`, including
// `- key: value` maps), flow sequences and maps (`[a, "b"]`, `{source: file, path: x}`), plain,
// single- and double-quoted scalars, `|` and `>` block scalars, true/false/null and numbers, and
// `#` comments. What it writes is plain YAML that any YAML 1.2 parser reads the same way.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
  }
}

const MAX_DEPTH = 20;

/** A plain scalar's value: true/false/null/~, an integer or a float, else the text itself. */
function plainValue(s) {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?\d+$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^[&*!%@`]/.test(t)) throw new YamlError(`unsupported YAML (anchors, aliases, tags or reserved characters): ${t.slice(0, 40)}`);
  return t;
}

function unquoteDouble(body, line) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', 0: '\0', b: '\b', f: '\f', e: '\x1b', ' ': ' ', N: '\u0085', _: ' ' };
    if (n in map) out += map[n];
    else if (n === 'x' || n === 'u' || n === 'U') {
      const len = n === 'x' ? 2 : n === 'u' ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + len);
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw new YamlError('bad escape in a double-quoted string', line);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += len;
    } else throw new YamlError(`unknown escape \\${n ?? ''} in a double-quoted string`, line);
  }
  return out;
}

/** Read a quoted scalar starting at s[i]; returns [value, next index]. */
function readQuoted(s, i, line) {
  const q = s[i];
  let j = i + 1;
  let body = '';
  for (; j < s.length; j++) {
    const c = s[j];
    if (q === "'" && c === "'") {
      if (s[j + 1] === "'") {
        body += "'";
        j++;
        continue;
      }
      return [body, j + 1];
    }
    if (q === '"' && c === '\\') {
      body += c + (s[j + 1] ?? '');
      j++;
      continue;
    }
    if (q === '"' && c === '"') return [unquoteDouble(body, line), j + 1];
    body += c;
  }
  throw new YamlError('a quoted string is not closed', line);
}

/** Parse a flow collection or scalar at s[i] (inside [] or {}); returns [value, next index]. */
function readFlow(s, i, line, depth = 0) {
  if (depth > MAX_DEPTH) throw new YamlError('nested too deeply', line);
  while (s[i] === ' ' || s[i] === '\t') i++;
  const c = s[i];
  if (c === '[' || c === '{') {
    const close = c === '[' ? ']' : '}';
    const out = c === '[' ? [] : {};
    i++;
    for (;;) {
      while (s[i] === ' ' || s[i] === '\t') i++;
      if (s[i] === close) return [out, i + 1];
      if (i >= s.length) throw new YamlError(`a flow ${c === '[' ? 'sequence' : 'map'} is not closed`, line);
      if (c === '[') {
        const [v, j] = readFlow(s, i, line, depth + 1);
        out.push(v);
        i = j;
      } else {
        let key;
        if (s[i] === '"' || s[i] === "'") [key, i] = readQuoted(s, i, line);
        else {
          const m = /^[^:,{}[\]]+/.exec(s.slice(i));
          if (!m) throw new YamlError('a flow map needs key: value', line);
          key = m[0].trim();
          i += m[0].length;
        }
        while (s[i] === ' ') i++;
        if (s[i] !== ':') throw new YamlError(`a flow map needs key: value (after "${String(key).slice(0, 30)}")`, line);
        i++;
        const [v, j] = readFlow(s, i, line, depth + 1);
        if (Object.hasOwn(out, key)) throw new YamlError(`duplicate key "${key}"`, line);
        out[key] = v;
        i = j;
      }
      while (s[i] === ' ' || s[i] === '\t') i++;
      if (s[i] === ',') i++;
      else if (s[i] !== close) throw new YamlError('expected , or the closing bracket', line);
    }
  }
  if (c === '"' || c === "'") return readQuoted(s, i, line);
  // A plain scalar inside a flow collection ends at , ] or }.
  const m = /^[^,\]}]*/.exec(s.slice(i));
  return [plainValue(m[0]), i + m[0].length];
}

/** Strip a trailing comment (a # after a space, outside quotes) and trailing spaces. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      // Only a quote that starts a token opens a quoted span ("it's" in plain text does not).
      if (i === 0 || /[\s[{,:]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).replace(/\s+$/, '');
  }
  return s.replace(/\s+$/, '');
}

/** A scalar or flow value written after `key:` or `- ` on one line. */
function inlineValue(raw, line) {
  const s = raw.trim();
  if (s === '') return undefined;
  if (s[0] === '[' || s[0] === '{' || s[0] === '"' || s[0] === "'") {
    const [v, j] = readFlow(s, 0, line);
    if (s.slice(j).trim()) throw new YamlError(`unexpected text after a value: ${s.slice(j).trim().slice(0, 30)}`, line);
    return v;
  }
  return plainValue(s);
}

/**
 * Parse YAML text (the subset above) into plain objects. Throws YamlError with a line number on
 * anything it does not understand, so a hand-edited file is never misread silently.
 */
export function parseYaml(text) {
  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^\s*(%|---\s*\S)/m.test(src.split('\n')[0] || '')) throw new YamlError('YAML directives are not supported');
  const lines = src.split('\n').map((raw, n) => ({ raw, n: n + 1 }));
  let pos = 0;
  const indentOf = (s) => s.length - s.replace(/^ +/, '').length;
  const significant = () => {
    while (pos < lines.length) {
      const l = lines[pos];
      if (/^ *\t/.test(l.raw) && l.raw.trim()) throw new YamlError('tabs are not allowed for indentation', l.n);
      const t = stripComment(l.raw);
      if (t.trim() === '' || t.trim() === '---' || t.trim() === '...') {
        pos++;
        continue;
      }
      return { ...l, text: t, indent: indentOf(t) };
    }
    return null;
  };

  // A `|` or `>` block scalar: the lines indented deeper than `parentIndent`.
  const blockScalar = (style, parentIndent) => {
    const body = [];
    let indent = null;
    while (pos < lines.length) {
      const raw = lines[pos].raw;
      if (raw.trim() === '') {
        body.push('');
        pos++;
        continue;
      }
      const ind = indentOf(raw);
      if (ind <= parentIndent) break;
      if (indent === null) indent = ind;
      if (ind < indent) break;
      body.push(raw.slice(indent));
      pos++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    const strip = style.includes('-');
    let out = style[0] === '|' ? body.join('\n') : body.reduce((acc, l, i) => (i === 0 ? l : l === '' || body[i - 1] === '' ? `${acc}\n${l}` : `${acc} ${l}`), '');
    return strip ? out : `${out}\n`;
  };

  const value = (indent, depth) => {
    if (depth > MAX_DEPTH) throw new YamlError('nested too deeply');
    const first = significant();
    if (!first || first.indent < indent) return null;
    if (/^-( |$)/.test(first.text.trim())) return sequence(first.indent, depth);
    return mapping(first.indent, depth);
  };

  // A flow collection may continue on the next lines until its brackets close.
  const joinFlow = (rest) => {
    let text = rest;
    const open = () => {
      let depth = 0;
      let q = null;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
          if (q === '"' && c === '\\') i++;
          else if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
      }
      return depth > 0;
    };
    while (/^\s*[[{]/.test(text) && open() && pos < lines.length) {
      text += ` ${stripComment(lines[pos].raw).trim()}`;
      pos++;
    }
    return text;
  };

  const afterKey = (rawRest, l, depth) => {
    const rest = joinFlow(rawRest);
    const r = rest.trim();
    if (/^[|>][-+]?$/.test(r)) return blockScalar(r, l.indent);
    const v = inlineValue(rest, l.n);
    if (v !== undefined) return v;
    const next = significant();
    if (!next || next.indent < l.indent || (next.indent === l.indent && !/^-( |$)/.test(next.text.trim()))) return null;
    if (next.indent === l.indent) return sequence(next.indent, depth + 1); // `key:\n- a` (same indent)
    return value(next.indent, depth + 1);
  };

  const mapping = (indent, depth) => {
    const out = {};
    for (;;) {
      const l = significant();
      if (!l || l.indent < indent) return out;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.n);
      const t = l.text.trim();
      if (/^-( |$)/.test(t)) return out;
      let key;
      let rest;
      if (t[0] === '"' || t[0] === "'") {
        const [k, j] = readQuoted(t, 0, l.n);
        if (t[j] !== ':') throw new YamlError('expected : after a quoted key', l.n);
        key = k;
        rest = t.slice(j + 1);
      } else {
        const m = /^([^:#]+?):(?:\s|$)(.*)$/.exec(t);
        if (!m) throw new YamlError(`expected key: value, got "${t.slice(0, 40)}"`, l.n);
        key = m[1].trim();
        rest = m[2];
      }
      if (Object.hasOwn(out, key)) throw new YamlError(`duplicate key "${key}"`, l.n);
      pos++;
      out[key] = afterKey(rest, l, depth);
    }
  };

  const sequence = (indent, depth) => {
    const out = [];
    for (;;) {
      const l = significant();
      if (!l || l.indent < indent) return out;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.n);
      const t = l.text.trim();
      if (!/^-( |$)/.test(t)) return out;
      const item = t.slice(1).replace(/^ /, '');
      const itemIndent = l.indent + 1 + (t.slice(1).length - t.slice(1).replace(/^ +/, '').length);
      pos++;
      if (item.trim() === '') {
        out.push(value(l.indent + 1, depth + 1));
        continue;
      }
      // `- key: value` starts a map item; its other keys follow at the item's indent.
      if (/^[^"'[{][^:#]*:(\s|$)/.test(item) || /^["'][^"']*["']:(\s|$)/.test(item)) {
        lines.splice(pos, 0, { raw: `${' '.repeat(itemIndent)}${item}`, n: l.n });
        out.push(mapping(itemIndent, depth + 1));
        continue;
      }
      if (/^[|>][-+]?$/.test(item.trim())) {
        out.push(blockScalar(item.trim(), l.indent));
        continue;
      }
      out.push(inlineValue(item, l.n));
    }
  };

  const root = value(0, 0);
  const left = significant();
  if (left) throw new YamlError(`unexpected text: ${left.text.trim().slice(0, 40)}`, left.n);
  return root;
}

// -------------------------------------------------------------------------------------- writing

const RESERVED = /^(true|false|null|yes|no|on|off|~|y|n)$/i;

/** A scalar as YAML: plain when that reads back as the same string, else double-quoted. */
export function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new YamlError('numbers must be finite');
    return String(v);
  }
  const s = String(v);
  const plainOk = s !== '' && !RESERVED.test(s) && !/^[-+]?(\d|\.\d)/.test(s) && /^[A-Za-z_./(][A-Za-z0-9 _./()@+-]*$/.test(s) && !/:( |$)| #|\s$|^[-?:,[\]{}#&*!|>'"%@`]/.test(s);
  return plainOk ? s : JSON.stringify(s);
}

function flowValue(v) {
  if (Array.isArray(v)) return `[${v.map(flowValue).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${yamlScalar(k)}: ${flowValue(x)}`).join(', ')}}`;
  return yamlScalar(v);
}

/**
 * Write a mapping as YAML. Scalars and flow collections go on one line; an array of maps (the
 * checks in checks.yaml) is written as a block sequence. Keys keep their order.
 */
export function stringifyYaml(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      out.push(`${yamlScalar(k)}:`);
      for (const item of v) {
        const entries = Object.entries(item).filter(([, x]) => x !== undefined);
        entries.forEach(([ik, iv], i) => out.push(`${i === 0 ? '  - ' : '    '}${yamlScalar(ik)}: ${flowValue(iv)}`));
      }
      continue;
    }
    out.push(`${yamlScalar(k)}: ${flowValue(v)}`);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------- frontmatter

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/;

/** {fm, body, had}: a Markdown file's YAML frontmatter (between --- lines) and the rest. */
export function splitFrontmatter(text) {
  const s = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = FRONTMATTER.exec(s);
  if (!m) {
    if (/^---[ \t]*\n/.test(s)) throw new YamlError('the frontmatter has an opening --- but no closing ---');
    return { fm: {}, body: s, had: false };
  }
  const fm = m[1].trim() ? parseYaml(m[1]) : {};
  if (fm !== null && (typeof fm !== 'object' || Array.isArray(fm))) throw new YamlError('the frontmatter must be key: value lines');
  return { fm: fm || {}, body: s.slice(m[0].length), had: true };
}

/** A Markdown file with frontmatter. */
export function joinFrontmatter(fm, body) {
  const head = Object.keys(fm).length ? stringifyYaml(fm) : '';
  return `---\n${head}---\n\n${String(body ?? '').replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
}
