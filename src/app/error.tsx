'use client';

// Route error boundary — degrades any page crash to a friendly message instead
// of a 500. Closes the audit finding that /agents /projects /crm /ai-foundry (and
// any not-yet-wired page) throw for a fresh user. Chat, Docs, and settings work;
// everything else lands here cleanly until it's wired.

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif', color: '#e7e9ec', background: '#0d0f12' }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>This section isn&rsquo;t available yet</div>
        <p style={{ color: '#8b929b', fontSize: 14, margin: '0 0 20px' }}>
          Clawdling is in alpha and this area is still being built. Chat is where the action is.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a href="/chat" style={{ padding: '9px 16px', borderRadius: 8, background: '#4f7cff', color: '#fff', fontWeight: 600, fontSize: 14, textDecoration: 'none' }}>Go to chat</a>
          <button onClick={reset} style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid #2c3038', background: 'transparent', color: '#b6bcc4', fontSize: 14, cursor: 'pointer' }}>Try again</button>
        </div>
      </div>
    </div>
  );
}
