// ═══════════════════════════════════════════════════════════════════════════
// VoiceRecorder.test.tsx — mobile mic-permission hardening (fix/mobile-mic-
// permission, 2026-06-11).
//
// JD on prod mobile: "When I click mic access on mobile it doesn't ask me to
// allow mic access." Three silent-failure root causes, each pinned here:
//
//   1. iOS rejects getUserMedia INSTANTLY with NotAllowedError (no prompt)
//      when the site was previously denied — the old 10px mono error text was
//      invisible on a phone. → prominent banner with the iOS Settings path.
//   2. In-app browsers (Telegram) ship no navigator.mediaDevices at all.
//      → explicit "open in Safari" banner.
//   3. Gesture race: releasing while getUserMedia is pending used to leave
//      recorder.start() running with no finger down → hot mic, stuck state.
//      → releasedWhilePending guard stops tracks the moment the promise
//      resolves.
//   4. First-use: the permission sheet eats the press gesture, so the press
//      is treated as a permission request → "Mic ready — hold to record".
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('@/lib/haptics', () => ({ tap: vi.fn() }));

import VoiceRecorder, {
  MIC_GRANTED_KEY,
  deniedCopy,
  unsupportedCopy,
} from '../VoiceRecorder';

// ── Test doubles ────────────────────────────────────────────────────────────

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported() {
    return true;
  }
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: FakeStream) {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setMediaDevices(getUserMedia: (() => Promise<unknown>) | null) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: getUserMedia ? { getUserMedia } : undefined,
  });
}

function setPermissionState(state: 'granted' | 'denied' | 'prompt' | 'throw') {
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: {
      query:
        state === 'throw'
          ? vi.fn().mockRejectedValue(new TypeError('unsupported'))
          : vi.fn().mockResolvedValue({ state }),
    },
  });
}

// vitest's jsdom env ships window.localStorage as an own-but-undefined prop
// (Node 22's experimental webstorage shadowing). Back it with a Map.
function stubLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage,
  });
}

const micButton = () => screen.getByRole('button', { name: /hold to record|recording/i });
const banner = () => screen.queryByTestId('mic-notice-banner');

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  FakeMediaRecorder.instances = [];
  stubLocalStorage();
  setPermissionState('throw'); // default: Permissions API unavailable
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 1. Unsupported (in-app webview, no mediaDevices) ───────────────────────

describe('unsupported browser (no mediaDevices)', () => {
  it('shows a prominent unsupported banner and fires onError', async () => {
    setMediaDevices(null);
    const onError = vi.fn();
    render(<VoiceRecorder onTranscript={vi.fn()} onError={onError} />);

    fireEvent.pointerDown(micButton());

    await waitFor(() => expect(banner()).toBeTruthy());
    expect(banner()!.dataset.kind).toBe('unsupported');
    expect(banner()!.textContent).toContain('Open in Safari');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: unsupportedCopy() }));
  });
});

// ── 2. Denied (iOS instant NotAllowedError, no prompt) ─────────────────────

