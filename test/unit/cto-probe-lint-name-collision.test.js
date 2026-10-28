// Probe: lintReview (server/review-lint.js) maps a section heading to an agent through one Map of ids
// and names, last one wins. A later agent whose name equals an earlier agent's id or name takes over
// that heading, so the CTO's label is compared with the wrong agent's computed label: the page shows
// "Computed by Clawdling" (state "match") and the lint reads clean, though Clawdling computed another
// label for the agent the heading names. Two agents with the same name (allowed) hit it innocently;
// an agent can also rename itself to shadow another.
//
// Fails on 49723e2; passes once ids always win over names and a name shared by two agents maps to none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintReview } from '../../server/review-lint.js';

const R = 'R-session-0123abcd';
const receipts = { [R]: { kind: 'session', agent: 'website', link: '#/s/x', label: 'a session' } };
const review = (heading) => `# CTO review, 2026-W44\nHeadline: Quiet week.\n## ${heading}\n- Shipped the landing page [${R}]\n`;

test('an agent named like another agent\'s id cannot take over that id\'s heading', () => {
  // "website" is Stalled; agent "evil" (listed later) renamed itself "website" and is On track.
  const labels = { website: { label: 'stalled', name: 'Website' }, evil: { label: 'on_track', name: 'website' } };
  const l = lintReview(review('website: On track'), { receipts, labels });
  const s = l.sections[0];
  assert.equal(s.agent, 'website', `the heading was matched to "${s.agent}"`);
  assert.equal(s.state, 'mismatch', `state ${s.state}: Clawdling computed Stalled for website`);
  assert.equal(l.clean, false);
});

test('a name two agents share does not pick one of them', () => {
  const labels = { site: { label: 'stalled', name: 'Website' }, zz: { label: 'on_track', name: 'Website' } };
  const l = lintReview(review('Website: On track'), { receipts, labels });
  assert.notEqual(l.sections[0].state, 'match', `matched to "${l.sections[0].agent}", whose label happens to agree`);
  assert.equal(l.clean, false);
});
