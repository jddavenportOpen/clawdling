// The pane header's model and effort chips. A chip shows what the session runs on and, between
// turns (your turn), switches it: the server resumes this session's claude on the same
// conversation with the new --model / --effort, for this session only (POST .../settings).
import { html } from '../lib/html.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { Icon } from './icons.js';
import { mergeSession, toast, errorToast } from '../lib/actions.js';
import { MODEL_CHOICES, EFFORT_CHOICES, isIdle, isEnded } from '../lib/model.js';

const BUSY_TITLE = "Change it between turns: wait until it's your turn.";

const KINDS = {
  model: { choices: MODEL_CHOICES, label: (v) => v || 'Default model', what: 'Model' },
  effort: { choices: EFFORT_CHOICES, label: (v) => (v ? `effort: ${v}` : 'Default effort'), what: 'Effort' },
};

async function change(s, kind, value) {
  try {
    const next = await api.sessionSettings(s.sid, { [kind]: value });
    mergeSession(next && next.sid ? next : { sid: s.sid, [kind]: value });
  } catch (e) {
    if (e && e.status === 409) toast(`Wait for your turn to change the ${kind}.`, { ms: 3600 });
    else errorToast(`Could not change the ${kind}`, e);
  }
}

function Chip({ s, kind }) {
  const k = KINDS[kind];
  const value = s[kind] || null;
  const [open, setOpen] = useState(null); // {top, left} of the menu while it is open
  const btn = useRef(null);
  const menu = useRef(null);
  const idle = isIdle(s);
  const base = value ? `${k.what}: ${value}` : `${k.what}: your Claude Code default`;

  // Layout effect: Escape and focus work from the very first frame the menu exists.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const first = menu.current && (menu.current.querySelector('[aria-checked="true"]') || menu.current.querySelector('button'));
    if (first) first.focus();
    const away = (e) => {
      if (menu.current && menu.current.contains(e.target)) return;
      if (btn.current && btn.current.contains(e.target)) return;
      setOpen(null);
    };
    const close = () => setOpen(null);
    // Escape closes the menu wherever focus is (the terminal may still hold it).
    const esc = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(null);
      if (btn.current) btn.current.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // Leaving "your turn" while the menu is open closes it.
  useEffect(() => { if (!idle && open) setOpen(null); }, [idle]);

  if (isEnded(s)) {
    return html`<span class=${`pane-pick pane-pick-${kind} is-static`} title=${base} data-testid=${`chip-${kind}`}>${k.label(value)}</span>`;
  }

  const toggle = () => {
    if (!idle) return;
    if (open) { setOpen(null); return; }
    const r = btn.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 180));
    setOpen({ top: r.bottom + 4, left });
  };
  const pick = (v) => {
    setOpen(null);
    if (btn.current) btn.current.focus();
    if (v !== value) change(s, kind, v);
  };
  const onMenuKey = (e) => {
    const items = [...menu.current.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') setOpen(null);
  };

  return html`<span class="pane-pick-wrap">
    <button ref=${btn} type="button" class=${`pane-pick pane-pick-${kind}`} onClick=${toggle}
      aria-disabled=${idle ? undefined : 'true'} aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'}
      title=${idle ? `${base}. Click to change.` : `${base}. ${BUSY_TITLE}`} data-testid=${`chip-${kind}`}>${k.label(value)}</button>
    ${open ? html`<div ref=${menu} class="menu pick-menu" role="menu" aria-label=${k.what} style=${{ top: `${open.top}px`, left: `${open.left}px` }} onKeyDown=${onMenuKey}>
      ${k.choices.map((c) => html`<button type="button" class="menu-item" role="menuitemradio" aria-checked=${c === value ? 'true' : 'false'}
        onClick=${() => pick(c)} data-testid="chip-option" data-value=${c}><span class="pick-check" aria-hidden="true">${c === value ? html`<${Icon} name="check" />` : null}</span>${c}</button>`)}
    </div>` : null}
  </span>`;
}

export function PaneChips({ s }) {
  if (!s) return null;
  return html`<span class="pane-picks"><${Chip} s=${s} kind="model" /><${Chip} s=${s} kind="effort" /></span>`;
}
