// One workspace pane: header (status, editable title, agent, model, live
// activity trace, actions), a needs-you bar, and the live terminal.
import { html } from '../lib/html.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon, AgentIcon } from './icons.js';
import { StatusGlyph } from './status.js';
import { dialogAnswers } from '../lib/dialogs.js';
import { TerminalView } from './terminal.js';
import { Composer } from './composer.js';
import { PaneChips } from './chips.js';
import { ChatView, useTranscript } from './chat-view.js';
import { terms, onTraceTick } from '../lib/term.js';
import {
  touchFocus, toggleMaximize, askEndSession, copyAttach, renameSession, mergeSession, resumeSession,
  closePane, setRenaming, answerDialog, toast, errorToast, signInFor, restartSession,
} from '../lib/actions.js';
import { api } from '../lib/api.js';
import { sessionName, agentLabel, statusText, STATUS_LABEL, sessionTime, attachCommand } from '../lib/model.js';
import { relTime, prefersReducedMotion, paneKey, tildify, coarsePointer } from '../lib/util.js';
import { getState, setState } from '../lib/store.js';
import { load, save } from '../lib/prefs.js';

export function Pane({ sid, index, hidden, order, span, layout, solo }) {
  const s = useStore((st) => st.sessions[sid]);
  const agentsById = useStore((st) => st.agentsById);
  const focused = useStore((st) => st.focused === sid);
  const focusTick = useStore((st) => st.focusTick);
  const held = useStore((st) => !!(st.overlay || st.menu));
  const renaming = useStore((st) => st.renaming === sid);
  const mobile = useStore((st) => st.mobile);
  const now = useStore((st) => st.now);
  const [conn, setConn] = useState('connecting');
  const [flash, setFlash] = useState(false);
  const el = useRef(null);
  // A pane that mounts already focused (just opened, or restored on reload) takes the keyboard too.
  const lastTick = useRef(focused ? -1 : focusTick);
  // A jump whose keyboard a dialog or menu held back (see below); paid once that closes.
  const owed = useRef(false);
  // Chat | Raw, remembered per pane. Chat shows once the transcript has messages; until then the
  // raw terminal shows with a note. The terminal stays mounted under the chat either way.
  const [view, setViewState] = useState(() => (load(`view.${sid}`, 'chat') === 'raw' ? 'raw' : 'chat'));
  const ended0 = !!s && s.status === 'ended';
  const { messages, loaded } = useTranscript(sid, ended0, view === 'chat' && !!s);
  const chat = view === 'chat' && messages.length > 0;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const setView = (v) => {
    save(`view.${sid}`, v);
    setViewState(v);
    // Back to Raw: the terminal kept its size under the chat, but refit in case the pane changed.
    requestAnimationFrame(() => { const t = terms.get(sid); if (t && t.layout) t.layout(); });
  };

  // A rail click / palette jump / ⌘N targets this pane: reveal it, flash it,
  // and put the keyboard in its terminal. Nothing else in the workspace moves.
  const takeKeyboard = () => {
    const node = el.current;
    const st = getState();
    // On a phone, focusing the terminal raises the keyboard over it: typing goes through the composer.
    if (!node || st.mobile || coarsePointer()) return;
    const v = terms.get(sid);
    const box = chatRef.current ? node.querySelector('.chat-view textarea') : null;
    if (box) { if (!box.disabled) box.focus(); } else if (v) v.focus();
  };
  useEffect(() => {
    if (!focused) owed.current = false;
    if (!focused || focusTick === lastTick.current) { lastTick.current = focusTick; return; }
    lastTick.current = focusTick;
    const node = el.current;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      // Never pull the keyboard out of a dialog or menu opened since the jump.
      const st = getState();
      const busy = st.overlay || st.menu || st.renaming || (document.activeElement && document.activeElement.closest('.modal, .menu, .pane-title-input'));
      owed.current = !!(st.overlay || st.menu);
      if (!busy) takeKeyboard();
      setFlash(true);
      setTimeout(() => setFlash(false), 650);
    });
  }, [focused, focusTick]);

  // The jump landed while a dialog or menu was up (an agent card's start finishing behind New
  // session). When that closes and the keyboard is left on nothing, this pane takes it: the
  // dialog itself does not hand focus back once a jump has happened, so without this the first
  // thing typed after Escape went nowhere.
  useEffect(() => {
    if (held || !owed.current) return undefined;
    owed.current = false;
    if (!focused) return undefined;
    const id = requestAnimationFrame(() => {
      const a = document.activeElement;
      if (getState().focused === sid && (!a || a === document.body || a === document.documentElement)) takeKeyboard();
    });
    return () => cancelAnimationFrame(id);
  }, [held]);

  if (!s) {
    return html`<section class=${`pane is-missing ${hidden ? 'is-hidden' : ''}`} data-pane=${sid} style=${{ order: String(order) }}>
      <div class="pane-missing"><p>This session is no longer on the server.</p>
      <button class="btn btn-quiet" onClick=${() => closePane(sid)}>Close pane</button></div>
    </section>`;
  }

  const name = sessionName(s, agentsById);
  const agent = agentsById[s.agent];
  const ended = s.status === 'ended';
  const maximized = layout === 'focus';

  const onStatus = (status) => { if (status && status !== s.status) mergeSession({ sid, status }); };
  const onEnded = () => {
    const cur = getState().sessions[sid];
    if (cur && cur.status !== 'ended') mergeSession({ sid, status: 'ended', ended_at: new Date().toISOString() });
  };

  const style = { order: String(order) };
  if (span > 1) style.gridRow = `span ${span}`;

  return html`<section ref=${el}
      class=${`pane st-${s.status} ${chat ? 'is-chat' : ''} ${focused ? 'is-focused' : ''} ${hidden ? 'is-hidden' : ''} ${flash ? 'is-flash' : ''}`}
      data-pane=${sid} data-status=${s.status} data-view=${chat ? 'chat' : 'raw'} data-focused=${focused ? 'true' : 'false'} style=${style}
      role="region" aria-label=${`${name} (${agentLabel(s, agentsById)})`}
      onMouseDown=${() => touchFocus(sid)} onFocusIn=${() => touchFocus(sid)}>
    <header class="pane-head">
      <span class="pane-glyph" title=${STATUS_LABEL[s.status] || s.status}><${StatusGlyph} status=${s.status} /></span>
      <${PaneTitle} sid=${sid} name=${name} title=${s.title} editing=${renaming} />
      <span class="pane-chip" title=${agent && agent.mission ? agent.mission : agentLabel(s, agentsById)}>
        <span class="chip-icon" aria-hidden="true"><${AgentIcon} agent=${agent || { name: agentLabel(s, agentsById) }} size=${12} /></span>${agentLabel(s, agentsById)}
      </span>
      <${PaneChips} s=${s} />
      <${Trace} sid=${sid} status=${s.status} />
      <span class="pane-spacer"></span>
      <div class="seg pane-view" role="group" aria-label="View">
        <button type="button" class=${`seg-btn ${view === 'chat' ? 'is-on' : ''}`} aria-pressed=${view === 'chat' ? 'true' : 'false'}
          onClick=${() => setView('chat')} title="Chat view" data-testid="pane-view-chat">Chat</button>
        <button type="button" class=${`seg-btn ${view === 'raw' ? 'is-on' : ''}`} aria-pressed=${view === 'raw' ? 'true' : 'false'}
          onClick=${() => setView('raw')} title="Raw terminal" data-testid="pane-view-raw">Raw</button>
      </div>
      ${conn === 'reconnecting' && !ended ? html`<span class="pane-conn" role="status">Reconnecting…</span>` : null}
      ${!solo && index < 9 ? html`<span class="pane-index" aria-hidden="true" title=${`Focus with ${paneKey(index + 1)}`}>${paneKey(index + 1)}</span>` : null}
      <div class="pane-actions">
        ${attachCommand(s) ? html`<button class="icon-btn" onClick=${() => copyAttach(s)} aria-label="Copy attach command" title=${`Copy: ${attachCommand(s)}`} data-testid="pane-attach"><${Icon} name="terminal" /></button>` : null}
        <button class="icon-btn" onClick=${() => closePane(sid)} aria-label="Hide pane (keeps running)" title="Hide pane. The session keeps running." data-testid="pane-hide"><${Icon} name="pane-hide" /></button>
        ${mobile || solo ? null : html`<button class="icon-btn" onClick=${() => toggleMaximize(sid)} aria-label=${maximized ? 'Restore layout' : 'Maximize pane'} aria-pressed=${maximized ? 'true' : 'false'}
          title=${maximized ? 'Restore layout' : 'Maximize'} data-testid="pane-max"><${Icon} name=${maximized ? 'restore' : 'maximize'} /></button>`}
        ${ended ? html`<button class="icon-btn" onClick=${() => closePane(sid)} aria-label="Close pane" title="Close pane" data-testid="pane-end"><${Icon} name="x" /></button>`
          : html`<button class="icon-btn icon-danger" onClick=${() => askEndSession(sid)} aria-label="End session" title="End session…" data-testid="pane-end"><${Icon} name="x" /></button>`}
      </div>
    </header>
    ${needsSignIn(s) ? html`<${LoginBanner} s=${s} accent=${focused || solo} />`
      : s.status === 'needs_you' && STARTUP_DIALOGS[s.waiting_on] ? html`<${DialogBanner} s=${s} mobile=${mobile} accent=${focused || solo} />`
      : s.status === 'needs_you' && s.waiting_on === 'permission_prompt' && Array.isArray(s.choices) && s.choices.length ? html`<${QuestionBanner} s=${s} mobile=${mobile} accent=${focused || solo} />`
      : s.status === 'needs_you' ? html`<button class="pane-alert" onClick=${() => {
        const focusTerm = () => { const v = terms.get(sid); if (v) v.focus(); };
        if (chat) { setView('raw'); requestAnimationFrame(() => requestAnimationFrame(focusTerm)); } else focusTerm();
      }}>
      <${StatusGlyph} status="needs_you" label=${false} /><span class="alert-label">Needs you</span><span class="alert-text">${s.notification || 'Claude is waiting for your answer in the terminal.'}</span>
    </button>` : null}
    ${view === 'chat' && !chat && loaded && !ended ? html`<p class="chat-pending" data-testid="chat-pending-note">Chat appears once Claude Code starts.</p>` : null}
    <div class="pane-body">
      <${TerminalView} sid=${sid} ended=${ended} onConn=${setConn} onStatus=${onStatus} onEnded=${onEnded} />
      ${chat ? html`<${ChatView} s=${s} agent=${agentLabel(s, agentsById)} messages=${messages} />` : null}
      ${ended ? html`<div class="pane-ended" role="group" aria-label="Session ended">
        <div class="ended-card">
          <p class="ended-title"><${StatusGlyph} status="ended" label=${false} /> Session ended ${relTime(sessionTime(s), now) === 'now' ? 'just now' : `${relTime(sessionTime(s), now)} ago`}</p>
          ${s.resumable === false ? html`<p class="ended-sub">This session can't be resumed.</p>`
            : html`<p class="ended-sub">Resume reopens the same conversation with <code>claude --resume</code>.</p>`}
          <div class="ended-actions">
            ${s.resumable === false ? null : html`<button class="btn btn-primary" onClick=${() => resumeSession(sid)} data-testid="pane-resume"><${Icon} name="play" /> Resume</button>`}
            <button class="btn btn-quiet" onClick=${() => closePane(sid)}>Close pane</button>
          </div>
        </div>
      </div>` : null}
    </div>
    ${mobile && !ended && !chat ? html`<${Composer} s=${s} agent=${agentLabel(s, agentsById)} />` : null}
  </section>`;
}

