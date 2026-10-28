// Probe (round 2, Low): the review lint (server/review-lint.js lintReview) checks only that a cited
// receipt exists in the week's index, never that it belongs to the agent whose section cites it. Every
// receipt carries its agent (receipts.js collectReceipts). So a bullet under "## Website" that cites
// one of Newsletter's receipts reads as "cited", and the whole review lints clean: "receipts or it
// didn't happen" passes on a receipt for something else. A confused CTO hits this by accident, and a
// steered one can attribute another project's verified work to a stalled project.
//
// Fails on 10aba82 (the bullet is "cited" and the review is clean); passes once such a bullet is
// marked (any state other than "cited") or the review no longer reads clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintReview } from '../../server/review-lint.js';

const R_NEWS = 'R-session-0123abcd';
const receipts = { [R_NEWS]: { kind: 'session', agent: 'newsletter', link: '#/s/n', label: 'Sent the October issue' } };
const labels = { website: { label: 'stalled', name: 'Website' }, newsletter: { label: 'on_track', name: 'Newsletter' } };
const review = [
  '# CTO review, 2026-W44',
  'Headline: Quiet week.',
  '## Website: Stalled',
  `- Shipped the landing page, verified [${R_NEWS}]`,
  '## Newsletter: On track',
  `- Sent the October issue [${R_NEWS}]`,
  '',
].join('\n');

test("control: a receipt cited in its own agent's section is cited", () => {
  const l = lintReview(review, { receipts, labels });
  assert.equal(l.sections[1].agent, 'newsletter');
  assert.equal(l.sections[1].bullets[0].state, 'cited');
});

test("a receipt of another agent is not proof of a finding in this agent's section", () => {
  const l = lintReview(review, { receipts, labels });
  const s = l.sections[0];
  assert.equal(s.agent, 'website');
  const b = s.bullets[0];
  assert.ok(b.state !== 'cited' || !l.clean, `bullet state ${b.state}, review clean ${l.clean}: Newsletter's receipt stands as Website's proof`);
});
