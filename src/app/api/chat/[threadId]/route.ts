// ═══════════════════════════════════════════════════════════════════════════
// POST /api/chat/[threadId] — send a user message, stream assistant reply
//                             from the Mac Mini Claude Code CLI bridge.
// GET  /api/chat/[threadId]?before=<iso> — poll new messages since timestamp.
//
// ── Architecture ─────────────────────────────────────────────────────
// Historical note: this route used to call `api.anthropic.com` directly
// (metered API, no tools, no MCP, no file access). As of 2026-04-23 it
// forwards every turn to the Mac Mini FastAPI bridge at `$BRIDGE_URL`
// (tunneled via cloudflared). The bridge shells out to `claude --print
// --session-id <threadId>` — JD's Max subscription pays, and we get the
// full Claude Code surface: Bash, Edit, Read, Write, MCP servers, per-
// agent cwd, per-agent system prompts, tool-call cards, thinking blocks.
//
// Each thread_id is persisted as a Claude CLI session-id (UUID). First
// turn uses `--session-id` to create; follow-ups use `--resume`.
//
// The bridge streams `claude --output-format stream-json` back as SSE.
// We translate those events into the frontend's expected shape:
//   data: {"type":"text","text":"..."}      — assistant text delta
//   data: {"type":"thinking","text":"..."}  — extended-thinking delta
//   data: {"type":"tool_use_start","id":"...","name":"Bash"}
//   data: {"type":"tool_use_end","id":"..."}
//   data: {"type":"done","message_id":"..."}
//   data: {"type":"error","error":"..."}
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import {
  addMessage,
  getMessagesForThread,
  getThreadById,
  getUploadsByIds,
  upsertAssistantMessage,
} from '@/lib/chat';
import { bridgeFetch } from '@/lib/bridge-client';
import { resolveThreadRuntime } from '@/lib/agents-runtime';
import { streamTurn, type EngineMessage } from '@/lib/engine/sdk-engine';
import {
  byokEnabled, getUserSettings, getUserApiKey, isOverBudget, recordUsage,
} from '@/lib/user-settings';
export const dynamic = 'force-dynamic';
// Vercel Pro supports up to 300s. Claude CLI runs can be long — don't
// starve them at 60s. If a turn takes >300s something is wrong.
export const maxDuration = 300;

// ── GET: poll new messages since ?before=<iso-timestamp> ─────────────────

export async function GET(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { threadId } = await params;
  const thread = await getThreadById(threadId, userId);
  if (!thread) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const before = url.searchParams.get('before') || undefined;

  const messages = await getMessagesForThread(threadId, userId, 200, before);
  return Response.json({ messages });
}

// ── POST: send a user message + stream assistant reply (via bridge) ──────

interface PostBody {
  content: string;
  file_refs?: string[];
}

