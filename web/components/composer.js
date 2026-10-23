// The message box under a pane: on the phone always, and in the chat view on every screen.
// It sends through POST /api/sessions/:sid/send, like the iPhone app.
import { html } from '../lib/html.js';
import { useRef, useState } from 'preact/hooks';
import { Icon } from './icons.js';
import { toast, errorToast } from '../lib/actions.js';
import { api } from '../lib/api.js';

// The phone has no hardware keyboard, and typing into xterm through the iOS keyboard fights
// autocorrect and the hidden textarea. A plain composer sends the text with POST /send.
const ANSWER_FIRST = new Set(['trust', 'imports', 'login', 'startup', 'permission_prompt', 'elicitation_dialog']);
const COMPOSER_MAX_LINES = 5;

export function Composer({ s, agent }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const area = useRef(null);
  const waiting = s.status === 'needs_you' && ANSWER_FIRST.has(s.waiting_on);
  const grow = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * COMPOSER_MAX_LINES + 18)}px`;
  };
  const submit = async (e) => {
    if (e) e.preventDefault();
    const t = text.trim();
    if (!t || busy || waiting) return;
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
      placeholder=${waiting ? 'Answer the question above first' : `Message ${agent}…`} aria-label=${`Message ${agent}`}
      enterkeyhint="send" disabled=${waiting} data-testid="composer-input"></textarea>
    <button class="btn btn-primary composer-send" type="submit" aria-label="Send" disabled=${waiting || busy || !text.trim()} data-testid="composer-send">
      <${Icon} name="send" /></button>
  </form>`;
}
