// Question cards: reading AskUserQuestion / ExitPlanMode from the transcript, reading the question
// off Claude Code 2.1.283's real screens, checking a card's answers, and driving the keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAnswers, driveAnswers, isPlanScreen, readQuestion, screenShowsAsk } from '../../server/questions.js';
import { parseChoices } from '../../server/sessions.js';
import { TranscriptReader, askAnswerOf, askOf } from '../../server/transcripts.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const screen = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

const SLEEP = {
  question: 'Where does your sleep data live, so I can review it?',
  multiSelect: false,
  options: [{ label: "I'll paste/describe it here" }, { label: "There's a file or export somewhere" }, { label: 'No data yet — just a general check-in' }],
};
const PETS = { question: 'Which pets do you like?', multiSelect: true, options: [{ label: 'Cat' }, { label: 'Dog' }, { label: 'Fish' }] };

test('readQuestion: the real 2.1.283 screen of one question (descriptions, "Type something", "Chat about this" below the rule)', () => {
  const r = readQuestion(screen('screen-askuserquestion-2.1.283.txt'), SLEEP);
  assert.deepEqual(r.items.map((i) => i.label), ["I'll paste/describe it here", "There's a file or export somewhere", 'No data yet — just a general check-in', 'Type something.']);
  assert.equal(r.selected, 0);
  assert.equal(r.submit, null);
  // Not this question, or not these options: no answer is typed.
  assert.equal(readQuestion(screen('screen-askuserquestion-2.1.283.txt'), { ...SLEEP, question: 'Something else?' }), null);
  assert.equal(readQuestion(screen('screen-askuserquestion-2.1.283.txt'), { ...SLEEP, options: [{ label: 'Yes' }, { label: 'No' }] }), null);
  // A permission prompt is not a question, even one whose lines a stale question matches.
  assert.equal(readQuestion(' Bash command\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n', { question: 'Do you want to proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }), null);
  const bash = ' Bash command\n   ls\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for ls commands\n   3. No, and tell Claude what to do differently (esc)\n\n Esc to cancel\n';
  assert.equal(readQuestion(bash, { question: 'Do you want to proceed?', options: [{ label: 'Yes' }, { label: "Yes, and don't ask again for ls commands" }] }), null, 'the third line is not "Type something"');
  assert.equal(screenShowsAsk(bash, { kind: 'plan', plan: 'x' }), false);
});

test('readQuestion: a multiSelect question: ticked boxes, the pointer, the Submit line', () => {
  const r = readQuestion(screen('screen-askuserquestion-multi-2.1.283.txt'), PETS);
  assert.deepEqual(r.items.map((i) => [i.label, i.checked]), [['Cat', true], ['Dog', false], ['Fish', true], ['Type something', false]]);
  assert.equal(r.selected, 2);
  assert.deepEqual(r.submit, { selected: false });
  assert.equal(readQuestion(screen('screen-askuserquestion-multi-2.1.283.txt').replace('     Submit', ''), PETS), null, 'multiSelect needs its Submit line');
});

test('isPlanScreen: the plan approval, and nothing else', () => {
  assert.equal(isPlanScreen(screen('screen-exitplanmode-2.1.283.txt')), true);
  assert.equal(isPlanScreen(screen('screen-askuserquestion-2.1.283.txt')), false);
  assert.equal(isPlanScreen(' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n'), false);
});

test('the plan prompt\'s choices are read by the existing parser (the card answers it by option)', () => {
  const c = parseChoices(screen('screen-exitplanmode-2.1.283.txt'));
  assert.equal(c.selected, 0);
  assert.deepEqual(c.labels.map((l) => l.replace(/\s+shift\+tab.*$/, '')), ['1. Yes, auto-accept edits', '2. Yes, manually approve edits', '3. Tell Claude what to change']);
});

test('checkAnswers: one pick or typed text for a one-pick question; one or more picks for multiSelect', () => {
  const qs = [{ ...SLEEP }, { ...PETS }];
  assert.deepEqual(checkAnswers(qs, [{ choices: [1] }, { choices: [2, 0, 2] }]), [{ choices: [1], text: '' }, { choices: [0, 2], text: '' }]);
  assert.deepEqual(checkAnswers([SLEEP], [{ text: '  Oura\nring  ' }]), [{ choices: [], text: 'Oura ring' }]);
  for (const bad of [[], [{ choices: [1] }], [{ choices: [] }, { choices: [0] }], [{ choices: [0, 1] }, { choices: [0] }], [{ choices: [3] }, { choices: [0] }], [{ choices: [0] }, { text: 'Hamster' }], [{ choices: [1], text: 'x' }, { choices: [0] }], [{ choices: ['1'] }, { choices: [0] }]]) {
    assert.throws(() => checkAnswers(qs, bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test('driveAnswers: arrows onto the choice, Enter; the review is submitted; a changed screen stops it', async () => {
  // A tiny screen model of the two-question flow.
  const Q1 = { question: 'Favorite color?', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] };
  let step = 0;
  let sel = 0;
  const ticks = new Set();
  const sent = [];
  const draw = () => {
    const foot = ['  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
    if (step === 0) return ['Favorite color?', '', ...['Red', 'Blue', 'Type something.'].map((l, i) => `${sel === i ? '❯' : ' '} ${i + 1}. ${l}`), '─'.repeat(20), ...foot].join('\n');
    if (step === 1) return ['Which pets do you like?', '', ...['Cat', 'Dog', 'Fish', 'Type something'].map((l, i) => `${sel === i ? '❯' : ' '} ${i + 1}. [${ticks.has(i) ? '✔' : ' '}] ${l}`), `${sel === 4 ? '❯' : ' '}    Submit`, '─'.repeat(20), ...foot].join('\n');
    if (step === 2) return ['Ready to submit your answers?', '', `${sel === 0 ? '❯' : ' '} 1. Submit answers`, `${sel === 1 ? '❯' : ' '} 2. Cancel`].join('\n');
    return 'done';
  };
  const keys = async (b) => {
    const k = b.toString();
    sent.push(k);
    if (k === '\x1b[B') sel += 1;
    else if (k === '\x1b[A') sel -= 1;
    else if (k === '\r') {
      if (step === 1 && sel < 4) ticks.has(sel) ? ticks.delete(sel) : ticks.add(sel);
      else { step += 1; sel = 0; }
    }
  };
  await driveAnswers({ questions: [Q1, PETS], answers: [{ choices: [1], text: '' }, { choices: [0, 2], text: '' }], screen: async () => draw(), keys, pause: 1 });
  assert.equal(step, 3, 'both questions and the review were answered');
  assert.deepEqual([...ticks].sort(), [0, 2]);
  assert.deepEqual(sent, ['\x1b[B', '\r', '\r', '\x1b[B', '\x1b[B', '\r', '\x1b[B', '\x1b[B', '\r', '\r']);

  // The screen is some other prompt: nothing is pressed.
  const pressed = [];
  await assert.rejects(driveAnswers({ questions: [Q1], answers: [{ choices: [0], text: '' }], screen: async () => ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n', keys: async (b) => pressed.push(b), pause: 1, tries: 2 }), (e) => e.status === 409);
  assert.deepEqual(pressed, []);
});

test('transcript: a question and a plan become cards, their answers answer entries; the newest unanswered one is pending', () => {
  const r = new TranscriptReader();
  const file = path.join(FIX, 'transcript-ask.jsonl');
  const entries = r.read(file);
  const ask = entries.flatMap((e) => e.tools || []).find((t) => t.name === 'AskUserQuestion');
  assert.equal(ask.id, 'toolu_01KNkwDSCHkM8jedbXq2CxjE');
  assert.equal(ask.ask.kind, 'question');
  assert.deepEqual(ask.ask.questions[0].options.map((o) => o.label), ['Blue', 'Orange', 'Green']);
  assert.equal(ask.ask.questions[0].header, 'Color Preference');
  const answers = entries.filter((e) => e.role === 'answer');
  assert.deepEqual(answers.map((a) => [a.kind, a.tool_id]), [['question', 'toolu_01KNkwDSCHkM8jedbXq2CxjE'], ['plan', 'toolu_01AXQW2H4nGNaA2AVjixhWrP']]);
  assert.deepEqual(answers[0].answers, { 'Which of these three colors do you like best?': 'Orange' });
  assert.equal(answers[1].feedback, 'Also add a third step that prints the file.');
  assert.deepEqual(r.pendingAsk(file), { tool_id: 'toolu_011cnsMuYBHjK4WbHpWBiQqC', kind: 'plan', plan: '# Create hello.txt\n\n## Plan\n1. Create `hello.txt`.\n2. Write "hi" into it.\n3. Print it.\n' });
  // The plan's file path on disk is not carried to the browser.
  assert.equal(JSON.stringify(entries).includes('planFilePath'), true, 'the raw tool detail keeps it (as for any tool)');
  assert.equal('planFilePath' in entries.flatMap((e) => e.tools || []).find((t) => t.ask?.kind === 'plan').ask, false);
});

test('askOf / askAnswerOf: bounded, and unusable inputs are not cards', () => {
  assert.equal(askOf('Bash', { command: 'ls' }), null);
  assert.equal(askOf('AskUserQuestion', { questions: [] }), null);
  assert.equal(askOf('AskUserQuestion', { questions: [{ question: 'Q?', options: [] }] }), null);
  const big = askOf('AskUserQuestion', { questions: Array.from({ length: 9 }, () => ({ question: 'x'.repeat(5000), options: Array.from({ length: 40 }, (_, i) => ({ label: `o${i}` })) })) });
  assert.equal(big.questions.length, 4);
  assert.equal(big.questions[0].options.length, 12);
  assert.ok(big.questions[0].question.length <= 600);
  assert.deepEqual(askAnswerOf('plan', { content: 'User has approved your plan.' }, {}), { approved: true });
  assert.deepEqual(askAnswerOf('question', { content: 'rejected', is_error: true }, 'User rejected tool use'), { declined: true });
  assert.deepEqual(askAnswerOf('plan', { content: 'The user doesn\'t want to proceed. STOP', is_error: true }, ''), { declined: true });
});
