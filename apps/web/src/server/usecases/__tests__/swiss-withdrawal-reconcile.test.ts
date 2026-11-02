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
import { publishSchedule, startDivision } from "../schedule";
import { createStages, generateStageFixtures, unpairSwissRound, type SwissExistingFixture } from "../stages";
import { chooseDoomedBoards } from "@/lib/rebuild-slots";
import { swissBoardsForField } from "@/lib/swiss-shell";
import { createVenue, createCourt } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";
import { seedLegacySwissAdhoc } from "./_swiss-legacy-adhoc";

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
const iso = (at: Date | string | null) => (at instanceof Date ? at.toISOString() : at);

/**
 * The ext_keys round `roundNo` must hold for a field of `field` entrants,
 * DERIVED from the engine's own `swissBoardsForField` rather than typed out
 * (AGENTS.md 19) — the same authority `planSwissShells` mints from and
 * `reconcileSwissRoundShells` reshapes to, so a change to the shape rule moves
 * every expectation below with it instead of leaving them on yesterday's
 * numbers.
 *
 * Deriving from the production authority is a tautology risk on its own, so
 * the naming convention and the arithmetic are ALSO pinned literally, once,
 * by "the expected-key helper matches the shipped shell naming" below. That
 * is the case where the right answer differs from a wrong constant; here the
 * subject under test is which ROUNDS get reshaped and whether ids survive,
 * not the board count.
 */
function expectedRoundKeys(roundNo: number, field: number): string[] {
  const { boards, bye } = swissBoardsForField(field);
  const keys = Array.from({ length: boards }, (_, i) => `sw-r${roundNo}-b${i + 1}`);
  if (bye) keys.push(`sw-r${roundNo}-bye`);
  return keys;
}

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

// The ONE place the shell naming convention and the board arithmetic are
// written down literally. Every other expectation in this file derives from
// `swissBoardsForField`, which would otherwise make them agree with production
// by construction; this test is what stops that being a tautology. It needs no
// database, so it runs even when the suite above skips.
describe("swiss — the expected-key helper matches the shipped shell naming", () => {
  it("names boards `sw-r{n}-b{k}` from 1, and appends `-bye` only on an odd field", () => {
    expect(expectedRoundKeys(1, 6)).toEqual(["sw-r1-b1", "sw-r1-b2", "sw-r1-b3"]);
    expect(expectedRoundKeys(2, 7)).toEqual([
      "sw-r2-b1",
      "sw-r2-b2",
      "sw-r2-b3",
      "sw-r2-bye",
    ]);
    // A field of 8 takes a FOURTH board and no bye — the case where the right
    // answer differs from 7's constant in both dimensions at once.
    expect(expectedRoundKeys(3, 8)).toEqual([
      "sw-r3-b1",
      "sw-r3-b2",
      "sw-r3-b3",
      "sw-r3-b4",
    ]);
    // The bye sits LAST, after every board — the order `fixturesOf` returns and
    // every `toEqual` above depends on.
    expect(expectedRoundKeys(1, 9).at(-1)).toBe("sw-r1-bye");
    expect(expectedRoundKeys(1, 9)).toHaveLength(5);
  });
});

// W3 T2 (SW-L8, X-RB-1): which boards a shrinking pre-Start round loses. The
// rule: a board that holds no slot (`holdsSlot` — no time, court, venue or pin;
// the one predicate, W3 fix round 1) goes first, then one that is not
// `schedule_locked`, then the highest seq. Each key is pinned by a
// case where it — and only it — changes the answer (an ordering differential),
// so dropping any one of them reds exactly its own case.
type Board = SwissExistingFixture;
function board(seq: number, over: Partial<Board> = {}): Board {
  return {
    id: `id-b${seq}`,
    ext_key: `sw-r2-b${seq}`,
    round_no: 2,
    seq_in_round: seq,
    status: "scheduled",
    home_entrant_id: null,
    away_entrant_id: null,
    outcome: null,
    scheduled_at: null,
    court_id: null,
    venue_id: null,
    schedule_locked: false,
    ...over,
  };
}
const AT = new Date("2030-06-15T09:00:00.000Z");
const doomedKeys = (rows: Board[], keep: number) => chooseDoomedBoards(rows, keep).doomed.map((r) => r.ext_key);

