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
import { roundRoleKey } from "@seazn/engine/competition";
import { isByeLine } from "@/lib/bye-line";
import { roundRoleFor } from "@/lib/round-role-label";
import { holdsSlot } from "@/lib/rebuild-slots";
import type { AuthCtx } from "@/server/api-v1/auth";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { setDivisionLocks } from "../history";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures, overrideStandings, rebuildStageFixtures } from "../stages";
import { callFixtureToCourt, undoCall } from "../match-day-call";
import { createCourt, createVenue } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { createStagesWithLegacy } from "./_legacy-standalone-stage";
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

// W4 Task 2 (K4, X-LE-9; owner ruling 257). A Match Day call writes a court and a time and nothing Rebuild's result guard
// read, so a stage whose only start was a called match rebuilt — the delete cascades into `fixture_calls`
// (V484__match_day_fixture_calls.sql), so the players standing at the court lost their match and its call. Badminton, one
// sport: neither the guard nor the call reads a sport column.
describe.skipIf(!HAS_DB)("X-LE-9 a called match is started", () => {
  it("X-LE-9 Rebuild refuses a stage whose only start is a live call", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, BADMINTON, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    const before = await rowsOf(stage!.id);
    const r1 = before.filter((r) => r.round_no === 1);
    expect(r1.length, "premise: two seated round-one lines").toBe(2);
    expect(r1.every((r) => r.home_entrant_id !== null && r.away_entrant_id !== null)).toBe(true);
    const { courts } = await twoCourts(auth);
    const called = r1[0]!;
    await callFixtureToCourt(auth, called.id, courts[0]);
    const [{ n: events }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events e join fixtures f on f.id = e.fixture_id where f.stage_id = ${stage!.id}`;
    const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${called.id}`;
    expect([events, status], "premise: nothing recorded, the call wrote no status").toEqual([0, "scheduled"]);

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({ status: 409, code: "STAGE_HAS_RESULTS" });
    expect((await rowsOf(stage!.id)).map((r) => r.id), "nothing deleted").toEqual(before.map((r) => r.id));
    const calls = await sql<{ court_id: string }[]>`select court_id from fixture_calls where fixture_id = ${called.id}`;
    expect(calls, "the call row survives").toEqual([{ court_id: courts[0] }]);

    // The positive pair: Undo call, and the stage nobody has started rebuilds.
    await undoCall(auth, called.id);
    const out = await rebuildStageFixtures(auth, stage!.id);
    expect(out.removed, "an uncalled stage rebuilds").toBe(before.length);
  });
});

// W4 app-A Task 4 (gap K3; X-RB-1). A knockout's `round_no` counts from its FIRST round (stages/generators.ts `bracketToGen`), so a
// Rebuild that carried slots by position handed an 8-bracket's final slot to a 16-bracket's semi-final, and a line that
// became a bye inherited a court. Rebuild now carries a knockout's slots by bracket ROLE (`bracketRoleKey`), and a bye
// line (`isByeLine`) neither gives nor takes a slot. Roles are read off what the engine stored — `is_final`, and the
// semi-finals are the round before it — and the expected slots are the ones each test writes, never values read back
// from `carrySlots`. single-sport: badminton (the brief's rig); the carry reads no sport field.
interface FullRow extends Row {
  is_final: boolean;
  status: string;
  outcome: unknown;
  home_slot_label: unknown;
  away_slot_label: unknown;
}

const fullRowsOf = (stageId: string) =>
  sql<FullRow[]>`
    select id, pool_id, round_no, seq_in_round, ext_key, home_entrant_id, away_entrant_id, scheduled_at, court_id,
           venue_id, schedule_locked, is_final, status, outcome, home_slot_label, away_slot_label
    from fixtures where stage_id = ${stageId}
    order by pool_id nulls first, round_no, seq_in_round`;

const NO_SLOT = { scheduled_at: null, court_id: null, venue_id: null, schedule_locked: false };
const bySlotTime = (a: ReturnType<typeof slotOf>, b: ReturnType<typeof slotOf>) =>
  String(a.scheduled_at).localeCompare(String(b.scheduled_at));

/** A badminton knockout of `n`, generated and laid out (a distinct time and court on every line). */
async function laidOutKnockout(n: number, kind: "knockout" | "double_elim" = "knockout") {
  const { auth } = await seedOrg();
  const { divisionId, entrants } = await seedDivision(auth, BADMINTON, n);
  const [stage] = await createStages(auth, divisionId, { seq: 1, kind, name: "Cup", config: {}, progression: null });
  await generateStageFixtures(auth, stage!.id);
  const before = await fullRowsOf(stage!.id);
  const { venueId, courts } = await twoCourts(auth);
  const written = await layOut(before, venueId, courts);
  return { auth, divisionId, entrants, stageId: stage!.id, before, written };
}

