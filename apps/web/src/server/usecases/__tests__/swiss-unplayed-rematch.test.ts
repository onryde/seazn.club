// W3 Task 7 (X-SW-15; RB3-2, RB3-14): a Swiss pair whose match was NOT PLAYED has not met, so the two may be paired again
// — rulebook P-A2 (FIDE C.04.2 3.5): "A pair whose match was not played (a one-sided walkover, a double walkover, a
// forfeit before play) has not met". The walkover winner still never takes the pairing-allocated bye (P-A4).
//
// Before this task the history (`buildSwissHistory`) added EVERY two-seated row to `played`, so a double walkover or a
// no-show "used up" the pairing, and a 4-player field could run out of legal opponents for games nobody played.
//
// What "played" means is the ledger's, read once by the one server reader (`forfeitPlayedFacts`, engine
// `playRecorded`) under the division's module, and judged by the engine's one rule (`isUnplayedForfeit`): a walkover is
// unplayed whatever the ledger reads; any other forfeit only while nothing was played. Chess (boardgame) declares
// `startIsPlay` (ruling 118): a retirement after a bare Start IS a played game, and a no-show after it is "still a
// walkover (the reason the organiser picks tells them apart)" — so it has not met.
//
// The forced shape (premise note: the brief's "the only legal round-3 pairing" does not exist for 4 players — with two
// full rounds behind it, round 3 always has the never-seated matching legal; see the task report). Four players S1..S4
// in a 3-round Swiss. Round 1 is the fold (S1 v S3, S2 v S4); S1 and S4 win, so round 2 pairs the score groups {S1, S4}
// and {S2, S3}. Round 2's two boards then carry the case under test. Round 3's answer turns on it alone:
//   - unplayed (not met): the only met pairs are round 1's, and the score groups (engine `pairRound`: own score group
//     first, then the nearest group, then rank) re-seat round 2's pairs — S1-S4 and S2-S3 again;
//   - played (met): every pair but S1-S2 and S3-S4 has met, so round 3 is exactly those two boards.
// So the right answer and the wrong one differ on every board, both ways.
//
// Every result goes through the real producers — the Forfeit button's `core.forfeit` and the scorer's events through
// `scoreEvent` — and every round through the real Pair (`generateStageFixtures`); the step path through the real
// Undo/Redo (`undoDivision` / `redoDivision`). The engine's input is read through a spy on `pairRound` (precedent:
// swiss-late-field.test.ts).
//
// Two sports, the same body: badminton (no `startIsPlay`: play is a sport event after the Start) and boardgame (chess
// colours on; `startIsPlay`: the Start is play). `startIsPlay` is the one module field the rule reads, so these two
// cover both of its values; the rest of the registry reads as badminton does.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { pairKey, type SwissHistory, type SwissStanding } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { isOneSidedAwardBye } from "@/lib/fixture-bye";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { redoDivision, undoDivision } from "../history";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { buildSwissHistory, createStages, generateStageFixtures, type ActiveEntrant, type SwissExistingFixture } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// ─── The pure rule: P-A2's truth table, over buildSwissHistory ──────────────────────────────────────────────────────

const ent = (id: string): ActiveEntrant => ({ id, seed: null, swiss_first_round: null });

function row(id: string, round: number, seq: number, home: string | null, away: string | null, outcome: unknown): SwissExistingFixture {
  return {
    id,
    ext_key: away === null ? `sw-r${round}-bye` : `sw-r${round}-b${seq}`,
    round_no: round,
    seq_in_round: seq,
    status: outcome === null ? "scheduled" : "decided",
    home_entrant_id: home,
    away_entrant_id: away,
    outcome,
    scheduled_at: null,
    court_id: null,
    venue_id: null,
    schedule_locked: false,
  };
}

const award = (reason: string) => ({ kind: "award", winner: "a", loser: "b", reason });
const LEGACY_CHESS_FORFEIT_WIN = { kind: "win", winner: "a", method: "forfeit" }; // legacy replay row: pre-W2b chess, still stored

/** P-A2, row by row: the board a-v-b's outcome, its ledger's played fact (undefined: an outcome no forfeit decided, so no
 *  fact is read), and whether the RULEBOOK says a and b have met. Never read from the code under test. */