describe("X-RB-1 chooseDoomedBoards — which boards a shrinking pre-Start round loses", () => {
  it("keeping every board dooms none and re-packs nothing; an empty round is empty", () => {
    expect(chooseDoomedBoards([], 0)).toEqual({ survivors: [], doomed: [] });
    const rows = [board(1), board(2), board(3)];
    const out = chooseDoomedBoards(rows, 3);
    expect(out.doomed).toEqual([]);
    expect(out.survivors).toEqual(rows);
  });

  it("key 1: an unscheduled board goes before a higher-seq board that holds a time or a court", () => {
    const rows = [board(1, { scheduled_at: AT }), board(2, { court_id: "c" }), board(3), board(4, { scheduled_at: AT, court_id: "c" })];
    expect(doomedKeys(rows, 3)).toEqual(["sw-r2-b3"]);
    // A court, a time, a venue, or a pin alone each count as holding a slot.
    let checked = 0;
    for (const over of [{ court_id: "c" }, { scheduled_at: AT }, { venue_id: "v" }, { schedule_locked: true }]) {
      expect(doomedKeys([board(1), board(2, over)], 1), JSON.stringify(over)).toEqual(["sw-r2-b1"]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("key 2: among boards that all hold a slot, an unlocked one goes before a higher-seq locked one", () => {
    const rows = [1, 2, 3, 4].map((q) => board(q, { scheduled_at: AT, schedule_locked: q !== 2 }));
    expect(doomedKeys(rows, 3)).toEqual(["sw-r2-b2"]);
  });

  it("key 3: all alike, the highest seq goes — the old rule, now the fallback", () => {
    const pinned = [1, 2, 3, 4].map((q) => board(q, { scheduled_at: AT, court_id: "c" }));
    expect(doomedKeys(pinned, 3)).toEqual(["sw-r2-b4"]);
    const bare = [1, 2, 3, 4].map((q) => board(q));
    expect(doomedKeys(bare, 2)).toEqual(["sw-r2-b3", "sw-r2-b4"]);
  });

  it("survivors keep their ext_key and prior order, re-packed to seq 1..keep", () => {
    const rows = [board(1, { scheduled_at: AT }), board(2, { scheduled_at: AT }), board(3), board(4, { court_id: "c" })];
    const out = chooseDoomedBoards(rows, 3);
    expect(out.survivors.map((r) => `${r.seq_in_round}:${r.ext_key}:${r.id}`)).toEqual([
      "1:sw-r2-b1:id-b1", "2:sw-r2-b2:id-b2", "3:sw-r2-b4:id-b4",
    ]);
    expect(out.doomed.map((r) => r.id)).toEqual(["id-b3"]);
    // Input order does not matter: the prior order is seq order.
    expect(chooseDoomedBoards([...rows].reverse(), 3).survivors.map((r) => r.ext_key)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b4"]);
  });

  it("refuses a bye shell or a keep it cannot honour, by name", () => {
    expect(() => chooseDoomedBoards([board(1), { ...board(2), ext_key: "sw-r2-bye" }], 1)).toThrow(/bye/);
    expect(() => chooseDoomedBoards([board(1)], -1)).toThrow(/keep/);
    expect(() => chooseDoomedBoards([board(1)], 1.5)).toThrow(/keep/);
  });
});

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
    expect(bye.outcome).toEqual({ kind: "award", winner: bye.home_entrant_id, loser: null, reason: "bye" }); // W2b C-5

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
      expect(keysIn(before, r)).toEqual(expectedRoundKeys(r, 6));
    }

    await addEntrants(auth, divisionId, 1);
    expect(await activeFieldSize(divisionId)).toBe(7);

    await generateStageFixtures(auth, stageId); // reconcile every round + seat round 1

    const rows = await fixturesOf(stageId);
    // Seven takes a bye where six did not — in EVERY round, not just the paired
    // one. The shape comes from the engine, so only the FIELD is stated here.
    for (const r of [1, 2, 3]) {
      expect(keysIn(rows, r)).toEqual(expectedRoundKeys(r, 7));
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
      expect(keysIn(before, r)).toEqual(expectedRoundKeys(r, 7));
    }

    const gone = await deleteLastEntrant(auth, divisionId);
    expect(await activeFieldSize(divisionId)).toBe(6);

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    for (const r of [1, 2, 3]) {
      expect(keysIn(rows, r)).toEqual(expectedRoundKeys(r, 6));
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
      expect(keysIn(rows, r)).toEqual(expectedRoundKeys(r, 8));
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
  // started", so it is on the EAGER side. A predicate written
  // `status !== 'setup'` passes every other test in this describe and fails
  // this one.
  //
  // Driven through the REAL producer, `publishSchedule` — a fixture on both
  // ends proves the fixture. Publishing is also what makes this case bite: the
  // timetable the eager pass then reshapes is one an organiser has already
  // published.
  it("a published (scheduled) division is still before Start, so the reconcile stays eager", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // mint shells for six
    const published = await publishSchedule(auth, divisionId, { acknowledge_warnings: true });
    expect(published.status).toBe("scheduled");
    const [division] = await sql<{ status: string }[]>`
      select status from divisions where id = ${divisionId}`;
    expect(division!.status).toBe("scheduled");

    await addEntrants(auth, divisionId, 2); // six → eight

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(keysIn(rows, 3)).toEqual(expectedRoundKeys(3, 8));
  });

  // The other side of the same predicate: `completed` is a STARTED status, so
  // the scope must fall back to lazy there exactly as it does for `active`.
  // Delete `"completed"` from `DIVISION_STARTED_STATUSES` and this test reds.
  //
  // The status is set by SQL rather than driven, and that is a real limitation
  // stated rather than hidden: the producer is `completeStage`, which flips a
  // division to `completed` only once EVERY stage is complete — and a complete
  // swiss stage has every round seated, at which point `nextUnseatedSwissRound`
  // returns null and `swissGen` returns before this predicate is ever read. So
  // the `completed` arm is defensive: reachable in the type, not reachable
  // through the product today. The test keeps it honest rather than asserting
  // it is load-bearing.
  it("a completed division is on the STARTED side, so the reconcile falls back to lazy", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // mint shells for six
    await addEntrants(auth, divisionId, 1); // six → seven
    await sql`update divisions set status = 'completed' where id = ${divisionId}`;

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    // Round 1 is the one being paired, so it reshapes either way.
    expect(keysIn(rows, 1)).toEqual(expectedRoundKeys(1, 7));
    // Lazy: rounds 2 and 3 keep the six-player shape.
    expect(keysIn(rows, 2)).toEqual(expectedRoundKeys(2, 6));
    expect(keysIn(rows, 3)).toEqual(expectedRoundKeys(3, 6));
  });

  // The widened scope must not reach a round it cannot legally reshape.
  // `addFixture` used to put an ad-hoc swiss fixture at `maxRound + 1`, SEATED
  // on both sides (it requires two entrant ids), so a 3-round stage can hold a
  // fully seated round 4. W3 RB3-15 A refuses that now, but the LEGACY rows
  // stay live, so the row is seeded as `addFixture` wrote it
  // (`seedLegacySwissAdhoc`). It trips the reconcile's "already partly seated" guard —
  // which, on a NON-target round, skips instead of throwing. Hand the later
  // rounds `"refuse"` in `swissGen` and this test reds with STAGE_NOT_READY,
  // which is a Generate that works today turned into a hard refusal.
  it("an ad-hoc fixture beyond the round budget neither blocks the eager reconcile nor is reshaped", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // mint shells for six

    const pair = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${divisionId}
        and status in ('registered','confirmed') order by seed limit 2`;
    const { fixture_id } = await seedLegacySwissAdhoc(stageId, pair[0]!.id, pair[1]!.id);
    expect(inRound(await fixturesOf(stageId), 4).map((f) => f.id)).toEqual([fixture_id]);

    await addEntrants(auth, divisionId, 1); // six → seven

    await generateStageFixtures(auth, stageId); // must NOT refuse

    const rows = await fixturesOf(stageId);
    for (const r of [1, 2, 3]) {
      expect(keysIn(rows, r)).toEqual(expectedRoundKeys(r, 7));
    }
    const adhoc = inRound(rows, 4);
    expect(adhoc.map((f) => f.id)).toEqual([fixture_id]);
    expect(adhoc[0]!.home_entrant_id).toBe(pair[0]!.id);
    expect(adhoc[0]!.away_entrant_id).toBe(pair[1]!.id);
  });

  // I1. The eager loop must not widen the REFUSAL surface. All three of the
  // reconcile's guards — seated, `swissRoundHasPlayedResult`, and the canonical
  // `fixtureEvidenceSql` — fire on a later round too, and a throw there would
  // abort the whole Generate and take the target round's pairing with it. That
  // is the very thing "does not refuse a round it would not change" forbids for
  // the paired round. So a NON-TARGET round that cannot be reshaped is SKIPPED
  // and left stale; only the target round refuses out loud.
  it("a later round carrying evidence is skipped, and the round being paired still seats", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // mint shells for six
    // `config_snapshot` is the monotonic arm of the canonical evidence guard,
    // and it is the ONLY thing that can block this row: no seats, no events,
    // no played status.
    const blocked = inRound(await fixturesOf(stageId), 3).find((f) => f.ext_key === "sw-r3-b1")!;
    await sql`
      update fixtures set config_snapshot = ${sql.json({ points: { w: 3 } })},
                          config_snapshot_at = now()
      where id = ${blocked.id}`;
    const roundThreeBefore = inRound(await fixturesOf(stageId), 3).map((f) => f.id);

    await addEntrants(auth, divisionId, 1); // six → seven

    // Must NOT throw: round 3's evidence is not round 1's business.
    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(seatedIn(rows, 1)).toHaveLength(7);
    expect(keysIn(rows, 1)).toEqual(["sw-r1-b1", "sw-r1-b2", "sw-r1-b3", "sw-r1-bye"]);
    // Round 2 has nothing against it, so the eager reconcile still resized it.
    expect(keysIn(rows, 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3", "sw-r2-bye"]);
    // Round 3 was skipped whole: stale, untouched, and above all not deleted.
    expect(keysIn(rows, 3)).toEqual(["sw-r3-b1", "sw-r3-b2", "sw-r3-b3"]);
    expect(inRound(rows, 3).map((f) => f.id)).toEqual(roundThreeBefore);
  });

  // I2. The other half of an eager shrink, recorded rather than discovered in
  // production: a board the field no longer needs is DELETED, and its pinned
  // time and court go with it — now in every unseated round at once, where the
  // lazy scope dropped one round at a time. `scheduled` status means the
  // timetable has been PUBLISHED, so this is visible to an organiser.
  //
  // This is not a defect to fix here: a board that no longer exists cannot
  // carry a slot. It is asserted so the cost is a pinned fact.
  // W3 T2 (SW-L8, X-RB-1): this case used to pin the defect — the shrink took
  // the highest-seq board whatever it held, so the one board an organiser had
  // laid out in advance went, time and court with it. A shrink now dooms an
  // UNSCHEDULED board first; the pinned b4 survives, re-packed to seq 3 under
  // its own ext_key, and the bare b3 goes instead.
  it("an eager shrink keeps the pinned surplus-seq board and deletes an unscheduled one instead (SW-L8)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 9);

    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 4", sort: 0, tags: [] });
    const pinnedAt = "2030-09-09T16:45:00.000Z";

    await generateStageFixtures(auth, stageId); // nine ⇒ four boards + a bye
    const before = await fixturesOf(stageId);
    expect(keysIn(before, 3)).toEqual(expectedRoundKeys(3, 9));

    // The highest-seq board, laid out in advance: the one the old rule took.
    const pinned = inRound(before, 3).find((f) => f.ext_key === "sw-r3-b4")!;
    const bare = inRound(before, 3).find((f) => f.ext_key === "sw-r3-b3")!;
    const survivor = inRound(before, 3).find((f) => f.ext_key === "sw-r3-b1")!;
    await sql`
      update fixtures set scheduled_at = ${pinnedAt}, court_id = ${court.id}
      where id = ${pinned.id}`;

    for (let i = 0; i < 3; i++) await deleteLastEntrant(auth, divisionId);
    expect(await activeFieldSize(divisionId)).toBe(6);

    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    // Three boards, no bye; b4 now sits at seq 3 under its own key.
    expect(inRound(rows, 3).map((f) => `${f.seq_in_round}:${f.ext_key}`)).toEqual([
      "1:sw-r3-b1", "2:sw-r3-b2", "3:sw-r3-b4",
    ]);
    const kept = inRound(rows, 3).find((f) => f.ext_key === "sw-r3-b4")!;
    expect(kept.id).toBe(pinned.id);
    expect(iso(kept.scheduled_at)).toBe(pinnedAt);
    expect(kept.court_id).toBe(court.id);
    // The bare board is the one GONE — not emptied, not re-keyed.
    const [gone] = await sql<{ id: string }[]>`select id from fixtures where id = ${bare.id}`;
    expect(gone).toBeUndefined();
    expect(inRound(rows, 3).find((f) => f.ext_key === "sw-r3-b1")!.id).toBe(survivor.id);
  });

  // Generate used to report only how many fixtures it SEATED, so an eager
  // shrink could delete three boards — and the times and courts pinned on them
  // — while the organiser was told nothing at all. The owner's whole reported
  // problem was staleness they could not see; silently fixing it in a way they
  // still cannot see is the same defect wearing a different hat.
  it("reports what an eager shrink removed across every round, not just the paired one", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 9);

    await generateStageFixtures(auth, stageId); // nine ⇒ four boards + a bye, ×3
    for (let i = 0; i < 3; i++) await deleteLastEntrant(auth, divisionId);
    expect(await activeFieldSize(divisionId)).toBe(6);

    const out = await generateStageFixtures(auth, stageId);

    // Six needs three boards and no bye, so each of the three rounds loses its
    // fourth board AND its bye. Counted across the whole press.
    expect(out.reshaped).toEqual({
      matches_added: 0,
      matches_removed: 3,
      byes_added: 0,
      byes_removed: 3,
    });
  });

  it("reports what an eager growth added, matches and byes counted apart", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // six ⇒ three boards, no bye, ×3
    await addEntrants(auth, divisionId, 1); // six → seven

    const out = await generateStageFixtures(auth, stageId);

    // Seven is still three boards, so nothing is added but the bye — in all
    // three rounds. A single "4 matches added" would be a number the organiser
    // could not match against the run sheet.
    expect(out.reshaped).toEqual({
      matches_added: 0,
      matches_removed: 0,
      byes_added: 3,
      byes_removed: 0,
    });
  });

  it("counts a board added when the field crosses into another board", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId);
    await addEntrants(auth, divisionId, 2); // six → eight ⇒ a fourth board, no bye

    const out = await generateStageFixtures(auth, stageId);

    expect(out.reshaped).toEqual({
      matches_added: 3,
      matches_removed: 0,
      byes_added: 0,
      byes_removed: 0,
    });
  });

  // The no-op must stay SILENT. `reshaped` absent, not four zeroes — the
  // organiser presses Pair next far more often than they change the field.
  it("says nothing about reshaping when the field has not moved", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);

    const mint = await generateStageFixtures(auth, stageId);
    expect(mint.reshaped).toBeUndefined();

    const pair = await generateStageFixtures(auth, stageId); // seats round 1
    // The press really did do something — otherwise "silent" is vacuous.
    expect(pair.created).toBeGreaterThan(0);
    expect(pair.reshaped).toBeUndefined();
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

// W3 T2 (SW-L8, X-RB-1): the pre-Start reshape inherits G3 — a shrinking round
// keeps the boards that hold a slot. Every slot below is one this file writes
// itself before the reshape, never one read back from the code under test.
describe.runIf(HAS_DB)("X-RB-1 swiss — a pre-Start reshape keeps the boards that hold a slot", () => {
  async function twoCourts(auth: AuthCtx) {
    const venue = await createVenue(auth, { name: "Main " + randomUUID().slice(0, 4), sort: 0 });
    const c1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const c2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
    return [c1.id, c2.id] as const;
  }
  /** Lay out `keys` in round `r`: its own hour each, alternating courts. Returns ext_key → slot. */
  async function layOut(stageId: string, r: number, keys: string[], courts: readonly string[]) {
    const laid = new Map<string, { id: string; at: string; court: string }>();
    const rows = inRound(await fixturesOf(stageId), r);
    for (const [i, key] of keys.entries()) {
      const row = rows.find((f) => f.ext_key === key);
      expect(row, key).toBeDefined();
      const at = new Date(Date.UTC(2030, 5, 15, 9 + i, 0, 0)).toISOString();
      const court = courts[i % courts.length]!;
      await sql`update fixtures set scheduled_at = ${at}, court_id = ${court} where id = ${row!.id}`;
      laid.set(key, { id: row!.id, at, court });
    }
    return laid;
  }
  function expectKept(rows: FixtureRow[], r: number, laid: Map<string, { id: string; at: string; court: string }>) {
    let checked = 0;
    for (const [key, slot] of laid) {
      const row = inRound(rows, r).find((f) => f.ext_key === key);
      expect(row, `${key} survives`).toBeDefined();
      expect({ id: row!.id, at: iso(row!.scheduled_at), court: row!.court_id }, key).toEqual(slot);
      checked++;
    }
    expect(checked, "anti-vacuity: every laid-out board was read back").toBe(laid.size);
    expect(checked).toBeGreaterThan(0);
  }

  it("X-RB-1 a shrinking pre-Start round deletes the unscheduled board, not the pinned seq-4 board", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 8);
    const courts = await twoCourts(auth);
    await generateStageFixtures(auth, stageId); // eight ⇒ four boards, no bye
    expect(keysIn(await fixturesOf(stageId), 2)).toEqual(expectedRoundKeys(2, 8));
    const laid = await layOut(stageId, 2, ["sw-r2-b1", "sw-r2-b2", "sw-r2-b4"], courts);
    const bare = inRound(await fixturesOf(stageId), 2).find((f) => f.ext_key === "sw-r2-b3")!;

    await deleteLastEntrant(auth, divisionId); // pre-Start departure: eight → seven
    expect(await activeFieldSize(divisionId)).toBe(7);
    await generateStageFixtures(auth, stageId); // the eager reshape, and round 1's pairing

    const rows = await fixturesOf(stageId);
    // Seven ⇒ three boards and a bye: b3 went, b4 sits at seq 3, the bye at 4.
    expect(inRound(rows, 2).map((f) => `${f.seq_in_round}:${f.ext_key}`)).toEqual([
      "1:sw-r2-b1", "2:sw-r2-b2", "3:sw-r2-b4", "4:sw-r2-bye",
    ]);
    expectKept(rows, 2, laid);
    const [gone] = await sql<{ id: string }[]>`select id from fixtures where id = ${bare.id}`;
    expect(gone, "the unscheduled board is the one deleted").toBeUndefined();
  });

  // The brief's word is "withdraw": the status-flip departure
  // (`withdrawEntrantCascade`, what POST /entrants/{id}/withdraw runs), not the
  // delete the cases around it use. The field shrinks the same way, and the
  // next press reshapes with the same choice.
  it("X-RB-1 a pre-Start WITHDRAWAL (status flip) reshapes round 2 and keeps the laid-out b4", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 8);
    const courts = await twoCourts(auth);
    await generateStageFixtures(auth, stageId); // eight ⇒ four boards, no bye
    const laid = await layOut(stageId, 2, ["sw-r2-b1", "sw-r2-b2", "sw-r2-b4"], courts);
    const bare = inRound(await fixturesOf(stageId), 2).find((f) => f.ext_key === "sw-r2-b3")!;

    const [leaving] = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${divisionId} order by seed desc limit 1`;
    await withdrawEntrantCascade(auth, leaving!.id);
    const [row] = await sql<{ status: string }[]>`select status from entrants where id = ${leaving!.id}`;
    expect(row?.status, "a status flip, not a delete").toBe("withdrawn");
    expect(await activeFieldSize(divisionId)).toBe(7);
    await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(inRound(rows, 2).map((f) => `${f.seq_in_round}:${f.ext_key}`)).toEqual([
      "1:sw-r2-b1", "2:sw-r2-b2", "3:sw-r2-b4", "4:sw-r2-bye",
    ]);
    expectKept(rows, 2, laid);
    const [gone] = await sql<{ id: string }[]>`select id from fixtures where id = ${bare.id}`;
    expect(gone, "the unscheduled board is the one deleted").toBeUndefined();
  });

  it("ext_keys stay unique and seqs contiguous after a shrink then a grow", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 8);
    const courts = await twoCourts(auth);
    await generateStageFixtures(auth, stageId); // eight ⇒ four boards ×3
    const laid = await layOut(stageId, 2, ["sw-r2-b1", "sw-r2-b2", "sw-r2-b4"], courts);

    await deleteLastEntrant(auth, divisionId); // shrink: eight → seven
    await generateStageFixtures(auth, stageId); // reshape every round; pairs round 1
    await unpairSwissRound(auth, stageId); // round 1 back onto its shells, so it can grow too
    await addEntrants(auth, divisionId, 2); // grow: seven → nine
    expect(await activeFieldSize(divisionId)).toBe(9);
    await generateStageFixtures(auth, stageId); // reshape every round again; Pair round 1

    const rows = await fixturesOf(stageId);
    const { boards, bye } = swissBoardsForField(9);
    let checked = 0;
    for (const r of [1, 2, 3]) {
      const round = inRound(rows, r);
      const keys = round.map((f) => f.ext_key!);
      expect(new Set(keys).size, `round ${r}: ext_keys unique — ${keys.join(",")}`).toBe(keys.length);
      expect(round.map((f) => f.seq_in_round), `round ${r}: seqs contiguous`).toEqual(
        Array.from({ length: round.length }, (_, i) => i + 1),
      );
      expect(round.length, `round ${r}: ${boards} boards${bye ? " + a bye" : ""}`).toBe(boards + (bye ? 1 : 0));
      expect(round.at(-1)!.ext_key, `round ${r}: the bye sits last`).toBe(`sw-r${r}-bye`);
      checked++;
    }
    expect(checked).toBe(3);
    // Round 2's pinned boards came through both reshapes; the board minted for
    // the grow takes the next index past the highest it has, never a reused b3.
    expectKept(rows, 2, laid);
    expect(keysIn(rows, 2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b4", "sw-r2-b5", "sw-r2-bye"]);
    expect(inRound(rows, 1).filter((f) => !f.ext_key!.endsWith("-bye")).every(isSeated), "round 1 was paired").toBe(true);
  });

  it("all boards pinned → the highest-seq board goes and the delta counts it", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 8);
    const courts = await twoCourts(auth);
    await generateStageFixtures(auth, stageId);
    const all = ["sw-r2-b1", "sw-r2-b2", "sw-r2-b3", "sw-r2-b4"];
    const laid = await layOut(stageId, 2, all, courts);
    const highest = laid.get("sw-r2-b4")!;
    laid.delete("sw-r2-b4");

    await deleteLastEntrant(auth, divisionId); // eight → seven
    const out = await generateStageFixtures(auth, stageId);

    const rows = await fixturesOf(stageId);
    expect(keysIn(rows, 2)).toEqual(expectedRoundKeys(2, 7));
    expectKept(rows, 2, laid);
    const [gone] = await sql<{ id: string }[]>`select id from fixtures where id = ${highest.id}`;
    expect(gone, "with nothing to choose between, the highest seq goes").toBeUndefined();
    // Each of the three rounds lost one board and gained a bye.
    expect(out.reshaped).toEqual({ matches_added: 0, matches_removed: 3, byes_added: 3, byes_removed: 0 });
  });
});

