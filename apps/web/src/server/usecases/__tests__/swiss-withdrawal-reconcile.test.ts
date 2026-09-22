// Task 1.0 (2026-09-20 swiss shell hardening) — a mid-tournament withdrawal
// used to brick Pair next for the rest of the event.
//
// The chain: after Start the only roster change left is a withdrawal
// (`enrollEntrants` refuses additions on an `active` division); a withdrawal is
// a STATUS FLIP, not a delete (`withdrawEntrantCascade`); and the pair path
// counts only `registered`/`confirmed` entrants. So the field the pairer sees
// shrinks the moment anyone withdraws, while the shells were minted for the OLD
// field size — and the seating loop then throws "swiss shell count mismatch for
// pairing" or "swiss bye shell missing for pairing".
//
// The fix RECONCILES the target round's shells against the current active
// field. It is deliberately NOT a delete-and-recreate: scheduling a shell ahead
// of Pair is a shipped feature, so a surviving board keeps its id, its
// `scheduled_at` and its `court_id`. The test named "keeps the slot" below is
// the one that separates the two implementations — without it a recreate passes
// every other assertion in this file.
//
// Scope depends on whether the division has STARTED (owner ruling 2026-09-22,
// closing Open question 1's deferred half):
//
//  - BEFORE Start (`divisions.status` in 'setup'/'scheduled') the reconcile is
//    EAGER — every unseated round is brought into line with the current field,
//    because organisers schedule courts and times for ALL rounds in advance and
//    a round minted for a stale field has no boards to hang the new players on.
//    Pinned by the "eager scope" describe below.
//  - AFTER Start ('active'/'completed') it stays LAZY — only the round being
//    paired. No reason to widen a destructive write mid-event. Pinned by
//    "after Start … leaves later rounds' shells alone (lazy scope)".
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { EngineError } from "@seazn/engine/core";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { addFixture, createStages, generateStageFixtures } from "../stages";
import { createVenue, createCourt } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface FixtureRow {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
  /** postgres.js parses `timestamptz` into a JS Date. */
  scheduled_at: Date | string | null;
  court_id: string | null;
  ext_key: string | null;
}

async function fixturesOf(stageId: string): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           status, outcome, scheduled_at, court_id, ext_key
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
}

const inRound = (rows: FixtureRow[], r: number) => rows.filter((f) => f.round_no === r);
const keysIn = (rows: FixtureRow[], r: number) => inRound(rows, r).map((f) => f.ext_key);

function isSeated(f: FixtureRow): boolean {
  const o = f.outcome as { kind?: string } | null;
  if (o?.kind === "award") return true;
  return f.home_entrant_id !== null && f.away_entrant_id !== null;
}

/** Every entrant id the round seats, board sides and bye recipient alike. */
function seatedIn(rows: FixtureRow[], r: number): string[] {
  const ids: string[] = [];
  for (const f of inRound(rows, r)) {
    if (f.home_entrant_id) ids.push(f.home_entrant_id);
    if (f.away_entrant_id) ids.push(f.away_entrant_id);
  }
  return ids;
}

async function seedSwissStage(
  auth: AuthCtx,
  rounds: number,
  entrantCount: number,
): Promise<{ divisionId: string; stageId: string }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss withdrawal " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds },
    progression: null,
  });
  return { divisionId: division.id, stageId: stage!.id };
}

/** Enrol `count` more entrants, seeded after the ones already there. */
async function addEntrants(auth: AuthCtx, divisionId: string, count: number): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from entrants where division_id = ${divisionId}`;
  await createEntrants(
    auth,
    divisionId,
    Array.from({ length: count }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${n + i + 1}`,
      seed: n + i + 1,
      members: [],
    })),
  );
}

/** Remove the highest-seeded entrant through the real `deleteEntrant` — the
 *  pre-Start departure path. (After Start it refuses and `withdrawEntrantCascade`
 *  is the tool; that half is covered by the lazy-scope describe.) */
async function deleteLastEntrant(auth: AuthCtx, divisionId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId}
    order by seed desc nulls last, created_at desc limit 1`;
  await deleteEntrant(auth, row!.id);
  return row!.id;
}

async function activeFieldSize(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from entrants
    where division_id = ${divisionId} and status in ('registered','confirmed')`;
  return n;
}

