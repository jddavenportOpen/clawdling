'use client';

// ═══════════════════════════════════════════════════════════════════════════
// NewSessionCta — client wrapper around the unified NewSessionPicker for the
// /chat landing. Server Component pages can't open client-only modal state, so
// this small client component owns the button + picker pair. On launch,
// navigates to /chat?panes=<sid> to enter grid mode.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import NewSessionPicker from './NewSessionPicker';
// ── Warm Graphite foundation (REUSED) ───────────────────────────────────────
// This CTA is the ONE filled hero-accent affordance on the /chat landing (the
// single rationed accent instance per screen). The old build painted it in the
// banned cyan-on-slate AI-HUD combo (border-cyan-800 / bg-cyan-950 / text-cyan)
// with a lobster emoji — both named slop tells. It now carries the clay-amber
// accent FILLED, with the Circuitry nerve-hub glyph (the Clawd CEO orchestrator)
// — never an emoji and never the Crown clipart the critic flagged round-3.
import { Icon } from '@/components/ds/Icon';
import { Circuitry } from '@phosphor-icons/react/dist/ssr';

export default function NewSessionCta() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // The single FILLED accent on this screen: solid clay-amber, dark text
        // on-accent, lifts to accent-hover. radius-md (8px), :active scale.
        className="rounded-[var(--radius-md)] bg-accent text-on-accent hover:bg-accent-hover active:scale-[0.99] transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out-strong)] p-4 text-left w-full"
      >
        <div className="flex items-center gap-3 mb-1">
          <Icon glyph={Circuitry} state="idle" size={20} className="shrink-0 text-on-accent" aria-hidden />
          <span className="weight-strong text-on-accent">+ New session</span>
        </div>
        <p className="text-xs text-on-accent/80">
          Launch a project agent. <span className="font-mono tabular">⌘</span> to search.
        </p>
      </button>

      {/* W8 (JD 2026-05-31): cockpit-restricted. The projects-only picker
          strips the ad-hoc Claude / 8 spawnable domains / specialists /
          launch-all rows. The locked model: the ONLY picker-spawnable agents
          are projects (CEO is the header button, domains are the fixed rail).
          NewSessionPicker now DEFAULTS to 'projects', and this call-site
          declares it explicitly so its intent is self-documenting. */}
      <NewSessionPicker
        open={open}
        onClose={() => setOpen(false)}
        mode="projects"
        onLaunched={(sid) => {
          // Enter grid mode for this single pane.
          router.push(`/chat?panes=${encodeURIComponent(sid)}`);
        }}
        hasOpenPanes={false}
      />
    </>
  );
}
