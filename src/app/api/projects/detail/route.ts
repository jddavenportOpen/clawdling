import { getServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name');

    if (!name) {
      return Response.json(
        { error: 'Missing ?name= parameter' },
        { status: 400 }
      );
    }

    const supabase = getServerClient();

    // Try matching by name (case-insensitive) or by id (slug)
    const { data: rows, error } = await supabase
      .from('projects')
      .select('*')
      .or(`name.ilike.${name},id.eq.${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`)
      .limit(1);

    if (error) {
      return Response.json(
        { error: error.message, source: 'supabase' },
        { status: 500 }
      );
    }

    if (!rows || rows.length === 0) {
      return Response.json(
        { error: `Project "${name}" not found` },
        { status: 404 }
      );
    }

    const project = rows[0];

    return Response.json({
      data: {
        name: project.name,
        prd: project.prd_content || null,
        workplan: project.workplan_content || null,
      },
    });
  } catch (err) {
    return Response.json(
      { error: String(err), source: 'supabase' },
      { status: 500 }
    );
  }
}
