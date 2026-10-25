// "An agent needs you" (CS-21, CS-22): the opt-in line to the paired Telegram chat, end to end with
// the Telegram stub and the fake claude. Off by default; names the agent and the kind of wait, never
// what was asked; nothing when the question is answered first; rate-limited per session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startTelegramStub } from '../fixtures/telegram-stub.mjs';
import { cli, killTmux, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

const TOKEN = '123456789:TEST_token_abcdefghijklmnopqrstu';
const OWNER_CHAT = 3003;
let home;
let socket;
let srv;
let stub;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  stub = await startTelegramStub({ token: TOKEN });
  const configDir = path.join(home, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  const env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, TELEGRAM_API_BASE: stub.url, CLAWDLING_TELEGRAM_POLL_TIMEOUT: '1', CLAUDE_CONFIG_DIR: configDir, CLAWDLING_PING_DELAY_MS: '3000' });
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
  const conf = await request(srv, 'POST', '/api/channels/telegram', { token: TOKEN });
  stub.message(OWNER_CHAT, `/pair ${conf.body.pairing_code}`);
  await waitFor(() => stub.sent(OWNER_CHAT).some((c) => /Paired/.test(c.params.text)), { label: 'paired', timeout: 15000 });
});

after(async () => {
  await srv?.stop();
  await stub?.close();
  killTmux(socket);
  rmrf(home);
});

const pings = () => stub.sent(OWNER_CHAT).map((c) => c.params.text).filter((t) => t.startsWith('Clawdling:'));
const view = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body;
async function ready(agent, title) {
  const s = (await request(srv, 'POST', '/api/sessions', { agent, title })).body;
  await waitFor(async () => (await view(s.sid)).status === 'ready', { label: 'ready', timeout: 20000 });
  return s;
}
const send = (sid, text) => request(srv, 'POST', `/api/sessions/${sid}/send`, { text });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('off by default: a session waiting on you sends nothing', async () => {
  const off = (await request(srv, 'GET', '/api/notify')).body;
  assert.deepEqual([off.needs_you, off.channel, off.labels], [false, 'telegram', {}]);
  assert.equal(off.preview_labels.health, 'Health', 'the names turning it on would approve');
  const s = await ready('work', 'quiet');
  await send(s.sid, 'permission? now');
  await waitFor(async () => (await view(s.sid)).status === 'needs_you', { label: 'needs you' });
  await sleep(4000);
  assert.deepEqual(pings(), []);
  await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 3 });
});

test('on: one line naming the agent and the kind of wait, never the question; once per session', async () => {
  assert.equal((await request(srv, 'POST', '/api/notify', { needs_you: 'yes' })).status, 400);
  const on = (await request(srv, 'POST', '/api/notify', { needs_you: true })).body;
  assert.equal(on.needs_you, true);
  assert.equal(on.channel, 'telegram');
  assert.equal(on.labels.health, 'Health', 'the names the owner sees now are the approved labels');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.clawdling', 'notify.json'), 'utf8')).needs_you, true, 'kept where agents cannot edit it');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'org.json'), 'utf8')).notify, undefined);
  const s = await ready('health', 'colors');
  await send(s.sid, 'ask? colors');
  await waitFor(() => pings().length === 1, { label: 'a ping', timeout: 15000 });
  assert.deepEqual(pings(), ['Clawdling: Health needs you (a question). Open the cockpit to answer.']);
  assert.ok(!pings()[0].includes('color'), 'the question itself never leaves the computer');
  // Answer, ask again: within 10 minutes the same session pings no more.
  const v = await view(s.sid);
  await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { tool_id: v.asking.tool_id, answers: [{ choices: [0] }] });
  await waitFor(async () => (await view(s.sid)).status === 'ready', { label: 'answered' });
  await send(s.sid, 'permission? again');
  await waitFor(async () => (await view(s.sid)).status === 'needs_you', { label: 'needs you again' });
  await sleep(4000);
  assert.equal(pings().length, 1);
  await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 3 });
});

test('answered within the delay: nothing is sent', async () => {
  const s = await ready('work', 'fast');
  const before = pings().length;
  await send(s.sid, 'permission? quick');
  await waitFor(async () => (await view(s.sid)).choices, { label: 'choices' });
  await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 1 });
  await sleep(4000);
  assert.equal(pings().length, before);
});

test('turned off again: nothing more', async () => {
  assert.equal((await request(srv, 'POST', '/api/notify', { needs_you: false })).body.needs_you, false);
  const s = await ready('work', 'off again');
  const before = pings().length;
  await send(s.sid, 'permission? off');
  await waitFor(async () => (await view(s.sid)).status === 'needs_you', { label: 'needs you' });
  await sleep(4000);
  assert.equal(pings().length, before);
  await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 3 });
});
