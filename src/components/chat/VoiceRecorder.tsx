'use client';

/**
 * VoiceRecorder
 *
 * Press-and-hold mic button that captures audio via MediaRecorder, POSTs
 * the blob to `/api/transcribe` (multipart FormData, field `audio`), and
 * fires `onTranscript(text)` with the Whisper transcription.
 *
 * Gestures:
 *   - pointerdown  → request mic, start recording
 *   - pointerup    → stop recording, transcribe
 *   - pointerleave → cancel (user dragged off the button)
 *
 * Mobile-permission hardening (fix/mobile-mic-permission, 2026-06-11):
 *
 * 1. RACE GUARD — on iOS, getUserMedia can stay pending long after
 *    pointerdown (permission sheet, slow hardware). If the user released
 *    while it was in flight, the old code early-returned from
 *    stopAndTranscribe (state still 'idle'), then the await resolved and
 *    recorder.start() ran with NO finger down → hot mic + stuck
 *    'recording' state. Now `releasedWhilePendingRef` is set on any
 *    pointerup/cancel/leave while the request is pending; when the promise
 *    resolves we immediately stop all tracks and return to idle. The mic
 *    is never left hot.
 *
 * 2. FIRST-USE / PERMISSION-REQUEST PRESS — on first use, the iOS
 *    permission sheet interrupts the press gesture entirely, so "record
 *    through the grant" is always a broken interaction. If
 *    navigator.permissions reports 'prompt' (or is unavailable and we've
 *    never successfully recorded — persisted via localStorage), the press
 *    is treated as a permission request: we acquire the stream, stop it,
 *    and show a "Mic ready — hold to record" hint instead of pretending
 *    to record.
 *
 * 3. PROMINENT DENIED/UNSUPPORTED UI — iOS rejects getUserMedia INSTANTLY
 *    (no prompt) when the site was previously denied, and in-app browsers
 *    (Telegram/SFSafariViewController) may lack mediaDevices entirely.
 *    The old 10px mono error text was invisible on a phone. Errors now
 *    render as a fixed, dismissable banner (portal to <body>) with
 *    actionable copy — including the iOS Settings path, since no code can
 *    re-trigger the prompt once iOS has the site set to "Deny".
 *
 * Errors are still surfaced via `onError` prop for parents that render
 * their own surface.
 */
import { Mic, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { tap } from '@/lib/haptics';

type Props = {
  onTranscript: (text: string) => void;
  onError?: (err: Error) => void;
  /** Transcribe target. Defaults to `/api/transcribe`. */
  transcribeUrl?: string;
  /** Form field name. Defaults to `audio`. */
  fieldName?: string;
  /** Additional classes on the button. */
  className?: string;
  disabled?: boolean;
};

type State = 'idle' | 'recording' | 'transcribing';

type Notice = {
  kind: 'denied' | 'unsupported' | 'ready' | 'error';
  text: string;
};

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/** localStorage key: '1' once getUserMedia has succeeded at least once. */
export const MIC_GRANTED_KEY = 'app.mic.granted';

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

/** Best-effort Permissions API query — Safari supports 'microphone' from
 *  16.4 but throws on older engines; treat any failure as 'unknown'. */
async function queryMicPermission(): Promise<
  'granted' | 'denied' | 'prompt' | 'unknown'
> {
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state;
  } catch {
    return 'unknown';
  }
}

function isStandalonePwa(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
        // iOS legacy flag for home-screen web apps
        (navigator as unknown as { standalone?: boolean }).standalone === true)
    );
  } catch {
    return false;
  }
}

/** Actionable copy for the no-prompt deny case. Exported for tests. */
export function deniedCopy(): string {
  if (isStandalonePwa()) {
    return (
      'Mic blocked. This is the Home-Screen app: open iPhone Settings, ' +
      'scroll to this app, then Microphone → Allow, and relaunch. ' +
      'iOS will not re-ask once denied.'
    );
  }
  return (
    'Mic blocked. iPhone: Settings → Apps → Safari → Microphone → Allow ' +
    '(or tap the AA / page icon in the address bar → Website Settings → ' +
    'Microphone → Allow), then reload. In the Telegram in-app browser? ' +
    'Open this page in Safari instead — iOS will not re-ask once denied.'
  );
}

