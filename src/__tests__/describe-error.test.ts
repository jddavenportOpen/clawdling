// ═══════════════════════════════════════════════════════════════════════════
// describe-error.test.ts — regression guard for CAT-06's "[object Object]" half.
//
// LIVE-DESKTOP BUG-6 / BUG-R1: createThread failures surfaced
// "Failed to create thread: [object Object]" because the route did
// `String(err)` on a Supabase/Postgres error — a PLAIN OBJECT, not an Error.
// describeError() must NEVER return "[object Object]"; it must surface the
// real Postgres message/details/code so the FK violation is visible.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { describeError } from '@/lib/utils';

describe('describeError — CAT-06 logging fix', () => {
  it('extracts message/details/code from a PostgrestError-shaped object (the bug)', () => {
    // The exact shape Supabase returned for the CAT-06 FK violation.
    const pgErr = {
      code: '23503',
      details:
        'Key (user_id)=(00000000-0000-4000-8000-0000ca0bb001) is not present in table "users".',
      hint: null,
      message:
        'insert or update on table "chat_threads" violates foreign key constraint "chat_threads_user_id_fkey"',
    };
    const out = describeError(pgErr);
    // The literal bug: must NOT be the stringified-object sentinel.
    expect(out).not.toContain('[object Object]');
    // Must carry the real Postgres reason.
    expect(out).toContain('foreign key constraint');
    expect(out).toContain('not present in table');
    expect(out).toContain('[23503]');
  });

  it('reproduces that String(err) WOULD have lost the message (pins the root cause)', () => {
    const pgErr = { code: '23503', message: 'FK violation' };
    // The old code path:
    expect(String(pgErr)).toBe('[object Object]');
    // The fix:
    expect(describeError(pgErr)).not.toBe('[object Object]');
    expect(describeError(pgErr)).toContain('FK violation');
  });

  it('uses Error.message for real Error instances', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('passes strings through unchanged', () => {
    expect(describeError('plain string error')).toBe('plain string error');
  });

  it('handles null/undefined without throwing', () => {
    expect(describeError(null)).toBe('unknown error');
    expect(describeError(undefined)).toBe('unknown error');
  });

  it('falls back to JSON for objects with no standard fields', () => {
    const out = describeError({ weird: 'shape', n: 1 });
    expect(out).not.toBe('[object Object]');
    expect(out).toContain('weird');
  });
});
