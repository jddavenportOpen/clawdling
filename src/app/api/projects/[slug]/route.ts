import { updateProject, deleteProject, hardDeleteProject, slugify, type ProjectInput } from '@/lib/projects';
import { getServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// QA Bug #4 (2026-04-30): this used to live at api/projects/[id]/route.ts
// alongside api/projects/[slug]/chat/threads — Next.js 16 refuses to start
// dev server when the same dynamic path segment uses two different param
// names ('id' !== 'slug'). Resolved by renaming `[id]` → `[slug]` here. The
// behavior is unchanged: the path param accepts either a slug or a uuid.

// GET — full project dossier (PRD/WORKPLAN/README content) for the [slug] page.
// Added 2026-04-18 — was missing entirely; the dossier page was 404'ing the
// content fetch and rendering empty.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug: slugOrId } = await params;
    const supabase = getServerClient();
    // slugOrId may be a slug or a uuid — try slug first (the new schema), fallback to id col
    const { data: row, error } = await supabase
      .from('projects')
      .select('*')
      .or(`slug.eq.${slugOrId},id.eq.${slugOrId}`)
      .maybeSingle();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!row) {
      return Response.json({ error: 'project not found' }, { status: 404 });
    }

    const slug = row.slug || row.id;
    const repo = row.repo_url || null;
    const deployed = row.deployed_url || row.url || null;

    return Response.json({
      data: {
        id: row.id,
        slug,
        name: row.name,
        status: (row.status || 'active').toLowerCase(),
        phase: row.phase || null,
        domain: row.domain || null,
        owner: row.owner || null,
        path: row.folder_path || row.path || null,
        repo,
        github: repo,
        deployed_url: deployed,
        url: deployed,
        next_milestone: row.next_action || row.next_milestone || null,
        description: row.description || null,
        // Full markdown bodies (synced from disk every 15m by sync-project-registry.sh)
        readme: row.readme_content || '',
        prd: row.prd_content || '',
        workplan: row.workplan_content || '',
        // Helpful metadata
        last_activity: row.last_activity || row.updated_at || null,
        blockers: row.blockers
          ? String(row.blockers).split('\n').filter((l: string) => l.trim().length > 0)
          : [],
      },
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug: slugOrId } = await params;
    const body = (await request.json()) as Partial<ProjectInput>;

    if (body.status) {
      const validStatuses = ['planning', 'active', 'paused', 'complete', 'archived'];
      if (!validStatuses.includes(body.status)) {
        return Response.json(
          { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
          { status: 400 }
        );
      }
    }

    const project = await updateProject(slugOrId, body);

    return Response.json({
      data: {
        id: slugify(project.name),
        ...project,
      },
      message: `Project "${project.name}" updated`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug: slugOrId } = await params;

    // Check for ?hard=true query param for permanent deletion
    const url = new URL(request.url);
    const hard = url.searchParams.get('hard') === 'true';

    const project = hard
      ? await hardDeleteProject(slugOrId)
      : await deleteProject(slugOrId);

    return Response.json({
      data: {
        id: slugify(project.name),
        ...project,
      },
      message: hard
        ? `Project "${project.name}" permanently deleted`
        : `Project "${project.name}" archived`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}
