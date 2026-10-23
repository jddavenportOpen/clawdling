// The first ten minutes for a stranger, and the honesty fixes from the 2026-10-22 UX review:
// a missing claude/tmux banner, the first-run folder trust, sign-in and permission questions,
// commands spelled the way this computer runs them, and the P2 polish checks.
import { test, expect } from '@playwright/test';
import {
  login, reset, seedStandard, isMock, mock, health, sessions, sessionBySid, mockRequests, openPanes, pane, panes, focusedPane, contrast, api,
} from './helpers.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('health banner (P0-1)', () => {
  test.skip(() => !isMock(), 'needs the mock to report a missing tool');

  test('claude missing: a persistent alert that names the fix, and nothing offers to start', async ({ page }) => {
    await reset('empty');
    await mock('health', { claude: { ok: false, version: null, error: 'claude not found on PATH' } });
    const h = await health();
    await login(page);
    const banner = page.getByTestId('health-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toContainText("Clawdling can't find the claude command, so no agent can start.");
    await expect(banner).toContainText('which claude');
    await expect(banner).toContainText(`${h.cli} service install`);
    for (const id of ['donna', 'work']) {
      await expect(page.locator(`[data-agent-card="${id}"]`)).toBeDisabled();
      await expect(page.locator(`[data-agent-card="${id}"]`)).toHaveAttribute('title', 'Fix the problem above first');
    }
    await expect(page.getByTestId('first-trust-go')).toBeDisabled();
    await expect(page.locator('.rail').getByTestId('new-session')).toBeDisabled();
    await expect(page.locator('.rail [data-agent="work"] button.row')).toBeDisabled();
    // It is not a toast: still there on another page, and after a reload.
    await page.goto('/#/settings');
    await expect(banner).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('health-banner')).toBeVisible();
    // Fixed: "Check again" clears it and the cards come back.
    await mock('health', { claude: { ok: true, version: '2.1.283 (Claude Code)' } });
    await page.getByTestId('health-recheck').click();
    await expect(page.getByTestId('health-banner')).toHaveCount(0);
    await page.goto('/#/');
    await expect(page.locator('[data-agent-card="donna"]')).toBeEnabled();
  });

  test('tmux missing: the install command matches the server platform', async ({ page }) => {
    await reset('empty');
    await mock('health', { tmux: { ok: false, version: null, error: 'tmux not found on PATH' }, platform: 'linux' });
    await login(page);
    const banner = page.getByTestId('health-banner');
    await expect(banner).toContainText("Clawdling can't find tmux 3.2 or newer, so no session can start.");
    await expect(banner).toContainText('sudo apt install tmux');
    await expect(banner).not.toContainText('brew');
    await mock('health', { platform: 'darwin' });
    await page.getByTestId('health-recheck').click();
    await expect(banner).toContainText('brew install tmux');
  });

  test('a check the cockpit has no words for shows the server text; optional checks stay quiet', async ({ page }) => {
    await reset('empty');
    await mock('health', {
      backend: { ok: false, error: 'neither tmux nor the PTY backend is available' },
      extra: { ok: false, optional: true, error: 'not needed' },
    });
    await login(page);
    const banner = page.getByTestId('health-banner');
    await expect(banner.locator('[data-problem]')).toHaveCount(1);
    await expect(banner).toContainText('Neither tmux nor the PTY backend is available.');
    await expect(banner).toContainText(`${(await health()).cli} doctor`);
  });
});