const P_A2: { name: string; outcome: unknown; fact: boolean | undefined; met: boolean }[] = [
  { name: "a played win", outcome: { kind: "win", winner: "a" }, fact: undefined, met: true },
  { name: "a played draw", outcome: { kind: "draw" }, fact: undefined, met: true },
  { name: "a double walkover", outcome: { kind: "double_walkover" }, fact: undefined, met: false },
  { name: "a one-sided walkover before play", outcome: award("walkover"), fact: false, met: false },
  { name: "a one-sided walkover after a chess Start (ruling 118: a no-show is still a walkover)", outcome: award("walkover"), fact: true, met: false },
  { name: "a retirement after play", outcome: award("retired"), fact: true, met: true },
  { name: "a withdrawal before play (a forfeit before play)", outcome: award("withdrew"), fact: false, met: false },
  { name: "a withdrawal after play", outcome: award("withdrew"), fact: true, met: true },
  { name: "a disqualification before play", outcome: award("disqualified"), fact: false, met: false },
  { name: "a disqualification after play", outcome: award("disqualified"), fact: true, met: true },
  { name: "a pre-W2b chess win by forfeit, nothing played", outcome: LEGACY_CHESS_FORFEIT_WIN, fact: false, met: false },
  { name: "a pre-W2b chess win by forfeit after play", outcome: LEGACY_CHESS_FORFEIT_WIN, fact: true, met: true },
];

describe("W3 T7 buildSwissHistory: X-SW-15 a pair whose match was not played has not met (P-A2)", () => {
  // Round 1: the board under test (a v b) and a played board (c beats d), so the round is fully seated.
  const field = ["a", "b", "c", "d"].map(ent);
  const historyOf = (outcome: unknown, fact: boolean | undefined) =>
    buildSwissHistory(
      [row("ab", 1, 1, "a", "b", outcome), row("cd", 1, 2, "c", "d", { kind: "win", winner: "c" })],
      field,
      fact === undefined ? new Map() : new Map([["ab", fact]]),
    );

  let checked = 0;
  for (const c of P_A2) {
    it(`X-SW-15 ${c.name}: ${c.met ? "met — no rematch" : "not met — may meet again"}`, () => {
      const h = historyOf(c.outcome, c.fact);
      expect(h.played.has(pairKey("a", "b")), "a and b have met").toBe(c.met);
      expect(h.played.has(pairKey("c", "d")), "the played board beside it has met").toBe(true);
      // Both sides SAT the round, met or not (M2: a double walkover is decided, nobody is owed a bye for it): no
      // implicit bye, so neither is bye-marked for it and neither is credited a point for the round.
      expect(h.byes.has("b"), "the side that lost or forfeited is not given a bye for the round").toBe(false);
      // FIDE game points: ½ for a draw, else nothing for b — never the implicit bye's +1.
      expect(h.score.get("b"), "nor a point").toBe((c.outcome as { kind: string }).kind === "draw" ? 0.5 : 0);
      checked++;
    });
  }
  it("anti-vacuity: every P-A2 row ran, and both answers were asked", () => {
    expect(checked, "rows checked").toBe(P_A2.length);
    expect(P_A2.filter((c) => c.met).length, "rows whose pair met").toBeGreaterThan(0);
    expect(P_A2.filter((c) => !c.met).length, "rows whose pair did not").toBeGreaterThan(0);
  });

  it("X-SW-15 a walkover winner is still never given the bye: not met, yet bye-marked, and the win's point stands (P-A4)", () => {
    const h = historyOf(award("walkover"), false);
    expect(h.played.has(pairKey("a", "b")), "not met (P-A2)").toBe(false);
    expect(h.byes.has("a"), "the walkover winner may not take the pairing-allocated bye (P-A4)").toBe(true);
    expect(h.score.get("a"), "the win's point").toBe(1);
  });

  it("X-SW-15 a double walkover: both sides keep their bye eligibility, score nothing, and take no colour (M2, P-A5)", () => {
    const h = historyOf({ kind: "double_walkover" }, undefined);
    expect([h.byes.has("a"), h.byes.has("b")], "both still bye-eligible").toEqual([false, false]);
    expect([h.score.get("a"), h.score.get("b")], "both on 0").toEqual([0, 0]);
    expect([h.colours.get("a"), h.colours.get("b")], "a game nobody played holds no colour").toEqual([undefined, undefined]);
  });

  it("the guard: a forfeit-decided board whose played fact was never read is refused, never guessed", () => {
    let thrown: unknown = null;
    try {
      historyOf(award("retired"), undefined);
    } catch (e) {
      thrown = e;
    }
    expect(EngineError.is(thrown, "CONFIG_INVALID"), `refused CONFIG_INVALID (got ${String(thrown)})`).toBe(true);
    expect((thrown as EngineError).data, "naming the board").toEqual({ fixtureId: "ab" });
  });

  it("the empty case: no forfeit anywhere and no facts — every seated pair has met, and nothing is asked", () => {
    const rows = [
      row("ab", 1, 1, "a", "b", { kind: "win", winner: "a" }),
      row("cd", 1, 2, "c", "d", { kind: "draw" }),
      row("ac", 2, 1, "a", "c", { kind: "win", winner: "c" }),
      row("bd", 2, 2, "b", "d", { kind: "win", winner: "b" }),
    ];
    const h = buildSwissHistory(rows, field, new Map());
    const want = rows.map((f) => pairKey(f.home_entrant_id!, f.away_entrant_id!)).sort();
    expect(want.length, "pairs checked").toBe(4);
    expect([...h.played].sort()).toEqual(want);
  });

  it("a bye row is a bye, not a pair: it adds nothing to `played` and its fact is never asked", () => {
    const h = buildSwissHistory(
      [row("ab", 1, 1, "a", "b", { kind: "win", winner: "a" }), row("bye", 1, 2, "c", null, { kind: "award", winner: "c", reason: "bye" })],
      ["a", "b", "c"].map(ent),
      new Map(),
    );
    expect([...h.played], "only the board").toEqual([pairKey("a", "b")]);
    expect(h.byes.has("c"), "the bye is a bye").toBe(true);
  });
});

