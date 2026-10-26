import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YamlError, joinFrontmatter, parseYaml, splitFrontmatter, stringifyYaml, yamlScalar } from '../../server/yaml-lite.js';

test('parseYaml: the spec\'s checks.yaml example, flow form over several lines', () => {
  const o = parseYaml(`schema: 1
approved_at: 2026-11-02T14:00:00Z
setup:  [{ run: "npm ci", timeout: 600 }]           # optional, approved like the rest
checks: [{ name: tests, run: "npm test", timeout: 600 },
         { name: build, run: "npm run build", timeout: 600 }]
`);
  assert.deepEqual(o, { schema: 1, approved_at: '2026-11-02T14:00:00Z', setup: [{ run: 'npm ci', timeout: 600 }], checks: [{ name: 'tests', run: 'npm test', timeout: 600 }, { name: 'build', run: 'npm run build', timeout: 600 }] });
});

test('parseYaml: block sequences of maps, comments, quoting, block scalars, booleans and null', () => {
  const o = parseYaml(`checks:
  - name: tests
    run: npm test   # the tests
    timeout: 600
  - name: "lint: strict"
    run: 'it''s fine'
list:
- a
- "b # not a comment"
text: |
  line one
  line two
folded: >
  one
  two
yes: true
no: false
nothing: null
tilde: ~
n: -3
f: 1.5
match: count:2
`);
  assert.deepEqual(o.checks, [{ name: 'tests', run: 'npm test', timeout: 600 }, { name: 'lint: strict', run: "it's fine" }]);
  assert.deepEqual(o.list, ['a', 'b # not a comment']);
  assert.equal(o.text, 'line one\nline two\n');
  assert.equal(o.folded, 'one two\n');
  assert.deepEqual([o.yes, o.no, o.nothing, o.tilde, o.n, o.f, o.match], [true, false, null, null, -3, 1.5, 'count:2']);
});

test('parseYaml: anything it does not understand is an error with a line number, never a guess', () => {
  for (const bad of ['a: *alias', 'a: &anchor 1', 'a: !!str x', 'a: [1, 2', 'a: 1\na: 2', '\tb: 1', 'a: "x\\q"', 'a: {b c}', '  a: 1\nb: 2', 'just text']) {
    assert.throws(() => parseYaml(bad), YamlError, JSON.stringify(bad));
  }
});

test('stringifyYaml: what it writes reads back the same, here and in any YAML parser (plain only when unambiguous)', () => {
  const o = { schema: 1, approved_at: '2026-11-02T14:00:00Z', setup: [{ run: 'npm ci', timeout: 600 }], checks: [{ name: 'tests', run: 'npm test', timeout: 600 }, { name: 'lint', run: 'npm run lint -- --max-warnings 0', timeout: 60 }] };
  assert.deepEqual(parseYaml(stringifyYaml(o)), o);
  for (const s of ['Bash(npm test:*)', 'count:2', 'yes', 'no', '2026-01-01', '- x', '#x', 'a: b', '', ' padded', 'true', '1e3', 'it\'s', 'tab\there', 'line\nbreak', '{x}', '[x]', '*x', '&x', '!x', '%x', '@x', '`x`']) {
    assert.equal(parseYaml(`k: ${yamlScalar(s)}`).k, s, `round trip ${JSON.stringify(s)}`);
  }
  assert.equal(yamlScalar('npm test'), 'npm test');
  assert.equal(yamlScalar('Bash(npm test:*)'), '"Bash(npm test:*)"');
});

test('frontmatter: split and join a plugin-eval prompt.md', () => {
  const src = `---
name: knows-its-job
description: "Asks the agent: what is your job?"
max_turns: 6
timeout_seconds: 120
allowed_tools: [Read, Glob, Grep, "Bash(npm test:*)"]
---

What is your job? Answer in two sentences.
`;
  const { fm, body, had } = splitFrontmatter(src);
  assert.equal(had, true);
  assert.deepEqual(fm.allowed_tools, ['Read', 'Glob', 'Grep', 'Bash(npm test:*)']);
  assert.equal(body.trim(), 'What is your job? Answer in two sentences.');
  const again = splitFrontmatter(joinFrontmatter(fm, body));
  assert.deepEqual(again.fm, fm);
  assert.equal(again.body.trim(), body.trim());
  assert.deepEqual(splitFrontmatter('no frontmatter here').had, false);
  assert.throws(() => splitFrontmatter('---\ntype: llm\nno closing line'), YamlError);
  assert.deepEqual(splitFrontmatter('---\nfocus: {source: file, path: out.md}\n---\nx').fm, { focus: { source: 'file', path: 'out.md' } });
});
