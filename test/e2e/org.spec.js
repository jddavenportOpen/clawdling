// Org map, agent page, new-agent wizard, Donna page.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { login, reset, api, isMock, mockRequests, spawn, panes, focusedPane, sessionBySid, tag, sessions, mock, health } from './helpers.js';

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

  test('"need you" is one honest number everywhere: amber = Claude asked, green = your turn', async ({ page }) => {
    await reset('default');
    await login(page, '#/map');
    await expect(page.locator('[data-node]').first()).toBeVisible();
    const all = await sessions();
    const blocked = all.filter((x) => x.status === 'needs_you');
    const turn = all.filter((x) => x.status === 'ready' && x.last_message); // finished a turn, waiting for your reply
    const waiting = [...blocked, ...turn];
    // The rail shows a count only when something needs you.
    if (waiting.length) await expect(page.locator('#sec-needs .sec-count')).toHaveText(String(waiting.length));
    else await expect(page.locator('#sec-needs .sec-count')).toHaveCount(0);
    if (waiting.length) await expect(page.locator('.map-page .page-sub')).toContainText(`${waiting.length} need you`);
    else await expect(page.locator('.map-page .page-sub')).not.toContainText('need you');
    const agentsBlocked = new Set(blocked.map((x) => x.agent));
    const agentsTurn = new Set(turn.map((x) => x.agent).filter((a) => !agentsBlocked.has(a)));
    for (const a of await orgAgents()) {
      await expect(page.locator(`[data-node="${a.id}"] .needs-ring`)).toHaveCount(agentsBlocked.has(a.id) ? 1 : 0);
      await expect(page.locator(`[data-node="${a.id}"] .ready-ring`)).toHaveCount(agentsTurn.has(a.id) ? 1 : 0);
    }
    if (isMock()) {
      // Home's "your turn" session is green on the map, as in the rail; Work's amber badge counts
      // the one session that needs you, not its two live ones (P1-5).
      await expect(page.locator('[data-node="home"]')).toHaveClass(/tone-ready/);
      await expect(page.locator('[data-node="work"]')).toHaveClass(/tone-needs/);
      await expect(page.locator('[data-node="work"] .badge-g text')).toHaveText('1');
      await expect(page.locator('.rail [data-agent="work"] [data-badge="needs"]')).toHaveText('1');
      await expect(page.locator('.legend')).toContainText('Your turn');
    }
  });

  test('a session you just opened adds nothing to "need you"', async ({ page }) => {
    await reset('default');
    await login(page);
    const count = page.locator('#sec-needs .sec-count');
    const needs = async () => ((await count.count()) ? (await count.textContent()).trim() : '0');
    const before = await needs();
    await page.locator('.rail [data-agent="money"] button.row').click();
    await expect(focusedPane(page)).toHaveCount(1);
    const sid = await focusedPane(page).getAttribute('data-pane');
    await expect.poll(async () => (await sessionBySid(sid))?.status).toBe('ready');
    const row = page.locator(`.rail .row-wrap[data-sid="${sid}"]`);
    await expect(row).toHaveAttribute('data-section', 'live');
    await expect(row).toContainText('Ready for your first message');
    await expect.poll(needs).toBe(before);
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

  test('the NOW.md editor keeps text typed in its first frame', async ({ page }) => {
    await reset('default');
    const original = (await api('GET', '/api/agents/health')).now_md;
    await login(page, '#/agent/health/memory');
    const editor = page.getByTestId('editor-now_md');
    await editor.waitFor({ state: 'attached' });
    await editor.focus(); // type at once: no waiting for the value to settle
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await page.keyboard.type('\n- typed in the first frame');
    await page.getByTestId('save-now_md').click();
    await expect(page.locator('.editor-state')).toContainText('Saved');
    const saved = (await api('GET', '/api/agents/health')).now_md;
    expect(saved).toContain('- typed in the first frame');
    expect(saved.startsWith(original.trimEnd())).toBe(true); // typed after the file, not into an empty frame
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
    const live = await spawn({ agent: 'home', title: 'Plan the move', status: 'working' });
    await login(page, '#/agent/home');
    await expect(page.locator(`.srow[data-sid="${live}"]`)).toBeVisible();
    await expect(page.locator(`.srow[data-sid="${ended}"]`)).toContainText('Ended');
    await page.locator(`.srow[data-sid="${ended}"]`).getByTestId('agent-resume').click();
    await expect(page.locator('.page-layer')).toHaveCount(0);
    await expect(focusedPane(page)).toHaveAttribute('data-pane', ended);
  });

  test('says what the agent may do without asking: "Ask before editing files" unless set otherwise (1.1.1)', async ({ page }) => {
    await reset('empty');
    await login(page, '#/agent/home');
    await expect(page.getByTestId('agent-permissions')).toHaveText('Permissions: Ask before editing files');
  });
});

