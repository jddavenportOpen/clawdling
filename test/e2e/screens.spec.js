// Screenshots of the key screens at 1440x900 and 1024x768 (plus a light-theme
// and a phone pass) into test/e2e/screenshots/ (gitignored). Each one also
// asserts the screen actually rendered, so a blank capture fails the suite.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reset, login, sessions, openPanes, panes, isMock, seedStandard, spawn } from './helpers.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
const shot = (page, name) => page.screenshot({ path: path.join(DIR, `${name}.png`) });

async function liveSids(min) {
  if (!isMock()) {
    await seedStandard();
    await spawn({ agent: 'money', title: 'Pay the water bill', status: 'working' });
    await spawn({ agent: 'health', title: 'Log the long run', status: 'ready' });
  }
  const order = { needs_you: 0, ready: 1, working: 2, starting: 3 };
  const list = (await sessions()).filter((s) => s.status !== 'ended').sort((a, b) => order[a.status] - order[b.status]);
  expect(list.length).toBeGreaterThanOrEqual(min);
  return list.map((s) => s.sid);
}

async function settle(page, ms = 700) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => document.fonts && document.fonts.ready);
}

for (const vp of [{ w: 1440, h: 900 }, { w: 1024, h: 768 }]) {
  const tag = `${vp.w}x${vp.h}`;
  test.describe(`screens ${tag}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h } });

    test(`cockpit with 1, 3 and 6 panes (${tag})`, async ({ page }) => {
      await reset('default');
      const sids = await liveSids(6);
      await login(page);
      await openPanes(page, sids.slice(0, 1));
      await expect(page.locator('.xterm-rows').first()).toContainText(/\S/);
      await settle(page);
      await shot(page, `cockpit-1-pane-${tag}`);
      await openPanes(page, sids.slice(1, 3));
      await expect(panes(page)).toHaveCount(3);
      await settle(page, 2200);
      await shot(page, `cockpit-3-panes-${tag}`);
      await openPanes(page, sids.slice(3, 6));
      await expect(panes(page)).toHaveCount(6);
      await settle(page, 3200); // let the activity traces of working sessions draw
      await shot(page, `cockpit-6-panes-${tag}`);
    });

    test(`collapsed rail (${tag})`, async ({ page }) => {
      await reset('default');
      const sids = await liveSids(3);
      await login(page);
      await openPanes(page, sids.slice(0, 3));
      await page.getByTestId('rail-collapse').click();
      await expect(page.locator('[data-rail="collapsed"]')).toBeVisible();
      await page.locator('.strip-dot').nth(1).hover();
      await expect(page.locator('.strip-tip')).toBeVisible();
      await settle(page);
      await shot(page, `cockpit-collapsed-rail-${tag}`);
    });

    test(`org map with 4 and with 30 agents (${tag})`, async ({ page }) => {
      await reset('small');
      await login(page, '#/map');
      await expect(page.locator('[data-node]').first()).toBeVisible();
      await settle(page);
      await shot(page, `org-map-4-agents-${tag}`);
      await page.locator('[data-node="health"]').click();
      await expect(page.getByTestId('map-panel')).toBeVisible();
      await settle(page);
      await shot(page, `org-map-4-agents-panel-${tag}`);
      test.skip(!isMock(), 'the 30-agent org is a mock fixture');
      await reset('big');
      await page.reload();
      await expect(page.locator('[data-node]')).toHaveCount(32); // 30 agents + you + the unattached-projects cluster
      await settle(page);
      await shot(page, `org-map-30-agents-${tag}`);
    });

    test(`agent page (${tag})`, async ({ page }) => {
      await reset('default');
      await login(page, '#/agent/health/memory');
      await expect(page.getByTestId('editor-now_md')).toBeVisible();
      await settle(page);
      await shot(page, `agent-page-memory-${tag}`);
      await page.locator('[data-tab-btn="sessions"]').click();
      await settle(page);
      await shot(page, `agent-page-sessions-${tag}`);
    });

    test(`settings with phone pairing (${tag})`, async ({ page }) => {
      await reset('default');
      // Loopback (the default bind) shows no QR: a phone cannot reach it. Capture the reachable case.
      if (isMock()) await fetch(new URL('/__mock/bind', process.env.CLAWDLING_E2E_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bind: '0.0.0.0' }) });
      await login(page, '#/settings');
      await expect(page.getByTestId(isMock() ? 'pair-qr' : 'phone-card')).toBeVisible();
      await settle(page);
      await shot(page, `settings-${tag}`);
    });

    test(`Donna page (${tag})`, async ({ page }) => {
      test.skip(!isMock(), 'stores a bot token');
      await reset('default');
      await login(page, '#/donna');
      await page.getByTestId('tg-token').fill('123456789:AAFakeTokenForTests_0123456789');
      await page.getByTestId('tg-connect').click();
      await expect(page.getByTestId('pairing-code')).toBeVisible();
      await fetch(new URL('/__mock/channel', process.env.CLAWDLING_E2E_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Can someone book the dentist for next week?' }) });
      await fetch(new URL('/__mock/channel', process.env.CLAWDLING_E2E_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'out', text: 'Home is on it. Watch it in the cockpit: "Book the dentist".' }) });
      await expect(page.locator('.chan-row')).toHaveCount(2);
      await settle(page);
      await shot(page, `donna-page-${tag}`);
    });
  });
}

test.describe('screens: startup dialog banner', () => {
  test('trust dialog banner (1440x900)', async ({ page }) => {
    test.skip(!isMock(), 'uses the mock to raise the dialog');
    await reset('default');
    const sids = await liveSids(2);
    await fetch(new URL('/__mock/dialog', process.env.CLAWDLING_E2E_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: sids[1], kind: 'trust' }) });
    await login(page);
    await openPanes(page, [sids[0], sids[1]]);
    await expect(page.getByTestId('pane-dialog')).toBeVisible();
    await settle(page);
    await shot(page, 'cockpit-trust-dialog-1440x900');
  });
});

test.describe('screens: light theme and phone', () => {
  test('light theme cockpit (1440x900)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    await reset('default');
    const sids = await liveSids(3);
    await login(page);
    await openPanes(page, sids.slice(0, 3));
    await settle(page);
    await shot(page, 'cockpit-3-panes-light-1440x900');
    await page.goto('/#/map');
    await expect(page.locator('[data-node]').first()).toBeVisible();
    await settle(page);
    await shot(page, 'org-map-light-1440x900');
    await ctx.close();
  });

  test('phone: rail as a list, one terminal at a time (390x844)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await reset('default');
    const sids = await liveSids(2);
    await login(page);
    await settle(page);
    await shot(page, 'phone-list-390x844');
    await page.locator(`.rail .row-wrap[data-sid="${sids[0]}"] button.row`).click();
    await expect(page.locator(`[data-pane="${sids[0]}"]`)).toBeVisible();
    await expect(page.locator('[data-rail]')).toBeHidden();
    await settle(page);
    await shot(page, 'phone-pane-390x844');
    await page.getByRole('button', { name: 'Back to sessions' }).click();
    await expect(page.locator('[data-rail]')).toBeVisible();
    await ctx.close();
  });
});