// ─── The DB-backed cases: the real producers, the real Pair ──────────────────────────────────────────────────────────

interface Board {
  id: string;
  round_no: number;
  seq_in_round: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string; reason?: string } | null;
}

interface Sport {
  key: "badminton" | "boardgame";
  variant: string;
  config: Record<string, unknown>;
  /** The scorer's quick result: `winner` wins the board. */
  win(auth: AuthCtx, board: Board, winner: string): Promise<void>;
  /** Something PLAYED, then `by` retires: badminton plays a game first; chess's Start is play (ruling 118). */
  retireAfterPlay(auth: AuthCtx, board: Board, by: string): Promise<void>;
}

/** One event through the real scoring usecase, at the fixture's tip. */
async function emit(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown>) {
  const [{ tip }] = await sql<{ tip: number }[]>`select coalesce(max(seq), 0)::int as tip from score_events where fixture_id = ${fixtureId}`;
  return scoreEvent(auth, fixtureId, { expected_seq: tip, type, payload });
}

const SPORTS: Sport[] = [
  {
    key: "badminton",
    variant: "bwf",
    config: {},
    async win(auth, b, winner) {
      const homeWins = winner === b.home_entrant_id;
      await emit(auth, b.id, "core.start", {});
      for (let g = 0; g < 2; g++) {
        await emit(auth, b.id, "badminton.game.summary", homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 });
      }
    },
    async retireAfterPlay(auth, b, by) {
      await emit(auth, b.id, "core.start", {});
      await emit(auth, b.id, "badminton.game.summary", { home: 21, away: 19 });
      await emit(auth, b.id, "core.forfeit", { by, reason: "retired" });
    },
  },
  {
    key: "boardgame",
    variant: "classical",
    config: { chess: true },
    async win(auth, b, winner) {
      await emit(auth, b.id, "core.start", {});
      await emit(auth, b.id, "boardgame.result", { winner, method: "resign" });
    },
    async retireAfterPlay(auth, b, by) {
      await emit(auth, b.id, "core.start", {});
      await emit(auth, b.id, "core.forfeit", { by, reason: "retired" });
    },
  },
];

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  idOf: (name: string) => string;
  nameOf: (id: string | null | undefined) => string;
}

