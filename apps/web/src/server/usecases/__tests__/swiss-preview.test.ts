// MD-1 Task 5 (Match Day spec §7, Review Focus 4): the next Swiss round, previewed and then paired against a stale check.
//
// `previewSwissNextRound` runs the very Generate the desk's Pair next runs (`generateStageFixturesTx`), reads the round it
// seated and rolls the whole transaction back, answering the pairings and `inputHash`, a hash of the round's INPUTS (the
// stage's fixtures by id, status and result version, and the division's active entrants). `pairSwissNextRound` takes that
// hash and the previewed round back, recomputes the hash under the division lock and refuses MD_ALREADY (409) when that
// round is already seated, MD_STALE (409) when the inputs moved (results, field, stage config, lots draws), and otherwise
// runs the Generate for real.
//
// The case Review Focus 4 names: a preview whose draw uses lots. The preview commits that draw before its rolled-back
// Pair (fix round 1, I1), so the pair reads the very draw the preview did and seats exactly the previewed pairings; the
// hash is over the inputs, never the drawn pairings, so the approve is not refused as stale.
//
// Every expected value is read from the rows the rig wrote or from the preview's own answer; none is computed by the code
// under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { rankedStageStandings } from "@/server/engine-db/competition";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures, pairSwissNextRound, previewSwissNextRound } from "../stages";
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

interface Board {
  id: string;
  round_no: number;
  seq_in_round: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  ids: string[];
}

/** A chess Swiss (boardgame, colours on) of `players` individuals, started (which mints the shells), round 1 paired. */
async function chessSwiss(opts: { players: number; seeded: boolean; config?: Record<string, unknown> }): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss preview " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "boardgame", // single-sport: preview and pair are sport-blind wrappers over the one Generate; chess is the sport whose Swiss ties fall to lots (draws, no seeds) and whose colours add the most pairing inputs, so it carries every case here
    variant_key: "classical",
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.players }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      ...(opts.seeded ? { seed: i + 1 } : {}),
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 3, chess: true, ...(opts.config ?? {}) },
    progression: null,
  });
  await startDivision(auth, division.id);
  await generateStageFixtures(auth, stage!.id); // Pair round 1
  return { auth, divisionId: division.id, stageId: stage!.id, ids: entrants.map((e) => e.id) };
}

const boardsOf = (stageId: string, round?: number) =>
  sql<Board[]>`
    select id, round_no, seq_in_round, status, home_entrant_id, away_entrant_id from fixtures
     where stage_id = ${stageId} and (${round ?? null}::int is null or round_no = ${round ?? null}::int)
     order by round_no, seq_in_round`;

const playable = (b: Board) => b.home_entrant_id !== null && b.away_entrant_id !== null && b.status === "scheduled";

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: unknown = {}): Promise<void> {
  const [{ s }] = await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: s, type, payload } as never);
}
async function chessWin(auth: AuthCtx, b: Board, winner: string): Promise<void> {
  await post(auth, b.id, "core.start");
  await post(auth, b.id, "boardgame.result", { winner, method: "resign" });
}
async function chessDraw(auth: AuthCtx, b: Board): Promise<void> {
  await post(auth, b.id, "core.start");
  await post(auth, b.id, "boardgame.result", { winner: null, method: "agreement" });
}

/** Decide every playable board of round 1 with `how`; answers how many it decided. */
async function decideRoundOne(r: Rig, how: (b: Board) => Promise<void>): Promise<number> {
  const boards = (await boardsOf(r.stageId, 1)).filter(playable);
  for (const b of boards) await how(b);
  return boards.length;
}

const count = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]!.n;
const fixtureCount = (stageId: string) => count(sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId}`);
const eventCount = (divisionId: string) =>
  count(sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId}`);
