'use client';

// ═══════════════════════════════════════════════════════════════════════════
// TranscriptMessage — read-only renderer for one persisted chat_messages row.
//
// Used by /chat/[threadId] (V3 M7 retired transcript view). Mirrors the
// styling MessageStream uses for the same roles, but stripped of anything
// that depends on streaming state (active tool, queue, retries).
//
// Tool messages render as expandable cards (clientside state for the
// open/close toggle — same UX as MessageStream's ToolCard).
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';
import type { ChatMessage } from '@/lib/chat';
import MarkdownBubble from './MarkdownBubble';

export default function TranscriptMessage({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-white text-neutral-900 px-4 py-2 text-sm whitespace-pre-wrap break-words">
          {msg.content}
          {msg.file_refs && msg.file_refs.length > 0 && (
            <div className="mt-1 text-[10px] text-neutral-500 font-mono">
              📎 {msg.file_refs.length} file{msg.file_refs.length > 1 ? 's' : ''} attached
            </div>
          )}
        </div>
      </div>
    );
  }

  if (msg.role === 'assistant') {
    const formattedTime = (() => {
      try {
        return new Date(msg.created_at).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        });
      } catch {
        return '';
      }
    })();
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-neutral-900 border border-neutral-800 px-4 py-2 text-sm text-neutral-100 break-words">
          <MarkdownBubble content={msg.content} />
          {formattedTime && (
            <div className="mt-2 text-xs text-neutral-500">{formattedTime}</div>
          )}
        </div>
      </div>
    );
  }

  if (msg.role === 'tool') {
    return <ToolCard msg={msg} />;
  }

  // 'thinking' and any future roles — render the content if present, else skip.
  if (msg.content) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-lg bg-neutral-900/40 border border-neutral-800/60 px-3 py-2 text-xs text-neutral-400 font-mono whitespace-pre-wrap">
          {msg.role} · {msg.content}
        </div>
      </div>
    );
  }
  return null;
}

function ToolCard({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full rounded-lg bg-neutral-900/60 border border-neutral-800 px-3 py-2 text-xs">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-neutral-400 hover:text-neutral-200 font-mono"
        >
          <span>{open ? '▾' : '▸'}</span>
          <span>tool · {msg.tool_name || 'unknown'}</span>
        </button>
        {open && (
          <div className="mt-2 space-y-2">
            {msg.tool_input && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">input</div>
                <pre className="text-[11px] text-neutral-300 bg-black/40 rounded p-2 overflow-x-auto">
                  {JSON.stringify(msg.tool_input, null, 2)}
                </pre>
              </div>
            )}
            {msg.tool_output && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">output</div>
                <pre className="text-[11px] text-neutral-300 bg-black/40 rounded p-2 overflow-x-auto">
                  {JSON.stringify(msg.tool_output, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
