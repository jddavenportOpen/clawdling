'use client';

import { motion } from 'framer-motion';
import {
  ExternalLink,
  GitBranch,
  GitCommit,
  AlertTriangle,
  CircleDot,
  User,
  Target,
  CheckCircle2,
  Pause,
  Zap,
  Archive,
  Clock,
  MessageCircle,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  FileText,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import GlassPanel from '@/components/GlassPanel';
import NeonBadge from '@/components/NeonBadge';

// ── Constants ─────────────────────────────────────────────────────────────────

const CYAN = '#00FFE0';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GitHubData {
  last_push: string | null;
  commits_30d: number;
  open_issues: number;
  open_prs: number;
  default_branch: string;
}

export interface Project {
  id: string;
  name: string;
  status: string;
  phase: string | null;
  repo: string | null;
  deployed_url: string | null;
  prd: string | null;
  workplan: string | null;
  next_milestone: string | null;
  blockers: string[];
  owner: string | null;
  order: number;
  github: GitHubData | null;
  // NEW from project-status-sync
  progress?: { pct: number; done: number; total: number; no_workplan?: boolean } | null;
  last_ship?: { at: string; title: string } | null;
  recent_ships?: { at: string; title: string }[];
  stalled?: boolean;
  stalled_days?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export const STATUS_CONFIG: Record<string, { label: string; badgeColor: 'green' | 'amber' | 'blue' | 'cyan' | 'red' | 'purple'; icon: typeof Zap }> = {
  active:   { label: 'Active',   badgeColor: 'green', icon: Zap },
  planning: { label: 'Planning', badgeColor: 'amber', icon: Pause },
  paused:   { label: 'Paused',   badgeColor: 'amber', icon: Pause },
  complete: { label: 'Complete', badgeColor: 'blue',  icon: CheckCircle2 },
  archived: { label: 'Archived', badgeColor: 'cyan',  icon: Archive },
};

export const STATUS_CYCLE: string[] = ['active', 'paused', 'complete', 'archived'];

export function parsePhaseProgress(phase: string | null): { current: number; total: number } | null {
  if (!phase) return null;
  const slashMatch = phase.match(/Phase\s+(\d+)\s*\/\s*(\d+)/i);
  if (slashMatch) return { current: parseInt(slashMatch[1]), total: parseInt(slashMatch[2]) };
  const simpleMatch = phase.match(/Phase\s+(\d+)/i);
  if (simpleMatch) return { current: parseInt(simpleMatch[1]), total: 4 };
  return null;
}

export function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  return `${diffMonth}mo ago`;
}

export function normalizeUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `https://${url}`;
}

// ── Project Card ──────────────────────────────────────────────────────────────

