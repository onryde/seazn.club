// Swiss float history reaches the pairer, on Postgres, through the REAL Generate / Pair next (`generateStageFixtures` →
// `swissGen` → the engine's `pairRound`).
//
// The defect on the tree before this fix: `swissGen` handed `pairRound` a `SwissHistory` of `played`, `colours` and `byes`
// only. The engine reads `history.floats?.get(id) ?? 0` (scheduling/swiss.ts, `floatCountOf`), so every player always read
// as never having floated, and the pairer could float the same player down round after round - FIDE C.04.3 (1 Feb 2026)
// C14 "Minimise the number of resident downfloaters who received a downfloat the previous round" never applied.
//
// The engine's contract for the field (seazn.club.engine src/scheduling/swiss.ts:61, `floats?: ReadonlyMap<EntrantId,
// number>; // downfloat count`; :121, `floated: EntrantId[]; // entrants that downfloated this round (merge into
// history.floats)`; its own producer, src/testkit/simulation.ts:658, adds 1 per `floated` id per round): a COUNT of the
// rounds in which the entrant floated DOWN, over every earlier round of the stage. A round's downfloater is the stronger side
// of a board whose two sides came into that round on different scores (swiss.ts `seat`: "a is the stronger side ⇒ it
// floated down"); its opponent upfloated, which the engine has no field for. A bye is never in `floated`, and a walkover
// board was paired like any other, so its stronger side floated when it was paired.
//
// Every expected value here is derived by hand from those rules and the FIDE criterion, over scores taken from the sport's
// DECLARED points rule applied to the recorded results (`earned`) - never from `swissGen`, `stageTablePoints` or a run of
// the engine. The history the engine was handed is read through a spy on `pairRound` (precedent: swiss-score-groups.test.ts).
//
// Sports: badminton (a set sport, win 2), chess (boardgame: half-points, draws, colours on) and ice hockey (IIHF, win 3).
//
// A points adjustment is in a round's score only when it was written before that round was paired: its ledger row's
// `division_events.seq` below the round's newest pairing row's (both rows of one per-division counter, taken under the division
// lock). An adjustment written later moved the table AFTER those boards were seated, so it cannot have made them unequal.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { swissDrawFactsOf, type PointsRule } from "@seazn/engine/competition";
import { pairKey, type SwissHistory, type SwissStanding } from "@seazn/engine/scheduling";
import type { AuthCtx } from "@/server/api-v1/auth";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { adjustPoints } from "../points-adjustments";
import { startDivision } from "../schedule";
import { putStageRules } from "../stage-rules";
import { createStages, generateStageFixtures, swissFloatHistory, swissFloatRounds, unpairSwissRound } from "../stages";
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

// ─── The derivation, pure ───────────────────────────────────────────────────────────────────────────────────────────

describe("swissFloatHistory: the engine's downfloat count, off the stage's earlier boards", () => {
  type Row = { round_no: number; home_entrant_id: string | null; away_entrant_id: string | null };
  const board = (round_no: number, home: string, away: string | null): Row => ({ round_no, home_entrant_id: home, away_entrant_id: away });
  const cut = (rounds: Record<number, Record<string, number>>) =>
    new Map(Object.entries(rounds).map(([r, pts]) => [Number(r), new Map(Object.entries(pts))]));

  it("the empty case first: no earlier board, no float - and no table read asked for", () => {
    expect([...swissFloatHistory([], 1, new Map())], "no rows").toEqual([]);
    // Round 3's own seats and later rows are not history (a re-Pair of round 3 reads rounds 1 and 2 only).
    const later = [board(3, "a", "b"), board(4, "c", "d")];
    expect(swissFloatRounds(later, 3), "no round before the target").toEqual([]);
    expect([...swissFloatHistory(later, 3, new Map())], "nothing counted").toEqual([]);
  });

  it("the side that came into the round on MORE points floated down once - home or away", () => {
    const rows = [board(1, "a", "b"), board(1, "c", "d")];
    const got = swissFloatHistory(rows, 2, cut({ 1: { a: 2, b: 0, c: 0, d: 2 } }));
    expect([...got].sort(), "a (home) and d (away), the stronger sides").toEqual([["a", 1], ["d", 1]]);
  });

  it("a board between level scores floats nobody, and a bye (one seat) is never a board", () => {
    const rows = [board(1, "a", "b"), board(1, "c", null)];
    expect(swissFloatRounds(rows, 2), "the bye's round is read only for its board").toEqual([1]);
    expect([...swissFloatHistory(rows, 2, cut({ 1: { a: 2, b: 2, c: 0 } }))], "nobody").toEqual([]);
    // A round holding only a bye needs no table read at all.
    expect(swissFloatRounds([board(1, "c", null)], 2), "a bye-only round is not read").toEqual([]);
  });

  it("counts every earlier round (the engine merges each round's `floated` into the history)", () => {
    const rows = [board(1, "a", "b"), board(2, "a", "c"), board(3, "a", "d")];
    expect(swissFloatRounds(rows, 4), "rounds 1-3, each once").toEqual([1, 2, 3]);
    const got = swissFloatHistory(rows, 4, cut({ 1: { a: 2, b: 0 }, 2: { a: 4, c: 2 }, 3: { a: 4, d: 4 } }));
    expect([...got], "a floated down in rounds 1 and 2, not in round 3 (level)").toEqual([["a", 2]]);
  });

  it("an entrant the cut does not list came in on 0 (a latecomer's first round)", () => {
    expect([...swissFloatHistory([board(2, "late", "b")], 3, cut({ 2: { b: 2 } }))], "b floated down to the newcomer").toEqual([["b", 1]]);
  });

  it("refuses by name when a board's round has no points read (never guessed as level)", () => {
    expect(() => swissFloatHistory([board(1, "a", "b"), board(2, "a", "c")], 3, cut({ 1: { a: 0, b: 0 } }))).toThrow(
      /no table points before round 2/,
    );
  });
});

