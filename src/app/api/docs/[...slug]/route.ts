import { promises as fs } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// Docs root — the project's markdown documentation under `docs/`.
//
// `process.cwd()` is the Next.js project root in both `next dev` and
// the serverless function; the bundled `docs/` ships with the
// deployment (see the outputFileTracingIncludes glob in next.config.ts).
const DOCS_ROOT = path.join(process.cwd(), 'docs');

interface DirEntry {
  slug: string;       // joined slug path for routing (no .md)
  name: string;       // display name (file/dir basename)
  kind: 'file' | 'dir';
}

interface DocResponse {
  kind: 'file' | 'dir';
  slug: string[];     // requested slug path
  title: string;
  content?: string;   // markdown body (file mode)
  entries?: DirEntry[]; // children (dir mode)
  mtime?: string;     // last modified ISO
}

/**
 * Resolve a slug array to a real path inside DOCS_ROOT.
 * Returns null if traversal escapes the root.
 *
 * Resolution order:
 *   1. exact match (`<root>/<slug>` is dir or file)
 *   2. `<slug>.md` (file with extension stripped from URL)
 */
async function resolve(slug: string[]): Promise<{ abs: string; isDir: boolean } | null> {
  const joined = path.join(DOCS_ROOT, ...slug);
  const resolved = path.resolve(joined);
  if (!resolved.startsWith(path.resolve(DOCS_ROOT))) {
    return null; // traversal attempt
  }
  try {
    const stat = await fs.stat(resolved);
    return { abs: resolved, isDir: stat.isDirectory() };
  } catch {
    // try with .md suffix
    try {
      const withMd = resolved + '.md';
      const stat = await fs.stat(withMd);
      if (stat.isFile()) return { abs: withMd, isDir: false };
    } catch {
      // fall through
    }
    return null;
  }
}

async function listDir(abs: string, slugPrefix: string[]): Promise<DirEntry[]> {
  const items = await fs.readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    if (item.isDirectory()) {
      entries.push({
        slug: [...slugPrefix, item.name].join('/'),
        name: item.name,
        kind: 'dir',
      });
    } else if (item.isFile() && item.name.endsWith('.md')) {
      const baseName = item.name.replace(/\.md$/, '');
      entries.push({
        slug: [...slugPrefix, baseName].join('/'),
        name: baseName,
        kind: 'file',
      });
    }
  }
  // dirs first, alphabetical
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await context.params;
  const r = await resolve(slug);
  if (!r) {
    return Response.json({ error: 'not found', slug }, { status: 404 });
  }

  const stat = await fs.stat(r.abs);
  const title = slug[slug.length - 1] || 'docs';

  if (r.isDir) {
    const entries = await listDir(r.abs, slug);
    const payload: DocResponse = {
      kind: 'dir',
      slug,
      title,
      entries,
      mtime: stat.mtime.toISOString(),
    };
    return Response.json(payload);
  }

  const content = await fs.readFile(r.abs, 'utf8');
  const payload: DocResponse = {
    kind: 'file',
    slug,
    title,
    content,
    mtime: stat.mtime.toISOString(),
  };
  return Response.json(payload);
}