describe.skipIf(!HAS_DB)("X-RB-1 knockout Rebuild carries by bracket role (W4 T4, K3)", () => {
  it("X-RB-1 knockout 8→9 Rebuild: the final keeps the final's slot", async () => {
    const rig = await laidOutKnockout(8);
    const oldFinal = rig.before.find((r) => r.is_final)!;
    expect([rig.before.length, oldFinal.round_no], "rig: a bracket of 8 — seven lines, the final in round 3").toEqual([7, 3]);
    const slotsOfRound = (rows: FullRow[], round: number, written: Map<string, ReturnType<typeof slotOf>>) =>
      rows.filter((r) => r.round_no === round).map((r) => written.get(position(r))!).sort(bySlotTime);

    await createEntrants(rig.auth, rig.divisionId, [{ kind: "individual", display_name: "E9", seed: 9, members: [] }]);
    const out = await rebuildStageFixtures(rig.auth, rig.stageId);

    const after = await fullRowsOf(rig.stageId);
    const newFinal = after.find((r) => r.is_final)!;
    expect([after.length, newFinal.round_no], "premise: a bracket of 16 — the final moved to round 4").toEqual([15, 4]);
    expect(slotOf(newFinal), "the new final holds the old final's slot").toEqual(rig.written.get(position(oldFinal)));
    expect(
      after.filter((r) => r.round_no === newFinal.round_no - 1).map(slotOf).sort(bySlotTime),
      "each semi-final holds a semi-final's slot",
    ).toEqual(slotsOfRound(rig.before, oldFinal.round_no - 1, rig.written));
    expect(
      after.filter((r) => r.round_no === newFinal.round_no - 2).map(slotOf).sort(bySlotTime),
      "each quarter-final holds a quarter-final's slot",
    ).toEqual(slotsOfRound(rig.before, oldFinal.round_no - 2, rig.written));
    const roundOne = after.filter((r) => r.round_no === 1);
    expect(roundOne.length, "anti-vacuity: the new first round").toBe(8);
    for (const r of roundOne) expect(slotOf(r), `new round-one line ${r.seq_in_round} is unscheduled`).toEqual(NO_SLOT);
    const byes = roundOne.filter((r) => isByeLine(r));
    expect(byes.length, "premise: seven of the new first round are byes").toBe(7);
    expect(out.slots, "kept seven, freed none, the one real new line unscheduled").toEqual({ kept: 7, freed: 0, unscheduled: 1 });
  });

  it("X-RB-1 knockout 8→6 Rebuild: a line that becomes a bye frees its slot", async () => {
    const rig = await laidOutKnockout(8);
    const oldFinal = rig.before.find((r) => r.is_final)!;
    await patchEntrant(rig.auth, rig.entrants[6]!, { status: "withdrawn" });
    await patchEntrant(rig.auth, rig.entrants[7]!, { status: "withdrawn" });

    const out = await rebuildStageFixtures(rig.auth, rig.stageId);

    const after = await fullRowsOf(rig.stageId);
    const byes = after.filter((r) => isByeLine(r));
    expect([after.length, byes.length], "premise: six in a bracket of 8 — two quarter-finals are byes").toEqual([7, 2]);
    let checked = 0;
    for (const b of byes) {
      expect(holdsSlot(b), `bye line ${b.seq_in_round} holds no slot`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
    expect(slotOf(after.find((r) => r.is_final)!), "positive pair: the final keeps its slot").toEqual(rig.written.get(position(oldFinal)));
    const real = after.filter((r) => !isByeLine(r));
    for (const r of real) expect(holdsSlot(r), `real line ${position(r)} keeps a slot`).toBe(true);
    expect(out.slots, "the two bye lines' slots are reported freed").toEqual({ kept: 5, freed: 2, unscheduled: 0 });
  });

  it("X-RB-1 knockout 6→8 Rebuild: a bye that becomes a real line has nothing to inherit, and is counted unscheduled", async () => {
    // The other direction. A bye line holds no slot (X-SD-5), so the two quarter-finals that were byes for six are new
    // matches for eight with nothing laid out on them: the answer must say so (the organiser places them), not count them
    // carried. Only the real lines are laid out — a bye cannot be placed.
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, BADMINTON, 6);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
    await generateStageFixtures(auth, stage!.id);
    const before = await fullRowsOf(stage!.id);
    const oldByes = before.filter((r) => isByeLine(r));
    expect([before.length, oldByes.length], "premise: six in a bracket of 8 — two quarter-finals are byes").toEqual([7, 2]);
    const { venueId, courts } = await twoCourts(auth);
    const written = await layOut(before.filter((r) => !isByeLine(r)), venueId, courts);
    await createEntrants(auth, divisionId, [7, 8].map((n) => ({ kind: "individual" as const, display_name: `E${n}`, seed: n, members: [] })));

    const out = await rebuildStageFixtures(auth, stage!.id);

    const after = await fullRowsOf(stage!.id);
    expect([after.length, after.filter((r) => isByeLine(r)).length], "premise: eight — no byes").toEqual([7, 0]);
    let checked = 0;
    for (const r of after) {
      expect(slotOf(r), position(r)).toEqual(written.get(position(r)) ?? NO_SLOT);
      checked++;
    }
    expect(checked).toBe(7);
    expect(out.slots, "five kept, none freed, the two former byes unscheduled").toEqual({ kept: 5, freed: 0, unscheduled: 2 });
  });

  it("X-RB-1 a double-elimination Rebuild still carries by position (knockout, stepladder and page playoff read roles; double elimination does not)", async () => {
    // 4 → 5 changes the lanes' depth, so position and role disagree here: a role carry would move every lower-bracket
    // and grand-final slot. Expected = the rule as it stood (position), with a bye line holding nothing (X-SD-5).
    // KNOWN DEFECT PINNED (B1a review #6, parked): this freezes today's position carry for double elimination, which is
    // K3's own defect — the new grand final does NOT inherit the old grand final's slot. It flips when double
    // elimination gets role keys; until then a red here means the carry changed, not that it was fixed or broke.
    const rig = await laidOutKnockout(4, "double_elim");
    await createEntrants(rig.auth, rig.divisionId, [{ kind: "individual", display_name: "E5", seed: 5, members: [] }]);

    const out = await rebuildStageFixtures(rig.auth, rig.stageId);

    const after = await fullRowsOf(rig.stageId);
    let checked = 0;
    let carried = 0;
    let unscheduled = 0;
    for (const r of after) {
      const want = isByeLine(r) ? undefined : rig.written.get(position(r));
      expect(slotOf(r), `${position(r)} ${r.ext_key}`).toEqual(want ?? NO_SLOT);
      if (want) carried++;
      else if (!isByeLine(r)) unscheduled++;
      checked++;
    }
    expect(checked, "anti-vacuity: every rebuilt line checked").toBe(after.length);
    expect(carried, "premise: some positions survive").toBeGreaterThan(0);
    expect(out.slots).toEqual({ kept: carried, freed: rig.before.length - carried, unscheduled });
    // Position and role really disagree on this rig, or the case could not tell them apart.
    const oldGf = rig.before.filter((r) => r.is_final).map(position);
    const newGf = after.filter((r) => r.is_final).map(position);
    expect(newGf, "premise: the grand final moved position").not.toEqual(oldGf);
  });
});

// T26c item B (controller ruling 2026-11-09, re-review): a stepladder and a page playoff carry by bracket ROLE too. A
// stepladder's `round_no` counts from its bottom rung (the engine's `generateStepladder`: game j in round j + 1), so a
// 4 -> 5 Rebuild that carried by position handed the final's time and court to a rung. Expected values come from the
// engine, never from `carrySlots`: each line's role is the engine's own name for it (`roundRole`, through
// `roundRoleFor`, the namer every surface reads), and a stepladder game's home seat is the seed waiting on it
// (`generateStepladder`), so "the game seed 2 waits on" is the same game at 4 and at 5. Both are legacy standalone
// stages, the only kind of root stepladder or page playoff a Rebuild reaches since X-SP-6. single-sport: badminton (the
// K3 rig above); the carry reads no sport field.
/** The engine's role key for each line of a stage, by fixture id. */
async function engineRolesOf(stageId: string, kind: string): Promise<Map<string, string>> {
  const rows = await sql<
    { id: string; round_no: number; lane: "WB" | "LB" | "GF" | null; is_final: boolean; third_place: boolean; conditional: boolean; ext_key: string | null }[]
  >`select id, round_no, lane, is_final, third_place, conditional, ext_key from fixtures where stage_id = ${stageId}`;
  return new Map(rows.map((r) => [r.id, roundRoleKey(roundRoleFor(rows, r, kind, r.ext_key))]));
}

/** A legacy root stepladder or page playoff of `n`, generated and laid out (a distinct time and court on every line). */
async function laidOutLegacy(kind: "stepladder" | "page_playoff", n: number) {
  const { auth } = await seedOrg();
  const { divisionId, entrants } = await seedDivision(auth, BADMINTON, n);
  const [stage] = await createStagesWithLegacy(auth, divisionId, { seq: 1, kind, name: "Playoff", config: {}, progression: null });
  await generateStageFixtures(auth, stage!.id);
  const before = await fullRowsOf(stage!.id);
  const { venueId, courts } = await twoCourts(auth);
  const written = await layOut(before, venueId, courts);
  return { auth, divisionId, entrants, stageId: stage!.id, before, written, roles: await engineRolesOf(stage!.id, kind) };
}

describe.skipIf(!HAS_DB)("X-RB-1 stepladder and page playoff Rebuild carry by bracket role (T26c)", () => {
  it("X-RB-1 stepladder 4→5 Rebuild: the final keeps the final's slot, each waiting seed's game keeps its slot, the new bottom rung is unscheduled", async () => {
    const rig = await laidOutLegacy("stepladder", 4);
    const oldFinal = rig.before.filter((r) => rig.roles.get(r.id) === "final");
    expect([rig.before.length, oldFinal.length], "rig: four climb in three games, one of them the final").toEqual([3, 1]);
    await createEntrants(rig.auth, rig.divisionId, [{ kind: "individual", display_name: "E5", seed: 5, members: [] }]);

    const out = await rebuildStageFixtures(rig.auth, rig.stageId);

    const after = await fullRowsOf(rig.stageId);
    const roles = await engineRolesOf(rig.stageId, "stepladder");
    const newFinal = after.filter((r) => roles.get(r.id) === "final");
    expect([after.length, newFinal.length], "premise: five climb in four games, one of them the final").toEqual([4, 1]);
    // Position and role really disagree on this rig, or the case could not tell them apart.
    const atOldFinalsPlace = after.find((r) => position(r) === position(oldFinal[0]!))!;
    expect(roles.get(atOldFinalsPlace.id), "premise: the old final's place holds a rung after the Rebuild").toMatch(/^rung_\d+$/);
    expect(slotOf(newFinal[0]!), "the new final holds the old final's slot").toEqual(rig.written.get(position(oldFinal[0]!)));

    let checked = 0;
    for (const r of after) {
      expect(r.home_entrant_id, `premise: ${roles.get(r.id)} seats its waiting seed`).not.toBeNull();
      const was = rig.before.find((b) => b.home_entrant_id === r.home_entrant_id);
      expect(slotOf(r), `${roles.get(r.id)}: the slot of the game its seed waited on`).toEqual(was ? rig.written.get(position(was)) : NO_SLOT);
      checked++;
    }
    expect(checked, "anti-vacuity: every rebuilt game").toBe(4);
    const fresh = after.filter((r) => !rig.before.some((b) => b.home_entrant_id === r.home_entrant_id));
    expect(fresh.map((r) => roles.get(r.id)), "the one game nobody waited on before is the new bottom rung").toEqual(["rung_1"]);
    expect(out.slots, "kept three, freed none, the new bottom rung unscheduled").toEqual({ kept: 3, freed: 0, unscheduled: 1 });
  });

  it("X-RB-1 page playoff Rebuild after a roster swap: Q1, the Eliminator, Q2 and the final each keep their slot", async () => {
    // A page playoff is always four (the engine refuses any other count), so its lines never change place and role and
    // position agree here: this pins the role carry for the kind; the stepladder case above is the differential.
    const rig = await laidOutLegacy("page_playoff", 4);
    expect([...rig.roles.values()].sort(), "rig: the four roles").toEqual(["eliminator", "final", "qualifier1", "qualifier2"]);
    const slotByRole = new Map(rig.before.map((r) => [rig.roles.get(r.id)!, rig.written.get(position(r))!]));
    const gone = rig.entrants[3]!;
    await patchEntrant(rig.auth, gone, { status: "withdrawn" });
    await createEntrants(rig.auth, rig.divisionId, [{ kind: "individual", display_name: "E5", seed: 5, members: [] }]);

    const out = await rebuildStageFixtures(rig.auth, rig.stageId);

    const after = await fullRowsOf(rig.stageId);
    const roles = await engineRolesOf(rig.stageId, "page_playoff");
    expect(after.some((r) => r.home_entrant_id === gone || r.away_entrant_id === gone), "premise: the withdrawn seed is out of the new draw").toBe(false);
    let checked = 0;
    for (const r of after) {
      expect(slotOf(r), roles.get(r.id)).toEqual(slotByRole.get(roles.get(r.id)!));
      checked++;
    }
    expect(checked, "anti-vacuity: every rebuilt line").toBe(4);
    expect(out.slots).toEqual({ kept: 4, freed: 0, unscheduled: 0 });
  });
});

// W5 app-A Task 18 (RB-1; ruling 288's storage cleanup, G7; RB5-G1 under ruling 285). Rebuild holds on every round-robin row: a
// league of one, two and three legs, a pooled group of two legs, the catch-up lines and byes a late entry wrote, the rank pins,
// the withdrawal's expunged lines. The rulebook's answer for each row: what Rebuild rewrites it rewrites in ONE transaction; what
// it holds (a played stage, an appended ledger row) it holds by refusing BEFORE any delete. single-sport: generic — Rebuild's
// carry, its result guard and its storage rewrites read no sport column (the sport sweeps live in the late-entry and
// rank-override suites this file's rows come from).
const RR_KEY = /(?:^|-)rr-r\d+-c\d+-L(\d+)$/; // a pool prefixes its key (`rrExtKey`)
const legOf = (r: Pick<Row, "ext_key">) => Number(RR_KEY.exec(r.ext_key ?? "")?.[1]);

async function configOf(stageId: string): Promise<Record<string, unknown>> {
  const [row] = await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`;
  return row!.config;
}
async function eventCount(divisionId: string, type?: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events where division_id = ${divisionId} and (${type ?? null}::text is null or type = ${type ?? null})`;
  return n;
}
async function scoreEventCount(stageId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from score_events e join fixtures f on f.id = e.fixture_id where f.stage_id = ${stageId}`;
  return n;
}
/** Everything a refused Rebuild must leave byte-identical: every fixture row, the stage's config, the ledger and the score events. */
async function stageSnapshot(stageId: string, divisionId: string) {
  return {
    fixtures: await sql`select * from fixtures where stage_id = ${stageId} order by pool_id nulls first, round_no, seq_in_round, id`,
    config: await configOf(stageId),
    ledger: await eventCount(divisionId),
    scoreEvents: await scoreEventCount(stageId),
  };
}
const SEEDED_BYES = (rows: { round_no: number; entrant_id: string }[], name: Map<string, string>) =>
  rows.map((b) => `r${b.round_no}:${name.get(b.entrant_id) ?? b.entrant_id}`);

describe.skipIf(!HAS_DB)("RB-1 Rebuild keeps times and courts on a league of one, two and three legs (RB5-G1: legs 1-8 stay)", () => {
  it("RB-1 a league Rebuild keeps every line's slot by position and draws every leg again, for legs 1, 2 and 3", async () => {
    let checked = 0;
    for (const legs of [1, 2, 3]) {
      const { auth } = await seedOrg();
      const { divisionId, entrants } = await seedDivision(auth, GENERIC, 4);
      const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: { legs }, progression: null });
      await generateStageFixtures(auth, stage!.id);
      const { venueId, courts } = await twoCourts(auth);
      const before = await rowsOf(stage!.id);
      // Four play six pairs a leg (the pair count, not the code's schedule): legs of them.
      expect(before, `legs ${legs}: premise`).toHaveLength(6 * legs);
      const written = await layOut(before, venueId, courts);

      await patchEntrant(auth, entrants[0]!, { status: "withdrawn" });
      const [late] = await createEntrants(auth, divisionId, [{ kind: "individual", display_name: "E5", seed: 5, members: [] }]);
      const out = await rebuildStageFixtures(auth, stage!.id);

      const after = await rowsOf(stage!.id);
      expect(after.map(position), `legs ${legs}: every position survives`).toEqual(before.map(position));
      for (const r of after) {
        expect(slotOf(r), `legs ${legs} ${position(r)}`).toEqual(written.get(position(r)));
        checked++;
      }
      // Every leg is drawn again: each of legs 1..legs holds the six pairs, and nobody plays twice in a leg.
      for (let leg = 1; leg <= legs; leg++) {
        const inLeg = after.filter((r) => legOf(r) === leg);
        expect(inLeg, `legs ${legs}: leg ${leg} holds six pairs`).toHaveLength(6);
        expect(new Set(inLeg.map((r) => [r.home_entrant_id, r.away_entrant_id].sort().join("|"))).size, `legs ${legs}: leg ${leg} pairs are distinct`).toBe(6);
      }
      expect(after.every((r) => RR_KEY.test(r.ext_key ?? "")), `legs ${legs}: the generator's keys only`).toBe(true);
      const seated = new Set(after.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]));
      expect([seated.has(entrants[0]!), seated.has(late!.id)], `legs ${legs}: the leaver is out, the newcomer in`).toEqual([false, true]);
      expect(out.slots).toEqual({ kept: 6 * legs, freed: 0, unscheduled: 0 });
    }
    expect(checked, "anti-vacuity: 6 + 12 + 18 lines checked").toBe(36);
  });

  it("RB-1 a pooled group of two legs keeps each pool's slots in that pool, and both legs of both pools are drawn again", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 6);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "group", name: "G", config: { pools: { count: 2 }, legs: 2 }, progression: null });
    await generateStageFixtures(auth, stage!.id); // two pools of three, two legs: three pairs a leg a pool
    const { venueId, courts } = await twoCourts(auth);
    const before = await rowsOf(stage!.id);
    expect(before, "premise: 2 pools x 3 pairs x 2 legs").toHaveLength(12);
    expect(new Set(before.map((r) => r.pool_id)).size).toBe(2);
    const written = await layOut(before, venueId, courts);

    await patchEntrant(auth, entrants[5]!, { status: "withdrawn" });
    const [e7] = await createEntrants(auth, divisionId, [{ kind: "individual", display_name: "E7", seed: 7, members: [] }]);
    const out = await rebuildStageFixtures(auth, stage!.id);

    const after = await rowsOf(stage!.id);
    expect(after.map(position).sort()).toEqual(before.map(position).sort());
    // B4 fix wave (T18 m2): each pool of three sits one out a round, per leg, and the Rebuild rewrites those byes POOL BY POOL.
    // Expected from the engine's own schedule (generateRoundRobin over each pool's members as the rebuilt lines seat them).
    const seedOf = new Map<string, number>([...entrants.map((id, i) => [id, i + 1] as const), [e7!.id, 7]]);
    const stored = ((await configOf(stage!.id)).round_byes ?? []) as { pool: string | null; round_no: number; leg: number; entrant_id: string }[];
    let poolsChecked = 0;
    for (const pool of new Set(after.map((r) => r.pool_id))) {
      const members = [...new Set(after.filter((r) => r.pool_id === pool).flatMap((r) => [r.home_entrant_id!, r.away_entrant_id!]))].sort(
        (a, b) => seedOf.get(a)! - seedOf.get(b)!,
      );
      expect(members, `pool ${pool}: premise, a pool of three`).toHaveLength(3);
      const engine = generateRoundRobin({ entrants: members, seeds: new Map(members.map((id) => [id, seedOf.get(id)!])), config: { legs: 2 } });
      const want = engine.rounds.flatMap((r) => (r.bye === undefined ? [] : [`L${r.leg} r${r.roundNo}:${r.bye}`]));
      expect(want, `pool ${pool}: premise, one bye a round, three rounds a leg`).toHaveLength(6);
      expect(stored.filter((b) => b.pool === pool).map((b) => `L${b.leg} r${b.round_no}:${b.entrant_id}`), `pool ${pool}: its byes`).toEqual(want);
      poolsChecked++;
    }
    expect(poolsChecked).toBe(2);
    expect(stored, "no bye names a pool the Rebuild did not draw").toHaveLength(12);
    let checked = 0;
    for (const r of after) {
      expect(slotOf(r), position(r)).toEqual(written.get(position(r)));
      checked++;
    }
    expect(checked).toBe(12);
    for (const pool of new Set(after.map((r) => r.pool_id))) {
      for (const leg of [1, 2]) {
        expect(after.filter((r) => r.pool_id === pool && legOf(r) === leg), `pool ${pool} leg ${leg}`).toHaveLength(3);
      }
    }
    expect(out.slots).toEqual({ kept: 12, freed: 0, unscheduled: 0 });
  });
});

