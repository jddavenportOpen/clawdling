// Dictation into the composer through the browser's own Web Speech API. Pure helpers here,
// so the joining rules are unit-tested without a browser.

/** The browser's SpeechRecognition constructor, or null where there is none (Firefox). */
export function speechCtor(win = typeof window === 'undefined' ? undefined : window) {
  if (!win) return null;
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

/** What the recognizer has heard so far: every result's best guess, in order. */
export function transcriptOf(results) {
  let out = '';
  if (!results) return out;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const alt = r && r[0];
    if (alt && typeof alt.transcript === 'string') out += alt.transcript;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** The text already in the box, then what was said, with one space between them. */
export function joinDictation(base, heard) {
  const b = String(base || '');
  const h = String(heard || '').trim();
  if (!h) return b;
  if (!b.trim()) return h;
  return /\s$/.test(b) ? b + h : `${b} ${h}`;
}

export const VOICE_NOTE = "Dictation uses your browser's own speech service, which may send the audio to its maker (Google, in Chrome).";
