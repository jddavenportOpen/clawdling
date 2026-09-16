// ═══════════════════════════════════════════════════════════════════════════
// /agents — the agent index.
//
// Only /agents/[id] existed, so the "Agents" entry in MobileTabBar (and the
// sidebar / command palette) 404'd on every tap. This is that missing index:
// the roster from src/config/agents.json, each tile linking to the agent's
// existing detail route, which finds-or-creates its chat thread and redirects
// into /chat/[threadId].
//
// Server Component, auth-gated exactly like its [id] sibling, so an unauthed
// visitor lands on /login with a callbackUrl instead of seeing a roster whose
// every link would bounce them. The roster itself is static config, so there
// is no data fetch and nothing to degrade.
// ═══════════════════════════════════════════════════════════════════════════

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { Icon } from '@/components/ds/Icon';
import { agentGlyph } from '@/components/ds/glyphMap';
import agentRegistry from '@/config/agents.json';

export const dynamic = 'force-dynamic';

type AgentConfig = {
  id: string;
  name: string;
  icon: string;
  description: string;
};

export default async function AgentsIndexPage() {
  const session = await auth({ label: 'GET /agents' });
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login?callbackUrl=/agents');

  const agents = agentRegistry as AgentConfig[];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-md flex items-center justify-center border border-hairline bg-surface-2">
          <Icon
            glyph={agentGlyph('assistant').glyph}
            state="domain"
            size={20}
            className="text-2"
          />
        </div>
        <div>
          <h1 className="text-2xl font-display weight-strong tracking-tight text-1 display">
            Agents
          </h1>
          <p className="overline mt-0.5">Your roster — one thread each</p>
        </div>
      </div>

      {/* Roster. A tile is a link into the agent's own persistent thread. */}
      {agents.length === 0 ? (
        <div className="rounded-lg border border-hairline bg-surface-1 p-8 text-center">
          <p className="text-sm font-mono text-3">
            No agents configured. Add one to src/config/agents.json.
          </p>
        </div>
      ) : (
        <div
          data-testid="agents-list"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        >
          {agents.map((a) => {
            const g = agentGlyph(a.id);
            return (
              <Link
                key={a.id}
                href={`/agents/${a.id}`}
                data-testid={`agent-card-${a.id}`}
                // Same tile treatment as the /chat launcher: tier-2 surface, a
                // 1px inset top highlight for elevation by luminance, and the
                // accent rationed to hover only.
                className="group press lift relative rounded-[var(--radius-md)] border border-hairline bg-surface-2 p-4 hover:bg-surface-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.045)]"
              >
                <div className="flex items-center gap-3 mb-2">
                  <Icon
                    glyph={g.glyph}
                    state="idle"
                    size={22}
                    className="shrink-0 text-2 group-hover:text-accent-text transition-colors duration-[var(--dur-fast)]"
                    aria-hidden
                  />
                  {/* No role caption: AGENT_GLYPHS' label is the agent's own
                      name for every agent in the roster, so a caption line
                      would just print the title twice. */}
                  <span className="min-w-0 flex-1 weight-label text-1 truncate leading-tight">
                    {a.name}
                  </span>
                  <Icon
                    glyph={ArrowRight}
                    state="idle"
                    size={14}
                    className="shrink-0 text-4 group-hover:text-accent-text transition-colors duration-[var(--dur-fast)]"
                    aria-hidden
                  />
                </div>
                <p className="text-xs text-2 leading-relaxed">{a.description}</p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
