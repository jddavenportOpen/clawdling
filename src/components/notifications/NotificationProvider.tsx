// ═══════════════════════════════════════════════════════════════════════════
// NotificationProvider — single mount point for the cockpit-v1 in-app
// notification system. Wires useCompletionEvents() to NotificationToast
// (top-left fixed) and an optional audio chime.
//
// (see docs/ARCHITECTURE.md)
//
// Mount this ONCE near the root (e.g. in app/layout.tsx). It renders:
//   - A top-left FIXED stack of toasts.
//
// 2026-05-30 (JD): the global notification BELL + unread-count badge has been
// REMOVED from the app chrome entirely. JD asked for it gone repeatedly; prior
// passes only *conditionally hid* it in cockpit grid mode (`?panes=`), so it
// kept reappearing on dashboard/projects/non-grid-chat routes. This is the real
// removal — the bell component and its render site are deleted. The toast +
// audio chime + completion-event context all remain intact.
//
// Audio: looks for /sounds/ping.mp3. If the file 404s the play call rejects
// silently — no console spam. JD can drop a real chime in later without code
// changes. Pref persisted in localStorage under cockpit.audio = 'on'|'off'
// (default on; no in-app toggle now that the bell is gone).
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useCompletionEvents } from '@/lib/useCompletionEvents';
import NotificationToast from './NotificationToast';

const AUDIO_KEY = 'cockpit.audio';
const AUDIO_FILE = '/sounds/ping.mp3';

function loadAudioPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const v = window.localStorage.getItem(AUDIO_KEY);
    if (v === 'off') return false;
    return true;
  } catch {
    return true;
  }
}

export default function NotificationProvider() {
  return (
    <Suspense fallback={null}>
      <NotificationProviderInner />
    </Suspense>
  );
}

function NotificationProviderInner() {
  const { newEventTick, latestNew } = useCompletionEvents();

  const [audioEnabled] = useState<boolean>(() => loadAudioPref());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastPlayedTickRef = useRef(0);

  // Lazy-construct the Audio element on first mount (browser only).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      audioRef.current = new Audio(AUDIO_FILE);
      audioRef.current.preload = 'auto';
      audioRef.current.volume = 0.4;
    } catch {
      audioRef.current = null;
    }
  }, []);

  // Play chime on each new event tick (when enabled).
  useEffect(() => {
    if (newEventTick === 0) return;
    if (newEventTick === lastPlayedTickRef.current) return;
    lastPlayedTickRef.current = newEventTick;
    if (!audioEnabled) return;
    const el = audioRef.current;
    if (!el) return;
    try {
      el.currentTime = 0;
      // play() returns a Promise that rejects if (a) the file 404s or (b)
      // the user hasn't interacted with the page yet. Both are non-fatal —
      // swallow silently so the toast still shows.
      void el.play().catch(() => {});
    } catch {
      // ignore
    }
  }, [newEventTick, audioEnabled]);

  // Toasts only — the global bell + unread badge were removed from the chrome
  // (JD's repeated request). Completion events still fire toasts + the audio
  // chime; they just no longer surface a persistent bell button.
  return (
    <NotificationToast
      newEventTick={newEventTick}
      latestNew={latestNew}
    />
  );
}
