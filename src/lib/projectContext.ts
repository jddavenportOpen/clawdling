// ═══════════════════════════════════════════════════════════════════════════
// projectContext — fetch a per-project system-prompt snapshot from the bridge.
//
// The bridge host owns the source-of-truth at $ADJUTANT_STATE_ROOT/projects/<slug>/.
// The web app can't read those files, so we ask the bridge, which assembles the prompt
// from README/WORKPLAN/CHANGELOG/LINKS.md (capped at 40KB total) and
// returns it as JSON. We snapshot once at thread-creation time and store
// it on the thread row — see `getOrCreateProjectAgentThread` in lib/chat.ts.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

import { bridgeFetch } from '@/lib/bridge-client';

export interface ProjectContext {
  slug: string;
  systemPrompt: string;
  sourceFiles: string[];
  cwd: string;
}

/**
 * Fetch a project's assembled context from the Mac bridge.
 * Returns null if the project doesn't exist on disk.
 * Throws on network/auth errors.
 */
export async function fetchProjectContext(
  slug: string,
  userId: string,
  email: string
): Promise<ProjectContext | null> {
  const res = await bridgeFetch(
    `/api/projects/${encodeURIComponent(slug)}/context`,
    { method: 'GET' },
    userId,
    email
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`bridge project context failed: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    slug: string;
    system_prompt: string;
    source_files: string[];
    cwd: string;
  };
  return {
    slug: data.slug,
    systemPrompt: data.system_prompt,
    sourceFiles: data.source_files,
    cwd: data.cwd,
  };
}
