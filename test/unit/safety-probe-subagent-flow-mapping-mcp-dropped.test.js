// A permanent regression test: the stand-in adversarial review (1.8, round 3) wrote it as a probe.
// Stand-in review r3, MEDIUM-2: a subagent's inline MCP server written as a YAML flow mapping is dropped
// without a word, so a setup with all three legs shows GREEN.
//
// subagentServers() (server/discover.js) reads the `mcpServers:` block line by line and starts a server
// only on a line that begins with a plain key (`/^["']?([A-Za-z0-9_.@-]{1,100})["']?\s*:/`, after an
// optional "- "). `- {gmail: {command: npx, args: [...]}}` is valid YAML and means exactly what the
// documented form (`- gmail:` with indented fields) means, but its line starts with "{": no entry is
// made, the line is thrown away, and `unreadable` stays false because it is only set when an entry was
// made or the value sits on the `mcpServers:` line itself. toolGrants() then drops the subagent (no
// allowed-tools, no mode, no servers, nothing unreadable), so neither a chip nor an unknown appears.
// Round 1 settled the rule: what is there but not read is "unknown: review", never absent.
//
// FAILS on r18 HEAD 7017c92 (the user row is green); passes once the flow form is read (gmail: all three
// legs, red) or a `mcpServers` block with lines no server was read from is said as unknown (amber).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runSafetyAudit } from '../../server/safety-run.js';

const temps = [];
after(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  return file;
}

function userRow(servers) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-r3-m2-')));
  temps.push(home);
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { permissions: { defaultMode: 'default' }, disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  write(path.join(cfg, 'agents', 'mailer.md'), `---\nname: mailer\ndescription: Reads and answers my mail\nmcpServers:\n${servers}\n---\nHandle the inbox.\n`);
  const audit = runSafetyAudit({ agents: [], home: path.join(home, 'clawdling'), userHome: home, configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), env: {}, managed: [], channels: {} });
  return audit.rows.find((r) => r.id === '_user');
}

test('control: the documented block form of the same server makes the user level red', () => {
  const r = userRow('  - gmail:\n      command: npx\n      args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"]');
  assert.equal(r.verdict, 'red', JSON.stringify(r.chips));
  assert.ok(r.chips.sends.some((x) => /gmail MCP server/.test(x.text)));
});

test('the same server as a flow mapping is counted, or at least said as unknown', () => {
  const r = userRow('  - {gmail: {command: npx, args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"]}}');
  const said = [...r.chips.private, ...r.chips.untrusted, ...r.chips.sends, ...r.unknown].some((x) => /gmail|mailer/.test(x.text));
  assert.ok(said, `the mailer subagent's gmail server is neither a chip nor an unknown: verdict "${r.verdict}" (${r.summary})`);
  assert.notEqual(r.verdict, 'green');
});
