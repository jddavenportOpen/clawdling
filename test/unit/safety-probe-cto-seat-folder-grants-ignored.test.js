// A permanent regression test: the stand-in adversarial review (1.8, round 2) wrote it as a probe.
// Stand-in review r2, LOW-1: the CTO row ignores the skills, commands and subagents in the CTO seat's own
// folder, though its sessions load them.
//
// The CTO seat runs in its own folder with `--setting-sources project --strict-mcp-config`
// (sessions.js), so the folder's own `.claude/skills|commands|agents` load like any project's. SPEC 1.8
// says the audit reads grants from "the session folder's `.claude/`". scanSafety() does read them
// (scan.dirs[<cto folder>].grants), but auditSafety() builds the CTO view from managed settings, the
// folder's settings.json and the seat's rules only: no grantLayers(d.grants), no subagentModes. A skill the
// owner adds there with `allowed-tools: Bash(gh pr comment:*)` gives the seat a way to send, on top of
// the private data (the org report) and the untrusted input (agent-written text in it) the row already
// lists: all three legs, and the row says green, "No trifecta found by name".
//
// It FAILS while the CTO row has no sends chip from its own folder's skill, and passes once the CTO view
// includes the grants of its folder's `.claude/` (and that folder's subagent modes).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { scanSafety } from '../../server/discover.js';
import { runSafetyAudit } from '../../server/safety-run.js';

const temps = [];
after(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix) {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(d);
  return d;
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  return file;
}

test('a skill in the CTO seat folder that sends counts on the CTO row', () => {
  const home = tmp('probe-r2-l1-');
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  const ctoDir = path.join(org, 'cto');
  write(path.join(ctoDir, '.claude', 'skills', 'pr-notes', 'SKILL.md'), [
    '---',
    'name: pr-notes',
    'description: Leave the review on the pull requests it covers',
    'allowed-tools: Bash(gh pr view:*), Bash(gh pr comment:*)',
    '---',
    'Comment on each pull request the review mentions.',
    '',
  ].join('\n'));

  // Precondition: the scan reads the skill's grant from the seat folder.
  const scan = scanSafety({ configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), dirs: [ctoDir], homedir: home, env: {} });
  const grants = (scan.dirs[ctoDir] && scan.dirs[ctoDir].grants) || [];
  assert.ok(grants.some((g) => g.allowed.includes('Bash(gh pr comment:*)')), 'precondition: scanSafety reads the CTO folder skill');

  const audit = runSafetyAudit({
    agents: [{ id: 'cto', name: 'CTO', kind: 'cto', dir: ctoDir }],
    home: org,
    userHome: home,
    configDir: cfg,
    claudeJsonPath: path.join(home, '.claude.json'),
    env: {},
    managed: [],
    channels: {},
  });
  const row = audit.rows.find((r) => r.id === 'cto');
  assert.ok(row, 'precondition: the CTO row is there');
  assert.ok(row.chips.private.length && row.chips.untrusted.length, 'precondition: the CTO row lists the report (private) and agent-written text (untrusted)');
  assert.ok(row.chips.sends.some((x) => x.text.includes('Bash(gh pr comment:*)')), `the CTO seat's own skill lets it run \`gh pr comment\` without asking, but the CTO row's "sends out" is empty (verdict ${row.verdict}: ${row.summary})`);
  assert.notEqual(row.verdict, 'green', 'all three legs, shown green');
});
