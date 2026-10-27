// Clawdling cockpit: the root. No build step: plain ESM + htm via the import map.
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { html } from './lib/html.js';
import { setState, getState, useStore } from './lib/store.js';
import { initialState, parseRoute, togglePalette, toggleRail, focusPaneIndex, closeOverlay, goHome, focusSession, navigate } from './lib/actions.js';
import { boot } from './lib/live.js';
import { initTheme } from './lib/theme.js';
import { shortcutOf, eventInTerminal, isTypingTarget } from './lib/keys.js';
import { terms } from './lib/term.js';
import { Rail } from './components/rail.js';
import { Workspace } from './components/workspace.js';
import { OrgMap } from './components/orgmap.js';
import { AgentPage } from './components/agent-page.js';
import { DonnaPage } from './components/donna-page.js';
import { SettingsPage } from './components/settings-page.js';
import { AuthScreen } from './components/auth-screen.js';
import { Palette } from './components/palette.js';
import { NewSessionDialog } from './components/new-session.js';
import { Wizard } from './components/wizard.js';
import { ImportScreen } from './components/import.js';
import { EndDialog, Menu, Toasts } from './components/dialogs.js';
import { Icon, Mark } from './components/icons.js';
import { HealthBanner } from './components/health-banner.js';

setState({ ...initialState(), route: parseRoute(), booting: true });
initTheme();

function Page({ route }) {
  if (route.name === 'map') return html`<${OrgMap} />`;
  if (route.name === 'agent') return html`<${AgentPage} key=${route.id} id=${route.id} tab=${route.tab} />`;
  if (route.name === 'donna') return html`<${DonnaPage} />`;
  if (route.name === 'settings') return html`<${SettingsPage} />`;
  return null;
}

function Overlays() {
  const overlay = useStore((s) => s.overlay);
  if (!overlay) return null;
  if (overlay.type === 'palette') return html`<${Palette} key="palette" />`;
  if (overlay.type === 'new-session') return html`<${NewSessionDialog} key="ns" agent=${overlay.agent} />`;
  if (overlay.type === 'wizard') return html`<${Wizard} key="wizard" name=${overlay.name} />`;
  if (overlay.type === 'import') return html`<${ImportScreen} key="import" />`;
  if (overlay.type === 'end') return html`<${EndDialog} key=${`end-${overlay.sid}`} sid=${overlay.sid} />`;
  return null;
}

function App() {
  const auth = useStore((s) => s.auth);
  const booting = useStore((s) => s.booting);
  const route = useStore((s) => s.route);
  const mobile = useStore((s) => s.mobile);
  const mobileView = useStore((s) => s.mobileView);
  const rail = useStore((s) => s.rail);

  // Coming back to the cockpit: the keyboard goes back to the focused terminal. Going to a page:
  // focus moves to its heading, so a screen reader announces where you are and Tab starts there.
  useEffect(() => {
    if (route.name !== 'cockpit') {
      const id = requestAnimationFrame(() => {
        const h = document.querySelector('.page-layer h1');
        if (!h || (document.activeElement && document.activeElement.closest('.page-layer'))) return;
        h.setAttribute('tabindex', '-1');
        h.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(id);
    }
    const sid = getState().focused;
    const v = sid && terms.get(sid);
    if (v) setTimeout(() => v.focus(), 0);
    return undefined;
  }, [route.name, route.id]);

  // #/s/<sid> (a receipt's link to a session, 1.7): open that session once the list has it.
  useEffect(() => {
    if (!route.sid || auth !== 'ok') return undefined;
    const sid = route.sid;
    const tryOpen = () => {
      if (!getState().sessions[sid]) return false;
      focusSession(sid, { route: false });
      navigate('#/');
      return true;
    };
    if (tryOpen()) return undefined;
    const t = setInterval(() => { if (tryOpen()) clearInterval(t); }, 300);
    const stop = setTimeout(() => clearInterval(t), 10000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [route.sid, auth]);

  if (auth !== 'ok') {
    if (booting) return html`<div class="splash" aria-label="Loading Clawdling"><span class="splash-mark"><${Mark} size=${28} /></span></div>`;
    return html`<${AuthScreen} onRetry=${() => boot()} />`;
  }
  const page = route.name !== 'cockpit';
  return html`<div class=${`app ${mobile ? 'is-mobile' : ''} rail-${rail}`} data-route=${route.name} data-mobile-view=${mobileView}>
    <${HealthBanner} />
    <${Rail} />
    <div class="stage">
      <${Workspace} hidden=${page} />
      ${page ? html`<div class="page-layer" key=${route.name}>
        ${mobile ? html`<div class="mobile-back"><button class="btn btn-quiet btn-sm" onClick=${goHome}><${Icon} name="arrow-left" size=${14} /> Cockpit</button></div>` : null}
        <${Page} route=${route} />
      </div>` : null}
    </div>
    <${Overlays} />
    <${Menu} />
    <${Toasts} />
  </div>`;
}

window.addEventListener('hashchange', () => setState({ route: parseRoute(), menu: null }));

// App shortcuts run in the capture phase so they beat xterm's own key handling.
window.addEventListener('keydown', (e) => {
  if (getState().auth !== 'ok') return;
  const inTerminal = eventInTerminal(e);
  const sc = shortcutOf(e, { inTerminal, inText: !inTerminal && isTypingTarget(e.target) });
  if (!sc) return;
  e.preventDefault();
  e.stopPropagation();
  if (sc.type === 'palette') togglePalette();
  else if (sc.type === 'rail') toggleRail();
  else if (sc.type === 'pane') {
    if (getState().overlay) closeOverlay();
    focusPaneIndex(sc.index);
  }
}, true);

try {
  const mq = window.matchMedia('(max-width: 720px)');
  const apply = () => setState({ mobile: mq.matches });
  mq.addEventListener('change', apply);
  apply();
} catch { /* no matchMedia: desktop layout */ }

const root = document.getElementById('app');
root.classList.remove('boot');
root.removeAttribute('aria-busy');
render(html`<${App} />`, root);

boot().finally(() => setState({ booting: false }));
