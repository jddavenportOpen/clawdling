'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ChatGrid — multi-pane wrapper for Chat Cockpit.
//
// M1 v0: single-pane mode only.
// M2 v1: 1/2/3/4/6 responsive layouts, focus management (Tab cycle),
//        Cmd+K palette, mobile tabs fallback, capacity toast.
// V3.2 (2026-05-28, JD msgs 8280+8285): two RENDER modes for the same deck.
//   chat (DEFAULT) — one focused chat fills the canvas; others are
//                    hidden-but-mounted so streams keep running.
//                    Mental model: ChatGPT / Claude.ai tabs.
//   pane           — the existing multi-pane grid (opt-in).
//   Mode is selected via the toolbar toggle + persisted to localStorage
//   `chat-cockpit.mode`. URL `?mode=` wins on initial render. Both modes
//   share the same `?panes=` deck — switching modes never kills a stream.
//   "Add to pane" button per pane head (toolbar icon) is a no-op when the
//   sid is already in the deck (the common case) and surfaces a toast
//   offering to switch to pane mode. Mobile is chat-mode only.
//
// URL state contract:
//   /chat                       → no grid; renders launcher landing
//   /chat?panes=sid1            → 1 pane (mode defaults to chat)
//   /chat?panes=sid1,sid2…      → up to 10 panes; 11th rejected
//   /chat?...&mode=chat|pane    → render mode (default chat)
//   /chat?...&focus=<sid>       → in chat mode: the visible chat
//                                  in pane mode: the maximized pane
//
// The URL IS the source of truth — refresh restores. Server is stateless
// about composition.
//
// Hotkeys:
//   Tab   — cycle focus to next pane
//   ⇧+Tab — cycle focus to previous pane
//   ⌘/⌃+K — open quick-switch palette (PaneSwitcher)
//   ⌘/⌃+J — fallback if K conflicts with browser (rare)
//
// Mobile (< md): single visible pane; horizontal tab strip at the top
// switches between panes (no grid tiling). Mode toggle is hidden on mobile
// (pane mode is desktop-only).
//
// (see docs/ARCHITECTURE.md)
// This file: mode-toggle + chat-mode render branch + cockpitMode.ts.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ChatGridPane from './ChatGridPane';
import NewSessionPicker from './NewSessionPicker';
import PaneSwitcher, { type PanePalette } from './PaneSwitcher';
import {
  type CockpitMode,
  parseModeParam,
  getStoredMode,
  setStoredMode,
  resolveInitialMode,
  DEFAULT_MODE,
} from '@/lib/cockpitMode';
import { getDomain } from '@/config/domains';
import { PANE_SOFT_CAP } from '@/lib/cockpitCaps';
import { HAMBURGER } from '@/lib/chatChrome';
// Warm Graphite ds foundation — bespoke icon wrapper (no Unicode emoji in chrome).
import { Icon } from '@/components/ds/Icon';
import { X as XGlyph, Circle } from '@phosphor-icons/react/dist/ssr';
import {
  resolveSpaceDeck,
  persistSpaceDeck,
  writeDeckCache,
} from '@/lib/spaceDeck';

// C5 (R-Cockpit, no-cap, 2026-06-10): the deck is now UNBOUNDED — "many open
// Claude Codes, all organized, from the GUI." MAX_PANES stops being a hard
// "max 10" refusal and becomes a SOFT RENDER BUDGET sourced from the single
// shared PANE_SOFT_CAP (src/lib/cockpitCaps.ts), so the three append paths
// (here, ThreadSidebar.openSidInDeck, ThreadSidebar.openInGrid) can never drift
// to different numbers again (they used to be 10 / 10 / 6 — the chat-cockpit
// audit §4 #3 flagged the mismatch). Every pane stays MOUNTED regardless of
// count (chat mode hides all but the visible one via display:none; their SSE
// streams keep running), so a big fleet is performant — only one xterm paints
// at a time in chat mode. The real ceiling is the box's PTY limit, surfaced via
// CapacityPill, not this constant. Behavior for decks of <=10 is unchanged
// (PANE_SOFT_CAP >> 10, so no <=10 deck ever hits the clamp).
//
// History: 2026-05-03 bumped 6 → 10 per the "100x productivity / 10+ parallel
// chat sessions" vision; 2026-06-10 removed the cap entirely per the
// infinity-agents ethos.
const MAX_PANES = PANE_SOFT_CAP;
// LS_LAST_PANES — storage contract
//   Key:   'chat-cockpit.last-panes' on window.localStorage
//   Value: comma-separated list of session ids (no leading/trailing spaces),
//          e.g. "sid_abc123,sid_def456". Max MAX_PANES entries.
//   Write: on every URL `?panes=` change (existing useEffect below).
//   Read:  ONCE on cold mount in the restore effect — only when no
//          `?panes=` query is present. URL wins if both exist.
//   Quota/corrupt: read/write are wrapped in try/catch; on any failure
//          (QuotaExceededError, disabled storage, JSON-shaped garbage, etc.)
//          we silently fall through to the launcher. We never surface a
//          storage error toast — losing pane history is annoying but not
//          alarming. P0.5 of cockpit-multi-session-v2 (2026-05-23).
const LS_LAST_PANES = 'chat-cockpit.last-panes';
const TOAST_TTL_MS = 3500;
// Longer TTL for the cold-restore notice so JD has time to read and
// dismiss it (it carries an "X dismiss" affordance). 5s per spec.
const RESTORED_TOAST_TTL_MS = 5000;

// ── PaneDescriptor (audit HIGH #1+#2 root-cause fix, 2026-05-27) ──────────
// Carries the REAL session state per pane — not synthesized defaults. Every
// creation site MUST source `status` + `threadId` from the actual session row
// (bridge `/api/sessions/list` enriched response, or the launcher/spawn API
// response which returns the same shape).
//
// Why this matters:
//   • `status` flows into SessionTerminal's `initialStatus`, which gates
//     `seedHistoryTail` at SessionTerminal.tsx:475-484. If we hardcode 'live'
//     for a dead session, the gate fires the wrong branch and the /history
//     replay is silently dropped → JD's msg-8136 "history of each panel isnt
//     saved when you go back and forth back into old chats" lands on prod
//     despite PR #102 claiming to fix it.
//   • `threadId` flows into SessionTerminal's "Spawn new with same prompt"
//     crash-recovery button. If null, the button is silently hidden. PR #97
//     papered over this with a per-pane `/api/sessions/list` useEffect inside
//     ChatGridPane, but that races against the user's first interaction
//     (sub-second). Hoisting it into the descriptor closes the race.
//
// Source-of-truth decision (push-back response): we trust the Supabase
// `chat_sessions.status` column (DB-truth) as the descriptor seed value,
// surfaced via `/api/sessions/list` (and `/api/threads/[id]/session` for the
// single-thread lookup in ThreadSidebar). The bridge `running` set is
// separate (`live: boolean`) and only confirms PTY-aliveness — it doesn't
// override DB status. After mount, SessionTerminal's SSE stream is the
// real-time source of truth via `onStatusChange`. The descriptor only needs
// to be CORRECT AT MOUNT so the history-replay gate fires the right branch.
interface PaneDescriptor {
  sid: string;
  title: string;
  /** DB chat_sessions.status seed — 'live' | 'starting' | 'exited' | 'crashed' |
   *  'error' | string. SessionTerminal mirrors this into `initialStatus`. */
  status: string;
  /** Supabase chat_sessions.thread_id for this session. Null when the pane was
   *  launched without a backing thread (rare — ad-hoc preview paths) or when
   *  resolution failed; SessionTerminal hides the recovery button in that case. */
  threadId: string | null;
  /** True once `status` + `threadId` have been resolved from a real source
   *  (launcher response, spawn API, or fetchSessionMeta). Until then we render
   *  a placeholder instead of mounting <ChatGridPane>, because SessionTerminal
   *  reads `initialStatus` via useRef ONCE at mount — mounting with the wrong
   *  status (e.g. 'live' for a dead session) would gate seedHistoryTail down
   *  the wrong branch and the history paint would be silently dropped (JD
   *  msg 8136 root cause).
   *
   *  For paths that KNOW the status at creation (handleLaunched, handleResumed)
   *  this is true immediately. For URL-seed / LS-restore / URL-reconcile paths,
   *  it flips true after the batched fetchSessionMeta call. */
  metaResolved: boolean;
  addedAt: number;
  /** Bridge waiting-signal for this session: 'working' | 'waiting' | 'idle' |
   *  null. Drives the tab's NEEDS-YOU cue — the dot goes amber+pulse when
   *  'waiting' (agent finished a turn, blocked on JD). Resolved from
   *  /api/sessions/list alongside status/title (W9 named-live-tabs). Null
   *  until resolved or when the session isn't live. */
  activity: string | null;
}

/**
 * Resolve a human tab label for a session from its meta. Strict precedence
 * (first non-empty wins) — W9 named-live-tabs spec §1, extended by
 * feat/cockpit-naming-history with the auto-generated TITLE:
 *   1. domain      → DOMAINS label ("Work", "Notes") — the domain brains
 *                    (a fixed brain keeps its domain name; a per-chat title
 *                    would be noise on a continuity brain).
 *   2. title       → the auto-generated 3-5 word chat title (ChatGPT-style;
 *                    derived from the first real human turns, cached by the
 *                    bridge). Null until the chat has >= 2 real turns.
 *   3. agent_name  → trimmed, non-empty (project name, ad-hoc CEO summary)
 *   4. cwd basename → "<state-root>", "<project-slug>"
 *   5. "Session"   → last-resort literal; NEVER the sid hash (the sid hash IS
 *                    the bug this whole change kills — this last step is honest
 *                    and visually distinct so a missing-name regression is
 *                    VISIBLE in QA instead of masquerading as the old hash).
 *
 * Pure + exported via __chatGridInternals__ for unit tests.
 */
function resolveTabLabel(meta: {
  domain?: string | null;
  title?: string | null;
  agent_name?: string | null;
  cwd?: string | null;
}): string {
  const domainLabel = meta.domain ? getDomain(meta.domain)?.label : undefined;
  if (domainLabel) return domainLabel;
  const title = meta.title?.trim();
  if (title) return title;
  const name = meta.agent_name?.trim();
  if (name) return name;
  if (meta.cwd && meta.cwd.trim()) return basenameOf(meta.cwd);
  return 'Session';
}

