// Mock mode (default): start the in-memory server on a free port and hand its
// URL + token to the workers through the environment. Real mode: the caller
// already set CLAWDLING_E2E_URL and CLAWDLING_E2E_TOKEN; we only check them.
import { startMockServer } from './mock-server.mjs';

export default async function globalSetup() {
  if (process.env.CLAWDLING_E2E_URL) {
    if (!process.env.CLAWDLING_E2E_TOKEN) {
      throw new Error('CLAWDLING_E2E_URL is set but CLAWDLING_E2E_TOKEN is not. Use the token from <home>/.clawdling/token.');
    }
    process.env.CLAWDLING_E2E_MODE = 'real';
    const res = await fetch(new URL('/api/health', process.env.CLAWDLING_E2E_URL)).catch((e) => ({ ok: false, statusText: e.message }));
    if (!res.ok) throw new Error(`Real server at ${process.env.CLAWDLING_E2E_URL} did not answer /api/health: ${res.statusText}`);
    return undefined;
  }
  const srv = await startMockServer({ port: 0, fixture: 'default' });
  process.env.CLAWDLING_E2E_URL = srv.url;
  process.env.CLAWDLING_E2E_TOKEN = srv.token;
  process.env.CLAWDLING_E2E_MODE = 'mock';
  return async () => { await srv.close(); };
}
