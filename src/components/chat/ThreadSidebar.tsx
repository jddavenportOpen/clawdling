'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ThreadSidebar — left column in /chat.
//
// Layout (top to bottom):
//   1. PROJECT CHATS (collapsible parent) — wraps every per-project group.
//      Each project_slug becomes a sub-section under this parent so the
//      sidebar stays readable when JD has 5+ active projects in flight.
//      Threads with project_slug != null land here.
//   2. Agents — kind='agent' threads with no project_slug (general chats).
//   3. Project sessions — kind='project-session' (Claude Code CLI sessions
//      bound to a project, separate flow from the agent chat panel).
//   4. Ad-hoc — kind='ad-hoc'.
//
// "New thread" button opens NewThreadModal.
// "+ Code" button (mobile-essential) opens NewSessionModal — gives mobile
// users access to the Claude Code session spawn flow that previously
// only existed in the desktop /chat landing's `<main>` (hidden on <md).
// Clicking a thread navigates to /chat/[threadId] via <Link>.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import NewSessionPicker from './NewSessionPicker';
import SessionHistoryPanel from './SessionHistoryPanel';
import type { ChatSessionStatus, DbChatThread } from '@/lib/supabase';
import { useActiveThreads } from '@/lib/useActiveThreads';
import { usePinnedIds, useIsPinned, togglePin } from '@/lib/usePins';
import { getDomain, DOMAIN_IDS, DOMAINS } from '@/config/domains';
import { buildDomainEntries, partitionThreads, type DomainEntry } from '@/lib/railModel';
import { PANE_SOFT_CAP } from '@/lib/cockpitCaps';
import { spawnFailureMessage } from '@/lib/utils';
// ── Warm Graphite design-system foundation (the bespoke glyph + icon layer) ──
// REUSE the foundation built in `ds(v6): Warm Graphite design-system
// FOUNDATION` — never an emoji. domainGlyph/agentGlyph resolve a per-domain /
// per-agent DUOTONE Phosphor glyph (the "custom emoji"); Icon's `state` props
// encode weight (regular idle → fill active → duotone domain). StatusGlyph is
// the signature ring/pie state machine for any session/agent status.
import { Icon } from '@/components/ds/Icon';
import { StatusGlyph, type GlyphState } from '@/components/ds/StatusGlyph';
import { Eyebrow } from '@/components/ds/Wordmark';
import HeaderClock from '@/components/chat/HeaderClock';
import {
  domainGlyph,
  agentGlyph,
  type GlyphDef,
} from '@/components/ds/glyphMap';
import {
  PushPin,
  Circuitry,
  FolderSimple,
  ChatCircle,
  Archive,
  Brain,
  Paperclip,
  X as XGlyph,
} from '@phosphor-icons/react/dist/ssr';
// V2.1 click-mode preference RETIRED in V3.2 (2026-05-28, JD msgs 8280+8285).
// The chrome-level Chat/Pane toggle (see ChatGrid + cockpitMode.ts) subsumes
// the old per-user "what does a click do" dropdown — the toggle directly
// expresses intent ("I want this view") instead of conditioning click handlers.
// Right-clicks on rail rows still route via openInGrid (now always appends to
// ?panes=, the deck shared by both render modes).

// Derive a session's Space (domain id) from its cwd. Domain sessions are
// rooted at <state-root>/domains/<id>/; non-domain sessions return null and
// stay under the generic groups.
function spaceOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const m = cwd.match(/\/domains\/([^/]+)/);
  if (m && DOMAIN_IDS.has(m[1])) return m[1];
  return null;
}

// Map a Space's default_ref (a domain | project id) to the working dir a
// "+ New in this Space" spawn lands in. A domain ref → <state-root>/domains/<id>;
// everything else is treated as a project slug (<state-root>/projects/<ref>).
// Returns null for a ref we can't map (the spawn then lands in the default
// state root, an honest degrade, never a hard failure).
const STATE_ROOT = '.';
function spaceCwdFromRef(ref: string | null | undefined): string | null {
  const r = (ref || '').trim();
  if (!r || r === 'life' || r === 'misc') return null;
  if (DOMAIN_IDS.has(r)) return `${STATE_ROOT}/domains/${r}`;
  return `${STATE_ROOT}/projects/${r}`;
}

// ─── P1.2 — Sidebar polls Supabase status independent of SSE ──────────────
// Each thread row gets a status pill driven by the latest chat_sessions row
// for that thread, polled at 5s cadence via SWR. Decouples liveness display
// from "is some pane currently subscribing to this session's SSE?" — closing
// a pane no longer stales the sidebar.
// (see docs/ARCHITECTURE.md)

interface ThreadMetaRow {
  id: string;
  title: string;
  kind: string;
  ref_id: string | null;
  project_slug: string | null;
  session_id: string | null;
  // 'unknown' status is the no-session-row case (pre-P1.1 backfill, agent
  // threads with no project-session, etc). UI renders it gray + "unknown".
  // 'crashed' / 'error' are reserved for P1.4 — the API can emit them today
  // if a future migration adds those values to ChatSessionStatus; the
  // sidebar pill handles them now so we don't need a second pass later.
  session_status: ChatSessionStatus | 'crashed' | 'error' | null;
  exited_at: string | null;
  exit_code: number | null;
  // cwd of the latest session — the rail derives its Space from this (PR-E).
  cwd: string | null;
  // Human rail identity set at spawn (Cockpit V3 M5): what the agent IS +
  // what it's doing ("Health · weekly summary", "find old logo", a project
  // slug). The row label prefers this over the machine thread title so JD can
  // tell his agents apart. Null → fall back to t.title (old derivation).
  agent_name: string | null;
}

interface ThreadMetaResponse {
  threads: ThreadMetaRow[];
}

async function metaFetcher(url: string): Promise<ThreadMetaResponse> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return { threads: [] };
  return (await res.json()) as ThreadMetaResponse;
}

// Bridge waiting-signal feed (PR — Needs-You). /api/sessions/list joins
// Supabase + the bridge and carries per-session `activity` (working/waiting/
// idle) for live sessions, keyed by thread_id.
interface SessListResp {
  sessions?: Array<{
    id?: string; // bridge session id (sid) — used to open the brain's pane
    thread_id: string;
    activity: string | null;
    live?: boolean;
    // Two-class distinction (persistent-domain-agents, 2026-05-30). True iff
    // this LIVE session is its domain's persistent continuity brain (vs an
    // ad-hoc disposable worker). domain names which of the 8 it owns. Bridge
    // truth — the rail badges a brain with 🧠 so JD can tell them apart.
    persistent?: boolean;
    domain?: string | null;
  }>;
}
async function listFetcher(url: string): Promise<SessListResp> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return { sessions: [] };
  return (await res.json()) as SessListResp;
}

// ── C1 (r-cockpit): the focused Space's real workspace state ─────────────────
// GET /api/spaces/[id] → the spine-backed workspace: server-side deck + focus,
// the Space-scoped context bundle (pinned docs / memory keys a spawn inherits),
// and the Space notes/memory. degraded:true means the spine was unreachable, so
// the chip keeps its cwd-derived label (the route never 5xx's).
interface SpaceWorkspace {
  id: string;
  label: string;
  color: string | null;
  default_role: string | null;
  default_ref: string | null;
  bundle: { pinned_docs?: string[]; memory_keys?: string[]; [k: string]: unknown } | null;
  deck: string[];
  focus: string | null;
  notes: string;
  live_count: number;
  waiting_count: number;
}
interface SpaceWorkspaceResp {
  space: SpaceWorkspace | null;
  degraded: boolean;
}
async function spaceWorkspaceFetcher(url: string): Promise<SpaceWorkspaceResp> {
  const res = await fetch(url, { cache: 'no-store' });
  // The route soft-degrades (never 5xx on a spine outage); a non-ok here means
  // an auth/transport failure → treat as degraded so the chip uses its fallback.
  if (!res.ok) return { space: null, degraded: true };
  return (await res.json()) as SpaceWorkspaceResp;
}

interface Props {
  threads: DbChatThread[];
  activeThreadId: string | null;
  /** When set (via /chat?space=<domain>), focus that Space: a context chip at
      the top + the matching Space group highlighted. Spaces are derived from
      session cwd, so this is a view filter, not a stored column. */
  initialSpace?: string | null;
  /** CAT-12 (2026-06-12): true when rendered inside MobileSidebarDrawer. The
      drawer's own close (X) button is absolutely positioned top-right and
      overlapped the brand-row HeaderClock; in-drawer we suppress the clock so
      the X has clear space (the clock is redundant chrome inside a transient
      drawer anyway). Desktop inline usage leaves it undefined → clock shows. */
  inDrawer?: boolean;
}

const AGENT_LABEL: Record<string, string> = {
  clawd: 'CEO',
  chief_of_staff: 'COS',
  health_coach: 'Coach',
  researcher: 'Researcher',
  counselor: 'Examiner',
  counselor_ai_foundry: 'Foundry',
  professor: 'Professor',
  quanta: 'Quanta',
  analytics_suite: 'Analytics',
  qa_agent: 'QA',
  ops: 'DevOps',
};

// Resolve a thread → its bespoke Phosphor glyph (NO emoji). Agent threads map
// to the per-agent role glyph from the foundation's AGENT_GLYPHS; the two
// session kinds get a function-appropriate monoline mark. This replaces the
// old AGENT_EMOJI clipart (🦞/💪/🔬/…) one-for-one.
function threadGlyph(t: DbChatThread): GlyphDef['glyph'] {
  if (t.kind === 'agent') return agentGlyph(t.ref_id).glyph;
  if (t.kind === 'project-session') return FolderSimple;
  return ChatCircle;
}

