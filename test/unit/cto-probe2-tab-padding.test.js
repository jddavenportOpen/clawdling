// Probe (round 2, Medium): the seat's padding rules count tab characters, not the columns a tab
// takes, so the round-1 fix (joiners read as absent) leaves the same outcome open through tabs.
//
// server/seat-policy.js:
//   - shownRows counts every tab as one column;
//   - the "more than 80 spaces in a row" rule is /[ \t]{81}/, which counts tab characters.
// A tab moves to the next multiple of 8 columns, in a terminal and in the cockpit's command box
// (web/styles.css .dialog-cmd: white-space pre-wrap, no tab-size, so the default of 8). So 20 tabs
// are about 160 blank columns but are not "a run of more than 80", and 80 tabs (eight blank rows)
// are not either. A one-line command of 48 runs of 80 tabs, each followed by one dot, is about 380
// rows tall; shownRows reports 49, under the 60-row limit. The command's first part sits far above
// what the owner sees at the bottom of the prompt, and the call is only asked about, not refused.
//
// Fails on 10aba82 (decision "ask"); passes once a tab counts as the columns it advances (to the
// next multiple of 8) in shownRows and in the blank-run rule, or once tabs are refused in a seat
// shell command (no seat command needs one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatDecision } from '../../server/seat-policy.js';

const HOME = '/tmp/clawdling-probe-org';
const bash = (command) => seatDecision({ tool_name: 'Bash', tool_use_id: 'toolu_probe', tool_input: { command, description: 'List the sessions' } }, { home: HOME });

test('control: 81 spaces in a row are refused as padding', () => {
  assert.equal(bash(`clawdling ls${' '.repeat(81)}#`).decision, 'deny');
});

test('20 tabs in a row (about 160 blank columns) are a blank run of more than 80 columns', () => {
  const d = bash(`clawdling ls${'\t'.repeat(20)}#`);
  assert.equal(d.decision, 'deny', `got ${d.decision} (${d.reason})`);
});

test('ten tabs fill an 80-column row: 70 of them make a command about 71 rows tall', () => {
  const cmd = `echo a${`${'\t'.repeat(10)}x`.repeat(70)}`;
  assert.ok(cmd.length <= 4000 && !cmd.includes('\n'));
  const d = bash(cmd);
  assert.equal(d.decision, 'deny', `got ${d.decision} (${d.reason})`);
});

test('a one-line command about 380 rows tall, nearly all blank, is refused like any other over 60 rows', () => {
  const cmd = `echo first-part #${`${'\t'.repeat(80)}.`.repeat(48)} clawdling ls`;
  assert.ok(cmd.length <= 4000, `length ${cmd.length}`);
  assert.ok(!/[ \t]{81}/.test(cmd), 'precondition: no run of more than 80 characters');
  assert.equal(cmd.split('\n').length, 1);
  const d = bash(cmd);
  assert.equal(d.decision, 'deny', `got ${d.decision} (${d.reason})`);
});
