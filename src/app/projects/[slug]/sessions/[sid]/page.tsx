// ═══════════════════════════════════════════════════════════════════════════
// /projects/[slug]/sessions/[sid]
//
// Server component. Loads the chat_sessions row + parent thread + first 50
// messages from Supabase (ownership-checked against the signed-in user),
// then hands them off to <SessionTerminal /> which manages the live SSE.
// ═══════════════════════════════════════════════════════════════════════════

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Folder } from '@phosphor-icons/react/dist/ssr';

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { getServerClient, type DbChatSession } from '@/lib/supabase';
import { getThreadById, getMessagesForThread } from '@/lib/chat';
import { Icon } from '@/components/ds/Icon';
import NeonBadge from '@/components/NeonBadge';
import SessionTerminal from '@/components/chat/SessionTerminal';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string; sid: string }>;
}

export default async function ProjectSessionPage({ params }: PageProps) {
  const { slug, sid } = await params;

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    redirect(`/login?callbackUrl=/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sid)}`);
  }

  // Load session
  const supabase = getServerClient();
  const { data: chatSessionRaw, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('id', sid)
    .maybeSingle();

  if (error) {
    return (
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <BackLink slug={slug} />
        <div className="rounded-lg border border-hairline bg-surface-1 p-6">
          <p className="text-sm font-mono text-state-danger-muted">
            Failed to load session: {error.message}
          </p>
        </div>
      </div>
    );
  }
  const chatSession = chatSessionRaw as DbChatSession | null;
  if (!chatSession) notFound();

  // Ownership check via thread
  const thread = await getThreadById(chatSession.thread_id, userId);
  if (!thread) {
    return (
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <BackLink slug={slug} />
        <div className="rounded-lg border border-hairline bg-surface-1 p-6">
          <p className="text-sm font-mono text-state-danger-muted">
            You don&apos;t have access to this session.
          </p>
        </div>
      </div>
    );
  }

  // Load first 50 messages (if any — early sessions won't have any yet)
  let messages: Awaited<ReturnType<typeof getMessagesForThread>> = [];
  try {
    messages = await getMessagesForThread(chatSession.thread_id, userId, 50);
  } catch {
    messages = [];
  }

  const startedDate = new Date(chatSession.started_at);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 space-y-4 relative z-10">
      <BackLink slug={slug} />

      {/* Header — hairline-bordered warm surface. */}
      <div className="rounded-lg border border-hairline bg-surface-1 p-4">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="w-9 h-9 rounded-md flex items-center justify-center border border-hairline bg-surface-2 flex-shrink-0">
            <Icon glyph={Folder} state="domain" size={16} className="text-2" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-display weight-strong text-1 truncate display">
              {thread.title || `Session on ${slug}`}
            </h1>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <code className="text-[10px] font-mono text-3 bg-surface-2 px-2 py-0.5 rounded-sm">
                {slug}
              </code>
              <NeonBadge
                color={chatSession.status === 'live' ? 'green' : chatSession.status === 'starting' ? 'amber' : 'cyan'}
                size="sm"
              >
                {chatSession.status.toUpperCase()}
              </NeonBadge>
              <span className="text-[10px] font-mono tabular text-3">
                started {startedDate.toLocaleString()}
              </span>
              {chatSession.pid != null && (
                <span className="text-[10px] font-mono tabular text-3">
                  pid {chatSession.pid}
                </span>
              )}
              {chatSession.cwd && (
                <code className="text-[10px] font-mono text-3 bg-surface-2 px-2 py-0.5 rounded-sm truncate max-w-[260px]">
                  {chatSession.cwd}
                </code>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Past messages (minimal — just so reloads show context) */}
      {messages.length > 0 && (
        <div className="rounded-lg border border-hairline bg-surface-1 p-3">
          <p className="overline mb-2 px-1">
            Recent messages (<span className="tabular">{messages.length}</span>)
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {messages.map((m) => (
              <div
                key={m.id}
                className="px-3 py-2 rounded-md bg-surface-2 border border-border-micro text-[11px] font-mono"
              >
                <span className="text-3 uppercase text-[9px] tracking-widest mr-2">
                  {m.role}
                </span>
                <span className="text-1 whitespace-pre-wrap">{m.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live terminal */}
      <SessionTerminal
        sessionId={chatSession.id}
        initialStatus={chatSession.status}
        projectSlug={chatSession.project_slug}
        threadId={chatSession.thread_id}
      />
    </div>
  );
}

function BackLink({ slug }: { slug: string }) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(slug)}`}
      className="inline-flex items-center gap-1.5 text-sm font-mono text-3 press hover:text-1 focus-accent rounded-sm"
    >
      <Icon glyph={ArrowLeft} size={16} />
      Back to project
    </Link>
  );
}
