// ═══════════════════════════════════════════════════════════════════════════
// /chat/[threadId] — READ-ONLY TRANSCRIPT VIEW (V3 M7, 2026-05-28)
//
// Retired from primary use. The PRD says: panes (`?panes=<sid>`) are the ONE
// chat model. Live + dead-row clicks both land in panes now (PR #102/#105/#107).
//
// This URL survives as a bookmarkable transcript-history surface — modifier-
// click on a rail row still pops the transcript in a new tab (ThreadSidebar
// line ~1068 + ~1178 preserves that power-user pattern). What it ISN'T
// anymore: a place to send messages or spawn agents. No Composer, no polling.
// Just the stored chat_messages rendered with a CTA back to the cockpit.
//
// If the thread has any chat_sessions, the most recent one is offered as an
// "Open in cockpit" link → /chat?panes=<sid>. If not (chat-only thread with
// no spawned agent session), the CTA collapses to a "Back to cockpit" link.
// ═══════════════════════════════════════════════════════════════════════════

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { authWithTimeout } from '@/lib/auth-timeout';
import { getMessagesForThread, getThreadById, getThreadsForUser, type ChatMessage } from '@/lib/chat';
import { getServerClient, type DbChatSession } from '@/lib/supabase';
import ThreadSidebar from '@/components/chat/ThreadSidebar';
import TranscriptMessage from '@/components/chat/TranscriptMessage';
import SdkChat from '@/components/chat/SdkChat';

export const dynamic = 'force-dynamic';

// When the SDK engine is active (Vercel / self-host, no Mac Mini bridge), the
// thread page is INTERACTIVE: SdkChat streams replies via /api/chat/[threadId].
// Otherwise it stays the bridge-era read-only transcript.
const ENGINE_SDK = process.env.ADJUTANT_ENGINE === 'sdk';

/**
 * Find the most recent chat_session for this thread (any status). Used to
 * power the "Open in cockpit" CTA. Returns null if the thread never spawned
 * a session (pure chat-only thread).
 *
 * No bridge call — Supabase-only. The cockpit pane will handle live-vs-dead
 * resolution itself via /api/sessions/list (PR #105 meta-resolution).
 */
async function getLatestSessionForThread(threadId: string): Promise<DbChatSession | null> {
  const { data, error } = await getServerClient()
    .from('chat_sessions')
    .select('*')
    .eq('thread_id', threadId)
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) return null;
  return ((data as DbChatSession[]) ?? [])[0] ?? null;
}

export default async function ThreadTranscriptPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  // 1.5s wall-clock auth budget — protects against the hang-on-stale-session
  // bug. See src/lib/auth-timeout.ts.
  const session = await authWithTimeout({ label: `/chat/${threadId}`, budgetMs: 1500 });
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const [thread, messages, threads, latestSession] = await Promise.all([
    getThreadById(threadId, userId),
    // M7: pull a deeper transcript than the old 50-msg ChatView default.
    // This is read-only history — JD wants to scroll back, not stream forward.
    getMessagesForThread(threadId, userId, 500),
    getThreadsForUser(userId),
    getLatestSessionForThread(threadId),
  ]);

  if (!thread) return notFound();

  // CTA target — most recent session goes straight into a pane. Falls back to
  // the empty cockpit if there's no session (chat-only threads, legacy rows).
  const cockpitHref = latestSession ? `/chat?panes=${encodeURIComponent(latestSession.id)}` : '/chat';
  const cockpitLabel = latestSession ? 'Open in cockpit' : 'Back to cockpit';

  return (
    <div className="flex h-full bg-neutral-950 text-neutral-100">
      {/* Mobile (<md): hide thread list — transcript takes the whole
          screen. User taps the back arrow in the header to return to /chat.
          Desktop (>=md): show both side-by-side. */}
      <div className="hidden md:flex">
        <ThreadSidebar threads={threads} activeThreadId={threadId} />
      </div>

      <section className="flex-1 flex flex-col min-w-0">
        <header className="px-4 sm:px-6 py-3 border-b border-neutral-800 flex items-center gap-3 shrink-0">
          {/* Back arrow — mobile only. Returns to thread list. */}
          <Link
            href="/chat"
            aria-label="Back to threads"
            className="md:hidden -ml-1 p-1.5 rounded-md text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900 transition"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </Link>
          <div className="text-base font-semibold truncate">{thread.title}</div>
          <div className="text-xs text-neutral-500 font-mono hidden sm:block">
            {thread.kind === 'agent' && thread.ref_id ? `agent · ${thread.ref_id}` : thread.kind}
          </div>
          {/* CTA — push JD back into the cockpit. Live use of this thread
              happens in a pane; this surface is transcript-only. */}
          <div className="ml-auto flex items-center gap-2">
            {!ENGINE_SDK && (
              <>
                <span
                  aria-label="Read-only transcript"
                  title="Read-only — open in cockpit to continue"
                  className="text-[10px] uppercase tracking-wider text-neutral-500 font-mono hidden sm:inline"
                >
                  transcript · read-only
                </span>
                <Link
                  href={cockpitHref}
                  className="text-xs px-2.5 py-1 rounded-md border border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 hover:border-neutral-600 transition whitespace-nowrap"
                >
                  {cockpitLabel} →
                </Link>
              </>
            )}
          </div>
        </header>

        {ENGINE_SDK ? (
          <SdkChat
            threadId={threadId}
            initialMessages={messages.map((m) => ({ id: m.id, role: m.role, content: m.content }))}
          />
        ) : (
          <>
            {/* Bridge-era read-only banner + transcript. */}
            <div className="px-4 sm:px-6 py-2 border-b border-neutral-800/60 bg-neutral-900/40 text-[11px] text-neutral-400 shrink-0">
              You&rsquo;re reading the archived transcript. To continue the conversation, open this thread in the cockpit grid.
            </div>
            <TranscriptList messages={messages} />
          </>
        )}
      </section>
    </div>
  );
}

// ── Render ──────────────────────────────────────────────────────────────
// Server component — no polling, no streaming, no composer. Static list.
// Mirrors MessageStream's per-role styling but stripped of everything that
// depended on `isStreaming` / `streamingText` / `queuedMessages`.

function TranscriptList({ messages }: { messages: ChatMessage[] }) {
  if (messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-12 text-center text-sm text-neutral-500">
        No messages in this thread. Open it in the cockpit to start one.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 space-y-4">
      {messages.map((m) => (
        <TranscriptMessage key={m.id} msg={m} />
      ))}
    </div>
  );
}
