// Setup safety (1.8): the Safety section on the Setup card (Settings), at 1280 and 375 px; the
// shields on the org map and the report card; accept-with-a-reason; tagging an unknown server; and
// the "newer than the last version checked" note. The mock computes the audit with the real
// server/safety.js over a names-only fixture; one test runs against the real server too.
import { test, expect } from '@playwright/test';
import { api, isMock, login, mock, reset } from './helpers.js';

const rowOf = (page, id) => page.locator(`[data-safety-row="${id}"]`);

test.describe('setup safety', () => {
  test('US-91/US-92: every agent and the user level, three chips that name their sources; red rows open with the sentence and fixes (1280 px)', async ({ page }) => {
    test.skip(!isMock(), 'mock fixture');
    await reset('default');
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, '#/settings/safety');
    const sec = page.getByTestId('safety-section');
    await expect(sec).toBeVisible();
    await expect(sec).toContainText('lethal trifecta');
    await expect(sec.getByRole('link', { name: /Simon Willison/ })).toHaveAttribute('href', /simonwillison\.net/);
    await expect(page.getByTestId('safety-tally')).toContainText('2 with the lethal trifecta');
    for (const id of ['_user', 'donna', 'work', 'health', 'site']) await expect(rowOf(page, id)).toBeVisible();
    await expect(rowOf(page, '_user')).toContainText('Everything (user level)');
    const site = rowOf(page, 'site');
    await expect(site).toHaveAttribute('data-verdict', 'red');
    await expect(site.locator('.safety-row-head')).toHaveAttribute('aria-expanded', 'true');
    await expect(site.locator('[data-cap="private"]')).toContainText('github MCP server (issues and code)');
    await expect(site.locator('[data-cap="untrusted"]')).toContainText('WebFetch');
    await expect(site.locator('[data-cap="sends"]')).toContainText('Bash(curl:*)');
    await expect(site.locator('[data-cap="sends"]')).toContainText('~/code/site/.claude/settings.json');
    await expect(site.getByTestId('safety-sentence')).toContainText(/^Lethal trifecta\. Text this agent reads through .+ could tell it to take your data from .+ and send it out with .+\.$/);
    const fixes = site.getByTestId('safety-fixes');
    await expect(fixes.locator('li')).toHaveCount(3);
    await expect(fixes).toContainText('Remove Bash(curl:*) from allow in ~/code/site/.claude/settings.json');
    await expect(fixes.locator('li').nth(2)).toContainText('And 2 more like these');
    await expect(fixes).toContainText('Clawdling changes nothing');
    // A green agent stays folded; opening it shows its three chips and "nothing by name".
    const health = rowOf(page, 'health');
    await expect(health).toHaveAttribute('data-verdict', 'green');
    await expect(health).toContainText('No trifecta found by name');
    await health.locator('.safety-row-head').click();
    await expect(health.locator('[data-cap="private"]')).toContainText('the org folder');
    await expect(health.locator('[data-cap="sends"]')).toContainText('nothing by name');
    // Donna: her inbound is the owner's own, and the UI says why.
    await rowOf(page, 'donna').locator('.safety-row-head').click();
    await expect(rowOf(page, 'donna')).toContainText('Her text-message turns load none of your Claude Code setup (only her allow-list); the sessions you open with her in the cockpit load it like any agent');
    await expect(sec).toContainText('Green means no trifecta found by name, not “secure”.');
    await page.screenshot({ path: test.info().outputPath('safety-1280.png'), fullPage: false });
  });

  test('US-93: setup risks with their files, and an unknown MCP server to review and tag', async ({ page }) => {
    test.skip(!isMock(), 'mock fixture');
    await reset('default');
    await api('POST', '/api/agents', { kind: 'project', name: 'Shop', repo: '/Users/ada/code/shop' });
    await login(page, '#/settings/safety');
    const shop = rowOf(page, 'shop');
    // db and stripe (private), the site agent's words (untrusted), stripe (sends): red, so it opens.
    await expect(shop).toHaveAttribute('data-verdict', 'red');
    await expect(shop.locator('.safety-row-head')).toHaveAttribute('aria-expanded', 'true');
    const risks = shop.getByTestId('safety-risks');
    await expect(risks.locator('[data-risk="session_start"]')).toContainText('~/code/shop/.claude/settings.json');
    await expect(risks.locator('[data-risk="repo_mcp"]')).toHaveCount(2);
    await expect(risks.locator('[data-risk="local_not_ignored"]')).toContainText('no .gitignore rule covers');
    // The user level: a plugin from a marketplace other than Anthropic's.
    await expect(rowOf(page, '_user').locator('.safety-row-head')).toHaveAttribute('aria-expanded', 'true'); // red: open
    await expect(rowOf(page, '_user').locator('[data-risk="marketplace"]').filter({ hasText: 'superpowers' })).toContainText('superpowers plugin comes from the "obra" marketplace');
    // figma (site's .mcp.json) is not in the table: unknown, never green; tag it.
    const site = rowOf(page, 'site');
    const unknown = site.getByTestId('safety-unknown');
    await expect(unknown).toContainText('figma MCP server');
    await unknown.getByTestId('safety-tag-open').click();
    await unknown.getByLabel('Private data').check();
    await unknown.getByTestId('safety-tag-save').click();
    await expect(site.locator('[data-cap="private"]')).toContainText('figma MCP server (tagged by you)');
  });

  test('accept a risk with a reason: red becomes amber, and it can be undone', async ({ page }) => {
    test.skip(!isMock(), 'mock fixture');
    await reset('default');
    await login(page, '#/settings/safety');
    const site = rowOf(page, 'site');
    await site.getByTestId('safety-accept-open').click();
    await expect(site.getByTestId('safety-accept-save')).toBeDisabled();
    await site.getByTestId('safety-accept-reason').fill('test data only; it never sees my mail');
    await site.getByTestId('safety-accept-save').click();
    await expect(site).toHaveAttribute('data-verdict', 'amber');
    await expect(site).toContainText('Lethal trifecta (accepted)');
    await expect(site.getByTestId('safety-accepted')).toContainText('test data only');
    await site.getByRole('button', { name: 'Stop accepting it' }).click();
    await expect(site).toHaveAttribute('data-verdict', 'red');
  });

  test('US-91 at 375 px: chips stack, nothing overflows', async ({ page }) => {
    test.skip(!isMock(), 'mock fixture');
    await reset('default');
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, '#/settings/safety');
    const site = rowOf(page, 'site');
    await expect(site.locator('[data-cap="sends"]')).toBeVisible();
    const boxes = await Promise.all(['private', 'untrusted', 'sends'].map((c) => site.locator(`[data-cap="${c}"]`).boundingBox()));
    expect(boxes[1].y).toBeGreaterThan(boxes[0].y); // one column
    expect(boxes[2].y).toBeGreaterThan(boxes[1].y);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const head = await site.locator('.safety-row-head').boundingBox();
    expect(head.height).toBeGreaterThanOrEqual(40);
    await page.screenshot({ path: test.info().outputPath('safety-375.png'), fullPage: false });
  });

  test('US-94: a shield on each agent on the map, the owner carries the user level, and the report card says it', async ({ page }) => {
    test.skip(!isMock(), 'mock fixture');
    await reset('default');
    await login(page, '#/map');
    await expect(page.locator('[data-node="site"] [data-map-shield="red"]')).toBeVisible();
    await expect(page.locator('[data-node="health"] [data-map-shield="green"]')).toBeVisible();
    await expect(page.locator('[data-node="donna"] [data-map-shield]')).toHaveCount(1);
    await expect(page.locator('[data-kind="owner"] [data-map-shield="red"]')).toHaveCount(1);
    await expect(page.locator('[data-node="site"]')).toHaveAttribute('aria-label', /setup safety: Lethal trifecta/);
    await page.locator('[data-node="site"] .node-disc').click();
    await expect(page.getByTestId('panel-safety')).toContainText('Setup safety: Lethal trifecta');
    await page.getByTestId('panel-safety').click();
    await expect(page).toHaveURL(/#\/settings\/safety$/);
    await login(page, '#/agent/health');
    await expect(page.getByTestId('report-safety')).toHaveAttribute('data-verdict', 'green');
    await expect(page.getByTestId('report-safety')).toContainText('No trifecta found by name');
  });

  test('US-98: Claude Code newer than the last version checked: one note, dismissible, once per version', async ({ page }) => {
    test.skip(!isMock(), 'mock health');
    await reset('default');
    await mock('health', { claude: { ok: true, version: '2.1.320 (Claude Code)' }, claude_compat: { max_checked: '2.1.308', newer: true } });
    await login(page, '#/map');
    const note = page.getByTestId('compat-note');
    await expect(note).toHaveText(/Claude Code 2\.1\.320 is newer than the last version Clawdling checked \(2\.1\.308\)\. It will probably work\. Run Doctor to check: .*doctor --contract/);
    await expect(page.getByTestId('health-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New session' }).first()).toBeEnabled(); // a note, never a block
    await note.getByTestId('compat-dismiss').click();
    await expect(note).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-node="site"]')).toBeVisible();
    await expect(page.getByTestId('compat-note')).toHaveCount(0);
    // A newer version still: it shows again.
    await mock('health', { claude: { ok: true, version: '2.1.321 (Claude Code)' }, claude_compat: { max_checked: '2.1.308', newer: true } });
    await page.reload();
    await expect(page.getByTestId('compat-note')).toContainText('2.1.321');
  });

  test('the real server: the Safety section lists the org, by name', async ({ page }) => {
    test.skip(isMock(), 'real server only');
    await login(page, '#/settings/safety');
    const sec = page.getByTestId('safety-section');
    await expect(sec).toBeVisible();
    await expect(rowOf(page, '_user')).toBeVisible();
    await expect(rowOf(page, 'donna')).toBeVisible();
    await expect(page.getByTestId('safety-tally')).toContainText('checked');
    await expect(sec).toContainText('Names only');
  });
});
