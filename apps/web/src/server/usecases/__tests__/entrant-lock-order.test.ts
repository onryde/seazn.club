// #850 review round 3, finding 2 — LOCK ORDER. Every write that reconciles a
// division's rest byes takes the division advisory lock BEFORE any row lock
// on the entrant (or the entrant's registration), in the order `deleteEntrant`
// takes them: lock, then rows. `patchEntrant` and `withdrawCore` used to
// update the entrant row first and take the lock after, so a withdrawal and a
// delete of the same entrant could each hold what the other waits for — a
// deadlock (40P01). `deleteEntrant` also reaches the REGISTRATION row, through
// `registrations.entrant_id on delete set null`, which is why `withdrawCore`
// must take the lock before its own `for update` on that row too.
//
// Proven by ORDER, not by racing: a second connection holds the division lock;
// the write under test is started and runs until it parks on that lock (read
// from `pg_blocking_pids`, not from a sleep); while it is parked, a
// `for update nowait` probe asks which rows it already holds. Whatever it
// holds at that moment it took BEFORE the division lock. The probe is proven
// able to see a held row lock first, so "free" is not a probe that cannot fail.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant, patchEntrant } from "../entrants";
import { withdrawRegistrationPublic } from "../registrations";
import { createStages, generateStageFixtures } from "../stages";
import { seedRegistration } from "./_registration-fixtures";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  entrantIds: string[];
}

/** A 5-entrant league, generated (so the division has rest-bye rows for the
 *  reconcile to act on) and left in `setup` (so `deleteEntrant` is allowed). */
async function rig(): Promise<Rig> {
  const { auth } = await seedOrg();
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Lock order " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 5 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  await generateStageFixtures(auth, stage!.id);
  return { auth, competitionId: comp.id, divisionId: division.id, entrantIds: entrants.map((e) => e.id) };
}

/** Hold the division's advisory lock on a connection of its own, the key every
 *  fixture writer takes. */
async function holdDivisionLock(divisionId: string) {
  const conn = await sql.reserve();
  await conn`begin`;
  await conn`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
  const [{ pid }] = await conn<{ pid: number }[]>`select pg_backend_pid() as pid`;
  return {
    pid,
    release: async () => {
      await conn`commit`;
      conn.release();
    },
  };
}

/** Until a backend is waiting on `holder` — the write under test, parked on
 *  the division lock. A condition, polled; the deadline only turns a hang into
 *  a readable failure. */
async function parkedBehind(holder: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const waiting = await sql<{ pid: number }[]>`
      select pid from pg_stat_activity where ${holder} = any(pg_blocking_pids(pid))`;
    if (waiting.length > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the write never reached the division lock");
}

/** Can a third party take this row's lock right now? */
async function rowLockFree(table: "entrants" | "registrations", id: string): Promise<boolean> {
  try {
    await sql.begin((tx) => tx`select id from ${tx(table)} where id = ${id} for update nowait`);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "55P03") return false; // lock_not_available
    throw err;
  }
}

/** Run `write` against a held division lock; report what it held while parked. */
async function heldWhileParked<T>(
  divisionId: string,
  write: () => Promise<T>,
  rows: { table: "entrants" | "registrations"; id: string }[],
): Promise<{ held: string[]; result: T }> {
  const lock = await holdDivisionLock(divisionId);
  let pending: Promise<T> | undefined;
  try {
    pending = write();
    // Surface a write that never waits (or fails) instead of waiting out the
    // poll. Both branches are marked handled: only the race reads them.
    const parked = parkedBehind(lock.pid);
    const finishedFirst = pending.then(() => {
      throw new Error("the write finished without waiting for the division lock");
    });
    parked.catch(() => {});
    finishedFirst.catch(() => {});
    await Promise.race([parked, finishedFirst]);
    const held: string[] = [];
    for (const r of rows) if (!(await rowLockFree(r.table, r.id))) held.push(`${r.table}:${r.id}`);
    await lock.release();
    return { held, result: await pending };
  } catch (err) {
    await lock.release().catch(() => {});
    await pending?.catch(() => {});
    throw err;
  }
}

describe.skipIf(!HAS_DB)("#850 R3-2 — the division lock is taken BEFORE the entrant's rows", () => {
  it("control: the probe DOES see a row lock another transaction holds", async () => {
    const r = await rig();
    const conn = await sql.reserve();
    try {
      await conn`begin`;
      await conn`select id from entrants where id = ${r.entrantIds[0]!} for update`;
      expect(await rowLockFree("entrants", r.entrantIds[0]!), "held → not free").toBe(false);
      await conn`commit`;
      expect(await rowLockFree("entrants", r.entrantIds[0]!), "released → free").toBe(true);
    } finally {
      conn.release();
    }
  });

  it("deleteEntrant (the reference order): parked on the division lock, it holds no entrant row", async () => {
    const r = await rig();
    const id = r.entrantIds[4]!;
    const { held } = await heldWhileParked(r.divisionId, () => deleteEntrant(r.auth, id), [{ table: "entrants", id }]);
    expect(held).toEqual([]);
    expect(await sql`select 1 from entrants where id = ${id}`, "and then it deleted the entrant").toHaveLength(0);
  });

  it("patchEntrant withdrawing an entrant: parked on the division lock, it holds no entrant row", async () => {
    const r = await rig();
    const id = r.entrantIds[4]!;
    const { held } = await heldWhileParked(r.divisionId, () => patchEntrant(r.auth, id, { status: "withdrawn" }), [
      { table: "entrants", id },
    ]);
    expect(held, "the entrant row was updated before the division lock").toEqual([]);
    const [e] = await sql<{ status: string }[]>`select status from entrants where id = ${id}`;
    expect(e!.status, "and then the withdrawal landed").toBe("withdrawn");
  });

  it("a registration withdrawal (withdrawCore): parked on the division lock, it holds neither the entrant row nor the entry's own row", async () => {
    const r = await rig();
    const id = r.entrantIds[4]!;
    const { registration, access_token } = await seedRegistration(
      r.competitionId,
      r.divisionId,
      { fee_cents: 0, currency: "gbp", payment_method: "offline" as const },
      { displayName: "Leaver", status: "confirmed" },
    );
    await sql`update registrations set entrant_id = ${id} where id = ${registration.id}`;
    const { held } = await heldWhileParked(r.divisionId, () => withdrawRegistrationPublic(registration.id, access_token), [
      { table: "entrants", id },
      { table: "registrations", id: registration.id },
    ]);
    expect(held, "rows locked before the division lock").toEqual([]);
    const [e] = await sql<{ status: string }[]>`select status from entrants where id = ${id}`;
    expect(e!.status, "and then the withdrawal landed").toBe("withdrawn");
  });
});
