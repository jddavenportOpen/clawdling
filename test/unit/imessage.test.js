// iMessage gateway against a fixture chat.db and a stub osascript. Never touches Messages.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { IMessageGateway, SEND_SCRIPT, decodeAttributedBody, normalizeHandle, osascriptArgs, pollSql, validHandle } from '../../server/channels/imessage.js';
import { EventBus } from '../../server/events.js';
import { OrgStore, initOrg } from '../../server/org.js';
import { runtimePaths } from '../../server/paths.js';
import { FAKE_OSASCRIPT, rmrf, tempHome, waitFor } from '../helpers.mjs';

const SQLITE = '/usr/bin/sqlite3';
const hasSqlite = fs.existsSync(SQLITE);
const NASTY_REPLY = 'Health is on it. "); do shell script "rm -rf ~" -- \\ $(id) `id` \u{1F680}';

function attributedBody(text) {
  const t = Buffer.from(text, 'utf8');
  const head = Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+', 'latin1');
  const len = t.length < 0x80 ? Buffer.from([t.length]) : Buffer.from([0x81, t.length & 0xff, t.length >> 8]);
  return Buffer.concat([head, len, t, Buffer.from('\x86\x84\x02iI\x01', 'latin1')]);
}

test('helpers: handles, AppleScript argv, attributedBody, SQL', () => {
  assert.equal(normalizeHandle('+1 (555) 010-0001'), '5550100001');
  assert.equal(normalizeHandle('15550100001'), '5550100001');
  assert.equal(normalizeHandle('Owner@Example.COM'), 'owner@example.com');
  assert.ok(validHandle('+44 7700 900123'));
  assert.ok(validHandle('me@example.com'));
  assert.ok(!validHandle('"; drop table'));
  const args = osascriptArgs('+15550100001', NASTY_REPLY);
  assert.deepEqual(args.slice(-3), ['--', '+15550100001', NASTY_REPLY], 'text is an argv item, after the script and "--"');
  assert.ok(!validHandle('-e'), 'a handle never starts with "-" (osascript would read it as an option)');
  assert.ok(!validHandle('-12345'));
  assert.ok(validHandle('(555) 010-0001'));
  assert.equal(args.filter((a) => a === '-e').length, SEND_SCRIPT.length);
  assert.ok(SEND_SCRIPT.every((l) => !l.includes('rm -rf')));
  assert.equal(decodeAttributedBody(attributedBody('hello from the blob').toString('hex')), 'hello from the blob');
  const long = 'x'.repeat(300);
  assert.equal(decodeAttributedBody(attributedBody(long).toString('hex')), long);
  assert.equal(decodeAttributedBody('00ff'), null);
  assert.match(pollSql(41), /ROWID > 41 AND m.is_from_me = 0/);
  assert.match(pollSql('1; DROP TABLE message'), /ROWID > 0 /);
});

let home;
let db;
let osaLog;
let gw;
const asked = [];

before(() => {
  if (!hasSqlite) return;
  home = tempHome();
  initOrg({ home, answers: { owner: 'Ada', domains: [{ name: 'Health' }] } });
  db = path.join(home, 'chat.db');
  osaLog = path.join(home, 'osascript.log');
  execFileSync(SQLITE, [db], {
    input:
      'CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);' +
      'CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, handle_id INTEGER, is_from_me INTEGER, date INTEGER, service TEXT, attributedBody BLOB);' +
      "INSERT INTO handle VALUES (1, '+15550100001', 'iMessage'), (2, '+15550109999', 'iMessage');" +
      "INSERT INTO message VALUES (1, 'old history, never replay', 1, 0, 0, 'iMessage', NULL);",
  });
  const paths = runtimePaths(home);
  const env = { CLAWDLING_TEST: '1', CLAWDLING_CHATDB_PATH: db, CLAWDLING_OSASCRIPT_BIN: FAKE_OSASCRIPT, CLAWDLING_IMESSAGE_POLL_MS: '600000', FAKE_OSASCRIPT_LOG: osaLog };
  process.env.FAKE_OSASCRIPT_LOG = osaLog; // the stub reads it from its own env
  const donna = { handle: async ({ channel, text }) => (asked.push({ channel, text }), NASTY_REPLY) };
  gw = new IMessageGateway({ paths, org: new OrgStore(paths), donna, events: new EventBus({ file: paths.events }), env, platform: 'darwin' });
});

