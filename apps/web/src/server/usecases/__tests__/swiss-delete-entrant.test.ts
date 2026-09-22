// 2026-09-22 — deleting an entrant BEFORE Start stranded the organiser
// completely, reported live from production.
//
// THE CHAIN. `deleteEntrant` guards only on `division.status !== 'setup'` and
// then runs a bare `delete from entrants`. It never touches `fixtures`; the FK
// does it instead (`home_entrant_id ... on delete set null`, V214__fixtures.sql
// :12). On a swiss stage the deleted player's already-paired board therefore
// SURVIVES with one null slot while its neighbours stay fully seated, and that
// round is then unreachable from every button on the page:
//
//  - Generate / "Pair next round" targets it (`nextUnseatedSwissRound`) and
//    `reconcileSwissRoundShells` refuses a partly seated round outright
//    (`swiss round is already partly seated — reconcile refused`).
//  - Unpair does not even render: `canUnpairSwiss` → `latestSeatedSwissRound`
//    required the round be WHOLLY seated, so one null slot hid the only
//    control that could have cleared it.
//
// There is a SECOND shape the original report did not name, and on an odd
// field it is the likelier one. The bye row is written `home = winner,
// away = null, status = 'forfeited', outcome = {award, winner}` (stages.ts
// :1179). Delete the BYE RECIPIENT and the FK leaves an award outcome with NO
// seat on either side — an orphan. `isSwissBoardSeated` calls it seated (it is
// an award), so the round reads as complete and Generate walks past it to
// round 2 and throws "current swiss round has undecided fixtures"; while
// `swissRoundHasPlayedResult` calls the orphan a PLAYED RESULT (it is an award
// that is not a one-sided bye), so Unpair refuses it too. Different route, same
// dead end. Both shapes are swept below.
//
// TWO HALVES, because each is useless alone:
//
//  1. ROOT CAUSE — `deleteEntrant` now unseats every swiss round the departing
//     entrant sat in, back onto its shells, BEFORE the delete. The round is
//     left wholly unseated, which is the state `reconcileSwissRoundShells`
//     already knows how to resize, so the next Generate reshapes and re-pairs
//     it with no new mechanism. Reuses `unpairSwissRound`'s own clear-onto-
//     shells write, so a surviving shell keeps its id, its `scheduled_at` and
//     its `court_id` — the standing requirement of this programme.
//  2. RECOVERY — Unpair can now clear a PARTLY seated round, client predicate
//     and server both, so the divisions already broken in production have a
//     way out. The destructive guards are untouched: a round carrying real
//     evidence still refuses.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { EngineError } from "@seazn/engine/core";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import { createStages, generateStageFixtures, unpairSwissRound } from "../stages";
import { createVenue, createCourt } from "../venues";
import { swissBoardsForField } from "@/lib/swiss-shell";
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

/** Derived from the engine's own shape authority (AGENTS.md 19) — the same one
 *  `planSwissShells` mints from and `reconcileSwissRoundShells` reshapes to.
 *  The literal naming/arithmetic is pinned once by
 *  `swiss-withdrawal-reconcile.test.ts`'s "expected-key helper" test, so this
 *  copy is not the only thing standing between the suite and a tautology. */
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

/**
 * The assertion the whole of half 1 turns on: not "the deleted player is gone"
 * — the FK already does that — but "no row is left HALF filled". A round where
 * two boards still hold both their players and a third holds one is exactly the
 * state that refuses reconcile and hides Unpair.
 */
function expectRoundWhollyUnseated(rows: FixtureRow[], r: number): void {
  const round = inRound(rows, r);
  expect(round.length).toBeGreaterThan(0);
  for (const f of round) {
    expect({
      key: f.ext_key,
      home: f.home_entrant_id,
      away: f.away_entrant_id,
      status: f.status,
      outcome: f.outcome,
    }).toEqual({ key: f.ext_key, home: null, away: null, status: "scheduled", outcome: null });
  }
}

async function seedSwissStage(
  auth: AuthCtx,
  rounds: number,
  entrantCount: number,
): Promise<{ divisionId: string; stageId: string }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss delete " + randomUUID().slice(0, 6),
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

/**
 * The pre-Start state the defect needs: shells minted (first Generate), then
 * round 1 PAIRED (second Generate). The division is never started — that is
 * the whole point, `deleteEntrant` refuses once it has been.
 */
