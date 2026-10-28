// Probe (round 2, Low): the round-1 fix for wide characters (Low-1) added \p{Emoji_Presentation} to
// WIDE_RE, but the list is still hand-written, not the East Asian Width property, and some BMP ranges
// that are Wide (W) are missing:
//   U+A960-A97C  Hangul Jamo Extended-A
//   U+FE10-FE19  vertical forms
//   U+FE50-FE6B  small form variants (U+FE50 SMALL COMMA, U+FE68 SMALL REVERSE SOLIDUS)
// Terminals (wcwidth) and xterm.js draw them two columns wide. 3,970 small commas are about 100 rows
// of an 80-column terminal, but shownRows counts 50, so the command is asked about, not refused.
//
// Fails on 10aba82; passes once widths come from the East Asian Width property (W and F count 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatDecision, shownRows } from '../../server/seat-policy.js';

const bash = (command) => seatDecision({ tool_name: 'Bash', tool_use_id: 'toolu_probe', tool_input: { command, description: 'List the sessions' } }, { home: '/tmp/clawdling-probe-org' });

test('80 East Asian Wide characters take two rows of an 80-column terminal', () => {
  for (const ch of ['ꥠ', '︐', '﹐', '﹨']) {
    assert.equal(shownRows(ch.repeat(80)), 2, `U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
  }
});

test('a command about 100 rows tall is refused like any other over 60 rows', () => {
  const cmd = `echo first-part #${'﹐'.repeat(3970)} clawdling ls`;
  assert.ok(cmd.length <= 4000, `length ${cmd.length}`);
  const d = bash(cmd);
  assert.equal(d.decision, 'deny', `got ${d.decision} (${d.reason})`);
});
