// 1.5.2: the two defects the Studio product review found on camera, checked where a viewer sees
// them: 1440 and 390 wide, dark and light, on a fresh org and on a busy one. Each test also writes
// a screenshot to test/e2e/screenshots/ (or $CLAWDLING_SHOTS_DIR) for the release notes.
//   #29  the org map drew a lone project (and its usage line) over the owner's "You" disc.
//   #31  a recovered tool error showed in amber on a session that succeeded, and the outcome
//        ("tests passed") was cut from the row.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, isMock, login, reset } from './helpers.js';

const DIR = process.env.CLAWDLING_SHOTS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
const WIDTHS = [{ w: 1440, h: 900 }, { w: 390, h: 844, phone: true }];
const THEMES = ['dark', 'light'];

// fresh: a brand-new org with one project (the Studio's first run); busy: a week of work, live
// sessions and usage on two projects; busy-one: the same with a single project (the real run).
const ORGS = {
  fresh: async () => {
    await reset('fresh');
    await api('POST', '/api/agents', { kind: 'project', name: 'garden-site', mission: 'Keep the garden website up to date' });
    return 'garden-site';
  },
  busy: async () => {
    await reset('report');
    return 'site';
  },
  'busy-one': async () => {
    await reset('report');
    await api('DELETE', '/api/agents/marathon');
    return 'site';
  },
};

async function settle(page) {
  await page.waitForTimeout(800); // the map's fit transition
  await page.evaluate(() => document.fonts && document.fonts.ready);
}

/** Everything on the map drawn over the owner's disc, and any node placed at a non-number. */
function mapProblems(page) {
  return page.evaluate(() => {
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const o = document.querySelector('.node.kind-owner .node-disc').getBoundingClientRect();
    const out = [];
    for (const n of document.querySelectorAll('.node')) {
      const t = n.getAttribute('transform') || '';
      if (!/^translate\(-?[\d.e-]+ -?[\d.e-]+\)$/.test(t)) out.push(`${n.dataset.node}: transform "${t}"`);
      if (n.dataset.kind === 'owner') {
        if (n.querySelector('.node-usage')) out.push('the owner has a usage line');
        continue;
      }
      for (const el of n.querySelectorAll('.node-disc, .node-label, .node-usage, .node-sub')) {
        if (hit(el.getBoundingClientRect(), o)) out.push(`${n.dataset.node} ${el.getAttribute('class')} "${el.textContent}" overlaps the owner's disc`);
      }
    }
    return out;
  });
}

for (const vp of WIDTHS) {
  for (const theme of THEMES) {
    test.describe(`on camera ${vp.w} ${theme}`, () => {
      test.use({ viewport: { width: vp.w, height: vp.h }, colorScheme: theme, ...(vp.phone ? { hasTouch: true, isMobile: true } : {}) });

      for (const org of Object.keys(ORGS)) {
        test(`#29 the org map draws nothing over "You" (${org}, ${vp.w}, ${theme})`, async ({ page }) => {
          test.skip(!isMock(), 'uses the mock fixtures');
          const project = await ORGS[org]();
          await login(page, '#/map');
          const map = page.getByTestId('org-map');
          await expect(map.locator(`.node[data-node="${project}"]`)).toBeVisible();
          if (org !== 'fresh') await expect(map.locator('[data-usage]').first()).toBeVisible();
          await settle(page);
          await page.screenshot({ path: path.join(DIR, `oncamera-map-${org}-${vp.w}-${theme}.png`) });
          expect(await mapProblems(page)).toEqual([]);
          // The project sits on the outer ring, with a line to its domain or the Projects group.
          const far = await page.evaluate((id) => {
            const c = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
            const [ox, oy] = c(document.querySelector('.node.kind-owner .node-disc'));
            const [px, py] = c(document.querySelector(`.node[data-node="${id}"] .node-disc`));
            return Math.hypot(px - ox, py - oy) / document.querySelector('.node.kind-owner .node-disc').getBoundingClientRect().width;
          }, project);
          expect(far).toBeGreaterThan(3);
        });
      }

      test(`#31 the report card leads with the outcome, whole, and no amber for recovered errors (${vp.w}, ${theme})`, async ({ page }) => {
        test.skip(!isMock(), 'uses the mock "report" fixture');
        await reset('report');
        await login(page, '#/agent/site');
        const done = page.getByTestId('rc-done');
        const row = done.locator('.rc-done-item', { hasText: 'Add the signup form' });
        await expect(row.getByTestId('rc-outcome')).toHaveText('All 24 tests pass.');
        await expect(row.locator('.rc-line')).toHaveText('The signup form works: it saves to the waitlist and sends the welcome email.');
        await expect(row.getByTestId('rc-hiccups')).toHaveText('2 hiccups along the way');
        await expect(done.locator('.rc-done-item', { hasText: 'Speed up the home page' }).getByTestId('rc-hiccups')).toHaveText('1 hiccup along the way');
        await expect(done.locator('.tone-amber-text')).toHaveCount(0);
        await expect(done).not.toContainText('hit an error');
        await row.scrollIntoViewIfNeeded();
        await settle(page);
        await done.screenshot({ path: path.join(DIR, `oncamera-report-busy-${vp.w}-${theme}.png`) });
        const m = await row.evaluate((li) => {
          const out = li.querySelector('[data-testid="rc-outcome"]');
          const line = li.querySelector('.rc-line');
          const facts = li.querySelector('.rc-facts');
          const hic = li.querySelector('[data-testid="rc-hiccups"]');
          const files = facts.firstElementChild;
          return {
            first: out.getBoundingClientRect().top < line.getBoundingClientRect().top,
            whole: out.scrollWidth <= out.clientWidth + 1 && out.scrollHeight <= out.clientHeight + 1 && getComputedStyle(out).textOverflow !== 'ellipsis',
            neutral: getComputedStyle(hic).color === getComputedStyle(files).color,
          };
        });
        expect(m).toEqual({ first: true, whole: true, neutral: true });
      });

      test(`#31 a fresh project's report card has no amber (${vp.w}, ${theme})`, async ({ page }) => {
        test.skip(!isMock(), 'uses the mock fixtures');
        const project = await ORGS.fresh();
        await login(page, `#/agent/${project}`);
        const done = page.getByTestId('rc-done');
        await expect(done).toContainText('Nothing done in the last 7 days yet.');
        await settle(page);
        await page.screenshot({ path: path.join(DIR, `oncamera-report-fresh-${vp.w}-${theme}.png`) });
        await expect(page.getByTestId('report-card').locator('.tone-amber-text')).toHaveCount(0);
      });
    });
  }
}
