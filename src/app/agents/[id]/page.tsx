// ═══════════════════════════════════════════════════════════════════════════
// /agents/[id] — dedicated chat surface for a single domain agent.
// Finds or creates a chat_threads row with kind='agent', ref_id=<agent_id>,
// then redirects to /chat/[threadId]. Telegram-style — one thread per agent
// persists across sessions.
// ═══════════════════════════════════════════════════════════════════════════

import { redirect, notFound } from 'next/navigation';
import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { getServerClient } from '@/lib/supabase';
import { createThread } from '@/lib/chat';
import agentRegistry from '@/config/agents.json';

export const dynamic = 'force-dynamic';

type AgentConfig = {
  id: string;
  name: string;
  icon: string;
  description: string;
};

export default async function AgentChatRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: agentId } = await params;

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect(`/login?callbackUrl=/agents/${agentId}`);

  const agents = agentRegistry as AgentConfig[];
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) notFound();

  // Find the user's existing thread for this agent, or create one.
  const supabase = getServerClient();
  const { data: existing } = await supabase
    .from('chat_threads')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', 'agent')
    .eq('ref_id', agentId)
    .is('archived_at', null)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let threadId: string;
  if (existing?.id) {
    threadId = existing.id;
  } else {
    const created = await createThread(
      userId,
      'agent',
      agentId,
      agent.name,
    );
    threadId = created.id;
  }

  redirect(`/chat/${threadId}`);
}
