// A permanent regression test: the stand-in adversarial review (1.8, round 3) wrote it as a probe.
// Stand-in review r3, LOW-3 (classification, close to a word-list case): a plugin whose name holds a
// "local helper" word is treated as harmless, so it is neither a chip nor an unknown on any agent row.
//
// capsFor() (server/safety.js) classifies a plugin by name with the same table as an MCP server. The
// "local helper" entry (sequential-thinking, time, everything, memory, ide, think) makes a name known
// with no capabilities. For MCP servers that is only kept for a server that runs here (a remote one is
// downgraded to unknown); for plugins nothing is downgraded, although the row's own wording for an
// unknown plugin is "a plugin can add MCP servers and hooks". `everything-claude-code` (a widely
// installed plugin bundling agents, commands, hooks and more) matches "everything" and disappears from
// every agent row; the user row only carries its marketplace risk.
//
// FAILS on r18 HEAD 7017c92; passes once a plugin that matches only "local helper" is unknown (or a
// plugin is never treated as a local helper).
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

function agentRow(plugin) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-r3-l3-')));
  temps.push(home);
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { permissions: { defaultMode: 'default' }, disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false, enabledPlugins: { [plugin]: true } });
  const dir = path.join(org, 'domains', 'work');
  fs.mkdirSync(dir, { recursive: true });
  const agents = [{ id: 'work', name: 'Work', kind: 'domain', dir, repo: null, permission_mode: null }];
  const audit = runSafetyAudit({ agents, home: org, userHome: home, configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), env: {}, managed: [], channels: {} });
  return audit.rows.find((r) => r.id === 'work');
}

test('control: a plugin with an unknown name is said as unknown on the agent row', () => {
  const r = agentRow('acme-toolkit@acme-tools');
  assert.ok(r.unknown.some((u) => /acme-toolkit plugin/.test(u.text)), JSON.stringify(r.unknown));
});

test('a plugin whose name holds a local-helper word is said too', () => {
  const r = agentRow('everything-claude-code@everything-claude-code');
  const said = [...r.chips.private, ...r.chips.untrusted, ...r.chips.sends, ...r.unknown].some((x) => /everything-claude-code/.test(x.text));
  assert.ok(said, `the everything-claude-code plugin loads in this agent's sessions but the row says nothing about it (verdict "${r.verdict}")`);
});
