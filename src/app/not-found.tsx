// Custom 404 page.
//
// force-dynamic: Next 16 / React 19 crash when statically prerendering the
// framework's DEFAULT /_not-found page inside a root layout that mounts client
// providers (`TypeError: Cannot read properties of null (reading 'useState')`
// — the client dispatcher is null during static export). Shipping our own
// not-found opted out of static prerender sidesteps that path; it renders at
// runtime like every other page. This mirrors the global-error.tsx fix.
export const dynamic = 'force-dynamic';

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif',
        color: '#e7e9ec',
      }}
    >
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Page not found</div>
        <p style={{ color: '#8b929b', fontSize: 14, margin: '0 0 20px' }}>
          That page doesn&rsquo;t exist. Chat is where the action is.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a
            href="/chat"
            style={{
              padding: '9px 16px',
              borderRadius: 8,
              background: '#4f7cff',
              color: '#fff',
              fontWeight: 600,
              fontSize: 14,
              textDecoration: 'none',
            }}
          >
            Go to chat
          </a>
        </div>
      </div>
    </div>
  );
}