function PaneTitle({ sid, name, title, editing }) {
  if (editing) return html`<${TitleEditor} sid=${sid} name=${name} title=${title} />`;
  return html`<h3 class="pane-title" onDblClick=${() => setRenaming(sid)} title=${`${name} (double-click to rename)`} data-testid="pane-title">
    <span class="pane-title-text">${name}</span>
  </h3>`;
}

// Mounted only while renaming: its value is set synchronously at mount and focus lands in a
// layout effect (before paint), so the very first keystroke is never overwritten by a late reset.
function TitleEditor({ sid, name, title }) {
  const [value, setValue] = useState(() => title || '');
  const input = useRef(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    const el = input.current;
    if (el) { el.focus(); el.select(); }
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    setRenaming(null);
    renameSession(sid, input.current ? input.current.value : value);
  };
  const cancel = () => {
    done.current = true;
    setRenaming(null);
    const v = terms.get(sid);
    if (v) v.focus();
  };

  return html`<input ref=${input} class="pane-title-input" value=${value} maxLength="120" aria-label="Session title"
    placeholder=${name} onInput=${(e) => setValue(e.currentTarget.value)} onBlur=${commit} onMouseDown=${(e) => e.stopPropagation()}
    onKeyDown=${(e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); const v = terms.get(sid); if (v) v.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    }} data-testid="pane-title-input" />`;
}

