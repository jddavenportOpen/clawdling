// ═══════════════════════════════════════════════════════════════════════════
// sdk-engine.ts — headless Anthropic engine with an AGENTIC TOOL LOOP.
//
// When ADJUTANT_ENGINE=sdk (the OSS self-host + hosted-cloud default), chat
// turns run directly against the Anthropic Messages API. This is what lets the
// cockpit reply with only an API key, no Mac Mini bridge.
//
// Two kinds of tools, both live here:
//   • Anthropic SERVER tools (web_search / web_fetch) — Anthropic runs them
//     inside a single streamed call; we just show "Searching…".
//   • CUSTOM tools (tasks, memory, …) from tools.ts — the model REQUESTS them,
//     WE execute them server-side scoped to the user, feed the result back, and
//     let the model continue. This multi-step loop is what makes it ACT, not
//     just talk: it can add to your list and recall facts, then answer.
//
// streamTurn() async-yields the UI-shaped SSE events the chat route forwards.
// Model + effort are env/BYOK configurable:
//   ADJUTANT_MODEL (default claude-sonnet-4-6), ADJUTANT_EFFORT (default medium),
//   ADJUTANT_TOOLS (default 'web'; add 'tasks','memory' once their tables exist).
// ═══════════════════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';
import { enabledAgentTools, enabledToolset, toolByName } from './tools';

export interface EngineMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamTurnParams {
  system: string;
  messages: EngineMessage[];
  signal?: AbortSignal;
  // The authenticated user; required for custom tools that touch per-user data.
  userId?: string;
  // BYOK (docs/SPEC-BYOK.md): per-user overrides. Fall back to env when absent.
  apiKey?: string;
  model?: string;
  effort?: string;
}

export type EngineEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking_start' }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_end' }
  | { type: 'error'; error: string }
  // Tool activity (web search/fetch OR a custom action) so the UI can show it.
  | { type: 'tool'; name: string; phase: 'start' | 'end' }
  // Emitted once at end of a turn so the route can meter per-user cost.
  | { type: 'usage'; model: string; tokensIn: number; tokensOut: number };

const MODEL = process.env.ADJUTANT_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env.ADJUTANT_MAX_TOKENS) || 8192;
const VALID_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT = (VALID_EFFORT as readonly string[]).includes(process.env.ADJUTANT_EFFORT || '')
  ? (process.env.ADJUTANT_EFFORT as (typeof VALID_EFFORT)[number])
  : 'medium';
// Cap on agentic round-trips per turn, so a tool-loop can never run away and
// blow the serverless window. Each step is one model call.
const MAX_STEPS = Number(process.env.ADJUTANT_MAX_STEPS) || 6;

let _envClient: Anthropic | null = null;
function client(apiKey?: string): Anthropic {
  if (apiKey) return new Anthropic({ apiKey });
  if (!_envClient) _envClient = new Anthropic();
  return _envClient;
}

// Friendly labels for the "Working…" chip.
function toolLabel(name: string): string {
  if (name === 'web_search') return 'Searching the web';
  if (name === 'web_fetch') return 'Reading a page';
  if (name === 'create_task') return 'Adding a task';
  if (name === 'list_tasks') return 'Checking your tasks';
  if (name === 'complete_task') return 'Updating a task';
  if (name === 'remember') return 'Remembering that';
  if (name === 'recall') return 'Recalling what you told me';
  return 'Working';
}

type Block = { type: string; name?: string; id?: string; input?: Record<string, unknown> };
type ApiMessage = { role: 'user' | 'assistant'; content: unknown };

