import { getServerClient } from '@/lib/supabase';
import { createProject, slugify, type ProjectInput } from '@/lib/projects';
import { readFile } from 'fs/promises';
import { join } from 'path';

export const dynamic = 'force-dynamic';

// Root under which per-project state (PRD / WORKPLAN / README) lives. A
// self-hoster points ADJUTANT_STATE_ROOT at their own data dir; the projects
// subtree mirrors $ADJUTANT_STATE_ROOT/projects/<slug>/. (see docs/ARCHITECTURE.md)
const PROJECTS_ROOT = join(process.env.ADJUTANT_STATE_ROOT || './.adjutant', 'projects');

// Load project-status.json snapshot (written every 15 min by project_status_sync.py).
// Returns a map keyed by slug → { progress, last_ship, stalled } or {} on miss.
async function loadStatusSnapshot(): Promise<Record<string, {
  progress?: { pct: number; done: number; total: number; no_workplan?: boolean };
  last_ship?: { at: string; title: string } | null;
  recent_ships?: { at: string; title: string }[];
  stalled?: boolean;
  stalled_days?: number;
}>> {
  try {
    const p = join(process.cwd(), 'src', 'data', 'project-status.json');
    const raw = await readFile(p, 'utf-8');
    const doc = JSON.parse(raw);
    return doc.projects || {};
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  try {
    const statusBySlug = await loadStatusSnapshot();
    const supabase = getServerClient();
    const domainParam = new URL(request.url).searchParams.get('domain');
    let query = supabase
      .from('projects')
      .select('*')
      .order('last_activity', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });

    if (domainParam && domainParam.length > 0) {
      query = query.eq('domain', domainParam);
    }

    const { data: rows, error } = await query;

    if (error) {
      return Response.json(
        { error: error.message, source: 'supabase' },
        { status: 500 }
      );
    }

    const projects = (rows || []).map(
      (row: Record<string, unknown>, index: number) => {
        const slug = (row.slug as string) || (row.id as string);
        const folderPath = (row.folder_path as string) || (row.path as string) || null;
        const repoUrl = (row.repo_url as string) || null;
        const deployedUrl = (row.deployed_url as string) || (row.url as string) || null;
        // Has PRD/WORKPLAN content been synced from disk?
        const hasPrd = typeof row.prd_content === 'string' && (row.prd_content as string).length > 100;
        const hasWorkplan = typeof row.workplan_content === 'string' && (row.workplan_content as string).length > 100;
        const hasReadme = typeof row.readme_content === 'string' && (row.readme_content as string).length > 100;
        // Real-progress data from project-status-sync.
        const statusData = statusBySlug[slug] || {};
        const progress = statusData.progress || null;
        const lastShip = statusData.last_ship || null;
        const stalled = statusData.stalled === true;
        const stalledDays = statusData.stalled_days ?? 0;
        return {
          id: row.id as string,
          slug,
          name: (row.name as string) || (row.id as string),
          status: ((row.status as string) || 'active').toLowerCase(),
          phase: (row.phase as string) || null,
          // NEW: real progress (replaces the manual "phase" string for % display)
          progress,           // { pct, done, total } | null
          last_ship: lastShip, // { at, title } | null
          recent_ships: statusData.recent_ships || [],
          stalled,
          stalled_days: stalledDays,
          domain: (row.domain as string) || null,
          repo: repoUrl,
          github: repoUrl,                 // alias for older UI consumers
          deployed_url: deployedUrl,
          url: deployedUrl,                // alias for older UI consumers
          // Provide path pointers + content-presence flags so detail page can
          // load the body via /api/projects/[id]/detail.
          folder_path: folderPath,
          path: folderPath,
          has_prd: hasPrd,
          has_workplan: hasWorkplan,
          has_readme: hasReadme,
          prd: hasPrd ? join(PROJECTS_ROOT, slug, 'PRD.md') : null,
          workplan: hasWorkplan ? join(PROJECTS_ROOT, slug, 'WORKPLAN.md') : null,
          readme: hasReadme ? join(PROJECTS_ROOT, slug, 'README.md') : null,
          next_milestone: (row.next_action as string) || (row.next_milestone as string) || null,
          blockers:
            typeof row.blockers === 'string' && (row.blockers as string).length > 0
              ? (row.blockers as string).split('\n')
              : [],
          owner: (row.owner as string) || null,
          order: index,
          description: (row.description as string) || null,
        };
      }
    );

    const active = projects.filter(
      (p: { status: string }) => p.status === 'active'
    ).length;
    const paused = projects.filter(
      (p: { status: string }) =>
        p.status === 'paused' || p.status === 'planning'
    ).length;
    const complete = projects.filter(
      (p: { status: string }) =>
        p.status === 'complete' || p.status === 'archived'
    ).length;

    return Response.json({
      data: {
        projects,
        active,
        paused,
        complete,
      },
    });
  } catch (err) {
    return Response.json(
      { error: String(err), source: 'supabase' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ProjectInput;

    if (
      !body.name ||
      typeof body.name !== 'string' ||
      body.name.trim().length === 0
    ) {
      return Response.json(
        { error: 'Project name is required' },
        { status: 400 }
      );
    }

    const validStatuses = [
      'planning',
      'active',
      'paused',
      'complete',
      'archived',
    ];
    if (body.status && !validStatuses.includes(body.status)) {
      return Response.json(
        {
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        },
        { status: 400 }
      );
    }

    const project = await createProject(body);

    return Response.json(
      {
        data: {
          id: slugify(project.name),
          ...project,
        },
        message: `Project "${project.name}" created`,
      },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('already exists') ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
}
