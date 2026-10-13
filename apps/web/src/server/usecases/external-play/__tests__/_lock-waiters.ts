import { sql } from "@/lib/db";

/**
 * Final review I-3: a lock-waiter poll scoped to OUR holder.
 *
 * The old predicate counted every `Lock` waiter in the database. Under the parallel CI split another suite's waiter
 * satisfies it, so a test could assert its interleaving before its own transaction was ever blocked, and pass with the
 * lock never contended. This counts only the sessions blocked BY `holderPid`: directly, or down a chain (a second
 * waiter queues behind the first, and a row lock's second waiter is blocked by the first, not by the holder).
 * `queryLike` narrows it to the statement the test expects to be waiting.
 */
type Reserved = Awaited<ReturnType<typeof sql.reserve>>;

/** The holder's backend pid: what every waiter of ITS lock lists in `pg_blocking_pids`. */
export async function backendPid(conn: Reserved): Promise<number> {
  const [row] = await conn<{ pid: number }[]>`select pg_backend_pid() as pid`;
  return row!.pid;
}

export async function waitersBehind(holderPid: number, queryLike?: string): Promise<number> {
  const like = queryLike ?? null;
  const [row] = await sql<{ n: number }[]>`
    with recursive behind(pid) as (
      select pid from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))
      union
      select a.pid from pg_stat_activity a join behind b on b.pid = any(pg_blocking_pids(a.pid))
    )
    select count(*)::int as n
      from pg_stat_activity a join behind b on b.pid = a.pid
     where ${like}::text is null or a.query ilike ${like}::text`;
  return row!.n;
}

/**
 * Polls every 50 ms, up to `tries` times, until at least `atLeast` sessions wait behind `holderPid`, or until
 * `finished()` says the work already ended (it can no longer be waiting). Returns the last count seen, so the caller
 * asserts on it.
 */
export async function pollWaitersBehind(
  holderPid: number,
  opts: { atLeast?: number; queryLike?: string; finished?: () => boolean; tries?: number } = {},
): Promise<number> {
  const atLeast = opts.atLeast ?? 1;
  let seen = 0;
  for (let i = 0; i < (opts.tries ?? 100); i++) {
    seen = await waitersBehind(holderPid, opts.queryLike);
    if (seen >= atLeast || opts.finished?.()) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  return seen;
}
