// GET  /api/user/settings → { hasKey, keyPreview, model, effort, budgetUsd, periodCostUsd }
// POST /api/user/settings   { model?, effort?, budgetUsd? } → update prefs
// See docs/SPEC-BYOK.md. Never returns the plaintext key.

import { authWithTimeout } from '@/lib/auth-timeout';
import { getUserSettings, updateUserSettings, byokEnabled } from '@/lib/user-settings';

export const dynamic = 'force-dynamic';

function uid(session: Awaited<ReturnType<typeof authWithTimeout>>): string | undefined {
  return (session?.user as { id?: string } | undefined)?.id;
}

const VALID_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5'];
const VALID_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

export async function GET() {
  const userId = uid(await authWithTimeout({ label: '/api/user/settings' }));
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const view = await getUserSettings(userId);
  return Response.json({ ...view });
}

export async function POST(request: Request) {
  const userId = uid(await authWithTimeout({ label: '/api/user/settings' }));
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { model?: string; effort?: string; budgetUsd?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const patch: { model?: string | null; effort?: string | null; budgetUsd?: number | null } = {};
  if (body.model !== undefined) {
    if (body.model !== null && !VALID_MODELS.includes(body.model)) {
      return Response.json({ error: 'Unknown model' }, { status: 400 });
    }
    patch.model = body.model;
  }
  if (body.effort !== undefined) {
    if (body.effort !== null && !VALID_EFFORT.includes(body.effort)) {
      return Response.json({ error: 'Unknown effort' }, { status: 400 });
    }
    patch.effort = body.effort;
  }
  if (body.budgetUsd !== undefined) {
    // In production (company key), the usage cap is plan-controlled — a customer
    // cannot raise how much of OUR key they spend. Only BYOK users set their own.
    if (!byokEnabled()) {
      return Response.json({ error: 'Usage limit is set by your plan.' }, { status: 403 });
    }
    const n = Number(body.budgetUsd);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      return Response.json({ error: 'Budget must be a non-negative number' }, { status: 400 });
    }
    patch.budgetUsd = n;
  }
  await updateUserSettings(userId, patch);
  return Response.json(await getUserSettings(userId));
}
