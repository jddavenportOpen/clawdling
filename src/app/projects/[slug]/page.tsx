'use client';

// ═══════════════════════════════════════════════════════════════════════════
// /projects/[slug] — full project dossier
//
// Left (desktop) / top (mobile): tabbed README / WORKPLAN / CHANGELOG.
// Right (desktop) / bottom (mobile): attached tasks list.
// Header: name + domain badge + status badge + LINKS.md rendered as links.
// Footer: "Last updated" = max(mtime across readme/workplan/changelog/links).
//
// Markdown rendering uses the shared renderer in src/lib/markdown.ts (zero
// deps — package.json has no markdown lib).
// ═══════════════════════════════════════════════════════════════════════════

import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckSquare,
  Calendar,
  Clock,
  ArrowSquareOut,
  FileText,
  GitBranch,
  ListChecks,
  ClockCounterClockwise,
  Folder,
  User,
  Target,
} from '@phosphor-icons/react/dist/ssr';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { Icon } from '@/components/ds/Icon';
import NeonBadge from '@/components/NeonBadge';
import NewSessionButton from '@/components/projects/NewSessionButton';
import { renderMarkdown, MARKDOWN_STYLES } from '@/lib/markdown';

// ── Constants ───────────────────────────────────────────────────────────────
// Warm Graphite: the legacy cyan constants + per-domain saturated hex chips +
// per-priority hex dots are RETIRED. Status/priority ride the muted state pill
// (NeonBadge → warm-graphite tint) and the priority dot is a muted state hue
// via a semantic class — never a raw saturated hex.

const STATUS_CONFIG: Record<string, { label: string; badge: 'green' | 'amber' | 'blue' | 'cyan' | 'red' | 'purple' }> = {
  active:    { label: 'Active',    badge: 'green'  },
  planning:  { label: 'Planning',  badge: 'amber'  },
  paused:    { label: 'Paused',    badge: 'amber'  },
  complete:  { label: 'Complete',  badge: 'blue'   },
  archived:  { label: 'Archived',  badge: 'cyan'   },
  merged:    { label: 'Merged',    badge: 'purple' },
  unknown:   { label: 'Unknown',   badge: 'cyan'   },
};

// Priority → muted state pill (NeonBadge color) + a semantic dot class. The dot
// is a ~muted state hue, never a saturated neon. P2/P3 stay neutral grey so the
// one accent stays rationed and only true-urgent (P0/P1) carry a state color.
const PRIORITY_CONFIG: Record<string, { label: string; dot: string; badge: 'red' | 'amber' | 'cyan' | 'green' }> = {
  P0: { label: 'CRITICAL', dot: 'bg-state-error',     badge: 'red'   },
  P1: { label: 'HIGH',     dot: 'bg-state-attention', badge: 'amber' },
  P2: { label: 'MEDIUM',   dot: 'bg-text-3',          badge: 'cyan'  },
  P3: { label: 'LOW',      dot: 'bg-text-4',          badge: 'green' },
};

// ── Types ───────────────────────────────────────────────────────────────────

interface ProjectMeta {
  name: string;
  slug: string;
  status: string;
  phase?: string | null;
  path?: string | null;
  repo?: string | null;
  deployed_url?: string | null;
  next_milestone?: string | null;
  blockers?: string[];
  owner?: string | null;
  domain?: string | null;
  merged_into?: string | null;
  target_go_live?: string | null;
  north_star?: string | null;
}

interface Task {
  id: number;
  domain_id: string;
  project_slug: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  assignee: string;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
}

interface DossierResponse {
  project: ProjectMeta;
  markdown: {
    readme: string;
    workplan: string;
    changelog: string;
    links: string;
  };
  mtimes: Record<'readme' | 'workplan' | 'changelog' | 'links', string | null>;
  last_modified: string | null;
  tasks: Task[];
  generated_at: string;
  error?: string;
}

type TabKey = 'readme' | 'workplan' | 'changelog';

// ── Fetcher ─────────────────────────────────────────────────────────────────

const fetcher = async (url: string): Promise<DossierResponse> => {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
}

