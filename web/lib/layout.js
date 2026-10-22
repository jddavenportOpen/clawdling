// Workspace geometry shared by the pane grid and by spawn (which sizes a new
// session's tmux window to the pane it is about to get, so Claude's first
// screen is drawn at the right width instead of being reflowed).
import { getState } from './store.js';
import { estimateSize } from './term.js';

// Pick a grid that keeps terminals wide enough for Claude Code's UI.
export function gridShape(n, W, H) {
  if (n <= 1 || !W || !H) return { cols: 1, rows: 1 };
  let best = null;
  for (let cols = 1; cols <= Math.min(n, 4); cols += 1) {
    const rows = Math.ceil(n / cols);
    const w = W / cols;
    const h = H / rows;
    const ratio = w / h;
    const s = Math.min(w / 600, 1) * 1.2 + Math.min(h / 300, 1) - Math.abs(Math.log(ratio / 1.4)) * 0.35;
    if (!best || s > best.s) best = { cols, rows, s };
  }
  return { cols: best.cols, rows: best.rows };
}


const PANE_HEAD = 36;
const TABS = 38;

// Terminal size the next pane will have once a session is added to the open set.
export function nextPaneSize(extra = 1) {
  const el = typeof document !== 'undefined' && document.querySelector('.panes');
  if (!el || !el.clientWidth || !el.clientHeight) return null;
  const W = el.clientWidth;
  const H = el.clientHeight;
  const s = getState();
  const n = s.open.length + extra;
  const layout = s.mobile || n <= 1 ? 'focus' : s.layout;
  let w = W;
  let h = H;
  if (layout === 'split') { w = W / 2; h = H - TABS; }
  else if (layout === 'focus' && n > 1) h = H - TABS;
  else if (layout === 'grid') {
    const g = gridShape(n, W, H);
    w = W / g.cols;
    h = Math.max(220, H / g.rows);
  }
  return estimateSize(w, h - PANE_HEAD);
}
