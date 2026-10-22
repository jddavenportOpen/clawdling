// The app's web build against the REAL Clawdling server (real tmux, the server's own fake
// `claude`), served from the same origin by the server itself (CLAWDLING_WEB_DIR). This is the
// contract test between the two halves: if the server changes a route or a shape, it fails here.
//
// It runs when the server is next to the app (the merged repo: mobile/ inside the server's repo),
// or when CLAWDLING_SERVER_DIR points at a server checkout. Otherwise every test is skipped.
// Nothing here reaches the real claude, Telegram or iMessage: the server runs in its test mode.

import { test as base, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist-web');
const SERVER_DIR = path.resolve(process.env.CLAWDLING_SERVER_DIR || path.join(HERE, '../../..'));
const HELPERS = path.join(SERVER_DIR, 'test', 'helpers.mjs');
const HAVE_SERVER = fs.existsSync(path.join(SERVER_DIR, 'bin', 'clawdling.js')) && fs.existsSync(HELPERS);

interface Real {
  url: string;
  token: string;
  home: string;
  link: string;
}

const test = base.extend<{}, { real: Real }>({
  real: [
    async ({}, use) => {
      const h = await import(pathToFileURL(HELPERS).href);
      const home: string = h.tempHome('cl-mobile-e2e-');
      const claudeDir: string = h.tempHome('cl-mobile-claude-');
      const socket: string = h.uniqueSocket();
      const env = h.testEnv({ CLAWDLING_TMUX_SOCKET: socket, CLAWDLING_WEB_DIR: DIST, CLAUDE_CONFIG_DIR: claudeDir });
      h.cli(['init', '--defaults'], { env, home });
      const srv = await h.startServerProc({ home, env });
      try {
        await use({ url: srv.url, token: srv.token, home, link: `clawdling://connect?url=${encodeURIComponent(srv.url)}&t=${srv.token}` });
      } finally {
        await srv.stop();
        try {
          execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
        } catch {
          // no sessions left
        }
        // kill-server can leave the socket file behind; do not litter the tmux directory.
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket), { force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(claudeDir, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],
});

test.skip(!HAVE_SERVER, `no Clawdling server at ${SERVER_DIR} (set CLAWDLING_SERVER_DIR)`);
test.skip(!fs.existsSync(path.join(DIST, 'index.html')), 'no web build: run `npm run export:web`');

async function pair(page: Page, real: Real) {
  await page.goto(`${real.url}/`);
  await expect(page.getByTestId('connect-screen')).toBeVisible();
  await page.getByTestId('paste-button').click();
  await page.getByTestId('link-input').fill(real.link);
  await page.getByTestId('link-connect').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
}

test('pairs, starts a session from an agent, and chats through the real transcript', async ({ page, real }) => {
  await pair(page, real);
  const agents = page.getByTestId('section-agents');
  for (const name of ['Donna', 'Work', 'Health', 'Money', 'Home']) await expect(agents.getByText(name, { exact: true })).toBeVisible();

  await page.getByTestId('agent-row-work').click();
  await send(page, 'Plan my week');
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/);
  const chat = page.getByTestId('chat-screen');
  await expect(page.getByTestId('chat-title')).toHaveText('Plan my week', { timeout: 15_000 });
  await expect(chat.getByText('assistant: Plan my week')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('chat-header').getByText('Ready')).toBeVisible({ timeout: 15_000 });
  await expect(chat.getByTestId('msg-me').filter({ hasText: 'Plan my week' })).toHaveCount(1);

  await send(page, 'Add a review on Friday');
  await expect(chat.getByText('assistant: Add a review on Friday')).toBeVisible({ timeout: 20_000 });
  await expect(chat.getByTestId('msg-me').filter({ hasText: 'Add a review on Friday' })).toHaveCount(1);
  // The server's transcript plumbing (caveats, thinking) never reaches the chat.
  await expect(chat.getByText('plumbing the chat view must hide')).toHaveCount(0);
  await expect(chat.getByText('hidden', { exact: true })).toHaveCount(0);

  // A permission prompt: the step shows as a tool line, and the app will not type into the prompt.
  await send(page, 'run it, permission? please');
  await expect(page.getByTestId('needs-card')).toContainText('Waiting for your permission', { timeout: 20_000 });
  await expect(chat.getByText('echo hi')).toBeVisible();
  await expect(page.getByTestId('composer-input')).not.toBeEditable();
  await page.screenshot({ path: path.resolve(HERE, '../screenshots/real-server-permission.png') });
});

test('Donna routes a request through the real server', async ({ page, real }) => {
  await pair(page, real);
  await page.getByTestId('ask-donna').click();
  const donna = page.getByTestId('donna-screen');
  await send(page, 'health: book a physio appointment');
  await expect(donna.getByText('Health agent is on it.')).toBeVisible({ timeout: 60_000 });
  await expect(donna.getByTestId('msg-me').filter({ hasText: 'health: book a physio appointment' })).toHaveCount(1);
  await page.getByTestId('header-back').click();
  // The session Donna started is on Home, under the Health agent.
  const rows = page.getByTestId('home-screen').locator('[data-testid^="session-row-"]').filter({ hasText: 'Health' });
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: path.resolve(HERE, '../screenshots/real-server-donna.png') });
});

test('a folder-trust question before start blocks typing until answered on the computer', async ({ page, real }) => {
  fs.writeFileSync(path.join(real.home, 'domains', 'money', '.fake-claude-trust'), '');
  try {
    await pair(page, real);
    await page.getByTestId('agent-row-money').click();
    await send(page, 'Check my subscriptions');
    await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('needs-card')).toContainText('Waiting for an answer before it starts', { timeout: 20_000 });
    await expect(page.getByTestId('composer-input')).not.toBeEditable();
  } finally {
    fs.rmSync(path.join(real.home, 'domains', 'money', '.fake-claude-trust'), { force: true });
  }
});
