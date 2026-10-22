import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTitle, deriveTitle, TITLE_MAX } from '../../server/titles.js';

test('first sentence, sentence case, trailing period removed', () => {
  assert.equal(deriveTitle('fix the login bug. then deploy it'), 'Fix the login bug');
  assert.equal(deriveTitle("what's on my calendar tomorrow?"), "What's on my calendar tomorrow?");
  assert.equal(deriveTitle('Wow! that worked'), 'Wow!');
});

test('markdown and URLs are stripped', () => {
  assert.equal(deriveTitle('**Refactor** the `auth` module'), 'Refactor the auth module');
  assert.equal(deriveTitle('# Plan\nbody text'), 'Plan');
  assert.equal(deriveTitle('- [ ] read [the docs](https://example.com/x) now'), 'Read the docs now');
  assert.equal(deriveTitle('check https://example.com/a?b=c and summarize'), 'Check and summarize');
  assert.equal(deriveTitle('> quoted _emphasis_ here'), 'Quoted emphasis here');
  assert.equal(deriveTitle('```js\nconsole.log(1)\n```\nexplain this code'), 'Explain this code');
});

test('length cap with a word-boundary ellipsis', () => {
  const t = deriveTitle('please go through every single receipt from last year and categorize them for the accountant');
  assert.ok(t.length <= TITLE_MAX, t);
  assert.ok(t.endsWith('…'));
  assert.ok(t.startsWith('Please go through every single receipt'));
});

test('nothing title-worthy returns null', () => {
  assert.equal(deriveTitle(''), null);
  assert.equal(deriveTitle('   '), null);
  assert.equal(deriveTitle('/handoff'), null);
  assert.equal(deriveTitle('https://example.com'), null);
  assert.equal(deriveTitle(null), null);
  assert.equal(deriveTitle('...'), null);
});

test('unicode: first letter after punctuation is capitalised, digits left alone', () => {
  assert.equal(deriveTitle('¿qué tal?'), '¿Qué tal?');
  assert.equal(deriveTitle('3 things to do today'), '3 things to do today');
  assert.equal(deriveTitle('été plans'), 'Été plans');
});

test('cleanTitle normalises user titles', () => {
  assert.equal(cleanTitle('  a\n b\t c '), 'a b c');
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle(null), null);
  assert.equal(cleanTitle('x'.repeat(500)).length, 120);
});
