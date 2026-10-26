// The clean chat view of a pane: the session's transcript (read from Claude Code's own JSONL by
// the server) as messages, Markdown rendered safely, tool calls folded to one line each, and the
// composer underneath. The raw terminal stays mounted behind it (see pane.js).
import { html } from '../lib/html.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Composer } from './composer.js';
import { api } from '../lib/api.js';
import { parseMarkdown } from '../lib/markdown.js';
import { answerCard } from '../lib/actions.js';
import { ClaimBadge, claimFor, useClaims } from './claims.js';

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
  // Claude Code writes a question's line to the transcript only once it is answered: until then
  // the card comes from the session (`asking.card`, from its PreToolUse hook), and stays mounted
  // until the transcript has it, so its "Sent" state does not blink away.
  const early = useRef(null);
  const inTranscript = (id) => messages.some((m) => (m.tools || []).some((t) => t && t.id === id));
  if (s.asking && s.asking.card && s.asking.tool_id && !inTranscript(s.asking.tool_id)) {
    if (!early.current || early.current.tool_id !== s.asking.tool_id) early.current = { tool_id: s.asking.tool_id, card: s.asking.card };
  } else if (early.current && inTranscript(early.current.tool_id)) {
    early.current = null;
  }
  const pendingMsg = early.current ? { n: `ask-${early.current.tool_id}`, role: 'assistant', text: '', tools: [{ name: early.current.card.kind === 'plan' ? 'ExitPlanMode' : 'AskUserQuestion', id: early.current.tool_id, ask: early.current.card }] } : null;
  // A question's or a plan's answer is its own transcript entry; the card shows it.
  const answers = useMemo(() => {
    const m = {};
    for (const x of messages) if (x.role === 'answer' && x.tool_id) m[x.tool_id] = x;
    return m;
  }, [messages.length]);
  // Claim receipts (1.6): re-read when the transcript grows or the session's state changes.
  const [claims, refreshClaims] = useClaims(s.sid, `${messages.length}:${s.status}`);
  return html`<div class="chat-view" data-testid="chat-view">
    <div class="chat-list" ref=${list} onScroll=${onScroll} role="log" aria-label="Conversation" aria-live="polite">
      <div class="chat-inner">
        ${messages.map((m) => (m.role === 'answer' ? null : html`<${Message} key=${m.n} m=${m} s=${s} answers=${answers} claim=${claimFor(claims, m)} onFixSent=${refreshClaims} />`))}
        ${pendingMsg ? html`<${Message} key=${pendingMsg.n} m=${pendingMsg} s=${s} answers=${answers} />` : null}
        ${s.status === 'working' ? html`<p class="chat-working" aria-hidden="true">Working…</p>` : null}
      </div>
    </div>
    ${ended ? null : html`<${Composer} s=${s} agent=${agent} />`}
  </div>`;
}

function Message({ m, s, answers, claim, onFixSent }) {
  const blocks = useMemo(() => parseMarkdown(m.text || ''), [m.text]);
  const all = Array.isArray(m.tools) ? m.tools : [];
  const tools = all.filter((t) => !(t && t.ask));
  const asks = all.filter((t) => t && t.ask && t.id);
  const role = m.role === 'user' ? 'user' : 'assistant';
  return html`<div class=${`chat-msg chat-${role}`} data-testid="chat-msg" data-role=${role}>
    ${blocks.length ? html`<div class="chat-body">${blocks.map(renderBlock)}</div>` : null}
    ${tools.length ? html`<div class="chat-tools">${tools.map((t, i) => html`<${Tool} key=${i} t=${t} />`)}</div>` : null}
    ${claim ? html`<${ClaimBadge} claim=${claim} sid=${s.sid} onSent=${onFixSent} />` : null}
    ${asks.map((t) => (t.ask.kind === 'plan'
      ? html`<${PlanCard} key=${t.id} t=${t} s=${s} answer=${answers[t.id]} />`
      : html`<${QuestionCard} key=${t.id} t=${t} s=${s} answer=${answers[t.id]} />`))}
  </div>`;
}

// Is this card's question the one the session is waiting on right now?
const isPending = (t, s, answer) => !answer && !!s && s.status === 'needs_you' && s.waiting_on === 'permission_prompt' && !!s.asking && s.asking.tool_id === t.id;

/**
 * A question Claude asked (AskUserQuestion): its options as buttons (checkboxes for a multiSelect
 * one), a free-text "Other" for a one-pick question, then Send. Afterwards: what was answered.
 */