// ─── The rig ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Board {
  id: string;
  round_no: number;
  seq_in_round: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string } | null;
}

interface Sport {
  key: "badminton" | "boardgame" | "icehockey";
  variant: string;
  config: Record<string, unknown>;
  /** The scorer's ordinary result: `winner` wins the board outright. */
  win(auth: AuthCtx, board: Board, winner: string): Promise<void>;
}

const SPORTS: Sport[] = [
  {
    key: "badminton",
    variant: "bwf",
    config: {},
    async win(auth, b, winner) {
      await post(auth, b.id, "core.start");
      for (let i = 0; i < 2; i++) {
        await post(auth, b.id, "badminton.game.summary", winner === b.home_entrant_id ? { home: 21, away: 10 } : { home: 10, away: 21 });
      }
    },
  },
  {
    key: "boardgame",
    variant: "classical",
    config: { chess: true },
    async win(auth, b, winner) {
      await post(auth, b.id, "core.start");
      await post(auth, b.id, "boardgame.result", { winner, method: "resign" });
    },
  },
  {
    key: "icehockey",
    variant: "iihf",
    config: {},
    async win(auth, b, winner) {
      await post(auth, b.id, "core.start");
      await post(auth, b.id, "icehockey.goal", { by: winner });
      for (const to of ["P2", "P3", "FT"]) await post(auth, b.id, "icehockey.period.advance", { to });
    },
  },
];
const sportOf = (key: Sport["key"]): Sport => SPORTS.find((s) => s.key === key)!;

async function drawChess(auth: AuthCtx, b: Board): Promise<void> {
  await post(auth, b.id, "core.start");
  await post(auth, b.id, "boardgame.result", { winner: null, method: "agreement" });
}

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

/** The sport's DECLARED Swiss points rule under its variant. */
function declaredRule(sport: Sport): PointsRule {
  const m = moduleOf(sport.key);
  return m.tablePointsRule(m.configSchema.parse(m.variants[sport.variant]), "swiss");
}

/** What a bye pays under `rule` (X-SW-5): a set sport's clean sweep, else the win - or the forfeit row where one is set. */
function byePoints(sport: Sport, rule: PointsRule): number {
  const m = moduleOf(sport.key);
  const facts = swissDrawFactsOf(m, m.configSchema.parse(m.variants[sport.variant]));
  if (rule.forfeit !== undefined) return rule.forfeit.winnerPoints;
  if (rule.bySetScore === undefined) return rule.win.regulation;
  const pair = rule.bySetScore[`${facts.setsToWin}-0`] ?? rule.bySetScore["*"];
  if (pair === undefined) throw new Error("premise: a set-score rule names its clean sweep or a catch-all");
  return pair[0];
}

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  stageId: string;
  /** "P1".."Pn" -> entrant id. */
  id: (name: string) => string;
  nameOf: (id: string | null | undefined) => string;
}

