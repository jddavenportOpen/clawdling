// ═══════════════════════════════════════════════════════════════════════════
// Clawdling — Project CRUD Utilities
// Shared helpers for reading/writing project-registry.yaml and syncing Supabase
// ═══════════════════════════════════════════════════════════════════════════

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { parse, stringify } from 'yaml';
import { getServerClient } from './supabase';

// ── Paths ────────────────────────────────────────────────────────────────

export const REGISTRY_PATH =
  process.env.PROJECT_REGISTRY ||
  '/opt/adjutant/clawd/state/project-registry.yaml';

const SNAPSHOT_PATH = resolve(process.cwd(), 'src/data/project-registry.yaml');

// ── Types ────────────────────────────────────────────────────────────────

export interface RawProject {
  name: string;
  status?: string;
  phase?: string;
  repo?: string | null;
  deployed_url?: string | null;
  prd?: string | null;
  workplan?: string | null;
  changelog?: string | null;
  next_milestone?: string | null;
  blockers?: string[];
  owner?: string;
  id?: string;
  type?: string;
  description?: string;
  priority?: number;
  domain?: string | null;
}

export interface RegistryFile {
  projects?: RawProject[];
  domain_agents?: unknown[];
}

export interface ProjectInput {
  name: string;
  status?: string;
  phase?: string;
  repo?: string | null;
  deployed_url?: string | null;
  prd?: string | null;
  workplan?: string | null;
  changelog?: string | null;
  next_milestone?: string | null;
  blockers?: string[];
  owner?: string;
  description?: string;
  priority?: number;
  domain?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Supabase → RegistryFile adapter ─────────────────────────────────────

async function readRegistryFromSupabase(): Promise<RegistryFile> {
  const sb = getServerClient();
  const { data, error } = await sb
    .from('projects')
    .select('*')
    .order('updated_at', { ascending: false });

  if (error) throw error;
  if (!data || data.length === 0) throw new Error('No projects in Supabase');

  const projects: RawProject[] = data.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: (row.name as string) || (row.id as string),
    status: (row.status as string) || 'active',
    phase: (row.phase as string) || undefined,
    repo: (row.repo_url as string) || undefined,
    deployed_url: (row.url as string) || undefined,
    description: (row.description as string) || undefined,
    next_milestone: (row.next_action as string) || undefined,
    blockers: typeof row.blockers === 'string' && (row.blockers as string).length > 0
      ? (row.blockers as string).split('\n')
      : [],
    owner: (row.owner as string) || 'JD',
    domain: (row.domain as string) || null,
  }));

  return { projects };
}

// ── YAML Read / Write ────────────────────────────────────────────────────

export async function readRegistry(): Promise<RegistryFile> {
  // 1. Try local YAML (works on Mac Mini)
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    return parse(raw) as RegistryFile;
  } catch {
    // YAML not available (Vercel or missing file)
  }

  // 2. Try Supabase (authoritative on Vercel)
  try {
    return await readRegistryFromSupabase();
  } catch {
    // Supabase failed too
  }

  // 3. Snapshot YAML baked into the build (last resort)
  const raw = await readFile(SNAPSHOT_PATH, 'utf-8');
  return parse(raw) as RegistryFile;
}

export async function writeRegistry(registry: RegistryFile): Promise<void> {
  // Build the YAML with a header comment
  const header = [
    '# Project Registry — ~/clawd/state/project-registry.yaml',
    '# Statuses: planning, active, paused, complete, archived',
    `# Updated: ${new Date().toISOString().slice(0, 10)}`,
    '',
  ].join('\n');

  const yamlStr = stringify(registry, {
    lineWidth: 120,
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    nullStr: '',
  });

  try {
    await writeFile(REGISTRY_PATH, header + yamlStr, 'utf-8');
  } catch {
    // On Vercel, filesystem writes fail — that's OK,
    // Supabase is the authoritative store on deployed environments
    console.log('[projects] Skipping YAML write (no local filesystem — using Supabase as primary)');
  }
}

