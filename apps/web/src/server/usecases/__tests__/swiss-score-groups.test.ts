// W3 app-B Task 5 (SW-M11; rule X-SW-19 "Pairing score groups use the stage's table points"; RB3-9) on Postgres.
//
// The defect on the tree before this task: `swissGen` scored every entrant itself, +1 per win or bye and +½ per draw, while
// the published table pays the STAGE'S points rule (the pin once started). Two authorities for one number: an IIHF
// overtime win (2) and a regulation win (3) landed in ONE score group, a chess win (2, a draw 1 - the table's half-points)
// was grouped on 1 and ½, and a custom or pinned rule was ignored. The pairing score is now the table's own `points`
// (`stageTablePoints`, the same inputs and the same engine fold the table reads), so the groups, the table and the
// tie-breaks read one number (rulebook §5, last paragraph).
//
// Every expected value comes from the engine's DECLARATION - the sport module's `tablePointsRule` for the stage (IIHF's
// 3/2/1/0, chess's half-points 2/1), or the custom rule a test saves itself - applied to the results the rig recorded. None
// comes from `swissGen`, `loadStageInputs` or `stageTablePoints`. What the engine was handed is read through a spy on
// `pairRound` (precedent: swiss-late-field.test.ts, swiss-history-round-order.test.ts).
//
// Sports: badminton (a set sport: the points are a `bySetScore` map), chess (boardgame: half-points, draws) and ice hockey
// (IIHF 3/2/1/0: the sport whose rule pays a win by HOW it was decided). Each carries its reason where a case runs on one.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { swissDrawFactsOf, type PointsRule } from "@seazn/engine/competition";
import type { SwissHistory, SwissStanding } from "@seazn/engine/scheduling";
import type { AuthCtx } from "@/server/api-v1/auth";
import { rankedStageStandings, stageTablePoints } from "@/server/engine-db/competition";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { putStageRules } from "../stage-rules";
import {
  createStages,
  generateStageFixtures,
  swissActiveEntrants,
  swissGen,
  unpairSwissRound,
  type SwissExistingFixture,
} from "../stages";
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

// ─── The rig ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Board {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string; reason?: string } | null;
}

interface Sport {
  key: "badminton" | "boardgame" | "icehockey";
  variant: string;
  /** Extra Swiss stage config (chess colours on for the boardgame). */
  config: Record<string, unknown>;
  /** The scorer's ordinary result: `winner` wins the board outright (a 2-0, a resignation, a regulation win). */
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
      // A goal in the first period, then the three periods to full time: a REGULATION win.
      await post(auth, b.id, "core.start");
      await post(auth, b.id, "icehockey.goal", { by: winner });
      for (const to of ["P2", "P3", "FT"]) await post(auth, b.id, "icehockey.period.advance", { to });
    },
  },
];
const sportOf = (key: Sport["key"]): Sport => SPORTS.find((s) => s.key === key)!;

/** Overtime: level after three periods, then a goal in the extra period (IIHF: an OT win). */
async function winInOvertime(auth: AuthCtx, b: Board, winner: string): Promise<void> {
  await post(auth, b.id, "core.start");
  for (const to of ["P2", "P3", "FT"]) await post(auth, b.id, "icehockey.period.advance", { to });
  await post(auth, b.id, "icehockey.goal", { by: winner });
}
async function drawChess(auth: AuthCtx, b: Board): Promise<void> {
  await post(auth, b.id, "core.start");
  await post(auth, b.id, "boardgame.result", { winner: null, method: "agreement" });
}
/** A badminton 2-1: the winner takes games one and three. */
async function winBadmintonInThree(auth: AuthCtx, b: Board, winner: string): Promise<void> {
  const homeWins = winner === b.home_entrant_id;
  await post(auth, b.id, "core.start");
  for (const g of [homeWins, !homeWins, homeWins]) {
    await post(auth, b.id, "badminton.game.summary", g ? { home: 21, away: 10 } : { home: 10, away: 21 });
  }
}

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

/** The sport's DECLARED Swiss points rule under its variant: what the engine says a stage of it pays, before any save. */
function declaredRule(sport: Sport): PointsRule {
  const m = moduleOf(sport.key);
  const cfg = m.configSchema.parse(m.variants[sport.variant]);
  return m.tablePointsRule(cfg, "swiss");
}

