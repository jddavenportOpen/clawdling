# Thinking-block upgrade — reference for `route.ts`

**Audience:** Agent A (owner of `src/app/api/chat/[threadId]/route.ts`).
**Written by:** Agent B (Phase 2 — real-time extended-thinking visibility).
**Status:** Reference doc only. This file is a spec, not code. Apply the
pattern below when wiring Phase 2.

## Goal

When the server calls the Anthropic messages API, make Claude's extended
thinking visible to the client as it streams. The client parser
(`src/lib/claude-stream.ts`) already understands both the native SDK
event shape and a simpler flat shape — Agent A can emit whichever is
easier. The UI (`StreamRenderer`) will render thinking in a collapsible
`ThinkingBlock` and the assistant text in the main bubble.

## Client expectations

The client parser emits this discriminated union (see
`src/lib/claude-stream.ts`):

```ts
type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_end'; duration_ms: number }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; input_delta: string }
  | { type: 'tool_use_end'; id: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Either wire format will be parsed correctly:

- **A) Pass-through SDK events** (`message_start`, `content_block_start`,
  `content_block_delta`, `content_block_stop`, `message_stop`) — lowest
  effort on the server.
- **B) Flat server events** — the server pre-classifies content blocks
  and emits `event: thinking_delta`, `event: text_delta`, `event: done`,
  etc. Slightly more work but much easier to debug in DevTools.

## Server-side — shared imports

```ts
import Anthropic from '@anthropic-ai/sdk'; // npm i @anthropic-ai/sdk
import {
  CHAT_MODEL,
  MAX_TOKENS,
  THINKING_CONFIG,
  buildSystemPrompt,
  type ThreadKind,
} from '@/lib/claude-config';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

## Pattern A — Pass-through SDK events (minimum work)

This is the fastest path. The client parser already handles
`content_block_start/delta/stop` with `type: 'thinking'` blocks.

```ts
export async function POST(req: Request, ctx: { params: { threadId: string } }) {
  const { messages, threadKind, refId, projectContext } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const mStream = anthropic.messages.stream({
          model: CHAT_MODEL,
          max_tokens: MAX_TOKENS,
          thinking: THINKING_CONFIG, // <-- the key upgrade
          system: buildSystemPrompt(threadKind as ThreadKind, refId, projectContext),
          messages,
        });

        // Pass every SDK event through as SSE. The client parser knows
        // the full SDK shape and will emit StreamEvents accordingly.
        for await (const sdkEvent of mStream) {
          write(sdkEvent.type, sdkEvent);
        }

        write('done', { type: 'done' });
      } catch (err) {
        write('error', {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        write('done', { type: 'done' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering
    },
  });
}
```

## Pattern B — Flat server events (more server work, easier to debug)

Server walks the SDK stream, classifies content blocks, and emits the
flat `StreamEvent` shape directly. Useful if you want server-side
metrics, filtering, or logging per event type.

```ts
for await (const ev of mStream) {
  if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') {
    write('thinking_start', { type: 'thinking_start' });
  } else if (ev.type === 'content_block_delta') {
    if (ev.delta.type === 'thinking_delta') {
      write('thinking_delta', {
        type: 'thinking_delta',
        text: ev.delta.thinking ?? '',
      });
    } else if (ev.delta.type === 'text_delta') {
      write('text_delta', { type: 'text_delta', text: ev.delta.text });
    }
  } else if (ev.type === 'content_block_stop') {
    // You may want to track per-index timing here and emit the
    // duration_ms on thinking_end — the client falls back to its own
    // wall-clock timing if you don't.
    write('thinking_end', { type: 'thinking_end', duration_ms: 0 });
  }
}
write('done', { type: 'done' });
```

## Matching a GET stream URL (StreamRenderer default)

`StreamRenderer` uses `EventSource`, which is GET-only. If the client
posts the user's message first via a separate POST and then connects to
the stream via GET, the endpoints might be:

- `POST /api/chat/[threadId]` — enqueue the user message, return an
  assistant-message id.
- `GET /api/chat/[threadId]/stream` — open the SSE stream that runs the
  Anthropic call and emits StreamEvents.

If you prefer a single POST-and-stream endpoint, pass
`transport="fetch"` + `fetchInit` from the caller — `StreamRenderer`
supports that path too (see the component source).

## Model ID caveat

`CHAT_MODEL` is currently pinned to `claude-opus-4-20250514`. When you
upgrade to Opus 4.6 or 4.7, **switch** `THINKING_CONFIG` to
`{ type: 'adaptive' }` — `budget_tokens` is deprecated on 4.6 and
returns 400 on 4.7. Update `claude-config.ts` in one change; nothing
downstream needs to change.

## Reliability checklist for the route

- [ ] Set `Cache-Control: no-cache, no-transform` and
      `X-Accel-Buffering: no` — otherwise Vercel/CDN will buffer SSE.
- [ ] Wrap the SDK iteration in try/catch and always emit `done` after
      `error`, so the client closes its EventSource cleanly.
- [ ] When the client reconnects (EventSource will), consider returning
      events from the persisted message rather than re-running the LLM.
      Phase 2 does not need this — a new LLM call is acceptable — but
      mark a TODO.
- [ ] Don't log thinking text at INFO level. It can be long and
      sensitive. Use DEBUG or omit.

## Route-ambiguity note (route.ts conflict)

There is currently an `[domain]` dynamic route sibling at
`src/app/api/chat/[domain]/`. Next.js rejects having two dynamic
segments at the same level (`Ambiguous app routes detected`). Agent A
will need to resolve this — options:

1. Move `[domain]` under a static prefix (e.g. `/api/chat/domain/[id]`).
2. Migrate `[domain]` callers to the new `[threadId]` route and remove
   the old directory.
3. Rename `[threadId]` to nest under a static prefix
   (e.g. `/api/chat/thread/[threadId]`).

This is outside Phase 2 scope but blocks `npm run build`.