/** Players P1..Pn seeded 1..n, one Swiss stage of `rounds` rounds (extra stage config and table rules when given), started. */
async function startedSwiss(
  sport: Sport,
  opts: { players: number; rounds: number; config?: Record<string, unknown>; tiebreakers?: string[] },
): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss floats " + randomUUID().slice(0, 6),
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
  const kind = moduleOf(sport.key).entrantModel?.defaultKind ?? "individual";
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.players }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: opts.rounds, ...sport.config, ...(opts.config ?? {}) },
    progression: null,
  });
  if (opts.tiebreakers !== undefined) await putStageRules(auth, stage!.id, { tiebreakers: opts.tiebreakers } as never);
  await startDivision(auth, division.id);
  const idOf = new Map(entrants.map((e) => [e.display_name, e.id]));
  return {
    sport,
    auth,
    stageId: stage!.id,
    id: (name) => {
      const v = idOf.get(name);
      if (v === undefined) throw new Error(`rig: no entrant ${name}`);
      return v;
    },
    nameOf: (v) => {
      if (!v) return "-";
      for (const [name, x] of idOf) if (x === v) return name;
      return v;
    },
  };
}

const allRows = (stageId: string) =>
  sql<Board[]>`
    select id, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome from fixtures
    where stage_id = ${stageId} order by round_no, seq_in_round`;

const twoSeated = (b: Board): boolean => b.home_entrant_id !== null && b.away_entrant_id !== null;

