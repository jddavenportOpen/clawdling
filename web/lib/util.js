export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
export const MOD = isMac ? '⌘' : 'Ctrl';

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export function toMs(ts) {
  if (ts == null || ts === '') return 0;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? 0 : n;
}

// "now", "4m", "3h", "yesterday", "5d", "Oct 3"
export function relTime(ts, now = Date.now()) {
  const t = toMs(ts);
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function longTime(ts) {
  const t = toMs(ts);
  if (!t) return '';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Case-insensitive match of every whitespace-separated term somewhere in the haystack.
export function matches(query, ...fields) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = fields.filter(Boolean).join(' \u0001 ').toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

// Score for the palette: word-start hits beat mid-word hits; all terms must hit.
export function score(query, label, extra = '') {
  const q = (query || '').trim().toLowerCase();
  if (!q) return 1;
  const l = (label || '').toLowerCase();
  const e = (extra || '').toLowerCase();
  let total = 0;
  for (const term of q.split(/\s+/)) {
    let best = 0;
    const i = l.indexOf(term);
    if (i === 0) best = 10;
    else if (i > 0) best = /[\s:/_\-.]/.test(l[i - 1]) ? 7 : 4;
    else if (e.includes(term)) best = 2;
    if (!best) return 0;
    total += best;
  }
  return total + (l.startsWith(q) ? 5 : 0);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