// Claude Code's own startup screens (detected by the server from the screen, before any hook
// runs). Dialogs with choices are answered with POST /api/sessions/:sid/answer {option}, where
// option is the choice's place on screen (the server's `choices`, in screen order: 2.1.283 lists
// "No, exit" first); the terminal keeps working too. `note` = no buttons, just what to do.
export const STARTUP_DIALOGS = {
  trust: {
    text: (s) => `Claude Code asks whether you trust ${tildify(s.cwd) || 'this folder'}. "No, exit" ends this session.`,
    yes: 'Yes, trust it',
    no: 'No, exit',
  },
  imports: { text: () => 'Claude Code is asking whether to load CLAUDE.md imports from outside this folder.', yes: 'Allow imports', no: "Don't allow" },
  login: {
    // A "Sign in" session is exactly where signing in happens. Any other session gets LoginBanner.
    text: () => 'Sign in to Claude in the terminal below.',
    note: () => html`Follow Claude Code's own steps (or type <code>/login</code>). Clawdling never sees the login.`,
  },
};

// Not signed in, in a session that is not itself a "Sign in" session.
export const needsSignIn = (s) => !!s && s.status === 'needs_you' && s.waiting_on === 'login' && s.purpose !== 'signin';

// One click to sign in, for people who have no terminal in mind (the desktop app's Code tab):
// Sign in opens a "Sign in" session for this session's login, where Claude Code runs its own
// browser sign-in; Start again then starts this session over with the new login.
function LoginBanner({ s, accent }) {
  const [busy, setBusy] = useState('');
  const run = async (what, fn) => {
    setBusy(what);
    await fn();
    setBusy('');
  };
  const done = !!s.signed_in;
  return html`<div class="pane-dialog pane-login" role="group" aria-label="Claude Code is not signed in" data-testid="pane-dialog" data-dialog="login">
    <${StatusGlyph} status="needs_you" label=${false} />
    <span class="dialog-text" data-testid="pane-dialog-text">${done
      ? 'Claude Code is signed in now. Start this session again to use it.'
      : "Claude Code isn't signed in yet. Click Sign in, then follow the browser steps."}</span>
    ${done ? null : html`<span class="dialog-note" data-testid="pane-dialog-note">Then click Start again. In a terminal, <code>claude auth login</code> does the same.</span>`}
    <span class="dialog-actions">
      <button class=${`btn ${!done && accent ? 'btn-primary' : 'btn-quiet'} btn-sm`} onClick=${() => run('signin', () => signInFor(s))}
        disabled=${!!busy} data-testid="login-signin">${busy === 'signin' ? 'Starting…' : 'Sign in'}</button>
      <button class=${`btn ${done && accent ? 'btn-primary' : 'btn-quiet'} btn-sm`} onClick=${() => run('restart', () => restartSession(s.sid))}
        disabled=${!!busy} data-testid="login-restart">${busy === 'restart' ? 'Starting…' : 'Start again'}</button>
    </span>
  </div>`;
}

