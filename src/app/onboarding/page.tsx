'use client';

// /onboarding — first-run BYOK gate. Captures + live-tests the user's Anthropic
// key, then sends them into the cockpit. See docs/SPEC-BYOK.md.

import { useState } from 'react';

export default function OnboardingPage() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/user/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key.trim() }),
      });
      const d = await r.json();
      if (r.ok) {
        window.location.href = '/chat';
      } else {
        setErr(d.error || 'Could not save the key.');
        setBusy(false);
      }
    } catch (e2) {
      setErr(String(e2));
      setBusy(false);
    }
  }

  return (
    <div style={wrap}>
      <form onSubmit={save} style={card}>
        <h1 style={{ fontSize: 20, margin: '0 0 6px' }}>Welcome to Clawdling</h1>
        <p style={{ color: '#8b929b', fontSize: 14, margin: '0 0 18px' }}>
          Clawdling runs on your own Anthropic key, so you control your usage and cost.
          Paste your key to begin. It is encrypted and never shared.
        </p>
        <label style={label}>Anthropic API key</label>
        <input
          value={key} onChange={(e) => setKey(e.target.value)} type="password"
          placeholder="sk-ant-api03-..." autoComplete="off" style={input}
        />
        <p style={{ color: '#6b7280', fontSize: 12, margin: '8px 0 0' }}>
          Get one at console.anthropic.com. We make one free test call to confirm it works.
        </p>
        <button type="submit" disabled={busy || !key.trim()} style={{ ...btn, opacity: busy || !key.trim() ? 0.6 : 1 }}>
          {busy ? 'Testing your key…' : 'Test & continue'}
        </button>
        {err && <div style={{ marginTop: 14, fontSize: 13, color: '#f0a0a5' }}>{err}</div>}
      </form>
    </div>
  );
}

const wrap: React.CSSProperties = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d0f12', color: '#e7e9ec', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' };
const card: React.CSSProperties = { width: '100%', maxWidth: 440, padding: 32, border: '1px solid #23262b', borderRadius: 14, background: '#14171b' };
const label: React.CSSProperties = { display: 'block', fontSize: 13, color: '#b6bcc4', margin: '12px 0 6px' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '11px 12px', border: '1px solid #2c3038', borderRadius: 8, background: '#0d0f12', color: '#e7e9ec', fontSize: 14 };
const btn: React.CSSProperties = { width: '100%', marginTop: 20, padding: 12, border: 0, borderRadius: 8, background: '#4f7cff', color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer' };
