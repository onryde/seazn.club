// W2d Task 12 (spec §5.6 "ST-G12 partial schedule", D7; rule rows X-TB-8, IH-TB-2) — a head-to-head step needs a COMPLETE
// mini-schedule: every fixture the stage schedules between the tied entrants decided. Otherwise the sport's
// partial-schedule order ranks the class instead of the h2h block (IIHF: fewest games played, GD, GF, seed, lots —
// RBG:349-350), or, for every other sport, the step does not split and the tie popover says why (`h2h_incomplete`, the
// author's call, AUD-ST:71 G12: "a team can rank above a tied rival it has not played yet").
//
// Every expected order below is typed from the rule text and the matches the test declares; the partial-schedule order
// and the default cascade are the engine's own declarations (`module.partialScheduleOrder`, `defaultTiebreakers`).
// Each case states the answer the WRONG reading gives (the block run on a partial mini-table, or the skip where IIHF
// orders), and shows it differs.
//
// Sequence (TEST-STRATEGY rule 1): the empty cases first (no row, a class of one, an empty schedule) → an incomplete
// class → the same class complete (the positive pair) → a second call → a double round robin's second leg → after a
// withdrawal (walkovers decide the outstanding fixtures) → another sport (football, badminton's h2h_two, chess's direct).
import { describe, expect, it } from "vitest";
import { shuffle } from "../core/rng.ts";
import type { EntrantId, MatchOutcome, StandingsDelta } from "../core/types.ts";
import type { AnySportModule, TiebreakerKey } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { offerableKeys } from "./cascade-rules.ts";
import { decidedInFor } from "./decided-in.ts";
import { payout, setsToWinOf } from "./points.ts";
import { completeTableStage, type TableFixture } from "./stage.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { resolveTableRules, type TableRulesPin } from "./table-rules.ts";
import { buildSwissTable, lotSeed, rankStandings } from "./tiebreakers.ts";

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m;
};
// single-sport: ice hockey is the one sport declaring a partial-schedule order (RBG:349-350; the premise test sweeps for it).
const icehockey = moduleOf("icehockey");
// single-sport: football witnesses the generic skip — no partial order, and its default order holds the h2h block.
const football = moduleOf("football");
// single-sport: badminton's default order holds h2h_two (BWF 16.2.2), and production's one Swiss competition is badminton (B1).
const badminton = moduleOf("badminton");
// single-sport: the board game's round-robin order is the one holding `direct` (FIDE C.07).
const boardgame = moduleOf("boardgame");
const cfgOf = (m: AnySportModule): unknown => declaredCfgs(m)[0]!.cfg;

type Ledger = Readonly<Record<string, number>>;
/** One match as the rule text sees it: who played whom, the ledger each side records, and how it ended. */
interface Match {
  readonly home: EntrantId;
  readonly away: EntrantId;
  readonly ledger: readonly [Ledger, Ledger];
  /** "h" home won, "a" away won, "d" a draw. */
  readonly r: "h" | "a" | "d";
  /** An unplayed award (a withdrawal's walkover): the winner and the score credited. */
  readonly award?: true;
}
const goals = (home: EntrantId, away: EntrantId, hg: number, ag: number): Match => ({
  home, away, r: hg > ag ? "h" : hg < ag ? "a" : "d",
  ledger: [{ gf: hg, ga: ag, gd: hg - ag }, { gf: ag, ga: hg, gd: ag - hg }],
});
/** A set sport: sets (BWF "games") and rally points. */
const sets = (home: EntrantId, away: EntrantId, hs: number, as: number, hp: number, ap: number): Match => ({
  home, away, r: hs > as ? "h" : "a",
  ledger: [
    { sets_won: hs, sets_lost: as, points_won: hp, points_lost: ap },
    { sets_won: as, sets_lost: hs, points_won: ap, points_lost: hp },
  ],
});
/** Chess (FIDE 1 / ½ / 0): no ledger beyond the result. */
const chess = (home: EntrantId, away: EntrantId, r: "h" | "a" | "d"): Match => ({ home, away, r, ledger: [{}, {}] });

function outcomeOf(m: Match): MatchOutcome {
  if (m.r === "d") return { kind: "draw" };
  const [winner, loser] = m.r === "h" ? [m.home, m.away] : [m.away, m.home];
  return m.award === true ? { kind: "award", winner, loser, reason: "walkover" } : { kind: "win", winner, loser };
}

