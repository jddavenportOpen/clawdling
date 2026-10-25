// 1.2: "Bring in your projects" (the first-run card, the wizard's "From a repo", the import screen
// with per-row progress, group import, Deep onboard) and "Your Claude Code setup" (the Settings
// card, promoting a subagent, the org map layer). Full-page screenshots for review go to
// test-results/screens-1.2/ (desktop 1440x900, and the import screen at phone 390x844).
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, reset, api, isMock, mock, mockRequests, panes, focusedPane, sessionBySid } from './helpers.js';

test.skip(() => !isMock(), 'drives the mock: discovery, gh and failures are simulated');

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-results', 'screens-1.2');
const shot = async (page, name) => {
  await page.waitForTimeout(250);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.screenshot({ path: path.join(DIR, `${name}.png`), fullPage: true });
};

const screen = (page) => page.getByTestId('import-screen');
const cand = (page, name) => page.locator(`.imp-row[data-candidate="${name}"]`);
const tick = (page, name) => cand(page, name).getByTestId('imp-check');
const importBodies = async () => (await mockRequests()).filter((r) => r.method === 'POST' && r.path === '/api/import').map((r) => r.body);
const orgAgents = async () => (await api('GET', '/api/org')).agents || [];
const scrollWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth);

async function openFromCard(page) {
  await page.getByTestId('first-import-go').click();
  await expect(screen(page)).toBeVisible();
  await expect(screen(page)).toHaveAttribute('data-phase', 'pick');
}

