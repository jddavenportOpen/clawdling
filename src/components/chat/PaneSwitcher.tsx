'use client';

// ═══════════════════════════════════════════════════════════════════════════
// PaneSwitcher — Cmd+K (Ctrl+K on Linux/Windows) quick-jump palette for
// Chat Cockpit. Lists every open pane in the grid with title + sid hint;
// arrow keys navigate, Enter activates the focus.
//
// Activation:
//   - Hotkey is owned by ChatGrid (it knows when grid mode is active).
//     ChatGrid passes `open` and `onClose` here.
//   - On Linux/Windows the OS Ctrl+K conflicts with the address-bar
//     focus shortcut in some browsers — ChatGrid has a fallback to
//     Cmd+J (or Ctrl+J) which we accept too. (Implemented in ChatGrid.)
//
// Behavior:
//   - Filter input narrows by case-insensitive substring match against
//     `title` first, then `sid`.
//   - Up/Down navigate; Enter selects; Esc closes.
//   - Click row to select.
//
// (see docs/ARCHITECTURE.md)
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';

export interface PanePalette {
  sid: string;
  title: string;
  status: string;
}

interface Props {
  open: boolean;
  panes: PanePalette[];
  /** Currently active sid (highlighted in the list). */
  activeSid: string | null;
  onClose: () => void;
  onSelect: (sid: string) => void;
}

export default function PaneSwitcher({
  open,
  panes,
  activeSid,
  onClose,
  onSelect,
}: Props) {
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset query + highlight when opened.
  useEffect(() => {
    if (open) {
      setQuery('');
      // Default highlight = active pane if present, else 0.
      const idx = activeSid
        ? Math.max(
            0,
            panes.findIndex((p) => p.sid === activeSid)
          )
        : 0;
      setHighlightIndex(idx);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, activeSid, panes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return panes;
    return panes.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.sid.toLowerCase().includes(q)
    );
  }, [panes, query]);

  // Keep highlight in bounds when filter changes.
  useEffect(() => {
    if (highlightIndex >= filtered.length) {
      setHighlightIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, highlightIndex]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) =>
        Math.min(i + 1, Math.max(0, filtered.length - 1))
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[highlightIndex];
      if (target) {
        onSelect(target.sid);
        onClose();
      }
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[210] flex items-start justify-center bg-black/50 backdrop-blur-sm pt-[10vh] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl overflow-hidden">
        <div className="px-3 py-2 border-b border-neutral-800">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Switch to pane…"
            className="w-full bg-transparent border-0 outline-none text-sm text-neutral-100 placeholder-neutral-500 font-mono"
          />
        </div>

        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <li className="px-4 py-3 text-xs text-neutral-500 text-center">
              No matching panes
            </li>
          )}
          {filtered.map((p, i) => {
            const highlighted = i === highlightIndex;
            const isActive = p.sid === activeSid;
            const statusColor =
              p.status === 'live'
                ? 'bg-emerald-400'
                : p.status === 'starting'
                ? 'bg-amber-400 animate-pulse'
                : p.status === 'exited'
                ? 'bg-neutral-500'
                : 'bg-red-500';
            return (
              <li key={p.sid}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlightIndex(i)}
                  onClick={() => {
                    onSelect(p.sid);
                    onClose();
                  }}
                  className={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 ${
                    highlighted
                      ? 'bg-cyan-700/20 text-cyan-100'
                      : 'text-neutral-300 hover:bg-neutral-900'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className={`shrink-0 inline-block w-2 h-2 rounded-full ${statusColor}`}
                      aria-hidden
                    />
                    <span className="truncate text-sm font-mono">{p.title}</span>
                    {isActive && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-cyan-300/70 px-1.5 py-0.5 rounded border border-cyan-700/40">
                        active
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[10px] text-neutral-500 font-mono">
                    {p.sid.slice(0, 8)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <footer className="px-3 py-2 border-t border-neutral-800 flex items-center justify-between text-[10px] text-neutral-500 font-mono">
          <span>↑↓ navigate · ↵ select · Esc close</span>
          <span>{filtered.length}/{panes.length}</span>
        </footer>
      </div>
    </div>
  );
}
