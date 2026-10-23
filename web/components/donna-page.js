// Donna page (#/donna): connect Telegram and iMessage, see their status and the
// latest channel traffic, and jump into Donna's own session.
import { html } from '../lib/html.js';
import { useMemo, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon } from './icons.js';
import { StatusGlyph } from './status.js';
import { api } from '../lib/api.js';
import { refreshChannels } from '../lib/live.js';
import { startSession, focusSession, toast, errorToast } from '../lib/actions.js';
import { copyText, relTime, toMs } from '../lib/util.js';
import { sessionName, statusText } from '../lib/model.js';

function pairingCodeOf(r) {
  if (!r || typeof r !== 'object') return null;
  return r.pairing_code || r.code || r.pair_code || (r.telegram && (r.telegram.pairing_code || r.telegram.code)) || null;
}

function CopyLine({ text, label }) {
  return html`<div class="copy-line">
    <code>${text}</code>
    <button class="icon-btn icon-btn-sm" aria-label=${label || `Copy ${text}`} title="Copy" onClick=${async () => {
      const ok = await copyText(text);
      toast(ok ? 'Copied' : text, { tone: ok ? 'ok' : 'info', ms: 1800 });
    }}><${Icon} name="copy" size=${14} /></button>
  </div>`;
}

export function DonnaPage() {
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const sessionsMap = useStore((s) => s.sessions);
  const log = useStore((s) => s.channelLog);
  const now = useStore((s) => s.now);
  const agentsById = useStore((s) => s.agentsById);
  const donna = agents.find((a) => a.kind === 'chief') || agents.find((a) => a.id === 'donna');
  const donnaId = donna ? donna.id : 'donna';
  const donnaSessions = useMemo(() => Object.values(sessionsMap).filter((s) => s.agent === donnaId)
    .sort((a, b) => toMs(b.last_activity_at || b.created_at) - toMs(a.last_activity_at || a.created_at)), [sessionsMap, donnaId]);
  const liveDonna = donnaSessions.find((s) => s.status !== 'ended');

  return html`<div class="page donna-page" data-testid="donna-page">
    <header class="agent-hero">
      <span class="hero-icon"><${Icon} name="chat" size=${22} /></span>
      <div class="hero-text">
        <p class="hero-kind">Chief of staff</p>
        <h1 class="page-title">${donna ? donna.name : 'Donna'}</h1>
        <p class="hero-mission">Text ${donna ? donna.name : 'Donna'} from your phone. She works out which agent should handle it, starts or continues that agent's session, and replies in a line or two with who is on it.</p>
      </div>
      <div class="hero-actions">
        ${liveDonna ? html`<button class="btn btn-quiet" onClick=${() => focusSession(liveDonna.sid)} data-testid="donna-session">
            <${StatusGlyph} status=${liveDonna.status} label=${false} /> Open ${sessionName(liveDonna, agentsById)}</button>`
          : html`<button class="btn btn-quiet" onClick=${() => startSession(donnaId).catch(() => {})} data-testid="donna-session"><${Icon} name="plus" /> Start a session with ${donna ? donna.name : 'Donna'}</button>`}
      </div>
    </header>
    <div class="donna-grid">
      <${TelegramCard} t=${channels && channels.telegram} />
      <${IMessageCard} m=${channels && channels.imessage} />
      <section class="card donna-log" aria-labelledby="log-title">
        <h2 id="log-title" class="card-title">Recent messages</h2>
        ${log.length ? html`<ol class="chan-log">${[...log].reverse().slice(0, 30).map((e, i) => {
          const dir = e.direction || e.dir || null;
          const ch = e.channel || e.source || 'channel';
          const label = dir === 'out' ? (donna ? donna.name : 'Donna') : dir === 'in' ? 'You' : 'Clawdling';
          const text = dir ? (e.text || e.message || '') : e.event === 'paired' ? `Paired with chat ${e.chat || ''}`.trim()
            : e.event === 'error' ? `Error: ${e.text || 'unknown'}` : (e.text || e.event || 'event');
          return html`<li key=${i} class=${`chan-row dir-${dir || 'sys'}`}>
            <span class="chan-dir">${label}</span>
            <span class="chan-text">${text}</span>
            <span class="chan-meta">${ch} · ${relTime(e.at || e.ts || e._at, now)}</span>
          </li>`;
        })}</ol>` : html`<p class="panel-quiet">Messages to and from ${donna ? donna.name : 'Donna'} appear here as they happen.</p>`}
        ${channels && channels.donna && channels.donna.session ? html`<div class="donna-thread">
          <h3 class="card-h">Her channel conversation${channels.donna.busy ? html` <span class="pill pill-wait"><span class="pill-dot"></span>Working on a message</span>` : null}</h3>
          <p class="step-note">Texts are handled in one running Claude Code conversation. Read it any time from her folder:</p>
          <${CopyLine} text=${`claude --resume ${channels.donna.session}`} label="Copy the command that opens Donna's channel conversation" />
        </div>` : null}
        ${donnaSessions.length ? html`<h3 class="card-h">Donna's sessions</h3><ul class="srows">${donnaSessions.slice(0, 5).map((s) => html`<li key=${s.sid}>
          <div class="srow"><${StatusGlyph} status=${s.status} /><button class="srow-main" onClick=${() => focusSession(s.sid)}>
            <span class="srow-title">${sessionName(s, agentsById)}</span><span class="srow-meta">${s.status === 'ended' ? 'Ended' : statusText(s)} · ${relTime(s.last_activity_at || s.created_at, now)}</span>
          </button></div></li>`)}</ul>` : null}
      </section>
    </div>
  </div>`;
}

function StatusPill({ tone, children }) {
  return html`<span class=${`pill pill-${tone}`}><span class="pill-dot" aria-hidden="true"></span>${children}</span>`;
}

function TelegramCard({ t }) {
  const [token, setToken] = useState('');
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const configured = !!(t && t.configured);
  const paired = !!(t && t.paired);
  const enabled = !!(t && t.enabled);
  const pending = code || (t && t.pairing_code) || null;
  const bot = t && t.bot_username ? `@${String(t.bot_username).replace(/^@/, '')}` : 'your bot';
  const expires = t && t.pairing_expires_at ? Math.max(0, Math.round((Date.parse(t.pairing_expires_at) - Date.now()) / 60000)) : null;

  const connect = async (withToken) => {
    setBusy(true);
    setErr('');
    try {
      const body = withToken ? { token: token.trim(), enabled: true } : { enabled: true };
      const r = await api.telegram(body);
      const c = pairingCodeOf(r);
      if (c) setCode(String(c));
      setToken('');
      await refreshChannels();
    } catch (e) {
      setErr(e.message || 'Could not save the token');
    } finally {
      setBusy(false);
    }
  };
  const toggle = async () => {
    setBusy(true);
    try { await api.telegram({ enabled: !enabled }); await refreshChannels(); } catch (e) { errorToast('Telegram', e); } finally { setBusy(false); }
  };

  const status = paired ? html`<${StatusPill} tone="ok">Paired${t.chat_id_masked ? ` · chat ${t.chat_id_masked}` : ''}</${StatusPill}>`
    : configured ? html`<${StatusPill} tone="wait">Waiting for /pair</${StatusPill}>`
    : html`<${StatusPill} tone="off">Not set up</${StatusPill}>`;

  return html`<section class="card chan-card" aria-labelledby="tg-title" data-testid="telegram-card">
    <header class="card-head">
      <span class="card-icon"><${Icon} name="send" /></span>
      <h2 id="tg-title" class="card-title">Telegram</h2>
      ${status}
    </header>
    <ol class="steps">
      <li class=${configured ? 'is-done' : ''}>
        <span class="step-title">Create a bot</span>
        <span class="step-text">In Telegram, open <strong>@BotFather</strong>, send <code>/newbot</code>, pick a name, and copy the token it gives you.</span>
      </li>
      <li class=${configured ? 'is-done' : ''}>
        <span class="step-title">Give Clawdling the token</span>
        <span class="step-text">Paste it here, or run this in your terminal:</span>
        <${CopyLine} text="clawdling donna telegram --token <TOKEN>" label="Copy the clawdling donna telegram command" />
        <form class="inline-form" onSubmit=${(e) => { e.preventDefault(); if (token.trim()) connect(true); }}>
          <label class="sr-only" for="tg-token">Bot token</label>
          <input id="tg-token" class="mono" type="password" autocomplete="off" spellcheck="false" value=${token}
            onInput=${(e) => setToken(e.currentTarget.value)} placeholder=${configured ? 'Token saved. Paste a new one to replace it' : '123456789:AA…'} data-testid="tg-token" />
          <button class="btn btn-primary" type="submit" disabled=${!token.trim() || busy} data-testid="tg-connect">${busy ? 'Saving…' : configured ? 'Replace' : 'Connect'}</button>
        </form>
        ${err ? html`<p class="form-error" role="alert" data-testid="tg-error"><${Icon} name="alert" size=${14} /> ${err}</p>` : null}
        <span class="step-note">Stored in <code>.env</code> in your org folder with owner-only permissions. Never shown again.</span>
      </li>
      <li class=${paired ? 'is-done' : ''}>
        <span class="step-title">Pair your phone</span>
        ${pending && !paired ? html`<span class="step-text">Send this to ${bot} from your phone:</span>
            <div class="pair-code" data-testid="pairing-code"><span class="pair-cmd">/pair</span> <span class="pair-digits">${pending}</span>
              <button class="icon-btn icon-btn-sm" aria-label="Copy pairing message" onClick=${async () => { const ok = await copyText(`/pair ${pending}`); toast(ok ? 'Copied' : `/pair ${pending}`, { tone: 'ok', ms: 1600 }); }}><${Icon} name="copy" size=${14} /></button></div>
            <span class="step-note">${expires != null ? `Expires in ${expires} min. ` : ''}The first chat that pairs becomes the only one Donna answers. Everyone else is ignored.</span>`
          : paired ? html`<span class="step-text">Paired. Donna only answers this chat.</span>`
          : html`<span class="step-text">${configured ? 'Get a one-time code, then send it to your bot.' : 'After the token is saved you get a 6-digit code to send to your bot.'}</span>
            ${configured ? html`<button class="btn btn-quiet" onClick=${() => connect(false)} disabled=${busy} data-testid="tg-code">Get pairing code</button>` : null}`}
      </li>
    </ol>
    ${t && t.error ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${14} /> ${t.error}</p>` : null}
    ${configured ? html`<footer class="card-foot">
      <label class="switch"><input type="checkbox" checked=${enabled} onChange=${toggle} disabled=${busy} /><span class="switch-ui" aria-hidden="true"></span>
        <span>${enabled ? 'Donna answers on Telegram' : 'Telegram is paused'}</span></label>
    </footer>` : null}
  </section>`;
}

