import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TranscriptReader, findTranscript, toolDetail, toolSummary, transcriptEntry } from '../../server/transcripts.js';
import { ROOT, rmrf, tempHome } from '../helpers.mjs';

const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'transcript.jsonl');
const SID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

test('chat view keeps real prompts and replies, drops plumbing, meta, sidechains, tool results', () => {
  const entries = new TranscriptReader().read(FIXTURE);
  assert.deepEqual(entries.map((e) => [e.n, e.role]), [[0, 'user'], [1, 'assistant'], [2, 'assistant'], [3, 'assistant'], [4, 'user']]);
  assert.equal(entries[0].text, 'How did I sleep this week?');
  assert.equal(entries[0].ts, '2026-10-22T10:00:03.000Z');
  assert.equal(entries[1].text, 'Let me look at your sleep log.');
  assert.deepEqual(entries[1].tools, []);
  assert.equal(entries[2].text, '');
  assert.deepEqual(entries[2].tools[0], { name: 'Read', summary: '/Users/sam/clawdling/domains/health/memory/NOW.md', detail: '/Users/sam/clawdling/domains/health/memory/NOW.md' });
  assert.equal(entries[2].tools[1].name, 'Bash');
  assert.ok(entries[2].tools[1].summary.length <= 80);
  assert.match(entries[2].tools[1].detail, /well past eighty characters total$/); // the expanded line has it all
  assert.equal(entries[2].model, 'claude-haiku');
  assert.equal(entries[3].text, 'You averaged 7h 10m.\nBest night: Tuesday.');
  assert.equal(entries[4].text, 'Thanks! Plan an earlier bedtime.');
});

test('incremental reads pick up appended lines (and wait for a line to be complete)', () => {
  const dir = tempHome('cl-tx-');
  try {
    const f = path.join(dir, `${SID}.jsonl`);
    fs.writeFileSync(f, fs.readFileSync(FIXTURE));
    const r = new TranscriptReader();
    assert.equal(r.read(f).length, 5);
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'café \u{1F600}' }] } });
    const bytes = Buffer.from(line + '\n');
    fs.appendFileSync(f, bytes.subarray(0, bytes.length - 6)); // half a line, split inside the emoji
    assert.equal(r.read(f).length, 5);
    fs.appendFileSync(f, bytes.subarray(bytes.length - 6));
    const all = r.read(f);
    assert.equal(all.length, 6);
    assert.equal(all[5].n, 5);
    assert.equal(all[5].text, 'café \u{1F600}');
    fs.writeFileSync(f, ''); // rewritten / truncated: start over
    assert.equal(r.read(f).length, 0);
  } finally {
    rmrf(dir);
  }
});

test('findTranscript globs projects/*/<sid>.jsonl under the config dir; hints must match the id', () => {
  const cfg = tempHome('cl-cfg-');
  try {
    const proj = path.join(cfg, 'projects', '-Users-sam-clawdling-domains-health');
    fs.mkdirSync(proj, { recursive: true });
    const f = path.join(proj, `${SID}.jsonl`);
    fs.writeFileSync(f, '');
    assert.equal(findTranscript({ ids: [SID], configDir: cfg }), f);
    assert.equal(findTranscript({ ids: ['../../etc/passwd'], configDir: cfg }), null);
    assert.equal(findTranscript({ ids: [SID], hint: '/etc/passwd', configDir: cfg }), f);
    assert.equal(findTranscript({ ids: ['11111111-1111-4111-8111-111111111111'], configDir: cfg }), null);
    assert.equal(findTranscript({ ids: [SID], configDir: path.join(cfg, 'missing') }), null);
  } finally {
    rmrf(cfg);
  }
});

test('tool summaries and entry edge cases', () => {
  assert.equal(toolSummary({ command: 'ls -la' }), 'ls -la');
  assert.equal(toolSummary({ pattern: 'TODO', path: '/x' }), 'TODO');
  assert.equal(toolSummary({ url: 'https://example.com' }), 'https://example.com');
  assert.equal(toolSummary({ other: 1 }), '');
  assert.equal(toolSummary(null), '');
  assert.equal(transcriptEntry({ type: 'user', message: { role: 'user', content: '   ' } }), null);
  assert.equal(transcriptEntry({ type: 'assistant', message: { content: 'plain string reply' } }).text, 'plain string reply');
  assert.equal(transcriptEntry(null), null);
});

test('tool detail: one string field as is, several as JSON, capped at 2000 characters', () => {
  assert.equal(toolDetail({ command: 'ls -la' }), 'ls -la');
  assert.equal(toolDetail({ command: 'ls', description: 'List' }), '{\n  "command": "ls",\n  "description": "List"\n}');
  assert.equal(toolDetail(null), '');
  const long = toolDetail({ command: 'x'.repeat(5000) });
  assert.equal(long.length, 2001);
  assert.ok(long.endsWith('…'));
});

test('chat view: a cut summary ends in …; a question shows as its words; a declined step reads plainly', async () => {
  const { toolSummary, transcriptEntry } = await import('../../server/transcripts.js');
  const long = toolSummary({ command: `clawdling remote add https://box.example.ts.net:8743 --kind tailscale ${'x'.repeat(60)}` });
  assert.ok(long.length <= 80 && long.endsWith('…'), long);
  assert.equal(toolSummary({ questions: [{ question: 'Which port should the cockpit use?' }] }), 'Which port should the cockpit use?');
  const e = transcriptEntry({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  assert.equal(e.text, 'You stopped that step.');
});
