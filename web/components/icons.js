// Hand-drawn 16px icon set (no emoji, no icon font). Every icon is a few
// strokes on a 16x16 grid so it stays crisp at 1x and reads at a glance.
import { html } from '../lib/html.js';

const P = {
  home: () => html`<path d="M2.5 7.4 8 2.6l5.5 4.8"/><path d="M4 6.3v7.2h8V6.3"/><path d="M6.6 13.5V10h2.8v3.5"/>`,
  plus: () => html`<path d="M8 3.2v9.6M3.2 8h9.6"/>`,
  search: () => html`<circle cx="7" cy="7" r="4.3"/><path d="m10.3 10.3 3.2 3.2"/>`,
  compass: () => html`<circle cx="8" cy="8" r="5.8"/><path d="m10.6 5.4-1.5 3.7-3.7 1.5 1.5-3.7z"/>`,
  map: () => html`<circle cx="8" cy="8" r="1.7"/><circle cx="8" cy="8" r="5.6"/><circle cx="12.4" cy="4.6" r="1.35" class="fill"/>`,
  user: () => html`<circle cx="8" cy="5.4" r="2.6"/><path d="M3 13.5c.8-2.7 2.8-4.1 5-4.1s4.2 1.4 5 4.1"/>`,
  'user-plus': () => html`<circle cx="6.4" cy="5.4" r="2.5"/><path d="M1.9 13.5c.7-2.6 2.5-4 4.5-4s3.8 1.4 4.5 4"/><path d="M12.6 4.4v4.2M10.5 6.5h4.2"/>`,
  users: () => html`<circle cx="5.8" cy="5.6" r="2.2"/><path d="M1.8 13.2c.6-2.3 2.2-3.6 4-3.6s3.4 1.3 4 3.6"/><path d="M10.4 3.6a2.2 2.2 0 0 1 0 4.1"/><path d="M11.6 9.8c1.3.4 2.2 1.6 2.6 3.4"/>`,
  folder: () => html`<path d="M2 4.6c0-.6.4-1.1 1-1.1h3.1l1.5 1.6H13c.6 0 1 .4 1 1v5.8c0 .6-.4 1.1-1 1.1H3c-.6 0-1-.5-1-1.1z"/>`,
  heart: () => html`<path d="M8 13.3S2.4 10.1 2.4 6.2A2.9 2.9 0 0 1 8 4.9a2.9 2.9 0 0 1 5.6 1.3c0 3.9-5.6 7.1-5.6 7.1z"/>`,
  briefcase: () => html`<rect x="2" y="5" width="12" height="8.2" rx="1.3"/><path d="M5.6 5V3.9c0-.5.4-.9.9-.9h3c.5 0 .9.4.9.9V5"/><path d="M2 8.6h12"/>`,
  chat: () => html`<path d="M3 3.4h10c.6 0 1 .4 1 1v6.1c0 .6-.4 1-1 1H7.2l-3.1 2.4v-2.4H3c-.6 0-1-.4-1-1V4.4c0-.6.4-1 1-1z"/>`,
  'chevrons-left': () => html`<path d="M8.6 4 4.6 8l4 4"/><path d="M12.6 4l-4 4 4 4"/>`,
  'chevrons-right': () => html`<path d="m7.4 4 4 4-4 4"/><path d="m3.4 4 4 4-4 4"/>`,
  'chevron-right': () => html`<path d="m6 3.6 4.4 4.4L6 12.4"/>`,
  'chevron-down': () => html`<path d="M3.6 6 8 10.4 12.4 6"/>`,
  'arrow-left': () => html`<path d="M13 8H3.6"/><path d="M7.4 4.2 3.6 8l3.8 3.8"/>`,
  x: () => html`<path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/>`,
  more: () => html`<circle cx="8" cy="3.6" r="1.1" class="fill"/><circle cx="8" cy="8" r="1.1" class="fill"/><circle cx="8" cy="12.4" r="1.1" class="fill"/>`,
  terminal: () => html`<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><path d="m4.6 6.4 1.9 1.7-1.9 1.7"/><path d="M8.2 10h3.2"/>`,
  copy: () => html`<rect x="5.4" y="5.4" width="8.1" height="8.1" rx="1.3"/><path d="M10.6 5.4V3.6c0-.6-.4-1.1-1-1.1H3.6c-.6 0-1.1.5-1.1 1.1v6c0 .6.5 1 1.1 1h1.8"/>`,
  maximize: () => html`<path d="M9.6 2.6h3.8v3.8"/><path d="M6.4 13.4H2.6V9.6"/><path d="m13.4 2.6-4.3 4.3"/><path d="m2.6 13.4 4.3-4.3"/>`,
  restore: () => html`<path d="M13.4 2.6 9.4 6.6"/><path d="M9.4 3.2v3.4h3.4"/><path d="m2.6 13.4 4-4"/><path d="M6.6 12.8V9.4H3.2"/>`,
  sliders: () => html`<path d="M2.6 4.2h6.2M12.2 4.2h1.2M2.6 8h1.6M7.6 8h5.8M2.6 11.8h7M13 11.8h.4"/><circle cx="10.5" cy="4.2" r="1.6"/><circle cx="5.9" cy="8" r="1.6"/><circle cx="11.3" cy="11.8" r="1.6"/>`,
  'layout-focus': () => html`<rect x="2" y="2.6" width="12" height="10.8" rx="1.4"/><path d="M2 5.6h12"/><path d="M5.6 2.6v3"/>`,
  'layout-split': () => html`<rect x="2" y="2.6" width="12" height="10.8" rx="1.4"/><path d="M8 2.6v10.8"/>`,
  'layout-grid': () => html`<rect x="2" y="2.6" width="12" height="10.8" rx="1.4"/><path d="M8 2.6v10.8M2 8h12"/>`,
  'pane-hide': () => html`<rect x="2" y="2.6" width="12" height="10.8" rx="1.4"/><path d="M5.4 8h5.2"/>`,
  play: () => html`<path d="M5.2 3.6v8.8l7-4.4z"/>`,
  check: () => html`<path d="m3.4 8.6 3 3 6.2-7"/>`,
  book: () => html`<path d="M2.6 3.2h3.6c1 0 1.8.8 1.8 1.8v8.2c0-.8-.7-1.4-1.5-1.4H2.6z"/><path d="M13.4 3.2H9.8C8.8 3.2 8 4 8 5v8.2c0-.8.7-1.4 1.5-1.4h3.9z"/>`,
  coin: () => html`<circle cx="8" cy="8" r="5.6"/><path d="M9.7 6.3c-.3-.6-1-1-1.8-1-1 0-1.8.5-1.8 1.3 0 1.9 3.8 1 3.8 3 0 .8-.8 1.4-1.9 1.4-.9 0-1.6-.4-1.9-1.1"/><path d="M8 4.3v1M8 10.9v.9"/>`,
  alert: () => html`<path d="M8 2.6 14 13H2z"/><path d="M8 6.6v3"/><circle cx="8" cy="11.2" r=".7" class="fill"/>`,
  refresh: () => html`<path d="M13.2 3.8v3.3H9.9"/><path d="M12.8 7.1A5 5 0 1 0 13 10"/>`,
  archive: () => html`<path d="M2.4 3.4h11.2v3H2.4z"/><path d="M3.4 6.4v6c0 .6.4 1 1 1h7.2c.6 0 1-.4 1-1v-6"/><path d="M6.4 9h3.2"/>`,
  send: () => html`<path d="M13.6 2.4 2.4 7.2l4.4 1.6 1.6 4.8z"/><path d="m6.8 8.8 3-3"/>`,
  phone: () => html`<rect x="4.4" y="1.8" width="7.2" height="12.4" rx="1.6"/><path d="M7.2 11.8h1.6"/>`,
  key: () => html`<circle cx="5.4" cy="10.6" r="2.8"/><path d="m7.4 8.6 5.8-5.8M11.2 4.8l1.6 1.6M9.6 6.4l1.2 1.2"/>`,
  spark: () => html`<path d="M8 2v3.2M8 10.8V14M2 8h3.2M10.8 8H14M3.8 3.8l2.2 2.2M10 10l2.2 2.2M12.2 3.8 10 6M6 10l-2.2 2.2"/>`,
  dot: () => html`<circle cx="8" cy="8" r="3" class="fill"/>`,
  star: () => html`<path d="m8 2.3 1.75 3.62 3.95.55-2.87 2.76.7 3.93L8 11.3l-3.53 1.86.7-3.93L2.3 6.47l3.95-.55z"/>`,
  pen: () => html`<path d="m10.4 2.9 2.7 2.7-7.3 7.3-3.4.7.7-3.4z"/><path d="m9.1 4.2 2.7 2.7"/>`,
  plane: () => html`<path d="M7.1 2.6c.5-.5 1.3-.5 1.8 0v4.1l4.9 2.6v1.6l-4.9-1.3v2.7l1.4 1.2v1.1L8 13.8l-2.3.8v-1.1l1.4-1.2V9.6l-4.9 1.3V9.3l4.9-2.6z"/>`,
  keyboard: () => html`<rect x="1.6" y="4" width="12.8" height="8" rx="1.4"/><path d="M4.2 6.6h.1M6.7 6.6h.1M9.2 6.6h.1M11.7 6.6h.1M4.6 9.4h6.8"/>`,
  external: () => html`<path d="M9.4 2.6h4v4"/><path d="M13.4 2.6 7.6 8.4"/><path d="M11.4 9.4v3c0 .6-.4 1-1 1H3.6c-.6 0-1-.4-1-1V5.6c0-.6.4-1 1-1h3"/>`,
  layers: () => html`<path d="M8 2.4 14 5.6 8 8.8 2 5.6z"/><path d="m2 8.6 6 3.2 6-3.2"/><path d="m2 11.4 6 3.2 6-3.2"/>`,
  import: () => html`<path d="M8 2.4v7.4"/><path d="M5 7 8 10l3-3"/><path d="M2.6 9.8v2.6c0 .6.4 1.1 1 1.1h8.8c.6 0 1-.5 1-1.1V9.8"/>`,
  monitor: () => html`<rect x="2" y="2.8" width="12" height="8.4" rx="1.3"/><path d="M5.6 13.6h4.8M8 11.2v2.4"/>`,
  cloud: () => html`<path d="M4.7 12.6h6.9a2.8 2.8 0 0 0 .3-5.6 4 4 0 0 0-7.7-1 3.3 3.3 0 0 0 .5 6.6z"/>`,
  clock: () => html`<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.1 1.3"/>`,
};

