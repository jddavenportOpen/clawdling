// A permanent regression test: the stand-in adversarial review (1.8, round 3) wrote it as a probe.
// Stand-in review r3, MEDIUM-1: sessions on an extra Claude account load a config folder the audit never
// reads, yet every agent row stays GREEN ("No trifecta found by name").
//
// An extra account (accounts.js, 1.0.1) is only a folder, ~/.clawdling-accounts/<id>, created EMPTY and
// handed to a session as CLAUDE_CONFIG_DIR. Such a session reads that folder's settings.json (none: Claude
// Code's defaults, so auto mode for an agent on "Your Claude Code setting", and claude.ai connectors,
// plugin and skill sync all on) and that folder's .claude.json MCP servers, never ~/.claude's. The audit
// reads only ~/.claude and ~/.claude.json, and for `accounts > 0` adds one NOTE to the user row
// (safety-run.js) and nothing to any verdict. Round 1 settled the rule: what is there but not read is
// "unknown: review", never absent.
//
// The owner here followed the audit's own fixes in ~/.claude/settings.json (a mode that asks first,
// connectors and sync off) and has one extra account. By the audit's own rules a session of the "inherit"
// agent on that account runs in auto mode (sends + untrusted) with the org folder (private): a trifecta.
// The "ask" agent's sessions there load the account's claude.ai connectors: unknown. Both rows show green.
//
// FAILS on r18 HEAD 7017c92 (both rows green); passes once an extra account makes each row that loads
// user-level settings at least amber (an unknown naming the account folders), or the rows say what
// those folders hold.
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

function audit(accounts) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-r3-m1-')));
  temps.push(home);
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  // The audit's own advice, followed: a mode that asks first, connectors, plugin and skill sync off.
  write(path.join(cfg, 'settings.json'), { permissions: { defaultMode: 'default' }, disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  // The extra account, as accounts.create() makes it: an empty folder.
  if (accounts) fs.mkdirSync(path.join(home, '.clawdling-accounts', 'work'), { recursive: true });
  const agents = [];
  for (const [id, mode] of [['mine', 'inherit'], ['asks', null]]) {
    const dir = path.join(org, 'domains', id);
    fs.mkdirSync(dir, { recursive: true });
    agents.push({ id, name: id, kind: 'domain', dir, repo: null, permission_mode: mode });
  }
  return runSafetyAudit({ agents, home: org, userHome: home, configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), env: {}, managed: [], channels: {}, accounts });
}
const row = (a, id) => a.rows.find((r) => r.id === id);

test('control: with no extra account both agents are green (the owner fixed what the audit said)', () => {
  const a = audit(0);
  assert.equal(row(a, 'mine').verdict, 'green', JSON.stringify(row(a, 'mine')));
  assert.equal(row(a, 'asks').verdict, 'green', JSON.stringify(row(a, 'asks')));
});

test('with an extra account, the "inherit" agent is not shown green (its sessions there run in auto mode)', () => {
  const a = audit(1);
  const r = row(a, 'mine');
  assert.ok(row(a, '_user').unknown.some((u) => /other Claude account/.test(u.text)), 'precondition: the audit knows there is an extra account (an unknown since the fix)');
  assert.notEqual(r.verdict, 'green', `"${r.summary}" for an agent whose sessions on the extra account load an empty config folder: auto mode (sends, untrusted) + the org folder (private) by the audit's own rules; nothing on the row says so (mode shown: "${r.mode}")`);
});

test('with an extra account, the "ask" agent is not shown green (its sessions there load that account\'s claude.ai connectors)', () => {
  const a = audit(1);
  const r = row(a, 'asks');
  assert.notEqual(r.verdict, 'green', `"${r.summary}": the connectors were turned off only in ~/.claude/settings.json, which a session on the extra account does not load`);
});
