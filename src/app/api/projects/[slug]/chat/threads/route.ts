// ═══════════════════════════════════════════════════════════════════════════
// POST /api/projects/[slug]/chat/threads
//
// Get-or-create a chat thread scoped to (user, project_slug, agent_id).
// On a fresh create: ask the Mac bridge for the assembled system-prompt
// snapshot from the project's README/WORKPLAN/CHANGELOG/LINKS, store it
// on the thread row. Subsequent turns replay that prompt via /api/chat/
// [threadId] which already passes thread.system_prompt to the bridge.
//
// Request body:
//   { agent_id?: string, force_new?: boolean }   default agent: "clawd"
//
// Response:
//   { thread_id: string, is_new: boolean, project_slug: string,
//     agent_id: string, source_files: string[] }
//
// GET /api/projects/[slug]/chat/threads?agent_id=clawd
//
// Returns the recent thread list for (user, project, agent). Drives the
// in-panel "Recent chats" tabs introduced in Phase 3.
//
// Response:
//   { threads: [{ id, title, last_message_at, created_at, agent_id }, ...] }
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import {
  createFreshProjectAgentThread,
  getOrCreateProjectAgentThread,
  listProjectAgentThreads,
} from '@/lib/chat';
import { fetchProjectContext } from '@/lib/projectContext';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DEFAULT_AGENT_ID = 'clawd';

interface PostBody {
  agent_id?: string;
  /**
   * When true, ALWAYS create a brand new thread for (user, project, agent),
   * bypassing the resume-latest lookup. Used by the "Refresh project
   * context" button so JD can snapshot the latest README/WORKPLAN/CHANGELOG
   * into a fresh thread.
   */
  force_new?: boolean;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  const userObj = session?.user as { id?: string; email?: string } | undefined;
  const userId = userObj?.id;
  const email = userObj?.email ?? 'unknown@local';
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: 'Invalid project slug' }, { status: 400 });
  }

  let body: PostBody = {};
  try {
    body = (await request.json()) as PostBody;
  } catch {
    // empty body is OK — defaults to CEO
  }
  const agentId = (body.agent_id || DEFAULT_AGENT_ID).trim();
  if (!/^[a-z0-9_]+$/.test(agentId)) {
    return Response.json({ error: 'Invalid agent_id' }, { status: 400 });
  }

  // Track which docs actually contributed to the snapshot, so the UI can
  // show "Loaded README + WORKPLAN + last 12 changelog entries" or similar.
  let sourceFiles: string[] = [];

  const buildSystemPrompt = async (): Promise<string | null> => {
    // Snapshot the project's docs from the bridge. If the project
    // doesn't exist on disk we still create the thread but with a
    // null system_prompt — the per-agent persona from
    // resolveThreadRuntime() carries the conversation.
    try {
      const ctx = await fetchProjectContext(slug, userId, email);
      if (!ctx) return null;
      sourceFiles = ctx.sourceFiles;
      return ctx.systemPrompt;
    } catch (err) {
      // Don't block thread creation on a context-assembly failure;
      // log it and let the agent run without project context. The
      // user will get an empty-context experience but the chat opens.
      console.error('[project-threads] context fetch failed:', err);
      return null;
    }
  };

  try {
    const { thread, isNew } = body.force_new
      ? await createFreshProjectAgentThread(userId, slug, agentId, buildSystemPrompt)
      : await getOrCreateProjectAgentThread(userId, slug, agentId, buildSystemPrompt);

    return Response.json({
      thread_id: thread.id,
      is_new: isNew,
      project_slug: slug,
      agent_id: agentId,
      source_files: sourceFiles,
    });
  } catch (err) {
    return Response.json(
      { error: `Thread create failed: ${String(err instanceof Error ? err.message : err)}` },
      { status: 500 }
    );
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: 'Invalid project slug' }, { status: 400 });
  }

  const url = new URL(request.url);
  const agentId = (url.searchParams.get('agent_id') || DEFAULT_AGENT_ID).trim();
  if (!/^[a-z0-9_]+$/.test(agentId)) {
    return Response.json({ error: 'Invalid agent_id' }, { status: 400 });
  }
  const limitRaw = parseInt(url.searchParams.get('limit') || '10', 10);
  const limit = Math.max(1, Math.min(50, isNaN(limitRaw) ? 10 : limitRaw));

  try {
    const threads = await listProjectAgentThreads(userId, slug, agentId, limit);
    return Response.json({
      threads: threads.map((t) => ({
        id: t.id,
        title: t.title,
        last_message_at: t.last_message_at,
        created_at: t.created_at,
        agent_id: t.ref_id,
      })),
    });
  } catch (err) {
    return Response.json(
      { error: `Thread list failed: ${String(err instanceof Error ? err.message : err)}` },
      { status: 500 }
    );
  }
}