/** A round's boards as unordered name pairs, sorted ("P1-P4"), and its bye holder's name, if any. */
async function seatsOf(r: Rig, round: number): Promise<{ boards: string[]; bye: string | null }> {
  const rows = (await allRows(r.stageId)).filter((f) => f.round_no === round);
  const boards = rows
    .filter(twoSeated)
    .map((f) => [r.nameOf(f.home_entrant_id), r.nameOf(f.away_entrant_id)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join("-"))
    .sort();
  const bye = rows.find((f) => f.home_entrant_id !== null && f.away_entrant_id === null);
  return { boards, bye: bye ? r.nameOf(bye.home_entrant_id) : null };
}

/** The board of `round` that seats both `a` and `b`. */
async function boardOf(r: Rig, round: number, a: string, b: string): Promise<Board> {
  const want = [r.id(a), r.id(b)].sort().join("|");
  const board = (await allRows(r.stageId)).find(
    (f) => f.round_no === round && twoSeated(f) && [f.home_entrant_id!, f.away_entrant_id!].sort().join("|") === want,
  );
  if (board === undefined) throw new Error(`rig: no ${a}-${b} board in round ${round}`);
  return board;
}

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

/** The points each entrant has EARNED in rounds 1..`through`, off the recorded rows under the sport's DECLARED rule - a
 *  decided win or an award pays the winner the rule's win (a bye its clean-sweep win), a draw pays each side the draw. */
async function earned(r: Rig, through: number): Promise<Map<string, number>> {
  const rule = declaredRule(r.sport);
  const out = new Map<string, number>();
  const add = (v: string, n: number) => out.set(v, (out.get(v) ?? 0) + n);
  for (const f of (await allRows(r.stageId)).filter((row) => row.round_no <= through)) {
    if (f.status !== "decided" && f.status !== "forfeited") continue;
    const o = f.outcome;
    if ((o?.kind === "win" || o?.kind === "award") && o.winner) add(o.winner, f.away_entrant_id === null ? byePoints(r.sport, rule) : rule.win.regulation);
    else if (o?.kind === "draw" && twoSeated(f)) {
      if (rule.draw == null) throw new Error("rig: this rule pays no draw");
      add(f.home_entrant_id!, rule.draw);
      add(f.away_entrant_id!, rule.draw);
    }
  }
  return out;
}

/** The ORACLE for the history the engine is owed before round `target`, by the engine's definition (header): for every
 *  two-seated board of an earlier round, the side that came into that round on MORE points (`earned` through the round
 *  before) floated down once. A bye row has one seat and is never a board. Returns the counts and how many boards it read. */
async function oracleFloats(r: Rig, target: number): Promise<{ floats: Map<string, number>; boards: number }> {
  const floats = new Map<string, number>();
  let boards = 0;
  for (let round = 1; round < target; round++) {
    const before = await earned(r, round - 1);
    for (const f of (await allRows(r.stageId)).filter((row) => row.round_no === round && twoSeated(row))) {
      boards++;
      const [h, a] = [before.get(f.home_entrant_id!) ?? 0, before.get(f.away_entrant_id!) ?? 0];
      if (h === a) continue;
      const down = h > a ? f.home_entrant_id! : f.away_entrant_id!;
      floats.set(down, (floats.get(down) ?? 0) + 1);
    }
  }
  return { floats, boards };
}

/** A history's floats as sorted [name, count] rows, for a readable diff. */
const named = (r: Rig, floats: ReadonlyMap<string, number> | undefined): [string, number][] =>
  [...(floats ?? new Map<string, number>())].map(([k, v]): [string, number] => [r.nameOf(k), v]).sort((x, y) => x[0].localeCompare(y[0]));

/** Who floated DOWN in `round` by the oracle's definition: the stronger side of each board between unequal scores. */
async function downfloatersOf(r: Rig, round: number): Promise<string[]> {
  const before = await earned(r, round - 1);
  const out: string[] = [];
  for (const f of (await allRows(r.stageId)).filter((row) => row.round_no === round && twoSeated(row))) {
    const [h, a] = [before.get(f.home_entrant_id!) ?? 0, before.get(f.away_entrant_id!) ?? 0];
    if (h !== a) out.push(r.nameOf(h > a ? f.home_entrant_id : f.away_entrant_id));
  }
  return out.sort();
}

// The base rig - six seeded players, three rounds, no draws. Every pairing below is hand-derived from the engine's declared
// rules (scheduling/swiss.ts header: order by score then seed; a score group pairs by fold; an odd group floats ONE down, the
// least-floated first and the lowest-ranked among them, P-Q1; a floater meets the top of the group below that it has not met)
// and from FIDE C.04.3 C14.
//   Round 1 (everyone on 0, fold): P1-P4, P2-P5, P3-P6. Results: P1, P2 and P6 win.
//   Round 2: the winners' group {P1, P2, P6} is odd and nobody has floated, so its lowest-ranked, P6, floats down; P6 has met
//            P3, so it meets P4; P1-P2; P3-P5. Results: P1 beats P2, P4 beats P6, P3 beats P5.
//   Round 3: P1 alone on two wins floats into the one-win group {P2, P3, P4, P6}, which then holds five, so one of its four
//            residents must float down to P5. P6 floated down in round 2: C14 says not P6 when another resident can go, and
//            the engine's rule takes the lowest-ranked of the rest - P4. P4 meets P5; P1 has met P2, so P1 meets P3; P2 meets
//            P6. Round 3 is P1-P3, P2-P6, P4-P5.
//            Without the history every resident reads as never floated and P6, the group's lowest-ranked, floats down a
//            second round running: P1-P3, P2-P4, P5-P6. That is the defect.
const ROUND_ONE = ["P1-P4", "P2-P5", "P3-P6"];
const ROUND_TWO = ["P1-P2", "P3-P5", "P4-P6"];
const ROUND_THREE = ["P1-P3", "P2-P6", "P4-P5"];
const ROUND_THREE_WITHOUT_HISTORY = ["P1-P3", "P2-P4", "P5-P6"];

/** Rounds 1 and 2 of the base rig, with the results above, asserting each round's seats on the way. `walkover` decides the
 *  round-2 P4-P6 board as a walkover (P6 does not show) instead of a played win. Returns round 2's spied history. */
async function playBaseRoundsOneAndTwo(r: Rig, opts: { walkover?: boolean } = {}): Promise<SwissHistory> {
  await generateStageFixtures(r.auth, r.stageId); // Pair round 1
  expect((await seatsOf(r, 1)).boards, "premise: round 1 folds the seeds").toEqual(ROUND_ONE);
  await r.sport.win(r.auth, await boardOf(r, 1, "P1", "P4"), r.id("P1"));
  await r.sport.win(r.auth, await boardOf(r, 1, "P2", "P5"), r.id("P2"));
  await r.sport.win(r.auth, await boardOf(r, 1, "P3", "P6"), r.id("P6"));

  const two = await pairSpied(r); // Pair round 2
  expect((await seatsOf(r, 2)).boards, "round 2: P6, the odd winners' group's lowest-ranked, floats down to P4").toEqual(ROUND_TWO);
  await r.sport.win(r.auth, await boardOf(r, 2, "P1", "P2"), r.id("P1"));
  const p4p6 = await boardOf(r, 2, "P4", "P6");
  if (opts.walkover) await post(r.auth, p4p6.id, "core.forfeit", { by: r.id("P6"), reason: "walkover" });
  else await r.sport.win(r.auth, p4p6, r.id("P4"));
  await r.sport.win(r.auth, await boardOf(r, 2, "P3", "P5"), r.id("P3"));
  return two.history;
}

// ─── Float history ──────────────────────────────────────────────────────────────────────────────────────────────────

describe.runIf(HAS_DB)("Swiss float history reaches the pairer (engine SwissHistory.floats; FIDE C.04.3 C14)", () => {
  for (const sport of SPORTS) {
    it(`round 2 is the empty case and round 3 floats a fresh player, not round 2's downfloater (${sport.key})`, async () => {
      // A sweep of the three sports the Swiss rigs score for real: the floats are read off the stage's own table points, so
      // what moves between sports is the points unit (a set-score map, half-points, IIHF's 3) - the shape stays the same.
      const r = await startedSwiss(sport, { players: 6, rounds: 3 });

      // The empty case first: round 1 was paired with everyone on 0, so no board of it was between different scores.
      const two = await playBaseRoundsOneAndTwo(r);
      const twoOracle = await oracleFloats(r, 2);
      expect(twoOracle.boards, "anti-vacuity: the oracle read round 1's three boards").toBe(3);
      expect(twoOracle.floats.size, "premise: round 1 floated nobody (all level)").toBe(0);
      expect.soft(two.floats, "round 2 is handed a float history, not none").toBeInstanceOf(Map);
      expect.soft(named(r, two.floats), "and it is empty").toEqual([]);

      const three = await pairSpied(r); // Pair round 3
      const oracle = await oracleFloats(r, 3);
      expect(oracle.boards, "anti-vacuity: the oracle read rounds 1 and 2, three boards each").toBe(6);
      expect(named(r, oracle.floats), "premise: P6 floated down in round 2, and only P6").toEqual([["P6", 1]]);
      expect.soft(named(r, three.history.floats), "round 3 is handed the float history the definition gives").toEqual(named(r, oracle.floats));

      const seats = await seatsOf(r, 3);
      expect(seats.boards, "round 3 floats P4, not P6 a second round running (C14)").toEqual(ROUND_THREE);
      expect(seats.boards, "differential: what the pairer seated without the history").not.toEqual(ROUND_THREE_WITHOUT_HISTORY);
      const down = await downfloatersOf(r, 3);
      expect(down.length, "anti-vacuity: round 3 has its two downfloats (P1 into the group, one resident out)").toBe(2);
      expect(down, "nobody who floated down in round 2 floats down again").not.toContain("P6");
    }, 180_000);
  }

  it("a second Pair of round 3 (Unpair, then Pair) is handed the same history and seats the same boards", async () => {
    // single-sport: Unpair/Pair is sport-blind; the sweep above already moves the points unit.
    const r = await startedSwiss(sportOf("badminton"), { players: 6, rounds: 3 });
    await playBaseRoundsOneAndTwo(r);
    const first = await pairSpied(r);
    expect((await seatsOf(r, 3)).boards, "rig: round 3 as derived").toEqual(ROUND_THREE);
    expect((await unpairSwissRound(r.auth, r.stageId)).round, "rig: Unpair cleared round 3").toBe(3);
    expect((await seatsOf(r, 3)).boards, "rig: round 3 holds no board after the Unpair").toEqual([]);
    const second = await pairSpied(r);
    expect(named(r, second.history.floats), "the same float history on the second Pair").toEqual(named(r, first.history.floats));
    expect(named(r, second.history.floats).length, "anti-vacuity: and it is not empty").toBe(1);
    expect((await seatsOf(r, 3)).boards, "and the same round 3").toEqual(ROUND_THREE);
  }, 180_000);

  it("a walkover board's float counts: it was paired between different scores (engine contract), though not played", async () => {
    // single-sport: what a walkover pays is the sport's forfeit rule; badminton's declares none, so the walkover pays the
    // win and every score - and so every score group - is the played rig's. The board under test is round 2's P4-P6, the
    // one that carries round 2's float: P6 (on one win) was paired down to P4 (on none), then did not show.
    const r = await startedSwiss(sportOf("badminton"), { players: 6, rounds: 3 });
    expect(declaredRule(r.sport).forfeit, "premise: no forfeit row, so the walkover pays the win").toBeUndefined();
    await playBaseRoundsOneAndTwo(r, { walkover: true });
    const p4p6 = await boardOf(r, 2, "P4", "P6");
    expect(p4p6.outcome, "rig: the board is a walkover to P4").toMatchObject({ kind: "award", winner: r.id("P4") });

    const three = await pairSpied(r);
    expect(three.history.played.has(pairKey(r.id("P4"), r.id("P6"))), "premise: an unplayed pair has not met (X-SW-15)").toBe(false);
    const oracle = await oracleFloats(r, 3);
    expect(oracle.boards, "anti-vacuity: six boards read").toBe(6);
    expect(named(r, three.history.floats), "P6 floated when the board was paired, whatever came of it").toEqual([["P6", 1]]);
    expect(named(r, three.history.floats), "the oracle agrees").toEqual(named(r, oracle.floats));
    // P4-P6 may meet again now, but the hand derivation above never pairs them in round 3, so round 3 is the played rig's.
    expect((await seatsOf(r, 3)).boards, "round 3 floats P4, not P6").toEqual(ROUND_THREE);
  }, 180_000);

  it("rank_adjacent (the Swiss stage of Swiss Playoff and Swiss Knockout) reads the float history too", async () => {
    // single-sport: rank_adjacent changes only the partner order inside a score group (engine `orderCandidates`); who floats
    // out of an odd group is the same score-group pass, so badminton's rig is enough. The stage's order is `points` alone,
    // so a tie on points falls to the seed (engine tiebreakers, "seed then id") and the rank order is the seed order the
    // derivation above uses - never a lots draw.
    const r = await startedSwiss(sportOf("badminton"), {
      players: 6,
      rounds: 3,
      config: { pairing: "rank_adjacent" }, // the Swiss stage format-templates.ts builds for swiss_playoff / swiss_knockout
      tiebreakers: ["points"],
    });
    // Round 2 and 3 by rank_adjacent: the winners' group P1, P2 pairs neighbours P1-P2 either way, and every other board is
    // forced (a floater, or the last two), so the derived seats are the fold rig's.
    await playBaseRoundsOneAndTwo(r);
    const three = await pairSpied(r);
    const group = three.standings.filter((s) => s.score === three.standings.find((x) => x.entrantId === r.id("P2"))!.score);
    expect(group.map((s) => r.nameOf(s.entrantId)).sort(), "premise: the one-win group").toEqual(["P2", "P3", "P4", "P6"]);
    expect(
      [...group].sort((a, b) => a.rank - b.rank).map((s) => r.nameOf(s.entrantId)),
      "premise: the group's rank order is the seed order (a points-only table falls to the seed)",
    ).toEqual(["P2", "P3", "P4", "P6"]);
    expect(named(r, three.history.floats), "the float history reaches a rank_adjacent Pair").toEqual([["P6", 1]]);
    expect((await seatsOf(r, 3)).boards, "round 3 floats P4, not P6").toEqual(ROUND_THREE);
  }, 180_000);

  it("a points adjustment written after round 2 was paired is in neither earlier round's score", async () => {
    // single-sport: the cut is by ledger order, sport-blind; badminton's base rig is enough.
    // Hand derivation: the base rig (above) through round 2, then P3 is adjusted -1 BEFORE round 3 is paired. Rounds 1 and 2
    // were paired before the adjustment was written, so neither round's boards could have been unequal because of it: round
    // 1 was all level, and round 2 floated only P6 (on one win against P4's none). The history is P6 once.
    // Counting the adjustment in every earlier round's score instead puts P3 below 0 going into round 1 (P6 "floats" on
    // P3-P6) and below P5 going into round 2 (P5 "floats" on P3-P5): P5 once, P6 twice.
    const r = await startedSwiss(sportOf("badminton"), { players: 6, rounds: 3 });
    await playBaseRoundsOneAndTwo(r);
    await adjustPoints(r.auth, r.stageId, { entrant_id: r.id("P3"), delta: -1, reason: "Late to court" });

    const three = await pairSpied(r);
    const p3 = three.standings.find((s) => s.entrantId === r.id("P3"))?.score;
    const p3Earned = (await earned(r, 2)).get(r.id("P3")) ?? 0;
    expect(p3, "positive pair: the adjustment IS on the table round 3 is paired on").toBeLessThan(p3Earned);
    expect(named(r, three.history.floats), "P6 once: the adjustment came after both earlier rounds were paired").toEqual([["P6", 1]]);
    expect(named(r, three.history.floats), "differential: not every adjustment in every earlier score").not.toEqual([["P5", 1], ["P6", 2]]);
  }, 180_000);

  it("a points adjustment written before round 2 was paired is in round 2's score, never round 1's", async () => {
    // single-sport: as above.
    // Hand derivation: round 1 of the base rig (P1, P2 and P6 win), then P1 is adjusted +1 BEFORE round 2 is paired.
    //   Round 2 (P1 one win and 1; P2, P6 one win; P3, P4, P5 none): P1 alone floats down to the top of the group below it
    //            has not met, P2; {P6} is left odd and floats down to P4 (it has met P3); P3-P5 - the base rig's round 2. Its
    //            history is empty: the adjustment was written AFTER round 1 was paired, so round 1 stays all level.
    //   Results: P1 beats P2, P4 beats P6, P3 beats P5. Round 2's boards were paired with the adjustment already written,
    //            so P1-P2 was unequal (P1 floated down) and P4-P6 was too (P6 floated). The history is P1 once, P6 once.
    // Counting the adjustment in round 1 too adds a float for P1 on P1-P4 (P1 twice); counting it nowhere loses P1's.
    const r = await startedSwiss(sportOf("badminton"), { players: 6, rounds: 3 });
    await generateStageFixtures(r.auth, r.stageId); // Pair round 1
    expect((await seatsOf(r, 1)).boards, "premise: round 1 folds the seeds").toEqual(ROUND_ONE);
    await r.sport.win(r.auth, await boardOf(r, 1, "P1", "P4"), r.id("P1"));
    await r.sport.win(r.auth, await boardOf(r, 1, "P2", "P5"), r.id("P2"));
    await r.sport.win(r.auth, await boardOf(r, 1, "P3", "P6"), r.id("P6"));
    await adjustPoints(r.auth, r.stageId, { entrant_id: r.id("P1"), delta: 1, reason: "Fair play" });

    const two = await pairSpied(r); // Pair round 2
    expect((await seatsOf(r, 2)).boards, "round 2 as derived").toEqual(ROUND_TWO);
    expect(named(r, two.history.floats), "round 1 stays level: the adjustment came after it was paired").toEqual([]);
    await r.sport.win(r.auth, await boardOf(r, 2, "P1", "P2"), r.id("P1"));
    await r.sport.win(r.auth, await boardOf(r, 2, "P4", "P6"), r.id("P4"));
    await r.sport.win(r.auth, await boardOf(r, 2, "P3", "P5"), r.id("P3"));

    const three = await pairSpied(r); // Pair round 3
    expect(named(r, three.history.floats), "P1 floated in round 2 on the adjustment, and P6").toEqual([["P1", 1], ["P6", 1]]);
  }, 180_000);

  it("a round whose pairing row names no round (a stage paired before rows carried one) reads every adjustment in force", async () => {
    // single-sport: as above. The legacy reading is the table as it stands now, the reading before rounds were cut by the ledger.
    // Hand derivation: the first adjustment test's rig, with round 2's pairing row stripped of its `round`. Round 1's row
    // still bounds round 1 (no adjustment in it, all level); round 2 has no bound, so P3's -1 is in round 2's score and P3-P5
    // reads P5 floating down; P4-P6 floats P6. The history is P5 once, P6 once.
    const r = await startedSwiss(sportOf("badminton"), { players: 6, rounds: 3 });
    await playBaseRoundsOneAndTwo(r);
    await adjustPoints(r.auth, r.stageId, { entrant_id: r.id("P3"), delta: -1, reason: "Late to court" });
    const stripped = await sql`
      update division_events set payload = payload - 'round'
       where payload->>'stage_id' = ${r.stageId} and type = 'fixtures_generated' and payload->>'round' = '2'
      returning seq`;
    expect(stripped.length, "rig: round 2's one pairing row now names no round").toBe(1);

    const three = await pairSpied(r);
    expect(named(r, three.history.floats), "round 2 reads the adjustment; round 1, still bounded, does not").toEqual([["P5", 1], ["P6", 1]]);
  }, 180_000);

  it("after a withdrawal the departed player's boards still count on the points he held, and a bye is not a float (chess)", async () => {
    // single-sport: chess - draws make the odd score groups this sequence needs on six players, and its colours must not
    // stand in the way (the seats below hold under either round-1 colour lot).
    // Hand derivation (chess pays 2 / 1 / 0):
    //   Round 1 P1-P4, P2-P5, P3-P6: P1-P4 drawn, P2 wins, P3-P6 drawn.
    //   Round 2 (P2 2; P1, P3, P4, P6 1; P5 0): P2 alone floats down to the top of the 1-point group it has not met, P1;
    //            {P3, P4, P6} is odd and nobody has floated, so its lowest-ranked, P6, floats down to P5; P3-P4. Downfloats:
    //            P2 and P6. P3-P4 is LEVEL only on the point P4 drew in round 1. Results: P1 beats P2, P3 beats P4, P6 beats P5.
    //   P4 withdraws, holding that 1 point.
    //   Round 3 (P1, P3, P6 3; P2 2; P5 0): five players, so the lowest, P5, takes the bye. {P1, P3, P6} is odd and P6
    //            floated down in round 2: C14 floats the lowest-ranked of the rest, P3, down to P2; P1-P6.
    //            Without the history P6 floats again: P1-P3, P2-P6. And a table that dropped the departed P4 to 0 would read
    //            P3-P4 as P3 floating down, so P3 and P6 would both have floated, P1 (who has met P2) could not go, and P6
    //            would float again - the same P1-P3, P2-P6.
    //   Results: P1 beats P6, P3 beats P2. Before round 4 the history is P2, P6 (round 2) and P3 (round 3: 3 against P2's 2);
    //   P1-P6 was level. P5's round-3 bye is not a downfloat: the engine never lists a bye in `floated`.
    const r = await startedSwiss(sportOf("boardgame"), { players: 6, rounds: 4 });
    await generateStageFixtures(r.auth, r.stageId); // Pair round 1
    expect((await seatsOf(r, 1)).boards, "premise: round 1 folds the seeds").toEqual(ROUND_ONE);
    await drawChess(r.auth, await boardOf(r, 1, "P1", "P4"));
    await r.sport.win(r.auth, await boardOf(r, 1, "P2", "P5"), r.id("P2"));
    await drawChess(r.auth, await boardOf(r, 1, "P3", "P6"));

    const two = await pairSpied(r); // Pair round 2
    expect(named(r, two.history.floats), "round 2: the empty case").toEqual([]);
    expect((await seatsOf(r, 2)).boards, "round 2 as derived").toEqual(["P1-P2", "P3-P4", "P5-P6"]);
    await r.sport.win(r.auth, await boardOf(r, 2, "P1", "P2"), r.id("P1"));
    await r.sport.win(r.auth, await boardOf(r, 2, "P3", "P4"), r.id("P3"));
    await r.sport.win(r.auth, await boardOf(r, 2, "P5", "P6"), r.id("P6"));

    const held = (await earned(r, 1)).get(r.id("P4")) ?? 0;
    expect(held, "premise: P4 withdraws holding round 1's drawn point, so 'kept on the table' and 'read as 0' differ").toBe(declaredRule(r.sport).draw);
    expect(held, "and it is more than nothing").toBeGreaterThan(0);
    await withdrawEntrantCascade(r.auth, r.id("P4"));
    const three = await pairSpied(r); // Pair round 3
    expect(three.standings.map((s) => r.nameOf(s.entrantId)), "premise: P4 is out of round 3's field").not.toContain("P4");
    const oracle3 = await oracleFloats(r, 3);
    expect(oracle3.boards, "anti-vacuity: six boards read, two of them P4's").toBe(6);
    expect(named(r, oracle3.floats), "premise: P2 and P6 floated down in round 2, P3-P4 was level").toEqual([["P2", 1], ["P6", 1]]);
    expect(named(r, three.history.floats), "the departed P4 keeps his point in round 2's cut: P3-P4 floats nobody").toEqual(named(r, oracle3.floats));
    const seats3 = await seatsOf(r, 3);
    expect(seats3.bye, "premise: P5, the lowest, sits out").toBe("P5");
    expect(seats3.boards, "round 3 floats P3, not P6 a second round running").toEqual(["P1-P6", "P2-P3"]);
    expect(seats3.boards, "differential: without the history, or with P4 read as 0").not.toEqual(["P1-P3", "P2-P6"]);

    await r.sport.win(r.auth, await boardOf(r, 3, "P1", "P6"), r.id("P1"));
    await r.sport.win(r.auth, await boardOf(r, 3, "P2", "P3"), r.id("P3"));
    const four = await pairSpied(r); // Pair round 4
    const oracle4 = await oracleFloats(r, 4);
    expect(oracle4.boards, "anti-vacuity: eight boards read").toBe(8);
    expect(named(r, oracle4.floats), "premise: P2, P3 and P6 have floated down once each").toEqual([["P2", 1], ["P3", 1], ["P6", 1]]);
    expect(named(r, four.history.floats), "round 4 is handed the counts, P5's bye not among them").toEqual(named(r, oracle4.floats));
    expect(four.history.byes?.has(r.id("P5")), "positive pair: P5's bye IS in the history, as a bye").toBe(true);
    expect(four.history.floats?.has(r.id("P5")), "and is not a float").toBe(false);
  }, 240_000);
});
