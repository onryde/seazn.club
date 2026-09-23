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
//    status, stated first.
//
// Mutants killed: `poolId: null` in the helper (→ the two-pool test); the
// award flag forced false (→ the award test); bounds not derived (→ the empty
// case's positive pair, the two-pool test).
import { describe, expect, it } from "vitest";
import type { StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import { divisionQualification, type QualSnapshot, type QualStage } from "../division-qualification";
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
});
const won = (pool: string | null, round: number, winner: string, loser: string) =>
  fx(pool, round, winner, loser, "decided", { kind: "win", winner, loser });
const toPlay = (pool: string | null, round: number, home: string, away: string) => fx(pool, round, home, away, "scheduled", null);
/** A two-sided walkover (core.forfeit): an award with both seats. */
const walkover = (pool: string | null, round: number, winner: string, loser: string) =>
  fx(pool, round, winner, loser, "forfeited", { kind: "award", winner });

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
  // "Ice-hockey-shaped": the generic module with the REAL ice-hockey forfeit
  // score in its parsed cfg — so the bounds (and every status) are the generic
  // sport's, and the ONLY difference between the two runs is the flag the
  // helper derives. The score is read off the ice-hockey module's own parse,
  // never typed here.
  const iceAward = (ICEHOCKEY.configSchema.parse({}) as { awardScore?: unknown }).awardScore;
  const ICE_SHAPED = {
    ...GENERIC,
    configSchema: {
      ...GENERIC.configSchema,
      safeParse: (cfg: unknown) => {
        const parsed = GENERIC.configSchema.safeParse(cfg);
        return parsed.success ? { ...parsed, data: { ...(parsed.data as object), awardScore: iceAward } } : parsed;
      },
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
  const RULE = "goal/run difference";

  it("premise: ice hockey declares a forfeit score, the shaped module carries it, the generic sport does not", () => {
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