const lotsCount = (stageId: string) => count(sql<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${stageId}`);
const seatedIn = async (stageId: string, round: number) => (await boardsOf(stageId, round)).filter((b) => b.home_entrant_id !== null).length;

/** The round's seated boards as the preview shapes them, read from the rows. */
async function seatedPairings(stageId: string, round: number) {
  return (await boardsOf(stageId, round))
    .filter((b) => b.home_entrant_id !== null)
    .map((b) => ({ home: b.home_entrant_id!, away: b.away_entrant_id, board: b.seq_in_round }));
}

/** The refusal's status and code, or null when the call went through. */
const refusalOf = (p: Promise<unknown>): Promise<{ status?: number; code?: string } | null> =>
  p.then(
    () => null,
    (e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }),
  );

describe.skipIf(!HAS_DB)("MD-1 Task 5: Swiss next-round preview and stale-checked pairing", () => {
  it("preview returns round 2 pairings and leaves no fixtures behind", async () => {
    const r = await chessSwiss({ players: 5, seeded: true });
    expect(await decideRoundOne(r, (b) => chessWin(r.auth, b, b.home_entrant_id!)), "rig: round 1 decided").toBe(2);
    const before = { fixtures: await fixtureCount(r.stageId), events: await eventCount(r.divisionId), lots: await lotsCount(r.stageId) };
    expect(await seatedIn(r.stageId, 2), "premise: round 2 is not seated").toBe(0);

    const preview = await previewSwissNextRound(r.auth, r.stageId);

    expect(preview.round).toBe(2);
    expect(preview.pairings.length, "two boards and the bye of a field of five").toBe(3);
    const seated = preview.pairings.flatMap((p) => [p.home, p.away]).filter((id): id is string => id !== null);
    expect([...seated].sort(), "every entrant is seated exactly once").toEqual([...r.ids].sort());
    expect(preview.pairings.filter((p) => p.away === null).length, "one bye, as a pairing with no away").toBe(1);
    expect(preview.pairings.map((p) => p.board), "boards numbered in order").toEqual([1, 2, 3]);
    expect(preview.inputHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await fixtureCount(r.stageId), "the fixture count is unchanged").toBe(before.fixtures);
    expect(await seatedIn(r.stageId, 2), "round 2 is still not seated").toBe(0);
    expect(await eventCount(r.divisionId), "no ledger row was left behind").toBe(before.events);
    expect(await lotsCount(r.stageId), "no lots draw was left behind").toBe(before.lots);
  }, 180_000);

  it("pair with the preview's hash creates exactly the previewed round", async () => {
    const r = await chessSwiss({ players: 6, seeded: true });
    expect(await decideRoundOne(r, (b) => chessWin(r.auth, b, b.home_entrant_id!)), "rig: round 1 decided").toBe(3);
    const preview = await previewSwissNextRound(r.auth, r.stageId);
    expect(preview.pairings.length, "anti-vacuity: three boards proposed").toBe(3);

    const paired = await pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round);

    expect(paired).toEqual({ round: 2 });
    expect(await seatedPairings(r.stageId, 2), "the very pairings the preview proposed (no lots drawn)").toEqual(preview.pairings);
  }, 180_000);

  it("pair after a result changed is MD_STALE", async () => {
    const r = await chessSwiss({ players: 4, seeded: true });
    expect(await decideRoundOne(r, (b) => chessWin(r.auth, b, b.home_entrant_id!)), "rig: round 1 decided").toBe(2);
    const preview = await previewSwissNextRound(r.auth, r.stageId);

    // A correction that leaves the board decided: the result is taken back and the other side recorded as the winner. The
    // board's status is `decided` before and after, so only its result version tells the two apart.
    const [board] = await boardsOf(r.stageId, 1);
    const [last] = await sql<{ id: string; seq: number }[]>`
      select id, seq from score_events where fixture_id = ${board!.id} order by seq desc limit 1`;
    await scoreEvent(r.auth, board!.id, { expected_seq: last!.seq, type: "core.void", payload: { event_id: last!.id } } as never);
    await post(r.auth, board!.id, "boardgame.result", { winner: board!.away_entrant_id, method: "resign" });
    const [after] = await boardsOf(r.stageId, 1);
    expect(after!.status, "premise: the board is decided again, so its status did not move").toBe(board!.status);

    expect(await refusalOf(pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round))).toEqual({ status: 409, code: "MD_STALE" });
    expect(await seatedIn(r.stageId, 2), "nothing was seated").toBe(0);
    // And a fresh preview's hash pairs.
    const again = await previewSwissNextRound(r.auth, r.stageId);
    expect(again.inputHash, "the fresh preview hashes the new result").not.toBe(preview.inputHash);
    expect(await pairSwissNextRound(r.auth, r.stageId, again.inputHash, again.round)).toEqual({ round: 2 });
  }, 180_000);

  it("pair after the field changed is MD_STALE", async () => {
    const r = await chessSwiss({ players: 5, seeded: true });
    expect(await decideRoundOne(r, (b) => chessWin(r.auth, b, b.home_entrant_id!)), "rig: round 1 decided").toBe(2);
    const preview = await previewSwissNextRound(r.auth, r.stageId);
    const fixturesBefore = await sql<{ id: string; status: string }[]>`select id, status from fixtures where stage_id = ${r.stageId} order by id`;

    await withdrawEntrantCascade(r.auth, r.ids[4]!);
    // The leaver's boards are all decided, so the withdrawal leaves the stage's fixtures as they were: only the field moved.
    expect(await sql`select id, status from fixtures where stage_id = ${r.stageId} order by id`, "premise: the fixtures did not move").toEqual(
      fixturesBefore,
    );

    expect(await refusalOf(pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round))).toEqual({ status: 409, code: "MD_STALE" });
    expect(await seatedIn(r.stageId, 2), "nothing was seated").toBe(0);
  }, 180_000);

  it("pair twice: the second is MD_ALREADY", async () => {
    const r = await chessSwiss({ players: 4, seeded: true });
    expect(await decideRoundOne(r, (b) => chessWin(r.auth, b, b.home_entrant_id!)), "rig: round 1 decided").toBe(2);
    const preview = await previewSwissNextRound(r.auth, r.stageId);
    expect(await pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round)).toEqual({ round: 2 });
    const seated = await seatedPairings(r.stageId, 2);
    const fixtures = await fixtureCount(r.stageId);

    // The second phone, holding the same proposal.
    expect(await refusalOf(pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round))).toEqual({ status: 409, code: "MD_ALREADY" });
    expect(await seatedPairings(r.stageId, 2), "round 2 is as the first approve seated it").toEqual(seated);
    expect(await fixtureCount(r.stageId)).toBe(fixtures);
    expect(await seatedIn(r.stageId, 3), "and round 3 was not touched").toBe(0);
  }, 180_000);

  it("a preview that draws lots still pairs with its own hash, and seats exactly the previewed pairings", async () => {
    // Unseeded and drawn level: rank-adjacent pairing ranks the level table, which takes a drawing of lots.
    const r = await chessSwiss({ players: 4, seeded: false, config: { pairing: "rank_adjacent" } });
    expect(await decideRoundOne(r, (b) => chessDraw(r.auth, b)), "rig: both round-1 boards drawn, so the table is level").toBe(2);
    // Scoring's refold stored the draw the level table needed. Take it away, so the preview has to draw lots itself.
    expect(await lotsCount(r.stageId), "premise: scoring stored a draw for the level table").toBeGreaterThan(0);
    await sql`delete from stage_lots_draws where stage_id = ${r.stageId}`;

    const preview = await previewSwissNextRound(r.auth, r.stageId);
    expect(preview.round).toBe(2);
    expect(await lotsCount(r.stageId), "the preview drew lots and KEPT the draw (committed before its rolled-back Pair)").toBeGreaterThan(0);
    expect(await seatedIn(r.stageId, 2), "while round 2 itself was rolled back").toBe(0);
    const second = await previewSwissNextRound(r.auth, r.stageId);
    expect(second.pairings, "a second preview reads the same stored draw, so it proposes the same pairings").toEqual(preview.pairings);

    expect(await pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round), "the approve is not stale").toEqual({ round: 2 });
    expect(await seatedPairings(r.stageId, 2), "the round seated is the previewed round, board by board").toEqual(preview.pairings);
  }, 180_000);

  it("a lots draw replaced after the preview is MD_STALE", async () => {
    const r = await chessSwiss({ players: 4, seeded: false, config: { pairing: "rank_adjacent" } });
    expect(await decideRoundOne(r, (b) => chessDraw(r.auth, b))).toBe(2);
    const preview = await previewSwissNextRound(r.auth, r.stageId);
    expect(await lotsCount(r.stageId), "premise: the pairing reads a stored draw").toBeGreaterThan(0);
    // The draw the preview paired over goes; the pair would have to draw again, perhaps differently.
    await sql`delete from stage_lots_draws where stage_id = ${r.stageId}`;

    expect(await refusalOf(pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round))).toEqual({ status: 409, code: "MD_STALE" });
    expect(await seatedIn(r.stageId, 2), "nothing was seated").toBe(0);
  }, 180_000);

  it("a pairing mode changed after the preview is MD_STALE", async () => {
    const r = await chessSwiss({ players: 6, seeded: true });
    expect(await decideRoundOne(r, (b) => chessWin(r.auth, b, b.home_entrant_id!)), "rig: round 1 decided").toBe(3);
    const preview = await previewSwissNextRound(r.auth, r.stageId);
    const [cfg] = await sql<{ pairing: string | null }[]>`select config->>'pairing' as pairing from stages where id = ${r.stageId}`;
    expect(cfg!.pairing, "premise: the stage pairs by its default mode").not.toBe("rank_adjacent");
    // The desk's pairing menu: the stage's stored mode changes between the review and the approve.
    await sql`update stages set config = config || '{"pairing":"rank_adjacent"}'::jsonb where id = ${r.stageId}`;

    expect(await refusalOf(pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round))).toEqual({ status: 409, code: "MD_STALE" });
    expect(await seatedIn(r.stageId, 2), "nothing was seated").toBe(0);
  }, 180_000);

  it("an approve for a round other than the next one: a seated round is MD_ALREADY even after a result, a later one MD_STALE", async () => {
    const r = await chessSwiss({ players: 4, seeded: true });
    expect(await decideRoundOne(r, (b) => chessWin(r.auth, b, b.home_entrant_id!))).toBe(2);
    const preview = await previewSwissNextRound(r.auth, r.stageId);
    // A round ahead of the next one to pair is not the proposal the server holds.
    expect(await refusalOf(pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round + 1))).toEqual({ status: 409, code: "MD_STALE" });
    expect(await seatedIn(r.stageId, 3), "nothing was seated").toBe(0);
    // A round that is not a whole number is refused before anything is read.
    expect(await refusalOf(pairSwissNextRound(r.auth, r.stageId, preview.inputHash, Number.NaN))).toEqual({ status: 422, code: undefined });

    expect(await pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round)).toEqual({ round: 2 });
    // A scorer finishes a board of the new round before the second phone approves: still the round it held, already seated.
    const [b] = (await boardsOf(r.stageId, 2)).filter(playable);
    await chessWin(r.auth, b!, b!.home_entrant_id!);
    expect(await refusalOf(pairSwissNextRound(r.auth, r.stageId, preview.inputHash, preview.round))).toEqual({ status: 409, code: "MD_ALREADY" });
    expect(await seatedIn(r.stageId, 3), "round 3 was not touched").toBe(0);
  }, 180_000);

  it("a preview of a round still in play gives one refusal, with or without a result", async () => {
    const r = await chessSwiss({ players: 4, seeded: true });
    // Round 1 is paired and nothing is played yet.
    const fresh = await refusalOf(previewSwissNextRound(r.auth, r.stageId));
    const [b] = (await boardsOf(r.stageId, 1)).filter(playable);
    await chessWin(r.auth, b!, b!.home_entrant_id!);
    const oneResult = await refusalOf(previewSwissNextRound(r.auth, r.stageId));
    expect(fresh?.code, "the round still in play: not ready").toBe("STAGE_NOT_READY");
    expect(oneResult, "the same refusal after its first result").toEqual(fresh);
  }, 180_000);

  it("a preview with every round seated is MD_ALREADY", async () => {
    const r = await chessSwiss({ players: 4, seeded: true, config: { rounds: 1 } });
    expect(await seatedIn(r.stageId, 1), "premise: the one round is seated").toBe(2);
    expect(await refusalOf(previewSwissNextRound(r.auth, r.stageId))).toEqual({ status: 409, code: "MD_ALREADY" });
  }, 180_000);

  it("anti-vacuity for the lots case: that level table takes a drawing of lots, inside a transaction", async () => {
    // The ranking the rank-adjacent pair reads (`rankedStageStandings`) stores the draw it makes: from this state a draw is
    // needed, so the lots tests above exercise a real drawing of lots.
    const r = await chessSwiss({ players: 4, seeded: false, config: { pairing: "rank_adjacent" } });
    expect(await decideRoundOne(r, (b) => chessDraw(r.auth, b))).toBe(2);
    await sql`delete from stage_lots_draws where stage_id = ${r.stageId}`;
    const ROLLBACK = new Error("rollback");
    let drawn = -1;
    await withTenant(r.auth.orgId, async (tx) => {
      await rankedStageStandings(tx, r.stageId);
      drawn = (await tx<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${r.stageId}`)[0]!.n;
      throw ROLLBACK;
    }).catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
    expect(drawn, "the level table's ranking draws lots").toBeGreaterThan(0);
  }, 180_000);
});