/** What a bye pays under `rule`: the win of a clean sweep under a set-score rule (X-SW-5), else the rule's win - or its
 *  forfeit row where it sets one (the premise below says none of the three sports here does). */
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
  divisionId: string;
  stageId: string;
  /** "P1".."Pn" -> entrant id. */
  idOf: Map<string, string>;
  nameOf: (id: string | null | undefined) => string;
}

/** `players` individuals/teams P1..Pn (seeded 1..n unless `seeded: false`), one Swiss stage of `rounds` rounds, `points`
 *  saved on the stage when given, and the division started (which mints the shells). One Generate press then pairs
 *  round 1. */
async function startedSwiss(
  sport: Sport,
  opts: { players: number; rounds: number; seeded?: boolean; points?: Record<string, unknown> },
): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss groups " + randomUUID().slice(0, 6),
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
    Array.from({ length: opts.players }, (_, i) => ({
      kind,
      display_name: `P${i + 1}`,
      ...(opts.seeded === false ? {} : { seed: i + 1 }),
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: opts.rounds, ...sport.config },
    progression: null,
  });
  if (opts.points !== undefined) await putStageRules(auth, stage!.id, { points: opts.points } as never);
  await startDivision(auth, division.id);
  const idOf = new Map(entrants.map((e) => [e.display_name, e.id]));
  return {
    sport,
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    idOf,
    nameOf: (id) => {
      if (!id) return "-";
      for (const [name, v] of idOf) if (v === id) return name;
      return id;
    },
  };
}

const boardsOf = (stageId: string, round: number) =>
  sql<Board[]>`
    select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome from fixtures
    where stage_id = ${stageId} and round_no = ${round} order by seq_in_round`;

const allRows = (stageId: string) =>
  sql<Board[]>`
    select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome from fixtures
    where stage_id = ${stageId} order by round_no, seq_in_round`;

const playable = (b: Board): boolean => b.home_entrant_id !== null && b.away_entrant_id !== null && b.status === "scheduled";

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

/** Every entrant's score as the engine was handed it. */
const scoresOf = (standings: readonly SwissStanding[]): Map<string, number> => new Map(standings.map((s) => [s.entrantId, s.score]));

/** The points each entrant has EARNED through `round`, counted off the recorded results under `rule` - the declared rule
 *  applied to the rows, never read from the table: a decided win or an award pays the winner `win`, a draw pays each side
 *  `draw`, and a bye its clean-sweep win. A voided or unfinished row pays nothing. `round` is the last round that counts,
 *  so the round a Pair seats (and its bye) is not read as earned. */
async function earned(r: Rig, rule: PointsRule, win: number, draw: number | null, round: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const add = (id: string, n: number) => out.set(id, (out.get(id) ?? 0) + n);
  const bye = byePoints(r.sport, rule);
  for (const f of (await allRows(r.stageId)).filter((row) => row.round_no <= round)) {
    for (const id of [f.home_entrant_id, f.away_entrant_id]) if (id) add(id, 0);
    if (f.status !== "decided" && f.status !== "forfeited") continue;
    const o = f.outcome;
    if (o?.kind === "win" || o?.kind === "award") {
      if (!o.winner) continue;
      add(o.winner, f.away_entrant_id === null ? bye : win);
    } else if (o?.kind === "draw" && f.home_entrant_id && f.away_entrant_id) {
      if (draw === null) throw new Error("rig: this rule pays no draw");
      add(f.home_entrant_id, draw);
      add(f.away_entrant_id, draw);
    }
  }
  return out;
}

/** Decide every playable board of `round` with `how(board, index)`, home side winning unless `how` says otherwise. */
async function decideRound(r: Rig, round: number, how: (b: Board, i: number) => Promise<void>): Promise<number> {
  let decided = 0;
  for (const b of (await boardsOf(r.stageId, round)).filter(playable)) {
    await how(b, decided);
    decided++;
  }
  return decided;
}
const homeWins = (r: Rig) => async (b: Board) => r.sport.win(r.auth, b, b.home_entrant_id!);

