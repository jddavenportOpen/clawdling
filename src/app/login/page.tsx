// ═══════════════════════════════════════════════════════════════════════════
// /login — magic-link sign-in form.
// Server Component that renders the form. The form POSTs to NextAuth's
// /api/auth/signin/email endpoint (built-in handler).
// ═══════════════════════════════════════════════════════════════════════════

import { headers } from 'next/headers';
import { Wordmark, Eyebrow } from '@/components/ds';

// force-dynamic: this page reads request headers (host / cookie) and fetches a
// live CSRF token, so it is never actually static. Marking it dynamic also
// sidesteps the Next 16 / React 19 null-dispatcher crash seen when statically
// prerendering pages whose root layout mounts the cmdk command palette.
export const dynamic = 'force-dynamic';

type SearchParams = {
  callbackUrl?: string;
  error?: string;
};

function errorBanner(code: string | undefined): string | null {
  if (!code) return null;
  const known: Record<string, string> = {
    OAuthAccountNotLinked: 'That email is not linked to this account.',
    EmailSignin: 'Could not send the magic link. Try again in a minute.',
    AccessDenied: 'Email not authorized.',
    Configuration: 'Auth is misconfigured. Check server logs.',
    Verification: 'That link expired or was already used. Request a new one.',
  };
  return known[code] ?? `Sign-in error: ${code}`;
}

export default async function LoginPage(
  { searchParams }: { searchParams: Promise<SearchParams> }
) {
  const params = await searchParams;
  const callbackUrl = params.callbackUrl || '/chat';
  const err = errorBanner(params.error);

  // Build the CSRF-protected signin form. NextAuth v5 expects a POST to
  // /api/auth/signin/email with an email field + csrfToken cookie set.
  // We render the form action as the signin endpoint and let NextAuth
  // set the CSRF cookie on first GET of /login.
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const base = `${proto}://${host}`;

  // Fetch the CSRF token so the form can submit it back. NextAuth's
  // /api/auth/csrf returns { csrfToken }.
  let csrfToken = '';
  try {
    const res = await fetch(`${base}/api/auth/csrf`, {
      cache: 'no-store',
      headers: { cookie: h.get('cookie') ?? '' },
    });
    if (res.ok) {
      const data = await res.json();
      csrfToken = data.csrfToken ?? '';
    }
  } catch {
    // Swallow — form will still render; CSRF will re-request on POST.
  }

  return (
    <div className="min-h-screen bg-canvas text-1 flex items-center justify-center px-4">
      {/* max-w-sm on mobile (sized for thumb keyboards), max-w-md on desktop
          so the form doesn't look like a tiny mobile widget on a 27" screen. */}
      <div className="w-full max-w-sm md:max-w-md">
        {/* Brand lockup: mono eyebrow above the bespoke lowercase wordmark — the
            "real product" hierarchy from the design system (no plain text logo). */}
        <div className="mb-8 flex flex-col items-center text-center">
          <Eyebrow>CLAWDLING</Eyebrow>
          <Wordmark height={28} accent className="mt-2" title="Clawdling" />
          <div className="text-sm text-2 mt-3">Sign in with a magic link</div>
        </div>

        {err && (
          <div className="mb-4 rounded-md border border-hairline bg-tint-error px-3 py-2 text-sm text-state-error">
            {err}
          </div>
        )}

        <form action="/api/auth/signin/nodemailer" method="POST" className="space-y-3">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <label className="block">
            <span className="block text-sm text-2 mb-1 weight-label">Email</span>
            <input
              type="email"
              name="email"
              required
              autoFocus
              autoComplete="email"
              placeholder="you@example.com"
              className="w-full rounded-md bg-surface-1 border border-hairline px-3 py-2 text-sm text-1 placeholder:text-3 focus-accent transition-colors"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-md bg-accent text-on-accent weight-strong py-2 text-sm press focus-accent transition-colors hover:bg-accent-hover"
          >
            Send magic link
          </button>
        </form>

        <p className="mt-6 text-xs text-3 text-center">
          Only the allowlisted address can sign in. Unauthorized attempts are logged.
        </p>
      </div>
    </div>
  );
}
