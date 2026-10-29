// divisionQualification — the ONE place a standings surface turns what it
// already holds (the division's pinned module and live cfg, its dictionary,
// fixtures, entrants and cascade) into a per-table `QualificationView` builder
// (Task 7 fix round 1). The division page, the embed and the competition hub
// each assembled these inputs by hand; the page's and the embed's pool wiring
// was untested (`poolId: null` survived there 3/3), and the console (Task 9)
// would have been a fourth copy.
//
// What this file pins is the ASSEMBLY, not the builder's logic
// (qualification-view.test.ts owns that):
//  * the table's pool comes from the snapshot it is drawn for — a two-pool
//    `qualify_per_group` stage gives each pool a view over exactly its own
//    entrants, with that pool's own cut line and statuses;
//  * the walkover's ledger flag comes from the division's PINNED module and
//    cfg — a sport whose forfeit writes a score moves the what-if's average;
//  * the bounds come from the module too — none (a retired build) is no
//    status, stated first; and (W2c X-PT-1) so do the fixtures' played facts a
//    stage rule's awarded score is read by, so a retired build gives no view
//    under a stage PointsRule either, though the rule has bounds of its own.
//
// Mutants killed: `poolId: null` in the helper (→ the two-pool test); the
// award flag forced false (→ the award test); bounds not derived (→ the empty
// case's positive pair, the two-pool test).
import { describe, expect, it } from "vitest";
import { PointsRule, resolveTableRules, type StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, defaultOrderOf } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import { divisionQualification, qualificationFixtures, type QualSnapshot, type QualStage } from "../division-qualification";
import { EVERY_OUTCOME, divisionAwardAddsToLedger, type QualFixture } from "../qualification-view";
import type { StageTableRulesDoc } from "@/server/engine-db/table-rules";

const moduleOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no module ${key}`);
  return m;
};
const GENERIC = moduleOf("generic");
const ICEHOCKEY = moduleOf("icehockey");
const CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

/** A ranked snapshot row whose for/against/diff agree. */
function row(entrantId: string, rank: number, won: number, played: number, goals: [number, number] = [won, played - won]): StandingsRow {
  return {
    entrantId,
    rank,
    played,
    won,
    drawn: 0,
    lost: played - won,
    points: 3 * won,
    metrics: { for: goals[0], against: goals[1], diff: goals[0] - goals[1] },
  };
}

let seq = 0;
const fx = (pool: string | null, round: number, home: string, away: string, status: string, outcome: unknown): QualFixture => ({
  id: `f${++seq}`,
  stage_id: "S",
  pool_id: pool,
  round_no: round,
  status,
  home_entrant_id: home,
  away_entrant_id: away,
  outcome,
  // W2c X-PT-1: no ledger behind these fixtures — nothing played before a forfeit.
  played: false,
});
const won = (pool: string | null, round: number, winner: string, loser: string) =>
  fx(pool, round, winner, loser, "decided", { kind: "win", winner, loser });
const toPlay = (pool: string | null, round: number, home: string, away: string) => fx(pool, round, home, away, "scheduled", null);
/** A two-sided walkover (core.forfeit): an award with both seats, as W2b stores it (`reason`, `loser`). */
const walkover = (pool: string | null, round: number, winner: string, loser: string) =>
  fx(pool, round, winner, loser, "forfeited", { kind: "award", winner, loser, reason: "walkover" });

/** W2d Task 9: a stage's table rules as the one loader serves them (`stageTableRulesDocs`) for an unpinned stage — the
 *  ENGINE's resolver over the stage's own rule and the sport's layers (its order, its rule), every outcome reachable. */
function rulesDoc(points: unknown = null): StageTableRulesDoc {
  const r = resolveTableRules({
    module: GENERIC,
    stageKind: "league",
    mergedCfg: CFG,
    stageOwn: { points: points === null ? null : PointsRule.parse(points), tiebreakers: null, crossGroup: null },
    divisionTiebreakers: null,
    pinned: null,
  });
  return { ...r, pinnedAt: null, reachable: [...EVERY_OUTCOME], sportDefault: [...defaultOrderOf(GENERIC)], primary: GENERIC.primaryTableKey };
}

/** A stage row as `public_stages_v` publishes it (V414 meta, snake_case), with its loaded table rules (W2d Task 9). */
const stage = (over: Partial<QualStage> = {}): QualStage => ({
  id: "S",
  kind: "league",
  qualify_count: 2,
  qualify_per_group: false,
  next_stage_name: "Finals",
  swiss_rounds: null,
  points_rule: null,
  has_rank_overrides: false,
  // an unpinned stage (V475): the table is paid by its own rule, so the two columns agree unless a test says otherwise
  table_rules: rulesDoc(over.points_rule ?? null),
  ...over,
});

const NAMES: Record<string, string> = {
  A: "Ada", B: "Bo", C: "Cy", D: "Di",
  e1: "Red Rovers", e2: "Blue Jays", e3: "Green Giants", e4: "Gold Geese", e5: "Silver Swans", e6: "Bronze Bears",
};

function assemble(over: { module_?: AnySportModule | null; config?: unknown; fixtures: QualFixture[]; ids: string[] }) {
  return divisionQualification({
    module_: over.module_ === undefined ? GENERIC : over.module_,
    division: { config: over.config ?? CFG },
    dict: en,
    locale: "en",
    fixtures: over.fixtures,
    entrantStatuses: Object.fromEntries(over.ids.map((id) => [id, "confirmed"])),
    entrantNames: NAMES,
  });
}

// Two pools of three, one through from each (`qualify_per_group`) — the
// competition hub's Task 6 scene, so the three surfaces agree on it.
//  Pool A: r1 e1>e2; r2 e1–e3, r3 e2–e3 to play. Two rounds left.
//  Pool B: r1 e4>e5, r2 e4>e6; r3 e5–e6 to play. e4 is out of reach.
// They differ in every line a swap would move: the rounds left on the cut
// line, and the statuses.
const POOL_FIXTURES = [
  won("pA", 1, "e1", "e2"),
  toPlay("pA", 2, "e1", "e3"),
  toPlay("pA", 3, "e2", "e3"),
  won("pB", 1, "e4", "e5"),
  won("pB", 2, "e4", "e6"),
  toPlay("pB", 3, "e5", "e6"),
];
const SNAP_A: QualSnapshot = { pool_id: "pA", rows: [row("e1", 1, 1, 1), row("e2", 2, 0, 1), row("e3", 3, 0, 0)] };
const SNAP_B: QualSnapshot = { pool_id: "pB", rows: [row("e4", 1, 2, 2), row("e5", 2, 0, 1), row("e6", 3, 0, 1)] };
const GROUP = stage({ kind: "group", qualify_count: 1, qualify_per_group: true });
const POOL_IDS = ["e1", "e2", "e3", "e4", "e5", "e6"];

describe("divisionQualification — no status stated first", () => {
  it("a retired module build gives no view for any table: the loader cannot resolve its module, so the stage carries no rules", () => {
    const unread = { ...GROUP, table_rules: null };
    const qual = assemble({ module_: null, fixtures: POOL_FIXTURES, ids: POOL_IDS });
    expect(qual(unread, SNAP_A)).toBeNull();
    expect(qual(unread, SNAP_B)).toBeNull();
  });
  it("W2d T9: a stage with no table rules (the loader refused it, or an older document) gets no view even under a live module — never a guessed order", () => {
    const qual = assemble({ fixtures: POOL_FIXTURES, ids: POOL_IDS });
    for (const table_rules of [null, undefined]) {
      expect(qual({ ...GROUP, table_rules }, SNAP_A)).toBeNull();
      expect(qual({ ...GROUP, table_rules }, SNAP_B)).toBeNull();
    }
  });
  it("…its positive pair: the stage's loaded rules give both pools a view", () => {
    const qual = assemble({ fixtures: POOL_FIXTURES, ids: POOL_IDS });
    expect(qual(GROUP, SNAP_A)).not.toBeNull();
    expect(qual(GROUP, SNAP_B)).not.toBeNull();
  });
  it("W2c X-PT-1: a retired build gives no view under a stage PointsRule either — its played facts are the module's", () => {
    // The rule has bounds of its own (`pointsRuleBounds`), so only the missing module can refuse here: where the rule's
    // awarded score lands depends on what was played, which only the module reads (ruling 118).
    // W2d T9: the stage's rule in force is its loaded one (`table_rules.points`); a doc that reaches the builder without
    // a module is the builder's own contract (the loader itself never serves one for a retired build).
    const ruled = stage({ kind: "group", qualify_count: 1, qualify_per_group: true, points_rule: { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] } } });
    const live = assemble({ fixtures: POOL_FIXTURES, ids: POOL_IDS });
    expect(live(ruled, SNAP_A), "premise: the rule's own bounds give a view").not.toBeNull();
    const retired = assemble({ module_: null, fixtures: POOL_FIXTURES, ids: POOL_IDS });
    expect(retired(ruled, SNAP_A)).toBeNull();
    expect(retired(ruled, SNAP_B)).toBeNull();
  });
  it("…but only where the rule scores forfeits: under a rule with no awarded score a retired build keeps the rule's view (fix round 1 M-2)", () => {
    // No awarded score, so no fixture's played fact is read (`pointsRuleScoresForfeits`) and the module is not needed for
    // one; the rule's own bounds stand in for the module's, as they did before W2c. The SAME builder still refuses the
    // scoring stage beside it, so the refusal is per stage, not per division.
    const RULE = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 0 } };
    const unscoring = stage({ kind: "group", qualify_count: 1, qualify_per_group: true, points_rule: RULE });
    const scoring = stage({ kind: "group", qualify_count: 1, qualify_per_group: true, points_rule: { ...RULE, forfeit: { ...RULE.forfeit, awardScore: [3, 0] } } });
    const retired = assemble({ module_: null, fixtures: POOL_FIXTURES, ids: POOL_IDS });
    expect(retired(unscoring, SNAP_A)).not.toBeNull();
    expect(retired(unscoring, SNAP_B)).not.toBeNull();
    expect(retired(scoring, SNAP_A)).toBeNull();
  });
  it("W2d T9 (T7 carry): whether a stage scores forfeits is read off the rule the table is PAID by (its loaded rules), never its own column — both directions", () => {
    // A stage's own rule and its rule in force part ways once it is pinned (a migrated pin, a division or sport layer
    // fixed at start): the forfeit-award read follows the one in force.
    const RULE = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 0 } };
    const SCORES = { ...RULE, forfeit: { ...RULE.forfeit, awardScore: [3, 0] } };
    const base = { kind: "group", qualify_count: 1, qualify_per_group: true } as const;
    // own rule silent, rule in force scores forfeits → the retired build cannot place it: no view
    const paidScores = { ...stage({ ...base, points_rule: RULE }), table_rules: rulesDoc(SCORES) };
    // own rule scores forfeits, rule in force does not → the retired build keeps the rule's view
    const paidSilent = { ...stage({ ...base, points_rule: SCORES }), table_rules: rulesDoc(RULE) };
    const retired = assemble({ module_: null, fixtures: POOL_FIXTURES, ids: POOL_IDS });
    expect(retired(paidScores, SNAP_A)).toBeNull();
    expect(retired(paidSilent, SNAP_A)).not.toBeNull();
  });
});

describe("qualificationFixtures — the played facts the view reads (W2c X-PT-1)", () => {
  // W2d T9 (T7 carry): the rule the table is PAID by (the loader's `table_rules.points`), never the stage's own.
  const SCORING = [{ table_rules: { points: { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] } } } }];
  it("a one-seated award under a scoring stage rule is a bye: played false, never refused for a fact nobody read (fix round 1 I-2)", async () => {
    // `playedFor` refuses a forfeit-shaped fixture whose ledger was not read (CONFIG_INVALID), and a one-seated award is
    // forfeit-shaped but has no ledger to read — only the seated gate keeps that refusal off a public page. Typed and
    // pre-W2b byes both, beside an open two-seated fixture (the empty read: nothing forfeit-shaped is seated).
    const oneSeat = (outcome: unknown) => ({ ...fx(null, 1, "A", "B", "forfeited", outcome), away_entrant_id: null });
    const fixtures = [
      oneSeat({ kind: "award", winner: "A", loser: null, reason: "bye" }),
      oneSeat({ kind: "award", winner: "A" }),
      toPlay(null, 2, "A", "B"),
    ];
    const out = await qualificationFixtures(fixtures, GENERIC, SCORING);
    expect(out.map((f) => f.played)).toEqual([false, false, false]);
    expect(out).toHaveLength(fixtures.length);
  });
});

describe("divisionQualification — the table's pool is the snapshot's", () => {
  it("a per-group cut over two pools: each view covers exactly its own pool's entrants, with its own line and statuses", () => {
    const qual = assemble({ fixtures: POOL_FIXTURES, ids: POOL_IDS });
    const a = qual(GROUP, SNAP_A)!;
    const b = qual(GROUP, SNAP_B)!;
    expect(Object.keys(a.rows).sort()).toEqual(["e1", "e2", "e3"]);
    expect(Object.keys(b.rows).sort()).toEqual(["e4", "e5", "e6"]);

    expect(a.table).toMatchObject({ cutIndex: 1, label: "First place goes through to Finals · 2 rounds left" });
    expect(b.table).toMatchObject({ cutIndex: 1, label: "First place goes through to Finals · 1 round left" });
    expect(Object.fromEntries(Object.entries(a.rows).map(([id, r]) => [id, [r.label, r.ifYouLose]]))).toEqual({
      e1: ["Needs help", "If you lose your next match, you'll need other results to go your way."],
      e2: ["Needs help", "If you lose your next match, you're out."],
      e3: ["Needs help", "If you lose your next match, you'll need other results to go your way."],
    });
    expect(Object.fromEntries(Object.entries(b.rows).map(([id, r]) => [id, [r.label, r.ifYouLose]]))).toEqual({
      e4: ["Through", null],
      e5: ["Out", null],
      e6: ["Out", null],
    });
  });
});

describe("divisionQualification — the walkover's ledger is the pinned sport's", () => {
  // League of four after two rounds — r1 A>D, C>B; r2 A>C and a WALKOVER B
  // over D; r3 A–B, C–D to play. D (0 pts, 6–8) can tie B (3 pts, 7–2) only
  // by winning while B loses; `diff` then decides and D needs a margin of
  // 5 − (−2) + 1 = 8. Whether 8 fits in D's "average match" turns on whether
  // the walkover wrote goals: if it did not, D's 14 goals came from ONE match
  // (8 fits); if it did, from two (an average of 7, and it does not).
  //
  // "Ice-hockey-shaped": the generic module with the REAL ice-hockey walkover
  // CREDIT — so the bounds (and every status) are the generic sport's, and the
  // ONLY difference between the two runs is the flag the helper derives. W2b
  // Task 13 (X-WO-1): the helper asks the engine's `forfeitCredit` (what a
  // walkover credits the table), so the shape carries ice hockey's own credit
  // laid onto generic's ledger keys (gf/ga/gd → for/against/diff), read off
  // the ice-hockey module, never typed here. (Before W2b the helper read
  // `cfg.awardScore`, and this shape injected that into the parsed cfg.)
  const iceCfg = ICEHOCKEY.configSchema.parse({});
  const iceSeats = defaultLineupPair(ICEHOCKEY.positions);
  const ICE_SHAPED = {
    ...GENERIC,
    forfeitCredit: (_cfg: unknown, _state: unknown, reason: never, by: never) => {
      const ice = ICEHOCKEY.forfeitCredit(iceCfg, ICEHOCKEY.init(iceCfg, iceSeats), reason, by);
      const generic = (m: Record<string, number>) => ({ for: m.gf ?? 0, against: m.ga ?? 0, diff: m.gd ?? 0 });
      return { perSide: [generic(ice.perSide[0]), generic(ice.perSide[1])], excluded: [] };
    },
  } as unknown as AnySportModule;
  const fixtures = [
    won(null, 1, "A", "D"),
    won(null, 1, "C", "B"),
    won(null, 2, "A", "C"),
    walkover(null, 2, "B", "D"),
    toPlay(null, 3, "A", "B"),
    toPlay(null, 3, "C", "D"),
  ];
  const snap: QualSnapshot = {
    pool_id: null,
    rows: [row("A", 1, 2, 2, [2, 0]), row("B", 2, 1, 2, [7, 2]), row("C", 3, 1, 2, [1, 1]), row("D", 4, 0, 2, [6, 8])],
  };
  const LEAGUE = stage();
  // The snapshot rows fold the plain for/against/diff keys (`snap` above), so
  // the rule reads as plain "difference" whatever module shapes the bounds.
  const RULE = "difference";

  it("premise: ice hockey's walkover credits the table, the shaped module carries that credit, the generic sport's does not", () => {
    expect(divisionAwardAddsToLedger(ICEHOCKEY, {})).toBe(true);
    expect(divisionAwardAddsToLedger(ICE_SHAPED, CFG)).toBe(true);
    expect(divisionAwardAddsToLedger(GENERIC, CFG)).toBe(false);
  });

  it("a sport whose walkover writes a score counts it toward the average: no margin fits, so the what-if states the values", () => {
    const d = assemble({ module_: ICE_SHAPED, fixtures, ids: ["A", "B", "C", "D"] })(LEAGUE, snap)!.rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides. Now: you -2, Bo +5.`);
  });

  it("…the generic sport's walkover writes nothing: D's goals are one match's, and the target stands", () => {
    const d = assemble({ fixtures, ids: ["A", "B", "C", "D"] })(LEAGUE, snap)!.rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: win your next match by 8 or more to finish ahead.`);
  });
});

// W2e Task 8c (owner D19; rule row CK-BO-2) - the what-if's "Now: you X, they Y" prints a net run rate on the table's own
// scale. B and C are level on points (one win each in two), so the order's next step - net run rate - decides, and the
// sentence states both today's values (net run rate is no `WhatIfKey`, so there is no target to compute). The loaded rules
// carry the division's over length (`table_rules.ballsPerOver`, the one loader's) and the assembly must hand it on.
//
// Hand-worked (ECB The Hundred Playing Conditions 2026, 16.9.4(a): runs per over, an over is 5 balls): B scored 100 off 100
// balls and conceded 80 off 100: 5.000 - 4.000 = +1.000 per five-ball over, +1.200 per six-ball. C scored 90 and conceded
// 100: 4.500 - 5.000 = -0.500 per five-ball over, -0.600 per six-ball.
describe("divisionQualification - the what-if's net run rate is on the stage's over length (CK-BO-2)", () => {
  const ledger = (rf: number, ra: number) => ({ runs_for: rf, balls_faced_eff: 100, runs_against: ra, balls_bowled_eff: 100 });
  const withLedger = (r: StandingsRow, rf: number, ra: number): StandingsRow => ({ ...r, metrics: { ...r.metrics, ...ledger(rf, ra) } });
  const fixtures = [
    won(null, 1, "A", "D"),
    won(null, 1, "C", "B"),
    won(null, 2, "A", "C"),
    won(null, 2, "B", "D"),
    toPlay(null, 3, "A", "B"),
    toPlay(null, 3, "C", "D"),
  ];
  const snap: QualSnapshot = {
    pool_id: null,
    rows: [
      withLedger(row("A", 1, 2, 2, [2, 0]), 150, 100),
      withLedger(row("B", 2, 1, 2, [1, 1]), 100, 80),
      withLedger(row("C", 3, 1, 2, [1, 1]), 90, 100),
      withLedger(row("D", 4, 0, 2, [0, 2]), 80, 140),
    ],
  };
  const nrrStage = (extra: { ballsPerOver?: number }): QualStage => {
    const doc = rulesDoc();
    return stage({ table_rules: { ...doc, tiebreakers: ["points", "nrr"], ...extra } });
  };
  const sentence = (extra: { ballsPerOver?: number }) =>
    assemble({ fixtures, ids: ["A", "B", "C", "D"] })(nrrStage(extra), snap)!.rows.B!.whatIf;

  it("a five-ball stage prints runs per five-ball over", () => {
    expect(sentence({ ballsPerOver: 5 })).toBe("If you finish level on points with Cy, net run rate decides. Now: you +1.000, Cy -0.500.");
  });

  it("…its pair: the same table in six-ball overs prints per six, and a stage naming none keeps the default six", () => {
    const six = "If you finish level on points with Cy, net run rate decides. Now: you +1.200, Cy -0.600.";
    expect(sentence({ ballsPerOver: 6 })).toBe(six);
    expect(sentence({})).toBe(six);
  });
});
