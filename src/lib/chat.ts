// ═══════════════════════════════════════════════════════════════════════════
// Chat query helpers — Phase 1 persistence
// Wraps Supabase access for chat_threads / chat_messages / chat_uploads.
// ═══════════════════════════════════════════════════════════════════════════

import {
  getServerClient,
  getNextAuthClient,
  type ChatMessageRole,
  type ChatThreadKind,
  type DbChatMessage,
  type DbChatThread,
  type DbChatUpload,
} from '@/lib/supabase';

export type ChatMessage = DbChatMessage;
export type ChatThread = DbChatThread;
export type ChatUpload = DbChatUpload;

// ── Users (FK parent for chat_threads) ─────────────────────────────────────

/**
 * Idempotently ensure a row exists in next_auth.users for `userId` before we
 * insert anything that FKs to it (chat_threads.user_id → next_auth.users.id).
 *
 * ROOT CAUSE this guards (CAT-06 / BUG-R1 / LIVE-DESKTOP BUG-6, 2026-06-12):
 *   createThread() inserted chat_threads with a user_id that had no backing
 *   next_auth.users row → Postgres FK violation 23503 → the route 500'd. This
 *   500'd the QA bot (synthetic-session id with no adapter-created row) AND
 *   would 500 ANY genuinely-new authenticated user whose adapter row is
 *   missing (e.g. session id outliving the user row). It blocked all
 *   disposable-session QA and was a real onboarding bug.
 *
 * Fix: a merge-duplicates upsert keyed on the PK `id`. Cheap (one row),
 * idempotent (no-op once the row exists), and self-healing — the FK parent is
 * guaranteed present before the child insert, for the QA bot and every real
 * new user alike. NextAuth's adapter still owns the row's lifecycle on real
 * sign-in; this only backfills a missing parent so the insert can't FK-fault.
 *
 * Targets the `next_auth` schema (getNextAuthClient), NOT public.users —
 * public.users is unrelated/empty; the FK references next_auth.users.
 */
export async function ensureUserRow(
  userId: string,
  email?: string | null
): Promise<void> {
  const row: Record<string, string> = { id: userId };
  if (email && email.trim()) row.email = email.trim();
  const { error } = await getNextAuthClient()
    .from('users')
    .upsert(row, { onConflict: 'id', ignoreDuplicates: false });
  if (error) throw error;
}

// ── Threads ──────────────────────────────────────────────────────────────

export async function getThreadsForUser(userId: string): Promise<ChatThread[]> {
  const { data, error } = await getServerClient()
    .from('chat_threads')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('last_message_at', { ascending: false });
  if (error) throw error;
  return (data as ChatThread[]) || [];
}

export async function getThreadById(
  threadId: string,
  userId: string
): Promise<ChatThread | null> {
  const { data, error } = await getServerClient()
    .from('chat_threads')
    .select('*')
    .eq('id', threadId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as ChatThread | null) ?? null;
}

export async function createThread(
  userId: string,
  kind: ChatThreadKind,
  ref_id?: string | null,
  title?: string | null,
  extra?: {
    system_prompt?: string | null;
    project_slug?: string | null;
    // Authenticated user's email — used to backfill the next_auth.users FK
    // parent row on first thread create (CAT-06). Optional & best-effort:
    // the FK only requires the id to exist; email just makes the seeded row
    // legible. Callers (cockpit-spawn / spawn-*) already have it in scope.
    email?: string | null;
  }
): Promise<ChatThread> {
  // Guarantee the FK parent (next_auth.users.id) exists before inserting the
  // thread, so a brand-new / unseeded user (or the QA bot) can't FK-fault the
  // insert into a 500. Idempotent no-op once the row exists. (CAT-06 root fix.)
  await ensureUserRow(userId, extra?.email ?? null);

  const row = {
    user_id: userId,
    kind,
    ref_id: ref_id ?? null,
    title: (title && title.trim()) || defaultTitleForKind(kind, ref_id ?? null),
    system_prompt: extra?.system_prompt ?? null,
    project_slug: extra?.project_slug ?? null,
  };
  const { data, error } = await getServerClient()
    .from('chat_threads')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data as ChatThread;
}

/**
 * Get-or-create a thread scoped to (user, project_slug, agent_id).
 * Returns { thread, isNew }. If freshly created, the system_prompt is
 * snapshotted from the project's docs at this moment in time.
 *
 * Lookup is intentionally conservative: most-recently-active wins. If JD
 * has multiple threads for the same (user, project, agent) — which Phase 2
 * will allow once we add a thread-list inside the panel — we resume the
 * latest. Old ones stay accessible from the sidebar.
 */
