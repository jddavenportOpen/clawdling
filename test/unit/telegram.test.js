// Telegram gateway against a local stub Bot API, with Donna stubbed out.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { TelegramGateway, chunkText } from '../../server/channels/telegram.js';
import { EventBus } from '../../server/events.js';
import { OrgStore, initOrg } from '../../server/org.js';
import { runtimePaths } from '../../server/paths.js';
import { startTelegramStub } from '../fixtures/telegram-stub.mjs';
import { rmrf, tempHome, waitFor } from '../helpers.mjs';

const TOKEN = '987654321:UNIT_token_abcdefghijklmnopqrstu';
const OWNER = 501;
let home;
let stub;
let gw;
const logs = [];
const asked = [];

before(async () => {
  home = tempHome();
  initOrg({ home, answers: { owner: 'Ada', domains: [{ name: 'Work' }] } });
  stub = await startTelegramStub({ token: TOKEN });
  const paths = runtimePaths(home);
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const donna = {
    handle: async ({ channel, text }) => {
      asked.push({ channel, text });
      if (text === 'long') return `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}\n${'c'.repeat(2500)}`;
      if (text === 'fail') throw new Error('claude is not signed in');
      return `echo: ${text}`;
    },
  };
  gw = new TelegramGateway({ paths, org: new OrgStore(paths), donna, events: new EventBus({ file: paths.events, logger }), logger, apiBase: stub.url, pollTimeoutSec: 1 });
});

after(async () => {
  gw?.stop();
  await stub?.close();
  rmrf(home);
});

test('chunkText splits at paragraph, line or word boundaries under 4000 chars', () => {
  assert.deepEqual(chunkText('short'), ['short']);
  const parts = chunkText(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`);
  assert.deepEqual(parts, ['a'.repeat(3000), 'b'.repeat(3000)]);
  const words = chunkText(('word '.repeat(2000)).trim());
  assert.ok(words.every((p) => p.length <= 4000));
  assert.equal(words.join(' '), ('word '.repeat(2000)).trim());
  assert.ok(chunkText('x'.repeat(9000)).every((p) => p.length <= 4000));
});

test('rejects tokens that are not bot tokens', async () => {
  await assert.rejects(gw.configure({ token: 'not a token' }), /BotFather/);
});

test('pairing: only a private chat with the current code pairs; brute force burns the code', async () => {
  const { pairing_code: code } = await gw.configure({ token: TOKEN });
  assert.match(code, /^\d{6}$/);
  await waitFor(() => gw.running, { label: 'polling' });
  stub.message(-100, `/pair ${code}`, { type: 'group' });
  for (let i = 0; i < 5; i++) stub.message(666, `/pair ${String((Number(code) + 1 + i) % 1000000).padStart(6, '0')}`);
  stub.message(666, `/pair ${code}`); // right code, but the 5 wrong guesses already burned it
  await waitFor(() => stub.calls.filter((c) => c.method === 'getUpdates').length >= 3, { label: 'updates consumed' });
  await waitFor(() => !gw.pendingPairing(), { label: 'code burned', timeout: 5000 });
  assert.equal(gw.status().paired, false);
  assert.equal(stub.sent().length, 0, 'nobody got a reply');

  const fresh = (await gw.configure({ pair: true })).pairing_code;
  assert.match(fresh, /^\d{6}$/);
  stub.message(OWNER, `/pair@clawdling_test_bot ${fresh}`);
  await waitFor(() => stub.sent(OWNER).length === 1, { label: 'paired reply' });
  assert.match(stub.sent(OWNER)[0].params.text, /Paired/);
  const st = gw.status();
  assert.equal(st.paired, true);
  assert.equal(st.chat_id_masked, '•••501');
  assert.equal(st.bot_username, 'clawdling_test_bot');
});

test('paired chat: messages go to Donna, typing shown, long replies chunked; strangers ignored', async () => {
  stub.message(777, 'hello from a stranger');
  stub.message(OWNER, 'hi donna');
  await waitFor(() => stub.sent(OWNER).some((c) => c.params.text === 'echo: hi donna'), { label: 'reply' });
  assert.ok(stub.calls.some((c) => c.method === 'sendChatAction' && c.params.chat_id === OWNER));
  assert.equal(stub.sent(777).length, 0);
  assert.ok(!asked.some((a) => a.text === 'hello from a stranger'), 'strangers never reach Donna');
  assert.equal(asked.find((a) => a.text === 'hi donna').channel, 'telegram');

  const before = stub.sent(OWNER).length;
  stub.message(OWNER, 'long');
  await waitFor(() => stub.sent(OWNER).length >= before + 3, { label: 'chunks' });
  const chunks = stub.sent(OWNER).slice(before).map((c) => c.params.text);
  assert.ok(chunks.every((t) => t.length <= 4000));
  assert.equal(chunks.join(''), 'a'.repeat(3000) + 'b'.repeat(3000) + 'c'.repeat(2500));

  stub.message(OWNER, 'fail');
  await waitFor(() => stub.sent(OWNER).some((c) => c.params.text === 'Donna hit an error: claude is not signed in'), { label: 'error reply' });
  assert.ok(!logs.some((l) => l.includes(TOKEN)), 'the bot token never appears in logs');
});

test('disabling stops routing even for the paired chat', async () => {
  await gw.configure({ enabled: false });
  const n = asked.length;
  stub.message(OWNER, 'are you there?');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(asked.length, n);
});
