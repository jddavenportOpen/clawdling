// Org map, agent page, new-agent wizard, Donna page.
import { test, expect } from '@playwright/test';
import { login, reset, api, isMock, mockRequests, spawn, panes, focusedPane, sessionBySid } from './helpers.js';

async function orgAgents() {
  const r = await api('GET', '/api/org');
  return r.agents || [];
}

test.describe('org map', () => {
  test('renders every agent and a node click opens its panel', async ({ page }) => {
    await reset('default');
    const agents = await orgAgents();
    await login(page, '#/map');
    await expect(page.getByTestId('org-map')).toBeVisible();
    for (const a of agents) await expect(page.locator(`[data-node="${a.id}"]`)).toHaveCount(1);
    await expect(page.locator('[data-node="__owner"]')).toHaveCount(1);

    const health = agents.find((a) => a.id === 'health');
    await page.locator('[data-node="health"]').click();
    const panel = page.getByTestId('map-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.panel-title')).toHaveText(health.name);
    if (health.mission) await expect(panel).toContainText(health.mission);
    await expect(panel.locator('.panel-now, .panel-quiet').first()).toBeVisible(); // NOW.md preview (or its empty state)

    // Open agent page from the panel.
    await panel.getByTestId('panel-open-agent').click();
    await expect(page).toHaveURL(/#\/agent\/health$/);
    await expect(page.getByTestId('agent-page')).toBeVisible();
  });

  test('New session from the map panel lands focused in the cockpit', async ({ page }) => {
    await reset('empty');
    await login(page, '#/map');
    await page.locator('[data-node="money"]').click();
    await page.getByTestId('panel-new-session').click();
    await expect(page.locator('.page-layer')).toHaveCount(0);
    await expect(panes(page)).toHaveCount(1);
    const sid = await focusedPane(page).getAttribute('data-pane');
    expect((await sessionBySid(sid)).agent).toBe('money');
  });

  test('keyboard: nodes are reachable and Enter opens the panel', async ({ page }) => {
    await reset('default');
    await login(page, '#/map');
    await page.locator('[data-node="work"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('map-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('map-panel')).toHaveCount(0);
  });
});

test.describe('agent page', () => {
  test('edits NOW.md and saves it with PUT /context', async ({ page }) => {
    await reset('default');
    await login(page, '#/agent/health/memory');
    const editor = page.getByTestId('editor-now_md');
    await expect(editor).toBeVisible();
    const stamp = `- E2E note ${Date.now()}`;
    const before = await editor.inputValue();
    await editor.fill(`${before.trim()}\n${stamp}\n`);
    await expect(page.getByTestId('save-now_md')).toBeEnabled();
    await page.getByTestId('save-now_md').click();
    await expect(page.locator('.editor-state')).toContainText('Saved');
    const detail = await api('GET', '/api/agents/health');
    expect((detail.agent || detail).now_md).toContain(stamp);
    if (isMock()) {
      const put = (await mockRequests()).find((r) => r.method === 'PUT' && r.path === '/api/agents/health/context');
      expect(put, 'PUT /api/agents/health/context recorded').toBeTruthy();
      expect(put.body.now_md).toContain(stamp);
      expect(put.body.claude_md).toBeUndefined(); // only the edited file is sent
    }
  });

  test('Context tab edits CLAUDE.md with Cmd/Ctrl+S', async ({ page }) => {
    await reset('default');
    await login(page, '#/agent/work/context');
    const editor = page.getByTestId('editor-claude_md');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await page.keyboard.type('\n- Prefer short status updates.');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect(page.locator('.editor-state')).toContainText('Saved');
    const detail = await api('GET', '/api/agents/work');
    expect((detail.agent || detail).claude_md).toContain('Prefer short status updates.');
  });

  test('shows live and recent sessions; Resume brings one back', async ({ page }) => {
    await reset('empty');
    const ended = await spawn({ agent: 'home', title: 'Book the plumber', status: 'ended' });
    await spawn({ agent: 'home', title: 'Plan the move', status: 'working' });
    await login(page, '#/agent/home');
    await expect(page.locator('.srow')).toHaveCount(2);
    await page.locator(`.srow[data-sid="${ended}"]`).getByTestId('agent-resume').click();
    await expect(page.locator('.page-layer')).toHaveCount(0);
    await expect(focusedPane(page)).toHaveAttribute('data-pane', ended);
  });
});