describe.skipIf(!HAS_DB)("RB-1 Rebuild after a result refuses and holds every round-robin row", () => {
  async function playOne(auth: AuthCtx, stageId: string): Promise<void> {
    const first = (await rowsOf(stageId))[0]!;
    await appendEvent(auth.orgId, first.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, first.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  }

  it("RB-1 a league of three legs and a pooled group with a result: Rebuild refuses STAGE_HAS_RESULTS and nothing moves (rows, slots, round_byes, pins, ledger)", async () => {
    let checked = 0;
    for (const spec of [
      { kind: "league" as const, config: { legs: 3 }, n: 5 },
      { kind: "group" as const, config: { pools: { count: 2 }, legs: 2 }, n: 7 },
    ]) {
      const { auth } = await seedOrg();
      const { divisionId, entrants } = await seedDivision(auth, GENERIC, spec.n);
      const [stage] = await createStages(auth, divisionId, { seq: 1, kind: spec.kind, name: "T", config: spec.config, progression: null });
      await generateStageFixtures(auth, stage!.id);
      const { venueId, courts } = await twoCourts(auth);
      await layOut(await rowsOf(stage!.id), venueId, courts);
      // A pin and the stage's byes (odd fields: a league of five, a pool of three) are the rows a Rebuild would have rewritten.
      await overrideStandings(auth, stage!.id, { rows: [{ entrant_id: entrants[0]!, rank: 1, reason: "placement game" }] });
      await playOne(auth, stage!.id);
      const config = await configOf(stage!.id);
      expect((config.round_byes as unknown[] | undefined)?.length ?? 0, `${spec.kind}: premise, the stage records byes`).toBeGreaterThan(0);
      expect((config.rank_overrides as unknown[] | undefined)?.length, `${spec.kind}: premise, a pin is stored`).toBe(1);
      const snapshot = await stageSnapshot(stage!.id, divisionId);
      expect(snapshot.scoreEvents, `${spec.kind}: premise, a result is recorded`).toBeGreaterThan(0);
      // The field changes too, so a Rebuild that ran would redraw: the refusal is what holds the board.
      await createEntrants(auth, divisionId, [{ kind: "individual", display_name: "Late", seed: 99, members: [] }]);

      await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({ status: 409, code: "STAGE_HAS_RESULTS" });

      expect(await stageSnapshot(stage!.id, divisionId), `${spec.kind}: the stage is byte-identical`).toEqual(snapshot);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("RB-1 a regenerate that throws rolls back the delete of a stage that records byes and pins: the old board, its config and its ledger stand", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 6);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "group", name: "G", config: { pools: { count: 2 } }, progression: null });
    await generateStageFixtures(auth, stage!.id); // two pools of three: each sits one player out a round
    await overrideStandings(auth, stage!.id, { rows: [{ entrant_id: entrants[0]!, rank: 1, reason: "placement game" }] });
    const { venueId, courts } = await twoCourts(auth);
    await layOut(await rowsOf(stage!.id), venueId, courts);
    const before = await stageSnapshot(stage!.id, divisionId);
    expect((before.config.round_byes as unknown[]).length, "premise: the byes are recorded").toBeGreaterThan(0);
    // Four leave: two entrants snake into two pools of one, which pairs nothing - the regenerate refuses AFTER its delete.
    for (const i of [2, 3, 4, 5]) await patchEntrant(auth, entrants[i]!, { status: "withdrawn" });
    const afterWithdrawals = await stageSnapshot(stage!.id, divisionId);

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({ code: "STAGE_NOT_READY", data: { reason: "group_too_few_entrants" } });

    // The departures dropped no pin of the two who stay (her pin, P1's, is not a leaver's); the rollback restored the lines.
    expect(await stageSnapshot(stage!.id, divisionId)).toEqual(afterWithdrawals);
    expect(afterWithdrawals.fixtures.map((f) => f.id), "the same fixture ids as before").toEqual(before.fixtures.map((f) => f.id));
  });
});

