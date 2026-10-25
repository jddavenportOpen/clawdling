// Settings, "Use from anywhere" (1.3). Off by default. Turning it on is a setup chat with a Claude
// Code agent running the org's /remote-access skill; the first message it gets is the visible
// prompt below. Once an address is registered (`clawdling remote add`), the card shows each one's
// last check, pairs a device with a one-time link, and turns it all off at once.
// GET /api/remote -> {enabled, invalid, port, pairing_minutes, hosts: [{url, kind, status,
// status_text, detail, checked_at, answering}], devices: [{id, label, host, created_at,
// last_seen_at}], here: {remote, url, device}}.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { startSession, toast, errorToast } from '../lib/actions.js';
import { copyText, relTime } from '../lib/util.js';
import { Icon } from './icons.js';
import { Modal } from './dialogs.js';

export const REMOTE_PATHS = {
  tailscale: {
    title: 'Just my devices',
    tag: 'Recommended',
    text: 'Uses Tailscale, free for personal use: a private network between your own devices. Nothing goes on the public internet. Needs the free Tailscale app on this computer and on your phone, signed in to the same account.',
    service: 'Tailscale',
  },
  cloudflare: {
    title: 'A web address with a sign-in',
    tag: 'Beta',
    text: 'Uses a Cloudflare Tunnel with a Cloudflare Access email sign-in. Needs a free Cloudflare account and a domain on Cloudflare.',
    service: 'Cloudflare',
  },
};

/** What the setup agent is asked, shown to the user before it starts. */
export const remotePrompt = (path) => `/remote-access ${path}`;

const KIND_LABEL = { tailscale: 'Tailscale', cloudflare: 'Cloudflare (beta)' };
/** "just now", "2 min ago", "3 h ago", "yesterday", "Oct 3": plain words for a past time. */
export function ago(ts) {
  const r = relTime(ts);
  if (!r) return '';
  if (r === 'now') return 'just now';
  if (/^\d+m$/.test(r)) return `${r.slice(0, -1)} min ago`;
  if (/^\d+h$/.test(r)) return `${r.slice(0, -1)} h ago`;
  if (/^\d+d$/.test(r)) return `${r.slice(0, -1)} days ago`;
  return r;
}
const GOOD = new Set(['private', 'access']);

