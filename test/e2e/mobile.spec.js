// Phone checks at 390x844 with touch. Runs in the phone-chromium and phone-webkit projects (see
// playwright.config.js): iPhone Safari is WebKit, so the key mobile fixes are checked there too.
import { test, expect } from '@playwright/test';
import { login, reset, isMock, mock, sessions, mockRequests, health } from './helpers.js';

test.skip(() => !isMock(), 'the phone checks drive the mock');

// Every visible control on screen that is shorter than 44 px (WCAG 2.5.5 / Apple's minimum).
// Links inside running text are exempt (WCAG 2.5.8's inline exception); so are the terminal and
// the org map's SVG nodes.
async function smallTargets(page) {
  return page.evaluate(() => {
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
        && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    return [...document.querySelectorAll('button, a[href], input:not([type="checkbox"]), select, textarea, [role="button"], [role="option"], summary')]
      .filter((el) => !el.closest('svg, .xterm') && !(el.tagName === 'A' && el.closest('p')) && shown(el))
      .map((el) => ({ what: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40), h: Math.round(el.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44);
  });
}

const fontSizes = (page) => page.evaluate(() => [...document.querySelectorAll('input:not([type="checkbox"]), textarea, select')]
  .filter((el) => el.getBoundingClientRect().height > 2 && !el.closest('.xterm'))
  .map((el) => getComputedStyle(el).fontSize));

const scrollWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth);

test('home list: 15 px rows, a + on agent rows, 44 px targets, 16 px fields, no sideways scroll (P1-7, P1-11, P1-12)', async ({ page }) => {
  await reset('default');
  await login(page);
  expect(await page.locator('.rail .row-title').first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('15px');
  for (const a of ['donna', 'work', 'money']) {
    const r = page.locator(`.rail [data-agent="${a}"]`);
    await expect(r.locator('.row-plus')).toBeVisible();
    await expect(r.locator('.row-status')).toHaveText(/ · tap to start$/);
  }
  expect(await scrollWidth(page)).toBe(390);
  expect(await smallTargets(page)).toEqual([]);
  expect(new Set(await fontSizes(page))).toEqual(new Set(['16px']));
});

test('New session opens without raising the keyboard; its fields are 16 px (P1-7)', async ({ page }) => {
  await reset('default');
  await login(page);
  await page.locator('.rail').getByTestId('new-session').tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(250); // the dialog places focus on its first frame
  expect(await page.evaluate(() => document.activeElement && document.activeElement.tagName)).not.toMatch(/^(INPUT|TEXTAREA)$/);
  expect(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]'))).toBe(true); // focus is still trapped inside
  expect(new Set(await fontSizes(page))).toEqual(new Set(['16px']));
  expect(await smallTargets(page)).toEqual([]);
});

test('a permission prompt is one tap, and the composer sends a message (P1-8)', async ({ page }) => {
  await reset('default');
  const s = (await sessions()).find((x) => x.waiting_on === 'permission_prompt');
  await login(page);
  await page.locator(`.rail .row-wrap[data-sid="${s.sid}"] button.row`).tap();
  const p = page.locator(`[data-pane="${s.sid}"]`);
  await expect(p).toBeVisible();
  const input = p.getByTestId('composer-input');
  await expect(input).toBeDisabled(); // a question is on screen: answer it first
  await expect(input).toHaveAttribute('placeholder', 'Answer the question above first');
  expect(await smallTargets(page)).toEqual([]);
  await p.getByTestId('question-choice').first().tap();
  await expect.poll(async () => (await mockRequests()).find((r) => r.method === 'POST' && r.path === `/api/sessions/${s.sid}/answer`)?.body).toEqual({ option: 1 });
  await expect(p.getByTestId('pane-question')).toHaveCount(0);
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute('placeholder', 'Message Work…');
  await input.tap();
  await input.fill('hi');
  await p.getByTestId('composer-send').tap();
  await expect.poll(async () => (await mockRequests()).find((r) => r.method === 'POST' && r.path === `/api/sessions/${s.sid}/send`)?.body).toEqual({ text: 'hi', enter: true });
  await expect(input).toHaveValue('');
});

test('a missing claude is on the phone screen too (P0-1)', async ({ page }) => {
  await reset('empty');
  await mock('health', { claude: { ok: false, version: null, error: 'claude not found on PATH' } });
  await login(page);
  const banner = page.getByTestId('health-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("can't find the claude command");
  await expect(page.locator('.rail').getByTestId('new-session')).toBeDisabled();
  expect(await scrollWidth(page)).toBe(390);
});

test('first run on the phone: trust the org folder from the list (P0-4)', async ({ page }) => {
  await reset('fresh');
  await login(page);
  await expect(page.getByTestId('first-trust')).toBeVisible();
  await page.getByTestId('first-trust-go').tap();
  const banner = page.getByTestId('pane-dialog');
  await expect(banner).toBeVisible();
  await expect(banner.getByTestId('pane-dialog-text')).toContainText('~/clawdling. "No, exit" ends this session.');
  await expect(banner.locator('button')).toHaveText(['No, exit', 'Yes, trust it']);
  expect(await smallTargets(page)).toEqual([]);
  await banner.getByTestId('dialog-yes').tap();
  await expect(page.getByTestId('pane-dialog')).toHaveCount(0);
});

test('phone card at 390: loopback shows the fix, not a QR that cannot work (P0-2)', async ({ page }) => {
  await reset('default');
  const h = await health();
  await login(page, '#/settings');
  await expect(page.getByTestId('pair-warning')).toContainText(`${h.cli} start --host 0.0.0.0`);
  await expect(page.getByTestId('pair-qr')).toHaveCount(0);
  await expect(page.getByTestId('pair-app')).toContainText('public beta');
  expect(await scrollWidth(page)).toBe(390);
  expect(await smallTargets(page)).toEqual([]);
});
