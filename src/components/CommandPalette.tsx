'use client';

import { useEffect, useState, useCallback } from 'react';
import { Command } from 'cmdk';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import {
  MessageSquare,
  Search,
  Folder,
  Inbox,
  Bot,
  Settings,
  BookOpen,
} from 'lucide-react';
import { DOMAINS } from '@/config/domains';
import agentRegistry from '@/config/agents.json';

// Flat command list for the cmdk picker — only the engine's KEEP routes plus
// the configured domains and agents. href + label + icon only (no badges).
const pages = [
  { name: 'Chat', href: '/chat', icon: MessageSquare, group: 'Navigation' },
  { name: 'Tasks', href: '/tasks', icon: Inbox, group: 'Navigation' },
  { name: 'Projects', href: '/projects', icon: Folder, group: 'Navigation' },
  { name: 'Agents', href: '/agents', icon: Bot, group: 'Navigation' },
  { name: 'Docs', href: '/docs/index', icon: BookOpen, group: 'Navigation' },
  { name: 'Settings', href: '/settings', icon: Settings, group: 'Navigation' },

  // Domains (from the configured profile)
  ...DOMAINS.map((d) => ({
    name: `${d.label} Domain`,
    href: `/chat?domain=${d.id}`,
    icon: Folder,
    group: 'Domains',
  })),
];

// Convert "Task Manager" -> "task-manager"
const nameToSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const actions = (agentRegistry as Array<{ id: string; name: string }>).map((a) => ({
  name: `Chat: ${a.name}`,
  href: `/agents/${a.id}`,
  icon: MessageSquare,
  group: 'Agents',
}));

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setOpen((o) => !o);
    }
    if (e.key === 'Escape') {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleSelect = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100]"
            onClick={() => setOpen(false)}
          />

          {/* Palette */}
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.98 }}
            transition={{
              type: 'spring',
              stiffness: 400,
              damping: 30,
            }}
            className="fixed top-[15%] left-1/2 -translate-x-1/2 w-[90vw] max-w-[560px] z-[101]"
          >
            <Command
              className="glass-panel overflow-hidden"
              label="Command palette"
              data-testid="command-palette"
            >
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border-glass">
                <Search className="w-4 h-4 text-text-muted shrink-0" />
                <Command.Input
                  placeholder="Type a command or search..."
                  className="w-full bg-transparent text-base font-mono text-text-primary placeholder:text-text-muted outline-none"
                />
                <kbd className="hidden sm:flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-text-muted bg-white/5 rounded border border-white/10">
                  ESC
                </kbd>
              </div>

              <Command.List className="max-h-[400px] overflow-y-auto p-2">
                <Command.Empty className="px-4 py-8 text-center text-sm text-text-muted font-mono">
                  No results found.
                </Command.Empty>

                {/* Render each group of routes. M7 expanded the page list
                    to 30+ entries across Navigation/Domains/System, so we
                    iterate by group rather than hardcoding two sections. */}
                {(['Navigation', 'Domains', 'System'] as const).map((groupName) => {
                  const items = pages.filter((p) => p.group === groupName);
                  if (items.length === 0) return null;
                  return (
                    <Command.Group key={groupName} heading={groupName} className="mb-2">
                      <p className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-text-muted">
                        {groupName}
                      </p>
                      {items.map((item) => {
                        const Icon = item.icon;
                        return (
                          <Command.Item
                            key={item.href}
                            value={item.name}
                            onSelect={() => handleSelect(item.href)}
                            data-testid={`palette-item-${nameToSlug(item.name)}`}
                            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-text-secondary cursor-pointer data-[selected=true]:bg-neon-cyan/8 data-[selected=true]:text-neon-cyan transition-colors"
                          >
                            <Icon className="w-4 h-4" />
                            <span className="font-medium">{item.name}</span>
                          </Command.Item>
                        );
                      })}
                    </Command.Group>
                  );
                })}

                <Command.Group heading="Agents" className="mb-2">
                  <p className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-text-muted">
                    Agents
                  </p>
                  {actions.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Command.Item
                        key={item.href}
                        value={item.name}
                        onSelect={() => handleSelect(item.href)}
                        data-testid={`palette-item-${nameToSlug(item.name)}`}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-text-secondary cursor-pointer data-[selected=true]:bg-neon-cyan/8 data-[selected=true]:text-neon-cyan transition-colors"
                      >
                        <Icon className="w-4 h-4" />
                        <span className="font-medium">{item.name}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              </Command.List>

              <div className="px-4 py-2.5 border-t border-border-glass flex items-center justify-between">
                <span className="text-[10px] font-mono text-text-muted">
                  Navigate with <kbd className="px-1 py-0.5 bg-white/5 rounded text-[9px] border border-white/10">&#8593;&#8595;</kbd> then <kbd className="px-1 py-0.5 bg-white/5 rounded text-[9px] border border-white/10">Enter</kbd>
                </span>
                <span className="text-[10px] font-mono text-text-muted">
                  <kbd className="px-1 py-0.5 bg-white/5 rounded text-[9px] border border-white/10">&#8984;K</kbd> to toggle
                </span>
              </div>
            </Command>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
