// Final review I-3: the lock-waiter poll the staged-race tests stand on counts only the sessions OUR holder blocks.
// The predicate it replaced counted every `Lock` waiter in the database, so under the parallel CI split another suite's
// waiter satisfied it. Staged on advisory keys no other test takes, every connection reserved and released here.
import { afterEach, describe, expect, it } from "vitest";
import { randomInt } from "node:crypto";
import { sql } from "@/lib/db";
import { backendPid, pollWaitersBehind, waitersBehind } from "./_lock-waiters";

const HAS_DB = !!process.env.DATABASE_URL;

type Reserved = Awaited<ReturnType<typeof sql.reserve>>;
const open: Reserved[] = [];
async function session(): Promise<Reserved> {
  const c = await sql.reserve();
  open.push(c);
  await c`begin`;
  return c;
}
afterEach(async () => {
  for (const c of open.splice(0)) {
    await c`rollback`.catch(() => undefined);
    c.release();
  }
});

/** A key per test run: two runs of this file, or another suite, never share one. */
const key = () => randomInt(1, 2 ** 31 - 1);
/** What the old predicate read: every advisory waiter in the database, whoever holds the lock. */
const anyAdvisoryWaiter = async () =>
  (
    await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`
  )[0]!.n;

describe.runIf(HAS_DB)("waitersBehind — scoped to the holder", () => {
  it("a waiter behind ANOTHER holder is not ours: the old predicate saw it, the scoped one does not; our own waiter is seen", async () => {
    const [mine, theirs] = [key(), key()];
    const holder = await session();
    const foreign = await session();
    await holder`select pg_advisory_xact_lock(${mine})`;
    await foreign`select pg_advisory_xact_lock(${theirs})`;
    const holderPid = await backendPid(holder);
    const foreignPid = await backendPid(foreign);
    // Another suite's waiter, blocked by THEIR holder.
    const stranger = await session();
    const strangerWaits = stranger`select pg_advisory_xact_lock(${theirs})`.then(() => undefined).catch(() => undefined);
    expect(await pollWaitersBehind(foreignPid), "premise: the stranger is waiting").toBe(1);
    expect(await anyAdvisoryWaiter(), "the old predicate: satisfied by the stranger alone").toBeGreaterThanOrEqual(1);
    expect(await waitersBehind(holderPid), "the scoped one: nobody waits on OUR holder yet").toBe(0);
    // Now our own waiter.
    const ours = await session();
    const oursWaits = ours`select pg_advisory_xact_lock(${mine})`.then(() => undefined).catch(() => undefined);
    expect(await pollWaitersBehind(holderPid), "our waiter, seen").toBe(1);
    await holder`rollback`;
    await foreign`rollback`;
    await Promise.all([strangerWaits, oursWaits]);
  });

  it("a waiter DOWN THE CHAIN is counted: the second waits on the first, which waits on the holder", async () => {
    const [a, b] = [key(), key()];
    const holder = await session();
    await holder`select pg_advisory_xact_lock(${a})`;
    const holderPid = await backendPid(holder);
    const first = await session();
    const second = await session();
    // Each pid BEFORE its session blocks: a reserved connection runs its queries in order, so a pid asked for behind a
    // blocked statement would wait with it.
    const firstPid = await backendPid(first);
    const secondPid = await backendPid(second);
    await first`select pg_advisory_xact_lock(${b})`;
    const firstWaits = first`select pg_advisory_xact_lock(${a})`.then(() => undefined).catch(() => undefined);
    expect(await pollWaitersBehind(holderPid), "premise: the first waits on the holder").toBe(1);
    const secondWaits = second`select pg_advisory_xact_lock(${b})`.then(() => undefined).catch(() => undefined);
    // The second's blocker is the first, never the holder: a direct-only check would miss it.
    let blockers: number[] = [];
    for (let i = 0; i < 100 && blockers.length === 0; i++) {
      blockers = (await sql<{ b: number[] }[]>`select pg_blocking_pids(${secondPid}::int) as b`)[0]!.b;
      if (blockers.length === 0) await new Promise((res) => setTimeout(res, 50));
    }
    expect(blockers, "premise: blocked by the first alone").toEqual([firstPid]);
    expect(await pollWaitersBehind(holderPid, { atLeast: 2 }), "the chain, counted").toBe(2);
    // queryLike narrows to the statement: both run the same text, so both match; a text nobody runs matches none.
    expect(await waitersBehind(holderPid, "%pg_advisory_xact_lock%")).toBe(2);
    expect(await waitersBehind(holderPid, "%no such statement%")).toBe(0);
    await holder`rollback`;
    await firstWaits;
    await first`rollback`;
    await secondWaits;
  });

  it("the poll stops at once when the work says it already finished, and reports what it saw (0)", async () => {
    const holder = await session();
    const holderPid = await backendPid(holder);
    const t0 = Date.now();
    expect(await pollWaitersBehind(holderPid, { finished: () => true })).toBe(0);
    expect(Date.now() - t0, "one look, no 5 s of polling").toBeLessThan(2_000);
  });
});
