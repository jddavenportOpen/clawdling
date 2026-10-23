// The message box under a pane: on the phone always, and in the chat view on every screen.
// It sends through POST /api/sessions/:sid/send, like the iPhone app.
import { html } from '../lib/html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.js';
import { toast, errorToast } from '../lib/actions.js';
import { api } from '../lib/api.js';
import { load, save } from '../lib/prefs.js';
import { speechCtor, transcriptOf, joinDictation, VOICE_NOTE } from '../lib/voice.js';

// The phone has no hardware keyboard, and typing into xterm through the iOS keyboard fights
// autocorrect and the hidden textarea. A plain composer sends the text with POST /send.
const ANSWER_FIRST = new Set(['trust', 'imports', 'login', 'startup', 'permission_prompt', 'elicitation_dialog']);
const COMPOSER_MAX_LINES = 5;

const MicIcon = () => html`<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
  stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2"/></svg>`;

export function Composer({ s, agent }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const area = useRef(null);
  const rec = useRef(null);
  const waiting = s.status === 'needs_you' && ANSWER_FIRST.has(s.waiting_on);
  const Speech = speechCtor();
  const grow = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * COMPOSER_MAX_LINES + 18)}px`;
  };
  const stopVoice = () => {
    const r = rec.current;
    rec.current = null;
    setListening(false);
    if (r) { try { r.stop(); } catch { /* already stopped */ } }
  };
  // Stop listening when the pane goes away, or when the box is disabled under it.
  useEffect(() => () => { const r = rec.current; rec.current = null; if (r) { try { r.abort ? r.abort() : r.stop(); } catch { /* gone */ } } }, []);
  useEffect(() => { if (waiting && rec.current) stopVoice(); }, [waiting]);

  const startVoice = () => {
    if (!Speech || rec.current) return;
    let r;
    try { r = new Speech(); } catch { return; }
    const base = text;
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = true;
    // The words fill the box for you to read over; they are never sent on their own.
    r.onresult = (e) => {
      if (rec.current !== r) return;
      setText(joinDictation(base, transcriptOf(e.results)));
      requestAnimationFrame(grow);
    };
    r.onerror = (e) => {
      if (e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')) {
        toast('The microphone is blocked. Allow it for this site in your browser settings.', { tone: 'error', ms: 5200 });
      }
      if (rec.current === r) stopVoice();
    };
    r.onend = () => { if (rec.current === r) { rec.current = null; setListening(false); } };
    rec.current = r;
    try {
      r.start();
    } catch {
      rec.current = null;
      return;
    }
    setListening(true);
    if (!load('voice.noted', false)) {
      save('voice.noted', true);
      toast(VOICE_NOTE, { ms: 7000 });
    }
  };

  const submit = async (e) => {
    if (e) e.preventDefault();
    const t = text.trim();
    if (!t || busy || waiting) return;
    if (rec.current) stopVoice();
    setBusy(true);
    try {
      await api.send(s.sid, t, true);
      setText('');
      requestAnimationFrame(grow);
    } catch (err) {
      if (err && err.status === 409) toast('Answer the question above first.', { ms: 3600 });
      else errorToast('Could not send the message', err);
    } finally {
      setBusy(false);
    }
  };
  return html`<form class="pane-composer" onSubmit=${submit} data-testid="pane-composer">
    <textarea ref=${area} rows="1" value=${text} onInput=${(e) => { setText(e.currentTarget.value); grow(); }}
      onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } }}
      placeholder=${waiting ? 'Answer the question above first' : listening ? 'Listening…' : `Message ${agent}…`} aria-label=${`Message ${agent}`}
      enterkeyhint="send" disabled=${waiting} data-testid="composer-input"></textarea>
    ${Speech ? html`<button class="btn btn-quiet composer-mic" type="button" aria-label="Dictate" aria-pressed=${listening ? 'true' : 'false'}
      title=${listening ? 'Stop dictation' : 'Dictate'} disabled=${waiting} onClick=${() => (listening ? stopVoice() : startVoice())} data-testid="composer-mic">
      <${MicIcon} /></button>` : null}
    <button class="btn btn-primary composer-send" type="submit" aria-label="Send" disabled=${waiting || busy || !text.trim()} data-testid="composer-send">
      <${Icon} name="send" /></button>
  </form>`;
}