async function mintAndPairRoundOne(auth: AuthCtx, stageId: string, field: number): Promise<void> {
  await generateStageFixtures(auth, stageId); // mint
  await generateStageFixtures(auth, stageId); // seat round 1
  const rows = await fixturesOf(stageId);
  expect(keysIn(rows, 1)).toEqual(expectedRoundKeys(1, field));
  expect(inRound(rows, 1).every(isSeated)).toBe(true);
  expect(seatedIn(rows, 1)).toHaveLength(field);
}

/** A round-1 BOARD player (one of two seated sides), never the bye recipient. */
async function boardPlayerOfRoundOne(stageId: string): Promise<string> {
  const [row] = await sql<{ home_entrant_id: string }[]>`
    select home_entrant_id from fixtures
    where stage_id = ${stageId} and round_no = 1
      and home_entrant_id is not null and away_entrant_id is not null
    order by seq_in_round limit 1`;
  return row!.home_entrant_id;
}

/** The entrant sitting out round 1 — the one holding the bye award. */
async function byeHolderOfRoundOne(stageId: string): Promise<string> {
  const [row] = await sql<{ home_entrant_id: string }[]>`
    select home_entrant_id from fixtures
    where stage_id = ${stageId} and round_no = 1 and ext_key like '%-bye'`;
  return row!.home_entrant_id;
}

/**
 * A refusal is pinned by its SENTENCE, not merely by `STAGE_NOT_READY`.
 * Every refusal on this path shares that code, so a code-only assertion is
 * satisfied by the WRONG refusal — and three of the tests below were green
 * before a line of production code changed, on "no seated swiss round to
 * unpair" rather than on the guard they exist to pin.
 */
function refusesWith(fragment: string) {
  return (err: unknown): boolean =>
    EngineError.is(err, "STAGE_NOT_READY") && String((err as Error).message).includes(fragment);
}

/**
 * The PRODUCTION damage, reproduced by its real producer: the bare
 * `delete from entrants` the shipped `deleteEntrant` ran, so the `on delete
 * set null` FK does the harm exactly as it did to live divisions. Used only by
 * the recovery half — half 1's tests all go through the real `deleteEntrant`.
 */
async function strandByLegacyDelete(entrantId: string): Promise<void> {
  await sql`delete from entrants where id = ${entrantId}`;
}

