// Answering Claude Code's own questions (AskUserQuestion) from a question card.
//
// Claude Code draws the question as a list in the terminal (2.1.283):
//
//    ☐ Color                                    one question; several show a tab row:
//                                               ←  ☐ Color  ☐ Pets  ✔ Submit  →
//   Which color do you like best?
//
//   ❯ 1. Red                                    the pointer; arrows move it, Enter picks
//        A warm, bold color.                    (a multiSelect question toggles [ ] / [✔]
//     2. Green                                  boxes, then "Submit" moves on)
//     3. Type something.                        free text: type on this line, then Enter
//   ──────────
//     4. Chat about this
//
// and, after several questions, a review: "Ready to submit your answers?" 1. Submit answers.
//
// The card's answer is given the way a person would: read the screen, check it shows THIS
// question with THESE options (so a key never lands on some other prompt), move the pointer, check
// it is there, press Enter. Nothing here can approve a tool: a screen that is not the expected
// question stops the answer with an error.
import { conflict, badRequest, sleep } from './util.js';

const POINTER = '❯';
const KEY = { up: Buffer.from('\x1b[A'), down: Buffer.from('\x1b[B'), enter: Buffer.from('\r') };
const OPTION_RE = new RegExp(`^\\s*(${POINTER}\\s*)?(\\d+)\\.\\s+(.*)$`);
const SUBMIT_RE = new RegExp(`^\\s*(${POINTER})?\\s*Submit\\s*$`);
const BOX_RE = /^\[([ ✔✓xX])\]\s*/;
const RULE_RE = /^\s*[─━╌┄-]{8,}/;
const REVIEW_RE = /Ready to submit your answers\?/;
const OTHER_RE = /^Type something\.?$/i; // the free-text line every AskUserQuestion list ends with
const FOOTER_RE = /Enter to select\b/; // AskUserQuestion's own footer (a permission prompt has another)
const PLAN_RE = /Would you like to proceed\?/;
const PLAN_FEEDBACK_RE = new RegExp(`^\\s*(?:${POINTER}\\s*)?\\d+\\.\\s+Tell Claude what to change\\b`, 'i');
const TEXT_MAX = 1000;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** Does a label on screen match the option's label? (the screen can cut a long one short) */
const sameLabel = (screen, want) => {
  const a = norm(screen);
  const b = norm(want);
  return a === b || (b.length > 30 && a.length >= 30 && b.startsWith(a.replace(/…$/, '')));
};

/**
 * The question `q` as it is on `screen` now, or null when the screen does not show it:
 * {items: [{n, label, checked, selected}], submit: {selected}|null, selected: index}, where the
 * last index past the items is the multiSelect "Submit" line.
 */
export function readQuestion(screen, q) {
  const lines = String(screen || '').split('\n');
  const want = norm(q.question);
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = norm(lines[i]);
    if (l && (l === want || (want.length > 40 && l.startsWith(want.slice(0, 40))))) {
      at = i;
      break;
    }
  }
  if (at === -1) return null;
  const items = [];
  let submit = null;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (RULE_RE.test(line)) break;
    const m = OPTION_RE.exec(line);
    if (m) {
      const n = Number(m[2]);
      if (n !== items.length + 1) break;
      let label = m[3];
      let checked = null;
      const box = BOX_RE.exec(label);
      if (box) {
        checked = box[1] !== ' ';
        label = label.slice(box[0].length);
      }
      items.push({ n, label: label.trim(), checked, selected: !!m[1] });
      continue;
    }
    const s = SUBMIT_RE.exec(line);
    if (s && items.length) submit = { selected: !!s[1] };
  }
  const n = q.options.length;
  if (items.length < n + 1) return null; // the options, then "Type something"
  // An AskUserQuestion list, not some other prompt with the same lines: its free-text line, and
  // its own footer below the list.
  // (With the pointer on it, a one-pick question's free-text line holds what was typed so far.)
  if (!OTHER_RE.test(norm(items[n].label)) && !(items[n].selected && !q.multiSelect)) return null;
  if (!lines.slice(at + 1).some((l) => FOOTER_RE.test(l))) return null;
  for (let i = 0; i < n; i++) if (!sameLabel(items[i].label, q.options[i].label)) return null;
  if (q.multiSelect && !submit) return null;
  let selected = items.findIndex((it) => it.selected);
  if (selected === -1 && submit?.selected) selected = n + 1;
  if (selected === -1) return null;
  return { items: items.slice(0, n + 1), submit, selected };
}

/** Is `screen` Claude Code's plan approval ("Would you like to proceed?" with "Tell Claude what to change")? */
export function isPlanScreen(screen) {
  const lines = String(screen || '').split('\n');
  return lines.some((l) => PLAN_RE.test(l)) && lines.some((l) => PLAN_FEEDBACK_RE.test(l));
}

/** Does `screen` show this pending ask (its first question, or a plan approval)? */
export function screenShowsAsk(screen, ask) {
  if (!ask) return false;
  if (ask.kind === 'plan') return isPlanScreen(screen);
  return !!(ask.questions && ask.questions[0] && readQuestion(screen, ask.questions[0]));
}

