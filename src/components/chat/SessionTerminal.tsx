'use client';

// ═══════════════════════════════════════════════════════════════════════════
// SessionTerminal — live Claude Code session UI
//
// State machine (P0.6 cockpit-multi-session-v2, 2026-05-23): the pane's
// transport status now lives in an explicit reducer at src/lib/sse-state.ts:
//
//   INITIAL → SYNCING → LIVE → RECONNECT → ENDED | ERROR
//
// Before P0.6: ad-hoc bits — "thinking · 8s", "reconnecting to live stream",
// a green dot, a sync badge — with no explicit state. JD complaint: "I can't
// tell 'the agent is working' from 'the SSE is broken' from 'the session
// ended.'" Now there's ONE badge in the top-right pane header that maps 1:1
// to a state-machine state. Same pattern tmux + zellij use for session
// status — one indicator, deterministic transitions, no second source of truth.
//
// Transport (P0.4 cockpit-multi-session-v2, 2026-05-23): switched from
// EventSource (GET-only, buffered by cloudflared per issue #1449) to
// fetch()+ReadableStream POST against the bridge. POST response bodies
// are not buffered by cloudflared, so tokens arrive in real-time through
// app.example.com instead of dumping at session-end.
//
// Transport selection is runtime-controlled via `BRIDGE_STREAM_METHOD`
// (default `post`). Set `NEXT_PUBLIC_BRIDGE_STREAM_METHOD=get` in the env
// to revert to the legacy EventSource path — 30-second escape hatch if
// POST breaks anywhere downstream.
//
// Mental model (chat-resume-fix, 2026-05-22, JD ask):
//
//   The bridge runs an in-memory PTY per session. Its SSE /stream is
//   live-only — it does NOT replay anything emitted before the consumer
//   subscribed. The on-disk log file at <state-root>/logs/<sid>.log,
//   however, has the full transcript. So:
//
//     SSE        = "tap the firehose right now"
//     /history   = "the durable record" (full transcript, byte-addressable)
//
//   On mount: tail-fetch ~50KB of /history (→ HISTORY_LOADED → SYNCING),
//   then open the live POST stream. First frame transitions SYNCING → LIVE.
//   SSE drop → SSE_CLOSED → RECONNECT. Successful retry → SSE_RECONNECTED →
//   LIVE. Session exit → SESSION_ENDED → ENDED. Hard connect failure (8
//   retries) → BRIDGE_ERROR → ERROR (with reload button).
//
//   Visibility/focus return is a SILENT sub-flow of LIVE — it pulls the
//   /history catchup via the byte cursor but doesn't drop the state back
//   to SYNCING, because the SSE stream is still live (or being reconnected
//   via the RECONNECT path). The badge stays green throughout.
//
//   Auth + transport: /history is Vercel-proxied (NextAuth cookie →
//   bridge JWT server-side) because cloudflared QUIC was 503'ing one-shot
//   blobs under load (NC v5 audit bugs #6+#7). SSE stays browser-direct
//   because Vercel Hobby's 10s function timeout would sever it.
//
// Input box at bottom → POST /api/sessions/<sid>/input.
// Kill button → DELETE /api/sessions/<sid>.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Send, Square, Loader2, Plug, PlugZap, AlertCircle, CheckCircle2, Check, CheckCheck, RefreshCcw, DollarSign, Paperclip, ArrowUp, ArrowDown, CornerDownLeft, X as XIcon } from 'lucide-react';
import { detectTuiMenu, keystrokesForOption } from '@/lib/tui-menu';
import { streamIsDead } from '@/lib/sessionResume';
import { makeSeqDeduper, type SeqDeduper } from '@/lib/seqDedup';
import {
  badgeForState,
  useSseState,
  type SseState,
} from '@/lib/sse-state';
// M2 (Cockpit/Chat V3, 2026-05-27): the pane composer reuses the SAME
// VoiceRecorder the thread chat (Composer.tsx) uses — record → /api/transcribe
// → insert transcript into the pane input (JD reviews + sends, no auto-send).
// File attach (📎) is a sibling affordance that uploads via the new
// /api/sessions/[sid]/upload route and injects the resulting absolute
// disk_path into the input so it reaches the live agent's PTY stdin.
import VoiceRecorder from './VoiceRecorder';
// xterm.js (fix/cockpit-xterm-render, 2026-05-25): the cockpit chat pane used
// to dump the raw PTY byte stream into a <pre>, so the Claude Code TUI's ANSI
// escape codes (\x1b[38;5;211m, cursor moves, etc.) rendered as literal
// garbage — "shits hella broken" (JD). The fix: feed the PTY stream into a
// real terminal emulator (xterm) which interprets the ANSI into a clean view.
//
// IMPORTANT — SSR safety: xterm's `Terminal` constructor touches `document`,
// so it MUST NOT be instantiated at module top-level (Next.js renders this on
// the server first). We `import type` for the type-only refs and `await
// import()` the real classes inside a useEffect (browser-only). The CSS is a
// plain side-effect import — safe in any environment, bundled by Next.
import type { Terminal as XTerminal } from '@xterm/xterm';
import type { FitAddon as XFitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Clickable links (feat/v3-pane-clickable-links, 2026-05-27, JD ask msg 8120):
// "I sometimes want it to drop clickable links and stuff to review like how
// telegram does it." Agents print URLs and file paths as plain text in the
// pane; we add click affordance ON TOP of xterm without reskinning the pane.
//
// Two link providers attached at terminal init:
//   1. WebLinksAddon (official) — matches http/https URLs. Click → window.open
//      in a new tab (Telegram-style). Shift-click → same (kept symmetric so a
//      modifier doesn't accidentally do nothing).
//   2. Custom path matcher via registerLinkProvider — matches absolute Unix
//      paths (/Users/..., /tmp/..., /opt/...) and ~/ paths. Plain click →
//      copy-to-clipboard + transient toast. (`file://` is blocked by Chrome
//      for security on non-file: pages, so a click "opens nothing" if we
//      window.open it — copy-to-clipboard is the actually-useful default.)
//
// Both are dynamically imported inside the term-init useEffect to keep the
// SSR-safety contract above intact.

interface SessionTerminalProps {
  sessionId: string;
  /** 'live' | 'exited' | 'starting' from the DB */
  initialStatus: string;
  projectSlug?: string | null;
  /** cockpit-multi-session-v2 P1.4 — Supabase chat_sessions.thread_id of
   *  this session. Needed by the "Spawn new with same prompt" button so
   *  the new session attaches to the SAME thread (and therefore the same
   *  message history + UI route). Optional because some callers (e.g.
   *  ad-hoc preview panes) don't have a backing thread; the spawn-new
   *  button is hidden when this is absent.
   */
  threadId?: string | null;
  /** Fired whenever the terminal's authoritative status changes. The parent
   *  uses this to keep its own header / pane chrome in sync without running
   *  a polling fetch (the SSE stream is the single source of truth). */
  onStatusChange?: (status: string) => void;
  /** cockpit overhaul (2026-05-26) — fired when a dead session is resumed
   *  into a NEW bridge sid (via the /input 404-fallback). The cockpit grid
   *  passes this so it can swap THIS pane's sid in place (React state +
   *  router.replace) instead of a full window reload — keeping every other
   *  pane mounted and streaming. When absent (e.g. the standalone
   *  /projects/.../sessions/[sid] route) the component falls back to the
   *  legacy full-reload swap. */
  onResumed?: (oldSid: string, newSid: string) => void;
  /** v3 pane-readability (2026-05-27) — xterm font size in px. ChatGrid
   *  passes a smaller value when many panes are open so dense terminal text
   *  fits readably without horizontal wrapping. Optional; default 12.
   *  Floor at 10 — anything smaller is unreadable on retina at the cockpit's
   *  typical pane sizes. */
  fontSize?: number;
}

interface StreamMeta {
  stream_url: string;
  token: string;
  expires_in: number;
  status: string;
  /** New in P0.4 (stream-post metadata route). Absent on legacy stream route. */
  method?: 'POST' | 'GET';
}

// Runtime transport selector. `post` is the cloudflared GET-buffer bypass
// shipped in P0.4 (default + recommended path); `get` keeps the legacy
// EventSource transport for local dev or rollback. Read once at module
// load so the value is stable across re-renders.
//
// To revert: set NEXT_PUBLIC_BRIDGE_STREAM_METHOD=get and redeploy. The
// runtime-flag escape hatch was JD's requirement so we can pivot in 30s
// if POST regresses anywhere in the chain (Vercel proxy, cloudflared
// edge, bridge route, browser).
const BRIDGE_STREAM_METHOD: 'post' | 'get' =
  (process.env.NEXT_PUBLIC_BRIDGE_STREAM_METHOD as 'post' | 'get' | undefined) ===
  'get'
    ? 'get'
    : 'post';

// Max reconnect attempts before we fall to ERROR. Existing backoff schedule
// (1s, 2s, 4s, 8s, 8s, 8s, 15s, 15s) totals ~60s of retry-window. After
// that we surface the reload button so the user has explicit recourse.
const MAX_RECONNECT_ATTEMPTS = 8;

export default function SessionTerminal({
  sessionId,
  initialStatus,
  projectSlug,
  threadId,
  onStatusChange,
  onResumed,
  fontSize,
}: SessionTerminalProps) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(initialStatus);

  // ── Explicit state machine (P0.6) ──
  // Single source of truth for the badge. Every event source (history fetch,
  // SSE open/close, exit event, error) dispatches into this reducer. The
  // badge is a pure render of the state. No conn / syncState ad-hoc bools
  // anymore.
  const { state: sseState, send: dispatch } = useSseState();

  // If the session was already exited at mount, seed the state machine
  // directly into ENDED so we don't briefly render INITIAL/spinner.
  const initialStatusRef = useRef(initialStatus);
  useEffect(() => {
    if (initialStatusRef.current === 'exited') {
      dispatch({ type: 'SESSION_ENDED' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bubble status up to the parent (ChatGridPane uses this to render the
  // header dot/text without polling /api/sessions/<sid> separately). Fires
  // on initial mount with `initialStatus`, then on every transition.
  //
  // statusRef mirrors `status` so callbacks with intentionally-minimal dep
  // arrays (seedHistoryTail — see the V3 M3 no-echo fix) can read the LATEST
  // status without taking a `status` dep that would churn the connect/mount
  // effect chain. Updated in the same effect that bubbles status up.
  // ── exitedRef — the authoritative "this sid is permanently dead, NEVER
  // reconnect" latch (fix/cockpit-resume-after-rotation, 2026-05-27).
  //
  // ROOT CAUSE of the flaky rotation→resume + the "(session exited)" STACK:
  // the connect/reconnect guards read the `status` STATE captured in their
  // closure, not the live value. When the PTY is killed (rotation), the bridge
  // delivers an `exit` SSE frame. Whether that frame arrives BEFORE the
  // teardown abort or AFTER is a race — and on the "frame wins" branch the
  // post-stream guard `if (status !== 'exited')` reads the STALE closure value
  // (still 'live' from when connectViaPost was created), so it schedules a
  // reconnect against a dead sid. The reconnect re-subscribes to a session the
  // bridge still has in its 10-min reap window → bridge immediately yields
  // another `exit` frame → we append "[session exited]" AGAIN and reconnect
  // AGAIN — the visible STACK. That retry storm also churns the pane and
  // starves the user's typed message (the transparent-resume /input call),
  // which is why the resume sometimes never fires.
  //
  // A ref read at guard-time is always current (no stale closure) and, once
  // latched true, is monotonic: a killed/exited session is never live again
  // under the SAME sid (a resume gets a NEW sid + a freshly-mounted component,
  // which resets this to false via the initial useRef). Set it from EVERY path
  // that learns the session died: the exit/crashed SSE frames, the kill button,
  // the initial-status seed, and the status effect below.
  const exitedRef = useRef(initialStatus === 'exited');

  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
    if (status === 'exited') exitedRef.current = true;
    onStatusChange?.(status);
  }, [status, onStatusChange]);
  const [input, setInput] = useState<string>('');
  const [sending, setSending] = useState(false);
  // Telegram-style receipts (feat/read-receipts, JD 2026-06-11 — upgrades the
  // 2026-06-02 "Seen by agent" flash into the full progression):
  //   'delivered' (✓)  — the /input POST succeeded AND (new bridge) the
  //                      verified-submit confirmed the turn entered claude's
  //                      composer and submitted (payload.submitted === true).
  //                      Old bridge (field absent) degrades to the previous
  //                      2xx-means-seen behavior.
  //   'read' (✓✓)      — the agent's PTY emitted output AFTER delivery (the
  //                      TUI echoes the submitted turn / starts working) — the
  //                      session has provably consumed the message.
  // Cleared the instant a new send starts. 'delivered' lingers until read (or
  // 20s safety); 'read' fades after 6s — the thinking pill takes over.
  const [receipt, setReceipt] = useState<null | 'delivered' | 'read'>(null);
  // Armed at 'delivered'; the first output chunk afterwards flips to 'read'.
  const awaitingReadRef = useRef(false);
  // Thinking indicator (JD 2026-06-02 "I'd like to see some thinking stuff at
  // the bottom like Claude Code does, to show we are live and thinking too").
  // Driven by the output stream: every chunk through appendChunk marks the
  // agent ACTIVE; a debounce timer clears it after a quiet gap. `thinkingSince`
  // powers a Claude-Code-style elapsed-seconds readout. Refs avoid re-render
  // churn — we flip React state only on the active↔idle transition, not per
  // chunk.
  const [thinking, setThinking] = useState(false);
  const [thinkingSince, setThinkingSince] = useState<number | null>(null);
  const thinkingActiveRef = useRef(false);
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [killing, setKilling] = useState(false);
  // ── Interactive-menu controls (fix/cockpit-interactive-prompts, 2026-06-01)
  // `menu` is the detected TUI selection menu (or null). When non-null the
  // composer renders tappable option buttons (part B). `keySending` debounces
  // rapid taps on the raw-key control row / option buttons so a double-tap
  // can't fire two keystrokes into the same menu row.
  const [menu, setMenu] = useState<import('@/lib/tui-menu').TuiMenu | null>(null);
  const [keySending, setKeySending] = useState(false);
  // M2 attach (📎) — uploading state + hidden file input ref. Reuses the same
  // 25MB / 5-file limits as the thread chat's Composer.
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const esRef = useRef<EventSource | null>(null);
  // POST transport (P0.4): AbortController severs the in-flight fetch when
  // we tear down. ReadableStream readers are released via the controller's
  // abort signal — no manual reader.cancel() needed.
  const postAbortRef = useRef<AbortController | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  // Last SSE event_id we successfully delivered to the buffer. On
  // reconnect we send this back as `Last-Event-ID` so the bridge replays
  // only the gap (P0.3 contract). Null = no events seen yet → cold-connect.
  const lastEventIdRef = useRef<string | null>(null);
  // Tracks whether the CURRENT live connection has yielded its first frame
  // yet. Resets on every connect attempt. Used to drive FIRST_LIVE_EVENT
  // dispatch (one per connection, not one per chunk).
  const sawFirstFrameRef = useRef(false);

  // ── Frame-SEQ dedup (CAT-15, 2026-06-12 — replaces the content+time ring) ──
  // The bridge stamps every output frame with a MONOTONIC `id:`/Last-Event-ID
  // seq (P0.3/P0.4 contract). The ONLY duplicate source on the wire is the
  // catchup/SSE overlap window after a reconnect — the bridge replays frames
  // we may have already rendered, and those replays carry seqs we've ALREADY
  // passed. So the correct dedup is "skip a frame whose seq we've already
  // delivered," keyed on that monotonic id — NOT the old content+time ring,
  // which dropped any chunk ≥4 chars that textually repeated within 3s (a
  // progress line the agent reprints, identical tool-result lines, an ANSI
  // repaint) and so SILENTLY CORRUPTED legit terminal output. This guard never
  // drops on content: a frame with a NEW (or non-numeric / absent) seq always
  // renders — fail-open, we never lose real bytes.
  const seqDeduperRef = useRef<SeqDeduper>(makeSeqDeduper());
  const shouldSkipSeq = useCallback(
    (rawId: string | null | undefined): boolean =>
      seqDeduperRef.current.shouldSkip(rawId),
    []
  );
  // Reset the seq high-water mark on a sid-swap so the NEW session's frames
  // (whose seqs restart) are never mistaken for already-delivered replays.
  useEffect(() => {
    seqDeduperRef.current.reset();
  }, [sessionId]);

  // ── xterm.js terminal (fix/cockpit-xterm-render) ─────────────────────────
  //
  // The terminal is instantiated lazily inside a useEffect (SSR-safe — see the
  // import note at the top of the file). Output sinks (appendChunk,
  // seedHistoryTail, catchupHistory) no longer accumulate into React state;
  // they call writeToTerm() which either writes directly to the live terminal
  // or, if the terminal hasn't mounted yet (the connect effect can fire its
  // first history/SSE write before the term-init effect runs), buffers into
  // pendingWritesRef. The init effect flushes the queue in order once the
  // terminal exists. This preserves the exact byte ordering of the PTY stream.
  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<XFitAddon | null>(null);
  const pendingWritesRef = useRef<string[]>([]);
  // Tracks whether anything has been written to the terminal yet — drives the
  // "Connecting…/Waiting for output…" empty-state overlay (replaces the old
  // `buffer || <hint>` check now that buffer state is gone).
  const [hasOutput, setHasOutput] = useState(false);

  // ── fix/cockpit-restore-not-boot-on-return (2026-05-30) ──────────────────
  // True once the initial /history tail-fetch returns NON-EMPTY bytes — i.e.
  // this session ALREADY HAS prior output on disk. That's the authoritative
  // "this is an established session, NOT a fresh cold-boot" signal, and it's
  // derived from the very fetch the pane already makes on every mount
  // (seedHistoryTail) — no extra bridge round-trip.
  //
  // ROOT CAUSE this fixes (JD screenshot, mobile cold-remount):
  // On a remount of a LIVE-but-quiet session, the boot overlay rendered
  // "Booting agent… first output in 20–30s" during the SYNCING window
  // (between HISTORY_LOADED and the stream opening). That window can be
  // seconds long on mobile/slow networks, and the wording is a LIE — the
  // agent already ran; we're RECONNECTING + RESTORING, not booting. The
  // 20–30s cold-boot copy must be RESERVED for genuinely-fresh spawns
  // (no prior history). When prior history exists, the overlay says
  // "Restoring session…" instead.
  const [hasPriorHistory, setHasPriorHistory] = useState(false);

  // True once the initial /history tail-fetch has RESOLVED (regardless of
  // whether it had bytes). Until then we genuinely DON'T KNOW whether this is a
  // fresh boot or a return to an established session, so it is dishonest to
  // claim "Booting agent… 20–30s" — that claim is committed ONLY after the
  // fetch confirms there is NO prior history. Before resolution the overlay
  // shows the neutral "Connecting…" copy.
  //
  // Why this is needed ON TOP of hasPriorHistory: the cold-boot bug window on a
  // real cold remount is the INITIAL + token-mint stretch BEFORE seedHistory-
  // Tail even runs — connectViaPost mints the stream-post token first (a Vercel-
  // proxied round trip of a second or two). hasPriorHistory is still false in
  // that stretch, so gating the cold-boot copy on hasPriorHistory ALONE still
  // flashed "Booting agent… 20–30s" there (caught by the prod smoke for PR #133).
  // Gating on `historyChecked` closes that earlier window honestly.
  const [historyChecked, setHistoryChecked] = useState(false);

  // Path-click toast (feat/v3-pane-clickable-links). Briefly surfaces "Path
  // copied: <path>" when JD clicks a path link. Auto-hides after 2s. Null =
  // hidden. The string IS the displayed text (already short — paths are
  // truncated to the last 48 chars in the toast for legibility).
  const [pathToast, setPathToast] = useState<string | null>(null);
  const pathToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPathToast = useCallback((msg: string) => {
    setPathToast(msg);
    if (pathToastTimerRef.current) clearTimeout(pathToastTimerRef.current);
    pathToastTimerRef.current = setTimeout(() => setPathToast(null), 2000);
  }, []);

  // Menu re-scan debounce (fix/cockpit-interactive-prompts). A menu repaint
  // arrives as a burst of small chunks; we coalesce and scan once it settles.
  const menuScanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scan the CURRENT xterm screen for a TUI selection menu and update state.
  // Reads the rendered buffer rows (viewport region) — the same clean text
  // JD sees — and runs the pure detector. Cheap; runs only on a settle tick.
  const scanForMenu = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;
    try {
      const buf = term.buffer.active;
      // Scan the visible viewport rows (the menu is always on screen when up).
      const rows = term.rows;
      const top = buf.viewportY;
      const lines: string[] = [];
      for (let y = 0; y < rows; y++) {
        const line = buf.getLine(top + y);
        lines.push(line ? line.translateToString(true) : '');
      }
      const detected = detectTuiMenu(lines);
      setMenu((prev) => {
        // Avoid churn: only update state when the menu's shape actually changed
        // (option count / labels / selected row), so taps don't re-render
        // needlessly while output streams.
        if (prev === null && detected === null) return prev;
        if (prev && detected) {
          const same =
            prev.selectedIndex === detected.selectedIndex &&
            prev.options.length === detected.options.length &&
            prev.options.every(
              (o, k) =>
                o.number === detected.options[k].number &&
                o.label === detected.options[k].label,
            );
          if (same) return prev;
        }
        return detected;
      });
    } catch {
      // Buffer access can throw mid-dispose; harmless — next tick retries.
    }
  }, []);

  const scheduleMenuScan = useCallback(() => {
    if (menuScanTimerRef.current) clearTimeout(menuScanTimerRef.current);
    // 120ms after the last write — long enough for a menu repaint burst to
    // finish, short enough that the buttons appear promptly.
    menuScanTimerRef.current = setTimeout(scanForMenu, 120);
  }, [scanForMenu]);

  const writeToTerm = useCallback((data: string) => {
    if (!data) return;
    if (!hasOutput) setHasOutput(true);
    const term = xtermRef.current;
    if (term) {
      term.write(data);
    } else {
      // Terminal not mounted yet — queue, flushed by the init effect.
      pendingWritesRef.current.push(data);
    }
    // Re-scan for an interactive menu after this write settles.
    scheduleMenuScan();
  }, [hasOutput, scheduleMenuScan]);

  // Thinking-indicator pulse: called on every output chunk. Flips React state
  // only on the idle→active edge (cheap), then (re)arms a debounce timer that
  // flips back to idle after THINKING_IDLE_MS of silence. Result: the "thinking"
  // pill shows while the agent is streaming and disappears ~1s after it stops.
  const THINKING_IDLE_MS = 1100;
  const markActivity = useCallback(() => {
    // feat/read-receipts: first PTY output AFTER a delivered send = the TUI is
    // repainting with the submitted turn (echo + spinner) — the agent has
    // consumed the message. Upgrade ✓ delivered → ✓✓ read.
    if (awaitingReadRef.current) {
      awaitingReadRef.current = false;
      setReceipt('read');
    }
    if (!thinkingActiveRef.current) {
      thinkingActiveRef.current = true;
      setThinking(true);
      setThinkingSince(Date.now());
    }
    if (thinkingTimerRef.current) clearTimeout(thinkingTimerRef.current);
    thinkingTimerRef.current = setTimeout(() => {
      thinkingActiveRef.current = false;
      setThinking(false);
      setThinkingSince(null);
    }, THINKING_IDLE_MS);
  }, []);

  const appendChunk = useCallback((chunk: string) => {
    if (!chunk) return;
    // Agent is producing output → pulse the thinking indicator.
    markActivity();
    // First frame in this connection → dispatch FIRST_LIVE_EVENT so the
    // state machine transitions SYNCING/RECONNECT/ERROR → LIVE. Idempotent
    // in LIVE itself (the reducer no-ops). Reset by every new connect.
    if (!sawFirstFrameRef.current) {
      sawFirstFrameRef.current = true;
      dispatch({ type: 'FIRST_LIVE_EVENT' });
    }
    // Try parsing as JSON first (some bridges wrap output); fall back to raw
    let text = chunk;
    try {
      const parsed = JSON.parse(chunk);
      if (typeof parsed === 'string') text = parsed;
      else if (typeof parsed?.text === 'string') text = parsed.text;
      else if (typeof parsed?.data === 'string') text = parsed.data;
      else if (typeof parsed?.content === 'string') text = parsed.content;
    } catch {
      // raw string — keep as-is
    }

    // CAT-15 (2026-06-12): the content+time dedup ring that used to live here
    // was REMOVED. It dropped any chunk ≥4 chars that textually repeated within
    // 3s — silently corrupting legitimately-repeated PTY output (reprinted
    // progress lines, identical tool-result lines, ANSI repaints). Duplicate
    // detection now happens at the FRAME-SEQ level (shouldSkipSeq, applied in
    // the SSE message paths that carry the monotonic id), so a textual repeat
    // with a fresh seq renders correctly and only true wire-replays are skipped.

    // Write the PTY bytes into the xterm terminal, which interprets the ANSI.
    // xterm owns its own scrollback (capped via the `scrollback` option), so
    // there's no manual 256KB buffer slice anymore.
    writeToTerm(text);
  }, [dispatch, writeToTerm, markActivity]);

  // Tick a re-render once a second while thinking, so the elapsed-seconds
  // readout updates. Cleared as soon as the agent goes idle.
  const [, _forceTick] = useState(0);
  useEffect(() => {
    if (!thinking) return;
    const id = setInterval(() => _forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [thinking]);

  // Clean up the debounce timer on unmount.
  useEffect(() => () => {
    if (thinkingTimerRef.current) clearTimeout(thinkingTimerRef.current);
  }, []);

  // ── SSE connection management ────────────────────────────────────────────

  const closeEventSource = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  // POST transport teardown — separate from the EventSource close because
  // the two transports have different lifetimes and we want to be able to
  // close one without touching the other (defensive against transport-
  // switch bugs during development).
  const closePostStream = useCallback(() => {
    if (postAbortRef.current) {
      try {
        postAbortRef.current.abort();
      } catch {
        // ignore — abort can throw on already-aborted controllers
      }
      postAbortRef.current = null;
    }
  }, []);

  // Single teardown the rest of the component calls — works for both
  // transports. Keeps `closeEventSource` callers untouched so the diff
  // to other code paths stays minimal.
  const closeStream = useCallback(() => {
    closeEventSource();
    closePostStream();
  }, [closeEventSource, closePostStream]);

  // Byte cursor into the bridge's on-disk session log. Updated from the
  // X-Session-Log-Total-Bytes response header on every /history fetch.
  // The catchup path sends `?start=<cursor>` so a re-sync on focus only
  // pulls what was appended since the last sync (instead of re-pasting
  // the trailing 50KB on every alt-tab return).
  // null = haven't done the initial tail-fetch yet.
  const logCursorRef = useRef<number | null>(null);
  // The one-time seed of the buffer from the log tail. Subsequent catchup
  // fetches are NOT guarded — they're the mechanism that delivers
  // "out of sight ≠ out of mind."
  const initialHistoryDoneRef = useRef(false);

  /**
   * One-time seed of the terminal buffer from the log tail. Records the
   * starting byte cursor so subsequent catchup fetches know where to
   * read from. Best-effort — network/404 failures fall through silently
   * and live SSE still opens.
   *
   * Dispatches HISTORY_LOADED on success so the state machine moves
   * INITIAL → SYNCING. The first SSE frame will then advance us to LIVE.
   */
  const seedHistoryTail = useCallback(
    async () => {
      if (initialHistoryDoneRef.current) return;
      initialHistoryDoneRef.current = true;
      try {
        const url = `/api/sessions/${encodeURIComponent(
          sessionId
        )}/history?bytes=51200`;
        const res = await fetch(url, { method: 'GET', cache: 'no-store' });
        if (!res.ok) {
          // 404 / network — leave cursor as null so the first catchup is
          // skipped until live SSE forces a seed retry. Graceful: live
          // stream still opens. We've now CHECKED history (it isn't there /
          // isn't reachable) so the overlay may commit to its non-restoring
          // wording. A 404 here means "no on-disk log" → treat as fresh.
          setHistoryChecked(true);
          return;
        }
        const text = await res.text();
        // Pick up the cursor for future catchup calls. Header is set by
        // the Vercel proxy (passing through from the bridge). Falls back
        // to byte length of returned text if header missing — better
        // than nothing, even though the byte counts may drift slightly
        // (the catchup path is forgiving).
        const totalHdr = res.headers.get('X-Session-Log-Total-Bytes');
        const cursor = totalHdr !== null ? Number(totalHdr) : NaN;
        logCursorRef.current = Number.isFinite(cursor)
          ? cursor
          : new TextEncoder().encode(text).length;
        // ── V3 M3 no-echo fix (2026-05-27): the duplicated-greeting bug ──
        //
        // The Claude Code session is a FULL-SCREEN TUI (alternate-screen-style
        // repainting app). Its on-disk .log is the raw PTY byte stream: full of
        // ABSOLUTE cursor moves (\x1b[12G), line erases (\x1b[K), scroll-region
        // sets (\x1b[r), cursor-up (\x1b[3A), and full screen REPAINTS. Such a
        // stream is only coherent when fed to a terminal whose screen state
        // matches the moment the bytes were emitted.
        //
        // /history returns the last ~50KB — a MID-STREAM SLICE. Replaying that
        // slice into a FRESH xterm (cursor at home, blank grid) makes every
        // repaint land as a NEW stacked line instead of overwriting in place.
        // The TUI redraws its banner/greeting/"Brewed for Ns" spinner many
        // times per second, so the slice contains those strings repeated — and
        // they render as visible duplicates. THEN the live SSE attaches and the
        // TUI repaints AGAIN below the divider. Net (JD's SS4): greeting twice,
        // "Brewed for 4s" twice. This is the root cause — NOT a double SSE
        // subscription or a missing dedup; the dedup ring never sees these
        // bytes (history bypasses appendChunk) and the repaints aren't
        // byte-identical anyway.
        //
        // Fix: for a LIVE/STARTING session, do NOT paint the stale mid-stream
        // history slice. The live stream IS the authoritative screen — the TUI
        // repaints its full screen on the next render tick, so the pane shows
        // the correct, single-copy UI. We still capture logCursorRef (above)
        // and dispatch HISTORY_LOADED (below) so the state machine + catchup
        // machinery are unaffected.
        //
        // For an EXITED session there is no live repaint coming, so the only
        // way to show the dead session's output is to replay the log. Keep the
        // transcript replay + divider for that case — a static dump of a dead
        // TUI screen is imperfect but it's the durable record (and it's not the
        // SS4 live-pane case this milestone targets).
        const sessionIsLive =
          initialStatusRef.current !== 'exited' && statusRef.current !== 'exited';

        // ── fix/cockpit-restore-not-boot-on-return (2026-05-30) ────────────
        // Record "this session has prior output on disk" the instant the tail
        // fetch returns bytes — for ANY status. This is the established-vs-
        // fresh discriminator that drives the overlay wording (no cold-boot
        // copy for an established session) and the live-restore branch below.
        // Captured BEFORE the paint decision so the overlay flips honest even
        // if we (deliberately) don't paint.
        const hasBytes = !!text && text.length > 0;
        if (hasBytes) setHasPriorHistory(true);
        // History fetch has now RESOLVED — the overlay may commit to its
        // fresh-vs-established wording. (hasBytes=false here = genuinely-fresh.)
        setHistoryChecked(true);

        // Which live sessions get a transcript restore on (re)mount?
        //
        // The V3 M3 no-echo fix above skips painting history for live sessions
        // because a FRESHLY-SPAWNING session is actively repainting its full
        // TUI screen, and replaying the mid-stream slice stacks those repaints
        // as duplicate greeting lines (JD's SS4). That reasoning ONLY holds
        // while the TUI is mid-boot-redraw — which is exactly a session with
        // little/no prior history.
        //
        // The JD cold-remount bug is the OPPOSITE case: an ESTABLISHED, quiet
        // session (agent already ran, sitting at a waiting prompt). No live
        // full-screen repaint is coming, so skipping the paint leaves the pane
        // BLANK behind a "Booting agent… 20–30s" overlay — misrepresenting a
        // live, established session as a cold boot and losing the transcript.
        //
        // Resolution: restore the transcript (replay slice + divider, same as
        // the exited path) when the session is LIVE *and has prior history*.
        // `hasBytes` is the discriminator — a genuinely-fresh actively-booting
        // spawn has no meaningful history tail to replay, so the SS4 no-echo
        // protection is preserved for it; an established session gets its
        // transcript back. Painting also flips `hasOutput` true via
        // writeToTerm, clearing the boot overlay immediately.
        const restoreLiveTranscript = hasBytes && sessionIsLive;

        if (text && (!sessionIsLive || restoreLiveTranscript)) {
          // Replay the transcript bytes (xterm interprets the ANSI), followed
          // by a dim separator. \r\n so the separator lands cleanly regardless
          // of the history tail's last byte.
          const separator =
            '\r\n\x1b[2m─── history above · live below ───\x1b[0m\r\n';
          writeToTerm(text + separator);
        }
        // History phase complete → state machine: INITIAL → SYNCING.
        // (No-op if we already advanced past INITIAL via a fast-path
        // FIRST_LIVE_EVENT.)
        dispatch({ type: 'HISTORY_LOADED' });
      } catch {
        // network failures: silently fall through to live stream. The history
        // check has still "resolved" (we tried + failed) — don't pin the
        // overlay in the indeterminate state forever on a flaky network.
        setHistoryChecked(true);
      }
    },
    [sessionId, dispatch, writeToTerm]
  );

  /**
   * Cursor-based catchup. Fetches /history?start=<cursor> to pull only
   * the bytes appended since the last sync, then advances the cursor.
   * Called on visibilitychange→visible, on window focus, and before
   * SSE reconnect to ensure no events are lost across disconnect windows.
   *
   * Idempotent and cheap when there's nothing new (200 with empty body).
   *
   * Does NOT dispatch state-machine events — visibility/focus catchup is
   * a silent sub-flow during LIVE. The badge stays green throughout. The
   * SSE drop/reconnect path (separate from this) drives the LIVE →
   * RECONNECT → LIVE badge transitions.
   */
  const catchupHistory = useCallback(
    async () => {
      // Need the initial seed first to know where to read from. If the
      // seed never landed, the next mount-path attempt will recover.
      if (logCursorRef.current === null) {
        if (!initialHistoryDoneRef.current) {
          // Try once to seed. If still null after this, give up for now.
          await seedHistoryTail();
          if (logCursorRef.current === null) return;
        } else {
          return;
        }
      }
      try {
        const cursor = logCursorRef.current;
        const url = `/api/sessions/${encodeURIComponent(
          sessionId
        )}/history?bytes=524288&start=${cursor}`;
        const res = await fetch(url, { method: 'GET', cache: 'no-store' });
        if (!res.ok) {
          // 404 = log gone (log rotation, session purged). Reset cursor
          // so future catchups don't infinite-loop on the same hole;
          // the next mount will re-seed from EOF.
          if (res.status === 404) {
            logCursorRef.current = null;
            initialHistoryDoneRef.current = false;
          }
          return;
        }
        const text = await res.text();
        const totalHdr = res.headers.get('X-Session-Log-Total-Bytes');
        const nextCursor = totalHdr !== null ? Number(totalHdr) : NaN;
        if (Number.isFinite(nextCursor)) {
          logCursorRef.current = nextCursor;
        } else {
          // Header missing — advance by best-effort byte count so we
          // don't re-fetch this slice on the next catchup.
          logCursorRef.current =
            (cursor as number) + new TextEncoder().encode(text).length;
        }
        if (text) {
          writeToTerm(text);
        }
      } catch {
        // Network blip — leave cursor where it was; next catchup retries.
      }
    },
    [sessionId, seedHistoryTail, writeToTerm]
  );

  // ── SSE frame dispatch (shared by GET + POST transports) ────────────────
  //
  // Both transports receive the same wire format: `event:`/`id:`/`data:`
  // frames separated by `\n\n`. The EventSource API parses this for us; the
  // POST + ReadableStream path has to parse manually. Both feed events into
  // this dispatch table so the UI behaviour is identical across transports.
  // Returns true if the frame indicated session exit (so the caller can
  // tear down the connection cleanly).
  const dispatchSseFrame = useCallback(
    (frame: { event?: string; id?: string; data?: string }): boolean => {
      // Track Last-Event-ID for resume. P0.3 + P0.4 contract: every frame
      // (data or event-named) the bridge emits carries `id: <event_id>`.
      if (frame.id) {
        lastEventIdRef.current = frame.id;
      }
      const ev = frame.event || 'message';
      const data = frame.data ?? '';
      if (ev === 'message' || ev === 'output' || ev === 'stdout' || ev === 'stderr') {
        // CAT-15: skip only TRUE wire-replays (a seq we've already delivered,
        // e.g. the catchup/SSE overlap after a reconnect). A fresh seq always
        // renders — repeated CONTENT with a new seq is real output, not a dup.
        if (!shouldSkipSeq(frame.id)) appendChunk(data);
        return false;
      }
      if (ev === 'status') {
        try {
          const d = JSON.parse(data);
          if (typeof d.status === 'string') setStatus(d.status);
        } catch {
          // ignore malformed status frame
        }
        return false;
      }
      if (ev === 'exit') {
        // Latch the dead-state SYNCHRONOUSLY (before consumePostStream returns
        // and its reconnect guard runs) — setStatus is async and would lose
        // the race, scheduling a reconnect into the dead sid. This is THE line
        // that kills the "(session exited)" stack at its source.
        exitedRef.current = true;
        setStatus('exited');
        dispatch({ type: 'SESSION_ENDED' });
        try {
          const d = JSON.parse(data);
          if (d?.message) appendChunk(`\n[session exited: ${d.message}]\n`);
          else appendChunk('\n[session exited]\n');
        } catch {
          appendChunk('\n[session exited]\n');
        }
        return true;
      }
      if (ev === 'crashed') {
        // cockpit-multi-session-v2 P1.4 — bridge crashed mid-session.
        // Frame arrives via /history catchup after a bridge restart
        // (crash_recovery.scan_and_mark_crashed appended the crashed
        // event to the JSONL log on bridge boot). Transitions the
        // state machine into ERROR with crashedAt set so the badge
        // renders the "agent crashed at <time>" + spawn-new variant.
        //
        // We deliberately do NOT return true here — we want to keep
        // the connection open so any further frames (if any) still
        // arrive. The session is in fact gone, but the SSE stream is
        // the only signal the client has, and shutting it down would
        // race with the bridge's own EOF/exit frame.
        exitedRef.current = true; // dead — no reconnect (see exitedRef docstring)
        setStatus('exited');
        // Pull ts from the frame's data payload if present; bridge writes
        // it as ISO8601 inside the base64'd payload. Fallback to "now".
        let crashedAtMs = Date.now();
        try {
          const d = JSON.parse(data);
          if (typeof d?.ts === 'string') {
            const parsed = Date.parse(d.ts);
            if (Number.isFinite(parsed)) crashedAtMs = parsed;
          } else if (typeof d?.text === 'string') {
            // bridge's _format_sse wraps the payload as `{text: "..."}`.
            // We don't have an embedded ts in there today; "now" is good
            // enough since the catchup arrives within a second of the
            // bridge starting.
          }
        } catch {
          // payload wasn't JSON — that's fine, use Date.now()
        }
        dispatch({ type: 'SESSION_CRASHED', crashedAt: crashedAtMs });
        appendChunk('\n[bridge crashed — session terminated]\n');
        return false;
      }
      if (ev === 'gap') {
        // Bridge's signal that the subscriber queue overflowed. The
        // visibility/focus catchup machinery handles the /history backfill;
        // here we just surface a faint marker so JD knows the stream
        // hiccupped.
        appendChunk('\n\x1b[2m─── stream gap (backfilling) ───\x1b[0m\n');
        return false;
      }
      if (ev === 'error') {
        // Bridge-side stream error. Don't tear down — the bridge keeps the
        // PTY alive and we want SSE to reconnect. State machine does NOT
        // transition to ERROR here — that's reserved for hard connect
        // failures. This is recoverable mid-stream noise.
        try {
          const d = JSON.parse(data);
          setError(`bridge stream error: ${d?.error || data}`);
        } catch {
          setError(`bridge stream error: ${data.slice(0, 200)}`);
        }
        return false;
      }
      // Unknown event — append the data so we don't silently lose output.
      appendChunk(data);
      return false;
    },
    [appendChunk, dispatch, shouldSkipSeq]
  );

  // Manual SSE-line parser for the POST transport. Streams body bytes into
  // an internal buffer, splits frames on \n\n, parses `event:`/`id:`/`data:`
  // lines. Handles partial frames across chunk boundaries by keeping the
  // tail of the buffer until the next chunk arrives.
  //
  // Why manual (vs piping to a parser lib): EventSource is GET-only — the
  // browser's native parser isn't available for POST. Industry-standard
  // pattern is a ~30-line manual splitter; pulling a library adds bundle
  // weight + a dependency for code that's spec-stable. Same pattern as
  // Anthropic Claude Code's web cockpit + LangChain's stream handler.
  const consumePostStream = useCallback(
    async (resp: Response): Promise<void> => {
      const body = resp.body;
      if (!body) {
        throw new Error('response body is null');
      }
      const reader = body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value && value.length) {
            buf += decoder.decode(value, { stream: true });
            // Split on \n\n; the last fragment may be a partial frame.
            // Keep that tail in buf and process the rest.
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const frameText = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              if (!frameText.trim()) continue;
              const frame: { event?: string; id?: string; data?: string } = {};
              for (const line of frameText.split('\n')) {
                if (line.startsWith('id: ')) frame.id = line.slice(4);
                else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
                else if (line.startsWith('event: ')) frame.event = line.slice(7);
                else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
                else if (line.startsWith('data: ')) frame.data = line.slice(6);
                else if (line.startsWith('data:')) frame.data = line.slice(5).trim();
              }
              const sessionExited = dispatchSseFrame(frame);
              if (sessionExited) {
                // Bridge said the session ended — flush any trailing frame
                // (best-effort) and return. The connection will close from
                // the bridge side anyway.
                if (buf.trim()) {
                  const tail: { event?: string; id?: string; data?: string } = {};
                  for (const line of buf.split('\n')) {
                    if (line.startsWith('id: ')) tail.id = line.slice(4);
                    else if (line.startsWith('event: ')) tail.event = line.slice(7);
                    else if (line.startsWith('data: ')) tail.data = line.slice(6);
                  }
                  if (tail.event || tail.data) dispatchSseFrame(tail);
                }
                return;
              }
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    },
    [dispatchSseFrame]
  );

  // ── POST transport (P0.4 cockpit-multi-session-v2, 2026-05-23) ──────────
  //
  // 1. GET /api/sessions/<sid>/stream-post (NC v5 metadata route) → mint a
  //    fresh 15-min bridge JWT, return { stream_url, token, method: 'POST' }.
  //    Hits Vercel for auth/ownership check; does NOT proxy the SSE itself
  //    (Vercel function timeouts would sever long-lived streams).
  // 2. POST stream_url directly to the bridge with Authorization: Bearer
  //    header + Last-Event-ID header (if we have a cursor from a previous
  //    connection). cloudflared does NOT buffer POST response bodies, so
  //    bytes flush mid-stream — the property GET breaks via issue #1449.
  // 3. Consume the response body via ReadableStream + manual SSE parser
  //    (see consumePostStream above). On stream end / network error,
  //    reconnect with the latest Last-Event-ID so the bridge replays the gap.
  const connectViaPost = useCallback(async () => {
    let meta: StreamMeta;
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/stream-post`,
        { method: 'GET', cache: 'no-store' }
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`stream-post metadata ${res.status}: ${txt.slice(0, 200)}`);
      }
      meta = (await res.json()) as StreamMeta;
    } catch (err) {
      setError(`Failed to mint stream-post token: ${String(err)}`);
      dispatch({ type: 'SSE_CLOSED' });
      scheduleReconnect();
      return;
    }

    await seedHistoryTail();
    if (logCursorRef.current !== null && reconnectAttempts.current > 0) {
      await catchupHistory();
    }

    closeStream();
    const abort = new AbortController();
    postAbortRef.current = abort;
    sawFirstFrameRef.current = false;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${meta.token}`,
      Accept: 'text/event-stream',
    };
    // Resume: re-send the last event_id so the bridge replays the gap
    // (P0.3 contract — ring buffer → JSONL log → 400 unknown cursor).
    if (lastEventIdRef.current) {
      headers['Last-Event-ID'] = lastEventIdRef.current;
    }

    let resp: Response;
    try {
      resp = await fetch(meta.stream_url, {
        method: 'POST',
        headers,
        // Empty body — the bridge's POST handler ignores any body content.
        body: '',
        signal: abort.signal,
        cache: 'no-store',
      });
    } catch (err) {
      // Network failure or fetch aborted. If aborted (user navigated away,
      // tab closed, transport switched), don't schedule reconnect.
      if (abort.signal.aborted) return;
      setError(`POST stream connect failed: ${String(err)}`);
      dispatch({ type: 'SSE_CLOSED' });
      scheduleReconnect();
      return;
    }

    if (!resp.ok) {
      // 400 from the bridge = unknown Last-Event-ID (the cursor we sent is
      // not in the ring buffer AND not in the JSONL log — likely log rotation
      // or a very stale cursor). Clear the cursor and reconnect from now.
      if (resp.status === 400) {
        lastEventIdRef.current = null;
        setError('stream cursor expired — reconnecting from current');
        dispatch({ type: 'SSE_CLOSED' });
        scheduleReconnect();
        return;
      }
      const txt = await resp.text().catch(() => '');
      setError(`bridge POST stream ${resp.status}: ${txt.slice(0, 200)}`);
      dispatch({ type: 'SSE_CLOSED' });
      scheduleReconnect();
      return;
    }

    // Connection established. Transition to LIVE NOW — don't wait for the
    // first PTY frame. An already-running, quiet session emits no bytes
    // after subscribe, so gating LIVE on FIRST_LIVE_EVENT left every
    // backgrounded-then-resubscribed pane stuck in SYNCING/RECONNECT forever
    // (JD: "ONE FALLS OUT OF LIVE NEAR INSTANTLY", 2026-05-27 fix/v3-two-
    // agents-stay-live). The bridge's HTTP 200 + open response body IS the
    // proof-of-life signal — the PTY is running and we're subscribed; if it
    // weren't running the bridge would have 404'd or 410'd. FIRST_LIVE_EVENT
    // transitions both SYNCING → LIVE (cold mount with quiet session) AND
    // RECONNECT → LIVE (post-drop reconnect on a quiet session), so it covers
    // every entry point. Idempotent in LIVE (reducer no-ops). The dedup-ring
    // logic in appendChunk that ALSO dispatches FIRST_LIVE_EVENT on the first
    // chunk is now redundant for the "quiet session" case but still correct
    // for the "frame arrived before resp.ok handler ran" race.
    dispatch({ type: 'FIRST_LIVE_EVENT' });
    sawFirstFrameRef.current = true;
    reconnectAttempts.current = 0;

    try {
      await consumePostStream(resp);
      // Stream ended cleanly (bridge closed connection). If the session
      // hasn't exited, schedule reconnect — this is the "EOF without exit"
      // case (e.g. session is still live but the bridge process restarted).
      // Read exitedRef (live), NOT the stale `status` closure: an `exit` frame
      // we just consumed sets exitedRef synchronously inside dispatchSseFrame,
      // so we correctly STOP here instead of reconnecting into the dead-sid
      // "(session exited)" stack. (fix/cockpit-resume-after-rotation.)
      if (!exitedRef.current) {
        dispatch({ type: 'SSE_CLOSED' });
        scheduleReconnect();
      }
    } catch (err) {
      // Aborted = clean teardown, don't reconnect.
      if (abort.signal.aborted) return;
      setError(`POST stream read failed: ${String(err)}`);
      if (!exitedRef.current) {
        dispatch({ type: 'SSE_CLOSED' });
        scheduleReconnect();
      }
    } finally {
      if (postAbortRef.current === abort) {
        postAbortRef.current = null;
      }
    }
    // CAT-18: NO `status` dep — connectViaPost reads only exitedRef.current /
    // res.status (HTTP), never the `status` STATE. Keeping it status-stable is
    // what lets `connect` (and the visibility effect) mount once.
  }, [
    sessionId,
    closeStream,
    seedHistoryTail,
    catchupHistory,
    consumePostStream,
    dispatch,
  ]);

  // ── GET transport (LEGACY — pre-P0.4) ─────────────────────────────────
  //
  // EventSource against /api/sessions/[sid]/stream metadata route. Kept as
  // a runtime fallback (NEXT_PUBLIC_BRIDGE_STREAM_METHOD=get) for the
  // 30-second pivot path if POST regresses. Identical wire format on the
  // bridge side — we just pipe EventSource events through dispatchSseFrame
  // (which writes lastEventIdRef so a transport swap mid-session picks up
  // the right cursor).
  const connectViaGet = useCallback(async () => {
    let meta: StreamMeta;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, {
        method: 'GET',
        cache: 'no-store',
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`stream metadata ${res.status}: ${txt.slice(0, 200)}`);
      }
      meta = (await res.json()) as StreamMeta;
    } catch (err) {
      setError(`Failed to mint stream token: ${String(err)}`);
      dispatch({ type: 'SSE_CLOSED' });
      scheduleReconnect();
      return;
    }

    // Seed the buffer from the log tail (first mount only — idempotent
    // via initialHistoryDoneRef). On subsequent reconnects this is a
    // no-op; the catchupHistory call below picks up the disconnect gap.
    await seedHistoryTail();
    // If this is a RECONNECT (cursor already populated by seed), pull
    // any events that landed during the disconnect window from /history
    // BEFORE opening the new SSE. This is the chat-resume-fix payload —
    // without it, the EventSource auto-reconnect window silently drops
    // every chunk emitted by the agent while the browser was offline.
    if (logCursorRef.current !== null && reconnectAttempts.current > 0) {
      await catchupHistory();
    }

    closeStream();
    sawFirstFrameRef.current = false;
    let es: EventSource;
    try {
      es = new EventSource(meta.stream_url);
    } catch (err) {
      setError(`EventSource construct failed: ${String(err)}`);
      dispatch({ type: 'SSE_CLOSED' });
      scheduleReconnect();
      return;
    }
    esRef.current = es;

    es.onopen = () => {
      // Mirror the POST transport: transition to LIVE on connection open,
      // not on first frame. A quiet already-running session has no bytes
      // to deliver, so gating LIVE on the first frame left panes stuck in
      // SYNCING/RECONNECT forever after any reconnect (fix/v3-two-agents-
      // stay-live, 2026-05-27). Idempotent in LIVE.
      dispatch({ type: 'FIRST_LIVE_EVENT' });
      sawFirstFrameRef.current = true;
      reconnectAttempts.current = 0;
    };

    es.onmessage = (ev) => {
      const lastId = (ev as MessageEvent).lastEventId || '';
      if (lastId) lastEventIdRef.current = lastId;
      // CAT-15: skip seqs already delivered (catchup/SSE overlap on reconnect).
      if (!shouldSkipSeq(lastId)) appendChunk(ev.data);
    };

    const namedHandler = (ev: MessageEvent) => {
      const lastId = ev.lastEventId || '';
      if (lastId) lastEventIdRef.current = lastId;
      if (!shouldSkipSeq(lastId)) appendChunk(ev.data);
    };
    es.addEventListener('output', namedHandler);
    es.addEventListener('stdout', namedHandler);
    es.addEventListener('stderr', namedHandler);

    es.addEventListener('status', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data);
        if (typeof d.status === 'string') setStatus(d.status);
      } catch {
        // ignore
      }
    });

    es.addEventListener('exit', (ev) => {
      exitedRef.current = true; // dead — stop reconnects (see exitedRef docstring)
      setStatus('exited');
      dispatch({ type: 'SESSION_ENDED' });
      try {
        const d = JSON.parse((ev as MessageEvent).data);
        if (d?.message) appendChunk(`\n[session exited: ${d.message}]\n`);
      } catch {
        appendChunk('\n[session exited]\n');
      }
      closeStream();
    });

    es.addEventListener('crashed', (ev) => {
      // cockpit-multi-session-v2 P1.4 — bridge crash recovery. Same
      // handling as the POST transport's `crashed` branch in
      // dispatchSseFrame, just routed via EventSource's named-event API.
      setStatus('exited');
      let crashedAtMs = Date.now();
      try {
        const d = JSON.parse((ev as MessageEvent).data);
        if (typeof d?.ts === 'string') {
          const parsed = Date.parse(d.ts);
          if (Number.isFinite(parsed)) crashedAtMs = parsed;
        }
      } catch {
        // fall through to Date.now()
      }
      exitedRef.current = true; // dead — stop reconnects (see exitedRef docstring)
      dispatch({ type: 'SESSION_CRASHED', crashedAt: crashedAtMs });
      appendChunk('\n[bridge crashed — session terminated]\n');
    });

    es.onerror = () => {
      closeStream();
      // exitedRef (live), not the stale `status` closure — see the POST
      // transport guard. Prevents the dead-sid reconnect storm on the GET
      // transport too. (fix/cockpit-resume-after-rotation.)
      if (!exitedRef.current) {
        dispatch({ type: 'SSE_CLOSED' });
        scheduleReconnect();
      }
    };
    // CAT-18: NO `status` dep — connectViaGet reads only exitedRef.current /
    // resp.status (HTTP) / the 'status' event name, never the `status` STATE.
  }, [sessionId, closeStream, seedHistoryTail, catchupHistory, appendChunk, dispatch, shouldSkipSeq]);

  // Transport selector. Picks POST (P0.4 default) unless explicitly
  // overridden via NEXT_PUBLIC_BRIDGE_STREAM_METHOD=get. The branch is
  // a one-line dispatch so the rest of the component doesn't care which
  // transport is live.
  const connect = useCallback(async () => {
    // CAT-18 (2026-06-12): read the LIVE `statusRef.current`, not the `status`
    // STATE closure. Taking a `status` dep here minted a NEW `connect` identity
    // on every status transition (starting→live→working→exited), which churned
    // the visibility-resume effect below (it deps on `connect`) — tearing down
    // and re-adding the visibilitychange/focus listeners on every status change
    // (a re-subscribe storm on mobile app-switch churn). With statusRef + the
    // monotonic exitedRef latch, `connect` is STABLE and the listeners mount
    // ONCE. streamIsDead still catches the case where the session died AFTER
    // this callback ran — a queued reconnect must not re-open a dead-sid stream.
    if (streamIsDead(statusRef.current, exitedRef.current)) {
      // ── Iter-5 (2026-05-27): JD msg 8136 dead-row history replay ──
      // When a dead row is clicked, ChatGridPane mounts SessionTerminal
      // with initialStatus='exited'. Previously we dispatched SESSION_ENDED
      // and returned IMMEDIATELY — which meant seedHistoryTail() was never
      // called for an exited-at-mount session, so the prior transcript
      // never painted. Pane was blank with "Waiting for output…".
      //
      // seedHistoryTail already has the exit-replay branch baked in
      // (lines 475-484): when initialStatusRef === 'exited' it writes the
      // /history bytes + "history above · live below" divider to the
      // terminal. We just have to actually CALL it on the exited mount path.
      //
      // No race: there's no live SSE that will start (we return immediately
      // after). writeToTerm queues bytes if xtermRef.current isn't ready
      // yet (pendingWritesRef flush at line ~1319), so order is preserved
      // regardless of mount timing. Network failure is caught inside
      // seedHistoryTail (silent fall-through) — never throws here.
      try {
        await seedHistoryTail();
      } catch {
        // Defensive: seedHistoryTail handles its own errors, but if a
        // future change adds a throw path, don't block SESSION_ENDED.
      }
      dispatch({ type: 'SESSION_ENDED' });
      return;
    }
    setError(null);
    if (BRIDGE_STREAM_METHOD === 'post') {
      await connectViaPost();
    } else {
      await connectViaGet();
    }
    // CAT-18: deliberately NO `status` dep — read statusRef.current above so
    // `connect`'s identity is stable across status transitions (keeps the
    // visibility listeners from re-subscribing on every status change).
  }, [connectViaPost, connectViaGet, dispatch, seedHistoryTail]);

  const scheduleReconnect = useCallback(() => {
    // Never reconnect a permanently-dead session. exitedRef is the live latch
    // (set by kill / exit-frame / crashed-frame); the `status` state can lag a
    // tick behind. This is the belt-and-suspenders stop for the "(session
    // exited)" stack — even if a guard upstream missed, no retry is scheduled.
    if (exitedRef.current) return;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    const attempt = reconnectAttempts.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setError(`Gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts. Reload to retry.`);
      dispatch({
        type: 'BRIDGE_ERROR',
        error: `Gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts.`,
      });
      return;
    }
    // Exponential backoff: 1s, 2s, 4s, 8s, capped at 15s
    const delay = Math.min(1000 * Math.pow(2, attempt), 15000);
    reconnectAttempts.current = attempt + 1;
    reconnectTimer.current = setTimeout(() => {
      void connect();
    }, delay);
  }, [connect, dispatch]);

  // Mount / unmount
  useEffect(() => {
    void connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      closeStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Visibility-aware resume (chat-resume-fix, 2026-05-22) ───────────────
  //
  // When JD switches tabs / minimizes the window, the browser throttles
  // background SSE aggressively — Chrome drops EventSource connections
  // after ~30s-5min depending on policy. Even when the connection lingers,
  // event delivery is bursty and unreliable.
  //
  // On return-to-tab we:
  //   1. Pull the disconnect window from /history (cursor mode → only the
  //      bytes appended since the last sync).
  //   2. Re-open SSE if its readyState says it's anything other than OPEN.
  //
  // EventSource readyState values: 0 = CONNECTING, 1 = OPEN, 2 = CLOSED.
  // We only force-reopen on CLOSED (2) because CONNECTING (0) is already
  // trying — yanking it out from under itself would be wasteful churn.
  //
  // State-machine note: visibility/focus catchup is SILENT — it doesn't
  // dispatch HISTORY_LOADED (that's reserved for the initial mount) and
  // it doesn't drop us back to SYNCING. If the SSE happens to be CLOSED
  // and we force-reconnect, that path goes through SSE_CLOSED + connect()
  // which produces the RECONNECT badge naturally.
  useEffect(() => {
    // CAT-18 (2026-06-12): this effect now mounts its visibilitychange/focus
    // listeners ONCE for the lifetime of the sid — it no longer deps on
    // `status` or a `status`-derived `connect`. Re-reading the live
    // `statusRef.current`/`exitedRef.current` at SETUP and at EVENT time gives
    // the SAME dead-session protection the `status` closure gave, WITHOUT the
    // re-subscribe churn (the old deps re-registered the listeners on every
    // status transition — a storm on mobile app-switch focus/blur). The
    // resilience no longer hangs solely on the exitedRef latch discipline at
    // every exit path — the listeners themselves are stable.
    //
    // Honor the monotonic exited latch: in the window where exitedRef has fired
    // but setStatus hasn't flushed, a tab re-focus would otherwise run a
    // wasteful catchup + dispatch SSE_CLOSED (flipping a correctly-ENDED badge
    // to a stuck "RECONNECT") before connect() bails. streamIsDead closes that
    // gap — a dead session never resumes.
    if (streamIsDead(statusRef.current, exitedRef.current)) return;

    const resume = () => {
      // Event-time latch check (not just the setup-time guard above): the
      // listeners outlive the render in which the session died, so re-read the
      // authoritative statusRef/exitedRef here. Without this, a focus event in
      // the exited-but-status-not-yet-flushed window dispatches SSE_CLOSED on a
      // dead session — the stuck-RECONNECT-badge bug. (Iter 3)
      if (streamIsDead(statusRef.current, exitedRef.current)) return;
      // Catchup unconditionally — cheap empty body when there's nothing
      // new, and the visible "synced" badge is the proof-of-life JD
      // explicitly asked for.
      void catchupHistory();

      // Force SSE reopen if it's drifted to CLOSED. Branches per transport:
      //   - GET path: EventSource exposes readyState (0=CONNECTING, 1=OPEN,
      //     2=CLOSED). Reconnect only on CLOSED; CONNECTING already has a
      //     reconnect path in flight; OPEN is fine.
      //   - POST path: AbortController has no readyState equivalent. We
      //     treat "no live abort controller" as "no active stream" and
      //     reconnect. If one IS live, leave it — consumePostStream is
      //     either reading bytes or about to schedule its own reconnect.
      const needReopen =
        BRIDGE_STREAM_METHOD === 'get'
          ? !esRef.current || esRef.current.readyState === 2 /* CLOSED */
          : postAbortRef.current === null;
      if (needReopen) {
        // Cancel any pending reconnect timer — we're going NOW.
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
        reconnectAttempts.current = 0;
        // Signal to the state machine that we're back to reconnecting,
        // since the prior stream is dead. (No-op if we're already in
        // RECONNECT.)
        dispatch({ type: 'SSE_CLOSED' });
        void connect();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        resume();
      }
    };
    const onFocus = () => resume();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
    // CAT-18: NO `status` dep — the listeners mount once and re-read the live
    // statusRef/exitedRef at event time. `connect` is now stable (status-free
    // deps), so this effect's identity no longer churns on status transitions.
  }, [catchupHistory, connect, dispatch]);

  // ── xterm terminal lifecycle (fix/cockpit-xterm-render) ─────────────────
  //
  // Instantiate the emulator on mount (browser-only — dynamic import keeps
  // `document`-touching code out of the SSR pass). Wire FitAddon + a
  // ResizeObserver + window resize so the terminal's cols/rows track the pane
  // size. Flush any writes that arrived before the terminal existed (the
  // connect effect's history/SSE writes can land first). Dispose on unmount.
  //
  // Mounts once per sessionId — re-keys on sessionId so a transparent resume
  // (which reloads the whole component) gets a fresh terminal. xterm itself is
  // never recreated mid-session; the streaming machinery feeds it.
  useEffect(() => {
    let disposed = false;
    let term: XTerminal | null = null;
    let fit: XFitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;

    // swap-to-raw fix (JD 2026-06-02): after fitting the xterm to the pane,
    // tell the BRIDGE the new cols/rows so the PTY (and Claude's TUI) re-renders
    // for the ACTUAL display width. Without this the PTY stayed at its fixed
    // 120x40 spawn size and the TUI's cursor math garbled into "raw" overlap
    // whenever the pane wasn't ~120 cols. Debounced (250ms) + deduped so rapid
    // ResizeObserver ticks collapse to one POST per settled size.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSize = '';
    const postResize = (cols: number, rows: number) => {
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 20 || rows < 4) return;
      const key = `${cols}x${rows}`;
      if (key === lastSize) return; // size unchanged → no POST
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        lastSize = key;
        void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols, rows }),
        }).catch(() => {
          // Cosmetic — a failed resize never breaks the pane. Allow a retry
          // next fit by clearing the dedup latch.
          lastSize = '';
        });
      }, 250);
    };

    const doFit = () => {
      if (!fit) return;
      try {
        fit.fit();
        if (term) postResize(term.cols, term.rows);
      } catch {
        // fit() throws if the container has zero dimensions (e.g. a hidden
        // mobile tab). Harmless — the ResizeObserver re-fires when it shows.
      }
    };

    const onWindowResize = () => doFit();

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      // Component may have unmounted during the dynamic import.
      if (disposed || !termContainerRef.current) return;

      term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontSize: Math.max(10, fontSize ?? 12),
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Liberation Mono", monospace',
        scrollback: 10_000,
        // Dark theme tuned to the cockpit's near-black panes + neon accents.
        theme: {
          background: '#000000',
          foreground: '#e5e7eb',
          cursor: '#22d3ee',
          cursorAccent: '#000000',
          selectionBackground: 'rgba(34,211,238,0.30)',
          black: '#1f2937',
          red: '#f87171',
          green: '#34d399',
          yellow: '#fbbf24',
          blue: '#60a5fa',
          magenta: '#e879f9',
          cyan: '#22d3ee',
          white: '#e5e7eb',
          brightBlack: '#4b5563',
          brightRed: '#fca5a5',
          brightGreen: '#6ee7b7',
          brightYellow: '#fde68a',
          brightBlue: '#93c5fd',
          brightMagenta: '#f0abfc',
          brightCyan: '#67e8f9',
          brightWhite: '#f9fafb',
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);

      // ── Clickable URLs (feat/v3-pane-clickable-links) ──
      // Telegram-style: plain-click opens in a new tab. Shift-click does the
      // same — we keep it symmetric so a modifier doesn't surprise JD. If
      // pushback comes back that he sometimes wants to copy-not-open, the
      // handler is the place to fork.
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          event.preventDefault();
          try {
            window.open(uri, '_blank', 'noopener,noreferrer');
          } catch {
            // popup blocked / iframe sandbox — fall back to clipboard copy so
            // the click is never a silent no-op.
            void navigator.clipboard?.writeText(uri).then(
              () => showPathToast(`URL copied: ${uri.slice(-48)}`),
              () => undefined,
            );
          }
        }),
      );

      // ── Custom matcher for absolute Unix paths + ~/ paths ──
      //
      // Regex notes:
      //   - Absolute paths: /Users/..., /tmp/..., /opt/..., /var/... — match
      //     a leading slash followed by a path-safe char + chain of segments.
      //     Path chars allowed: word chars, dot, dash, underscore, slash. We
      //     deliberately STOP at whitespace, quotes, parens, brackets,
      //     backticks, commas, colons-not-followed-by-slash. That covers
      //     "logs: /Users/foo/bar.log" and "see /Users/foo/bar.log." (trailing
      //     punctuation stripped below).
      //   - ~/ paths: same body, leading tilde-slash.
      //   - We require a "/" somewhere after the start so we don't match
      //     bare command names like "/Users" alone.
      //
      // file:// URLs are blocked by Chrome/Safari from non-file: pages (security
      // — preventing remote pages from sniffing local files via 1×1 iframes),
      // so a click that does window.open('file:///Users/...') opens about:blank.
      // The actually-useful behavior is copy-to-clipboard: JD can then paste
      // into Finder (Cmd-Shift-G), an editor's Open dialog, or a shell.
      const PATH_RE = /(?:^|[\s"'`(\[])((?:~|\/[A-Za-z][A-Za-z0-9_\-.]*)(?:\/[A-Za-z0-9_\-.][A-Za-z0-9_\-.]*)+\/?)/g;
      // Strip trailing punctuation chars that often follow paths in prose.
      const trimTrailing = (s: string) => s.replace(/[.,;:!?)\]}>'"`]+$/, '');

      term.registerLinkProvider({
        provideLinks(y, callback) {
          const buf = term!.buffer.active;
          const line = buf.getLine(y - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          const text = line.translateToString(true);
          if (!text) {
            callback(undefined);
            return;
          }
          const links: import('@xterm/xterm').ILink[] = [];
          let m: RegExpExecArray | null;
          PATH_RE.lastIndex = 0;
          while ((m = PATH_RE.exec(text)) !== null) {
            const captureStart = m.index + (m[0].length - m[1].length);
            const raw = m[1];
            const cleaned = trimTrailing(raw);
            if (!cleaned || cleaned.length < 4) continue;
            // 1-based column positions inclusive at start, inclusive at end.
            const startCol = captureStart + 1;
            const endCol = captureStart + cleaned.length;
            links.push({
              range: {
                start: { x: startCol, y },
                end: { x: endCol, y },
              },
              text: cleaned,
              decorations: { pointerCursor: true, underline: true },
              activate(_ev, linkText) {
                const path = linkText;
                // Copy to clipboard (the always-useful default), then attempt
                // a best-effort file:// open as well — harmless if Chrome
                // blocks it; helpful in the rare environments that allow it.
                const writeP = navigator.clipboard?.writeText(path);
                if (writeP && typeof writeP.then === 'function') {
                  writeP.then(
                    () => showPathToast(`Path copied: ${path.slice(-48)}`),
                    () => showPathToast(`Path: ${path.slice(-48)}`),
                  );
                } else {
                  showPathToast(`Path: ${path.slice(-48)}`);
                }
              },
            });
          }
          callback(links.length ? links : undefined);
        },
      });

      term.open(termContainerRef.current);
      xtermRef.current = term;
      fitAddonRef.current = fit;

      // Initial fit, then flush any queued writes in order.
      doFit();
      if (pendingWritesRef.current.length) {
        for (const chunk of pendingWritesRef.current) {
          term.write(chunk);
        }
        pendingWritesRef.current = [];
      }

      // Track pane resizes so cols/rows follow the container. The bridge PTY
      // size isn't renegotiated from the client today (the bridge spawns at a
      // fixed size), so this is purely a client-side reflow of the rendered
      // glyphs — see the resize note in the PR report.
      resizeObserver = new ResizeObserver(() => doFit());
      resizeObserver.observe(termContainerRef.current);
      window.addEventListener('resize', onWindowResize);
    })();

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener('resize', onWindowResize);
      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch {
          // ignore
        }
        resizeObserver = null;
      }
      if (term) {
        try {
          term.dispose();
        } catch {
          // ignore
        }
      }
      xtermRef.current = null;
      fitAddonRef.current = null;
      // Clear any pending toast timer so a unmount-mid-toast doesn't leak.
      if (pathToastTimerRef.current) {
        clearTimeout(pathToastTimerRef.current);
        pathToastTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Live fontSize updates (v3 pane-readability, 2026-05-27) ──────────────
  // When ChatGrid passes a different fontSize prop (pane count crossed a
  // tier), mutate the running xterm's font size + re-fit so cols/rows recompute
  // for the new glyph dimensions. No terminal re-instantiation — scrollback,
  // SSE stream, input state all survive. Floor at 10 to match the prop guard.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const size = Math.max(10, fontSize ?? 12);
    if (term.options.fontSize === size) return;
    try {
      term.options.fontSize = size;
      fitAddonRef.current?.fit();
    } catch {
      // ignore — fit() throws on zero-dim containers (hidden panes); next
      // ResizeObserver tick will recover when the pane becomes visible.
    }
  }, [fontSize]);

  // ── Manual reload (ERROR escape hatch) ───────────────────────────────────

  const manualReload = useCallback(() => {
    // Clear retry state, dispatch MANUAL_RELOAD (resets ENDED/ERROR →
    // INITIAL), then reconnect from scratch.
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectAttempts.current = 0;
    lastEventIdRef.current = null;
    sawFirstFrameRef.current = false;
    setError(null);
    dispatch({ type: 'MANUAL_RELOAD' });
    void connect();
  }, [connect, dispatch]);

  // ── Spawn-new-with-same-prompt (P1.4 crashed-session recovery) ──────────
  //
  // Flow:
  //   1. GET /api/sessions/<sid>/metadata via the bridge proxy to read the
  //      crashed session's cwd + project_slug (persisted in
  //      bridge-sessions.json; survives the bridge restart that caused
  //      the crash).
  //   2. POST /api/sessions/spawn with thread_id (same thread) + cwd +
  //      project_slug → bridge spawns a new Claude session into the same
  //      context. UI navigates to the new sid's pane so JD keeps reading
  //      from where the old agent died (the transcript is preserved on
  //      disk via /history; new session lands in the same project).
  //
  // "Original prompt" is not available — the bridge has the command
  // line (claude --session-id <uuid> [project_context]) but not the
  // user's first message. The next-best thing is identical cwd +
  // project_slug, which gives the new session the same project pre-
  // injection (life-os-v1 T1.1.c). If JD wants the literal prompt
  // re-sent he can paste it into the input.
  //
  // threadId guard: if the pane wasn't spawned with a thread (ad-hoc
  // preview), the spawn-new button is hidden — there's no thread to
  // attach the new session to.
  const [spawningNew, setSpawningNew] = useState(false);

  // ── Transparent resume on input (chat-resume-fix, 2026-05-24, JD ask) ──
  //
  // When JD types into a dead-sid pane, /api/sessions/[sid]/input asks the
  // bridge to resume the session under a new sid (via `claude --resume
  // <cc_session_id>` or fresh + project pre-injection — see bridge resume
  // route docstring). The bridge returns the NEW sid; we have to:
  //
  //   1. Stop reading from the OLD sid's SSE stream.
  //   2. Update the URL + window.history.pushState so a refresh lands on
  //      the new sid (also so JD can copy-link to the right session).
  //   3. Reload the whole component for the new sid — easiest with
  //      window.location.replace, which preserves the project context but
  //      cleanly remounts SessionTerminal pointing at the live sid.
  //
  // A simpler-than-replace path: setActiveSid + force the component to
  // rebind. But our SSE/history/cost machinery all keyed on sessionId via
  // useEffect deps, and forcing every ref to reset cleanly is fragile.
  // Reload is one line and ALWAYS correct. JD typed his message; we sent
  // it to the bridge under the new sid; reloading takes him to the new
  // pane where the SSE picks up the live stream (including the message
  // he just sent + the agent's response). User-visible result: typed
  // text appears, brief flicker, response streams in — exactly what
  // "type and it works" looks like.
  //
  // Toast: 3-second "Session resumed" badge so JD knows what happened.
  // Click-to-dismiss for the impatient. Logged + persisted via
  // sessionStorage so it survives the reload.
  const [resumedBadge, setResumedBadge] = useState<{
    from: string;
    to: string;
    strategy?: string;
  } | null>(null);
  const RESUMED_STORAGE_KEY = `chat-resumed-from-${sessionId}`;
  // On mount: check if we just resumed INTO this sid. The /input handler
  // sets sessionStorage before reload; we surface the badge here.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      // The previous sid stored a flag under its own key; look for any
      // flag that lists us as the "to" sid.
      const raw = sessionStorage.getItem(`chat-resumed-into-${sessionId}`);
      if (!raw) return;
      const info = JSON.parse(raw) as {
        from: string;
        to: string;
        strategy?: string;
      };
      sessionStorage.removeItem(`chat-resumed-into-${sessionId}`);
      setResumedBadge(info);
      const t = setTimeout(() => setResumedBadge(null), 3500);
      return () => clearTimeout(t);
    } catch {
      // ignore
    }
  }, [sessionId]);
  // Hide badge handler — kept here so the cleanup return-fn structure is
  // intact (the inner setTimeout already auto-clears).
  const dismissResumedBadge = useCallback(() => setResumedBadge(null), []);
  // Receipt auto-hide — 'read' fades after 6s (it did its job; the thinking
  // pill carries the live signal). 'delivered' gets a 20s safety so a missed
  // read upgrade can't pin the pill forever.
  useEffect(() => {
    if (!receipt) return;
    const t = setTimeout(
      () => {
        awaitingReadRef.current = false;
        setReceipt(null);
      },
      receipt === 'read' ? 6000 : 20000
    );
    return () => clearTimeout(t);
  }, [receipt]);
  const spawnNewWithSamePrompt = useCallback(async () => {
    if (spawningNew || !threadId) return;
    setSpawningNew(true);
    setError(null);
    try {
      // 1. Pull metadata via the bridge proxy (existing /api/sessions/[sid]
      // route shape: GET returns status; for metadata we hit a new endpoint).
      // The /api/sessions/<sid>/metadata bridge route was added in the
      // matching P1.4 bridge PR; route by route we hit the Vercel proxy
      // which already forwards arbitrary subpaths to the bridge.
      let cwd: string | null = null;
      let metaProjectSlug: string | null = null;
      try {
        const metaRes = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/metadata`,
          { method: 'GET', cache: 'no-store' }
        );
        if (metaRes.ok) {
          const m = (await metaRes.json()) as {
            cwd?: string | null;
            project_slug?: string | null;
          };
          cwd = (m.cwd && String(m.cwd)) || null;
          metaProjectSlug = (m.project_slug && String(m.project_slug)) || null;
        }
      } catch {
        // Metadata is best-effort — fall through with the slug we
        // already have from props (still gives the spawn enough
        // context to land in the right project).
      }
      const spawnBody = {
        thread_id: threadId,
        project_slug: metaProjectSlug || projectSlug || null,
        cwd: cwd || undefined,
      };
      const res = await fetch('/api/sessions/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spawnBody),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`spawn failed ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = (await res.json()) as { session_id?: string };
      const newSid = data.session_id;
      if (!newSid) {
        throw new Error('spawn returned no session_id');
      }
      // 2. Navigate to the new pane. The session page route lives at
      // /projects/[slug]/sessions/[sid] when there's a project; for
      // non-project threads we route to /chat?panes=<sid>.
      const targetSlug = metaProjectSlug || projectSlug || null;
      if (typeof window !== 'undefined') {
        if (targetSlug) {
          window.location.href = `/projects/${encodeURIComponent(targetSlug)}/sessions/${encodeURIComponent(newSid)}`;
        } else {
          window.location.href = `/chat?panes=${encodeURIComponent(newSid)}`;
        }
      }
    } catch (err) {
      setError(`Spawn-new failed: ${String(err)}`);
      setSpawningNew(false);
    }
  }, [spawningNew, threadId, sessionId, projectSlug]);

  // ── M2: voice transcript → input (mirrors Composer.handleTranscript) ────
  //
  // The shared VoiceRecorder records audio → POSTs /api/transcribe → fires
  // onTranscript with the Whisper text. We append it to the pane input
  // (space-separated if there's already text) and DO NOT auto-send — JD
  // reviews + hits Enter, exactly like the thread chat. This keeps the
  // pane composer's "you submit, not the mic" contract.
  const handleTranscript = useCallback((transcript: string) => {
    setError(null);
    setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
  }, []);

  // ── M2: file attach → upload → inject absolute path into input ──────────
  //
  // Flow: POST the file(s) to /api/sessions/<sid>/upload (session-scoped — it
  // resolves thread_id server-side from the chat_sessions row, forwards to the
  // bridge, returns the absolute disk_path the bridge wrote on the Mac Mini).
  // We then inject those paths into the input box as text. The Claude Code
  // agent runs on the SAME machine with filesystem access (--add-dir), so a
  // path is all it needs — it reads the bytes itself. JD reviews + sends
  // (no auto-send), consistent with the voice path. Multiple files → one path
  // per line so the agent sees each.
  const handleAttachFiles = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      if (uploading) return;
      const files = Array.from(list);
      // Reset the input element so re-selecting the same file re-fires change.
      if (fileInputRef.current) fileInputRef.current.value = '';
      setError(null);
      setUploading(true);
      try {
        const form = new FormData();
        for (const f of files) form.append('files', f, f.name);
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/upload`,
          { method: 'POST', body: form }
        );
        const data = (await res.json().catch(() => ({}))) as {
          uploads?: Array<{ disk_path: string; filename: string }>;
          error?: string;
        };
        if (res.status === 401 && typeof window !== 'undefined') {
          const back = window.location.pathname + window.location.search;
          setError('Session expired — re-authenticating…');
          window.location.assign(`/login?callbackUrl=${encodeURIComponent(back)}`);
          return;
        }
        if (!res.ok) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const uploads = data.uploads || [];
        if (uploads.length === 0) {
          throw new Error('Upload returned no files');
        }
        // Inject the absolute path(s) into the composer for JD to review +
        // send. One path per line so multi-file attaches stay legible.
        const pathsBlock = uploads
          .map((u) => `Attached file: ${u.disk_path}`)
          .join('\n');
        setInput((prev) => (prev ? `${prev}\n${pathsBlock}` : pathsBlock));
      } catch (err) {
        setError(
          `Attach failed: ${String(err instanceof Error ? err.message : err)}`
        );
      } finally {
        setUploading(false);
      }
    },
    [sessionId, uploading]
  );

  // ── Input submit ─────────────────────────────────────────────────────────

  const submitInput = useCallback(async () => {
    const text = input.trim();
    // Allow sending even when status === 'exited' — the bridge will auto-
    // resume via /input route's bridge-404 handler (chat-resume-fix 2026-05-24).
    // The OLD guard blocked the very flow JD asked for: "type into a dead
    // chat and have it just work."
    if (!text || sending) return;
    setSending(true);
    setError(null);
    // Clear any prior receipt while this send is in flight (sending state is
    // carried by the composer's spinner; the pill returns at 'delivered').
    awaitingReadRef.current = false;
    setReceipt(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/input`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Append a CARRIAGE RETURN (\r) to actually SUBMIT the message.
          // The Claude Code TUI runs in bracketed-paste mode ([?2004h), so
          // text written to the PTY lands in the composer but a trailing \n
          // is NOT treated as Enter — it inserts a literal newline. The TUI
          // submits on \r. Without this, every typed message sat unsent in
          // the composer and the pane looked permanently "stuck" (JD,
          // 2026-05-25 "this pane is stuck when I say Hi"). Verified: text+\r
          // → session replies; text alone → stuck. This is THE fix that makes
          // the cockpit chat actually respond.
          body: JSON.stringify({ text: text + '\r' }),
        }
      );
      // 401 self-heal (JD 2026-05-25 "fix this so it doesn't happen again"):
      // the app session is configured 365-day sliding, so a 401 here means a
      // transient auth blip (Supabase session-lookup hiccup, or a stale-deploy-
      // URL cookie mismatch), not real expiry. Don't dead-end on "Unauthorized"
      // — re-authenticate and return to THIS exact pane URL so the open grid
      // survives. NextAuth's magic-link flow lands the user right back here.
      if (res.status === 401 && typeof window !== 'undefined') {
        const back = window.location.pathname + window.location.search;
        setError('Session expired — re-authenticating…');
        window.location.assign(`/login?callbackUrl=${encodeURIComponent(back)}`);
        return;
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${res.status}: ${txt.slice(0, 200)}`);
      }
      // Inspect the response for the resume signal. The /input route returns
      // `{new_session_id, resumed: true, resumed_from, strategy}` when it
      // transparently swapped the bridge sid (i.e. the OLD sid was dead and
      // the bridge spun up a new PTY via /resume — JD's input was forwarded
      // to the new sid). When this happens we need to swap the UI to the
      // new sid; the simplest correct way is to reload the page pointed at
      // the new pane.
      let payload: {
        new_session_id?: string;
        resumed?: boolean;
        resumed_from?: string;
        strategy?: string;
        // M4 rotation-safe-context: present when the resume's readiness gate
        // timed out — the forwarded message may not have landed in the agent's
        // composer, so we surface it as a visible "resend" warning rather than
        // a false silent success.
        warning?: string;
        input_ready?: boolean;
        // feat/read-receipts: the bridge's verified-submit outcome. true =
        // the turn provably entered the composer and submitted (receipt →
        // 'delivered'); false = unconfirmed (warn + no receipt); absent =
        // older bridge (degrade to 2xx-means-delivered).
        submitted?: boolean;
      } = {};
      try {
        payload = await res.json();
      } catch {
        // non-JSON response — treat as success, no resume happened
      }
      // Surface a not-ready warning (visible) so JD never thinks a message
      // sent when it may have been dropped into a still-booting agent. This
      // covers BOTH the resume path (payload.warning) AND the normal live
      // path on a freshly-spawned pane whose composer wasn't ready yet
      // (input_ready === false from the bridge's first-input gate). Either
      // way JD gets a visible "resend" cue instead of a false silent success.
      if (payload.warning) {
        setError(payload.warning);
      } else if (payload.input_ready === false) {
        setError(
          'Agent was still starting up — if it does not respond, resend your message.'
        );
      }
      if (payload.resumed && payload.new_session_id) {
        // RESUME path ONLY — local-echo the input here because the NEW sid's
        // fresh PTY stream won't contain the text JD typed against the OLD
        // (dead) sid. Without this echo the swapped pane would look like the
        // message vanished. (Contrast the normal-live path below, where the
        // local echo was REMOVED in V3 M3 — see the no-echo note there.)
        appendChunk(`\n> ${text}\n`);
        setInput('');
        // Stash the resume info under the NEW sid so the next mount can
        // show the "Session resumed" toast.
        if (typeof window !== 'undefined') {
          try {
            sessionStorage.setItem(
              `chat-resumed-into-${payload.new_session_id}`,
              JSON.stringify({
                from: sessionId,
                to: payload.new_session_id,
                strategy: payload.strategy,
              })
            );
          } catch {
            // sessionStorage may be unavailable (private window quota,
            // etc.) — toast just won't show. Swap still happens.
          }
          // Navigate to the new pane. Use replace() so JD's back button
          // doesn't bounce him to a dead-session URL.
          //
          // URL shape: if we're at /projects/<slug>/sessions/<oldsid>,
          // swap the sid in-place. Otherwise we're on /chat?panes=...
          // and we rewrite the query param.
          const curUrl = new URL(window.location.href);
          const oldEnc = encodeURIComponent(sessionId);
          const newEnc = encodeURIComponent(payload.new_session_id);
          if (curUrl.pathname.includes(`/sessions/${sessionId}`)) {
            curUrl.pathname = curUrl.pathname.replace(
              `/sessions/${sessionId}`,
              `/sessions/${payload.new_session_id}`
            );
            window.location.replace(curUrl.toString());
          } else if (onResumed) {
            // Cockpit grid (?panes=) — swap THIS pane's sid IN PLACE via the
            // parent (React state + router.replace, no reload). Every other
            // pane stays mounted and keeps streaming, so resuming one dead
            // session no longer reloads the whole deck. The parent updates
            // ?panes= + localStorage; this pane re-mounts on its new key and
            // reads the sessionStorage stash above to show the resumed badge.
            // cockpit overhaul 2026-05-26.
            onResumed(sessionId, payload.new_session_id);
          } else if (curUrl.searchParams.has('panes')) {
            // Legacy fallback (no onResumed wired) — full-reload sid swap.
            const panes = curUrl.searchParams.get('panes') || '';
            const swapped = panes.split(',').map((p) =>
              p === sessionId || p === oldEnc ? payload.new_session_id! : p
            ).join(',');
            curUrl.searchParams.set('panes', swapped);
            window.location.replace(curUrl.toString());
          } else {
            // No URL shape we recognize — fall back to a full reload
            // pointed at /chat?panes=<new_sid>. JD lands on the live
            // session; transcript is preserved via /history.
            window.location.replace(
              `/chat?panes=${newEnc}`
            );
          }
        }
        return;
      }
      // Normal path — session was live, input went through directly.
      //
      // V3 M3 no-echo fix (2026-05-27): do NOT local-echo the typed text into
      // the terminal here. The bridge writes the text to the PTY
      // (manager.write → sess.proc.write), and the Claude Code TUI echoes it
      // back through its OWN render — the typed message appears in the TUI's
      // composer and then in the transcript, streamed to us over SSE. The old
      // `appendChunk('> text')` printed a SECOND copy: JD's SS4 showed his
      // message twice (once as the local "> ..." sent-line, once echoed by the
      // TUI). Dropping the local echo leaves exactly one copy — the TUI's. The
      // dedup ring in appendChunk could never catch this because the two copies
      // aren't byte-identical (one is "> text", the other is the TUI's styled
      // composer render). Root cause: double source of truth for "what the user
      // typed." The PTY is the single source of truth; trust it.
      setInput('');
      // Read-receipt: the message landed in the LIVE agent's PTY cleanly (no
      // resume swap, no not-ready warning). Flash the 👀 "Seen by agent" pill.
      // Skipped on the resume path (returns above) and when input_ready===false
      // / a warning was set — those aren't a clean "the agent has it" delivery.
      if (!payload.warning && payload.input_ready !== false) {
        if (payload.submitted === false) {
          // The bridge wrote the bytes but could NOT verify the submit —
          // visible cue instead of a false "delivered" (resend is safe to
          // suggest; a verified-submit failure means no turn is running).
          setError(
            'Message may not have submitted — if the agent does not respond, resend it.'
          );
        } else {
          setReceipt('delivered');
          awaitingReadRef.current = true;
        }
      }
    } catch (err) {
      setError(`Send failed: ${String(err)}`);
    } finally {
      setSending(false);
    }
  }, [input, sending, sessionId, appendChunk, onResumed]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submitInput();
      }
    },
    [submitInput]
  );

  // ── Raw keystroke send (fix/cockpit-interactive-prompts, 2026-06-01) ───────
  //
  // POST a RAW key to /api/sessions/<sid>/key — no '\r' append, no submit
  // machinery — so a bare arrow / Esc / digit / Enter reaches a Claude Code
  // selection menu verbatim and actually NAVIGATES it. This is the unblock for
  // JD's "the chatbox can only pick the default" bug. Powers both the ↑ ↓
  // Enter Esc control row (part A) and the tappable option buttons (part B).
  //
  // Sends a sequence in order (e.g. digit then Enter). keySending debounces so
  // a double-tap can't fire twice into the same row. After sending we let the
  // PTY repaint and re-scan — the menu either advances (cursor moved) or
  // disappears (option confirmed); scanForMenu picks that up off the stream.
  const sendKey = useCallback(
    async (payloads: Array<{ key?: string; bytes?: string }>) => {
      if (keySending || !payloads.length) return;
      setKeySending(true);
      setError(null);
      try {
        for (const p of payloads) {
          const res = await fetch(
            `/api/sessions/${encodeURIComponent(sessionId)}/key`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(p),
            },
          );
          if (res.status === 401 && typeof window !== 'undefined') {
            const back = window.location.pathname + window.location.search;
            setError('Session expired — re-authenticating…');
            window.location.assign(`/login?callbackUrl=${encodeURIComponent(back)}`);
            return;
          }
          if (!res.ok) {
            const txt = await res.text();
            // 404/409 = the PTY is gone (menu is gone too); 422 = bad key.
            throw new Error(`${res.status}: ${txt.slice(0, 160)}`);
          }
          // Small gap between keys so a digit-then-Enter sequence isn't
          // coalesced into one PTY read (the menu needs to register the digit
          // before the Enter confirms it).
          if (payloads.length > 1) await new Promise((r) => setTimeout(r, 80));
        }
      } catch (err) {
        setError(`Key send failed: ${String(err)}`);
      } finally {
        setKeySending(false);
      }
    },
    [keySending, sessionId],
  );

  // Tap an option button → select that option. Uses the digit/arrow strategy
  // from keystrokesForOption (digit+Enter by default — verified to land the
  // chosen, non-default option).
  const tapOption = useCallback(
    (targetIndex: number) => {
      if (!menu) return;
      void sendKey(keystrokesForOption(menu, targetIndex));
    },
    [menu, sendKey],
  );

  // ── Kill session ─────────────────────────────────────────────────────────

  const killSession = useCallback(async () => {
    if (killing || status === 'exited') return;
    if (!confirm('Kill this Claude Code session?')) return;
    setKilling(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${res.status}: ${txt.slice(0, 200)}`);
      }
      exitedRef.current = true; // dead — stop reconnects (see exitedRef docstring)
      setStatus('exited');
      dispatch({ type: 'SESSION_ENDED' });
      closeStream();
      appendChunk('\n[session killed by user]\n');
    } catch (err) {
      setError(`Kill failed: ${String(err)}`);
    } finally {
      setKilling(false);
    }
  }, [killing, status, sessionId, closeStream, appendChunk, dispatch]);

  // ── Render ───────────────────────────────────────────────────────────────

  const isLive = status === 'live' || status === 'starting';

  // ── Interactive-menu poll (fix/cockpit-interactive-prompts) ──────────────
  // writeToTerm already re-scans after each PTY write, but a menu can settle on
  // a chunk that the dedup ring dropped, or appear while the stream is quiet. A
  // lightweight 1s poll while live guarantees the option buttons surface (and
  // clear when the menu closes) regardless of stream timing. Cheap: it reads
  // the already-rendered xterm buffer, no network. Stops when not live.
  useEffect(() => {
    if (!isLive) {
      setMenu(null);
      return;
    }
    const id = setInterval(scanForMenu, 1000);
    return () => clearInterval(id);
  }, [isLive, scanForMenu]);

  // Boot-overlay copy (fix/cockpit-restore-not-boot-on-return). Precedence:
  //   1. hasPriorHistory   → established session RETURNING → "Restoring…".
  //   2. !historyChecked    → fresh-vs-established not yet known (the /history
  //                          fetch hasn't resolved — still minting the stream
  //                          token, etc.) → NEUTRAL "Connecting…". Committing to
  //                          "Booting agent… 20–30s" here is the exact lie JD
  //                          screenshotted on mobile cold-remount.
  //   3. INITIAL / SYNCING  → CONFIRMED-fresh spawn (history checked, no bytes)
  //                          → the real "Booting agent… 20–30s" copy.
  //   4. RECONNECT / ERROR  → bridge recovering.
  //   5. else               → subscribed, between writes.
  const bootOverlayCopy: { headline: string; sub: string } = hasPriorHistory
    ? {
        headline: 'Restoring session…',
        sub: 'Reconnecting — your conversation is loading. The agent kept running; nothing was lost.',
      }
    : !historyChecked
    ? {
        headline: 'Connecting…',
        sub: 'Reconnecting to your session — restoring the transcript.',
      }
    : sseState.kind === 'INITIAL' || sseState.kind === 'SYNCING'
    ? {
        headline: 'Booting agent…',
        sub: 'Claude Code is starting up. First output usually lands in 20–30 seconds.',
      }
    : sseState.kind === 'RECONNECT' || sseState.kind === 'ERROR'
    ? {
        headline: 'Reconnecting to bridge…',
        sub: 'Bridge link is recovering — the agent keeps running, output resumes when the stream catches up.',
      }
    : {
        headline: 'Waiting for output…',
        sub: 'Subscribed; the agent is between writes.',
      };

  return (
    // 2026-05-24 mobile-responsive: switched from h-[calc(100vh-180px)] to
    // h-full so the pane respects its parent (ChatGrid's tab content area
    // on mobile, grid cell on desktop). The viewport math the prior fixed
    // calc tried to do was wrong on iPhone Safari portrait — it ignored
    // the MobileTabBar (64px + safe-area) and the URL bar collapse, so
    // the composer fell off-screen. The parent now owns height; we just
    // flex into it. min-h-0 lets the buffer + textarea flex without clip.
    <div className="flex flex-col h-full min-h-0 rounded-xl border border-white/[0.08] bg-black/60 overflow-hidden">
      {/* Header — flex-wrap on mobile so badges + Kill stack under the
          session-id line when the screen is too narrow. The min-w-0 on
          the title block keeps it truncating instead of forcing overflow.
          P2.1 cockpit-multi-session-v2 (2026-05-23). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 sm:px-4 py-2 border-b border-white/[0.06] bg-white/[0.02]">
        <div className="flex-1 min-w-0 basis-full sm:basis-auto">
          <div className="text-xs font-mono text-text-secondary truncate">
            session <code className="text-neon-cyan">{sessionId.slice(0, 8)}</code>
            {projectSlug && (
              <>
                {' · '}
                <code className="text-text-muted">{projectSlug}</code>
              </>
            )}
            {' · '}
            <span className="text-text-muted">{status}</span>
          </div>
        </div>
        {/* pane-header-badges — shared container. Each P1.x adds ONE badge.
            - SessionStateBadge (P0.6) + P1.4 onSpawnNew on ERROR state
            - SessionCostBadge (P1.3)  — $ · msgs · elapsed
            flex-wrap so badges stack on narrow viewports without
            overflowing the pane header. */}
        <div className="pane-header-badges flex flex-wrap gap-2 items-center">
          {/* P0.6 state-machine badge — single source of truth for the pane's
              transport status. P1.4 adds a "spawn new with same prompt"
              button when the badge spec opts in (crashed-session ERROR state). */}
          <SessionStateBadge
            state={sseState}
            onReload={manualReload}
            onSpawnNew={threadId ? spawnNewWithSamePrompt : undefined}
            spawningNew={spawningNew}
          />
          {/* P1.3 per-session cost badge — `$X.XX · N msgs · Mm` polled every
              30s via SWR. Aggregates from session-cost.json (bridge-proxied). */}
          <SessionCostBadge sessionId={sessionId} />
        </div>
        <button
          onClick={killSession}
          disabled={!isLive || killing}
          className="inline-flex items-center gap-1 px-2 min-h-[36px] sm:min-h-0 py-1 rounded-md text-[10px] font-mono border border-neon-red/30 text-neon-red hover:bg-neon-red/[0.08] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Kill session"
          aria-label="Kill session"
        >
          {killing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
          <span className="hidden sm:inline">Kill</span>
        </button>
      </div>

      {/* Terminal — xterm.js renders the PTY stream here (fix/cockpit-xterm-
          render). The container is the xterm mount target; FitAddon sizes the
          terminal to fill it. `relative` so the empty-state hint can overlay
          before the first byte arrives. p-2 gives the glyphs breathing room
          against the pane border without xterm computing odd cols. */}
      <div className="relative flex-1 min-h-0 overflow-hidden bg-black p-2">
        <div ref={termContainerRef} className="h-full w-full" />
        {/* V3 M6 — boot indicator. The Claude Code spawn takes 20–30s from
            session-create to first PTY byte; before this change a fresh pane
            sat blank or showed a faint italic hint in the corner, which JD
            read as "broken." Now: a centered spinner + "Booting agent…"
            block covering the whole pane until FIRST_LIVE_EVENT lands. The
            instant `hasOutput` flips true (first byte from the bridge), this
            overlay unmounts and the xterm output takes over.

            Wording is computed by `bootOverlayCopy` (just above the return).
            The fix/cockpit-restore-not-boot-on-return precedence (2026-05-30,
            JD's mobile cold-remount bug):
              hasPriorHistory       — established session, RETURNING. Restoring
                                      the transcript + reconnecting, NOT cold-
                                      booting → "Restoring session…". Never the
                                      "20–30s" copy.
              !historyChecked       — we haven't confirmed fresh-vs-established
                                      yet (the /history fetch hasn't resolved —
                                      e.g. still minting the stream token).
                                      Show NEUTRAL "Connecting…" — committing to
                                      "Booting agent… 20–30s" here would be the
                                      exact lie JD screenshotted.
              INITIAL / SYNCING     — CONFIRMED-FRESH spawn (history checked, no
                                      bytes). The 20–30s copy is reserved for
                                      THIS case only.
              RECONNECT / ERROR     — bridge dropped us; we're trying to recover.
              everything else       — connected, agent is between writes.
        */}
        {!hasOutput && (
          <div
            data-testid="pane-boot-indicator"
            data-restoring={hasPriorHistory ? 'true' : 'false'}
            data-history-checked={historyChecked ? 'true' : 'false'}
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-[1px]"
          >
            <Loader2 className="w-6 h-6 text-neon-cyan animate-spin" aria-hidden="true" />
            <div className="text-sm font-mono text-neon-cyan/90">
              {bootOverlayCopy.headline}
            </div>
            <div className="text-[10px] font-mono text-text-muted max-w-[28ch] text-center leading-snug">
              {bootOverlayCopy.sub}
            </div>
          </div>
        )}
        {/* Path-click toast (feat/v3-pane-clickable-links). Floats above the
            terminal at the bottom-center; auto-hides after 2s. pointer-events
            none so it never blocks a follow-on click into the terminal. */}
        {pathToast && (
          <div
            data-testid="path-click-toast"
            className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md text-[11px] font-mono text-neon-cyan bg-black/85 border border-neon-cyan/30 shadow-lg"
          >
            {pathToast}
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 text-[11px] font-mono text-neon-red bg-neon-red/[0.06] border-t border-neon-red/20 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="flex-1 truncate">{error}</span>
        </div>
      )}

      {/* Resumed toast (chat-resume-fix, 2026-05-24) — surfaces the
          transparent bridge resume so JD knows what happened. Auto-hides
          after 3.5s; click to dismiss. */}
      {resumedBadge && (
        <div
          data-testid="session-resumed-badge"
          onClick={dismissResumedBadge}
          className="px-4 py-2 text-[11px] font-mono text-neon-cyan bg-neon-cyan/[0.06] border-t border-neon-cyan/20 flex items-center gap-2 cursor-pointer"
          title={`Resumed from ${resumedBadge.from.slice(0, 8)} via ${resumedBadge.strategy || 'auto'}. Click to dismiss.`}
        >
          <PlugZap className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="flex-1 truncate">
            Session resumed —{' '}
            {resumedBadge.strategy === 'path1_claude_resume'
              ? 'restored full chat history from ' + resumedBadge.from.slice(0, 8)
              : 'restarted with project context from ' + resumedBadge.from.slice(0, 8)}
          </span>
        </div>
      )}

      {/* Receipt pill (feat/read-receipts, JD 2026-06-11) — Telegram-style:
          ✓ Delivered (bridge verified-submit) → ✓✓ Read (the agent's PTY
          echoed/worked the turn). Distinct from the LIVE/working badge in the
          header, which tracks the stream state, not this message. */}
      {receipt && (
        <div
          data-testid="session-read-receipt"
          data-receipt={receipt}
          className={`px-4 py-2 text-[11px] font-mono flex items-center gap-2 border-t ${
            receipt === 'read'
              ? 'text-neon-green/90 bg-neon-green/[0.05] border-neon-green/15'
              : 'text-neon-cyan/90 bg-neon-cyan/[0.05] border-neon-cyan/15'
          }`}
          title={
            receipt === 'read'
              ? 'The agent has read your message'
              : 'Delivered — the message submitted into the agent session'
          }
        >
          {receipt === 'read' ? (
            <CheckCheck className="w-3.5 h-3.5 flex-shrink-0" />
          ) : (
            <Check className="w-3.5 h-3.5 flex-shrink-0" />
          )}
          <span className="flex-1 truncate">
            {receipt === 'read' ? 'Read by agent' : 'Delivered'}
          </span>
        </div>
      )}

      {/* Thinking indicator (JD 2026-06-02) — Claude-Code-style "we're live and
          thinking" cue at the bottom. Driven by the output stream: shows while
          the agent is actively producing tokens, with an elapsed-seconds
          readout, and fades ~1s after output stops. Pure presence signal — it
          never blocks input (JD can still type to interrupt/queue). */}
      {thinking && (
        <div
          data-testid="session-thinking"
          className="px-4 py-2 text-[11px] font-mono text-neon-cyan bg-neon-cyan/[0.06] border-t border-neon-cyan/20 flex items-center gap-2"
          aria-live="polite"
        >
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neon-cyan/60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-neon-cyan" />
          </span>
          <span className="flex-1 truncate">Agent thinking…</span>
          {thinkingSince != null && (
            <span className="tabular-nums text-neon-cyan/60">
              {Math.max(0, Math.floor((Date.now() - thinkingSince) / 1000))}s
            </span>
          )}
        </div>
      )}

      {/* Input — chat-resume-fix (2026-05-24): allow typing into exited
          sessions. Bridge auto-resumes via /input route's 404-fallback;
          the OLD disabled-when-exited guard blocked the entire flow JD
          asked for ("type into a dead chat and have it just work"). */}
      {/* Composer — 2026-05-24 mobile-responsive:
            - text-base (16px) on mobile prevents iOS Safari auto-zooming
              on focus (Safari zooms inputs <16px which double-breaks layout).
            - min-h-[44px] on Send hits the iOS HIG touch-target spec.
            - pb-[env(safe-area-inset-bottom)] on the wrapper keeps the
              textarea above the iPhone home indicator on full-bleed pages.
            - The parent flex container (SessionTerminal root) is now h-full
              so the composer naturally sits at the bottom of whatever
              height the parent reserved; the MobileTabBar (rendered above
              in DashboardShell) lives in a separate layer with its own
              safe-area handling. */}
      {/* ── Interactive-menu controls (fix/cockpit-interactive-prompts) ──────
          Part B: when a Claude Code selection menu is detected on screen,
          render its options as TAPPABLE BUTTONS. Tapping sends the exact
          keystrokes (digit + Enter) to select that option — including the
          NON-default ones the chatbox could never reach.
          Part A: a raw-key control row (↑ ↓ Enter Esc) is ALWAYS available
          when the session is live, as the safety net for any TUI menu the
          detector misses. */}
      {isLive && (
        <div
          data-testid="pane-tui-controls"
          className="border-t border-neon-cyan/20 bg-neon-cyan/[0.03] px-3 py-2 space-y-2"
        >
          {menu && menu.options.length > 0 && (
            <div className="space-y-1.5" data-testid="pane-menu-options">
              {menu.prompt && (
                <p className="text-[11px] font-mono text-text-secondary truncate">
                  {menu.prompt}
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {menu.options.map((opt, idx) => (
                  <button
                    key={opt.number}
                    type="button"
                    onClick={() => tapOption(idx)}
                    disabled={keySending}
                    data-testid={`pane-menu-option-${opt.number}`}
                    title={`Select option ${opt.number}: ${opt.label}`}
                    className={`inline-flex items-center gap-1.5 max-w-full px-2.5 py-1.5 rounded-md text-[12px] font-mono border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      opt.selected
                        ? 'border-neon-cyan/50 text-neon-cyan bg-neon-cyan/[0.10]'
                        : 'border-white/15 text-text-primary bg-black/40 hover:border-neon-cyan/40 hover:text-neon-cyan'
                    }`}
                  >
                    <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-sm bg-white/10 text-[10px] font-bold">
                      {opt.number}
                    </span>
                    <span className="truncate">{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* Raw-key control row — always present when live (the unblock + the
              fallback when the menu detector misses a prompt). */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-text-muted mr-0.5">
              keys:
            </span>
            <button
              type="button"
              onClick={() => void sendKey([{ key: 'up' }])}
              disabled={keySending}
              data-testid="pane-key-up"
              title="Arrow up"
              aria-label="Menu arrow up"
              className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-white/15 bg-black/40 text-text-secondary hover:text-neon-cyan hover:border-neon-cyan/40 transition-colors disabled:opacity-40"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void sendKey([{ key: 'down' }])}
              disabled={keySending}
              data-testid="pane-key-down"
              title="Arrow down"
              aria-label="Menu arrow down"
              className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-white/15 bg-black/40 text-text-secondary hover:text-neon-cyan hover:border-neon-cyan/40 transition-colors disabled:opacity-40"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void sendKey([{ key: 'enter' }])}
              disabled={keySending}
              data-testid="pane-key-enter"
              title="Enter (confirm highlighted)"
              aria-label="Menu confirm (enter)"
              className="inline-flex items-center gap-1 px-2 h-8 rounded-md border border-white/15 bg-black/40 text-text-secondary hover:text-neon-cyan hover:border-neon-cyan/40 transition-colors disabled:opacity-40"
            >
              <CornerDownLeft className="w-3.5 h-3.5" />
              <span className="text-[11px] font-mono">Enter</span>
            </button>
            <button
              type="button"
              onClick={() => void sendKey([{ key: 'esc' }])}
              disabled={keySending}
              data-testid="pane-key-esc"
              title="Escape (cancel menu)"
              aria-label="Menu cancel (escape)"
              className="inline-flex items-center gap-1 px-2 h-8 rounded-md border border-white/15 bg-black/40 text-text-secondary hover:text-neon-red hover:border-neon-red/40 transition-colors disabled:opacity-40"
            >
              <XIcon className="w-3.5 h-3.5" />
              <span className="text-[11px] font-mono">Esc</span>
            </button>
            {keySending && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-neon-cyan ml-1" />
            )}
          </div>
        </div>
      )}

      <div className="border-t border-white/[0.06] bg-white/[0.02] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex gap-2 items-end">
          {/* M2 attach (📎) — uploads via /api/sessions/<sid>/upload, then
              injects the absolute disk_path into the input for the agent. */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || uploading}
            data-testid="pane-attach-button"
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 sm:w-9 sm:h-9 rounded-md border border-white/10 bg-black/40 text-text-secondary hover:text-neon-cyan hover:border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Attach file"
            title="Attach a file (the agent reads it from disk)"
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Paperclip className="w-4 h-4" />
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            data-testid="pane-attach-input"
            accept="image/*,application/pdf,.txt,.md,.csv,.json,.docx,.pptx,.xlsx,.py,.ts,.tsx,.js,.jsx,.yaml,.yml,.log"
            onChange={(e) => void handleAttachFiles(e.target.files)}
            className="hidden"
          />

          {/* M2 record (🎤) — shared VoiceRecorder; transcript lands in the
              input via handleTranscript (no auto-send). */}
          <div data-testid="pane-record-button" className="shrink-0">
            <VoiceRecorder
              onTranscript={handleTranscript}
              onError={(err) => setError(err.message)}
              disabled={sending || uploading}
              className="w-10 h-10 sm:w-9 sm:h-9"
            />
          </div>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={sending}
            placeholder={
              isLive
                ? 'Type and press Enter (Shift+Enter for newline)'
                : 'Type to resume session (will restart bridge PTY)'
            }
            rows={2}
            className="flex-1 resize-none rounded-md bg-black/40 border border-white/10 px-3 py-2 text-base sm:text-[12px] font-mono text-text-primary placeholder-text-muted focus:outline-none focus:border-neon-cyan/40 disabled:opacity-50"
          />
          <button
            onClick={() => void submitInput()}
            disabled={sending || !input.trim()}
            className="inline-flex items-center gap-1 px-3 py-2 min-h-[44px] sm:min-h-0 rounded-md text-xs font-mono font-medium border border-neon-cyan/30 text-neon-cyan bg-neon-cyan/[0.06] hover:bg-neon-cyan/[0.12] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Send"
          >
            {sending ? <Loader2 className="w-4 h-4 sm:w-3.5 sm:h-3.5 animate-spin" /> : <Send className="w-4 h-4 sm:w-3.5 sm:h-3.5" />}
            <span className="hidden sm:inline">Send</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * SessionStateBadge — the single state-machine-driven badge in the pane
 * header (P0.6). Replaces the prior StatusDot + SyncBadge pair.
 *
 * Renders one of 6 visual states per sseState.kind, mapping to the
 * BadgeSpec from sse-state.ts. RECONNECT shows live-elapsed time so JD
 * can tell "this just dropped, retrying" from "this has been stuck for
 * 30 seconds, something's really wrong." ERROR shows a reload button —
 * the explicit escape hatch per spec.
 *
 * The LIVE badge auto-hides its text label after 2s and renders dot-only
 * — tmux/zellij convention. (JD's pushback if the label stayed: "I don't
 * need 'live' permanently in my face, the green dot tells me.")
 */
function SessionStateBadge({
  state,
  onReload,
  onSpawnNew,
  spawningNew = false,
}: {
  state: SseState;
  onReload: () => void;
  /** cockpit-multi-session-v2 P1.4 — callback to spawn a new session with
   *  the SAME cwd + project_slug as the crashed one. Rendered as a button
   *  only when the badge spec opts in (showSpawnNew). Optional because
   *  some callers don't have a thread to attach the new session to. */
  onSpawnNew?: () => void;
  /** Loading state for the spawn-new button — keeps the click idempotent
   *  + gives the user a visible spinner during the bridge round-trip. */
  spawningNew?: boolean;
}) {
  const spec = badgeForState(state);
  const [now, setNow] = useState(() => Date.now());
  const [labelHidden, setLabelHidden] = useState(false);

  // Live elapsed timer for RECONNECT.
  useEffect(() => {
    if (!spec.showElapsed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [spec.showElapsed]);

  // LIVE label auto-hides after 2s — dot-only steady state.
  useEffect(() => {
    setLabelHidden(false);
    if (state.kind !== 'LIVE') return;
    const id = setTimeout(() => setLabelHidden(true), 2000);
    return () => clearTimeout(id);
  }, [state.kind, state.since]);

  // Color → Tailwind class. Kept inline so a future theme refactor only
  // touches this one map. P1.4 adds `red` for the crashed-session badge —
  // distinct from `magenta` (generic ERROR) so the user can tell apart
  // "stream cursor expired, hit reload" from "agent is dead, spawn new."
  const colorClass = ({
    gray: 'text-text-muted',
    cyan: 'text-neon-cyan',
    green: 'text-neon-green',
    amber: 'text-neon-amber',
    magenta: 'text-neon-magenta',
    red: 'text-neon-red',
  } as const)[spec.color];

  const Icon = ({
    spinner: Loader2,
    pulse: PlugZap,
    dot: PlugZap,
    check: CheckCircle2,
    alert: AlertCircle,
  } as const)[spec.icon];

  const isSpinner = spec.icon === 'spinner';
  const isPulse = spec.icon === 'pulse';

  const elapsedLabel = spec.showElapsed
    ? `${Math.max(0, Math.round((now - state.since) / 1000))}s`
    : '';

  return (
    <div
      data-testid="session-state-badge"
      data-state={state.kind}
      data-crashed={typeof state.crashedAt === 'number' ? 'true' : undefined}
      className={`inline-flex items-center gap-1 text-[11px] font-mono ${colorClass}`}
      title={state.error || `state: ${state.kind.toLowerCase()}`}
    >
      <Icon
        className={`w-3 h-3 ${isSpinner ? 'animate-spin' : ''} ${isPulse ? 'animate-pulse' : ''}`}
      />
      {!labelHidden && <span>{spec.label}</span>}
      {spec.showElapsed && <span className="text-text-muted">{elapsedLabel}</span>}
      {spec.showReload && (
        <button
          onClick={onReload}
          className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-neon-magenta/40 text-neon-magenta hover:bg-neon-magenta/[0.08] transition-colors"
          title="Reload — re-establish the stream from the current cursor"
        >
          <RefreshCcw className="w-2.5 h-2.5" />
          reload
        </button>
      )}
      {spec.showSpawnNew && onSpawnNew && (
        <button
          data-testid="spawn-new-button"
          onClick={onSpawnNew}
          disabled={spawningNew}
          className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-neon-red/40 text-neon-red hover:bg-neon-red/[0.08] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Spawn a new Claude session in the same cwd + project as the crashed one"
        >
          {spawningNew ? (
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
          ) : (
            <RefreshCcw className="w-2.5 h-2.5" />
          )}
          spawn new
        </button>
      )}
    </div>
  );
}

// ── SessionCostBadge ──────────────────────────────────────────────────────
//
// Per-session cost badge in the pane header (P1.3, cockpit-multi-session-v2,
// 2026-05-23). Shows `$X.XX · N msgs · Mm` polled every 30s via SWR.
//
// Why JD asked for it: "I can't see which sessions are burning budget."
// Now there's a per-pane $ figure that updates as the session runs, so
// when a Claude Code session goes off the rails JD can identify the
// offender at a glance instead of grepping cost-tracker logs.
//
// Data source: `/api/sessions/{sid}/costs` → bridge → session-cost.json
// (regenerated every 5 min by `scripts/claude-code-usage.py`). The 30s
// SWR poll is much faster than the 5-min cron, but that's fine — when
// the cron hasn't fired yet, we just keep showing the last-known value.
//
// Render decisions:
//   - Width-stable: always renders 3 segments (cost · msgs · elapsed)
//     so the header doesn't jitter when values change.
//   - Neutral color when `source: "unmatched"` (no cc-data yet) — distinct
//     from a real $0.00 reading.
//   - Tabular numerals (`tabular-nums`) so digits don't shift width.
//   - 11px font, monospace — matches SessionStateBadge for visual harmony.
//   - Tooltip explains "$X.XX · N messages · Mm session age." Helps when
//     JD's hovering trying to remember what each field means.

interface SessionCostsResponse {
  cost_usd: number;
  msgs: number;
  elapsed_min: number;
  source: 'matched' | 'unmatched';
}

const costFetcher = async (url: string): Promise<SessionCostsResponse> => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    // Return zeros on auth/proxy failure so the badge degrades to "$0.00 ·
    // 0 msgs · 0m" rather than disappearing. Real errors (badge stuck at
    // zero for a known-active session) are spotted via the wider monitoring
    // stack, not this widget.
    return { cost_usd: 0, msgs: 0, elapsed_min: 0, source: 'unmatched' };
  }
  return (await res.json()) as SessionCostsResponse;
};

function SessionCostBadge({ sessionId }: { sessionId: string }) {
  const { data } = useSWR<SessionCostsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/costs`,
    costFetcher,
    {
      refreshInterval: 30_000,
      revalidateOnFocus: true,
      // No throw on error — fetcher already returns safe zeros.
      shouldRetryOnError: true,
      errorRetryInterval: 60_000,
    }
  );

  const cost = data?.cost_usd ?? 0;
  const msgs = data?.msgs ?? 0;
  const elapsedMin = data?.elapsed_min ?? 0;
  const isMatched = data?.source === 'matched';

  // Format dollars with $ + 2 decimals. < $0.01 still shows "$0.00" rather
  // than scientific notation. Cap display at $9999.99 (4 digits) to keep
  // header width bounded; real sessions rarely exceed $100 but jay's
  // long-running ones occasionally do.
  const dollarStr = `$${cost.toFixed(2)}`;
  const colorClass = isMatched ? 'text-neon-green' : 'text-text-muted';
  const tooltip = isMatched
    ? `Cost-to-date: $${cost.toFixed(4)} · ${msgs} message${msgs === 1 ? '' : 's'} · ${elapsedMin}m session age`
    : 'Cost data not yet available — session-cost.json regenerates every 5min';

  return (
    <div
      data-testid="session-cost-badge"
      data-source={data?.source ?? 'loading'}
      className={`inline-flex items-center gap-1 text-[11px] font-mono tabular-nums ${colorClass}`}
      title={tooltip}
    >
      <DollarSign className="w-3 h-3" />
      <span>{dollarStr}</span>
      <span className="text-text-muted">·</span>
      <span>{msgs} msgs</span>
      <span className="text-text-muted">·</span>
      <span>{elapsedMin}m</span>
    </div>
  );
}
