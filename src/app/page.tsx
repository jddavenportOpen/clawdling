// ═══════════════════════════════════════════════════════════════════════════
// / — PUBLIC marketing landing page (the front door).
// The app itself lives behind auth at /chat. This page is intentionally public
// (proxy-exempt) and static.
// ═══════════════════════════════════════════════════════════════════════════

import Link from 'next/link';

export const metadata = {
  title: 'Clawdling: Your AI chief of staff',
  description: 'A private AI chief of staff. It chats, searches the web, and acts on your behalf, with your data isolated. Sign in and go, no API keys to manage.',
};

export default function Landing() {
  return (
    <div style={{ background: '#0b0d10', color: '#e7e9ec', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif', minHeight: '100vh' }}>
      {/* Nav */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 1080, margin: '0 auto', padding: '20px 24px' }}>
        <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em' }}>Clawdling</div>
        <nav style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Link href="/login" style={ghostBtn}>Log in</Link>
          <Link href="/login" style={primaryBtn}>Get started</Link>
        </nav>
      </header>

      {/* Hero */}
      <section style={{ maxWidth: 820, margin: '0 auto', padding: '72px 24px 40px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block', fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8fb0ff', border: '1px solid #24324f', borderRadius: 999, padding: '4px 12px', marginBottom: 22 }}>
          Alpha · early access
        </div>
        <h1 style={{ fontSize: 48, lineHeight: 1.08, margin: '0 0 18px', letterSpacing: '-0.02em' }}>
          Your AI chief of staff,<br />in a cockpit you own.
        </h1>
        <p style={{ fontSize: 18, color: '#9aa2ad', maxWidth: 620, margin: '0 auto 32px', lineHeight: 1.55 }}>
          Clawdling is a private assistant that chats, searches the web, and acts on your behalf.
          Sign in and go: no API keys to manage, no setup. We run the model; your data stays yours.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link href="/login" style={{ ...primaryBtn, padding: '13px 26px', fontSize: 16 }}>Get started</Link>
          <Link href="/login" style={{ ...ghostBtn, padding: '13px 26px', fontSize: 16 }}>Log in</Link>
        </div>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 16 }}>Private by design. Your data is isolated and never sold or trained on.</p>
      </section>

      {/* Features */}
      <section style={{ maxWidth: 1000, margin: '0 auto', padding: '32px 24px 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 18 }}>
        {[
          { t: 'It acts, not just talks', d: 'Live web search and fetch built in, so it can look things up and reason over current information — not a static chatbot.' },
          { t: 'No setup', d: 'Sign in and go. No API keys to manage, no configuration. We handle model access; you just use it.' },
          { t: 'Your data, isolated', d: 'Every account is walled off from every other. We do not sell your data or train on your chats.' },
          { t: 'Own it, or host it', d: 'Use the hosted cockpit, or self-host the open-source core on your own machine with your own key. Your choice.' },
        ].map((f) => (
          <div key={f.t} style={{ border: '1px solid #1c2027', borderRadius: 14, background: '#111419', padding: 22 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{f.t}</div>
            <div style={{ fontSize: 14, color: '#9aa2ad', lineHeight: 1.55 }}>{f.d}</div>
          </div>
        ))}
      </section>

      {/* CTA band */}
      <section style={{ maxWidth: 820, margin: '0 auto', padding: '48px 24px 24px', textAlign: 'center' }}>
        <h2 style={{ fontSize: 26, margin: '0 0 16px' }}>Ready when you are.</h2>
        <Link href="/login" style={{ ...primaryBtn, padding: '13px 28px', fontSize: 16 }}>Get started</Link>
      </section>

      {/* Footer */}
      <footer style={{ maxWidth: 1080, margin: '0 auto', padding: '40px 24px', borderTop: '1px solid #1c2027', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, color: '#6b7280', fontSize: 13 }}>
        <div>© 2026 Clawdling</div>
        <div style={{ display: 'flex', gap: 18 }}>
          <Link href="/privacy" style={{ color: '#9aa2ad' }}>Privacy</Link>
          <Link href="/terms" style={{ color: '#9aa2ad' }}>Terms</Link>
          <Link href="/login" style={{ color: '#9aa2ad' }}>Log in</Link>
        </div>
      </footer>
    </div>
  );
}

const primaryBtn: React.CSSProperties = { padding: '9px 18px', borderRadius: 9, background: '#4f7cff', color: '#fff', fontWeight: 600, fontSize: 14, textDecoration: 'none' };
const ghostBtn: React.CSSProperties = { padding: '9px 18px', borderRadius: 9, border: '1px solid #2c3038', color: '#d6dae0', fontSize: 14, textDecoration: 'none' };