/** The sport's real payout of `m` under `rule` (the seam a stage pays through). */
function paid(module: AnySportModule, cfg: unknown, m: Match, rules: ReturnType<typeof resolveTableRules>): FixtureResult {
  const side = (id: EntrantId, won: boolean, lost: boolean, metrics: Ledger): StandingsDelta => ({
    entrantId: id, played: 1, won: won ? 1 : 0, drawn: !won && !lost ? 1 : 0, lost: lost ? 1 : 0, points: 0, metrics: { ...metrics },
  });
  const raw: FixtureResult = [side(m.home, m.r === "h", m.r === "a", m.ledger[0]), side(m.away, m.r === "a", m.r === "h", m.ledger[1])];
  const outcome = outcomeOf(m);
  return payout(outcome, decidedInFor(module, outcome), raw, m.award !== true, rules.points, module.awardScoreKeys, setsToWinOf(module, cfg));
}

interface Scene {
  readonly module: AnySportModule;
  readonly decided: readonly Match[];
  /** Fixtures the stage schedules that are not decided yet, as [home, away]. */
  readonly pending: readonly (readonly [EntrantId, EntrantId])[];
  /** Pass the schedule to the ranker (`scheduledPairs`): default yes. */
  readonly schedule?: "all" | "none" | "empty";
  readonly seeds?: Readonly<Record<EntrantId, number>>;
  readonly order?: readonly TiebreakerKey[];
  /** The stage's format: default a league. */
  readonly kind?: "league" | "swiss";
  /** A pinned stage's rules (B1): never re-validated, so an order W2d would refuse to save still ranks. */
  readonly pinned?: TableRulesPin;
  /** The stage's circular-H2H mode for ≥3-way ties (Jul3/05 §5): default the mini-table. */
  readonly h2hScope?: "mini_table" | "overall";
}

/** The stage's own path: every match paid through the sport's rule, ranked by the resolved order (or `order`), with the
 *  stage's schedule (one entry per fixture, decided or not) and the sport's declared partial-schedule order. */