// The rows a late entry and a withdrawal wrote, and the pins (storage table, ruling 288 G7). The late-entry rig mirrors
// roundrobin-late-entry.test.ts: a started league, nothing played, so the newcomer is placed by catch-up and Rebuild is still open.
async function startedLeague(n: number) {
  const { auth } = await seedOrg("pro");
  const { divisionId, entrants } = await seedDivision(auth, GENERIC, n);
  const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: {}, progression: null });
  await startDivision(auth, divisionId); // Start draws the table
  const name = new Map(entrants.map((id, i) => [id, `E${i + 1}`]));
  return { auth, divisionId, entrants, stageId: stage!.id, name };
}
const byesStored = async (stageId: string) => ((await configOf(stageId)).round_byes ?? []) as { round_no: number; leg: number; entrant_id: string }[];

describe.skipIf(!HAS_DB)("RB-1 Rebuild rewrites round_byes and drops catch-up lines", () => {
  it("RB-1 Rebuild rewrites round_byes and drops catch-up lines: a five-field league whose late player took every bye (rr-by-)", async () => {
    const rig = await startedLeague(5);
    // Premise, from the engine's own declaration (generateRoundRobin over the seeded field): one bye a round, E5 r1 ... E1 r5.
    const ids = rig.entrants;
    const engine = generateRoundRobin({ entrants: ids, seeds: new Map(ids.map((id, i) => [id, i + 1])), config: { legs: 1 } });
    expect(SEEDED_BYES(await byesStored(rig.stageId), rig.name), "premise: the stored byes are the engine's").toEqual(
      engine.rounds.map((r) => `r${r.roundNo}:${rig.name.get(r.bye!)}`),
    );
    expect(await scoreEventCount(rig.stageId), "premise: nothing played").toBe(0);
    const [late] = await createEntrants(rig.auth, rig.divisionId, [{ kind: "individual", display_name: "Late", seed: 6, members: [] }]);
    rig.name.set(late!.id, "Late");
    const withCatchUp = await rowsOf(rig.stageId);
    expect(withCatchUp.filter((r) => /rr-by-/.test(r.ext_key ?? "")), "premise: the newcomer took each bye slot").toHaveLength(5);
    expect(await byesStored(rig.stageId), "premise: every bye was consumed").toEqual([]);
    const lateEntryRows = await eventCount(rig.divisionId, "roundrobin_late_entry");
    expect(lateEntryRows, "premise: the add wrote its ledger row").toBe(1);
    // E1 leaves before any match: the field Rebuild draws is E2..E5 and Late - five again, so the byes are a NEW set.
    await patchEntrant(rig.auth, rig.entrants[0]!, { status: "withdrawn" });
    expect(await scoreEventCount(rig.stageId), "premise: the bare withdrawal wrote no result").toBe(0);

    const out = await rebuildStageFixtures(rig.auth, rig.stageId);

    const after = await rowsOf(rig.stageId);
    expect(after.filter((r) => /rr-cu-|rr-by-/.test(r.ext_key ?? "")), "no catch-up line survives").toEqual([]);
    expect(after, "ten pairs of five").toHaveLength(10);
    expect(after.every((r) => RR_KEY.test(r.ext_key ?? "")), "the generator's keys only").toBe(true);
    const active = [...rig.entrants.slice(1), late!.id];
    const fresh = generateRoundRobin({ entrants: active, seeds: new Map(active.map((id, i) => [id, i + 2])), config: { legs: 1 } });
    const want = fresh.rounds.map((r) => `r${r.roundNo}:${rig.name.get(r.bye!)}`);
    expect(want, "premise: the rewritten set is five byes").toHaveLength(5);
    expect(SEEDED_BYES(await byesStored(rig.stageId), rig.name), "round_byes is rewritten from the new schedule, not kept").toEqual(want);
    // The ledger is append-only: the late entry's row stays, and the Rebuild adds its own.
    expect(await eventCount(rig.divisionId, "roundrobin_late_entry"), "the late-entry row survives").toBe(lateEntryRows);
    expect(out.removed).toBe(withCatchUp.length);
  });

  it("RB-1 a six-field league whose late player was appended as catch-up rounds (rr-cu-): Rebuild draws one table of six again, byes stay empty", async () => {
    const rig = await startedLeague(6);
    expect(await byesStored(rig.stageId), "premise: an even field sits nobody out").toEqual([]);
    const [late] = await createEntrants(rig.auth, rig.divisionId, [{ kind: "individual", display_name: "Late", seed: 7, members: [] }]);
    const withCatchUp = await rowsOf(rig.stageId);
    expect(withCatchUp.filter((r) => /rr-cu-/.test(r.ext_key ?? "")), "premise: six catch-up lines, Late v each").toHaveLength(6);
    expect(withCatchUp, "premise: 15 + 6").toHaveLength(21);
    // A seventh at Rebuild: nobody left, so the draw is seven.
    const out = await rebuildStageFixtures(rig.auth, rig.stageId);
    const after = await rowsOf(rig.stageId);
    expect(after.filter((r) => /rr-cu-|rr-by-/.test(r.ext_key ?? ""))).toEqual([]);
    expect(after, "twenty-one pairs of seven").toHaveLength(21);
    const seated = new Set(after.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]));
    expect(seated.has(late!.id)).toBe(true);
    expect(await byesStored(rig.stageId), "seven sit one out a round: seven byes, none stale").toHaveLength(7);
    expect(out.removed).toBe(21);
  });
});