export async function getOrCreateProjectAgentThread(
  userId: string,
  projectSlug: string,
  agentId: string,
  buildSystemPrompt: () => Promise<string | null>
): Promise<{ thread: ChatThread; isNew: boolean }> {
  // 1) Look for an existing live thread for (user, project, agent).
  const supa = getServerClient();
  const { data: existing, error: lookupErr } = await supa
    .from('chat_threads')
    .select('*')
    .eq('user_id', userId)
    .eq('project_slug', projectSlug)
    .eq('kind', 'agent')
    .eq('ref_id', agentId)
    .is('archived_at', null)
    .order('last_message_at', { ascending: false })
    .limit(1);
  if (lookupErr) throw lookupErr;
  if (existing && existing.length > 0) {
    return { thread: existing[0] as ChatThread, isNew: false };
  }

  // 2) Build a fresh system prompt from the project's docs. If the
  //    project doesn't exist on disk we still create the thread but with
  //    a null system_prompt — the per-agent persona from
  //    resolveThreadRuntime() will carry it.
  const systemPrompt = await buildSystemPrompt();

  const title = `${prettyAgentLabel(agentId)} • ${projectSlug}`;
  const thread = await createThread(userId, 'agent', agentId, title, {
    system_prompt: systemPrompt,
    project_slug: projectSlug,
  });
  return { thread, isNew: true };
}

/**
 * Force-create a brand new (user, project, agent) thread, bypassing the
 * resume-latest lookup. Used by the "Refresh project context" button so JD
 * can snapshot the current README/WORKPLAN/CHANGELOG into a fresh thread
 * while keeping the old one accessible from the sidebar / panel tab list.
 *
 * Phase 3 polish (2026-04-27).
 */
export async function createFreshProjectAgentThread(
  userId: string,
  projectSlug: string,
  agentId: string,
  buildSystemPrompt: () => Promise<string | null>
): Promise<{ thread: ChatThread; isNew: true }> {
  const systemPrompt = await buildSystemPrompt();
  const title = `${prettyAgentLabel(agentId)} • ${projectSlug}`;
  const thread = await createThread(userId, 'agent', agentId, title, {
    system_prompt: systemPrompt,
    project_slug: projectSlug,
  });
  return { thread, isNew: true };
}

/**
 * List all (live) threads for a (user, project, agent) tuple, most recent
 * first. Drives the in-panel "Recent chats" tab strip — when the user has
 * spawned multiple threads via the refresh button, they can switch between
 * them without leaving the panel.
 *
 * Phase 3 polish (2026-04-27).
 */
