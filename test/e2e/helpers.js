// Shared E2E helpers. Every fixture is built through the PUBLIC API (sessions,
// hooks, agents), so the same specs run against the mock and a real server.
// The only mock-only call is reset(), which real mode replaces with scoping
// every assertion to the sids a test created itself.
import { expect } from '@playwright/test';

export const BASE = () => process.env.CLAWDLING_E2E_URL;
export const TOKEN = () => process.env.CLAWDLING_E2E_TOKEN;
export const isMock = () => (process.env.CLAWDLING_E2E_MODE || 'mock') === 'mock';
// Real server we booted ourselves (temp home, fake claude): safe to configure channels in.
export const ownsServer = () => process.env.CLAWDLING_E2E_OWNED === '1';
// A suffix that keeps names unique when a real server accumulates state across tests.
export const tag = () => (isMock() ? '' : ` ${Date.now().toString(36).slice(-5)}`);

export async function api(method, path, body) {
  const res = await fetch(new URL(path, BASE()), {
    method,
    headers: { 'x-clawdling-token': TOKEN(), 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return data;
}

const unwrap = (r, key) => (r && r[key] && !r.sid && !r.id ? r[key] : r);

export async function reset(fixture = 'empty') {
  if (!isMock()) {
    // A real server we booted ourselves: end what earlier tests left running so the box
    // never carries dozens of idle sessions. Never touch a server we did not start.
    if (ownsServer()) {
      const live = (await sessions()).filter((x) => x.status !== 'ended');
      await Promise.all(live.map((x) => api('DELETE', `/api/sessions/${x.sid}`).catch(() => {})));
    }
    return;
  }
  const res = await fetch(new URL('/__mock/reset', BASE()), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixture }),
  });
  if (!res.ok) throw new Error(`mock reset failed: ${res.status}`);
}

export async function mockRequests() {
  const res = await fetch(new URL('/__mock/requests', BASE()));
  return res.json();
}

// Mock-only control routes (see test/e2e/mock-server.mjs).
export async function mock(route, body = {}) {
  const res = await fetch(new URL(`/__mock/${route}`, BASE()), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`mock ${route} failed: ${res.status}`);
}

export async function health() {
  const res = await fetch(new URL('/api/health', BASE()));
  return res.json();
}

// WCAG 2.x contrast ratio of two CSS colours (rgb()/rgba() strings from getComputedStyle).
export function contrast(fg, bg) {
  const parse = (c) => (String(c).match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [a, b] = [lum(parse(fg)), lum(parse(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

export async function sessions() {
  const r = await api('GET', '/api/sessions');
  return Array.isArray(r) ? r : (r && r.sessions) || [];
}

export async function sessionBySid(sid) {
  return (await sessions()).find((s) => s.sid === sid);
}

async function waitStarted(sid) {
  // claude's own SessionStart hook moves a fresh session out of "starting"; apply our hooks
  // after it, or it would overwrite them.
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const s = await sessionBySid(sid);
    if (s && s.status !== 'starting') return;
    await new Promise((r) => setTimeout(r, 60));
  }
}

// Create a session and drive it to a status through the hook contract.
export async function spawn({ agent, title, status = 'starting', notification, prompt, lastMessage }) {
  const s = unwrap(await api('POST', '/api/sessions', { agent, ...(title ? { title } : {}), ...(prompt ? { prompt } : {}) }), 'session');
  const hook = (event, payload = {}) => api('POST', '/api/hooks', { event, sid: s.sid, payload });
  if (status !== 'starting') await waitStarted(s.sid);
  if (status === 'working') await hook('UserPromptSubmit', { prompt: title || 'Work on it' });
  // A finished turn carries Claude's last message (Claude Code sends it with Stop): "your turn".
  if (status === 'ready') { await hook('UserPromptSubmit', { prompt: title || 'Work on it' }); await hook('Stop', { last_assistant_message: lastMessage || 'Done. Tell me what to do next.' }); }
  if (status === 'needs_you') await hook('Notification', { message: notification || 'Claude needs your permission to use Bash' });
  if (status === 'ended') await api('DELETE', `/api/sessions/${s.sid}`);
  if (title) await api('PATCH', `/api/sessions/${s.sid}`, { title }); // a prompt hook may have derived a different one
  return s.sid;
}

export async function seed(specs) {
  const sids = await Promise.all(specs.map((spec) => spawn(spec)));
  const out = {};
  specs.forEach((spec, i) => { out[spec.key || spec.title] = sids[i]; });
  return out;
}

// A standard set: one of each status, all titled, plus one untitled.
export async function seedStandard() {
  await reset('empty');
  const t = tag();
  return seed([
    { key: 'roadmap', agent: 'work', title: `Draft the Q4 roadmap${t}`, status: 'needs_you', notification: 'Claude needs your permission to use Bash' },
    { key: 'brief', agent: 'donna', title: `Morning brief${t}`, status: 'ready' },
    { key: 'training', agent: 'health', title: `Plan this week's training${t}`, status: 'working' },
    { key: 'quotes', agent: 'home', title: `Compare dishwasher quotes${t}`, status: 'ready' },
    { key: 'reconcile', agent: 'money', title: `Reconcile September${t}`, status: 'ended' },
    { key: 'untitled', agent: 'work', status: 'starting' },
  ]);
}

export async function login(page, hash = '') {
  await page.goto(`/?t=${encodeURIComponent(TOKEN())}`);
  await expect(page.locator('[data-rail]')).toBeVisible();
  if (hash) {
    await page.goto(`/${hash}`);
    // On a phone the rail hides on every page but the cockpit list; the shell is always there.
    await expect(page.locator('.app[data-route]')).toBeVisible();
    await expect(page.locator('[data-rail]')).toBeAttached();
  }
}

export const row = (page, sid) => page.locator(`.rail .row-wrap[data-sid="${sid}"]`);
export const rowButton = (page, sid) => row(page, sid).locator('button.row');
export const pane = (page, sid) => page.locator(`[data-pane="${sid}"]`);
export const panes = (page) => page.locator('[data-pane]');
export const focusedPane = (page) => page.locator('[data-pane][data-focused="true"]');

export async function openPanes(page, sids) {
  for (const sid of sids) {
    await rowButton(page, sid).click();
    await expect(pane(page, sid)).toHaveAttribute('data-focused', 'true');
  }
}

// xterm renders rows as DOM text; this reads what the terminal shows.
export const termText = (page, sid) => pane(page, sid).locator('.xterm-rows');