/**
 * Check a card's answers against the questions: [{choices: [0-based option index...], text?}].
 * A one-pick question takes one choice or a free-text answer; a multiSelect one takes one or more
 * choices. Returns the cleaned list, or throws a 400.
 */
export function checkAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) throw badRequest(`send one answer per question (${questions.length})`);
  return answers.map((a, i) => {
    const q = questions[i];
    const text = typeof a?.text === 'string' ? a.text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, TEXT_MAX) : '';
    const raw = Array.isArray(a?.choices) ? a.choices : [];
    if (!raw.every((c) => Number.isInteger(c) && c >= 0 && c < q.options.length)) throw badRequest(`question ${i + 1}: choices must be option numbers from 0 to ${q.options.length - 1}`);
    const choices = [...new Set(raw)].sort((x, y) => x - y);
    if (q.multiSelect) {
      if (text) throw badRequest(`question ${i + 1}: pick from the options (a typed answer goes through the terminal)`);
      if (!choices.length) throw badRequest(`question ${i + 1}: pick at least one option`);
      return { choices, text: '' };
    }
    if (text ? choices.length : choices.length !== 1) throw badRequest(`question ${i + 1}: pick one option, or type an answer`);
    return { choices, text };
  });
}

/** What the person answered, in words, for the event log and the reply. */
export function answerLabels(questions, answers) {
  return answers.map((a, i) => (a.text ? a.text : a.choices.map((c) => questions[i].options[c].label).join(', ')));
}

/**
 * Drive the terminal through every question, then the review. `screen()` returns the screen text;
 * `keys(buf)` sends bytes. Throws a 409 when the screen is not what the card expects.
 */
export async function driveAnswers({ questions, answers, screen, keys, pause = 200, tries = 10 }) {
  const read = async (q) => {
    for (let t = 0; t < tries; t++) {
      const r = readQuestion(await screen(), q);
      if (r) return r;
      await sleep(pause + t * 50);
    }
    throw conflict(`the question "${norm(q.question).slice(0, 80)}" is not on screen any more`);
  };
  const moveTo = async (q, target) => {
    for (let t = 0; t < 8; t++) {
      const r = await read(q);
      const moves = target - r.selected;
      if (moves === 0) return r;
      const key = moves > 0 ? KEY.down : KEY.up;
      for (let i = 0; i < Math.abs(moves); i++) await keys(key);
      await sleep(pause);
    }
    throw conflict('could not move the selection onto that choice');
  };
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const a = answers[qi];
    const n = q.options.length;
    if (q.multiSelect) {
      for (let i = 0; i < n; i++) {
        const want = a.choices.includes(i);
        const r = await read(q);
        if (!!r.items[i].checked === want) continue;
        await moveTo(q, i);
        await keys(KEY.enter);
        await sleep(pause);
        const after = await read(q);
        if (!!after.items[i].checked !== want) throw conflict(`could not ${want ? 'tick' : 'untick'} "${q.options[i].label}"`);
      }
      await moveTo(q, n + 1);
      await keys(KEY.enter);
    } else if (a.text) {
      await moveTo(q, n);
      await keys(Buffer.from(a.text, 'utf8'));
      await sleep(pause);
      const r = await read(q);
      if (r.selected !== n || !norm(r.items[n].label).includes(norm(a.text).slice(0, 40))) throw conflict('the typed answer did not reach the question');
      await keys(KEY.enter);
    } else {
      await moveTo(q, a.choices[0]);
      await keys(KEY.enter);
    }
    if (qi < questions.length - 1) await sleep(pause);
  }
  if (questions.length > 1) {
    // The review: "Ready to submit your answers?" 1. Submit answers / 2. Cancel.
    for (let t = 0; t < tries; t++) {
      const text = await screen();
      if (REVIEW_RE.test(text)) {
        const lines = text.split('\n');
        const at = lines.findIndex((l) => REVIEW_RE.test(l));
        const opts = lines.slice(at + 1).map((l) => OPTION_RE.exec(l)).filter(Boolean);
        const submit = opts.findIndex((m) => /^Submit answers\b/i.test(m[3].trim()));
        const sel = opts.findIndex((m) => !!m[1]);
        if (submit === -1 || sel === -1) throw conflict('the review screen has no "Submit answers"');
        const moves = submit - sel;
        for (let i = 0; i < Math.abs(moves); i++) await keys(moves > 0 ? KEY.down : KEY.up);
        if (moves) await sleep(pause);
        const again = (await screen()).split('\n');
        const at2 = again.findIndex((l) => REVIEW_RE.test(l));
        const now = again.slice(at2 + 1).map((l) => OPTION_RE.exec(l)).filter(Boolean);
        if (at2 === -1 || !now[submit]?.[1]) throw conflict('could not select "Submit answers"');
        await keys(KEY.enter);
        return;
      }
      await sleep(pause + t * 50);
    }
    throw conflict('the review screen did not appear');
  }
}
