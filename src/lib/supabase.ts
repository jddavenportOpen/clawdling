// ═══════════════════════════════════════════════════════════════════════════
// Clawdling — Supabase Client
// Server-side + client-side Supabase access with typed tables
// ═══════════════════════════════════════════════════════════════════════════

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getLocalClient, isLocalState } from '@/lib/local-store';

// ── Types ─────────────────────────────────────────────────────────────────

export interface DbDomain {
  id: string;
  name: string;
  status: string;
  color: string | null;
  icon: string | null;
  last_heartbeat: string;
  alert_count: number;
  top_alert: string | null;
  summary: string | null;
  updated_at: string;
}

export interface DbDomainMetric {
  id: number;
  domain_id: string;
  key: string;
  value: string | null;
  numeric_value: number | null;
  updated_at: string;
}

export interface DbTask {
  id: number;
  domain_id: string;
  // project_slug is OPTIONAL. null/omitted = "domain todo" (no artifact,
  // no end-state, ongoing chore like "buy milk" or "register car").
  // Non-null = rolls up into that scaffolded project at $ADJUTANT_STATE_ROOT/projects/<slug>/.
  project_slug: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  assignee: string;
  tags: string[] | null;
  source_id: string | null;
  external_id: string | null;
  _synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbCalendarEvent {
  id: number;
  domain_id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  event_type: string;
  location: string | null;
  all_day: boolean;
  created_at: string;
}

export interface DbGrade {
  id: number;
  course: string;
  course_code: string | null;
  percentage: number | null;
  letter: string | null;
  trend_direction: string;
  trend_points: number;
  assignments_remaining: number;
  updated_at: string;
}

export interface DbPipelineDeal {
  id: number;
  stage: string;
  contact: string | null;
  company: string | null;
  value: number;
  last_contact: string | null;
  heat: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbBudgetEnvelope {
  id: number;
  category: string;
  allocated: number;
  spent: number;
  period: string;
  locked: boolean;
  updated_at: string;
}

// Daily Claude Code token spend — VISIBILITY, not enforcement.
// One row per calendar day. Written by scripts/token_spend_sync.py (ccusage).
// Source-of-truth for "how many tokens am I spending" (the /budget page).
export interface DbTokenSpend {
  date: string;            // YYYY-MM-DD (PK)
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_creation: number;
  est_cost_usd: number;
  session_count: number;
  source: string;
  _synced_at: string;
}

export interface DbHabit {
  id: number;
  name: string;
  person: string;
  streak: number;
  last_checked: string | null;
  today_done: boolean;
  updated_at: string;
}

export interface DbHealthMetric {
  id: number;
  date: string;           // YYYY-MM-DD (the metric date, not insert time)
  source: string;         // 'garmin' | 'weight_checkin' | 'manual' | etc.
  weight_kg: number | null;
  body_fat_pct: number | null;
  muscle_mass_kg: number | null;
  steps: number | null;
  calories_burned: number | null;
  calories_consumed: number | null;
  vo2_max: number | null;
  sleep_hours: number | null;
  deep_sleep_hours: number | null;
  rem_sleep_hours: number | null;
  light_sleep_hours: number | null;
  awake_hours: number | null;
  sleep_score: number | null;
  resting_hr_bpm: number | null;
  hrv_ms: number | null;
  // Body Battery (added 2026-06-06 — migration 20260606-health-metrics-body-battery.sql)
  body_battery_max: number | null;
  body_battery_min: number | null;
  body_battery_charged: number | null;
  body_battery_drained: number | null;
  notes: string | null;
  _synced_at: string;
}

export interface DbSystemHealth {
  id: number;
  component: string;
  status: string;
  last_check: string;
  response_ms: number | null;
  details: Record<string, unknown> | null;
  updated_at: string;
}

export interface DbAiFoundryMilestone {
  id: number;
  external_id: string;
  source_id: string;
  label: string;
  status: string;          // complete | current | future
  position: number;
  phase: string | null;
  updated_at: string;
  _synced_at: string;
}

export interface DbAiFoundryStakeholder {
  id: number;
  external_id: string;
  source_id: string;
  name: string;
  role: string | null;
  need: string | null;
  status: string | null;
  status_color: string | null;
  updated_at: string;
  _synced_at: string;
}

export interface DbAiFoundryCourse {
  id: number;
  external_id: string;
  source_id: string;
  title: string;
  credits: string | null;
  status: string | null;
  status_color: string | null;
  file: string | null;
  updated_at: string;
  _synced_at: string;
}

export interface DbXPost {
  id: number;
  tweet_id: string;
  content: string;
  posted_at: string;
  url: string | null;
  strategy_snapshot: string | null;  // pillar name
  tone_score: number | null;
  created_at: string;
  // Optional metrics columns (may be null until reflector backfills)
  impressions?: number | null;
  likes?: number | null;
  retweets?: number | null;
  replies?: number | null;
  quotes?: number | null;
  bookmarks?: number | null;
  metrics_updated_at?: string | null;
}

export interface DbXMetric {
  date: string;                      // YYYY-MM-DD PK
  followers: number | null;
  following: number | null;
  impressions_24h: number | null;
  engagements_24h: number | null;
  posts_count: number | null;
  top_post_id: string | null;
  top_post_impressions: number | null;
  created_at: string;
}

// ── Chat tables (Phase 1 — chat-interface-v2) ────────────────────────────

export type ChatThreadKind = 'agent' | 'project-session' | 'ad-hoc';
export type ChatMessageRole = 'user' | 'assistant' | 'tool' | 'thinking';
export type ChatSessionStatus = 'starting' | 'live' | 'exited';

export interface DbChatThread {
  id: string;
  user_id: string;
  title: string;
  kind: ChatThreadKind;
  ref_id: string | null;
  created_at: string;
  last_message_at: string;
  archived_at: string | null;
  // Added in migration 008. Both NULL on legacy threads — backward-compatible.
  system_prompt: string | null;
  project_slug: string | null;
}

export interface DbChatMessage {
  id: string;
  thread_id: string;
  role: ChatMessageRole;
  content: string;
  tool_name: string | null;
  tool_input: Record<string, unknown> | null;
  tool_output: Record<string, unknown> | null;
  file_refs: string[] | null;
  // Cockpit-v1 Phase 2: idempotency key for shadow-write dedup between
  // bridge subprocess persistence and Next route handler. Format:
  // "turn-<thread_id>-<started_at_ms>". Null for legacy / system rows;
  // optional in TS so client-side optimistic messages don't have to set it.
  external_id?: string | null;
  created_at: string;
}

export interface DbChatSession {
  id: string;
  thread_id: string;
  project_slug: string | null;
  cwd: string;
  pid: number | null;
  status: ChatSessionStatus;
  started_at: string;
  exited_at: string | null;
  exit_code: number | null;
  agent_name: string | null;
}

export interface DbChatUpload {
  id: string;
  thread_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  disk_path: string;
  created_at: string;
}

export async function fetchChatThreads(userId: string): Promise<DbChatThread[]> {
  const { data, error } = await getServerClient()
    .from('chat_threads')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('last_message_at', { ascending: false });
  if (error) throw error;
  return (data as DbChatThread[]) || [];
}

// ── Client creation ───────────────────────────────────────────────────────

// Env-only. The hardcoded fallback used to point at the source user's live
// Supabase project (a data-coupling + leak). In the product, the URL comes
// from config; ADJUTANT_STATE=local will route around this client entirely
// (see docs/API-FOCUS-WORKLIST.md — local-store adapter, resume build).
const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
const supabaseServiceKey = (process.env.SUPABASE_SERVICE_KEY || '').trim();

// Server-side client (service role — full access)
let _serverClient: SupabaseClient | null = null;
export function getServerClient(): SupabaseClient {
  // Self-host: route the entire data layer to the local store BEFORE
  // createClient('') would throw on the empty URL. chat.ts and every fetchX
  // caller get the local adapter transparently. (ADJUTANT_STATE=local)
  if (isLocalState()) return getLocalClient() as unknown as SupabaseClient;
  if (!_serverClient) {
    const key = supabaseServiceKey || supabaseAnonKey;
    _serverClient = createClient(supabaseUrl, key, {
      auth: { persistSession: false },
    });
  }
  return _serverClient;
}

// Server-side client scoped to the `next_auth` schema (service role).
//
// NextAuth's SupabaseAdapter owns the user table in the `next_auth` schema
// (next_auth.users), NOT public.users. chat_threads.user_id has a FK to
// next_auth.users — so seeding/repairing a missing user row (the CAT-06
// root cause) must target that schema, not the default `public` one the
// other helpers use. Separate client instance because the schema is fixed
// at client-construction time in supabase-js.
// The `db.schema: 'next_auth'` option is what actually routes .from('users')
// to next_auth.users at RUNTIME. We keep the default (untyped) SupabaseClient
// type — same as getServerClient — because supabase-js's custom-schema generic
// requires a full Database type we don't model here; typing it explicitly
// collapses the schema param to `never`. The runtime option is the load-bearing
// part; the type is cosmetic for an untyped client.
let _nextAuthClient: SupabaseClient | null = null;
export function getNextAuthClient(): SupabaseClient {
  // Self-host: the local store's `users` table absorbs ensureUserRow's upsert
  // (no next_auth schema, no FK to enforce). Same adapter as getServerClient.
  if (isLocalState()) return getLocalClient() as unknown as SupabaseClient;
  if (!_nextAuthClient) {
    const key = supabaseServiceKey || supabaseAnonKey;
    _nextAuthClient = createClient(supabaseUrl, key, {
      auth: { persistSession: false },
      db: { schema: 'next_auth' },
    }) as unknown as SupabaseClient;
  }
  return _nextAuthClient;
}

// Client-side client (anon key — read only via RLS)
let _browserClient: SupabaseClient | null = null;
export function getBrowserClient(): SupabaseClient {
  // Self-host: return the local adapter so client components that construct a
  // browser client on mount don't throw on the empty NEXT_PUBLIC_SUPABASE_URL.
  // (Realtime subscriptions no-op in local mode; poll-based reads still work.)
  if (isLocalState()) return getLocalClient() as unknown as SupabaseClient;
  if (!_browserClient) {
    _browserClient = createClient(supabaseUrl, supabaseAnonKey);
  }
  return _browserClient;
}

// ── Query helpers ─────────────────────────────────────────────────────────

export async function fetchDomains(): Promise<DbDomain[]> {
  const { data, error } = await getServerClient()
    .from('domains')
    .select('*')
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function fetchDomainMetrics(domainId: string): Promise<DbDomainMetric[]> {
  const { data, error } = await getServerClient()
    .from('domain_metrics')
    .select('*')
    .eq('domain_id', domainId);
  if (error) throw error;
  return data || [];
}

export async function fetchTasks(opts?: {
  domainId?: string;
  status?: string;
  priority?: string;
}): Promise<DbTask[]> {
  let query = getServerClient()
    .from('tasks')
    .select('*')
    .order('priority', { ascending: true })
    .order('due_date', { ascending: true, nullsFirst: false });
  if (opts?.domainId) query = query.eq('domain_id', opts.domainId);
  if (opts?.status) query = query.eq('status', opts.status);
  if (opts?.priority) query = query.eq('priority', opts.priority);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function fetchCalendarEvents(domainId?: string): Promise<DbCalendarEvent[]> {
  let query = getServerClient()
    .from('calendar_events')
    .select('*')
    .order('start_time');
  if (domainId) query = query.eq('domain_id', domainId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function fetchGrades(): Promise<DbGrade[]> {
  const { data, error } = await getServerClient()
    .from('grades')
    .select('*')
    .order('course');
  if (error) throw error;
  return data || [];
}

export async function fetchPipelineDeals(): Promise<DbPipelineDeal[]> {
  const { data, error } = await getServerClient()
    .from('pipeline_deals')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function fetchBudgetEnvelopes(): Promise<DbBudgetEnvelope[]> {
  const { data, error } = await getServerClient()
    .from('budget_envelopes')
    .select('*')
    .order('category');
  if (error) throw error;
  return data || [];
}

export async function fetchHabits(person?: string): Promise<DbHabit[]> {
  let query = getServerClient()
    .from('habits')
    .select('*')
    .order('name');
  if (person) query = query.eq('person', person);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function fetchSystemHealth(): Promise<DbSystemHealth[]> {
  const { data, error } = await getServerClient()
    .from('system_health')
    .select('*')
    .order('component');
  if (error) throw error;
  return data || [];
}

export async function fetchHealthMetrics(opts?: {
  source?: string;
  since?: string;   // YYYY-MM-DD inclusive lower bound
  limit?: number;
}): Promise<DbHealthMetric[]> {
  let query = getServerClient()
    .from('health_metrics')
    .select('*')
    .order('date', { ascending: false });
  if (opts?.source) query = query.eq('source', opts.source);
  if (opts?.since) query = query.gte('date', opts.since);
  if (opts?.limit) query = query.limit(opts.limit);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function fetchAiFoundryMilestones(): Promise<DbAiFoundryMilestone[]> {
  const { data, error } = await getServerClient()
    .from('ai_foundry_milestones')
    .select('*')
    .order('position', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchAiFoundryStakeholders(): Promise<DbAiFoundryStakeholder[]> {
  const { data, error } = await getServerClient()
    .from('ai_foundry_stakeholders')
    .select('*')
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function fetchAiFoundryCourses(): Promise<DbAiFoundryCourse[]> {
  const { data, error } = await getServerClient()
    .from('ai_foundry_courses')
    .select('*')
    .order('title');
  if (error) throw error;
  return data || [];
}

// Token-spend rows for the last `days` calendar days, newest first.
// Returns [] when the table is empty (writer not yet running) — callers
// must treat [] as "wiring in progress", NOT as "$0 spent".
export async function fetchTokenSpend(days = 30): Promise<DbTokenSpend[]> {
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const sinceStr = since.toISOString().slice(0, 10);
  const { data, error } = await getServerClient()
    .from('token_spend')
    .select('*')
    .gte('date', sinceStr)
    .order('date', { ascending: false });
  if (error) throw error;
  return (data as DbTokenSpend[]) || [];
}

// ── Sync status helper ──────────────────────────────────────────────────

export async function getLastSyncTime(): Promise<string | null> {
  const { data } = await getServerClient()
    .from('domains')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();
  return data?.updated_at || null;
}
