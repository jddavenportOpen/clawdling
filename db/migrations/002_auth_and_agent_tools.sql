-- ═══════════════════════════════════════════════════════════════════════════
-- 002 — real sign-up + agent action tools
-- Safe to run whole (idempotent: IF NOT EXISTS everywhere). Apply via the
-- Supabase Management API (see the db-apply script) or the dashboard SQL editor.
--
-- Part A: complete the NextAuth Supabase-adapter schema so magic-link email
--         sign-up works (only next_auth.users existed; the adapter also needs
--         verification_tokens / accounts / sessions).
-- Part B: per-user stores that let the agent ACT and REMEMBER (tasks, memory)
--         and hold connected-account tokens (integrations, for Gmail/Calendar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Part A: NextAuth adapter schema ─────────────────────────────────────────
create schema if not exists next_auth;
grant usage on schema next_auth to service_role;
grant all on all tables in schema next_auth to service_role;

create table if not exists next_auth.verification_tokens (
  identifier text,
  token      text,
  expires    timestamptz not null,
  primary key (token)
);

create table if not exists next_auth.accounts (
  id                  uuid not null default gen_random_uuid(),
  type                text not null,
  provider            text not null,
  "providerAccountId" text not null,
  refresh_token       text,
  access_token        text,
  expires_at          bigint,
  token_type          text,
  scope               text,
  id_token            text,
  session_state       text,
  oauth_token_secret  text,
  oauth_token         text,
  -- next_auth.users.id is TEXT in this instance (matches the app's userId
  -- shape), so the FK columns must be text too, not the adapter's default uuid.
  "userId"            text references next_auth.users(id) on delete cascade,
  primary key (id)
);

create table if not exists next_auth.sessions (
  id             uuid not null default gen_random_uuid(),
  expires        timestamptz not null,
  "sessionToken" text not null,
  "userId"       text references next_auth.users(id) on delete cascade,
  primary key (id)
);

grant all on table next_auth.verification_tokens to service_role;
grant all on table next_auth.accounts to service_role;
grant all on table next_auth.sessions to service_role;

-- ── Part B: per-user agent stores (public schema, service-role only) ─────────
-- user_id is text to match the app's id shape (uuid for real users,
-- "test:email" for the secret test login). RLS on + no anon policy = only the
-- server (service key, which bypasses RLS) can touch these. Same pattern as
-- the existing chat_* / user_settings / user_subscriptions tables.

create table if not exists public.user_tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null,
  title        text not null,
  status       text not null default 'open',   -- open | done
  due          text,                            -- freeform ("tomorrow", "2026-07-10")
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists user_tasks_user_idx on public.user_tasks (user_id, status);
alter table public.user_tasks enable row level security;

create table if not exists public.user_memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  content    text not null,
  tag        text,
  created_at timestamptz not null default now()
);
create index if not exists user_memory_user_idx on public.user_memory (user_id);
alter table public.user_memory enable row level security;

create table if not exists public.user_integrations (
  user_id       text not null,
  provider      text not null,                  -- 'google'
  access_token  text,                           -- AES-GCM encrypted (crypto-key.ts)
  refresh_token text,                           -- AES-GCM encrypted
  expiry        timestamptz,
  scope         text,
  updated_at    timestamptz not null default now(),
  primary key (user_id, provider)
);
alter table public.user_integrations enable row level security;
