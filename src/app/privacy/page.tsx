// /privacy — public privacy policy. Kept honest + minimal for the alpha.

export const metadata = { title: 'Privacy — Clawdling' };

export default function PrivacyPage() {
  return (
    <div style={wrap}>
      <div style={card}>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Privacy Policy</h1>
        <p style={{ color: '#8b929b', fontSize: 13, marginBottom: 24 }}>Clawdling — hosted service at clawdascended.app. Last updated 2026-07-04.</p>

        <h2 style={h2}>What we collect</h2>
        <p style={p}>Your email address (for sign-in), the chat threads and messages you create, and your usage totals. If you connect an Anthropic API key, it is encrypted at rest and used only to make model calls on your behalf.</p>

        <h2 style={h2}>Your API key</h2>
        <p style={p}>Bring-your-own-key means your Anthropic key powers your own usage. It is encrypted with AES-256 and never displayed back to you in full, never shared, and never sent anywhere except Anthropic to serve your requests.</p>

        <h2 style={h2}>Your chat content</h2>
        <p style={p}>Messages you send are transmitted to Anthropic to generate replies, subject to Anthropic&rsquo;s policies. We store your threads so you can return to them. Each account&rsquo;s data is isolated from every other account.</p>

        <h2 style={h2}>What we do not do</h2>
        <p style={p}>We do not sell your data. We do not use your chats to train models. We do not share your data with third parties except the model provider (Anthropic) needed to run the service.</p>

        <h2 style={h2}>Self-hosting</h2>
        <p style={p}>If you run the open-source version yourself, your data stays entirely on your own machine and this hosted policy does not apply.</p>

        <h2 style={h2}>Contact</h2>
        <p style={p}>Questions: reach out via the address on clawdascended.app. You can delete your data by removing your account.</p>

        <p style={{ marginTop: 28 }}><a href="/chat" style={{ color: '#8fb0ff' }}>← Back</a>  ·  <a href="/terms" style={{ color: '#8fb0ff', marginLeft: 12 }}>Terms</a></p>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = { minHeight: '100vh', display: 'flex', justifyContent: 'center', padding: '48px 16px', background: '#0d0f12', color: '#e7e9ec', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' };
const card: React.CSSProperties = { width: '100%', maxWidth: 640 };
const h2: React.CSSProperties = { fontSize: 15, fontWeight: 600, marginTop: 22, marginBottom: 6 };
const p: React.CSSProperties = { color: '#b6bcc4', fontSize: 14, lineHeight: 1.6, margin: 0 };
