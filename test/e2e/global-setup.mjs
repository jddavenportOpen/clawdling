// Three ways to run the cockpit E2E suite:
//   default                    the in-memory mock (test/e2e/mock-server.mjs) on a free port
//   CLAWDLING_E2E_REAL=1       boot the real server from this repo in test mode (fake claude,
//                              private tmux socket, temp home), run, tear it all down
//   CLAWDLING_E2E_URL + _TOKEN an already-running real server (yours); the suite only adds its
//                              own sessions and never configures channels unless
//                              CLAWDLING_E2E_ALLOW_CHANNELS=1
import { startMockServer } from './mock-server.mjs';
import { startRealServer } from './real-server.mjs';

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
  if (process.env.CLAWDLING_E2E_REAL === '1') {
    const srv = await startRealServer();
    process.env.CLAWDLING_E2E_URL = srv.url;
    process.env.CLAWDLING_E2E_TOKEN = srv.token;
    process.env.CLAWDLING_E2E_MODE = 'real';
    process.env.CLAWDLING_E2E_OWNED = '1';
    process.env.CLAWDLING_E2E_ALLOW_CHANNELS = '1'; // Telegram points at a dead local port
    return async () => { await srv.close(); };
  }
  const srv = await startMockServer({ port: 0, fixture: 'default' });
  process.env.CLAWDLING_E2E_URL = srv.url;
  process.env.CLAWDLING_E2E_TOKEN = srv.token;
  process.env.CLAWDLING_E2E_MODE = 'mock';
  return async () => { await srv.close(); };
}
