// Question cards (CS-14..CS-16) and Watching (CS-19, CS-20) in the cockpit, against the mock.
// The real server's half (the transcript, the screen-driven answer, the background detector) is
// covered by test/integration/questions.test.js with the fake claude on both backends.
import { test, expect } from '@playwright/test';
import { login, reset, spawn, mock, mockRequests, openPanes, pane, row, isMock } from './helpers.js';

test.skip(() => !isMock(), 'the chat transcript is injected through the mock');

async function chatSession(title) {
  await reset('empty');
  const sid = await spawn({ agent: 'work', title, status: 'ready' });
  await mock('transcript', { sid, messages: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hi. What next?' }] });
  return sid;
}

async function ask(page, sid, text) {
  const input = pane(page, sid).getByTestId('chat-view').getByTestId('composer-input');
  await input.fill(text);
  await input.press('Enter');
}

const answerBody = async (sid) => (await mockRequests()).filter((r) => r.method === 'POST' && r.path === `/api/sessions/${sid}/answer`).pop()?.body;

test.describe('question cards', () => {
  test('CS-14: a question shows as a card; picking an option and Send answers it, and the card keeps the answer', async ({ page }) => {
    const sid = await chatSession('Colors');
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    await ask(page, sid, 'ask? colors');
    const card = p.getByTestId('question-card');
    await expect(card).toHaveAttribute('data-state', 'pending');
    await expect(card).toContainText('Which color do you like best?');
    await expect(card.getByTestId('ask-option')).toHaveText([/Red\s*A warm, bold color\./, /Green/, /Blue\s*A cool, steady color\./]);
    // The card is the way to answer: no banner over it, and the composer waits.
    await expect(p.getByTestId('pane-question')).toHaveCount(0);
    await expect(p.getByTestId('composer-input')).toBeDisabled();
    await expect(p.getByTestId('composer-input')).toHaveAttribute('placeholder', 'Answer the question above first');
    const send = card.getByTestId('ask-send');
    await expect(send).toBeDisabled();
    await card.getByTestId('ask-option').nth(2).click();
    await expect(card.getByTestId('ask-option').nth(2)).toHaveAttribute('aria-checked', 'true');
    await send.click();
    await expect.poll(() => answerBody(sid)).toEqual({ tool_id: expect.stringMatching(/^toolu_mock/), answers: [{ choices: [2] }] });
    await expect(card).toHaveAttribute('data-state', 'answered', { timeout: 15000 });
    await expect(card).toContainText('You answered');
    await expect(card.getByTestId('ask-option').nth(2)).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByTestId('ask-option').nth(0)).toHaveAttribute('aria-checked', 'false');
    await expect(p.getByTestId('chat-msg').last()).toContainText('You chose Blue.');
    await expect(p.getByTestId('composer-input')).toBeEnabled();
    // After a reload the card still shows what was answered (read back from the transcript).
    await page.reload();
    await expect(pane(page, sid).getByTestId('question-card')).toHaveAttribute('data-state', 'answered', { timeout: 15000 });
  });

  test('CS-14: "Something else…" sends a typed answer', async ({ page }) => {
    const sid = await chatSession('Typed');
    await login(page);
    await openPanes(page, [sid]);
    await ask(page, sid, 'ask? colors');
    const card = pane(page, sid).getByTestId('question-card');
    await card.getByTestId('ask-other').click();
    await card.getByTestId('ask-other-input').fill('Ultraviolet');
    await card.getByTestId('ask-other-input').press('Enter');
    await expect.poll(() => answerBody(sid)).toEqual({ tool_id: expect.any(String), answers: [{ text: 'Ultraviolet' }] });
    await expect(card).toHaveAttribute('data-state', 'answered', { timeout: 15000 });
    await expect(card.getByTestId('ask-typed')).toHaveText('“Ultraviolet”');
  });

  test('CS-15: several questions, one multiSelect, go in one Send', async ({ page }) => {
    const sid = await chatSession('Two');
    await login(page);
    await openPanes(page, [sid]);
    await ask(page, sid, 'ask2? both');
    const card = pane(page, sid).getByTestId('question-card');
    await expect(card.locator('fieldset')).toHaveCount(2);
    await expect(card).toContainText('Pick any that apply.');
    const opts = card.getByTestId('ask-option');
    await opts.nth(0).click(); // Red
    await expect(card.getByTestId('ask-send')).toBeDisabled(); // the pets are not answered yet
    await opts.nth(3).click(); // Cat
    await opts.nth(5).click(); // Fish
    await expect(opts.nth(3)).toHaveAttribute('role', 'checkbox');
    await card.getByTestId('ask-send').click();
    await expect.poll(() => answerBody(sid)).toEqual({ tool_id: expect.any(String), answers: [{ choices: [0] }, { choices: [0, 2] }] });
    await expect(card).toHaveAttribute('data-state', 'answered', { timeout: 15000 });
  });

  test('CS-16: a plan shows as a card; approve it, or send it back with what to change', async ({ page }) => {
    const sid = await chatSession('Plan');
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    await ask(page, sid, 'plan? please');
    let card = p.getByTestId('plan-card');
    await expect(card).toHaveAttribute('data-state', 'pending');
    await expect(card.locator('.plan-body strong')).toHaveText('hi');
    await expect(card.getByTestId('plan-choice')).toHaveText(['Yes, auto-accept edits', 'Yes, manually approve edits']);
    await card.getByTestId('plan-change').click();
    await card.getByTestId('plan-feedback-input').fill('Add a step that prints it');
    await card.getByTestId('plan-feedback-send').click();
    await expect.poll(() => answerBody(sid)).toEqual({ option: 3, text: 'Add a step that prints it' });
    await expect(card).toHaveAttribute('data-state', 'feedback', { timeout: 15000 });
    await expect(card.getByTestId('plan-feedback')).toHaveText('“Add a step that prints it”');

    await ask(page, sid, 'plan? again');
    card = p.getByTestId('plan-card').last();
    await expect(card).toHaveAttribute('data-state', 'pending');
    await card.getByTestId('plan-choice').nth(1).click();
    await expect.poll(() => answerBody(sid)).toEqual({ option: 2 });
    await expect(card).toHaveAttribute('data-state', 'approved', { timeout: 15000 });
    await expect(card).toContainText('Plan approved');
  });
});

test.describe('Watching', () => {
  test('CS-19: background work after the turn reads Watching · N on the pane and the rail; the popover lists it', async ({ page }) => {
    const sid = await chatSession('Builds');
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    await ask(page, sid, 'watch? the build');
    const pill = p.getByTestId('watching-pill');
    await expect(pill).toHaveText('Watching · 2');
    await expect(p).toHaveAttribute('data-display', 'watching');
    await expect(row(page, sid)).toHaveAttribute('data-status', 'watching');
    await expect(row(page, sid)).toContainText('Watching · 2 · Wait for the build');
    // Watching is not "needs you": the session is in Live, not in the Needs you section.
    await expect(row(page, sid)).toHaveAttribute('data-section', 'live');
    await pill.click();
    const items = p.getByTestId('watching-task');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Background command');
    await expect(items.nth(0)).toContainText('Wait for the build');
    await expect(items.nth(1)).toContainText('Watcher');
    await expect(items.nth(1)).toContainText('ends by itself');
    await page.keyboard.press('Escape');
    await expect(p.getByTestId('watching-pop')).toHaveCount(0);
    await ask(page, sid, 'unwatch? done');
    await expect(pill).toHaveCount(0);
    await expect(row(page, sid)).toHaveAttribute('data-status', 'ready');
  });

  test('CS-20: needs-you beats Watching', async ({ page }) => {
    const sid = await chatSession('Both');
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    await ask(page, sid, 'watch? the build');
    await expect(p.getByTestId('watching-pill')).toBeVisible();
    await ask(page, sid, 'ask? colors');
    await expect(p.getByTestId('question-card')).toHaveAttribute('data-state', 'pending');
    await expect(p.getByTestId('watching-pill')).toHaveCount(0);
    await expect(row(page, sid)).toHaveAttribute('data-status', 'needs_you');
  });
});

test.describe('question cards on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('CS-14 (phone): the card fits, its targets are 44 px, and a tap answers', async ({ page }) => {
    const sid = await chatSession('Phone');
    await login(page);
    await page.locator(`.rail .row-wrap[data-sid="${sid}"] button.row`).tap();
    const p = pane(page, sid);
    await expect(p.getByTestId('chat-view')).toBeVisible();
    await ask(page, sid, 'ask? colors');
    const card = p.getByTestId('question-card');
    await expect(card).toHaveAttribute('data-state', 'pending');
    for (let i = 0; i < 3; i++) expect((await card.getByTestId('ask-option').nth(i).boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await card.getByTestId('ask-option').nth(1).tap();
    await card.getByTestId('ask-send').tap();
    await expect(card).toHaveAttribute('data-state', 'answered', { timeout: 15000 });
    await expect(p.getByTestId('chat-msg').last()).toContainText('You chose Green.');
  });
});