describe.skipIf(!HAS_DB)("RB-1 Rebuild and the withdrawal's rows (B3): the expunged lines and the ledger are a played stage's, so Rebuild refuses", () => {
  it("RB-1 after a started league's player withdraws, Rebuild refuses STAGE_HAS_RESULTS and keeps her expunged lines, the leaver's byes and the ledger", async () => {
    const rig = await startedLeague(5);
    const leaver = rig.entrants[2]!;
    const before = await stageSnapshot(rig.stageId, rig.divisionId);
    expect(before.scoreEvents, "premise: nothing played yet").toBe(0);

    await withdrawEntrantCascade(rig.auth, leaver);

    const afterWithdrawal = await stageSnapshot(rig.stageId, rig.divisionId);
    expect(afterWithdrawal.scoreEvents, "premise: the withdrawal expunged her lines as events (abandon), which a Rebuild must not delete").toBeGreaterThan(0);
    expect(afterWithdrawal.ledger, "premise: the withdrawal appended its ledger rows").toBeGreaterThan(before.ledger);
    expect((await byesStored(rig.stageId)).some((b) => b.entrant_id === leaver), "premise: her bye entry is left, readers skip it").toBe(true);

    await expect(rebuildStageFixtures(rig.auth, rig.stageId)).rejects.toMatchObject({ status: 409, code: "STAGE_HAS_RESULTS" });

    expect(await stageSnapshot(rig.stageId, rig.divisionId), "refused before any delete: lines, config, ledger, events identical").toEqual(afterWithdrawal);
  });
});

