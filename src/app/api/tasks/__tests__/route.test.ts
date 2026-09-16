// ═══════════════════════════════════════════════════════════════════════════
// /api/tasks — driven against the REAL local store, not a mock.
//
// This route was repointed (2026-09-16) off @/lib/backlog-db, which reads a
// public.backlog_items_v view that exists in NO migration here and pages with
// .range(), a method @/lib/local-store does not implement — so on the self-host
// default the old route threw, swallowed it, and answered { data: [], _degraded }
// forever. A mocked test would have gone green on that exact bug, so these tests
// use ADJUTANT_STATE=local + a temp state root and seed rows through the agent's
// OWN create_task tool. If /tasks and the chat assistant ever stop sharing one
// store, these fail.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// local-store reads ADJUTANT_STATE_ROOT at MODULE LOAD, so env must be in place
// before the route (which transitively imports it) is first imported.
const STATE_ROOT = mkdtempSync(join(tmpdir(), 'clawdling-tasks-'));
process.env.ADJUTANT_STATE = 'local';
process.env.ADJUTANT_STATE_ROOT = STATE_ROOT;
delete process.env.ADJUTANT_TOOLS;

const mockAuth = vi.fn();
vi.mock('@/lib/auth-timeout', () => ({
  authWithTimeout: () => mockAuth(),
}));

type RouteModule = typeof import('../route');
type ToolsModule = typeof import('@/lib/engine/tools');
let route: RouteModule;
let tools: ToolsModule;

beforeAll(async () => {
  route = await import('../route');
  tools = await import('@/lib/engine/tools');
});

afterAll(() => {
  rmSync(STATE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.ADJUTANT_STATE = 'local';
  process.env.ADJUTANT_STATE_ROOT = STATE_ROOT;
  mockAuth.mockReset();
});

/** One store file is shared by the whole suite, so each test gets its own
 *  user id and therefore its own isolated, scoped slice of it. */
let userSeq = 0;
function signInAsNewUser(): string {
  const id = `local-user-${++userSeq}`;
  mockAuth.mockResolvedValue({ user: { id, email: `${id}@example.test` } });
  return id;
}

async function addTask(userId: string, title: string, due?: string): Promise<void> {
  const createTask = tools.toolByName('create_task')!;
  await createTask.execute(userId, due ? { title, due } : { title });
}

interface TaskShape {
  id: string;
  title: string;
  status: string;
  due: string | null;
  completed_at: string | null;
}

async function readTasks(): Promise<{
  tasks: TaskShape[];
  stats: { total: number; open: number; done: number };
}> {
  const res = await route.GET();
  expect(res.status).toBe(200);
  return res.json();
}

function patch(body: unknown): Promise<Response> {
  return route.PATCH(
    new Request('http://localhost/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

// ── GET ────────────────────────────────────────────────────────────────────

describe('GET /api/tasks', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await route.GET();
    expect(res.status).toBe(401);
  });

  it('returns a task the assistant created, with open status and stats', async () => {
    const user = signInAsNewUser();
    await addTask(user, 'buy oat milk', 'tomorrow');

    const { tasks, stats } = await readTasks();

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('buy oat milk');
    expect(tasks[0].status).toBe('open');
    expect(tasks[0].due).toBe('tomorrow');
    expect(tasks[0].id).toBeTruthy();
    expect(stats).toEqual({ total: 1, open: 1, done: 0 });
  });

  it('returns an empty list (not an error) for a user with no tasks', async () => {
    signInAsNewUser();
    const { tasks, stats } = await readTasks();
    expect(tasks).toEqual([]);
    expect(stats).toEqual({ total: 0, open: 0, done: 0 });
  });

  it('never leaks another user\'s tasks', async () => {
    const owner = signInAsNewUser();
    await addTask(owner, 'owner-only secret errand');

    signInAsNewUser(); // a different user is now signed in
    const { tasks } = await readTasks();
    expect(tasks.map((t) => t.title)).not.toContain('owner-only secret errand');
  });
});

// ── PATCH ──────────────────────────────────────────────────────────────────

describe('PATCH /api/tasks', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await patch({ id: 'whatever', status: 'done' });
    expect(res.status).toBe(401);
  });

  it('completes a task: status flips, completed_at is stamped, stats move', async () => {
    const user = signInAsNewUser();
    await addTask(user, 'file the expense report');
    const before = await readTasks();
    const id = before.tasks[0].id;

    const res = await patch({ id, status: 'done' });
    expect(res.status).toBe(200);
    const { task } = await res.json();
    expect(task.status).toBe('done');
    expect(task.completed_at).toBeTruthy();

    const after = await readTasks();
    expect(after.stats).toEqual({ total: 1, open: 0, done: 1 });
    expect(after.tasks[0].status).toBe('done');
  });

  it('reopening clears completed_at so a row cannot be both open and completed', async () => {
    const user = signInAsNewUser();
    await addTask(user, 'renew the registration');
    const { tasks } = await readTasks();
    const id = tasks[0].id;

    await patch({ id, status: 'done' });
    const res = await patch({ id, status: 'open' });

    expect(res.status).toBe(200);
    const { task } = await res.json();
    expect(task.status).toBe('open');
    expect(task.completed_at).toBeNull();
  });

  it('a completion here is visible to the assistant\'s own list_tasks', async () => {
    // The whole point of repointing this route: one store, two surfaces.
    const user = signInAsNewUser();
    await addTask(user, 'water the plants');
    const { tasks } = await readTasks();

    await patch({ id: tasks[0].id, status: 'done' });

    const listTasks = tools.toolByName('list_tasks')!;
    const openList = await listTasks.execute(user, { status: 'open' });
    expect(openList).not.toContain('water the plants');
    const allList = await listTasks.execute(user, { status: 'all' });
    expect(allList).toContain('water the plants');
    expect(allList).toContain('[done]');
  });

  it('404s an unknown id', async () => {
    signInAsNewUser();
    const res = await patch({ id: 'no-such-task', status: 'done' });
    expect(res.status).toBe(404);
  });

  it('404s another user\'s task rather than completing it', async () => {
    const owner = signInAsNewUser();
    await addTask(owner, 'not yours to finish');
    const { tasks } = await readTasks();
    const id = tasks[0].id;

    signInAsNewUser(); // different user
    const res = await patch({ id, status: 'done' });
    expect(res.status).toBe(404);

    // And the owner's task is untouched.
    mockAuth.mockResolvedValue({ user: { id: owner, email: 'o@example.test' } });
    const still = await readTasks();
    expect(still.tasks[0].status).toBe('open');
  });

  it('400s a missing id', async () => {
    signInAsNewUser();
    const res = await patch({ status: 'done' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/id is required/i);
  });

  it('400s a status outside open|done', async () => {
    signInAsNewUser();
    const res = await patch({ id: 'x', status: 'deleted' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/open.*done/i);
  });

  it('400s a non-JSON body', async () => {
    signInAsNewUser();
    const res = await route.PATCH(
      new Request('http://localhost/api/tasks', { method: 'PATCH', body: 'not json' })
    );
    expect(res.status).toBe(400);
  });
});