// Agent icons stored in agent.json map onto the set above; unknown names
// fall back to the agent's initial so a custom icon never renders blank.
const ALIASES = {
  coins: 'coin', pencil: 'pen', travel: 'plane', trip: 'plane', writing: 'pen',
  work: 'briefcase', job: 'briefcase', health: 'heart', fitness: 'heart', money: 'coin', finance: 'coin',
  dollar: 'coin', wallet: 'coin', family: 'users', people: 'users', team: 'users', learning: 'book',
  school: 'book', study: 'book', project: 'folder', code: 'terminal', repo: 'folder', donna: 'chat',
  chief: 'chat', message: 'chat', house: 'home', settings: 'sliders', gear: 'sliders',
};

export function hasIcon(name) {
  return !!(name && (P[name] || P[ALIASES[name]]));
}

export function Icon({ name, size = 16, title, class: cls = '' }) {
  const make = P[name] || P[ALIASES[name]];
  if (!make) return null;
  const body = make();
  return html`<svg class=${`icon ${cls}`} width=${size} height=${size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden=${title ? undefined : 'true'}
    role=${title ? 'img' : undefined} focusable="false">${title ? html`<title>${title}</title>` : null}${body}</svg>`;
}

// The Clawdling mark: an open pincer. Two strokes, one accent colour.
export function Mark({ size = 18 }) {
  return html`<svg class="mark" width=${size} height=${size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
    <g stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 18.5C7 11.6 12.4 7 18.3 7.6c3 .3 5.2 2.3 5.9 4.9l-5.6 2.1"/>
      <path d="M7 18.5c.8 4.2 4.4 6.6 8.6 6.6 3.4 0 6.4-1.6 7.9-4.4l-5.9-1.4"/>
    </g></svg>`;
}

// Agent avatar: its own icon when we have one, else its initial.
export function AgentIcon({ agent, size = 16 }) {
  const name = agent && agent.icon;
  if (hasIcon(name)) return html`<${Icon} name=${name} size=${size} />`;
  const fallback = agent && agent.kind === 'chief' ? 'chat' : agent && agent.kind === 'cto' ? 'compass' : agent && agent.kind === 'project' ? 'folder' : null;
  if (fallback && !(agent && agent.name)) return html`<${Icon} name=${fallback} size=${size} />`;
  const letter = ((agent && (agent.name || agent.id)) || '?').trim().charAt(0).toUpperCase();
  return html`<span class="initial" aria-hidden="true">${letter}</span>`;
}
