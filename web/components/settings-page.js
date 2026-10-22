// Settings (#/settings): appearance, workspace, shortcuts, and what the server reports.
import { html } from '../lib/html.js';
import { useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { getThemePref, setThemePref } from '../lib/theme.js';
import { load, save } from '../lib/prefs.js';
import { terms } from '../lib/term.js';
import { closeAllPanes, toast } from '../lib/actions.js';
import { refreshHealth } from '../lib/live.js';
import { MOD } from '../lib/util.js';

export function SettingsPage() {
  const health = useStore((s) => s.health);
  const open = useStore((s) => s.open);
  const [theme, setTheme] = useState(getThemePref());
  const [font, setFont] = useState(Number(load('termFontSize', 13)) || 13);

  const pickTheme = (t) => { setTheme(t); setThemePref(t); };
  const pickFont = (px) => {
    setFont(px);
    save('termFontSize', px);
    for (const v of terms.values()) v.setFontSize();
  };
  const ok = (x) => x && (x.ok === true || x.ok === 'true');

  return html`<div class="page settings-page" data-testid="settings-page">
    <header class="page-bar"><div class="page-bar-main"><h1 class="page-title">Settings</h1>
      <p class="page-sub">Stored in this browser. Your org itself lives in files on disk.</p></div></header>
    <div class="settings-grid">
      <section class="card" aria-labelledby="set-look">
        <h2 id="set-look" class="card-title">Appearance</h2>
        <div class="set-row"><span class="set-label">Theme</span>
          <div class="seg" role="radiogroup" aria-label="Theme">
            ${[['system', 'System'], ['dark', 'Dark'], ['light', 'Light']].map(([v, l]) => html`<button role="radio" aria-checked=${theme === v ? 'true' : 'false'}
              class=${`seg-btn ${theme === v ? 'is-on' : ''}`} onClick=${() => pickTheme(v)}><span class="seg-label">${l}</span></button>`)}
          </div></div>
        <div class="set-row"><span class="set-label">Terminal text</span>
          <div class="seg" role="radiogroup" aria-label="Terminal font size">
            ${[12, 13, 14, 15, 16].map((px) => html`<button role="radio" aria-checked=${font === px ? 'true' : 'false'}
              class=${`seg-btn ${font === px ? 'is-on' : ''}`} onClick=${() => pickFont(px)}><span class="seg-label">${px}</span></button>`)}
          </div></div>
      </section>
      <section class="card" aria-labelledby="set-ws">
        <h2 id="set-ws" class="card-title">Workspace</h2>
        <div class="set-row"><span class="set-label">Open panes<span class="set-sub">${open.length} open. Closing panes never stops a session.</span></span>
          <button class="btn btn-quiet" onClick=${() => { closeAllPanes(); toast('All panes closed. Sessions are still running.', { tone: 'ok' }); }} disabled=${!open.length}>Close all panes</button></div>
      </section>
      <section class="card" aria-labelledby="set-keys">
        <h2 id="set-keys" class="card-title">Keyboard</h2>
        <dl class="keys">
          <div><dt><kbd>${MOD}</kbd><kbd>K</kbd></dt><dd>Jump to a session or agent, or run a command</dd></div>
          <div><dt><kbd>${MOD}</kbd><kbd>\\</kbd></dt><dd>Collapse or expand the sidebar</dd></div>
          <div><dt><kbd>${MOD}</kbd><kbd>1</kbd>–<kbd>9</kbd></dt><dd>Focus pane 1 to 9</dd></div>
          <div><dt><kbd>Shift</kbd><kbd>↵</kbd></dt><dd>New line in Claude Code's prompt</dd></div>
          <div><dt>Double-click a title</dt><dd>Rename the session</dd></div>
        </dl>
      </section>
      <section class="card" aria-labelledby="set-server">
        <h2 id="set-server" class="card-title">Server <button class="link-btn" onClick=${refreshHealth}>Refresh</button></h2>
        ${health ? html`<dl class="facts">
          <div><dt>Clawdling</dt><dd class="mono">${health.version || 'unknown'}</dd></div>
          <div><dt>tmux</dt><dd class="mono">${health.tmux ? `${ok(health.tmux) ? 'ok' : 'missing'}${health.tmux.version ? ` · ${health.tmux.version}` : ''}` : 'unknown'}</dd></div>
          <div><dt>claude CLI</dt><dd class="mono">${health.claude ? `${ok(health.claude) ? 'ok' : 'missing'}${health.claude.version ? ` · ${health.claude.version}` : ''}` : 'unknown'}</dd></div>
          <div><dt>Org folder</dt><dd class="mono">${health.home || 'unknown'}</dd></div>
        </dl>` : html`<p class="panel-quiet">The server did not report its health.</p>`}
        <p class="set-note">Clawdling only ever starts the official <code>claude</code> binary you are signed into. It never reads or forwards your credentials.</p>
      </section>
    </div>
  </div>`;
}
