import { DOMAINS } from '@/config/domains';

export const dynamic = 'force-dynamic';

// GET /api/domains — the configured domains for this install.
//
// Serves the starter domains from src/config/domains.ts. A future release
// will resolve this from the active profile (ADJUTANT_PROFILE); for now it
// is the compiled starter set.
export async function GET() {
  return Response.json({
    data: { domains: DOMAINS },
    generated_at: new Date().toISOString(),
    source: 'config',
  });
}
