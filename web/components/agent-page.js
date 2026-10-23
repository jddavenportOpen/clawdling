// Agent page (#/agent/<id>): mission, sessions (live + recent, resume), and the
// files that make the agent who it is: CLAUDE.md (Context) and NOW.md + LOG (Memory).
import { html } from '../lib/html.js';
import { useEffect, useMemo, useState, useRef } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon, AgentIcon } from './icons.js';
import { StatusGlyph } from './status.js';
import { api } from '../lib/api.js';
import { startSession, focusSession, resumeSession, navigate, toast, errorToast, openOverlay } from '../lib/actions.js';
import { refreshOrg } from '../lib/live.js';
import { sessionName, statusText, KIND_LABEL, agentFolder, groupSessions, sessionTime } from '../lib/model.js';
import { relTime, longTime, isMac } from '../lib/util.js';
import { BLOCKED_TITLE, useStartBlocked } from './health-banner.js';

const MAX_BYTES = 200 * 1024;

export function AgentPage({ id, tab = 'sessions' }) {
  const agentsById = useStore((s) => s.agentsById);
  const sessionsMap = useStore((s) => s.sessions);
  const now = useStore((s) => s.now);
  const a = agentsById[id];
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const [reload, setReload] = useState(0);
  const blocked = useStartBlocked();

  useEffect(() => {
    let live = true;
    setErr('');
    api.agent(id).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setErr(e.status === 404 ? 'missing' : e.message); });
    return () => { live = false; };
  }, [id, reload]);

  const sessions = useMemo(() => Object.values(sessionsMap).filter((s) => s.agent === id), [sessionsMap, id]);
  const g = useMemo(() => groupSessions(sessions, now), [sessions, now]);
  const live = [...g.needs, ...g.live];

  const info = a || detail;
  if (!info && err === 'missing') {
    return html`<div class="page agent-page"><div class="page-pad"><div class="notice">
      <h1 class="page-title">No agent called “${id}”</h1>
      <p class="page-sub">It may have been archived. <a href="#/map">Open the org map</a> to see who is in your org.</p></div></div></div>`;
  }
  if (!info) return html`<div class="page agent-page"><div class="page-pad"><div class="panel-skel tall" aria-label="Loading"></div></div></div>`;

  const setTab = (t) => navigate(`#/agent/${encodeURIComponent(id)}${t === 'sessions' ? '' : `/${t}`}`);
  const parent = info.domain ? agentsById[info.domain] : null;

  return html`<div class="page agent-page" data-testid="agent-page" data-agent=${id}>
    <header class="agent-hero">
      <span class="hero-icon" style=${info.color ? { '--agent': info.color } : undefined}><${AgentIcon} agent=${info} size=${22} /></span>
      <div class="hero-text">
        <p class="hero-kind">${KIND_LABEL[info.kind] || info.kind}${parent ? html` · in <a href=${`#/agent/${encodeURIComponent(parent.id)}`}>${parent.name}</a>` : null}</p>
        <h1 class="page-title">${info.name}</h1>
        ${info.mission ? html`<p class="hero-mission">${info.mission}</p>` : html`<p class="hero-mission is-empty">No mission yet. Add one in Context.</p>`}
        <p class="hero-meta">
          <span class="mono" title=${info.dir || ''}>${info.dir ? info.dir.replace(/^\/(Users|home)\/[^/]+/, '~') : agentFolder(info)}</span>
          ${info.repo ? html`<span class="mono" title="Sessions open in this repo">${info.repo}</span>` : null}
          ${info.model ? html`<span>Model: <span class="mono">${info.model}</span></span>` : null}
        </p>
      </div>
      <div class="hero-actions">
        <button class="btn btn-primary" onClick=${() => startSession(id).catch(() => {})} data-testid="agent-new-session"
          disabled=${blocked} title=${blocked ? BLOCKED_TITLE : undefined}><${Icon} name="plus" /> New session</button>
        <button class="btn btn-quiet" onClick=${() => openOverlay({ type: 'new-session', agent: id })}
          disabled=${blocked} title=${blocked ? BLOCKED_TITLE : undefined}>With a first message…</button>
      </div>
    </header>

    <div class="tabs" role="tablist" aria-label=${`${info.name} sections`}>
      ${[['sessions', `Sessions`, live.length + g.recent.length], ['context', 'Context', null], ['memory', 'Memory', null]].map(([t, label, n]) => html`
        <button role="tab" aria-selected=${tab === t ? 'true' : 'false'} class=${`tab-btn ${tab === t ? 'is-on' : ''}`} onClick=${() => setTab(t)} data-tab-btn=${t}>
          ${label}${n ? html`<span class="sec-count">${n}</span>` : null}</button>`)}
    </div>

    <div class="tab-panel" role="tabpanel">
      ${tab === 'sessions' ? html`<${AgentSessions} live=${live} recent=${g.recent} now=${now} agentsById=${agentsById} name=${info.name} id=${id} />` : null}
      ${tab === 'context' ? html`<${FileEditor} key=${`ctx-${id}`} id=${id} field="claude_md" file="CLAUDE.md"
        value=${detail ? detail.claude_md || '' : null} err=${err}
        help=${html`Every session of ${info.name} starts with this file, on top of the org's CLAUDE.md and me.md.`}
        onSaved=${() => { setReload((x) => x + 1); refreshOrg(); }} />` : null}
      ${tab === 'memory' ? html`<div class="memory-grid">
        <${FileEditor} key=${`now-${id}`} id=${id} field="now_md" file="memory/NOW.md" value=${detail ? detail.now_md || '' : null} err=${err}
          help=${html`What ${info.name} knows right now. Loaded into every new session; the agent updates it before it finishes (<code>/handoff</code>).`}
          onSaved=${() => setReload((x) => x + 1)} />
        <section class="log-card" aria-labelledby="log-h">
          <h3 id="log-h" class="card-h">memory/LOG.md <span class="card-h-sub">last ${detail && detail.log_tail ? detail.log_tail.length : 0} lines</span></h3>
          ${detail && Array.isArray(detail.log_tail) && detail.log_tail.length
            ? html`<ol class="log-lines">${detail.log_tail.map((line) => html`<li>${line}</li>`)}</ol>`
            : html`<p class="panel-quiet">No log entries yet. Agents append one dated line each time they hand off.</p>`}
        </section>
      </div>` : null}
    </div>
  </div>`;
}

