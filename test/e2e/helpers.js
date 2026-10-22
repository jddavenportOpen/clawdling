// Shared E2E helpers. Every fixture is built through the PUBLIC API (sessions,
// hooks, agents), so the same specs run against the mock and a real server.
// The only mock-only call is reset(), which real mode replaces with scoping
// every assertion to the sids a test created itself.
import { expect } from '@playwright/test';

export const BASE = () => process.env.CLAWDLING_E2E_URL;
export const TOKEN = () => process.env.CLAWDLING_E2E_TOKEN;
export const isMock = () => (process.env.CLAWDLING_E2E_MODE || 'mock') === 'mock';

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
  if (!isMock()) return;
  const res = await fetch(new URL('/__mock/reset', BASE()), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixture }),
  });
  if (!res.ok) throw new Error(`mock reset failed: ${res.status}`);
}

export async function mockRequests() {
  const res = await fetch(new URL('/__mock/requests', BASE()));
  return res.json();
}

export async function sessions() {
  const r = await api('GET', '/api/sessions');
  return Array.isArray(r) ? r : (r && r.sessions) || [];
}

export async function sessionBySid(sid) {
  return (await sessions()).find((s) => s.sid === sid);
}

// Create a session and drive it to a status through the hook contract.
export async function spawn({ agent, title, status = 'starting', notification, prompt }) {
  const s = unwrap(await api('POST', '/api/sessions', { agent, ...(title ? { title } : {}), ...(prompt ? { prompt } : {}) }), 'session');
  const hook = (event, payload = {}) => api('POST', '/api/hooks', { event, sid: s.sid, payload });
  if (status === 'working') await hook('UserPromptSubmit', { prompt: title || 'Work on it' });
  if (status === 'ready') { await hook('UserPromptSubmit', { prompt: title || 'Work on it' }); await hook('Stop'); }
  if (status === 'needs_you') await hook('Notification', { message: notification || 'Claude needs your permission to use Bash' });
  if (status === 'ended') await api('DELETE', `/api/sessions/${s.sid}`);
  if (title) await api('PATCH', `/api/sessions/${s.sid}`, { title }); // a prompt hook may have derived a different one
  return s.sid;
}

export async function seed(specs) {
  const out = {};
  for (const spec of specs) out[spec.key || spec.title] = await spawn(spec);
  return out;
}

// A standard set: one of each status, all titled, plus one untitled.
export async function seedStandard() {
  await reset('empty');
  const tag = isMock() ? '' : ` ${Date.now().toString(36).slice(-4)}`;
  return seed([
    { key: 'roadmap', agent: 'work', title: `Draft the Q4 roadmap${tag}`, status: 'needs_you', notification: 'Claude needs your permission to use Bash' },
    { key: 'brief', agent: 'donna', title: `Morning brief${tag}`, status: 'ready' },
    { key: 'training', agent: 'health', title: `Plan this week's training${tag}`, status: 'working' },
    { key: 'quotes', agent: 'home', title: `Compare dishwasher quotes${tag}`, status: 'ready' },
    { key: 'reconcile', agent: 'money', title: `Reconcile September${tag}`, status: 'ended' },
    { key: 'untitled', agent: 'work', status: 'starting' },
  ]);
}

export async function login(page, hash = '') {
  await page.goto(`/?t=${encodeURIComponent(TOKEN())}`);
  await expect(page.locator('[data-rail]')).toBeVisible();
  if (hash) {
    await page.goto(`/${hash}`);
    await expect(page.locator('[data-rail]')).toBeVisible();
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