function rank(s: Scene): readonly StandingsRow[] {
  const cfg = cfgOf(s.module);
  const resolved = resolveTableRules({
    module: s.module, stageKind: s.kind ?? "league", mergedCfg: cfg,
    stageOwn: { points: null, tiebreakers: s.order ?? null, crossGroup: null }, divisionTiebreakers: null, pinned: s.pinned ?? null,
  });
  const entrants = [...new Set([...s.decided.flatMap((m) => [m.home, m.away]), ...s.pending.flat()])].sort();
  const fixtures: TableFixture[] = [
    ...s.decided.map((m, i): TableFixture => ({ id: `d${i}`, status: "decided", result: paid(s.module, cfg, m, resolved) })),
    ...s.pending.map((_, i): TableFixture => ({ id: `p${i}`, status: "scheduled" })),
  ];
  const all = [...s.decided.map((m) => [m.home, m.away] as const), ...s.pending];
  const scheduledPairs = s.schedule === "none" ? undefined : s.schedule === "empty" ? [] : all;
  const done = completeTableStage(
    {
      id: "s", kind: s.kind ?? "league", entrants, rules: resolved, rngSeed: 7,
      ...(s.kind === "swiss" ? { swiss: true, rounds: 3 } : {}),
      ...(scheduledPairs === undefined ? {} : { scheduledPairs }),
      ...(s.module.partialScheduleOrder === undefined ? {} : { partialScheduleOrder: s.module.partialScheduleOrder }),
      ...(s.module.winsCount === undefined ? {} : { winsCount: s.module.winsCount }),
      ...(s.seeds === undefined ? {} : { seeds: new Map(Object.entries(s.seeds)) }),
      ...(s.h2hScope === undefined ? {} : { h2hScope: s.h2hScope }),
    },
    fixtures,
  );
  const rows = done.tables.overall;
  if (rows === undefined) throw new Error("a one-pool stage has an overall table");
  return rows;
}
const ids = (rows: readonly StandingsRow[]): EntrantId[] => rows.map((r) => r.entrantId);
const rowOf = (rows: readonly StandingsRow[], id: EntrantId): StandingsRow => {
  const row = rows.find((r) => r.entrantId === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};
/** The engine's declared draw for a tied set (spec 05 §4.4), computed without the ranker. */
const declaredDraw = (rngSeed: number, members: readonly EntrantId[]): EntrantId[] => {
  const sorted = [...members].sort();
  return shuffle(lotSeed(rngSeed, sorted), sorted);
};

// IIHF, RBG:349-350: "if the tied teams have not all met, rank by fewest games played, GD, GF, seed" (then lots, D5).
const RBG_PARTIAL = ["fewest_played", "diff", "for", "seed", "lots"];

/** A 4-team ice hockey round robin, half played. A beat D 3-0; B beat C 2-1; C beat D 4-0; A–B, A–C and B–D still to
 *  play. A, B and C have 3 points each (IIHF regulation win 3, RBG:341). Among them only B–C has been played. */
const IIHF_HALF: Scene = {
  module: icehockey,
  decided: [goals("A", "D", 3, 0), goals("B", "C", 2, 1), goals("C", "D", 4, 0)],
  pending: [["A", "B"], ["A", "C"], ["B", "D"]],
};

describe("W2d T12 — the empty cases first (X-TB-8)", () => {
  it("empty: a class of one, and a stage whose scheduledPairs is empty, behave as before", () => {
    // No row at all: nothing is tied, nothing consults the schedule.
    const none = rankStandings([], { cascade: ["points", "h2h_points", "lots"], results: [], scheduledPairs: [["A", "B"]] });
    expect(none.rows).toEqual([]);
    expect(none.newLotsDraws).toEqual([]);
    // A class of one: A, B, C, D on 3, 2, 1, 0 points never tie, so the incomplete schedule (A–B pending) changes nothing.
    const rows: StandingsRow[] = [
      { entrantId: "A", played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {} },
      { entrantId: "B", played: 2, won: 0, drawn: 2, lost: 0, points: 2, metrics: {} },
      { entrantId: "C", played: 1, won: 0, drawn: 1, lost: 0, points: 1, metrics: {} },
      { entrantId: "D", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} },
    ];
    const cascade: TiebreakerKey[] = ["points", "h2h_points", "lots"];
    const before = rankStandings(rows, { cascade, results: [] });
    const withSchedule = rankStandings(rows, { cascade, results: [], scheduledPairs: [["A", "B"], ["C", "D"]], partialScheduleOrder: icehockey.partialScheduleOrder! });
    expect(withSchedule).toStrictEqual(before);
    expect(ids(withSchedule.rows)).toEqual(["A", "B", "C", "D"]);
    // An EMPTY schedule is no schedule: the football half-played table below ranks exactly as it did before W2d (the h2h
    // block on the mini-table it has: B 3 h2h points; A, absent from that mini-table, sorts below C's −1 on h2h GD, #429),
    // not as the guard would (C, then A and B by lots).
    // Nothing counted yet (no results at all): a level pair with a meeting scheduled has an incomplete mini-schedule —
    // h2h points does not split them, lots does, noted.
    const unplayed = rankStandings(rows.slice(2).map((r) => ({ ...r, played: 0, drawn: 0, points: 0 })), {
      cascade, scheduledPairs: [["C", "D"]], rngSeed: 3,
    });
    for (const row of unplayed.rows) expect(row.tieBreak, row.entrantId).toMatchObject({ key: "lots", note: "h2h_incomplete" });
    expect(unplayed.rows, "anti-vacuity: both rows checked").toHaveLength(2);
    const fbHalf: Scene = { ...FOOTBALL_HALF, schedule: "none" };
    expect(rank({ ...fbHalf, schedule: "empty" })).toStrictEqual(rank(fbHalf));
    expect(ids(rank({ ...fbHalf, schedule: "empty" }))).toEqual(["B", "C", "A", "D"]);
  });
});