function QuestionCard({ t, s, answer }) {
  const qs = t.ask.questions || [];
  const pending = isPending(t, s, answer);
  const [picks, setPicks] = useState(() => qs.map(() => []));
  const [texts, setTexts] = useState(() => qs.map(() => null)); // null = Other not chosen
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const sending = useRef(false); // a key-repeat Enter or a double tap must not send twice
  const pick = (qi, oi) => {
    setTexts((x) => x.map((v, i) => (i === qi && !qs[qi].multiSelect ? null : v)));
    setPicks((x) => x.map((p, i) => (i !== qi ? p : qs[qi].multiSelect ? (p.includes(oi) ? p.filter((o) => o !== oi) : [...p, oi]) : [oi])));
  };
  const other = (qi) => {
    setPicks((x) => x.map((p, i) => (i === qi ? [] : p)));
    setTexts((x) => x.map((v, i) => (i === qi ? v ?? '' : v)));
  };
  const ready = qs.every((q, i) => (texts[i] !== null ? texts[i].trim().length > 0 : picks[i].length > 0));
  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    const body = { tool_id: t.id, answers: qs.map((q, i) => (texts[i] !== null ? { text: texts[i].trim() } : { choices: [...picks[i]].sort((a, b) => a - b) })) };
    const ok = await answerCard(s.sid, body);
    setBusy(false);
    sending.current = false;
    if (ok) setSent(true);
  };
  const given = answer && answer.answers ? answer.answers : null;
  const state = given ? 'answered' : answer ? 'declined' : sent ? 'sent' : pending ? 'pending' : 'waiting';
  const live = pending && !sent;
  return html`<section class=${`ask-card is-${state}`} data-testid="question-card" data-state=${state} data-tool=${t.id} aria-label="Claude's question">
    <p class="ask-kicker">${state === 'answered' ? 'You answered' : state === 'declined' ? 'Not answered' : 'Claude asks'}</p>
    ${qs.map((q, qi) => {
      const chosen = given ? String(given[q.question] ?? '') : '';
      // A one-pick answer is one label (it may contain a comma); a multiSelect one is "A, B".
      const chosenSet = new Set(q.multiSelect ? chosen.split(', ').filter(Boolean) : [chosen]);
      const known = q.options.some((o) => chosenSet.has(o.label));
      return html`<fieldset key=${qi} class="ask-q" disabled=${!live || busy}>
        <legend class="ask-legend">${q.header ? html`<span class="ask-header">${q.header}</span>` : null}<span class="ask-text">${q.question}</span></legend>
        ${q.multiSelect && live ? html`<p class="ask-hint">Pick any that apply.</p>` : null}
        <div class="ask-options" role=${q.multiSelect ? 'group' : 'radiogroup'} aria-label=${q.question}>
          ${q.options.map((o, oi) => {
            const on = live ? picks[qi].includes(oi) : chosenSet.has(o.label);
            return html`<button type="button" key=${oi} class=${`ask-opt ${on ? 'is-on' : ''}`} data-testid="ask-option" data-option=${oi}
              role=${q.multiSelect ? 'checkbox' : 'radio'} aria-checked=${on ? 'true' : 'false'} onClick=${() => pick(qi, oi)}>
              <span class="ask-mark" aria-hidden="true">${q.multiSelect ? (on ? '☑' : '☐') : on ? '◉' : '○'}</span>
              <span class="ask-opt-main"><span class="ask-opt-label">${o.label}</span>${o.description ? html`<span class="ask-opt-desc">${o.description}</span>` : null}</span>
            </button>`;
          })}
          ${!q.multiSelect && live ? html`<div class=${`ask-other ${texts[qi] !== null ? 'is-on' : ''}`}>
            ${texts[qi] === null
              ? html`<button type="button" class="ask-opt ask-opt-other" role="radio" aria-checked="false" onClick=${() => other(qi)} data-testid="ask-other"><span class="ask-mark" aria-hidden="true">○</span><span class="ask-opt-label">Something else…</span></button>`
              : html`<input class="ask-other-input" type="text" maxLength="1000" value=${texts[qi]} placeholder="Type your answer" aria-label=${`Your answer to: ${q.question}`}
                  onInput=${(e) => { const v = e.currentTarget.value; setTexts((x) => x.map((w, i) => (i === qi ? v : w))); }}
                  onKeyDown=${(e) => { if (e.key === 'Enter' && ready && !busy) { e.preventDefault(); send(); } }} data-testid="ask-other-input" ref=${(el) => el && !el.dataset.seen && (el.dataset.seen = '1', el.focus())} />`}
          </div>` : null}
          ${given && chosen && !known ? html`<p class="ask-typed" data-testid="ask-typed">“${chosen}”</p>` : null}
        </div>
      </fieldset>`;
    })}
    ${live ? html`<div class="ask-foot">
      <button type="button" class="btn btn-primary btn-sm" onClick=${send} disabled=${!ready || busy} data-testid="ask-send">${busy ? 'Sending…' : qs.length > 1 ? 'Send answers' : 'Send answer'}</button>
    </div>` : state === 'sent' ? html`<p class="ask-note" role="status">Sent. Claude is carrying on.</p>`
      : state === 'waiting' && s && s.status === 'needs_you' && s.waiting_on === 'permission_prompt' ? html`<p class="ask-note">Getting the question ready…</p>` : null}
  </section>`;
}