/**
 * Fetch real status + thread_id for a set of sids from the user's recent
 * sessions feed. Single batched call — no per-pane fan-out. Best-effort.
 *
 * STATE-TRUTH SPINE (CAT-01, 2026-06-12): `status` is derived from the bridge
 * `live` flag, NOT the (possibly stale) DB `chat_sessions.status`. A row whose
 * DB status reads 'live' but whose PTY the bridge no longer reports as running
 * resolves to 'exited' — same logic the live activity poll uses below. A sid
 * the feed never returns is NOT present in the map at all; the resolver treats
 * that absence as 'exited' (the bridge has never heard of it — reaped, expired,
 * corrupt deep-link), instead of the old optimistic 'live' default that lit a
 * LYING green "Done · your turn" pill on a dead pane.
 *
 * Used by: cold-mount URL parse, LS restore reconciler, URL-reconcile effect.
 */
interface ResolvedMeta {
  status: string;
  threadId: string | null;
  /** Resolved human label (domain → agent_name → cwd → "Session"); never the
   *  sid hash. W9 named-live-tabs. */
  title: string;
  /** Bridge waiting-signal: 'working' | 'waiting' | 'idle' | null. */
  activity: string | null;
}

/**
 * Resolve the descriptor `status` for one pane from its feed meta + the
 * previously-seeded status. PURE so the spine derivation is a pinned contract
 * (see ChatGrid.test.tsx) instead of logic buried in an effect.
 *
 * Contract (CAT-01):
 *   - meta present + live      → the bridge/DB status ('live' or whatever it
 *                                 reports) — a genuinely live session STAYS live.
 *   - meta present + not live  → 'exited' (DB row exists but PTY is dead).
 *   - meta ABSENT (undefined)  → 'exited' — the bridge never heard of this sid
 *                                 (reaped / expired / corrupt link). NEVER keep
 *                                 the optimistic 'live' seed. This is the bug.
 *
 * `prevStatus` is honored only for the one case the feed can't speak to: a sid
 * still in flight to the bridge whose seed is the transient 'starting' (a fresh
 * spawn the feed hasn't indexed yet) — we don't flip THAT to dead on the first
 * resolution race; the poll corrects it within a tick once the feed catches up.
 */
function resolvePaneStatus(
  meta: ResolvedMeta | undefined,
  prevStatus: string
): string {
  if (meta) return meta.status;
  // Absent from the feed. A just-spawned 'starting' sid may simply not be
  // indexed yet — keep it so we don't flash Stopped on a booting session; the
  // poll re-resolves it. Anything else absent is genuinely unknown → exited.
  if (prevStatus === 'starting') return 'starting';
  return 'exited';
}

/**
 * CAT-20 / CODE-STATE BUG-9 (2026-06-12) — resume sid-swap bookkeeping.
 *
 * `handleResumed(oldSid, newSid)` swaps a dead pane's sid for the freshly-live
 * one the bridge minted. Two shapes:
 *   - SWAP: newSid is NOT already a pane → the old pane keeps its slot, sid
 *     repointed in place. Index unchanged; focus moves old→new.
 *   - DROP (`alreadyHasNew`): newSid is ALREADY a pane → the old pane is
 *     REMOVED. This must mirror handleRemove's bookkeeping, which the original
 *     code did NOT: mobileVisibleIdx could point past the end (the mobile
 *     single-pane view yanks JD to a different chat) and a focused dead pane
 *     that resumes-into-an-existing one left focusedSid dangling at a sid no
 *     longer in panes (the focus-collapse grid renders blank).
 *
 * Pure so the index/focus contract is regression-pinned without rendering the
 * whole grid. `nextLen` is the pane count AFTER the swap/drop.
 */
function resolveResumeBookkeeping(args: {
  oldSid: string;
  newSid: string;
  alreadyHasNew: boolean;
  nextLen: number;
  mobileVisibleIdx: number;
  focusedSid: string | null;
}): { mobileVisibleIdx: number; focusedSid: string | null } {
  const { oldSid, newSid, alreadyHasNew, nextLen, mobileVisibleIdx, focusedSid } =
    args;
  // Clamp the mobile index into range ONLY when a pane was removed (the DROP
  // branch); the SWAP branch keeps the same number of panes at the same slots.
  const nextIdx = alreadyHasNew
    ? Math.min(mobileVisibleIdx, Math.max(0, nextLen - 1))
    : mobileVisibleIdx;
  // Repoint focus old→new in BOTH shapes: SWAP → the focused pane now lives at
  // newSid; DROP → the old pane is gone, collapse focus onto the surviving
  // newSid pane. No-op when focus wasn't on the old pane.
  const nextFocused = focusedSid === oldSid ? newSid : focusedSid;
  return { mobileVisibleIdx: nextIdx, focusedSid: nextFocused };
}

async function fetchSessionMeta(
  sids: string[]
): Promise<Map<string, ResolvedMeta>> {
  const out = new Map<string, ResolvedMeta>();
  if (sids.length === 0) return out;
  try {
    const res = await fetch('/api/sessions/list', {
      method: 'GET',
      cache: 'no-store',
    });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      sessions?: Array<{
        id: string;
        status?: string | null;
        // Bridge truth: is a PTY actually running for this sid right now? The
        // DB `status` can read 'live' on a row whose PTY already died; `live`
        // is the authority (CAT-01).
        live?: boolean | null;
        thread_id?: string | null;
        // W9 named-live-tabs: name + activity inputs.
        agent_name?: string | null;
        domain?: string | null;
        cwd?: string | null;
        activity?: string | null;
        // feat/cockpit-naming-history: auto-generated chat title (cached;
        // null until the chat has real turns). Highest label precedence after
        // the fixed domain name.
        title?: string | null;
      }>;
    };
    for (const s of data.sessions ?? []) {
      if (!s.id) continue;
      // CAT-01 spine: derive status from the bridge `live` flag, mirroring the
      // live activity poll below. A not-live row → 'exited' so the pill can't
      // lie green on a dead pane. A live row keeps its reported status (or
      // 'live' when the DB status is blank). This is identical to the poll's
      // `s.live ? status||'live' : 'exited'`.
      const status = s.live
        ? typeof s.status === 'string' && s.status
          ? s.status
          : 'live'
        : 'exited';
      out.set(s.id, {
        status,
        threadId: s.thread_id ?? null,
        title: resolveTabLabel({
          domain: s.domain,
          title: s.title,
          agent_name: s.agent_name,
          cwd: s.cwd,
        }),
        // Activity only meaningful while live.
        activity: s.live ? s.activity ?? null : null,
      });
    }
  } catch {
    // network blip — return whatever we have (often empty); caller falls back.
  }
  return out;
}

function parsePanesParam(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_PANES);
}

/** Test-only exports — see src/components/chat/__tests__/ChatGrid.test.tsx.
 *  Keeping the symbols private at runtime; the test imports them via this
 *  named-namespace object so the ChatGrid component module stays a default
 *  export with no new public surface. */
export const __chatGridInternals__ = {
  parsePanesParam,
  MAX_PANES,
  LS_LAST_PANES,
  // V3.1 V2.2 ultrawide regression guards (2026-05-28). These pure helpers
  // own the grid-cols + font-tier contract; exposing them lets the vitest
  // suite assert breakpoint-conditioned class output and ultrawide font
  // bumps without rendering the whole component tree.
  gridClassFor,
  fontSizeForPaneCount,
  // V3.2 mode-toggle exports (2026-05-28, JD msgs 8280+8285). Re-exported
  // so the ChatGrid test file can assert mode-resolution behavior alongside
  // the rest of the grid contract without a second module-level mock.
  parseModeParam,
  resolveInitialMode,
  DEFAULT_MODE,
  // W9 named-live-tabs: pure tab-label resolver. The vitest suite pins the
  // domain → agent_name → cwd → "Session" precedence + the never-a-hash
  // guarantee without rendering the component.
  resolveTabLabel,
  // CAT-01 state-truth spine: pure status resolver. The vitest suite pins the
  // {known-live, unknown, 404/reaped, exited} derivation so a dead/unknown sid
  // can never again default to the optimistic 'live' that lit a lying pill.
  resolvePaneStatus,
  // CAT-20 resume sid-swap bookkeeping: pure (clamp index, repoint focus)
  // resolver. Pinned so the `alreadyHasNew` DROP branch can't again leave
  // mobileVisibleIdx past the end or focusedSid dangling at a removed sid.
  resolveResumeBookkeeping,
};

function basenameOf(p: string): string {
  if (!p) return 'session';
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) || 'root' : trimmed;
}

/**
 * Layout class for N panes on desktop.
 *
 * Standard desktop (md+, up to 1799px viewport):
 *   1     → full
 *   2     → 50/50
 *   3     → 33/33/33 single row
 *   4     → 2x2
 *   5–6   → 2x3 (3 cols × 2 rows)
 *   7–8   → 2x4 (4 cols × 2 rows)
 *   9     → 3x3 (3 cols × 3 rows)
 *   10    → 2x5 (5 cols × 2 rows)
 *
 * Ultrawide (3xl breakpoint, ≥1800px — V3.1 V2.2 2026-05-28). On a 21:9 or
 * 32:9 monitor (3440x1440, 2560x1080, 5120x1440, etc.) the extra horizontal
 * room makes the standard 4x2 cramped — wider columns + fewer rows is the
 * "side-by-side ideal pattern" JD references in msg 8122. Per-N overrides:
 *   1     → full (same)
 *   2     → 2x1 (same — already wide)
 *   3     → 3x1 (same — already wide)
 *   4     → 4x1 (NEW: collapse to one row, each pane ~640px on 2560 wide)
 *   5–6   → 3x2 (same row count; panes get ~850px wide vs ~480px on 1440)
 *   7–8   → 4x2 (same — canonical V2.2 target per PRD line 41)
 *   9     → 5x2 (NEW: from 3x3, exploits width for shorter pane heights)
 *   10    → 5x2 (same)
 *
 * Mobile (<md) ignores grid mode; the tab strip is rendered instead so
 * pane width never collapses below readable.
 *
 * Why Option A (Tailwind breakpoint) over Option B (JS viewport measurement):
 *   • Pure CSS — no SSR/CSR hydration mismatch, no ResizeObserver overhead,
 *     no flicker on first paint, no re-renders on browser zoom/resize.
 *   • Tailwind v4 makes adding `3xl:1800px` trivial (one line in globals.css
 *     @theme block).
 *   • Idiomatic — the existing grid already uses `md:` responsive classes.
 *   Option B was reserved for the font-size tier (see fontSizeForPaneCount)
 *   because that prop is a NUMBER, not a CSS class.
 */
