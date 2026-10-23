// Settings -> Accounts: an optional second Claude login. Clawdling only gives it a folder
// (passed to claude as CLAUDE_CONFIG_DIR); the user signs in inside Claude Code.
import { test, expect } from '@playwright/test';
import { login, reset, isMock, mockRequests, mock, sessions, focusedPane } from './helpers.js';

test.beforeEach(() => { test.skip(!isMock(), 'adds accounts through the mock'); });

const card = (page) => page.getByTestId('accounts-card');
const rows = (page) => card(page).getByTestId('account-row');

test('the card shows only your own Claude login by default, with no Sign in on it', async ({ page }) => {
  await reset('default');
  await login(page, '#/settings');
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText('Clawdling runs your own claude');
  await expect(rows(page)).toHaveCount(1);
  const own = card(page).locator('[data-account="default"]');
  await expect(own).toContainText('Your Claude login');
  await expect(own).toContainText('Default');
  await expect(own.getByTestId('account-signin')).toHaveCount(0);
  await expect(card(page).getByTestId('account-add')).toHaveText('Add another Claude account');
});

test('adding "work" lists it with its folder and a Sign in button; an empty name adds nothing', async ({ page }) => {
  await reset('default');
  await login(page, '#/settings');
  await card(page).getByTestId('account-add').click();
  const input = card(page).getByTestId('account-name');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('maxlength', '32');

  // Empty: an inline error, no request, no new row.
  await card(page).getByTestId('account-add-submit').click();
  await expect(card(page).getByRole('alert')).toContainText('Give the account a name');
  expect((await mockRequests()).filter((r) => r.method === 'POST' && r.path === '/api/accounts')).toEqual([]);
  await expect(rows(page)).toHaveCount(1);

  // Escape cancels the form.
  await input.press('Escape');
  await expect(card(page).getByTestId('account-name')).toHaveCount(0);

  // Enter submits.
  await card(page).getByTestId('account-add').click();
  await card(page).getByTestId('account-name').fill('work');
  await card(page).getByTestId('account-name').press('Enter');
  const work = card(page).locator('[data-account="work"]');
  await expect(work).toBeVisible();
  await expect(work).toContainText('~/.clawdling-accounts/work');
  await expect(work.getByTestId('account-signin')).toHaveText('Sign in');
  await expect(rows(page)).toHaveCount(2);
  await expect(card(page).getByTestId('account-name')).toHaveCount(0);

  // A duplicate shows the server's error inline.
  await card(page).getByTestId('account-add').click();
  await card(page).getByTestId('account-name').fill('work');
  await card(page).getByTestId('account-add-submit').click();
  await expect(card(page).getByRole('alert')).toContainText('already an account');
  await expect(rows(page)).toHaveCount(2);
});

test('Sign in starts a sign-in session for that account and opens it in the workspace', async ({ page }) => {
  await reset('default');
  await mock('accounts', { accounts: ['work'] });
  await login(page, '#/settings');
  const btn = card(page).locator('[data-account="work"]').getByTestId('account-signin');
  await btn.click();
  await expect.poll(async () => (await mockRequests()).some((r) => r.method === 'POST' && r.path === '/api/accounts/work/signin')).toBe(true);
  await expect(page.locator('.app[data-route="cockpit"]')).toBeVisible();
  const s = (await sessions()).find((x) => x.title === 'Sign in: work');
  expect(s).toBeTruthy();
  await expect(focusedPane(page)).toHaveAttribute('data-pane', s.sid);
  await expect(focusedPane(page)).toContainText('Sign in: work');
  await expect(page.locator('.toast').filter({ hasText: 'Sign in to work in the new session' })).toBeVisible();
});

test('an older server without accounts shows the card quietly, with no list and no error', async ({ page }) => {
  await reset('default');
  await page.route('**/api/accounts', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }));
  await login(page, '#/settings');
  await expect(card(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(card(page).getByRole('alert')).toHaveCount(0);
  await expect(card(page).getByTestId('account-add')).toHaveCount(0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the Accounts card fits a 390px phone: no sideways scroll, 16px field, 44px targets', async ({ page }) => {
    await reset('default');
    await mock('accounts', { accounts: ['a-rather-long-account-name-here'] });
    await login(page, '#/settings');
    await card(page).scrollIntoViewIfNeeded();
    await card(page).getByTestId('account-add').tap();
    const input = card(page).getByTestId('account-name');
    await expect(input).toBeVisible();
    await card(page).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    const small = await card(page).evaluate((root) => [...root.querySelectorAll('button, input')]
      .map((el) => ({ what: (el.textContent || el.getAttribute('aria-label') || '').trim(), h: Math.round(el.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44));
    expect(small).toEqual([]);
  });
});
