// A permanent regression test: the stand-in adversarial review (1.8, round 1) wrote it as a probe.
// Stand-in review r1, LOW-2 (rests on Claude Code's documented subagent rule): a subagent's own
// `permissionMode` overrides the parent's mode except when the parent is in bypassPermissions or
// acceptEdits (which take precedence) or auto (which the subagent inherits). safety.js only counts a
// subagent's bypass/auto mode when the session runs in default, manual or dontAsk, so an agent Clawdling
// starts in Plan mode (one of its four settings) that can hand work to your `runner` subagent
// (`permissionMode: bypassPermissions`) is shown GREEN, while in "Ask before editing files" the same
// subagent makes it red.
//
// Fails on r18 HEAD ca03e6d; passes once 'plan' is among the modes a subagent's own mode overrides.
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
function rowFor(mode) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-l2-')));
  temps.push(home);
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  write(path.join(cfg, 'agents', 'runner.md'), '---\nname: runner\ndescription: Runs what it is asked to\npermissionMode: bypassPermissions\n---\nRun it.\n');
  const dir = path.join(org, 'domains', 'work');
  fs.mkdirSync(dir, { recursive: true });
  const agents = [{ id: 'work', name: 'Work', kind: 'domain', dir, repo: null, permission_mode: mode }];
  const audit = runSafetyAudit({ agents, home: org, userHome: home, configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), env: {}, managed: [], channels: {} });
  return audit.rows.find((r) => r.id === 'work');
}

test('control: in "Ask before editing files" the bypass subagent makes the agent red', () => {
  const r = rowFor(null);
  assert.equal(r.verdict, 'red');
  assert.ok(r.chips.sends.some((x) => /runner subagent/.test(x.text)));
});

test('in Plan mode the same subagent is not counted: the agent shows green', () => {
  const r = rowFor('plan');
  assert.ok(r.chips.sends.some((x) => /runner subagent/.test(x.text)), `no chip for the runner subagent (mode "${r.mode}"): ${JSON.stringify(r.chips)}`);
  assert.notEqual(r.verdict, 'green');
});
