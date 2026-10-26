// Question cards and Watching, end to end on the real server with the fake claude (both backends).
// The fake draws AskUserQuestion and plan approval the way Claude Code 2.1.283 does (see
// test/fake-claude.mjs), writes the same transcript lines, and sends the same Notification
// ("permission_prompt"). Answers go through POST /api/sessions/:sid/answer, the route that already
// answers dialogs; the card's form is {tool_id, answers}, a plan's is {option, text?}.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, killTmux, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let srv;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  const configDir = path.join(home, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  const env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, CLAUDE_CONFIG_DIR: configDir, FAKE_CLAUDE_LOG: path.join(home, 'fake.log') });
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
});

const view = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body;
const messages = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}/messages`)).body.messages;
const until = (sid, pred, label, timeout = 15000) => waitFor(async () => {
  const v = await view(sid);
  return pred(v) ? v : null;
}, { label, timeout });

async function session(title) {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'work', title })).body;
  await until(s.sid, (v) => v.status === 'ready', 'ready');
  return s;
}
const send = (sid, text) => request(srv, 'POST', `/api/sessions/${sid}/send`, { text });
const answer = (sid, body) => request(srv, 'POST', `/api/sessions/${sid}/answer`, body);

function findJsonl(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) out.push(p); } };
  walk(path.join(dir, 'projects'));
  return out;
}

test('a question: the card has it (question, options, descriptions) and answering picks the option', async () => {
  const s = await session('question');
  await send(s.sid, 'ask? pick one');
  const v = await until(s.sid, (x) => x.asking, 'asking');
  assert.equal(v.status, 'needs_you');
  assert.equal(v.asking.kind, 'question');
  assert.match(v.notification, /^Claude asks: Which color do you like best\?/);
  // The card comes from the PreToolUse hook: the transcript has no line for it yet (as in 2.1.283).
  assert.equal((await messages(s.sid)).flatMap((m) => m.tools || []).find((t) => t.ask), undefined);
  assert.deepEqual(v.asking.card.questions[0].options.map((o) => o.label), ['Red', 'Green', 'Blue']);
  assert.equal(v.asking.card.questions[0].options[1].description, 'A calm, natural color.');

  // Wrong id, bad shapes: refused, nothing typed.
  assert.equal((await answer(s.sid, { tool_id: 'toolu_other', answers: [{ choices: [0] }] })).status, 409);
  assert.equal((await answer(s.sid, { tool_id: v.asking.tool_id, answers: [{ choices: [7] }] })).status, 400);
  assert.equal((await answer(s.sid, { tool_id: v.asking.tool_id, answers: [{ choices: [0, 1] }] })).status, 400);

  const r = await answer(s.sid, { tool_id: v.asking.tool_id, answers: [{ choices: [2] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.answered.answers, ['Blue']);
  const done = await until(s.sid, (x) => x.status === 'ready', 'turn done');
  assert.equal(done.last_message, 'you chose Blue');
  assert.equal(done.asking, null);
  const after = await messages(s.sid);
  assert.equal(after.flatMap((m) => m.tools || []).find((t) => t.ask)?.id, v.asking.tool_id, 'the transcript has it once answered');
  const ans = after.find((m) => m.role === 'answer');
  assert.deepEqual(ans.answers, { 'Which color do you like best?': 'Blue' });
  assert.equal(ans.tool_id, v.asking.tool_id);
});

test('a question answered with typed text ("Type something")', async () => {
  const s = await session('typed');
  await send(s.sid, 'ask? type one');
  const v = await until(s.sid, (x) => x.asking, 'asking');
  const r = await answer(s.sid, { tool_id: v.asking.tool_id, answers: [{ text: 'Ultraviolet' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const done = await until(s.sid, (x) => x.status === 'ready', 'turn done');
  assert.equal(done.last_message, 'you chose Ultraviolet');
});

test('two questions, the second multiSelect: ticks, Submit, then the review', async () => {
  const s = await session('two');
  await send(s.sid, 'ask2? both');
  const v = await until(s.sid, (x) => x.asking, 'asking');
  assert.equal(v.asking.questions, 2);
  assert.equal((await answer(s.sid, { tool_id: v.asking.tool_id, answers: [{ choices: [0] }, { text: 'Hamster' }] })).status, 400, 'multiSelect takes options only');
  const r = await answer(s.sid, { tool_id: v.asking.tool_id, answers: [{ choices: [0] }, { choices: [2, 0] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.answered.answers, ['Red', 'Cat, Fish']);
  const done = await until(s.sid, (x) => x.status === 'ready', 'turn done');
  assert.equal(done.last_message, 'you chose Red / Cat, Fish');
});

test('a plan: approve, or send it back with what to change', async () => {
  const s = await session('plan');
  await send(s.sid, 'plan? first');
  let v = await until(s.sid, (x) => x.asking && x.choices, 'plan asking with choices');
  assert.equal(v.asking.kind, 'plan');
  assert.match(v.notification, /plan ready/);
  assert.deepEqual(v.choices.map((c) => c.label.replace(/\s+shift\+tab.*$/, '')), ['1. Yes, auto-accept edits', '2. Yes, manually approve edits', '3. Tell Claude what to change']);
  assert.match(v.asking.card.plan, /Write hi into it/);
  assert.equal((await answer(s.sid, { option: 2, text: 'nope' })).status, 400, 'text only goes with "Tell Claude what to change"');
  let r = await answer(s.sid, { option: 3, text: 'Add a step that prints it' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let done = await until(s.sid, (x) => x.status === 'ready', 'turn done');
  assert.equal(done.last_message, 'plan feedback: Add a step that prints it');
  const fb = (await messages(s.sid)).filter((m) => m.role === 'answer').pop();
  assert.deepEqual([fb.kind, fb.feedback], ['plan', 'Add a step that prints it']);

  await send(s.sid, 'plan? again');
  v = await until(s.sid, (x) => x.asking && x.choices, 'plan asking again');
  r = await answer(s.sid, { option: 2 });
  assert.equal(r.status, 200);
  done = await until(s.sid, (x) => x.status === 'ready', 'turn done');
  assert.equal(done.last_message, 'plan approved (Yes, manually approve edits)');
  assert.equal((await messages(s.sid)).filter((m) => m.role === 'answer').pop().approved, true);
});

test('Claude Code 2.1.308 (issue #21): an empty ExitPlanMode still shows the plan, from the plan file', async () => {
  const s = await session('plan from its file');
  await send(s.sid, 'planfile? go');
  const v = await until(s.sid, (x) => x.asking && x.asking.kind === 'plan' && x.choices, 'plan asking');
  assert.match(v.asking.card.plan, /Write hi into it/, 'the card (from the hook) shows the plan file');
  assert.equal((await answer(s.sid, { option: 2 })).status, 200);
  await until(s.sid, (x) => x.status === 'ready', 'turn done');
  const t = (await messages(s.sid)).flatMap((m) => m.tools || []).find((x) => x.name === 'ExitPlanMode');
  assert.match(t.ask.plan, /Write hi into it/, 'the chat card (from the transcript) shows it too');
  // It really was the 2.1.308 shape: the ExitPlanMode in the transcript has an empty input.
  // This session's transcript only (other tests' plans share the config folder).
  const mine = findJsonl(path.join(home, 'claude-config')).map((f) => fs.readFileSync(f, 'utf8')).filter((t) => t.includes('planfile? go'));
  assert.equal(mine.length, 1);
  const lines = mine[0].trim().split('\n').map((l) => JSON.parse(l));
  const exit = lines.flatMap((o) => o.message?.content || []).filter((b) => b?.name === 'ExitPlanMode').pop();
  assert.deepEqual(exit.input, {});
});

test('a plan sent back, then a tool permission in the same turn: no card for it, and the plan card cannot press it', async () => {
  const s = await session('plan then bash');
  await send(s.sid, 'planperm? go');
  const v = await until(s.sid, (x) => x.asking?.kind === 'plan' && x.choices, 'plan');
  const plan = v.asking.tool_id;
  assert.equal((await answer(s.sid, { option: 3, text: 'Change it', tool_id: plan })).status, 200);
  // The Bash prompt that follows: Claude Code sent no PostToolUse for the rejected plan.
  const b = await until(s.sid, (x) => x.status === 'needs_you' && x.notification === 'Claude needs your permission to use Bash' && x.choices, 'bash prompt');
  await new Promise((r) => setTimeout(r, 4000)); // every ask-detection attempt has had its chance
  assert.equal((await view(s.sid)).asking, null, 'not dressed up as the old plan');
  assert.equal((await answer(s.sid, { option: 1, tool_id: plan })).status, 409, 'the plan card cannot approve Bash');
  assert.equal((await answer(s.sid, { option: 1, text: 'x', tool_id: plan })).status, 409);
  assert.equal(b.choices.length, 3);
  // The ordinary permission answer still works, as before.
  assert.equal((await answer(s.sid, { option: 3 })).status, 200);
  const done = await until(s.sid, (x) => x.status === 'ready', 'turn done');
  assert.equal(done.last_message, 'plan feedback, then permission no');
});

test('two answers at once: the second is refused, nothing is typed twice', async () => {
  const s = await session('double');
  await send(s.sid, 'ask? double');
  const v = await until(s.sid, (x) => x.asking, 'asking');
  const body = { tool_id: v.asking.tool_id, answers: [{ text: 'Teal' }] };
  const [a, b] = await Promise.all([answer(s.sid, body), answer(s.sid, body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const done = await until(s.sid, (x) => x.status === 'ready', 'turn done');
  assert.equal(done.last_message, 'you chose Teal');
});

test('a permission prompt is not a question: no card, and the card form is refused', async () => {
  const s = await session('perm');
  await send(s.sid, 'permission? please');
  const v = await until(s.sid, (x) => x.status === 'needs_you' && x.choices, 'permission prompt');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await view(s.sid)).asking, null);
  assert.equal((await answer(s.sid, { tool_id: 'toolu_1', answers: [{ choices: [0] }] })).status, 409);
  assert.equal((await answer(s.sid, { option: 1, text: 'hi' })).status, 400);
  assert.equal(v.notification, 'Claude needs your permission to use Bash');
  assert.equal((await answer(s.sid, { option: 3 })).status, 200);
});

test('Watching: background work shows on the session until it ends', async () => {
  const s = await session('watch');
  assert.equal((await view(s.sid)).background, null, 'no transcript yet: unknown, not zero');
  await send(s.sid, 'hello');
  await until(s.sid, (x) => x.status === 'ready' && x.background?.count === 0, 'a transcript, nothing running');
  await send(s.sid, 'watch? start');
  const v = await until(s.sid, (x) => x.status === 'ready' && x.background?.count === 2, 'watching 2');
  assert.deepEqual(v.background.tasks.map((t) => [t.kind, t.description]), [['shell', 'Wait for the build'], ['watcher', 'Watch the deploy log']]);
  assert.ok(v.background.tasks[1].expires_at, 'a watcher with a timeout says when it expires');
  await send(s.sid, 'unwatch? stop');
  await until(s.sid, (x) => x.status === 'ready' && x.background?.count === 0, 'watching 0');
});