// Three refusal arms, mutated one at a time. Each row below is invisible to the
// other two guards, so no arm can cover for another.
//
// These are all TARGET-round rows, and deliberately so: the target keeps its
// loud refusal while a later round is skipped instead (I1, above). The pair of
// tests that hold that line apart are "a later round carrying evidence is
// skipped …" and "before Start, the round being paired still refuses …".
describe.runIf(HAS_DB)("swiss — the reconcile refuses a round that is not provably empty", () => {
  // The eager path's own half of the asymmetry. The three tests below run
  // post-Start (`playR1ThenWithdraw` starts the division), so without this one
  // nothing witnesses that "skip" was applied to the later rounds only.
  it("before Start, the round being paired still refuses on evidence, and nothing is written", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 6);

    await generateStageFixtures(auth, stageId); // mint shells for six
    const [shell] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} and ext_key = 'sw-r1-b1'`;
    await sql`
      update fixtures set config_snapshot = ${sql.json({ points: { w: 3 } })},
                          config_snapshot_at = now()
      where id = ${shell!.id}`;

    await addEntrants(auth, divisionId, 1); // six → seven, so round 1 must reshape

    await expect(generateStageFixtures(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );

    // The whole transaction rolled back, so the later rounds the eager loop had
    // already reshaped are back at the old field's shape too.
    const rows = await fixturesOf(stageId);
    for (const r of [1, 2, 3]) {
      expect(keysIn(rows, r)).toEqual([`sw-r${r}-b1`, `sw-r${r}-b2`, `sw-r${r}-b3`]);
    }
  });

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
