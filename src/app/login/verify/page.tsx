// /login/verify — shown after form submit: "check your email."

import { Icon } from '@/components/ds';
import { EnvelopeSimple, ArrowLeft } from '@phosphor-icons/react/dist/ssr';

export default function VerifyPage() {
  return (
    <div className="min-h-screen bg-canvas text-1 flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        {/* Bespoke duotone glyph in a hairline-bordered surface — replaces the
            Unicode mailbox emoji (an AI-slop tell). */}
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-lg border border-hairline bg-surface-1 text-2">
          <Icon glyph={EnvelopeSimple} state="domain" size={26} aria-label="Email sent" />
        </div>
        <h1 className="text-xl weight-strong mb-2">Check your email</h1>
        <p className="text-sm text-2 mb-6">
          A magic link is on its way. Tap it on any device to sign in. Expires in 24 hours.
        </p>
        <a
          href="/login"
          className="inline-flex items-center gap-1.5 text-sm text-3 hover:text-1 transition-colors"
        >
          <Icon glyph={ArrowLeft} size={14} aria-hidden /> Back to sign in
        </a>
      </div>
    </div>
  );
}
