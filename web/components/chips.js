// The pane header's model and effort chips. (Stub: the chips lane fills this in.)
import { html } from '../lib/html.js';

export function PaneChips({ s }) {
  return s.model ? html`<span class="pane-model" title="Model">${s.model}</span>` : null;
}
