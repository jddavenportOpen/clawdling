// ═══════════════════════════════════════════════════════════════════════════
// POST /api/chat — create a new chat_threads row and return {id}.
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { createThread } from '@/lib/chat';
import { describeError } from '@/lib/utils';
import type { ChatThreadKind } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const VALID_KINDS: ChatThreadKind[] = ['agent', 'project-session', 'ad-hoc'];

export async function POST(request: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const email = session?.user?.email;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { kind?: string; ref_id?: string | null; title?: string | null };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const kind = body.kind as ChatThreadKind | undefined;
  if (!kind || !VALID_KINDS.includes(kind)) {
    return Response.json(
      { error: `Invalid kind. Must be one of: ${VALID_KINDS.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const thread = await createThread(
      userId,
      kind,
      body.ref_id ?? null,
      body.title ?? null,
      { email }
    );
    return Response.json({ id: thread.id, thread });
  } catch (err) {
    return Response.json(
      { error: `Failed to create thread: ${describeError(err)}` },
      { status: 500 }
    );
  }
}
