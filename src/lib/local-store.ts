// ═══════════════════════════════════════════════════════════════════════════
// local-store.ts — a Supabase-js-compatible local store for the self-host build
//
// When ADJUTANT_STATE=local (the OSS self-host default), getServerClient() /
// getNextAuthClient() / getBrowserClient() in supabase.ts return getLocalClient()
// instead of a real Supabase client — BEFORE the createClient('') call that
// would otherwise throw on an empty URL. This means chat.ts and every fetchX
// helper stay UNCHANGED: they call .from(table).select()/insert()/... and get a
// transparent local adapter backed by JSON files under ADJUTANT_STATE_ROOT.
//
// Storage: one JSON file per table at ${ADJUTANT_STATE_ROOT}/db/<table>.json,
// each an array of row objects. Single local user, tiny data volume — a plain
// JSON store is robust, dependency-free (no native module to compile on a fresh
// clone), and correct. SQLite is a P2 optimization, not needed at this scale.
//
// The adapter implements only the fluent subset chat.ts + the chat/upload routes
// actually use:
//   .from(t)
//     .select('*').eq().is().gte().gt().lt().lte().in().order().limit()   → {data,error}
//     .select('*')...maybeSingle()/.single()                              → {data,error}
//     .insert(row).select('*').single()                                   → {data,error}
//     .upsert(row,{onConflict}).select('*').single() | (awaited directly) → {data,error}
//     .update(row).eq()...                                                → {data,error}
//     .delete().eq()/.lt()...                                             → {data,error}
// Terminal shape matches supabase-js: {data, error} so the `if (error) throw`
// guards in chat.ts behave. Unknown tables read as [] (domain reads degrade to
// empty instead of throwing).
// ═══════════════════════════════════════════════════════════════════════════

// No STATIC node imports: supabase.ts (which imports this) is also reached by
// client components via getBrowserClient, so a top-level `fs`/`path`/`crypto`
// import would pull Node built-ins into the browser bundle and fail the build.
// fs is loaded lazily (server-only call paths); crypto is the global Web Crypto
// (present on both Node 20+ and the browser); paths are built as plain strings.

const STATE_ROOT = process.env.ADJUTANT_STATE_ROOT || './.adjutant';
const DB_DIR = `${STATE_ROOT.replace(/\/+$/, '')}/db`;