function threadSubLabel(t: DbChatThread): string | null {
  if (t.kind === 'agent' && t.ref_id) {
    return AGENT_LABEL[t.ref_id] || t.ref_id;
  }
  if (t.kind === 'project-session') return 'CLI session';
  return null;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(1, Math.floor((now - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}


// ── liveSet derivation (M1 — bridge-truth union, MA-11 honest-dead gate) ─────
// Extracted as a pure function so the unit suite can exercise the union math
// (audit HIGH #3, cockpit-chat-v3). The component's useMemo body delegates to
// this so the test contract IS the live contract — no diverging copies.
//
// Contract:
//   (1) activeSet                                       → mid-turn emitting now
//   (2) sessions where live && thread_id                → BRIDGE-reported live
//   (3) statusByThread row.session_status in {live,starting} → Supabase DB,
//       BUT gated: only counts when the bridge feed does NOT already report
//       this thread's session as DEAD. The bridge `/api/sessions/list` feed
//       carries the user's recent rows with a per-row `live` flag (bridge
//       truth). A thread the feed lists with live=false is bridge-confirmed
//       dead — its stale DB `status='live'` column is a GHOST and must NOT
//       resurrect it (3rd-party QA MA-11: "93/93 live" vs 1 real PTY, all
//       rows 19h+ past the reaper). Signal (3) survives ONLY for threads the
//       feed doesn't mention at all (fell off the 100-row cap → genuinely
//       unknown to the feed, so trust the DB optimistically — that's the
//       idle-between-turns case M1 was built to cover).
//
// Union, not replace: bridge truth (1,2) always dominates; (3) only ADDS
// coverage for feed-absent threads. A genuinely-killed session drops out of
// (1)+(2) AND is feed-dead, so (3) can no longer keep it "live."
export function computeLiveSet(
  activeSet: Iterable<string>,
  sessions:
    | Array<{ thread_id?: string; live?: boolean }>
    | undefined,
  statusByThread: Map<string, { session_status: string | null | undefined }>
): Set<string> {
  const s = new Set<string>();
  // Threads the BRIDGE FEED has an opinion about. A thread present here with
  // live=false is bridge-confirmed dead; absent threads are unknown to the feed.
  const feedDead = new Set<string>();
  for (const id of activeSet) s.add(id);
  for (const sess of sessions ?? []) {
    if (!sess.thread_id) continue;
    if (sess.live) {
      s.add(sess.thread_id); // (2) bridge says live
    } else {
      feedDead.add(sess.thread_id); // bridge says this thread's session is dead
    }
  }
  for (const [id, row] of statusByThread) {
    if (row.session_status === 'live' || row.session_status === 'starting') {
      // (3) DB optimism — but never override a bridge-confirmed-dead thread.
      if (!feedDead.has(id)) s.add(id);
    }
  }
  return s;
}

export default function ThreadSidebar({
  threads,
  activeThreadId,
  initialSpace = null,
  inDrawer = false,
}: Props) {
  // 2026-05-04 — added so mobile users can spawn Claude Code sessions.
  // Previously the "+ New Claude Session" CTA lived only in the desktop
  // `<main>` of /chat (hidden md:block), leaving phones with no way to
  // open the cockpit. The button sits next to "+ New" in the sidebar
  // header; on launch we route to /chat?panes=<sid>.
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const sessionRouter = useRouter();

  // ── W9 CEO-disappear root-cause fix (2026-06-01) ────────────────────────
  // The rail's domain/CEO spawn handlers used to `router.push('/chat?panes=
  // <newsid>')` — a naive REPLACE that wiped every prior pane from the deck.
  // That is the actual "I spawned a 2nd CEO and the first one disappeared" bug
  // (JD msg 8685): the deck only ever held the newest sid, so the prior agent
  // wasn't a hidden background tab — it was evicted from ?panes= entirely.
  // (The TAB-NAMING-SPEC assumed these handlers already appended; they did
  // NOT — pushback logged in the WORKPLAN.) This routes all three rail-spawn
  // paths through the SAME append-with-dedup-and-cap logic openInGrid already
  // uses: keep the existing deck, add the new sid, bump the oldest past the
  // cap, and focus the new one. Now spawning a 2nd CEO ADDS a named tab next
  // to the first; nothing is lost.
  const openSidInDeck = (sid: string) => {
    const sp = new URLSearchParams(window.location.search);
    const current = (sp.get('panes') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let next: string[];
    if (current.length === 0) {
      next = [sid];
    } else if (current.includes(sid)) {
      next = current; // already open — just navigate + focus it
    } else if (current.length >= PANE_SOFT_CAP) {
      // C5 no-cap: the deck is unbounded; this only bumps the oldest at the
      // shared safety limit (PANE_SOFT_CAP, src/lib/cockpitCaps.ts). Previously
      // this hardcoded `10` while openInGrid below hardcoded `6` — the two rail
      // append paths disagreed (chat-cockpit audit §4 #3). They now share ONE
      // constant so a session is never silently evicted depending on which
      // button opened it.
      next = [...current.slice(1), sid];
    } else {
      next = [...current, sid];
    }
    sp.set('panes', next.join(','));
    // Focus the just-opened/spawned session so the user lands on it (chat mode
    // shows the focused chat; the prior panes stay mounted as named tabs).
    sp.set('focus', sid);
    sessionRouter.push(`/chat?${sp.toString()}`);
  };
  // Agent-rail status filter (cockpit overhaul PR-C). Scannability for 10+
  // sessions: All / Live / Ended. agent-deck's status-filter pattern.
  const [statusFilter, setStatusFilter] = useState<'all' | 'live' | 'waiting' | 'ended'>('all');
  // Cockpit v1 — pulse-dot indicator. Set of thread_ids whose claude proc
  // is currently running on the bridge. See PRD §7.2.
  const activeSet = useActiveThreads();

  // P1.2 — independent-of-SSE status poll. Build a stable comma-joined ID
  // list (sorted so reordering doesn't bust SWR cache) of ALL visible
  // thread IDs and poll /api/threads/meta every 5s. Returns the latest
  // chat_sessions row per thread (status + exited_at + session_id).
  const visibleIds = useMemo(() => {
    const ids = threads.map((t) => t.id);
    ids.sort();
    return ids;
  }, [threads]);
  const swrKey =
    visibleIds.length > 0
      ? `/api/threads/meta?ids=${visibleIds.join(',')}`
      : null;
  const { data: metaResp } = useSWR<ThreadMetaResponse>(swrKey, metaFetcher, {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
    // Don't show stale on slow networks — keep the previous data so the
    // pill doesn't flicker to "unknown" between polls.
    keepPreviousData: true,
    dedupingInterval: 2_000,
  });
  const statusByThread = useMemo(() => {
    const m = new Map<string, ThreadMetaRow>();
    for (const row of metaResp?.threads ?? []) {
      m.set(row.id, row);
    }
    return m;
  }, [metaResp]);

  // Activity poll (bridge waiting-signal). thread_id → working/waiting/idle for
  // live sessions. Powers the Needs-You queue + the activity dot.
  const { data: sessListResp } = useSWR<SessListResp>(
    '/api/sessions/list',
    listFetcher,
    { refreshInterval: 5_000, keepPreviousData: true, dedupingInterval: 2_000 }
  );
  const activityByThread = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessListResp?.sessions ?? []) {
      if (s.live && s.activity && !m.has(s.thread_id)) m.set(s.thread_id, s.activity);
    }
    return m;
  }, [sessListResp]);

  // thread_id → domain id for LIVE persistent continuity brains (bridge truth).
  // Drives the 🧠 brain badge so JD can distinguish a domain's persistent brain
  // from a disposable ad-hoc worker in the rail (MA-2 AC4 / MA-4 AC2). Only
  // live + persistent rows qualify — a dead row is never a brain.
  const brainDomainByThread = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const s of sessListResp?.sessions ?? []) {
      if (s.live && s.persistent && !m.has(s.thread_id)) {
        m.set(s.thread_id, s.domain ?? null);
      }
    }
    return m;
  }, [sessListResp]);

  // ── W6: the FIXED 8 domain entries (JD's persistent-domain-chats model) ────
  // Always render exactly the 8 domains (DOMAINS order). A domain is "live"
  // when /api/sessions/list reports a live + persistent brain for it (bridge
  // truth). Cold domains still render — clicking them creates-or-resumes the
  // brain. Folded here so a domain is one rail entry, never a wall of history.
  const domainEntries = useMemo(
    () => buildDomainEntries(sessListResp?.sessions),
    [sessListResp]
  );

  // Spinner state for a domain entry while its persistent brain is being
  // created-or-resumed (the spawn-domain round-trip).
  const [domainBusy, setDomainBusy] = useState<string | null>(null);
  // Spinner state for the "+ CEO agent" header button.
  const [ceoBusy, setCeoBusy] = useState(false);
  // CAT-05 (LIVE-MOBILE BUG-MOB-01): a spawn that 500s/502s used to fail
  // SILENTLY — `if (res.ok && data.session_id) open(...)` had no `else` and the
  // catch was empty, so JD tapped CEO/Project/Domain and got a byte-identical
  // screen, no toast, no spinner-error. This surfaces a dismissible inline error
  // banner above the spawn buttons (the codebase has no imperative toast API;
  // an inline banner matches saveSpaceNotes' existing retry affordance and is
  // visible on the mobile launcher where JD actually hits this).
  const [spawnError, setSpawnError] = useState<string | null>(null);

  // ── C1 (r-cockpit): Spaces as REAL workspaces ───────────────────────────────
  // The chat-cockpit audit (§6) flagged that a Space is just `spaceOf(cwd)` — a
  // view grouping that owns NOTHING. C1 backs the focused Space with the cockpit
  // spine so the Space chip becomes a real workspace panel: it loads the Space's
  // server-side deck (own route), its Space-scoped context BUNDLE (pinned docs /
  // memory keys a spawn inherits), and its NOTES/memory — all persisted on the
  // spine (survives restarts, follows JD across devices). Soft-degrades: when the
  // spine is down the SWR returns space:null + degraded:true and the chip falls
  // back to the cwd-derived label exactly as today (the route never 5xx's).
  const { data: spaceWs, mutate: mutateSpaceWs } = useSWR<SpaceWorkspaceResp>(
    initialSpace ? `/api/spaces/${encodeURIComponent(initialSpace)}` : null,
    spaceWorkspaceFetcher,
    { revalidateOnFocus: true, keepPreviousData: true, dedupingInterval: 2_000 }
  );
  const space = spaceWs?.space ?? null;
  // The Space notes/memory editor. Seeded from the loaded workspace; the user
  // edits locally and saves to the spine (PUT /api/spaces/[id]). `notesDirty`
  // gates the Save button so we don't thrash the spine on every keystroke.
  const [notesDraft, setNotesDraft] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [notesSaving, setNotesSaving] = useState(false);
  // When the focused Space (or its server notes) changes, reseed the draft —
  // unless the user has unsaved edits, which we must not clobber.
  useEffect(() => {
    if (notesDirty) return;
    setNotesDraft(space?.notes ?? '');
  }, [space?.id, space?.notes, notesDirty]);
  // Reset the editor entirely when the focused Space changes (id switch).
  useEffect(() => {
    setNotesDirty(false);
  }, [initialSpace]);

  // Persist the Space notes/memory to the spine. Soft-degrade aware: the route
  // returns persisted:false on a spine outage; we keep the draft + dirty flag so
  // the user can retry rather than silently losing the edit.
  const saveSpaceNotes = async () => {
    if (!initialSpace || notesSaving) return;
    setNotesSaving(true);
    try {
      const res = await fetch(`/api/spaces/${encodeURIComponent(initialSpace)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notesDraft }),
      });
      const data = (await res.json().catch(() => ({}))) as { persisted?: boolean };
      if (res.ok && data.persisted) {
        setNotesDirty(false);
        void mutateSpaceWs();
      }
      // persisted:false → keep the draft + dirty flag so the user can retry.
    } catch {
      /* network error — keep the draft so the edit isn't lost */
    } finally {
      setNotesSaving(false);
    }
  };

  // C1 "+ New in this Space" — a spawn inside a Space inherits the workspace's
  // spawn DEFAULTS (default_role/default_ref from the spine) so it lands
  // pre-scoped instead of as a generic worker. For a domain-shaped Space the
  // domain brain IS that scoped spawn (openDomainBrain, idempotent), so we route
  // there when the Space id is a known domain; otherwise we resolve the Space's
  // spawn-defaults and open a cockpit session scoped to the Space. Soft-degrades
  // to a plain CEO-class spawn if the spine can't resolve defaults.
  const [spaceSpawnBusy, setSpaceSpawnBusy] = useState(false);
  const newInSpace = async () => {
    if (!initialSpace || spaceSpawnBusy) return;
    // Domain Space → its persistent brain is the canonical scoped spawn.
    if (DOMAIN_IDS.has(initialSpace)) {
      const entry = domainEntries.find((e) => e.def.id === initialSpace);
      if (entry) {
        void openDomainBrain(entry);
        return;
      }
    }
    setSpaceSpawnBusy(true);
    setSpawnError(null);
    try {
      // Resolve the Space-scoped spawn identity (role/ref) the workspace imposes.
      const dRes = await fetch(
        `/api/spaces/${encodeURIComponent(initialSpace)}/spawn-defaults`,
        { cache: 'no-store' }
      );
      const defaults = (await dRes.json().catch(() => ({}))) as {
        ref?: string | null;
      };
      // Land the spawn in the Space's working dir so cockpit-spawn's cwd→(role,
      // ref) derivation attributes it to the workspace (its assembler then
      // preloads the Space context). The ref is a project/venture/domain id; map
      // it to its ~/clawd dir. `space` is sent too so a promoted spine that reads
      // it can attribute even when the cwd mapping is unknown (forward-compatible;
      // the current route ignores unknown fields harmlessly).
      const ref = defaults?.ref || initialSpace;
      const cwd = spaceCwdFromRef(ref);
      const res = await fetch('/api/sessions/cockpit-spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ space: initialSpace, ...(cwd ? { cwd } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        session_id?: string;
        error?: string;
      };
      if (res.ok && data.session_id) {
        openSidInDeck(data.session_id);
      } else {
        // CAT-05: don't swallow a non-2xx (or a 2xx with no session_id) —
        // surface it so the tap isn't silent.
        setSpawnError(spawnFailureMessage(res.status, data.error));
      }
    } catch {
      // CAT-05: network throw (offline / aborted) — status 0 path.
      setSpawnError(spawnFailureMessage(0));
    } finally {
      setSpaceSpawnBusy(false);
    }
  };

  // Spawn an ad-hoc session — a fresh, unscoped session in the state root.
  // On launch, jump to its pane.
  const spawnCeoAgent = async () => {
    if (ceoBusy) return;
    setCeoBusy(true);
    setSpawnError(null);
    try {
      const res = await fetch('/api/sessions/cockpit-spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '.' }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        session_id?: string;
        error?: string;
      };
      if (res.ok && data.session_id) {
        // W9: APPEND to the deck (don't replace) so a 2nd CEO adds a tab next
        // to the first instead of evicting it. Root-cause fix for the
        // CEO-disappear bug.
        openSidInDeck(data.session_id);
      } else {
        // CAT-05 (BUG-MOB-01): a 500 (thread-create) or 502 (bridge down) used
        // to vanish here — no else, empty catch. Surface it.
        setSpawnError(spawnFailureMessage(res.status, data.error));
      }
    } catch {
      // CAT-05: network throw — status 0 path.
      setSpawnError(spawnFailureMessage(0));
    } finally {
      setCeoBusy(false);
    }
  };

  // Click a domain entry → open-or-resume its ONE persistent continuity brain.
  // If a live brain already exists (bridge truth), jump straight to its pane.
  // Otherwise POST spawn-domain { domain, persistent:true } — idempotent: the
  // bridge reuses the existing brain or mints it — then open the returned pane.
  const openDomainBrain = async (entry: DomainEntry) => {
    if (entry.live && entry.sid) {
      // W9: APPEND (don't replace) so opening a 2nd domain door keeps the
      // first domain's tab in the deck.
      openSidInDeck(entry.sid);
      return;
    }
    if (domainBusy) return;
    setDomainBusy(entry.def.id);
    setSpawnError(null);
    try {
      const res = await fetch('/api/sessions/spawn-domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // persistent:true is the locked model — this is the domain's ONE brain.
        body: JSON.stringify({ domain: entry.def.id, persistent: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        session_id?: string;
        error?: string;
      };
      if (res.ok && data.session_id) {
        openSidInDeck(data.session_id);
      } else {
        // CAT-05 (BUG-MOB-01): opening a domain brain that 502s (bridge down)
        // or 500s used to leave the row spinning-then-silent. Surface it.
        setSpawnError(spawnFailureMessage(res.status, data.error));
      }
    } catch {
      // CAT-05: network throw — status 0 path.
      setSpawnError(spawnFailureMessage(0));
    } finally {
      setDomainBusy(null);
    }
  };

  // BRIDGE-TRUTH live set. Union of THREE signals so a live agent is never
  // mis-classified as resting — the bug JD hit: a live "health" agent idle
  // *between* turns rendered in Spaces and routed to the empty thread view.
  //   1. activeSet (useActiveThreads) — thread is mid-turn, emitting RIGHT NOW.
  //   2. /api/sessions/list `sess.live` — bridge reports it running. BUT this
  //      feed is capped at the 100 most-recent sessions (raised from 30 in the
  //      v3-cosmetic-batch fix, 2026-05-28), so an older live session (or one
  //      idle between turns) can STILL fall off it on a long-running power
  //      session — covered by signal (3).
  //   3. /api/threads/meta `session_status` — the per-thread Supabase poll
  //      (NOT capped; covers every visible thread). status='live'/'starting'
  //      catches exactly the idle-between-turns live agent that (1) and (2)
  //      both miss.
  // We previously refused to trust the DB `status` column for fear of stale
  // 'live' ghosts after a bridge restart. That fear is asymmetric: a ghost
  // gets openAsPane=true and routes to /chat?panes=<sid> (which renders the
  // resumable/ended pane — recoverable), whereas a MISSED live agent routes to
  // the dead "No messages yet" view (JD's documented break). Union, never
  // replace: bridge truth (1,2) still dominates; (3) only ADDS coverage. A
  // genuinely-killed session drops out of (1) and (2); if its DB row still
  // says 'live' the pane view shows the kill state — strictly better than the
  // empty transcript. Net: a live row ALWAYS opens its pane, from any section.
  const liveSet = useMemo(
    () => computeLiveSet(activeSet, sessListResp?.sessions, statusByThread),
    [activeSet, sessListResp, statusByThread]
  );

  // PANEABLE set — threads that should open as a cockpit pane on plain click
  // INSTEAD of routing to /chat/[threadId] (the empty transcript view).
  // = LIVE ∪ {threads with ANY chat_sessions row}. Per JD msg 8136 (2026-05-27):
  // "history of each panel isnt saved when you go back and forth back into old
  // chats, its almost like the chat history should be reloaded if you spin up
  // a dead session?" — dead rows have a persisted transcript at
  // <state-root>/state/sessions/<sid>.jsonl + raw bytes that /api/sessions/
  // [sid]/history serves, and SessionTerminal already statically replays them
  // for exited sessions (see SessionTerminal.tsx:441-484, the "Exited session
  // — replay the transcript bytes" path). The crash-recovery "Spawn new with
  // same prompt" button (P1.4, #97) is also wired in the pane header for any
  // crashed/exited session. The MISSING piece was the routing: plain click on
  // a dead row fell through to /chat/[threadId] (empty "No messages yet" view)
  // instead of opening the dead session in a pane where /history + replay can
  // actually do their job.
  //
  // Predicate: any thread with statusByThread[id].session_id !== null is
  // paneable. This covers status in (live, starting, exited, crashed, error)
  // — anything that has a session_id. The /api/threads/[threadId]/session
  // endpoint (which openInGrid hits to resolve sid) ALREADY prefers live →
  // most-recent-by-started_at, so a thread with both live + dead rows opens
  // live (no regression to M1), and a thread with only dead rows opens the
  // most-recent dead. Threads with NO session row at all (session_id===null:
  // kind=agent, ad-hoc, never-spawned project-session) intentionally fall
  // through to the transcript href — they have nothing to render in a pane.
  const paneableSet = useMemo(() => {
    const s = new Set<string>(liveSet);
    for (const [id, row] of statusByThread) {
      if (row.session_id) s.add(id);
    }
    return s;
  }, [liveSet, statusByThread]);

  // ── Status filter (PR-C) ────────────────────────────────────────────────
  // 'live'  → session running on the bridge (or mid-turn emitting output).
  // 'ended' → exited / crashed / error.
  // Threads with no session row (kind=agent / ad-hoc) only show under 'all'.
  const passesFilter = (t: DbChatThread): boolean => {
    if (statusFilter === 'all') return true;
    const st = statusByThread.get(t.id)?.session_status;
    if (statusFilter === 'live') return liveSet.has(t.id);
    if (statusFilter === 'waiting') return activityByThread.get(t.id) === 'waiting';
    return st === 'exited' || st === 'crashed' || st === 'error';
  };
  // Pinned chats (localStorage, shared store) — float to a dedicated rail at
  // the top so the 2-3 chats you're actively driving are always one click away.
  // A pinned chat has exactly ONE home: the Pinned rail. We carry its waiting
  // signal onto the pinned row (amber dot) rather than bouncing it to Needs-You,
  // so clicking pin always has a visible effect.
  const pinnedIds = usePinnedIds();
  const pinnedThreads = useMemo(
    () => threads.filter((t) => pinnedIds.has(t.id)),
    [threads, pinnedIds]
  );
  // Threads where the agent finished its turn and is blocked on the user.
  // Drives the "Needs you" filter-chip count. (No longer its own section —
  // waiting agents surface in LIVE, waiting-first, with an amber dot.)
  const needsYou = useMemo(
    () =>
      threads.filter(
        (t) => activityByThread.get(t.id) === 'waiting' && !pinnedIds.has(t.id)
      ),
    [threads, activityByThread, pinnedIds]
  );
  // LIVE — every agent currently running on the bridge, regardless of how it'd
  // otherwise be grouped. THE answer to "I spawned 2 agents, show me both and
  // let me tab between them." Single home at the top (excluded from the grouped
  // sections below). Pinned takes precedence (a pinned live chat shows in
  // Pinned). Waiting-first so the agents that need you float to the top.
  const liveThreads = useMemo(() => {
    let list = threads.filter((t) => liveSet.has(t.id) && !pinnedIds.has(t.id));
    if (statusFilter === 'waiting') {
      list = list.filter((t) => activityByThread.get(t.id) === 'waiting');
    }
    return list.sort((a, b) => {
      const aw = activityByThread.get(a.id) === 'waiting' ? 0 : 1;
      const bw = activityByThread.get(b.id) === 'waiting' ? 0 : 1;
      if (aw !== bw) return aw - bw;
      return (
        new Date(b.last_message_at).getTime() -
        new Date(a.last_message_at).getTime()
      );
    });
  }, [threads, liveSet, pinnedIds, statusFilter, activityByThread]);
  const liveCount = useMemo(
    () => threads.filter((t) => liveSet.has(t.id)).length,
    [threads, liveSet]
  );

  // ── W6 + RAIL-PURGE: SPAWNED = ONLY ad-hoc CEO + project agents, and by
  // DEFAULT only the ones that are still LIVE ────────────────────────────────
  // JD's locked model: the rail shows the fixed 8 domains (above) + only the
  // ad-hoc CEO agents and project agents currently spawned. Everything else —
  // legacy specialist chats, old ad-hoc message threads, domain-scoped thread
  // rows (folded into the fixed domain entries) — is ARCHIVED (hidden, kept in
  // the DB, recoverable). partitionThreads() is the pure, tested classifier.
  //
  // RAIL-PURGE root-cause fix (2026-06-01, JD's "junk drawer of ~71 dead
  // sessions"): partitionThreads classifies a thread as ceo/project purely on
  // "did it ever spawn a session" (session_id present) — it has NO liveness
  // notion. So every long-DEAD exited CEO/project thread piled into SPAWNED in
  // the default ALL view, burying what's actually live. The classifier stays
  // liveness-agnostic (it answers WHAT class a thread is, not WHETHER it's
  // running — the right separation of concerns); the LIVENESS split happens
  // HERE, where bridge-truth liveSet lives. Default rail (ALL/LIVE/WAITING)
  // shows ONLY live spawned agents. The ENDED filter chip surfaces the dead
  // ones on demand — they're never deleted, just hidden from the default view.
  //
  // Pinned + Live still take precedence as their own rails so a chat you're
  // actively driving stays one click away. The status filter still applies on
  // top (e.g. 'waiting' further narrows to waiting-only).
  const { spawnedThreads, spawnedEndedThreads, archivedCount } = useMemo(() => {
    const metaFor = (id: string) => {
      const m = statusByThread.get(id);
      return { cwd: m?.cwd ?? null, session_id: m?.session_id ?? null };
    };
    const candidates = threads.filter((t) => passesFilter(t));
    const { spawned, archivedCount } = partitionThreads(candidates, metaFor);
    const byRecency = (a: DbChatThread, b: DbChatThread) =>
      new Date(b.last_message_at).getTime() -
      new Date(a.last_message_at).getTime();
    // Exclude Pinned (its own rail). LIVE spawned agents are the DEFAULT rail
    // content. DEAD spawned agents are split out for the ENDED filter only.
    const notPinned = spawned.filter((t) => !pinnedIds.has(t.id));
    const spawnedThreads = notPinned
      .filter((t) => liveSet.has(t.id))
      .sort(byRecency);
    const spawnedEndedThreads = notPinned
      .filter((t) => !liveSet.has(t.id))
      .sort(byRecency);
    return { spawnedThreads, spawnedEndedThreads, archivedCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, statusFilter, statusByThread, activityByThread, pinnedIds, liveSet]);

  // Mobile (<md): w-full — the parent page hides its main pane so this
  // sidebar IS the screen. Desktop (>=md): fixed 288px column beside main.
  return (
    // Warm Graphite: the rail recedes — surface-1 (dimmer than the canvas) with
    // a translucent-white hairline edge, never a heavy divider. Depth is
    // luminance, not shadow.
    <aside className="w-full md:w-72 md:shrink-0 border-r border-hairline bg-surface-1 flex flex-col h-full">
      {/* 2026-05-24 mobile-responsive: pl-16 lg:pl-4 clears the fixed
          hamburger button (top-4 left-4, ~40px) so the wordmark doesn't sit
          under it on phone. Desktop (lg+) restores standard padding —
          the sidebar takes the hamburger's spot via Sidebar.tsx.
          Warm Graphite: the brand wordmark + mono-uppercase eyebrow lockup
          (the "real product" metadata hierarchy) replaces the bare "Chats". */}
      {/* FIX #1 (critic round-1): the old single justify-between row crammed the
          155px SVG wordmark + clock + BOTH spawn buttons into a 288px column, so
          "CLAWDLING" z-fought "CEO agent" / "Project agent". Split into two
          honest rows: (1) the brand lockup ONLY (eyebrow over wordmark over the
          quiet mono clock — the "real instrument" metadata hierarchy), (2) the
          spawn selectors on their own grid row BELOW the wordmark zone. Nothing
          overlaps; the agent selectors live where they belong. */}
      <div className={`pl-16 lg:pl-4 ${inDrawer ? 'pr-12' : 'pr-3'} pt-3 pb-2 border-b border-hairline flex flex-col gap-2.5`}>
        {/* Row 1 — brand lockup only. Mono "CLAWDLING" eyebrow sits above the
            bespoke wordmark; the live clock is the quiet mono telemetry beside it
            (tertiary, no accent — the surface's one hero accent is spent below). */}
        <Link
          href="/"
          className="flex items-center justify-between gap-2 min-w-0 group/brand"
          title="Clawdling — back to home"
        >
          <span className="flex flex-col gap-0.5 leading-none min-w-0">
            <Eyebrow>CLAWDLING</Eyebrow>
            {/* The rail is navigational chrome (the chat surface's top bar), so it
                carries the mono eyebrow + a COMPACT text mark — NOT a second full
                SVG wordmark. The big `clawd` SVG lockup lives once, in the canvas
                hero (de-duplicates the "two identical wordmarks side by side"
                tell). Matches the global Sidebar's compact lockup treatment. */}
            <span className="text-sm weight-strong tracking-[-0.02em] lowercase text-1 opacity-90 group-hover/brand:opacity-100 transition-opacity duration-[var(--dur-base)]">
              clawd
            </span>
          </span>
          {/* CAT-12: hide the clock in-drawer so the drawer's top-right close
              (X) button has clear space (it overlapped the clock otherwise). */}
          {!inDrawer && <HeaderClock className="shrink-0 self-end" />}
        </Link>

        {/* Row 2 — spawn selectors, OUT of the wordmark zone (FIX #1). A 2-up
            grid so they share the column evenly and never collide with the mark.
            W6 (JD 2026-05-31): the ONLY spawnable classes are CEO agents + project
            agents (domains are the fixed 8 in the rail below).

            Critic r1 FIX #3 (single filled accent per screen): in grid mode the
            screen's ONE accent is the focused composer ring. The rail previously
            kept the "+ CEO agent" button on an accent OUTLINE (accent-border +
            accent-text) which still read as a competing amber touch alongside the
            composer + the (now-ghosted) alert pill. Both spawn buttons are now
            FULLY NEUTRAL twins — text-2 on a hairline surface-2 tile that lifts +
            warms to text-1 on hover. The CEO button stays the LEAD via its
            Circuitry nerve-hub glyph + first position, not a color. Zero amber in
            the rail; the composer holds the only accent. */}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            data-testid="spawn-ceo-agent"
            onClick={() => void spawnCeoAgent()}
            disabled={ceoBusy}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border-default bg-surface-2 text-2 text-xs weight-label px-2 py-1.5 hover:bg-surface-3 hover:text-1 active:scale-[0.97] disabled:opacity-50 transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out-strong)]"
            aria-label="New CEO agent"
            title="Spawn an ad-hoc CEO agent (full-power Clawd-class orchestrator)"
          >
            <Icon glyph={Circuitry} state="idle" size={13} aria-hidden />
            <span className="truncate">{ceoBusy ? '…' : 'CEO agent'}</span>
          </button>
          <button
            type="button"
            data-testid="spawn-project-agent"
            onClick={() => setSessionModalOpen(true)}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border-default bg-surface-2 text-2 text-xs weight-label px-2 py-1.5 hover:bg-surface-3 hover:text-1 active:scale-[0.97] transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out-strong)]"
            aria-label="New project agent"
            title="Spawn a project agent (loaded with a project's context)"
          >
            <Icon glyph={FolderSimple} state="idle" size={13} aria-hidden />
            <span className="truncate">Project agent</span>
          </button>
        </div>

        {/* CAT-05 (LIVE-MOBILE BUG-MOB-01): spawn-failure banner. Before this,
            a 500/502 from any rail-spawn (CEO / Project-via-modal / Domain /
            "+ New in this Space") produced TOTAL SILENCE — JD tapped and the
            screen was byte-identical. Now the failure surfaces here with a
            humanized, retry-able message (502 → bridge unreachable; else →
            couldn't start), dismissible. The buttons themselves stay enabled so
            "Tap to retry" works. */}
        {spawnError && (
          <div
            role="alert"
            data-testid="spawn-error-banner"
            className="mt-1.5 flex items-start gap-1.5 rounded-md bg-tint-error px-2 py-1.5 text-[11px] text-state-error"
          >
            <span className="flex-1 leading-snug">{spawnError}</span>
            <button
              type="button"
              onClick={() => setSpawnError(null)}
              aria-label="Dismiss spawn error"
              className="shrink-0 -mr-0.5 rounded p-0.5 opacity-70 hover:opacity-100 transition-opacity"
            >
              <Icon glyph={XGlyph} state="idle" size={12} aria-hidden />
            </button>
          </div>
        )}
      </div>

      {/* Status filter chips (PR-C) — scan to live agents fast (agent-deck
          pattern). Warm Graphite: selected chip = surface-3 (lighter, no
          shadow) + text-1; the waiting chip uses the attention TINT (14%-alpha
          pill, never a saturated fill); idle chips are text-3. */}
      <div className="px-3 py-1.5 flex items-center gap-1 border-b border-border-micro">
        {(['all', 'live', 'waiting', 'ended'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setStatusFilter(f)}
            className={`px-2 py-0.5 rounded-md text-[10px] weight-label uppercase tracking-wider transition-colors duration-[var(--dur-micro)] ${
              statusFilter === f
                ? f === 'waiting'
                  ? 'bg-tint-attention text-state-attention'
                  : 'bg-surface-3 text-1'
                : f === 'waiting' && needsYou.length > 0
                ? 'text-state-attention/80 hover:text-state-attention'
                : 'text-3 hover:text-1'
            }`}
          >
            {f === 'live'
              ? `Live${liveCount ? ` ${liveCount}` : ''}`
              : f === 'waiting'
              ? `Needs you${needsYou.length ? ` ${needsYou.length}` : ''}`
              : f}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
        {/* ── SPACE WORKSPACE (when arriving via /chat?space=<id>) — C1 ────────
            A Space is no longer a cwd-derived view chip: it's a real workspace
            panel backed by the cockpit spine. It shows the Space's scoped
            CONTEXT BUNDLE (pinned docs / memory keys a spawn inherits), its
            editable NOTES/memory (persisted to the spine), a "+ New in this
            Space" that inherits the workspace's spawn defaults, and a quick exit.
            Soft-degrades: when the spine is down the panel keeps the cwd-derived
            label and just hides the spine-backed bits. ───────────────────────── */}
        {initialSpace &&
          (() => {
            const def = getDomain(initialSpace);
            // Prefer the spine workspace's stored label; fall back to the
            // cwd-derived domain def so a cold/degraded spine still renders.
            // (The per-domain brand color is intentionally NOT used for tinting
            // anymore — FIX #3: the glyph identifies by shape + accent, never a
            // saturated hue.)
            const label = space?.label || def?.label || initialSpace;
            const isDomainSpace = DOMAIN_IDS.has(initialSpace);
            const pinnedCount = space?.bundle?.pinned_docs?.length ?? 0;
            const memoryCount = space?.bundle?.memory_keys?.length ?? 0;
            const bundleCount = pinnedCount + memoryCount;
            const spaceGlyph = domainGlyph(initialSpace);
            return (
              <section
                data-testid="space-workspace"
                className="rounded-lg border border-border-default bg-surface-2 overflow-hidden"
              >
                {/* Header: identity + counts + exit. FIX #3 — the per-domain
                    glyph identifies the workspace by its SHAPE, rendered at the
                    accent (this panel is the ONE focused Space, so the accent is
                    earned here) — never a saturated per-domain brand hue. */}
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <Icon
                    glyph={spaceGlyph.glyph}
                    state="active"
                    size={18}
                    className="shrink-0 text-accent-text"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block overline">Workspace</span>
                    <span className="block text-sm weight-label truncate text-1">
                      {label}
                    </span>
                  </span>
                  {space && (space.live_count > 0 || space.waiting_count > 0) && (
                    <span
                      className="font-mono text-[10px] text-3 shrink-0 tabular"
                      title={`${space.live_count} live · ${space.waiting_count} waiting in this Space`}
                    >
                      {space.live_count} live
                      {space.waiting_count > 0 ? ` · ${space.waiting_count} waiting` : ''}
                    </span>
                  )}
                  <Link
                    href="/chat"
                    className="inline-flex items-center justify-center w-5 h-5 rounded-md text-3 hover:text-1 hover:bg-surface-3 leading-none shrink-0 transition-colors duration-[var(--dur-micro)]"
                    title="Clear Space focus — show all chats"
                    aria-label="Clear Space focus"
                  >
                    <Icon glyph={XGlyph} state="idle" size={13} aria-hidden weight="bold" />
                  </Link>
                </div>

                {/* Context bundle — the Space-scoped context a spawn inherits.
                    Surfaced so JD sees the workspace carries real context, not
                    just a label. Only shown when the spine has a bundle. */}
                {bundleCount > 0 && (
                  <div
                    data-testid="space-bundle"
                    className="px-2.5 pb-1.5 flex items-center gap-1.5 text-[11px] text-2"
                    title="The Space-scoped context bundle a spawn inside this Space inherits"
                  >
                    <Icon glyph={Paperclip} state="idle" size={12} className="text-3" aria-hidden />
                    <span className="truncate">
                      {pinnedCount > 0 && `${pinnedCount} doc${pinnedCount === 1 ? '' : 's'}`}
                      {pinnedCount > 0 && memoryCount > 0 && ' · '}
                      {memoryCount > 0 && `${memoryCount} memory key${memoryCount === 1 ? '' : 's'}`}
                    </span>
                  </div>
                )}

                {/* Actions: a Space-scoped spawn + (for domain Spaces) the brain. */}
                <div className="px-2.5 pb-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="space-new"
                    disabled={spaceSpawnBusy || (isDomainSpace && domainBusy === initialSpace)}
                    onClick={() => void newInSpace()}
                    className="rounded-md border border-border-default text-[11px] weight-label px-1.5 py-0.5 text-1 hover:bg-surface-3 active:scale-[0.97] transition-[background-color,transform] duration-[var(--dur-micro)] disabled:opacity-60"
                    title={`Spawn a session scoped to the ${label} workspace (inherits its defaults)`}
                  >
                    {spaceSpawnBusy ? '…' : '+ New in this Space'}
                  </button>
                  {isDomainSpace && (
                    <button
                      type="button"
                      onClick={() => {
                        const entry = domainEntries.find((e) => e.def.id === initialSpace);
                        if (entry) void openDomainBrain(entry);
                      }}
                      className="rounded-md border border-border-default text-[11px] weight-label px-1.5 py-0.5 text-2 hover:bg-surface-3 hover:text-1 active:scale-[0.97] transition-[background-color,color,transform] duration-[var(--dur-micro)]"
                      title={`Open the ${label} persistent brain`}
                    >
                      Open brain
                    </button>
                  )}
                </div>

                {/* Space NOTES / memory — free text scoped to the workspace,
                    persisted to the spine. The durable "what is this workspace
                    about" the cwd-derived view could never hold. Only rendered
                    when the spine is reachable (space loaded). */}
                {space && (
                  <div className="px-2.5 pb-2">
                    <label className="block overline mb-0.5">
                      Space notes
                    </label>
                    <textarea
                      data-testid="space-notes"
                      value={notesDraft}
                      onChange={(e) => {
                        setNotesDraft(e.target.value);
                        setNotesDirty(true);
                      }}
                      rows={2}
                      placeholder="Notes / memory for this workspace…"
                      // CAT-22 (2026-06-12): iOS auto-zooms any input/textarea
                      // with font-size < 16px on focus. The rail IS a mobile
                      // surface (it's the drawer), so a 12px notes field zoomed
                      // the viewport on tap. Floor at 16px on mobile (text-base),
                      // revert to the compact 12px on desktop (md:text-[12px]).
                      className="w-full resize-y rounded-md border border-border-default bg-sunken px-2 py-1 text-base md:text-[12px] text-1 placeholder:text-4 focus:outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-colors duration-[var(--dur-micro)]"
                    />
                    {notesDirty && (
                      <div className="mt-1 flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setNotesDraft(space.notes ?? '');
                            setNotesDirty(false);
                          }}
                          className="text-[11px] text-3 hover:text-1 transition-colors duration-[var(--dur-micro)]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          data-testid="space-notes-save"
                          disabled={notesSaving}
                          onClick={() => void saveSpaceNotes()}
                          className="rounded-md bg-accent text-on-accent text-[11px] px-2 py-0.5 weight-label hover:bg-accent-hover active:scale-[0.97] transition-[background-color,transform] duration-[var(--dur-micro)] disabled:opacity-60"
                        >
                          {notesSaving ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })()}

        {/* ═══ W6: DOMAINS — the FIXED 8 persistent domain chats ═══════════
            JD's locked model (2026-05-31): "I want these domain chats to be
            persistent the exact same idea we have captured in this telegram. I
            want to see these chats in the chat area." These 8 entries are
            ALWAYS rendered (even when the brain isn't running yet). Clicking one
            opens-or-resumes that domain's ONE persistent continuity brain
            (spawn-domain persistent:true — idempotent reuse). A live brain
            shows green + 🧠 and jumps straight to its pane. This is the top,
            fixed section of the rail — the spine of the whole cockpit. */}
        {statusFilter !== 'ended' && (
          <section data-testid="rail-domains">
            <div className="px-2 pb-1 flex items-center gap-1.5 overline">
              <Icon glyph={Brain} state="domain" size={12} className="text-3" aria-hidden />
              <span>Domains</span>
              <span className="text-4 normal-case tracking-normal lowercase font-mono tabular">
                {domainEntries.length}
              </span>
            </div>
            <ul className="space-y-0.5">
              {domainEntries.map((entry) => {
                const waiting = entry.threadId
                  ? activityByThread.get(entry.threadId) === 'waiting'
                  : false;
                const busy = domainBusy === entry.def.id;
                // The focused Space (arrived via /chat?space=<id>) is the ONE
                // row that earns the sanctioned 2px left accent bar — the only
                // one-side accent allowed (a selection indicator, never decor).
                const selected = initialSpace === entry.def.id;
                const dGlyph = domainGlyph(entry.def.id);
                return (
                  <li key={`domain::${entry.def.id}`} className="relative">
                    {/* FIX #9: the active/focused row carries the rail's ONE
                        sanctioned side-accent — the 2px left amber bar — so
                        selection is read by the accent, never by a colored icon. */}
                    {selected && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-accent"
                      />
                    )}
                    <button
                      type="button"
                      data-testid={`rail-domain-${entry.def.id}`}
                      data-live={entry.live ? '1' : '0'}
                      disabled={busy}
                      onClick={() => void openDomainBrain(entry)}
                      className={`group/row w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] weight-label text-left transition-colors duration-[var(--dur-micro)] disabled:opacity-60 ${
                        selected
                          ? 'bg-accent-subtle text-1'
                          : entry.live
                          ? 'text-1 hover:bg-surface-3'
                          : 'text-2 hover:bg-surface-2 hover:text-1'
                      }`}
                      title={
                        entry.live
                          ? `Open ${entry.def.label}'s persistent brain (running)`
                          : `Start or resume ${entry.def.label}'s persistent brain`
                      }
                    >
                      {/* Critic round-3 FIX #4 — the saturated filled status dots
                          (bg-amber-400 / bg-state-ready) are gone. Status is now
                          the bespoke StatusGlyph ring state machine in the muted
                          warm-graphite state set: waiting → attention (the one
                          pulsing eye-demand), live → working ring, idle → hollow
                          grey ring. No neon dot; the glyph reserves a fixed 14px
                          box so rows never shift when state toggles. */}
                      <span className="shrink-0 flex items-center justify-center w-[14px]">
                        <StatusGlyph
                          state={waiting ? 'attention' : entry.live ? 'working' : 'idle'}
                          size={12}
                          title={
                            waiting
                              ? `${entry.def.label} finished its turn — waiting for you`
                              : entry.live
                              ? `${entry.def.label}'s brain is running`
                              : `${entry.def.label} idle`
                          }
                        />
                      </span>
                      {/* FIX #3 — the bespoke per-domain glyph renders in
                          text-secondary (white-at-66%), NOT its saturated brand
                          hue. It lifts to text-1 with the row on hover, and the
                          active row's accent-subtle fill already carries the
                          selection. Weight switches regular→fill on the active
                          row so the icon still encodes state — without a single
                          competing color. No more 9 neon rail hues. */}
                      <Icon
                        glyph={dGlyph.glyph}
                        state={selected || entry.live ? 'active' : 'idle'}
                        size={16}
                        className={`shrink-0 transition-colors duration-[var(--dur-micro)] ${
                          selected
                            ? 'text-accent-text'
                            : 'text-2 group-hover/row:text-1'
                        }`}
                        aria-hidden
                      />
                      {entry.live && (
                        <span
                          data-testid={`domain-brain-badge-${entry.def.id}`}
                          className="inline-flex shrink-0 text-accent-text"
                          title="Persistent continuity brain — survives restarts, never reaped"
                          aria-label="persistent brain"
                        >
                          <Icon glyph={Brain} state="active" size={12} aria-hidden />
                        </span>
                      )}
                      <span className="truncate flex-1">{entry.def.label}</span>
                      <span className="text-[9px] font-mono uppercase tracking-wider text-3 shrink-0 tabular">
                        {busy ? '…' : entry.live ? 'live' : 'open'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* ── LIVE section REMOVED (W9 named-live-tabs, 2026-06-01) ──────────
            JD flagged the rail's LIVE section as redundant: a live domain brain
            showed a green dot in DOMAINS *and* re-listed itself as a row here,
            and a spawned CEO/project agent showed in SPAWNED *and* here. Live
            sessions are now surfaced as NAMED middle tabs in the cockpit (each
            with a live/amber-waiting dot), the DOMAINS rows keep their green +
            amber dots, and the Needs-you filter chip still answers "anything
            waiting I don't have open?". So this whole re-listing was pure
            duplication and is gone.

            KEPT (do NOT remove): every `live*` derivation — `liveThreads`,
            `liveSet`, `computeLiveSet`, `liveCount`, `paneableSet` — still
            powers the Live filter chip count + the open-as-pane routing + the
            "no agents running" empty-state note below. Only the RENDERED
            section was deleted. ──────────────────────────────────────────── */}

        {/* ── PINNED (chats you're actively driving — one click away). Kept
            from the prior rail; pinned chats float above Spawned regardless of
            class so the 2-3 you're working float to the top. ──────────────── */}
        {pinnedThreads.length > 0 && (
          <section data-testid="rail-pinned">
            <div className="px-2 pb-1 flex items-center gap-1.5 overline">
              <Icon glyph={PushPin} state="active" size={12} className="text-3" aria-hidden />
              <span>Pinned</span>
              <span className="text-4 normal-case tracking-normal lowercase font-mono tabular">
                {pinnedThreads.length}
              </span>
            </div>
            <ul className="space-y-0.5">
              {pinnedThreads.map((t) => (
                <ThreadRow
                  key={`pinned::${t.id}`}
                  thread={t}
                  active={t.id === activeThreadId}
                  isActive={activeSet.has(t.id)}
                  waiting={activityByThread.get(t.id) === 'waiting'}
                  openAsPane={paneableSet.has(t.id)}
                  meta={statusByThread.get(t.id) || null}
                  brainDomain={brainDomainByThread.get(t.id)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* ═══ W6 + RAIL-PURGE: SPAWNED — ONLY *LIVE* ad-hoc CEO + project
            agents ═══════════════════════════════════════════════════════════
            JD's locked model: "the only agents that are spawnable is CEO agents
            and project agents." This section lists exactly those — and, after
            the RAIL-PURGE fix (2026-06-01), ONLY the ones still LIVE on the
            bridge. The default rail no longer shows the junk drawer of dead
            exited sessions; those move to the ENDED filter below. Everything
            else (legacy specialist chats, old ad-hoc message threads,
            domain-scoped rows) is ARCHIVED: hidden but kept in the DB,
            recoverable. partitionThreads() is the tested classifier; the
            live/dead split happens in the spawnedThreads memo. */}
        {statusFilter !== 'ended' && spawnedThreads.length > 0 && (
          <section data-testid="rail-spawned">
            <div className="px-2 pb-1 flex items-center gap-1.5 overline">
              <Icon glyph={Circuitry} state="idle" size={12} className="text-3" aria-hidden />
              <span>Spawned</span>
              <span className="text-4 normal-case tracking-normal lowercase font-mono tabular">
                {spawnedThreads.length}
              </span>
            </div>
            <ul className="space-y-0.5">
              {spawnedThreads.map((t) => (
                <ThreadRow
                  key={`spawned::${t.id}`}
                  thread={t}
                  active={t.id === activeThreadId}
                  isActive={activeSet.has(t.id)}
                  waiting={activityByThread.get(t.id) === 'waiting'}
                  openAsPane={paneableSet.has(t.id)}
                  meta={statusByThread.get(t.id) || null}
                  brainDomain={brainDomainByThread.get(t.id)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* ═══ RAIL-PURGE: ENDED — the dead spawned sessions, on demand ══════
            The default rail hides exited/crashed CEO + project sessions so JD
            sees only what's live (the "junk drawer" fix). They are NOT deleted
            — clicking the ENDED filter chip surfaces them here so JD can resume
            / replay any of them. Each row still opens its pane (static
            transcript replay + "Spawn new with same prompt" recovery). This
            section ONLY renders under the ENDED filter; the live SPAWNED
            section above is hidden there. */}
        {statusFilter === 'ended' && spawnedEndedThreads.length > 0 && (
          <section data-testid="rail-spawned-ended">
            <div className="px-2 pb-1 flex items-center gap-1.5 overline">
              <Icon glyph={Archive} state="domain" size={12} className="text-3" aria-hidden />
              <span>Ended</span>
              <span className="text-4 normal-case tracking-normal lowercase font-mono tabular">
                {spawnedEndedThreads.length}
              </span>
            </div>
            <ul className="space-y-0.5">
              {spawnedEndedThreads.map((t) => (
                <ThreadRow
                  key={`spawned-ended::${t.id}`}
                  thread={t}
                  active={t.id === activeThreadId}
                  isActive={activeSet.has(t.id)}
                  waiting={activityByThread.get(t.id) === 'waiting'}
                  openAsPane={paneableSet.has(t.id)}
                  meta={statusByThread.get(t.id) || null}
                  brainDomain={brainDomainByThread.get(t.id)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* ENDED filter, nothing to show — tell JD the drawer is empty rather
            than leaving a blank panel (the 8 domains still render above). */}
        {statusFilter === 'ended' && spawnedEndedThreads.length === 0 && (
          <div className="px-3 py-8 text-xs text-3 text-center">
            No ended CEO or project sessions.
          </div>
        )}

        {/* Archived count — a quiet line so JD knows past chats aren't gone,
            just hidden (recoverable). No destructive op happened. */}
        {archivedCount > 0 && (
          <div
            data-testid="rail-archived-note"
            className="px-2 pt-1 text-[10px] text-4 font-mono tabular"
            title="Past chats are hidden from the rail but kept in the database — recoverable, not deleted."
          >
            {archivedCount} archived chat{archivedCount === 1 ? '' : 's'} hidden
          </div>
        )}

        {/* ═══ HISTORY — reopen any past chat (feat/cockpit-naming-history) ═══
            The going-forward "list of past/ended chats you can click to revive"
            (JD's ChatGPT/Claude-style ask). Lists live + parked sessions from
            the last 30 days, newest-first, each by its auto-generated title.
            Clicking a parked one revives it (claude --resume); a live one
            reconnects to its existing pane. Self-contained — owns its own poll.*/}
        <SessionHistoryPanel openSidInDeck={openSidInDeck} />

        {/* The 8 fixed domain chats always render, so the rail is never truly
            empty. This note only shows when the Live filter hides everything. */}
        {statusFilter === 'live' && liveThreads.length === 0 && domainEntries.every((e) => !e.live) && (
          <div className="px-3 py-8 text-xs text-3 text-center leading-relaxed">
            No agents running right now. Click a{' '}
            <span className="text-1 weight-label">Domain</span> above to open its
            brain, or <span className="text-1 weight-label">+ CEO agent</span> /{' '}
            <span className="text-1 weight-label">+ Project agent</span>.
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-hairline">
        <Link
          href="/"
          className="block text-xs text-3 hover:text-1 transition-colors duration-[var(--dur-micro)]"
        >
          ← Back to dashboard
        </Link>
      </div>

      {/* W6: the only picker-driven spawn is a PROJECT agent. mode="projects"
          strips Domains / Specialists / Launch-all / Ad-hoc — domains are the
          fixed 8 above, ad-hoc CEO is the header button. */}
      <NewSessionPicker
        open={sessionModalOpen}
        onClose={() => setSessionModalOpen(false)}
        mode="projects"
        onLaunched={(sid) => {
          // W9: APPEND a spawned project agent to the deck so it adds a named
          // tab next to any prior open sessions instead of replacing them
          // (same CEO-disappear root-cause fix).
          setSessionModalOpen(false);
          openSidInDeck(sid);
        }}
        hasOpenPanes={false}
      />
    </aside>
  );
}

// Status pill component — visualises the persisted session state polled
// from Supabase. Color mapping (per workplan P1.2 spec):
//   green  → live (chat_sessions.status='live')
//   gray   → idle/ended (status='exited' with exit_code 0, or no session row
//                        for non-project-session thread kinds)
//   amber  → crashed (reserved — populated by P1.4 once it ships)
//   red    → error (reserved — populated by P1.4 once it ships)
//   blank  → starting (transient, <1s; suppress to avoid flicker)
//
// `null` meta = thread isn't in the latest poll response yet (cold load,
// or row was deleted). Render no pill rather than "unknown" so legacy
// kind=agent / kind=ad-hoc threads (which never have a chat_sessions row)
// don't show a permanent gray pill cluttering the sidebar.
function SessionStatusPill({ meta }: { meta: ThreadMetaRow | null }): React.ReactElement | null {
  // No meta yet (initial load) → render nothing. Better than "unknown" gray
  // because it would show on every row for the first 5s after page load.
  if (!meta) return null;
  // For threads that never spawn a session (kind=agent, ad-hoc), the API
  // returns session_status=null. Don't render — they're not sessions.
  if (meta.session_status === null) return null;

  // Warm Graphite: the persisted session state is carried by the SIGNATURE
  // StatusGlyph (the bespoke ring/pie state machine) instead of a saturated
  // neon dot — its color + motion are the muted warm-graphite state set, and
  // the mono label rides alongside in text-3.
  let glyphState: GlyphState;
  let label: string;
  let title: string;
  switch (meta.session_status) {
    case 'live':
      glyphState = 'working';
      label = 'live';
      title = 'Session live (bridge is running this agent)';
      break;
    case 'starting':
      glyphState = 'queued';
      label = 'start';
      title = 'Session starting';
      break;
    case 'exited':
      glyphState = 'idle';
      label = 'ended';
      title = meta.exited_at
        ? `Session ended at ${new Date(meta.exited_at).toLocaleTimeString()} (exit ${meta.exit_code ?? '?'})`
        : 'Session ended';
      break;
    case 'crashed':
      glyphState = 'attention';
      label = 'crash';
      title = 'Session crashed (bridge died with no clean exit) — reserved for P1.4';
      break;
    case 'error':
      glyphState = 'error';
      label = 'error';
      title = 'Session error — reserved for P1.4';
      break;
    default:
      // Defensive: unknown status string → render the idle ring so JD sees
      // something is off rather than the pill silently disappearing.
      glyphState = 'idle';
      label = 'unknown';
      title = `Unknown status: ${String(meta.session_status)}`;
      break;
  }

  return (
    <span
      className="flex items-center gap-1 shrink-0"
      title={title}
      aria-label={`session ${label}`}
    >
      <StatusGlyph state={glyphState} size={12} title={title} />
      <span className="text-[9px] font-mono uppercase tracking-wider text-3">
        {label}
      </span>
    </span>
  );
}

// Single row — pulled out so the four sections (projects, agents, sessions,
// ad-hoc) stay readable above and don't duplicate render logic.
//
// `isActive` (cockpit-v1) toggles a green pulsing dot to the LEFT of the
// thread icon when a claude subprocess is currently EMITTING output on the
// bridge right now. Source: useActiveThreads() hook → /api/threads/active.
// This is "live, mid-turn" — it goes false the instant the agent goes idle.
//
// `meta` (cockpit-multi-session-v2 P1.2) carries the latest chat_sessions
// row for this thread, polled at 5s from /api/threads/meta. Drives a SECOND
// indicator (the status pill on the right) that reflects PERSISTED session
// state — live / idle / ended / unknown — independent of whether any pane
// is currently open. The two indicators are complementary: pulse-dot answers
// "is the agent typing right this second?"; status pill answers "is the
// session alive at all?". A live session that's idle between turns shows
// pill=live, pulse=off; a session running a long tool call shows both on;
// an exited session shows pill=ended, pulse=off.
//
// Right-click on any project-session thread opens a Chat Cockpit context
// menu with "Open in grid (new pane)" / "Open in grid (replace active)".
// Implemented inline (no portal) for simplicity — closes on outside click.
function ThreadRow({
  thread: t,
  active,
  isActive = false,
  waiting = false,
  openAsPane = false,
  meta = null,
  brainDomain = undefined,
}: {
  thread: DbChatThread;
  active: boolean;
  isActive?: boolean;
  /** Agent finished its turn and is blocked on you — shows an amber dot. */
  waiting?: boolean;
  /** When set, this LIVE row is its domain's persistent continuity brain —
      renders a 🧠 badge (the value is the domain id, used for the tooltip).
      undefined = ad-hoc disposable session (no badge). Bridge truth. */
  brainDomain?: string | null;
  /** Thread has a session row (live OR dead) — left-click opens its COCKPIT
      PANE (appended to the grid, keep-alive) instead of the empty
      /chat/[threadId] message view. Live → pane streams from the bridge;
      dead → pane statically replays the transcript from /api/sessions/<sid>/
      history (see SessionTerminal.tsx:441) and exposes the "Spawn new with
      same prompt" button. This is what makes "go back and forth between
      chats — live or dead — and always see history" work (JD msg 8136). */
  openAsPane?: boolean;
  meta?: ThreadMetaRow | null;
}) {
  const sub = threadSubLabel(t);
  // M5 agent identity. Label = the spawn-time agent_name when present (human:
  // "Health · weekly summary"), else the thread title (old derivation). Space =
  // the domain id derived from the session cwd, used for the color dot badge.
  const rowLabel = meta?.agent_name?.trim() || t.title;
  const rowSpace = spaceOf(meta?.cwd);
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const pinned = useIsPinned(t.id);

  // Hydration guard (W7, QA NO-GO fix): formatRelative() calls Date.now() and
  // toLocaleDateString() during render, so the SSR HTML ("5m") and the first
  // client render ("6m", or a different-TZ date) diverge → React #418 text
  // mismatch on every /chat load (audit FINAL-QA-batch.md §4). We render NOTHING
  // for the timestamp on the server + first client paint (identical → no
  // mismatch), then flip `mounted` after hydration to fill in the live value.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Only project-session threads support "Open in grid" (Chat Cockpit
  // M2). Other thread types open the standard /chat/[threadId] view on
  // right-click → just suppress the menu so the OS native menu shows.
  const supportsGrid = t.kind === 'project-session';

  function onContextMenu(e: React.MouseEvent) {
    if (!supportsGrid) return;
    e.preventDefault();
    setMenuOpen({ x: e.clientX, y: e.clientY });
  }

  // Close menu on Escape or outside click.
  useEffect(() => {
    if (!menuOpen) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(null);
    }
    function onClick() {
      setMenuOpen(null);
    }
    window.addEventListener('keydown', onEsc);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onEsc);
      window.removeEventListener('click', onClick);
    };
  }, [menuOpen]);

  async function openInGrid(replace: boolean, _fromMenu: boolean = false) {
    if (busy) return;
    setBusy(true);
    setMenuOpen(null);
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(t.id)}/session`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        // Could surface a toast — for now let the row revert silently.
        return;
      }
      const data = (await res.json()) as { session_id?: string };
      if (!data.session_id) return;

      // Decide URL: replace = swap into existing grid; otherwise append.
      const sp = new URLSearchParams(window.location.search);
      const current = (sp.get('panes') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      let next: string[];
      if (replace || current.length === 0) {
        next = [data.session_id];
      } else {
        if (current.includes(data.session_id)) {
          next = current; // already open — just navigate to grid mode
        } else if (current.length >= PANE_SOFT_CAP) {
          // C5 no-cap (2026-06-10): was a hardcoded `6` — a DIFFERENT number
          // than openSidInDeck's `10`, so opening a thread via the right-click
          // menu evicted the deck's oldest pane at 6 while the rail-spawn path
          // didn't until 10. Both now share PANE_SOFT_CAP (cockpitCaps.ts), so
          // the unbounded deck bumps-oldest only at the single safety limit.
          next = [...current.slice(1), data.session_id];
        } else {
          next = [...current, data.session_id];
        }
      }

      // V3.2 (2026-05-28, JD msg 8280): V2.1 click-mode resolution removed
      // — render mode is now driven by the chrome-level Chat/Pane toggle
      // (?mode=chat|pane), not by per-click resolution. We always append
      // to the deck (?panes=…) and let the toolbar toggle decide whether
      // the user sees a single focused chat or the grid. ?focus= is
      // preserved by cockpitMode rules (chat mode: the visible chat;
      // pane mode: maximized pane) so we don't force-delete it here.
      const url = new URLSearchParams(window.location.search);
      url.set('panes', next.join(','));
      router.push(`/chat?${url.toString()}`);
    } catch {
      // Network error — silently bail; user can right-click again.
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="group relative">
      <Link
        // href is ALWAYS the transcript URL. For a LIVE row the plain click is
        // intercepted below → cockpit pane; the transcript href only fires on
        // cmd/ctrl/shift-click (open transcript in a new tab — preserved power-
        // user behavior). Keeping the href as the transcript (not '/chat') means
        // a modifier-click on a live agent still pops its history, and a non-JS
        // / prefetch fallback degrades to the transcript, never a 404.
        href={`/chat/${t.id}`}
        onContextMenu={onContextMenu}
        onClick={
          openAsPane
            ? (e) => {
                // Thread has a session (live OR dead) — a plain left-click
                // opens/focuses its cockpit PANE (?panes=<sid>), NEVER the
                // empty /chat/[threadId] "No messages yet" view. For a LIVE
                // session this routes you to the running agent (M1, JD's #1
                // break). For an EXITED/CRASHED session the pane statically
                // replays the transcript from /api/sessions/<sid>/history
                // and shows the "Spawn new with same prompt" recovery button
                // (JD msg 8136, 2026-05-27: "history of each panel isnt
                // saved when you go back and forth back into old chats…").
                // /api/threads/[threadId]/session prefers live → most-recent
                // by started_at, so a thread with mixed live+dead opens
                // live, and a thread with only dead opens most-recent-dead.
                // cmd/ctrl/shift-click falls through to the transcript href
                // so power users can still pop history in a new tab.
                if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                openInGrid(false);
              }
            : undefined
        }
        className={`relative flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-[var(--dur-micro)] ${
          active
            ? 'bg-accent-subtle text-1'
            : 'text-2 hover:bg-surface-2 hover:text-1'
        }`}
      >
        {/* Selected row → the sanctioned 2px left accent bar (selection
            indicator only — the one one-side accent allowed). */}
        {active && (
          <span
            aria-hidden="true"
            className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-accent"
          />
        )}
        {/* Critic round-3 FIX #4 — the saturated pulsing dots (bg-amber-400 /
            bg-state-ready) are replaced by the bespoke StatusGlyph ring state
            machine in the muted state set: waiting → attention (the one pulsing
            eye-demand), running → working ring, otherwise a fixed-width spacer so
            rows never shift when state toggles. */}
        {waiting ? (
          <span className="mt-0.5 shrink-0 flex w-[14px] justify-center" aria-hidden="true">
            <StatusGlyph state="attention" size={12} title="Finished its turn — waiting for you" />
          </span>
        ) : isActive ? (
          <span className="mt-0.5 shrink-0 flex w-[14px] justify-center" aria-hidden="true">
            <StatusGlyph state="working" size={12} title="Agent running" />
          </span>
        ) : (
          // Reserve the same width so rows don't shift horizontally when the
          // glyph toggles on/off — keeps the icon column visually stable.
          <span className="mt-0.5 h-3.5 w-[14px] shrink-0" aria-hidden="true" />
        )}
        {/* Bespoke per-agent / per-kind glyph (NO emoji) — regular weight,
            tinted text-2, lifting to text-1 with the row on hover. */}
        <span className="mt-0.5 shrink-0 text-2 group-hover:text-1 transition-colors duration-[var(--dur-micro)]">
          <Icon glyph={threadGlyph(t)} state="idle" size={16} aria-hidden />
        </span>
        <span className="flex-1 min-w-0">
          {/* M5 agent identity: prefer the spawn-time agent_name (what the
              agent IS + what it's DOING) over the machine thread title, with a
              quiet domain marker derived from cwd. Falls back to t.title when no
              agent_name (legacy / agent / ad-hoc threads).
              FIX #3 — the domain marker is GREY (text-3), not a saturated brand
              hue: the rail's color budget is the ONE accent, spent on selection. */}
          {rowSpace && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle shrink-0 bg-text-3/60"
              title={`${getDomain(rowSpace)?.label || rowSpace} domain`}
              aria-hidden="true"
            />
          )}
          {/* Persistent continuity-brain badge (MA-2/MA-4). The bespoke Brain
              glyph (NOT 🧠) marks this live row as its domain's ONE long-lived
              brain — survives bridge restarts, exempt from the idle reaper — vs
              a disposable ad-hoc worker (no badge). undefined → not a brain. */}
          {brainDomain !== undefined && (
            <span
              data-testid="persistent-brain-badge"
              className="mr-1 inline-flex align-middle text-accent-text"
              title={
                brainDomain
                  ? `Persistent ${getDomain(brainDomain)?.label || brainDomain} brain — survives restarts, never reaped`
                  : 'Persistent continuity brain — survives restarts, never reaped'
              }
              aria-label="persistent brain"
            >
              <Icon glyph={Brain} state="active" size={11} aria-hidden />
            </span>
          )}
          <span className="truncate align-middle weight-label" title={rowLabel}>
            {rowLabel}
          </span>
          <span className="block text-[10px] text-3 font-mono tabular" suppressHydrationWarning>
            {mounted ? formatRelative(t.last_message_at) : ''}
            {mounted && sub ? ` · ${sub}` : ''}
          </span>
        </span>
        {/* P1.2 session status pill — polled from Supabase every 5s,
            independent of any open SSE stream. */}
        <SessionStatusPill meta={meta} />
        {/* Pin toggle. role=button (not <button>) so it can nest inside the
            <Link> anchor without invalid-HTML interactive nesting. Hidden
            until row hover; always visible once pinned. */}
        <span
          role="button"
          tabIndex={0}
          aria-label={pinned ? 'Unpin chat' : 'Pin to top'}
          aria-pressed={pinned}
          title={pinned ? 'Unpin' : 'Pin to top'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePin(t.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              togglePin(t.id);
            }
          }}
          className={`shrink-0 self-center inline-flex cursor-pointer leading-none px-0.5 transition-opacity duration-[var(--dur-micro)] ${
            pinned
              ? 'opacity-100 text-accent-text'
              : 'opacity-0 text-3 group-hover:opacity-50 hover:!opacity-100 hover:!text-1'
          }`}
        >
          {/* Bespoke PushPin glyph (NOT 📌) — fill weight when pinned, regular
              when it's the hover affordance. */}
          <Icon glyph={PushPin} state={pinned ? 'active' : 'idle'} size={12} aria-hidden />
        </span>
      </Link>

      {menuOpen && (
        <div
          // Position is fixed to viewport coords. z-[150] sits above
          // ThreadSidebar but below NewSessionModal (z-200) and the
          // PaneSwitcher (z-210). A popover IS one of the few surfaces the
          // design system allows a shadow on (overlays only).
          style={{ left: menuOpen.x, top: menuOpen.y, boxShadow: 'var(--shadow-popover)' }}
          className="fixed z-[150] min-w-[220px] rounded-lg border border-border-default bg-surface-3 py-1 text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => openInGrid(false, true)}
            className="block w-full text-left px-3 py-1.5 text-1 hover:bg-surface-4 transition-colors duration-[var(--dur-micro)] disabled:opacity-50"
          >
            Add to grid (new pane)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => openInGrid(true, true)}
            className="block w-full text-left px-3 py-1.5 text-1 hover:bg-surface-4 transition-colors duration-[var(--dur-micro)] disabled:opacity-50"
          >
            Open in grid (replace)
          </button>
          <div className="my-1 border-t border-border-micro" />
          <Link
            href={`/chat/${t.id}`}
            className="block px-3 py-1.5 text-2 hover:bg-surface-4 hover:text-1 transition-colors duration-[var(--dur-micro)]"
          >
            Open standalone
          </Link>
        </div>
      )}
    </li>
  );
}
