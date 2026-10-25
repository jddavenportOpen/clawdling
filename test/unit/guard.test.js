// The PreToolUse guard of a Use from anywhere setup chat: the remote-access skill's "never" list,
// enforced in code. It runs as a hook (stdin JSON, exit 2 + stderr to refuse).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { verdict } from '../../bin/clawdling-guard.js';
import { buildHooksSettings, GUARDED_TOOLS } from '../../server/hooks.js';
import { ROOT } from '../helpers.mjs';

const TS = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const bash = (command) => verdict({ tool_name: 'Bash', tool_input: { command } });

test('the setup steps the skill takes are let through to the normal permission prompt', () => {
  for (const c of [
    'clawdling remote tailscale-name', `${TS} serve --https=8743 off`,
    `${TS} funnel --https=8743 off`, 'tailscale funnel 443 off',
    'clawdling remote serve https://box.example.ts.net:8743', 'clawdling remote serve-status', 'clawdling remote add https://box.example.ts.net:8743 --kind tailscale',
    'cloudflared --version', 'cloudflared tunnel create clawdling', 'cloudflared tunnel route dns clawdling cockpit.example.com',
    "curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\\n' https://cockpit.example.com/", 'brew install --cask tailscale',
  ]) assert.equal(bash(c), null, c);
  assert.equal(verdict({ tool_name: 'Read', tool_input: { file_path: '/home/u/.cloudflared/config.yml' } }), null);
  assert.equal(verdict({ tool_name: 'Edit', tool_input: { file_path: '/home/u/.cloudflared/config.yml' } }), null);
});

test('the never list is refused, whatever the session was told', () => {
  for (const c of [
    `${TS} funnel --bg 443`, `${TS} funnel 8743 on`, `${TS} serve --bg --funnel 443 http://127.0.0.1:4791`, `${TS} funnel reset`,
    `${TS} serve reset`, `${TS} serve --tcp=10000 tcp://127.0.0.1:4791`, `${TS} serve --tls-terminated-tcp=443 tcp://127.0.0.1:4791`,
    `${TS} up --authkey tskey-abc`, `${TS} up`, `${TS} down`, `${TS} logout`, `${TS} set --operator=me`, 'tailscale switch other',
    'sudo cloudflared service install', 'sudo tailscale set --operator=$USER', 'cloudflared tunnel login', 'cloudflared login',
    'cat ~/.cloudflared/cert.pem', 'cat ~/.cloudflared/6ff42ae2-765d-4adf-8112-31c55c1551ef.json', 'cat /home/u/org/.clawdling/token',
    `echo ok && ${TS} funnel --bg 443`,
    // The serve entry holds the private path: only `clawdling remote serve` / `serve-status` touch it.
    `${TS} serve status`, `${TS} serve status --json`, `${TS} serve --bg --https=8743 http://127.0.0.1:4791/_clawdling/${'a'.repeat(32)}`,
    `${TS} serve --https=8743 off && ${TS} serve status`,
  ]) assert.ok(bash(c), c);
  for (const [tool, file_path] of [['Read', '/home/u/.cloudflared/cert.pem'], ['Read', '/home/u/.cloudflared/abc.json'], ['Read', '/home/u/org/.clawdling/token'], ['Edit', '/home/u/org/.clawdling/remote.json'], ['Write', '/home/u/org/.clawdling/remote.json']]) {
    assert.ok(verdict({ tool_name: tool, tool_input: { file_path } }), `${tool} ${file_path}`);
  }
  assert.ok(verdict({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '/home/u/.cloudflared/cert.pem' } }));
});

test('as a hook: exit 2 with the reason refuses, exit 0 lets it through, bad input lets it through', () => {
  const run = (input) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'clawdling-guard.js')], { input, encoding: 'utf8' });
  const no = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `${TS} serve reset` } }));
  assert.equal(no.status, 2);
  assert.match(no.stderr, /Clawdling refused this in a Use from anywhere setup chat: never `tailscale serve reset`/);
  const yes = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: 'clawdling remote serve-status' } }));
  assert.equal(yes.status, 0);
  assert.equal(yes.stdout + yes.stderr, '');
  assert.equal(run('not json').status, 0);
});