// ── Supabase Sync ────────────────────────────────────────────────────────

export async function upsertProjectToSupabase(project: RawProject): Promise<void> {
  const sb = getServerClient();
  const id = slugify(project.name);

  const row = {
    id,
    name: project.name,
    description: project.description || '',
    status: project.status || 'active',
    phase: project.phase || '',
    repo_url: project.repo || null,
    url: project.deployed_url || null,
    prd_content: '',
    workplan_content: '',
    blockers: Array.isArray(project.blockers) ? project.blockers.join('\n') : '',
    next_action: project.next_milestone || '',
    category: project.status || 'active',
    tags: [slugify(project.name)],
    domain: project.domain || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb.from('projects').upsert(row, { onConflict: 'id' });
  if (error) {
    console.error('Supabase upsert error:', error);
    // Non-fatal: YAML is source of truth
  }
}

export async function deleteProjectFromSupabase(name: string): Promise<void> {
  const sb = getServerClient();
  const id = slugify(name);
  const { error } = await sb.from('projects').delete().eq('id', id);
  if (error) {
    console.error('Supabase delete error:', error);
  }
}

// ── CRUD Operations ──────────────────────────────────────────────────────

export async function createProject(input: ProjectInput): Promise<RawProject> {
  const registry = await readRegistry();
  if (!registry.projects) registry.projects = [];

  // Check for duplicate name
  const exists = registry.projects.find(
    (p) => p.name.toLowerCase() === input.name.toLowerCase() && (!p.type || p.type !== 'domain-agent')
  );
  if (exists) {
    throw new Error(`Project "${input.name}" already exists`);
  }

  const project: RawProject = {
    name: input.name,
    status: input.status || 'active',
    phase: input.phase || undefined,
    repo: input.repo || undefined,
    deployed_url: input.deployed_url || undefined,
    prd: input.prd || undefined,
    workplan: input.workplan || undefined,
    changelog: input.changelog || undefined,
    next_milestone: input.next_milestone || undefined,
    blockers: input.blockers || [],
    owner: input.owner || 'JD',
    description: input.description || undefined,
    domain: input.domain ?? null,
  };

  registry.projects.push(project);
  await writeRegistry(registry);
  await upsertProjectToSupabase(project);

  return project;
}

export async function updateProject(
  nameOrSlug: string,
  updates: Partial<ProjectInput>
): Promise<RawProject> {
  const registry = await readRegistry();
  if (!registry.projects) throw new Error('No projects found');

  const slug = nameOrSlug.toLowerCase();
  const idx = registry.projects.findIndex(
    (p) =>
      (!p.type || p.type !== 'domain-agent') &&
      (p.name.toLowerCase() === slug ||
        slugify(p.name) === slug ||
        (p.id && p.id.toLowerCase() === slug))
  );

  if (idx === -1) {
    // Fallback: try direct Supabase update when registry lookup fails
    const sb = getServerClient();
    const { data: row, error: fetchErr } = await sb
      .from('projects')
      .select('*')
      .eq('id', nameOrSlug)
      .single();

    if (fetchErr || !row) {
      throw new Error(`Project "${nameOrSlug}" not found`);
    }

    const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.status !== undefined) { updatePayload.status = updates.status; updatePayload.category = updates.status; }
    if (updates.name !== undefined) updatePayload.name = updates.name;
    if (updates.phase !== undefined) updatePayload.phase = updates.phase;
    if (updates.repo !== undefined) updatePayload.repo_url = updates.repo;
    if (updates.deployed_url !== undefined) updatePayload.url = updates.deployed_url;
    if (updates.next_milestone !== undefined) updatePayload.next_action = updates.next_milestone;
    if (updates.blockers !== undefined) updatePayload.blockers = updates.blockers.join('\n');
    if (updates.description !== undefined) updatePayload.description = updates.description;
    if (updates.domain !== undefined) updatePayload.domain = updates.domain;

    const { error: updateErr } = await sb.from('projects').update(updatePayload).eq('id', nameOrSlug);
    if (updateErr) throw updateErr;

    return { ...row, name: row.name, status: updates.status || row.status } as unknown as RawProject;
  }

  const project = registry.projects[idx];

  // Apply updates (only non-undefined fields)
  if (updates.name !== undefined) project.name = updates.name;
  if (updates.status !== undefined) project.status = updates.status;
  if (updates.phase !== undefined) project.phase = updates.phase;
  if (updates.repo !== undefined) project.repo = updates.repo;
  if (updates.deployed_url !== undefined) project.deployed_url = updates.deployed_url;
  if (updates.prd !== undefined) project.prd = updates.prd;
  if (updates.workplan !== undefined) project.workplan = updates.workplan;
  if (updates.changelog !== undefined) project.changelog = updates.changelog;
  if (updates.next_milestone !== undefined) project.next_milestone = updates.next_milestone;
  if (updates.blockers !== undefined) project.blockers = updates.blockers;
  if (updates.owner !== undefined) project.owner = updates.owner;
  if (updates.description !== undefined) project.description = updates.description;
  if (updates.domain !== undefined) project.domain = updates.domain;

  registry.projects[idx] = project;
  await writeRegistry(registry);
  await upsertProjectToSupabase(project);

  return project;
}

