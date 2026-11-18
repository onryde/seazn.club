// A begin() that postgres.js wrote but never reserved (found by the 100-board load run, 2026-11-18).
//
// THE DEFECT. `sql.begin` marks its connection as reserved from a hook (`onexecute`) that `Connection.execute` called as the
// LAST term of `write(...) && !describeFirst && !cursorFn && sent.length < max_pipeline && onexecute(connection)`. Two of
// those terms can be false for a BEGIN that has nonetheless been written to the socket:
//   - `sent.length < max_pipeline`: while every connection is busy, pooled statements are pipelined onto the next busy
//     connection, and the one that fills it (`max_pipeline`, default 100, deep) fails the check;
//   - `write(...)`: false when the socket answers backpressure (its unsent bytes are over the high-water mark).
// Either way the BEGIN still ran on the server, the connection was NOT reserved, and when the BEGIN completed postgres.js
// raised `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1` - after which the connection went back to the pool
// INSIDE the open transaction. That request failed with a 500 (a room read, under the load run), the next `begin` on the
// stranded connection logged "there is already a transaction in progress", and pooled writes that landed on it were never
// committed.
//
// THE FIX. patches/postgres@3.4.9.patch: `execute` calls the hook for every statement it wrote, and returns what it returned
// before. The app's client keeps the library's default pipeline depth.
//
// WHAT THIS PROVES, against real Postgres, down both paths:
//   1. the pipeline, through the app's own pooled client (`sql`, built by `getClient`): a statement that is not a BEGIN
//      holds each connection, `max_pipeline` more are written behind it, then a `sql.begin` is issued as exactly the
//      statement that would be one past the library's default depth, on every connection;
//   2. backpressure: a begin pipelined behind a busy statement on every connection, its BEGIN too long for the socket to
//      take at once, through a client of the same ESM copy the app imports - built here because only a client of its own
//      can carry the socket hook that RECORDS what `write` answered: the premise "the socket answered backpressure" is
//      observed, not assumed (a BEGIN that merely exceeds the high-water mark is taken whole by a loopback socket);
//   2b. the same through the CommonJS copy the package ships (`require("postgres")`), which the patch rewrites on its own.
//      (The Cloudflare copy needs the workerd runtime; its patched source is pinned by
//      scripts/__tests__/patched-dependencies.test.ts.)
// Each begin must run its transaction, on the connection it landed on, and no connection of the pool may be left idle in a
// transaction. Depths and the pool come from the library's and the client's own declarations, never from a literal; the
// pids come from the connections the pool really opened.
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { connectionOptions, sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Client = ReturnType<typeof postgres>;

/** The depth postgres.js ships with, and the one the app's client runs at. Read from a client built with no option. */
function libraryDefaultDepth(): number {
  const bare = postgres(process.env.DATABASE_URL!, { max: 1 });
  const depth = (bare.options as unknown as { max_pipeline: number }).max_pipeline;
  void bare.end({ timeout: 0 });
  return depth;
}

const poolSizeOf = (client: Client) => (client.options as unknown as { max: number }).max;

/** Open every connection of `client`'s pool and read its backend pid (the pids ARE the pool, whoever else uses the database). */
async function poolPids(client: Client): Promise<number[]> {
  const size = poolSizeOf(client);
  const pids = (await Promise.all(Array.from({ length: size }, () => client<{ pid: number }[]>`select pg_backend_pid() as pid, pg_sleep(0.1)`)))
    .map((r) => r[0]!.pid);
  expect(new Set(pids).size, "premise: one pid per connection").toBe(size);
  return pids;
}

/** None of `pids` is idle inside a transaction - asked on a client of its own: a stranded pooled connection would otherwise
 *  run this very question inside the stranded transaction. */
async function expectNoneStranded(pids: number[]): Promise<void> {
  const probe = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stranded = await probe<{ pid: number }[]>`
      select pid from pg_stat_activity where pid = any(${pids}::int[]) and state like 'idle in transaction%'`;
    expect(stranded, "no connection of the pool is stranded in a transaction").toEqual([]);
  } finally {
    await probe.end({ timeout: 1 });
  }
}

interface Written {
  bytes: number;
  answered: boolean;
}

/** postgres.js's `socket` option (a runtime option its typings do not declare): a factory for an already-connected socket.
 *  This one is a plain TCP socket to the database whose every `write` is recorded with what it answered. */
function recordingSocket(url: URL, writes: Written[]) {
  return () =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect(Number(url.port || 5432), url.hostname, () => resolve(s));
      s.once("error", reject);
      const write = s.write.bind(s) as (chunk: Uint8Array, ...rest: unknown[]) => boolean;
      s.write = ((chunk: Uint8Array, ...rest: unknown[]) => {
        const answered = write(chunk, ...rest);
        writes.push({ bytes: chunk.length, answered });
        return answered;
      }) as Socket["write"];
    });
}

/** Path 2, on a client of `factory` (the ESM or the CJS copy): every connection busy with a sleeping statement, then a begin
 *  behind it on each, whose BEGIN is padded far past what the kernel buffers of a connection whose backend is not reading
 *  will take, so the socket must answer backpressure - and the recording says whether it did. */
