import { NextRequest } from "next/server";
import { getServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/agents/stream
 *
 * Receives agent activity events from the nerve-stream MCP server.
 * Stores them in the Supabase `agent_stream` table.
 */
export async function POST(request: NextRequest) {
  let event: Record<string, unknown>;

  try {
    event = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Malformed JSON body" },
      { status: 400 }
    );
  }

  if (!event || typeof event !== "object") {
    return Response.json(
      { success: false, error: "Body must be a JSON object" },
      { status: 400 }
    );
  }

  if (!event.runId || !event.data) {
    return Response.json(
      { success: false, error: "Missing required fields: runId, data" },
      { status: 400 }
    );
  }

  const data = event.data as Record<string, unknown>;

  const row = {
    run_id: event.runId as string,
    seq: (event.seq as number) ?? null,
    stream: (event.stream as string) ?? null,
    ts: (event.ts as number) ?? null,
    session_key: (event.sessionKey as string) ?? null,
    agent_id: (event.sessionKey as string) ?? (event.runId as string),
    tool_name: (data.name as string) ?? null,
    tool_call_id: (data.toolCallId as string) ?? null,
    phase: (data.phase as string) ?? null,
    status:
      data.phase === "start"
        ? "started"
        : data.success === false
          ? "error"
          : "completed",
    args: data.args ? JSON.parse(JSON.stringify(data.args)) : null,
    result: (data.result as string) ?? null,
    received_at: new Date().toISOString(),
  };

  const supabase = getServerClient();
  const { error } = await supabase.from("agent_stream").insert(row);

  if (error) {
    console.error("Failed to insert stream event:", error);
    return Response.json(
      { success: false, error: "Internal write error" },
      { status: 500 }
    );
  }

  // Prune old events — keep only the most recent 500
  // Find the id threshold
  const { data: cutoff } = await supabase
    .from("agent_stream")
    .select("id")
    .order("id", { ascending: false })
    .range(499, 499)
    .limit(1)
    .single();

  if (cutoff) {
    await supabase
      .from("agent_stream")
      .delete()
      .lt("id", cutoff.id);
  }

  return Response.json({ success: true, seq: event.seq });
}

/**
 * GET /api/agents/stream?limit=50
 *
 * Returns the most recent N events for the dashboard to display.
 */
export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam ?? "50", 10) || 50, 1),
    500
  );

  const supabase = getServerClient();
  const { data, error } = await supabase
    .from("agent_stream")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Reverse so oldest-first (matching previous behavior)
  const events = (data || []).reverse();
  return Response.json({ data: events });
}