test.describe('new agent wizard', () => {
  test('creates a project agent and offers a first session', async ({ page }) => {
    await reset('empty');
    await login(page);
    const name = isMock() ? 'Kitchen remodel' : `Kitchen remodel ${Date.now().toString(36).slice(-4)}`;
    await page.getByTestId('new-agent').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('[data-kind="project"]').click();
    await dialog.getByTestId('wz-name').fill(name);
    await dialog.getByTestId('wz-next').click();
    await dialog.getByTestId('wz-mission').fill('Finish the kitchen by March without going over budget.');
    await dialog.getByTestId('wz-next').click();
    await dialog.getByTestId('wz-repo').fill('/tmp/kitchen');
    await dialog.getByTestId('wz-domain').selectOption('home');
    await dialog.getByTestId('wz-next').click();
    await expect(dialog).toContainText(`${name} is ready`);

    const created = (await orgAgents()).find((a) => a.name === name);
    expect(created, 'agent shows up in /api/org').toBeTruthy();
    expect(created.kind).toBe('project');
    expect(created.domain).toBe('home');
    if (isMock()) {
      const post = (await mockRequests()).find((r) => r.method === 'POST' && r.path === '/api/agents');
      expect(post.body).toMatchObject({ kind: 'project', name, mission: 'Finish the kitchen by March without going over budget.', repo: '/tmp/kitchen', domain: 'home' });
    }
    await expect(page.locator(`.rail [data-agent="${created.id}"]`)).toBeVisible();

    // "Start a session to flesh this out" spawns it with the interview prompt.
    await dialog.getByTestId('wz-flesh').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(panes(page)).toHaveCount(1);
    const sid = await focusedPane(page).getAttribute('data-pane');
    expect((await sessionBySid(sid)).agent).toBe(created.id);
    if (isMock()) {
      const spawnReq = (await mockRequests()).find((r) => r.method === 'POST' && r.path === '/api/sessions' && r.body.agent === created.id);
      expect(spawnReq.body.prompt).toMatch(/interview me/i);
      expect(spawnReq.body.prompt).toMatch(/CLAUDE\.md/);
    }
  });

  test('domain path has three steps and validates', async ({ page }) => {
    await reset('empty');
    await login(page);
    await page.getByTestId('new-agent').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('[data-kind="domain"]').click();
    await expect(dialog.getByTestId('wz-next')).toBeDisabled();
    await dialog.getByTestId('wz-name').fill('Fitness');
    await dialog.getByTestId('wz-name').press('Enter');
    await expect(dialog.getByTestId('wz-mission')).toBeFocused();
    await expect(dialog.getByTestId('wz-next')).toHaveText(/Create domain/);
    await dialog.getByTestId('wz-mission').fill('Get stronger without getting hurt.');
    await dialog.getByTestId('wz-next').click();
    await expect(dialog).toContainText('Fitness is ready');
  });
});

test.describe('donna page', () => {
  test.skip(() => !isMock() && !process.env.CLAWDLING_E2E_ALLOW_CHANNELS, 'real server: would store a bot token; opt in with CLAWDLING_E2E_ALLOW_CHANNELS=1 and a stub TELEGRAM_API_BASE');

  test('connecting a Telegram bot shows a pairing code', async ({ page }) => {
    await reset('default');
    await login(page, '#/donna');
    await expect(page.getByTestId('telegram-card')).toContainText('Not set up');
    await expect(page.getByTestId('telegram-card')).toContainText('@BotFather');
    await page.getByTestId('tg-token').fill('123456789:AAFakeTokenForTests');
    await page.getByTestId('tg-connect').click();
    const code = page.getByTestId('pairing-code');
    await expect(code).toBeVisible();
    await expect(code.locator('.pair-digits')).toHaveText(/^\d{6}$/);
    await expect(page.getByTestId('telegram-card')).toContainText('Waiting for /pair');
    if (isMock()) {
      const post = (await mockRequests()).find((r) => r.method === 'POST' && r.path === '/api/channels/telegram');
      expect(post.body.token).toBe('123456789:AAFakeTokenForTests');
    }
    // the token never stays on screen
    await expect(page.getByTestId('tg-token')).toHaveValue('');
  });

  test('channel events appear live and Donna\'s session is one click away', async ({ page }) => {
    test.skip(!isMock(), 'needs the mock to inject a channel event');
    await reset('default');
    await login(page, '#/donna');
    await fetch(new URL('/__mock/channel', process.env.CLAWDLING_E2E_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'telegram', direction: 'in', text: 'Book a dentist for next week' }) });
    await expect(page.locator('.chan-log')).toContainText('Book a dentist for next week');
    await page.getByTestId('donna-session').click();
    await expect(page.locator('.page-layer')).toHaveCount(0);
    const sid = await focusedPane(page).getAttribute('data-pane');
    expect((await sessionBySid(sid)).agent).toBe('donna');
  });
});
