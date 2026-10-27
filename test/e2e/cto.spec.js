// The CTO seat (1.7): "Add a CTO" on the org map, its page (Reviews, no Check-up), its CLAUDE.md
// in the Context tab, "Run this week's review" with the cost first, the decision card in the chat,
// Claude Code's permission prompt for the exact `clawdling send|spawn` command, and the review page
// with its lint, receipt links, decisions and messages. Against the real server the fake claude
// writes the review and asks; against the mock the "cto" fixture carries one of every marker.
// Set CLAWDLING_E2E_SHOTS=<dir> to save screenshots of each screen.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { api, isMock, login, mock, mockRequests, openPanes, pane, reset, sessionBySid, sessions, spawn, tag } from './helpers.js';

const SHOTS = process.env.CLAWDLING_E2E_SHOTS || '';
async function shot(target, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: 'disabled' });
}

async function until(fn, { timeout = 30000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// "Beside Donna": the CTO node is on Donna's orbit around you (the same distance from you), a
// short arc from her.
async function expectBesideDonna(page) {
  await page.getByRole('button', { name: 'Fit the whole org' }).click();
  await page.waitForTimeout(600); // the fit animation
  const centre = async (sel) => {
    const b = await page.locator(`[data-node="${sel}"] .node-disc`).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const [you, donna, cto] = [await centre('__owner'), await centre('donna'), await centre('cto')];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  expect(Math.abs(d(you, cto) - d(you, donna))).toBeLessThan(4);
  expect(d(cto, donna)).toBeLessThan(d(you, donna) * 1.5);
}

test.describe('the CTO seat (real server)', () => {
  test.skip(() => isMock(), 'the fake claude writes the review and asks its questions');

  test('Add a CTO, edit its CLAUDE.md, run the review, decide, decline the message, read the cited review', async ({ page }) => {
    test.setTimeout(180_000);
    await reset();
    // Something to decide about: a project agent (placeholder names only).
    const taken = (await api('GET', '/api/org')).agents.some((a) => a.id === 'atlas');
    await api('POST', '/api/agents', { kind: 'project', name: taken ? `Atlas${tag()}` : 'Atlas', mission: 'Ship the new docs site' });

    // The org map: "Add a CTO" puts the seat on Donna's orbit (a retry finds it already there).
    await login(page, '#/map');
    if (!(await api('GET', '/api/cto')).exists) {
      await page.getByTestId('map-add-cto').click();
      await expect(page.locator('.toast', { hasText: 'Your CTO is ready' })).toBeVisible();
    }
    await expect(page.getByTestId('map-add-cto')).toHaveCount(0);
    const node = page.locator('[data-node="cto"][data-kind="cto"]');
    await expect(node).toBeVisible();
    await expectBesideDonna(page);
    await shot(page, '01-org-map-cto-node');

    // Its panel opens the reviews; the page has Reviews, Sessions, Context, Memory (no Check-up).
    // "Add a CTO" selects the new node, so its panel is open already.
    if ((await node.getAttribute('aria-pressed')) !== 'true') await node.locator('.node-disc').click();
    await expect(page.getByTestId('panel-open-agent')).toHaveText('Open the reviews');
    await page.getByTestId('panel-open-agent').click();
    await expect(page).toHaveURL(/#\/agent\/cto$/);
    await expect(page.getByTestId('cto-page')).toBeVisible();
    await expect(page.locator('[data-tab-btn="overview"]')).toHaveText('Reviews');
    await expect(page.locator('[data-tab-btn="checkup"]')).toHaveCount(0);

    // Context: its CLAUDE.md (the review rules), saved like any agent's.
    await page.locator('[data-tab-btn="context"]').click();
    const editor = page.getByTestId('editor-claude_md');
    await expect(editor).toHaveValue(/Cite a receipt id in brackets on every bullet/);
    const line = `- Keep each finding to one line${tag()}.`;
    await editor.fill(`${(await editor.inputValue()).trimEnd()}\n${line}\n`);
    await page.getByTestId('save-claude_md').click();
    await expect(page.locator('.editor-state')).toContainText('Saved');
    expect((await api('GET', '/api/agents/cto')).claude_md).toContain(line);

    // Run this week's review: the cost first (a dollar range), then Start.
    await page.locator('[data-tab-btn="overview"]').click();
    await page.getByTestId('cto-run').click();
    const dlg = page.getByTestId('cto-cost-dialog');
    await expect(dlg.getByTestId('cto-cost-line')).toHaveText(/about \$\d+\.\d\d to \$\d+\.\d\d list-price equivalent/);
    await expect(dlg).toContainText('Each message to another agent waits for your yes.');
    await page.getByTestId('cto-cost-go').click();
    const sid = await until(async () => (await api('GET', '/api/cto')).running, { label: 'the review session' });
    const p = pane(page, sid);
    await expect(p).toHaveAttribute('data-focused', 'true');

    // The decision card in the chat: "Ask <first>" for the first question, "Leave" for any others.
    const card = p.getByTestId('question-card');
    await expect(card).toHaveAttribute('data-state', 'pending', { timeout: 30000 });
    await expect(card).toContainText('what should happen next?');
    if (SHOTS) await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10000 }); // "Your CTO is ready" fades
    await shot(p, '03-decision-card');
    const qs = card.locator('fieldset');
    const n = await qs.count();
    const picked = (await qs.nth(0).getByTestId('ask-option').nth(0).locator('.ask-opt-label').innerText()).trim();
    expect(picked).toMatch(/^Ask .+ to look at it$/);
    for (let i = 0; i < n; i++) await qs.nth(i).getByTestId('ask-option').nth(i === 0 ? 0 : 1).click();
    await card.getByTestId('ask-send').click();

    // Claude Code's permission prompt shows the exact command; decline it.
    const banner = p.getByTestId('pane-question');
    await expect(banner).toBeVisible({ timeout: 30000 });
    await expect(p.getByTestId('pane-question-text')).toHaveText('Send this message to another agent?');
    const cmd = p.getByTestId('pane-pending-cmd');
    await expect(cmd).toHaveText(/^clawdling (send|spawn) \S+ "Your CTO review flagged this: .+"$/);
    const command = await cmd.innerText();
    expect(command).toContain('Your CTO review flagged this');
    // The CLI (what agents and Donna use) never sees what the CTO is asking.
    expect((await sessionBySid(sid)).pending_cmd).toBe(null);
    await shot(p, '04-permission-banner');
    await banner.getByTestId('question-choice').filter({ hasText: /^No\b/ }).click();
    await until(async () => (await sessionBySid(sid))?.status === 'ready', { label: 'the review to finish' });
    // Nothing was delivered: no new session of the project and no message in a live one.
    expect((await sessions()).filter((s) => s.sid !== sid && s.agent !== 'cto' && /Your CTO review flagged this/.test(`${s.title || ''} ${s.last_message || ''}`))).toEqual([]);

    // The review page: clean lint, citations as links, the decision and the declined message.
    await login(page, '#/agent/cto');
    const review = page.getByTestId('cto-review');
    await expect(review).toBeVisible();
    const lint = page.getByTestId('cto-lint');
    await expect(lint).toHaveText(/^\s*\d+ findings, all cited\s*$/);
    await expect(lint).toHaveClass(/is-clean/);
    await expect(page.getByTestId('cto-headline')).toContainText('at risk');
    await expect(page.getByTestId('cto-section').first()).toBeVisible();
    const cites = review.locator('a.cite[data-receipt]');
    expect(await cites.count()).toBeGreaterThan(0);
    for (const href of await cites.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) expect(href).toMatch(/^#\//);
    await expect(review.locator('span.cite.is-bad')).toHaveCount(0);
    await expect(review.locator('.cto-flag')).toHaveCount(0);
    await expect(page.getByTestId('cto-missing')).toHaveCount(0);
    const answered = page.getByTestId('cto-decisions').locator('li[data-state="answered"]').first();
    await expect(answered).toContainText(`You chose: ${picked}`);
    const declined = page.getByTestId('cto-deliveries').locator('li[data-state="declined"]');
    await expect(declined).toHaveCount(1);
    await expect(declined).toContainText('You declined it: not sent');
    await expect(declined.locator('.cto-del-msg')).toHaveText(command.replace(/^clawdling \S+ \S+ "(.*)"$/, '$1'));
    await review.getByRole('button', { name: 'Show the file' }).click();
    await expect(page.getByTestId('cto-file')).toContainText('Declined: Your CTO review flagged this');
    await review.getByRole('button', { name: 'Hide the file' }).click();
    if (SHOTS) {
      await page.setViewportSize({ width: 1440, height: 2400 });
      await shot(page.getByTestId('cto-page'), '02-cto-review-page');
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    // Settings: the weekly run is off by default and says what it costs before it is on; the
    // Monday report line is previewed.
    await login(page, '#/settings');
    const ctoCard = page.getByTestId('cto-card');
    await expect(ctoCard.getByTestId('cto-schedule-switch')).not.toBeChecked();
    await expect(ctoCard).toContainText(/about \$\d+\.\d\d(?: to \$\d+\.\d\d)? each time \(list-price equivalent, not a bill\)/);
    await expect(ctoCard.getByTestId('cto-digest-switch')).not.toBeChecked();
    await expect(ctoCard.getByTestId('cto-digest-preview')).toHaveText(/^CTO, week \d+: .+/);
    await ctoCard.scrollIntoViewIfNeeded();
    await shot(ctoCard, '05-settings-cto-card');
  });
});

test.describe('the CTO seat (mock)', () => {
  test.skip(() => !isMock(), 'uses the mock "cto" fixture');

  test('the map offers "Add a CTO" when there is none; one click puts the CTO on Donna\'s orbit, and its panel opens the reviews', async ({ page }) => {
    await reset('default');
    await login(page, '#/map');
    await expect(page.locator('[data-node="cto"]')).toHaveCount(0);
    await page.getByTestId('map-add-cto').click();
    await expect(page.locator('.toast', { hasText: 'Your CTO is ready' })).toBeVisible();
    expect((await mockRequests()).some((r) => r.method === 'POST' && r.path === '/api/cto')).toBe(true);
    await expect(page.getByTestId('map-add-cto')).toHaveCount(0);
    const node = page.locator('[data-node="cto"][data-kind="cto"]');
    await expect(node).toBeVisible();
    await expectBesideDonna(page);
    // "Add a CTO" selects the new node, so its panel is open already.
    if ((await node.getAttribute('aria-pressed')) !== 'true') await node.locator('.node-disc').click();
    await expect(page.getByTestId('panel-open-agent')).toHaveText('Open the reviews');
    await page.getByTestId('panel-open-agent').click();
    await expect(page).toHaveURL(/#\/agent\/cto$/);
    await expect(page.locator('[data-tab-btn="overview"]')).toHaveText('Reviews');
    await expect(page.locator('[data-tab-btn="checkup"]')).toHaveCount(0);
    await expect(page.getByTestId('cto-empty')).toContainText('No reviews yet');
  });

  test('with a CTO the map has no "Add a CTO" and shows the CTO node beside Donna', async ({ page }) => {
    await reset('cto');
    await login(page, '#/map');
    await expect(page.locator('[data-node="cto"][data-kind="cto"]')).toBeVisible();
    await expect(page.getByTestId('map-add-cto')).toHaveCount(0);
    await expect(page.locator('[data-node="cto"]')).toContainText('CTO');
    await expectBesideDonna(page);
  });

  test('Run this week\'s review: the cost range first, then Start opens the new session', async ({ page }) => {
    await reset('default');
    await api('POST', '/api/cto');
    await login(page, '#/agent/cto');
    await expect(page.getByTestId('cto-empty')).toBeVisible();
    await page.getByTestId('cto-run').click();
    const dlg = page.getByTestId('cto-cost-dialog');
    await expect(dlg.getByTestId('cto-cost-line')).toHaveText('This starts one Claude Code session on your plan, about $0.18 to $0.54 list-price equivalent.');
    await shot(page, 'mock-cost-dialog');
    await expect(dlg).toContainText("Based on the size of the CTO's prompt");
    await page.getByTestId('cto-cost-go').click();
    await expect.poll(async () => (await api('GET', '/api/cto')).running).toBeTruthy();
    const sid = (await api('GET', '/api/cto')).running;
    await expect(pane(page, sid)).toHaveAttribute('data-focused', 'true');
    expect((await sessionBySid(sid)).title).toMatch(/^CTO review, \d{4}-W\d{2}$/);
    // Back on the page: one run at a time, so the button opens the running one.
    await login(page, '#/agent/cto');
    await expect(page.getByTestId('cto-open-run')).toBeVisible();
    await expect(page.getByTestId('cto-run')).toHaveCount(0);
  });

  test('the review page marks every finding: cited links, uncited, no such receipt, an override with its reason, a missing section', async ({ page }) => {
    await reset('cto');
    const site = (await sessions()).find((s) => s.agent === 'site');
    await login(page, '#/agent/cto');
    const review = page.getByTestId('cto-review');
    await expect(review).toBeVisible();
    const lint = page.getByTestId('cto-lint');
    await expect(lint).toHaveClass(/is-flagged/);
    await expect(lint).toContainText('1 uncited · 1 citation to a receipt that does not exist · 1 label overridden by the CTO. Flagged lines are marked below.');
    await expect(page.getByTestId('cto-headline')).toHaveText('One project is at risk and one has stalled; the rest are on track or quiet.');
    const sections = page.getByTestId('cto-section');
    await expect(sections).toHaveCount(5);

    // A clean, cited bullet: its receipt is a link to the session; an uncited one says so.
    const siteSec = page.locator('[data-testid="cto-section"][data-agent="site"]');
    await expect(siteSec.locator('.cto-label')).toHaveText('At risk');
    await expect(siteSec).toContainText('Computed by Clawdling');
    const bullets = siteSec.getByTestId('cto-bullet');
    await expect(bullets.nth(0)).toHaveAttribute('data-state', 'cited');
    const cite = bullets.nth(0).locator('a.cite[data-receipt="R-claim-1a2b3c4d"]');
    await expect(cite).toHaveText('claim');
    await expect(cite).toHaveAttribute('href', `#/s/${site.sid}`);
    await expect(cite).toHaveAttribute('title', /^R-claim-1a2b3c4d: Contradicted/);
    await expect(bullets.nth(1)).toHaveAttribute('data-state', 'uncited');
    await expect(bullets.nth(1).locator('.cto-flag')).toHaveText('uncited');
    await expect(bullets.nth(1).locator('.cite')).toHaveCount(0);

    // A citation to a receipt that does not exist.
    const health = page.locator('[data-testid="cto-section"][data-agent="health"]');
    await expect(health.getByTestId('cto-bullet').nth(0)).toHaveAttribute('data-state', 'cited');
    const bad = health.getByTestId('cto-bullet').nth(1);
    await expect(bad).toHaveAttribute('data-state', 'unknown');
    await expect(bad.locator('span.cite.is-bad[data-receipt="R-session-00000000"]')).toHaveText('no such receipt');
    await expect(bad.locator('a.cite')).toHaveCount(0);

    // A label the CTO changed: its reason, and the label Clawdling computed.
    const marathon = page.locator('[data-testid="cto-section"][data-agent="marathon"]');
    await expect(marathon).toHaveClass(/state-overridden/);
    await expect(marathon.locator('.cto-sec-h .cto-label')).toHaveText('On track');
    const over = marathon.getByTestId('cto-override');
    await expect(over).toContainText('Overridden by the CTO, here is why: the plan was rewritten on paper this week, outside Clawdling');
    await expect(over.locator('a.cite[data-receipt="R-next-5e6f7a8b"]')).toHaveAttribute('href', '#/agent/marathon');
    await expect(over.locator('.cto-was')).toContainText('Clawdling computed');
    await expect(over.locator('.cto-was [data-label="stalled"]')).toHaveText('Stalled');
    await expect(marathon.getByTestId('cto-bullet')).toHaveCount(1); // the Override line is the reason, not a finding
    await expect(page.getByTestId('cto-mismatch')).toHaveCount(0);

    // An agent with no section.
    await expect(page.getByTestId('cto-missing')).toHaveText('No section for Home (Quiet).');
    await shot(page.getByTestId('cto-review'), 'mock-review-markers');

    // The file itself, as text.
    await review.getByRole('button', { name: 'Show the file' }).click();
    await expect(page.getByTestId('cto-file')).toContainText('## Spring half marathon: On track');
    await expect(page.getByTestId('cto-file')).toContainText('Declined: Your CTO review flagged this: nothing finished in 9 days.');

    // A receipt link opens what it points at: here, the session.
    await cite.click();
    await expect(pane(page, site.sid)).toHaveAttribute('data-focused', 'true');
  });

  test('decisions and messages: answered and waiting, sent and declined; "Answer it" opens the asking session', async ({ page }) => {
    await reset('cto');
    const all = await sessions();
    const site = all.find((s) => s.agent === 'site');
    const asking = all.find((s) => s.agent === 'cto' && s.status === 'needs_you');
    await login(page, '#/agent/cto');
    await expect(page.getByTestId('cto-open-run')).toHaveText('It is asking you: open it');
    const dec = page.getByTestId('cto-decisions');
    await expect(dec.locator('li.cto-dec')).toHaveCount(2);
    const answered = dec.locator('li[data-state="answered"]');
    await expect(answered).toContainText('Launch the website: what should happen next?');
    await expect(answered).toContainText('Options: Ask Launch the website to look at it · Leave Launch the website for now');
    await expect(answered.locator('.cto-dec-a')).toHaveText('You chose: Ask Launch the website to look at it');
    const waiting = dec.locator('li[data-state="waiting"]');
    await expect(waiting).toContainText('Spring half marathon: what should happen next?');
    await expect(waiting).toContainText('Waiting for you.');

    const del = page.getByTestId('cto-deliveries');
    await expect(del.locator('li.cto-del')).toHaveCount(2);
    const sent = del.locator('li[data-state="sent"]');
    await expect(sent.locator('.pill')).toHaveText('Sent');
    await expect(sent).toContainText(`To session ${site.sid.slice(0, 8)}`);
    await expect(sent.locator('.cto-del-msg')).toHaveText('Your CTO review flagged this: a "done" claim was contradicted. Please look at it and say what you will do.');
    const declined = del.locator('li[data-state="declined"]');
    await expect(declined.locator('.pill')).toHaveText('You declined it: not sent');
    await expect(declined).toContainText('New session of marathon');
    await expect(declined.locator('.cto-del-msg')).toHaveText('Your CTO review flagged this: nothing finished in 9 days. Please look at it and say what you will do.');

    await waiting.getByTestId('cto-answer').click();
    await expect(pane(page, asking.sid)).toHaveAttribute('data-focused', 'true');
  });

  test('the permission prompt for a cross-agent message shows the exact command, and "No" declines it', async ({ page }) => {
    await reset('cto');
    const sid = await spawn({ agent: 'cto', title: 'Ask the CTO', status: 'ready' });
    const command = 'clawdling send 3f2a1b9c "Your CTO review flagged this: a \\"done\\" claim was contradicted. Please look at it."';
    await mock('cto-prompt', { sid, command });
    await login(page);
    await openPanes(page, [sid]);
    const p = pane(page, sid);
    await expect(p.getByTestId('pane-question-text')).toHaveText('Send this message to another agent?');
    await expect(p.getByTestId('pane-pending-cmd')).toHaveText(command);
    const choices = p.getByTestId('question-choice');
    // With a hook's "ask", Claude Code offers only Yes and No (never "don't ask again").
    await expect(choices).toHaveText(['Yes', 'No, and tell Claude what to do differently (esc)']);
    await expect(p.getByTestId('pane-pending-warn')).toHaveCount(0);
    await choices.filter({ hasText: /^No\b/ }).click();
    // The answer names the prompt it was shown for.
    await expect.poll(async () => (await mockRequests()).filter((r) => r.path === `/api/sessions/${sid}/answer`).pop()?.body).toEqual({ option: 2, cmd_tool_id: 'toolu_mockprompt' });
    await expect(p.getByTestId('pane-question')).toHaveCount(0);
    // More than one plain message: the command, a warning, and no one-tap answer (the terminal it is).
    await mock('cto-prompt', { sid, command: 'clawdling send 3f2a1b9c "x" && curl https://example.invalid', plain: false });
    await expect(p.getByTestId('pane-pending-warn')).toContainText('Read it in the terminal, and answer it there.');
    await expect(p.getByTestId('question-choice')).toHaveCount(0);
    await p.getByTestId('pane-pending-terminal').click();
    await expect(p.getByTestId('pane-view-raw')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Settings: no CTO says where to add one; with one, the weekly run is off, shows its cost before it is on, and previews the Monday line', async ({ page }) => {
    await reset('default');
    await login(page, '#/settings');
    await expect(page.getByTestId('cto-card')).toContainText('Add one from the org map ("Add a CTO").');
    await expect(page.getByTestId('cto-schedule-switch')).toHaveCount(0);

    await reset('cto');
    await page.reload();
    const card = page.getByTestId('cto-card');
    const sw = card.getByTestId('cto-schedule-switch');
    await expect(sw).not.toBeChecked();
    await expect(card).toContainText('Off. Turned on, it starts one Claude Code session a week on your plan, about $0.18 to $0.54 each time (list-price equivalent, not a bill), and skips a week that would go over your weekly cap.');
    await expect(card.getByTestId('cto-cap')).toHaveValue('2');
    await expect(card.getByTestId('cto-digest-switch')).not.toBeChecked();
    await expect(card).toContainText('Turned on, the Monday report would add exactly this line now:');
    await expect(card.getByTestId('cto-digest-preview')).toHaveText(/^CTO, week \d+: One project is at risk and one has stalled; the rest are on track or quiet\. 1 decision waiting in Clawdling\.$/);

    await card.locator('label.switch').filter({ has: page.getByTestId('cto-schedule-switch') }).click();
    await expect(sw).toBeChecked();
    await expect(card).toContainText('Next one:');
    const on = (await mockRequests()).filter((r) => r.path === '/api/cto/settings').pop();
    expect(on.body).toEqual({ enabled: true, weekly_cap_usd: 2 });
    await card.getByTestId('cto-day').selectOption('5');
    await expect.poll(async () => (await api('GET', '/api/cto')).schedule.day).toBe(5);
    await expect(card).toContainText('Run the CTO review every Friday');
    await card.locator('label.switch').filter({ has: page.getByTestId('cto-digest-switch') }).click();
    await expect(card.getByTestId('cto-digest-switch')).toBeChecked();
    await expect(card).toContainText('The Monday report adds this line now:');
  });
});