function tablePath(table: string): string {
  // sanitize — table names are internal constants, but never let one escape DB_DIR
  const safe = table.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${DB_DIR}/${safe}.json`;
}

// Lazy Node fs — only ever invoked on server call paths (route handlers /
// server components). Kept out of module scope so the browser bundle compiles.
async function fs(): Promise<typeof import('node:fs/promises')> {
  return import('node:fs/promises');
}

// ── Serialize all store ops so a poll read never lands mid-write ────────────
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

type Row = Record<string, unknown>;

async function readTable(table: string): Promise<Row[]> {
  try {
    const { readFile } = await fs();
    const raw = await readFile(tablePath(table), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeTable(table: string, rows: Row[]): Promise<void> {
  const { mkdir, writeFile } = await fs();
  await mkdir(DB_DIR, { recursive: true });
  await writeFile(tablePath(table), JSON.stringify(rows, null, 2), 'utf-8');
}

// ── Insert-time defaults per table ──────────────────────────────────────────
function withDefaults(table: string, row: Row): Row {
  const now = new Date().toISOString();
  const out: Row = { ...row };
  if (out.id == null) out.id = globalThis.crypto.randomUUID();
  if (out.created_at == null) out.created_at = now;
  if (table === 'chat_threads') {
    if (out.last_message_at == null) out.last_message_at = now;
    if (out.archived_at === undefined) out.archived_at = null;
  }
  return out;
}

type Filter = { op: 'eq' | 'is' | 'gte' | 'gt' | 'lt' | 'lte' | 'in'; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    switch (f.op) {
      case 'eq':
      case 'is':
        if (v !== f.val) return false;
        break;
      case 'gte':
        if (!(v != null && (v as never) >= (f.val as never))) return false;
        break;
      case 'gt':
        if (!(v != null && (v as never) > (f.val as never))) return false;
        break;
      case 'lt':
        if (!(v != null && (v as never) < (f.val as never))) return false;
        break;
      case 'lte':
        if (!(v != null && (v as never) <= (f.val as never))) return false;
        break;
      case 'in':
        if (!Array.isArray(f.val) || !f.val.includes(v)) return false;
        break;
    }
  }
  return true;
}

type Result = { data: unknown; error: { message: string } | null };

class LocalQuery implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private mode: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private onConflict: string | null = null;

  constructor(private table: string) {}

  // select() is a passthrough — it names the returning columns but never
  // overrides an insert/upsert/update/delete mode set earlier in the chain.
  select(_cols?: string): this {
    return this;
  }

  eq(col: string, val: unknown): this { this.filters.push({ op: 'eq', col, val }); return this; }
  is(col: string, val: unknown): this { this.filters.push({ op: 'is', col, val }); return this; }
  gte(col: string, val: unknown): this { this.filters.push({ op: 'gte', col, val }); return this; }
  gt(col: string, val: unknown): this { this.filters.push({ op: 'gt', col, val }); return this; }
  lt(col: string, val: unknown): this { this.filters.push({ op: 'lt', col, val }); return this; }
  lte(col: string, val: unknown): this { this.filters.push({ op: 'lte', col, val }); return this; }
  in(col: string, vals: unknown[]): this { this.filters.push({ op: 'in', col, val: vals }); return this; }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number): this { this.limitN = n; return this; }

  insert(row: Row | Row[]): this { this.mode = 'insert'; this.payload = row; return this; }
  upsert(row: Row | Row[], opts?: { onConflict?: string }): this {
    this.mode = 'upsert';
    this.payload = row;
    this.onConflict = opts?.onConflict ?? 'id';
    return this;
  }
  update(row: Row): this { this.mode = 'update'; this.payload = row; return this; }
  delete(): this { this.mode = 'delete'; return this; }

  // ── execution ─────────────────────────────────────────────────────────────
  private async run(): Promise<Row[]> {
    return withLock(async () => {
      let rows = await readTable(this.table);

      if (this.mode === 'select') {
        let out = rows.filter((r) => matches(r, this.filters));
        if (this.orderCol) {
          const col = this.orderCol;
          const dir = this.orderAsc ? 1 : -1;
          out = [...out].sort((a, b) => {
            const av = a[col] as never, bv = b[col] as never;
            if (av === bv) return 0;
            return (av < bv ? -1 : 1) * dir;
          });
        }
        if (this.limitN != null) out = out.slice(0, this.limitN);
        return out;
      }

      if (this.mode === 'insert') {
        const toInsert = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((r) =>
          withDefaults(this.table, r)
        );
        rows.push(...toInsert);
        await writeTable(this.table, rows);
        await this.touchThreadOnMessage(toInsert);
        return toInsert;
      }

      if (this.mode === 'upsert') {
        const key = this.onConflict || 'id';
        const toUpsert = Array.isArray(this.payload) ? this.payload : [this.payload!];
        const result: Row[] = [];
        for (const incoming of toUpsert) {
          const idx = rows.findIndex((r) => r[key] != null && r[key] === incoming[key]);
          if (idx >= 0) {
            rows[idx] = { ...rows[idx], ...incoming };
            result.push(rows[idx]);
          } else {
            const created = withDefaults(this.table, incoming);
            rows.push(created);
            result.push(created);
          }
        }
        await writeTable(this.table, rows);
        await this.touchThreadOnMessage(result);
        return result;
      }

      if (this.mode === 'update') {
        const updated: Row[] = [];
        for (const r of rows) {
          if (matches(r, this.filters)) {
            Object.assign(r, this.payload as Row);
            updated.push(r);
          }
        }
        await writeTable(this.table, rows);
        return updated;
      }

      if (this.mode === 'delete') {
        const keep = rows.filter((r) => !matches(r, this.filters));
        await writeTable(this.table, keep);
        return [];
      }

      return [];
    });
  }

  // Keep thread ordering correct: a new message bumps its thread's
  // last_message_at so getThreadsForUser (ordered by last_message_at desc)
  // surfaces the active thread first, matching the Postgres trigger behavior.
  private async touchThreadOnMessage(inserted: Row[]): Promise<void> {
    if (this.table !== 'chat_messages') return;
    const threads = await readTable('chat_threads');
    if (!threads.length) return;
    let changed = false;
    for (const msg of inserted) {
      const t = threads.find((th) => th.id === msg.thread_id);
      if (t) {
        t.last_message_at = (msg.created_at as string) || new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await writeTable('chat_threads', threads);
  }

  async single(): Promise<Result> {
    try {
      const rows = await this.run();
      if (rows.length === 0) {
        return { data: null, error: { message: 'No rows found (single).' } };
      }
      return { data: rows[0], error: null };
    } catch (e) {
      return { data: null, error: { message: String(e) } };
    }
  }

  async maybeSingle(): Promise<Result> {
    try {
      const rows = await this.run();
      return { data: rows[0] ?? null, error: null };
    } catch (e) {
      return { data: null, error: { message: String(e) } };
    }
  }

  // Thenable: awaiting the builder executes and yields {data: Row[], error}.
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.run()
      .then(
        (rows): Result => ({ data: rows, error: null }),
        (e): Result => ({ data: null, error: { message: String(e) } })
      )
      .then(onfulfilled, onrejected);
  }
}

class LocalClient {
  from(table: string): LocalQuery {
    return new LocalQuery(table);
  }
}

let _client: LocalClient | null = null;

/** Memoized local store client. Shape-compatible with the subset of the
 *  supabase-js client that chat.ts and the fetchX helpers use. */
export function getLocalClient(): LocalClient {
  if (!_client) _client = new LocalClient();
  return _client;
}

/** True when the self-host local store is active. */
export function isLocalState(): boolean {
  return process.env.ADJUTANT_STATE === 'local';
}
