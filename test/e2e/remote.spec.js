// Settings -> Use from anywhere (1.3): off by default; "Set it up with an agent" shows what will
// happen, then starts a real setup session whose first message is the visible prompt; once an
// address is registered the card shows each one's check, pairs a device, and turns it all off.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { login, reset, isMock, mockRequests, mock, sessions, focusedPane } from './helpers.js';

test.beforeEach(() => { test.skip(!isMock(), 'drives Use from anywhere through the mock'); });

const card = (page) => page.getByTestId('remote-card');
// Screenshots for the visual review land here when CLAWDLING_E2E_SHOTS names a folder.
const SHOTS = process.env.CLAWDLING_E2E_SHOTS || '';
async function shot(page, name, locator) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await (locator || page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
const spawns = async () => (await mockRequests()).filter((r) => r.method === 'POST' && r.path === '/api/sessions');

const TS = 'https://box.example.ts.net';
const CF = 'https://cockpit.example.com';

test('off by default: two plain choices, the reason there is no cloud copy, and one button', async ({ page }) => {
  await reset('default');
  await login(page, '#/settings');
  const c = card(page);
  await expect(c).toBeVisible();
  await expect(c.getByTestId('remote-state')).toHaveText('Off');
  await expect(c).toContainText('Open your cockpit from your phone or another computer.');
  const ts = c.getByTestId('remote-path-tailscale');
  const cf = c.getByTestId('remote-path-cloudflare');
  await expect(ts).toContainText('Just my devices');
  await expect(ts).toContainText('Recommended');
  await expect(ts).toContainText('Tailscale, free for personal use');
  await expect(ts).toContainText('Nothing goes on the public internet.');
  await expect(ts).toContainText('Needs the free Tailscale app on this computer and on your phone');
  await expect(ts).toHaveAttribute('aria-checked', 'true');
  await expect(cf).toContainText('A web address with a sign-in');
  await expect(cf).toContainText('Beta');
  await expect(cf).toContainText('Needs a free Cloudflare account and a domain on Cloudflare.');
  await expect(c).toContainText('has to run on the computer where your Claude Code and your files live');
  await expect(c.getByTestId('remote-setup')).toHaveText('Set it up with an agent');
  await expect(c.getByTestId('remote-host')).toHaveCount(0);
  await shot(page, 'us52-settings-off', c);
});

test('the confirm sheet says what will happen and shows the exact prompt; Cancel starts nothing', async ({ page }) => {
  await reset('default');
  await login(page, '#/settings');
  await card(page).getByTestId('remote-setup').click();
  const sheet = page.getByTestId('remote-sheet');
  await expect(sheet).toBeVisible();
  for (const line of [
    'This opens a setup chat with a Claude Code agent.',
    'The agent asks before it installs or changes anything.',
    'It uses your Claude plan.',
    'You sign in to Tailscale yourself, in your browser. Clawdling never sees those logins.',
  ]) await expect(sheet).toContainText(line);
  await expect(sheet.getByTestId('remote-prompt')).toHaveText('/remote-access tailscale');
  await shot(page, 'us53-setup-sheet', page.locator('.modal'));
  await page.getByTestId('remote-sheet-cancel').click();
  await expect(sheet).toHaveCount(0);
  expect(await spawns()).toEqual([]);
  // Escape closes it too.
  await card(page).getByTestId('remote-setup').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('remote-sheet')).toHaveCount(0);
});

