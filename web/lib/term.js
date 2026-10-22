// One live terminal per open session: xterm.js + fit + clickable links, bound to
// WS /ws/term/:sid (SPEC §4). Snapshot first, then live output; input and
// resize go back as {"t":"in"} / {"t":"resize"}. Reconnects with backoff.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { getTheme, onThemeChange } from './theme.js';
import { isAppShortcut } from './keys.js';
import { copyText, isMac } from './util.js';
import { load } from './prefs.js';

export const PALETTES = {
  dark: {
    background: '#101216', foreground: '#d9dde3', cursor: '#b4a9ff', cursorAccent: '#101216',
    selectionBackground: 'rgba(154, 140, 255, 0.32)', selectionInactiveBackground: 'rgba(154, 140, 255, 0.16)',
    black: '#1c1f24', red: '#f0717a', green: '#5cc98f', yellow: '#e9b949', blue: '#64a8f0', magenta: '#b496f5',
    cyan: '#5cc3c7', white: '#c9ced6', brightBlack: '#666d78', brightRed: '#ff8f97', brightGreen: '#7ddba8',
    brightYellow: '#f5cd6e', brightBlue: '#88bdf5', brightMagenta: '#c9b1fa', brightCyan: '#82d6d9', brightWhite: '#f2f4f7',
  },
  light: {
    background: '#fbfbfc', foreground: '#1e2227', cursor: '#5b45e0', cursorAccent: '#fbfbfc',
    selectionBackground: 'rgba(91, 69, 224, 0.22)', selectionInactiveBackground: 'rgba(91, 69, 224, 0.12)',
    black: '#24292f', red: '#c4313b', green: '#1f7a4a', yellow: '#8a6100', blue: '#1d63b8', magenta: '#7a3fc4',
    cyan: '#13757a', white: '#6e7781', brightBlack: '#57606a', brightRed: '#d6454f', brightGreen: '#2a8f5a',
    brightYellow: '#9e7200', brightBlue: '#2f74c8', brightMagenta: '#8d55d6', brightCyan: '#1b878c', brightWhite: '#8c959f',
  },
};

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';
const TRACE_BUCKETS = 40;

export const terms = new Map(); // sid -> TermView

// capture-pane snapshots are "\n"-joined; a terminal needs CR+LF or lines staircase.
export function normalizeSnapshot(data) {
  return String(data || '').replace(/\r?\n/g, '\r\n');
}

