import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchdPlist, parseArgs, systemdUnit } from '../../bin/clawdling.js';
import { buildDonnaArgs, buildDonnaPrompt, donnaAllowedTools, parseResult } from '../../server/channels/donna.js';

test('parseArgs: positionals, --flag value, --flag=value, booleans, --', () => {
  const a = parseArgs(['spawn', 'health', 'look at --this', '--model', 'haiku', '--json', '--title=Sleep', '--', '--literal']);
  assert.deepEqual(a._, ['spawn', 'health', 'look at --this', '--literal']);
  assert.deepEqual(a.flags, { model: 'haiku', json: true, title: 'Sleep' });
  assert.equal(parseArgs(['init', '--defaults', '--home', '/x']).flags.home, '/x');
  assert.equal(parseArgs(['-h']).flags.help, true);
  assert.throws(() => parseArgs(['start', '--port']), /needs a value/);
});

test('launchd plist escapes XML and keeps the login session (Keychain) requirement', () => {
  const p = launchdPlist({ label: 'com.clawdling.cockpit', node: '/opt/node', cli: '/app/bin/clawdling.js', home: '/Users/a&b/<org>', port: '4747', logFile: '/l.log', envPath: '/usr/bin', socket: 'clawdling' });
  assert.match(p, /<string>\/Users\/a&amp;b\/&lt;org&gt;<\/string>/);
  assert.match(p, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(p, /CLAWDLING_TMUX_SOCKET/);
  assert.match(launchdPlist({ label: 'l', node: 'n', cli: 'c', home: 'h', port: '1', logFile: 'f', envPath: 'p', socket: 'other' }), /CLAWDLING_TMUX_SOCKET/);
  assert.match(systemdUnit({ node: '/n', cli: '/c', home: '/h', port: '4747', envPath: '/p' }), /ExecStart=\/n \/c start --home \/h --port 4747/);
});

test('Donna turn argv: headless JSON, dontAsk, narrow allow-list kept last (variadic)', () => {
  const tools = donnaAllowedTools('/Users/ada/clawdling');
  assert.ok(tools.includes('Bash(clawdling spawn *)'));
  assert.ok(tools.includes('Read(//Users/ada/clawdling/**)'));
  assert.ok(!tools.some((t) => /^Bash(\(\*\))?$/.test(t) || t === 'Bash(clawdling *)'));
  assert.ok(!donnaAllowedTools('/weird(path)/x').some((t) => t.startsWith('Read(')), 'no Read rule for paths with rule syntax');
  const a = buildDonnaArgs({ sessionId: 'S', resume: false, home: '/h', ctxFile: '/ctx.md', model: 'sonnet' });
  assert.deepEqual(a.slice(0, 5), ['-p', '--output-format', 'json', '--session-id', 'S']);
  assert.ok(a.includes('--model=sonnet'));
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(a.indexOf('--allowedTools'), a.length - donnaAllowedTools('/h').length - 1, '--allowedTools is last');
  assert.deepEqual(buildDonnaArgs({ sessionId: 'S', resume: true, home: '/h' }).slice(3, 5), ['--resume', 'S']);
});

test('Donna prompt carries the message, roster and live sessions; result parsing', () => {
  const p = buildDonnaPrompt({
    owner: 'Ada',
    channel: 'telegram',
    text: 'can health look at my sleep',
    agents: [{ id: 'health', kind: 'domain', name: 'Health', mission: 'Stay healthy' }],
    sessions: [{ sid: 'abc', agent: 'work', status: 'ready', title: 'Q4' }, { sid: 'old', agent: 'x', status: 'ended' }],
  });
  assert.match(p, /<message>\ncan health look at my sleep\n<\/message>/);
  assert.match(p, /- health \(domain\): Health: Stay healthy/);
  assert.match(p, /- abc work \[ready\] Q4/);
  assert.doesNotMatch(p, /old x/);
  assert.equal(parseResult('noise\n{"type":"result","result":"ok","session_id":"s"}\n').result, 'ok');
  assert.equal(parseResult('[{"type":"system"},{"type":"result","result":"arr"}]').result, 'arr');
  assert.equal(parseResult('garbage'), null);
});
