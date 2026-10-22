import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  channelLabel,
  groupForDisplay,
  mergeDonna,
  mergeMessages,
  newLocalItem,
  nextCursor,
  pruneLocal,
  reconcilePending,
  toolDisplay,
  toolLine,
  type PendingMessage,
} from '../../src/chat';
import type { ChatMessage, DonnaMessage } from '../../src/types';

const msg = (n: number, role: 'user' | 'assistant', text: string): ChatMessage => ({ n, role, text, tools: [], ts: null });
const pending = (id: string, text: string, afterN: number | null, state: PendingMessage['state'] = 'sent'): PendingMessage => ({
  id,
  text,
  state,
  afterN,
  createdAt: 0,
});

describe('session messages', () => {
  it('merges pages by n without duplicates, in order', () => {
    const a = [msg(1, 'user', 'a'), msg(2, 'assistant', 'b')];
    const merged = mergeMessages(a, [msg(2, 'assistant', 'b (edited)'), msg(4, 'user', 'd'), msg(3, 'assistant', 'c')]);
    assert.deepEqual(merged.map((m) => m.n), [1, 2, 3, 4]);
    assert.equal(merged[1].text, 'b (edited)');
    assert.equal(mergeMessages(a, []), a, 'an empty page keeps the same array (no re-render)');
  });

  it('advances the cursor to the furthest known point', () => {
    assert.equal(nextCursor(null, [], null), null);
    assert.equal(nextCursor(7, [msg(5, 'user', 'x')], 3), 7);
    assert.equal(nextCursor(null, [msg(5, 'user', 'x')], 3), 5);
    assert.equal(nextCursor(2, [], 9), 9);
  });

  it('confirms a sent message when the server echoes it after the send', () => {
    const p = [pending('p1', 'ship it', 4)];
    assert.deepEqual(reconcilePending(p, [msg(3, 'user', 'ship it')]), p, 'an older identical message is not the echo');
    assert.deepEqual(reconcilePending(p, [msg(5, 'user', '  ship   it ')]), [], 'whitespace differences still match');
  });

  it('matches each echo to one pending message, oldest first', () => {
    const p = [pending('p1', 'ok', 2), pending('p2', 'ok', 2)];
    const left = reconcilePending(p, [msg(3, 'user', 'ok')]);
    assert.deepEqual(left.map((x) => x.id), ['p2']);
  });

  it('never drops a failed message on its own', () => {
    const p = [pending('p1', 'retry me', 1, 'failed')];
    assert.deepEqual(reconcilePending(p, [msg(2, 'user', 'retry me')]), p);
  });
});

describe('display grouping', () => {
  const tool = (n: number, name: string): ChatMessage => ({ n, role: 'assistant', text: '', tools: [{ name, summary: name.toLowerCase() }], ts: `t${n}` });
  it('folds a run of tool-only lines into the next reply, keeping the first key', () => {
    const shown = groupForDisplay([msg(0, 'user', 'fix it'), msg(1, 'assistant', 'Looking.'), tool(2, 'Grep'), tool(3, 'Read'), msg(4, 'assistant', 'Fixed.')]);
    assert.deepEqual(
      shown.map((m) => [m.key, m.role, m.text, m.tools.map((t) => t.name)]),
      [
        ['n0', 'user', 'fix it', []],
        ['n1', 'assistant', 'Looking.', []],
        ['n2', 'assistant', 'Fixed.', ['Grep', 'Read']],
      ],
    );
  });

  it('keeps a trailing run (still working) and a run before a user message as tool-only rows', () => {
    const a = groupForDisplay([msg(0, 'user', 'go'), tool(1, 'Bash'), tool(2, 'Edit')]);
    assert.deepEqual(a.map((m) => [m.key, m.text, m.tools.length]), [['n0', 'go', 0], ['n1', '', 2]]);
    const b = groupForDisplay([tool(0, 'Bash'), msg(1, 'user', 'stop')]);
    assert.deepEqual(b.map((m) => [m.key, m.role]), [['n0', 'assistant'], ['n1', 'user']]);
  });
});

describe('tool lines', () => {
  it('prefers the summary, falls back to the tool name', () => {
    assert.equal(toolLine({ name: 'Bash', summary: 'npm test' }), 'Ran: npm test');
    assert.equal(toolLine({ name: 'Read', summary: '' }), 'Ran: Read');
    assert.equal(toolLine({ name: '', summary: '' }), 'Ran: a tool');
  });

  it('shows up to two lines, collapses longer runs', () => {
    const tools = [
      { name: 'Grep', summary: 'search pricing' },
      { name: 'Read', summary: 'Read Nav.tsx' },
      { name: 'Edit', summary: 'Edit Nav.tsx' },
    ];
    assert.deepEqual(toolDisplay(tools.slice(0, 2), false), { lines: ['Ran: search pricing', 'Ran: Read Nav.tsx'], toggle: null });
    assert.deepEqual(toolDisplay(tools, false), { lines: ['Ran: search pricing'], toggle: '2 more steps' });
    assert.deepEqual(toolDisplay(tools, true).toggle, 'Show less');
    assert.equal(toolDisplay(tools, true).lines.length, 3);
    assert.deepEqual(toolDisplay([], false), { lines: [], toggle: null });
    assert.deepEqual(toolDisplay(tools.concat(tools[0]), false).toggle, '3 more steps');
  });
});

describe('Donna local echo', () => {
  const s = (role: 'user' | 'donna', text: string, channel = 'app'): DonnaMessage => ({ role, text, ts: '2026-10-22T10:00:00Z', channel });

  it('shows a sent message until the server has it, then only the server copy', () => {
    const server: DonnaMessage[] = [];
    const item = newLocalItem(server, [], 'user', 'plan my week', 'sending', 1000);
    const before = mergeDonna(server, [item]);
    assert.equal(before.rows.length, 1);
    assert.equal(before.rows[0].state, 'sending');
    const after = mergeDonna([s('user', 'plan my week')], [item]);
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].state, undefined);
    assert.equal(after.local.length, 0);
  });

  it('an older identical message never swallows a new one', () => {
    const server = [s('user', 'ok'), s('donna', 'Done.')];
    const item = newLocalItem(server, [], 'user', 'ok', 'sending');
    assert.equal(item.expect, 2);
    assert.equal(pruneLocal(server, [item]).length, 1);
    assert.equal(pruneLocal([...server, s('user', 'ok')], [item]).length, 0);
  });

  it('two quick identical messages wait for two echoes', () => {
    const a = newLocalItem([], [], 'user', 'yes', 'sent');
    const b = newLocalItem([], [a], 'user', 'yes', 'sending');
    assert.equal(b.expect, 2);
    assert.deepEqual(pruneLocal([s('user', 'yes')], [a, b]).map((x) => x.id), [b.id]);
    assert.deepEqual(pruneLocal([s('user', 'yes'), s('user', 'yes')], [a, b]), []);
  });

  it('labels outside channels only', () => {
    assert.equal(channelLabel('telegram'), 'via Telegram');
    assert.equal(channelLabel('imessage'), 'via iMessage');
    assert.equal(channelLabel('app'), null);
    assert.equal(channelLabel(null), null);
    assert.equal(channelLabel('slack'), 'via slack');
  });
});
