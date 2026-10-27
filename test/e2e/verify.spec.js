// Verified done (1.6): claim receipts in the chat view and on the report card, the ship check and
// agent check-ups in the Check-up tab, the cost dialog, Try a cheaper model, and the Verified block.
// Tests marked mock-only inject claims and ship-check results through the mock; the check-up flow
// runs against the real server too (its fake claude drafts, answers and judges).
import { test, expect } from '@playwright/test';
import { api, isMock, login, mock, mockRequests, openPanes, pane, reset, spawn, tag } from './helpers.js';

const at = (min) => new Date(Date.now() - min * 60000).toISOString();

async function freshDomain(name) {
  const a = await api('POST', '/api/agents', { kind: 'domain', name: `${name}${tag()}`, mission: 'Keep the garden alive and the seed list current' });
  return (a.agent || a).id;
}

test.describe('claim receipts (mock-only)', () => {
  test.skip(() => !isMock(), 'claims are injected through the mock');

  test('US-75: a "done" message carries its receipt: Verified, Not verified or Contradicted, each with its evidence', async ({ page }) => {
    await reset('empty');
    const sid = await spawn({ agent: 'work', title: `Signup form${tag()}`, status: 'ready', lastMessage: 'Fixed. It works now.' });
    const t1 = at(30);
    const t2 = at(20);
    const t3 = at(10);
    await mock('transcript', { sid, messages: [
      { role: 'user', text: 'Add email validation and run the tests' },
      { role: 'assistant', text: 'Done. All tests pass.', ts: t1 },
      { role: 'user', text: 'Also trim spaces' },
      { role: 'assistant', text: 'Done, spaces are trimmed.', ts: t2 },
      { role: 'user', text: 'Is the empty case handled?' },
      { role: 'assistant', text: 'Fixed. It works now.', ts: t3 },
    ] });
    await mock('claims', { sid, claims: [
      { at: t1, kind: 'tests', needs: ['test'], phrase: 'all tests pass', label: 'verified', check: { cmd: 'npm test', at: t1, ok: true, first_error_line: null } },
      { at: t2, kind: 'completion', needs: [], phrase: 'done', label: 'not_verified', check: null },
      { at: t3, kind: 'completion', needs: [], phrase: 'fixed', label: 'contradicted', check: { cmd: 'npm test', at: t3, ok: false, first_error_line: 'FAIL src/signup.test.js > rejects an empty email' } },
    ] });
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    const badges = p.getByTestId('claim-badge');
    await expect(badges).toHaveCount(3);
    await expect(badges.nth(0)).toHaveAttribute('data-claim', 'verified');
    await expect(badges.nth(0)).toContainText('Verified');
    await expect(badges.nth(0)).toContainText('npm test');
    await expect(badges.nth(0)).toContainText('after the last edit');
    await expect(badges.nth(1)).toContainText('Not verified');
    await expect(badges.nth(1)).toContainText('No check ran after the last edit.');
    await expect(badges.nth(2)).toContainText('Contradicted');
    await expect(badges.nth(2)).toContainText('FAIL src/signup.test.js > rejects an empty email');
    // The evidence is one tap away, and says no model judged it.
    await badges.nth(1).locator('.claim-head').click();
    await expect(badges.nth(1).getByTestId('claim-detail')).toContainText('not an accusation');
    await expect(badges.nth(1).getByTestId('claim-detail')).toContainText('no model judged it');
    // US-76: "Ask the agent to fix it" shows the exact message first.
    await badges.nth(2).getByTestId('claim-fix').click();
    const text = 'Your last check failed: `npm test` → `FAIL src/signup.test.js > rejects an empty email`. Please fix it and re-run the check.';
    await expect(page.getByTestId('fix-text')).toHaveText(text);
    await page.getByTestId('fix-send').click();
    await expect(page.locator('.toast', { hasText: 'Sent to the agent' })).toBeVisible();
    const sent = (await mockRequests()).find((r) => r.path === `/api/sessions/${sid}/fix`);
    expect(sent.body.text).toBe(text);
  });

  test('US-76: a contradicted claim waits in Needs you, with "Ask the agent to fix it"; the Done row shows the label', async ({ page }) => {
    await reset('empty');
    const t = tag();
    const live = await spawn({ agent: 'work', title: `Live fix${t}`, status: 'ready', lastMessage: 'Done.' });
    await mock('claims', { sid: live, claims: [{ at: at(5), kind: 'completion', needs: [], phrase: 'done', label: 'contradicted', check: { cmd: 'npm test', at: at(5), ok: false, first_error_line: 'Error: expected 2, got 3' } }] });
    await login(page, '#/agent/work');
    const needs = page.getByTestId('rc-needs');
    await expect(needs.locator(`[data-sid="${live}"]`)).toContainText('Said done, but a check failed');
    await expect(needs.locator(`[data-sid="${live}"]`)).toContainText('expected 2, got 3');
    await needs.getByTestId('rc-fix').click();
    await expect(page.getByTestId('fix-text')).toContainText('Please fix it and re-run the check.');
    await page.getByRole('button', { name: 'Cancel' }).click();
    // The Verified block counts the week's claims by label.
    const v = page.getByTestId('rc-verified');
    await expect(v.locator('[data-claim="contradicted"] .rc-claim-n')).toHaveText('1');
    await expect(v).toContainText('Not verified: no check ran after it, or one that cannot be tied to it (not an accusation)');
  });
});