function gridClassFor(n: number): string {
  if (n <= 1) return 'grid grid-cols-1 grid-rows-1';
  if (n === 2) return 'grid grid-cols-1 md:grid-cols-2 grid-rows-1';
  if (n === 3) return 'grid grid-cols-1 md:grid-cols-3 grid-rows-1';
  // ── iter-7 (2026-05-28) CSS specificity tie-break ──────────────────────────
  // The `3xl:` utilities below MUST carry the `!` important flag. Reason:
  // Tailwind v4 emits utilities into the bundle in an order that does NOT
  // track our source-string order — third-party audit caught the prod bundle
  // shipping `.md\:grid-cols-2` AT BYTE OFFSET 132832, AFTER
  // `.\33 xl\:grid-cols-4` at offset 130653. Both selectors have equal
  // specificity (single class), so at any viewport ≥1800px where BOTH the
  // `(min-width:768px)` and `(min-width:1800px)` media queries match, the
  // CASCADE picks the source-later rule → `md:grid-cols-2` wins → N=4
  // ultrawide silently fell back to 2x2 instead of the spec's 4x1, and N=9
  // ultrawide silently fell back to 3x3 instead of the spec's 5x2.
  //
  // The `!` makes the 3xl declaration `!important`, beating any
  // equal-specificity later rule regardless of emission order. Tailwind v4
  // syntax: trailing `!` on the utility (e.g. `3xl:grid-cols-4!`).
  // Needed so ultrawide (4-pane) layouts pack correctly.
  // Regression guard: ChatGrid.test.tsx asserts BOTH the class string carries
  // `!` AND (jsdom-stub branch) the computed CSS column count after media
  // query resolution. Class-string-only assertions missed this bug for a
  // full iteration cycle; the computed-style assertion is the real safety net.
  if (n === 4)
    return 'grid grid-cols-1 md:grid-cols-2 grid-rows-1 md:grid-rows-2 3xl:grid-cols-4! 3xl:grid-rows-1!';
  if (n <= 6) return 'grid grid-cols-1 md:grid-cols-3 grid-rows-1 md:grid-rows-2';
  if (n <= 8) return 'grid grid-cols-1 md:grid-cols-4 grid-rows-1 md:grid-rows-2';
  if (n === 9)
    return 'grid grid-cols-1 md:grid-cols-3 grid-rows-1 md:grid-rows-3 3xl:grid-cols-5! 3xl:grid-rows-2!';
  return 'grid grid-cols-1 md:grid-cols-5 grid-rows-1 md:grid-rows-2'; // 10
}

/**
 * v3 pane-readability (2026-05-27, revised after JD msg 8131) — xterm font
 * size by pane count, plus V3.1 V2.2 ultrawide bump (2026-05-28).
 *
 * Standard desktop (<1800px):
 *   1-2 panes  → 15px (JD's main pain: even TWO panes side-by-side were
 *                unreadable at 13px on his desktop browser. At 2 panes the
 *                pane is ~688px wide on 1440px viewports — plenty of room
 *                for 15px without sacrificing the 80-col target).
 *   3-4 panes  → 13px (modest bump from 12. At 4 panes a pane is ~459px;
 *                14px would cut col count too aggressively, 13px preserves
 *                ~53 cols while still feeling more readable than 12).
 *   5-6 panes  → 12px (was 11. At 5-6 the grid is genuinely crowded so the
 *                taper engages — but 11 was eye-strain territory).
 *   7-10 panes → 12px (floor for the tiers; at this density JD has the
 *                stage-mode roadmap V2.3 anyway).
 *   Focus mode → 16px (was 13. Full-bleed pane deserves the biggest tier;
 *                ~152 cols at 1376px wide so no col-count cost).
 *
 * Ultrawide (≥1800px, V3.1 V2.2 2026-05-28): bump each tier by +1px. The
 * grid widens columns at this breakpoint (gridClassFor adds `3xl:` overrides)
 * so panes are physically larger, AND ultrawide monitors are typically 34"+
 * which means users sit further away. Both reasons compound:
 *   1-2 panes  → 16px (was 15)
 *   3-4 panes  → 14px (was 13)
 *   5-6 panes  → 13px (was 12)
 *   7-10 panes → 13px (was 12)
 *   Focus mode → 17px (was 16)
 *   Floor      → 10px in SessionTerminal stays as defensive safety net.
 *
 * Detection: `useIsUltrawide()` hook below — viewport width via matchMedia
 * `(min-width: 1800px)`. SSR-safe (defaults to false on server; settles to
 * the real value on the first client effect tick). Matching threshold to
 * the Tailwind `3xl:` breakpoint keeps grid + font in lockstep.
 *
 * JD msg 8131 (2026-05-27 20:55): "btw doesnt even work with just two, I
 * cant tell whats going on." Original tiers (PR #99) scaled DOWN from a
 * baseline of 13 to fix density; the real bug was the baseline itself
 * was too small for desktop browsers. New tiers raise the floor + only
 * scale down when crowding actually forces it.
 */
function fontSizeForPaneCount(
  n: number,
  isFocused: boolean,
  isUltrawide: boolean = false
): number {
  if (isFocused) return isUltrawide ? 17 : 16;
  if (n <= 2) return isUltrawide ? 16 : 15;
  if (n <= 4) return isUltrawide ? 14 : 13;
  return isUltrawide ? 13 : 12;
}

/**
 * V3.1 V2.2 (2026-05-28) — viewport-width hook for ultrawide font-tier
 * bumping. Returns true when `window.innerWidth >= 1800` (matches the
 * Tailwind `3xl:` breakpoint at globals.css). SSR-safe: returns false on
 * the server + during the first client render; flips to the real value
 * on the first useEffect tick + tracks subsequent resizes via matchMedia.
 *
 * Why a hook (Option B) here when the grid uses pure Tailwind (Option A):
 * the xterm font size is a numeric `fontSize` PROP passed into
 * ChatGridPane → SessionTerminal, NOT a CSS class. There's no CSS-only path
 * to swap a JS-prop value at a breakpoint, so JS measurement is necessary
 * for THIS axis. The grid columns themselves stay pure CSS (no hook needed
 * for column count).
 */
function useIsUltrawide(): boolean {
  const [isUltrawide, setIsUltrawide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(min-width: 1800px)');
    const update = () => setIsUltrawide(mql.matches);
    update();
    // addEventListener is the modern API; older Safari needs addListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
      return () => mql.removeEventListener('change', update);
    } else if (typeof (mql as MediaQueryList).addListener === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      mql.addListener(update);
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      return () => mql.removeListener(update);
    }
  }, []);
  return isUltrawide;
}

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error';
  /** If true, render an "X" dismiss control. Defaults to false. */
  dismissible?: boolean;
  /** Override the default TOAST_TTL_MS auto-dismiss window. */
  ttlMs?: number;
}