async function openFromPalette(page) {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`);
  await page.getByTestId('palette-input').fill('bring in');
  await page.locator('.pal-item', { hasText: 'Bring in your projects' }).click();
  await expect(screen(page)).toHaveAttribute('data-phase', 'pick');
}

// Leave exactly these ticked.
async function only(page, names) {
  for (const row of await page.locator('.imp-row').all()) {
    const name = await row.getAttribute('data-candidate');
    const box = row.getByTestId('imp-check');
    if (await box.isDisabled()) continue;
    if (names.includes(name)) await box.check();
    else await box.uncheck();
  }
}

test.describe('bring in your projects', () => {
  test('the first-run card opens the import screen: recent rows ticked, GitHub-only and archived ones not', async ({ page }) => {
    await reset('empty');
    await mock('discover', { delay: 4500 }); // long enough to see the loading state and the GitHub hint
    await login(page);
    const card = page.getByTestId('first-import');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Bring in your projects');
    await expect(card).toContainText('Nothing leaves this computer.');
    // Beside "Trust my org folder" it is the quiet second step: one filled button per screen.
    await expect(page.getByTestId('first-trust')).toBeVisible();
    await expect(page.getByTestId('first-import-go')).toHaveClass(/btn-quiet/);
    await shot(page, '01-empty-state-first-run-cards-1440x900');

    await page.getByTestId('first-import-go').click();
    await expect(page.getByTestId('imp-loading')).toBeVisible();
    await expect(page.getByTestId('imp-loading')).toContainText('Looking for your projects');
    await expect(page.getByTestId('imp-slow')).toBeVisible(); // after 2.5 s: still looking, and GitHub can be skipped
    // It does not blame GitHub: the folder walk may be the slow part.
    await expect(page.getByTestId('imp-slow')).toHaveText('Still looking… Asking GitHub can take a few seconds. Skip GitHub this time');
    await expect(page.getByTestId('imp-skip-github')).toBeVisible();
    await shot(page, '02-import-loading-1440x900');
    await expect(screen(page)).toHaveAttribute('data-phase', 'pick', { timeout: 6000 });

    const sources = page.getByTestId('imp-sources');
    await expect(sources.locator('[data-source="claude"]')).toContainText("folders you've worked in");
    await expect(sources.locator('[data-source="local"]')).toContainText('~/code');
    await expect(sources.locator('[data-source="github"]')).toContainText('signed in as ada');
    for (const name of ['site', 'recipe-box', 'shop', 'garden-sensors', 'notes', 'dotfiles']) await expect(tick(page, name)).toBeChecked();
    // A GitHub repo that is not cloned waits for a tick: ticking it means downloading it.
    await expect(tick(page, 'family-photos')).not.toBeChecked();
    await expect(cand(page, 'family-photos')).toContainText('GitHub · not on this computer yet · will clone to ~/code/family-photos');
    await expect(tick(page, 'old-blog')).not.toBeChecked();
    await expect(cand(page, 'old-blog')).toContainText('Archived');
    await expect(cand(page, 'tax-scripts')).toHaveCount(0); // older than 90 days: under "Show all"
    await expect(cand(page, 'shop')).toContainText('Monorepo');
    await expect(cand(page, 'shop')).toContainText('Private');
    await expect(cand(page, 'recipe-box')).toContainText('Public');
    await expect(cand(page, 'recipe-box')).toContainText('Claude Code');
    await expect(cand(page, 'recipe-box').getByTestId('imp-domain')).toHaveValue('d:work'); // default: Work
    await expect(page.getByTestId('imp-create')).toHaveText('Create 6 project agents');
    await expect(page.getByTestId('imp-group')).toHaveText('One agent for these 6');
    await shot(page, '03-import-pick-1440x900');

    // Escape closes it, and focus is back on the page.
    await page.keyboard.press('Escape');
    await expect(screen(page)).toHaveCount(0);
  });

  test('GitHub slow: "Skip GitHub this time" shows the folders on this computer at once', async ({ page }) => {
    await reset('empty');
    await mock('discover', { delay: 6000 });
    await login(page);
    await page.getByTestId('first-import-go').click();
    await page.getByTestId('imp-skip-github').click();
    await expect(screen(page)).toHaveAttribute('data-phase', 'pick', { timeout: 3000 });
    const gh = page.getByTestId('imp-sources').locator('[data-source="github"]');
    await expect(gh).toContainText("GitHub: skipped this time. Ask GitHub to see repos you haven't cloned.");
    await expect(cand(page, 'family-photos')).toHaveCount(0);
    await expect(cand(page, 'recipe-box')).toBeVisible();
  });

  test('once the folder is trusted, "Find my projects" is the one filled button on screen', async ({ page }) => {
    await reset('small'); // trusted, sessions but no pane open, and no project agent yet
    await login(page);
    await expect(page.getByTestId('first-trust')).toHaveCount(0);
    await expect(page.getByTestId('first-import-go')).toHaveClass(/btn-primary/);
    await expect(page.locator('.rail').getByTestId('new-session')).toHaveClass(/btn-quiet/);
    await expect(page.locator('.btn-primary:visible')).toHaveCount(1);
  });

  test('a repo that already has an agent is disabled and says so (default org, from the palette)', async ({ page }) => {
    await reset('default');
    await login(page);
    await expect(page.getByTestId('first-import')).toHaveCount(0); // the org has project agents
    await openFromPalette(page);
    await expect(tick(page, 'site')).toBeDisabled();
    await expect(tick(page, 'site')).not.toBeChecked();
    await expect(cand(page, 'site').getByTestId('imp-agent')).toHaveText('Already an agent: Launch the website');
    await expect(page.getByTestId('imp-create')).toHaveText('Create 5 project agents');
    await cand(page, 'site').getByTestId('imp-agent').locator('button').click();
    await expect(page).toHaveURL(/#\/agent\/site$/);
    await expect(screen(page)).toHaveCount(0);
  });

  test('search, Show all / Recent only, and Escape clears the search before it closes', async ({ page }) => {
    await reset('empty');
    await login(page);
    await openFromCard(page);
    const search = page.getByTestId('imp-search');
    await search.fill('garden');
    await expect(page.locator('.imp-row')).toHaveCount(1);
    await expect(cand(page, 'garden-sensors')).toBeVisible();
    await expect(page.getByTestId('imp-count')).toHaveText('1 match in all 11');
    await search.fill('receipts'); // descriptions count, and the search spans every project
    await expect(page.locator('.imp-row')).toHaveCount(1);
    await expect(cand(page, 'tax-scripts')).toBeVisible();
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(screen(page)).toBeVisible();
    await expect(page.getByTestId('imp-count')).toHaveText('9 projects active in the last 90 days');
    await page.getByTestId('imp-show-all').click();
    await expect(page.locator('.imp-row')).toHaveCount(11);
    await expect(page.getByTestId('imp-show-all')).toHaveText('Recent only');
    await tick(page, 'ml-course').check();
    await page.getByTestId('imp-show-all').click();
    await expect(cand(page, 'tax-scripts')).toHaveCount(0);
    await expect(cand(page, 'ml-course')).toBeVisible(); // a ticked row never hides
    await expect(page.getByTestId('imp-create')).toHaveText('Create 7 project agents');
  });

  test('CS-27: create 3 with a new domain for one: per-row progress, results, and the map shows them', async ({ page }) => {
    await reset('empty');
    await mock('discover', { importDelay: 700 });
    await login(page);
    await openFromCard(page);
    await only(page, ['recipe-box', 'garden-sensors', 'notes']);
    await expect(page.getByTestId('imp-create')).toHaveText('Create 3 project agents');
    const pick = cand(page, 'garden-sensors').getByTestId('imp-domain');
    await pick.selectOption('__new');
    const name = cand(page, 'garden-sensors').getByTestId('imp-new-domain');
    await expect(name).toBeFocused();
    await name.fill('Garden');
    await name.press('Enter');
    await expect(pick).toHaveValue('n:Garden');
    await expect(pick.locator('option:checked')).toHaveText('Garden (new)');
    // Other rows can pick the new name too.
    await expect(cand(page, 'notes').getByTestId('imp-domain').locator('option[value="n:Garden"]')).toHaveCount(1);

    await page.getByTestId('imp-create').click();
    await expect(screen(page)).toHaveAttribute('data-phase', 'running');
    await expect(page.locator('.imp-row[data-status="creating"]')).toHaveCount(1);
    await expect(page.locator('.imp-row[data-status="waiting"]')).toHaveCount(2);
    await expect(page.getByTestId('imp-progress')).toContainText('Creating 1 of 3: recipe-box');
    await expect(cand(page, 'recipe-box').getByTestId('imp-status')).toHaveText('Creating…');
    await expect(page.locator('.imp-row[data-status="created"]')).toHaveCount(1);
    await shot(page, '04-import-running-1440x900');

    await expect(page.getByTestId('imp-done-title')).toHaveText('3 project agents are ready', { timeout: 8000 });
    await expect(page.getByTestId('imp-done-title')).toBeFocused();
    for (const id of ['recipe-box', 'garden-sensors', 'notes']) {
      const r = page.locator(`[data-result="${id}"]`);
      await expect(r.getByTestId('imp-open')).toBeVisible();
      await expect(r.getByTestId('imp-onboard')).toHaveText('Deep onboard');
    }
    await expect(page.locator('[data-result="garden-sensors"]')).toContainText('in Garden');
    await expect(page.locator('.imp-onboard-note')).toContainText('Uses your Claude plan.');
    await shot(page, '05-import-results-1440x900');

    const bodies = await importBodies();
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toEqual({ path: '/Users/ada/code/recipe-box', github: 'ada/recipe-box', domain: 'work' });
    expect(bodies[1]).toEqual({ path: '/Users/ada/projects/garden-sensors', new_domain: 'Garden' });
    expect(bodies[2]).toEqual({ path: '/Users/ada/Documents/notes', domain: 'work' });

    const agents = await orgAgents();
    expect(agents.find((a) => a.id === 'garden').kind).toBe('domain');
    expect(agents.find((a) => a.id === 'garden-sensors')).toMatchObject({ kind: 'project', domain: 'garden', repo: '/Users/ada/projects/garden-sensors' });

    await page.getByTestId('imp-done').click();
    await expect(screen(page)).toHaveCount(0);
    await expect(page.getByTestId('first-import')).toHaveCount(0); // the org has project agents now
    await page.goto('/#/map');
    for (const id of ['recipe-box', 'garden-sensors', 'notes', 'garden']) await expect(page.locator(`[data-node="${id}"]`)).toHaveCount(1);
    await expect(page.locator('[data-node="garden-sensors"]')).toHaveAttribute('aria-label', /garden-sensors, Project/);
  });

  test('Deep onboard starts a session with /onboard-project', async ({ page }) => {
    await reset('empty');
    await login(page);
    await openFromCard(page);
    await only(page, ['recipe-box', 'notes']);
    await page.getByTestId('imp-create').click();
    await expect(page.getByTestId('imp-done-title')).toHaveText('2 project agents are ready');
    await page.locator('[data-result="recipe-box"]').getByTestId('imp-onboard').click();
    await expect(page.locator('[data-result="recipe-box"]').getByTestId('imp-onboard')).toHaveText('Started');
    await expect(screen(page)).toBeVisible(); // two new agents: stay, so the other can be onboarded too
    await expect.poll(async () => (await mockRequests()).find((r) => r.method === 'POST' && r.path === '/api/sessions' && r.body.agent === 'recipe-box')?.body)
      .toMatchObject({ agent: 'recipe-box', prompt: '/onboard-project', title: 'Deep onboard' });
    await page.getByTestId('imp-done').click();
    await expect(panes(page)).toHaveCount(1);
    const sid = await focusedPane(page).getAttribute('data-pane');
    expect((await sessionBySid(sid)).agent).toBe('recipe-box');
  });

  test('one new agent: Deep onboard closes the screen and lands on its session', async ({ page }) => {
    await reset('empty');
    await login(page);
    await openFromCard(page);
    await only(page, ['dotfiles']);
    await expect(page.getByTestId('imp-create')).toHaveText('Create 1 project agent');
    await expect(page.getByTestId('imp-group')).toHaveCount(0); // needs two or more
    await page.getByTestId('imp-create').click();
    await expect(page.getByTestId('imp-done-title')).toHaveText('dotfiles is ready');
    await page.locator('[data-result="dotfiles"]').getByTestId('imp-onboard').click();
    await expect(screen(page)).toHaveCount(0);
    await expect(panes(page)).toHaveCount(1);
    expect((await sessionBySid(await focusedPane(page).getAttribute('data-pane'))).agent).toBe('dotfiles');
  });

  test('a GitHub repo that is not cloned is cloned first, and "Work (new)" when the org has no Work', async ({ page }) => {
    await reset('empty');
    await api('DELETE', '/api/agents/work');
    await login(page);
    await openFromCard(page);
    await only(page, ['family-photos']);
    const pick = cand(page, 'family-photos').getByTestId('imp-domain');
    await expect(pick).toHaveValue('n:Work');
    await expect(pick.locator('option:checked')).toHaveText('Work (new)');
    await page.getByTestId('imp-create').click();
    await expect(cand(page, 'family-photos').getByTestId('imp-status')).toHaveText('Cloning…');
    await expect(page.getByTestId('imp-done-title')).toHaveText('family-photos is ready');
    await expect(page.locator('[data-result="family-photos"]')).toContainText('~/code/family-photos · cloned just now');
    const [body] = await importBodies();
    expect(body).toEqual({ clone: true, url: 'https://github.com/ada/family-photos.git', github: 'ada/family-photos', new_domain: 'Work' });
    expect((await orgAgents()).find((a) => a.id === 'work')).toMatchObject({ kind: 'domain', name: 'Work' });
  });

  test('a clone goes to clone_root, and the result shows the folder it really got (<name>-2)', async ({ page }) => {
    await reset('empty');
    // The server's clone root is ~/src here, and ~/src/family-photos already holds something else.
    await mock('discover', { cloneRoot: '/Users/ada/src', cloneTaken: ['family-photos'] });
    await login(page);
    await openFromCard(page);
    await expect(cand(page, 'family-photos')).toContainText('GitHub · not on this computer yet · will clone to ~/src/family-photos');
    await only(page, ['family-photos']);
    await page.getByTestId('imp-create').click();
    await expect(page.getByTestId('imp-done-title')).toHaveText('family-photos is ready');
    await expect(page.locator('[data-result="family-photos"]').getByTestId('imp-result-repo')).toHaveText('~/src/family-photos-2');
    await expect(page.locator('[data-result="family-photos"]')).toContainText('~/src/family-photos-2 · cloned just now');
    expect((await orgAgents()).find((a) => a.id === 'family-photos')).toMatchObject({ repo: '/Users/ada/src/family-photos-2' });
  });

  test('gh not installed: folders on this computer only, with what to do', async ({ page }) => {
    await reset('empty');
    await mock('discover', { gh: 'missing' });
    await login(page);
    await openFromCard(page);
    const gh = page.getByTestId('imp-sources').locator('[data-source="github"]');
    await expect(gh).toHaveAttribute('data-gh', 'warn');
    await expect(gh).toContainText('GitHub: not connected. Install GitHub CLI and run gh auth login to see repos you haven\'t cloned. Showing folders on this computer.');
    await expect(gh.locator('a')).toHaveAttribute('href', 'https://cli.github.com');
    await expect(cand(page, 'family-photos')).toHaveCount(0);
    await expect(cand(page, 'ada.github.io')).toHaveCount(0);
    await expect(cand(page, 'recipe-box')).toBeVisible();
    await expect(cand(page, 'recipe-box')).not.toContainText('Public'); // unknown without gh
    await expect(page.locator('.imp-row', { hasText: 'not on this computer' })).toHaveCount(0);
    await shot(page, '06-import-no-gh-1440x900');

    // Signed out is a different fix.
    await mock('discover', { gh: 'unauthed' });
    await page.getByTestId('imp-refresh').click();
    await expect(gh).toContainText('GitHub CLI is installed but not signed in. Run gh auth login in a terminal');
  });

  test('a failed row says why and can be tried again', async ({ page }) => {
    await reset('empty');
    await mock('discover', { failImport: { name: 'recipe-box', times: 1 }, importDelay: 900 });
    await login(page);
    await openFromCard(page);
    await only(page, ['recipe-box', 'notes']);
    await page.getByTestId('imp-create').click();
    await expect(cand(page, 'recipe-box').getByTestId('imp-status')).toHaveText("Didn't work");
    await expect(cand(page, 'recipe-box').locator('.imp-row-error')).toContainText('the connection timed out');
    await expect(page.getByTestId('imp-done-title')).toHaveText("1 project agent is ready, 1 didn't work");
    const failed = page.locator('[data-failed="recipe-box"]');
    await expect(failed.getByTestId('imp-error')).toContainText("Couldn't reach GitHub for recipe-box: the connection timed out.");
    await shot(page, '07-import-failed-row-1440x900');
    await failed.getByTestId('imp-retry').click();
    await expect(page.locator('[data-failed]')).toHaveCount(0);
    await expect(page.locator('[data-result="recipe-box"]')).toBeVisible();
    await expect(page.getByTestId('imp-done-title')).toHaveText('2 project agents are ready');
    expect((await importBodies()).filter((b) => b.path === '/Users/ada/code/recipe-box')).toHaveLength(2);
  });

  test('"One agent for these N" makes one agent for several repos', async ({ page }) => {
    await reset('empty');
    await login(page);
    await openFromCard(page);
    await only(page, ['site', 'shop', 'recipe-box']);
    await page.getByTestId('imp-group').click();
    const form = page.getByTestId('imp-group-form');
    await expect(form).toContainText('One agent for 3 projects.');
    await expect(form.getByTestId('imp-group-name')).toBeFocused();
    await expect(form.getByTestId('imp-group-create')).toBeDisabled();
    await form.getByTestId('imp-group-name').press('Escape'); // back, not closed
    await expect(form).toHaveCount(0);
    await expect(screen(page)).toBeVisible();
    await page.getByTestId('imp-group').click();
    await form.getByTestId('imp-group-name').fill('Online shop');
    await shot(page, '08-import-group-1440x900');
    await form.getByTestId('imp-group-create').click();
    await expect(page.getByTestId('imp-done-title')).toHaveText('Online shop is ready');
    await expect(page.locator('[data-result]')).toHaveCount(1);
    const bodies = await importBodies();
    expect(bodies).toEqual([{ group: { name: 'Online shop', domain: 'work' }, items: [{ path: '/Users/ada/code/site' }, { path: '/Users/ada/code/recipe-box' }, { path: '/Users/ada/code/shop' }] }]);
    const made = (await orgAgents()).filter((a) => a.kind === 'project');
    expect(made).toHaveLength(1);
    expect(made[0].repos).toHaveLength(3);
  });

  test('"One agent" is off while a ticked repo is not on this computer', async ({ page }) => {
    await reset('empty');
    await login(page);
    await openFromCard(page);
    await only(page, ['notes', 'family-photos']);
    await expect(page.getByTestId('imp-group')).toBeDisabled();
    await expect(page.getByTestId('imp-group')).toHaveAttribute('title', 'Works only when every ticked project is already on this computer');
  });

  test('"One agent" for repos that all became agents meanwhile: "Already in your org", no Try again (an older server\'s 409 too)', async ({ page }) => {
    await reset('empty');
    await login(page);
    await openFromCard(page);
    await only(page, ['recipe-box', 'garden-sensors']);
    // Both become agents somewhere else, and this browser is not told (no org event).
    await mock('discover', { quiet: true });
    await api('POST', '/api/import', { path: '/Users/ada/code/recipe-box', domain: 'work' });
    await api('POST', '/api/import', { path: '/Users/ada/projects/garden-sensors', domain: 'work' });
    await page.getByTestId('imp-group').click();
    await page.getByTestId('imp-group-name').fill('Kitchen');
    await page.getByTestId('imp-group-create').click();
    await expect(page.getByTestId('imp-done-title')).toHaveText('Already in your org');
    await expect(page.getByTestId('imp-retry')).toHaveCount(0);
    await expect(page.locator('[data-failed]')).toHaveCount(0);
    for (const id of ['recipe-box', 'garden-sensors']) await expect(page.locator(`[data-result="${id}"]`)).toContainText('Nothing new was made.');
    expect((await orgAgents()).filter((a) => a.kind === 'project').map((a) => a.id).sort()).toEqual(['garden-sensors', 'recipe-box']); // nothing new
    await shot(page, '14-import-group-already-in-org-1440x900');

    // A server from before this change answered 409: the same result, from the live org.
    await mock('discover', { legacyGroup409: true });
    await page.getByTestId('imp-again').click();
    await expect(screen(page)).toHaveAttribute('data-phase', 'pick');
    await expect(tick(page, 'recipe-box')).toBeDisabled();
    await only(page, ['site', 'shop']);
    await api('POST', '/api/import', { path: '/Users/ada/code/site', domain: 'work' });
    await api('POST', '/api/import', { path: '/Users/ada/code/shop', domain: 'work' });
    await page.getByTestId('imp-group').click();
    await page.getByTestId('imp-group-name').fill('Web');
    await page.getByTestId('imp-group-create').click();
    await expect(page.getByTestId('imp-done-title')).toHaveText('Already in your org');
    await expect(page.getByTestId('imp-retry')).toHaveCount(0);
    for (const id of ['site', 'shop']) await expect(page.locator(`[data-result="${id}"]`)).toContainText('Already an agent');
    expect((await importBodies()).filter((b) => b.group)).toHaveLength(2);
  });

  test('a repo that becomes an agent elsewhere while the screen is open is unticked and says so', async ({ page }) => {
    await reset('empty');
    await login(page);
    await openFromCard(page);
    await expect(tick(page, 'recipe-box')).toBeChecked();
    await expect(page.getByTestId('imp-create')).toHaveText('Create 6 project agents');
    // By its folder.
    await api('POST', '/api/import', { path: '/Users/ada/code/recipe-box', domain: 'work' });
    await expect(tick(page, 'recipe-box')).not.toBeChecked();
    await expect(tick(page, 'recipe-box')).toBeDisabled();
    await expect(cand(page, 'recipe-box').getByTestId('imp-agent')).toHaveText('Already an agent: recipe-box');
    await expect(page.getByTestId('imp-create')).toHaveText('Create 5 project agents');
    // By its remote: a GitHub repo cloned and imported elsewhere, though this row has no folder.
    await tick(page, 'family-photos').check();
    await expect(page.getByTestId('imp-create')).toHaveText('Create 6 project agents');
    await api('POST', '/api/import', { clone: true, github: 'ada/family-photos', url: 'https://github.com/ada/family-photos.git', domain: 'work' });
    await expect(tick(page, 'family-photos')).not.toBeChecked();
    await expect(tick(page, 'family-photos')).toBeDisabled();
    await expect(cand(page, 'family-photos').getByTestId('imp-agent')).toHaveText('Already an agent: family-photos');
    // As one of a group's repos.
    await api('POST', '/api/import', { group: { name: 'Shop and site', domain: 'work' }, items: [{ path: '/Users/ada/code/site' }, { path: '/Users/ada/code/shop' }] });
    for (const name of ['site', 'shop']) {
      await expect(tick(page, name)).not.toBeChecked();
      await expect(cand(page, name).getByTestId('imp-agent')).toHaveText('Already an agent: Shop and site');
    }
    await expect(page.getByTestId('imp-create')).toHaveText('Create 3 project agents');
    await shot(page, '15-import-live-already-an-agent-1440x900');
    await page.getByTestId('imp-create').click();
    await expect(page.getByTestId('imp-done-title')).toHaveText('3 project agents are ready');
    // The cockpit made only the three still ticked.
    expect((await importBodies()).slice(-3).map((b) => b.path)).toEqual(['/Users/ada/projects/garden-sensors', '/Users/ada/Documents/notes', '/Users/ada/code/dotfiles']);
  });

  test('New agent → "From a repo" opens the import screen', async ({ page }) => {
    await reset('default');
    await login(page);
    await page.getByTestId('new-agent').click();
    const card = page.getByTestId('wz-from-repo');
    await expect(card).toContainText('From a repo');
    await shot(page, '09-wizard-from-a-repo-1440x900');
    await card.click();
    await expect(screen(page)).toHaveAttribute('data-phase', 'pick');
    await expect(page.locator('.wizard')).toHaveCount(0);
  });

  test('the card can be hidden for good; the org map offers it while there are no projects', async ({ page }) => {
    await reset('empty');
    await login(page, '#/map');
    await expect(page.getByTestId('map-import-hint')).toContainText('No project agents yet.');
    // The map fits the org above the hint: no node or label sits under it, wide or narrow.
    for (const size of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(600); // the fit animates
      const hint = await page.getByTestId('map-import-hint').boundingBox();
      for (const el of await page.locator('[data-node] .node-disc, [data-node] .node-label').all()) {
        const b = await el.boundingBox();
        expect(b.y + b.height <= hint.y || b.x + b.width <= hint.x || b.x >= hint.x + hint.width, `${size.width}px: a node under the hint`).toBe(true);
      }
    }
    await page.getByTestId('map-import-go').click();
    await expect(screen(page)).toHaveAttribute('data-phase', 'pick');
    await page.keyboard.press('Escape');
    await page.goto('/#/');
    await page.getByTestId('first-import-dismiss').click();
    await expect(page.getByTestId('first-import')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('first-import')).toHaveCount(0);
    await page.goto('/#/map');
    await expect(page.getByTestId('org-map')).toBeVisible();
    await expect(page.getByTestId('map-import-hint')).toHaveCount(0);
  });
});

test.describe('your Claude Code setup', () => {
  test('CS-28: Settings lists names only, collapses long lists, and promotes a subagent', async ({ page }) => {
    await reset('default');
    await login(page, '#/settings/setup');
    const card = page.getByTestId('setup-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Every agent session loads these, because Claude Code loads them in every session.');
    await expect(page.getByTestId('setup-claude-md')).toContainText('Prefer small pull requests');
    const skills = card.locator('[data-setup="skills"]');
    await expect(skills.locator('.setup-item')).toHaveCount(6);
    await expect(skills.getByTestId('setup-more')).toHaveText('Show all 9');
    await skills.getByTestId('setup-more').click();
    await expect(skills.locator('.setup-item')).toHaveCount(9);
    await expect(card.locator('[data-setup="mcp"]')).toContainText('github');
    await expect(card.locator('[data-setup="mcp"]')).toContainText('in every project');
    // Hooks count every hook (2 + 1 + 1), listed per event, like the map chip.
    await expect(card.locator('[data-setup="hooks"] .sec-count')).toHaveText('4');
    await expect(card.locator('[data-setup="hooks"] .setup-item[data-item="PreToolUse"] .setup-name')).toHaveText('PreToolUse (2)');
    await expect(card.locator('[data-setup="hooks"] .setup-item[data-item="PreToolUse"] .setup-desc')).toHaveText('Runs before Claude uses a tool');
    await expect(card.locator('[data-setup="hooks"] .setup-item[data-item="Stop"]')).toContainText('Stop (1)');
    await expect(card.locator('[data-setup="commands"]')).toContainText('/git:sync');
    await expect(card.locator('[data-setup="plugins"]')).toContainText('Off');
    await expect(card.locator('[data-project="site"]')).toContainText('copy-editor');
    await expect(card.locator('[data-project="site"]')).toContainText('figma');
    await expect(page.getByTestId('setup-privacy')).toHaveText('Names and descriptions only. Clawdling never reads MCP keys or environment values or hook commands, and nothing here leaves your computer.');
    await shot(page, '10-settings-setup-card-1440x900');
    // The page scrolls inside its own layer: a tall window shows the whole card in one picture.
    await page.setViewportSize({ width: 1440, height: 2600 });
    await card.screenshot({ path: path.join(DIR, '10b-settings-setup-card-whole-1440w.png') });
    await page.setViewportSize({ width: 1440, height: 900 });

    const sub = card.locator('[data-setup="agents"] .setup-item[data-item="code-reviewer"]');
    await sub.getByTestId('setup-promote').click();
    await expect(sub.getByTestId('setup-made')).toContainText('Standing agent: Code reviewer');
    const toast = page.locator('.toast', { hasText: 'Code reviewer is now a standing agent' });
    await expect(toast).toBeVisible();
    const promotes = async () => (await mockRequests()).filter((r) => r.method === 'POST' && r.path === '/api/setup/promote').map((r) => r.body);
    expect(await promotes()).toEqual([{ scope: 'user', name: 'code-reviewer' }]);
    expect((await orgAgents()).find((a) => a.id === 'code-reviewer')).toMatchObject({ kind: 'domain', name: 'Code reviewer', source: { subagent: 'code-reviewer', subagent_scope: 'user' } });
    await toast.getByTestId('toast-action').click();
    await expect(page).toHaveURL(/#\/agent\/code-reviewer$/);
    await expect(page.getByTestId('agent-page')).toBeVisible();

    // A subagent called "health" was never made into the built-in Health domain: the id is taken
    // by another agent, so it says so and offers another name (sent as `as`).
    await page.goto('/#/settings/setup');
    const health = page.getByTestId('setup-card').locator('[data-setup="agents"] .setup-item[data-item="health"]');
    await expect(health.getByTestId('setup-made')).toHaveCount(0);
    await expect(health.getByTestId('setup-promote')).toHaveCount(0);
    await expect(health.getByTestId('setup-taken')).toContainText('An agent called Health already exists.');
    await health.getByTestId('setup-rename').click();
    const as = health.getByTestId('setup-as');
    await expect(as).toBeFocused();
    await as.fill('work'); // taken too: says so and sends nothing
    await as.press('Enter');
    await expect(health.locator('.form-error')).toHaveText('An agent called "Work" already exists. Try another name.');
    await as.fill('Health coach');
    await page.getByTestId('setup-card').locator('[data-setup="agents"]').screenshot({ path: path.join(DIR, '10c-settings-subagent-name-taken-1440x900.png') });
    await health.getByTestId('setup-as-submit').click();
    await expect(health.getByTestId('setup-made')).toContainText('Standing agent: Health coach');
    expect(await promotes()).toEqual([{ scope: 'user', name: 'code-reviewer' }, { scope: 'user', name: 'health', as: 'Health coach' }]);
    expect((await orgAgents()).find((a) => a.id === 'health-coach')).toMatchObject({ kind: 'domain', name: 'Health coach', source: { subagent: 'health', subagent_scope: 'user' } });
    // After a reload each says which agent was made from it: by its source, not by its name.
    await page.reload();
    const subs = page.getByTestId('setup-card').locator('[data-setup="agents"]');
    await expect(subs.locator('.setup-item[data-item="health"]').getByTestId('setup-made')).toContainText('Standing agent: Health coach');
    await expect(subs.locator('.setup-item[data-item="code-reviewer"]').getByTestId('setup-made')).toContainText('Standing agent: Code reviewer');
    await expect(subs.locator('.setup-item[data-item="test-writer"]').getByTestId('setup-promote')).toBeVisible();
  });

  test('the org map layer: a halo of chips around you, project badges, and a chip opens its list', async ({ page }) => {
    await reset('default');
    await login(page, '#/map');
    const toggle = page.getByTestId('map-setup-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('setup-halo')).toHaveCount(0); // off: the map is unchanged
    await expect(page.locator('[data-setup-badge]')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const halo = page.getByTestId('setup-halo');
    await expect(halo).toContainText('Loaded in every session');
    for (const [k, text] of [['skills', 'Skills 9'], ['agents', 'Subagents 4'], ['mcp', 'MCP 3'], ['hooks', 'Hooks 4']]) {
      await expect(halo.locator(`[data-chip="${k}"]`)).toHaveText(text);
    }
    await expect(page.locator('[data-node="site"] [data-setup-badge]')).toHaveCount(1);
    await expect(page.locator('[data-node="shop"]')).toHaveCount(0);
    // A project imported while the layer is on: the layer reads the setup again and badges it.
    await api('POST', '/api/import', { path: '/Users/ada/code/shop', domain: 'work' });
    await expect(page.locator('[data-node="shop"] [data-setup-badge]')).toHaveCount(1);
    await expect(page.locator('[data-node="marathon"] [data-setup-badge]')).toHaveCount(0); // no repo
    await expect(page.locator('[data-node="site"]')).toHaveAttribute('aria-label', /its repo adds its own Claude Code setup/);

    // No chip sits on the line from you up to Donna, and none covers your label.
    const clear = await page.evaluate(() => {
      const edge = document.querySelector('.edge-core').getBBox();
      const label = document.querySelector('[data-node="__owner"] .node-label').getBBox();
      const owner = document.querySelector('[data-node="__owner"]').transform.baseVal.consolidate().matrix;
      return [...document.querySelectorAll('.setup-chip')].every((chip) => {
        const m = chip.transform.baseVal.consolidate().matrix;
        const b = chip.querySelector('rect').getBBox();
        const x0 = b.x + m.e; const x1 = x0 + b.width; const y0 = b.y + m.f; const y1 = y0 + b.height;
        const hitsEdge = x0 <= edge.x + edge.width && x1 >= edge.x && y1 >= edge.y && y0 <= edge.y + edge.height;
        const lx0 = label.x + owner.e; const ly0 = label.y + owner.f;
        const hitsLabel = x0 <= lx0 + label.width && x1 >= lx0 && y1 >= ly0 && y0 <= ly0 + label.height;
        return !hitsEdge && !hitsLabel;
      });
    });
    expect(clear).toBe(true);
    await shot(page, '11-org-map-setup-layer-1440x900');

    await halo.locator('[data-chip="skills"]').click();
    const panel = page.getByTestId('map-panel');
    await expect(panel).toHaveAttribute('data-setup-panel', 'skills');
    await expect(panel.locator('.panel-title')).toHaveText('Skills');
    await expect(panel).toContainText('Loaded in every session');
    await expect(panel).toContainText('deploy');
    await expect(panel).toContainText('Ship the current branch to staging');
    await shot(page, '12-org-map-chip-panel-1440x900');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    // Keyboard: chips are buttons.
    await halo.locator('[data-chip="mcp"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('map-panel')).toContainText('postgres');
    // The hooks chip's panel counts hooks the way the chip does.
    await halo.locator('[data-chip="hooks"]').click();
    await expect(page.getByTestId('map-panel')).toHaveAttribute('data-setup-panel', 'hooks');
    await expect(page.getByTestId('map-panel').locator('.panel-text')).toHaveText('4 hooks from your own Claude Code setup. Claude Code loads them in every session, so every agent has them.');
    await expect(page.getByTestId('map-panel')).toContainText('PreToolUse (2)');

    // A project's panel gains "Its repo adds".
    await page.locator('[data-node="shop"]').click();
    const adds = page.getByTestId('panel-repo-adds');
    await expect(adds).toContainText('Its repo adds');
    await expect(adds).toContainText('db-migrator');
    await expect(adds).toContainText('stripe');
    await expect(adds).toContainText('AGENTS.md');
    await expect(adds).not.toContainText('No repo linked');
    await shot(page, '13-org-map-project-repo-adds-1440x900');
    // "No repo linked" only for a project with no repo; a repo that adds nothing says that.
    await page.locator('[data-node="marathon"]').click();
    await expect(page.getByTestId('panel-repo-adds')).toContainText('No repo linked, so nothing extra.');
    await api('POST', '/api/import', { path: '/Users/ada/code/recipe-box', domain: 'work' });
    await page.locator('[data-node="recipe-box"]').click();
    await expect(page.getByTestId('panel-repo-adds')).toContainText('Nothing beyond your own setup.');
    await expect(page.locator('[data-node="recipe-box"] [data-setup-badge]')).toHaveCount(0);

    // Remembered in this browser; off again puts the map back.
    await page.reload();
    await expect(page.getByTestId('map-setup-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('setup-halo')).toBeVisible();
    await page.getByTestId('map-setup-toggle').click();
    await expect(page.getByTestId('setup-halo')).toHaveCount(0);
    await expect(page.locator('[data-setup-badge]')).toHaveCount(0);
  });
});

test.describe('light theme', () => {
  test('the import screen and the map layer read in light mode too', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    await reset('empty');
    await login(page);
    await openFromCard(page);
    await shot(page, '30-light-import-pick-1440x900');
    await page.keyboard.press('Escape');
    await page.goto('/#/settings/setup');
    await expect(page.getByTestId('setup-card')).toContainText('Skills');
    await shot(page, '31-light-settings-setup-1440x900');
    await reset('default');
    await page.goto('/#/map');
    const toggle = page.getByTestId('map-setup-toggle');
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    await expect(page.getByTestId('setup-halo')).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, '32-light-org-map-setup-layer-1440x900');
    await ctx.close();
  });
});

test.describe('phone (390x844)', () => {
  test('the import screen fits a phone: rows stack, nothing scrolls sideways', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await reset('empty');
    await login(page);
    await expect(page.getByTestId('first-import')).toBeVisible(); // in the phone's list view
    await shot(page, '20-phone-list-first-run-390x844');
    await page.getByTestId('first-import-go').tap();
    await expect(screen(page)).toHaveAttribute('data-phase', 'pick');
    expect(await scrollWidth(page)).toBe(390);
    const row = cand(page, 'shop');
    const boxTop = (await row.getByTestId('imp-check').boundingBox()).y;
    const pick = await row.getByTestId('imp-domain').boundingBox();
    expect(pick.y).toBeGreaterThan(boxTop + 20); // the domain picker sits under the name, not beside it
    expect(pick.x + pick.width).toBeLessThanOrEqual(390);
    // Nothing in the dialog is wider than the dialog.
    const over = await page.evaluate(() => {
      const d = document.querySelector('.import-screen').getBoundingClientRect();
      return [...document.querySelectorAll('.import-screen *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > d.right + 1 || r.left < d.left - 1);
      }).map((el) => String(el.className || el.tagName)).slice(0, 5);
    });
    expect(over).toEqual([]);
    await shot(page, '21-phone-import-pick-390x844');
    await only(page, ['recipe-box', 'notes']);
    await page.getByTestId('imp-create').tap();
    await expect(page.getByTestId('imp-done-title')).toHaveText('2 project agents are ready');
    expect(await scrollWidth(page)).toBe(390);
    await shot(page, '22-phone-import-results-390x844');
    await ctx.close();
  });
});
