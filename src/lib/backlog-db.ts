// ═══════════════════════════════════════════════════════════════════════════
// backlog-db.ts — DECOUPLE: the cockpit's DIRECT read/write of the unified
// backlog (spine.backlog_items) via Supabase, with NO Mac-mini bridge.
//
// WHY: the /backlog page used to proxy the bridge (bridge-client.ts), but the
// live bridge goes stale + can't serve the new spine routes. spine is psql-only
// (not exposed to PostgREST) so the cockpit reaches it through a thin `public`
// access layer added in spine/sql/003_backlog_public_api.sql:
//   - read VIEW   public.backlog_items_v       (service_role SELECT only)
//   - RPC         public.backlog_set_state     (Done / Remove)
//   - RPC         public.backlog_snooze        (Snooze)
//   - RPC         public.backlog_dispatch      ("send it?" one-tap)
// Each is GRANTed to service_role ONLY. This module runs SERVER-SIDE with the
// service key (getServerClient bypasses RLS via the grants); anon/browser can
// never reach it.
//
// The functions here reproduce the bridge spine_backlog.py JSON shape EXACTLY
// (spine-native fields + the legacy aliases the old EA-backlog UI keyed on:
// status, tier, raw_excerpt, type, due, source) so the /backlog + /api/tasks
// response shapes stay byte-identical after the data-source swap — only the
// SOURCE changed (bridge → Supabase), not the contract.
// ═══════════════════════════════════════════════════════════════════════════
import 'server-only';

import { getServerClient } from '@/lib/supabase';

export const BACKLOG_VIEW = 'backlog_items_v';

// The PULL surface (EA-BACKLOG-MIGRATION §4) — the only states the default
// /backlog view shows. Mirrors spine_backlog.PULL_STATES.
export const PULL_STATES = ['next', 'in_progress', 'waiting'] as const;

// Known spine state set (002_donna.sql CHECK constraint).
export const VALID_STATES = [
  'captured', 'triaged', 'next', 'in_progress', 'waiting',
  'snoozed', 'done', 'cancelled', 'archived',
] as const;
export type SpineState = (typeof VALID_STATES)[number];

// UI action verb → spine state (mirrors spine_backlog._ACTION_TO_STATE). The
// /backlog page sends Done/Remove/Snooze; the bridge accepted these aliases too.
const ACTION_TO_STATE: Record<string, SpineState> = {
  done: 'done', complete: 'done', completed: 'done',
  dropped: 'cancelled', cancel: 'cancelled', cancelled: 'cancelled', remove: 'cancelled',
  snooze: 'snoozed',
  next: 'next', in_progress: 'in_progress', waiting: 'waiting',
};

// spine state → legacy EA-backlog `status` token (mirrors
// spine_backlog._STATE_TO_LEGACY_STATUS) so the old UI's STATUS_CONFIG keys resolve.
const STATE_TO_LEGACY_STATUS: Record<string, string> = {
  next: 'captured', triaged: 'triaged', captured: 'captured', snoozed: 'triaged',
  in_progress: 'triaged', waiting: 'triaged',
  done: 'done', cancelled: 'dropped', archived: 'dropped',
};

// The columns the public.backlog_items_v view exposes (the JD-facing set).
export interface BacklogViewRow {
  id: string;
  title: string | null;
  body: string | null;
  next_action: string | null;
  source_store: string | null;
  source_origin: string | null;
  domain: string | null;
  project: string | null;
  person_ref: string | null;
  meeting_ref: string | null;
  goal_ref: string | null;
  state: string;
  blocked_on: string | null;
  priority: number | null;
  owner: string | null;
  can_agent_do: boolean | null;
  agent_task_id: string | null;
  due_date: string | null;
  snooze_until: string | null;
  surfaced_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  source_created_at: string | null;
}