/** Has getUserMedia ever succeeded here? (window.localStorage — the bare
 *  `localStorage` global is shadowed by Node's experimental stub in tests.) */
function hasPriorGrant(): boolean {
  try {
    return window.localStorage.getItem(MIC_GRANTED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberGrant(): void {
  try {
    window.localStorage.setItem(MIC_GRANTED_KEY, '1');
  } catch {
    /* private mode — non-fatal */
  }
}

/** Copy for browsers with no mediaDevices at all (in-app webviews). */
export function unsupportedCopy(): string {
  return (
    'This browser cannot use the mic (no media support — common in ' +
    'in-app browsers like Telegram). Tap the share / ··· menu and ' +
    '"Open in Safari", then try again.'
  );
}

export default function VoiceRecorder({
  onTranscript,
  onError,
  transcribeUrl = '/api/transcribe',
  fieldName = 'audio',
  className,
  disabled,
}: Props) {
  const [state, setState] = useState<State>('idle');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [mounted, setMounted] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);
  /** True while the permission query + getUserMedia are in flight. */
  const pendingRef = useRef(false);
  /** Set when pointerup/cancel/leave fires while the request is pending. */
  const releasedWhilePendingRef = useRef(false);
  const readyHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setMounted(true), []);

  const cleanup = useCallback(() => {
    const s = streamRef.current;
    if (s) s.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  // Clean up on unmount — don't leave the mic hot.
  useEffect(
    () => () => {
      cleanup();
      if (readyHintTimerRef.current) clearTimeout(readyHintTimerRef.current);
    },
    [cleanup]
  );

  const fail = useCallback(
    (err: Error, kind: Notice['kind'] = 'error') => {
      setNotice({ kind, text: err.message || 'Mic error' });
      setState('idle');
      cleanup();
      if (onError) onError(err);
      else console.error('[VoiceRecorder]', err);
    },
    [cleanup, onError]
  );

  const showReadyHint = useCallback(() => {
    setNotice({ kind: 'ready', text: 'Mic ready — hold to record' });
    if (readyHintTimerRef.current) clearTimeout(readyHintTimerRef.current);
    readyHintTimerRef.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const start = useCallback(async () => {
    if (state !== 'idle' || disabled || pendingRef.current) return;
    setNotice(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      // In-app webviews (Telegram, SFSafariViewController without
      // entitlements) ship no mediaDevices at all — say exactly that.
      fail(new Error(unsupportedCopy()), 'unsupported');
      return;
    }

    pendingRef.current = true;
    releasedWhilePendingRef.current = false;
    try {
      const perm = await queryMicPermission();
      const grantedBefore =
        perm === 'granted' || (perm === 'unknown' && hasPriorGrant());

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          // iOS rejects INSTANTLY with no prompt when previously denied —
          // the only fix is the Settings path, so say it prominently.
          fail(new Error(deniedCopy()), 'denied');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          fail(new Error('No microphone found on this device.'));
        } else {
          fail(new Error('Could not start mic. Reload and try again.'));
        }
        return;
      }

      rememberGrant();

      if (!grantedBefore) {
        // FIRST-USE / PERMISSION-REQUEST PRESS: the permission sheet ate the
        // gesture. Don't pretend we recorded through it — release the mic
        // and tell the user it's armed now.
        stream.getTracks().forEach((t) => t.stop());
        setState('idle');
        showReadyHint();
        return;
      }

      if (releasedWhilePendingRef.current) {
        // RACE GUARD: finger already lifted while getUserMedia was pending.
        // Never leave the mic hot.
        stream.getTracks().forEach((t) => t.stop());
        setState('idle');
        return;
      }

      streamRef.current = stream;
      const mimeType = pickMime();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => fail(new Error('Recorder error'));
      recorder.start();
      startedAtRef.current = Date.now();
      setState('recording');
      tap();
    } finally {
      pendingRef.current = false;
    }
  }, [disabled, fail, showReadyHint, state]);

  const stopAndTranscribe = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || state !== 'recording') {
      cleanup();
      setState('idle');
      return;
    }
    setState('transcribing');
    const duration_ms = Date.now() - startedAtRef.current;

    // Wait for the final chunk.
    const blob: Blob = await new Promise((resolve) => {
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        resolve(new Blob(chunksRef.current, { type }));
      };
      try {
        rec.stop();
      } catch {
        resolve(new Blob(chunksRef.current, { type: 'audio/webm' }));
      }
    });
    cleanup();

    // Tiny recordings (<200ms) are almost always accidental — skip.
    if (duration_ms < 200 || blob.size < 256) {
      setState('idle');
      return;
    }

    const ext =
      blob.type.includes('mp4') ? 'mp4'
      : blob.type.includes('ogg') ? 'ogg'
      : 'webm';
    const filename = `voice-${Date.now()}.${ext}`;
    const fd = new FormData();
    fd.append(fieldName, blob, filename);

    try {
      const res = await fetch(transcribeUrl, { method: 'POST', body: fd });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Transcribe failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
      const json = (await res.json()) as { text?: string; error?: string };
      if (json.error) throw new Error(json.error);
      const text = (json.text || '').trim();
      if (!text) throw new Error('Transcription returned empty text');
      onTranscript(text);
      setState('idle');
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  }, [cleanup, fieldName, onTranscript, state, transcribeUrl, fail]);

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch {}
    }
    cleanup();
    setState('idle');
  }, [cleanup]);

  /** If getUserMedia is still in flight, record the release so `start`
   *  drops the stream when it resolves. Returns true if consumed. */
  const consumeIfPending = useCallback(() => {
    if (pendingRef.current) {
      releasedWhilePendingRef.current = true;
      return true;
    }
    return false;
  }, []);

  const banner =
    notice && mounted
      ? createPortal(
          <div
            role="alert"
            data-testid="mic-notice-banner"
            data-kind={notice.kind}
            className={cn(
              'fixed left-3 right-3 bottom-24 z-[100] mx-auto max-w-md',
              'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm leading-snug shadow-lg backdrop-blur',
              notice.kind === 'ready'
                ? 'border-emerald-500/50 bg-emerald-950/90 text-emerald-200'
                : 'border-red-500/60 bg-red-950/90 text-red-100'
            )}
          >
            <span className="flex-1">{notice.text}</span>
            <button
              type="button"
              aria-label="Dismiss mic notice"
              onClick={() => setNotice(null)}
              className="shrink-0 -mr-1 -mt-0.5 rounded p-1 opacity-70 hover:opacity-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>,
          document.body
        )
      : null;

  return (
    // CAT-09 (2026-06-12): the sizing className (e.g. `w-11 h-11 md:w-8 md:h-8
    // shrink-0` from CleanComposer) now lands on THIS wrapper — it's the real
    // flex child of the composer's `flex items-end gap-2` row, so `shrink-0`
    // must be here or the mic gets squeezed. The inner button fills the wrapper
    // (`w-full h-full`) instead of carrying a competing hardcoded `w-12 h-12`,
    // which Tailwind could resolve over the prop's `w-11`/`w-8` by stylesheet
    // order — making the mic a different size than the 44/32px attach + send
    // buttons and breaking the row's items-end alignment.
    <div className={cn('inline-flex flex-col items-center', className)}>
      <button
        type="button"
        disabled={disabled || state === 'transcribing'}
        aria-label={
          state === 'recording'
            ? 'Recording — release to transcribe'
            : state === 'transcribing'
            ? 'Transcribing…'
            : 'Hold to record'
        }
        aria-pressed={state === 'recording'}
        onPointerDown={(e) => {
          e.preventDefault();
          start();
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          if (consumeIfPending()) return;
          stopAndTranscribe();
        }}
        onPointerLeave={() => {
          if (consumeIfPending()) return;
          if (state === 'recording') cancel();
        }}
        onPointerCancel={() => {
          if (consumeIfPending()) return;
          if (state === 'recording') cancel();
        }}
        className={cn(
          // CAT-09: fill the wrapper (which now carries the size + shrink-0)
          // instead of a hardcoded w-12 h-12 that fought the prop's w-11/w-8.
          'inline-flex items-center justify-center w-full h-full rounded-full transition-colors select-none',
          'border border-border-glass bg-surface/60 text-text-primary',
          state === 'recording' && 'bg-red-500/20 border-red-500/60 text-red-400',
          state === 'transcribing' && 'opacity-60'
        )}
        style={{ touchAction: 'none' }}
      >
        {state === 'transcribing' ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <Mic className="w-5 h-5" />
        )}
      </button>
      {banner}
    </div>
  );
}
