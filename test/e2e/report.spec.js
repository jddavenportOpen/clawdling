// The report card (1.5): the agent Overview tab (Done, Needs you, Cost, Next), the session Timeline
// tab, the org map's usage lines, and the Settings cards for the Monday report and the detailed
// timeline. Tests marked mock-only use the mock's "report" fixture (a week of Lou-style data); the
// rest run against the real server too.
import { test, expect } from '@playwright/test';
import { api, isMock, login, mock, pane, reset, rowButton, sessions, spawn, tag } from './helpers.js';

const COST_LABEL = 'List-price equivalent, not a bill. On Pro and Max, usage is included in your plan.';

async function freshDomain(name) {
  const a = await api('POST', '/api/agents', { kind: 'domain', name: `${name}${tag()}`, mission: 'Keep the garden alive' });
  return (a.agent || a).id;
}

test.describe('report card: the Overview tab', () => {
  test('US-65: Overview is the default tab, with four blocks and an empty state in each', async ({ page }) => {
    await reset('empty');
    const id = await freshDomain('Garden');
    await login(page, `#/agent/${id}`);
    await expect(page.locator('[data-tab-btn="overview"]')).toHaveAttribute('aria-selected', 'true');
    const card = page.getByTestId('report-card');
    await expect(card).toBeVisible();
    for (const b of ['rc-done', 'rc-needs', 'rc-cost', 'rc-next']) await expect(page.getByTestId(b)).toBeVisible();
    await expect(page.getByTestId('rc-done')).toContainText('Nothing done in the last 7 days yet.');
    await expect(page.getByTestId('rc-needs')).toContainText('Nothing is waiting on you.');
    await expect(page.getByTestId('rc-cost')).toContainText('No usage in the last 7 days.');
    await expect(page.getByTestId('rc-cost-label')).toHaveText(COST_LABEL);
    await expect(page.getByTestId('rc-next')).toContainText('from memory/NOW.md');
    // The other tabs are still there.
    for (const t of ['sessions', 'context', 'memory']) await expect(page.locator(`[data-tab-btn="${t}"]`)).toBeVisible();
    await page.locator('[data-tab-btn="sessions"]').click();
    await expect(page).toHaveURL(new RegExp(`#/agent/${id}/sessions$`));
    await page.locator('[data-tab-btn="overview"]').click();
    await expect(page).toHaveURL(new RegExp(`#/agent/${id}$`));
  });

  test('US-67: Needs you lists exactly the rail\'s needs-you sessions for this agent, and each opens its session', async ({ page }) => {
    await reset('empty');
    const t = tag();
    const asked = await spawn({ agent: 'work', title: `Draft the Q4 roadmap${t}`, status: 'needs_you', notification: 'Claude needs your permission to use Bash' });
    const turn = await spawn({ agent: 'work', title: `Hiring plan${t}`, status: 'ready', lastMessage: 'Two candidates fit. Want me to book calls?' });
    await spawn({ agent: 'work', title: `Pricing research${t}`, status: 'working' });
    await login(page, '#/agent/work');
    const needs = page.getByTestId('rc-needs');
    const railCount = (await sessions()).filter((s) => s.agent === 'work' && (s.status === 'needs_you' || (s.status === 'ready' && s.last_message && !(s.background && s.background.count)))).length;
    await expect(needs.locator('.rc-item')).toHaveCount(railCount);
    await expect(needs.locator('.rc-h .sec-count')).toHaveText(String(railCount));
    await expect(needs.locator(`[data-sid="${asked}"]`)).toContainText('Claude needs your permission to use Bash');
    await expect(needs.locator(`[data-sid="${turn}"]`)).toContainText('Finished and waiting for your reply');
    await needs.locator(`[data-sid="${asked}"]`).click();
    await expect(page.locator('.page-layer')).toHaveCount(0);
    await expect(pane(page, asked)).toHaveAttribute('data-focused', 'true');
  });

  test('US-66, US-68, US-69: Done with commits, Cost by day and model with its label, Next from NOW.md (mock)', async ({ page }) => {
    test.skip(!isMock(), 'uses the mock "report" fixture');
    await reset('report');
    await login(page, '#/agent/site');
    const done = page.getByTestId('rc-done');
    await expect(done.locator('.rc-item')).toHaveCount(4);
    const signup = done.locator('.rc-done-item', { hasText: 'Add the signup form' });
    await expect(signup).toContainText('The signup form works');
    await expect(signup).toContainText('6 files changed');
    await expect(signup).toContainText('2 commits');
    await expect(signup.locator('.rc-commits li')).toHaveText(['Add the signup form with email checks', 'Send the welcome email from the waitlist']);
    await expect(done.locator('.rc-item').first()).toContainText('Still running');
    await expect(done.locator('.rc-item', { hasText: 'launch checklist' })).toContainText('Transcript gone, kept summary only');
    await expect(done).toContainText('Also committed in the repo');
    const cost = page.getByTestId('rc-cost');
    await expect(page.getByTestId('rc-cost-total')).toHaveText('about $10.22');
    await expect(cost).toContainText('of usage at list price');
    await expect(page.getByTestId('rc-cost-label')).toHaveText(COST_LABEL);
    await expect(cost).toContainText("On Pro, your plan's usage limits are smaller than Max's");
    await expect(cost.locator('.rc-bar')).toHaveCount(7);
    await expect(cost.locator('.rc-rows').first()).toContainText('Opus 5.5');
    await expect(cost).toContainText('Top sessions');
    const next = page.getByTestId('rc-next');
    await expect(next).toContainText('Get the hero to stack properly on phones');
    await expect(next).toContainText('updated 3h ago');
    await expect(page.getByTestId('rc-next-stale')).toHaveCount(0);
    // Windows: today shows only today's work; 30 days shows a month of bars.
    await page.locator('[data-window-btn="today"]').click();
    await expect(page.getByTestId('report-card')).toHaveAttribute('data-window', 'today');
    await expect(done.locator('.rc-item', { hasText: 'Fix the hero layout' })).toBeVisible();
    await expect(done.locator('.rc-item', { hasText: 'launch checklist' })).toHaveCount(0);
    // Today's usage: the hero session ($1.84) and today's part of the signup form ($0.62).
    await expect(page.getByTestId('rc-cost-total')).toHaveText('about $2.46');
    await page.locator('[data-window-btn="30d"]').click();
    await expect(page.getByTestId('rc-cost').locator('.rc-bar')).toHaveCount(30);
    // Every dollar figure on the card reads as an estimate.
    const text = await page.getByTestId('report-card').innerText();
    expect(text).not.toMatch(/\b(spend|spent|charged)\b/i);
  });

  test('US-69: a NOW.md over 7 days old says so (mock)', async ({ page }) => {
    test.skip(!isMock(), 'uses the mock fixture ages');
    await reset('report');
    await login(page, '#/agent/work');
    await expect(page.getByTestId('rc-next-stale')).toHaveText('This note is over a week old, so it may be out of date.');
  });

  test('Done opens the session it describes (mock)', async ({ page }) => {
    test.skip(!isMock(), 'uses the mock "report" fixture');
    await reset('report');
    await login(page, '#/agent/site');
    const item = page.getByTestId('rc-done').locator('.rc-item', { hasText: 'Add the signup form' });
    const sid = await item.getAttribute('data-sid');
    await item.click();
    await expect(pane(page, sid)).toHaveAttribute('data-focused', 'true');
  });
});