describe('permission denied', () => {
  it('shows the actionable Settings-path banner on NotAllowedError', async () => {
    const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    setMediaDevices(() => Promise.reject(err));
    const onError = vi.fn();
    render(<VoiceRecorder onTranscript={vi.fn()} onError={onError} />);

    fireEvent.pointerDown(micButton());

    await waitFor(() => expect(banner()).toBeTruthy());
    expect(banner()!.dataset.kind).toBe('denied');
    expect(banner()!.textContent).toContain('Settings');
    expect(banner()!.textContent).toContain('Microphone');
    expect(onError).toHaveBeenCalled();
    // Button is back to idle and usable.
    expect(micButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('banner is dismissable', async () => {
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    setMediaDevices(() => Promise.reject(err));
    render(<VoiceRecorder onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(micButton());
    await waitFor(() => expect(banner()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /dismiss mic notice/i }));
    expect(banner()).toBeNull();
  });

  it('deniedCopy tailors to standalone PWA', () => {
    const base = deniedCopy();
    expect(base).toContain('Safari');

    const mm = vi
      .spyOn(window, 'matchMedia')
      .mockReturnValue({ matches: true } as MediaQueryList);
    expect(deniedCopy()).toContain('Home-Screen app');
    mm.mockRestore();
  });
});

// ── 3. First-use permission-request press ──────────────────────────────────

describe('first-use press (permission state = prompt)', () => {
  it('acquires + releases the stream and shows the "mic ready" hint instead of recording', async () => {
    setPermissionState('prompt');
    const stream = new FakeStream();
    setMediaDevices(() => Promise.resolve(stream));
    render(<VoiceRecorder onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(micButton());

    await waitFor(() => expect(banner()).toBeTruthy());
    expect(banner()!.dataset.kind).toBe('ready');
    expect(banner()!.textContent).toContain('hold to record');
    // Stream released — mic NOT hot, no recording started.
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(micButton().getAttribute('aria-pressed')).toBe('false');
    // Grant persisted for the localStorage fallback path.
    expect(window.localStorage.getItem(MIC_GRANTED_KEY)).toBe('1');
  });

  it('treats unknown permission state with no prior grant as first-use', async () => {
    setPermissionState('throw'); // Permissions API unavailable (older Safari)
    const stream = new FakeStream();
    setMediaDevices(() => Promise.resolve(stream));
    render(<VoiceRecorder onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(micButton());

    await waitFor(() => expect(banner()).toBeTruthy());
    expect(banner()!.dataset.kind).toBe('ready');
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });
});

// ── 4. Race guard: release while getUserMedia pending ──────────────────────

describe('release while getUserMedia is pending', () => {
  it('stops tracks when the promise resolves and never enters recording', async () => {
    setPermissionState('granted');
    const d = deferred<FakeStream>();
    const stream = new FakeStream();
    setMediaDevices(() => d.promise as Promise<unknown>);
    render(<VoiceRecorder onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(micButton());
    // Finger lifts while getUserMedia is still in flight.
    fireEvent.pointerUp(micButton());

    await act(async () => {
      d.resolve(stream);
      await d.promise;
    });

    await waitFor(() => expect(stream.tracks.every((t) => t.stopped)).toBe(true));
    // Never entered recording — no hot mic, no stuck state.
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(micButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('pointercancel during pending also arms the guard', async () => {
    setPermissionState('granted');
    const d = deferred<FakeStream>();
    const stream = new FakeStream();
    setMediaDevices(() => d.promise as Promise<unknown>);
    render(<VoiceRecorder onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(micButton());
    fireEvent.pointerCancel(micButton());

    await act(async () => {
      d.resolve(stream);
      await d.promise;
    });

    await waitFor(() => expect(stream.tracks.every((t) => t.stopped)).toBe(true));
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });
});

// ── 5. Normal hold-to-record (permission already granted) ──────────────────

describe('already granted (desktop / repeat use)', () => {
  it('starts recording on pointerdown when permissions reports granted', async () => {
    setPermissionState('granted');
    setMediaDevices(() => Promise.resolve(new FakeStream()));
    render(<VoiceRecorder onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(micButton());

    await waitFor(() =>
      expect(micButton().getAttribute('aria-pressed')).toBe('true')
    );
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(banner()).toBeNull();
  });

  it('starts recording when Permissions API is unavailable but localStorage records a prior grant', async () => {
    setPermissionState('throw');
    window.localStorage.setItem(MIC_GRANTED_KEY, '1');
    setMediaDevices(() => Promise.resolve(new FakeStream()));
    render(<VoiceRecorder onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(micButton());

    await waitFor(() =>
      expect(micButton().getAttribute('aria-pressed')).toBe('true')
    );
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });
});

// ── CAT-09 — size + shrink-0 must land on the flex-child WRAPPER, and the
//    inner button must FILL it (w-full h-full) instead of a hardcoded w-12 h-12
//    that fought the prop and made the mic a different size than the row's
//    attach/send buttons (the `cn()` here is a plain join, NOT tailwind-merge,
//    so both widths would otherwise survive and resolve by stylesheet order). ──
describe('VoiceRecorder — composer-row sizing (CAT-09)', () => {
  it('applies the size + shrink-0 className to the flex-child wrapper, not the button', () => {
    const { getByRole } = render(
      <VoiceRecorder
        onTranscript={vi.fn()}
        onError={vi.fn()}
        className="w-11 h-11 md:w-8 md:h-8 shrink-0"
      />
    );
    const button = getByRole('button', { name: /hold to record/i });
    const wrapper = button.parentElement as HTMLElement;
    // The wrapper IS the flex child the composer row lays out — it must carry
    // the size + shrink-0 so the mic can't be squeezed/mis-sized.
    expect(wrapper.className).toContain('shrink-0');
    expect(wrapper.className).toContain('w-11');
    expect(wrapper.className).toContain('md:w-8');
  });

  it('the inner button fills the wrapper (w-full h-full) and drops the hardcoded w-12', () => {
    const { getByRole } = render(
      <VoiceRecorder
        onTranscript={vi.fn()}
        onError={vi.fn()}
        className="w-11 h-11 shrink-0"
      />
    );
    const button = getByRole('button', { name: /hold to record/i });
    expect(button.className).toContain('w-full');
    expect(button.className).toContain('h-full');
    // The old hardcoded fixed size is gone (it competed with the prop's w-11).
    expect(button.className).not.toContain('w-12');
    expect(button.className).not.toContain('h-12');
  });
});