// ---------------------------------------------------------------------------
// Half 1 — the delete leaves the round coherent
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("swiss — deleting an entrant pre-Start leaves the round coherent", () => {
  // EVEN field, BOARD player. Six players, three boards, no bye.
  it("even field: deleting a paired board player unseats round 1 whole, and Pair next then works", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);
    await mintAndPairRoundOne(auth, stageId, 6);

    const victim = await boardPlayerOfRoundOne(stageId);
    await deleteEntrant(auth, victim);

    const after = await fixturesOf(stageId);
    // The defect: two boards still seated beside one holding a single player.
    expectRoundWhollyUnseated(after, 1);
    // Reconcile has not run yet — the shells are untouched, still six-shaped.
    expect(keysIn(after, 1)).toEqual(expectedRoundKeys(1, 6));

    // And the organiser has a way forward from the button they pressed.
    await generateStageFixtures(auth, stageId);
    const paired = await fixturesOf(stageId);
    expect(keysIn(paired, 1)).toEqual(expectedRoundKeys(1, 5));
    expect(inRound(paired, 1).every(isSeated)).toBe(true);
    const seated = seatedIn(paired, 1);
    expect(seated).toHaveLength(5);
    expect(new Set(seated).size).toBe(5);
    expect(seated).not.toContain(victim);
  });

  // ODD field, BOARD player — the round HOLDS a bye, and the bye's own holder
  // is not the one leaving. Seven players: three boards plus a bye.
  it("odd field: deleting a paired board player unseats the bye row too, bye award and all", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 7);
    await mintAndPairRoundOne(auth, stageId, 7);

    const victim = await boardPlayerOfRoundOne(stageId);
    const byeHolder = await byeHolderOfRoundOne(stageId);
    expect(byeHolder).not.toBe(victim);

    await deleteEntrant(auth, victim);

    const after = await fixturesOf(stageId);
    // The bye row is part of the round and is cleared with it: leaving a live
    // award beside four blank shells is a partly seated round by another name.
    expectRoundWhollyUnseated(after, 1);
    expect(keysIn(after, 1)).toEqual(expectedRoundKeys(1, 7));

    await generateStageFixtures(auth, stageId);
    const paired = await fixturesOf(stageId);
    expect(keysIn(paired, 1)).toEqual(expectedRoundKeys(1, 6));
    expect(seatedIn(paired, 1)).toHaveLength(6);
    expect(seatedIn(paired, 1)).not.toContain(victim);
  });

  // ODD field, the BYE RECIPIENT. The shape the original report did not name:
  // the FK leaves `{home: null, away: null, outcome: {award, winner: <gone>}}`,
  // which `isSwissBoardSeated` still reads as SEATED, so the round looks
  // complete and Generate walks past it into "current swiss round has
  // undecided fixtures". Nothing about one null slot appears anywhere.
  it("odd field: deleting the BYE HOLDER leaves no orphan award, and Pair next works", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 7);
    await mintAndPairRoundOne(auth, stageId, 7);

    const byeHolder = await byeHolderOfRoundOne(stageId);
    await deleteEntrant(auth, byeHolder);

    const after = await fixturesOf(stageId);
    expectRoundWhollyUnseated(after, 1);
    // Named explicitly: no `{kind:"award"}` survives with both seats empty.
    expect(inRound(after, 1).filter((f) => f.outcome !== null)).toEqual([]);

    await generateStageFixtures(auth, stageId);
    const paired = await fixturesOf(stageId);
    expect(keysIn(paired, 1)).toEqual(expectedRoundKeys(1, 6));
    expect(seatedIn(paired, 1)).toHaveLength(6);
    expect(seatedIn(paired, 1)).not.toContain(byeHolder);
  });

  // The test that separates "unseat" from "delete and re-mint": an organiser's
  // advance court layout must survive the departure. Standing requirement of
  // this programme — recreating the round would change fixture ids and throw
  // `scheduled_at` / `court_id` away silently.
  it("a board scheduled ahead keeps its id, its slot and its court across the unseat", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);

    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const pinnedAt = "2030-08-02T11:30:00.000Z";

    await mintAndPairRoundOne(auth, stageId, 6);
    const board = (await fixturesOf(stageId)).find((f) => f.ext_key === "sw-r1-b1")!;
    await sql`
      update fixtures set scheduled_at = ${pinnedAt}, court_id = ${court.id}
      where id = ${board.id}`;

    // Delete a player seated on a DIFFERENT board, so `sw-r1-b1` survives the
    // 6 → 5 reshape that follows and this is not vacuous.
    const [other] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures
      where stage_id = ${stageId} and round_no = 1 and ext_key = 'sw-r1-b3'`;
    await deleteEntrant(auth, other!.home_entrant_id);

    const after = await fixturesOf(stageId);
    expectRoundWhollyUnseated(after, 1);
    const kept = inRound(after, 1).find((f) => f.ext_key === "sw-r1-b1")!;
    expect(kept.id).toBe(board.id);
    const at = kept.scheduled_at;
    expect(at instanceof Date ? at.toISOString() : at).toBe(pinnedAt);
    expect(kept.court_id).toBe(court.id);
  });

  // Scope. An entrant who sits in no swiss round at all must cost nothing —
  // the unseat is not allowed to blank a round it has no business in. Remove
  // the `home_entrant_id = $1 or away_entrant_id = $1` filter and this reds.
  it("deleting an entrant who is seated nowhere leaves every paired round alone", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, 3, 7);
    await mintAndPairRoundOne(auth, stageId, 7);

    // Round 1 seats everybody, so enrol an eighth who is in no round at all.
    await createEntrants(auth, divisionId, [
      { kind: "individual" as const, display_name: "E8", seed: 8, members: [] },
    ]);
    const [spare] = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${divisionId} and display_name = 'E8'`;

    const before = await fixturesOf(stageId);
    await deleteEntrant(auth, spare!.id);
    const after = await fixturesOf(stageId);

    expect(inRound(after, 1).every(isSeated)).toBe(true);
    expect(seatedIn(after, 1).sort()).toEqual(seatedIn(before, 1).sort());
  });

  // Scope, the other axis. The unseat is a SWISS repair and must not reach
  // another stage kind: a league's round-robin fixtures are generated and
  // regenerated by an entirely different path (`rebuildStageFixtures`), and
  // blanking one because a player left would be a new defect, not a fix. Drop
  // `s.kind = 'swiss'` from the round query and this reds.
  //
  // It also RECORDS, rather than hides, what the same FK still does to a
  // league: the surviving side stays, the departed side goes null. That is the
  // pre-existing behaviour on a path this change deliberately does not touch.
  it("leaves a LEAGUE stage's fixtures to their own path, half-filled slot and all", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "League delete " + randomUUID().slice(0, 6),
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
      Array.from({ length: 4 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);

    const before = await fixturesOf(stage!.id);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every(isSeated)).toBe(true);

    const victim = before[0]!.home_entrant_id!;
    await deleteEntrant(auth, victim);

    const after = await fixturesOf(stage!.id);
    expect(after).toHaveLength(before.length);
    // Untouched by this change: every row the victim was NOT on still holds
    // both its players, which is exactly what a swiss-wide unseat would have
    // destroyed.
    const untouched = after.filter(
      (f) => !before.some((b) => b.id === f.id && (b.home_entrant_id === victim || b.away_entrant_id === victim)),
    );
    expect(untouched.length).toBeGreaterThan(0);
    expect(untouched.every(isSeated)).toBe(true);
    // And the victim's own rows are left in the FK's half-filled state — the
    // pre-existing league behaviour, pinned rather than quietly changed here.
    const victimRows = after.filter((f) =>
      before.some((b) => b.id === f.id && (b.home_entrant_id === victim || b.away_entrant_id === victim)),
    );
    expect(victimRows.length).toBeGreaterThan(0);
    expect(
      victimRows.every((f) => (f.home_entrant_id === null) !== (f.away_entrant_id === null)),
    ).toBe(true);
  });

  // The guard. Unseating is a destructive write, so a round carrying recorded
  // match data refuses the DELETE rather than wiping it — and the entrant is
  // still there afterwards. `config_snapshot` is used because it is the
  // monotonic arm of the canonical `fixtureEvidenceSql` and the only one that
  // can fire here: no played status, no award, no events.
  it("refuses the delete when the entrant's round carries recorded match data", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);
    await mintAndPairRoundOne(auth, stageId, 6);

    const victim = await boardPlayerOfRoundOne(stageId);
    const [board] = await sql<{ id: string }[]>`
      select id from fixtures
      where stage_id = ${stageId} and round_no = 1 and home_entrant_id = ${victim}`;
    await sql`
      update fixtures set config_snapshot = ${sql.json({ bestOf: 3 } as never)},
                          config_snapshot_at = now()
      where id = ${board!.id}`;

    await expect(deleteEntrant(auth, victim)).rejects.toSatisfy(
      refusesWith("swiss round has recorded match data"),
    );

    // A green refusal that had already cleared the round would be worthless.
    const after = await fixturesOf(stageId);
    expect(inRound(after, 1).every(isSeated)).toBe(true);
    const [still] = await sql<{ id: string }[]>`select id from entrants where id = ${victim}`;
    expect(still?.id).toBe(victim);
  });

  // The OTHER arm of the same guard, pinned on its own so neither can cover
  // for the other: a played STATUS with no evidence row anywhere.
  it("refuses the delete when the entrant's round holds a decided board", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);
    await mintAndPairRoundOne(auth, stageId, 6);

    const victim = await boardPlayerOfRoundOne(stageId);
    await sql`
      update fixtures set status = 'decided'
      where stage_id = ${stageId} and round_no = 1 and home_entrant_id = ${victim}`;

    await expect(deleteEntrant(auth, victim)).rejects.toSatisfy(
      refusesWith("swiss round has played results"),
    );
    const [still] = await sql<{ id: string }[]>`select id from entrants where id = ${victim}`;
    expect(still?.id).toBe(victim);
  });
});

