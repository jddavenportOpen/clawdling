// localStorage with a namespace. Storage can be missing or throw (private
// windows, blocked site data), so every access is guarded and falls back.
const NS = 'clawdling.';

export function load(key, fallback) {
  try {
    const raw = window.localStorage.getItem(NS + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    if (value === undefined || value === null) window.localStorage.removeItem(NS + key);
    else window.localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the UI still works, it just will not remember */
  }
}
