'use client';

// /settings — manage BYOK key, model, effort, monthly budget, and see usage.
// See docs/SPEC-BYOK.md. The plaintext key is never shown (masked preview only).

import { useEffect, useState } from 'react';

interface Settings {
  byok: boolean;
  hasKey: boolean; keyPreview: string | null;
  model: string | null; effort: string | null;
  budgetUsd: number | null; periodCostUsd: number;
}

const MODELS = [
  { id: '', label: 'Default (Sonnet 4.6)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (fast)' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (most capable)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (cheapest)' },
];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [newKey, setNewKey] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState<{ configured: boolean; connected: boolean } | null>(null);

  async function load() {
    const r = await fetch('/api/user/settings');
    if (r.ok) setS(await r.json());
  }
  async function loadGoogle() {
    const r = await fetch('/api/google/status');
    if (r.ok) setGoogle(await r.json());
  }
  useEffect(() => {
    void load();
    void loadGoogle();
    // Reflect the OAuth round-trip result (?google=connected|denied|error).
    const g = new URLSearchParams(window.location.search).get('google');
    if (g === 'connected') setMsg('Google connected.');
    else if (g === 'denied') setMsg('Google connection was cancelled.');
    else if (g === 'error') setMsg('Google connection failed. Please try again.');
  }, []);

  async function disconnectGoogle() {
    setBusy(true); setMsg('');
    await fetch('/api/google/disconnect', { method: 'POST' });
    setMsg('Google disconnected.'); setBusy(false); void loadGoogle();
  }

  async function saveKey() {
    setBusy(true); setMsg('');
    const r = await fetch('/api/user/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: newKey.trim() }) });
    const d = await r.json();
    setMsg(r.ok ? 'Key saved.' : (d.error || 'Failed.'));
    setNewKey(''); setBusy(false); void load();
  }
  async function removeKey() {
    setBusy(true); setMsg('');
    await fetch('/api/user/key', { method: 'DELETE' });
    setMsg('Key removed.'); setBusy(false); void load();
  }
  async function savePrefs(patch: Record<string, unknown>) {
    setBusy(true); setMsg('');
    const r = await fetch('/api/user/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    setMsg(r.ok ? 'Saved.' : 'Failed.'); setBusy(false); if (r.ok) setS(await r.json());
  }
  if (!s) return <div style={{ ...wrap, color: '#8b929b' }}>Loading…</div>;

  return (
    <div style={wrap}>
      <div style={card}>
        <h1 style={{ fontSize: 20, margin: '0 0 20px' }}>Settings</h1>

        {s.byok ? (
          <section style={sec}>
            <div style={h}>Anthropic API key</div>
            <div style={{ fontSize: 13, color: s.hasKey ? '#7ee2a8' : '#f0a0a5', marginBottom: 8 }}>
              {s.hasKey ? `Set — ${s.keyPreview}` : 'No key set. Add one to chat.'}
            </div>
            <input value={newKey} onChange={(e) => setNewKey(e.target.value)} type="password" placeholder="sk-ant-api03-..." style={input} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={saveKey} disabled={busy || !newKey.trim()} style={btn}>Save key</button>
              {s.hasKey && <button onClick={removeKey} disabled={busy} style={btnGhost}>Remove</button>}
            </div>
          </section>
        ) : (
          <section style={sec}>
            <div style={h}>Model access</div>
            <div style={{ fontSize: 13, color: '#7ee2a8' }}>Included with your plan — no API key needed.</div>
          </section>
        )}

        <section style={sec}>
          <div style={h}>Model</div>
          <select value={s.model ?? ''} onChange={(e) => savePrefs({ model: e.target.value || null })} style={input}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </section>

        <section style={sec}>
          <div style={h}>Effort</div>
          <select value={s.effort ?? ''} onChange={(e) => savePrefs({ effort: e.target.value || null })} style={input}>
            {EFFORTS.map((e) => <option key={e} value={e}>{e || 'Default (medium)'}</option>)}
          </select>
        </section>

        <section style={sec}>
          <div style={h}>{s.byok ? 'Monthly budget (USD)' : 'Usage this month'}</div>
          <div style={{ fontSize: 13, color: '#b6bcc4', marginBottom: 8 }}>
            Used ${s.periodCostUsd.toFixed(2)} of ${(s.budgetUsd ?? 0).toFixed(2)} {s.byok ? 'this month.' : 'included with your plan. Resets next month.'}
          </div>
          {s.byok && (
            <input
              type="number" min={0} defaultValue={s.budgetUsd ?? 20}
              onBlur={(e) => savePrefs({ budgetUsd: Number(e.target.value) })} style={input}
            />
          )}
        </section>

        {google?.configured && (
          <section style={sec}>
            <div style={h}>Gmail &amp; Calendar</div>
            {google.connected ? (
              <>
                <div style={{ fontSize: 13, color: '#7ee2a8', marginBottom: 10 }}>
                  Connected. Your assistant can read and draft email and manage your calendar.
                </div>
                <button onClick={disconnectGoogle} disabled={busy} style={btnGhost}>Disconnect Google</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, color: '#b6bcc4', marginBottom: 10 }}>
                  Connect your Google account so your assistant can check your calendar, schedule events,
                  and read or draft email on your behalf.
                </div>
                <a href="/api/google/connect" style={{ ...btn, textDecoration: 'none', display: 'inline-block' }}>Connect Gmail &amp; Calendar</a>
              </>
            )}
          </section>
        )}

        {msg && <div style={{ fontSize: 13, color: '#8fb0ff', marginTop: 6 }}>{msg}</div>}
        <a href="/chat" style={{ display: 'inline-block', marginTop: 18, color: '#8fb0ff', fontSize: 14 }}>← Back to cockpit</a>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = { minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 16px', background: '#0d0f12', color: '#e7e9ec', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' };
const card: React.CSSProperties = { width: '100%', maxWidth: 480, padding: 32, border: '1px solid #23262b', borderRadius: 14, background: '#14171b' };
const sec: React.CSSProperties = { marginBottom: 22, paddingBottom: 22, borderBottom: '1px solid #23262b' };
const h: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 8 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1px solid #2c3038', borderRadius: 8, background: '#0d0f12', color: '#e7e9ec', fontSize: 14 };
const btn: React.CSSProperties = { padding: '9px 16px', border: 0, borderRadius: 8, background: '#4f7cff', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '9px 16px', border: '1px solid #2c3038', borderRadius: 8, background: 'transparent', color: '#b6bcc4', fontSize: 14, cursor: 'pointer' };
