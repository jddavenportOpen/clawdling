'use client';

// Global error boundary — catches errors in the root layout itself. Must render
// its own <html>/<body>. Friendly fallback instead of a raw crash.
//
// force-dynamic: Next 16 / React 19 crash when statically prerendering this
// error page (`TypeError: Cannot read properties of null (reading 'useContext')`
// — the client dispatcher is null during the static export of an error boundary
// that owns its own <html>/<body>). Opting the page out of static prerender
// sidesteps the null-dispatcher path; the boundary still renders at runtime.
export const dynamic = 'force-dynamic';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html>
      <body style={{ margin: 0, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif', color: '#e7e9ec', background: '#0d0f12' }}>
        <div style={{ maxWidth: 420, textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Something went wrong</div>
          <p style={{ color: '#8b929b', fontSize: 14, margin: '0 0 20px' }}>Clawdling hit an unexpected error. Try again, or head back to chat.</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <a href="/chat" style={{ padding: '9px 16px', borderRadius: 8, background: '#4f7cff', color: '#fff', fontWeight: 600, fontSize: 14, textDecoration: 'none' }}>Go to chat</a>
            <button onClick={reset} style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid #2c3038', background: 'transparent', color: '#b6bcc4', fontSize: 14, cursor: 'pointer' }}>Try again</button>
          </div>
        </div>
      </body>
    </html>
  );
}
