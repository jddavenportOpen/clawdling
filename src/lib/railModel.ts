// ═══════════════════════════════════════════════════════════════════════════
// railModel.ts — pure rail-composition logic for the persistent-domain-chats
// rail (W6, 2026-05-31, JD's locked model).
//
// JD's model (his words): "I want these domain chats to be persistent the exact
// same idea we have captured in this telegram. I want to see these chats in the
// chat area. And then the only agents that are spawnable is CEO agents and
// project agents."
//
// Concretely the rail renders exactly TWO sections:
//   1. DOMAINS — the configured domains (from src/config/domains.ts). Always
//      present, even if no session is running yet. Each is a persistent
//      continuity brain. Clicking one opens-or-resumes that domain's ONE brain
//      (idempotent reuse).
//   2. SPAWNED — only ad-hoc + project agents that are currently
//      live/recent. Nothing else.
//
// EVERYTHING ELSE is ARCHIVED = HIDDEN-BUT-RECOVERABLE. We do NOT delete data;
// the threads stay in the DB. The rail simply does not render legacy specialist
// chats, old ad-hoc message threads, domain-scoped thread rows (folded into the
// fixed domain entry instead), past project history beyond live, etc.
//
// This module is the testable contract (mirrors computeLiveSet's pattern): the
// component delegates to these pure functions so the vitest suite IS the rail's
// behavior, with no diverging copy.
// ═══════════════════════════════════════════════════════════════════════════

import { DOMAINS, DOMAIN_IDS, type DomainDef } from '@/config/domains';

/** Minimal thread shape the rail classifier needs (subset of DbChatThread). */
export interface RailThread {
  id: string;
  title: string;
  kind: string;
  project_slug: string | null;
}

/** Per-thread meta the rail derives class from (subset of the meta poll). */
export interface RailThreadMeta {
  /** cwd of the latest session — domain is derived from this. */
  cwd?: string | null;
  /** session_id of the latest session — null means "no session ever spawned". */
  session_id?: string | null;
}

/** A live persistent domain brain, as reported by /api/sessions/list. */
export interface BrainRow {
  /** Bridge session id (sid) of the live brain — used to open its pane. */
  id?: string;
  thread_id?: string;
  live?: boolean;
  persistent?: boolean;
  domain?: string | null;
}

// Derive a domain id from a session cwd (<state-root>/domains/<id>/). Mirrors
// ThreadSidebar.spaceOf — kept here so the classifier is self-contained.
export function domainOfCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  // Domain sessions are rooted at <state-root>/domains/<id>/. Match the generic
  // path segment (mirrors ThreadSidebar.spaceOf) — NOT a hardcoded home dir.
  const m = cwd.match(/\/domains\/([^/]+)/);
  if (m && DOMAIN_IDS.has(m[1])) return m[1];
  return null;
}

// The three rail classes (JD's model). 'domain' rows are NOT rendered as their
// own thread row — they're folded into the fixed domain entry. Only 'ceo' and
// 'project' threads appear in the Spawned section. 'archived' is hidden.
export type RailClass = 'domain' | 'ceo' | 'project' | 'archived';

// Classify a single thread into one of the rail classes.
//
//   domain   → the thread's latest session lives under <state-root>/domains/<id>/.
//              Represented by the fixed domain entry, not a separate row.
//   project  → thread is bound to a project (project_slug set) OR is a
//              project-session CLI thread with a session.
//   ceo      → an ad-hoc, full-power cockpit session with a session row that is
//              neither a domain nor a project — i.e. an ad-hoc CEO/worker agent.
//   archived → everything else (legacy specialist `agent` chats with no session,
//              old ad-hoc message threads, never-spawned threads). HIDDEN but
//              kept in the DB — recoverable, not deleted.
export function classifyThread(
  t: RailThread,
  meta: RailThreadMeta | null | undefined
): RailClass {
  const cwd = meta?.cwd ?? null;
  const sid = meta?.session_id ?? null;

  // Domain sessions are folded into the fixed domain entries.
  if (domainOfCwd(cwd)) return 'domain';

  // Project: explicit slug, or a project-session CLI thread that actually spawned.
  if (t.project_slug) return 'project';
  if (t.kind === 'project-session' && sid) return 'project';

  // CEO / ad-hoc: a live-or-dead ad-hoc cockpit session that isn't a domain or
  // project. These are the disposable full-power CEO/worker agents.
  if (sid && t.kind !== 'agent') return 'ceo';

  // Everything else — legacy specialist agent chats, no-session ad-hoc threads,
  // never-spawned project-sessions — is archived (hidden but recoverable).
  return 'archived';
}

// The fixed domain entry rendered in the rail. ALWAYS one per DOMAINS row,
// regardless of whether a brain is currently running.
export interface DomainEntry {
  def: DomainDef;
  /** True iff a live persistent brain currently exists for this domain. */
  live: boolean;
  /** sid of the live brain (to open its pane) — null when not running. */
  sid: string | null;
  /** thread_id of the live brain — null when not running. */
  threadId: string | null;
}

// Build the FIXED 8 domain entries. Always returns DOMAINS.length entries in
// DOMAINS order. A domain is marked live when /api/sessions/list reports a
// live + persistent row whose `domain` matches (bridge truth) — that's the
// running continuity brain. Otherwise the entry is "cold": clicking it will
// create-or-resume the brain (persistent spawn-domain).
export function buildDomainEntries(
  brains: BrainRow[] | undefined
): DomainEntry[] {
  // domain id → the live brain row (first wins; bridge truth).
  const liveByDomain = new Map<string, BrainRow>();
  for (const b of brains ?? []) {
    if (b.live && b.persistent && b.domain && !liveByDomain.has(b.domain)) {
      liveByDomain.set(b.domain, b);
    }
  }
  return DOMAINS.map((def) => {
    const brain = liveByDomain.get(def.id);
    return {
      def,
      live: !!brain,
      sid: brain?.id ?? null,
      threadId: brain?.thread_id ?? null,
    };
  });
}

// Split a thread list into the rail's two visible buckets + the hidden archive.
// `metaFor(id)` returns the latest meta row for a thread (cwd + session_id).
export function partitionThreads<T extends RailThread>(
  threads: T[],
  metaFor: (id: string) => RailThreadMeta | null | undefined
): { spawned: T[]; archivedCount: number } {
  const spawned: T[] = [];
  let archivedCount = 0;
  for (const t of threads) {
    const cls = classifyThread(t, metaFor(t.id));
    if (cls === 'ceo' || cls === 'project') {
      spawned.push(t);
    } else {
      // domain rows are folded into fixed entries; archived rows are hidden.
      // Both are "not a standalone Spawned row." Count only true-archive for
      // the optional "N archived" affordance.
      if (cls === 'archived') archivedCount += 1;
    }
  }
  return { spawned, archivedCount };
}
