'use client';

// ═══════════════════════════════════════════════════════════════════════════
// NewSessionButton
//
// Client button that, on click:
//   1. POSTs to /api/chat to create a new chat_threads row
//        (kind='project-session', ref_id=projectSlug)
//   2. POSTs to /api/sessions/spawn with the returned thread_id
//   3. router.push()s to /projects/<slug>/sessions/<sid>
//
// Shows inline error state if any step fails. Disables while in flight.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Terminal, AlertCircle } from 'lucide-react';

interface Props {
  projectSlug: string;
  cwd?: string;
  label?: string;
}

export default function NewSessionButton({ projectSlug, cwd, label = 'New Session' }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      // 1) Create thread
      const threadRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'project-session',
          ref_id: projectSlug,
          title: `Session: ${projectSlug}`,
        }),
      });
      if (!threadRes.ok) {
        const txt = await threadRes.text();
        throw new Error(`thread: ${threadRes.status} ${txt.slice(0, 200)}`);
      }
      const threadData = await threadRes.json();
      const threadId: string | undefined = threadData?.id;
      if (!threadId) throw new Error('thread created but no id returned');

      // 2) Spawn bridge session
      const spawnRes = await fetch('/api/sessions/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread_id: threadId,
          project_slug: projectSlug,
          ...(cwd ? { cwd } : {}),
        }),
      });
      if (!spawnRes.ok) {
        const txt = await spawnRes.text();
        throw new Error(`spawn: ${spawnRes.status} ${txt.slice(0, 200)}`);
      }
      const spawnData = await spawnRes.json();
      const sid: string | undefined = spawnData?.session_id;
      if (!sid) throw new Error('spawned but no session_id returned');

      // 3) Navigate
      router.push(
        `/projects/${encodeURIComponent(projectSlug)}/sessions/${encodeURIComponent(sid)}`
      );
    } catch (err) {
      console.error('[NewSessionButton]', err);
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <button
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium border border-neon-cyan/30 text-neon-cyan bg-neon-cyan/[0.08] hover:bg-neon-cyan/[0.14] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Terminal className="w-3.5 h-3.5" />
        )}
        {busy ? 'Spawning...' : label}
      </button>
      {error && (
        <div className="inline-flex items-start gap-1 text-[10px] font-mono text-neon-red max-w-[420px]">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}
    </div>
  );
}
