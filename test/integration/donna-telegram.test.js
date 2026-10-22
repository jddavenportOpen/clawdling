// End to end: a Telegram message to Donna becomes a live health session.
// Stub Bot API -> pairing -> Donna headless turn (fake claude -p) -> `clawdling spawn health ...`
// through the real CLI -> new live session in tmux -> reply to the paired chat only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startTelegramStub } from '../fixtures/telegram-stub.mjs';
import { cli, killTmux, readJsonFile, readLog, request, rmrf, startServerProc, tempHome, testEnv, tmuxHas, uniqueSocket, waitFor } from '../helpers.mjs';

const TOKEN = '123456789:TEST_token_abcdefghijklmnopqrstu';
const OWNER_CHAT = 1001;
const STRANGER_CHAT = 2002;
let home;
let socket;
let srv;
let stub;
let fakeLog;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  fakeLog = path.join(home, 'fake-claude.log');
  stub = await startTelegramStub({ token: TOKEN });
  const env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, FAKE_CLAUDE_LOG: fakeLog, TELEGRAM_API_BASE: stub.url, CLAWDLING_TELEGRAM_POLL_TIMEOUT: '1' });
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  await stub?.close();
  killTmux(socket);
  rmrf(home);
});

test('pair, ignore strangers, route "can the health agent look at my sleep" to a new health session', async () => {
  const conf = await request(srv, 'POST', '/api/channels/telegram', { token: TOKEN });
  assert.equal(conf.status, 200, conf.text);
  const code = conf.body.pairing_code;
  assert.match(code, /^\d{6}$/);
  assert.equal(conf.body.configured, true);
  assert.equal(readJsonFile(path.join(home, '.clawdling', 'telegram.json')).pairing.code, code);
  assert.ok(!JSON.stringify(conf.body).includes(TOKEN), 'the bot token is never echoed back');

  const wrong = code === '000000' ? '111111' : '000000';
  stub.message(STRANGER_CHAT, `/pair ${wrong}`);
  stub.message(OWNER_CHAT, `/pair ${code}`);
  await waitFor(() => stub.sent(OWNER_CHAT).some((c) => /Paired/.test(c.params.text)), { label: 'pairing reply', timeout: 15000 });
  const org = readJsonFile(path.join(home, 'org.json'));
  assert.equal(org.channels.telegram.chat_id, OWNER_CHAT);
  assert.equal(org.channels.telegram.enabled, true);
  const ch = (await request(srv, 'GET', '/api/channels')).body;
  assert.equal(ch.telegram.paired, true);
  assert.equal(ch.telegram.chat_id_masked, '•••1001');
  assert.equal(ch.telegram.pairing_code, null);

  // A stranger who learns the code later gets nothing.
  stub.message(STRANGER_CHAT, `/pair ${code}`);
  stub.message(STRANGER_CHAT, 'can the health agent look at my sleep');
  stub.message(OWNER_CHAT, 'can the health agent look at my sleep');
  await waitFor(() => stub.sent(OWNER_CHAT).some((c) => c.params.text === 'Health agent is on it.'), { label: 'Donna reply', timeout: 30000 });

  const sessions = (await request(srv, 'GET', '/api/sessions')).body;
  const health = sessions.filter((s) => s.agent === 'health' && s.status !== 'ended');
  assert.equal(health.length, 1, 'exactly one new live health session (the stranger did not trigger one)');
  assert.equal(health[0].title, 'Can the health agent look at my sleep');
  assert.ok(tmuxHas(socket, health[0].tmux_name), 'the health session is a live tmux session');
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${health[0].sid}`)).body.status === 'ready', { label: 'health session ready' });

  assert.equal(stub.sent(STRANGER_CHAT).length, 0, 'strangers never get a reply');
  assert.ok(stub.calls.some((c) => c.method === 'sendChatAction' && c.params.chat_id === OWNER_CHAT && c.params.action === 'typing'));

  const turn = readLog(fakeLog).find((e) => e.mode === 'print');
  assert.ok(turn, 'Donna ran a headless turn');
  assert.equal(turn.cwd, path.join(home, 'donna'));
  assert.equal(turn.env.CLAWDLING_DONNA, '1');
  assert.equal(turn.opts.permissionMode, 'dontAsk');
  assert.equal(turn.opts.settingSources, 'project,local', "the owner's user settings are not loaded into Donna's turns");
  assert.equal(turn.opts.strictMcpConfig, true, 'no MCP servers');
  assert.ok(turn.opts.allowedTools.includes('Bash(clawdling spawn *)'));
  assert.ok(!turn.opts.allowedTools.some((t) => t === 'Bash' || t === 'Bash(*)'), 'no arbitrary shell');
  assert.ok(turn.opts.sessionId, 'first Donna turn uses --session-id');
  const after1 = readJsonFile(path.join(home, 'org.json'));
  assert.equal(after1.donna_session, turn.opts.sessionId, 'Donna session id is persisted');

  // A second message resumes Donna's session.
  stub.message(OWNER_CHAT, 'thanks');
  await waitFor(() => stub.sent(OWNER_CHAT).some((c) => /^Noted: thanks/.test(c.params.text)), { label: 'second reply', timeout: 30000 });
  const turns = readLog(fakeLog).filter((e) => e.mode === 'print');
  assert.equal(turns[turns.length - 1].opts.resume, after1.donna_session);

  // Errors come back as a short message, not silence.
  stub.message(OWNER_CHAT, 'please explode');
  await waitFor(() => stub.sent(OWNER_CHAT).some((c) => /^Donna hit an error: /.test(c.params.text)), { label: 'error reply', timeout: 30000 });

  const log = (await request(srv, 'GET', '/api/channels')).body.recent;
  assert.ok(log.some((e) => e.direction === 'in' && e.text === 'can the health agent look at my sleep'));
  assert.ok(log.some((e) => e.direction === 'out' && e.text === 'Health agent is on it.'));
  assert.ok(!log.some((e) => JSON.stringify(e).includes(TOKEN)));
});
