// End-to-end smoke of the app's web build against the mock server, in an iPhone-sized window.
// Build first: `npm run export:web`. Screenshots land in test/screenshots/ (gitignored).

import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from '../mock-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist-web');
const SHOTS = path.resolve(HERE, '../screenshots');

type Mock = Awaited<ReturnType<typeof startMockServer>>;

const test = base.extend<{ shot: (name: string) => Promise<void> }, { mock: Mock }>({
  mock: [
    async ({}, use) => {
      if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('No web build. Run `npm run export:web` first.');
      const m = await startMockServer({ staticDir: DIST, replyMs: 900, donnaMs: 1200 });
      await use(m);
      await m.close();
    },
    { scope: 'worker' },
  ],
  shot: async ({ page }, use) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await use(async (name: string) => {
      await page.waitForTimeout(350); // let pills and fonts settle
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    });
  },
});

test.describe.configure({ mode: 'serial' });

async function control(mock: Mock, what: string, body: object = {}) {
  const res = await fetch(`${mock.url}/__mock/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`mock control ${what} failed: ${res.status}`);
  return res.json();
}

async function openApp(page: Page, mock: Mock) {
  await page.goto(`${mock.url}/`);
  await expect(page.getByTestId('connect-screen')).toBeVisible();
}

async function connect(page: Page, mock: Mock) {
  await openApp(page, mock);
  await page.getByTestId('paste-button').click();
  await page.getByTestId('link-input').fill(mock.link);
  await page.getByTestId('link-connect').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('org-name')).toHaveText("Alex's org");
}

async function send(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
}

test.beforeEach(async ({ mock }) => {
  await control(mock, 'reset');
});

test('connects with a pasted link and lists every session by its real name', async ({ page, mock, shot }) => {
  await openApp(page, mock);
  await shot('01-connect');
  await page.getByTestId('paste-button').click();
  await page.getByTestId('link-input').fill(mock.link);
  await shot('01b-connect-paste');
  await page.getByTestId('link-connect').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('org-name')).toHaveText("Alex's org");
  await expect(page.getByText(`Connected to 127.0.0.1:${mock.port}`)).toBeVisible();

  const needs = page.getByTestId('section-needs');
  await expect(needs.getByText('Categorize September spending')).toBeVisible();
  await expect(needs.getByText("Plan this week's workouts")).toBeVisible();
  await expect(needs.getByText('Draft the Q4 planning agenda')).toBeVisible();
  await expect(needs.getByText('Claude needs your permission to use Bash')).toBeVisible();
  await expect(page.getByTestId('section-live').getByText('Fix the broken pricing page links')).toBeVisible();
  await expect(page.getByTestId('section-recent').getByText('Find three kitchen contractors')).toBeVisible();
  await expect(page.getByTestId('section-recent').getByText("Summarize Monday's standup notes")).toBeVisible();
  for (const name of ['Donna', 'Work', 'Health', 'Money', 'Home', 'Website relaunch', 'Kitchen remodel']) {
    await expect(page.getByTestId('section-agents').getByText(name, { exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('demo-badge')).toHaveCount(0);
  await shot('02-home');
});

test('opens a chat with markdown and tool lines, sends, and sees the reply', async ({ page, mock, shot }) => {
  await connect(page, mock);
  await page.getByText("Plan this week's workouts").first().click();
  await expect(page.getByTestId('chat-screen')).toBeVisible();
  await expect(page.getByTestId('chat-title')).toHaveText("Plan this week's workouts");
  const chat = page.getByTestId('chat-screen');
  await expect(chat.getByText('Lower + intervals')).toBeVisible(); // a markdown table cell
  await expect(chat.getByText('memory/LOG.md')).toBeVisible(); // a tool line
  await expect(page.getByTestId('chat-header').getByText('Ready')).toBeVisible();
  await shot('03-chat');

  await send(page, 'Add a mobility session on Sunday');
  await expect(chat.getByTestId('msg-me').filter({ hasText: 'Add a mobility session on Sunday' })).toBeVisible();
  await expect(chat.getByText('Got it: "Add a mobility session on Sunday"')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-header').getByText('Ready')).toBeVisible();
  // The optimistic copy is replaced by the server's: the message shows once.
  await expect(chat.getByTestId('msg-me').filter({ hasText: 'Add a mobility session on Sunday' })).toHaveCount(1);
  await shot('03b-chat-reply');
});

test('a collapsed run of tool calls expands', async ({ page, mock }) => {
  await connect(page, mock);
  await page.getByText('Fix the broken pricing page links').first().click();
  const chat = page.getByTestId('chat-screen');
  await expect(chat.getByText('3 more steps')).toBeVisible();
  await expect(chat.getByText('npm test -- MobileNav')).toHaveCount(0);
  await chat.getByTestId('tool-toggle').click();
  await expect(chat.getByText('npm test -- MobileNav')).toBeVisible();
  await expect(chat.getByText('Show less')).toBeVisible();
  await expect(chat.getByTestId('typing-row')).toBeVisible(); // status: working
});

test('tapping an agent starts a session with the first message', async ({ page, mock, shot }) => {
  await connect(page, mock);
  await page.getByTestId('agent-row-money').click();
  await expect(page.getByTestId('draft-empty')).toBeVisible();
  await expect(page.getByText('New session with Money')).toBeVisible();
  await shot('04-new-session');
  await send(page, 'Find every subscription I pay for. Then rank them by cost.');
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('chat-title')).toHaveText('Find every subscription I pay for');
  await expect(page.getByTestId('chat-screen').getByText('Got it: "Find every subscription I pay for. Then rank them by cost."')).toBeVisible({ timeout: 15_000 });
});

test('a permission prompt is shown, and sending asks first', async ({ page, mock, shot }) => {
  await connect(page, mock);
  await page.getByText('Categorize September spending').first().click();
  await expect(page.getByTestId('needs-card')).toContainText('Waiting for your permission');
  await expect(page.getByTestId('needs-card')).toContainText('Claude needs your permission to use Bash');
  await shot('05-needs-you');

  const chat = page.getByTestId('chat-screen');
  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await send(page, 'yes, go ahead');
  await expect.poll(() => asked).toContain('presses Return in the terminal');
  await expect(chat.getByTestId('msg-me').filter({ hasText: 'yes, go ahead' })).toHaveCount(0);

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('composer-send').click();
  await expect(chat.getByTestId('msg-me').filter({ hasText: 'yes, go ahead' })).toBeVisible();
  await expect(chat.getByText('Got it: "yes, go ahead"')).toBeVisible({ timeout: 15_000 });
});

test('an ended session can be resumed', async ({ page, mock }) => {
  await connect(page, mock);
  await page.getByText('Find three kitchen contractors').first().click();
  await expect(page.getByTestId('ended-bar')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toHaveCount(0);
  await page.getByTestId('resume-button').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('chat-header').getByText('Ready')).toBeVisible();
});

test('Donna answers and routes work to an agent', async ({ page, mock, shot }) => {
  await connect(page, mock);
  await page.getByTestId('ask-donna').click();
  await expect(page.getByTestId('donna-screen')).toBeVisible();
  const donna = page.getByTestId('donna-screen');
  await expect(donna.getByText('Can someone look at why the pricing page is broken on my phone?')).toBeVisible();
  await expect(donna.getByText('via Telegram').first()).toBeVisible();
  await send(page, 'Ask Work to draft my priorities for tomorrow');
  await expect(donna.getByTestId('typing-row')).toContainText('Donna is on it');
  await expect(donna.getByText(/^Work is on it: "Ask Work to draft my priorities for tomorrow"/)).toBeVisible({ timeout: 15_000 });
  await expect(donna.getByTestId('typing-row')).toHaveCount(0);
  await expect(donna.getByTestId('msg-me').filter({ hasText: 'Ask Work to draft my priorities for tomorrow' })).toHaveCount(1);
  await shot('06-donna');

  await page.getByTestId('header-back').click();
  await expect(page.getByTestId('home-screen').getByText('Ask Work to draft my priorities for tomorrow')).toBeVisible({ timeout: 10_000 });
});

test('network trouble shows the retry banner, then recovers', async ({ page, mock, shot }) => {
  await connect(page, mock);
  await control(mock, 'offline', { on: true });
  await expect(page.getByTestId('retry-banner')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('retry-banner')).toContainText("Can't reach your computer");
  await shot('07-offline');
  await control(mock, 'offline', { on: false });
  await page.getByTestId('retry-banner').getByText('Retry now').click();
  await expect(page.getByTestId('retry-banner')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText(`Connected to 127.0.0.1:${mock.port}`)).toBeVisible();
});

test('a rejected pairing code sends you back to Connect with a clear message', async ({ page, mock, shot }) => {
  await connect(page, mock);
  await control(mock, 'rotate-token');
  await expect(page.getByTestId('connect-screen')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('connect-notice')).toContainText("no longer accepts this phone's pairing code");
  await shot('08-auth-lost');
  // Reloading stays disconnected: the stale code was removed.
  await page.reload();
  await expect(page.getByTestId('connect-screen')).toBeVisible();
});

test('bad links are refused with a reason', async ({ page, mock }) => {
  await openApp(page, mock);
  await page.getByTestId('paste-button').click();
  await page.getByTestId('link-input').fill('javascript:alert(1)');
  await page.getByTestId('link-connect').click();
  await expect(page.getByTestId('connect-problem')).toContainText('Only clawdling://, http:// and https:// links');

  const wrong = mock.link.replace(/t=[0-9a-f]+/, `t=${'0'.repeat(64)}`);
  await page.getByTestId('link-input').fill(wrong);
  await page.getByTestId('link-connect').click();
  await expect(page.getByTestId('connect-problem')).toContainText('That pairing code was not accepted');

  await page.getByTestId('link-input').fill(`clawdling://connect?url=${encodeURIComponent(mock.url)}`);
  await page.getByTestId('link-connect').click();
  await expect(page.getByTestId('connect-problem')).toContainText('no pairing code');
});