test.describe('the ship check (mock-only)', () => {
  test.skip(() => !isMock(), 'the mock stands in for a project repo');

  test('US-77: set up a ship check: every command shown exactly with what it does, nothing runs until approved', async ({ page }) => {
    await reset('default');
    await login(page, '#/agent/site/checkup');
    const ship = page.getByTestId('ship-check');
    await expect(ship).toContainText('never in the live one');
    const setup = page.getByTestId('ship-setup');
    await expect(setup).toContainText("A check runs your project's own scripts as you.");
    await expect(setup.locator('[data-run="npm test"]')).not.toBeChecked();
    await expect(setup).toContainText('Runs the "test" script from package.json: vitest run');
    await expect(setup).toContainText('downloads code from the npm registry');
    await expect(page.getByTestId('ship-approve')).toBeDisabled();
    await setup.locator('[data-run="npm test"]').check();
    await setup.locator('[data-run="npm run build"]').check();
    await page.getByTestId('ship-approve').click();
    await expect(page.locator('.toast', { hasText: 'Ship check approved' })).toBeVisible();
    const put = (await mockRequests()).find((r) => r.method === 'PUT' && r.path === '/api/agents/site/checks');
    expect(put.body.shown).toEqual(['npm test', 'npm run build']);
    expect(put.body.setup).toEqual([]);
    await expect(ship.locator('.cu-cmds')).toContainText('npm test');
    await expect(ship).toContainText('New files the agent has not added to git are not included');
  });

  test('US-78: run the ship check: progress, then pass or fail per check with the last lines of output', async ({ page }) => {
    await reset('default');
    await api('PUT', '/api/agents/site/checks', { checks: [{ name: 'tests', run: 'npm test' }, { name: 'build', run: 'npm run build' }], shown: ['npm test', 'npm run build'] });
    await mock('verify', { checkFails: true });
    await login(page, '#/agent/site/checkup');
    await page.getByTestId('ship-run').click();
    const r = page.getByTestId('ship-result');
    await expect(r).toHaveAttribute('data-ok', 'false', { timeout: 10000 });
    await expect(r).toContainText('Failed');
    await r.locator('li.is-bad summary').click();
    await expect(r).toContainText('AssertionError: expected 200 to be 400');
    // The report card's Verified block shows it.
    await page.locator('[data-tab-btn="overview"]').click();
    await expect(page.getByTestId('rc-ship')).toContainText('Failed');
  });
});

