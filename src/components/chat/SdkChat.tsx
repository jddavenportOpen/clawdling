'use client';

// ═══════════════════════════════════════════════════════════════════════════
// SdkChat — bridge-free interactive chat for ADJUTANT_ENGINE=sdk.
//
// The cockpit's primary chat UI (the pane grid + SessionTerminal) is built for
// the Mac Mini CLI bridge and does not run on Vercel. This component is the
// browser chat surface for the SDK engine: a message list + composer that POSTs
// to /api/chat/[threadId] and renders the streamed reply live. No sessions, no
// bridge, no PTY — just the Anthropic Messages API behind the route.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';

interface Msg {
  id: string;
  role: 'user' | 'assistant' | string;
  content: string;
}

export default function SdkChat({
  threadId,
  initialMessages,
}: {
  threadId: string;
  initialMessages: Msg[];
}) {
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [streaming, setStreaming] = useState('');
  const [tool, setTool] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  async function send() {
    const content = text.trim();
    if (!content || busy) return;
    setError('');
    setText('');
    setBusy(true);
    const userMsg: Msg = { id: `local-${Date.now()}`, role: 'user', content };
    setMessages((m) => [...m, userMsg]);
    let acc = '';
    let doneFired = false;
    try {
      const res = await fetch(`/api/chat/${threadId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        // BYOK gates return 402 JSON (no_key / budget_exceeded) — show the message.
        let m = `Request failed (${res.status}).`;
        try {
          const j = await res.json();
          m = j.message || j.error || m;
          if (j.error === 'no_key') { window.location.href = '/onboarding'; return; }
        } catch { /* not json */ }
        setError(m);
        setBusy(false);
        return;
      }
      if (!res.body) throw new Error('No response stream.');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt: { type?: string; text?: string; error?: string; message_id?: string; name?: string; phase?: string };
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.type === 'text' && evt.text) {
            acc += evt.text;
            setStreaming(acc);
          } else if (evt.type === 'tool') {
            const label = evt.name === 'web_search' ? 'Searching the web…' : evt.name === 'web_fetch' ? 'Reading a page…' : 'Working…';
            setTool(evt.phase === 'start' ? label : '');
          } else if (evt.type === 'error') {
            setError(evt.error || 'stream error');
          } else if (evt.type === 'done') {
            doneFired = true;
            setMessages((m) => [...m, { id: evt.message_id || `a-${Date.now()}`, role: 'assistant', content: acc }]);
            setStreaming('');
          }
        }
      }
      setTool('');
      // AUDIT-010/BUG-006 fix: flush only if 'done' never fired (stream cut off).
      // Flag-based, not content-matching, so a reply that happens to repeat an
      // earlier message is never silently dropped.
      if (acc && !doneFired) {
        setMessages((m) => [...m, { id: `a-${Date.now()}`, role: 'assistant', content: acc }]);
        setStreaming('');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} data-testid="sdk-chat-messages" className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 space-y-4">
        {messages.length === 0 && !streaming && (
          <div className="text-center text-sm text-neutral-500 py-12">Send a message to start.</div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} content={m.content} />
        ))}
        {tool && (
          <div className="flex justify-start">
            <div className="inline-flex items-center gap-2 rounded-full bg-neutral-900 border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              {tool}
            </div>
          </div>
        )}
        {streaming && <Bubble role="assistant" content={streaming} streaming />}
        {error && <div className="text-xs text-red-400 px-1">{error}</div>}
      </div>

      <div className="shrink-0 border-t border-neutral-800 bg-neutral-950 px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={busy}
            placeholder={busy ? 'Waiting for reply…' : 'Message…'}
            data-testid="sdk-chat-input"
            className="flex-1 min-w-0 resize-none rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-neutral-600 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || !text.trim()}
            data-testid="sdk-chat-send"
            className="shrink-0 rounded-md bg-white text-neutral-900 font-semibold px-4 py-2 text-sm hover:bg-neutral-200 disabled:opacity-40 transition"
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, content, streaming }: { role: string; content: string; streaming?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm ${
          isUser ? 'bg-blue-600 text-white' : 'bg-neutral-900 border border-neutral-800 text-neutral-100'
        }`}
      >
        {content}
        {streaming && <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-neutral-400 animate-pulse" />}
      </div>
    </div>
  );
}
