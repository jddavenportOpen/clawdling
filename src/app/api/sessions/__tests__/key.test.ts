// ═══════════════════════════════════════════════════════════════════════════
// [sid]/key (POST) — raw keystroke send, against a MOCKED bridge.
//
// Why this route exists: Claude Code drives its permission prompts, plan mode
// and AskUserQuestion as arrow-key menus. Answering one needs bare
// Up/Down/digit/Enter bytes with no "\r" appended, which /input's submit path
// cannot express. SessionTerminal.sendKey and AskUserQuestionCard both POST
// `{key?, bytes?}` here.
//
// Pins:
//   - named keys resolve to the ESCAPE SEQUENCE a terminal expects, not the
//     literal word ("down" must become \x1b[B, never the text "down")
//   - `bytes` passes through verbatim and wins over `key`
//   - a single printable character is a valid `key`
//   - an unknown multi-char key is a 400, not silently typed into the pane
//   - always forwards {data} to the bridge (the key the Python half takes)
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bridge-jwt', () => ({ signBridgeJWT: async () => 'test.jwt.token' }));
const mockAuth = vi.fn();
vi.mock('@/lib/auth-timeout', () => ({ authWithTimeout: () => mockAuth() }));

import { POST as keyPOST } from '../[sid]/key/route';

const AUTHED = { user: { id: 'user-1', email: 'jd@example.com' } };
const sidParams = (sid: string) => ({ params: Promise.resolve({ sid }) });
const req = (body: unknown) =>
  new Request('http://localhost/api/sessions/s1/key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Capture what got forwarded to the bridge. */
function spyBridge() {
  const spy = vi.fn(async () => ok());
  vi.stubGlobal('fetch', spy as unknown as typeof fetch);
  return spy;
}
const sentData = (spy: ReturnType<typeof spyBridge>) =>
  JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string).data;

beforeEach(() => { vi.restoreAllMocks(); mockAuth.mockReset(); mockAuth.mockResolvedValue(AUTHED); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('POST /api/sessions/[sid]/key', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await keyPOST(req({ key: 'up' }), sidParams('s1'))).status).toBe(401);
  });

  it.each([
    ['up', '\x1b[A'],
    ['down', '\x1b[B'],
    ['enter', '\r'],
    ['escape', '\x1b'],
    ['ctrl-c', '\x03'],
  ])('resolves named key %s to its escape sequence', async (name, bytes) => {
    const spy = spyBridge();
    const res = await keyPOST(req({ key: name }), sidParams('s1'));
    expect(res.status).toBe(200);
    expect(sentData(spy)).toBe(bytes);
  });

  it('never forwards the literal key NAME', async () => {
    const spy = spyBridge();
    await keyPOST(req({ key: 'down' }), sidParams('s1'));
    expect(sentData(spy)).not.toBe('down');
  });

  it('passes bytes through verbatim and prefers them over key', async () => {
    const spy = spyBridge();
    await keyPOST(req({ bytes: '2', key: 'up' }), sidParams('s1'));
    expect(sentData(spy)).toBe('2');
  });

  it('accepts a single printable character as key', async () => {
    const spy = spyBridge();
    await keyPOST(req({ key: '1' }), sidParams('s1'));
    expect(sentData(spy)).toBe('1');
  });

  it('400s an unknown multi-char key instead of typing it into the pane', async () => {
    const spy = spyBridge();
    const res = await keyPOST(req({ key: 'frobnicate' }), sidParams('s1'));
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('400s when neither key nor bytes is given', async () => {
    expect((await keyPOST(req({}), sidParams('s1'))).status).toBe(400);
  });

  it('reports an unreachable bridge clearly rather than hanging', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), { code: 'ECONNREFUSED' }),
      });
    }) as unknown as typeof fetch);
    const res = await keyPOST(req({ key: 'up' }), sidParams('s1'));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(await res.json()).toLowerCase()).toMatch(/bridge/);
  });
});
