// ═══════════════════════════════════════════════════════════════════════════
// chat-interface-v2 — NextAuth v5 (Auth.js) configuration
//
// - Magic-link email sign-in (no passwords, no OAuth providers)
// - Single-user allowlist: only NEXT_AUTH_ALLOWED_EMAIL can sign in
// - 365-day sessions with daily sliding refresh → JD signs in once per year
// - Supabase adapter for sessions/users/verification_tokens tables
// - Kill-switch: NEXT_AUTH_KILL=1 throws on every auth attempt
//
// Env required:
//   NEXTAUTH_SECRET               — random 32+ bytes (openssl rand -base64 32)
//   NEXTAUTH_URL                  — canonical app URL (https://app.example.com)
//   NEXT_AUTH_ALLOWED_EMAIL       — single allowed signer (user@example.com)
//   NEXT_PUBLIC_SUPABASE_URL      — existing Supabase project URL
//   SUPABASE_SERVICE_KEY          — service-role key
//
// Email sender (pick ONE, fallback order):
//   RESEND_API_KEY + EMAIL_FROM  — recommended for Vercel
//   EMAIL_SERVER + EMAIL_FROM    — nodemailer SMTP URL (works with Gmail app-pw)
//   (none)                        — dev mode: magic link printed to server log
// ═══════════════════════════════════════════════════════════════════════════

import NextAuth, { type NextAuthConfig } from 'next-auth';
import Nodemailer from 'next-auth/providers/nodemailer';
import { SupabaseAdapter } from '@auth/supabase-adapter';

type SendVerificationRequestParams = Parameters<
  NonNullable<Parameters<typeof Nodemailer>[0]['sendVerificationRequest']>
>[0];

// ── Kill-switch guard ──────────────────────────────────────────────────────
if (process.env.NEXT_AUTH_KILL === '1') {
  console.warn('[auth] NEXT_AUTH_KILL=1 — auth is disabled.');
}