async function playRoundHomeWins(orgId: string, stageId: string, roundNo: number): Promise<void> {
  const rows = await sql<{ id: string; away_entrant_id: string | null }[]>`
    select id, away_entrant_id from fixtures
    where stage_id = ${stageId} and round_no = ${roundNo}`;
  for (const f of rows) {
    if (f.away_entrant_id === null) continue; // the bye is already settled
    await appendEvent(orgId, f.id, 0, { type: "core.start", payload: {}, recordedBy: null });
    await appendEvent(orgId, f.id, 1, {
      type: "badminton.game.summary",
      payload: { home: 21, away: 10 },
      recordedBy: null,
    });
    await appendEvent(orgId, f.id, 2, {
      type: "badminton.game.summary",
      payload: { home: 21, away: 12 },
      recordedBy: null,
    });
  }
}

/**
 * Start, mint, seat round 1, play it, then withdraw a round-1 BOARD player
 * through the real `withdrawEntrantCascade`. A board player has played exactly
 * one fixture and has none pending, so the engine's table policy is `award`
 * with nothing to award — round 1's result stands untouched, which is what the
 * "untouched" assertions below depend on.
 */
async function playR1ThenWithdraw(
  auth: AuthCtx,
  divisionId: string,
  stageId: string,
): Promise<{ withdrawn: string }> {
  await startDivision(auth, divisionId);
  await generateStageFixtures(auth, stageId); // seat round 1
  await playRoundHomeWins(auth.orgId, stageId, 1);

  const board = inRound(await fixturesOf(stageId), 1).find((f) => f.away_entrant_id !== null);
  const withdrawn = board!.home_entrant_id!;
  await withdrawEntrantCascade(auth, withdrawn);

  const [row] = await sql<{ status: string }[]>`
    select status from entrants where id = ${withdrawn}`;
  expect(row!.status).toBe("withdrawn");
  return { withdrawn };
}

