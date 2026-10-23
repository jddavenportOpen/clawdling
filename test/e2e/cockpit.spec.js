// The cockpit's core contract: auth, real names in the rail, focus-not-navigate,
// a collapsible-but-useful rail, home with panes intact, live terminals.
import { test, expect } from '@playwright/test';
import {
  login, seedStandard, row, rowButton, pane, panes, focusedPane, openPanes, termText, sessionBySid, isMock, TOKEN, mockRequests, spawn, api, sessions, ownsServer, health,
} from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('auth', () => {
  test('cockpit loads after /?t=<token> and the token leaves the address bar', async ({ page }) => {
    await seedStandard();
    await page.goto(`/?t=${encodeURIComponent(TOKEN())}`);
    await expect(page.locator('[data-rail="expanded"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Cockpit/ }).first()).toBeVisible();
    expect(page.url()).not.toContain('t=');
    const cookies = await page.context().cookies();
    const c = cookies.find((x) => x.name === 'cl_token');
    expect(c, 'server sets the cl_token cookie').toBeTruthy();
    expect(c.httpOnly).toBe(true);
  });

  test('without a token the cockpit explains how to get in, with a command that runs here', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const h = await health(); // public: the sign-in screen reads the server's CLI spelling from it
    expect(typeof h.cli).toBe('string');
    await page.goto('/');
    const msg = page.getByTestId('auth-message');
    await expect(msg).toBeVisible();
    await expect(msg).toHaveText('Run this in a terminal on this computer. It opens the cockpit already signed in.');
    await expect(page.locator('.auth-title')).toHaveText('Open the cockpit from your terminal');
    // Never a bare `clawdling open` unless that is how this computer runs it (P0-3).
    await expect(page.getByTestId('auth-command')).toHaveText(`${h.cli} open`);
    await page.getByTestId('auth-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${h.cli} open`);
    await expect(page.locator('[data-rail]')).toHaveCount(0);
  });
});

test.describe('rail and workspace', () => {
  let ids;
  test.beforeEach(async ({ page }) => {
    ids = await seedStandard();
    await login(page);
  });

  test('rail rows show each session by its real name', async ({ page }) => {
    const roadmap = await sessionBySid(ids.roadmap);
    await expect(row(page, ids.roadmap).getByTestId('row-title')).toHaveText(roadmap.title);
    await expect(row(page, ids.roadmap)).toHaveAttribute('data-section', 'needs');
    await expect(row(page, ids.brief)).toHaveAttribute('data-section', 'needs'); // ready = your turn
    await expect(row(page, ids.training)).toHaveAttribute('data-section', 'live');
    await expect(row(page, ids.reconcile)).toHaveAttribute('data-section', 'recent');
    // No title yet: "<Agent>: new session", never a generic label.
    await expect(row(page, ids.untitled).getByTestId('row-title')).toHaveText('Work: new session');
    // Section order: Needs you, Live, Recent, Agents.
    const order = await page.locator('.rail [data-section]').evaluateAll((els) => [...new Set(els.filter((e) => e.tagName === 'SECTION').map((e) => e.dataset.section))]);
    expect(order).toEqual(['needs', 'live', 'recent', 'agents']);
  });

  test('clicking an open row focuses that pane and nothing else changes', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.brief, ids.training]);
    await expect(panes(page)).toHaveCount(3);
    await expect(focusedPane(page)).toHaveAttribute('data-pane', ids.training);

    await rowButton(page, ids.roadmap).click();
    await expect(panes(page)).toHaveCount(3);
    await expect(page.locator('[data-pane]:not(.is-hidden)')).toHaveCount(3); // grid: all still on screen
    await expect(focusedPane(page)).toHaveCount(1);
    await expect(pane(page, ids.roadmap)).toHaveAttribute('data-focused', 'true');
    await expect(rowButton(page, ids.roadmap)).toHaveAttribute('aria-current', 'true');
    await expect(row(page, ids.brief)).toHaveAttribute('data-onscreen', 'true');
    await expect(row(page, ids.training)).toHaveAttribute('data-onscreen', 'true');
    // Keyboard focus landed in that pane's terminal.
    await expect.poll(() => page.evaluate((sid) => !!document.activeElement?.closest(`[data-pane="${sid}"]`), ids.roadmap)).toBe(true);
    expect(new URL(page.url()).hash).toMatch(/^(#\/?)?$/);
  });

  test('clicking a row that is not open adds it and focuses it', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.brief]);
    await expect(panes(page)).toHaveCount(2);
    await expect(row(page, ids.quotes)).toHaveAttribute('data-onscreen', 'false');
    await rowButton(page, ids.quotes).click();
    await expect(panes(page)).toHaveCount(3);
    await expect(pane(page, ids.quotes)).toHaveAttribute('data-focused', 'true');
    await expect(pane(page, ids.roadmap)).toBeVisible();
    await expect(pane(page, ids.brief)).toBeVisible();
    await expect(row(page, ids.quotes)).toHaveAttribute('data-onscreen', 'true');
  });

  test('collapse persists across reload and the strip focuses sessions', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.brief]);
    await page.getByTestId('rail-collapse').click();
    await expect(page.locator('[data-rail="collapsed"]')).toBeVisible();
    const strip = await page.locator('[data-rail="collapsed"]').boundingBox();
    expect(Math.round(strip.width)).toBe(56);

    await page.reload();
    await expect(page.locator('[data-rail="collapsed"]')).toBeVisible();
    await expect(panes(page)).toHaveCount(2); // the open set survived the reload too

    // One dot per live session; clicking a dot focuses (and opens) that session.
    const dot = page.locator(`.strip-dot[data-sid="${ids.training}"]`);
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('aria-label', /Plan this week's training/);
    await dot.click();
    await expect(panes(page)).toHaveCount(3);
    await expect(pane(page, ids.training)).toHaveAttribute('data-focused', 'true');
    await page.locator(`.strip-dot[data-sid="${ids.roadmap}"]`).click();
    await expect(pane(page, ids.roadmap)).toHaveAttribute('data-focused', 'true');
    await expect(panes(page)).toHaveCount(3);

    // Strip still has home, new session and search; keyboard toggles back.
    await expect(page.getByTestId('cockpit-home')).toBeVisible();
    await expect(page.getByTestId('new-session')).toBeVisible();
    await page.keyboard.press(`${MOD}+Backslash`);
    await expect(page.locator('[data-rail="expanded"]')).toBeVisible();
  });

  test('the Cockpit button returns from any page with the same panes', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.brief, ids.training]);
    const goes = [
      () => page.locator('.rail-foot').getByRole('link', { name: 'Org map' }).click(),
      async () => { // agent rows reveal their "open page" button on hover/focus
        await page.locator('.rail [data-agent="health"]').hover();
        await page.locator('.rail [data-agent="health"] .row-more').click();
      },
      () => page.locator('.rail-foot').getByRole('link', { name: 'Donna' }).click(),
      () => page.locator('.rail-foot').getByRole('link', { name: 'Settings' }).click(),
      () => page.goto('/#/map'), // a deep link works the same way
    ];
    for (const go of goes) {
      await go();
      await expect(page.locator('.page-layer')).toBeVisible();
      await expect(page.locator('.workspace')).toHaveAttribute('aria-hidden', 'true');
      await page.getByTestId('cockpit-home').click();
      await expect(page.locator('.page-layer')).toHaveCount(0);
      await expect(page).toHaveURL(/#\/$/);
      await expect(panes(page)).toHaveCount(3);
      await expect(page.locator('[data-pane]:not(.is-hidden)')).toHaveCount(3);
      await expect(pane(page, ids.training)).toHaveAttribute('data-focused', 'true');
    }
  });

  test('terminal: snapshot, then typed input round-trips through the WebSocket', async ({ page }) => {
    await openPanes(page, [ids.quotes]);
    await expect(termText(page, ids.quotes)).toContainText(/\S/); // snapshot painted
    await page.keyboard.type('hello clawdling');
    await page.keyboard.press('Enter');
    await expect(termText(page, ids.quotes)).toContainText(isMock() ? 'You said: hello clawdling' : 'hello clawdling', { timeout: 10_000 });
    if (isMock()) {
      const reqs = await mockRequests();
      expect(reqs.some((r) => r.method === 'WS' && r.body.t === 'resize' && r.body.cols > 20 && r.body.rows > 5)).toBe(true);
    }
  });

  test('rename by double-clicking the pane title', async ({ page }) => {
    await openPanes(page, [ids.brief]);
    await pane(page, ids.brief).getByTestId('pane-title').dblclick();
    const input = pane(page, ids.brief).getByTestId('pane-title-input');
    await expect(input).toBeFocused();
    await input.fill('Morning brief, Thursday');
    await input.press('Enter');
    await expect(pane(page, ids.brief).getByTestId('pane-title')).toHaveText('Morning brief, Thursday');
    await expect(row(page, ids.brief).getByTestId('row-title')).toHaveText('Morning brief, Thursday');
    await expect.poll(async () => (await sessionBySid(ids.brief)).title).toBe('Morning brief, Thursday');
  });

  test('rename keeps keystrokes typed the instant the field opens', async ({ page }) => {
    await openPanes(page, [ids.quotes, ids.brief]);
    await pane(page, ids.brief).getByTestId('pane-title').dblclick();
    await page.keyboard.type('Brief, typed fast'); // no wait for focus: the field must already have it
    await page.keyboard.press('Enter');
    await expect(row(page, ids.brief).getByTestId('row-title')).toHaveText('Brief, typed fast');
    await expect.poll(async () => (await sessionBySid(ids.brief)).title).toBe('Brief, typed fast');
  });

  test('ending a session asks first and keeps the other panes', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.brief, ids.quotes]);
    await pane(page, ids.brief).getByTestId('pane-end').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('End “');
    await dialog.getByTestId('confirm-end').click();
    await expect(dialog).toHaveCount(0);
    await expect(panes(page)).toHaveCount(2);
    await expect(pane(page, ids.roadmap)).toBeVisible();
    await expect(pane(page, ids.quotes)).toBeVisible();
    await expect(page.locator('.page-layer')).toHaveCount(0);
    await expect.poll(async () => (await sessionBySid(ids.brief)).status).toBe('ended');
    await expect(row(page, ids.brief)).toHaveAttribute('data-section', 'recent');
  });

  test('cancelling the end dialog changes nothing', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.quotes]);
    await pane(page, ids.quotes).getByTestId('pane-end').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(panes(page)).toHaveCount(2);
    expect((await sessionBySid(ids.quotes)).status).not.toBe('ended');
  });

  test('a Recent row resumes the session and focuses it', async ({ page }) => {
    await openPanes(page, [ids.roadmap]);
    await expect(row(page, ids.reconcile)).toHaveAttribute('data-section', 'recent');
    await rowButton(page, ids.reconcile).click();
    await expect(pane(page, ids.reconcile)).toHaveAttribute('data-focused', 'true');
    await expect(panes(page)).toHaveCount(2);
    await expect.poll(async () => (await sessionBySid(ids.reconcile)).status).not.toBe('ended');
    await expect(row(page, ids.reconcile)).not.toHaveAttribute('data-section', 'recent');
    if (isMock()) {
      const reqs = await mockRequests();
      expect(reqs.some((r) => r.method === 'POST' && r.path === `/api/sessions/${ids.reconcile}/resume`)).toBe(true);
    }
  });

  test('command palette jumps to a session', async ({ page }) => {
    await openPanes(page, [ids.roadmap]);
    await page.keyboard.press(`${MOD}+k`);
    const input = page.getByTestId('palette-input');
    await expect(input).toBeFocused();
    await input.fill('dishwasher');
    await expect(page.locator('.pal-item.is-sel')).toContainText('Compare dishwasher quotes');
    await input.press('Enter');
    await expect(page.getByTestId('palette-input')).toHaveCount(0);
    await expect(pane(page, ids.quotes)).toHaveAttribute('data-focused', 'true');
    await expect(panes(page)).toHaveCount(2);
  });

  test('Option/Alt+N focuses pane N (browsers keep Cmd/Ctrl+N) and layouts never drop panes', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.brief, ids.quotes]);
    await page.keyboard.press('Alt+Digit1');
    await expect(pane(page, ids.roadmap)).toHaveAttribute('data-focused', 'true');
    // The hint on each pane names the key that works (⌥2 on a Mac, Alt+2 elsewhere).
    await expect(pane(page, ids.brief).locator('.pane-index')).toHaveText(/^(⌥|Alt\+)2$/);
    await page.locator('[data-layout-btn="focus"]').click();
    await expect(page.locator('[data-pane]:not(.is-hidden)')).toHaveCount(1);
    await expect(panes(page)).toHaveCount(3);
    await page.keyboard.press('Alt+Digit3');
    await expect(pane(page, ids.quotes)).toBeVisible();
    await expect(page.locator('.tabstrip [role="tab"]')).toHaveCount(3);
    await page.locator('[data-layout-btn="split"]').click();
    await expect(page.locator('[data-pane]:not(.is-hidden)')).toHaveCount(2);
    await page.locator('[data-layout-btn="grid"]').click();
    await expect(page.locator('[data-pane]:not(.is-hidden)')).toHaveCount(3);
  });

  test('new session from the rail opens focused in the workspace', async ({ page }) => {
    await openPanes(page, [ids.roadmap]);
    await page.getByTestId('new-session').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('[data-agent-option="health"]').click();
    await dialog.getByTestId('ns-prompt').fill('Plan a deload week.');
    await dialog.getByTestId('ns-start').click();
    await expect(dialog).toHaveCount(0);
    await expect(panes(page)).toHaveCount(2);
    const sid = await focusedPane(page).getAttribute('data-pane');
    const s = await sessionBySid(sid);
    expect(s.agent).toBe('health');
  });

  test('live status changes reach the rail without a reload', async ({ page }) => {
    const sid = await spawn({ agent: 'money', title: 'Pay the water bill', status: 'working' });
    await expect(row(page, sid)).toHaveAttribute('data-section', 'live', { timeout: 12_000 });
    await api('POST', '/api/hooks', { event: 'Notification', sid, payload: { message: 'Approve the payment?' } });
    await expect(row(page, sid)).toHaveAttribute('data-section', 'needs', { timeout: 12_000 });
    await expect(row(page, sid)).toContainText('Approve the payment?');
  });
});

