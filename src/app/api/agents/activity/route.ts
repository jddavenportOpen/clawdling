import { getServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('id');

  try {
    const supabase = getServerClient();
    const { data, error } = await supabase
      .from('agent_heartbeats')
      .select('*')
      .limit(1)
      .single();

    if (error) {
      return Response.json(
        { error: error.message, agents: {} },
        { status: 500 }
      );
    }

    if (!data) {
      return Response.json({ agents: {}, generated_at: null });
    }

    // The heartbeats row stores an 'agents' jsonb field with the full activity map
    const activity = {
      agents: data.agents ?? {},
      generated_at: data.generated_at ?? data.updated_at,
    };

    if (agentId) {
      const agents = activity.agents as Record<string, unknown>;
      const agent = agents[agentId];
      if (!agent) {
        return Response.json(
          { error: `Agent ${agentId} not found` },
          { status: 404 }
        );
      }
      return Response.json({
        agent,
        generated_at: activity.generated_at,
      });
    }

    return Response.json(activity);
  } catch (err) {
    return Response.json(
      { error: String(err), agents: {} },
      { status: 500 }
    );
  }
}
