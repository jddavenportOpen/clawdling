// ═══════════════════════════════════════════════════════════════════════════
// POST /api/uploads — accept multipart form, forward files to the Mac Mini
// the upload store (<state-root>/uploads/<thread>/), then insert
// chat_uploads rows in Supabase.
//
// Why forward instead of writing locally:
//   Vercel's serverless filesystem is read-only outside /tmp, and /tmp is
//   ephemeral per-invocation. The Mac bridge is the only place where these
//   files can land + survive long enough for `claude --resume` to read them.
//
// Limits (mirrored on the bridge as defense-in-depth):
//   - Max 25MB per file, max 5 files per request.
//   - Thread must belong to the signed-in user.
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { bridgeFetch } from '@/lib/bridge-client';
import { getThreadById } from '@/lib/chat';
import { getServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_FILES = 5;

interface BridgeUpload {
  filename: string;
  disk_path: string;
  size_bytes: number;
  content_type: string;
}

export async function POST(request: Request) {
  const session = await auth();
  const userObj = session?.user as { id?: string; email?: string } | undefined;
  const userId = userObj?.id;
  const email = userObj?.email ?? '';
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const threadId = (form.get('thread_id') as string | null)?.trim();
  if (!threadId) {
    return Response.json({ error: 'thread_id is required' }, { status: 400 });
  }

  const thread = await getThreadById(threadId, userId);
  if (!thread) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  // Validate file count + size before paying the bridge round-trip cost.
  const files: File[] = [];
  for (const value of form.getAll('files')) {
    if (value instanceof File) files.push(value);
  }
  if (files.length === 0) {
    return Response.json({ error: 'No files provided' }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return Response.json(
      { error: `Too many files (max ${MAX_FILES})` },
      { status: 400 }
    );
  }
  for (const f of files) {
    if (f.size > MAX_SIZE) {
      return Response.json(
        { error: `File "${f.name}" exceeds ${MAX_SIZE} bytes` },
        { status: 413 }
      );
    }
  }

  // Re-pack into a fresh FormData for the bridge (drop thread_id from body —
  // it's in the URL on the bridge side).
  const bridgeForm = new FormData();
  for (const f of files) {
    bridgeForm.append('files', f, f.name);
  }

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      `/api/uploads/${encodeURIComponent(threadId)}`,
      { method: 'POST', body: bridgeForm },
      userId,
      email
    );
  } catch (err) {
    return Response.json(
      { error: `Bridge unreachable: ${String(err instanceof Error ? err.message : err)}` },
      { status: 502 }
    );
  }

  if (!bridgeRes.ok) {
    const text = await bridgeRes.text().catch(() => `HTTP ${bridgeRes.status}`);
    return Response.json(
      { error: `Bridge upload failed: ${text.slice(0, 300)}` },
      { status: bridgeRes.status }
    );
  }

  const bridgeData = (await bridgeRes.json()) as { uploads?: BridgeUpload[] };
  const uploaded = bridgeData.uploads || [];
  if (uploaded.length === 0) {
    return Response.json({ error: 'Bridge returned no uploads' }, { status: 500 });
  }

  // Insert one chat_uploads row per file. We do them serially because the
  // bridge already wrote the bytes — we want a tight, well-ordered DB log,
  // and the count is capped at 5.
  const supa = getServerClient();
  const out: Array<{
    id: string;
    filename: string;
    disk_path: string;
    size_bytes: number;
    content_type: string;
  }> = [];

  for (const u of uploaded) {
    const row = {
      thread_id: threadId,
      filename: u.filename,
      content_type: u.content_type,
      size_bytes: u.size_bytes,
      disk_path: u.disk_path,
    };

    const { data, error } = await supa
      .from('chat_uploads')
      .insert(row)
      .select('*')
      .single();
    if (error) {
      return Response.json(
        { error: `DB insert failed: ${error.message}` },
        { status: 500 }
      );
    }
    out.push({
      id: data.id,
      filename: data.filename,
      disk_path: data.disk_path,
      size_bytes: data.size_bytes,
      content_type: data.content_type,
    });
  }

  return Response.json({ uploads: out });
}