// Does this session's pane show a question with answer buttons? Only the focused pane fills its
// default answer (one accent per screen); the others show the same buttons, quiet.
export function paneAsksWithButtons(s) {
  if (!s || s.status !== 'needs_you') return false;
  if (needsSignIn(s)) return true;
  if (s.waiting_on === 'permission_prompt') return Array.isArray(s.choices) && s.choices.length > 0;
  const d = STARTUP_DIALOGS[s.waiting_on];
  return !!d && !d.note && !!dialogAnswers(s.choices);
}

function DialogBanner({ s, mobile, accent }) {
  const d = STARTUP_DIALOGS[s.waiting_on];
  const opts = d.note ? null : dialogAnswers(s.choices);
  const [busy, setBusy] = useState(0);
  const answer = async (option, yes) => {
    setBusy(option);
    const answered = await answerDialog(s.sid, option, { focus: yes && !mobile });
    setBusy(0);
    if (answered && yes && s.waiting_on === 'trust') {
      toast(`Trusted ${tildify(s.cwd) || 'this folder'}. Sessions in it won't ask again.`, { tone: 'ok', ms: 4200 });
    }
  };
  return html`<div class="pane-dialog" role="group" aria-label="Claude Code is asking" data-testid="pane-dialog" data-dialog=${s.waiting_on}>
    <${StatusGlyph} status="needs_you" label=${false} />
    <span class="dialog-text" data-testid="pane-dialog-text">${d.text(s)}</span>
    ${d.note ? html`<span class="dialog-note" data-testid="pane-dialog-note">${typeof d.note === 'function' ? d.note(s) : d.note}</span>`
      : opts ? html`<span class="dialog-actions">
      <button class="btn btn-quiet btn-sm" onClick=${() => answer(opts.no, false)} disabled=${!!busy} data-testid="dialog-no">${busy === opts.no ? 'Answering…' : d.no}</button>
      <button class=${`btn ${accent ? 'btn-primary' : 'btn-quiet'} btn-sm`} onClick=${() => answer(opts.yes, true)} disabled=${!!busy} data-testid="dialog-yes">${busy === opts.yes ? 'Answering…' : d.yes}</button>
    </span>` : html`<span class="dialog-note" data-testid="pane-dialog-terminal">Answer it in the terminal below.</span>`}
  </div>`;
}

