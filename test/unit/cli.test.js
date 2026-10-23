import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchdPlist, parseArgs, systemdUnit, versionAtLeast, windowsStartupScript } from '../../bin/clawdling.js';
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
  // A text message never inherits the owner's own Claude Code settings or MCP servers.
  const ss = a.indexOf('--setting-sources');
  assert.ok(ss > 0 && a[ss + 1] === 'project,local', 'user settings (allow rules, hooks, plugins) are not loaded');
  assert.ok(a.includes('--strict-mcp-config'), 'no MCP servers from the user config');
  assert.ok(ss < a.indexOf('--allowedTools') && a.indexOf('--strict-mcp-config') < a.indexOf('--allowedTools'), 'both come before the variadic --allowedTools');
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

test('pairing info: LAN URL when bound to all interfaces, loopback otherwise', async () => {
  const { pairingInfo } = await import('../../server/index.js');
  const t = 'ab'.repeat(32);
  const all = pairingInfo({ host: '0.0.0.0', port: 4747, token: t, lan: ['192.168.1.20', '10.0.0.5'] });
  assert.equal(all.url, 'http://192.168.1.20:4747');
  assert.deepEqual(all.lan, ['http://192.168.1.20:4747', 'http://10.0.0.5:4747']);
  assert.equal(all.link, `clawdling://connect?url=${encodeURIComponent('http://192.168.1.20:4747')}&t=${t}`);
  assert.equal(all.bind, '0.0.0.0');
  assert.equal(pairingInfo({ host: '0.0.0.0', port: 1, token: t, lan: [] }).url, 'http://127.0.0.1:1');
  assert.equal(pairingInfo({ host: '127.0.0.1', port: 4747, token: t, lan: ['192.168.1.20'] }).url, 'http://127.0.0.1:4747');
  assert.equal(pairingInfo({ host: '100.64.0.7', port: 4747, token: t, lan: [] }).url, 'http://100.64.0.7:4747');
});

test('Windows login item: a Startup-folder launcher that starts the cockpit minimized', () => {
  const cmd = windowsStartupScript({ node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Users\\Sam\\.clawdling-app\\bin\\clawdling.js', home: 'C:\\Users\\Sam\\clawdling', port: '4747', backend: null });
  const lines = cmd.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.ok(lines.includes('start "Clawdling cockpit" /min "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Sam\\.clawdling-app\\bin\\clawdling.js" start --home "C:\\Users\\Sam\\clawdling" --port 4747'));
  assert.ok(!cmd.includes('CLAWDLING_BACKEND'));
  assert.match(windowsStartupScript({ node: 'n', cli: 'c', home: 'h', port: '1', backend: 'pty' }), /set "CLAWDLING_BACKEND=pty"/);
  assert.match(launchdPlist({ label: 'l', node: 'n', cli: 'c', home: 'h', port: '1', logFile: 'f', envPath: 'p', socket: 'clawdling', backend: 'pty' }), /<key>CLAWDLING_BACKEND<\/key><string>pty<\/string>/);
  assert.match(systemdUnit({ node: '/n', cli: '/c', home: '/h', port: '1', envPath: '/p', backend: 'tmux' }), /Environment=CLAWDLING_BACKEND=tmux/);
});

test('versionAtLeast compares major.minor.patch (Windows needs Claude Code 2.1.139+)', () => {
  assert.equal(versionAtLeast('2.1.139 (Claude Code)', 2, 1, 139), true);
  assert.equal(versionAtLeast('2.1.283 (Claude Code)', 2, 1, 139), true);
  assert.equal(versionAtLeast('2.1.120 (Claude Code)', 2, 1, 139), false);
  assert.equal(versionAtLeast('2.2.0', 2, 1, 139), true);
  assert.equal(versionAtLeast('2.1', 2, 1), true);
  assert.equal(versionAtLeast('nonsense', 2, 1), false);
});