async function beginUnderBackpressure(factory: typeof postgres): Promise<void> {
  const url = process.env.DATABASE_URL!;
  const { ssl, schema } = connectionOptions(url);
  const writes: Written[] = [];
  const client = factory(url, {
    max: poolSizeOf(sql),
    ssl,
    connection: { search_path: schema },
    ...({ socket: recordingSocket(new URL(url), writes) } as object),
  });
  try {
    const pids = await poolPids(client);
    // `begin(options)` keeps the letters and spaces of `options`: the BEGIN is padded with spaces, which Postgres ignores
    const pad = " ".repeat(16 * 1024 * 1024);
    const holders = pids.map(() => client`select pg_sleep(0.5)`);
    const begins = pids.map(() =>
      client
        .begin(pad, async (tx) => {
          // a transaction-local setting outlives its statement only inside a transaction block
          await tx`select set_config('seazn.begin_probe', 'inside', true)`;
          return (await tx<{ pid: number; probe: string }[]>`
            select pg_backend_pid() as pid, current_setting('seazn.begin_probe', true) as probe`)[0]!;
        })
        .then(
          (row) => ({ result: "ok" as const, pid: row.pid, inside: row.probe === "inside" }),
          (e: { code?: string; message: string }) => ({ result: e.code ?? e.message, pid: null, inside: false }),
        ),
    );
    const outcomes = await Promise.all(begins);
    await Promise.all(holders);

    const beginWrites = writes.filter((w) => w.bytes > pad.length);
    expect(beginWrites.length, "anti-vacuity: each BEGIN went out in one write").toBe(pids.length);
    expect(beginWrites.map((w) => w.answered), "premise: the socket answered backpressure to every one of them").toEqual(
      Array(pids.length).fill(false),
    );
    expect(outcomes.map((o) => o.result), "every begin ran its transaction").toEqual(Array(pids.length).fill("ok"));
    expect(outcomes.every((o) => o.inside), "each begin's statements ran inside its transaction").toBe(true);
    expect(new Set(outcomes.map((o) => o.pid)), "one begin landed on each connection of the pool").toEqual(new Set(pids));
    await expectNoneStranded(pids);
  } finally {
    await client.end({ timeout: 1 });
  }
}

describe.skipIf(!HAS_DB)("a begin() written but not reserved by postgres.js", () => {
  it("premise: the app's client runs at the library's default pipeline depth, with a pool of more than one", () => {
    const depth = libraryDefaultDepth();
    expect(Number.isInteger(depth) && depth >= 2, "the library declares a pipeline depth").toBe(true);
    expect((sql.options as unknown as { max_pipeline: number }).max_pipeline, "the client sets none of its own").toBe(depth);
    expect(poolSizeOf(sql), "a pool of more than one connection (max: 1 is exempt from the check)").toBeGreaterThan(1);
  });

  it("1. pipeline: as the statement one past the default depth, on every connection, it runs its transaction and strands nothing", async () => {
    const depth = libraryDefaultDepth();
    const pool = poolSizeOf(sql);
    const pids = await poolPids(sql);

    // one holder per connection (the first statement of each pipeline), then plain statements round-robin behind them.
    // Statement n lands on connection (n-1) mod pool as that connection's ceil(n / pool)-th, so the one that is
    // `depth + 1` deep on connection j is statement pool * depth + j. Each of those is a begin.
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
    await expectNoneStranded(pids);
  }, 60_000);

  it("2. backpressure: a begin the socket could not take at once, on every connection, runs its transaction and strands nothing", async () => {
    await beginUnderBackpressure(postgres);
  }, 60_000);

  it("2b. the same through the CommonJS copy the package ships (require), which the patch rewrites on its own", async () => {
    const cjs = createRequire(import.meta.url)("postgres") as typeof postgres;
    expect(cjs, "premise: require() loads a different copy from the ESM import").not.toBe(postgres);
    await beginUnderBackpressure(cjs);
  }, 60_000);

  // The patch keeps `execute`'s answer as it was: falsy for a BEGIN even with room to spare, which is what keeps the pool from
  // writing more pooled statements onto the begin's connection (`go` files it as full, not busy). Answering true would put
  // the very next pooled statement behind the BEGIN, inside the open transaction.
  it("3. a begin written with room to spare still leaves the pool: the pooled statements issued behind it never land on its connection", async () => {
    const url = process.env.DATABASE_URL!;
    const { ssl, schema } = connectionOptions(url);
    const client = postgres(url, { max: 2, ssl, connection: { search_path: schema } });
    try {
      const [a, b] = await poolPids(client);
      // A busy, B idle: the begin takes B, two statements deep at most - far under the pipeline depth
      const holder = client<{ pid: number }[]>`select pg_backend_pid() as pid, pg_sleep(0.3)`;
      const begin = client.begin(async (tx) => {
        const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid, pg_sleep(0.3)`;
        return row!.pid;
      });
      const probes = Array.from({ length: 6 }, () => client<{ pid: number }[]>`select pg_backend_pid() as pid`);
      const [held, beginPid, answered] = await Promise.all([holder, begin, Promise.all(probes)]);
      expect([held[0]!.pid, beginPid].sort(), "premise: the holder and the begin each had a connection").toEqual([a, b].sort());
      const probePids = answered.map((r) => r[0]!.pid);
      expect(probePids.length, "anti-vacuity: every pooled statement was answered").toBe(6);
      expect(probePids.filter((p) => p === beginPid), "none ran on the begin's connection").toEqual([]);
    } finally {
      await client.end({ timeout: 1 });
    }
  }, 60_000);
});
