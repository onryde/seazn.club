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
import type { StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import { divisionQualification, qualificationFixtures, type QualSnapshot, type QualStage } from "../division-qualification";
import { divisionAwardAddsToLedger, type QualFixture } from "../qualification-view";

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

/** A stage row as `public_stages_v` publishes it (V414 meta, snake_case). */
const stage = (over: Partial<QualStage> = {}): QualStage => ({
  id: "S",
  kind: "league",
  qualify_count: 2,
  qualify_per_group: false,
  next_stage_name: "Finals",
  swiss_rounds: null,
  points_rule: null,
  has_rank_overrides: false,
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
    cascade: [...GENERIC.defaultTiebreakers],
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
  it("a retired module build (no module, so no bounds) gives no view for any table", () => {
    const qual = assemble({ module_: null, fixtures: POOL_FIXTURES, ids: POOL_IDS });
    expect(qual(GROUP, SNAP_A)).toBeNull();
    expect(qual(GROUP, SNAP_B)).toBeNull();
  });
  it("…its positive pair: the pinned module's bounds give both pools a view", () => {
    const qual = assemble({ fixtures: POOL_FIXTURES, ids: POOL_IDS });
    expect(qual(GROUP, SNAP_A)).not.toBeNull();
    expect(qual(GROUP, SNAP_B)).not.toBeNull();
  });
  it("W2c X-PT-1: a retired build gives no view under a stage PointsRule either — its played facts are the module's", () => {
    // The rule has bounds of its own (`pointsRuleBounds`), so only the missing module can refuse here: where the rule's
    // awarded score lands depends on what was played, which only the module reads (ruling 118).
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
});

describe("qualificationFixtures — the played facts the view reads (W2c X-PT-1)", () => {
  const SCORING = [{ points_rule: { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] } } }];
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