describe("W2d T12 — IIHF partial schedule (X-TB-8, IH-TB-2)", () => {
  it("premise: ice hockey declares the partial-schedule order of RBG:349-350, and no other sport declares one (the registry, counted)", () => {
    let declaring = 0;
    const visited = forEachSport(({ module }) => {
      if (module.partialScheduleOrder === undefined) return;
      declaring++;
      expect(module.key).toBe("icehockey");
      expect([...module.partialScheduleOrder]).toEqual(RBG_PARTIAL);
    });
    expect(visited).toBe(builtinModules.length);
    expect(declaring, "anti-vacuity: one sport declares it").toBe(1);
  });

  it("X-TB-8 IH-TB-2 IIHF partial schedule: a 3-way tie whose mini-schedule is incomplete is ordered fewest played → diff → for → seed → lots (RBG:349-350)", () => {
    // A: P1 GD+3; B: P1 GD+1; C: P2 GD+3; D: P2, 0 points. RBG:349-350: fewest played puts A and B (1) above C (2); GD
    // then puts A (+3) above B (+1).
    const rows = rank(IIHF_HALF);
    expect(rows.map((r) => [r.entrantId, r.points, r.played, r.metrics.gd])).toEqual([
      ["A", 3, 1, 3], ["B", 3, 1, 1], ["C", 3, 2, 3], ["D", 0, 2, -7],
    ]);
    // The trace: C left the class on fewest played, A and B were split by goal difference.
    expect(rowOf(rows, "C").tieBreak).toStrictEqual({ key: "fewest_played", with: ["A", "B"] });
    expect(rowOf(rows, "A").tieBreak).toStrictEqual({ key: "diff", with: ["B"] });
    expect(rowOf(rows, "B").tieBreak).toStrictEqual({ key: "diff", with: ["A"] });
    // The wrong readings differ. Without the guard the IIHF block reads the one meeting it has (B beat C: B 3 h2h
    // points, A and C none), so B leads — a team placed above A, whom it has not played — and the re-applied block
    // leaves A and C to overall GD (+3 each) and GF (C 5, A 3): B, C, A. A plain skip (the generic rule) would rank
    // overall GD then GF among all three: C, A, B.
    expect(ids(rank({ ...IIHF_HALF, schedule: "none" }))).toEqual(["B", "C", "A", "D"]);
    expect(ids(rows)).not.toEqual(["C", "A", "B", "D"]);
  });

  it("X-TB-8 IH-TB-2 the partial order's own keys rank the class, whatever the stage's order holds after the block", () => {
    // The stage ranks by points, h2h points, lots — no goal difference after the block. RBG:349-350 still orders the
    // half-played class by fewest played, then GD: A (+3) above B (+1), traced to `diff`, not drawn by lots.
    const rows = rank({ ...IIHF_HALF, order: ["points", "h2h_points", "lots"] });
    expect(ids(rows)).toEqual(["A", "B", "C", "D"]);
    expect(rowOf(rows, "A").tieBreak).toStrictEqual({ key: "diff", with: ["B"] });
  });

  it("X-TB-8 IH-TB-2 a class the partial order leaves level goes to lots and keeps the 'h2h_incomplete' note", () => {
    // A beat D 2-0; B beat C 2-0; C beat D 4-0. A and B: one game each, GD +2, GF 2, no seeds — level through the partial
    // order down to lots; C (two played) is split off on fewest played and carries no note.
    const rows = rank({ module: icehockey, decided: [goals("A", "D", 2, 0), goals("B", "C", 2, 0), goals("C", "D", 4, 0)], pending: [["A", "B"], ["A", "C"], ["B", "D"]] });
    const drawn = declaredDraw(7, ["A", "B"]);
    expect(ids(rows)).toEqual([...drawn, "C", "D"]);
    for (const id of ["A", "B"]) {
      expect(rowOf(rows, id).tieBreak, id).toStrictEqual({ key: "lots", with: ["A", "B"].filter((x) => x !== id), note: "h2h_incomplete" });
    }
    expect(rowOf(rows, "C").tieBreak).toStrictEqual({ key: "fewest_played", with: ["A", "B"] });
  });

  it("X-TB-8 IH-TB-2 the partial order's seed step: two level on played, GD and GF are ordered by seed", () => {
    // As above, with seeds: B is seeded 1 and A 2 (RBG:350 "seed"), so B ranks first without lots.
    const rows = rank({
      module: icehockey, decided: [goals("A", "D", 2, 0), goals("B", "C", 2, 0), goals("C", "D", 4, 0)], pending: [["A", "B"], ["A", "C"], ["B", "D"]],
      seeds: { B: 1, A: 2, C: 3, D: 4 },
    });
    expect(ids(rows)).toEqual(["B", "A", "C", "D"]);
    expect(rowOf(rows, "B").tieBreak).toStrictEqual({ key: "seed", with: ["A"] });
  });

  it("X-TB-8 a complete mini-schedule uses the h2h block as usual (the positive pair)", () => {
    // Every fixture played. A beat B 2-0, B beat C 3-0, C beat A 1-0; each beat D (A 5-0, B 1-0, C 1-0). A, B and C on 6.
    // IIHF (RBG:345-346): H2H points level (3 each); H2H GD A +1, B +1, C −2; H2H goals A 2, B 3 → B, A, C.
    const complete: Scene = {
      module: icehockey,
      decided: [goals("A", "B", 2, 0), goals("B", "C", 3, 0), goals("C", "A", 1, 0), goals("A", "D", 5, 0), goals("B", "D", 1, 0), goals("C", "D", 1, 0)],
      pending: [],
    };
    const rows = rank(complete);
    expect(ids(rows)).toEqual(["B", "A", "C", "D"]);
    expect(rowOf(rows, "B").tieBreak?.key).toBe("h2h_for");
    expect(rowOf(rows, "C").tieBreak?.key).toBe("h2h_diff");
    // The partial order, wrongly applied here, would rank on overall GD (A +6, B +2, C −1): A first.
    expect(rowOf(rows, "A").metrics.gd).toBe(6);
    // A second call over the same stage is the same table.
    expect(rank(complete)).toStrictEqual(rows);
  });

  it("X-TB-8 D3: a stage ranking ≥3-way ties on overall metrics (h2h_scope 'overall') skips the block before the partial-schedule guard — no fewest-played, no note", () => {
    // Jul3/05 §5: in a tie of three or more the organiser's 'overall' mode skips the mini-table and the later keys of the
    // stage's order decide. Ice hockey's declared order after the block is overall GD, GF, seed, lots (premise). On the
    // half-played table A, B and C are on 3: GD A +3, B +1, C +3; GF C 5, A 3 → C, A, B, with no 'h2h_incomplete' note,
    // since no head-to-head step was skipped for want of a schedule — the organiser skipped every one.
    const order = icehockey.defaultTiebreakers("league", cfgOf(icehockey));
    expect(order.slice(order.indexOf("h2h_reapply") + 1)).toEqual(["diff", "for", "seed", "lots"]);
    const rows = rank({ ...IIHF_HALF, h2hScope: "overall" });
    expect(ids(rows)).toEqual(["C", "A", "B", "D"]);
    expect(rowOf(rows, "C").tieBreak).toStrictEqual({ key: "for", with: ["A"] });
    expect(rowOf(rows, "B").tieBreak).toStrictEqual({ key: "diff", with: ["A", "C"] });
    for (const row of rows) expect(row.tieBreak?.note, row.entrantId).toBeUndefined();
    expect(rows, "anti-vacuity: every row checked").toHaveLength(4);
    // The wrong precedence — the guard first — ranks the class by the partial order (fewest played: A, B, then C), noted.
    const guarded = rank(IIHF_HALF);
    expect(ids(guarded)).toEqual(["A", "B", "C", "D"]);
    expect(ids(guarded)).not.toEqual(ids(rows));
    // 'mini_table' is the default: stated, it ranks as the default does.
    expect(rank({ ...IIHF_HALF, h2hScope: "mini_table" })).toStrictEqual(guarded);
  });

  it("X-TB-8 D3: 'overall' covers ties of three or more only — a tied PAIR with an incomplete mini-schedule still takes the partial order", () => {
    // Jul3/05 §5 names ≥3-way ties. Five teams, four games played: C beat B 1-0 and D 2-0 (6 points); A beat D 1-0 and B
    // beat E 4-0 (3 points each). The tied class on 3 is the PAIR A, B, and A–B is still to play, so their mini-schedule
    // is incomplete: the partial order ranks them (RBG:349-350), fewest played first — A (one game) above B (two), though
    // B's GD (+3) is the better. D and E (0 points, D–E to play) are a pair the same way: E (one game) above D (two).
    const rows = rank({
      module: icehockey, decided: [goals("C", "B", 1, 0), goals("C", "D", 2, 0), goals("A", "D", 1, 0), goals("B", "E", 4, 0)],
      pending: [["A", "B"], ["A", "C"], ["A", "E"], ["B", "D"], ["C", "E"], ["D", "E"]], h2hScope: "overall",
    });
    expect(rows.map((r) => [r.entrantId, r.points, r.played, r.metrics.gd])).toEqual([
      ["C", 6, 2, 3], ["A", 3, 1, 1], ["B", 3, 2, 3], ["E", 0, 1, -4], ["D", 0, 2, -3],
    ]);
    expect(rowOf(rows, "A").tieBreak).toStrictEqual({ key: "fewest_played", with: ["B"] });
    expect(rowOf(rows, "E").tieBreak).toStrictEqual({ key: "fewest_played", with: ["D"] });
    // The wrong reading — 'overall' applied to a pair, which skips the block — leaves overall GD to decide: B (+3) above
    // A (+1), D (−3) above E (−4). Without the schedule the block finds no meeting between them and gives the same answer.
    expect(ids(rank({
      module: icehockey, decided: [goals("C", "B", 1, 0), goals("C", "D", 2, 0), goals("A", "D", 1, 0), goals("B", "E", 4, 0)],
      pending: [["A", "B"], ["A", "C"], ["A", "E"], ["B", "D"], ["C", "E"], ["D", "E"]], h2hScope: "overall", schedule: "none",
    }))).toEqual(["C", "B", "A", "D", "E"]);
  });

  it("X-TB-8 a second call over the half-played table is the same table", () => {
    expect(rank(IIHF_HALF)).toStrictEqual(rank(IIHF_HALF));
  });

  it("X-TB-8 IH-TB-2 after a withdrawal: the outstanding fixtures walked over complete the mini-schedule, and the block decides", () => {
    // D withdraws after the half-played table; the remaining fixtures are settled. A–B and A–C are played (A beat B 1-0,
    // C beat A 2-0), and B–D is awarded to B (a walkover counts as a decided fixture). A: 6, B: 6, C: 6. The
    // mini-schedule among A, B and C is complete, so the IIHF block ranks them: H2H GD A −1, B 0, C +1 → C, B, A.
    const rows = rank({
      module: icehockey,
      decided: [...IIHF_HALF.decided, goals("A", "B", 1, 0), goals("C", "A", 2, 0), { ...goals("B", "D", 5, 0), award: true }],
      pending: [],
    });
    expect(rows.slice(0, 3).map((r) => r.points)).toEqual([6, 6, 6]);
    expect(ids(rows)).toEqual(["C", "B", "A", "D"]);
    expect(rowOf(rows, "C").tieBreak?.key).toBe("h2h_diff");
  });
});

