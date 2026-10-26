// The plan card with Claude Code 2.1.308 (issue #21): ExitPlanMode arrives with an empty input and
// the plan lives in Claude Code's plan file, <config dir>/plans/<slug>.md, written (Write) and
// revised (Edit) just before. Contract fixture: test/fixtures/plan-2.1.308/ (paths say <CONFIG>,
// filled in with a temp folder here, so the card's path rules see real absolute paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptReader, askOf, readPlanFile } from '../../server/transcripts.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FIXTURE = path.join(FIXTURES, 'plan-2.1.308', 'config');
// A real Claude Code 2.1.308 plan session (the live questions check, scrubbed): ToolSearch for
// ExitPlanMode, a Write to the plan file, ExitPlanMode, sent back, the file rewritten, ExitPlanMode.
const REAL = path.join(FIXTURES, 'plan-2.1.308-real', 'config');

/** A copy of a fixture's config folder with <CONFIG> replaced; returns {config, transcript}. */
function install(fixture = FIXTURE) {
  const config = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-plan-')));
  fs.cpSync(fixture, config, { recursive: true });
  const projDir = path.join(config, 'projects', fs.readdirSync(path.join(config, 'projects'))[0]);
  const transcript = path.join(projDir, fs.readdirSync(projDir).find((f) => f.endsWith('.jsonl')));
  fs.writeFileSync(transcript, fs.readFileSync(transcript, 'utf8').replaceAll('<CONFIG>', config.replace(/\\/g, '\\\\')));
  return { config, transcript };
}

const planEntry = (entries) => entries.flatMap((e) => e.tools || []).find((t) => t.ask && t.ask.kind === 'plan');

test('2.1.308 shape: an empty ExitPlanMode shows the plan from the plan file the session wrote', () => {
  const { config, transcript } = install();
  const t = planEntry(new TranscriptReader().read(transcript));
  assert.ok(t, 'the ExitPlanMode is a plan card');
  assert.equal(t.ask.plan, fs.readFileSync(path.join(config, 'plans', 'zesty-hopping-hartmanis.md'), 'utf8'));
  assert.match(t.ask.plan, /Print it with `cat hello.txt`/, 'the revision (an Edit) is read from disk, not the first Write');
  fs.rmSync(config, { recursive: true, force: true });
});

test('the hook path (PreToolUse with an empty input) gets the same plan', () => {
  const { config, transcript } = install();
  const card = askOf('ExitPlanMode', {});
  assert.equal(card.plan, '', 'the input alone has no plan');
  assert.match(new TranscriptReader().planFor(transcript, {}), /^# Create hello\.txt/);
  fs.rmSync(config, { recursive: true, force: true });
});

test('the 2.1.283 shape (the plan in the input) is unchanged', () => {
  assert.equal(askOf('ExitPlanMode', { plan: '# Plan\n1. x' }).plan, '# Plan\n1. x');
});

test('a plan file is read only inside <config>/plans, as a .md file, never through a link', () => {
  const { config } = install();
  const outside = path.join(config, 'secret.md');
  fs.writeFileSync(outside, 'not a plan');
  assert.equal(readPlanFile(config, outside), null, 'outside the plans folder');
  assert.equal(readPlanFile(config, path.join(config, 'plans', '..', 'secret.md')), null, 'dot-dot out of it');
  assert.equal(readPlanFile(config, path.join(config, 'plans', 'x.txt')), null, 'not .md');
  try {
    fs.symlinkSync(outside, path.join(config, 'plans', 'link.md'));
    assert.equal(readPlanFile(config, path.join(config, 'plans', 'link.md')), null, 'a link that leaves the folder');
  } catch {
    // no symlinks here (Windows without the right): nothing to test for links
  }
  assert.match(readPlanFile(config, path.join(config, 'plans', 'zesty-hopping-hartmanis.md')), /hello\.txt/);
  fs.rmSync(config, { recursive: true, force: true });
});

test('a Write to a plans folder elsewhere is never read from disk (only its own content is used)', () => {
  const { config, transcript } = install();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-plan-other-'));
  fs.mkdirSync(path.join(other, 'plans'));
  fs.writeFileSync(path.join(other, 'plans', 'x.md'), 'FROM DISK ELSEWHERE');
  const lines = fs.readFileSync(transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // Point every plan-file path at the other folder: its file must not be read.
  const moved = lines.map((o) => JSON.parse(JSON.stringify(o).replaceAll(path.join(config, 'plans', 'zesty-hopping-hartmanis.md').replace(/\\/g, '\\\\'), path.join(other, 'plans', 'x.md').replace(/\\/g, '\\\\'))));
  fs.writeFileSync(transcript, moved.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const t = planEntry(new TranscriptReader().read(transcript));
  assert.ok(!/FROM DISK ELSEWHERE/.test(t.ask.plan), 'never read outside this config folder');
  assert.match(t.ask.plan, /Write `hello\.txt`/, 'the Write content from the transcript itself');
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test('real 2.1.308 transcript: both plan cards have their plan (the input recorded after the answer)', () => {
  const { config, transcript } = install(REAL);
  const plans = new TranscriptReader().read(transcript).flatMap((e) => e.tools || []).filter((t) => t.ask && t.ask.kind === 'plan');
  assert.equal(plans.length, 2);
  assert.ok(plans.every((t) => /^# Plan: create hello\.txt/.test(t.ask.plan)));
  assert.match(plans[1].ask.plan, /Print the file's contents/, 'the revised plan');
  fs.rmSync(config, { recursive: true, force: true });
});

test('real 2.1.308 records with the input emptied (what the hook sends): the plan comes from the plan file', () => {
  const { config, transcript } = install(REAL);
  const lines = fs.readFileSync(transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const o of lines) for (const b of o.message?.content || []) if (b?.name === 'ExitPlanMode') b.input = {};
  fs.writeFileSync(transcript, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const plans = new TranscriptReader().read(transcript).flatMap((e) => e.tools || []).filter((t) => t.ask && t.ask.kind === 'plan');
  assert.ok(plans.length === 2 && plans.every((t) => /^# Plan: create hello\.txt/.test(t.ask.plan)));
  assert.match(new TranscriptReader().planFor(transcript, {}), /Print the file's contents/);
  fs.rmSync(config, { recursive: true, force: true });
});
