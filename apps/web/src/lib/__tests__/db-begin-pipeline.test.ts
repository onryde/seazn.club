// A transaction opened as the deepest statement of a pipelined connection (found by the 100-board load run, 2026-11-18).
//
// THE DEFECT. postgres.js pipelines pooled statements: while every connection is busy, each new one is written onto the
// next busy connection, up to `max_pipeline` (default 100) deep. `sql.begin` marks its connection as reserved by a callback
// (`onexecute`) that `Connection.execute` calls only AFTER checking `sent.length < max_pipeline`. The statement that makes
// the pipeline 101 deep fails that check, so for a BEGIN the callback is never called: the BEGIN still goes to the
// server, the connection is NOT reserved, and when the BEGIN completes postgres.js raises
// `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1` - after which the connection goes back to the pool
// INSIDE the open transaction. That request fails with a 500 (a room read, under the load run), the next `begin` that
// lands on the stranded connection logs "there is already a transaction in progress", and a pooled write that lands on it
// is never committed.
//
// WHAT THIS PROVES. The real pooled client (`sql`, built by `getClient`), against real Postgres: a statement that is not
// a BEGIN holds each connection (so the pipelines build), `max_pipeline` more statements are written behind it, and then
// a `sql.begin` is issued as exactly the statement that would be one past the library's default depth, on every
// connection. Each must run its transaction, and no connection of the pool may be left idle in a transaction.
// The positions come from the library's own declared default (`options.max_pipeline`) and the pool's own size, never from
// a literal; the pids come from the connections the pool really opened.
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The depth postgres.js ships with: what the app's client ran at before it set its own. Read from a client built with no
 *  option, not written here. */
function libraryDefaultDepth(): number {
  const bare = postgres(process.env.DATABASE_URL!, { max: 1 });
  const depth = (bare.options as unknown as { max_pipeline: number }).max_pipeline;
  void bare.end({ timeout: 0 });
  return depth;
}

describe.skipIf(!HAS_DB)("a begin() written as the deepest statement of a pipelined connection", () => {
  it("runs its transaction and strands no connection, on every connection of the pool", async () => {
    const depth = libraryDefaultDepth();
    const pool = (sql.options as unknown as { max: number }).max;
    expect(Number.isInteger(depth) && depth >= 2, "premise: the library declares a pipeline depth").toBe(true);
    expect(pool, "premise: a pool of more than one connection").toBeGreaterThan(1);

    // 1. open every connection of the pool and read its backend pid (the pids ARE the pool, whoever else uses the database)
    const pids = (await Promise.all(Array.from({ length: pool }, () => sql<{ pid: number }[]>`select pg_backend_pid() as pid, pg_sleep(0.1)`)))
      .map((r) => r[0]!.pid);
    expect(new Set(pids).size, "premise: one pid per connection").toBe(pool);

    // 2. one holder per connection (the first statement of each pipeline), then plain statements round-robin behind them.
    //    Statement n lands on connection (n-1) mod pool as that connection's ceil(n / pool)-th, so the one that is
    //    `depth + 1` deep on connection j is statement pool * depth + j. Each of those is a begin.
    const beginAt = new Map<number, number>(); // statement number -> connection index
    for (let j = 1; j <= pool; j++) beginAt.set(pool * depth + j, j);
    const total = pool * depth + pool + 3;
    const outcomes: { at: number; result: "ok" | string }[] = [];
    const jobs: Promise<unknown>[] = [];
    let plain = 0;
    for (let n = 1; n <= total; n++) {
      if (n <= pool) {
        jobs.push(sql`select pg_sleep(0.6)`.then(() => plain++));
      } else if (beginAt.has(n)) {
        jobs.push(
          sql
            .begin(async (tx) => {
              await tx`select 1`;
            })
            .then(
              () => outcomes.push({ at: n, result: "ok" }),
              (e: { code?: string; message: string }) => outcomes.push({ at: n, result: e.code ?? e.message }),
            ),
        );
      } else {
        jobs.push(sql`select 1`.then(() => plain++));
      }
    }
    await Promise.all(jobs);

    expect(outcomes.length, "anti-vacuity: a begin was issued at every depth boundary").toBe(pool);
    expect(outcomes.map((o) => o.result), "every one of them ran its transaction").toEqual(Array(pool).fill("ok"));
    expect(plain, "and every other statement was answered").toBe(total - pool);

    // 3. the pool is clean: none of its backends is left idle inside a transaction (asked on a client of its own: a
    //    stranded pooled connection would otherwise run this very question inside the stranded transaction)
    const probe = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const stranded = await probe<{ pid: number }[]>`
        select pid from pg_stat_activity where pid = any(${pids}::int[]) and state like 'idle in transaction%'`;
      expect(stranded, "no connection of the pool is stranded in a transaction").toEqual([]);
    } finally {
      await probe.end({ timeout: 1 });
    }
  }, 60_000);
});