describe.runIf(HAS_DB)("swiss — a mid-tournament withdrawal reconciles the next round's shells", () => {
  it("even→odd: a 6-player field losing one seats round 2 on two boards plus a bye", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);
    const { withdrawn } = await playR1ThenWithdraw(auth, divisionId, stageId);

    // Minted for six: three boards, no bye.
    expect(keysIn(await fixturesOf(stageId), 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3"]);

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(keysIn(rows, 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-bye"]);
    expect(inRound(rows, 2).every(isSeated)).toBe(true);

    // The bye is one-sided and names its own seat as winner — the shape
    // `isOneSidedAwardBye` recognises, not merely "an award landed here".
    const bye = inRound(rows, 2).find((f) => f.ext_key === "sw-r2-bye")!;
    expect(bye.away_entrant_id).toBeNull();
    expect(bye.home_entrant_id).toBeTruthy();
    expect(bye.outcome).toEqual({ kind: "award", winner: bye.home_entrant_id });

    // Exactly the five survivors, once each, and never the withdrawn player.
    const seated = seatedIn(rows, 2);
    expect(seated).toHaveLength(5);
    expect(new Set(seated).size).toBe(5);
    expect(seated).not.toContain(withdrawn);
  });

  it("odd→even: a 5-player field losing one seats round 2 on two boards with no bye", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 5);
    const { withdrawn } = await playR1ThenWithdraw(auth, divisionId, stageId);

    // Minted for five: two boards and a bye.
    expect(keysIn(await fixturesOf(stageId), 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-bye"]);

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(keysIn(rows, 2)).toEqual(["sw-r2-b1", "sw-r2-b2"]);
    expect(inRound(rows, 2).every(isSeated)).toBe(true);

    const seated = seatedIn(rows, 2);
    expect(seated).toHaveLength(4);
    expect(new Set(seated).size).toBe(4);
    expect(seated).not.toContain(withdrawn);
  });

  // THE DISTINGUISHING TEST. A delete-and-recreate satisfies every other
  // assertion in this file and fails this one: it changes fixture ids and
  // discards the organiser's advance layout.
  it("a shell scheduled ahead keeps its id, slot and court across the reconcile", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const pinnedAt = "2030-06-15T14:00:00.000Z";

    await startDivision(auth, divisionId);
    const before = await fixturesOf(stageId);
    const shell = inRound(before, 2).find((f) => f.ext_key === "sw-r2-b1")!;
    await sql`
      update fixtures set scheduled_at = ${pinnedAt}, court_id = ${court.id}
      where id = ${shell.id}`;

    await generateStageFixtures(auth, stageId); // seat round 1
    await playRoundHomeWins(auth.orgId, stageId, 1);
    const r1 = inRound(await fixturesOf(stageId), 1).find((f) => f.away_entrant_id !== null);
    await withdrawEntrantCascade(auth, r1!.home_entrant_id!);

    await generateStageFixtures(auth, stageId); // reconcile + seat round 2

    const rows = await fixturesOf(stageId);
    // The reconcile really did run — otherwise this test is vacuous.
    expect(keysIn(rows, 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-bye"]);

    const kept = inRound(rows, 2).find((f) => f.ext_key === "sw-r2-b1")!;
    expect(kept.id).toBe(shell.id);
    const at = kept.scheduled_at;
    expect(at instanceof Date ? at.toISOString() : at).toBe(pinnedAt);
    expect(kept.court_id).toBe(court.id);
    expect(isSeated(kept)).toBe(true);
  });

  it("leaves the played round 1 exactly as it was", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);
    await playR1ThenWithdraw(auth, divisionId, stageId);

    const snap = (rows: FixtureRow[]) =>
      inRound(rows, 1).map((f) => ({
        id: f.id,
        home: f.home_entrant_id,
        away: f.away_entrant_id,
        status: f.status,
        outcome: f.outcome,
      }));
    const before = snap(await fixturesOf(stageId));
    expect(before).toHaveLength(3);

    await generateStageFixtures(auth, stageId);

    expect(snap(await fixturesOf(stageId))).toEqual(before);
  });

  // Pins the LAZY scope decision for a STARTED division: round 3 is wrong-sized
  // for the new field and stays that way until its own Pair reconciles it.
  // `playR1ThenWithdraw` calls `startDivision`, so the division is `active`
  // here — which is the whole reason this stays lazy after the 2026-09-22 owner
  // ruling made the PRE-Start case eager (Open question 1's deferred half).
  // Forcing the pre-Start predicate `true` reds this test.
  it("after Start, leaves later rounds' shells alone (lazy scope)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);
    await playR1ThenWithdraw(auth, divisionId, stageId);

    const before = inRound(await fixturesOf(stageId), 3).map((f) => f.id);
    expect(before).toHaveLength(3);

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(keysIn(rows, 3)).toEqual(["sw-r3-b1", "sw-r3-b2", "sw-r3-b3"]);
    expect(inRound(rows, 3).map((f) => f.id)).toEqual(before);
    expect(inRound(rows, 3).every((f) => !isSeated(f))).toBe(true);
  });

  it("a round needing no reshape is not rewritten (no withdrawal, ids stable)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);
    await playRoundHomeWins(auth.orgId, stageId, 1);

    const before = inRound(await fixturesOf(stageId), 2).map((f) => f.id);
    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(inRound(rows, 2).map((f) => f.id)).toEqual(before);
    expect(inRound(rows, 2).every(isSeated)).toBe(true);
  });

  // The refusals below are scoped to a round the reconcile is about to
  // RESHAPE. A round whose shape already matches the field is not a
  // destructive path, so Pair must still seat it even where evidence exists —
  // otherwise this task would refuse a Pair that worked before it.
  it("does not refuse a round it would not change, even carrying a config_snapshot", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);
    await playRoundHomeWins(auth.orgId, stageId, 1);

    const shell = inRound(await fixturesOf(stageId), 2).find((f) => f.ext_key === "sw-r2-b1")!;
    await sql`
      update fixtures set config_snapshot = ${sql.json({ points: { w: 3 } })},
                          config_snapshot_at = now()
      where id = ${shell.id}`;

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(inRound(rows, 2).every(isSeated)).toBe(true);
    expect(inRound(rows, 2).find((f) => f.ext_key === "sw-r2-b1")!.id).toBe(shell.id);
  });

  // The growth direction. It is reachable only BEFORE Start (`enrollEntrants`
  // locks the roster once a division is active), and it is the arm that mints
  // the shortfall rather than deleting a surplus.
  it("a field that grows before Start mints only the shortfall and keeps the boards it has", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 2, 4);

    await generateStageFixtures(auth, stageId); // mint shells for four
    const before = await fixturesOf(stageId);
    expect(keysIn(before, 1)).toEqual(["sw-r1-b1", "sw-r1-b2"]);

    const pinnedAt = "2030-07-01T09:00:00.000Z";
    const keep = inRound(before, 1).map((f) => f.id);
    await sql`
      update fixtures set scheduled_at = ${pinnedAt}
      where id = ${inRound(before, 1)[0]!.id}`;

    await createEntrants(auth, divisionId, [
      { kind: "individual" as const, display_name: "E5", seed: 5, members: [] },
      { kind: "individual" as const, display_name: "E6", seed: 6, members: [] },
    ]);

    await generateStageFixtures(auth, stageId); // reconcile + seat round 1

    const rows = await fixturesOf(stageId);
    expect(keysIn(rows, 1)).toEqual(["sw-r1-b1", "sw-r1-b2", "sw-r1-b3"]);
    expect(inRound(rows, 1).slice(0, 2).map((f) => f.id)).toEqual(keep);
    const at = inRound(rows, 1).find((f) => f.ext_key === "sw-r1-b1")!.scheduled_at;
    expect(at instanceof Date ? at.toISOString() : at).toBe(pinnedAt);
    expect(inRound(rows, 1).every(isSeated)).toBe(true);
    expect(seatedIn(rows, 1)).toHaveLength(6);
    // EAGER before Start (owner ruling 2026-09-22, closing Open question 1's
    // deferred half): round 2 tracks the new field too, so the organiser can
    // schedule courts and times for it. This assertion read
    // `["sw-r2-b1", "sw-r2-b2"]` while the scope was lazy in both states.
    expect(keysIn(rows, 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3"]);
    expect(inRound(rows, 2).every((f) => !isSeated(f))).toBe(true);
  });
});