test('a deep link asks before connecting', async ({ page, mock }) => {
  const q = `url=${encodeURIComponent(mock.url)}&t=${mock.token}`;
  await page.goto(`${mock.url}/connect?${q}`);
  await expect(page.getByTestId('confirm-card')).toContainText(`Connect to 127.0.0.1:${mock.port}?`);
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-card')).toHaveCount(0);
  await expect(page.getByTestId('scan-button')).toBeVisible();

  await page.goto(`${mock.url}/connect?${q}`);
  await page.getByTestId('confirm-connect').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
});

test('an older server degrades gracefully', async ({ page, mock }) => {
  await connect(page, mock);
  await control(mock, 'legacy', { on: true });
  await page.getByText('Draft the Q4 planning agenda').first().click();
  const chat = page.getByTestId('chat-screen');
  await expect(chat.getByText('Update Clawdling on your computer')).toBeVisible();
  await expect(chat.getByText('The agenda is ready: five items, 60 minutes, decisions first.')).toBeVisible(); // last_message fallback
  await page.getByTestId('header-back').click();
  await page.getByTestId('ask-donna').click();
  await expect(page.getByTestId('donna-screen').getByText('Update Clawdling on your computer')).toBeVisible();
  await control(mock, 'legacy', { on: false });
});

test('settings show the masked code and privacy note; disconnect returns to Connect', async ({ page, mock, shot }) => {
  await connect(page, mock);
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  await expect(page.getByTestId('server-row-value')).toHaveText(`127.0.0.1:${mock.port}`);
  await expect(page.getByTestId('token-row-value')).toHaveText(`••••••••${mock.token.slice(-4)}`);
  await expect(page.getByTestId('status-row-value')).toHaveText('Connected · Clawdling 1.0.0-mock');
  await expect(page.getByTestId('privacy-note')).toHaveText(
    'This app talks only to the server you connect it to. No accounts, no analytics, no data leaves your devices.',
  );
  await expect(page.getByText(mock.token)).toHaveCount(0);
  await shot('09-settings');
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('disconnect-button').click();
  await expect(page.getByTestId('connect-screen')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('connect-screen')).toBeVisible();
});

