'use client';

// ═══════════════════════════════════════════════════════════════════════════
// NeedsYouNotifier — fires a browser notification when a live agent finishes
// its turn and is waiting on JD, while the cockpit isn't in the foreground.
//
// Why this is the phone-first win: JD opens /chat, taps an agent, then switches
// apps / locks the phone. When the agent parks on him (activity → 'waiting'),
// a notification fires; tapping it deep-links straight into that pane. This
// beats native Remote Control's known gap (no push on permission/decision —
// anthropics/claude-code#29438).
//
// Built ON the EXISTING signal: /api/sessions/list already carries per-session
// `activity` (the same feed the rail's amber "Needs you" dot reads). NO bridge
// change, NO bridge restart. (chat-vision loop, Iter 2.)
//
// Scope note: the Notifications API only delivers while this page's JS is
// running (a backgrounded tab, throttled on mobile). True app-closed delivery
// is web-push + service worker — Iter 5. This is the foreground/backgrounded
// stepping stone that proves the transition-detection + deep-link plumbing
// Iter 5 reuses.
//
// Firing rules (deliberate, to avoid noise):
//   • only NEWLY-waiting sessions fire (diffNewlyWaiting) — a steady wait
//     doesn't re-alert;
//   • the first poll seeds silently — pre-existing waits never blast on load;
//   • only when document.hidden — if /chat is in the foreground the rail's
//     amber dot already shows it, so an OS notification would be redundant;
//   • only when Notification.permission === 'granted'.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useRef, useState } from 'react';
import {
  diffNewlyWaiting,
  buildNeedsYouUrl,
  notifyLabel,
  type WaitingSessionLite,
} from '@/lib/needsYouNotify';
import { StatusGlyph } from '@/components/ds/StatusGlyph';

interface ListResp {
  sessions?: WaitingSessionLite[];
}

const POLL_MS = 5_000;

export default function NeedsYouNotifier(): React.ReactElement | null {
  const prevRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  // 'unsupported' until we confirm the API exists (also the SSR value, so the
  // server and first client render agree — no hydration mismatch).
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(
    'unsupported'
  );

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setPerm(Notification.permission);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fire = (newly: WaitingSessionLite[]) => {
      if (typeof window === 'undefined' || !('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      // Foreground → the rail already shows it; don't double-signal.
      if (typeof document !== 'undefined' && !document.hidden) return;
      for (const s of newly) {
        if (!s.id) continue;
        try {
          // OS-notification title carries NO Unicode emoji (the cockpit's
          // status language is the bespoke StatusGlyph, never clipart). The
          // body names the agent so the alert is specific, not averaged.
          const n = new Notification('An agent needs you', {
            body: `${notifyLabel(s)} finished its turn and is waiting on you.`,
            tag: `needs-you-${s.id}`, // collapse repeats for the same session
          });
          const url = buildNeedsYouUrl(window.location.search, s.id);
          n.onclick = () => {
            window.focus();
            window.location.href = url;
            n.close();
          };
        } catch {
          // Notification construction can throw on some platforms (e.g. iOS
          // without an installed PWA) — degrade silently; Iter 5 (web-push)
          // is the real fix for those.
        }
      }
    };

    const tick = async () => {
      try {
        const r = await fetch('/api/sessions/list', { cache: 'no-store' });
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as ListResp;
        const { newly, next } = diffNewlyWaiting(prevRef.current, d.sessions ?? []);
        prevRef.current = next;
        // Seed silently on the first successful poll so sessions already
        // waiting when /chat loads don't all blast at once.
        if (!seededRef.current) {
          seededRef.current = true;
          return;
        }
        if (newly.length > 0) fire(newly);
      } catch {
        // best-effort — a failed poll just means we try again next tick.
      }
    };

    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Opt-in affordance — only while the browser hasn't decided yet. Requesting
  // permission needs a user gesture, so we surface a small pill rather than
  // prompting on load. Once granted/denied (or unsupported), render nothing.
  //
  // Warm Graphite + critic r1 FIX #3 (single filled accent per screen): this is
  // a SETUP affordance ("turn notifications on"), NOT a live alert — nothing is
  // waiting on JD yet. So it must NOT carry the brand accent. The grid screen's
  // ONE filled accent is reserved for the focused composer; an amber-touched
  // setup pill in the same corner was a second competing accent. This is now a
  // GHOST / hairline-outline control: a quiet IDLE ring (no pulse, no amber) +
  // a tertiary text-token label that warms to text-1 on hover. The pulsing
  // `attention` StatusGlyph is reserved for the REAL needs-you cue on a live
  // tab — never spent on this dormant setup button.
  //   • solid surface-2 + hairline border (no amber, no glass blur);
  //   • a muted IDLE StatusGlyph ring (no eye-demand pulse) — no emoji;
  //   • tertiary mono-grey label, hover → text-1;
  //   • a single popover-class shadow (it floats), transform/opacity press only.
  if (perm !== 'default') return null;
  return (
    <button
      type="button"
      data-testid="needs-you-enable"
      onClick={() => {
        if (typeof window !== 'undefined' && 'Notification' in window) {
          void Notification.requestPermission().then(setPerm);
        }
      }}
      // chat-session mobile pass (2026-06-10, header reflow): on a phone this
      // fixed pill sat ON TOP of the focused-session status chips. Collapse it
      // to ICON-ONLY at max-md (just the quiet StatusGlyph ring — no label),
      // with symmetric padding so it reads as a single round glyph button. The
      // `md:` reverts restore the desktop pill byte-for-byte (gap-2, pl-2 pr-2.5,
      // and the visible label below).
      className="group fixed top-2 right-2 z-[120] inline-flex items-center gap-0 md:gap-2 rounded-lg border border-hairline bg-surface-2 p-1.5 md:pl-2 md:pr-2.5 md:py-1.5 transition-[background-color,transform] duration-[var(--dur-base)] ease-[var(--ease-out-strong)] hover:bg-surface-3 active:scale-[0.97]"
      // Popover-class shadow — applied inline because --shadow-popover lives in
      // :root, not @theme (no `shadow-*` utility); this is the house convention
      // (MobileSidebarDrawer / NewSessionPicker / ThreadSidebar context menu).
      style={{ boxShadow: 'var(--shadow-popover)' }}
      title="Get a notification when an agent finishes and is waiting on you"
      aria-label="Alert me when an agent needs me"
    >
      {/* quiet idle ring (no pulse, no accent) — this is a setup control, not a
          live alert; the eye-demand attention ring is reserved for real waits.
          On mobile this glyph IS the whole control (label hidden below). */}
      <StatusGlyph state="idle" size={13} title="Enable needs-you notifications" />
      {/* Label hidden at max-md (icon-only on a phone); shown md:+ unchanged. */}
      <span className="hidden md:inline weight-label text-[12px] leading-none text-3 group-hover:text-1 transition-colors duration-[var(--dur-base)]">
        Alert me when an agent needs me
      </span>
    </button>
  );
}
