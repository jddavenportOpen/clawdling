// ═══════════════════════════════════════════════════════════════════════════
// create-thread-fk-guard.test.ts — regression guard for CAT-06 (the 500 half).
//
// ROOT CAUSE (RESUME BUG-R1 / LIVE-DESKTOP BUG-6, 2026-06-12):
//   createThread() inserted chat_threads with a user_id that had NO backing
//   next_auth.users row → Postgres FK violation 23503 → 500. This 500'd the
//   QA bot AND would 500 any brand-new authenticated user whose FK parent
//   row was missing.
//
// FIX UNDER TEST: createThread now idempotently upserts the user into
//   next_auth.users (ensureUserRow) BEFORE inserting the thread, so the FK
//   parent is guaranteed present. This test pins:
//     1. ensureUserRow upserts into the `users` table via the next_auth client
//        (NOT the public-schema getServerClient).
//     2. that upsert happens BEFORE the chat_threads insert (order matters —
//        the parent must exist first).
//     3. the email is threaded into the seeded row when provided.
//     4. if the upsert errors, we surface it (don't silently insert + FK-fault).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @/lib/supabase: two distinct fake clients that record call order ──
const calls: string[] = [];

// next_auth-schema client — the FK-parent seeder.
const upsertSpy = vi.fn(() => {
  calls.push('ensureUser.upsert');
  return Promise.resolve({ data: [{ id: 'u1' }], error: null });
});
const nextAuthFrom = vi.fn((table: string) => {
  calls.push(`nextAuth.from(${table})`);
  return { upsert: upsertSpy };
});

// public-schema client — the chat_threads inserter.
const threadRow = {
  id: 'thread-1',
  user_id: 'u1',
  title: 'New thread',
  kind: 'project-session',
  ref_id: null,
  created_at: '2026-06-12T00:00:00Z',
  last_message_at: '2026-06-12T00:00:00Z',
  archived_at: null,
  system_prompt: null,
  project_slug: null,
};
const single = vi.fn(() => {
  calls.push('thread.insert');
  return Promise.resolve({ data: threadRow, error: null });
});
const serverFrom = vi.fn((table: string) => {
  calls.push(`server.from(${table})`);
  return {
    insert: () => ({ select: () => ({ single }) }),
  };
});

vi.mock('@/lib/supabase', () => ({
  getServerClient: () => ({ from: serverFrom }),
  getNextAuthClient: () => ({ from: nextAuthFrom }),
}));

import { createThread, ensureUserRow } from '@/lib/chat';

beforeEach(() => {
  calls.length = 0;
  upsertSpy.mockClear();
  nextAuthFrom.mockClear();
  serverFrom.mockClear();
  single.mockClear();
});

describe('createThread — CAT-06 FK-parent guard', () => {
  it('seeds the user row BEFORE inserting the thread', async () => {
    await createThread('u1', 'project-session', null, 'New thread', {
      email: 'new-user@example.com',
    });

    // 1) the user upsert targets the `users` table via the next_auth client
    expect(nextAuthFrom).toHaveBeenCalledWith('users');
    expect(upsertSpy).toHaveBeenCalledTimes(1);

    // 2) and it runs BEFORE the chat_threads insert (parent before child)
    const userIdx = calls.indexOf('ensureUser.upsert');
    const threadIdx = calls.indexOf('thread.insert');
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(threadIdx).toBeGreaterThan(userIdx);

    // 3) the thread insert uses the public-schema server client on chat_threads
    expect(serverFrom).toHaveBeenCalledWith('chat_threads');
  });

  it('threads the email into the seeded next_auth.users row', async () => {
    await createThread('u1', 'project-session', null, 'x', {
      email: 'new-user@example.com',
    });
    expect(upsertSpy).toHaveBeenCalledWith(
      { id: 'u1', email: 'new-user@example.com' },
      expect.objectContaining({ onConflict: 'id', ignoreDuplicates: false }),
    );
  });

  it('upserts id-only when no email is supplied (FK only needs the id)', async () => {
    await ensureUserRow('u-no-email');
    expect(upsertSpy).toHaveBeenCalledWith(
      { id: 'u-no-email' },
      expect.objectContaining({ onConflict: 'id' }),
    );
  });

  it('surfaces an upsert error instead of proceeding to a FK-faulting insert', async () => {
    upsertSpy.mockImplementationOnce(() => {
      calls.push('ensureUser.upsert');
      return Promise.resolve({ data: null, error: { message: 'seed failed', code: 'XX' } });
    });
    await expect(
      createThread('u1', 'project-session', null, 't', { email: 'a@b.c' }),
    ).rejects.toMatchObject({ message: 'seed failed' });
    // and we never reached the thread insert
    expect(calls).not.toContain('thread.insert');
  });
});
