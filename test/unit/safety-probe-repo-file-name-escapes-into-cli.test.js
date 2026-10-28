// A permanent regression test: the stand-in adversarial review (1.8, round 1) wrote it as a probe.
// Stand-in review r1, MEDIUM-4 (the CLI only): a cloned repo's FILE NAMES reach the terminal raw.
// Names, rule text and descriptions pass cleanName/cleanText (control characters stripped), but a
// skill's, command's or subagent's path does not: toolGrants keeps `file: shown`, which only redacts
// token-looking segments. That path is a repo_grants risk's `file`, a grant layer's fix ("remove ... from
// `allowed-tools` in <path>") and a deny note's file, and printSafety prints all three as they are.
// On macOS and Linux a file name may hold ESC and BEL, and git checks such names out. So the repo being
// audited writes terminal control sequences into `clawdling discover --setup --safety`: move the cursor
// up, erase its own "RED  App: Lethal trifecta" line and print "GREEN ... No trifecta found by name" in
// its place, or set the title or a hyperlink. (The cockpit renders text, and --json escapes: both safe.)
//
// Fails on r18 HEAD ca03e6d; passes once every path in the audit is cleaned like a name (control
// characters removed or escaped) before it is printed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { printSafety } from '../../bin/clawdling.js';
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
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

test('a repo file name cannot put control sequences into `discover --setup --safety`', { skip: process.platform === 'win32' ? 'NTFS file names cannot hold control characters' : false }, () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-m4-')));
  temps.push(home);
  const org = path.join(home, 'clawdling');
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { disableClaudeAiConnectors: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  const repo = path.join(home, 'code', 'app');
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  // Up one line, erase it, write a fake verdict, then conceal whatever the CLI prints after it.
  const evil = '\u001b[1A\u001b[2KGREEN  App - No trifecta found by name\u001b[8m';
  write(path.join(repo, '.claude', 'commands', `${evil}.md`), '---\nallowed-tools: Bash(git status)\n---\nShow the status.\n');
  const dir = path.join(org, 'projects', 'app');
  fs.mkdirSync(dir, { recursive: true });
  const agents = [{ id: 'app', name: 'App', kind: 'project', dir, repo, permission_mode: null }];
  const audit = runSafetyAudit({ agents, home: org, userHome: home, configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), env: {}, managed: [], channels: {} });

  const lines = [];
  const was = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    printSafety(audit);
  } finally {
    console.log = was;
  }
  const out = lines.join('\n');
  assert.ok(/Risk: .*commands/.test(out), `precondition: the repo command's grant is printed as a risk with its file:\n${out}`);
  const bad = lines.filter((l) => CONTROL.test(l));
  assert.deepEqual(bad.map((l) => JSON.stringify(l)), [], 'lines that carry raw control characters from a repo file name');
});
