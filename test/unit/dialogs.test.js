import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialogAnswers } from '../../web/lib/dialogs.js';

test('trust dialog in Claude Code 2.1.283 order: "No, exit" is choice 1, so Yes is 2', () => {
  assert.deepEqual(dialogAnswers([{ option: 1, label: 'No, exit' }, { option: 2, label: 'Yes, I trust this folder' }]), { yes: 2, no: 1 });
});

test('yes-first lists and numbered labels map by label, not position', () => {
  assert.deepEqual(dialogAnswers([{ option: 1, label: '1. Yes, allow external imports' }, { option: 2, label: '2. No, disable external imports' }]), { yes: 1, no: 2 });
  assert.deepEqual(dialogAnswers([{ option: 1, label: 'Allow imports' }, { option: 2, label: "Don't allow" }]), { yes: 1, no: 2 });
});

test('missing or unrecognised choices give null, so the banner shows no buttons', () => {
  assert.equal(dialogAnswers(null), null);
  assert.equal(dialogAnswers(undefined), null);
  assert.equal(dialogAnswers([]), null);
  assert.equal(dialogAnswers([{ option: 1, label: 'Proceed' }, { option: 2, label: 'Exit' }]), null);
  assert.equal(dialogAnswers([{ option: 1, label: 'Yes' }]), null);
  assert.equal(dialogAnswers([{ label: 'Yes' }, { label: 'No' }]), null);
});