describe.skipIf(!HAS_DB)("RB-1 Rebuild and the rank pins (RB5-P5, G7): a pool whose membership changed loses its pins, an unchanged pool keeps them", () => {
  const pinOf = (entrant_id: string, rank: number) => ({ entrant_id, rank, reason: "placement game" });

  it("RB-1 a group Rebuild after nine become ten clears pool B's pin and keeps pool A's, in the same transaction as the redraw", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 9);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "group", name: "G", config: { pools: { count: 2 } }, progression: null });
    await generateStageFixtures(auth, stage!.id);
    // Doc 05 section 1's snake of nine, typed by hand: 1->A 2->B | 3->B 4->A | 5->A 6->B | 7->B 8->A | 9->A.
    const poolIds = new Map((await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${stage!.id}`).map((p) => [p.key, p.id]));
    await overrideStandings(auth, stage!.id, { rows: [pinOf(entrants[3]!, 1), pinOf(entrants[2]!, 1)] }); // A: E4, B: E3
    await createEntrants(auth, divisionId, [{ kind: "individual", display_name: "E10", seed: 10, members: [] }]); // 10 -> B

    await rebuildStageFixtures(auth, stage!.id);

    const stored = ((await configOf(stage!.id)).rank_overrides ?? []) as { entrant_id: string; rank: number; pool_id?: string }[];
    expect(stored, "B's pin goes with B's redraw, A's stays").toEqual([{ entrant_id: entrants[3]!, rank: 1, pool_id: poolIds.get("A")! }]);
  });

  it("RB-1 a Rebuild that moves nobody keeps every pin (the positive pair: a pin is dropped by a changed pool, not by a Rebuild)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 8);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "group", name: "G", config: { pools: { count: 2 } }, progression: null });
    await generateStageFixtures(auth, stage!.id);
    const poolIds = new Map((await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${stage!.id}`).map((p) => [p.key, p.id]));
    await overrideStandings(auth, stage!.id, { rows: [pinOf(entrants[0]!, 1), pinOf(entrants[1]!, 1)] }); // A: E1, B: E2
    const before = ((await configOf(stage!.id)).rank_overrides ?? []) as unknown[];
    expect(before, "premise: two pins stored, one per pool").toEqual([
      { entrant_id: entrants[0]!, rank: 1, pool_id: poolIds.get("A")! },
      { entrant_id: entrants[1]!, rank: 1, pool_id: poolIds.get("B")! },
    ]);

    await rebuildStageFixtures(auth, stage!.id);

    expect((await configOf(stage!.id)).rank_overrides).toEqual(before);
  });

  // B4 fix wave (T18 m3): a second Rebuild in a row is a no-op on the stage's config (byes, pins), and a one-pool group's pin
  // follows the one-pool rule: kept while its one table's membership stands, dropped when it changes.
  it("RB-1 a second Rebuild with nothing changed leaves the config byte-identical and keeps the pins", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 7);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "group", name: "G", config: { pools: { count: 2 } }, progression: null });
    await generateStageFixtures(auth, stage!.id); // a pool of four and a pool of three (byes)
    await overrideStandings(auth, stage!.id, { rows: [pinOf(entrants[0]!, 1), pinOf(entrants[1]!, 1)] });
    await rebuildStageFixtures(auth, stage!.id);
    const once = await configOf(stage!.id);
    expect((once.rank_overrides as unknown[]).length, "premise: both pins survive the first Rebuild").toBe(2);
    expect((once.round_byes as unknown[]).length, "premise: the pool of three records byes").toBeGreaterThan(0);

    await rebuildStageFixtures(auth, stage!.id);

    expect(JSON.stringify(await configOf(stage!.id)), "the second Rebuild rewrites the config to the same bytes").toBe(JSON.stringify(once));
  });

  it("RB-1 a one-pool group's pin stays through a Rebuild that moves nobody and goes when its table's membership changes", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 4);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "group", name: "G", config: { pools: { count: 1 } }, progression: null });
    await generateStageFixtures(auth, stage!.id);
    await overrideStandings(auth, stage!.id, { rows: [pinOf(entrants[0]!, 1)] });
    const pinned = (await configOf(stage!.id)).rank_overrides as { pool_id?: string | null }[];
    expect(pinned, "premise: stored").toHaveLength(1);

    await rebuildStageFixtures(auth, stage!.id);
    expect((await configOf(stage!.id)).rank_overrides, "nobody moved: kept").toEqual(pinned);

    await createEntrants(auth, divisionId, [{ kind: "individual", display_name: "E5", seed: 5, members: [] }]);
    await rebuildStageFixtures(auth, stage!.id);
    expect((await configOf(stage!.id)).rank_overrides, "its one table changed: dropped").toEqual([]);
  });

  it("RB-1 a league's pin goes when its one table's membership changes (a league is one pool)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrants } = await seedDivision(auth, GENERIC, 4);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: {}, progression: null });
    await generateStageFixtures(auth, stage!.id);
    await overrideStandings(auth, stage!.id, { rows: [pinOf(entrants[0]!, 1)] });
    expect(((await configOf(stage!.id)).rank_overrides as unknown[]).length, "premise: stored").toBe(1);
    await createEntrants(auth, divisionId, [{ kind: "individual", display_name: "E5", seed: 5, members: [] }]);

    await rebuildStageFixtures(auth, stage!.id);

    expect((await configOf(stage!.id)).rank_overrides).toEqual([]);
  });
});
