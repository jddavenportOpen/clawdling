'use client';

// ═══════════════════════════════════════════════════════════════════════════
// /docs/[...slug] — render the project's markdown docs from the `docs/` dir.
//
// Routing:
//   /docs                    → directory listing of docs/
//   /docs/ARCHITECTURE       → renders docs/ARCHITECTURE.md
// ═══════════════════════════════════════════════════════════════════════════

import { use } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Folder, CaretRight, Clock } from '@phosphor-icons/react/dist/ssr';
import { Icon } from '@/components/ds';
import { timeAgo } from '@/lib/utils';

// Warm-Graphite page-level surface: a hairline-bordered warm panel (surface-1)
// with the tight 12px radius — elevation is luminance + hairline, never the
// legacy blur-glass + neon-glow box-shadow. Replaces the legacy GlassPanel at the page
// level so the docs reader matches the /chat surface look.
function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-hairline bg-surface-1 ${className}`}>
      {children}
    </div>
  );
}

interface DirEntry {
  slug: string;
  name: string;
  kind: 'file' | 'dir';
}

interface DocResponse {
  kind: 'file' | 'dir';
  slug: string[];
  title: string;
  content?: string;
  entries?: DirEntry[];
  mtime?: string;
}

const fetcher = async (url: string): Promise<DocResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'unknown' }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
};

// Markdown renderer — wider/taller than chat-bubble defaults since this
// is a documentation context (the same react-markdown stack as
// MarkdownBubble, but with reading-page typography).
const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-2xl weight-strong text-1 mt-6 mb-3 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xl weight-strong text-1 mt-5 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-lg weight-label text-1 mt-4 mb-2 first:mt-0">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="leading-relaxed text-sm text-2 my-2">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-2 space-y-1 text-sm text-2 marker:text-3">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-2 space-y-1 text-sm text-2 marker:text-3">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent-text hover:underline"
    >
      {children}
    </a>
  ),
  // Inline code vs fenced — react-markdown 10 calls this for both. The
  // wrapping <pre> handler below renders fenced blocks.
  code: ({ className, children, ...rest }) => {
    const match = /language-(\w+)/.exec(className || '');
    if (!match) {
      return (
        <code
          className="px-1.5 py-0.5 rounded bg-sunken border border-hairline text-[12px] font-mono text-1"
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-3 p-3 rounded-lg bg-sunken border border-hairline overflow-x-auto text-[12px] font-mono text-2">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 pl-3 border-l-2 border-border-default text-3 italic">
      {children}
    </blockquote>
  ),
  // Tables — remark-gfm parses pipe tables; the auto-docs use them
  // heavily (crontab, heartbeats, integrations).
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full text-xs text-2">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-surface-2 text-[11px] font-mono uppercase tracking-wider text-3">
      {children}
    </thead>
  ),
  tbody: ({ children }) => <tbody className="divide-y divide-[var(--border-micro)]">{children}</tbody>,
  th: ({ children }) => <th className="px-3 py-2 text-left weight-label">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 align-top">{children}</td>,
  hr: () => <hr className="my-4 border-hairline" />,
};

export default function DocsPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = use(params);
  const slugPath = slug.join('/');
  const { data, error, isLoading } = useSWR<DocResponse>(
    `/api/docs/${slugPath}`,
    fetcher,
    { refreshInterval: 60_000 },
  );

  // Breadcrumb: System / docs / agents / clawd
  const crumbs = [
    { label: 'Docs', href: '/docs/index' },
    ...slug.map((seg, i) => ({
      label: seg,
      href: `/docs/${slug.slice(0, i + 1).join('/')}`,
    })),
  ];

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs font-mono text-3">
        {crumbs.map((c, i) => (
          <span key={c.href} className="flex items-center gap-1.5">
            {i > 0 && <Icon glyph={CaretRight} size={12} className="opacity-50" aria-hidden />}
            <Link href={c.href} className="hover:text-1 transition-colors">
              {c.label}
            </Link>
          </span>
        ))}
      </div>

      {isLoading && (
        <Panel className="p-6">
          <div className="text-3 text-sm">Loading…</div>
        </Panel>
      )}

      {error && (
        <Panel className="p-6">
          <div className="text-state-error text-sm font-mono">
            Error: {(error as Error).message}
          </div>
          <p className="mt-2 text-xs text-3">
            Source root: <code>docs/{slugPath}</code>
          </p>
        </Panel>
      )}

      {data?.kind === 'dir' && (
        <Panel className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Icon glyph={Folder} state="domain" size={18} className="text-2" aria-hidden />
              <h1 className="text-lg weight-strong text-1">
                {data.title}
              </h1>
              <span className="text-[10px] font-mono text-3 tabular">
                {data.entries?.length ?? 0} entries
              </span>
            </div>
            {data.mtime && (
              <div className="flex items-center gap-1 text-[10px] font-mono text-3">
                <Icon glyph={Clock} size={12} aria-hidden />
                <span className="tabular">updated {timeAgo(data.mtime)}</span>
              </div>
            )}
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {data.entries?.map((entry) => (
              <li key={entry.slug}>
                <Link
                  href={`/docs/${entry.slug}`}
                  className="group flex items-center gap-2 px-3 py-2 rounded-md bg-surface-2 border border-hairline hover:bg-surface-3 hover:border-border-default transition-colors lift"
                >
                  {entry.kind === 'dir' ? (
                    <Icon glyph={Folder} state="domain" size={14} className="text-2 group-hover:text-1 flex-shrink-0" aria-hidden />
                  ) : (
                    <Icon glyph={FileText} size={14} className="text-3 group-hover:text-2 flex-shrink-0" aria-hidden />
                  )}
                  <span className="text-sm text-2 group-hover:text-1 truncate">
                    {entry.name}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {data?.kind === 'file' && (
        <Panel className="p-6">
          <div className="flex items-center justify-between mb-2 pb-3 border-b border-hairline">
            <div className="flex items-center gap-2">
              <Icon glyph={FileText} size={16} className="text-2" aria-hidden />
              <span className="text-[11px] font-mono uppercase tracking-wider text-3">
                docs/{slugPath}.md
              </span>
            </div>
            {data.mtime && (
              <div className="flex items-center gap-1 text-[10px] font-mono text-3">
                <Icon glyph={Clock} size={12} aria-hidden />
                <span className="tabular">updated {timeAgo(data.mtime)}</span>
              </div>
            )}
          </div>
          <div className="docs-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {data.content || ''}
            </ReactMarkdown>
          </div>
        </Panel>
      )}
    </div>
  );
}