function ProjectCard({
  project,
  index,
  isFirst,
  isLast,
  onChat,
  chatLoading,
  onDoubleClick,
  onStatusChange,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  project: Project;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  // 2026-05-03 L4 fix — `name` arg was declared but parent ignores it.
  // Dropped to keep the type honest. ProjectsPage uses `slug` to look up
  // the project's existing thread before navigating; name comes from the
  // server's response, not the call site.
  onChat: (slug: string) => void;
  chatLoading?: boolean;
  onDoubleClick: (name: string) => void;
  onStatusChange: (project: Project, newStatus: string) => void;
  onEdit: (project: Project) => void;
  onDelete: (project: Project) => void;
  onMoveUp: (project: Project) => void;
  onMoveDown: (project: Project) => void;
}) {
  const config = STATUS_CONFIG[project.status] || STATUS_CONFIG.active;
  // Prefer real progress (from project-status-sync) over the legacy phase string.
  const realProgress = project.progress && !project.progress.no_workplan && project.progress.total > 0
    ? { current: project.progress.done, total: project.progress.total, pct: project.progress.pct }
    : null;
  const legacyProgress = parsePhaseProgress(project.phase);
  const progress = realProgress || legacyProgress;
  // Humanize "time ago" for last_ship
  const lastShipAgo = (() => {
    if (!project.last_ship?.at) return null;
    try {
      const then = new Date(project.last_ship.at).getTime();
      const now = Date.now();
      const mins = Math.floor((now - then) / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return null;
    }
  })();
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!statusDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setStatusDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [statusDropdownOpen]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        type: 'spring',
        stiffness: 300,
        damping: 30,
        delay: 0.05 * index,
      }}
      onDoubleClick={() => onDoubleClick(project.name)}
      style={{ cursor: 'pointer' }}
      data-testid="project-card"
      data-status={project.status}
    >
      <GlassPanel className="p-5 h-full flex flex-col group" animate={false}>
        {/* Header: Name + Status */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="text-sm font-semibold text-text-primary leading-snug">
            {project.name}
          </h3>
          <div ref={dropdownRef} className="relative flex items-center gap-1.5">
            {/* Status badge — click to open dropdown */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setStatusDropdownOpen(!statusDropdownOpen);
              }}
              title="Click to change status"
              data-testid="project-status-select"
            >
              <NeonBadge color={config.badgeColor} size="sm">
                {config.label.toUpperCase()}
              </NeonBadge>
            </button>
            {/* Status dropdown */}
            {statusDropdownOpen && (
              <div
                className="absolute top-full right-0 mt-1 z-50 rounded-lg border py-1 min-w-[140px]"
                style={{
                  backgroundColor: 'rgba(18, 18, 40, 0.95)',
                  borderColor: 'rgba(255,255,255,0.1)',
                  backdropFilter: 'blur(12px)',
                }}
              >
                {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                  <button
                    key={key}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (key !== project.status) {
                        onStatusChange(project, key);
                      }
                      setStatusDropdownOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono transition-colors hover:bg-white/[0.06]"
                    style={{
                      color: key === project.status ? CYAN : 'var(--text-muted)',
                    }}
                  >
                    <cfg.icon className="w-3 h-3" />
                    {cfg.label}
                    {key === project.status && (
                      <span className="ml-auto text-[10px]" style={{ color: CYAN }}>●</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Progress Bar — real checkbox %, falls back to legacy phase string */}
        {progress && (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] font-mono text-text-secondary">
                {realProgress
                  ? `${realProgress.current} of ${realProgress.total} milestones (${realProgress.pct}%)`
                  : project.phase}
              </p>
              {project.stalled && (
                <span
                  className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
                  style={{
                    color: '#FF6B6B',
                    backgroundColor: 'rgba(255, 107, 107, 0.15)',
                    border: '1px solid rgba(255, 107, 107, 0.4)',
                  }}
                  title={`${project.stalled_days ?? 0}d since last ship`}
                >
                  STALLED {project.stalled_days ?? 0}d
                </span>
              )}
            </div>
            <div className="w-full h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <motion.div
                className="h-full rounded-full"
                style={{ backgroundColor: CYAN }}
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(0, Math.min(100, (progress.current / progress.total) * 100))}%` }}
                transition={{ duration: 0.8, ease: 'easeOut', delay: 0.1 * index }}
              />
            </div>
            {lastShipAgo && project.last_ship && (
              <p className="text-[10px] font-mono text-text-muted mt-1.5 truncate" title={project.last_ship.title}>
                Last ship: {lastShipAgo} — {project.last_ship.title}
              </p>
            )}
          </div>
        )}

        {/* Next Milestone */}
        {project.next_milestone && (
          <div className="flex items-start gap-2 mb-3">
            <Target className="w-3.5 h-3.5 text-text-muted flex-shrink-0 mt-0.5" />
            <p className="text-[11px] font-mono text-text-muted leading-snug">
              {project.next_milestone}
            </p>
          </div>
        )}

        {/* Blockers */}
        {project.blockers.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {project.blockers.map((blocker, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-neon-red/10 text-neon-red border border-neon-red/20"
              >
                <AlertTriangle className="w-2.5 h-2.5" />
                {blocker}
              </span>
            ))}
          </div>
        )}

        {/* GitHub Stats */}
        {project.github && (
          <div className="flex flex-wrap items-center gap-3 mb-3 text-[10px] font-mono text-text-muted">
            {project.github.last_push && (
              <span className="inline-flex items-center gap-1" title={`Last push: ${project.github.last_push}`}>
                <Clock className="w-3 h-3" />
                {relativeTime(project.github.last_push)}
              </span>
            )}
            {project.github.commits_30d > 0 && (
              <span className="inline-flex items-center gap-1" title={`${project.github.commits_30d} commits in last 30 days`}>
                <GitCommit className="w-3 h-3" />
                {project.github.commits_30d}
              </span>
            )}
            {project.github.open_issues > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-400" title={`${project.github.open_issues} open issues`}>
                <CircleDot className="w-3 h-3" />
                {project.github.open_issues}
              </span>
            )}
            {project.github.open_prs > 0 && (
              <span className="inline-flex items-center gap-1 text-purple-400" title={`${project.github.open_prs} open PRs`}>
                <GitBranch className="w-3 h-3" />
                {project.github.open_prs} PR{project.github.open_prs > 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}

        {/* PRD / Workplan Links */}
        {(project.prd || project.workplan) && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {project.prd && (
              <button
                onClick={(e) => { e.stopPropagation(); onDoubleClick(project.name); }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium border border-neon-cyan/20 text-neon-cyan/70 hover:text-neon-cyan hover:border-neon-cyan/40 transition-colors bg-neon-cyan/[0.05]"
                title={project.prd}
              >
                <FileText className="w-2.5 h-2.5" />
                PRD
              </button>
            )}
            {project.workplan && (
              <button
                onClick={(e) => { e.stopPropagation(); onDoubleClick(project.name); }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium border border-purple-400/20 text-purple-400/70 hover:text-purple-400 hover:border-purple-400/40 transition-colors bg-purple-400/[0.05]"
                title={project.workplan}
              >
                <FileText className="w-2.5 h-2.5" />
                Workplan
              </button>
            )}
          </div>
        )}

        {/* Footer: Owner + Links + Actions */}
        <div className="mt-auto pt-3 border-t border-white/[0.04] flex items-center justify-between">
          {project.owner && (
            <div className="flex items-center gap-1.5">
              <User className="w-3 h-3 text-text-muted" />
              <span className="text-[10px] font-mono text-text-muted">
                {project.owner}
              </span>
            </div>
          )}

          <div className="flex items-center gap-1 ml-auto">
            {/* Reorder arrows — visible on hover */}
            <div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={(e) => { e.stopPropagation(); onMoveUp(project); }}
                disabled={isFirst}
                className="p-0.5 rounded hover:bg-white/[0.06] transition-colors disabled:opacity-20"
                title="Move up"
              >
                <ChevronUp className="w-3 h-3 text-text-muted" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onMoveDown(project); }}
                disabled={isLast}
                className="p-0.5 rounded hover:bg-white/[0.06] transition-colors disabled:opacity-20"
                title="Move down"
              >
                <ChevronDown className="w-3 h-3 text-text-muted" />
              </button>
            </div>

            {/* Edit */}
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(project); }}
              className="p-1.5 rounded-md hover:bg-white/[0.06] transition-colors opacity-0 group-hover:opacity-100"
              title="Edit project"
              data-testid="project-edit-btn"
            >
              <Pencil className="w-3 h-3 text-text-muted" />
            </button>

            {/* Delete / Archive */}
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(project); }}
              className="p-1.5 rounded-md hover:bg-neon-red/10 transition-colors opacity-0 group-hover:opacity-100"
              title="Archive project"
              data-testid="project-delete-btn"
            >
              <Trash2 className="w-3 h-3 text-neon-red/70" />
            </button>

            {/* Chat */}
            <button
              onClick={(e) => { e.stopPropagation(); onChat(project.id); }}
              disabled={chatLoading}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono font-medium hover:bg-white/[0.06] transition-colors border border-white/[0.06] disabled:opacity-60"
              style={{ color: CYAN }}
              title={`Chat about ${project.name}`}
              data-testid="project-chat-btn"
            >
              <MessageCircle className="w-3 h-3" />
              {chatLoading ? 'Opening…' : 'Chat'}
            </button>

            {/* GitHub */}
            {project.repo && (
              <a
                href={normalizeUrl(project.repo)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono font-medium hover:bg-white/[0.06] transition-colors border border-white/[0.06]"
                style={{ color: CYAN }}
                title="Repository"
                onClick={(e) => e.stopPropagation()}
              >
                <GitBranch className="w-3 h-3" />
                GitHub
              </a>
            )}

            {/* Live */}
            {project.deployed_url && (
              <a
                href={normalizeUrl(project.deployed_url)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono font-medium hover:bg-white/[0.06] transition-colors border border-white/[0.06]"
                style={{ color: '#A78BFA' }}
                title="Live Site"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
                Live
              </a>
            )}
          </div>
        </div>
      </GlassPanel>
    </motion.div>
  );
}

export default ProjectCard;