after(() => {
  gw?.stop();
  delete process.env.FAKE_OSASCRIPT_LOG;
  if (home) rmrf(home);
});

test('poller: starts from now, routes only the owner, replies via osascript argv', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  await assert.rejects(gw.configure({ handle: 'not a handle', enabled: true }), /email address or phone/);
  await gw.configure({ handle: '+1 (555) 010-0001', enabled: true });
  gw.stop(); // drive polls by hand from here
  const stateFile = runtimePaths(home).imessageState;
  await waitFor(() => fs.existsSync(stateFile) && !gw.polling, { label: 'first poll' });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).last_rowid, 1, 'first poll only records where history ends');
  assert.equal(asked.length, 0, 'history is never replayed');
  const blob = attributedBody('via attributed body').toString('hex');
  execFileSync(SQLITE, [db], {
    input:
      "INSERT INTO message VALUES (2, 'hello donna', 1, 0, 0, 'iMessage', NULL);" +
      "INSERT INTO message VALUES (3, 'stranger says hi', 2, 0, 0, 'iMessage', NULL);" +
      "INSERT INTO message VALUES (4, 'my own outgoing text', 1, 1, 0, 'iMessage', NULL);" +
      `INSERT INTO message VALUES (5, NULL, 1, 0, 0, 'iMessage', X'${blob}');`,
  });
  assert.equal(await gw.poll(), 2);
  assert.deepEqual(asked, [{ channel: 'imessage', text: 'hello donna' }, { channel: 'imessage', text: 'via attributed body' }]);
  const calls = fs.readFileSync(osaLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  for (const argv of calls) {
    assert.equal(argv.at(-1), NASTY_REPLY, 'reply passed verbatim as the last argument');
    assert.equal(argv.at(-2), '+1 (555) 010-0001');
    assert.equal(argv.at(-3), '--');
    for (let i = 0; i < argv.length - 3; i += 2) {
      assert.equal(argv[i], '-e');
      assert.ok(!argv[i + 1].includes('rm -rf'), 'reply text never spliced into script source');
    }
  }
  assert.equal(gw.verifiedHandle(), '+1 (555) 010-0001', 'a message from the handle proves it (kept in server-only state)');
  assert.equal(await gw.poll(), 0, 'nothing new');
  const st = JSON.parse(fs.readFileSync(runtimePaths(home).imessageState, 'utf8'));
  assert.equal(st.last_rowid, 5);
});

test('test mode refuses the real Messages database and osascript', () => {
  const g = new IMessageGateway({ paths: runtimePaths('/nonexistent'), org: null, donna: null, events: null, env: { CLAWDLING_TEST: '1' }, platform: 'darwin' });
  assert.match(g.blockedReason(), /test mode/);
  return assert.rejects(g.send('+15550100001', 'x'), /test mode/);
});

test('unsupported off macOS', () => {
  const g = new IMessageGateway({ paths: runtimePaths('/nonexistent'), org: null, donna: null, events: null, env: {}, platform: 'linux' });
  assert.equal(g.supported(), false);
});

test('start() polls on an interval once enabled', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  gw.pollMs = 50;
  gw.start();
  execFileSync(SQLITE, [db], { input: "INSERT INTO message VALUES (6, 'second wave', 1, 0, 0, 'iMessage', NULL);" });
  await waitFor(() => asked.some((a) => a.text === 'second wave'), { label: 'interval poll' });
  gw.stop();
});