// ---------------------------------------------------------------------------
// Half 2 — Unpair rescues a round that is ALREADY stranded
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("swiss — Unpair rescues an already-stranded round", () => {
  // THE PRODUCTION ROW SHAPE, half-seated board flavour. Built by the legacy
  // bare delete so the FK does the damage, not a hand-written fixture.
  it("clears a round left half-seated by the FK, and the reconcile then reshapes it", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);
    await mintAndPairRoundOne(auth, stageId, 6);

    const victim = await boardPlayerOfRoundOne(stageId);
    await strandByLegacyDelete(victim);

    // The stranding is real before we rescue it: exactly one board is half
    // filled, and its neighbours are fully seated.
    const stranded = await fixturesOf(stageId);
    const half = inRound(stranded, 1).filter(
      (f) => (f.home_entrant_id === null) !== (f.away_entrant_id === null),
    );
    expect(half).toHaveLength(1);
    expect(inRound(stranded, 1).filter(isSeated)).toHaveLength(2);
    // …and Generate is the dead end the organiser reported, verbatim.
    await expect(generateStageFixtures(auth, stageId)).rejects.toSatisfy(
      refusesWith("swiss round is already partly seated — reconcile refused"),
    );

    const out = await unpairSwissRound(auth, stageId);
    expect(out).toEqual({ cleared: 3, round: 1 });
    expectRoundWhollyUnseated(await fixturesOf(stageId), 1);

    await generateStageFixtures(auth, stageId);
    const paired = await fixturesOf(stageId);
    expect(keysIn(paired, 1)).toEqual(expectedRoundKeys(1, 5));
    expect(seatedIn(paired, 1)).toHaveLength(5);
  });

  // THE PRODUCTION ROW SHAPE, orphan-award flavour (odd field, bye recipient
  // deleted). Here the round reads as fully seated, so it was the played-result
  // guard rather than the seated predicate that refused.
  it("clears a round whose bye holder was deleted, leaving an award with no seats", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 7);
    await mintAndPairRoundOne(auth, stageId, 7);

    const byeHolder = await byeHolderOfRoundOne(stageId);
    await strandByLegacyDelete(byeHolder);

    const stranded = await fixturesOf(stageId);
    const orphan = inRound(stranded, 1).find((f) => f.ext_key === "sw-r1-bye")!;
    expect(orphan.home_entrant_id).toBeNull();
    expect(orphan.away_entrant_id).toBeNull();
    expect(orphan.outcome).toEqual({ kind: "award", winner: byeHolder });

    const out = await unpairSwissRound(auth, stageId);
    expect(out).toEqual({ cleared: 4, round: 1 });
    expectRoundWhollyUnseated(await fixturesOf(stageId), 1);

    await generateStageFixtures(auth, stageId);
    const paired = await fixturesOf(stageId);
    expect(keysIn(paired, 1)).toEqual(expectedRoundKeys(1, 6));
    expect(seatedIn(paired, 1)).toHaveLength(6);
    expect(seatedIn(paired, 1)).not.toContain(byeHolder);
  });

  // The widened target must not widen the permission. A partly seated round
  // that DOES hold evidence still refuses — force the evidence guard false and
  // this is the test that reds.
  it("still refuses a partly seated round that carries recorded match data", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);
    await mintAndPairRoundOne(auth, stageId, 6);

    const victim = await boardPlayerOfRoundOne(stageId);
    await strandByLegacyDelete(victim);

    // Evidence on a DIFFERENT, still fully seated board of the same round.
    const [other] = await sql<{ id: string }[]>`
      select id from fixtures
      where stage_id = ${stageId} and round_no = 1
        and home_entrant_id is not null and away_entrant_id is not null
      order by seq_in_round limit 1`;
    await sql`
      update fixtures set config_snapshot = ${sql.json({ bestOf: 3 } as never)},
                          config_snapshot_at = now()
      where id = ${other!.id}`;

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy(
      refusesWith("swiss round has recorded match data"),
    );
    // Refused means refused: the other board still holds both its players.
    const after = await fixturesOf(stageId);
    expect(inRound(after, 1).filter(isSeated)).toHaveLength(2);
  });

  // The other guard, on the same partly seated round, singly. A two-sided
  // award is a PLAYED match (a real forfeit or retirement) and is not exempt
  // just because the round next to it lost a player.
  it("still refuses a partly seated round holding a two-sided forfeit award", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);
    await mintAndPairRoundOne(auth, stageId, 6);

    const victim = await boardPlayerOfRoundOne(stageId);
    await strandByLegacyDelete(victim);

    const [other] = await sql<{ id: string; away_entrant_id: string }[]>`
      select id, away_entrant_id from fixtures
      where stage_id = ${stageId} and round_no = 1
        and home_entrant_id is not null and away_entrant_id is not null
      order by seq_in_round limit 1`;
    await sql`
      update fixtures set status = 'forfeited',
        outcome = ${sql.json({ kind: "award", winner: other!.away_entrant_id } as never)}
      where id = ${other!.id}`;

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy(
      refusesWith("swiss round has played results"),
    );
    const after = await fixturesOf(stageId);
    const kept = after.find((f) => f.id === other!.id)!;
    expect(kept.outcome).toEqual({ kind: "award", winner: other!.away_entrant_id });
    expect(kept.home_entrant_id).not.toBeNull();
  });

  // A stage with nothing seated anywhere still has nothing to unpair — the
  // widened predicate must not start answering "round 1" for a pile of shells.
  it("still refuses when no round holds a seat at all", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, 3, 6);
    await generateStageFixtures(auth, stageId); // mint only

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy(
      refusesWith("no seated swiss round to unpair"),
    );
  });
});