export default function ChatGrid() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const panesParam = searchParams.get('panes');
  // v3 pane-readability (2026-05-27): ?focus=<sid> persists which pane is
  // maximized so the URL is bookmarkable + survives full reload. Read once
  // on initial render; subsequent updates flow through setFocusedSid below
  // which writes the URL via router.replace.
  const focusParam = searchParams.get('focus');
  // V3.2 (2026-05-28): ?mode=chat|pane render mode. SSR-safe initial value
  // comes from the URL alone (no localStorage on the server); the cold-mount
  // effect below upgrades to stored-pref when URL is silent.
  const modeParam = searchParams.get('mode');
  // r-cockpit C2: ?space=<id> activates SPINE-BACKED deck persistence. When a
  // Space is active the deck source of truth is the cockpit spine (durable,
  // cross-device, survives a bridge restart); localStorage is a write-through
  // cache. When no Space is active the deck stays localStorage-only as before
  // (the legacy 'chat-cockpit.last-panes' key). null ⇒ no Space ⇒ legacy path.
  const spaceParam = searchParams.get('space');
  const activeSpace = spaceParam && spaceParam.trim().length > 0 ? spaceParam.trim() : null;

  const initialSids = useMemo(() => parsePanesParam(panesParam), [panesParam]);
  // Initial seed: descriptors START with `metaResolved: false`. The
  // URL-reconcile effect below fires fetchSessionMeta() in the next tick and
  // flips them to resolved with the REAL status + threadId. Until then a
  // placeholder renders in place of <ChatGridPane> so SessionTerminal isn't
  // mounted with a wrong-status initialStatus that would mis-fire seedHistoryTail.
  // (Audit HIGH #1 root-cause fix, 2026-05-27.)
  const [panes, setPanes] = useState<PaneDescriptor[]>(() =>
    initialSids.map((sid) => ({
      sid,
      // W9: seed the loading ellipsis, NOT the sid hash. The meta-resolution
      // effect snaps this to the real name (domain/agent_name/cwd) within the
      // same sub-second window that resolves status. The tab never shows a hash.
      title: '…',
      status: 'live',
      threadId: null,
      metaResolved: false,
      addedAt: Date.now(),
      activity: null,
    }))
  );
  const [activeSid, setActiveSid] = useState<string | null>(
    initialSids[0] || null
  );
  const [modalOpen, setModalOpen] = useState(false);
  // Focus mode (PR-D): sid of the pane maximized to fill the Stage, or null.
  // v3 pane-readability (2026-05-27): seeded from ?focus= and written back
  // to URL via the effect below so the maximized pane survives reload + is
  // shareable. Only valid when the focused sid is also in `panes`; else null.
  const [focusedSid, setFocusedSidState] = useState<string | null>(
    focusParam && initialSids.includes(focusParam) ? focusParam : null
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Mobile tab mode tracking — visible pane index for narrow viewports.
  const [mobileVisibleIdx, setMobileVisibleIdx] = useState(0);
  // V3.2 (2026-05-28): cockpit render mode. SSR seed = URL only (matches
  // ?panes= precedence). The cold-mount effect below upgrades to the
  // stored pref when URL is silent. URL writes via setCockpitMode below.
  const [mode, setModeState] = useState<CockpitMode>(() =>
    resolveInitialMode(modeParam, null)
  );

  // V3.1 V2.2 ultrawide adaptive grid (2026-05-28) — viewport-aware font
  // tier. The grid columns themselves use Tailwind's `3xl:` breakpoint
  // (pure CSS, no JS), but fontSize is a numeric prop so we need a hook
  // for that axis.
  const isUltrawide = useIsUltrawide();

  const toastIdRef = useRef(0);

  const pushToast = useCallback(
    (
      text: string,
      kind: Toast['kind'] = 'info',
      opts?: { dismissible?: boolean; ttlMs?: number }
    ) => {
      toastIdRef.current += 1;
      const id = toastIdRef.current;
      const ttlMs = opts?.ttlMs ?? TOAST_TTL_MS;
      setToasts((prev) => [
        ...prev,
        { id, text, kind, dismissible: opts?.dismissible, ttlMs },
      ]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, ttlMs);
    },
    []
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Cold-mount restore from localStorage ────────────────────────────────
  // P0.5 cockpit-multi-session-v2 (2026-05-23): when the user opens /chat
  // with no `?panes=` query (i.e. bookmark, fresh tab, browser restart),
  // hydrate the deck from LS_LAST_PANES. Validates surviving sids against
  // `/api/sessions/list` so dead sessions don't render "session 404" cards.
  //
  // Runs ONCE per component mount via the ref guard. URL changes after
  // mount go through the OTHER useEffect (which both writes LS and
  // reconciles state). If the URL ALREADY has `?panes=`, we never touch
  // localStorage on mount — the URL is the source of truth for that case.
  const restoreAttemptedRef = useRef(false);
  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;

    // URL wins. parsePanesParam handles null/empty/whitespace.
    const fromUrl = parsePanesParam(panesParam);
    if (fromUrl.length > 0) return;

    let cancelled = false;

    async function restoreFromStorage() {
      let savedSids: string[] = [];
      // r-cockpit C2: when a Space is active, the deck source of truth is the
      // SPINE (durable, survives a bridge restart + leaving the screen + crosses
      // devices). resolveSpaceDeck prefers the durable deck and falls back to the
      // localStorage cache when the spine is down or empty — and seeds the spine
      // from the cache on first-ever Space load (one-time migration). When no
      // Space is active we keep the legacy localStorage-only path verbatim.
      let deckSource: 'spine' | 'cache' = 'cache';
      if (activeSpace) {
        try {
          const resolved = await resolveSpaceDeck(activeSpace);
          savedSids = parsePanesParam(resolved.deck.join(','));
          deckSource = resolved.source;
          if (savedSids.length === 0) return;
        } catch {
          // resolveSpaceDeck never throws, but be defensive.
          return;
        }
      } else {
        try {
          const raw = window.localStorage.getItem(LS_LAST_PANES);
          if (!raw) return;
          savedSids = parsePanesParam(raw);
          if (savedSids.length === 0) return;
        } catch {
          // localStorage disabled / corrupt / SecurityError — fall through silently.
          return;
        }
      }

      // Validate sids against the bridge's known set (running + resumable +
      // recent exited from chat_sessions). /api/sessions/list returns this
      // user's most-recent 30 — sids older than that won't restore, which
      // is fine (stale deck from weeks ago is rarely worth resurrecting).
      // On any failure of the validation call we restore ALL saved sids
      // best-effort; SessionTerminal will surface real errors per-pane.
      let validSids = savedSids;
      try {
        const res = await fetch('/api/sessions/list', {
          method: 'GET',
          cache: 'no-store',
        });
        if (res.ok) {
          const data = (await res.json()) as {
            sessions?: Array<{ id: string }>;
          };
          const known = new Set(
            (data.sessions ?? []).map((s) => s.id).filter(Boolean)
          );
          if (known.size > 0) {
            validSids = savedSids.filter((sid) => known.has(sid));
          }
        }
      } catch {
        // network blip / bridge unreachable — keep savedSids, best effort.
      }

      if (cancelled) return;
      if (validSids.length === 0) {
        // Saved sids all gone — silently clear so we don't keep trying.
        try {
          window.localStorage.removeItem(LS_LAST_PANES);
        } catch {
          /* ignore */
        }
        return;
      }

      // We already hit /api/sessions/list above to validate sids — reuse that
      // response to seed status + threadId so we don't fan out a second fetch.
      // Best-effort: if a sid isn't in the feed (e.g. older than the 30-row
      // cap), we mount with metaResolved=false and the URL-reconcile effect
      // will retry the lookup.
      const meta = await fetchSessionMeta(validSids);
      const restored: PaneDescriptor[] = validSids.map((sid) => {
        const m = meta.get(sid);
        return {
          sid,
          // W9: resolved name from meta, or "…" until the URL-reconcile retry
          // resolves it (sid not in the feed). NEVER the sid hash.
          title: m?.title ?? '…',
          // CAT-01 / ADV-2: never seed the optimistic 'live' for a restored sid
          // the feed doesn't know — resolve through the spine helper so a since-
          // died sid in the saved deck comes back 'exited', not a lying green
          // pane. When m is present this is the live-flag-derived status; when
          // absent it's 'exited' AND metaResolved=false (placeholder renders,
          // the URL-reconcile retry confirms via resolvePaneStatus).
          status: resolvePaneStatus(m, 'live'),
          threadId: m?.threadId ?? null,
          metaResolved: m !== undefined,
          addedAt: Date.now(),
          activity: m?.activity ?? null,
        };
      });
      setPanes(restored);
      setActiveSid(restored[0]?.sid || null);
      setMobileVisibleIdx(0);

      // Push to URL without a navigation (replace, no scroll). The
      // panesParam-keyed effect below will see the new value and write
      // LS again — harmless idempotent re-save.
      try {
        const sp = new URLSearchParams(window.location.search);
        sp.set('panes', validSids.join(','));
        const qs = sp.toString();
        router.replace(`/chat${qs ? `?${qs}` : ''}`, { scroll: false });
      } catch {
        /* router unavailable in some test environments — UI still works */
      }

      pushToast(
        // Honest source: a Space deck restored from the durable spine vs the
        // local cache. Plain "from last visit" for the legacy no-Space path.
        deckSource === 'spine'
          ? `restored ${restored.length} pane${restored.length === 1 ? '' : 's'} from this Space (synced)`
          : `restored ${restored.length} pane${restored.length === 1 ? '' : 's'} from last visit`,
        'info',
        { dismissible: true, ttlMs: RESTORED_TOAST_TTL_MS }
      );
    }

    void restoreFromStorage();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ONE-SHOT on cold mount.

  // Reconcile when URL changes externally. Also fires the meta-resolution
  // pass for any descriptor that still has metaResolved=false (the cold-mount
  // initial useState + any new sid the back-button drops into the URL).
  useEffect(() => {
    const sids = parsePanesParam(panesParam);
    setPanes((prev) => {
      const byId = new Map(prev.map((p) => [p.sid, p]));
      return sids.map(
        (sid) =>
          byId.get(sid) || {
            sid,
            // W9: ellipsis placeholder, not the sid hash. Resolved by the
            // meta-resolution effect below (it patches title from the feed).
            title: '…',
            status: 'live',
            threadId: null,
            metaResolved: false,
            addedAt: Date.now(),
            activity: null,
          }
      );
    });
    if (sids.length > 0 && !sids.includes(activeSid || '')) {
      setActiveSid(sids[0]);
      setMobileVisibleIdx(0);
    } else if (sids.length === 0) {
      setActiveSid(null);
      setMobileVisibleIdx(0);
    }
    if (sids.length > 0) {
      try {
        localStorage.setItem(LS_LAST_PANES, sids.join(','));
      } catch {
        /* localStorage may be disabled — fine */
      }
      // r-cockpit C2: when a Space is active, WRITE THROUGH to the spine so the
      // deck is durable (survives a bridge restart + leaving the screen) and
      // cross-device. localStorage above stays the instant-paint cache; the
      // per-Space cache key is also refreshed so the next cold mount of THIS
      // Space paints from the same truth. persistSpaceDeck soft-degrades (no-op
      // on spine outage) so deck edits never block on the spine — the cache
      // holds and the spine re-syncs on the next change.
      if (activeSpace) {
        writeDeckCache(activeSpace, sids);
        void persistSpaceDeck(activeSpace, sids, { focus: focusParam ?? sids[0] ?? null });
      }
    }
    // v3 pane-readability — reconcile focus URL → state. If ?focus= names
    // a pane that's no longer open, drop it (the writeUrl helper also
    // strips it on pane remove, but back-button could resurrect a stale
    // value). Don't loop: only update state when it diverges.
    if (focusParam && sids.includes(focusParam)) {
      setFocusedSidState((cur) => (cur === focusParam ? cur : focusParam));
    } else {
      setFocusedSidState((cur) => (cur === null ? cur : null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panesParam, focusParam]);

  // ── Meta-resolution effect (audit HIGH #1+#2 root-cause fix) ────────────
  // For every pane whose descriptor is still metaResolved=false (cold-mount
  // from URL, back-button into a new sid, or LS-restore that missed the
  // batched lookup), fire ONE batched /api/sessions/list call and patch the
  // descriptors with their real status + threadId. Until this resolves, the
  // render path below renders a placeholder instead of <ChatGridPane> so
  // SessionTerminal isn't mounted with a wrong-status initialStatus that
  // would mis-fire the seedHistoryTail gate at SessionTerminal.tsx:475-484.
  //
  // Dedup: an in-flight ref so simultaneous mount + URL-reconcile don't
  // double-fetch. Re-runs only when the SET of unresolved sids changes —
  // never on every render.
  //
  // ── Iter-3 deadlock fix (2026-05-27) ──────────────────────────────────
  // The previous implementation had a `let cancelled = false;` + cleanup
  // `cancelled = true` pair. The deadlock trace:
  //   1. Cold-mount render 0: panes=[{metaResolved:false}] from useState.
  //   2. URL-reconcile effect (dep [panesParam, focusParam]) calls
  //      setPanes returning a NEW array reference (Map.get-ed descriptors
  //      wrapped in a fresh .map() result).
  //   3. Meta-resolution effect (dep [panes]) fires: starts fetch, sets
  //      metaFetchInFlightRef.current = key, captures cancelled1=false.
  //   4. URL-reconcile commit → panes reference flips → effects re-run.
  //   5. Meta-resolution cleanup: cancelled1 = true. New run sees ref ===
  //      key → BAIL. No new fetch starts.
  //   6. Original fetch resolves: `if (cancelled1) return;` → bails.
  //      setPanes NEVER runs. Ref NEVER reset. Deadlocked. Placeholder
  //      stays forever. JD msg 8136 made WORSE (whole pane never appears).
  //
  // Fix (Option B): drop the cancelled flag. setPanes's callback already
  // filters on `p.metaResolved` (line 513) — so multiple completing
  // fetches all call setPanes, but only the FIRST one actually mutates
  // (subsequent ones return the same descriptor refs → React shallow-bails
  // the commit). Zero orphaned closures, smaller diff than Option A.
  // The dedup ref still prevents redundant network calls during the same
  // unresolved-sid set. Regression guard: ChatGrid.test.tsx cold-mount.
  const metaFetchInFlightRef = useRef<string | null>(null);
  useEffect(() => {
    const unresolved = panes.filter((p) => !p.metaResolved).map((p) => p.sid);
    if (unresolved.length === 0) return;
    const key = unresolved.slice().sort().join(',');
    if (metaFetchInFlightRef.current === key) return;
    metaFetchInFlightRef.current = key;

    void (async () => {
      const meta = await fetchSessionMeta(unresolved);
      setPanes((prev) =>
        prev.map((p) => {
          if (p.metaResolved) return p;
          const m = meta.get(p.sid);
          // CAT-01 spine: resolve status through resolvePaneStatus, NOT the old
          // `m?.status ?? p.status` (which kept the optimistic 'live' seed for
          // any sid the feed never returned → a LYING green "Done · your turn"
          // pill + enabled composer on a dead/reaped/unknown sid). A sid absent
          // from the feed is one the bridge has never heard of → 'exited'. We
          // still mark resolved + mount the pane (refusing to render forever is
          // worse); SessionTerminal's seedHistoryTail then fires the dead-branch
          // and paints whatever /history it can (JD-msg-8136 case preserved).
          // A genuinely live row keeps 'live' — we do NOT swing false-DEAD.
          return {
            ...p,
            status: resolvePaneStatus(m, p.status),
            threadId: m?.threadId ?? p.threadId,
            // W9: snap the tab label to the resolved name. If the sid wasn't in
            // the feed, m is undefined → keep "…" (better than the hash); the
            // pane still mounts (metaResolved=true) on the optimistic default.
            title: m?.title ?? p.title,
            activity: m?.activity ?? p.activity,
            metaResolved: true,
          };
        })
      );
      // Reset the in-flight ref so a future render with new unresolved sids
      // (e.g. back-button adds a sid to the URL) can fire fresh. If the ref
      // was already overwritten by a parallel run for a different key, leave
      // that newer key in place.
      if (metaFetchInFlightRef.current === key) {
        metaFetchInFlightRef.current = null;
      }
    })();
    // No cleanup. The setPanes callback is idempotent; orphaning the closure
    // is impossible because we never start a second concurrent fetch for the
    // same key (dedup ref above). If `panes` re-renders mid-fetch, the
    // re-entry hits the dedup bail-out and we just wait for the in-flight
    // resolution to land.
  }, [panes]);

  // ── Live activity poll (cockpit-chat-ux, 2026-06-02) ────────────────────
  // The agent STATE pill (Thinking… / Done / Stopped) is JD's #1 ask. Its
  // ONLY honest data source is the bridge's live session activity, surfaced
  // by /api/sessions/list as per-session { live, status, activity }
  // (working|waiting|idle). fetchSessionMeta resolves these ONCE at mount and
  // never again, so a pane that starts 'working' would show "Thinking…"
  // forever. This single shared poll re-reads the list every few seconds and
  // patches `status` + `activity` on the matching descriptors. ONE call for
  // the whole deck (not one-per-pane) — same endpoint ChatGrid already uses.
  //
  // We only patch panes that are already metaResolved (don't race the
  // resolution effect) and only when a value actually changed (shallow-bail
  // otherwise so we don't churn React or yank the transcript). Bridge truth
  // wins over the optimistic 'live' default; a session the feed reports as
  // not-live becomes 'exited' so the pill can show "Stopped".
  const POLL_MS = 3500;
  useEffect(() => {
    const sids = panes.filter((p) => p.metaResolved).map((p) => p.sid);
    if (sids.length === 0) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch('/api/sessions/list', {
          method: 'GET',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          sessions?: Array<{
            id: string;
            status?: string | null;
            live?: boolean;
            activity?: string | null;
            // feat/cockpit-naming-history: cached auto-title + label inputs so
            // the poll can refresh a tab's label the moment a title resolves.
            title?: string | null;
            domain?: string | null;
            agent_name?: string | null;
            cwd?: string | null;
          }>;
        };
        if (cancelled) return;
        const byId = new Map(
          (data.sessions ?? []).map((s) => [s.id, s] as const)
        );
        setPanes((prev) => {
          let changed = false;
          const next = prev.map((p) => {
            if (!p.metaResolved) return p;
            const s = byId.get(p.sid);
            if (!s) return p;
            // Bridge truth: live flag drives status; activity drives the pill.
            const nextStatus = s.live
              ? typeof s.status === 'string' && s.status
                ? s.status
                : 'live'
              : 'exited';
            const nextActivity = s.live ? s.activity ?? null : null;
            // feat/cockpit-naming-history: recompute the label so a freshly
            // generated title swaps the tab from "CEO agent" to the real name.
            // resolveTabLabel falls back gracefully when title is still null.
            const nextTitle = resolveTabLabel({
              domain: s.domain,
              title: s.title,
              agent_name: s.agent_name,
              cwd: s.cwd,
            });
            if (
              nextStatus === p.status &&
              nextActivity === p.activity &&
              nextTitle === p.title
            ) {
              return p;
            }
            changed = true;
            return { ...p, status: nextStatus, activity: nextActivity, title: nextTitle };
          });
          return changed ? next : prev;
        });
      } catch {
        /* network blip — keep last-known state, next tick retries */
      }
    };

    void poll();
    const t = setInterval(() => {
      // Pause polling while the tab is hidden (saves bridge calls; SSE/visibility
      // catchup in SessionTerminal re-syncs on return anyway).
      if (typeof document !== 'undefined' && document.hidden) return;
      void poll();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // Re-key on the SET of resolved sids (stable string), not the array ref,
    // so the interval isn't torn down on every unrelated pane re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes.filter((p) => p.metaResolved).map((p) => p.sid).sort().join(',')]);

  // ── Auto-title generation trigger (feat/cockpit-naming-history) ──────────
  // The list poll above only surfaces CACHED titles. SOMETHING has to TRIGGER
  // the bridge to generate one. This slow poll GETs /api/sessions/{sid}/title
  // for each open pane — the bridge reads the session transcript (NEVER injects
  // anything), generates a 3-5 word title once the chat has >= 2 real turns,
  // and caches it. We stop polling a pane once it has a real (non-pending)
  // title cached. Slow cadence (every 20s) since titling is one-and-done — the
  // generated title then flows into the tab via the list poll's label refresh.
  const TITLE_POLL_MS = 20_000;
  useEffect(() => {
    const sids = panes.filter((p) => p.metaResolved && p.status !== 'exited').map((p) => p.sid);
    if (sids.length === 0) return;
    let cancelled = false;
    // Per-sid latch: once a sid resolves a real (non-pending) title we stop
    // poking it. Lives for the lifetime of this effect (re-keyed on the sid set).
    const resolved = new Set<string>();

    const tick = async () => {
      for (const sid of sids) {
        if (cancelled || resolved.has(sid)) continue;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/title`, {
            method: 'GET',
            cache: 'no-store',
          });
          if (!r.ok) continue;
          const body = (await r.json()) as { title?: string; pending?: boolean };
          if (body.pending === false && body.title) {
            resolved.add(sid);
          }
        } catch {
          /* network blip — retry next tick */
        }
      }
    };

    void tick();
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void tick();
    }, TITLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes.filter((p) => p.metaResolved).map((p) => p.sid).sort().join(',')]);

  const writeUrl = useCallback(
    (nextPanes: PaneDescriptor[]) => {
      const sp = new URLSearchParams(window.location.search);
      if (nextPanes.length === 0) {
        sp.delete('panes');
      } else {
        sp.set('panes', nextPanes.map((p) => p.sid).join(','));
      }
      // Drop stale ?focus= if it no longer matches an open pane.
      const fp = sp.get('focus');
      if (fp && !nextPanes.some((p) => p.sid === fp)) {
        sp.delete('focus');
      }
      const qs = sp.toString();
      router.replace(`/chat${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [router]
  );

  // ── V3.2 mode-toggle (2026-05-28, JD msgs 8280+8285) ───────────────────
  // setCockpitMode is the ONLY caller path for mode changes — writes state,
  // localStorage, AND the URL so refresh/bookmark survives. URL wins on
  // initial render (see resolveInitialMode); the cold-mount effect below
  // hydrates the URL-silent case from localStorage so a returning power-user
  // who prefers pane mode lands in pane mode without typing a URL.
  const setCockpitMode = useCallback(
    (next: CockpitMode) => {
      setModeState(next);
      setStoredMode(next);
      try {
        const sp = new URLSearchParams(window.location.search);
        // Only write the param when non-default so default chat-mode URLs
        // stay clean (`/chat?panes=sid` instead of `/chat?panes=sid&mode=chat`).
        // The parser treats absent ?mode= as 'chat' so semantics are identical.
        if (next === DEFAULT_MODE) {
          sp.delete('mode');
        } else {
          sp.set('mode', next);
        }
        const qs = sp.toString();
        router.replace(`/chat${qs ? `?${qs}` : ''}`, { scroll: false });
      } catch {
        /* router unavailable in some test environments — state still updates */
      }
    },
    [router]
  );

  // Cold-mount: hydrate mode from localStorage when URL is silent. URL wins;
  // we only fill in the default-vs-pane gap. Runs once via ref guard.
  const modeRestoredRef = useRef(false);
  useEffect(() => {
    if (modeRestoredRef.current) return;
    modeRestoredRef.current = true;
    // If the URL already named a mode, the initial useState already settled it.
    if (modeParam) return;
    const stored = getStoredMode();
    // Only flip state when stored differs from the SSR-seeded default; avoids
    // a redundant render when the user has never changed mode.
    if (stored !== mode) {
      setModeState(stored);
      // Don't write URL on cold mount — keep the bare `/chat?panes=…` shape
      // and let the user-visible toggle write `?mode=pane` if they switch.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ONE-SHOT.

  // Reconcile URL mode changes (back button, manual edit) → state.
  useEffect(() => {
    const next = parseModeParam(modeParam);
    if (next !== mode) setModeState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeParam]);

  // v3 pane-readability (2026-05-27): setFocusedSid is the ONLY caller path
  // for focus changes — wraps the underlying state setter and mirrors the
  // value into ?focus= so the URL is the source of truth (bookmarkable,
  // shareable, survives reload). Pass null to exit focus mode.
  //
  // V3.2 (2026-05-28): in chat mode this also drives the visible chat (the
  // ChatGrid render branch reads visibleSid which prefers focusedSid over
  // activeSid). In pane mode it's still the maximize toggle.
  const setFocusedSid = useCallback(
    (next: string | ((cur: string | null) => string | null) | null) => {
      setFocusedSidState((cur) => {
        const resolved = typeof next === 'function' ? next(cur) : next;
        try {
          const sp = new URLSearchParams(window.location.search);
          if (resolved) sp.set('focus', resolved);
          else sp.delete('focus');
          const qs = sp.toString();
          router.replace(`/chat${qs ? `?${qs}` : ''}`, { scroll: false });
        } catch {
          /* router unavailable in some test environments — state still updates */
        }
        // V2.1 setLastMode tracker removed in V3.2 (2026-05-28) — the
        // chrome-level Chat/Pane toggle subsumes the last-used pref.
        return resolved;
      });
    },
    [router]
  );

  const handleLaunched = useCallback(
    (sessionId: string, newThreadId: string, cwd: string) => {
      // Launcher response IS authoritative — spawn API guarantees status='live'
      // + the thread_id it just associated. metaResolved=true so we skip the
      // /api/sessions/list lookup that would otherwise fire on mount. (Audit
      // HIGH #2 fix: PR #97's ChatGridPane-internal threadId fetch race is
      // eliminated by carrying threadId in the descriptor from creation.)
      setPanes((prev) => {
        // C5 no-cap: PANE_SOFT_CAP is effectively unbounded, so this is a
        // DEFENSIVE clamp against a runaway/corrupt deck, not a UI refusal at
        // 10. A human-driven fleet never hits it; if it ever does, the box's
        // PTY ceiling (CapacityPill) is the honest limit, not this number.
        if (prev.length >= MAX_PANES) {
          pushToast(
            `Deck is at the ${MAX_PANES}-session safety limit — close one to add another`,
            'warn'
          );
          return prev;
        }
        const next: PaneDescriptor[] = [
          ...prev,
          {
            sid: sessionId,
            // W9: seed from cwd via the shared resolver (domain dir → label,
            // else basename → "<state-root>" / project slug). The just-spawned
            // session's agent_name (e.g. "CEO agent") lands in the DB but isn't
            // in this callback's args; the tab is still a clean NAME, never a
            // hash, and the rail/⌘K reflect the stored agent_name.
            title: cwd ? resolveTabLabel({ cwd }) : 'Session',
            status: 'live',
            threadId: newThreadId || null,
            metaResolved: true,
            addedAt: Date.now(),
            activity: null,
          },
        ];
        writeUrl(next);
        return next;
      });
      setActiveSid(sessionId);
      setMobileVisibleIdx(panes.length); // newly added is the last index after append
      setModalOpen(false);
    },
    [panes.length, pushToast, writeUrl]
  );

  // A dead pane resumed into a NEW bridge sid (via SessionTerminal's /input
  // 404-fallback). Swap the old sid → new sid IN PLACE: update the pane's
  // sid, the ?panes= URL, localStorage and activeSid, all via React state +
  // router.replace. No full reload — every OTHER pane stays mounted and keeps
  // streaming, preserving the "as if I wasn't looking at it" guarantee. The
  // pane whose sid changed re-mounts on its new key and reconnects to the
  // live resumed session. cockpit overhaul 2026-05-26.
  const handleResumed = useCallback(
    (oldSid: string, newSid: string) => {
      if (!newSid || oldSid === newSid) return;
      setPanes((prev) => {
        // Guard: if the new sid is somehow already a pane, just drop the old.
        const alreadyHasNew = prev.some((p) => p.sid === newSid);
        // Resume returns a freshly-live sid on the SAME thread → threadId
        // unchanged, status='live', metaResolved=true. The pane re-mounts on
        // its new key + SessionTerminal sees the correct initialStatus.
        const next = alreadyHasNew
          ? prev.filter((p) => p.sid !== oldSid)
          : prev.map((p) =>
              p.sid === oldSid
                ? { ...p, sid: newSid, status: 'live', metaResolved: true }
                : p
            );
        writeUrl(next);
        // CAT-20 / CODE-STATE BUG-9: in the `alreadyHasNew` DROP branch the old
        // pane is REMOVED, so its mobileVisibleIdx must be clamped (mirror
        // handleRemove) or the mobile single-pane view yanks JD to a different
        // chat. resolveResumeBookkeeping owns the (clamp index, repoint focus)
        // contract — pure + unit-pinned so this can't silently regress.
        if (alreadyHasNew) {
          setMobileVisibleIdx((idx) =>
            resolveResumeBookkeeping({
              oldSid,
              newSid,
              alreadyHasNew,
              nextLen: next.length,
              mobileVisibleIdx: idx,
              focusedSid: null,
            }).mobileVisibleIdx
          );
        }
        return next;
      });
      setActiveSid((cur) => (cur === oldSid ? newSid : cur));
      // Repoint focus old→new in BOTH shapes (SWAP: focused pane now at newSid;
      // DROP: old pane gone → collapse onto the surviving newSid pane).
      // setFocusedSid mirrors into ?focus= so the URL stays the source of truth
      // — without this the maximized/focused grid renders blank (no pane matches
      // the dangling oldSid). No-op when focus≠oldSid.
      setFocusedSid((cur) =>
        resolveResumeBookkeeping({
          oldSid,
          newSid,
          alreadyHasNew: false, // index already handled above; only focus here
          nextLen: 0,
          mobileVisibleIdx: 0,
          focusedSid: cur,
        }).focusedSid
      );
    },
    [writeUrl, setFocusedSid]
  );

  const handleRemove = useCallback(
    (sid: string) => {
      setPanes((prev) => {
        const next = prev.filter((p) => p.sid !== sid);
        writeUrl(next);
        if (activeSid === sid) {
          setActiveSid(next[0]?.sid || null);
        }
        // Keep mobile index in range.
        setMobileVisibleIdx((idx) => Math.min(idx, Math.max(0, next.length - 1)));
        return next;
      });
    },
    [activeSid, writeUrl]
  );

  // ── Hotkeys: Tab cycle, ⌘+K palette, ⌘+J fallback ───────────────────────
  useEffect(() => {
    if (panes.length === 0) return;

    function isInTextInput(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return (
        tag === 'input' ||
        tag === 'textarea' ||
        el.isContentEditable === true
      );
    }

    function onKey(e: KeyboardEvent) {
      // ⌘/⌃ + K (or J fallback) opens the palette regardless of focus.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 'k' || e.key === 'K' || e.key === 'j' || e.key === 'J')
      ) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      // Tab cycle — only when NOT inside a text input (so the user can
      // still tab inside SessionTerminal's input, Composer, etc.). Use
      // Alt+Tab equivalent: hold Alt to bypass and cycle anyway.
      if (e.key === 'Tab') {
        if (isInTextInput(e.target) && !e.altKey) return;
        // Don't intercept if any modal is open.
        if (modalOpen || paletteOpen) return;
        e.preventDefault();
        setActiveSid((current) => {
          if (!current) return panes[0]?.sid || null;
          const idx = panes.findIndex((p) => p.sid === current);
          if (idx < 0) return panes[0]?.sid || null;
          const dir = e.shiftKey ? -1 : 1;
          const nextIdx = (idx + dir + panes.length) % panes.length;
          const nextSid = panes[nextIdx]?.sid || current;
          // Sync mobile visible index too.
          setMobileVisibleIdx(nextIdx);
          return nextSid;
        });
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, paletteOpen, panes]);

  // Esc exits Focus mode → back to the grid (PR-D).
  useEffect(() => {
    if (!focusedSid) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocusedSid(null);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [focusedSid]);

  // Empty grid → modal still mountable.
  if (panes.length === 0) {
    return (
      <NewSessionPicker
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onLaunched={handleLaunched}
        hasOpenPanes={false}
        mode="projects"
      />
    );
  }

  const atCapacity = panes.length >= MAX_PANES;
  const palette: PanePalette[] = panes.map((p) => ({
    sid: p.sid,
    title: p.title,
    status: p.status,
  }));
  // Clamp the mobile-visible index in case panes shrank (close/remove).
  const visibleIdx = Math.min(mobileVisibleIdx, Math.max(0, panes.length - 1));

  // V3.2 (2026-05-28) chat-mode "visible chat" resolution:
  //   1. focusedSid if it points at a real pane (URL `?focus=` survives reload)
  //   2. activeSid (the last-clicked / Tab-cycled pane)
  //   3. fallback to panes[0]
  // The visible chat is the ONLY pane that renders at full size in chat mode;
  // the others stay mounted (display:none) so their streams keep running.
  const visibleSid =
    (focusedSid && panes.some((p) => p.sid === focusedSid) && focusedSid) ||
    (activeSid && panes.some((p) => p.sid === activeSid) && activeSid) ||
    panes[0]?.sid ||
    null;

  return (
    <div className="flex flex-col h-full bg-canvas">
      {/* Toolbar — pl-12 on mobile to clear the fixed hamburger at top-left,
          pr-12 on mobile to clear the fixed needs-you bell at top-right (the
          icon-only "Alert me" glyph at max-md). Desktop has the sidebar + the
          full bell pill in their own chrome, so md:pl-3/md:pr-3 revert exactly.

          FIX #2 (critic round-1): the WHOLE toolbar was still on the legacy
          neutral/cyan palette (the canvas-pane chrome the four restyle commits
          never reached). Re-faced to Warm Graphite: surface-1 chrome bar +
          hairline edge, mono telemetry in text-3, NO cyan anywhere.

          V3.2 (2026-05-28, JD msgs 8280+8285): segmented Chat/Pane toggle
          sits between the pane-count and the right-side actions. Hidden on
          mobile — pane mode is desktop-only; mobile is chat-mode forever
          (single pane visible + tab strip). */}
      {/* CAT-23 (2026-06-12): the left reserve clearing the fixed hamburger now
          DERIVES from the shared HAMBURGER geometry token (was a magic pl-14
          hand-tied to the hamburger's left-2 + w-11 — a resize would silently
          clip the "N chats" label). pl-14 (56px) = left-2 (8px) + w-11 (44px) +
          ~4px gutter; md:pl-3 because desktop has no hamburger. */}
      <div className={`shrink-0 flex items-center justify-between gap-3 ${HAMBURGER.contentReserveClass} pr-12 md:pr-3 py-2 border-b border-hairline bg-surface-1`}>
        <div className="text-[11px] text-3 font-mono tabular flex items-center gap-3 min-w-0">
          <span className="whitespace-nowrap">
            {panes.length} {mode === 'chat' ? 'chat' : 'pane'}{panes.length === 1 ? '' : 's'}
            {atCapacity && (
              <span className="ml-2 text-state-attention">· safety limit</span>
            )}
          </span>
          <span className="hidden md:inline text-4 truncate">
            {mode === 'chat'
              ? 'click chat in rail to switch · Tab to cycle'
              : '⌘K to switch · Tab to cycle'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* chat-session mobile pass (2026-06-10, header reflow): on a phone
              the full Claude+Kimi+Mini telemetry strip overflowed the 390px row
              and clipped off the right edge. At max-md we collapse to a SINGLE
              compact ACTIVE-model chip (the dot + "Claude" — every cockpit
              session is a Claude Code session, so Claude IS the active model),
              reusing the exact Circle glyph + chip styling from UsagePanel so
              there is no new emoji and the warm-graphite tokens carry through.
              The full telemetry below is hidden <md and restored byte-for-byte
              at md:. */}
          <span
            data-testid="usage-active-mobile"
            title="Claude — active model"
            className="md:hidden inline-flex items-center gap-1.5 rounded-md border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] font-mono tabular leading-none whitespace-nowrap text-3"
          >
            <Icon glyph={Circle} state="active" size={8} aria-hidden />
            <span aria-hidden>Claude</span>
          </span>
          {/* V3.2 mode toggle — segmented Chat / Pane control. Desktop only;
              hidden <md so mobile users stay in chat mode (pane grid would
              be unreadable on a phone). data-testid hooks for the e2e suite. */}
          {/* FIX #2 — segmented control on the surface ladder: the SELECTED
              segment lifts to surface-3 (lighter = elevated) + text-1, NOT a
              cyan fill. Selection is read by luminance, not a competing hue. */}
          <div
            role="group"
            aria-label="Cockpit render mode"
            data-testid="cockpit-mode-toggle"
            className="hidden md:inline-flex items-stretch rounded-md border border-border-default bg-surface-2 overflow-hidden text-[11px] font-mono weight-label"
          >
            <button
              type="button"
              data-testid="cockpit-mode-chat"
              onClick={() => {
                if (mode !== 'chat') setCockpitMode('chat');
              }}
              aria-pressed={mode === 'chat'}
              title="Chat mode — one chat visible, others run in background"
              className={`px-2.5 py-1 transition-colors duration-[var(--dur-micro)] ${
                mode === 'chat'
                  ? 'bg-surface-3 text-1'
                  : 'text-3 hover:text-1 hover:bg-surface-3/60'
              }`}
            >
              Chat
            </button>
            <button
              type="button"
              data-testid="cockpit-mode-pane"
              onClick={() => {
                if (mode !== 'pane') setCockpitMode('pane');
              }}
              aria-pressed={mode === 'pane'}
              title="Pane mode — multi-agent grid view"
              className={`px-2.5 py-1 border-l border-border-default transition-colors duration-[var(--dur-micro)] ${
                mode === 'pane'
                  ? 'bg-surface-3 text-1'
                  : 'text-3 hover:text-1 hover:bg-surface-3/60'
              }`}
            >
              Pane
            </button>
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden md:inline text-[11px] font-mono weight-label px-2.5 py-1 rounded-md text-3 hover:text-1 hover:bg-surface-3 border border-border-default bg-surface-2 transition-colors duration-[var(--dur-micro)]"
            title="Quick-switch panes (⌘K)"
          >
            ⌘K
          </button>
          <button
            type="button"
            onClick={() => {
              // C5 no-cap: only the defensive safety limit can block a spawn
              // (a human-driven fleet never reaches it). The fleet is otherwise
              // unbounded — "many open Claude Codes, all organized."
              if (atCapacity) {
                pushToast(
                  `Deck is at the ${MAX_PANES}-session safety limit — close one to add another`,
                  'warn'
                );
                return;
              }
              setModalOpen(true);
            }}
            className="inline-flex items-center gap-1 text-xs weight-label px-3 py-1 rounded-md bg-surface-2 hover:bg-surface-3 text-accent-text border border-border-default disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.97] transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out-strong)]"
            title={
              atCapacity
                ? `Safety limit (${MAX_PANES}) reached — close one to add another`
                : mode === 'chat'
                ? 'Spawn a new chat (added to your running deck)'
                : 'Add another Claude Code session'
            }
          >
            {/* FIX #2 — accent-TEXT label, not a filled-cyan CTA: the screen's
                ONE filled accent is already spent on the rail's "+ CEO agent",
                so the canvas chrome carries the accent as text on a surface tile
                (accent discipline).

                chat-session mobile pass (2026-06-10, header reflow): the trailing
                "chat"/"session" word is `hidden md:inline` so the button is just
                "+ New" on a phone (it kept clipping at the right edge next to the
                fixed bell). Desktop shows the full "+ New chat" / "+ New session"
                label byte-for-byte. */}
            + New
            <span className="hidden md:inline">
              {' '}
              {mode === 'chat' ? 'chat' : 'session'}
            </span>
          </button>
        </div>
      </div>

      {/* Open-chats tab strip — switches which pane is VISIBLE, NOT which
          is mounted. Every pane stays mounted in the grid below; the strip
          only flips CSS visibility, so a backgrounded session keeps its SSE
          stream live and its xterm scrollback + "thinking" state survive a
          tab switch.

          Visibility: ALWAYS rendered on mobile (existing P2.1 contract). On
          desktop, ALSO rendered in CHAT mode (V3.2) so JD can switch between
          his running chats without leaving the canvas. Hidden on desktop in
          PANE mode because the grid itself is the switcher. */}
      <div
        // CAT-11 (2026-06-12): the open-chats strip is the PRIMARY mobile
        // session switcher. `.momentum-scroll` adds iOS `-webkit-overflow-
        // scrolling:touch` + `overscroll-behavior:contain` (max-md scoped) so a
        // horizontal flick at the edge no longer rubber-bands into the browser
        // back-swipe nav with >6 panes, and switching feels native. `touch-pan-x`
        // keeps the gesture horizontal-only so a vertical flick on the strip
        // doesn't fight the transcript scroll.
        className={`momentum-scroll touch-pan-x shrink-0 flex overflow-x-auto border-b border-hairline bg-surface-1 ${HAMBURGER.contentReserveClass} ${
          mode === 'chat' ? '' : 'md:hidden'
        }`}
        data-testid="mobile-pane-tabs"
      >
        {panes.map((p, i) => {
          // In chat mode, "visible" tracks the resolved visible chat
          // (focus > active > [0]). In pane mode (mobile only path here),
          // it tracks mobileVisibleIdx as before.
          const isVisible =
            mode === 'chat' ? p.sid === visibleSid : i === visibleIdx;
          // W9 NEEDS-YOU: a live session whose turn finished and is now blocked
          // on JD (bridge activity==='waiting') gets an amber + pulse dot —
          // the primary needs-you cue, right on the open tab.
          // FIX #4 (critic round-1): the status dot now speaks the MUTED warm-
          // graphite state machine, never neon. waiting = amber pulse (test-
          // locked attention cue, on-brand), live = muted ready-green token,
          // starting = state-working, exited = grey idle, error = muted red.
          //
          // DONE-CUE (2026-06-13, JD): the tab dot used to collapse BOTH a
          // grinding session and a finished one into the same ready-green —
          // so from the strip you couldn't tell which sessions were still
          // working vs. done. Mirror derivePill's live state machine: an
          // actively-working session (bridge activity working/running/busy)
          // now pulses the state-working token, so green/amber unambiguously
          // mean "done", and a pulsing-blue tab means "still going". exited
          // stays grey idle (NOT collapsed to red like derivePill does).
          const act = (p.activity ?? '').toLowerCase();
          const isWorking =
            p.status === 'live' &&
            (act === 'working' || act === 'running' || act === 'busy');
          const isWaiting = p.status === 'live' && act === 'waiting';
          const statusColor = isWorking
            ? 'bg-state-working animate-pulse'
            : isWaiting
            ? 'bg-amber-400 animate-pulse'
            : p.status === 'live'
              ? 'bg-state-ready'
              : p.status === 'starting'
              ? 'bg-state-working'
              : p.status === 'exited'
              ? 'bg-state-idle'
              : 'bg-state-error';
          return (
            <button
              key={p.sid}
              type="button"
              onClick={() => {
                setMobileVisibleIdx(i);
                setActiveSid(p.sid);
                // In chat mode, clicking a chat in the strip ALSO updates the
                // focus URL so the visible chat is bookmarkable / survives
                // refresh. setFocusedSid persists to ?focus= via router.replace.
                if (mode === 'chat') setFocusedSid(p.sid);
              }}
              aria-current={isVisible ? 'page' : undefined}
              data-testid={`mobile-pane-tab-${i + 1}`}
              // W9: the full resolved name on hover (so the bare domain label
              // "Family" doesn't lose the task half "Family · reconcile…" that
              // lives in agent_name; truncated names stay legible on hover).
              title={
                p.title === '…'
                  ? 'resolving…'
                  : `${p.title} — ${
                      isWorking
                        ? 'working'
                        : isWaiting
                        ? 'done · your turn'
                        : p.status === 'live'
                        ? 'ready'
                        : p.status === 'starting'
                        ? 'starting'
                        : p.status === 'exited'
                        ? 'stopped'
                        : 'error'
                    }`
              }
              // FIX #2 — the SELECTED tab is read by the AMBER accent (2px bottom
              // bar + the canvas surface lifting under it), NOT the old neon
              // teal-green (#00d492). border-b-accent is the one sanctioned side-
              // accent for selection; the rest stays text-only.
              //
              // chat-session mobile pass (2026-06-10): the tab strip IS the
              // mobile session switcher (target 4 — thumb-reachable prev/next).
              // Floor the tap height at 44px on mobile (`min-h-11`), reverting to
              // the original compact py-2 height on desktop (`md:min-h-0`) so the
              // desktop chat-mode strip is pixel-unchanged.
              className={`shrink-0 flex items-center gap-1.5 px-3 py-2 min-h-11 md:min-h-0 text-xs font-mono border-r border-hairline transition-colors duration-[var(--dur-micro)] ${
                isVisible
                  ? 'bg-canvas text-1 border-b-2 border-b-accent'
                  : 'text-3 hover:text-1'
              }`}
            >
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${statusColor}`}
              />
              <span
                className={`weight-label tabular ${
                  isVisible ? 'text-accent-text' : 'text-3'
                }`}
              >
                #{i + 1}
              </span>
              {/* W9 named-live-tabs: the NAME (domain → agent_name → cwd →
                  "Session"), NEVER the sid hash. Shows "…" only pre-resolution. */}
              <span
                data-testid={`pane-tab-label-${i + 1}`}
                className="truncate max-w-[100px]"
              >
                {p.title}
              </span>
            </button>
          );
        })}
        {/* W9 overflow affordance: when the deck exceeds 6 tabs the strip
            scrolls horizontally (overflow-x-auto above). Keep a sticky
            "⌘K (N)" jump-to-any-tab control pinned at the right edge so the
            full-inventory switcher is reachable even when tabs scroll
            off-screen. (Desktop chat-mode only; the strip on mobile already
            has the hamburger rail for the full inventory.) */}
        {panes.length > 6 && (
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            data-testid="pane-tabs-overflow-cmdk"
            title="Jump to any chat (⌘K)"
            className="hidden md:flex shrink-0 sticky right-0 items-center gap-1 px-3 py-2 text-xs font-mono weight-label bg-surface-1 border-l border-hairline text-3 hover:text-1 hover:bg-surface-3 transition-colors duration-[var(--dur-micro)]"
          >
            ⌘K ({panes.length})
          </button>
        )}
      </div>

      {/* Unified pane grid — SINGLE mount per session (no more separate
          mobile/desktop copies, which double-mounted the active sid into two
          SSE consumers).

          PANE mode (desktop): all panes tiled via gridClassFor; focusedSid
            collapses the grid to 1×1 (maximize) — others stay mounted.
          CHAT mode (V3.2, default + mobile-always): grid is 1×1 — the
            visible chat (visibleSid) fills the canvas; ALL other panes stay
            mounted but display:none so their SSE streams keep running and
            xterm scrollback/state survives a chat switch. This is the
            ChatGPT/Claude.ai tab UX JD asked for in msg 8280: "spin up
            many Claude chats… message 6 questions, have confidence they're
            working even if not loaded."
          Mobile (<md): always single-pane via mobileVisibleIdx (existing
            keep-alive contract). */}
      <div
        className={`flex-1 min-h-0 grid gap-2 p-2 ${
          mode === 'chat' || focusedSid
            ? 'grid-cols-1 grid-rows-1'
            : gridClassFor(panes.length)
        }`}
      >
        {panes.map((p, i) => {
          // Three visibility regimes, in priority order:
          //   1. CHAT mode (any viewport) → only the visibleSid is shown.
          //   2. PANE mode + focusedSid → only that sid is shown (M6 maximize).
          //   3. PANE mode + no focus → all visible on desktop, mobile uses
          //      visibleIdx via max-md:hidden.
          let hiddenCls: string;
          if (mode === 'chat') {
            hiddenCls = p.sid === visibleSid ? '' : 'hidden';
          } else if (focusedSid) {
            hiddenCls = p.sid === focusedSid ? '' : 'hidden';
          } else {
            hiddenCls = i === visibleIdx ? '' : 'max-md:hidden';
          }
          return (
            <div
              key={p.sid}
              data-testid={`pane-wrap-${i + 1}`}
              data-sid={p.sid}
              className={`min-w-0 min-h-0 h-full ${hiddenCls}`}
            >
              {p.metaResolved ? (
                <ChatGridPane
                  sessionId={p.sid}
                  initialTitle={p.title}
                  initialStatus={p.status}
                  // Live, re-polled status + activity (cockpit-chat-ux). Unlike
                  // initialStatus (read ONCE by SessionTerminal via useRef),
                  // these update every poll tick and drive the agent STATE pill
                  // (Thinking… / Done / Stopped). Bridge truth, not faked.
                  liveStatus={p.status}
                  liveActivity={p.activity}
                  threadId={p.threadId}
                  isActive={p.sid === activeSid}
                  // In chat mode, "isFocused" maps to "this is the visible
                  // chat" so the font tier picks the bigger size (focus mode
                  // font in fontSizeForPaneCount). The Maximize button in
                  // the pane header is still useful in pane mode for the
                  // "full-bleed this one pane inside the grid" UX.
                  isFocused={
                    mode === 'chat'
                      ? p.sid === visibleSid
                      : p.sid === focusedSid
                  }
                  onToggleFocus={() => {
                    if (mode === 'chat') {
                      // No-op in chat mode — the canvas already shows the
                      // visible chat full-size. Maximizing further has no
                      // meaning. Hide the button via ChatGridPane prop instead?
                      // Kept here as a defensive guard; the header conditionally
                      // hides the icon in chat mode.
                      return;
                    }
                    setFocusedSid((cur) => (cur === p.sid ? null : p.sid));
                  }}
                  // V3.2: per-pane mode prop drives header chrome (hide
                  // Maximize in chat mode, show "Add to pane" in chat mode).
                  cockpitMode={mode}
                  onAddToPane={() => {
                    // In chat mode, the sid is ALREADY in ?panes= (every
                    // open chat is in the deck), so this is functionally
                    // a no-op for membership. The user-meaningful action
                    // is "show me the pane grid" → toast offers a switch.
                    // Push back if JD wanted dual membership (separate
                    // pane-set vs chat-deck) — single-membership keeps the
                    // mental model simple and removes a whole sync surface.
                    if (mode === 'pane') {
                      pushToast('Already in pane grid', 'info');
                      return;
                    }
                    pushToast(
                      `Added "${p.title}" to pane view. Switch to Pane mode to see the grid.`,
                      'info',
                      { dismissible: true, ttlMs: 5500 }
                    );
                  }}
                  onFocus={() => {
                    setActiveSid(p.sid);
                    setMobileVisibleIdx(i);
                    // V3.2 chat-mode: clicking the pane body also nudges the
                    // visible chat (in case the rail tap missed). No-op in
                    // pane mode since you're already looking at all panes.
                    if (mode === 'chat') setFocusedSid(p.sid);
                  }}
                  onRemove={() => handleRemove(p.sid)}
                  onResumed={handleResumed}
                  fontSize={fontSizeForPaneCount(
                    // In chat mode, only ONE pane is ever visible so font
                    // sizing should treat the count as 1 (biggest tier).
                    // Otherwise the multi-pane density shrink fires even
                    // though the user can only see one pane at a time.
                    mode === 'chat' ? 1 : panes.length,
                    mode === 'chat'
                      ? p.sid === visibleSid
                      : p.sid === focusedSid,
                    isUltrawide
                  )}
                />
              ) : (
                // Placeholder while fetchSessionMeta resolves status + threadId.
                // We DELIBERATELY do not mount <ChatGridPane> here — its child
                // SessionTerminal reads initialStatus once via useRef on mount,
                // so mounting with a stale 'live' default for an actually-dead
                // session would silently drop the /history paint (the bug PR
                // #102 thought it fixed). Sub-second flash → real pane.
                <div
                  data-testid={`pane-loading-${i + 1}`}
                  className="flex items-center justify-center h-full text-xs font-mono tabular text-3 border border-hairline rounded-lg bg-surface-2"
                >
                  loading {p.sid.slice(0, 8)}…
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/*
        W7 (QA NO-GO fix): the cockpit "+ New chat" header button routes through
        this picker. It MUST be the SAME restricted (CEO + project only) picker
        the rail uses — `mode="projects"`. Without it the picker defaulted to
        `'all'`, re-exposing the ad-hoc Claude + 8 spawnable domains + launch-all
        that W6's locked model removed (audit FINAL-QA-batch.md Item 6 FAIL).
      */}
      <NewSessionPicker
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onLaunched={handleLaunched}
        hasOpenPanes={panes.length > 0}
        mode="projects"
      />

      <PaneSwitcher
        open={paletteOpen}
        panes={palette}
        activeSid={activeSid}
        onClose={() => setPaletteOpen(false)}
        onSelect={(sid) => {
          setActiveSid(sid);
          const idx = panes.findIndex((p) => p.sid === sid);
          if (idx >= 0) setMobileVisibleIdx(idx);
        }}
      />

      {/* Toast container — bottom-right */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[220] flex flex-col gap-2 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              // A toast IS a true overlay → one of the few surfaces the design
              // system sanctions a shadow on. Warm-graphite state TINTS (14%-
              // alpha pill fills + muted state text), never a saturated card.
              style={{ boxShadow: 'var(--shadow-popover)' }}
              className={`pointer-events-auto flex items-center gap-2 rounded-md px-3 py-2 text-xs font-mono border ${
                t.kind === 'warn'
                  ? 'bg-tint-attention border-border-default text-state-attention'
                  : t.kind === 'error'
                  ? 'bg-tint-error border-border-default text-state-error'
                  : 'bg-surface-2 border-border-default text-1'
              }`}
            >
              <span>{t.text}</span>
              {t.dismissible && (
                <button
                  type="button"
                  onClick={() => dismissToast(t.id)}
                  className="shrink-0 inline-flex text-current opacity-60 hover:opacity-100 px-0.5 leading-none transition-opacity duration-[var(--dur-micro)]"
                  aria-label="Dismiss"
                  title="Dismiss"
                >
                  <Icon glyph={XGlyph} state="idle" size={12} weight="bold" aria-hidden />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