export class TermView {
  constructor(sid, hooks = {}) {
    this.sid = sid;
    this.hooks = hooks;
    this.ws = null;
    this.attempt = 0;
    this.timer = 0;
    this.opened = false;
    this.disposed = false;
    this.ended = false;
    this.conn = 'idle';
    this.sent = { cols: 0, rows: 0 };
    this.buckets = new Array(TRACE_BUCKETS).fill(0);
    this.wantFocus = false;

    this.term = new Terminal({
      fontFamily: MONO,
      fontSize: Number(load('termFontSize', 13)) || 13,
      lineHeight: 1.18,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      scrollback: 10000,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      drawBoldTextInBrightColors: false,
      smoothScrollDuration: 0,
      theme: PALETTES[getTheme()],
      allowTransparency: false,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((ev, uri) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.term.onData((d) => this.input(d));
    this.term.onBinary((d) => this.input(d));
    this.unTheme = onThemeChange((mode) => { this.term.options.theme = PALETTES[mode]; });
    terms.set(sid, this);
  }

  attach(el) {
    this.el = el;
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(el);
    this.layout();
    // One attempt even when ended: the server may still hold the last screen.
    this.connect(true);
  }

  layout() {
    if (this.disposed || !this.el) return;
    if (this.el.clientWidth < 24 || this.el.clientHeight < 24) return; // hidden pane: wait until shown
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
    }
    try { this.fit.fit(); } catch { /* not measurable yet */ }
    if (this.wantFocus) { this.wantFocus = false; this.term.focus(); }
    clearTimeout(this.rt);
    this.rt = setTimeout(() => this.sendResize(), 40);
  }

  setFontSize(px) {
    this.term.options.fontSize = px;
    this.layout();
  }

  sendResize(force = false) {
    const { cols, rows } = this.term;
    if (!cols || !rows || !this.opened) return;
    if (!force && cols === this.sent.cols && rows === this.sent.rows) return;
    if (this.sendMsg({ t: 'resize', cols, rows })) this.sent = { cols, rows };
  }

  sendMsg(msg) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  input(data) {
    if (this.ended) return;
    this.sendMsg({ t: 'in', data });
  }

  onKey(e) {
    if (isAppShortcut(e)) return false; // the app's window listener handles it
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Shift+Enter = newline in Claude Code's prompt (sent as Meta+Enter).
      if (e.type === 'keydown') { e.preventDefault(); this.input('\x1b\r'); }
      return false;
    }
    if (!isMac && e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      if (e.type === 'keydown') {
        e.preventDefault();
        const sel = this.term.getSelection();
        if (sel) copyText(sel);
      }
      return false;
    }
    return true;
  }

  setConn(c) {
    if (this.conn === c) return;
    this.conn = c;
    if (this.hooks.onConn) this.hooks.onConn(c);
  }

  connect(force = false) {
    if (this.disposed || (this.ended && !force)) return;
    clearTimeout(this.timer);
    if (this.ws && this.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws/term/${encodeURIComponent(this.sid)}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.setConn(this.attempt ? 'reconnecting' : 'connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setConn('open');
      this.sendResize(true);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'snapshot') {
        this.term.reset();
        if (m.data) this.term.write(normalizeSnapshot(m.data));
      } else if (m.t === 'out') {
        const d = typeof m.data === 'string' ? m.data : '';
        if (d) {
          this.term.write(d);
          this.buckets[this.buckets.length - 1] += d.length;
        }
      } else if (m.t === 'status') {
        if (this.hooks.onStatus) this.hooks.onStatus(m.status, m);
      } else if (m.t === 'ended') {
        this.markEnded();
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.disposed) return;
      if (this.ended) { this.setConn('ended'); return; }
      if (ev && (ev.code === 4401 || ev.code === 4403)) { this.setConn('denied'); return; }
      if (ev && ev.code === 4404) { this.markEnded(); return; }
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows and owns the retry */ };
  }

  scheduleReconnect() {
    if (this.disposed || this.ended) return;
    const delay = Math.min(8000, 400 * 2 ** this.attempt) + Math.floor(Math.random() * 250);
    this.attempt += 1;
    this.setConn('reconnecting');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  markEnded() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.setConn('ended');
    if (this.hooks.onEnded) this.hooks.onEnded();
  }

  // Store says the session is (no longer) ended: stop retrying, or come back.
  setEnded(ended) {
    if (ended) {
      if (!this.ended) {
        this.ended = true;
        clearTimeout(this.timer);
        this.setConn('ended');
      }
      return;
    }
    if (this.ended) {
      this.ended = false;
      this.attempt = 0;
      if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } this.ws = null; }
      this.connect();
    } else if (!this.ws && this.conn !== 'reconnecting') {
      this.connect();
    }
  }

  // Shift the activity buckets one second and return the trace polyline points.
  tick() {
    this.buckets.shift();
    this.buckets.push(0);
  }

  tracePoints(w = 48, h = 14) {
    const b = this.buckets;
    const peak = Math.max(1600, ...b);
    const den = Math.log1p(peak);
    const step = w / (b.length - 1);
    let pts = '';
    for (let i = 0; i < b.length; i += 1) {
      const y = h - 1 - (b[i] ? (Math.log1p(b[i]) / den) * (h - 2) : 0);
      pts += `${(i * step).toFixed(1)},${y.toFixed(1)} `;
    }
    return pts.trim();
  }

  recentlyActive() {
    const b = this.buckets;
    return b[b.length - 1] + b[b.length - 2] + b[b.length - 3] > 0;
  }

  focus() {
    if (this.opened) this.term.focus();
    else this.wantFocus = true;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.rt);
    if (this.ro) this.ro.disconnect();
    if (this.ws) { try { this.ws.close(1000, 'pane closed'); } catch { /* ignore */ } }
    this.ws = null;
    if (this.unTheme) this.unTheme();
    try { this.term.dispose(); } catch { /* ignore */ }
    if (terms.get(this.sid) === this) terms.delete(this.sid);
  }
}

// One clock for every trace: shift buckets once a second, then repaint.
const traceListeners = new Set();
export function onTraceTick(fn) {
  traceListeners.add(fn);
  return () => traceListeners.delete(fn);
}
if (typeof window !== 'undefined') {
  setInterval(() => {
    for (const v of terms.values()) v.tick();
    for (const fn of [...traceListeners]) fn();
  }, 1000);
}