test('the demo works with no server at all', async ({ page, mock, shot }) => {
  const apiCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) apiCalls.push(r.url());
  });
  await openApp(page, mock);
  await page.getByTestId('demo-button').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('home-screen').getByTestId('demo-badge')).toBeVisible();
  await expect(page.getByTestId('home-screen').getByText('Categorize September spending')).toBeVisible();
  await shot('10-demo-home');

  await page.getByText("Plan this week's workouts").first().click();
  await expect(page.getByTestId('chat-screen').getByTestId('demo-badge')).toBeVisible();
  await send(page, 'Add a stretching day');
  await expect(page.getByTestId('chat-screen').getByText(/This is the demo, so nothing actually ran/)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('header-back').click();

  await page.getByTestId('ask-donna').click();
  await send(page, 'Ask health to book a physio appointment');
  await expect(page.getByTestId('donna-screen').getByText(/^Health is on it/)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('header-back').click();

  await page.getByTestId('settings-button').click();
  await page.getByTestId('disconnect-button').click(); // "Leave the demo" needs no confirmation
  await expect(page.getByTestId('connect-screen')).toBeVisible();
  expect(apiCalls).toEqual([]);
});

test('help explains how to connect', async ({ page, mock, shot }) => {
  await openApp(page, mock);
  await page.getByTestId('help-link').click();
  await expect(page.getByTestId('help-screen')).toBeVisible();
  await expect(page.getByText('clawdling start --host 0.0.0.0').first()).toBeVisible();
  await expect(page.getByText('Away from home: Tailscale')).toBeVisible();
  await shot('11-help');
  await page.getByTestId('header-back').click();
  await expect(page.getByTestId('connect-screen')).toBeVisible();
});
