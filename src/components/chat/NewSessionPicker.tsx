'use client';

// ═══════════════════════════════════════════════════════════════════════════
// NewSessionPicker — the ONE "new session" entry point (cockpit overhaul 2026-05-26).
//
// Replaces the six scattered spawn affordances (+Code / +New / +New Claude /
// +New Claude Session / per-domain "Spawn agent" / "Launch all") with a single
// command-palette + gallery. The session TYPE (ad-hoc / domain / specialist /
// project / launch-all) is a ROW inside this picker, never a separate top-level
// button — the model every leading product (Cursor, Devin, Factory, agent-deck,
// Herdr) converged on. (see docs/ARCHITECTURE.md)
//
// Engines reused (unchanged backends):
//   - ad-hoc / project → POST /api/sessions/cockpit-spawn { cwd?, initial_prompt? }
//   - domain           → POST /api/sessions/spawn-domain  { domain, initial_prompt? }
//   - launch-all       → one spawn-domain per domain, in parallel
//   - specialist       → opens its /agents/<id> chat (unified into cockpit in a later PR)
//
// On a cockpit spawn it calls onLaunched(sessionId, threadId, cwd); the parent
// (ChatGrid) adds the pane + updates ?panes=. A `scopeDomain` prop pre-filters
// to one domain (used when opening the picker from a domain dashboard / Space).
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DOMAINS } from '@/config/domains';
import agentRegistry from '@/config/agents.json';
// ── Warm Graphite foundation (REUSED — never redefined here) ────────────────
// Icon's `state` encodes Phosphor weight (regular idle → fill active → duotone
// domain). agentGlyph/domainGlyph resolve the bespoke per-agent / per-domain
// glyph — these REPLACE the Unicode-emoji "AI clipart" the tiles used to carry.
// The few non-agent rows (ad-hoc / project / launch-all) get their own Phosphor
// glyph below. ZERO emoji survive in this surface.
import { Icon } from '@/components/ds/Icon';
import { StatusGlyph } from '@/components/ds/StatusGlyph';
import { agentGlyph, domainGlyph } from '@/components/ds/glyphMap';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import {
  MagnifyingGlass,
  X as XGlyph,
  Sparkle,
  FolderSimple,
  Lightning,
  KeyReturn,
} from '@phosphor-icons/react/dist/ssr';

interface AgentDef {
  id: string;
  name: string;
  icon: string;
  description: string;
}

const SPECIALISTS = (agentRegistry as AgentDef[]).filter((a) => a.id !== 'assistant');
const DEFAULT_CWD = '.';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired after a cockpit session spawns; parent adds the pane + updates URL. */
  onLaunched: (sessionId: string, threadId: string, cwd: string) => void;
  hasOpenPanes?: boolean;
  /** Pre-scope to a single domain (opened from a domain dashboard / Space). */
  scopeDomain?: string | null;
  /** W6 (JD 2026-05-31): when 'projects', the picker offers ONLY project
      agents — Domains / Specialists / Ad-hoc / Launch-all rows are dropped.
      The locked model makes domains the fixed 8 (not spawnable) and ad-hoc CEO
      its own header button; the picker's sole job becomes "pick a project."

      W8 (JD 2026-05-31, root-cause): the default is now the RESTRICTED
      'projects', NOT 'all'. The legacy 'all' default re-opened the spawn-lock
      leak at every call-site that forgot the prop (W6 fixed the rail, W7 the 2
      ChatGrid pickers, then NewSessionCta was found unlocked). The locked model
      says the ONLY spawnable agents are CEO + projects, so 'projects' is the
      correct default and a forgotten prop can no longer re-expose the leak. A
      caller wanting the full legacy picker must OPT IN explicitly with
      mode="all". (see docs/ARCHITECTURE.md) */
  mode?: 'all' | 'projects';
}