// A permission prompt ("Do you want to proceed?"): one button per choice, in screen order, so it
// can be answered with one tap on a phone. In the focused pane the first choice (Claude Code's
// own default) is filled.
const QUESTION_MAX = 3;
const choiceLabel = (c) => String((c && c.label) || '').replace(/^\s*\d+[.)]\s*/, '');

function QuestionBanner({ s, mobile, accent }) {
  const [busy, setBusy] = useState(0);
  const shown = s.choices.slice(0, QUESTION_MAX);
  const answer = async (option) => {
    setBusy(option);
    await answerDialog(s.sid, option, { focus: !mobile });
    setBusy(0);
  };
  return html`<div class="pane-dialog pane-question" role="group" aria-label="Claude Code is asking" data-testid="pane-question" data-dialog=${s.waiting_on}>
    <${StatusGlyph} status="needs_you" label=${false} />
    <span class="dialog-text" data-testid="pane-question-text">${s.notification || 'Claude Code is asking for your permission.'}</span>
    <span class="dialog-actions">
      ${shown.map((c, i) => html`<button key=${c.option} class=${`btn ${i === 0 && accent ? 'btn-primary' : 'btn-quiet'} btn-sm dialog-choice`} title=${choiceLabel(c)}
        onClick=${() => answer(c.option)} disabled=${!!busy} data-option=${c.option} data-testid="question-choice">
        <span class="choice-label">${busy === c.option ? 'Answering…' : choiceLabel(c)}</span></button>`)}
      ${s.choices.length > QUESTION_MAX ? html`<span class="dialog-note">More choices in the terminal.</span>` : null}
    </span>
  </div>`;
}

// Signature detail: a hairline trace of real terminal output over the last 40 s,
// so "working" and "actually producing output" are no longer the same claim.
function Trace({ sid, status }) {
  const line = useRef(null);
  const wrap = useRef(null);
  useEffect(() => onTraceTick(() => {
    const v = terms.get(sid);
    if (!v || !line.current) return;
    line.current.setAttribute('points', v.tracePoints(48, 14));
    if (wrap.current) {
      wrap.current.classList.toggle('is-active', v.recentlyActive());
      wrap.current.classList.toggle('is-idle', !v.anyActivity());
    }
  }), [sid]);
  return html`<span class="pane-trace is-idle" ref=${wrap} title="Terminal output, last 40 seconds" aria-hidden="true">
    <svg width="48" height="14" viewBox="0 0 48 14" focusable="false">
      <line x1="0" y1="13" x2="48" y2="13" class="trace-base" />
      <polyline ref=${line} points="0,13 48,13" class=${`trace-line st-${status}`} />
    </svg>
  </span>`;
}