const lotsCount = async (stageId: string): Promise<number> => {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${stageId}`;
  return n;
};

// ─── X-SW-19 ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.runIf(HAS_DB)("X-SW-19 the Swiss score groups are the stage's table points (task 5)", () => {
  // The empty case first (R13): before any result the table holds no row, so every entrant is on 0.
  for (const sport of SPORTS) {
    it(`X-SW-19 empty case first: round 1 sends every entrant score 0 (${sport.key})`, async () => {
      const r = await startedSwiss(sport, { players: 6, rounds: 3 });
      const { standings } = await pairSpied(r);
      expect(standings.length, "anti-vacuity: round 1's field of six was handed over").toBe(6);
      expect(standings.map((s) => s.score), "every entrant on 0").toEqual([0, 0, 0, 0, 0, 0]);
    }, 120_000);
  }

  it("X-SW-19 boardgame: a win is 2 and a draw 1 in the score groups (the table's half-points), not 1 / 0.5", async () => {
    // single-sport: chess is the sport whose declared rule is in half-points (unit "half"), the one whose numbers differ
    // from the old +1 / +½ by value (badminton's win 2 differs too, but only chess pays a draw).
    const r = await startedSwiss(sportOf("boardgame"), { players: 6, rounds: 3 });
    const rule = declaredRule(r.sport);
    expect([rule.win.regulation, rule.draw, rule.unit], "premise: chess declares 2 / 1 in half-points").toEqual([2, 1, "half"]);
    await generateStageFixtures(r.auth, r.stageId); // Pair round 1
    expect(
      await decideRound(r, 1, async (b, i) => (i === 1 ? drawChess(r.auth, b) : r.sport.win(r.auth, b, b.home_entrant_id!))),
      "rig: round 1 decided, board 2 drawn",
    ).toBe(3);
    const { standings } = await pairSpied(r);
    const got = scoresOf(standings);
    const want = await earned(r, rule, rule.win.regulation, rule.draw!, 1);
    expect([...got].sort(), "each entrant's score is the declared rule's, absolute").toEqual([...want].sort());
    // differential: today 1 and 0.5 (the ratio is equal, so the absolute values are the witness)
    expect([...got.values()].sort((a, b) => b - a), "two wins on 2, two draws on 1, two losses on 0").toEqual([2, 2, 1, 1, 0, 0]);
  }, 120_000);

  it("X-SW-19 ice hockey: an OT win (2) and a regulation win (3) land in different score groups", async () => {
    // single-sport: ice hockey is the sport whose declared rule pays a win by HOW it was decided (IIHF 3/2/1/0), the case
    // where the right answer differs in ORDER, not only in magnitude.
    const r = await startedSwiss(sportOf("icehockey"), { players: 6, rounds: 3 });
    const rule = declaredRule(r.sport);
    expect([rule.win.regulation, rule.win.ot, rule.loss.ot, rule.loss.regulation], "premise: IIHF pays 3 / 2 / 1 / 0").toEqual([3, 2, 1, 0]);
    await generateStageFixtures(r.auth, r.stageId); // Pair round 1
    const round1 = (await boardsOf(r.stageId, 1)).filter(playable);
    expect(round1.length, "rig: round 1 holds three boards").toBe(3);
    // Boards 1 and 2 are won in regulation, board 3 in overtime - by the home side each time.
    await r.sport.win(r.auth, round1[0]!, round1[0]!.home_entrant_id!);
    await r.sport.win(r.auth, round1[1]!, round1[1]!.home_entrant_id!);
    await winInOvertime(r.auth, round1[2]!, round1[2]!.home_entrant_id!);
    const [regA, regB, otWinner] = [round1[0]!.home_entrant_id!, round1[1]!.home_entrant_id!, round1[2]!.home_entrant_id!];
    const [otLoser, regLoserA, regLoserB] = [round1[2]!.away_entrant_id!, round1[0]!.away_entrant_id!, round1[1]!.away_entrant_id!];

    const { standings } = await pairSpied(r);
    const got = scoresOf(standings);
    // differential: today both are +1, one group
    expect(got.get(regA), "a regulation win is the rule's win.regulation").toBe(rule.win.regulation);
    expect(got.get(regB), "the other regulation win too").toBe(rule.win.regulation);
    expect(got.get(otWinner), "an overtime win is the rule's win.ot").toBe(rule.win.ot);
    expect(got.get(otLoser), "an overtime loss is the rule's loss.ot").toBe(rule.loss.ot);
    expect([got.get(regLoserA), got.get(regLoserB)], "a regulation loss is the rule's loss.regulation").toEqual([rule.loss.regulation, rule.loss.regulation]);
    expect(got.get(regA), "the OT winner is NOT in the regulation winners' score group").not.toBe(got.get(otWinner));
    // The score groups decide the seats: the two 3-point regulation winners are alone in their group and have not met,
    // so the engine's declared rule (a score group is paired within itself first) seats them against each other.
    const round2 = (await boardsOf(r.stageId, 2)).filter((b) => b.home_entrant_id !== null && b.away_entrant_id !== null);
    const pair = round2.find((b) => [b.home_entrant_id, b.away_entrant_id].includes(regA));
    expect([pair?.home_entrant_id, pair?.away_entrant_id].sort(), "the regulation winners meet each other, the OT winner outside their group").toEqual(
      [regA, regB].sort(),
    );
  }, 120_000);

  it("X-SW-19 a custom rule win 3 / draw 1 on badminton: the groups are 3 / 1 / 0, by the saved rule's set-score map", async () => {
    // single-sport: badminton is the set sport whose points are a `bySetScore` map, the shape a per-fixture formula cannot
    // read (a 2-1 win pays its loser a point). The rule is the test's own input, so every expected number is its.
    const CUSTOM: PointsRule = {
      win: { regulation: 3 },
      loss: { regulation: 0 },
      draw: 1,
      shootoutAs: "result",
      unit: "whole",
      bonuses: [],
      bySetScore: { "2-0": [3, 0], "2-1": [3, 1] },
    };
    const r = await startedSwiss(sportOf("badminton"), { players: 6, rounds: 3, points: CUSTOM });
    await generateStageFixtures(r.auth, r.stageId); // Pair round 1
    // Board 1 a 2-0, board 2 a 2-1, board 3 a 2-0 - the home side wins each.
    const round1 = (await boardsOf(r.stageId, 1)).filter(playable);
    expect(round1.length, "rig: three boards").toBe(3);
    await r.sport.win(r.auth, round1[0]!, round1[0]!.home_entrant_id!);
    await winBadmintonInThree(r.auth, round1[1]!, round1[1]!.home_entrant_id!);
    await r.sport.win(r.auth, round1[2]!, round1[2]!.home_entrant_id!);

    const { standings } = await pairSpied(r);
    const got = scoresOf(standings);
    const winners = round1.map((b) => b.home_entrant_id!);
    for (const w of winners) expect(got.get(w), `${r.nameOf(w)} won: the saved rule's 3`).toBe(3);
    expect(got.get(round1[1]!.away_entrant_id!), "the 2-1 loser is paid the map's 1").toBe(1);
    expect([got.get(round1[0]!.away_entrant_id!), got.get(round1[2]!.away_entrant_id!)], "a 2-0 loser is paid 0").toEqual([0, 0]);
    // differential: the sport's declared badminton rule pays 2 for a win; today's formula said 1
    expect([...new Set(got.values())].sort((a, b) => b - a), "three groups: 3 / 1 / 0").toEqual([3, 1, 0]);
  }, 120_000);

  for (const sport of SPORTS) {
    it(`X-SW-19 a bye scores the stage's win points, the same number the table shows (X-SW-5) (${sport.key})`, async () => {
      const r = await startedSwiss(sport, { players: 5, rounds: 3 });
      const rule = declaredRule(sport);
      expect(rule.forfeit, "premise: the sport's declared rule sets no forfeit row, so a bye pays the win").toBeUndefined();
      await generateStageFixtures(r.auth, r.stageId); // Pair round 1: two boards and a bye
      const bye = (await boardsOf(r.stageId, 1)).find((f) => f.home_entrant_id !== null && f.away_entrant_id === null);
      expect(bye, "rig: round 1 seats a bye").toBeDefined();
      expect(await decideRound(r, 1, homeWins(r)), "rig: the two boards decided").toBe(2);
      // T5 review m4: the consumer is the row the PUBLIC table is read from - `standings_snapshots`, written by the scoring
      // refold after round 1's last board - not `rankedStageStandings`, which runs the same loader and fold as the producer.
      // Read before the Pair, so round 2's own bye is no part of it.
      const [snapshot] = await sql<{ rows: { entrantId: string; points: number }[] }[]>`
        select rows from standings_snapshots where stage_id = ${r.stageId} and pool_id is null`;
      expect(snapshot?.rows.length, "anti-vacuity: the stored snapshot lists the field").toBeGreaterThan(0);

      const { standings } = await pairSpied(r);
      const holder = bye!.home_entrant_id!;
      const mine = scoresOf(standings).get(holder);
      expect(mine, "the bye holder is in round 2's field").toBeDefined();
      expect(mine, "the bye is the declared win (a set sport's clean sweep)").toBe(byePoints(sport, rule));
      expect(mine, "and a bye that scores nothing is no bye").toBeGreaterThan(0);
      expect(mine, "the very number the published table (its stored snapshot) shows").toBe(
        snapshot!.rows.find((row) => row.entrantId === holder)?.points,
      );
    }, 120_000);
  }

  for (const sport of SPORTS.filter((s) => s.key !== "icehockey")) {
    it(`X-SW-19 after a withdrawal: the withdrawn entrant's opponents keep the points the table gives them (${sport.key})`, async () => {
      // ice hockey is left to the cases above: its rig adds nothing to a walkover's value (no forfeit row is declared).
      const r = await startedSwiss(sport, { players: 6, rounds: 4 });
      const rule = declaredRule(sport);
      expect(rule.forfeit, "premise: no forfeit row, so a walkover win pays the win").toBeUndefined();
      await generateStageFixtures(r.auth, r.stageId); // Pair round 1
      expect(await decideRound(r, 1, homeWins(r)), "rig: round 1 decided").toBe(3);
      await generateStageFixtures(r.auth, r.stageId); // Pair round 2, nothing played yet
      const round2 = (await boardsOf(r.stageId, 2)).filter(playable);
      expect(round2.length, "rig: three round-2 boards").toBe(3);
      const leaver = round2[0]!.home_entrant_id!;
      const opponent = round2[0]!.away_entrant_id!;
      await withdrawEntrantCascade(r.auth, leaver);
      const walkover = (await boardsOf(r.stageId, 2)).find((f) => f.id === round2[0]!.id)!;
      expect(walkover.outcome, "rig: the withdrawal awarded the board to the opponent").toMatchObject({ kind: "award", winner: opponent });
      expect(await decideRound(r, 2, homeWins(r)), "rig: the other two round-2 boards decided").toBe(2);

      // Read BEFORE the Pair: round 3's own bye is a result of the Pair, and not yet a point of the scores it is handed.
      const table = await withTenant(r.auth.orgId, (tx) => rankedStageStandings(tx, r.stageId));
      const want = await earned(r, rule, rule.win.regulation, rule.draw ?? null, 2);
      const { standings } = await pairSpied(r);
      expect(standings.map((s) => s.entrantId), "the withdrawn entrant is out of round 3's field").not.toContain(leaver);
      expect(standings.length, "anti-vacuity: five remain").toBe(5);
      const got = scoresOf(standings);
      for (const s of standings) expect(got.get(s.entrantId), `${r.nameOf(s.entrantId)}'s score is the declared rule over the recorded results`).toBe(want.get(s.entrantId));
      // The opponent's walkover win counts, at the table's value: round 1 as recorded plus the awarded round 2.
      const round1 = (await boardsOf(r.stageId, 1)).filter((f) => f.away_entrant_id !== null);
      const r1 = round1.some((f) => f.outcome?.winner === opponent) ? rule.win.regulation : 0;
      expect(got.get(opponent), "the walkover's win is kept").toBe(r1 + rule.win.regulation);
      for (const s of standings) expect(got.get(s.entrantId), `${r.nameOf(s.entrantId)}: the table's points`).toBe(table.find((row) => row.entrantId === s.entrantId)?.points);
    }, 180_000);
  }

  for (const sport of SPORTS.filter((s) => s.key !== "icehockey")) {
    it(`X-SW-19 a second Pair (after Unpair) sends the same scores (${sport.key})`, async () => {
      // ice hockey is left out: Unpair/Pair is sport-blind, and the declared rule is read the same way.
      const r = await startedSwiss(sport, { players: 6, rounds: 3 });
      await generateStageFixtures(r.auth, r.stageId); // Pair round 1
      expect(await decideRound(r, 1, homeWins(r)), "rig: round 1 decided").toBe(3);
      const first = await pairSpied(r); // Pair round 2
      expect((await unpairSwissRound(r.auth, r.stageId)).round, "rig: Unpair cleared round 2").toBe(2);
      const second = await pairSpied(r); // Pair round 2 again
      const [a, b] = [scoresOf(first.standings), scoresOf(second.standings)];
      expect([...b].sort(), "the same scores on the second Pair").toEqual([...a].sort());
      const rule = declaredRule(sport);
      expect([...new Set(b.values())].sort((x, y) => y - x), "and they are the declared win and loss").toEqual([rule.win.regulation, rule.loss.regulation]);
    }, 180_000);
  }

  for (const sport of SPORTS.filter((s) => s.key !== "icehockey")) {
    it(`X-SW-19 a walkover pays its winner the table's win and a double walkover pays nobody (${sport.key})`, async () => {
      // ice hockey is left out: it adds no walkover value of its own (its declared rule sets no forfeit row either).
      const r = await startedSwiss(sport, { players: 6, rounds: 3 });
      const rule = declaredRule(sport);
      expect([rule.forfeit, rule.loss.unplayed], "premise: no forfeit row and no loss-not-played, so a walkover pays the win and 0").toEqual([undefined, undefined]);
      await generateStageFixtures(r.auth, r.stageId); // Pair round 1
      const round1 = (await boardsOf(r.stageId, 1)).filter(playable);
      expect(round1.length, "rig: three boards").toBe(3);
      await post(r.auth, round1[0]!.id, "core.forfeit", { by: round1[0]!.away_entrant_id, reason: "walkover" });
      await post(r.auth, round1[1]!.id, "core.forfeit", { by: "both", reason: "walkover" });
      await r.sport.win(r.auth, round1[2]!, round1[2]!.home_entrant_id!);

      const { standings } = await pairSpied(r);
      const got = scoresOf(standings);
      expect(got.get(round1[0]!.home_entrant_id!), "the walkover's winner is paid the table's win").toBe(byePoints(sport, rule));
      expect(got.get(round1[0]!.away_entrant_id!), "the forfeiter is paid 0").toBe(0);
      expect([got.get(round1[1]!.home_entrant_id!), got.get(round1[1]!.away_entrant_id!)], "a double walkover pays neither side").toEqual([0, 0]);
      expect(got.get(round1[2]!.home_entrant_id!), "the played win is the declared win").toBe(rule.win.regulation);
      const want = await earned(r, rule, rule.win.regulation, rule.draw ?? null, 1);
      expect([...got].sort(), "and every score is the declared rule over the recorded results").toEqual([...want].sort());
    }, 180_000);
  }

  it("X-SW-19 stageTablePoints writes no lots draw (the score read, and the Pair that makes it), and rankedStageStandings still stores one", async () => {
    // single-sport: chess is the sport whose Swiss ties fall all the way to lots (a level table of draws, no seeds).
    const r = await startedSwiss(sportOf("boardgame"), { players: 4, rounds: 3, seeded: false });
    await generateStageFixtures(r.auth, r.stageId); // Pair round 1
    expect(await decideRound(r, 1, async (b) => drawChess(r.auth, b)), "rig: both round-1 boards drawn, so the table is level").toBe(2);
    // Scoring re-ranked the table and stored the draw its tie needed. Put the stage back to the state BEFORE any ranking
    // stored one, so that what the score read does is the thing counted.
    expect(await lotsCount(r.stageId), "premise: scoring stored a draw for the level table").toBeGreaterThan(0);
    await sql`delete from stage_lots_draws where stage_id = ${r.stageId}`;
    expect(await lotsCount(r.stageId), "premise: no lots drawn now").toBe(0);

    const read = await withTenant(r.auth.orgId, (tx) => stageTablePoints(tx, r.stageId));
    expect(read.points.size, "anti-vacuity: the read listed the field").toBe(4);
    expect(await lotsCount(r.stageId), "stageTablePoints stored no lots draw").toBe(0);

    // The Pair's own transaction: `swissGen` is what reads the points, so count INSIDE the transaction it runs in - the
    // Generate's later refold (a separate transaction, `refoldStageTable`) ranks the table, and stores the draw, either way.
    // Rolled back by a sentinel, so the stage is left as the next assertions expect it.
    const ROLLBACK = new Error("rollback");
    const inTx: { before: number; after: number; seated: number; ranked: number } = { before: -1, after: -1, seated: -1, ranked: -1 };
    const count = (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) =>
      tx<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${r.stageId}`.then((rows) => rows[0]!.n);
    await withTenant(r.auth.orgId, async (tx) => {
      const [stage] = await tx<{ division_id: string; config: Record<string, unknown> }[]>`select division_id, config from stages where id = ${r.stageId}`;
      const entrants = await swissActiveEntrants(tx, stage!.division_id, r.stageId);
      const existing = await tx<SwissExistingFixture[]>`
        select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome,
               scheduled_at, court_id, venue_id, schedule_locked
        from fixtures where stage_id = ${r.stageId} order by round_no, seq_in_round`;
      inTx.before = await count(tx);
      const out = await swissGen(tx, r.stageId, stage!.division_id, stage!.config, entrants, existing);
      inTx.seated = out.seatedCount;
      inTx.after = await count(tx);
      // T5 review m3: the positive pair, counted by THIS counter in THIS transaction (as the tenant role, under FORCE RLS),
      // so the zeros above are shown to be able to see a row: the table's own ranking stores the draw the level table needs.
      await rankedStageStandings(tx, r.stageId);
      inTx.ranked = await count(tx);
      throw ROLLBACK;
    }).catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
    expect(inTx.seated, "anti-vacuity: the Pair seated round 2 inside that transaction").toBeGreaterThan(0);
    expect([inTx.before, inTx.after], "the Pair's score read stored no lots draw").toEqual([0, 0]);
    expect(inTx.ranked, "and the in-transaction counter CAN see a stored draw: the table's own ranking stores one there").toBeGreaterThan(0);
    expect(await lotsCount(r.stageId), "and the rolled-back Pair left none behind").toBe(0);

    // The positive pair, which gives the zeros above their meaning: the table's own ranking DOES store the draw here.
    await withTenant(r.auth.orgId, (tx) => rankedStageStandings(tx, r.stageId));
    expect(await lotsCount(r.stageId), "rankedStageStandings stores the draw the tied table needs").toBeGreaterThan(0);
  }, 180_000);

  it("X-SW-19 a stage pinned before W3 (a pre-W3 rule pin) groups by its PINNED rule's points", async () => {
    // single-sport: chess, so that a win AND a draw are both paid (the pin's two non-zero numbers).
    const r = await startedSwiss(sportOf("boardgame"), { players: 6, rounds: 3 });
    const PINNED: PointsRule = { win: { regulation: 5 }, loss: { regulation: 0 }, draw: 2, shootoutAs: "result", unit: "whole", bonuses: [] };
    const sportRule = declaredRule(r.sport);
    expect([sportRule.win.regulation, sportRule.draw], "premise: the pin is not the sport's declared rule").not.toEqual([PINNED.win.regulation, PINNED.draw]);
    // A stage pinned by a release that is gone: its points rule, with the source V475 gave a migrated pin.
    const moved = await sql`
      update stages set table_rules_pinned = jsonb_set(jsonb_set(table_rules_pinned, '{points}', ${sql.json(PINNED as never)}), '{sources,points}', '"migrated"')
       where id = ${r.stageId} and table_rules_pinned is not null returning id`;
    expect(moved.length, "premise: the started stage holds a pin to rewrite").toBe(1);

    await generateStageFixtures(r.auth, r.stageId); // Pair round 1
    expect(
      await decideRound(r, 1, async (b, i) => (i === 1 ? drawChess(r.auth, b) : r.sport.win(r.auth, b, b.home_entrant_id!))),
      "rig: round 1 decided, board 2 drawn",
    ).toBe(3);
    const { standings } = await pairSpied(r);
    const got = scoresOf(standings);
    const want = await earned(r, PINNED, PINNED.win.regulation, PINNED.draw!, 1);
    expect([...got].sort(), "each score is the pinned rule's").toEqual([...want].sort());
    // T5 review m1: the `rule` stageTablePoints hands the final-round maximum (T7) is the stage's PINNED rule, the very one
    // that paid those scores, not a re-read of the sport's declared one.
    const read = await withTenant(r.auth.orgId, (tx) => stageTablePoints(tx, r.stageId));
    expect(
      [read.rule.win.regulation, read.rule.draw, read.rule.unit],
      "stageTablePoints returns the pinned rule (win 5, draw 2), not the sport's declared 2 / 1 in half-points",
    ).toEqual([PINNED.win.regulation, PINNED.draw, PINNED.unit]);
    // differential: the sport's declared rule would say 2 / 1; today's formula 1 / 0.5
    expect([...got.values()].sort((a, b) => b - a), "5 / 5 / 2 / 2 / 0 / 0").toEqual([5, 5, 2, 2, 0, 0]);
  }, 120_000);
});
