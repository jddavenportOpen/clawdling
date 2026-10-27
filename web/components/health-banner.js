// The server says a tool every session needs is missing (claude, tmux, or any other check it
// reports in /api/health). One persistent banner on every screen, phone included, that names the
// fix, instead of a toast that disappears after five seconds. Every "start a session" control is
// disabled while it shows.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon } from './icons.js';
import { healthProblems } from '../lib/model.js';
import { refreshHealth } from '../lib/live.js';
import { toast } from '../lib/actions.js';
import { cliCmd } from '../lib/util.js';
import { load, save } from '../lib/prefs.js';

export const BLOCKED_TITLE = 'Fix the problem above first';

// True while the banner shows: start buttons are disabled with BLOCKED_TITLE.
export function useStartBlocked() {
  return useStore((s) => healthProblems(s.health).length > 0);
}

const sentence = (t) => {
  const s = String(t || '').trim().replace(/[.\s]+$/, '');
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : '';
};

function tmuxInstall(platform) {
  if (platform === 'darwin') return html`<code>brew install tmux</code>`;
  if (platform === 'linux') return html`<code>sudo apt install tmux</code> (or your distribution's package manager)`;
  return html`<code>brew install tmux</code> on macOS or <code>sudo apt install tmux</code> on Linux`;
}

function ProblemText({ p, health }) {
  if (p.id === 'claude') {
    if (!p.error || /not found/i.test(p.error)) {
      return html`<strong>Clawdling can't find the <code>claude</code> command, so no agent can start.</strong>${' '}
        Install Claude Code and sign in, then restart Clawdling. Already installed? Restart Clawdling from a terminal where
        <code>which claude</code> prints a path (if it starts at login, run <code>${cliCmd('service install', health)}</code> there).`;
    }
    return html`<strong>Clawdling found <code>claude</code>, but it does not run, so no agent can start.</strong>${' '}
      Reinstall Claude Code, then check again. <span class="hb-detail">${p.error}</span>`;
  }
  if (p.id === 'tmux') {
    return html`<strong>Clawdling can't find tmux 3.2 or newer, so no session can start.</strong>${' '}
      Install it with ${tmuxInstall(health.platform)}, then restart Clawdling.`;
  }
  // A check this cockpit has no special words for: the server's own text, and its fix if it sent one.
  return html`<strong>${sentence(p.error || `${p.label || p.id} is not available`)}</strong>${' '}
    ${p.fix ? sentence(p.fix) : html`Run <code>${cliCmd('doctor', health)}</code> in a terminal for the fix.`}`;
}

const RECHECK_MS = 30000;

export function HealthBanner() {
  const health = useStore((s) => s.health);
  const [busy, setBusy] = useState(false);
  const problems = healthProblems(health);
  const failing = problems.length > 0;
  // Fixed in a terminal while the cockpit stays open: the banner goes away on its own.
  useEffect(() => {
    if (!failing) return undefined;
    const t = setInterval(() => { refreshHealth(); }, RECHECK_MS);
    return () => clearInterval(t);
  }, [failing]);
  if (!failing) return null;
  const again = async () => {
    setBusy(true);
    const h = await refreshHealth();
    setBusy(false);
    if (!h) toast('The Clawdling server did not answer. Is it still running?', { tone: 'error', ms: 4200 });
    else if (healthProblems(h).length) toast('Still not fixed. If you changed your PATH, restart Clawdling.', { ms: 4200 });
    else toast('Fixed. You can start sessions now.', { tone: 'ok' });
  };
  return html`<div class="health-banner" role="alert" data-testid="health-banner">
    <span class="hb-icon" aria-hidden="true"><${Icon} name="alert" size=${16} /></span>
    <div class="hb-body">
      ${problems.map((p) => html`<p key=${p.id} class="hb-line" data-problem=${p.id}><${ProblemText} p=${p} health=${health} /></p>`)}
    </div>
    <button class="btn btn-quiet btn-sm hb-again" onClick=${again} disabled=${busy} data-testid="health-recheck">${busy ? 'Checking…' : 'Check again'}</button>
  </div>`;
}

// Claude Code ships about a release a day (1.8). When the installed one is newer than the last
// version Clawdling checked (server/claude-compat.json maxChecked), say so once per version, and let
// the owner dismiss it. It is not a problem, so it never blocks starting a session.
export function CompatNote() {
  const health = useStore((s) => s.health);
  const c = health && health.claude_compat;
  const ver = health && health.claude && health.claude.version ? String(health.claude.version).split(' ')[0] : null;
  const key = ver ? `compatNoteSeen:${ver}` : null;
  const [gone, setGone] = useState(() => !!(key && load(key, false)));
  useEffect(() => { setGone(!!(key && load(key, false))); }, [key]);
  if (!c || !c.newer || !ver || gone || healthProblems(health).length) return null;
  const dismiss = () => { save(key, true); setGone(true); };
  return html`<div class="compat-note" role="status" data-testid="compat-note">
    <p>Claude Code ${ver} is newer than the last version Clawdling checked (${c.max_checked}). It will probably work. Run Doctor to check: <code>${cliCmd('doctor --contract', health)}</code></p>
    <button class="btn btn-quiet btn-sm" onClick=${dismiss} data-testid="compat-dismiss" aria-label=${`Dismiss the note about Claude Code ${ver}`}>Dismiss</button>
  </div>`;
}
