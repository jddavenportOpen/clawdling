// /terms — public terms of service. Minimal + honest for the alpha.

export const metadata = { title: 'Terms — Clawdling' };

export default function TermsPage() {
  return (
    <div style={wrap}>
      <div style={card}>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Terms of Service</h1>
        <p style={{ color: '#8b929b', fontSize: 13, marginBottom: 24 }}>Clawdling — hosted service at clawdascended.app. Last updated 2026-07-04.</p>

        <h2 style={h2}>Alpha software</h2>
        <p style={p}>Clawdling is early alpha software provided as-is, without warranty. Features may change or break. Do not rely on it for critical work.</p>

        <h2 style={h2}>Your account and key</h2>
        <p style={p}>You are responsible for your own Anthropic API key and the usage and cost it incurs. You set a monthly budget cap; you are responsible for the spend under it. Do not use the service for unlawful purposes or in violation of Anthropic&rsquo;s usage policies.</p>

        <h2 style={h2}>Acceptable use</h2>
        <p style={p}>Do not attempt to access other users&rsquo; data, abuse the service, or use it to generate prohibited content. We may suspend accounts that violate these terms.</p>

        <h2 style={h2}>Liability</h2>
        <p style={p}>To the maximum extent permitted by law, Clawdling is not liable for any damages arising from use of the service, including model outputs, downtime, or data loss.</p>

        <h2 style={h2}>Changes</h2>
        <p style={p}>These terms may change as the product matures. Continued use means acceptance of the current terms.</p>

        <p style={{ marginTop: 28 }}><a href="/chat" style={{ color: '#8fb0ff' }}>← Back</a>  ·  <a href="/privacy" style={{ color: '#8fb0ff', marginLeft: 12 }}>Privacy</a></p>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = { minHeight: '100vh', display: 'flex', justifyContent: 'center', padding: '48px 16px', background: '#0d0f12', color: '#e7e9ec', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' };
const card: React.CSSProperties = { width: '100%', maxWidth: 640 };
const h2: React.CSSProperties = { fontSize: 15, fontWeight: 600, marginTop: 22, marginBottom: 6 };
const p: React.CSSProperties = { color: '#b6bcc4', fontSize: 14, lineHeight: 1.6, margin: 0 };
