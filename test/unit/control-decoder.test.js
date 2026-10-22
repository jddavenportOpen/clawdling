import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ControlClient, LineSplitter, parseControlLine, unescapeOctal } from '../../server/tmux.js';

const B = (s) => Buffer.from(s, 'latin1');

test('unescapeOctal decodes \\ooo at the byte level', () => {
  assert.deepEqual(unescapeOctal(B('a\\015\\012b')), Buffer.from('a\r\nb'));
  assert.deepEqual(unescapeOctal(B('back\\134slash')), Buffer.from('back\\slash'));
  assert.deepEqual(unescapeOctal(B('\\033[31mred')), Buffer.from('\x1b[31mred'));
  // Not an escape: kept literally.
  assert.deepEqual(unescapeOctal(B('\\9x\\0')), B('\\9x\\0'));
  // High bytes pass through untouched (UTF-8 is never escaped by tmux).
  const utf8 = Buffer.from('wörld \u{1F600}');
  assert.deepEqual(unescapeOctal(utf8), utf8);
});

test('LineSplitter splits on 0x0a and keeps partial lines (and split UTF-8) across chunks', () => {
  const ls = new LineSplitter();
  const full = Buffer.from('%output %1 café \u{1F600}\n%exit\n');
  const lines = [];
  for (let i = 0; i < full.length; i++) lines.push(...ls.push(full.subarray(i, i + 1)));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].toString('utf8'), '%output %1 café \u{1F600}');
  assert.equal(lines[1].toString('utf8'), '%exit');
  assert.deepEqual(ls.push(Buffer.from('partial')), []);
  assert.equal(ls.push(Buffer.from(' line\n'))[0].toString(), 'partial line');
});

test('parseControlLine understands output, blocks, exit and notifications', () => {
  const o = parseControlLine(B('%output %3 hi\\015\\012'));
  assert.equal(o.type, 'output');
  assert.equal(o.pane, '%3');
  assert.equal(o.data.toString(), 'hi\r\n');
  assert.deepEqual(parseControlLine(B('%begin 1792690768 286 1')), { type: 'begin', time: '1792690768', num: '286', flags: 1 });
  assert.equal(parseControlLine(B('%end 1 2 0')).type, 'end');
  assert.equal(parseControlLine(B('%exit')).type, 'exit');
  assert.equal(parseControlLine(B('%exit detached')).reason, 'detached');
  assert.deepEqual(parseControlLine(B('%session-changed $0 cl-x')), { type: 'notify', name: 'session-changed', rest: '$0 cl-x' });
  const ext = parseControlLine(B('%extended-output %2 120 : data\\012'));
  assert.equal(ext.type, 'output');
  assert.equal(ext.data.toString(), 'data\n');
});

/** A ControlClient with the tmux process replaced by a recorder. */
function fakeClient(paneId = '%7') {
  const c = Object.create(ControlClient.prototype);
  EventEmitter.call(c);
  Object.assign(c, { name: 'cl-x-abc123', paneId, splitter: new LineSplitter(), utf8: new TextDecoder('utf-8'), pending: [], block: null, keyQueue: [], keyTimer: null, closed: false, exitReason: '' });
  c.written = [];
  c.proc = { stdin: { write: (s) => c.written.push(s) } };
  c.feed = (s) => {
    for (const line of c.splitter.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'))) c._line(line);
  };
  return c;
}

test('control client decodes UTF-8 split across two %output lines, filters other panes', () => {
  const c = fakeClient();
  let out = '';
  c.on('output', (t) => (out += t));
  const emoji = Buffer.from('\u{1F600}');
  c.feed(Buffer.concat([B('%output %7 a'), emoji.subarray(0, 2), B('\n')]));
  c.feed(Buffer.concat([B('%output %7 '), emoji.subarray(2), B('b\\134\n')]));
  c.feed(B('%output %9 other pane\n'));
  assert.equal(out, 'a\u{1F600}b\\');
});

test('command responses: flags=1 blocks resolve our FIFO in order; flags=0 blocks are ignored; lines inside a block are data', () => {
  const c = fakeClient();
  const got = [];
  c.command('capture-pane -p', (err, lines) => got.push(['cap', err, lines]));
  c.command('display-message -p x', (err, lines) => got.push(['disp', err, lines]));
  c.feed('%begin 1 10 0\n%end 1 10 0\n'); // tmux's own (the attach)
  c.feed('%begin 1 11 1\n%output looks like output\n\x1b[31mline2\n%end 1 99 1\n%end 1 11 1\n');
  c.feed('%begin 1 12 1\nboom\n%error 1 12 1\n');
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], ['cap', null, ['%output looks like output', '\x1b[31mline2', '%end 1 99 1']]);
  assert.equal(got[1][0], 'disp');
  assert.match(got[1][1].message, /boom/);
  assert.deepEqual(c.written, ['capture-pane -p\n', 'display-message -p x\n']);
});

test('keystrokes are batched into send-keys -H with hex bytes', async () => {
  const c = fakeClient('%4');
  c.sendBytes(Buffer.from('h'));
  c.sendBytes(Buffer.from('ü\r'));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(c.written, ['send-keys -t %4 -H 68 c3 bc 0d\n']);
});

test('exit reason is captured and pending commands fail when the client closes', () => {
  const c = fakeClient();
  let err;
  c.command('x', (e) => (err = e));
  let closed;
  c.on('close', (info) => (closed = info));
  c.feed('%exit server exited\n');
  c._closed({ code: 0 });
  assert.equal(closed.reason, 'server exited');
  assert.match(err.message, /closed/);
});