export async function deleteProject(nameOrSlug: string): Promise<RawProject> {
  const registry = await readRegistry();
  if (!registry.projects) throw new Error('No projects found');

  const slug = nameOrSlug.toLowerCase();
  const idx = registry.projects.findIndex(
    (p) =>
      (!p.type || p.type !== 'domain-agent') &&
      (p.name.toLowerCase() === slug ||
        slugify(p.name) === slug ||
        (p.id && p.id.toLowerCase() === slug))
  );

  if (idx === -1) {
    throw new Error(`Project "${nameOrSlug}" not found`);
  }

  const project = registry.projects[idx];

  // Archive instead of hard-delete (safer)
  project.status = 'archived';
  registry.projects[idx] = project;
  await writeRegistry(registry);
  await upsertProjectToSupabase(project);

  return project;
}

export async function hardDeleteProject(nameOrSlug: string): Promise<RawProject> {
  const registry = await readRegistry();
  if (!registry.projects) throw new Error('No projects found');

  const slug = nameOrSlug.toLowerCase();
  const idx = registry.projects.findIndex(
    (p) =>
      (!p.type || p.type !== 'domain-agent') &&
      (p.name.toLowerCase() === slug ||
        slugify(p.name) === slug ||
        (p.id && p.id.toLowerCase() === slug))
  );

  if (idx === -1) {
    throw new Error(`Project "${nameOrSlug}" not found`);
  }

  const [project] = registry.projects.splice(idx, 1);
  await writeRegistry(registry);
  await deleteProjectFromSupabase(project.name);

  return project;
}

export async function reorderProjects(orderedSlugs: string[]): Promise<RawProject[]> {
  const registry = await readRegistry();
  if (!registry.projects) throw new Error('No projects found');

  // Separate domain agents from projects
  const domainAgents = registry.projects.filter((p) => p.type === 'domain-agent');
  const projects = registry.projects.filter((p) => !p.type || p.type !== 'domain-agent');

  // Build a map for fast lookup
  const projectMap = new Map<string, RawProject>();
  for (const p of projects) {
    projectMap.set(slugify(p.name), p);
  }

  // Reorder: put specified slugs first in order, then append any not in the list
  const reordered: RawProject[] = [];
  const placed = new Set<string>();

  for (const slug of orderedSlugs) {
    const p = projectMap.get(slug);
    if (p) {
      reordered.push(p);
      placed.add(slug);
    }
  }

  // Append any projects not in the reorder list (preserve their original order)
  for (const p of projects) {
    if (!placed.has(slugify(p.name))) {
      reordered.push(p);
    }
  }

  // Reconstruct: projects first, then domain agents
  registry.projects = [...reordered, ...domainAgents];
  await writeRegistry(registry);

  return reordered;
}