test.describe('agent check-ups', () => {
  test('US-79 and US-80: draft, read and edit the cases, approve, then run with the cost shown first', async ({ page }) => {
    if (isMock()) await reset('empty');
    const id = await freshDomain('Garden');
    await login(page, `#/agent/${id}/checkup`);
    const box = page.getByTestId('agent-checkup');
    await box.getByTestId('checkup-draft').click();
    await expect(page.locator('.modal', { hasText: 'capped at $0.50' })).toBeVisible();
    await page.getByTestId('draft-go').click();
    const cards = page.getByTestId('case-card');
    await expect(cards).toHaveCount(5, { timeout: 20000 });
    await expect(box).toContainText('5 waiting for your review');
    await expect(page.getByTestId('checkup-run')).toBeDisabled();
    // Open a case, edit its criteria, save: saving from here approves it as written.
    const job = page.locator('[data-case="knows-its-job"]');
    await job.locator('.cu-case-head').click();
    await expect(job.getByTestId('case-file-prompt.md')).toHaveValue(/^---\nname: knows-its-job\n/);
    const crit = job.getByTestId('case-file-graders/criteria.md');
    await crit.fill(`${await crit.inputValue()}\nNames the garden.\n`);
    await job.getByTestId('case-save').click();
    await expect(job.locator('.cu-chip')).toHaveAttribute('data-state', 'approved');
    await page.getByTestId('cases-approve').click();
    await expect(box).toContainText('5 approved');
    // The cost dialog: N runs, a range, the cap, and the Pro note, before anything starts.
    await page.getByTestId('checkup-run').click();
    const dlg = page.getByTestId('cost-dialog');
    await expect(dlg.getByTestId('cost-line')).toContainText('This starts 5 Claude Code runs on your plan');
    await expect(dlg.getByTestId('cost-line')).toContainText('list-price equivalent, capped at $2.00');
    await expect(dlg.getByTestId('cost-pro')).toContainText('On Pro');
    await page.getByTestId('cost-go').click();
    await expect(page.getByTestId('checkup-result')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('checkup-score')).toContainText('%');
    await expect(page.getByTestId('case-result')).toHaveCount(5);
    // The judge's reasons and each run's Timeline are there.
    await page.getByTestId('case-result').first().locator('summary').first().click();
    await expect(page.getByTestId('case-result').first()).toContainText('judge votes');
    await expect(page.getByTestId('case-result').first().locator('.cu-timeline summary')).toContainText('Timeline');
    // The report card's Verified block and the org map show the last check-up.
    await page.locator('[data-tab-btn="overview"]').click();
    await expect(page.getByTestId('rc-checkup')).toContainText('average case score');
  });

  test('US-82: Try a cheaper model: each setting scored and priced; "Use this" sets the agent default', async ({ page }) => {
    if (isMock()) await reset('empty');
    const id = await freshDomain('Pantry');
    await api('POST', `/api/agents/${id}/evals/draft`, {});
    const v = await api('GET', `/api/agents/${id}/evals`);
    await api('POST', `/api/agents/${id}/evals/approve`, { cases: v.cases.map((c) => ({ id: c.id, hash: c.hash })) });
    await login(page, `#/agent/${id}/checkup`);
    await page.getByTestId('checkup-cheaper').locator('summary').click();
    await page.getByTestId('checkup-compare-run').click();
    await expect(page.getByTestId('cost-line')).toContainText('Claude Code runs on your plan');
    await page.getByTestId('cost-go').click();
    const cmp = page.getByTestId('checkup-compare');
    await expect(cmp).toBeVisible({ timeout: 60000 });
    await expect(cmp.locator('tbody tr')).toHaveCount(isMock() ? 2 : 3);
    const rec = page.getByTestId('checkup-rec');
    await expect(rec).toBeVisible();
    if (await page.getByTestId('checkup-use').count()) {
      await page.getByTestId('checkup-use').click();
      await expect(page.locator('.toast', { hasText: 'your Claude Code settings are unchanged' })).toBeVisible();
    }
  });

  test('US-81: a judge that passes an empty answer is unreliable, and no score is shown (mock-only)', async ({ page }) => {
    test.skip(!isMock(), 'the lenient judge is a mock switch');
    await reset('empty');
    const id = await freshDomain('Lenient');
    await api('POST', `/api/agents/${id}/evals/draft`, {});
    const v = await api('GET', `/api/agents/${id}/evals`);
    await api('POST', `/api/agents/${id}/evals/approve`, { cases: v.cases.map((c) => ({ id: c.id, hash: c.hash })) });
    await mock('verify', { evalLenient: true });
    await login(page, `#/agent/${id}/checkup`);
    await page.getByTestId('checkup-run').click();
    await page.getByTestId('cost-go').click();
    await expect(page.getByTestId('judge-unreliable')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('judge-unreliable')).toContainText('No agent run was spent');
    await expect(page.getByTestId('checkup-score')).toHaveCount(0);
  });
});