test.describe('pane lifecycle', () => {
  let ids;
  test.beforeEach(async ({ page }) => {
    ids = await seedStandard();
    await login(page);
  });

  test('a session that ends on its own shows Resume in its pane', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.quotes]);
    await api('DELETE', `/api/sessions/${ids.quotes}`); // ended elsewhere (CLI, /exit, tmux)
    const p = pane(page, ids.quotes);
    await expect(p.getByText(/Session ended/)).toBeVisible({ timeout: 12_000 });
    await expect(p).toHaveAttribute('data-status', 'ended');
    await expect(panes(page)).toHaveCount(2); // it stays put until you close or resume it
    await p.getByTestId('pane-resume').click();
    await expect(p.getByText(/Session ended/)).toHaveCount(0);
    await expect.poll(async () => (await sessionBySid(ids.quotes)).status).not.toBe('ended');
    await expect(p).toHaveAttribute('data-focused', 'true');
  });

  test('the terminal reconnects after the socket drops', async ({ page }) => {
    test.skip(!isMock(), 'needs the mock to cut the socket');
    await openPanes(page, [ids.quotes]);
    await expect(termText(page, ids.quotes)).toContainText(/\S/);
    await fetch(new URL('/__mock/drop', process.env.CLAWDLING_E2E_URL), { method: 'POST' });
    // Backoff starts at ~0.4 s; the fresh snapshot repaints and input works again.
    await page.waitForTimeout(1500);
    await page.keyboard.type('after the blip');
    await page.keyboard.press('Enter');
    await expect(termText(page, ids.quotes)).toContainText('You said: after the blip', { timeout: 10_000 });
    await expect(pane(page, ids.quotes).locator('.pane-conn')).toHaveCount(0);
  });

  test('copy attach command puts the tmux line on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPanes(page, [ids.brief]);
    await pane(page, ids.brief).getByTestId('pane-attach').click();
    await expect(page.locator('.toast')).toContainText('Attach command copied');
    const s = await sessionBySid(ids.brief);
    // Only the server knows its tmux socket: tooltip and clipboard are exactly its attach_cmd.
    expect(s.attach_cmd).toContain(s.tmux_name);
    await expect(pane(page, ids.brief).getByTestId('pane-attach')).toHaveAttribute('title', `Copy: ${s.attach_cmd}`);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(s.attach_cmd);
  });

  test('hiding a pane keeps the session running', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.training]);
    await pane(page, ids.training).getByTestId('pane-hide').click();
    await expect(panes(page)).toHaveCount(1);
    await expect(row(page, ids.training)).toHaveAttribute('data-onscreen', 'false');
    await expect(row(page, ids.training)).toHaveAttribute('data-section', 'live');
    expect((await sessionBySid(ids.training)).status).not.toBe('ended');
  });

  test('the X on a live pane offers "hide, keep running" as the safe choice', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.training]);
    await pane(page, ids.training).getByTestId('pane-end').click();
    await page.getByTestId('confirm-hide').click();
    await expect(panes(page)).toHaveCount(1);
    expect((await sessionBySid(ids.training)).status).not.toBe('ended');
  });

  test('rail kebab menu: rename and end from the rail', async ({ page }) => {
    await openPanes(page, [ids.roadmap, ids.brief]);
    await row(page, ids.brief).hover();
    await row(page, ids.brief).locator('.row-more').click();
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    const input = pane(page, ids.brief).getByTestId('pane-title-input');
    await expect(input).toBeFocused();
    await input.fill('Brief for Friday');
    await input.press('Enter');
    await expect(row(page, ids.brief).getByTestId('row-title')).toHaveText('Brief for Friday');

    await row(page, ids.roadmap).hover();
    await row(page, ids.roadmap).locator('.row-more').click();
    await page.getByRole('menuitem', { name: 'End session…' }).click();
    await page.getByTestId('confirm-end').click();
    await expect(panes(page)).toHaveCount(1);
    await expect(pane(page, ids.brief)).toBeVisible();
    await expect.poll(async () => (await sessionBySid(ids.roadmap)).status).toBe('ended');
  });

  test('search filters every section', async ({ page }) => {
    const all = await sessions();
    const visibleRows = (list) => list.filter((x) => x.status !== 'ended' || Date.now() - Date.parse(x.ended_at || x.last_activity_at) < 14 * 864e5);
    const quotes = await sessionBySid(ids.quotes);
    const word = quotes.title.split(' ').slice(1, 2)[0]; // "dishwasher"
    await page.getByTestId('rail-search').fill(word);
    const expected = visibleRows(all).filter((x) => (x.title || '').toLowerCase().includes(word.toLowerCase())).length;
    await expect(page.locator('.rail .row-wrap[data-sid]')).toHaveCount(expected);
    await expect(row(page, ids.quotes)).toBeVisible();
    await expect(row(page, ids.brief)).toHaveCount(0);
    await page.getByTestId('rail-search').fill('money');
    await expect(row(page, ids.reconcile)).toBeVisible(); // matches by agent name
    await expect(page.locator('.rail [data-agent="money"]')).toBeVisible();
    await expect(page.locator('.rail [data-agent="work"]')).toHaveCount(0);
    await page.getByTestId('rail-search').press('Escape');
    await expect(page.getByTestId('rail-search')).toHaveValue('');
    await expect(row(page, ids.brief)).toBeVisible();
    await expect(page.locator('.rail [data-agent="work"]')).toBeVisible();
  });
});

