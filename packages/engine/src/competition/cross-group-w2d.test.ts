// W2d Task 12 (spec §5.9 "ST-G4", D3, D7; rule row X-TB-7) — entrants from DIFFERENT groups (best-Nth) are compared by
// the SOURCE stage's own `crossGroup` order — its tie-break order with every head-to-head step removed (they never met)
// — with its seeds, `winsCount`, rngSeed and stored cross-group draws, instead of the one list every sport shared before
// W2d (points, diff, for, wins). A B1-migrated pin records exactly that old list, so a stage pinned before W2d keeps its
// seats (B1).
//
// Every case runs the stage's own path: pools paid by the sport's rule and ranked by `completeTableStage`, the source's
// cross-group rules read by `crossGroupRulesOf(stage)`, the seats by `resolveProgression`. Expected orders come from the
// rule text (BWF 16.2.3, FIH HK-TB-1, FIDE C.07) and the matches each case declares, and each case says what the wrong
// reading (the pre-W2d list) gives instead.
//
// Sequence (TEST-STRATEGY rule 1): no candidates → one per group → a tie the order splits → a tie only lots splits (first
// draw, then the stored draw, then a changed tied set) → the empty pools (level) → another sport.
import { describe, expect, it } from "vitest";
import { shuffle } from "../core/rng.ts";
import type { EntrantId, MatchOutcome, StandingsDelta } from "../core/types.ts";
import type { AnySportModule, TiebreakerKey } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { isHeadToHeadKey } from "./cascade-rules.ts";
import { decidedInFor } from "./decided-in.ts";
import { payout, setsToWinOf } from "./points.ts";
import { crossGroupOrder, PRE_W2D_CROSS_GROUP, resolveProgression, type ProgressionSpec, type SourceTables } from "./progression.ts";
import { completeTableStage, crossGroupRulesOf, type TableFixture, type TableStage } from "./stage.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { resolveTableRules, type TableRulesPin } from "./table-rules.ts";
import { lotSeed, type StoredLotsDraw } from "./tiebreakers.ts";

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m;
};
const badminton = moduleOf("badminton");
const football = moduleOf("football");
const cfgOf = (m: AnySportModule): unknown => declaredCfgs(m)[0]!.cfg;

type Ledger = Readonly<Record<string, number>>;
interface Match {
  readonly home: EntrantId;
  readonly away: EntrantId;
  readonly ledger: readonly [Ledger, Ledger];
  readonly r: "h" | "a" | "d";
}
const goals = (home: EntrantId, away: EntrantId, hg: number, ag: number): Match => ({
  home, away, r: hg > ag ? "h" : hg < ag ? "a" : "d",
  ledger: [{ gf: hg, ga: ag, gd: hg - ag }, { gf: ag, ga: hg, gd: ag - hg }],
});
/** BWF "games" ride the sets ledger; rally points the points ledger. */
const sets = (home: EntrantId, away: EntrantId, hs: number, as: number, hp: number, ap: number): Match => ({
  home, away, r: hs > as ? "h" : "a",
  ledger: [
    { sets_won: hs, sets_lost: as, points_won: hp, points_lost: ap },
    { sets_won: as, sets_lost: hs, points_won: ap, points_lost: hp },
  ],
});

function outcomeOf(m: Match): MatchOutcome {
  if (m.r === "d") return { kind: "draw" };
  return m.r === "h" ? { kind: "win", winner: m.home, loser: m.away } : { kind: "win", winner: m.away, loser: m.home };
}

/** The stage's rules: the sport's own for a group stage, or a pin. */
function rulesFor(module: AnySportModule, pinned: TableRulesPin | null = null): TableRulesPin {
  return resolveTableRules({
    module, stageKind: "group", mergedCfg: cfgOf(module),
    stageOwn: { points: null, tiebreakers: null, crossGroup: null }, divisionTiebreakers: null, pinned,
  });
}

function paid(module: AnySportModule, m: Match, rules: TableRulesPin): FixtureResult {
  const side = (id: EntrantId, won: boolean, lost: boolean, metrics: Ledger): StandingsDelta => ({
    entrantId: id, played: 1, won: won ? 1 : 0, drawn: !won && !lost ? 1 : 0, lost: lost ? 1 : 0, points: 0, metrics: { ...metrics },
  });
  const raw: FixtureResult = [side(m.home, m.r === "h", m.r === "a", m.ledger[0]), side(m.away, m.r === "a", m.r === "h", m.ledger[1])];
  const outcome = outcomeOf(m);
  return payout(outcome, decidedInFor(module, outcome), raw, true, rules.points, module.awardScoreKeys, setsToWinOf(module, cfgOf(module)));
}