const planChoice = (c) => String((c && c.label) || '').replace(/^\s*\d+[.)]\s*/, '').replace(/\s+shift\+tab.*$/i, '');
const FEEDBACK = /^tell claude what to change\b/i;

/**
 * Claude's plan (ExitPlanMode): the plan itself, and Claude Code's own choices to approve it or send
 * it back. The filled button is "Yes, manually approve edits": the obvious tap is never the one that
 * stops asking before edits.
 */
function PlanCard({ t, s, answer }) {
  const pending = isPending(t, s, answer);
  const blocks = useMemo(() => parseMarkdown(t.ask.plan || ''), [t.ask.plan]);
  const [busy, setBusy] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [sent, setSent] = useState(false);
  const sending = useRef(false);
  const choices = pending && Array.isArray(s.choices) ? s.choices : [];
  const send = async (option, text) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(option);
    // The plan's id: the server presses nothing unless this plan is the one on screen.
    const ok = await answerCard(s.sid, text ? { option, text, tool_id: t.id } : { option, tool_id: t.id });
    setBusy(0);
    sending.current = false;
    if (ok) setSent(true);
  };
  const state = answer ? (answer.approved ? 'approved' : answer.feedback ? 'feedback' : 'declined') : sent ? 'sent' : pending ? 'pending' : 'waiting';
  const live = pending && !sent;
  const fb = choices.find((c) => FEEDBACK.test(planChoice(c)));
  return html`<section class=${`ask-card plan-card is-${state}`} data-testid="plan-card" data-state=${state} data-tool=${t.id} aria-label="Claude's plan">
    <p class="ask-kicker">${state === 'approved' ? 'Plan approved' : state === 'feedback' ? 'Plan sent back' : state === 'declined' ? 'Plan not approved' : 'Claude has a plan'}</p>
    <div class="plan-body chat-body">${blocks.map(renderBlock)}</div>
    ${state === 'feedback' ? html`<p class="ask-typed" data-testid="plan-feedback">“${answer.feedback}”</p>` : null}
    ${live && choices.length ? html`<div class="ask-foot plan-actions">
      ${choices.filter((c) => c !== fb).map((c) => html`<button type="button" key=${c.option} class=${`btn ${/manually/i.test(planChoice(c)) ? 'btn-primary' : 'btn-quiet'} btn-sm`}
        onClick=${() => send(c.option)} disabled=${!!busy} data-testid="plan-choice" data-option=${c.option}>${busy === c.option ? 'Sending…' : planChoice(c)}</button>`)}
      ${fb && feedback === null ? html`<button type="button" class="btn btn-quiet btn-sm" onClick=${() => setFeedback('')} disabled=${!!busy} data-testid="plan-change">Tell Claude what to change…</button>` : null}
    </div>` : null}
    ${live && fb && feedback !== null ? html`<div class="plan-feedback">
      <textarea class="plan-feedback-input" rows="3" maxLength="1000" value=${feedback} placeholder="What should Claude change?" aria-label="What Claude should change in the plan"
        onInput=${(e) => setFeedback(e.currentTarget.value)} data-testid="plan-feedback-input" ref=${(el) => { if (el && !el.dataset.seen) { el.dataset.seen = '1'; el.focus(); el.closest('.plan-feedback')?.scrollIntoView?.({ block: 'nearest' }); } }}></textarea>
      <div class="ask-foot"><button type="button" class="btn btn-quiet btn-sm" onClick=${() => setFeedback(null)} disabled=${!!busy}>Cancel</button>
        <button type="button" class="btn btn-primary btn-sm" onClick=${() => send(fb.option, feedback.trim())} disabled=${!feedback.trim() || !!busy} data-testid="plan-feedback-send">${busy ? 'Sending…' : 'Send back'}</button></div>
    </div>` : null}
    ${live && !choices.length ? html`<p class="ask-note">Getting the choices ready…</p>` : null}
    ${state === 'sent' ? html`<p class="ask-note" role="status">Sent. Claude is carrying on.</p>` : null}
  </section>`;
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

export function renderBlock(b, i) {
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