export async function* streamTurn(params: StreamTurnParams): AsyncGenerator<EngineEvent> {
  const { system, messages, signal, userId } = params;

  // ── Mock mode (ADJUTANT_MOCK=1) — zero API cost demo ─────────────────────
  if (process.env.ADJUTANT_MOCK === '1') {
    const last = messages.length ? messages[messages.length - 1].content : '';
    const reply =
      `Demo mode: no tokens were spent on this reply. You said: "${last.slice(0, 120)}". ` +
      `In the real product this streams a live Claude response. Everything else here is real.`;
    for (const word of reply.split(' ')) {
      if (signal?.aborted) return;
      yield { type: 'text', text: word + ' ' };
      await new Promise((r) => setTimeout(r, 35));
    }
    return;
  }

  const model = params.model || MODEL;
  const effort =
    params.effort && (VALID_EFFORT as readonly string[]).includes(params.effort) ? params.effort : EFFORT;

  // Build the tool set: Anthropic server web tools + our custom action tools.
  const toolset = enabledToolset();
  const tools: Array<Record<string, unknown>> = [];
  if (toolset.includes('web')) {
    tools.push({ type: 'web_search_20260209', name: 'web_search' });
    tools.push({ type: 'web_fetch_20260209', name: 'web_fetch' });
  }
  // Custom tools only offered when we have a user to scope them to.
  const customTools = userId ? enabledAgentTools() : [];
  for (const t of customTools) {
    tools.push({ name: t.name, description: t.description, input_schema: t.input_schema });
  }

  // The running conversation for the agentic loop. Starts from history (string
  // content is valid), then grows block-based turns as tools are called.
  const apiMessages: ApiMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));

  let tokensIn = 0;
  let tokensOut = 0;
  const blockTypes: Record<number, string> = {};
  const blockToolName: Record<number, string> = {};

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) return;

      const body = {
        model,
        max_tokens: MAX_TOKENS,
        system,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort },
        messages: apiMessages,
        ...(tools.length ? { tools } : {}),
      } as unknown as Anthropic.MessageCreateParamsStreaming;

      const stream = client(params.apiKey).messages.stream(body, signal ? { signal } : undefined);

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const cb = event.content_block as { type?: string; name?: string };
          blockTypes[event.index] = cb.type || 'unknown';
          if (cb.type === 'thinking') {
            yield { type: 'thinking_start' };
          } else if (cb.type === 'server_tool_use') {
            const name = cb.name || 'tool';
            blockToolName[event.index] = name;
            yield { type: 'tool', name: toolLabel(name), phase: 'start' };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta as { type?: string; text?: string; thinking?: string };
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            yield { type: 'text', text: delta.text };
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
            yield { type: 'thinking', text: delta.thinking };
          }
        } else if (event.type === 'content_block_stop') {
          if (blockTypes[event.index] === 'server_tool_use') {
            yield { type: 'tool', name: toolLabel(blockToolName[event.index] || 'tool'), phase: 'end' };
          }
          if (blockTypes[event.index] === 'thinking') {
            yield { type: 'thinking_end' };
          }
        }
      }

      const final = await stream.finalMessage();
      const u = final.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      tokensIn += u?.input_tokens ?? 0;
      tokensOut += u?.output_tokens ?? 0;

      if (final.stop_reason === 'refusal') {
        yield { type: 'error', error: 'The model declined to respond to this request.' };
        break;
      }

      // Custom tool calls the model wants US to run (web tools resolve inside the
      // call and never reach here). If none, the turn is complete.
      const content = final.content as unknown as Block[];
      const toolUses = content.filter((b) => b.type === 'tool_use');
      if (final.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      apiMessages.push({ role: 'assistant', content: final.content });
      const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
      for (const tu of toolUses) {
        if (signal?.aborted) return;
        yield { type: 'tool', name: toolLabel(tu.name || ''), phase: 'start' };
        const tool = tu.name ? toolByName(tu.name) : undefined;
        let out: string;
        if (!tool) {
          out = `Error: unknown tool "${tu.name}".`;
        } else if (!userId) {
          out = 'Error: no user context for this action.';
        } else {
          try {
            out = await tool.execute(userId, tu.input || {});
          } catch (e) {
            out = `Error running ${tu.name}: ${String(e)}`;
          }
        }
        yield { type: 'tool', name: toolLabel(tu.name || ''), phase: 'end' };
        results.push({ type: 'tool_result', tool_use_id: tu.id || '', content: out });
      }
      apiMessages.push({ role: 'user', content: results });
      // loop: let the model read the results and continue / answer.
    }

    yield { type: 'usage', model, tokensIn, tokensOut };
  } catch (err) {
    yield { type: 'error', error: `Engine error: ${String(err)}` };
  }
}