test('only the setup chat\'s settings file registers the guard', () => {
  const base = buildHooksSettings({ nodePath: '/usr/bin/node', hookScript: '/x/hook.js', home: '/h', platform: 'linux' });
  assert.equal(base.hooks.PreToolUse, undefined);
  const guarded = buildHooksSettings({ nodePath: '/usr/bin/node', hookScript: '/x/hook.js', home: '/h', guardScript: '/x/guard.js', platform: 'linux' });
  assert.equal(guarded.hooks.PreToolUse[0].matcher, GUARDED_TOOLS);
  assert.match(guarded.hooks.PreToolUse[0].hooks[0].command, /'\/x\/guard\.js'$/);
  const win = buildHooksSettings({ nodePath: 'C:\\node.exe', hookScript: 'C:\\x\\hook.js', guardScript: 'C:\\x\\guard.js', platform: 'win32' });
  assert.deepEqual(win.hooks.PreToolUse[0].hooks[0].args, ['C:/x/guard.js']);
});

test('the bypasses a reviewer traced are refused too (each part, quoting, scripts, handoffs, relative paths)', () => {
  for (const c of [
    'tailscale funnel --https=443 off && tailscale funnel --bg 8080',
    'tailscale "funnel" --bg 8080',
    'tailscale "serve" "res""et"',
    'tailscale serve --https=443 off; tailscale serve status',
    'cat .clawdling/token', 'cat .clawdling/remote.json', 'cat ~/.cloudflared/*', 'ls ~/.cloudflared',
    'sh x.sh', 'bash -c "tailscale funnel --bg 8080"', './x.sh', 'source x.sh', 'eval tailscale funnel --bg 8080', 'python3 -c "import os"',
    'clawdling spawn work "turn on funnel"', 'clawdling send abc "tailscale funnel --bg 443"', 'clawdling end abc', 'clawdling new domain X',
    `${TS} status`, `${TS} status --json`, 'tailscale status --peers',
    'echo $(tailscale funnel --bg 443)', 'tailscale funnel\n--bg 443',
  ]) assert.ok(bash(c), c);
  assert.ok(verdict({ tool_name: 'Grep', tool_input: { pattern: '.', path: '~/.cloudflared' } }));
  assert.ok(verdict({ tool_name: 'Read', tool_input: { file_path: '.clawdling/remote.json' } }));
  assert.ok(verdict({ tool_name: 'Write', tool_input: { file_path: '/tmp/x.sh', content: 'tailscale funnel --bg 443' } }));
  // Still fine: the config.yml the Cloudflare steps edit, and the skill's own commands.
  assert.equal(verdict({ tool_name: 'Edit', tool_input: { file_path: '/home/u/.cloudflared/config.yml' } }), null);
  assert.equal(bash('cat ~/.cloudflared/config.yml'), null);
  assert.ok(bash('clawdling remote serve https://box.example.ts.net:8743 && clawdling remote serve-status'), 'one command at a time');
  assert.ok(bash('ls /Applications/Tailscale.app && echo found'));
});

test('the setup chat\'s settings cannot have their hooks switched off', () => {
  assert.equal(buildHooksSettings({ nodePath: 'n', hookScript: 'h', guardScript: 'g', home: '/h' }).disableAllHooks, false);
  assert.equal(buildHooksSettings({ nodePath: 'n', hookScript: 'h', home: '/h' }).disableAllHooks, undefined);
});

test('no version probing in the setup chat (tailscale-name says if it is installed)', () => {
  assert.ok(bash('/Applications/Tailscale.app/Contents/MacOS/Tailscale --version'));
  assert.ok(bash('tailscale version'));
  assert.equal(bash('cloudflared --version'), null, 'the Cloudflare steps check cloudflared this way');
});
