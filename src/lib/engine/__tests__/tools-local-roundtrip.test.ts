// ═══════════════════════════════════════════════════════════════════════════
// tools-local-roundtrip.test.ts — regression guard for the P0 the Phase 5 boot
// test caught (2026-07-07): the flagship "create a task, then list tasks" first
// run was BROKEN for a fresh local (BYOK) self-hoster.
//
// ROOT CAUSE:
//   create_task inserted a row WITHOUT `status`; list_tasks filters status='open'.
//   On Supabase the column DEFAULT 'open' masked it, but the local-store JSON
//   adapter applies NO column defaults, so local rows persisted status=undefined
//   and never matched the filter → "No open tasks." right after creating one.
//
// THIS TEST would have caught it: it drives create_task → list_tasks against the
// REAL local store (ADJUTANT_STATE=local + a temp ADJUTANT_STATE_ROOT), NOT a
// mock, and asserts the created task actually comes back from list_tasks. A row
// with no status would be filtered out and fail the assertion — exactly the bug.
//
// It also pins enabledToolset()'s default so the second half of the P0 (the core
// acting tools being OFF by default) can't silently regress either.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The local store reads ADJUTANT_STATE_ROOT at MODULE LOAD, so both env vars
// must be set BEFORE the tools module (which transitively imports local-store)
// is first imported. We therefore create the temp dir + set env here, then
// import the module dynamically inside the tests.
const STATE_ROOT = mkdtempSync(join(tmpdir(), 'clawdling-tools-'));
process.env.ADJUTANT_STATE = 'local';
process.env.ADJUTANT_STATE_ROOT = STATE_ROOT;
// Ensure ADJUTANT_TOOLS is unset so the default-toolset assertion is meaningful.
delete process.env.ADJUTANT_TOOLS;

const USER = 'local-user';

// Loaded once env is in place.
type ToolsModule = typeof import('../tools');
let tools: ToolsModule;

beforeAll(async () => {
  tools = await import('../tools');
});

afterAll(() => {
  rmSync(STATE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // Guard against another test module having mutated these.
  process.env.ADJUTANT_STATE = 'local';
  process.env.ADJUTANT_STATE_ROOT = STATE_ROOT;
  delete process.env.ADJUTANT_TOOLS;
});

describe('local-store task round-trip (P0 regression)', () => {
  it('a created task appears in list_tasks with status open', async () => {
    const createTask = tools.toolByName('create_task');
    const listTasks = tools.toolByName('list_tasks');
    expect(createTask, 'create_task tool must be registered').toBeTruthy();
    expect(listTasks, 'list_tasks tool must be registered').toBeTruthy();

    const title = `roundtrip-${Date.now()}`;

    // 1) create — writes to the REAL local JSON store, no column defaults.
    const created = await createTask!.execute(USER, { title });
    expect(created).toContain(`Added task: "${title}"`);

    // 2) list open (default) — the created task MUST come back. Before the fix
    //    the row had status=undefined and was filtered out → "No open tasks."
    const openList = await listTasks!.execute(USER, {});
    expect(openList, 'freshly created task must appear in the open list').toContain(title);
    expect(openList, 'and it must be marked [open]').toContain('[open]');
    expect(openList).not.toBe('No open tasks.');

    // 3) explicit status:'open' filter returns it too (the exact filter path).
    const openFiltered = await listTasks!.execute(USER, { status: 'open' });
    expect(openFiltered).toContain(title);
  });

  it('two created tasks both list; second create does not clobber the first', async () => {
    const createTask = tools.toolByName('create_task')!;
    const listTasks = tools.toolByName('list_tasks')!;

    const a = `first-${Date.now()}`;
    const b = `second-${Date.now()}`;
    await createTask.execute(USER, { title: a });
    await createTask.execute(USER, { title: b });

    const list = await listTasks.execute(USER, { status: 'all' });
    expect(list).toContain(a);
    expect(list).toContain(b);
  });
});

describe('enabledToolset() default (P0 second half — tools ON by default)', () => {
  it("defaults to ['web','tasks','memory'] when ADJUTANT_TOOLS is unset", () => {
    delete process.env.ADJUTANT_TOOLS;
    expect(tools.enabledToolset()).toEqual(['web', 'tasks', 'memory']);
    expect(tools.DEFAULT_TOOLS).toBe('web,tasks,memory');
  });

  it('honors an explicit ADJUTANT_TOOLS override', () => {
    process.env.ADJUTANT_TOOLS = 'web';
    expect(tools.enabledToolset()).toEqual(['web']);
  });
});