export function RemoteCard() {
  const [view, setView] = useState(null);
  const [err, setErr] = useState('');
  const [choice, setChoice] = useState('tailscale');
  const [sheet, setSheet] = useState(null); // {type: 'setup', path} | {type: 'off'}
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState('');

  const reload = () => api.remote().then((v) => { setView(v); setErr(''); return v; })
    .catch((e) => { setErr(e.status === 404 ? 'unsupported' : e.message); return null; });
  useEffect(() => { reload(); }, []);
  // Waiting for a phone to pair: look often. Otherwise: now and then, for the last checks.
  useEffect(() => {
    const id = setInterval(reload, pairing ? 3000 : 15000);
    return () => clearInterval(id);
  }, [!!pairing]);
  // A pairing link that has expired is not shown any more.
  useEffect(() => {
    if (!pairing) return undefined;
    const left = Date.parse(pairing.expires_at) - Date.now();
    const id = setTimeout(() => setPairing(null), Math.max(0, left));
    return () => clearTimeout(id);
  }, [pairing]);

  const startAgent = async (path) => {
    setBusy('setup');
    try {
      await startSession('scratch', { prompt: remotePrompt(path), title: path === 'off' ? 'Remove remote access' : 'Use from anywhere' });
      setSheet(null);
      toast(path === 'off' ? 'A setup chat is removing the tunnel. It asks before each step.' : 'Your setup chat is open. The agent asks before it installs or changes anything.', { tone: 'ok', ms: 5200 });
    } catch {
      // startSession already said why
    } finally {
      setBusy('');
    }
  };

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      const v = await fn();
      if (v && v.hosts) setView(v);
      else await reload();
      if (ok) toast(ok, { tone: 'ok' });
      return true;
    } catch (e) {
      errorToast('That did not work', e);
      return false;
    } finally {
      setBusy('');
    }
  };

  const turnOff = async ({ removeTunnel }) => {
    const done = await run('off', () => api.remoteEnabled(false), 'Use from anywhere is off. Every paired device is signed out.');
    if (!done) return;
    setPairing(null);
    setSheet(null);
    if (removeTunnel && !(view && view.here && view.here.remote)) await startAgent('off');
  };

  const addDevice = async () => {
    setBusy('pair');
    try {
      const p = await api.remotePairing();
      setPairing({ ...p, devices: new Set(((view && view.devices) || []).map((d) => d.id)) });
    } catch (e) {
      errorToast('Could not make a pairing link', e);
    } finally {
      setBusy('');
    }
  };

  const signOut = (d) => run(`dev-${d.id}`, () => api.remoteSignOut(d.id), `${d.label} is signed out.`);

  if (err === 'unsupported') return null;
  const hosts = (view && view.hosts) || [];
  const devices = (view && view.devices) || [];
  const here = (view && view.here) || {};
  const remoteHere = !!here.remote;
  const on = !!(view && view.enabled);
  const fresh = pairing ? devices.filter((d) => !pairing.devices.has(d.id)) : [];

  return html`<section class="card remote-card" aria-labelledby="set-remote" data-testid="remote-card">
    <h2 id="set-remote" class="card-title">Use from anywhere
      ${view ? html`<span class=${`card-tag ${on ? 'tag-on' : ''}`} data-testid="remote-state">${on ? 'On' : 'Off'}</span>` : null}</h2>
    <p class="phone-lead remote-lead">Open your cockpit from your phone or another computer.</p>
    ${err ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${14} /> Could not load this: ${err}</p>`
      : !view ? html`<div class="panel-skel" aria-label="Loading"></div>`
      : html`
      ${view.invalid ? html`<p class="phone-warn" role="note" data-testid="remote-invalid"><${Icon} name="alert" size=${14} /><span>${view.invalid}.</span></p>` : null}
      ${hosts.length ? html`
        ${remoteHere ? html`<p class="set-note remote-here" data-testid="remote-here">You are using the cockpit through <span class="mono">${here.url}</span>.</p>` : null}
        <ul class="remote-hosts" aria-label="Remote addresses">
          ${hosts.map((h) => html`<li class="remote-host" data-testid="remote-host" data-status=${h.status} key=${h.url}>
            <span class="remote-host-main">
              <span class="mono remote-url">${h.url}</span>
              <span class="set-sub">${KIND_LABEL[h.kind] || h.kind}${h.checked_at ? ` · checked ${ago(h.checked_at)}` : ''}</span>
            </span>
            <span class=${`remote-status ${!on ? 'is-off' : GOOD.has(h.status) ? 'is-good' : h.answering ? 'is-warn' : 'is-bad'}`} data-testid="remote-status">
              ${!on || GOOD.has(h.status) ? null : html`<${Icon} name="alert" size=${13} />`}
              ${on ? h.status_text : 'Turned off'}</span>
            ${on && !GOOD.has(h.status) && h.detail ? html`<span class="set-sub remote-detail">${h.detail}</span>` : null}
          </li>`)}
        </ul>
        <div class="remote-actions">
          ${on ? html`
            <button class="btn btn-quiet btn-sm" onClick=${() => run('check', () => api.remoteCheck())} disabled=${!!busy} data-testid="remote-check">
              <${Icon} name="refresh" size=${13} /> ${busy === 'check' ? 'Checking…' : 'Check again'}</button>
            <button class="btn btn-quiet btn-sm" onClick=${() => setSheet({ type: 'off' })} disabled=${!!busy} data-testid="remote-off">Turn off</button>`
          : remoteHere ? null : html`
            <button class="btn btn-primary btn-sm" onClick=${() => run('on', () => api.remoteEnabled(true), 'Use from anywhere is on. Pair your devices again.')} disabled=${!!busy} data-testid="remote-on">${busy === 'on' ? 'Turning on…' : 'Turn on'}</button>
            <button class="btn btn-quiet btn-sm" onClick=${() => startAgent('off')} disabled=${!!busy} data-testid="remote-remove">Remove the tunnel too</button>`}
        </div>
        ${on ? html`<div class="remote-devices" data-testid="remote-devices">
          <h3 class="card-h">Your devices</h3>
          ${devices.length ? html`<ul class="acct-list">
            ${devices.map((d) => html`<li class="set-row" data-testid="remote-device" key=${d.id}>
              <span class="set-label"><span class="remote-dev-name">${d.label}${d.id === here.device ? html`<span class="card-tag">This device</span>` : null}</span>
                <span class="set-sub">Paired ${ago(d.created_at)}${d.last_seen_at ? ` · last used ${ago(d.last_seen_at)}` : ''}</span></span>
              <button class="btn btn-quiet btn-sm" onClick=${() => signOut(d)} disabled=${!!busy} data-testid="remote-signout">Sign out</button>
            </li>`)}
          </ul>` : html`<p class="set-note remote-none">No device is signed in.</p>`}
          ${remoteHere ? html`<p class="set-note">To add a device, open Settings on the computer Clawdling runs on.</p>`
            : pairing ? html`<${PairingBlock} pairing=${pairing} fresh=${fresh} onDone=${() => setPairing(null)} />`
            : !hosts.some((h) => h.answering) ? html`<p class="phone-warn" role="note" data-testid="remote-none-answering"><${Icon} name="alert" size=${14} />
                <span>No address is answering right now, so a new device could not reach the cockpit. Fix what the address above says, then press Check again.</span></p>`
            : html`<button class="btn btn-primary btn-sm remote-add" onClick=${addDevice} disabled=${!!busy} data-testid="remote-add-device">
                <${Icon} name="phone" size=${13} /> ${busy === 'pair' ? 'Making a link…' : 'Add a device'}</button>`}
        </div>` : null}`
      : html`
        <div class="remote-paths" role="radiogroup" aria-label="How to reach your cockpit">
          ${Object.entries(REMOTE_PATHS).map(([key, p]) => html`<button role="radio" aria-checked=${choice === key ? 'true' : 'false'}
              class=${`remote-path ${choice === key ? 'is-on' : ''}`} onClick=${() => setChoice(key)} data-testid=${`remote-path-${key}`}>
            <span class="remote-path-head"><span class="remote-path-title">${p.title}</span><span class="card-tag">${p.tag}</span></span>
            <span class="remote-path-text">${p.text}</span>
          </button>`)}
        </div>
        <p class="set-note remote-why">Why not a copy in the cloud? Your cockpit has to run on the computer where your Claude Code and your files live, and a cloud copy could not reach them. Both ways keep it here and open a private door to it.</p>
        ${remoteHere ? null : html`<button class="btn btn-primary remote-start" onClick=${() => setSheet({ type: 'setup', path: choice })} disabled=${!!busy} data-testid="remote-setup">
          <${Icon} name="spark" size=${14} /> Set it up with an agent</button>`}`}`}
    ${sheet && sheet.type === 'setup' ? html`<${SetupSheet} path=${sheet.path} busy=${busy === 'setup'} onStart=${() => startAgent(sheet.path)} onClose=${() => setSheet(null)} />` : null}
    ${sheet && sheet.type === 'off' ? html`<${OffSheet} hosts=${hosts} remoteHere=${remoteHere} busy=${busy === 'off' || busy === 'setup'} onOff=${turnOff} onClose=${() => setSheet(null)} />` : null}
  </section>`;
}

function SetupSheet({ path, busy, onStart, onClose }) {
  const p = REMOTE_PATHS[path];
  const prompt = remotePrompt(path);
  return html`<${Modal} labelledby="remote-setup-title" onClose=${onClose} size="sm" class="confirm remote-sheet">
    <div class="modal-body" data-testid="remote-sheet">
      <h2 id="remote-setup-title" class="modal-title">Set up “${p.title}”?</h2>
      <ul class="remote-promises">
        <li>This opens a setup chat with a Claude Code agent.</li>
        <li>If Claude Code first asks whether you trust your org folder, press “Yes, trust it”. The commands it lists are Clawdling's own, for working with your agents and reading this setup's status. None of them installs anything.</li>
        <li>The agent asks before it installs or changes anything.</li>
        <li>It uses your Claude plan.</li>
        <li>You sign in to ${p.service} yourself, in your browser. Clawdling never sees those logins.</li>
      </ul>
      <p class="modal-text">The agent's first message, so you can see exactly what it is asked:</p>
      <p class="remote-prompt"><code data-testid="remote-prompt">${prompt}</code></p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-quiet" onClick=${onClose} data-testid="remote-sheet-cancel">Cancel</button>
      <button class="btn btn-primary" onClick=${onStart} disabled=${busy} data-autofocus data-testid="remote-sheet-start">${busy ? 'Starting…' : 'Start setup'}</button>
    </div>
  </${Modal}>`;
}

function OffSheet({ hosts, remoteHere, busy, onOff, onClose }) {
  const [removeTunnel, setRemoveTunnel] = useState(false);
  return html`<${Modal} labelledby="remote-off-title" onClose=${onClose} size="sm" class="confirm">
    <div class="modal-body" data-testid="remote-off-sheet">
      <h2 id="remote-off-title" class="modal-title">Turn off Use from anywhere?</h2>
      <p class="modal-text">This computer stops answering ${hosts.map((h, i) => html`${i ? ', ' : ''}<span class="mono">${h.url}</span>`)} right away, and every paired device is signed out.${remoteHere ? ' That includes this one: you will lose this page.' : ''}</p>
      ${remoteHere ? html`<p class="modal-text remote-gap">The Tailscale serve entry or Cloudflare tunnel stays until you remove it from the computer itself.</p>`
        : html`<label class="remote-check-row"><input type="checkbox" checked=${removeTunnel} onChange=${(e) => setRemoveTunnel(e.currentTarget.checked)} data-testid="remote-off-tunnel" />
          <span>Remove the tunnel too<span class="set-sub">Opens a setup chat that removes only what setup added (<code>${remotePrompt('off')}</code>). It asks before each step.</span></span></label>`}
    </div>
    <div class="modal-foot">
      <button class="btn btn-quiet" onClick=${onClose} data-autofocus data-testid="remote-off-cancel">Cancel</button>
      <button class="btn btn-danger" onClick=${() => onOff({ removeTunnel })} disabled=${busy} data-testid="remote-off-confirm">${busy ? 'Turning off…' : 'Turn off'}</button>
    </div>
  </${Modal}>`;
}

function PairingBlock({ pairing, fresh, onDone }) {
  const links = pairing.links || [];
  const copy = async (link) => {
    const copied = await copyText(link);
    toast(copied ? 'Link copied. It works once, so send it only to your own device.' : link, { tone: copied ? 'ok' : 'info', ms: copied ? 3200 : 8000 });
  };
  if (fresh.length) {
    return html`<div class="remote-paired" role="status" data-testid="remote-paired"><${Icon} name="check" size=${14} />
      <span>${fresh.map((d) => d.label).join(', ')} ${fresh.length > 1 ? 'are' : 'is'} signed in.</span>
      <button class="link-btn" onClick=${onDone}>Done</button></div>`;
  }
  return html`<div class="remote-pairing" data-testid="remote-pairing">
    ${links.map((l) => html`<div class="phone-grid" key=${l.url}>
      <div class="qr-frame">${l.qr_svg ? html`<img class="qr" src=${`data:image/svg+xml;charset=utf-8,${encodeURIComponent(l.qr_svg)}`} width="168" height="168"
        alt=${`QR code that signs a device in to ${l.url}`} data-testid="remote-qr" />` : html`<p class="panel-quiet">Use the link.</p>`}</div>
      <div class="phone-text">
        <p class="phone-lead">Scan it with your phone's camera${l.kind === 'tailscale' ? ', with Tailscale on and signed in to the same account' : ''}, then press “Sign in this device”.</p>
        <div class="copy-line"><code class="remote-link">${l.link}</code>
          <button class="icon-btn icon-btn-sm" aria-label="Copy the pairing link" title="Copy" onClick=${() => copy(l.link)} data-testid="remote-copy"><${Icon} name="copy" size=${14} /></button></div>
        <p class="set-note">This link works once, for ${pairing.minutes || 10} minutes. It never holds your cockpit's private token.</p>
        <button class="link-btn remote-cancel" onClick=${onDone}>Cancel</button>
      </div>
    </div>`)}
  </div>`;
}
