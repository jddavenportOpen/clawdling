// /login/error — NextAuth sends users here on auth failures.

import { StatusGlyph } from '@/components/ds';

type SearchParams = { error?: string };

const COPY: Record<string, string> = {
  AccessDenied:     'Email not authorized. Only the allowlisted address can sign in.',
  Verification:     'That link expired or was already used. Request a new one.',
  Configuration:    'Auth is misconfigured. Check server logs.',
  EmailSignin:      'Could not send the magic link. Try again in a minute.',
  default:          'Something went wrong during sign-in.',
};

export default async function ErrorPage(
  { searchParams }: { searchParams: Promise<SearchParams> }
) {
  const { error } = await searchParams;
  const msg = COPY[error || 'default'] ?? COPY.default;

  return (
    <div className="min-h-screen bg-canvas text-1 flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        {/* The bespoke status-glyph error mark in a hairline surface — replaces
            the Unicode warning emoji. The glyph carries the muted state-error hue. */}
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-lg border border-hairline bg-surface-1">
          <StatusGlyph state="error" size={26} title="Sign-in failed" />
        </div>
        <h1 className="text-xl weight-strong mb-2">Sign-in failed</h1>
        <p className="text-sm text-2 mb-6">{msg}</p>
        <a
          href="/login"
          className="inline-block rounded-md bg-accent text-on-accent weight-strong px-4 py-2 text-sm press focus-accent transition-colors hover:bg-accent-hover"
        >
          Try again
        </a>
      </div>
    </div>
  );
}
