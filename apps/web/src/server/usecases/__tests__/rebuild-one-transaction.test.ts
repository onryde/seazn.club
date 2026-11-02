// W3 Task 1 (X-RB-1, design G3, #840, FX-G13) — Rebuild keeps times and
// courts, and deletes and regenerates in ONE transaction. Real Postgres, the
// full usecase pipeline; skipped without DATABASE_URL.
//
// Two defects on main this file is the regression for:
//   1. Rebuild deleted every fixture and regenerated fresh rows, so every time
//      and court an organiser had laid out on the stage was gone (#840). The
//      regenerate now inherits them by POSITION — (pool, round, seq) — through
//      `carrySlots` (lib/rebuild-slots.ts).
//   2. The delete committed in its own transaction and the regenerate ran in a
//      second one, so a regenerate that threw left the organiser an EMPTY stage
//      (FX-G13). Both now share one transaction: a refusal anywhere rolls the
//      delete back and the old board stands, slots and all.
//
// Expected slots are the ones each test writes itself before pressing Rebuild,
// never values read back from the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { SCHEDULE_LOCKED_CODE } from "@/lib/schedule-lock";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { setDivisionLocks } from "../history";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures, rebuildStageFixtures } from "../stages";
import { createCourt, createVenue } from "../venues";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Row {
  id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** postgres.js parses `timestamptz` into a JS Date. */
  scheduled_at: Date | string | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, pool_id, round_no, seq_in_round, ext_key, home_entrant_id, away_entrant_id,
           scheduled_at, court_id, venue_id, schedule_locked
    from fixtures where stage_id = ${stageId}
    order by pool_id nulls first, round_no, seq_in_round`;
}

const iso = (at: Date | string | null) => (at instanceof Date ? at.toISOString() : at);
const position = (r: Pick<Row, "pool_id" | "round_no" | "seq_in_round">) =>
  `${r.pool_id ?? "-"}|${r.round_no}|${r.seq_in_round}`;

/** The slot a row holds, in a shape a whole-object `toEqual` can compare. */
const slotOf = (r: Row) => ({
  scheduled_at: iso(r.scheduled_at),
  court_id: r.court_id,
  venue_id: r.venue_id,
  schedule_locked: r.schedule_locked,
});

async function seedDivision(
  auth: AuthCtx,
  sport: { sport_key: string; variant_key: string; config: Record<string, unknown> },
  count: number,
): Promise<{ divisionId: string; entrants: string[] }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Rebuild " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    ...sport,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: count }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  return { divisionId: division.id, entrants: entrants.map((e) => e.id) };
}

const GENERIC = { sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG };
const BADMINTON = { sport_key: "badminton", variant_key: "bwf", config: {} };

/** Two real courts in one venue: a carried court must still resolve, and its
 *  venue must still agree with it (the composite FK). */
async function twoCourts(auth: AuthCtx): Promise<{ venueId: string; courts: [string, string] }> {
  const venue = await createVenue(auth, { name: "Main " + randomUUID().slice(0, 4), sort: 0 });
  const c1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  const c2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
  return { venueId: venue.id, courts: [c1.id, c2.id] };
}

/** Lay out a distinct slot on each row: its own time (one hour apart, in
 *  order), alternating courts, and a pin on every third row so the lock is
 *  carried too. Returns position → the slot written. */
async function layOut(rows: Row[], venueId: string, courts: [string, string]): Promise<Map<string, ReturnType<typeof slotOf>>> {
  const written = new Map<string, ReturnType<typeof slotOf>>();
  for (const [i, r] of rows.entries()) {
    const at = new Date(Date.UTC(2030, 5, 15, 8 + i, 0, 0)).toISOString();
    const court = courts[i % 2]!;
    const locked = i % 3 === 0;
    await sql`
      update fixtures set scheduled_at = ${at}, court_id = ${court}, venue_id = ${venueId},
                          schedule_locked = ${locked}
      where id = ${r.id}`;
    written.set(position(r), { scheduled_at: at, court_id: court, venue_id: venueId, schedule_locked: locked });
  }
  return written;
}

describe.skipIf(!HAS_DB)("X-RB-1 Rebuild keeps times and courts", () => {
  it("X-RB-1 a Swiss pre-Start Rebuild keeps every board's scheduled_at and court_id", async () => {
    const { auth } = await seedOrg();
    // Seven: three boards and a bye per round. Withdrawing one leaves six,
    // three boards and no bye, so every board keeps its position.
    const { divisionId, entrants } = await seedDivision(auth, BADMINTON, 7);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null,
    });
    await generateStageFixtures(auth, stage!.id); // mint shells for rounds 1–3
    const { venueId, courts } = await twoCourts(auth);
    const boards = (await rowsOf(stage!.id)).filter((r) => !r.ext_key!.endsWith("-bye"));
    expect(boards).toHaveLength(9);
    const written = await layOut(boards, venueId, courts);

    await generateStageFixtures(auth, stage!.id); // Pair round 1
    // A board player leaves before Start: the roster drift Rebuild answers.
    const r1 = (await rowsOf(stage!.id)).find((r) => r.ext_key === "sw-r1-b1")!;
    const leaving = r1.home_entrant_id!;
    expect(entrants).toContain(leaving);
    await patchEntrant(auth, leaving, { status: "withdrawn" });

    const out = await rebuildStageFixtures(auth, stage!.id);

    const after = await rowsOf(stage!.id);
    // Six now: three boards per round, no bye — and every one holds its slot.
    expect(after.map((r) => r.ext_key)).toEqual([
      "sw-r1-b1", "sw-r1-b2", "sw-r1-b3",
      "sw-r2-b1", "sw-r2-b2", "sw-r2-b3",
      "sw-r3-b1", "sw-r3-b2", "sw-r3-b3",
    ]);
    let checked = 0;
    for (const r of after) {
      expect(slotOf(r), r.ext_key!).toEqual(written.get(position(r)));
      checked++;
    }
    expect(checked).toBe(9);
    // The rows really are new (a rebuild, not an in-place edit).
    expect(after.some((r) => boards.some((b) => b.id === r.id))).toBe(false);
    expect(out.slots).toEqual({ kept: 9, freed: 0, unscheduled: 0 });
  });

  // W3 fix round 1 (controller ruling): a Rebuild that SHRINKS a Swiss round
  // dooms boards in the pre-Start reshape's order (`chooseDoomedBoards`), not
  // by seq. b4 holds a slot and b3 does not, so b4's slot lands on the new b3
  // and nothing is freed — the positional carry used to free b4's slot here
  // while the bare b3 kept its (empty) place.
  it("X-RB-1 a shrinking Swiss Rebuild keeps the laid-out b4's slot when the bare b3 is the board that goes", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, BADMINTON, 8); // four boards a round
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    const { venueId, courts } = await twoCourts(auth);
    const round1 = (await rowsOf(stage!.id)).filter((r) => r.round_no === 1);
    const pick = (key: string) => round1.find((r) => r.ext_key === key)!;
    // layOut pins its first row (b1); b2 and b4 hold a time and a court; b3 is bare.
    const written = await layOut([pick("sw-r1-b1"), pick("sw-r1-b2"), pick("sw-r1-b4")], venueId, courts);

    await patchEntrant(auth, entrants[7]!, { status: "withdrawn" }); // seven: three boards and a bye
    const out = await rebuildStageFixtures(auth, stage!.id);

    const after = (await rowsOf(stage!.id)).filter((r) => r.round_no === 1);
    expect(after.map((r) => r.ext_key)).toEqual(["sw-r1-b1", "sw-r1-b2", "sw-r1-b3", "sw-r1-bye"]);
    expect(slotOf(after[0]!)).toEqual(written.get("-|1|1"));
    expect(slotOf(after[1]!)).toEqual(written.get("-|1|2"));
    expect(slotOf(after[2]!), "the new b3 holds the old b4's slot").toEqual(written.get("-|1|4"));
    expect(slotOf(after[3]!)).toEqual({ scheduled_at: null, court_id: null, venue_id: null, schedule_locked: false });
    expect(out.slots).toEqual({ kept: 3, freed: 0, unscheduled: 0 });
  });

  it("X-RB-1 a shrinking Swiss Rebuild with every board laid out frees an unlocked board's slot, keeps the pinned b4's, and the new bye takes none", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, BADMINTON, 8); // four boards a round
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    const { venueId, courts } = await twoCourts(auth);
    const round1 = (await rowsOf(stage!.id)).filter((r) => r.round_no === 1);
    expect(round1.map((r) => r.ext_key)).toEqual(["sw-r1-b1", "sw-r1-b2", "sw-r1-b3", "sw-r1-b4"]);
    // Every board holds a slot; layOut pins every third row, so b1 and b4 are locked.
    const written = await layOut(round1, venueId, courts);
    expect([...written.values()].map((w) => w.schedule_locked)).toEqual([true, false, false, true]);

    await patchEntrant(auth, entrants[7]!, { status: "withdrawn" }); // seven: three boards and a bye
    const out = await rebuildStageFixtures(auth, stage!.id);

    const after = (await rowsOf(stage!.id)).filter((r) => r.round_no === 1);
    expect(after.map((r) => r.ext_key)).toEqual(["sw-r1-b1", "sw-r1-b2", "sw-r1-b3", "sw-r1-bye"]);
    // Unlocked first, highest seq among them: b3 goes, the locked b4 survives onto the new b3.
    expect(after.slice(0, 3).map(slotOf)).toEqual([written.get("-|1|1"), written.get("-|1|2"), written.get("-|1|4")]);
    expect(slotOf(after[3]!)).toEqual({ scheduled_at: null, court_id: null, venue_id: null, schedule_locked: false });
    // b3's slot has nowhere to go and is counted, never silently dropped.
    // Round 2's boards held nothing, so they are neither kept nor unscheduled.
    expect(out.slots).toEqual({ kept: 3, freed: 1, unscheduled: 0 });
  });

  it("X-RB-1 a league Rebuild keeps slots by position", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id); // 3 rounds × 2 matches
    const { venueId, courts } = await twoCourts(auth);
    const before = await rowsOf(stage!.id);
    expect(before).toHaveLength(6);
    const written = await layOut(before, venueId, courts);

    // One out, one in: the same field size, so every position survives — but
    // the people on it change, which is why the board needed rebuilding.
    await patchEntrant(auth, entrants[0]!, { status: "withdrawn" });
    const [late] = await createEntrants(auth, divisionId, [
      { kind: "individual", display_name: "E5", seed: 5, members: [] },
    ]);

    const out = await rebuildStageFixtures(auth, stage!.id);

    const after = await rowsOf(stage!.id);
    expect(after.map(position)).toEqual(before.map(position));
    const seated = new Set(after.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]));
    expect(seated.has(entrants[0]!)).toBe(false);
    expect(seated.has(late!.id)).toBe(true);
    let checked = 0;
    for (const r of after) {
      expect(slotOf(r), position(r)).toEqual(written.get(position(r)));
      checked++;
    }
    expect(checked).toBe(6);
    expect(out.slots).toEqual({ kept: 6, freed: 0, unscheduled: 0 });
    expect(out.removed).toBe(6);
    expect(out.created).toBe(6);
  });

  it("X-RB-1 a group Rebuild keeps each pool's slots in that pool", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 6);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } }, progression: null,
    });
    await generateStageFixtures(auth, stage!.id); // two pools of three
    const { venueId, courts } = await twoCourts(auth);
    const before = await rowsOf(stage!.id);
    const pools = new Set(before.map((r) => r.pool_id));
    expect(pools.size).toBe(2);
    expect(pools.has(null)).toBe(false);
    const written = await layOut(before, venueId, courts);

    await patchEntrant(auth, entrants[5]!, { status: "withdrawn" });
    await createEntrants(auth, divisionId, [{ kind: "individual", display_name: "E7", seed: 7, members: [] }]);

    const out = await rebuildStageFixtures(auth, stage!.id);

    const after = await rowsOf(stage!.id);
    expect(after.map(position).sort()).toEqual(before.map(position).sort());
    for (const r of after) expect(slotOf(r), position(r)).toEqual(written.get(position(r)));
    expect(out.slots).toEqual({ kept: before.length, freed: 0, unscheduled: 0 });
  });
});

describe.skipIf(!HAS_DB)("X-RB-1 Rebuild is one transaction", () => {
  it("X-RB-1 a regenerate that throws rolls the delete back", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } }, progression: null,
    });
    await generateStageFixtures(auth, stage!.id); // two pools of two: one match each
    const { venueId, courts } = await twoCourts(auth);
    const before = await rowsOf(stage!.id);
    expect(before).toHaveLength(2);
    const written = await layOut(before, venueId, courts);

    // Two leave: two entrants snake into two pools of one, which pairs
    // nothing — the regenerate refuses `group_too_few_entrants`, AFTER the
    // delete has run in the same transaction.
    await patchEntrant(auth, entrants[2]!, { status: "withdrawn" });
    await patchEntrant(auth, entrants[3]!, { status: "withdrawn" });

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      code: "STAGE_NOT_READY",
      data: { reason: "group_too_few_entrants" },
    });

    // The old board still stands: the same fixture ids, each with its slot.
    const after = await rowsOf(stage!.id);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    for (const r of after) expect(slotOf(r), position(r)).toEqual(written.get(position(r)));
  });

  it("Rebuild still refuses STAGE_HAS_RESULTS and SCHEDULE_LOCKED before any delete", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, GENERIC, 3);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const ids = async () => (await rowsOf(stage!.id)).map((r) => r.id);
    const original = await ids();
    expect(original).toHaveLength(3);

    await setDivisionLocks(auth, divisionId, { schedule_locked: true });
    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({ status: 422, code: SCHEDULE_LOCKED_CODE });
    expect(await ids()).toEqual(original);
    await setDivisionLocks(auth, divisionId, { schedule_locked: false });

    await startDivision(auth, divisionId);
    await appendEvent(auth.orgId, fixtures[0]!.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, fixtures[0]!.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({ status: 409, code: "STAGE_HAS_RESULTS" });
    expect(await ids()).toEqual(original);
  });

  // Format-agnostic, and a bracket too: a root knockout drawn from a stored
  // `config.qualified` list (the shape dead-feeder-cascade.test.ts rebuilds on
  // purpose) is re-drawn from that same list, and every round keeps its slots.
  it("X-RB-1 a knockout drawn from config.qualified rebuilds from the same list and keeps every slot", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "Finals", config: {}, progression: null,
    });
    await sql`update stages set config = ${sql.json({ qualified: entrants } as never)} where id = ${stage!.id}`;
    await generateStageFixtures(auth, stage!.id);
    const before = await rowsOf(stage!.id);
    expect(new Set(before.map((r) => r.round_no)).size, "a bracket of more than one round").toBeGreaterThan(1);
    const { venueId, courts } = await twoCourts(auth);
    const written = await layOut(before, venueId, courts);

    const out = await rebuildStageFixtures(auth, stage!.id);

    const after = await rowsOf(stage!.id);
    expect(after.map((r) => [r.ext_key, r.home_entrant_id, r.away_entrant_id])).toEqual(
      before.map((r) => [r.ext_key, r.home_entrant_id, r.away_entrant_id]),
    );
    let checked = 0;
    for (const r of after) {
      expect(slotOf(r), position(r)).toEqual(written.get(position(r)));
      checked++;
    }
    expect(checked).toBe(before.length);
    expect(out.slots).toEqual({ kept: before.length, freed: 0, unscheduled: 0 });
  });
});