test.describe('first run (P0-4)', () => {
  test.skip(() => !isMock(), 'the mock simulates a Claude Code that has trusted no folder yet');

  test('trust the org folder once from the empty state, then agents start without asking', async ({ page }) => {
    await reset('fresh');
    await login(page);
    const block = page.getByTestId('first-trust');
    await expect(block).toBeVisible();
    await expect(block).toContainText('First, trust your org folder');
    await expect(block).toContainText('Trust ~/clawdling now and no agent inside it will ask again.');
    await expect(page.locator('.rail').getByTestId('new-session')).toHaveClass(/btn-quiet/); // one filled accent
    await page.getByTestId('first-trust-go').click();

    await expect(panes(page)).toHaveCount(1);
    const sid = await focusedPane(page).getAttribute('data-pane');
    expect((await sessionBySid(sid)).agent).toBe('scratch');
    const banner = pane(page, sid).getByTestId('pane-dialog');
    await expect(banner.getByTestId('pane-dialog-text')).toHaveText('Claude Code asks whether you trust ~/clawdling. "No, exit" ends this session.');
    await expect(banner.locator('button')).toHaveText(['No, exit', 'Yes, trust it']);
    await expect(page.getByTestId('first-trust')).toHaveCount(0); // a session exists now
    await banner.getByTestId('dialog-yes').click();
    await expect(pane(page, sid).getByTestId('pane-dialog')).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Trusted ~/clawdling');
    await expect.poll(async () => (await sessionBySid(sid)).status).toBe('ready');
    const answer = (await mockRequests()).find((r) => r.method === 'POST' && r.path === `/api/sessions/${sid}/answer`);
    expect(answer.body).toEqual({ option: 2 }); // "Yes" is the second choice on screen

    // Work lives inside the org folder: no question this time.
    await page.locator('.rail [data-agent="work"] button.row').click();
    await expect(panes(page)).toHaveCount(2);
    const work = await focusedPane(page).getAttribute('data-pane');
    await expect.poll(async () => (await sessionBySid(work)).status).toBe('ready');
    await expect(pane(page, work).getByTestId('pane-dialog')).toHaveCount(0);
  });

  test('the first screen speaks plainly: no "claude CLI", no CLAUDE.md (1.1.1)', async ({ page }) => {
    await reset('fresh');
    await login(page);
    const sub = page.getByTestId('empty-state').locator('.empty-sub');
    await expect(sub).toHaveText('Every agent is a real Claude Code session that already knows its job and remembers what it did.');
    await expect(page.getByTestId('empty-state')).not.toContainText('CLAUDE.md');
    await expect(page.getByTestId('empty-state')).not.toContainText('claude CLI');
  });

  test('the trust card stays until the org folder is trusted, even after a reload (1.1.1)', async ({ page }) => {
    await reset('fresh');
    await login(page);
    await page.getByTestId('first-trust-go').click();
    await expect(panes(page)).toHaveCount(1);
    const sid = await focusedPane(page).getAttribute('data-pane');
    await expect(pane(page, sid).getByTestId('pane-dialog')).toBeVisible();
    // Hide the pane and reload before answering: the card now points at the waiting question.
    await pane(page, sid).getByTestId('pane-hide').click();
    await page.reload();
    const card = page.getByTestId('first-trust');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-pending', sid);
    await expect(card).toContainText('Claude Code is waiting: do you trust your org folder?');
    await expect(page.locator('.rail').getByTestId('new-session')).toHaveClass(/btn-quiet/); // still the one accent
    // "Show the question" opens that session; hide it again and answer from the card instead.
    await card.getByTestId('first-trust-show').click();
    await expect(focusedPane(page)).toHaveAttribute('data-pane', sid);
    await pane(page, sid).getByTestId('pane-hide').click();
    await page.getByTestId('first-trust-yes').click();
    await expect(page.locator('.toast')).toContainText('Trusted ~/clawdling');
    await expect.poll(async () => (await sessionBySid(sid)).status).toBe('ready');
    await expect(page.getByTestId('first-trust')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('first-trust')).toHaveCount(0);
  });

  test('an org that already has sessions but never trusted its folder still shows the card (1.1.1)', async ({ page }) => {
    await reset('fresh');
    await login(page);
    await page.locator('[data-agent-card="work"]').click(); // trusts only domains/work
    const sid = await focusedPane(page).getAttribute('data-pane');
    await pane(page, sid).getByTestId('dialog-yes').click();
    await expect.poll(async () => (await sessionBySid(sid)).status).toBe('ready');
    await pane(page, sid).getByTestId('pane-hide').click();
    await expect(page.getByTestId('first-trust')).toBeVisible();
    await expect(page.getByTestId('first-trust-go')).toHaveText('Trust my org folder');
  });

  test('without that step, each agent asks about its own folder (what the step saves you)', async ({ page }) => {
    await reset('fresh');
    await login(page);
    await page.locator('[data-agent-card="work"]').click();
    const sid = await focusedPane(page).getAttribute('data-pane');
    await expect(pane(page, sid).getByTestId('pane-dialog-text')).toHaveText('Claude Code asks whether you trust ~/clawdling/domains/work. "No, exit" ends this session.');
  });
});