const boardsOf = (stageId: string, round: number) =>
  sql<Board[]>`
    select id, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome from fixtures
    where stage_id = ${stageId} and round_no = ${round} order by seq_in_round`;

/** `count` individuals S1..S<count> (seeds 1..count) in a 3-round Swiss, started (which mints the shells), round 1 paired. */
async function pairedRoundOne(sport: Sport, count: number): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss rematch " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: count }, (_, i) => ({ kind: "individual" as const, display_name: `S${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3, ...sport.config }, progression: null });
  await startDivision(auth, division.id);
  await generateStageFixtures(auth, stage!.id); // Pair round 1
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  return {
    sport,
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    idOf: (n) => byName.get(n)!,
    nameOf: (id) => entrants.find((e) => e.id === id)?.display_name ?? "-",
  };
}

/** A round's boards as unordered pairs of names, sorted: who meets whom, whatever the colours made home. */
async function pairsOf(r: Rig, round: number): Promise<string[]> {
  return (await boardsOf(r.stageId, round))
    .filter((b) => b.home_entrant_id !== null && b.away_entrant_id !== null)
    .map((b) => [r.nameOf(b.home_entrant_id), r.nameOf(b.away_entrant_id)].sort().join("-"))
    .sort();
}

const boardWith = async (r: Rig, round: number, a: string, b: string) => {
  const found = (await boardsOf(r.stageId, round)).find(
    (f) => [r.nameOf(f.home_entrant_id), r.nameOf(f.away_entrant_id)].sort().join("-") === [a, b].sort().join("-"),
  );
  expect(found, `rig: round ${round} seats ${a} v ${b}`).toBeDefined();
  return found!;
};

/** Pair the next round, reading what the engine was handed. */
async function pairSpied(r: Rig): Promise<{ standings: SwissStanding[]; history: SwissHistory }> {
  const engine = await import("@seazn/engine/scheduling");
  const spy = vi.spyOn(engine, "pairRound");
  try {
    await generateStageFixtures(r.auth, r.stageId);
    expect(spy.mock.calls.length, "anti-vacuity: the Pair called the engine once").toBe(1);
    const [standings, history] = spy.mock.calls[0]!;
    return { standings: [...standings], history };
  } finally {
    spy.mockRestore();
  }
}

/**
 * The shared opening: round 1 is the fold (S1 v S3, S2 v S4); S1 beats S3 and S4 beats S2, both PLAYED; round 2 pairs
 * the score groups {S1, S4} and {S2, S3}. Returns round 2's two boards.
 */
async function toRoundTwo(r: Rig): Promise<{ top: Board; bottom: Board }> {
  expect(await pairsOf(r, 1), "rig: round 1 is the fold").toEqual(["S1-S3", "S2-S4"]);
  await r.sport.win(r.auth, await boardWith(r, 1, "S1", "S3"), r.idOf("S1"));
  await r.sport.win(r.auth, await boardWith(r, 1, "S2", "S4"), r.idOf("S4"));
  await generateStageFixtures(r.auth, r.stageId); // Pair round 2
  expect(await pairsOf(r, 2), "rig: round 2 pairs the score groups").toEqual(["S1-S4", "S2-S3"]);
  return { top: await boardWith(r, 2, "S1", "S4"), bottom: await boardWith(r, 2, "S2", "S3") };
}

/** The two round-3 answers, from the opening above (see the header): round 2's pairs again, or the two that never met. */
const REMATCH = ["S1-S4", "S2-S3"];
const NO_REMATCH = ["S1-S2", "S3-S4"];