test.describe('report card: the session Timeline tab', () => {
  test('US-70: an ended session\'s Timeline shows prompts, tools with results and durations, and turn costs', async ({ page }) => {
    await reset('empty');
    const t = tag();
    const sid = await spawn({ agent: 'home', title: `Fix the leaking tap${t}`, status: 'working', prompt: 'please do some work? now' });
    if (!isMock()) {
      // The fake claude's "work?" turn writes real-shaped transcript records.
      const until = Date.now() + 15000;
      while (Date.now() < until && (await sessions()).find((s) => s.sid === sid)?.status !== 'ready') await new Promise((r) => setTimeout(r, 100));
    }
    await api('DELETE', `/api/sessions/${sid}`);
    await login(page);
    await rowButton(page, sid).click();
    await pane(page, sid).getByTestId('pane-view-timeline').click();
    const tl = pane(page, sid).getByTestId('timeline');
    await expect(tl).toBeVisible();
    await expect(pane(page, sid)).toHaveAttribute('data-view', 'timeline');
    await expect(tl.locator('[data-kind="prompt"]').first()).toBeVisible();
    await expect(tl.locator('[data-kind="tool"]').first()).toBeVisible();
    await expect(tl.locator('[data-kind="tool"][data-ok="ok"]').first()).toBeVisible();
    await expect(tl.locator('[data-kind="tool"][data-ok="error"]').first()).toBeVisible();
    await expect(tl.locator('[data-kind="subagent"]').first()).toBeVisible();
    await expect(tl.locator('[data-kind="prompt"] .tl-cost').first()).toContainText('$');
    await expect(tl).toContainText('list-price equivalent, not a bill');
    // The choice is remembered for this pane.
    await page.reload();
    await expect(pane(page, sid)).toHaveAttribute('data-view', 'timeline');
  });

  test('US-70: a 2,000-turn Timeline renders its first page in under a second (mock)', async ({ page }) => {
    test.skip(!isMock(), 'uses the mock "report" fixture');
    await reset('report');
    const all = await sessions();
    const big = all.find((s) => s.title === 'Speed up the home page');
    await login(page);
    await rowButton(page, big.sid).click();
    const t0 = Date.now();
    await pane(page, big.sid).getByTestId('pane-view-timeline').click();
    const tl = pane(page, big.sid).getByTestId('timeline');
    await expect(tl.locator('.tl-row')).toHaveCount(500);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1000);
    await expect(tl.getByTestId('timeline-more')).toContainText('more');
    await tl.getByTestId('timeline-more').click();
    await expect(tl.locator('.tl-row')).toHaveCount(1000);
  });

  test('US-74: a session whose transcript Claude Code deleted says so and keeps its summary (mock)', async ({ page }) => {
    test.skip(!isMock(), 'uses the mock "report" fixture');
    await reset('report');
    const gone = (await sessions()).find((s) => s.title === 'Write the launch checklist');
    await login(page);
    await rowButton(page, gone.sid).click();
    await pane(page, gone.sid).getByTestId('pane-view-timeline').click();
    await expect(pane(page, gone.sid).getByTestId('timeline-gone')).toContainText("Claude Code deleted this session's transcript");
    await expect(pane(page, gone.sid).getByTestId('timeline-gone')).toContainText('6 turns');
  });

  test('US-73: with the detailed timeline on, tools say who approved them and turns show their API time (mock)', async ({ page }) => {
    test.skip(!isMock(), 'uses the mock "report" fixture');
    await reset('report');
    await api('POST', '/api/otel', { enabled: true });
    const s = (await sessions()).find((x) => x.title === 'Add the signup form');
    await login(page);
    await rowButton(page, s.sid).click();
    await pane(page, s.sid).getByTestId('pane-view-timeline').click();
    const tl = pane(page, s.sid).getByTestId('timeline');
    await expect(tl.locator('.tl-approval').first()).toHaveText('you allowed it once');
    await expect(tl.locator('.tl-api').first()).toContainText('2 requests');
  });
});