test.describe('questions in a pane', () => {
  test.skip(() => !isMock(), 'uses the mock to raise the screens');

  test('not signed in: one click opens Sign in for your own login, then Start again picks it up (1.1.1)', async ({ page }) => {
    const ids = await seedStandard();
    await mock('dialog', { sid: ids.quotes, kind: 'login' });
    await login(page);
    await openPanes(page, [ids.quotes]);
    const banner = pane(page, ids.quotes).getByTestId('pane-dialog');
    // Plain words for someone with no terminal in mind (the desktop app's Code tab).
    await expect(banner.getByTestId('pane-dialog-text')).toHaveText("Claude Code isn't signed in yet. Click Sign in, then follow the browser steps.");
    await expect(banner.getByTestId('pane-dialog-note')).toHaveText('Then click Start again. In a terminal, claude auth login does the same.');
    await expect(banner).not.toContainText('Open a terminal');
    await expect(banner.locator('button')).toHaveText(['Sign in', 'Start again']);
    expect((await sessionBySid(ids.quotes)).notification).toMatch(/isn't signed in yet\. Click Sign in/);

    await banner.getByTestId('login-signin').click();
    await expect.poll(async () => (await mockRequests()).some((r) => r.method === 'POST' && r.path === '/api/accounts/default/signin')).toBe(true);
    const signin = (await sessions()).find((x) => x.title === 'Sign in');
    expect(signin).toBeTruthy();
    expect(signin.purpose).toBe('signin');
    expect(signin.account).toBe(null);
    await expect(focusedPane(page)).toHaveAttribute('data-pane', signin.sid);

    // Signing in there (Claude Code's auth_success) tells the first session; Start again restarts it.
    await api('POST', '/api/hooks', { event: 'Notification', sid: signin.sid, payload: { notification_type: 'auth_success', message: 'Login successful' } });
    await expect(banner.getByTestId('pane-dialog-text')).toHaveText('Claude Code is signed in now. Start this session again to use it.');
    await banner.getByTestId('login-restart').click();
    await expect.poll(async () => (await mockRequests()).some((r) => r.method === 'POST' && r.path === `/api/sessions/${ids.quotes}/restart`)).toBe(true);
    await expect.poll(async () => (await sessionBySid(ids.quotes)).status).toBe('ready');
    await expect(pane(page, ids.quotes).getByTestId('pane-dialog')).toHaveCount(0);
  });

  test('a permission prompt is answered with one click, choices in screen order (P1-8)', async ({ page }) => {
    await reset('default');
    const s = (await sessions()).find((x) => x.waiting_on === 'permission_prompt');
    await login(page);
    await openPanes(page, [s.sid]);
    const q = pane(page, s.sid).getByTestId('pane-question');
    await expect(q.getByTestId('pane-question-text')).toHaveText(s.notification);
    await expect(q.getByTestId('question-choice')).toHaveText(s.choices.map((c) => c.label.replace(/^\d+\.\s*/, '')));
    await expect(q.getByTestId('question-choice').first()).toHaveClass(/btn-primary/);
    await q.getByTestId('question-choice').nth(0).click();
    await expect.poll(async () => (await mockRequests()).find((r) => r.method === 'POST' && r.path === `/api/sessions/${s.sid}/answer`)?.body).toEqual({ option: 1 });
    await expect(pane(page, s.sid).getByTestId('pane-question')).toHaveCount(0);
  });

  test('one filled accent per screen: the focused question, else New session (P2-20)', async ({ page }) => {
    await reset('default');
    const list = await sessions();
    const home = list.find((x) => x.agent === 'home');
    const work = list.find((x) => x.waiting_on === 'permission_prompt');
    await mock('dialog', { sid: home.sid, kind: 'trust' });
    await login(page);
    await openPanes(page, [work.sid, home.sid]);
    await expect(page.locator('.btn-primary:visible')).toHaveCount(1);
    await expect(pane(page, home.sid).getByTestId('dialog-yes')).toHaveClass(/btn-primary/);
    await expect(pane(page, work.sid).getByTestId('question-choice').first()).toHaveClass(/btn-quiet/);
    await page.goto('/#/map');
    await page.locator('[data-node="health"]').click();
    await expect(page.getByTestId('map-panel')).toBeVisible();
    await expect(page.getByTestId('panel-new-session')).toHaveClass(/btn-quiet/);
    expect(await page.locator('.btn-primary:visible').count()).toBeLessThanOrEqual(1);
  });
});

test.describe('commands and copy (P0-3, P1-6, P1-14)', () => {
  test('every printed command is spelled the way this computer runs Clawdling', async ({ page }) => {
    await reset('default');
    const h = await health();
    expect(h.cli).toBeTruthy();
    await login(page, '#/donna');
    const tg = page.getByTestId('telegram-card');
    await expect(tg.locator('.copy-line code').first()).toHaveText(`${h.cli} donna telegram --token <TOKEN>`);
    await expect(tg).toContainText('Pair your Telegram chat');
    await expect(tg).not.toContainText('Pair your phone');
    await page.goto('/#/settings');
    await expect(page.getByTestId('server-cli')).toHaveText(h.cli);
    // Pane shortcuts are Option/Alt: the browser keeps Cmd/Ctrl+digit for its tabs.
    await expect(page.locator('.keys')).toContainText(/(⌥|Alt)\s*1–9/);
  });
});

test.describe('org errors (P2-15)', () => {
  test.skip(() => !isMock(), 'needs the mock to fail /api/org');

  test('a failed org read says so instead of showing an empty org', async ({ page }) => {
    await reset('empty');
    await mock('fail', { path: '/api/org', status: 500, error: 'org.json is not valid JSON' });
    await login(page);
    await expect(page.getByTestId('org-error')).toContainText("Couldn't read your org: org.json is not valid JSON.");
    await expect(page.getByTestId('org-error')).toContainText('~/clawdling/org.json');
    await expect(page.getByTestId('first-trust')).toHaveCount(0);
    await page.goto('/#/map');
    await expect(page.getByTestId('org-map').getByTestId('org-error')).toBeVisible();
    await expect(page.locator('.map-page')).not.toContainText('just you and Donna');
  });
});

test.describe('polish (P2-16, P2-18, P2-19)', () => {
  test('the End dialog starts on Cancel, so Enter never ends a session', async ({ page }) => {
    const ids = await seedStandard();
    await login(page);
    await openPanes(page, [ids.quotes]);
    await pane(page, ids.quotes).getByTestId('pane-end').click();
    await expect(page.getByTestId('confirm-cancel')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await sessionBySid(ids.quotes)).status).not.toBe('ended');
  });

  test("Donna's label sits above her node, clear of every spoke", async ({ page }) => {
    await reset('default');
    await login(page, '#/map');
    await expect(page.locator('[data-node="donna"] .node-label')).toBeVisible();
    // In the map's own coordinates, so the fit/zoom transform does not matter.
    const r = await page.evaluate(() => {
      const node = document.querySelector('[data-node="donna"]');
      const t = node.transform.baseVal.consolidate().matrix;
      const top = t.f - node.querySelector('.node-disc').r.baseVal.value;
      const boxes = [...node.querySelectorAll('.node-label, .node-sub')].map((e) => {
        const b = e.getBBox();
        return { x0: b.x + t.e, y0: b.y + t.f, x1: b.x + b.width + t.e, y1: b.y + b.height + t.f };
      });
      const hit = [...document.querySelectorAll('.edges line, .edges path')].some((el) => {
        const len = el.getTotalLength();
        for (let i = 0; i <= 60; i += 1) {
          const p = el.getPointAtLength((len * i) / 60);
          if (boxes.some((b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1)) return true;
        }
        return false;
      });
      return { above: boxes.every((b) => b.y1 <= top), hit, n: boxes.length };
    });
    expect(r.n).toBe(2);
    expect(r.above).toBe(true);
    expect(r.hit).toBe(false);
    await expect(page.locator('.map-page .page-sub')).toContainText('Click an agent to see what it knows');
  });

  test('screen reader support turns on the terminal accessibility tree', async ({ page }) => {
    const ids = await seedStandard();
    await login(page, '#/settings');
    await page.locator('label.switch').filter({ has: page.getByTestId('set-screen-reader') }).click();
    await expect(page.getByTestId('set-screen-reader')).toBeChecked();
    await page.getByTestId('cockpit-home').click();
    await openPanes(page, [ids.quotes]);
    await expect(pane(page, ids.quotes).locator('.xterm-accessibility')).toHaveCount(1);
  });
});

test.describe('contrast (P1-10)', () => {
  for (const scheme of ['dark', 'light']) {
    test(`secondary text on focused rows and placeholders passes 4.5:1 (${scheme})`, async ({ browser }) => {
      // Reduced motion: colours are read after their 0.1 s transitions, not halfway through one.
      const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const ids = await seedStandard();
      await login(page);
      await openPanes(page, [ids.quotes]);
      const row = page.locator(`.rail .row-wrap[data-sid="${ids.quotes}"]`);
      await expect(row).toHaveAttribute('data-focused', 'true');
      await expect.poll(() => row.evaluate((el) => getComputedStyle(el.querySelector('.row')).backgroundColor)).toMatch(/^rgb\(/); // opaque
      const [fg, bg] = await row.evaluate((el) => [getComputedStyle(el.querySelector('.row-agent')).color, getComputedStyle(el.querySelector('.row')).backgroundColor]);
      expect(contrast(fg, bg), `focused row meta ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      const [pfg, pbg, op] = await page.getByTestId('rail-search').evaluate((el) => {
        const ph = getComputedStyle(el, '::placeholder');
        return [ph.color, getComputedStyle(el.closest('.rail-search')).backgroundColor, ph.opacity];
      });
      expect(Number(op)).toBe(1);
      expect(contrast(pfg, pbg), `placeholder ${pfg} on ${pbg}`).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press(`${MOD}+k`);
      const sel = page.locator('.pal-item.is-sel');
      await expect(sel).toBeVisible();
      const [hfg, hbg] = await sel.evaluate((el) => [getComputedStyle(el.querySelector('.pal-hint')).color, getComputedStyle(el).backgroundColor]);
      expect(contrast(hfg, hbg), `palette hint ${hfg} on ${hbg}`).toBeGreaterThanOrEqual(4.5);
      await ctx.close();
    });
  }
});