/** A 4-team football round robin, half played. A beat D 1-0; B beat C 1-0; C beat D 2-0; A–B, A–C and B–D to play.
 *  A, B and C have 3 points (FIFA 3/1/0), GD +1 each; GF A 1, B 1, C 2. */
const FOOTBALL_HALF: Scene = {
  module: football,
  decided: [goals("A", "D", 1, 0), goals("B", "C", 1, 0), goals("C", "D", 2, 0)],
  pending: [["A", "B"], ["A", "C"], ["B", "D"]],
};

describe("W2d T12 — every other sport: the step does not split (X-TB-8, author's call)", () => {
  it("X-TB-8 another sport (football) with an incomplete mini-schedule skips the block for that class and notes 'h2h_incomplete' (author's call, AUD-ST:71)", () => {
    // premise: football declares no partial-schedule order, and its default order holds the h2h block
    expect(football.partialScheduleOrder).toBeUndefined();
    const rows = rank(FOOTBALL_HALF);
    // The block does not split; the FIFA order goes on: GD level (+1 each), GF: C 2 above A 1 and B 1; A and B are level
    // to the end, so lots (the declared draw) orders them, and each carries the note.
    const drawn = declaredDraw(7, ["A", "B"]);
    expect(ids(rows)).toEqual(["C", ...drawn, "D"]);
    expect(rowOf(rows, "C").tieBreak).toStrictEqual({ key: "for", with: ["A", "B"] });
    for (const id of ["A", "B"]) {
      expect(rowOf(rows, id).tieBreak, id).toStrictEqual({ key: "lots", with: ["A", "B"].filter((x) => x !== id), note: "h2h_incomplete" });
    }
    // The wrong reading — the block on the one meeting it has (B beat C) — puts B first, a team placed above A, whom it
    // has not yet played.
    expect(ids(rank({ ...FOOTBALL_HALF, schedule: "none" }))).toEqual(["B", "C", "A", "D"]);
  });

  it("X-TB-8 a double round robin's second leg still owed leaves the mini-schedule incomplete (one schedule entry per fixture)", () => {
    // Every pair has met once: A beat B 2-0, B beat C 1-0, C beat A 1-0, and each beat D (A 1-0, B 4-0, C 1-0) — 6 points
    // apiece. The second legs are all still to play. FIFA's block on the first legs: H2H GD A +1, C 0, B −1 → A, C, B.
    const firstLegs = [goals("A", "B", 2, 0), goals("B", "C", 1, 0), goals("C", "A", 1, 0), goals("A", "D", 1, 0), goals("B", "D", 4, 0), goals("C", "D", 1, 0)];
    const singleRoundRobin = rank({ module: football, decided: firstLegs, pending: [] });
    expect(ids(singleRoundRobin)).toEqual(["A", "C", "B", "D"]);
    // Scheduled as a double round robin, the same played legs are half of A–B, A–C and B–C: the block does not split,
    // overall GD decides (A +2, B +3, C +1 → B, A, C).
    const secondLegs: (readonly [EntrantId, EntrantId])[] = [["B", "A"], ["C", "B"], ["A", "C"], ["D", "A"], ["D", "B"], ["D", "C"]];
    const doubleRoundRobin = rank({ module: football, decided: firstLegs, pending: secondLegs });
    expect(ids(doubleRoundRobin)).toEqual(["B", "A", "C", "D"]);
    expect(rowOf(doubleRoundRobin, "B").tieBreak?.key).toBe("diff");
  });

  it("X-TB-8 badminton's h2h_two: two tied who have met in one of two scheduled matches are not split by it ('h2h_incomplete')", () => {
    // single-sport: h2h_two is the step under test, and badminton's default order is the one that holds it (BWF 16.2.2).
    // A beat B 2-1 (21-15 18-21 21-10); B beat D 2-0 (21-10 21-10); C beat A 2-0 (21-5 21-5) and B 2-1 (21-19 19-21 21-19).
    // A and B: one win each. Sets: A 2-3 (−1), B 4-4 (0).
    const decided = [sets("A", "B", 2, 1, 60, 46), sets("B", "D", 2, 0, 42, 20), sets("C", "A", 2, 0, 42, 10), sets("C", "B", 2, 1, 61, 59)];
    const once = rank({ module: badminton, decided, pending: [["A", "D"], ["C", "D"]] });
    // Their one meeting is their whole schedule: BWF 16.2.2, the winner of their match — A.
    expect(ids(once).slice(1, 3)).toEqual(["A", "B"]);
    expect(rowOf(once, "A").tieBreak?.key).toBe("h2h_two");
    // A second A–B match still to play: the match between them is not decided, so h2h_two does not split them, and BWF
    // 16.2.3's games difference does: B (0) above A (−1).
    const twice = rank({ module: badminton, decided, pending: [["A", "D"], ["C", "D"], ["B", "A"]] });
    expect(ids(twice).slice(1, 3)).toEqual(["B", "A"]);
    expect(rowOf(twice, "B").tieBreak?.key).toBe("set_diff");
  });

  it("X-TB-8 chess's direct encounter: a tied set that has not all met is not split by it", () => {
    // single-sport: `direct` is the step under test; the board game's round-robin order holds it (FIDE C.07).
    // A beat B; B beat D; C beat D. A, B, C on 1 point (2 half-points) each; A–C and B–C still to play, so the tied set
    // has not all met. Direct does not split; wins are level (1 each); Sonneborn-Berger: A beat B (B scored 1), B and C
    // beat D (0) → A first, B and C level to lots.
    const rows = rank({ module: boardgame, decided: [chess("A", "B", "h"), chess("B", "D", "h"), chess("C", "D", "h")], pending: [["A", "C"], ["B", "C"], ["A", "D"]] });
    expect(ids(rows)[0]).toBe("A");
    expect(rowOf(rows, "A").tieBreak?.key).toBe("sberger");
    for (const id of ["B", "C"]) expect(rowOf(rows, id).tieBreak?.note, id).toBe("h2h_incomplete");
    // The wrong reading: direct on the one meeting among them (A beat B) splits A off by direct encounter.
    expect(rowOf(rank({ module: boardgame, decided: [chess("A", "B", "h"), chess("B", "D", "h"), chess("C", "D", "h")], pending: [["A", "C"], ["B", "C"], ["A", "D"]], schedule: "none" }), "A").tieBreak?.key).toBe("direct");
  });
});

