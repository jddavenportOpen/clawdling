// The clean chat view: the default for every pane once Claude Code has a transcript, with the
// raw terminal one click away (and still mounted underneath).
import { test, expect } from '@playwright/test';
import { login, reset, spawn, mock, mockRequests, openPanes, pane, isMock } from './helpers.js';

test.skip(() => !isMock(), 'the chat transcript is injected through the mock');

const TRANSCRIPT = [
  { role: 'user', text: 'Show me the plan' },
  {
    role: 'assistant',
    text: [
      'Here is **the plan**, with `code` and a [link](https://example.com/docs).',
      '',
      '```js',
      `const veryLongLine = "${'x'.repeat(400)}";`,
      '```',
      '',
      '| Step | Owner |',
      '|------|-------|',
      '| Draft | Work |',
      '| Ship | Donna |',
      '',
      '<script>window.__pwned = 1</script>',
    ].join('\n'),
    tools: [
      { name: 'Read', summary: 'src/plan.md', detail: 'Read 120 lines from src/plan.md' },
      { name: 'Bash', summary: 'npm test' },
    ],
    model: 'claude-sonnet-5',
  },
];

async function chatSession(title = 'Chat test') {
  await reset('empty');
  const sid = await spawn({ agent: 'work', title, status: 'ready' });
  await mock('transcript', { sid, messages: TRANSCRIPT });
  return sid;
}