interface Group {
  readonly pool: string;
  readonly matches: readonly Match[];
  /** "void": every match voided with its outcome kept — the pool is an empty table (T5 M4's one reachable path). */
  readonly status?: "decided" | "void";
}
interface Source {
  readonly stage: TableStage;
  readonly tables: SourceTables;
}

/** A completed group stage: every group's matches paid by the stage's rules, ranked by `completeTableStage`; the
 *  source's cross-group rules read off the stage (`crossGroupRulesOf`) unless `legacy` (a caller that hands none). */
function groupStage(
  module: AnySportModule,
  groups: readonly Group[],
  opts: { seeds?: Readonly<Record<EntrantId, number>>; rngSeed?: number; pinned?: TableRulesPin; lotsDraws?: ReadonlyMap<string, StoredLotsDraw>; legacy?: true } = {},
): Source {
  const rules = rulesFor(module, opts.pinned ?? null);
  const fixtures: TableFixture[] = groups.flatMap((g) =>
    g.matches.map((m, i): TableFixture => ({ id: `${g.pool}-${i}`, poolId: g.pool, status: g.status ?? "decided", result: paid(module, m, rules) })),
  );
  const entrants = [...new Set(groups.flatMap((g) => g.matches.flatMap((m) => [m.home, m.away])))].sort();
  const stage: TableStage = {
    id: "groups", kind: "group", entrants, rules,
    ...(module.winsCount === undefined ? {} : { winsCount: module.winsCount }),
    ...(opts.seeds === undefined ? {} : { seeds: new Map(Object.entries(opts.seeds)) }),
    ...(opts.rngSeed === undefined ? {} : { rngSeed: opts.rngSeed }),
    ...(opts.lotsDraws === undefined ? {} : { lotsDraws: new Map([["", opts.lotsDraws]]) }),
  };
  const done = completeTableStage(stage, fixtures);
  return { stage, tables: opts.legacy === true ? done.tables : { ...done.tables, crossGroup: crossGroupRulesOf(stage) } };
}

const bestNth = (nth: number, count: number): ProgressionSpec => ({
  sources: [{ stage: "previous", take: [{ kind: "bestNth", nth, count }] }],
  placement: "rank_order",
});
const seatsOf = (source: Source, nth: number, count: number) =>
  resolveProgression(bestNth(nth, count), [{ poolKeys: source.tables.pools.map((p) => p.pool) }], [source.tables]);
const declaredDraw = (rngSeed: number, members: readonly EntrantId[]): EntrantId[] => {
  const sorted = [...members].sort();
  return shuffle(lotSeed(rngSeed, sorted), sorted);
};

// Two badminton groups of three. P1: x1 beat x2 2-1 and x3 2-0, x2 beat x3 2-0 — x2 one win, games 3-2 (+1). P2: a1
// beat a2 2-0 and a3 2-0, a2 beat a3 2-1 — a2 one win, games 2-3 (−1). The seeds favour a2 (3) over x2 (4).
const BADMINTON_GROUPS: readonly Group[] = [
  { pool: "P1", matches: [sets("x1", "x2", 2, 1, 60, 46), sets("x1", "x3", 2, 0, 42, 20), sets("x2", "x3", 2, 0, 42, 30)] },
  { pool: "P2", matches: [sets("a1", "a2", 2, 0, 42, 20), sets("a1", "a3", 2, 0, 42, 20), sets("a2", "a3", 2, 1, 61, 59)] },
];
const BADMINTON_SEEDS = { a1: 1, x1: 2, a2: 3, x2: 4, a3: 5, x3: 6 };
/** V472's migrated pin (`db/migration/deltas/V472__w2d_table_rules.sql:480-481`): the crossGroup it writes, typed. */
const MIGRATED_CROSS_GROUP: TiebreakerKey[] = ["points", "diff", "for", "wins"];

describe("W2d T12 — cross-group ranking: the empty cases first (X-TB-7)", () => {
  it("empty: no candidates rank to nothing and draw nothing; one candidate per group is a seat each", () => {
    const none = crossGroupOrder([], ["points", "diff", "for", "lots"], undefined, { rngSeed: 3 });
    expect(none.rows).toEqual([]);
    expect(none.newLotsDraws).toEqual([]);
    // One group: its runner-up is the best runner-up, whatever the order says.
    const one = groupStage(badminton, [BADMINTON_GROUPS[0]!], { seeds: BADMINTON_SEEDS });
    const seats = seatsOf(one, 2, 1);
    expect(seats.qualifiers.map((q) => q.entrantId)).toEqual(["x2"]);
    expect(seats.ties).toEqual([]);
    expect(seats.newLotsDraws).toEqual([]);
  });
});

