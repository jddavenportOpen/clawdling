// ═══════════════════════════════════════════════════════════════════════════
// domains.ts — the engine's domain list (profile-driven, with a compiled
// starter fallback).
//
// A "domain" is a scoped area of your AI OS — a bundle of a chat agent, tasks,
// and a dashboard. Everything that needs the domain list (the /chat domain
// picker, the per-domain chat button, the "Launch all" control) imports from
// here.
//
// SOURCE OF TRUTH is the active profile's domains.yaml:
//   profiles/<ADJUTANT_PROFILE || 'starter'>/domains.yaml
// It is loaded once, server-side, at build/boot. If that file is absent or
// invalid — or when this module is evaluated in the browser bundle, where the
// filesystem isn't available — we fall back to the three compiled STARTER
// domains below, so the cockpit always boots with a usable shell.
//
// NOTE (honest scope): client components import the compiled `DOMAINS` value.
// The server resolves it from the profile file; the shipped `starter` profile's
// domains.yaml is identical to STARTER_DOMAINS, so there is no divergence. A
// custom profile that differs from the compiled fallback is picked up by
// server consumers (e.g. GET /api/domains) at boot; a future release will hydrate
// the client picker from that endpoint so custom domains render without a
// recompile.
// ═══════════════════════════════════════════════════════════════════════════

export interface DomainDef {
  /** Canonical id — stable slug used in URLs and state keys. */
  id: string;
  /** Human label for buttons / pane titles. */
  label: string;
  /** Accent hex, matched to the domain dashboard. */
  color: string;
  /** One-line description of what the domain agent owns. */
  blurb: string;
}

/** The compiled starter domains — the fallback when no profile file loads. */
export const STARTER_DOMAINS: DomainDef[] = [
  { id: 'work', label: 'Work', color: '#6366F1', blurb: 'Projects, tasks, and deadlines' },
  { id: 'personal', label: 'Personal', color: '#F5A623', blurb: 'Life admin, errands, and one-off todos' },
  { id: 'notes', label: 'Notes', color: '#22C55E', blurb: 'Memory, recall, and reference notes' },
];

/**
 * Load the active profile's domains.yaml, server-side only. Returns null (→ use
 * the compiled fallback) in the browser bundle, when the file is missing, or on
 * any parse/validation error. Exported for unit testing.
 */
export function loadProfileDomains(profileName?: string): DomainDef[] | null {
  // Browser bundle: no filesystem. Use the compiled fallback.
  if (typeof window !== 'undefined') return null;
  try {
    // Resolve Node's require WITHOUT a static import, so the client bundle never
    // tries to resolve node:fs (webpack would fail the build). In the browser
    // `require` is undefined and we bail to the fallback above anyway.
    const req = Function(
      'return typeof require !== "undefined" ? require : undefined'
    )() as NodeRequire | undefined;
    if (!req) return null;

    const fs = req('node:fs') as typeof import('node:fs');
    const path = req('node:path') as typeof import('node:path');
    const YAML = req('yaml') as typeof import('yaml');

    const profile = profileName || process.env.ADJUTANT_PROFILE || 'starter';
    const file = path.join(process.cwd(), 'profiles', profile, 'domains.yaml');
    if (!fs.existsSync(file)) return null;

    const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const rows =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { domains?: unknown }).domains)
        ? ((parsed as { domains: unknown[] }).domains)
        : null;
    if (!rows) return null;

    const out: DomainDef[] = [];
    for (const r of rows) {
      if (
        r && typeof r === 'object' &&
        typeof (r as DomainDef).id === 'string' &&
        typeof (r as DomainDef).label === 'string' &&
        typeof (r as DomainDef).color === 'string' &&
        typeof (r as DomainDef).blurb === 'string'
      ) {
        const d = r as DomainDef;
        out.push({ id: d.id, label: d.label, color: d.color, blurb: d.blurb });
      }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** The active domain list: profile-driven, compiled-starter fallback. */
export const DOMAINS: DomainDef[] = loadProfileDomains() ?? STARTER_DOMAINS;

/** Set of canonical domain ids — defense-in-depth validation. */
export const DOMAIN_IDS = new Set(DOMAINS.map((d) => d.id));

export function getDomain(id: string): DomainDef | undefined {
  return DOMAINS.find((d) => d.id === id);
}
