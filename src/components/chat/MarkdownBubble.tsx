'use client';

// ═══════════════════════════════════════════════════════════════════════════
// MarkdownBubble — shared markdown renderer for assistant messages.
//
// Used by both the persisted message bubbles in MessageStream and the
// live-streaming bubble. User messages do NOT use this component; they
// stay as plain text to avoid escaping issues with pasted code/markup.
//
// Style notes:
//   - Headings are sized down (h1 caps at 18px) — chat bubbles are not
//     documents, so the document hierarchy looks ridiculous at full size.
//   - Code blocks use prism's oneDark theme + a slightly darker bg than
//     the bubble (neutral-950 vs neutral-900) so they read as separate.
//   - Inline `code` gets a subtle bg + border ring.
//   - Lists get right padding so bullets aren't flush against bubble edge.
//   - Links open in a new tab with rel="noopener noreferrer".
// ═══════════════════════════════════════════════════════════════════════════

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { stripPlumbing } from '@/lib/plumbing';

interface Props {
  content: string;
  className?: string;
}

// Tailwind v4: components are passed inline. We avoid `prose` (typography
// plugin not installed) and define every element ourselves so the look
// stays tight and predictable inside a chat bubble.
const components: Components = {
  // Headings — capped sizes for chat context.
  h1: ({ children }) => (
    <h1 className="text-[18px] font-semibold mt-3 mb-1.5 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[16px] font-semibold mt-3 mb-1.5 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[15px] font-semibold mt-2.5 mb-1 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-[14px] font-semibold mt-2 mb-1 first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-[13px] font-semibold mt-2 mb-1 first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-[12px] font-semibold uppercase tracking-wide text-neutral-300 mt-2 mb-1 first:mt-0">
      {children}
    </h6>
  ),

  // Paragraphs — tight leading, no top margin on the first one.
  p: ({ children }) => (
    <p className="leading-relaxed my-1.5 first:mt-0 last:mb-0">{children}</p>
  ),

  // Inline emphasis.
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => (
    <del className="line-through text-neutral-400">{children}</del>
  ),

  // Lists — pl-5 so bullets sit inside the padding, pr-1 so wrapped text
  // doesn't kiss the bubble edge.
  ul: ({ children }) => (
    <ul className="list-disc pl-5 pr-1 my-1.5 space-y-0.5 marker:text-neutral-500">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 pr-1 my-1.5 space-y-0.5 marker:text-neutral-500">
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => {
    // GFM task-list items get a `checked` boolean and a class on the <li>.
    // remark-gfm renders the checkbox as a disabled <input> child by default;
    // we just style the wrapper for alignment.
    const checked = (props as { checked?: boolean | null }).checked;
    if (typeof checked === 'boolean') {
      return (
        <li className="list-none -ml-5 flex items-start gap-2">
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="mt-1 h-3.5 w-3.5 rounded border-neutral-600 bg-neutral-800 accent-neutral-300"
          />
          <span>{children}</span>
        </li>
      );
    }
    return <li className="leading-relaxed">{children}</li>;
  },

  // Blockquote — left border + muted text.
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-neutral-700 pl-3 my-2 text-neutral-300 italic">
      {children}
    </blockquote>
  ),

  // Horizontal rule.
  hr: () => <hr className="my-3 border-neutral-800" />,

  // Links — always open in a new tab.
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-400 hover:text-sky-300 underline underline-offset-2 break-words"
    >
      {children}
    </a>
  ),

  // GFM tables.
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full text-[12px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-neutral-950/60">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr className="border-b border-neutral-800 last:border-0">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold text-neutral-200">{children}</th>
  ),
  td: ({ children }) => <td className="px-2 py-1 align-top">{children}</td>,

  // Code — inline vs block. react-markdown 10 calls this for both; we
  // detect block-vs-inline via the className `language-*` (set by GFM
  // for fenced blocks) AND a newline check on the content.
  code: ({ className, children, ...props }) => {
    const text = String(children ?? '').replace(/\n$/, '');
    const langMatch = /language-([\w-]+)/.exec(className || '');
    const looksBlock = !!langMatch || text.includes('\n');

    if (!looksBlock) {
      return (
        <code
          className="px-1 py-0.5 rounded bg-neutral-950/70 border border-neutral-800 text-[0.85em] font-mono text-neutral-100"
          {...props}
        >
          {children}
        </code>
      );
    }

    const language = langMatch?.[1] ?? 'text';
    return (
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        PreTag="div"
        customStyle={{
          margin: '0.5rem 0',
          padding: '0.75rem',
          borderRadius: '0.5rem',
          fontSize: '12px',
          lineHeight: '1.5',
          background: 'rgb(10 10 10)', // neutral-950, slightly darker than bubble
          border: '1px solid rgb(38 38 38)', // neutral-800
          // chat-session mobile pass (2026-06-10): a long code line must SCROLL
          // horizontally inside its own block, never widen the bubble past the
          // phone viewport (target 2 — "code/mono blocks scroll horizontally not
          // overflow"). overflowX:auto + maxWidth:100% keep the bubble within the
          // transcript column; harmless on desktop where lines rarely overflow.
          overflowX: 'auto',
          maxWidth: '100%',
        }}
        codeTagProps={{
          style: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
        }}
      >
        {text}
      </SyntaxHighlighter>
    );
  },

  // Plain <pre> wrapper around fenced blocks — react-markdown wraps the
  // <code> in a <pre>; we strip its default styling so SyntaxHighlighter
  // controls the look.
  pre: ({ children }) => <>{children}</>,
};

export default function MarkdownBubble({ content, className }: Props) {
  // Strip internal plumbing markers (<task-notification>, <local-command-*>,
  // etc.) before rendering. The streamed SSE path never filtered these, so raw
  // tags leaked into assistant bubbles ("weird messages"). This is the single
  // render chokepoint for both live-streaming and persisted assistant text.
  const clean = stripPlumbing(content);
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {clean}
      </ReactMarkdown>
    </div>
  );
}