export async function listProjectAgentThreads(
  userId: string,
  projectSlug: string,
  agentId: string,
  limit = 10
): Promise<ChatThread[]> {
  const { data, error } = await getServerClient()
    .from('chat_threads')
    .select('*')
    .eq('user_id', userId)
    .eq('project_slug', projectSlug)
    .eq('kind', 'agent')
    .eq('ref_id', agentId)
    .is('archived_at', null)
    .order('last_message_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as ChatThread[]) || [];
}

function prettyAgentLabel(agentId: string): string {
  if (agentId === 'clawd') return 'CEO';
  if (agentId === 'chief_of_staff') return 'COS';
  if (agentId === 'health_coach') return 'Coach';
  if (agentId === 'researcher') return 'Researcher';
  if (agentId === 'counselor') return 'Examiner';
  if (agentId === 'professor') return 'Professor';
  if (agentId === 'quanta') return 'Quanta';
  if (agentId === 'analytics_suite') return 'Analytics';
  if (agentId === 'ops') return 'DevOps';
  return agentId;
}

function defaultTitleForKind(kind: ChatThreadKind, refId: string | null): string {
  if (kind === 'agent' && refId) return `Chat with ${refId}`;
  if (kind === 'project-session' && refId) return `Project: ${refId}`;
  return 'New thread';
}

// ── Messages ─────────────────────────────────────────────────────────────

/**
 * Fetch messages for a thread.
 *
 * Two distinct call shapes — they look similar but mean opposite things:
 *
 *  1. Initial load — `before` is undefined. We want the LATEST `limit`
 *     messages so the user sees the tail of the conversation on refresh.
 *     Naive `ORDER BY created_at ASC LIMIT 50` returns the OLDEST 50,
 *     stranding everything past msg #50 until the 8s poll catches up
 *     — that's the "latest chat doesn't populate after refresh" bug
 *     (2026-04-28). We fix by ordering DESC at the DB, then reversing
 *     in memory so callers still see ASC.
 *
 *  2. Incremental poll — `before` is the timestamp of the newest msg
 *     the client already has. The param is misnamed: the filter means
 *     "messages AT OR AFTER this timestamp." We keep ASC for that branch
 *     — the natural order for appending to the tail of the in-memory list.
 *
 *     We use `>=` (not `>`) ON PURPOSE: created_at is a microsecond
 *     timestamp, and two messages persisted in the same microsecond would
 *     share it. Strict `>` skips the SECOND same-microsecond row FOREVER
 *     (its ts == `before`, so it never satisfies `> before`) — a silently
 *     lost message. `>=` re-returns the boundary row instead; the client's
 *     dedupeOptimisticOnPersist() filters that re-fetch out by id, so the
 *     only net effect is that the previously-lost twin now arrives. (audit #6)
 */
export async function getMessagesForThread(
  threadId: string,
  userId: string,
  limit = 50,
  before?: string
): Promise<ChatMessage[]> {
  // SEC-001 (2026-07-04 audit): chat_messages has no user_id column, so message
  // isolation depends on thread ownership. Enforce it HERE (defense in depth) so
  // this function is self-protecting even if a caller forgets the check and even
  // with no DB-level RLS backstop. Returns [] for a thread the caller doesn't own.
  const owned = await getThreadById(threadId, userId);
  if (!owned) return [];
  if (before) {
    // Incremental: messages at-or-after `before`, oldest-first for append.
    // `>=` (not `>`) so a second message sharing the boundary's exact
    // microsecond isn't skipped forever; the boundary row it re-returns is
    // deduped by id on the client (dedupeOptimisticOnPersist). (audit #6)
    const { data, error } = await getServerClient()
      .from('chat_messages')
      .select('*')
      .eq('thread_id', threadId)
      .gte('created_at', before)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data as ChatMessage[]) || [];
  }
  // Initial: latest `limit` messages, reversed back to ASC for the UI.
  const { data, error } = await getServerClient()
    .from('chat_messages')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data as ChatMessage[]) || [];
  return rows.reverse();
}

export async function addMessage(
  threadId: string,
  role: ChatMessageRole,
  content: string,
  tool_name?: string | null,
  tool_input?: Record<string, unknown> | null,
  tool_output?: Record<string, unknown> | null,
  file_refs?: string[] | null
): Promise<ChatMessage> {
  const row = {
    thread_id: threadId,
    role,
    content: content ?? '',
    tool_name: tool_name ?? null,
    tool_input: tool_input ?? null,
    tool_output: tool_output ?? null,
    file_refs: file_refs && file_refs.length > 0 ? file_refs : null,
  };
  const { data, error } = await getServerClient()
    .from('chat_messages')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data as ChatMessage;
}

/**
 * UPSERT an assistant message keyed on `external_id` for shadow-write dedup
 * (cockpit-v1 Phase 2). If the bridge already inserted the row server-side,
 * we resolve to the existing row instead of duplicating. Either way the
 * caller gets a ChatMessage with a valid `id` for the SSE `done` event.
 */
export async function upsertAssistantMessage(
  threadId: string,
  content: string,
  externalId: string
): Promise<ChatMessage> {
  const client = getServerClient();
  const row = {
    thread_id: threadId,
    role: 'assistant' as ChatMessageRole,
    content: content ?? '',
    external_id: externalId,
  };
  const { data, error } = await client
    .from('chat_messages')
    .upsert(row, {
      onConflict: 'external_id',
      ignoreDuplicates: false,
    })
    .select('*')
    .single();
  if (!error && data) {
    return data as ChatMessage;
  }
  // Race: bridge inserted first → we get a unique-violation. Fetch and
  // return the existing row so the caller can complete the SSE turn.
  const { data: existing, error: fetchErr } = await client
    .from('chat_messages')
    .select('*')
    .eq('external_id', externalId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (existing) return existing as ChatMessage;
  // No existing row + upsert errored — re-throw the original error.
  throw error;
}

// ── Uploads ──────────────────────────────────────────────────────────────

export async function getUploadsByIds(
  ids: string[],
  threadId: string
): Promise<ChatUpload[]> {
  // SEC-002 (2026-07-04 audit): scope uploads to the (already ownership-verified)
  // thread. Without this, a caller could pass another tenant's upload ids and
  // read their files. The caller MUST have verified thread ownership first.
  if (!ids.length) return [];
  const { data, error } = await getServerClient()
    .from('chat_uploads')
    .select('*')
    .eq('thread_id', threadId)
    .in('id', ids);
  if (error) throw error;
  return (data as ChatUpload[]) || [];
}