test.describe('an agent needs you', () => {
  test('CS-21: Settings turns on the browser notification; a hidden tab gets one when a session starts waiting', async ({ page }) => {
    await page.addInitScript(() => {
      window.__shown = [];
      window.Notification = class {
        constructor(title, opts) { window.__shown.push({ title, body: opts && opts.body }); }
        static permission = 'default';
        static requestPermission() { window.Notification.permission = 'granted'; return Promise.resolve('granted'); }
      };
    });
    const sid = await chatSession('Pinged');
    await login(page, '#/settings');
    const card = page.getByTestId('notify-card');
    await expect(card).toContainText('When an agent needs you');
    // No paired channel in this org: the message switch explains what to do first.
    await expect(card.getByTestId('notify-message')).toBeDisabled();
    await expect(card).toContainText('Pair Donna with Telegram or iMessage first');
    await card.locator('label.switch').filter({ has: page.getByTestId('notify-browser') }).click();
    await expect(card.getByTestId('notify-browser')).toBeChecked();
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
    await fetch(new URL(`/api/sessions/${sid}/send`, process.env.CLAWDLING_E2E_URL), { method: 'POST', headers: { 'content-type': 'application/json', 'x-clawdling-token': process.env.CLAWDLING_E2E_TOKEN }, body: JSON.stringify({ text: 'permission? now' }) });
    await expect.poll(() => page.evaluate(() => window.__shown)).toEqual([{ title: 'Work needs you', body: 'Waiting on you: a permission. Open the cockpit to answer.' }]);
  });
});