// Claude Code's own startup dialog (folder trust) is answered from the pane.
async function trustDialogSession(agent, title) {
  if (isMock()) {
    const sid = await spawn({ agent, title, status: 'ready' });
    await fetch(new URL('/__mock/dialog', process.env.CLAWDLING_E2E_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, kind: 'trust' }) });
    return sid;
  }
  // A real server we booted: the fake claude shows its trust dialog in a folder holding .fake-claude-trust.
  const a = await api('GET', `/api/agents/${agent}`);
  const marker = path.join(a.dir, '.fake-claude-trust');
  fs.writeFileSync(marker, '');
  try {
    const s = await api('POST', '/api/sessions', { agent, title });
    await expect.poll(async () => (await sessionBySid(s.sid)).waiting_on, { timeout: 15_000 }).toBe('trust');
    return s.sid;
  } finally {
    fs.rmSync(marker, { force: true });
  }
}

test.describe('startup dialogs', () => {
  test.skip(() => !isMock() && !ownsServer(), 'needs the mock, or a real server this suite booted');
  let ids;

  test.beforeEach(async () => {
    ids = await seedStandard();
    if (!isMock()) {
      const probe = await fetch(new URL('/api/sessions/00000000-0000-4000-8000-000000000000/answer', process.env.CLAWDLING_E2E_URL), {
        method: 'POST', headers: { 'x-clawdling-token': TOKEN(), 'content-type': 'application/json' }, body: '{"option":1}',
      });
      const body = await probe.json().catch(() => ({}));
      test.skip(probe.status === 404 && /route/i.test(body.error || ''), 'this server has no /answer route yet');
    }
  });

  test('"Yes, trust it" answers the trust dialog; the terminal still takes keys', async ({ page }) => {
    const sid = await trustDialogSession('home', 'Sort the garage');
    await login(page);
    await openPanes(page, [sid]);
    const banner = pane(page, sid).getByTestId('pane-dialog');
    await expect(banner).toBeVisible();
    // It names the folder and says what "No, exit" does (P0-4).
    const cwd = (await sessionBySid(sid)).cwd;
    await expect(banner.getByTestId('pane-dialog-text')).toHaveText(`Claude Code asks whether you trust ${cwd.replace(/^\/(Users|home)\/[^/]+/, '~')}. "No, exit" ends this session.`);
    // Buttons follow the server's choices in screen order (2.1.283 lists "No, exit" first).
    await expect(banner.locator('button')).toHaveText(['No, exit', 'Yes, trust it']);
    await expect(banner.getByTestId('dialog-yes')).toHaveText('Yes, trust it');
    await expect(banner.getByTestId('dialog-no')).toHaveText('No, exit');
    if (isMock()) {
      await expect(pane(page, sid).locator('textarea.xterm-helper-textarea')).toBeFocused();
      await page.keyboard.type('xyz'); // keystrokes still reach the session while the banner is up
      await expect(termText(page, sid)).toContainText('xyz');
    }
    await banner.getByTestId('dialog-yes').click();
    await expect(pane(page, sid).getByTestId('pane-dialog')).toHaveCount(0);
    await expect.poll(async () => (await sessionBySid(sid)).status).not.toBe('needs_you');
    await expect(pane(page, sid)).not.toHaveAttribute('data-status', 'ended');
    if (isMock()) {
      // Claude Code 2.1.283 lists "No, exit" first, so "Yes" is the second choice on screen.
      const req = (await mockRequests()).find((r) => r.method === 'POST' && r.path === `/api/sessions/${sid}/answer`);
      expect(req.body).toEqual({ option: 2 });
    }
  });

  test('"No, exit" ends the session and the pane offers Resume', async ({ page }) => {
    const sid = await trustDialogSession('money', 'Look at the budget');
    await login(page);
    await openPanes(page, [ids.roadmap, sid]);
    await pane(page, sid).getByTestId('dialog-no').click();
    await expect.poll(async () => (await sessionBySid(sid)).status).toBe('ended');
    await expect(pane(page, sid).getByText(/Session ended/)).toBeVisible();
    await expect(panes(page)).toHaveCount(2);
    if (isMock()) {
      const res = await fetch(new URL(`/api/sessions/${sid}/answer`, process.env.CLAWDLING_E2E_URL), {
        method: 'POST', headers: { 'x-clawdling-token': TOKEN(), 'content-type': 'application/json' }, body: '{"option":1}',
      });
      expect(res.status).toBe(409); // nothing left to answer
    }
  });
});
