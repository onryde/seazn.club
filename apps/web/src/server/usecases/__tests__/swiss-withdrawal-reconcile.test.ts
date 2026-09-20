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
// Scope is LAZY: only the round being paired is reconciled. Rounds beyond it
// stay minted at the old size until their own Pair reaches them — pinned by
// "leaves later rounds' shells alone" below, so a future change to all-rounds
// reconciliation has to move a test rather than slip through.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { EngineError } from "@seazn/engine/core";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
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

  // Pins the LAZY scope decision: round 3 is wrong-sized for the new field and
  // stays that way until its own Pair reconciles it.
  it("leaves later rounds' shells alone (lazy scope)", async () => {
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
    // Lazy again: round 2 is still minted for four.
    expect(keysIn(rows, 2)).toEqual(["sw-r2-b1", "sw-r2-b2"]);
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
