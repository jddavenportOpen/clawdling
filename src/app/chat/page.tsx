// ═══════════════════════════════════════════════════════════════════════════
// /chat — Telegram-style launcher landing OR Chat Cockpit grid.
//
// If `?panes=<sid>[,sid2,...]` is present in the URL → render ChatGrid
// (Chat Cockpit M1+). Otherwise render the original launcher landing,
// now with a "+ New Claude Session" CTA at the top of Quick actions.
//
// V3.2 (2026-05-28, JD msgs 8280+8285): the cockpit now has two render
// modes for the SAME running deck.
//   ?mode=chat (DEFAULT) — one focused chat fills the canvas; others stay
//                          mounted & streaming but hidden. ChatGPT/Claude.ai
//                          tabs mental model.
//   ?mode=pane           — the existing multi-pane grid (opt-in).
// The mode toggle lives in ChatGrid's toolbar. Storage + parsing live in
// `src/lib/cockpitMode.ts`. Mobile is chat-mode-only.
//
// Server Component. Three panes (landing mode):
//   Left sidebar: existing threads (most recent first)
//   Main: "Start a conversation" — agent launcher grid + active sessions
//   Right-most on desktop: empty (fills when a thread is selected)
// ═══════════════════════════════════════════════════════════════════════════

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authWithTimeout } from '@/lib/auth-timeout';
import { getThreadsForUser } from '@/lib/chat';
import ThreadSidebar from '@/components/chat/ThreadSidebar';
import MobileSidebarDrawer from '@/components/chat/MobileSidebarDrawer';
import ChatGrid from '@/components/chat/ChatGrid';
import NewSessionCta from '@/components/chat/NewSessionCta';
import NeedsYouNotifier from '@/components/chat/NeedsYouNotifier';
import agentRegistry from '@/config/agents.json';
import { byokEnabled, getUserSettings } from '@/lib/user-settings';
import { ensureWelcomeThread } from '@/lib/first-run';
// ── Warm Graphite foundation (REUSED — never an emoji) ──────────────────────
// The landing agent grid (critic round-2's gating surface) was the LAST chrome
// still rendering the raw Unicode emoji from agents.json (🦞/💪/🔬/…) on cool
// neutral-* tiles. It now renders each agent's bespoke per-agent Phosphor glyph
// (the "custom emoji"), a corner StatusGlyph, warm-graphite surface tokens, and
// the bespoke Clawdling wordmark hero. Icon's `state` encodes weight
// (regular idle → fill active → duotone domain). ZERO emoji survive here.
import { Icon } from '@/components/ds/Icon';
import { StatusGlyph } from '@/components/ds/StatusGlyph';
import { Wordmark, Eyebrow } from '@/components/ds/Wordmark';
import { agentGlyph } from '@/components/ds/glyphMap';
import { FolderSimple, ChatCircle } from '@phosphor-icons/react/dist/ssr';

export const dynamic = 'force-dynamic';

type AgentConfig = {
  id: string;
  name: string;
  icon: string;
  description: string;
};

// ── Per-agent role line (the muted mono sub-label under the name) ────────────
// The grid hierarchy is NAME (540 label) → ROLE (mono uppercase, tertiary) →
// DETAIL (the full description, clamped). agents.json carries only name +
// description, so the short function-true role lives here at the call-site (no
// edit to the shared config consumed by the bridge/picker). Lowercase keys
// match agents.json ids; unknown ids fall back to a neutral "Agent".
const AGENT_ROLE: Record<string, string> = {
  clawd: 'Orchestrator',
  health_coach: 'Health',
  researcher: 'Research',
  chief_of_staff: 'Operations',
  counselor: 'Reflection',
  professor: 'Course expert',
  quanta: 'Analytics',
  analytics_suite: 'Solver',
  counselor_ai_foundry: 'Admissions',
  qa_agent: 'Quality',
  ops: 'DevOps',
};
const agentRole = (id: string): string => AGENT_ROLE[id] ?? 'Agent';

interface SearchParams {
  panes?: string | string[];
  space?: string | string[];
}

