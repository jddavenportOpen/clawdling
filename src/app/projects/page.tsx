'use client';

import { motion } from 'framer-motion';
import {
  Stack,
  Plus,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react/dist/ssr';
// HudStat (a Foundation shared component) is typed to LucideIcon; keep its four
// stat icons on the sanctioned Lucide invisible-fallback set so its contract is
// untouched. All other page chrome uses the bespoke ds/Icon (Phosphor).
import { Layers, CheckCircle2, Pause, Zap } from 'lucide-react';
import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Icon } from '@/components/ds/Icon';
import NeonBadge from '@/components/NeonBadge';
import HudStat from '@/components/HudStat';
import ProjectDetailModal from '@/components/ProjectDetailModal';
import ProjectFormModal from '@/components/ProjectFormModal';
import ConfirmDialog from '@/components/ConfirmDialog';
import ProjectCard, { Project } from '@/components/projects/ProjectCard';
import LiveProjectSessions from '@/components/projects/LiveProjectSessions';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectsData {
  projects: Project[];
  active: number;
  paused: number;
  complete: number;
}

type FilterKey = 'all' | 'active' | 'paused' | 'complete' | 'archived';

// ── Data Fetching ─────────────────────────────────────────────────────────────

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const json = await res.json();
  return json.data as ProjectsData;
};

// ── Filter Pills ──────────────────────────────────────────────────────────────