for (const sport of SPORTS) {
  describe.runIf(HAS_DB)(`W3 T7 X-SW-15 unplayed pairs may meet again (${sport.key})`, () => {
    it(`X-SW-15 a double walkover pair may meet again (${sport.key})`, async () => {
      const r = await pairedRoundOne(sport, 4);
      const { top, bottom } = await toRoundTwo(r);
      for (const b of [top, bottom]) {
        const res = await emit(r.auth, b.id, "core.forfeit", { by: "both", reason: "walkover" });
        expect([res.status, res.outcome], "rig: a recorded double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
      }

      const { history } = await pairSpied(r); // Pair round 3
      expect(history.played.has(pairKey(r.idOf("S1"), r.idOf("S4"))), "the engine is told S1 and S4 have not met").toBe(false);
      expect(history.played.has(pairKey(r.idOf("S2"), r.idOf("S3"))), "nor S2 and S3").toBe(false);
      expect(history.played.size, "round 1's two played boards are the only meetings").toBe(2);
      expect(await pairsOf(r, 3), "round 3 re-seats both double-walkover pairs").toEqual(REMATCH);

      // A second Pair: nothing is left to seat, so it changes nothing.
      const before = await boardsOf(r.stageId, 3);
      const again = await generateStageFixtures(r.auth, r.stageId);
      expect(again.created, "a second Pair seats nothing").toBe(0);
      expect(await boardsOf(r.stageId, 3), "and round 3 stands as it was").toEqual(before);
    }, 180_000);

    it(`X-SW-15 a pre-play walkover (reason walkover) pair may meet again — and a Redo of the Pair seats it again (${sport.key})`, async () => {
      const r = await pairedRoundOne(sport, 4);
      const { top, bottom } = await toRoundTwo(r);
      // S1 and S2 do not turn up: S4 and S3 win by walkover, nothing played. S4 2, S1 1, S3 1, S2 0: S4 floats onto the
      // better-ranked of the 1-group, S1 — a pair that has not met — and S3 then meets S2.
      for (const [b, noShow] of [[top, "S1"], [bottom, "S2"]] as const) {
        const res = await emit(r.auth, b.id, "core.forfeit", { by: r.idOf(noShow), reason: "walkover" });
        expect(res.outcome, "rig: a recorded walkover").toMatchObject({ kind: "award", reason: "walkover" });
      }

      const { history } = await pairSpied(r); // Pair round 3
      expect(history.played.has(pairKey(r.idOf("S1"), r.idOf("S4"))), "a walkover is not a meeting").toBe(false);
      expect([history.byes?.has(r.idOf("S4")), history.byes?.has(r.idOf("S3"))], "both walkover winners are bye-ineligible (P-A4)").toEqual([true, true]);
      const paired = await pairsOf(r, 3);
      expect(paired, "round 3 re-seats both walkover pairs").toEqual(REMATCH);

      // The step path: Undo the Pair, then Redo it. Redo runs swissGen in the history step's own transaction
      // (`generateStageFixturesTx(…, "step")`), which reads the facts there — so it seats the same rematch.
      const undone = await undoDivision(r.auth, r.divisionId);
      expect(undone.applied.type, "rig: the Undo walked back the Pair").toBe("fixtures_cleared");
      expect(await pairsOf(r, 3), "rig: round 3 unseated").toEqual([]);
      const redone = await redoDivision(r.auth, r.divisionId);
      expect(redone.applied.type).toBe("fixtures_generated");
      expect(await pairsOf(r, 3), "the Redo re-seats the same rematch").toEqual(paired);
    }, 180_000);

    it(`X-SW-15 a retirement after play is met: no rematch (${sport.key})`, async () => {
      const r = await pairedRoundOne(sport, 4);
      const { top, bottom } = await toRoundTwo(r);
      // The same no-shows as the walkover case, but each AFTER play: a retirement. Same scores, so only `played` differs.
      await sport.retireAfterPlay(r.auth, top, r.idOf("S1"));
      await sport.retireAfterPlay(r.auth, bottom, r.idOf("S2"));
      for (const b of [top, bottom]) {
        const [d] = await boardsOf(r.stageId, 2).then((rows) => rows.filter((f) => f.id === b.id));
        expect(d!.outcome, "rig: a recorded retirement").toMatchObject({ kind: "award", reason: "retired" });
      }

      const { history } = await pairSpied(r);
      expect(history.played.has(pairKey(r.idOf("S1"), r.idOf("S4"))), "a retirement after play is a meeting").toBe(true);
      expect(history.played.has(pairKey(r.idOf("S2"), r.idOf("S3"))), "both").toBe(true);
      expect(await pairsOf(r, 3), "round 3 seats the two pairs that never met").toEqual(NO_REMATCH);
    }, 180_000);

    it(`X-SW-15 after a void: a double walkover taken back and replaced by a played game is a meeting (${sport.key})`, async () => {
      const r = await pairedRoundOne(sport, 4);
      const { top, bottom } = await toRoundTwo(r);
      // Each round-2 board is first recorded as a double walkover, then the forfeit is taken back (`core.void`) and the
      // board is played: S4 and S3 win. The history reads what stands — a played game — so both pairs have met.
      for (const [b, winner] of [[top, "S4"], [bottom, "S3"]] as const) {
        const dw = await emit(r.auth, b.id, "core.forfeit", { by: "both", reason: "walkover" });
        expect(dw.outcome, "rig: a recorded double walkover").toEqual({ kind: "double_walkover" });
        const undone = await emit(r.auth, b.id, "core.void", { event_id: dw.event_id });
        expect(undone.outcome, "rig: the void reopened the board").toBeNull();
        const [reopened] = await boardsOf(r.stageId, 2).then((rows) => rows.filter((f) => f.id === b.id));
        await sport.win(r.auth, reopened!, r.idOf(winner));
      }

      const { history } = await pairSpied(r);
      expect(history.played.has(pairKey(r.idOf("S1"), r.idOf("S4"))), "the played game is a meeting").toBe(true);
      expect(history.played.has(pairKey(r.idOf("S2"), r.idOf("S3"))), "both").toBe(true);
      expect(await pairsOf(r, 3), "round 3 seats the two pairs that never met").toEqual(NO_REMATCH);
    }, 180_000);

    if (sport.key === "badminton") {
      // single-sport: chess's only voidable play is its Start (ruling 118), and once the Start is taken back only a
      // walkover can be recorded — unplayed whatever the ledger reads — so the void cannot move chess's answer.
      it("X-SW-15 after a void: a game taken back is not play — a disqualification then is a forfeit before play, so the pair may meet again (badminton)", async () => {
        const r = await pairedRoundOne(sport, 4);
        const { top, bottom } = await toRoundTwo(r);
        for (const [b, by] of [[top, "S1"], [bottom, "S2"]] as const) {
          await emit(r.auth, b.id, "core.start", {});
          const game = await emit(r.auth, b.id, "badminton.game.summary", { home: 21, away: 19 });
          await emit(r.auth, b.id, "core.void", { event_id: game.event_id });
          const res = await emit(r.auth, b.id, "core.forfeit", { by: r.idOf(by), reason: "disqualified" });
          expect(res.outcome, "rig: a recorded disqualification").toMatchObject({ kind: "award", reason: "disqualified" });
        }

        const { history } = await pairSpied(r);
        expect(history.played.has(pairKey(r.idOf("S1"), r.idOf("S4"))), "nothing played: not a meeting").toBe(false);
        expect(await pairsOf(r, 3), "round 3 re-seats both pairs").toEqual(REMATCH);
      }, 180_000);

      it("X-SW-15 the positive pair: a disqualification after a game that STANDS is a meeting (badminton)", async () => {
        const r = await pairedRoundOne(sport, 4);
        const { top, bottom } = await toRoundTwo(r);
        for (const [b, by] of [[top, "S1"], [bottom, "S2"]] as const) {
          await emit(r.auth, b.id, "core.start", {});
          await emit(r.auth, b.id, "badminton.game.summary", { home: 21, away: 19 });
          const res = await emit(r.auth, b.id, "core.forfeit", { by: r.idOf(by), reason: "disqualified" });
          expect(res.outcome, "rig: a recorded disqualification").toMatchObject({ kind: "award", reason: "disqualified" });
        }

        const { history } = await pairSpied(r);
        expect(history.played.has(pairKey(r.idOf("S1"), r.idOf("S4"))), "played: a meeting").toBe(true);
        expect(await pairsOf(r, 3)).toEqual(NO_REMATCH);
      }, 180_000);
    }

    if (sport.key === "boardgame") {
      it("X-SW-15 a chess walkover after the Start (a no-show, FIDE 6.7.1) is still a walkover: the pair may meet again (boardgame)", async () => {
        // Ruling 118 makes chess's Start play, so the ledger's played fact reads TRUE here; the walkover reason still
        // makes it unplayed (P-A2 lists "a one-sided walkover" unqualified; boardgame.ts: "a no-show is still a
        // walkover"). The one case where reading the fact alone would answer "met".
        const r = await pairedRoundOne(sport, 4);
        const { top, bottom } = await toRoundTwo(r);
        for (const [b, noShow] of [[top, "S1"], [bottom, "S2"]] as const) {
          await emit(r.auth, b.id, "core.start", {});
          const res = await emit(r.auth, b.id, "core.forfeit", { by: r.idOf(noShow), reason: "walkover" });
          expect(res.outcome, "rig: a walkover recorded after the Start").toMatchObject({ kind: "award", reason: "walkover" });
        }
        const { history } = await pairSpied(r);
        expect(history.played.has(pairKey(r.idOf("S1"), r.idOf("S4"))), "a no-show is not a meeting").toBe(false);
        expect(await pairsOf(r, 3)).toEqual(REMATCH);
      }, 180_000);
    }

    it(`X-SW-15 a walkover winner is still never given the bye (${sport.key})`, async () => {
      // Five players. Round 1 (fold): S1 v S3, S2 v S4, S5 bye; S2 does not turn up, so S4 wins by walkover. By round 3
      // S5 and S3 have had byes, and S4 is the bottom-most of the rest — so the engine's own bye rule ("the lowest-ranked
      // entrant not yet byed") would give it S4, but for the walkover.
      const r = await pairedRoundOne(sport, 5);
      expect(await pairsOf(r, 1), "rig: round 1 is the fold").toEqual(["S1-S3", "S2-S4"]);
      const walkover = await boardWith(r, 1, "S2", "S4");
      await emit(r.auth, walkover.id, "core.forfeit", { by: r.idOf("S2"), reason: "walkover" });
      await sport.win(r.auth, await boardWith(r, 1, "S1", "S3"), r.idOf("S1"));
      await generateStageFixtures(r.auth, r.stageId); // Pair round 2
      // Round 2's boards go to the better seed, so the order below is decided by the results, not by the code.
      for (const b of await boardsOf(r.stageId, 2)) {
        if (b.home_entrant_id === null || b.away_entrant_id === null) continue;
        const better = Number(r.nameOf(b.home_entrant_id).slice(1)) < Number(r.nameOf(b.away_entrant_id).slice(1)) ? b.home_entrant_id : b.away_entrant_id;
        await sport.win(r.auth, b, better);
      }

      const { standings, history } = await pairSpied(r); // Pair round 3
      const byeRows = (await sql<Board[]>`
        select id, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome from fixtures
        where stage_id = ${r.stageId} and round_no < 3`).filter((f) => isOneSidedAwardBye(f));
      const realByes = new Set(byeRows.map((f) => f.home_entrant_id));
      expect(realByes.size, "rig: rounds 1 and 2 each gave a bye").toBe(2);
      // The engine's pairing order (score, then rank), bottom up: the first entrant without a REAL bye.
      const order = [...standings].sort((a, b) => b.score - a.score || a.rank - b.rank);
      const naive = [...order].reverse().find((s) => !realByes.has(s.entrantId));
      expect(r.nameOf(naive?.entrantId), "witness: without P-A4 the bye would go to the walkover winner").toBe("S4");

      expect(history.played.has(pairKey(r.idOf("S2"), r.idOf("S4"))), "the walkover is not a meeting (P-A2)").toBe(false);
      expect(history.byes?.has(r.idOf("S4")), "and its winner is bye-ineligible (P-A4)").toBe(true);
      const bye = (await boardsOf(r.stageId, 3)).find((f) => f.away_entrant_id === null && f.home_entrant_id !== null);
      expect(bye, "round 3 has a bye").toBeDefined();
      expect(r.nameOf(bye!.home_entrant_id), "the walkover winner is not the bye").not.toBe("S4");
    }, 180_000);
  });
}
