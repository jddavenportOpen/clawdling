import { reorderProjects, slugify } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { orderedSlugs?: string[] };

    if (!Array.isArray(body.orderedSlugs) || body.orderedSlugs.length === 0) {
      return Response.json(
        { error: 'orderedSlugs must be a non-empty array of project slug strings' },
        { status: 400 }
      );
    }

    const reordered = await reorderProjects(body.orderedSlugs);

    return Response.json({
      data: reordered.map((p, i) => ({
        id: slugify(p.name),
        name: p.name,
        status: p.status,
        order: i,
      })),
      message: `Reordered ${reordered.length} projects`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
