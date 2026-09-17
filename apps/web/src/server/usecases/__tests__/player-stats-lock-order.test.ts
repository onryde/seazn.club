// The player card and the digest never wait on a division's stats lock, in
// real Postgres (owner ruling 2026-09-16, review n3).
//
// Every fold takes its division's stats lock (`recomputePlayerStats`), held to
// the end of the transaction. A transaction that WAITS on several divisions'
// locks in whatever order it iterates can hold division X while it waits on Y;
// if another holds Y and waits on X, Postgres kills one of them (40P01).
// `lockPlayerStatsDivisions` is the ordering authority for the transactions
// that must wait (person merge and unmerge, pinned in
// `player-stats-refresh.test.ts`). The player card (`personStats`) and the
// digest (`loadDivisionHeadlines`) instead try each lock and never wait
// (`playerStatsWithoutWaiting`): a division held elsewhere is folded in memory,
// or served from its snapshot when that is current. This file pins that.
//
// Each case holds each of the reader's divisions' locks in turn, from a second
// connection. A reader that waits on any of them times out below; one that
// never waits finishes while the lock is held. No iteration order is assumed,
// so nothing is left to chance (final review m1: this used to pick a person
// whose divisions a hash plan happened to return highest id first, and about
// one run in sixteen found none).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { loadDivisionHeadlines, type ActiveDivision } from "../org-posts";
import { lockPlayerStats, personStats } from "../player-stats";
import { seedFootballCatalog, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const openGates: Array<() => void> = [];

afterEach(() => {
  for (const release of openGates.splice(0)) release();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function person(orgId: string, fullName: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, consent)
    values (${orgId}, ${fullName}, ${sql.json({} as never)})
    returning id`;
  return row!.id;
}

/** A football competition with `n` divisions, each with one team whose
 *  members are the persons `membersOf(i)` names. */
async function competition(auth: AuthCtx, n: number, membersOf: (i: number) => string[]) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Lock Order Cup " + randomUUID().slice(0, 8),
    visibility: "public",
    branding: {},
  });
  const divisions: ActiveDivision[] = [];
  for (let i = 0; i < n; i += 1) {
    const division = await createDivision(auth, comp.id, {
      name: `Division ${i}`,
      sport_key: "football",
      variant_key: "default",
      config: {},
    });
    const members = membersOf(i);
    if (members.length > 0) {
      await createEntrants(auth, division.id, [
        {
          kind: "team",
          display_name: `Team ${i}`,
          seed: 1,
          members: members.map((person_id, k) => ({
            person_id,
            squad_number: k + 1,
            is_captain: k === 0,
            roles: [],
            default_position_key: null,
          })),
        },
      ]);
    }
    const [row] = await sql<{ module_version: string }[]>`
      select module_version from divisions where id = ${division.id}`;
    divisions.push({
      division_id: division.id,
      division_name: division.name as string,
      sport_key: "football",
      module_version: row!.module_version,
    });
  }
  return divisions;
}

/** Run `reader` while another transaction holds `held`'s stats lock, then
 *  release it. */
async function whileHeld(orgId: string, held: string, reader: () => Promise<unknown>): Promise<unknown> {
  let otherHasIt!: () => void;
  const otherReady = new Promise<void>((resolve) => {
    otherHasIt = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  openGates.push(release);
  const other = withTenant(orgId, async (tx) => {
    await lockPlayerStats(tx, held);
    otherHasIt();
    await released;
  });
  await within(otherReady, 20_000, "the other transaction took the division's lock");
  const readerOutcome = await within(reader(), 5_000, "the reader finished without waiting on the held division").then(
    () => "ok" as const,
    (err: unknown) => err,
  );
  release();
  await within(other, 30_000, "the other transaction finished");
  return readerOutcome;
}

const describeError = (outcome: unknown) =>
  outcome === "ok" ? "ok" : `${(outcome as { code?: string }).code}: ${(outcome as Error).message}`;

describe.skipIf(!HAS_DB)("the player card and the digest never wait on a division's stats lock (review n3)", () => {
  it("the digest's headline loader, with each of its divisions held in turn", async () => {
    const { auth } = await seedOrg("pro");
    await seedFootballCatalog();
    const divisions = await competition(auth, 2, () => []);
    for (const { division_id: held } of divisions) {
      const outcome = await whileHeld(auth.orgId, held, () =>
        withTenant(auth.orgId, (tx) => loadDivisionHeadlines(tx, divisions)),
      );
      expect(describeError(outcome), `division ${held} held`).toBe("ok");
    }
  }, 90_000);

  it("the player card (personStats) of a person in two divisions, with each held in turn", async () => {
    const { auth } = await seedOrg("pro");
    await seedFootballCatalog();
    const personId = await person(auth.orgId, "Pat Player");
    const divisions = await competition(auth, 2, () => [personId]);
    for (const { division_id: held } of divisions) {
      const outcome = await whileHeld(auth.orgId, held, () => personStats(auth, personId));
      expect(describeError(outcome), `division ${held} held`).toBe("ok");
    }
  }, 90_000);
});