// The cockpit JSON shape (spine-native + legacy aliases) — byte-identical to the
// bridge's spine_backlog._row_to_item output. The /backlog page + drawer read this.
export interface BacklogItemShape {
  id: string;
  // spine-native
  title: string | null;
  body: string | null;
  next_action: string | null;
  state: string;
  priority: number | null;
  domain: string | null;
  project: string | null;
  person_ref: string | null;
  meeting_ref: string | null;
  goal_ref: string | null;
  owner: string | null;
  can_agent_do: boolean | null;
  agent_task_id: string | null;
  source_store: string | null;
  source_ref: string | null;
  source_origin: string | null;
  blocked_on: string | null;
  due_date: string | null;
  snooze_until: string | null;
  surfaced_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  source_created_at: string | null;
  // legacy aliases (back-compat with the pre-migration /backlog UI shape)
  status: string;
  tier: string;
  raw_excerpt: string | null;
  type: null;
  due: string | null;
  source: string | null;
}

// Project a view row into the cockpit JSON shape — the EXACT shape the bridge
// returned (spine_backlog._row_to_item). source_ref is NOT in the view (it's a
// reversible pointer, not JD-facing) so it surfaces as null, matching the
// front-end's optional `source_ref?: string | null` typing.
export function rowToItem(row: BacklogViewRow): BacklogItemShape {
  const state = row.state;
  return {
    id: String(row.id),
    title: row.title,
    body: row.body,
    next_action: row.next_action,
    state,
    priority: row.priority,
    domain: row.domain,
    project: row.project,
    person_ref: row.person_ref,
    meeting_ref: row.meeting_ref,
    goal_ref: row.goal_ref,
    owner: row.owner,
    can_agent_do: row.can_agent_do,
    agent_task_id: row.agent_task_id,
    source_store: row.source_store,
    source_ref: null,
    source_origin: row.source_origin,
    blocked_on: row.blocked_on,
    due_date: row.due_date,
    snooze_until: row.snooze_until,
    surfaced_count: row.surfaced_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    source_created_at: row.source_created_at,
    // legacy aliases
    status: STATE_TO_LEGACY_STATUS[state] ?? 'captured',
    tier: row.owner === 'jd' ? 'central' : 'domain',
    raw_excerpt: row.title,
    type: null,
    due: row.due_date,
    source: row.source_origin,
  };
}

export interface ListOpts {
  state?: string;
  states?: string[];
  domain?: string;
  sourceStore?: string;
  pullOnly?: boolean;
  limit?: number;
}

// PostgREST hard-caps a single response at db-max-rows (1000 on this project),
// so to honor a limit up to 2000 (the /backlog "Show all" view asks for 2000) we
// page in PAGE_SIZE chunks via .range() until we hit the limit or run dry. The
// bridge returned up to 2000 in one shot; this preserves that parity instead of
// silently truncating at 1000.
const PAGE_SIZE = 1000;

// List backlog items, ordered priority ASC (0=P0 first) → due_date → created_at —
// the canonical pull ordering (mirrors spine_backlog.list_items). pullOnly
// restricts to the PULL surface. Reads the view with the service key.
export async function listItems(opts: ListOpts = {}): Promise<BacklogItemShape[]> {
  let selected: string[] | null = null;
  if (opts.pullOnly) selected = [...PULL_STATES];
  else if (opts.states && opts.states.length) {
    selected = opts.states.filter((s) => (VALID_STATES as readonly string[]).includes(s));
  } else if (opts.state && (VALID_STATES as readonly string[]).includes(opts.state)) {
    selected = [opts.state];
  }

  const limit = Math.max(1, Math.min(opts.limit || 500, 2000));
  const client = getServerClient();
  const rows: BacklogViewRow[] = [];

  for (let offset = 0; offset < limit; offset += PAGE_SIZE) {
    const to = Math.min(offset + PAGE_SIZE, limit) - 1; // .range is inclusive
    let query = client
      .from(BACKLOG_VIEW)
      .select('*')
      .order('priority', { ascending: true })
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(offset, to);

    if (selected && selected.length) query = query.in('state', selected);
    if (opts.domain) query = query.eq('domain', opts.domain);
    if (opts.sourceStore) query = query.eq('source_store', opts.sourceStore);

    const { data, error } = await query;
    if (error) throw error;
    const page = (data as BacklogViewRow[]) || [];
    rows.push(...page);
    if (page.length < to - offset + 1) break; // last page — no more rows
  }

  return rows.map(rowToItem);
}