function todayLabel(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const userEmail = (session?.user as { email?: string } | undefined)?.email;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { threadId } = await params;
  const thread = await getThreadById(threadId, userId);
  if (!thread) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  // Claude CLI --session-id requires a UUID. Our threads use Supabase
  // UUIDs by default, but belt-and-suspenders:
  if (!isUuid(threadId)) {
    return Response.json(
      { error: 'thread_id must be a UUID (Claude CLI session-id constraint)' },
      { status: 400 }
    );
  }

  let body: PostBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const content = (body.content || '').trim();
  const fileRefs = Array.isArray(body.file_refs) ? body.file_refs : [];
  if (!content && fileRefs.length === 0) {
    return Response.json({ error: 'Empty message' }, { status: 400 });
  }

  // Resolve uploads and build a note the subprocess can use to Read them.
  let uploadNote = '';
  if (fileRefs.length > 0) {
    try {
      const uploads = await getUploadsByIds(fileRefs, threadId);
      if (uploads.length > 0) {
        uploadNote =
          '\n\n[Attached files — use the Read tool to open them:]\n' +
          uploads
            .map(
              (u) =>
                `- ${u.disk_path} (${u.filename}, ${u.content_type}, ${u.size_bytes} bytes)`
            )
            .join('\n');
      }
    } catch {
      // non-fatal — keep going without the note
    }
  }

  const userContent = content + uploadNote;

  // Persist the user message first so the thread UI reflects it
  // regardless of what happens to the bridge call.
  await addMessage(
    threadId,
    'user',
    userContent,
    null,
    null,
    null,
    fileRefs.length > 0 ? fileRefs : null
  );

  // Determine is_first_turn: if this thread has any prior assistant
  // messages, Claude CLI should --resume; otherwise --session-id.
  // NOTE: threads with history from the old Anthropic-API path will
  // currently resume into a claude session that has NO memory of those
  // prior turns (they were never fed to claude). JD can start a fresh
  // thread if continuity matters for an old thread.
  const history = await getMessagesForThread(threadId, userId, 200);
  const hasPriorAssistant = history.some((m) => m.role === 'assistant');
  const isFirstTurn = !hasPriorAssistant;

  // Base system prompt + per-agent / per-project suffix.
  const baseSystemPrompt = `You are an AI chief-of-staff assistant in the Clawdling cockpit. Today is ${todayLabel()}. Keep replies concise.`;
  const { cwd: defaultCwd, systemPrompt: defaultSystemPrompt } = resolveThreadRuntime(
    thread.kind,
    thread.ref_id,
    baseSystemPrompt,
    thread.project_slug
  );

  // If the thread was created with a snapshotted system_prompt (e.g. a
  // CEO chat scoped to a project — see /api/projects/[slug]/chat/threads),
  // append it AFTER the per-agent persona so the agent's identity stays
  // primary and the project context is the operating environment.
  // For project-scoped agent threads, also point cwd at the project dir
  // so the CLI's Read/Edit tools can hit the files directly.
  const systemPrompt = thread.system_prompt
    ? `${defaultSystemPrompt}\n\n${thread.system_prompt}`
    : defaultSystemPrompt;
  const stateRoot = process.env.ADJUTANT_STATE_ROOT || process.cwd();
  const cwd = thread.project_slug
    ? `${stateRoot.replace(/\/+$/, '')}/projects/${thread.project_slug}`
    : defaultCwd;

  // ── SDK engine path (ADJUTANT_ENGINE=sdk) ────────────────────────
  // Self-host + hosted default: drive the reply directly against the Anthropic
  // Messages API with the user's own ANTHROPIC_API_KEY — no bridge, no CLI.
  // Yields the same SSE event shape the browser already consumes; persists the
  // assistant reply via the same addMessage() path (which routes to the local
  // store in ADJUTANT_STATE=local).
  if (process.env.ADJUTANT_ENGINE === 'sdk') {
    // ── Key + usage gate (docs/SPEC-BYOK.md) ───────────────────────
    // Two models:
    //   PRODUCTION (paid, ADJUTANT_BYOK unset): runs on OUR company key
    //     (env ANTHROPIC_API_KEY). Customers pay us; they never supply a key.
    //     A per-customer usage cap protects our bill.
    //   BYOK / SELF-HOST (ADJUTANT_BYOK=1): the user supplies their own key;
    //     the cap protects THEIR spend.
    // The usage cap applies via ADJUTANT budget settings (see user-settings).

    let userKey: string | undefined;
    let userModel: string | undefined;
    let userEffort: string | undefined;
    const settings = await getUserSettings(userId);
    if (byokEnabled()) {
      if (!settings.hasKey) {
        return Response.json(
          { error: 'no_key', message: 'Add your Anthropic API key in Settings to start chatting.' },
          { status: 402 }
        );
      }
      userKey = (await getUserApiKey(userId)) || undefined;
      if (!userKey) {
        return Response.json({ error: 'no_key', message: 'Could not read your API key. Re-add it in Settings.' }, { status: 402 });
      }
    }
    // Per-customer / per-user usage cap (protects our key in production; their key in BYOK).
    if (await isOverBudget(userId, settings.budgetUsd)) {
      return Response.json(
        { error: 'budget_exceeded', message: byokEnabled()
            ? 'Monthly budget reached. Raise it in Settings to continue.'
            : 'You have reached this month’s included usage. It resets next month.' },
        { status: 402 }
      );
    }
    userModel = settings.model || undefined;
    userEffort = settings.effort || undefined;

    // Full conversation as Anthropic messages. `history` already includes the
    // user turn we just persisted. Drop non-user/assistant rows and any leading
    // assistant turns so the sequence starts with a user message.
    let engineMessages: EngineMessage[] = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content || '' }))
      .filter((m) => m.content.trim().length > 0);
    while (engineMessages.length && engineMessages[0].role === 'assistant') {
      engineMessages = engineMessages.slice(1);
    }
    if (engineMessages.length === 0) {
      engineMessages = [{ role: 'user', content: userContent }];
    }

    const encoder = new TextEncoder();
    const sdkStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: Record<string, unknown>): void => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };
        let assistantText = '';
        try {
          for await (const ev of streamTurn({
            system: systemPrompt,
            messages: engineMessages,
            userId,
            apiKey: userKey,
            model: userModel,
            effort: userEffort,
          })) {
            if (ev.type === 'text') {
              assistantText += ev.text;
              send({ type: 'text', text: ev.text });
            } else if (ev.type === 'usage') {
              // Meter per-user cost; do NOT forward token counts to the browser.
              void recordUsage(userId, ev.model, ev.tokensIn, ev.tokensOut);
            } else {
              // thinking_start / thinking / thinking_end / error pass through
              send(ev as unknown as Record<string, unknown>);
            }
          }
          if (assistantText.trim().length > 0) {
            try {
              const saved = await addMessage(threadId, 'assistant', assistantText);
              send({ type: 'done', message_id: saved.id });
            } catch (err) {
              send({ type: 'error', error: `persist failed: ${String(err)}` });
            }
          } else {
            send({ type: 'error', error: 'Engine returned no assistant text.' });
          }
        } catch (err) {
          send({ type: 'error', error: String(err) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(sdkStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }

  // ── Forward to bridge ────────────────────────────────────────────
  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      '/api/chat/turn',
      {
        method: 'POST',
        body: JSON.stringify({
          thread_id: threadId,
          message: userContent,
          is_first_turn: isFirstTurn,
          cwd,
          system_prompt: systemPrompt,
          kind: thread.kind,
          ref_id: thread.ref_id,
        }),
      },
      userId,
      userEmail || 'unknown@local'
    );
  } catch (err) {
    return Response.json(
      { error: `Failed to reach Mac Mini bridge: ${String(err)}` },
      { status: 502 }
    );
  }

  if (!bridgeRes.ok) {
    const errorText = await bridgeRes.text().catch(() => '');
    return Response.json(
      {
        error: `Bridge error: ${bridgeRes.status} — ${errorText.slice(0, 500)}`,
      },
      { status: 502 }
    );
  }

  // ── Translate bridge SSE → UI-expected SSE ───────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = bridgeRes.body?.getReader();
      if (!reader) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'error', error: 'Bridge returned no body' })}\n\n`
          )
        );
        controller.close();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      // Track whether the model did *anything* (tool calls, thinking, etc.)
      // so we can distinguish "model crashed before doing anything" from
      // "model ran tools but never emitted a final reply" — the second case
      // gets a clearer message than the generic empty-stream error.
      let toolCalls = 0;
      let exitCode: number | null = null;
      // Cockpit-v1 Phase 2: the bridge mints a per-turn external_id and
      // sends it in an `init` event before any text deltas. We mirror the
      // value into the UPSERT below so the bridge's server-side write and
      // this frontend write collapse to a single chat_messages row even
      // during the shadow-write window.
      let externalId: string | null = null;
      // Map content-block index -> type ("thinking" | "tool_use" | ...). Used
      // on content_block_stop to know which block ended (the stop event itself
      // doesn't carry the type).
      const blockTypes: Record<number, string> = {};

      function send(payload: Record<string, unknown>): void {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            // Bridge SSE emits:
            //   event: <type>
            //   data: {...json...}
            // followed by a blank line. We only care about `data:` lines
            // since the data JSON itself contains a `type` field.
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;

            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(data);
            } catch {
              continue;
            }

            const t = evt.type as string | undefined;

            // Bridge emits `heartbeat` events every ~10s during long agent
            // turns to keep the bridge↔Vercel hop's idle-write timer alive.
            // Without forwarding to the browser, segment 2 (Vercel↔CF↔
            // browser) idles out at ~100s and surfaces as a CF 524.
            //
            // We forward as an SSE comment line (`:` prefix) — browsers
            // parse and discard, so no consumer change is needed, but CF
            // sees bytes flow and keeps the connection open.
            // See ~/clawd/runbooks/cloudflare-tunnel-keepalive.md.
            if (t === 'heartbeat') {
              const ts = (evt as { ts?: unknown }).ts;
              controller.enqueue(
                encoder.encode(`: keepalive ${ts ?? ''}\n\n`)
              );
              continue;
            }

            // Bridge `init` event: capture external_id for the upsert.
            if (t === 'init') {
              const eid = (evt as { external_id?: unknown }).external_id;
              if (typeof eid === 'string' && eid.length > 0) {
                externalId = eid;
              }
              continue;
            }

            // Pass through exit events as final signals. Bridge also stamps
            // external_id here as a belt-and-suspenders for clients that
            // missed the init event (e.g. mid-stream reconnects).
            if (t === 'exit') {
              const code = (evt as { code?: unknown }).code;
              if (typeof code === 'number') exitCode = code;
              if (!externalId) {
                const eid = (evt as { external_id?: unknown }).external_id;
                if (typeof eid === 'string' && eid.length > 0) {
                  externalId = eid;
                }
              }
              continue;
            }

            // Defensive fallback: bridge sometimes emits SSE error/exit
            // events before the type-stamping fix landed. If we see an
            // `error` field with no usable type, surface it directly so
            // the user sees the real cause instead of "empty stream".
            if (t === 'error' || (!t && typeof evt.error === 'string')) {
              const errMsg = String(evt.error || 'bridge error');
              const exitFromErr = (evt as { exit_code?: unknown }).exit_code;
              if (typeof exitFromErr === 'number') exitCode = exitFromErr;
              send({ type: 'error', error: errMsg });
              // Don't break — the stream may still emit a useful exit
              // code event after this. Just record it.
              continue;
            }

            if (t === 'stream_event') {
              const inner = (evt.event || {}) as Record<string, unknown>;
              const innerType = inner.type as string | undefined;

              if (innerType === 'content_block_start') {
                const cb = (inner.content_block || {}) as Record<string, unknown>;
                const idx = inner.index as number | undefined;
                if (cb.type === 'tool_use') {
                  toolCalls += 1;
                  if (typeof idx === 'number') blockTypes[idx] = 'tool_use';
                  send({
                    type: 'tool_use_start',
                    id: cb.id,
                    name: cb.name,
                  });
                } else if (cb.type === 'thinking') {
                  // Claude Code redacts thinking text in --print mode (only
                  // the signature streams), so we can't show content. We
                  // instead surface activity: thinking_start now, thinking_end
                  // on the matching content_block_stop. The client renders a
                  // live "thinking… Xs" indicator.
                  if (typeof idx === 'number') blockTypes[idx] = 'thinking';
                  send({ type: 'thinking_start' });
                } else if (typeof idx === 'number') {
                  blockTypes[idx] = (cb.type as string) || 'unknown';
                }
              } else if (innerType === 'content_block_delta') {
                const delta = (inner.delta || {}) as Record<string, unknown>;
                const deltaType = delta.type as string | undefined;
                if (deltaType === 'text_delta' && typeof delta.text === 'string') {
                  assistantText += delta.text;
                  send({ type: 'text', text: delta.text });
                } else if (
                  deltaType === 'thinking_delta' &&
                  typeof delta.thinking === 'string' &&
                  delta.thinking.length > 0
                ) {
                  // Future-proofing: if a future Claude Code build streams
                  // real thinking text, surface it. Today this never fires.
                  send({ type: 'thinking', text: delta.thinking });
                }
                // signature_delta + input_json_delta intentionally ignored.
              } else if (innerType === 'content_block_stop') {
                const idx = inner.index as number | undefined;
                const blockType =
                  typeof idx === 'number' ? blockTypes[idx] : undefined;
                if (blockType === 'tool_use') {
                  send({ type: 'tool_use_end' });
                } else if (blockType === 'thinking') {
                  send({ type: 'thinking_end' });
                }
                // text blocks: nothing to do; deltas already streamed.
              }
              // message_start / message_delta / message_stop: silent.
            } else if (t === 'assistant') {
              // Final assistant message. If deltas were missed (e.g. the
              // bridge batched output), use this as the authoritative text.
              const msg = (evt.message || {}) as Record<string, unknown>;
              const blocks = Array.isArray(msg.content)
                ? (msg.content as Array<Record<string, unknown>>)
                : [];
              let full = '';
              for (const blk of blocks) {
                if (blk.type === 'text' && typeof blk.text === 'string') {
                  full += blk.text;
                }
              }
              if (full.length > assistantText.length) {
                assistantText = full;
              }
            } else if (t === 'result') {
              // `result` may also contain the full result string.
              const r = evt.result;
              if (typeof r === 'string' && r.length > assistantText.length) {
                assistantText = r;
              }
            }
            // 'system' init event: ignore.
          }
        }

        // Persist the assistant reply once the stream ends.
        // Cockpit-v1 Phase 2: UPSERT on external_id so the bridge's
        // server-side write (which fires regardless of whether this
        // frontend stream stayed alive) and this write collapse to a
        // single row. If externalId is null (legacy bridge / failed init
        // parse), fall back to a plain insert — duplication risk is the
        // pre-Phase-2 status quo.
        if (assistantText.trim().length > 0) {
          try {
            const saved = externalId
              ? await upsertAssistantMessage(
                  threadId,
                  assistantText,
                  externalId
                )
              : await addMessage(threadId, 'assistant', assistantText);
            send({ type: 'done', message_id: saved.id });
          } catch (err) {
            send({ type: 'error', error: `persist failed: ${String(err)}` });
          }
        } else {
          // No text came through. Distinguish three cases so the message is
          // actually actionable instead of always showing "empty stream":
          //   - Tools ran, claude exited 0 → it did work but never spoke. Tell
          //     the user explicitly + suggest re-asking for a summary.
          //   - Claude exited non-zero → the subprocess errored.
          //   - Nothing happened at all → stream-translation miss / bridge died.
          let msg: string;
          if (toolCalls > 0 && (exitCode === 0 || exitCode === null)) {
            msg = `Claude ran ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} but didn't reply with text. Ask "what did you find?" to get a summary.`;
          } else if (exitCode !== null && exitCode !== 0) {
            msg = `Claude exited with code ${exitCode}. Check bridge audit log for stderr.`;
          } else {
            msg = 'Bridge returned no assistant text (empty stream). Bridge may have died mid-turn.';
          }
          send({ type: 'error', error: msg });
        }
      } catch (err) {
        send({ type: 'error', error: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