interface Row {
  key: string;
  /** Bespoke vector glyph (Phosphor) — never an emoji. */
  glyph: PhosphorIcon;
  /** Icon weight semantics: 'idle' (regular) → 'domain' (duotone, premium). */
  iconState?: 'idle' | 'active' | 'domain';
  /** Per-glyph tint token (a muted, warm-leaning accent — never a saturated chip). */
  tint?: string;
  label: string;
  sub: string;
  keywords: string;
  /** The ONE hero row that carries the filled clay-amber accent (quick-start). */
  accent?: boolean;
  run: () => Promise<void> | void;
  group: 'Quick' | 'Domains' | 'Specialists' | 'Projects' | 'Power';
}

interface SpawnResp {
  session_id?: string;
  thread_id?: string;
  cwd?: string;
  error?: string;
}

export default function NewSessionPicker({
  open,
  onClose,
  onLaunched,
  scopeDomain = null,
  mode = 'projects',
}: Props) {
  const projectsOnly = mode === 'projects';
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setError(null);
    setBusy(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Recent project cwds for the Projects section (best-effort).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sessions/recent-cwds?limit=8', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { cwds?: string[] };
        if (!cancelled && Array.isArray(data.cwds)) setRecentCwds(data.cwds);
      } catch {
        /* fine — section just shows the default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const spawnCockpit = useCallback(
    async (label: string, body: Record<string, unknown>) => {
      setBusy(label);
      setError(null);
      try {
        const res = await fetch('/api/sessions/cockpit-spawn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as SpawnResp;
        if (!res.ok || !data.session_id || !data.thread_id) {
          setError(data.error || `Spawn failed (HTTP ${res.status})`);
          setBusy(null);
          return;
        }
        onLaunched(data.session_id, data.thread_id, data.cwd || (body.cwd as string) || '');
        onClose();
      } catch (err) {
        setError(`Network error: ${String(err)}`);
        setBusy(null);
      }
    },
    [onLaunched, onClose]
  );

  const spawnDomain = useCallback(
    async (domainId: string, label: string) => {
      setBusy(label);
      setError(null);
      try {
        const res = await fetch('/api/sessions/spawn-domain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // persistent:true — a domain spawn creates (or REUSES, MA-4) that
          // domain's ONE long-lived continuity brain, not a disposable worker.
          // This is the locked model (PRD §10): 1 persistent brain per domain.
          body: JSON.stringify({ domain: domainId, persistent: true }),
        });
        const data = (await res.json()) as SpawnResp;
        if (!res.ok || !data.session_id || !data.thread_id) {
          setError(data.error || `Spawn failed (HTTP ${res.status})`);
          setBusy(null);
          return;
        }
        onLaunched(data.session_id, data.thread_id, data.cwd || '');
        onClose();
      } catch (err) {
        setError(`Network error: ${String(err)}`);
        setBusy(null);
      }
    },
    [onLaunched, onClose]
  );

  const launchAll = useCallback(async () => {
    setBusy('launch-all');
    setError(null);
    const sids: string[] = [];
    await Promise.all(
      DOMAINS.map(async (d) => {
        try {
          const res = await fetch('/api/sessions/spawn-domain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Launch-all spawns the 8 domain continuity brains (persistent),
            // not 8 throwaway sessions. Idempotent: re-running reuses existing.
            body: JSON.stringify({ domain: d.id, persistent: true }),
          });
          const data = (await res.json()) as SpawnResp;
          if (res.ok && data.session_id) sids.push(data.session_id);
        } catch {
          /* skip the ones that fail; we open whatever launched */
        }
      })
    );
    if (sids.length === 0) {
      setError('Launch-all failed — no domains spawned');
      setBusy(null);
      return;
    }
    onClose();
    router.push(`/chat?panes=${sids.map(encodeURIComponent).join(',')}`);
  }, [router, onClose]);

  // ── Build the row set ──────────────────────────────────────────────────────
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];

    // W6 projects-only mode (the rail's "+ Project agent" button): the ONLY
    // rows are recent projects + a "browse a fresh project path" ad-hoc into a
    // project cwd. Domains (fixed 8), specialists, launch-all, and the bare
    // ad-hoc CEO row are intentionally dropped — they're not project agents.
    if (projectsOnly) {
      for (const cwd of recentCwds) {
        const base = cwd.replace(/\/+$/, '').split('/').pop() || cwd;
        out.push({
          key: `proj-${cwd}`,
          glyph: FolderSimple,
          iconState: 'domain',
          tint: 'var(--text-2)',
          label: base,
          sub: cwd,
          keywords: `project ${cwd} ${base}`,
          group: 'Projects',
          run: () => spawnCockpit(`proj-${cwd}`, { cwd }),
        });
      }
      return out;
    }

    // The ONE accent row: a fresh CEO/ad-hoc session is the highest-intent
    // quick-start, so it carries the single filled clay-amber affordance.
    out.push({
      key: 'adhoc',
      glyph: agentGlyph('assistant').glyph,
      iconState: 'active',
      label: 'Ad-hoc session',
      sub: 'Fresh session, no scope',
      keywords: 'adhoc assistant blank new session',
      accent: true,
      group: 'Quick',
      run: () => spawnCockpit('adhoc', { cwd: DEFAULT_CWD }),
    });

    const domainList = scopeDomain ? DOMAINS.filter((d) => d.id === scopeDomain) : DOMAINS;
    for (const d of domainList) {
      const g = domainGlyph(d.id); // per-domain DUOTONE glyph + warm tint
      out.push({
        key: `domain-${d.id}`,
        glyph: g.glyph,
        iconState: 'domain',
        tint: g.tint,
        label: d.label,
        sub: d.blurb,
        keywords: `domain ${d.id} ${d.label} ${d.blurb}`,
        group: 'Domains',
        run: () => spawnDomain(d.id, `domain-${d.id}`),
      });
    }

    for (const s of SPECIALISTS) {
      const g = agentGlyph(s.id); // per-agent role glyph (regular idle)
      out.push({
        key: `spec-${s.id}`,
        glyph: g.glyph,
        iconState: 'idle',
        tint: 'var(--text-2)',
        label: s.name,
        sub: s.description,
        keywords: `specialist agent ${s.id} ${s.name} ${s.description}`,
        group: 'Specialists',
        run: () => {
          onClose();
          router.push(`/agents/${s.id}`);
        },
      });
    }

    for (const cwd of recentCwds) {
      const base = cwd.replace(/\/+$/, '').split('/').pop() || cwd;
      out.push({
        key: `proj-${cwd}`,
        glyph: FolderSimple,
        iconState: 'domain',
        tint: 'var(--text-2)',
        label: base,
        sub: cwd,
        keywords: `project ${cwd} ${base}`,
        group: 'Projects',
        run: () => spawnCockpit(`proj-${cwd}`, { cwd }),
      });
    }

    if (!scopeDomain) {
      out.push({
        key: 'launch-all',
        glyph: Lightning,
        iconState: 'active',
        tint: 'var(--state-working)',
        label: `Launch all ${DOMAINS.length} domains`,
        sub: `Spawns one scoped session per domain (${DOMAINS.length} at once)`,
        keywords: 'launch all domains everything attack power',
        group: 'Power',
        run: launchAll,
      });
    }
    return out;
  }, [recentCwds, scopeDomain, projectsOnly, spawnCockpit, spawnDomain, launchAll, router, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => (r.label + ' ' + r.keywords).toLowerCase().includes(q));
  }, [rows, query]);

  // Esc closes; Enter runs the first filtered row.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && filtered.length > 0 && !busy) {
        e.preventDefault();
        void filtered[0].run();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, busy, onClose]);

  if (!open) return null;

  const groupsOrder: Row['group'][] = ['Quick', 'Domains', 'Specialists', 'Projects', 'Power'];
  const groupLabels: Record<Row['group'], string> = {
    Quick: 'Quick start',
    Domains: scopeDomain ? 'This domain' : 'Domains',
    Specialists: 'Specialists',
    Projects: 'Recent projects',
    Power: 'Power',
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center bg-[var(--bg-overlay)] backdrop-blur-sm p-4 pt-[10vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* The picker is a true overlay → shadow is sanctioned here (the only place
          elevation reads as a shadow, not a lighter surface). surface-2 modal on
          a hairline edge; radii 12 (lg). No card-in-card — rows sit directly on
          the modal, separated by space + a single accent on the hero row. */}
      <div
        className="w-full max-w-xl rounded-[var(--radius-lg)] border border-border-default bg-surface-2 overflow-hidden flex flex-col max-h-[75vh]"
        style={{ boxShadow: 'var(--shadow-modal)' }}
      >
        {/* Search header — mono glass-search prefix, Geist input, 540 esc chip. */}
        <div className="px-4 py-3 border-b border-hairline flex items-center gap-2.5">
          <Icon glyph={MagnifyingGlass} state="idle" size={15} className="text-3 shrink-0" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={projectsOnly ? 'New project agent — search projects…' : 'New session — search domains, specialists, projects…'}
            className="flex-1 bg-transparent text-sm text-1 placeholder:text-4 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-3 hover:text-1 hover:bg-surface-3 active:scale-[0.97] transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out-strong)]"
            aria-label="Close"
          >
            <Icon glyph={XGlyph} state="idle" size={14} weight="bold" aria-hidden />
          </button>
        </div>

        {/* Error — the muted error TINT (14%-alpha pill fill), state-error text;
            never a saturated red card. */}
        {error && (
          <div className="px-4 py-2 text-[11px] border-b border-hairline bg-tint-error text-state-error">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-1.5" data-testid="new-session-picker">
          {filtered.length === 0 && (
            <div className="px-4 py-7 text-center text-xs text-3">No matches.</div>
          )}
          {groupsOrder.map((g) => {
            const items = filtered.filter((r) => r.group === g);
            if (items.length === 0) return null;
            return (
              <div key={g} className="px-1.5 pt-1.5 pb-0.5">
                {/* mono-uppercase eyebrow group header — "real product" metadata. */}
                <div className="px-2.5 pb-1 text-[10px] weight-label uppercase tracking-[0.08em] font-mono text-3">
                  {groupLabels[g]}
                </div>
                {items.map((r) => {
                  const isBusy = busy === r.key || (busy === 'launch-all' && r.key === 'launch-all');
                  return (
                    <button
                      key={r.key}
                      type="button"
                      disabled={!!busy}
                      onClick={() => void r.run()}
                      data-testid={`picker-row-${r.key}`}
                      className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-left transition-[background-color,color] duration-[var(--dur-micro)] ease-[var(--ease-out-strong)] active:scale-[0.99] disabled:opacity-50 ${
                        r.accent
                          ? 'bg-accent-subtle hover:bg-surface-3'
                          : 'hover:bg-surface-3'
                      }`}
                    >
                      {/* Glyph slot — bespoke vector (no emoji). Busy → the live
                          working glyph (the StatusGlyph language), tinted warm. */}
                      <span
                        className="shrink-0 w-6 h-6 inline-flex items-center justify-center"
                        style={r.tint && !isBusy ? { color: r.tint } : undefined}
                      >
                        {isBusy ? (
                          <StatusGlyph state="working" size={16} />
                        ) : (
                          <Icon glyph={r.glyph} state={r.iconState ?? 'idle'} size={17} aria-hidden />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="block text-sm weight-label text-1 truncate">{r.label}</span>
                          {r.accent && (
                            <span className="text-[9px] font-mono uppercase tracking-wider text-accent-text shrink-0">
                              start
                            </span>
                          )}
                        </span>
                        {/* Project cwds / paths read as telemetry → mono tabular. */}
                        <span
                          className={`block text-[11px] text-3 truncate ${
                            r.group === 'Projects' ? 'font-mono tabular' : ''
                          }`}
                        >
                          {r.sub}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer — mono telemetry; the ↵ key hint carries a real glyph. */}
        <div className="px-4 py-2 border-t border-hairline text-[10px] text-3 font-mono tabular flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5">
            <Icon glyph={KeyReturn} state="idle" size={12} className="text-3" aria-hidden />
            launch first · esc close
          </span>
          <span className="inline-flex items-center gap-1.5 text-3">
            <Icon glyph={Sparkle} state="domain" size={11} aria-hidden />
            one entry for every agent
          </span>
        </div>
      </div>
    </div>
  );
}