// Per-state counts across the whole backlog (mirrors spine_backlog.counts_by_state).
// PostgREST can't GROUP BY without an RPC and hard-caps row fetches at db-max-rows
// (1000), so a "fetch all states + tally" would undercount a 2877-row table. We
// instead run one HEAD count={ exact } query PER state — counts are NOT row-capped,
// and the small fixed fan-out (≤9 states) is cheaper than paging the whole table.
export async function countsByState(): Promise<Record<string, number>> {
  const client = getServerClient();
  const results = await Promise.all(
    VALID_STATES.map(async (state) => {
      const { count, error } = await client
        .from(BACKLOG_VIEW)
        .select('*', { count: 'exact', head: true })
        .eq('state', state);
      if (error) throw error;
      return [state, count ?? 0] as const;
    })
  );
  const counts: Record<string, number> = {};
  for (const [state, n] of results) {
    if (n > 0) counts[state] = n;
  }
  return counts;
}

// Single item by id (mirrors spine_backlog.get_item). null if unknown.
export async function getItem(id: string): Promise<BacklogItemShape | null> {
  const { data, error } = await getServerClient()
    .from(BACKLOG_VIEW)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToItem(data as BacklogViewRow) : null;
}

// Map a UI verb to its spine state (mirrors spine_backlog._ACTION_TO_STATE).
// Returns null for an unknown verb so the route can 400.
export function actionToState(action: string): SpineState | null {
  return ACTION_TO_STATE[(action || '').trim().toLowerCase()] ?? null;
}

// Done / Remove write via the public.backlog_set_state RPC (mirrors
// spine_backlog.update_status). Sets completed_at on terminal states + appends
// the drop reason to body for cancelled. Returns the updated item, or null if
// the id is unknown (the RPC returns zero rows).
export async function setState(
  id: string,
  state: SpineState,
  reason?: string | null,
): Promise<BacklogItemShape | null> {
  const { data, error } = await getServerClient().rpc('backlog_set_state', {
    p_id: id,
    p_state: state,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  const rows = (data as BacklogViewRow[]) || [];
  return rows.length ? rowToItem(rows[0]) : null;
}

// Snooze write via public.backlog_snooze (mirrors update_status('snooze')).
export async function snooze(
  id: string,
  snoozeUntil: string,
): Promise<BacklogItemShape | null> {
  const { data, error } = await getServerClient().rpc('backlog_snooze', {
    p_id: id,
    p_until: snoozeUntil,
  });
  if (error) throw error;
  const rows = (data as BacklogViewRow[]) || [];
  return rows.length ? rowToItem(rows[0]) : null;
}

export type DispatchOutcome =
  | { ok: true; task: BacklogItemShape; agent_task_id: string | null }
  | { ok: false; status: 404 } // unknown id
  | { ok: false; status: 409; error: string }; // not dispatchable / already dispatched

// "Send it?" one-tap via public.backlog_dispatch (mirrors spine_backlog.dispatch).
// Stages a queued spine.agent_tasks row, flips the item to in_progress, and
// back-links agent_task_id — all in one transaction in the RPC. The RPC raises
// (mapped to 409) when the row isn't can_agent_do or is already dispatched, and
// returns zero rows (→ 404) for an unknown id.
export async function dispatch(id: string): Promise<DispatchOutcome> {
  const { data, error } = await getServerClient().rpc('backlog_dispatch', {
    p_id: id,
  });
  if (error) {
    // Postgres raises check_violation (not dispatchable) / unique_violation
    // (already dispatched) → the cockpit surfaced both as 409 via the bridge.
    return { ok: false, status: 409, error: error.message || 'dispatch failed' };
  }
  const rows = (data as BacklogViewRow[]) || [];
  if (!rows.length) return { ok: false, status: 404 };
  const task = rowToItem(rows[0]);
  return { ok: true, task, agent_task_id: task.agent_task_id };
}