function IMessageCard({ m }) {
  const [handle, setHandle] = useState((m && m.handle) || '');
  const [busy, setBusy] = useState(false);
  const supported = !m || m.supported !== false;
  const enabled = !!(m && m.enabled);
  const save = async (en) => {
    setBusy(true);
    try {
      await api.imessage({ handle: handle.trim(), enabled: en });
      await refreshChannels();
      toast(en ? 'iMessage on. Text the Mac from that number.' : 'iMessage saved', { tone: 'ok' });
    } catch (e) {
      errorToast('iMessage', e);
    } finally {
      setBusy(false);
    }
  };
  const status = !supported ? html`<${StatusPill} tone="off">macOS only</${StatusPill}>`
    : enabled ? html`<${StatusPill} tone="ok">On${m && m.handle ? ` · ${m.handle}` : ''}</${StatusPill}>`
    : html`<${StatusPill} tone="off">Off</${StatusPill}>`;
  return html`<section class=${`card chan-card ${supported ? '' : 'is-muted'}`} aria-labelledby="im-title" data-testid="imessage-card">
    <header class="card-head">
      <span class="card-icon"><${Icon} name="phone" /></span>
      <h2 id="im-title" class="card-title">iMessage <span class="card-tag">experimental</span></h2>
      ${status}
    </header>
    ${supported ? html`<ol class="steps">
      <li><span class="step-title">Let Clawdling read Messages</span>
        <span class="step-text">System Settings → Privacy & Security → <strong>Full Disk Access</strong>: turn it on for the terminal app that runs <code>clawdling start</code>.</span></li>
      <li><span class="step-title">Let it send replies</span>
        <span class="step-text">The first time Donna replies, macOS asks to let your terminal control <strong>Messages</strong> (Automation). Allow it.</span></li>
      <li><span class="step-title">Use a second Apple ID on this Mac</span>
        <span class="step-text">Sign this Mac's Messages into a different Apple ID than your phone, then enter the number or email you will text from.</span>
        <form class="inline-form" onSubmit=${(e) => { e.preventDefault(); if (handle.trim()) save(true); }}>
          <label class="sr-only" for="im-handle">Your phone number or email</label>
          <input id="im-handle" value=${handle} onInput=${(e) => setHandle(e.currentTarget.value)} placeholder="+1 555 010 0199 or you@icloud.com" data-testid="im-handle" />
          <button class="btn btn-primary" type="submit" disabled=${!handle.trim() || busy}>${enabled ? 'Update' : 'Turn on'}</button>
        </form>
      </li>
    </ol>
    ${enabled ? html`<footer class="card-foot"><button class="btn btn-quiet btn-sm" onClick=${() => save(false)} disabled=${busy}>Turn off iMessage</button></footer>` : null}`
    : html`<p class="panel-quiet">iMessage needs a Mac (it reads and sends through the Messages app). On Windows or Linux, use Telegram.</p>`}
  </section>`;
}
