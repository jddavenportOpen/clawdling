// NextAuth v5 route handler — wires GET + POST to the config in src/auth.ts.
// Next 16 App Router: handlers are exported directly.

import { handlers } from '@/auth';

export const { GET, POST } = handlers;

// Force Node runtime: the Supabase adapter needs Node APIs (Edge would fail).
export const runtime = 'nodejs';