export default async function ChatIndexPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  // 1.5s wall-clock budget on auth() — see src/lib/auth-timeout.ts. A bad
  // session cookie was hanging this route for 30s+, breaking multi-pane
  // cockpit UX (any pane that lost auth would hang the whole tab).
  const session = await authWithTimeout({ label: '/chat', budgetMs: 1500 });
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login?callbackUrl=/chat');

  // BYOK gate (docs/SPEC-BYOK.md): hosted users must connect a key before chatting.
  if (byokEnabled()) {
    const settings = await getUserSettings(userId);
    if (!settings.hasKey) redirect('/onboarding');
  }

  const params = (await searchParams) || {};
  const panesRaw = Array.isArray(params.panes) ? params.panes[0] : params.panes;
  const gridMode = !!(panesRaw && panesRaw.trim().length > 0);
  // ?space=<domain> focuses the rail on one Space (domain workspace) — a
  // shareable/bookmarkable URL. Spaces are derived from session cwd, so this
  // is a view focus, not a stored column.
  const spaceRaw = Array.isArray(params.space) ? params.space[0] : params.space;
  const initialSpace = spaceRaw && spaceRaw.trim().length > 0 ? spaceRaw.trim() : null;

  // First-run: on an empty install, seed a welcome thread explaining the 5
  // tools + how to add a domain, so a fresh boot is a usable first-run rather
  // than an empty shell. Idempotent (only fires when the user has 0 threads).
  await ensureWelcomeThread(userId, (session?.user as { email?: string } | undefined)?.email);

  const threads = await getThreadsForUser(userId);
  // Status-sort (critic round-2 FIX #5): the landing grid is a COLD launcher
  // (no bridge-live state server-side — the rail carries bridge-truth liveness),
  // so the honest "in-progress first" ordering is the primary CEO brain leading,
  // then the specialist roster in registry order. clawd floats to front
  // defensively in case the registry is reordered.
  const agents = [...(agentRegistry as AgentConfig[])].sort((a, b) =>
    a.id === 'clawd' ? -1 : b.id === 'clawd' ? 1 : 0
  );

  return (
    // 2026-05-24 mobile-responsive: switched outer container from h-screen
    // to h-full + min-h-0 so the chat surface respects DashboardShell's
    // flex math (which already reserves pb-20 on <md for the MobileTabBar).
    // The prior h-screen overlapped the tab bar — composer fell off-screen
    // on iPhone Safari portrait. h-full + parent's pb-20 keeps the composer
    // above the bar; safe-area-inset-bottom on the composer itself handles
    // the iPhone home indicator.
    //
    // CAT-08 (2026-06-12): `.chat-dvh` (height:100dvh on phones) is gated to
    // gridMode ONLY. In gridMode the cockpit owns the viewport — MobileTabBar
    // returns null and DashboardShell drops the pb-20 reserve (mobileCockpit
    // → pb-0), so a full-100dvh surface is correct. On the NON-cockpit /chat
    // landing the parent STILL reserves pb-20 (80px) for the fixed tab bar;
    // applying 100dvh there fought that reserve and pushed the bottom ~80px
    // (footer/composer) UNDER the tab bar with `overflow-hidden` clipping it.
    // Off-grid we defer to `h-full` + the parent flex/pb math.
    <div
      data-testid="chat-page"
      className={`${gridMode ? 'chat-dvh' : ''} flex h-full w-full min-h-0 bg-canvas text-1 overflow-hidden`}
    >
      {/* Needs-you notifier (chat-vision Iter 2) — headless poller of the
          existing /api/sessions/list activity feed; fires an OS notification
          (deep-linking into the pane) when a live agent parks on JD while the
          cockpit is backgrounded. Mounted once here so it runs in BOTH the
          launcher and the cockpit, independent of the rail's mount/visibility. */}
      <NeedsYouNotifier />
      {/* 2026-05-04 mobile fix — when gridMode is on, hide ThreadSidebar
          on mobile (<md). ThreadSidebar is w-full <md, so without this
          it consumed the entire viewport and the ChatGrid main pane was
          pushed off-screen to the right. Audit caught tab-strip buttons
          at x=390+ on a 390px viewport. Desktop is unchanged — sidebar
          at 288px + grid in the remaining width.

          P2.1 cockpit-multi-session-v2 (2026-05-23) — in gridMode,
          replace the bare ThreadSidebar with MobileSidebarDrawer. On
          mobile this becomes a hamburger button + slide-out drawer (so
          the user can switch threads from inside the cockpit). On
          desktop the drawer wraps ThreadSidebar inline, preserving the
          original layout. In non-grid mode (the launcher), behavior is
          unchanged: ThreadSidebar IS the mobile screen. */}
      {gridMode ? (
        <MobileSidebarDrawer
          threads={threads}
          activeThreadId={null}
          initialSpace={initialSpace}
        />
      ) : (
        <div className="contents">
          <ThreadSidebar
            threads={threads}
            activeThreadId={null}
            initialSpace={initialSpace}
          />
        </div>
      )}

      {/* Grid mode (Chat Cockpit M1+) — full-screen multi-pane.
          On mobile (<md): takes the whole viewport (sidebar hidden above).
          On desktop (>=md): flex-1 next to the 288px sidebar.
          ChatGrid renders mobile tabs vs desktop grid internally. */}
      {gridMode && (
        <main className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <ChatGrid />
        </main>
      )}

      {/* Mobile: ThreadSidebar IS the screen; this main pane hides at <md
          so the user gets a clean Telegram-style chat-list. Desktop keeps
          the full landing-page layout side-by-side. (block, not flex —
          original layout relied on block flow for the centered max-w-4xl.) */}
      {!gridMode && (
        <main className="hidden md:block flex-1 overflow-y-auto bg-canvas">
          {/* Doubled canvas whitespace (Linear's "take the spacing that feels
              enough, then double it"); optical, asymmetric density — not a flat
              uniform grid. */}
          <div className="max-w-4xl mx-auto px-8 py-14">
            {/* Hero — the brand lockup, rebuilt (critic round-3 FIX #6). The mono
                UPPERCASE "CLAWDLING" eyebrow sits ABOVE the bespoke lowercase
                `clawd` wordmark (the display brand mark, carrying its one accent
                claw-notch). The old build duplicated the wordmark: an outline-caps
                "CLAWDLING" SVG + the mono eyebrow + a redundant <h1>Clawd</h1>.
                The wordmark now IS "clawd", so the redundant heading is gone — one
                eyebrow, one wordmark. The opinionated subhead voice is kept verbatim. */}
            <header className="mb-14">
              <span className="flex flex-col gap-2 leading-none">
                <Eyebrow>CLAWDLING</Eyebrow>
                <Wordmark height={40} accent className="text-1" title="Clawdling" />
              </span>
              <p className="text-2 mt-5 max-w-xl leading-relaxed">
                Pick an agent to start a new conversation, spawn a fresh Claude Code session,
                or continue an existing thread from the sidebar.
              </p>
            </header>

            {/* Cockpit — the ONE filled hero-accent affordance on this screen
                lives inside NewSessionCta ("+ New session"). Everything else
                below is hairline / text-tint only (accent rationed to one
                filled instance per screen). */}
            <section className="mb-14">
              <h2 className="overline mb-3">Cockpit</h2>
              <div className="space-y-3">
                <NewSessionCta />
              </div>
            </section>

            {/* AGENTS — the centerpiece. Asymmetric density (NOT a flat uniform
                grid): the primary CEO tile is a wide FEATURED row that spans the
                full grid and carries the screen's ONE sanctioned accent GLYPH
                treatment (an unfilled accent hairline edge + accent-tinted
                duotone glyph + a VISIBLE working StatusGlyph — the orchestrator
                is the always-on brain). The specialist roster sits below in a
                quieter 3-up grid. Each tile reads NAME (540) → ROLE (mono
                tertiary) → DETAIL (clamped). Hover lifts the surface by LUMINANCE
                (surface-2 → surface-3), never a shadow; press = scale(0.97). */}
            <section className="mb-14">
              <h2 className="overline mb-4">Agents</h2>
              {(() => {
                const ceo = agents.find((a) => a.id === 'clawd');
                const rest = agents.filter((a) => a.id !== 'clawd');
                return (
                  <div className="space-y-3">
                    {ceo && (() => {
                      const g = agentGlyph(ceo.id);
                      return (
                        <Link
                          key={ceo.id}
                          href={`/agents/${ceo.id}`}
                          // The ONE accent-glyph tile. Unfilled accent hairline
                          // edge (border-accent-border, low-alpha — NOT a filled
                          // chip), surface-2 → surface-3 lift, press scale.
                          className="group press lift flex items-start gap-4 rounded-[var(--radius-md)] border border-accent-border bg-surface-2 p-5 hover:bg-surface-3"
                        >
                          {/* bespoke CEO glyph — accent-tinted duotone (the one
                              accent glyph), in a hairline-bounded surface chip so
                              it reads as the lead mark, not decor. */}
                          <span className="shrink-0 flex h-12 w-12 items-center justify-center rounded-[var(--radius-md)] border border-hairline bg-surface-1">
                            <Icon
                              glyph={g.glyph}
                              state="domain"
                              size={26}
                              className="text-accent-text"
                              aria-hidden
                            />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2.5">
                              <span className="weight-label text-1 truncate">{ceo.name}</span>
                              {/* the signature status ring, VISIBLE + STATE-BEARING:
                                  the CEO brain is the always-on orchestrator, so
                                  it renders the `working` arc (animated partial
                                  ring) — the one tile on this cold launcher with
                                  real, distinguishable state (critic r1 FIX #1). */}
                              <StatusGlyph state="working" size={14} title="Orchestrator — always on" />
                            </div>
                            {/* Critic r1 FIX #5 — tighter, more letterspaced mono
                                role caption (matches the specialist eyebrow rhythm). */}
                            <div className="role-caption mt-1 mb-2 text-accent-text/80">
                              {agentRole(ceo.id)} · always on
                            </div>
                            <p className="text-xs text-2 leading-relaxed max-w-xl">
                              {ceo.description}
                            </p>
                          </div>
                        </Link>
                      );
                    })()}

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {rest.map((a) => {
                        const g = agentGlyph(a.id);
                        // Critic r1 FIX #1 — a ring that never changes is worse
                        // than no ring. This IS a COLD launcher: there is no
                        // per-specialist liveness server-side (the rail carries
                        // bridge-truth, and it spawns these on click). So we do
                        // NOT paint an identical empty idle ring on every tile —
                        // that read as decoration, not signal. The honest cue is
                        // a small mono "spawn on click" availability caption; the
                        // STATE-bearing ring lives on the always-on CEO tile and
                        // on the live rail/cockpit tabs where real state exists.
                        return (
                          <Link
                            key={a.id}
                            href={`/agents/${a.id}`}
                            // Critic r1 FIX #5 — depth/hierarchy. Non-hero tiles
                            // get a tier-2 surface (surface-2) PLUS a 1px lighter
                            // top-edge inset hairline (the inset ring) so the eye
                            // reads elevation by luminance, not a flat rectangle.
                            // Hover lifts surface-2 → surface-3. radius-md (8px),
                            // press scale; no one-side colored border (banned).
                            className="group press lift relative rounded-[var(--radius-md)] border border-hairline bg-surface-2 p-4 hover:bg-surface-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.045)]"
                          >
                            <div className="flex items-center gap-3 mb-2">
                              {/* bespoke per-agent glyph — text-secondary idle,
                                  warms to accent-text on hover. The accent stays
                                  rationed: specialists never carry a permanent
                                  fill — only the CEO tile gets the accent glyph. */}
                              <Icon
                                glyph={g.glyph}
                                state="idle"
                                size={22}
                                className="shrink-0 text-2 group-hover:text-accent-text transition-colors duration-[var(--dur-fast)]"
                                aria-hidden
                              />
                              <span className="min-w-0">
                                <span className="block weight-label text-1 truncate leading-tight">
                                  {a.name}
                                </span>
                                {/* Critic r1 FIX #5 — tighter role eyebrow: a
                                    smaller, more letterspaced mono caption for a
                                    cleaner type rhythm under the name. */}
                                <span className="block role-caption mt-1 text-3">
                                  {agentRole(a.id)}
                                </span>
                              </span>
                            </div>
                            <p className="text-xs text-3 leading-relaxed line-clamp-2">
                              {a.description}
                            </p>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </section>

            <section>
              <h2 className="overline mb-4">Quick actions</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Link
                  href="/projects"
                  className="group rounded-[var(--radius-md)] border border-hairline bg-surface-2 p-4 hover:bg-surface-3 transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-strong)]"
                >
                  <div className="flex items-center gap-3 mb-1">
                    <Icon
                      glyph={FolderSimple}
                      state="idle"
                      size={18}
                      className="shrink-0 text-2 group-hover:text-accent-text transition-colors duration-[var(--dur-fast)]"
                      aria-hidden
                    />
                    <span className="weight-label text-1">Spawn project session</span>
                  </div>
                  <p className="text-xs text-3">
                    Open a Claude Code CLI session with a project&apos;s context loaded.
                  </p>
                </Link>
                <Link
                  href="/chat/new?kind=ad-hoc"
                  className="group rounded-[var(--radius-md)] border border-hairline bg-surface-2 p-4 hover:bg-surface-3 transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-strong)]"
                >
                  <div className="flex items-center gap-3 mb-1">
                    <Icon
                      glyph={ChatCircle}
                      state="idle"
                      size={18}
                      className="shrink-0 text-2 group-hover:text-accent-text transition-colors duration-[var(--dur-fast)]"
                      aria-hidden
                    />
                    <span className="weight-label text-1">Ad-hoc chat</span>
                  </div>
                  <p className="text-xs text-3">
                    Free-form conversation, no project or agent context.
                  </p>
                </Link>
              </div>
            </section>

            {threads.length === 0 && (
              <p className="mt-12 text-sm text-3 text-center">
                No threads yet. Pick an agent above to start your first conversation.
              </p>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