test.describe('report card: org map and Settings', () => {
  test('US-71: the org map shows each agent\'s 7-day usage and last-done age, and the org totals (mock)', async ({ page }) => {
    test.skip(!isMock(), 'uses the mock "report" fixture');
    await reset('report');
    await login(page, '#/map');
    await expect(page.getByTestId('map-usage')).toContainText('Usage at list price, not a bill: today about $2.');
    await expect(page.getByTestId('map-usage')).toContainText('last 7 days about $10.65');
    await expect(page.locator('[data-usage="site"]')).toHaveText('$10.22 · 3h ago');
    await expect(page.locator('[data-node="site"]')).toHaveAttribute('aria-label', /about \$10\.22 of usage in 7 days at list price, last finished work 3h ago/);
    await page.locator('[data-node="site"] .node-disc').click();
    const facts = page.getByTestId('panel-usage');
    await expect(facts).toContainText('Done, 7 days');
    await expect(facts).toContainText('$10.22');
    await expect(page.getByTestId('map-panel')).toContainText('list-price equivalent, not a bill');
  });

  test('US-72: the Monday report is off by default, shows its exact text, and turns on once Donna is paired', async ({ page }) => {
    test.skip(!isMock(), 'pairing a channel is mock-only');
    await reset('report');
    await login(page, '#/settings');
    const card = page.getByTestId('monday-card');
    await expect(card.getByTestId('monday-switch')).not.toBeChecked();
    await expect(card.getByTestId('monday-switch')).toBeDisabled();
    await expect(card).toContainText('Pair Donna with Telegram or iMessage first');
    const preview = card.getByTestId('monday-preview');
    await expect(preview).toContainText('Clawdling: your week, the last 7 days.');
    await expect(preview).toContainText('- Launch the website: 4 done, 0 need you, about $10.22');
    await expect(preview).toContainText('not a bill');
    await expect(preview).not.toContainText('Add the signup form'); // never a session title
    await api('POST', '/api/channels/imessage', { handle: 'owner@example.com', enabled: true });
    await page.reload();
    await expect(card.getByTestId('monday-switch')).toBeEnabled();
    await expect(card).toContainText('Counts, agent names and dollar figures only');
    await card.locator('label.switch').filter({ has: page.getByTestId('monday-switch') }).click();
    await expect(card.getByTestId('monday-switch')).toBeChecked();
    await expect(card).toContainText('Next one:');
    await card.getByTestId('monday-day').selectOption('5');
    await expect.poll(async () => (await api('GET', '/api/digest')).day).toBe(5);
  });

  test('US-73: the detailed timeline is off by default, and stays off where Claude Code already has telemetry settings (mock)', async ({ page }) => {
    test.skip(!isMock(), 'the preflight result is mocked');
    await reset('report');
    await login(page, '#/settings');
    const card = page.getByTestId('otel-card');
    await expect(card).toContainText('beta');
    await expect(card.getByTestId('otel-switch')).not.toBeChecked();
    await expect(card).toContainText('never to anyone else');
    await card.locator('label.switch').filter({ has: page.getByTestId('otel-switch') }).click();
    await expect(card.getByTestId('otel-switch')).toBeChecked();
    await expect(card).toContainText("It takes effect at each session's next start");
    await mock('otel', { blocked: true });
    await page.reload();
    await expect(card.getByTestId('otel-switch')).toBeDisabled();
    await expect(card).toContainText('Your Claude Code already has telemetry settings, so the detailed timeline stays off and Clawdling uses transcripts.');
    await expect(card.getByTestId('otel-found')).toContainText('OTEL_EXPORTER_OTLP_ENDPOINT');
  });
});