/**
 * EAGER scope before Start — owner ruling 2026-09-22, closing the half of Open
 * question 1 the design doc left open ("rounds BEYOND the one being paired are
 * also wrong-sized...").
 *
 * The production defect: a Swiss division pre-Start, three entrants added and
 * one deleted. Round 1 re-paired correctly through Unpair → Pair next, but
 * rounds 2 and 3 kept the shells minted for the OLD field — no boards for the
 * new players, so they could not be scheduled at all.
 *
 * Every assertion below is on a round the Generate did NOT pair. Round 1 is
 * seated by the same call; rounds 2 and 3 are the ones that were stale.
 */
describe.runIf(HAS_DB)("swiss — before Start, every unseated round tracks the current field", () => {
  it("even→odd: an entrant joining mints the -bye shell in rounds 2 and 3, not only round 1", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // mint shells for six
    const before = await fixturesOf(stageId);
    for (const r of [1, 2, 3]) {
      expect(keysIn(before, r)).toEqual([`sw-r${r}-b1`, `sw-r${r}-b2`, `sw-r${r}-b3`]);
    }

    await addEntrants(auth, divisionId, 1);
    expect(await activeFieldSize(divisionId)).toBe(7);

    await generateStageFixtures(auth, stageId); // reconcile every round + seat round 1

    const rows = await fixturesOf(stageId);
    // Seven is three boards plus a bye — in EVERY round, not just the paired one.
    for (const r of [1, 2, 3]) {
      expect(keysIn(rows, r)).toEqual([
        `sw-r${r}-b1`,
        `sw-r${r}-b2`,
        `sw-r${r}-b3`,
        `sw-r${r}-bye`,
      ]);
    }
    expect(seatedIn(rows, 1)).toHaveLength(7);
    // Reshaped, never seated: pairing is still one round at a time.
    expect(inRound(rows, 2).every((f) => !isSeated(f))).toBe(true);
    expect(inRound(rows, 3).every((f) => !isSeated(f))).toBe(true);
  });

  it("odd→even: an entrant deleted removes the -bye shell in rounds 2 and 3, not only round 1", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 7);

    await generateStageFixtures(auth, stageId); // mint shells for seven
    const before = await fixturesOf(stageId);
    for (const r of [1, 2, 3]) {
      expect(keysIn(before, r)).toEqual([
        `sw-r${r}-b1`,
        `sw-r${r}-b2`,
        `sw-r${r}-b3`,
        `sw-r${r}-bye`,
      ]);
    }

    const gone = await deleteLastEntrant(auth, divisionId);
    expect(await activeFieldSize(divisionId)).toBe(6);

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    for (const r of [1, 2, 3]) {
      expect(keysIn(rows, r)).toEqual([`sw-r${r}-b1`, `sw-r${r}-b2`, `sw-r${r}-b3`]);
    }
    expect(seatedIn(rows, 1)).toHaveLength(6);
    expect(seatedIn(rows, 1)).not.toContain(gone);
    expect(inRound(rows, 2).every((f) => !isSeated(f))).toBe(true);
    expect(inRound(rows, 3).every((f) => !isSeated(f))).toBe(true);
  });

  // The owner's production case, both directions inside ONE Generate.
  it("three join and one is deleted: rounds 2 and 3 gain the boards the new players need", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // mint shells for six
    await addEntrants(auth, divisionId, 3);
    await deleteLastEntrant(auth, divisionId);
    expect(await activeFieldSize(divisionId)).toBe(8);

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    for (const r of [1, 2, 3]) {
      expect(keysIn(rows, r)).toEqual([
        `sw-r${r}-b1`,
        `sw-r${r}-b2`,
        `sw-r${r}-b3`,
        `sw-r${r}-b4`,
      ]);
    }
    expect(seatedIn(rows, 1)).toHaveLength(8);
  });

  // THE DISTINGUISHING TEST for the eager loop. A delete-and-recreate satisfies
  // every count assertion above and fails this one — it changes fixture ids and
  // throws away the layout the organiser built for a round nobody has paired.
  it("a round 2 shell scheduled ahead keeps its id, slot and court across the eager reconcile", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const pinnedAt = "2030-08-02T11:30:00.000Z";

    await generateStageFixtures(auth, stageId); // mint shells for six
    const shell = inRound(await fixturesOf(stageId), 2).find((f) => f.ext_key === "sw-r2-b1")!;
    await sql`
      update fixtures set scheduled_at = ${pinnedAt}, court_id = ${court.id}
      where id = ${shell.id}`;

    await addEntrants(auth, divisionId, 1); // six → seven, so round 2 gains a bye

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    // The eager reconcile really did reach round 2 — otherwise this is vacuous.
    expect(keysIn(rows, 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3", "sw-r2-bye"]);

    const kept = inRound(rows, 2).find((f) => f.ext_key === "sw-r2-b1")!;
    expect(kept.id).toBe(shell.id);
    const at = kept.scheduled_at;
    expect(at instanceof Date ? at.toISOString() : at).toBe(pinnedAt);
    expect(kept.court_id).toBe(court.id);
    // Still a shell: round 2 has not been paired.
    expect(isSeated(kept)).toBe(false);
  });

  // The boundary, pinned. 'scheduled' means "timetable published, NOT yet
  // started" (`publishSchedule` moves setup → scheduled; `startDivision` moves
  // it to active), so it is on the EAGER side. A predicate written
  // `status !== 'setup'` passes every other test in this describe and fails
  // this one.
  it("a published (scheduled) division is still before Start, so the reconcile stays eager", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // mint shells for six
    await sql`update divisions set status = 'scheduled' where id = ${divisionId}`;
    await addEntrants(auth, divisionId, 2); // six → eight

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(keysIn(rows, 3)).toEqual(["sw-r3-b1", "sw-r3-b2", "sw-r3-b3", "sw-r3-b4"]);
  });

  // The widened scope must not reach a round it cannot legally reshape.
  // `addFixture` puts an ad-hoc swiss fixture at `maxRound + 1`, SEATED on both
  // sides (it requires two entrant ids), so a 3-round stage can hold a fully
  // seated round 4. Handing that round to the reconcile would trip its
  // "already partly seated" refusal and turn a Generate that works today into
  // STAGE_NOT_READY — so the later-round filter skips seated rounds. Drop the
  // `isSwissBoardSeated` filter in `swissGen` and this test reds.
  it("an ad-hoc fixture beyond the round budget neither blocks the eager reconcile nor is reshaped", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // mint shells for six

    const pair = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${divisionId}
        and status in ('registered','confirmed') order by seed limit 2`;
    const { fixture_id } = await addFixture(auth, stageId, {
      home_entrant_id: pair[0]!.id,
      away_entrant_id: pair[1]!.id,
    });
    expect(inRound(await fixturesOf(stageId), 4).map((f) => f.id)).toEqual([fixture_id]);

    await addEntrants(auth, divisionId, 1); // six → seven

    await generateStageFixtures(auth, stageId); // must NOT refuse

    const rows = await fixturesOf(stageId);
    for (const r of [1, 2, 3]) {
      expect(keysIn(rows, r)).toEqual([
        `sw-r${r}-b1`,
        `sw-r${r}-b2`,
        `sw-r${r}-b3`,
        `sw-r${r}-bye`,
      ]);
    }
    const adhoc = inRound(rows, 4);
    expect(adhoc.map((f) => f.id)).toEqual([fixture_id]);
    expect(adhoc[0]!.home_entrant_id).toBe(pair[0]!.id);
    expect(adhoc[0]!.away_entrant_id).toBe(pair[1]!.id);
  });

  // The early return still holds per round: a field that has not moved writes
  // nothing anywhere, so the ordinary Pair is untouched by the wider scope.
  it("a field that has not moved rewrites no round, paired or not", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId);
    const before = await fixturesOf(stageId);
    const idsOf = (rows: FixtureRow[]) => rows.map((f) => `${f.round_no}:${f.seq_in_round}:${f.id}`);

    await generateStageFixtures(auth, stageId); // seats round 1, reshapes nothing

    const rows = await fixturesOf(stageId);
    expect(idsOf(rows)).toEqual(idsOf(before));
    expect(inRound(rows, 1).every(isSeated)).toBe(true);
    expect(inRound(rows, 2).every((f) => !isSeated(f))).toBe(true);
  });
});

// Three refusal arms, mutated one at a time. Each row below is invisible to the
// other two guards, so no arm can cover for another.
describe.runIf(HAS_DB)("swiss — the reconcile refuses a round that is not provably empty", () => {
  it("refuses when a target-round shell already carries a frozen config_snapshot", async () => {
    // `config_snapshot` is monotonic where `status` is not, and is part of the
    // canonical evidence guard. No events, no award, no seats — the SQL
    // evidence arm is the only thing that can refuse this.
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);
    await playR1ThenWithdraw(auth, divisionId, stageId);

    const [shell] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} and ext_key = 'sw-r2-b3'`;
    await sql`
      update fixtures set config_snapshot = ${sql.json({ points: { w: 3 } })},
                          config_snapshot_at = now()
      where id = ${shell!.id}`;

    await expect(generateStageFixtures(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
    // Nothing was destroyed on the way to the refusal.
    expect(keysIn(await fixturesOf(stageId), 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3"]);
  });

  it("refuses when a target-round shell carries a played status with no events", async () => {
    // Set by direct SQL so the status arm is the ONLY thing that can refuse:
    // no score_events, no snapshot, no award, no seats.
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);
    await playR1ThenWithdraw(auth, divisionId, stageId);

    await sql`
      update fixtures set status = 'decided'
      where stage_id = ${stageId} and ext_key = 'sw-r2-b3'`;

    await expect(generateStageFixtures(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
    expect(keysIn(await fixturesOf(stageId), 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3"]);
  });

  it("refuses when a target-round shell is already seated", async () => {
    // Seats without evidence and without a played status, so only the
    // seated arm can refuse. Deleting this row would throw away a real pairing.
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);
    await playR1ThenWithdraw(auth, divisionId, stageId);

    const active = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${divisionId}
        and status in ('registered','confirmed') order by seed limit 2`;
    await sql`
      update fixtures set home_entrant_id = ${active[0]!.id}, away_entrant_id = ${active[1]!.id}
      where stage_id = ${stageId} and ext_key = 'sw-r2-b3'`;

    await expect(generateStageFixtures(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
    expect(keysIn(await fixturesOf(stageId), 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3"]);
  });
});
