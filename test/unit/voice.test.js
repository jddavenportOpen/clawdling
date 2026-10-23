// Dictation helpers (web/lib/voice.js): where the recognizer comes from, and how what was said
// joins the text already in the composer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speechCtor, transcriptOf, joinDictation } from '../../web/lib/voice.js';

test('speechCtor: standard, webkit-prefixed, or none', () => {
  class A {}
  class B {}
  assert.equal(speechCtor({ SpeechRecognition: A, webkitSpeechRecognition: B }), A);
  assert.equal(speechCtor({ webkitSpeechRecognition: B }), B);
  assert.equal(speechCtor({}), null);
  assert.equal(speechCtor(undefined), null);
});

test('transcriptOf: every result in order, best guess only, spaces tidied', () => {
  const res = (t) => Object.assign([{ transcript: t }, { transcript: 'ignored' }], { isFinal: true });
  assert.equal(transcriptOf([res('hello'), res(' from  voice ')]), 'hello from voice');
  assert.equal(transcriptOf([]), '');
  assert.equal(transcriptOf(null), '');
  assert.equal(transcriptOf([[]]), '');
});

test('joinDictation: appends with one space, never drops what was typed', () => {
  assert.equal(joinDictation('', 'hello'), 'hello');
  assert.equal(joinDictation('   ', 'hello'), 'hello');
  assert.equal(joinDictation('Fix this', 'and that'), 'Fix this and that');
  assert.equal(joinDictation('Fix this ', 'and that'), 'Fix this and that');
  assert.equal(joinDictation('Fix this', '  '), 'Fix this');
  assert.equal(joinDictation(null, undefined), '');
});