test.describe('chat view', () => {
  test('a session with a transcript opens in chat: messages, code block, table, safe text', async ({ page }) => {
    const sid = await chatSession();
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    await expect(p.getByTestId('chat-view')).toBeVisible();
    await expect(p).toHaveAttribute('data-view', 'chat');
    await expect(p.getByTestId('pane-view-chat')).toHaveAttribute('aria-pressed', 'true');
    const msgs = p.getByTestId('chat-msg');
    await expect(msgs).toHaveCount(2);
    await expect(msgs.nth(0)).toHaveAttribute('data-role', 'user');
    await expect(msgs.nth(0)).toHaveText('Show me the plan');
    await expect(msgs.nth(1)).toHaveAttribute('data-role', 'assistant');
    await expect(msgs.nth(1).locator('strong')).toHaveText('the plan');
    const link = msgs.nth(1).locator('a', { hasText: 'link' });
    await expect(link).toHaveAttribute('href', 'https://example.com/docs');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const code = p.getByTestId('chat-code');
    await expect(code).toContainText('const veryLongLine');
    await expect(code).toContainText('js');
    // Long code scrolls inside its block, never the page or the chat.
    const pre = code.locator('pre');
    expect(await pre.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await p.locator('.chat-list').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const table = p.getByTestId('chat-table');
    await expect(table.locator('th')).toHaveText(['Step', 'Owner']);
    await expect(table.locator('tbody tr')).toHaveCount(2);
    // Raw HTML is text, never markup.
    await expect(msgs.nth(1)).toContainText('<script>window.__pwned = 1</script>');
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    // The terminal is still mounted underneath (it owns the live connection), just hidden.
    await expect(p.locator('.term-host')).toBeAttached();
    await expect(p.locator('.term-host')).toBeHidden();
    // The composer sits in the chat view on desktop too.
    await expect(p.getByTestId('chat-view').getByTestId('composer-input')).toBeVisible();
    await expect(p.getByTestId('chat-pending-note')).toHaveCount(0);
  });

  test('a tool call is one line and expands to its detail', async ({ page }) => {
    const sid = await chatSession();
    await login(page);
    await openPanes(page, [sid]);
    const tools = pane(page, sid).getByTestId('chat-tool');
    await expect(tools).toHaveCount(2);
    const first = tools.nth(0);
    await expect(first.locator('summary')).toHaveText(/Read\s*src\/plan\.md/);
    const h = await first.locator('summary').evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeLessThan(40); // one line
    await expect(first.getByTestId('chat-tool-detail')).toBeHidden();
    await first.locator('summary').click();
    await expect(first.getByTestId('chat-tool-detail')).toBeVisible();
    await expect(first.getByTestId('chat-tool-detail')).toHaveText('Read 120 lines from src/plan.md');
    // No detail: the summary is shown.
    await tools.nth(1).locator('summary').click();
    await expect(tools.nth(1).getByTestId('chat-tool-detail')).toHaveText('npm test');
  });

  test('the chat composer sends and the reply appears live', async ({ page }) => {
    const sid = await chatSession();
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    await expect(p.getByTestId('chat-msg')).toHaveCount(2);
    const input = p.getByTestId('chat-view').getByTestId('composer-input');
    await input.fill('hello chat');
    await input.press('Enter');
    await expect.poll(async () => (await mockRequests()).find((r) => r.method === 'POST' && r.path === `/api/sessions/${sid}/send`)?.body).toEqual({ text: 'hello chat', enter: true });
    await expect(input).toHaveValue('');
    await expect(p.getByTestId('chat-msg')).toHaveCount(4, { timeout: 8000 });
    await expect(p.getByTestId('chat-msg').nth(2)).toHaveAttribute('data-role', 'user');
    await expect(p.getByTestId('chat-msg').nth(2)).toHaveText('hello chat');
    await expect(p.getByTestId('chat-msg').nth(3).locator('strong')).toHaveText('hello chat');
  });

  test('Raw shows the terminal, is remembered per pane across a reload, and Chat comes back', async ({ page }) => {
    const sid = await chatSession();
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    await expect(p.getByTestId('chat-view')).toBeVisible();
    await p.getByTestId('pane-view-raw').click();
    await expect(p.getByTestId('pane-view-raw')).toHaveAttribute('aria-pressed', 'true');
    await expect(p.getByTestId('chat-view')).toHaveCount(0);
    await expect(p.locator('.term-host')).toBeVisible();
    await expect(p.locator('.xterm-rows')).toBeVisible();
    const box = await p.locator('.term-host .xterm-screen').boundingBox();
    expect(box && box.width).toBeGreaterThan(200);
    await page.reload();
    await expect(pane(page, sid)).toBeVisible();
    await expect(pane(page, sid).getByTestId('pane-view-raw')).toHaveAttribute('aria-pressed', 'true');
    await expect(pane(page, sid).locator('.xterm-rows')).toBeVisible();
    await expect(pane(page, sid).getByTestId('chat-view')).toHaveCount(0);
    await pane(page, sid).getByTestId('pane-view-chat').click();
    await expect(pane(page, sid).getByTestId('chat-view')).toBeVisible();
    await expect(pane(page, sid).getByTestId('chat-msg')).toHaveCount(2);
  });

  test('a session with no transcript yet shows the raw terminal and a note', async ({ page }) => {
    await reset('empty');
    const sid = await spawn({ agent: 'work', title: 'No transcript', status: 'ready' });
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    await expect(p.getByTestId('chat-pending-note')).toHaveText('Chat appears once Claude Code starts.');
    await expect(p.locator('.xterm-rows')).toBeVisible();
    await expect(p.getByTestId('chat-view')).toHaveCount(0);
    await expect(p.getByTestId('pane-view-chat')).toHaveAttribute('aria-pressed', 'true');
    // The transcript appears: the pane switches to chat by itself.
    await mock('transcript', { sid, messages: TRANSCRIPT });
    await expect(p.getByTestId('chat-view')).toBeVisible({ timeout: 6000 });
    await expect(p.getByTestId('chat-pending-note')).toHaveCount(0);
  });
});

test.describe('chat view on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('chat with the composer, 16 px field, 44 px toggles, no sideways scroll', async ({ page }) => {
    const sid = await chatSession();
    await login(page);
    await page.locator(`.rail .row-wrap[data-sid="${sid}"] button.row`).tap();
    const p = pane(page, sid);
    await expect(p.getByTestId('chat-view')).toBeVisible();
    await expect(p.getByTestId('chat-msg')).toHaveCount(2);
    const input = p.getByTestId('composer-input');
    await expect(input).toHaveCount(1); // one composer: the chat's, not a second under the terminal
    await expect(input).toBeVisible();
    expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    for (const id of ['pane-view-chat', 'pane-view-raw']) {
      const b = await p.getByTestId(id).boundingBox();
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    const sum = await p.getByTestId('chat-tool').first().locator('summary').boundingBox();
    expect(sum.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await p.getByTestId('pane-view-raw').tap();
    await expect(p.locator('.xterm-rows')).toBeVisible();
    await expect(p.getByTestId('composer-input')).toHaveCount(1); // raw on the phone: today's composer
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