test('Start setup opens a new session whose first message is the visible prompt', async ({ page }) => {
  await reset('default');
  await login(page, '#/settings');
  await card(page).getByTestId('remote-setup').click();
  await page.getByTestId('remote-sheet-start').click();
  await expect(page).toHaveURL(/#\/$/);
  const pane = focusedPane(page);
  await expect(pane).toBeVisible();
  await expect(pane).toContainText('Use from anywhere');
  await expect(pane.locator('.xterm-rows')).toContainText('/remote-access tailscale');
  const req = await spawns();
  expect(req).toHaveLength(1);
  expect(req[0].body).toMatchObject({ agent: 'scratch', prompt: '/remote-access tailscale', title: 'Use from anywhere' });
  const s = (await sessions()).find((x) => x.title === 'Use from anywhere');
  expect(s && s.agent).toBe('scratch');
  await shot(page, 'us53-setup-session');
});

test('the Cloudflare choice asks for Cloudflare and sends /remote-access cloudflare', async ({ page }) => {
  await reset('default');
  await login(page, '#/settings');
  await card(page).getByTestId('remote-path-cloudflare').click();
  await expect(card(page).getByTestId('remote-path-cloudflare')).toHaveAttribute('aria-checked', 'true');
  await card(page).getByTestId('remote-setup').click();
  await expect(page.getByTestId('remote-sheet')).toContainText('You sign in to Cloudflare yourself');
  await expect(page.getByTestId('remote-prompt')).toHaveText('/remote-access cloudflare');
  await expect(page.getByTestId('remote-sheet')).toContainText('choose “Yes, I trust this folder”');
  await shot(page, 'us58-cloudflare-sheet', page.locator('.modal'));
  await page.getByTestId('remote-sheet-start').click();
  await expect(focusedPane(page)).toBeVisible();
  expect((await spawns())[0].body.prompt).toBe('/remote-access cloudflare');
});

test('status rows: each address with its last check, in plain words', async ({ page }) => {
  await reset('default');
  await mock('remote', {
    hosts: [
      { url: `${TS}:8743`, kind: 'tailscale', status: 'private', ago: 2 },
      { url: CF, kind: 'cloudflare', status: 'access', ago: 5 },
      { url: 'https://old.example.ts.net', kind: 'tailscale', status: 'unreachable', detail: 'Could not reach this Clawdling at https://old.example.ts.net (timed out).' },
    ],
    devices: [{ label: 'iPhone · Safari', ago: 60 * 24 }],
  });
  await login(page, '#/settings');
  const c = card(page);
  await expect(c.getByTestId('remote-state')).toHaveText('On');
  const rows = c.getByTestId('remote-host');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(`${TS}:8743`);
  await expect(rows.nth(0)).toContainText('Tailscale');
  await expect(rows.nth(0).getByTestId('remote-status')).toHaveText('Private to your devices ✓');
  await expect(rows.nth(1)).toContainText('Cloudflare (beta)');
  await expect(rows.nth(1).getByTestId('remote-status')).toHaveText('Behind Cloudflare Access ✓');
  await expect(rows.nth(2).getByTestId('remote-status')).toHaveText('Not reachable');
  await expect(rows.nth(2)).toContainText('timed out');
  await expect(rows.nth(0)).toContainText('checked 2 min ago');
  await expect(c.getByTestId('remote-device')).toHaveCount(1);
  await expect(c.getByTestId('remote-device')).toContainText('iPhone · Safari');
  await shot(page, 'us54-status-rows', c);
  await c.getByTestId('remote-check').click();
  await expect(c.getByTestId('remote-check')).toContainText('Check again');
  expect((await mockRequests()).some((r) => r.path === '/api/remote/check')).toBe(true);
  await expect(rows.nth(1)).toContainText('checked just now');
});

test('Add a device shows a one-time QR link (no token), then says when the phone signed in', async ({ page }) => {
  await reset('default');
  await mock('remote', { hosts: [{ url: `${TS}:8743`, kind: 'tailscale', status: 'private' }] });
  await login(page, '#/settings');
  const c = card(page);
  await expect(c).toContainText('No device is paired yet.');
  await c.getByTestId('remote-add-device').click();
  const block = c.getByTestId('remote-pairing');
  await expect(block).toBeVisible();
  await expect(block.getByTestId('remote-qr')).toBeVisible();
  await expect(block).toContainText('This link works once, for 10 minutes.');
  await expect(block).toContainText('It never holds your cockpit\'s private token.');
  await expect(block).toContainText('with Tailscale on and signed in to the same account');
  const link = await block.locator('.remote-link').textContent();
  expect(link).toMatch(/^https:\/\/box\.example\.ts\.net:8743\/\?pair=[A-Za-z0-9_-]{32}$/);
  expect(link).not.toContain('mock-token');
  await shot(page, 'us55-pairing-qr', c);
  await mock('remote-pair', { label: 'iPhone · Safari' });
  await expect(c.getByTestId('remote-paired')).toContainText('iPhone · Safari is signed in.', { timeout: 8000 });
  await expect(c.getByTestId('remote-device')).toHaveCount(1);
  await shot(page, 'us55-paired', c);
  // Sign it out again.
  await c.getByTestId('remote-paired').getByRole('button', { name: 'Done' }).click();
  await c.getByTestId('remote-signout').click();
  await expect(c.getByTestId('remote-device')).toHaveCount(0);
});

test('Turn off: one confirm, stops answering at once, and can start the removal chat', async ({ page }) => {
  await reset('default');
  await mock('remote', { hosts: [{ url: `${TS}:8743`, kind: 'tailscale', status: 'private' }], devices: [{ label: 'iPhone · Safari' }] });
  await login(page, '#/settings');
  const c = card(page);
  await c.getByTestId('remote-off').click();
  const sheet = page.getByTestId('remote-off-sheet');
  await expect(sheet).toContainText('This computer stops answering https://box.example.ts.net:8743 right away, and every paired device is signed out.');
  await expect(sheet).toContainText('Remove the tunnel too');
  await expect(sheet).toContainText('/remote-access off');
  await shot(page, 'us56-turn-off-sheet', page.locator('.modal'));
  await sheet.getByTestId('remote-off-tunnel').check();
  await page.getByTestId('remote-off-confirm').click();
  // The removal chat opens and gets the visible prompt.
  await expect(focusedPane(page)).toBeVisible();
  await expect(focusedPane(page).locator('.xterm-rows')).toContainText('/remote-access off');
  const reqs = await mockRequests();
  const offAt = reqs.findIndex((r) => r.path === '/api/remote/enabled' && r.body.enabled === false);
  const spawnAt = reqs.findIndex((r) => r.path === '/api/sessions' && r.body.prompt === '/remote-access off');
  expect(offAt).toBeGreaterThanOrEqual(0);
  expect(spawnAt).toBeGreaterThan(offAt);
  await page.goto('/#/settings');
  await expect(card(page).getByTestId('remote-state')).toHaveText('Off');
  await expect(card(page).getByTestId('remote-status')).toHaveText('Turned off');
  await expect(card(page).getByTestId('remote-on')).toBeVisible();
  await expect(card(page).getByTestId('remote-remove')).toHaveText('Remove the tunnel too');
  await expect(card(page).getByTestId('remote-device')).toHaveCount(0);
  await shot(page, 'us56-turned-off', card(page));
});

test('Turn off without removing the tunnel starts nothing', async ({ page }) => {
  await reset('default');
  await mock('remote', { hosts: [{ url: CF, kind: 'cloudflare', status: 'access' }] });
  await login(page, '#/settings');
  await card(page).getByTestId('remote-off').click();
  await page.getByTestId('remote-off-confirm').click();
  await expect(card(page).getByTestId('remote-state')).toHaveText('Off');
  expect(await spawns()).toEqual([]);
});

test('a Cloudflare address whose sign-in moved is shown as refused, with why', async ({ page }) => {
  await reset('default');
  await mock('remote', {
    hosts: [{ url: CF, kind: 'cloudflare', status: 'unprotected', detail: 'https://cockpit.example.com now sends visitors to a different Cloudflare Access team than the one you registered, so Clawdling does not answer it. Every device paired through it was signed out: pair them again once it is fixed.' }],
  });
  await login(page, '#/settings');
  const row = card(page).getByTestId('remote-host');
  await expect(row.getByTestId('remote-status')).toHaveText('Not behind Cloudflare Access ✗');
  await expect(row).toContainText('different Cloudflare Access team');
  await expect(card(page).getByTestId('remote-add-device')).toHaveCount(0);
  await expect(card(page).getByTestId('remote-none-answering')).toContainText('No address is answering right now');
  await shot(page, 'us58-refused-row', card(page));
});

test('on a paired phone, the cockpit leaves out what only the computer can do', async ({ page }) => {
  await reset('empty');
  await mock('health', { remote: true });
  await mock('remote', { hosts: [{ url: `${TS}:8743`, kind: 'tailscale', status: 'private' }], devices: [{ label: 'iPhone · Safari' }] });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByTestId('first-import')).toHaveCount(0);
  await expect(page.getByTestId('first-trust')).toHaveCount(0);
  await shot(page, 'us59-phone-cockpit');
});

