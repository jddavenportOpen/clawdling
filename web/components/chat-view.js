// The clean chat view of a pane: the session's transcript (read from Claude Code's own JSONL by
// the server) as messages, Markdown rendered safely, tool calls folded to one line each, and the
// composer underneath. The raw terminal stays mounted behind it (see pane.js).
import { html } from '../lib/html.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Composer } from './composer.js';
import { api } from '../lib/api.js';
import { parseMarkdown } from '../lib/markdown.js';

const POLL_MS = 1500;
const MAX_PAGES = 50;

// The transcript of one session: loaded from the start (paging while `more`), then polled for new
// entries every 1.5 s while visible. An ended session is read once. Errors keep the last good list.
export function useTranscript(sid, ended, enabled) {
  const [messages, setMessages] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const store = useRef({ sid, after: -1, list: [], loaded: false });
  if (store.current.sid !== sid) store.current = { sid, after: -1, list: [], loaded: false };

  useEffect(() => {
    if (!enabled) return undefined;
    const r = store.current;
    let alive = true;
    let busy = false;
    let timer = 0;
    const schedule = () => { clearTimeout(timer); if (alive && !(ended && r.loaded)) timer = setTimeout(tick, POLL_MS); };
    async function tick() {
      if (!alive || busy || (ended && r.loaded)) return;
      if (document.hidden) { schedule(); return; }
      busy = true;
      try {
        let got = false;
        for (let page = 0; page < MAX_PAGES && alive; page++) {
          const res = await api.messages(sid, r.after);
          const fresh = (res && Array.isArray(res.messages) ? res.messages : []).filter((m) => m && Number.isInteger(m.n) && m.n > r.after);
          if (fresh.length) {
            r.list = r.list.concat(fresh);
            r.after = fresh[fresh.length - 1].n;
            got = true;
          }
          if (!(res && res.more) || !fresh.length) break;
        }
        r.loaded = true;
        if (alive) {
          if (got) setMessages(r.list);
          setLoaded(true);
        }
      } catch {
        /* keep the last good list; try again on the next tick */
      } finally {
        busy = false;
      }
      schedule();
    }
    const onVisible = () => { if (!document.hidden && !busy) { clearTimeout(timer); tick(); } };
    document.addEventListener('visibilitychange', onVisible);
    if (r.list.length && messages !== r.list) setMessages(r.list);
    tick();
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [sid, ended, enabled]);

  return { messages, loaded };
}

const NEAR_BOTTOM = 80;

export function ChatView({ s, agent, messages }) {
  const list = useRef(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = list.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
  };
  // New messages keep the view at the bottom, unless the reader scrolled up to read.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  // A pane that changes height (the composer grows, the window resizes) stays pinned too.
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ended = s.status === 'ended';
  return html`<div class="chat-view" data-testid="chat-view">
    <div class="chat-list" ref=${list} onScroll=${onScroll} role="log" aria-label="Conversation" aria-live="polite">
      <div class="chat-inner">
        ${messages.map((m) => html`<${Message} key=${m.n} m=${m} />`)}
        ${s.status === 'working' ? html`<p class="chat-working" aria-hidden="true">Working…</p>` : null}
      </div>
    </div>
    ${ended ? null : html`<${Composer} s=${s} agent=${agent} />`}
  </div>`;
}

function Message({ m }) {
  const blocks = useMemo(() => parseMarkdown(m.text || ''), [m.text]);
  const tools = Array.isArray(m.tools) ? m.tools : [];
  const role = m.role === 'user' ? 'user' : 'assistant';
  return html`<div class=${`chat-msg chat-${role}`} data-testid="chat-msg" data-role=${role}>
    ${blocks.length ? html`<div class="chat-body">${blocks.map(renderBlock)}</div>` : null}
    ${tools.length ? html`<div class="chat-tools">${tools.map((t, i) => html`<${Tool} key=${i} t=${t} />`)}</div>` : null}
  </div>`;
}

function Tool({ t }) {
  const name = String((t && t.name) || 'Tool');
  const summary = String((t && t.summary) || '');
  const detail = String((t && (t.detail || t.summary)) || name);
  return html`<details class="chat-tool" data-testid="chat-tool">
    <summary title=${summary ? `${name}: ${summary}` : name}><span class="chat-tool-name">${name}</span>${summary ? html`<span class="chat-tool-sum">${summary}</span>` : null}</summary>
    <pre class="chat-tool-detail" data-testid="chat-tool-detail">${detail}</pre>
  </details>`;
}

// Markdown tree to Preact elements. Text is always a text node: nothing here is ever parsed as HTML.
function renderInline(n, i) {
  switch (n.type) {
    case 'text': return n.text;
    case 'code': return html`<code key=${i}>${n.text}</code>`;
    case 'strong': return html`<strong key=${i}>${n.children.map(renderInline)}</strong>`;
    case 'em': return html`<em key=${i}>${n.children.map(renderInline)}</em>`;
    case 'link': return html`<a key=${i} href=${n.href} target="_blank" rel="noopener noreferrer">${n.children.map(renderInline)}</a>`;
    case 'br': return html`<br key=${i} />`;
    default: return null;
  }
}

const inl = (nodes) => nodes.map(renderInline);

function renderBlock(b, i) {
  switch (b.type) {
    case 'p': return html`<p key=${i}>${inl(b.inline)}</p>`;
    case 'h': {
      const tag = `h${Math.min(6, b.level + 2)}`;
      return html`<${tag} key=${i} class="chat-h">${inl(b.inline)}</${tag}>`;
    }
    case 'code': return html`<div key=${i} class="chat-code" data-testid="chat-code">
      ${b.lang ? html`<span class="chat-code-lang">${b.lang}</span>` : null}
      <pre tabindex="0"><code data-lang=${b.lang || null}>${b.text}</code></pre>
    </div>`;
    case 'table': return html`<div key=${i} class="chat-table-wrap" tabindex="0"><table class="chat-table" data-testid="chat-table">
      <thead><tr>${b.head.map((c, k) => html`<th key=${k} style=${b.align[k] ? { textAlign: b.align[k] } : null}>${inl(c)}</th>`)}</tr></thead>
      <tbody>${b.rows.map((r, ri) => html`<tr key=${ri}>${r.map((c, k) => html`<td key=${k} style=${b.align[k] ? { textAlign: b.align[k] } : null}>${inl(c)}</td>`)}</tr>`)}</tbody>
    </table></div>`;
    case 'list': return b.ordered
      ? html`<ol key=${i} ...${b.start !== 1 ? { start: b.start } : {}}>${b.items.map((it, k) => html`<li key=${k}>${inl(it)}</li>`)}</ol>`
      : html`<ul key=${i}>${b.items.map((it, k) => html`<li key=${k}>${inl(it)}</li>`)}</ul>`;
    case 'quote': return html`<blockquote key=${i}>${b.blocks.map(renderBlock)}</blockquote>`;
    case 'hr': return html`<hr key=${i} />`;
    default: return null;
  }
}