// Production's one competition is a Swiss badminton one, pinned by the W2d migration to the order it ranks by today
// (spec §5.10 "Production fact", B1): points, wins, set ratio, point ratio, h2h points — no lots, so its residual is seed →
// id (§5.8). Its round in progress: z beat y; x and y are drawn against each other and have not played. x, y and z have
// one win and one loss each, sets 2-2 and points 62-62 — level on every step before h2h points.
const PRODUCTION_SWISS_ORDER: TiebreakerKey[] = ["points", "wins", "set_ratio", "point_ratio", "h2h_points"];
const SWISS_ROUND: Scene = {
  module: badminton,
  decided: [
    sets("z", "y", 2, 0, 42, 20), sets("d", "z", 2, 0, 42, 20), sets("y", "e", 2, 0, 42, 20),
    sets("x", "f", 2, 0, 42, 20), sets("g", "x", 2, 0, 42, 20),
  ],
  pending: [["y", "x"]],
};
const xyz = (rows: readonly StandingsRow[]): EntrantId[] => ids(rows).filter((id) => id === "x" || id === "y" || id === "z");

describe("W2d T12 — a Swiss stage is not a round robin (B1, D7: Swiss stays W3)", () => {
  it("X-TB-8 B1 Swiss: production's pinned badminton Swiss order ranks a round in progress as before W2d — the schedule is not read", () => {
    // single-sport: the production competition's sport and pinned order are the case B1 protects.
    const derived = resolveTableRules({
      module: badminton, stageKind: "swiss", mergedCfg: cfgOf(badminton),
      stageOwn: { points: null, tiebreakers: null, crossGroup: null }, divisionTiebreakers: null, pinned: null,
    });
    const pinned: TableRulesPin = {
      points: derived.points, tiebreakers: PRODUCTION_SWISS_ORDER, crossGroup: [],
      sources: { points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" },
    };
    const swiss: Scene = { ...SWISS_ROUND, kind: "swiss", pinned };
    const rows = rank(swiss);
    // Before W2d: h2h points on the meetings so far — z won its meeting; y lost it and x has played none, so both hold 0
    // h2h points and are level, and the order (no lots) falls to seed → id (§5.8): z, x, y.
    expect(xyz(rows)).toEqual(["z", "x", "y"]);
    expect(rows).toStrictEqual(rank({ ...swiss, schedule: "none" }));
    for (const row of rows) expect(row.tieBreak?.note, row.entrantId).toBeUndefined();
    // The differential: the same round read as a league with its schedule — the guard skips h2h points for the class
    // (y–x still to play), and the order, with no lots, falls to seed → id: x, y, z. That is the move B1 forbids.
    const league = rank({ ...SWISS_ROUND, pinned });
    expect(xyz(league)).toEqual(["x", "y", "z"]);
    expect(rowOf(league, "x").tieBreak?.note).toBe("h2h_incomplete");
  });
});

describe("W2d T12 — the guards (assumptions are guards)", () => {
  it("X-TB-8 a counted result the schedule does not hold is refused, typed (the schedule and the results disagree)", () => {
    const rows: StandingsRow[] = [
      { entrantId: "A", played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {} },
      { entrantId: "B", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {} },
    ];
    const ab: FixtureResult = [
      { entrantId: "A", played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {} },
      { entrantId: "B", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {} },
    ];
    const run = (scheduledPairs: readonly (readonly [EntrantId, EntrantId])[], results: readonly FixtureResult[]) =>
      () => rankStandings(rows, { cascade: ["points", "h2h_points", "lots"], results, scheduledPairs });
    expect(run([["C", "D"]], [ab])).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(run([["C", "D"]], [ab])).toThrow(/A,B/);
    expect(run([["C", "D"]], [ab])).toThrow(expect.objectContaining({ data: { pair: "A,B" } }));
    // two results of a pair scheduled once
    expect(run([["B", "A"]], [ab, ab])).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    // the positive pair: scheduled once, decided once; scheduled twice, decided once
    expect(run([["B", "A"]], [ab])).not.toThrow();
    expect(run([["B", "A"], ["A", "B"]], [ab])).not.toThrow();
  });

  it("X-TB-8 a partial-schedule order is plain keys, 'fewest_played' and a final 'lots' — anything else is refused, typed", () => {
    const rows: StandingsRow[] = [{ entrantId: "A", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} }];
    const run = (partialScheduleOrder: readonly string[]) => () =>
      rankStandings(rows, { cascade: ["points", "lots"], partialScheduleOrder: partialScheduleOrder as never });
    for (const bad of [["fewest_played", "h2h_points", "lots"], ["h2h_two", "lots"], ["direct"], ["lots", "diff"], ["fewest_played", "nope"], ["h2h_reapply"]]) {
      expect(run(bad), bad.join(",")).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
    // Each refusal names the key and its position (1-based), and carries both.
    expect(run(["fewest_played", "h2h_points", "lots"])).toThrow(/^partial-schedule key "h2h_points" at position 2 is not a plain key/);
    expect(run(["fewest_played", "h2h_points", "lots"])).toThrow(expect.objectContaining({ data: { key: "h2h_points", index: 1 } }));
    expect(run(["lots", "diff"])).toThrow(/^partial-schedule key "lots" at position 1 must be last$/);
    expect(run(["lots", "diff"])).toThrow(expect.objectContaining({ data: { key: "lots", index: 0 } }));
    expect(run(RBG_PARTIAL)).not.toThrow();
    expect(run(["fewest_played", "diff"])).not.toThrow();
  });

  it("X-TB-8 a Swiss table handed a schedule is refused, typed — ST-G12 reads a round-robin schedule, which a Swiss stage has not", () => {
    const rows: StandingsRow[] = [
      { entrantId: "A", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} },
      { entrantId: "B", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} },
    ];
    const run = (swiss: boolean, scheduledPairs: readonly (readonly [EntrantId, EntrantId])[]) => () =>
      rankStandings(rows, {
        cascade: ["points", "h2h_points", "lots"], results: [], scheduledPairs,
        ...(swiss ? { swiss: buildSwissTable(["A", "B"], [], []) } : {}),
      });
    expect(run(true, [["A", "B"]])).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(run(true, [["A", "B"]])).toThrow(/Swiss/);
    // the positive pairs: a Swiss table with no schedule; a league table with one
    expect(run(true, [])).not.toThrow();
    expect(run(false, [["A", "B"]])).not.toThrow();
  });

  it("X-TB-8 'fewest_played' is internal: never a tie-break key the editor offers (every sport × table kind, counted)", () => {
    let cells = 0;
    forEachSport(({ module }) => {
      for (const stageKind of ["league", "group", "swiss"] as const) {
        const order = module.defaultTiebreakers(stageKind, cfgOf(module));
        for (let position = 0; position <= order.length; position++) {
          cells++;
          expect(offerableKeys(order, position, { module, cfg: cfgOf(module), stageKind, crossGroup: false }) as readonly string[]).not.toContain("fewest_played");
        }
      }
    });
    expect(cells, "anti-vacuity").toBeGreaterThan(builtinModules.length * 3);
  });
});
