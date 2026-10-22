// Theme: dark by default, light when the OS asks for it, overridable in Settings.
import { load, save } from './prefs.js';

const listeners = new Set();
let mq = null;

function systemMode() {
  try {
    if (!mq) mq = window.matchMedia('(prefers-color-scheme: light)');
    return mq.matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function getThemePref() {
  const p = load('theme', 'system');
  return p === 'dark' || p === 'light' ? p : 'system';
}

export function getTheme() {
  const p = getThemePref();
  return p === 'system' ? systemMode() : p;
}

function apply() {
  const mode = getTheme();
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  for (const fn of [...listeners]) fn(mode);
}

export function setThemePref(pref) {
  save('theme', pref === 'system' ? null : pref);
  apply();
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initTheme() {
  systemMode();
  try {
    mq.addEventListener('change', () => { if (getThemePref() === 'system') apply(); });
  } catch { /* old browsers: theme just will not follow live OS changes */ }
  apply();
}