function AgentSessions({ live, recent, now, agentsById, name, id }) {
  if (!live.length && !recent.length) {
    return html`<div class="notice"><p>No sessions with ${name} in the last 14 days.</p>
      <button class="btn btn-primary" onClick=${() => startSession(id).catch(() => {})}><${Icon} name="plus" /> Start the first one</button></div>`;
  }
  const row = (s) => {
    const ended = s.status === 'ended';
    return html`<li key=${s.sid}><div class="srow" data-sid=${s.sid}>
      <${StatusGlyph} status=${s.status} />
      <button class="srow-main" onClick=${() => focusSession(s.sid)}>
        <span class="srow-title">${sessionName(s, agentsById)}</span>
        <span class="srow-meta">${ended ? 'Ended' : statusText(s)} · ${relTime(sessionTime(s), now)}${s.model ? ` · ${s.model}` : ''}</span>
      </button>
      <span class="srow-when" title=${longTime(s.created_at)}>${longTime(s.created_at)}</span>
      ${ended ? (s.resumable === false ? html`<span class="srow-note">Not resumable</span>`
        : html`<button class="btn btn-quiet btn-sm" onClick=${() => resumeSession(s.sid)} data-testid="agent-resume"><${Icon} name="play" size=${12} /> Resume</button>`)
        : html`<button class="btn btn-quiet btn-sm" onClick=${() => focusSession(s.sid)}>Focus</button>`}
    </div></li>`;
  };
  return html`<div class="agent-sessions">
    ${live.length ? html`<h3 class="card-h">Live</h3><ul class="srows">${live.map(row)}</ul>` : null}
    ${recent.length ? html`<h3 class="card-h">Recent</h3><ul class="srows">${recent.map(row)}</ul>` : null}
  </div>`;
}

function FileEditor({ id, field, file, value, err, help, onSaved }) {
  if (value == null && !err) return html`<div class="editor"><div class="panel-skel tall" aria-label="Loading"></div></div>`;
  if (value == null && err) return html`<div class="editor"><p class="form-error" role="alert">Could not load ${file}: ${err}</p></div>`;
  return html`<${EditorBody} id=${id} field=${field} file=${file} value=${value} help=${help} onSaved=${onSaved} />`;
}

// Mounted only once the file is loaded, so its first frame already shows the file (no empty
// frame, no mount-time reset). A later server value is adopted only while there are no unsaved
// edits, judged from refs that are current at that moment, never from a stale render closure.
function EditorBody({ id, field, file, value, help, onSaved }) {
  const [text, setText] = useState(() => value);
  const [base, setBase] = useState(() => value);
  const [state, setStateLocal] = useState('idle'); // idle | saving | saved | error
  const [msg, setMsg] = useState('');
  const live = useRef({ text: value, base: value });

  const edit = (t) => { live.current.text = t; setText(t); };
  const rebase = (b) => { live.current.base = b; setBase(b); };

  useEffect(() => {
    const cur = live.current;
    if (value === cur.base) return;
    if (cur.text === cur.base) edit(value);
    rebase(value);
  }, [value]);

  const dirty = text !== base;
  const size = new Blob([text]).size;
  const tooBig = size > MAX_BYTES;

  const save = async () => {
    const snapshot = live.current.text;
    if (snapshot === live.current.base || tooBig || state === 'saving') return;
    setStateLocal('saving');
    try {
      await api.saveContext(id, { [field]: snapshot });
      rebase(snapshot);
      setStateLocal('saved');
      setMsg(`Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
      toast(`${file} saved`, { tone: 'ok', ms: 2000 });
      if (onSaved) onSaved();
    } catch (e) {
      setStateLocal('error');
      setMsg(e.message);
      errorToast(`Could not save ${file}`, e);
    }
  };

  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
  };

  return html`<section class="editor" aria-label=${file}>
    <div class="editor-head">
      <h3 class="card-h mono">${file}</h3>
      <span class="editor-state" role="status">${state === 'saving' ? 'Saving…' : dirty ? 'Unsaved changes' : msg}</span>
      <span class="editor-spacer"></span>
      ${dirty ? html`<button class="btn btn-quiet btn-sm" onClick=${() => { edit(base); setStateLocal('idle'); }}>Revert</button>` : null}
      <button class="btn btn-primary btn-sm" onClick=${save} disabled=${!dirty || tooBig || state === 'saving'} data-testid=${`save-${field}`}>
        Save <span class="kbd-pair"><kbd>${isMac ? '⌘' : 'Ctrl'}</kbd><kbd>S</kbd></span></button>
    </div>
    <p class="editor-help">${help}</p>
    <textarea class="editor-area mono" value=${text} spellcheck="false" onInput=${(e) => edit(e.currentTarget.value)}
      onKeyDown=${onKey} aria-label=${`Edit ${file}`} data-testid=${`editor-${field}`}></textarea>
    ${tooBig ? html`<p class="form-error" role="alert">This file is ${Math.round(size / 1024)} KB; the limit is 200 KB.</p>` : null}
  </section>`;
}