function FilterPills({
  active,
  onChange,
  counts,
}: {
  active: FilterKey;
  onChange: (f: FilterKey) => void;
  counts: { all: number; active: number; paused: number; complete: number; archived: number };
}) {
  const pills: { key: FilterKey; label: string }[] = [
    { key: 'all',      label: `All (${counts.all})` },
    { key: 'active',   label: `Active (${counts.active})` },
    { key: 'paused',   label: `Paused (${counts.paused})` },
    { key: 'complete', label: `Complete (${counts.complete})` },
    { key: 'archived', label: `Archived (${counts.archived})` },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {pills.map((pill) => (
        <button
          key={pill.key}
          onClick={() => onChange(pill.key)}
          className={`px-3 py-1.5 rounded-pill text-xs font-mono weight-label border press lift focus-accent ${
            active === pill.key
              ? 'bg-accent-subtle border-accent-border text-accent-text'
              : 'bg-transparent border-hairline text-3 hover:bg-surface-2 hover:text-2'
          }`}
        >
          {pill.label}
        </button>
      ))}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  const { data, error, isLoading, mutate } = useSWR<ProjectsData>('/api/projects', fetcher, {
    refreshInterval: 120_000,
  });

  const router = useRouter();
  const [filter, setFilter] = useState<FilterKey>('all');
  // Free-text search over project name + slug + domain. Combined with the
  // status filter (AND). Clears via the X button or empty input.
  const [searchQuery, setSearchQuery] = useState('');
  const [chatLoadingSlug, setChatLoadingSlug] = useState<string | null>(null);
  const [detailProject, setDetailProject] = useState<string | null>(null);

  // JD msg 8277 (2026-05-28): *"from the projects tab, when I select boot up
  // a chat, I want a specific agent uploaded with that entire projects
  // context and history... Thats the whole point"*
  //
  // The PRIOR behavior (2026-04-28) merely created a chat_threads row and
  // navigated to /chat/<threadId> — the M7-demoted read-only transcript
  // view. The pane showed "No messages in this thread. Open it in the
  // cockpit to start one." NO agent was spawned. The projects tab was a
  // glorified bookmark list.
  //
  // NOW: POST /api/sessions/spawn-project, which spawns a fresh Claude Code
  // session ALREADY ROOTED in $ADJUTANT_STATE_ROOT/projects/<slug>/ with the project's
  // README + WORKPLAN status + CHANGELOG tail + LINKS.md + prior-sessions
  // pointer pre-injected as the first prompt (bridge-side
  // _build_project_context). Then route to /chat?panes=<sid> — the cockpit
  // grid — same destination LaunchAllDomainsButton uses, so the freshly
  // spawned agent surfaces as its own pane in the multi-session cockpit.
  //
  // Spawn is ~3-8s (bridge fork + lean MCP boot) so the "Opening…" badge
  // on the clicked card matters more than it did for the old fast path.
  const openProjectChat = useCallback(
    async (slug: string) => {
      if (chatLoadingSlug) return; // prevent double-clicks during nav
      setChatLoadingSlug(slug);
      try {
        const res = await fetch('/api/sessions/spawn-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_slug: slug }),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => `HTTP ${res.status}`);
          throw new Error(errBody.slice(0, 300));
        }
        const data = (await res.json()) as { session_id?: string };
        if (!data.session_id) {
          throw new Error('Bridge returned no session_id');
        }
        // Route to the cockpit grid as a single-pane URL — JD can add more
        // panes from the launcher or by clicking another project later.
        router.push(`/chat?panes=${encodeURIComponent(data.session_id)}`);
      } catch (err) {
        // Surface the failure inline rather than silently doing nothing.
        // alert() is rough but it's visible — refine later if JD wants a
        // toast/error UI.
        alert(`Couldn't spawn project chat: ${String(err instanceof Error ? err.message : err)}`);
        setChatLoadingSlug(null);
      }
    },
    [chatLoadingSlug, router]
  );

  // CRUD state
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const projects = data?.projects || [];
  const activeCount = projects.filter(p => p.status === 'active').length;
  const pausedCount = projects.filter(p => p.status === 'paused' || p.status === 'planning').length;
  const completeCount = projects.filter(p => p.status === 'complete').length;
  const archivedCount = projects.filter(p => p.status === 'archived').length;

  const q = searchQuery.trim().toLowerCase();
  const filtered = projects.filter((p) => {
    // Status filter
    let statusOk = true;
    if (filter === 'active') statusOk = p.status === 'active';
    else if (filter === 'paused') statusOk = p.status === 'paused' || p.status === 'planning';
    else if (filter === 'complete') statusOk = p.status === 'complete';
    else if (filter === 'archived') statusOk = p.status === 'archived';
    if (!statusOk) return false;
    // Search filter (matches name, id/slug, owner, phase — case-insensitive)
    if (!q) return true;
    const hay = [
      p.name,
      p.id,
      p.owner ?? '',
      p.phase ?? '',
      p.next_milestone ?? '',
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });

  // ── Handlers ────────────────────────────────────────────

  const handleStatusChange = useCallback(async (project: Project, newStatus: string) => {
    // Optimistic update
    mutate(
      (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...p, status: newStatus } : p
          ),
        };
      },
      false
    );

    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        console.error('Status update failed:', await res.text());
      }
      mutate();
    } catch {
      mutate(); // revert on error
    }
  }, [mutate]);

  // 2026-05-03 H4 fix — DELETE used to fire-and-forget. A 404 or 500 would
  // close the confirm dialog as if it succeeded, then mutate() would
  // silently restore the row JD just "deleted." Now we check res.ok,
  // pull the server's error body, and surface it via alert() (the same
  // pattern openProjectChat uses; refine to a toast later if JD wants).
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/projects/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(body.slice(0, 200) || `HTTP ${res.status}`);
      }
      mutate();
      setDeleteTarget(null);
    } catch (err) {
      // Keep the dialog open so JD can retry. Surface the reason.
      alert(`Couldn't archive project: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setDeleteLoading(false);
    }
  }, [deleteTarget, mutate]);

  // 2026-05-03 H5 fix — reorder PATCH used to swallow errors. If the API
  // 4xx'd (auth gone, bad slugs) the user saw nothing happen and assumed
  // the click registered. Now we throw on !ok and alert + revalidate so
  // the on-screen order snaps back to the server's truth.
  const handleMoveUp = useCallback(async (project: Project) => {
    const idx = filtered.findIndex((p) => p.id === project.id);
    if (idx <= 0) return;

    // Build new order with the two swapped
    const allSlugs = projects.map((p) => p.id);
    const globalIdx = allSlugs.indexOf(project.id);
    if (globalIdx <= 0) return;

    // Swap in the slugs array
    [allSlugs[globalIdx - 1], allSlugs[globalIdx]] = [allSlugs[globalIdx], allSlugs[globalIdx - 1]];

    try {
      const res = await fetch('/api/projects/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedSlugs: allSlugs }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(body.slice(0, 200) || `HTTP ${res.status}`);
      }
      mutate();
    } catch (err) {
      alert(`Couldn't move project: ${String(err instanceof Error ? err.message : err)}`);
      mutate(); // resync UI to server truth
    }
  }, [filtered, projects, mutate]);

  const handleMoveDown = useCallback(async (project: Project) => {
    const allSlugs = projects.map((p) => p.id);
    const globalIdx = allSlugs.indexOf(project.id);
    if (globalIdx < 0 || globalIdx >= allSlugs.length - 1) return;

    [allSlugs[globalIdx], allSlugs[globalIdx + 1]] = [allSlugs[globalIdx + 1], allSlugs[globalIdx]];

    try {
      const res = await fetch('/api/projects/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedSlugs: allSlugs }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(body.slice(0, 200) || `HTTP ${res.status}`);
      }
      mutate();
    } catch (err) {
      alert(`Couldn't move project: ${String(err instanceof Error ? err.message : err)}`);
      mutate();
    }
  }, [projects, mutate]);

  return (
    <div data-testid="projects-page" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 space-y-6 relative z-10">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="flex items-center gap-4"
      >
        <div className="w-10 h-10 rounded-md flex items-center justify-center border border-hairline bg-surface-2">
          <Icon glyph={Stack} state="domain" size={20} className="text-2" />
        </div>
        <div>
          <h1 className="text-2xl font-display weight-strong tracking-tight text-1 display">
            Projects
          </h1>
          <p className="overline mt-0.5">
            Project Registry — All Initiatives
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {/* New Project button — the ONE filled accent on this screen. */}
          <button
            onClick={() => {
              setEditTarget(null);
              setFormOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-mono weight-label bg-accent text-on-accent press lift hover:bg-accent-hover focus-accent"
          >
            <Icon glyph={Plus} size={14} />
            New Project
          </button>
          <NeonBadge color="green" size="sm">{activeCount} ACTIVE</NeonBadge>
          <NeonBadge color="purple">REGISTRY</NeonBadge>
        </div>
      </motion.div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <HudStat label="Total Projects" value={String(projects.length)} icon={Layers} color="cyan" delay={0.05} />
        <HudStat label="Active"         value={String(activeCount)}     icon={Zap}    color="green" delay={0.1} />
        <HudStat label="Paused"         value={String(pausedCount)}     icon={Pause}  color="amber" delay={0.15} />
        <HudStat label="Complete"       value={String(completeCount)}   icon={CheckCircle2} color="blue" delay={0.2} />
      </div>

      {/* life-os-v1 F2 — multi-session liveness strip. Renders null when no sessions. */}
      <LiveProjectSessions />

      {/* W6 (JD 2026-05-31): the "Launch all 8 domains" button was removed —
          domains are no longer bulk-spawnable. They're the fixed 8 persistent
          chats in the chat rail (/chat), opened-or-resumed on click. Only CEO
          agents + project agents are spawnable. */}

      {/* Search + Filter Pills */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="space-y-3"
      >
        {/* Search input */}
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-3">
            <Icon glyph={MagnifyingGlass} size={16} />
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search projects by name, slug, owner, phase, or milestone..."
            className="w-full pl-10 pr-10 py-2.5 text-sm font-mono rounded-md outline-none bg-surface-1 border border-hairline text-1 placeholder:text-4 focus:border-accent-border focus-accent transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-3 press hover:bg-surface-3 hover:text-1 focus-accent"
              aria-label="Clear search"
            >
              <Icon glyph={X} size={16} />
            </button>
          )}
          {q && (
            <p className="absolute -bottom-5 left-1 text-[10px] font-mono text-3">
              <span className="tabular text-2">{filtered.length}</span>{' '}
              {filtered.length === 1 ? 'match' : 'matches'} for &ldquo;{searchQuery}&rdquo;
            </p>
          )}
        </div>

        <FilterPills
          active={filter}
          onChange={setFilter}
          counts={{
            all: projects.length,
            active: activeCount,
            paused: pausedCount,
            complete: completeCount,
            archived: archivedCount,
          }}
        />
      </motion.div>

      {/* Loading / Error States — hairline-bordered warm surfaces (no glass). */}
      {isLoading && (
        <div className="rounded-lg border border-hairline bg-surface-1 p-8 text-center">
          <p className="text-sm font-mono text-3">
            Loading project registry…
          </p>
        </div>
      )}

      {error && !isLoading && (
        <div className="rounded-lg border border-hairline bg-surface-1 p-8 text-center">
          <p className="text-sm font-mono text-state-danger-muted">
            Failed to load projects: {String(error)}
          </p>
        </div>
      )}

      {/* Project Cards Grid */}
      {!isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((project, i) => (
            <ProjectCard
              key={project.id}
              project={project}
              index={i}
              isFirst={i === 0}
              isLast={i === filtered.length - 1}
              onChat={(slug) => openProjectChat(slug)}
              chatLoading={chatLoadingSlug === project.id}
              onDoubleClick={(name) => setDetailProject(name)}
              onStatusChange={handleStatusChange}
              onEdit={(p) => {
                setEditTarget(p);
                setFormOpen(true);
              }}
              onDelete={(p) => setDeleteTarget(p)}
              onMoveUp={handleMoveUp}
              onMoveDown={handleMoveDown}
            />
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full">
              <div className="rounded-lg border border-hairline bg-surface-1 p-8 text-center">
                <p className="text-sm font-mono text-3">
                  No projects match the current filter.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* (Legacy slide-over ProjectChatPanel removed 2026-04-28 per JD —
          card click now navigates to the full-page /chat/<threadId> view,
          which gives the same Telegram-style UX as agent chats.) */}

      {/* Project Detail Modal (double-click) */}
      <ProjectDetailModal
        projectName={detailProject || ''}
        isOpen={!!detailProject}
        onClose={() => setDetailProject(null)}
      />

      {/* Create / Edit Project Modal */}
      <ProjectFormModal
        isOpen={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditTarget(null);
        }}
        onSaved={() => mutate()}
        editProject={editTarget}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="Archive Project"
        message={`Are you sure you want to archive "${deleteTarget?.name}"? This will set its status to archived. The project can be restored by changing its status back.`}
        confirmLabel="Archive"
        confirmColor="red"
        loading={deleteLoading}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
