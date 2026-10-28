// Probe: CROSS_AGENT_RE (server/seat-policy.js) misses common shell spellings of `clawdling send`, so
// the seat's prompt is labelled "runs only the report and the session list" (ASK_OTHER) instead of
// "the CTO wants to message another agent" (ASK_SEND), the cockpit heads it "The CTO wants to run this
// command", and the review page files it under "Other commands", not "Messages to agents".
//
// Each command below runs `clawdling send abcd1234 ...` in bash/zsh. The owner still gets Claude Code's
// prompt (so this is a labelling gap, not a bypass), but the docs promise the send is named "in any
// spelling".
//
// Fails on 49723e2 (reason is ASK_OTHER); passes once the test normalises quotes/backslashes and does
// not require `clawdling` to come before the verb (e.g. `xargs clawdling`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_SEND, seatDecision } from '../../server/seat-policy.js';

const bash = (command) => seatDecision({ tool_name: 'Bash', tool_use_id: 'toolu_probe', tool_input: { command, description: 'Tell the agent' } }, { home: '/tmp/clawdling-probe-org' });

test('control: the plain spelling is named as a message', () => {
  assert.equal(bash('clawdling send abcd1234 "ship it"').reason, ASK_SEND);
});

for (const cmd of [
  'clawdling se""nd abcd1234 "ship it"', // the shell joins se + "" + nd
  "clawdling s\\end abcd1234 'ship it'", // \e is e outside quotes
  "printf 'send abcd1234 ship-it' | xargs clawdling", // verb before the program name
]) {
  test(`named as a message: ${cmd}`, () => {
    const d = bash(cmd);
    assert.equal(d.decision, 'ask');
    assert.equal(d.reason, ASK_SEND, `got: ${d.reason}`);
  });
}
