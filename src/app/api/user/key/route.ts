// POST /api/user/key   { apiKey } → validate + live-test + encrypt + store
// DELETE /api/user/key → clear the stored key
// Never returns the plaintext key. See docs/SPEC-BYOK.md.

import Anthropic from '@anthropic-ai/sdk';
import { authWithTimeout } from '@/lib/auth-timeout';
import { setUserApiKey, clearUserApiKey } from '@/lib/user-settings';

export const dynamic = 'force-dynamic';

function uid(session: Awaited<ReturnType<typeof authWithTimeout>>): string | undefined {
  return (session?.user as { id?: string } | undefined)?.id;
}

export async function POST(request: Request) {
  const userId = uid(await authWithTimeout({ label: '/api/user/key' }));
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let apiKey = '';
  try {
    apiKey = String((await request.json())?.apiKey ?? '').trim();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!/^sk-ant-api03-[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
    return Response.json({ error: 'That does not look like an Anthropic key (sk-ant-api03-...).' }, { status: 400 });
  }
  // Live-test the key with a free, no-token call before we store it.
  try {
    await new Anthropic({ apiKey }).models.list({ limit: 1 });
  } catch {
    return Response.json({ error: 'Anthropic rejected that key. Check it and try again.' }, { status: 400 });
  }
  const keyPreview = await setUserApiKey(userId, apiKey);
  return Response.json({ ok: true, keyPreview });
}

export async function DELETE() {
  const userId = uid(await authWithTimeout({ label: '/api/user/key' }));
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  await clearUserApiKey(userId);
  return Response.json({ ok: true });
}
