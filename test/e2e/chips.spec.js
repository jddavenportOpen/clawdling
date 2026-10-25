// Per-pane model and effort chips, the new-session pickers (model, effort, account), and
// dictation in the composer. Mock-only: it uses the 'default' fixture and the mock's control routes.
import { test, expect } from '@playwright/test';
import { login, reset, sessions, mockRequests, mock, rowButton, pane, isMock } from './helpers.js';

test.skip(!isMock(), 'uses the mock fixture and control routes');

const byTitle = async (title) => (await sessions()).find((s) => s.title === title);
const posts = async (path) => (await mockRequests()).filter((r) => r.method === 'POST' && r.path === path);

test.describe('pane chips', () => {
  test.beforeEach(async ({ page }) => {
    await reset('default');
    await login(page);
  });

  test('CS-25: chips show the session model and effort, and switch them between turns', async ({ page }) => {
    const site = await byTitle('Fix the hero layout on mobile');
    await rowButton(page, site.sid).click();
    const working = pane(page, site.sid);
    await expect(working.getByTestId('chip-model')).toHaveText('sonnet');
    await expect(working.getByTestId('chip-effort')).toHaveText('Default effort');
    // Working: the chips are there but cannot be used, and say why.
    await expect(working.getByTestId('chip-model')).toHaveAttribute('aria-disabled', 'true');
    await expect(working.getByTestId('chip-model')).toHaveAttribute('title', /wait until it's your turn/);
    await working.getByTestId('chip-model').click({ force: true });
    await expect(page.getByTestId('chip-option')).toHaveCount(0);

    const brief = await byTitle('Morning brief');
    await rowButton(page, brief.sid).click();
    const ready = pane(page, brief.sid);
    await expect(ready.getByTestId('chip-model')).toHaveText('Default model');
    await expect(ready.getByTestId('chip-model')).toHaveAttribute('title', /your Claude Code default/);
    await ready.getByTestId('chip-effort').click();
    await expect(page.getByTestId('chip-option')).toHaveCount(5);
    // Escape closes the menu without changing anything.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chip-option')).toHaveCount(0);
    await ready.getByTestId('chip-effort').click();
    await page.locator('[data-testid="chip-option"][data-value="high"]').click();
    await expect(ready.getByTestId('chip-effort')).toHaveText('effort: high');
    await expect(page.getByTestId('chip-option')).toHaveCount(0);
    const sent = await posts(`/api/sessions/${brief.sid}/settings`);
    expect(sent.length).toBe(1);
    expect(sent[0].body).toEqual({ effort: 'high' });

    // Model too, through the keyboard.
    await ready.getByTestId('chip-model').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chip-option')).toHaveCount(4);
    await page.locator('[data-testid="chip-option"][data-value="opus"]').click();
    await expect(ready.getByTestId('chip-model')).toHaveText('opus');
  });
});

test.describe('new session dialog', () => {
  test.beforeEach(async () => { await reset('default'); });

  const openDialog = async (page) => {
    await page.getByTestId('new-session').click();
    await expect(page.getByTestId('ns-model')).toBeVisible();
  };

  test('model and effort pickers; the account picker appears only with a second login', async ({ page }) => {
    await login(page);
    await openDialog(page);
    await expect(page.getByTestId('ns-account')).toHaveCount(0);
    await expect(page.getByTestId('ns-model').locator('option')).toHaveCount(5);
    await page.getByTestId('ns-model').selectOption('opus');
    await page.getByTestId('ns-effort').selectOption('high');
    await page.getByTestId('ns-start').click();
    await expect(page.getByTestId('ns-model')).toHaveCount(0);
    let spawns = await posts('/api/sessions');
    expect(spawns.length).toBe(1);
    expect(spawns[0].body).toMatchObject({ model: 'opus', effort: 'high' });
    expect(spawns[0].body.account).toBeUndefined();

    await mock('accounts', { accounts: ['work'] });
    await openDialog(page);
    const acct = page.getByTestId('ns-account');
    await expect(acct).toBeVisible();
    await expect(acct.locator('option')).toHaveCount(2);
    await expect(acct).toHaveValue('default');
    await acct.selectOption('work');
    await page.getByTestId('ns-start').click();
    await expect(page.getByTestId('ns-model')).toHaveCount(0);
    spawns = await posts('/api/sessions');
    expect(spawns.length).toBe(2);
    expect(spawns[1].body).toMatchObject({ account: 'work' });
    expect(spawns[1].body.model).toBeUndefined();
    expect(spawns[1].body.effort).toBeUndefined();
  });
});

test.describe('dictation on the phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test.beforeEach(async () => { await reset('default'); });

  const openBrief = async (page) => {
    await login(page);
    const brief = await byTitle('Morning brief');
    await rowButton(page, brief.sid).click();
    await expect(pane(page, brief.sid).getByTestId('composer-input')).toBeVisible();
    return brief;
  };

  test('no speech recognition in the browser: no mic', async ({ page }) => {
    await page.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
    const brief = await openBrief(page);
    await expect(pane(page, brief.sid).getByTestId('composer-mic')).toHaveCount(0);
  });

  test('CS-26: the mic fills the box, notes the speech service once, and never sends', async ({ page }) => {
    await page.addInitScript(() => {
      class FakeRecognition {
        start() {
          window.__micStarts = (window.__micStarts || 0) + 1;
          setTimeout(() => {
            const results = [Object.assign([{ transcript: 'hello from voice' }], { isFinal: true })];
            if (this.onresult) this.onresult({ results, resultIndex: 0 });
            if (this.onend) this.onend();
          }, 50);
        }
        stop() { if (this.onend) this.onend(); }
        abort() {}
      }
      delete window.SpeechRecognition;
      window.webkitSpeechRecognition = FakeRecognition;
    });
    const brief = await openBrief(page);
    const p = pane(page, brief.sid);
    const mic = p.getByTestId('composer-mic');
    await expect(mic).toBeVisible();
    await expect(mic).toHaveAttribute('aria-label', 'Dictate');
    const box = await mic.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    await mic.click();
    await expect(p.getByTestId('composer-input')).toHaveValue('hello from voice');
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    const note = page.getByText("Dictation uses your browser's own speech service");
    await expect(note).toHaveCount(1);
    // Typed text stays; a second dictation appends with a space and shows no second note.
    await p.getByTestId('composer-input').fill('Note:');
    await expect(note).toHaveCount(0, { timeout: 9000 });
    await mic.click();
    await expect(p.getByTestId('composer-input')).toHaveValue('Note: hello from voice');
    await page.waitForTimeout(300);
    await expect(note).toHaveCount(0);
    expect(await page.evaluate(() => window.__micStarts)).toBe(2);
    expect(await posts(`/api/sessions/${brief.sid}/send`)).toHaveLength(0);
  });
});
