// Status glyphs differ in SHAPE as well as colour, so they read without colour:
// new = dashed ring, working = turning arc, your turn = solid dot,
// needs you = diamond, ended = hollow ring.
import { html } from '../lib/html.js';
import { STATUS_LABEL } from '../lib/model.js';

export function StatusGlyph({ status, size = 12, label = true }) {
  const st = STATUS_LABEL[status] ? status : 'ended';
  const aria = label ? { role: 'img', 'aria-label': STATUS_LABEL[st] } : { 'aria-hidden': 'true' };
  let body;
  if (st === 'starting') body = html`<circle cx="6" cy="6" r="4.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.1 2.2" />`;
  else if (st === 'working') {
    body = html`<circle cx="6" cy="6" r="4.1" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.28" />
      <path class="spin" d="M6 1.9a4.1 4.1 0 0 1 4.1 4.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />`;
  } else if (st === 'ready') body = html`<circle cx="6" cy="6" r="3.6" fill="currentColor" />`;
  else if (st === 'needs_you') body = html`<path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="currentColor" />`;
  else body = html`<circle cx="6" cy="6" r="3.6" fill="none" stroke="currentColor" stroke-width="1.5" />`;
  return html`<svg class=${`glyph st-${st}`} width=${size} height=${size} viewBox="0 0 12 12" focusable="false" ...${aria}>${body}</svg>`;
}