describe("W2d T12 — the source stage's order compares groups (X-TB-7, ST-G4)", () => {
  it("X-TB-7 two badminton runners-up from different groups are split by set_diff, not by seed (ST-G4)", () => {
    // premise (the engine's own declarations): badminton's cross-group order is its order without head-to-head steps,
    // and it holds BWF 16.2.3's games difference.
    const order = rulesFor(badminton).crossGroup;
    expect(order).toEqual(badminton.defaultTiebreakers("group", cfgOf(badminton)).filter((k) => !isHeadToHeadKey(k)));
    expect(order).toContain("set_diff");
    // BWF 16.2.1 / 16.2.3: one win each, then games difference — x2 (+1) above a2 (−1).
    const source = groupStage(badminton, BADMINTON_GROUPS, { seeds: BADMINTON_SEEDS });
    const seats = seatsOf(source, 2, 2);
    expect(seats.qualifiers.map((q) => q.entrantId)).toEqual(["x2", "a2"]);
    expect(seats.ties).toEqual([]);
    expect(seats.newLotsDraws).toEqual([]);
    // The wrong reading: the pre-W2d list (points, diff, for, wins) sees two level rows — badminton records no goal
    // difference — and falls to the seed, a2 first.
    const legacy = seatsOf(groupStage(badminton, BADMINTON_GROUPS, { seeds: BADMINTON_SEEDS, legacy: true }), 2, 2);
    expect(legacy.qualifiers.map((q) => q.entrantId)).toEqual(["a2", "x2"]);
    // A second call over the same source is the same seats.
    expect(seatsOf(source, 2, 2)).toStrictEqual(seats);
  });

  it("X-TB-7 the cross-group order never applies a head-to-head step (teams never met)", () => {
    // Every sport, every declared cfg, both group kinds: the derived cross-group order holds no head-to-head key (counted).
    let orders = 0;
    const seen = new Set<string>();
    forEachSport(({ module }) => {
      for (const { cfg } of declaredCfgs(module)) {
        for (const stageKind of ["league", "group"] as const) {
          const rules = resolveTableRules({
            module, stageKind, mergedCfg: cfg,
            stageOwn: { points: null, tiebreakers: null, crossGroup: null }, divisionTiebreakers: null, pinned: null,
          });
          orders++;
          for (const key of rules.tiebreakers) if (isHeadToHeadKey(key)) seen.add(key);
          expect(rules.crossGroup.filter((k) => isHeadToHeadKey(k)), `${module.key} ${stageKind}`).toEqual([]);
        }
      }
    });
    expect(orders, "anti-vacuity").toBeGreaterThan(builtinModules.length);
    // And one handed to it anyway — every head-to-head key a sport's order holds (counted) — is refused by name, typed,
    // both by the comparison and on the seating path.
    expect(seen.size, "anti-vacuity: head-to-head keys in the sports' orders").toBeGreaterThan(4);
    for (const key of seen) {
      const order = ["points", key, "lots"] as TiebreakerKey[];
      expect(() => crossGroupOrder([], order, undefined), key).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
      expect(() => crossGroupOrder([], order, undefined), key).toThrow(new RegExp(`"${key}" at position 2`));
    }
    const source = groupStage(badminton, BADMINTON_GROUPS, { seeds: BADMINTON_SEEDS });
    const withH2h: SourceTables = { ...source.tables, crossGroup: { order: ["wins", "h2h_two", "set_diff", "lots"] } };
    expect(() => resolveProgression(bestNth(2, 2), [{ poolKeys: ["P1", "P2"] }], [withH2h])).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("X-TB-7 a pinned stage's crossGroup (migrated: points, diff, for, wins) is what progression uses — B1 keeps best-third unmoved", () => {
    // The pre-W2d list the seats were resolved by is the migrated pin's list (V472).
    expect([...PRE_W2D_CROSS_GROUP]).toEqual(MIGRATED_CROSS_GROUP);
    const derived = rulesFor(badminton);
    const pin: TableRulesPin = {
      points: derived.points, tiebreakers: derived.tiebreakers, crossGroup: MIGRATED_CROSS_GROUP,
      sources: { points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" },
    };
    const pinned = groupStage(badminton, BADMINTON_GROUPS, { seeds: BADMINTON_SEEDS, pinned: pin });
    expect(pinned.tables.crossGroup?.order).toEqual(MIGRATED_CROSS_GROUP);
    const seats = seatsOf(pinned, 2, 2);
    // Unmoved: the seats a caller with no cross-group rules (pre-W2d) resolves, a2 then x2 on the seed, still flagged as
    // an unbroken tie for the organiser…
    const before = seatsOf(groupStage(badminton, BADMINTON_GROUPS, { seeds: BADMINTON_SEEDS, legacy: true }), 2, 2);
    expect(seats).toStrictEqual(before);
    expect(seats.qualifiers.map((q) => q.entrantId)).toEqual(["a2", "x2"]);
    expect(seats.ties.map((t) => [t.entrantIds, t.reason])).toEqual([[["a2", "x2"], "seed"]]);
    // …while the same groups unpinned resolve by the stage's own order: x2 first (the differential).
    expect(seatsOf(groupStage(badminton, BADMINTON_GROUPS, { seeds: BADMINTON_SEEDS }), 2, 2).qualifiers.map((q) => q.entrantId)).toEqual(["x2", "a2"]);
  });
});

// Two football groups whose runners-up are level on every step of the cross-group order: y2 and b2 each won 1-0 and
// lost 0-1 (3 points, GD 0, GF 1, no fair-play ledger).
const FOOTBALL_GROUPS: readonly Group[] = [
  { pool: "G1", matches: [goals("y1", "y2", 1, 0), goals("y2", "y3", 1, 0), goals("y1", "y3", 2, 0)] },
  { pool: "G2", matches: [goals("b1", "b2", 1, 0), goals("b2", "b3", 1, 0), goals("b1", "b3", 3, 0)] },
];
const G3: Group = { pool: "G3", matches: [goals("z1", "z2", 1, 0), goals("z2", "z3", 1, 0), goals("z1", "z3", 1, 0)] };

describe("W2d T12 — a cross-group tie only lots can split (X-TB-7, §5.8)", () => {
  it("X-TB-7 the first time: the declared draw orders them, flagged, and the draw is returned to be stored", () => {
    // premise: football's cross-group order ends in lots, and the two are level on every step before it
    expect(rulesFor(football).crossGroup.at(-1)).toBe("lots");
    const source = groupStage(football, FOOTBALL_GROUPS, { rngSeed: 11 });
    const seats = seatsOf(source, 2, 2);
    const drawn = declaredDraw(11, ["b2", "y2"]);
    expect(seats.qualifiers.map((q) => q.entrantId)).toEqual(drawn);
    expect(seats.ties.map((t) => [t.entrantIds, t.reason])).toEqual([[["b2", "y2"], "lots"]]);
    // one draw for the pair (the second seat reads the same comparison), tagged with its source
    expect(seats.newLotsDraws).toEqual([{ sourceIndex: 0, membersKey: "b2,y2", members: ["b2", "y2"], drawnOrder: drawn, seed: lotSeed(11, ["b2", "y2"]) }]);
    // The wrong reading: the pre-W2d list has no lots, so it never draws — the seed, then the id, decide (b2 first).
    const legacy = seatsOf(groupStage(football, FOOTBALL_GROUPS, { rngSeed: 11, legacy: true }), 2, 2);
    expect(legacy.qualifiers.map((q) => q.entrantId)).toEqual(["b2", "y2"]);
    expect(legacy.newLotsDraws).toEqual([]);
  });

  it("X-TB-7 a second call: the STORED cross-group draw orders the pair, whatever the seed says now, and nothing is drawn again", () => {
    const drawn = declaredDraw(11, ["b2", "y2"]);
    const stored = new Map([["b2,y2", { order: [...drawn].reverse(), drawnAt: "2026-10-26T09:00:00.000Z" }]]);
    const seats = seatsOf(groupStage(football, FOOTBALL_GROUPS, { rngSeed: 11, lotsDraws: stored }), 2, 2);
    expect(seats.qualifiers.map((q) => q.entrantId)).toEqual([...drawn].reverse());
    expect(seats.newLotsDraws).toEqual([]);
  });

  it("X-TB-7 a changed tied set (a third group's runner-up level too) is a new draw — the pair's stored draw does not order it", () => {
    const drawn = declaredDraw(11, ["b2", "y2"]);
    const stored = new Map([["b2,y2", { order: [...drawn].reverse(), drawnAt: "2026-10-26T09:00:00.000Z" }]]);
    const seats = seatsOf(groupStage(football, [...FOOTBALL_GROUPS, G3], { rngSeed: 11, lotsDraws: stored }), 2, 3);
    const three = declaredDraw(11, ["b2", "y2", "z2"]);
    expect(seats.qualifiers.map((q) => q.entrantId)).toEqual(three);
    expect(seats.newLotsDraws.map((d) => d.membersKey)).toEqual(["b2,y2,z2"]);
  });
});

describe("W2d T12 — the empty pools: a level row stays level (T5 M4)", () => {
  it("X-TB-7 candidates from empty tables keep `level`, and an all-level comparison draws no lots (seed, then id)", () => {
    // Every match voided with its outcome kept: membership without a counted fixture — each group is an empty table.
    const voided = FOOTBALL_GROUPS.map((g): Group => ({ ...g, status: "void" }));
    const source = groupStage(football, voided, { rngSeed: 11, seeds: { y1: 2, b1: 1 } });
    for (const pool of source.tables.pools) for (const row of pool.rows) expect(row.level, row.entrantId).toBe(true);
    const ranked = crossGroupOrder(source.tables.pools.map((p) => p.rows[0]!), source.tables.crossGroup!.order, undefined, { rngSeed: 11, seeds: new Map([["y1", 2], ["b1", 1]]) });
    expect(ranked.rows.map((r) => [r.entrantId, r.level])).toEqual([["b1", true], ["y1", true]]);
    expect(ranked.newLotsDraws).toEqual([]);
    // Mixed: one empty group beside a played one — the empty group's row keeps `level`, the played one carries none.
    const mixed = groupStage(football, [voided[0]!, FOOTBALL_GROUPS[1]!], { rngSeed: 11 });
    const rows = crossGroupOrder(mixed.tables.pools.map((p) => p.rows[0]!), mixed.tables.crossGroup!.order, undefined, { rngSeed: 11 }).rows;
    expect(rows.map((r) => [r.entrantId, r.level === true])).toEqual([["b1", false], ["y1", true]]);
  });
});

describe("W2d T12 — what the order's keys read (X-TB-7)", () => {
  it("X-TB-7 FIH: the source's winsCount reaches `wins` — regulation wins only (HK-TB-1)", () => {
    // single-sport: `winsCount: "regulation"` is declared by hockey alone (the sweep below counts it).
    let regulation = 0;
    forEachSport(({ module }) => { if (module.winsCount === "regulation") regulation++; });
    expect(regulation).toBe(1);
    const hockey = moduleOf("hockey");
    const stage: TableStage = { id: "s", kind: "group", entrants: [], rules: rulesFor(hockey), winsCount: hockey.winsCount! };
    const rules = crossGroupRulesOf(stage);
    expect(rules.winsCount).toBe("regulation");
    // A: two wins, one of them in overtime; B: one win; level on points. FIH: regulation wins level (1 each), then goal
    // difference — B (+2) above A (+1). Counting every win would put A first.
    const row = (id: EntrantId, won: number, wonOt: number, gd: number): StandingsRow => ({
      entrantId: id, played: 3, won, drawn: 0, lost: 3 - won, points: 6, metrics: { won_ot: wonOt, gd, gf: 3, ga: 3 - gd },
    });
    const rows = [row("A", 2, 1, 1), row("B", 1, 0, 2)];
    expect(rules.order.slice(0, 3)).toEqual(["points", "wins", "diff"]);
    expect(crossGroupOrder(rows, rules.order, undefined, { winsCount: rules.winsCount! }).rows.map((r) => r.entrantId)).toEqual(["B", "A"]);
    expect(crossGroupOrder(rows, rules.order, undefined).rows.map((r) => r.entrantId)).toEqual(["A", "B"]);
  });

  it("X-TB-7 chess: Sonneborn-Berger compares each group's own SB (FIDE C.07), not a ledger of games they never played", () => {
    // single-sport: `sberger` is in the board game's round-robin order alone.
    const boardgame = moduleOf("boardgame");
    const order = rulesFor(boardgame).crossGroup;
    expect(order).toEqual(["points", "wins", "sberger", "lots"]);
    // Two group runners-up, level on points and wins; their groups gave them SB 1½ and 1.
    const row = (id: EntrantId, sb: number): StandingsRow => ({ entrantId: id, played: 3, won: 1, drawn: 1, lost: 1, points: 3, metrics: { sberger: sb } });
    const ranked = crossGroupOrder([row("c2", 1), row("d2", 1.5)], order, undefined, { rngSeed: 5 });
    expect(ranked.rows.map((r) => r.entrantId)).toEqual(["d2", "c2"]);
    expect(ranked.rows[1]!.tieBreak?.key).toBe("sberger");
    expect(ranked.newLotsDraws).toEqual([]);
    // Their SB is the group's: the comparison does not overwrite it.
    expect(ranked.rows.map((r) => r.metrics.sberger)).toEqual([1.5, 1]);
  });
});