test.describe('new agent wizard', () => {
  test('creates a project agent and offers a first session', async ({ page }) => {
    await reset('empty');
    await login(page);
    const name = `Kitchen remodel${tag()}`;
    // The real server checks that a project repo exists; use a real temp dir.
    const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-web-repo-')));
    await page.getByTestId('new-agent').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('[data-kind="project"]').click();
    await dialog.getByTestId('wz-name').fill(name);
    await dialog.getByTestId('wz-next').click();
    await dialog.getByTestId('wz-mission').fill('Finish the kitchen by March without going over budget.');
    await dialog.getByTestId('wz-next').click();
    await dialog.getByTestId('wz-repo').fill(repoDir);
    await dialog.getByTestId('wz-domain').selectOption('home');
    await dialog.getByTestId('wz-next').click();
    await expect(dialog).toContainText(`${name} is ready`);

    const created = (await orgAgents()).find((a) => a.name === name);
    expect(created, 'agent shows up in /api/org').toBeTruthy();
    expect(created.kind).toBe('project');
    expect(created.domain).toBe('home');
    if (isMock()) {
      const post = (await mockRequests()).find((r) => r.method === 'POST' && r.path === '/api/agents');
      expect(post.body).toMatchObject({ kind: 'project', name, mission: 'Finish the kitchen by March without going over budget.', repo: repoDir, domain: 'home' });
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
    const name = `Fitness${tag()}`;
    await dialog.getByTestId('wz-name').fill(name);
    await dialog.getByTestId('wz-name').press('Enter');
    await expect(dialog.getByTestId('wz-mission')).toBeFocused();
    await expect(dialog.getByTestId('wz-next')).toHaveText(/Create domain/);
    await dialog.getByTestId('wz-mission').fill('Get stronger without getting hurt.');
    await dialog.getByTestId('wz-next').click();
    await expect(dialog).toContainText(`${name} is ready`);
  });
});

test.describe('donna page', () => {
  test.skip(() => !isMock() && !process.env.CLAWDLING_E2E_ALLOW_CHANNELS, 'real server: would store a bot token; opt in with CLAWDLING_E2E_ALLOW_CHANNELS=1 and a stub TELEGRAM_API_BASE');

  test('connecting a Telegram bot shows a pairing code', async ({ page }) => {
    await reset('default');
    await login(page, '#/donna');
    await expect(page.getByTestId('telegram-card')).toContainText('Not set up');
    await expect(page.getByTestId('telegram-card')).toContainText('@BotFather');
    await page.getByTestId('tg-token').fill('123456789:AAFakeTokenForTests_0123456789');
    await page.getByTestId('tg-connect').click();
    const code = page.getByTestId('pairing-code');
    await expect(code).toBeVisible();
    await expect(code.locator('.pair-digits')).toHaveText(/^\d{6}$/);
    await expect(page.getByTestId('telegram-card')).toContainText('Waiting for /pair');
    if (isMock()) {
      const post = (await mockRequests()).find((r) => r.method === 'POST' && r.path === '/api/channels/telegram');
      expect(post.body.token).toBe('123456789:AAFakeTokenForTests_0123456789');
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

test.describe('settings: use Clawdling on your phone', () => {
  test('loopback: no QR and no LAN address, just how to make the phone reach it (P0-2)', async ({ page }) => {
    await reset('default');
    const probe = await fetch(new URL('/api/pair', process.env.CLAWDLING_E2E_URL), { headers: { 'x-clawdling-token': process.env.CLAWDLING_E2E_TOKEN } });
    test.skip(probe.status === 404, 'this server has no /api/pair yet');
    const pair = await probe.json();
    test.skip(!/^http:\/\/127\./.test(pair.url), 'this server is reachable from other devices');
    const h = await health();
    await login(page, '#/settings');
    const card = page.getByTestId('phone-card');
    await expect(card.locator('.card-title')).toHaveText('Use Clawdling on your phone');
    await expect(page.getByTestId('pair-qr')).toHaveCount(0);
    await expect(page.getByTestId('pair-app-qr')).toHaveCount(0);
    for (const lan of pair.lan) await expect(card).not.toContainText(lan);
    const warn = page.getByTestId('pair-warning');
    await expect(warn).toContainText("Your phone can't reach this cockpit yet.");
    await expect(warn).toContainText(`${h.cli} start --host 0.0.0.0`); // spelled the way this computer runs it
    await expect(warn).toContainText('Tailscale');
    // The app is honest about not being out yet.
    await expect(page.getByTestId('pair-app')).toContainText('public beta');
    await expect(page.getByTestId('pair-app')).toContainText('public beta on TestFlight');
  });

  test('reachable: the QR opens the cockpit in the phone browser, signed in; the app code is folded away', async ({ page, context }) => {
    test.skip(!isMock(), 'needs the mock to change the bind address');
    await reset('default');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mock('bind', { bind: '0.0.0.0' });
    const pair = await api('GET', '/api/pair');
    expect(pair.browser_link).toBe(`${pair.url}/?t=${pair.token}`);
    await login(page, '#/settings');
    const qr = page.getByTestId('pair-qr');
    await expect(qr).toHaveAttribute('src', '/api/pair/qr.svg?target=browser');
    await expect.poll(() => qr.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(page.getByTestId('pair-browser')).toContainText("Open it in your phone's browser");
    await expect(page.getByTestId('pair-warning')).toHaveCount(0);
    // The token is masked on screen until asked for, but Copy copies the real browser link.
    await expect(page.getByTestId('pair-link')).not.toContainText(pair.token);
    await page.getByTestId('pair-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pair.browser_link);
    // Only one code to scan with the camera: the app's stays folded until asked for.
    await expect(page.getByTestId('pair-app-qr')).toBeHidden();
    await page.getByTestId('pair-app').locator('summary').click();
    await expect(page.getByTestId('pair-app-qr')).toBeVisible();
    await expect(page.getByTestId('pair-app-qr')).toHaveAttribute('src', '/api/pair/qr.svg');
  });

  test('the browser link really signs a new browser in', async ({ browser }) => {
    const pair = await api('GET', '/api/pair');
    // The phone would use the LAN address; this machine reaches the same server on loopback.
    const local = pair.browser_link.replace(pair.url, process.env.CLAWDLING_E2E_URL.replace(/\/$/, ''));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(local);
    await expect(page.locator('[data-rail]')).toBeVisible();
    expect(page.url()).not.toContain('t=');
    await ctx.close();
  });
});