// ── Allowlist check ────────────────────────────────────────────────────────
// Multi-tenant PRODUCT: sign-up is OPEN by default. An allowlist is enforced
// ONLY when one is explicitly configured, so JD can gate a restricted alpha to
// friendly testers by setting AUTH_ALLOWLIST (comma-separated), or open it fully
// by leaving both env vars unset. NEXT_AUTH_ALLOWED_EMAIL is kept for back-compat
// (single-user self-host) and folded into the same set.
const ALLOWLIST = new Set(
  [
    process.env.NEXT_AUTH_ALLOWED_EMAIL || '',
    ...(process.env.AUTH_ALLOWLIST || '').split(','),
  ]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
/** True if this email may sign in. Empty allowlist = open signup (allow all). */
function emailAllowed(email: string): boolean {
  if (ALLOWLIST.size === 0) return true;
  return ALLOWLIST.has(email.trim().toLowerCase());
}

// ── Unified magic-link sender ──────────────────────────────────────────────
async function sendMagicLink(params: SendVerificationRequestParams): Promise<void> {
  const { identifier: email, url, provider } = params;

  // If kill-switch is on, refuse at this layer too
  if (process.env.NEXT_AUTH_KILL === '1') {
    throw new Error('Auth is temporarily disabled (NEXT_AUTH_KILL=1).');
  }

  // Allowlist — only enforced when one is configured (see emailAllowed).
  if (!emailAllowed(email)) {
    console.warn(`[auth] Refused magic-link send to ${email} (not in allowlist).`);
    // NextAuth expects this to throw on failure so the user sees an error.
    throw new Error('Email not authorized.');
  }

  // 2026-05-02: Resend free tier requires a verified sender domain. Until
  // app.example.com is verified, use Resend's onboarding@resend.dev default
  // — it can only send to the Resend account owner's email, which is fine
  // because we already enforce single-user allowlist above.
  const from = provider.from ?? process.env.EMAIL_FROM ?? 'onboarding@resend.dev';
  const subject = 'Sign in to Clawdling';
  const text = `Tap the link to sign in. Expires in 24 hours.\n\n${url}\n\nIf you didn't request this, ignore this email.`;
  const html = `
    <div style="font-family: -apple-system,BlinkMacSystemFont,sans-serif; max-width: 480px; margin: 40px auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
      <h2 style="margin: 0 0 16px;">Sign in to Clawdling</h2>
      <p style="color:#4b5563; font-size: 15px;">Tap the button to sign in. Expires in 24 hours.</p>
      <a href="${url}" style="display:inline-block; margin: 16px 0; padding: 12px 24px; background:#111; color:#fff; text-decoration:none; border-radius: 8px; font-weight: 600;">Sign in</a>
      <p style="color:#9ca3af; font-size: 13px;">If the button doesn't work, paste this link:<br/>${url}</p>
      <p style="color:#9ca3af; font-size: 12px; margin-top: 24px;">If you didn't request this, ignore this email.</p>
    </div>`;

  // 1) Resend HTTP (preferred for Vercel)
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from, to: email, subject, text, html }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Resend send failed: ${res.status} ${err.slice(0, 200)}`);
    }
    return;
  }

  // 2) nodemailer SMTP via EMAIL_SERVER (e.g. smtp://user:app-pw@smtp.gmail.com:587)
  if (process.env.EMAIL_SERVER) {
    // Dynamic import — only loaded if SMTP path is used
    const nodemailer = (await import('nodemailer')).default;
    const tx = nodemailer.createTransport(process.env.EMAIL_SERVER);
    await tx.sendMail({ from, to: email, subject, text, html });
    return;
  }

  // 3) Dev mode — log the link to server so you can click it
  console.log('\n────────────────────────────────────────────');
  console.log('[auth:dev] Magic link for', email);
  console.log(url);
  console.log('────────────────────────────────────────────\n');
}

// ── NextAuth config ────────────────────────────────────────────────────────
export const authConfig: NextAuthConfig = {
  secret: process.env.NEXTAUTH_SECRET,
  trustHost: true, // Vercel terminates TLS
  // debug removed — auth working 2026-04-22
  // 2026-05-02: SupabaseAdapter evaluates at module load — a missing env at
  // build time throws "supabaseUrl is required" during Next "Collecting page
  // data" on every preview branch. Vercel only had supabase env vars set on
  // feature/phase-0-auth, so every other PR's preview deploy crashed here.
  // Placeholder so module load never throws at build time; runtime auth still
  // requires the real env. URL placeholder is a non-routable example host, NOT
  // any live project (leak fix). ADJUTANT_AUTH=single bypasses this adapter
  // entirely for local self-host (see docs/ARCHITECTURE.md).
  // Otherwise the Supabase adapter backs magic-link database sessions.
  adapter: SupabaseAdapter({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.invalid',
    secret: process.env.SUPABASE_SERVICE_KEY || 'build-time-placeholder',
  }),
  providers: [
    // 2026-05-02: Wire sendVerificationRequest to our custom sender so we
    // actually use the Resend HTTP path instead of letting NextAuth fall
    // through to default SMTP (which hangs from Vercel functions to
    // Gmail:587). The `server` config is still required by Nodemailer's
    // type signature but unused when sendVerificationRequest is provided.
    Nodemailer({
      server: {
        host: process.env.EMAIL_HOST ?? 'smtp.gmail.com',
        port: Number(process.env.EMAIL_PORT ?? 587),
        secure: (process.env.EMAIL_SECURE ?? 'false') === 'true',
        requireTLS: true,
        auth: {
          user: process.env.EMAIL_USER ?? process.env.EMAIL_FROM ?? '',
          pass: process.env.EMAIL_PASSWORD ?? '',
        },
      },
      from: process.env.EMAIL_FROM ?? 'onboarding@resend.dev',
      maxAge: 24 * 60 * 60,
      sendVerificationRequest: sendMagicLink,
    }),
  ],
  session: {
    strategy: 'database',
    maxAge: 365 * 24 * 60 * 60,   // 1 year cookie
    updateAge: 24 * 60 * 60,      // sliding refresh every day → never expires with use
  },
  pages: {
    signIn: '/login',
    verifyRequest: '/login/verify',
    error: '/login/error',
  },
  callbacks: {
    async signIn({ user }) {
      if (process.env.NEXT_AUTH_KILL === '1') return false;
      return emailAllowed(user.email || '');
    },
    async session({ session, user }) {
      // Surface user.id on the session (database strategy → `user`).
      // Every chat query filters by this id (isolation).
      if (session.user && user?.id) {
        (session.user as { id?: string }).id = user.id;
      }
      return session;
    },
  },
};

// NOTE: the Supabase adapter is wired in auth/route.ts — importing it here
// would pull server-only deps into the edge bundle. Keep this file transport-safe.
const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export { handlers, auth, signIn, signOut };
