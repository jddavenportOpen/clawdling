// Terminal output plumbing between a tmux pane and browser terminals.
//
// tmux is the real terminal emulator for every Clawdling pane: it already answers the queries a
// TUI sends at startup (device attributes, cursor position, colours...). The raw pane output we
// relay to xterm.js still contains those queries, and xterm.js would answer them a second time;
// its answers would arrive back as keystrokes typed into the session. OutputFilter removes the
// queries (and only the queries) from the stream. ModeTracker remembers the terminal modes the
// app switched on (bracketed paste, mouse, focus, cursor keys) so a viewer that joins late gets
// them replayed with its snapshot.

const MAX_CARRY = 4096;

/** Scan one escape sequence starting at s[i] === ESC. */
export function scanEscape(s, i) {
  const n = s.length;
  if (i + 1 >= n) return { incomplete: true };
  const c = s[i + 1];
  if (c === '[') {
    for (let j = i + 2; j < n; j++) {
      const code = s.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) return { end: j + 1, type: 'csi' };
      if (code < 0x20 || code > 0x7e) return { end: j, type: 'broken' };
    }
    return { incomplete: true };
  }
  if (c === ']' || c === 'P' || c === '_' || c === '^' || c === 'X') {
    for (let j = i + 2; j < n; j++) {
      const ch = s[j];
      if (ch === '\x07' && c === ']') return { end: j + 1, type: 'osc' };
      if (ch === '\x1b') {
        if (j + 1 >= n) return { incomplete: true };
        if (s[j + 1] === '\\') return { end: j + 2, type: c === ']' ? 'osc' : c === 'P' ? 'dcs' : 'str' };
        return { end: j, type: 'broken' };
      }
    }
    return { incomplete: true };
  }
  if ('()*+-./#% '.includes(c)) {
    if (i + 2 >= n) return { incomplete: true };
    return { end: i + 3, type: 'esc' };
  }
  return { end: i + 2, type: 'esc' };
}

/** True for sequences that ask the terminal to reply (and must not reach a second emulator). */
export function isQuery(seq, type) {
  if (type === 'csi') {
    const body = seq.slice(2);
    const final = body[body.length - 1];
    const params = body.slice(0, -1);
    if (final === 'c') return true; // DA1 / DA2 / DA3
    if (final === 'n') return true; // DSR, cursor position report, ?996n colour scheme...
    if (final === 'p' && params.endsWith('$')) return true; // DECRQM
    if (final === 'q' && params.startsWith('>')) return true; // XTVERSION
    if (final === 'u' && params === '?') return true; // kitty keyboard flags query
    if (final === 't') return true; // XTWINOPS reports and resize requests
    if (final === 'm' && params.startsWith('?')) return true; // XTQMODKEYS
    return false;
  }
  if (type === 'osc') {
    const body = seq.slice(2).replace(/(?:\x07|\x1b\\)$/, '');
    return /(?:^|;)\?$/.test(body); // OSC 4/10/11/12/52 ...;? colour and clipboard queries
  }
  if (type === 'dcs') {
    const body = seq.slice(2);
    return body.startsWith('$q') || body.startsWith('+q'); // DECRQSS, XTGETTCAP
  }
  return false;
}

export class OutputFilter {
  constructor() {
    this.carry = '';
  }

  /** Filter a chunk. Incomplete trailing escape sequences are held until the next chunk. */
  push(chunk) {
    const s = this.carry + chunk;
    this.carry = '';
    let out = '';
    let i = 0;
    while (i < s.length) {
      const j = s.indexOf('\x1b', i);
      if (j === -1) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, j);
      const r = scanEscape(s, j);
      if (r.incomplete) {
        if (s.length - j <= MAX_CARRY) {
          this.carry = s.slice(j);
          break;
        }
        out += s[j];
        i = j + 1;
        continue;
      }
      const seq = s.slice(j, r.end);
      if (!isQuery(seq, r.type)) out += seq;
      i = r.end;
    }
    return out;
  }

  /** Release whatever is held (called when the stream goes quiet). */
  flush() {
    const c = this.carry;
    this.carry = '';
    return c;
  }
}

const TRACKED = new Set([1, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004]);

export class ModeTracker {
  constructor(initial = []) {
    this.on = new Set(initial.filter((m) => TRACKED.has(m)));
    this.cursorHidden = false;
  }

  feed(text) {
    if (text.indexOf('\x1b') === -1) return;
    if (text.includes('\x1bc')) {
      this.on.clear();
      this.cursorHidden = false;
    }
    const re = /\x1b\[\?([0-9;]+)([hl])/g;
    let m;
    while ((m = re.exec(text))) {
      const set = m[2] === 'h';
      for (const p of m[1].split(';')) {
        const n = Number(p);
        if (n === 25) this.cursorHidden = !set;
        else if (TRACKED.has(n)) {
          if (set) this.on.add(n);
          else this.on.delete(n);
        }
      }
    }
  }

  list() {
    return [...this.on].sort((a, b) => a - b);
  }

  /** Escape sequences that re-create the tracked modes in a fresh terminal. */
  replay() {
    let s = '';
    for (const m of this.list()) s += `\x1b[?${m}h`;
    if (this.cursorHidden) s += '\x1b[?25l';
    return s;
  }
}