function getPriorityConfig(p: string) {
  return PRIORITY_CONFIG[p] || { label: p, dot: 'bg-text-4', badge: 'green' as const };
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '--';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return 'just now';
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function isOverdue(task: Task): boolean {
  if (!task.due_date) return false;
  if (['completed', 'cancelled', 'done'].includes(task.status)) return false;
  return new Date(task.due_date) < new Date();
}

// ── LINKS.md parser ─────────────────────────────────────────────────────────
// Extract a flat list of {label, url} from a LINKS.md file.
// Recognizes: `[text](url)` anywhere, and plain `- text: \`path\`` lines.

interface LinkItem {
  label: string;
  url: string | null;
  section: string | null;
}

function parseLinks(md: string): LinkItem[] {
  if (!md) return [];
  const items: LinkItem[] = [];
  let section: string | null = null;

  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t) continue;

    const headerMatch = t.match(/^#+\s+(.+)$/);
    if (headerMatch) {
      section = headerMatch[1].trim();
      continue;
    }

    // Markdown link inside a bullet
    const mdLink = t.match(/^[-*]\s+(?:\*\*(.+?)\*\*[:\s]*)?\[([^\]]+)\]\(([^)]+)\)/);
    if (mdLink) {
      const label = (mdLink[1] ? `${mdLink[1]}: ${mdLink[2]}` : mdLink[2]).trim();
      items.push({ label, url: mdLink[3], section });
      continue;
    }

    // Plain bullet with a backtick-quoted path
    const pathMatch = t.match(/^[-*]\s+(.+?):\s*`([^`]+)`/);
    if (pathMatch) {
      items.push({ label: pathMatch[1].trim(), url: null, section });
      continue;
    }

    // Bare URL on a bullet
    const bareUrl = t.match(/^[-*]\s+(https?:\/\/\S+)/);
    if (bareUrl) {
      items.push({ label: bareUrl[1], url: bareUrl[1], section });
      continue;
    }
  }

  return items;
}

// ── Link List ───────────────────────────────────────────────────────────────

function LinkList({ links }: { links: LinkItem[] }) {
  if (links.length === 0) {
    return (
      <p className="text-xs font-mono text-3">No links defined in LINKS.md.</p>
    );
  }

  // Group by section
  const grouped = new Map<string | null, LinkItem[]>();
  for (const l of links) {
    const k = l.section;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(l);
  }

  return (
    <div className="space-y-3">
      {Array.from(grouped.entries()).map(([section, items], gi) => (
        <div key={gi}>
          {section && (
            <p className="text-[10px] font-mono uppercase tracking-widest text-3 mb-1.5">
              {section}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {items.map((item, i) =>
              item.url ? (
                <a
                  key={i}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-mono border border-hairline text-accent-text bg-surface-2 press lift hover:bg-surface-3 hover:border-default focus-accent"
                  title={item.url}
                >
                  <Icon glyph={ArrowSquareOut} size={12} />
                  {item.label}
                </a>
              ) : (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-mono border border-hairline text-3 bg-surface-1"
                  title={item.label}
                >
                  <Icon glyph={Folder} size={12} />
                  {item.label}
                </span>
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function ProjectDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug || '';

  const { data, error, isLoading } = useSWR<DossierResponse>(
    slug ? `/api/projects/${encodeURIComponent(slug)}` : null,
    fetcher,
    { refreshInterval: 120_000 }
  );

  const [activeTab, setActiveTab] = useState<TabKey>('readme');

  // If README is empty but WORKPLAN exists, default to workplan.
  useEffect(() => {
    if (!data) return;
    if (!data.markdown.readme && data.markdown.workplan) {
      setActiveTab('workplan');
    }
  }, [data]);

  const links = useMemo(() => parseLinks(data?.markdown.links || ''), [data]);

  // ── Loading / Error ───────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="p-6 space-y-4 max-w-7xl mx-auto">
        <div className="h-8 w-64 skeleton-line" />
        <div className="h-32 skeleton-line" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 h-96 skeleton-line" />
          <div className="h-96 skeleton-line" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-7xl mx-auto space-y-4">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-sm font-mono text-3 press hover:text-1 focus-accent rounded-sm"
        >
          <Icon glyph={ArrowLeft} size={16} />
          Back to projects
        </Link>
        <div className="rounded-lg border border-hairline bg-surface-1 p-8 text-center">
          <p className="text-sm font-mono text-state-danger-muted">
            {error ? `Failed to load: ${String(error)}` : `Project "${slug}" not found`}
          </p>
        </div>
      </div>
    );
  }

  const project = data.project;
  const statusCfg = getStatusConfig(project.status);
  const tasks = data.tasks || [];

  const TABS: Array<{ key: TabKey; label: string; icon: typeof FileText; content: string }> = [
    { key: 'readme',    label: 'README',    icon: FileText,   content: data.markdown.readme    },
    { key: 'workplan',  label: 'WORKPLAN',  icon: ListChecks, content: data.markdown.workplan  },
    { key: 'changelog', label: 'CHANGELOG', icon: ClockCounterClockwise, content: data.markdown.changelog },
  ];

  const activeContent = TABS.find((t) => t.key === activeTab)?.content || '';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 space-y-6 relative z-10">
      {/* Back link */}
      <Link
        href="/projects"
        className="inline-flex items-center gap-1.5 text-sm font-mono text-3 press hover:text-1 focus-accent rounded-sm"
      >
        <Icon glyph={ArrowLeft} size={16} />
        Back to projects
      </Link>

      {/* Header — hairline-bordered warm surface (no glass). */}
      <div className="rounded-lg border border-hairline bg-surface-1 p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-4 min-w-0">
            <div className="w-10 h-10 rounded-md flex items-center justify-center border border-hairline bg-surface-2 flex-shrink-0">
              <Icon glyph={Folder} state="domain" size={20} className="text-2" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-display weight-strong tracking-tight text-1 truncate display">
                {project.name}
              </h1>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <code className="text-[10px] font-mono text-3 bg-surface-2 px-2 py-0.5 rounded-sm">
                  {project.slug}
                </code>
                {project.domain && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[10px] font-mono weight-label border border-hairline text-2 bg-surface-2 uppercase tracking-wider">
                    {project.domain}
                  </span>
                )}
                <NeonBadge color={statusCfg.badge} size="sm">
                  {statusCfg.label.toUpperCase()}
                </NeonBadge>
                {project.owner && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-3">
                    <Icon glyph={User} size={12} />
                    {project.owner}
                  </span>
                )}
              </div>
              {project.phase && (
                <p className="text-xs font-mono text-2 mt-2">{project.phase}</p>
              )}
              {project.next_milestone && (
                <p className="text-xs font-mono text-3 mt-1 flex items-start gap-1.5">
                  <span className="mt-0.5 flex-shrink-0"><Icon glyph={Target} size={12} /></span>
                  {project.next_milestone}
                </p>
              )}
            </div>
          </div>

          {/* Repo / deploy links */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <NewSessionButton projectSlug={slug} cwd={project.path || undefined} />
            {project.repo && (
              <a
                href={project.repo}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-mono border border-hairline text-2 bg-surface-2 press lift hover:bg-surface-3 hover:border-default focus-accent"
              >
                <Icon glyph={GitBranch} size={12} />
                GitHub
              </a>
            )}
            {project.deployed_url && (
              <a
                href={project.deployed_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-mono border border-hairline text-accent-text bg-surface-2 press lift hover:bg-surface-3 hover:border-default focus-accent"
              >
                <Icon glyph={ArrowSquareOut} size={12} />
                Live
              </a>
            )}
          </div>
        </div>

        {/* LINKS row */}
        {links.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border-micro">
            <LinkList links={links} />
          </div>
        )}

        {/* Last updated footer */}
        <div className="mt-4 pt-3 border-t border-border-micro flex items-center gap-2 text-[10px] font-mono text-3">
          <Icon glyph={Clock} size={12} />
          <span>Last updated: <span className="tabular">{relativeTime(data.last_modified)}</span></span>
          {project.path && (
            <>
              <span>·</span>
              <code className="bg-surface-2 px-1.5 py-0.5 rounded-sm">{project.path}</code>
            </>
          )}
        </div>
      </div>

      {/* Two-column: markdown tabs + tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: tabs — hairline-bordered warm surface. */}
        <div className="lg:col-span-2">
          <div className="rounded-lg border border-hairline bg-surface-1 overflow-hidden">
            {/* Tab pills */}
            <div className="flex gap-2 px-4 py-3 border-b border-border-micro overflow-x-auto">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.key;
                const TabGlyph = tab.icon;
                const hasContent = tab.content && tab.content.trim().length > 0;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs font-mono weight-label border press lift focus-accent flex-shrink-0 ${
                      isActive
                        ? 'bg-accent-subtle border-accent-border text-accent-text'
                        : hasContent
                          ? 'bg-transparent border-hairline text-2 hover:bg-surface-2'
                          : 'bg-transparent border-hairline text-4 hover:bg-surface-2'
                    }`}
                  >
                    <Icon glyph={TabGlyph} state={isActive ? 'active' : 'idle'} size={12} />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Content */}
            <div className="px-5 py-5 overflow-x-auto">
              {activeContent ? (
                <div
                  className="markdown-content"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(activeContent) }}
                />
              ) : (
                <div className="text-center py-12">
                  <span className="inline-block text-4"><Icon glyph={FileText} state="domain" size={40} /></span>
                  <p className="text-xs font-mono text-3 mt-3">
                    No {activeTab.toUpperCase()}.md in this project.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: tasks — hairline-bordered warm surface. */}
        <div className="lg:col-span-1">
          <div className="rounded-lg border border-hairline bg-surface-1 overflow-hidden">
            <div className="px-4 py-3 border-b border-border-micro flex items-center gap-2">
              <span className="text-2"><Icon glyph={CheckSquare} size={16} /></span>
              <span className="overline">
                Attached Tasks
              </span>
              <span className="text-xs font-mono tabular text-3 ml-auto">
                {tasks.length}
              </span>
            </div>

            {tasks.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-xs font-mono text-3">
                  No tasks attached to this project.
                </p>
                <p className="text-[10px] font-mono text-3 mt-2">
                  Add <code className="bg-surface-2 px-1 rounded-sm">project_slug: {slug}</code> to a task in
                  <br />
                  <code className="bg-surface-2 px-1 rounded-sm">&lt;state-root&gt;/domains/&lt;domain&gt;/state/tasks.yaml</code>
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border-micro max-h-[600px] overflow-y-auto">
                {tasks.map((task) => {
                  const prioCfg = getPriorityConfig(task.priority);
                  const overdue = isOverdue(task);
                  const done = ['completed', 'done', 'cancelled'].includes(task.status);
                  return (
                    <div key={task.id} className="px-4 py-3 lift hover:bg-surface-2">
                      <div className="flex items-start gap-2">
                        <div
                          className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${prioCfg.dot}`}
                          title={prioCfg.label}
                        />
                        <div className="min-w-0 flex-1">
                          <p className={`text-xs weight-label leading-snug ${done ? 'text-3 line-through' : 'text-1'}`}>
                            {task.title}
                          </p>
                          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                            <NeonBadge color={prioCfg.badge} size="sm">{task.priority}</NeonBadge>
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[9px] font-mono text-3 bg-surface-2 border border-hairline">
                              {task.status}
                            </span>
                            {task.domain_id && (
                              <span className="text-[9px] font-mono text-3">
                                {task.domain_id}
                              </span>
                            )}
                            {task.due_date && (
                              <span
                                className={`inline-flex items-center gap-1 text-[10px] font-mono tabular ${overdue ? 'text-state-danger-muted' : 'text-3'}`}
                              >
                                <Icon glyph={Calendar} size={10} />
                                {formatDate(task.due_date)}
                                {overdue && ' (overdue)'}
                              </span>
                            )}
                          </div>
                          {task.description && (
                            <p className="text-[10px] font-mono text-3 mt-1 line-clamp-2">
                              {task.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Markdown styles (shared with ProjectDetailModal) */}
      <style dangerouslySetInnerHTML={{ __html: MARKDOWN_STYLES }} />
    </div>
  );
}
