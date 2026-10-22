import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModeTracker, OutputFilter } from '../../server/termfilter.js';

test('terminal queries are removed, normal output and mode switches are kept', () => {
  const f = new OutputFilter();
  const input = 'a\x1b[cb\x1b[>0cc\x1b[6nd\x1b[?2004$pe\x1b[>qf\x1b[?ug\x1b]11;?\x07h\x1b]10;?\x1b\\i\x1bP$qm\x1b\\j\x1b[14tk\x1b[31mred\x1b[0m\x1b[?2004h\x1b[2 q\x1b]0;title\x07';
  assert.equal(f.push(input), 'abcdefghijk\x1b[31mred\x1b[0m\x1b[?2004h\x1b[2 q\x1b]0;title\x07');
});

test('a query split across chunks is still removed; incomplete tails are held', () => {
  const f = new OutputFilter();
  assert.equal(f.push('x\x1b['), 'x');
  assert.equal(f.push('6'), '');
  assert.equal(f.push('ny\x1b]11'), 'y');
  assert.equal(f.push(';?\x1b'), '');
  assert.equal(f.push('\\z'), 'z');
  assert.equal(f.push('\x1b'), '');
  assert.equal(f.flush(), '\x1b');
});

test('ModeTracker remembers app modes and replays them for late viewers', () => {
  const m = new ModeTracker();
  m.feed('\x1b[?2004h\x1b[?1;1004h\x1b[?25l\x1b[?1000h');
  m.feed('\x1b[?1000l');
  assert.deepEqual(m.list(), [1, 1004, 2004]);
  assert.equal(m.replay(), '\x1b[?1h\x1b[?1004h\x1b[?2004h\x1b[?25l');
  m.feed('\x1bc');
  assert.deepEqual(m.list(), []);
  assert.equal(m.replay(), '');
  assert.deepEqual(new ModeTracker([2004, 99]).list(), [2004]);
});
