// Quick match plan 5, Task 2 (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md D4, D5, P7, P8,
// Review Focus 3; spec docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §11, §12): who a tie
// at the cut affects (`cutTies`), and the tiebreak order a League + Knockout league is stored with (`cutTiebreakers`).
//
// Controller ruling 2026-11-13 (Q1's PO rec, logged): in a League + Knockout quick match's LEAGUE stage `seed` is no
// tiebreaker. The seed is the order the names were typed, so tennis's and ice hockey's `…, seed, lots` would separate two
// sides level at the cut by typing order, silently: the spec's anti-goal. "Still level" = level after every default step
// except `seed` and `lots`. The sweep below pins both halves: those two sports' declared lists DO hide the tie, and the
// cut's list does not.
//
// Expected values: the hand-built tables' own ranks (each case pictures its table), the engine's declarations
// (`defaultTiebreakers`, `validateCascade`, `rankStandings` over results the sport's own fold paid), the offer
// (lib/quick-match-offer.generated.json) and, in the DB case, the rows the real write path stored. Never `cutTies`'s answer.
//
// The DB case needs real Postgres and skips without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  foldResults,
  rankStandings,
  validateCascade,
  type FixtureResult,
  type StandingsRow,
} from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, simOptionsFor, simulateDivision } from "@seazn/engine/testkit";

import { sql } from "@/lib/db";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { createQuickMatch, systemAuth } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { listQuickMatchSports } from "../quick-match-sports";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";
import { scoreEvent } from "../scoring";
import { completeStage, getStandings } from "../stages";
import { cutRowOf, cutTiebreakers, cutTies, openTie, tossThrough, type CutRow, type CutTie } from "../quick-match-cut";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // a create seals a secret (A15)
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------------------------------------------------
// Hand-built tables (D4)
// ---------------------------------------------------------------------------------------------------------------------

/** A table as the engine stores one: `order` is the ids from 1st down; each of `ties` is one residual class (level on
 *  every step before the lot), marked the engine's way: every member `tieUnbroken`, `tieBreak.with` the others. */
function table(order: readonly string[], ...ties: readonly (readonly string[])[]): CutRow[] {
  return order.map((entrantId, i) => {
    const cls = ties.find((t) => t.includes(entrantId));
    return {
      entrantId,
      rank: i + 1,
      tieUnbroken: cls !== undefined,
      tieWith: cls?.filter((id) => id !== entrantId) ?? [],
      tieKey: cls === undefined ? null : "lots",
    };
  });
}
const deepFrozen = (rows: CutRow[]): readonly CutRow[] =>
  Object.freeze(rows.map((r) => Object.freeze({ ...r, tieWith: Object.freeze([...r.tieWith]) })));

interface Case {
  name: string;
  rows: CutRow[];
  q: 2 | 4;
  want: CutTie[];
  /** The straddling tie's toss (D5: its first `seats` in the table's own order), read off the pictured table. */
  toss?: string[];
}

// Ids are chosen so the table's order is NOT the ids' sorted order wherever a tie is: `ranked` and a toss must follow
// the table, never the alphabet.
const CASES: Case[] = [
  { name: "the empty table: no row, no tie", rows: [], q: 2, want: [] },
  { name: "no tie at all", rows: table(["a", "b", "c", "d"]), q: 2, want: [] },
  {
    name: "2-way at 2nd-3rd, top 2: straddles, 1 seat for 2 (case 1)",
    rows: table(["a", "c", "b", "d"], ["c", "b"]),
    q: 2,
    want: [{ entrantIds: ["b", "c"], ranked: ["c", "b"], place: 2, seats: 1, straddles: true, byLot: true }],
    toss: ["c"],
  },
  {
    name: "2-way at 1st-2nd, top 2: both go through, ordered by the lot (case 2)",
    rows: table(["b", "a", "c"], ["b", "a"]),
    q: 2,
    want: [{ entrantIds: ["a", "b"], ranked: ["b", "a"], place: 1, seats: 2, straddles: false, byLot: true }],
  },
  {
    name: "3-way at 1st-3rd, top 2: pick 2 of 3 (Review Focus 3)",
    rows: table(["c", "a", "b"], ["c", "a", "b"]),
    q: 2,
    want: [{ entrantIds: ["a", "b", "c"], ranked: ["c", "a", "b"], place: 1, seats: 2, straddles: true, byLot: true }],
    toss: ["c", "a"],
  },
  {
    name: "2-way at 3rd-4th, top 2: wholly below the cut, nothing to ask",
    rows: table(["a", "b", "d", "c"], ["d", "c"]),
    q: 2,
    want: [],
  },
  {
    name: "top 4, 2-way classes at 1st-2nd and 3rd-4th: two case-2 ties, none open",
    rows: table(["b", "a", "d", "c", "e"], ["b", "a"], ["d", "c"]),
    q: 4,
    want: [
      { entrantIds: ["a", "b"], ranked: ["b", "a"], place: 1, seats: 2, straddles: false, byLot: true },
      { entrantIds: ["c", "d"], ranked: ["d", "c"], place: 3, seats: 2, straddles: false, byLot: true },
    ],
  },
  {
    name: "top 4, 2-way at 4th-5th: straddles the semi-final cut",
    rows: table(["a", "b", "c", "e", "d", "f"], ["e", "d"]),
    q: 4,
    want: [{ entrantIds: ["d", "e"], ranked: ["e", "d"], place: 4, seats: 1, straddles: true, byLot: true }],
    toss: ["e"],
  },
  {
    name: "top 4, 3-way at 3rd-5th: pick 2 of 3",
    rows: table(["a", "b", "f", "d", "c", "e"], ["f", "d", "c"]),
    q: 4,
    want: [{ entrantIds: ["c", "d", "f"], ranked: ["f", "d", "c"], place: 3, seats: 2, straddles: true, byLot: true }],
    toss: ["f", "d"],
  },
  {
    name: "top 4, a class among the qualifiers AND one across the cut: both reported, one open",
    rows: table(["b", "a", "c", "f", "d", "e"], ["b", "a"], ["f", "d"]),
    q: 4,
    want: [
      { entrantIds: ["a", "b"], ranked: ["b", "a"], place: 1, seats: 2, straddles: false, byLot: true },
      { entrantIds: ["d", "f"], ranked: ["f", "d"], place: 4, seats: 1, straddles: true, byLot: true },
    ],
    toss: ["f"],
  },
  {
    name: "a level table (every row one class), top 2 of 4: pick 2 of 4",
    rows: table(["d", "b", "c", "a"], ["d", "b", "c", "a"]),
    q: 2,
    want: [{ entrantIds: ["a", "b", "c", "d"], ranked: ["d", "b", "c", "a"], place: 1, seats: 2, straddles: true, byLot: true }],
    toss: ["d", "b"],
  },
  {
    name: "top 4 of 4, all level: everyone goes through, ordered by the lot (case 2)",
    rows: table(["d", "c", "b", "a"], ["d", "c", "b", "a"]),
    q: 4,
    want: [{ entrantIds: ["a", "b", "c", "d"], ranked: ["d", "c", "b", "a"], place: 1, seats: 4, straddles: false, byLot: true }],
  },
];

describe("cutTies: case 1 (ask) vs case 2 (the lot) vs nothing (D4)", () => {
  it("the case table is the one pictured, and it holds every kind of answer (anti-vacuity)", () => {
    expect(CASES).toHaveLength(12);
    const kinds = {
      none: CASES.filter((c) => c.want.length === 0).length,
      open: CASES.filter((c) => c.want.some((t) => t.straddles)).length,
      lotOnly: CASES.filter((c) => c.want.some((t) => !t.straddles)).length,
    };
    expect(kinds).toEqual({ none: 3, open: 6, lotOnly: 4 });
    // Every open case carries the toss it pins.
    expect(CASES.filter((c) => c.toss !== undefined).length).toBe(kinds.open);
  });

  it.each(CASES)("$name", ({ rows, q, want, toss }) => {
    const frozen = deepFrozen(rows);
    expect(cutTies(frozen, q)).toEqual(want);
    // The input's order is not the table's: the same rows bottom-up answer the same.
    expect(cutTies([...frozen].reverse(), q)).toEqual(want);
    // A second call answers the same, and neither call touched the rows (frozen: a write would throw).
    expect(cutTies(frozen, q)).toEqual(want);

    const open = want.find((t) => t.straddles) ?? null;
    expect(openTie(cutTies(frozen, q))).toEqual(open);
    if (open === null) {
      expect(toss).toBeUndefined();
    } else {
      expect(tossThrough(open)).toEqual(toss);
      expect(toss).toHaveLength(open.seats);
    }
  });

  it("an edit that grows the class changes the open tie's key (its sorted entrantIds); an edit that breaks the tie closes it", () => {
    // Before: B and C level for 2nd. After a corrected result D joins them, level on everything.
    const before = openTie(cutTies(table(["a", "c", "b", "d"], ["c", "b"]), 2));
    const after = openTie(cutTies(table(["a", "d", "c", "b"], ["d", "c", "b"]), 2));
    expect(before?.entrantIds).toEqual(["b", "c"]);
    expect(after?.entrantIds).toEqual(["b", "c", "d"]);
    // And an edit that breaks the tie closes the question.
    expect(openTie(cutTies(table(["a", "c", "b", "d"]), 2))).toBeNull();
  });
});

describe("byLot: a class the lot ordered vs one the engine left in typing order (m1)", () => {
  /** `table`'s rows with every tied row's step set to `key` (the engine's `tieBreak.key` on a residual class), or only
   *  `only`'s. */
  const keyed = (rows: CutRow[], key: string, only?: string): CutRow[] =>
    rows.map((r) => (r.tieUnbroken && (only === undefined || r.entrantId === only) ? { ...r, tieKey: key } : r));

  it("a class ordered by the lot is byLot; the same class ordered by seed (no lot drawn) is not, straddling or all through", () => {
    const straddle = table(["a", "c", "b", "d"], ["c", "b"]);
    const allThrough = table(["b", "a", "c"], ["b", "a"]);
    expect(cutTies(straddle, 2).map((t) => t.byLot)).toEqual([true]);
    expect(cutTies(allThrough, 2).map((t) => t.byLot)).toEqual([true]);
    expect(cutTies(keyed(straddle, "seed"), 2)).toEqual([
      { entrantIds: ["b", "c"], ranked: ["c", "b"], place: 2, seats: 1, straddles: true, byLot: false },
    ]);
    expect(cutTies(keyed(allThrough, "seed"), 2)).toEqual([
      { entrantIds: ["a", "b"], ranked: ["b", "a"], place: 1, seats: 2, straddles: false, byLot: false },
    ]);
  });

  it("one member not ordered by the lot is enough to say no lot", () => {
    expect(cutTies(keyed(table(["d", "b", "c", "a"], ["d", "b", "c", "a"]), "seed", "c"), 2).map((t) => t.byLot)).toEqual([false]);
  });
});

describe("cutTies refuses a table the engine never stores (assumptions are guards)", () => {
  it("a class whose ranks are not consecutive (A 1st and C 3rd level, B 2nd between them)", () => {
    expect(() => cutTies(table(["a", "b", "c"], ["a", "c"]), 2)).toThrow(/a,c does not hold consecutive ranks/);
    // Interleaved classes are refused by the same guard, before any question of how many straddle.
    expect(() => cutTies(table(["a", "b", "c", "d"], ["a", "c"], ["b", "d"]), 2)).toThrow(/consecutive ranks/);
  });

  it("two classes across one cut line: only rows sharing a rank can make it, and it is a fault", () => {
    // A and B level at 2nd-3rd; C and D level at 2nd-3rd too (two rows share each rank). Both straddle the top-2 line.
    const rows: CutRow[] = [
      { entrantId: "x", rank: 1, tieUnbroken: false, tieWith: [], tieKey: null },
      { entrantId: "a", rank: 2, tieUnbroken: true, tieWith: ["b"], tieKey: "lots" },
      { entrantId: "b", rank: 3, tieUnbroken: true, tieWith: ["a"], tieKey: "lots" },
      { entrantId: "c", rank: 2, tieUnbroken: true, tieWith: ["d"], tieKey: "lots" },
      { entrantId: "d", rank: 3, tieUnbroken: true, tieWith: ["c"], tieKey: "lots" },
    ];
    expect(() => cutTies(rows, 2)).toThrow("quick match cut: two ties straddle one cut");
  });

  it("openTie on a hand-built list with two open ties: the same fault", () => {
    const t = (ids: string[], place: number): CutTie => ({ entrantIds: ids, ranked: ids, place, seats: 1, straddles: true, byLot: true });
    expect(() => openTie([t(["a", "c"], 1), t(["b", "d"], 2)])).toThrow("quick match cut: two ties straddle one cut");
    expect(openTie([]), "the empty list has no open tie").toBeNull();
  });

  it("a tied row naming an entrant with no row", () => {
    const rows = table(["a", "b", "c"], ["b", "c"]).map((r) => (r.entrantId === "b" ? { ...r, tieWith: ["c", "ghost"] } : r));
    expect(() => cutTies(rows, 2)).toThrow(/ghost/);
  });

  it("members that disagree on their class (B says A,B,C; A says A,B)", () => {
    const rows: CutRow[] = [
      { entrantId: "a", rank: 1, tieUnbroken: true, tieWith: ["b"], tieKey: "lots" },
      { entrantId: "b", rank: 2, tieUnbroken: true, tieWith: ["a", "c"], tieKey: "lots" },
      { entrantId: "c", rank: 3, tieUnbroken: true, tieWith: ["b"], tieKey: "lots" },
    ];
    expect(() => cutTies(rows, 2)).toThrow(/disagree/);
  });

  it("a class member that is not itself marked level (its class trace agrees; only the flag is missing)", () => {
    const rows = table(["a", "b", "c"], ["b", "c"]).map((r) => (r.entrantId === "c" ? { ...r, tieUnbroken: false } : r));
    expect(() => cutTies(rows, 2)).toThrow(/disagree/);
  });

  it("a tie of one (marked level, level with nobody)", () => {
    const rows = table(["a", "b", "c"]).map((r) => (r.entrantId === "b" ? { ...r, tieUnbroken: true, tieKey: "lots" } : r));
    expect(() => cutTies(rows, 2)).toThrow(/level with nobody/);
  });
});

describe("cutRowOf: the stored standings row, read", () => {
  const stored = (over: Partial<StandingsRow>): StandingsRow => ({
    entrantId: "a",
    played: 2,
    won: 1,
    drawn: 0,
    lost: 1,
    points: 3,
    metrics: {},
    ...over,
  });

  it("a row split by the lot: rank, level, its class and the step that ordered it", () => {
    expect(cutRowOf(stored({ rank: 2, tieUnbroken: true, tieBreak: { key: "lots", with: ["c", "b"] } }))).toEqual({
      entrantId: "a",
      rank: 2,
      tieUnbroken: true,
      tieWith: ["c", "b"],
      tieKey: "lots",
    });
  });

  it("a row with no tie trace: not level, level with nobody", () => {
    expect(cutRowOf(stored({ rank: 1 }))).toEqual({ entrantId: "a", rank: 1, tieUnbroken: false, tieWith: [], tieKey: null });
  });

  it("a row split by an ordinary step (points) is not level", () => {
    expect(cutRowOf(stored({ rank: 1, tieBreak: { key: "points", with: ["b"] } })).tieUnbroken).toBe(false);
  });

  it("a row with no rank is refused: the cut is read off ranks", () => {
    expect(() => cutRowOf(stored({}))).toThrow(/rank/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The engine's declarations, every offered sport (P8, Q1, the controller ruling)
// ---------------------------------------------------------------------------------------------------------------------

interface OfferJson {
  offered: { sport_key: string; variant_key: string }[];
}
const OFFERED = (offerJson as OfferJson).offered;
const OFFERED_SPORTS = [...new Set(OFFERED.map((o) => o.sport_key))];

function moduleOf(sportKey: string): AnySportModule {
  const mod = builtinModules.find((m) => m.key === sportKey);
  if (mod === undefined) throw new Error(`premise: the engine registers no sport "${sportKey}"`);
  return mod;
}
function cfgOf(mod: AnySportModule, variantKey: string): unknown {
  const declared = declaredCfgs(mod).find((c) => c.name === variantKey);
  if (declared === undefined) throw new Error(`premise: ${mod.key} declares no variant "${variantKey}"`);
  return declared.cfg;
}
const leagueDefault = (mod: AnySportModule, cfg: unknown): TiebreakerKey[] => mod.defaultTiebreakers("league", cfg as never);

describe("cutTiebreakers: the sport's default with no seed step, ending in the lot", () => {
  it("the empty list is refused: no lot to end in", () => {
    expect(() => cutTiebreakers([])).toThrow(/lots/);
  });

  it("a list whose last step is not the lot is refused (the toss reveals the lot, D5)", () => {
    expect(() => cutTiebreakers(["points", "seed"])).toThrow(/lots/);
    expect(() => cutTiebreakers(["points", "lots", "diff"])).toThrow(/lots/);
  });

  it("does not touch its input", () => {
    const sent: readonly TiebreakerKey[] = Object.freeze(["points", "seed", "lots"]);
    expect(cutTiebreakers(sent)).toEqual(["points", "lots"]);
    expect(sent).toEqual(["points", "seed", "lots"]);
  });

  it("every offered variant: the default ends in the lot, every variant of a sport shares one list, only tennis and ice hockey list the seed, and the cut's order is the default less every seed step, an order the engine accepts", () => {
    expect(OFFERED_SPORTS, "the offer's sports (deduped)").toHaveLength(9);
    // The count this sweep owes, from the engine: every variant the offered sports DECLARE. The probe offers each of
    // them today, so a variant the engine adds, or one the probe stops offering, moves this.
    const declaredVariants = OFFERED_SPORTS.reduce((n, k) => n + Object.keys(moduleOf(k).variants).length, 0);
    expect(OFFERED, "every declared variant of the offered sports is offered").toHaveLength(declaredVariants);
    const withSeed = new Set<string>();
    const listsBySport = new Map<string, Set<string>>();
    let checked = 0;
    for (const { sport_key, variant_key } of OFFERED) {
      const mod = moduleOf(sport_key);
      const cfg = cfgOf(mod, variant_key);
      const declared = leagueDefault(mod, cfg);
      expect(declared.at(-1), `${sport_key}/${variant_key}: the default list ends in the lot`).toBe("lots");
      if (declared.includes("seed")) withSeed.add(sport_key);
      listsBySport.set(sport_key, (listsBySport.get(sport_key) ?? new Set()).add(declared.join(",")));
      const cut = cutTiebreakers(declared);
      // The ruling's own words: every default step, in its order, except `seed`.
      expect(cut, `${sport_key}/${variant_key}`).toEqual(declared.filter((k) => k !== "seed"));
      expect(validateCascade(cut, { module: mod, cfg, stageKind: "league", crossGroup: false }), `${sport_key}/${variant_key}`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(declaredVariants);
    expect(checked).toBeGreaterThan(0);
    // One list per sport, whatever the variant: why the ranking sweep below may play one variant of each sport.
    expect([...listsBySport].filter(([, lists]) => lists.size !== 1).map(([k]) => k), "sports whose variants differ").toEqual([]);
    expect(listsBySport.size).toBe(OFFERED_SPORTS.length);
    // P8: the engine declares `seed` before `lots` for exactly these two. A change in the engine moves this pin.
    expect([...withSeed].sort()).toEqual(["icehockey", "tennis"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Once vs Twice, ranked by the engine, every offered sport: the cut sees the tie the sport's own fold leaves level
// ---------------------------------------------------------------------------------------------------------------------

/** One decided match of `mod` under `cfg`, as its fold paid it: the winner's and the loser's deltas (the engine's
 *  simulation plays it; a league of 3 has a decided match with a winner in every offered sport). */
function oneWin(mod: AnySportModule, cfg: unknown): { win: FixtureResult[0]; loss: FixtureResult[1] } {
  const sim = simulateDivision({ ...simOptionsFor(mod, "league", 7), cfg, entrantCount: 3 });
  const fx = sim.stages[0]?.fixtures.find((f) => f.status === "decided" && f.winner !== undefined && f.result !== undefined);
  if (fx?.result === undefined) throw new Error(`premise: ${mod.key}'s simulated league decided no match with a winner`);
  const [home, away] = fx.result;
  const win = fx.winner === home.entrantId ? home : away;
  const loss = win === home ? away : home;
  return { win, loss };
}

/** `winner` beat `loser` exactly as the simulated match was won: every win in a table identical, every loss too. */
const beat = (w: { win: FixtureResult[0]; loss: FixtureResult[1] }, winner: string, loser: string): FixtureResult => [
  { ...w.win, entrantId: winner, metrics: { ...w.win.metrics } },
  { ...w.loss, entrantId: loser, metrics: { ...w.loss.metrics } },
];

/** The table the engine ranks: seeds are the typing order (a quick match seeds its sides as typed, P8). */
function ranked(entrants: string[], results: FixtureResult[], cascade: readonly TiebreakerKey[]): CutRow[] {
  const seeds = new Map(entrants.map((id, i) => [id, i + 1] as const));
  const { rows } = rankStandings(foldResults(entrants, results), {
    cascade,
    results,
    seeds,
    rngSeed: 20261113,
    countedFixtures: results.length,
  });
  return rows.map(cutRowOf);
}

// One variant per sport: the declaration sweep above proves every variant of a sport shares its tiebreak list, and the
// list is all the ranking reads of the cfg here.
describe("Once and Twice through the engine's ranking, every offered sport (one variant each)", () => {
  it("Once, a circle (each beats the next): 3 level, pick 2 of 3; Twice, a 1-1 split behind a leader: 2 level for 2nd, pick 1 of 2; both by lot. Only a default with a seed step hides either. Every match Not played: all level, no lot", () => {
    let sports = 0;
    const hiders: string[] = [];
    for (const sport_key of OFFERED_SPORTS) {
      const mod = moduleOf(sport_key);
      const variant_key = OFFERED.find((o) => o.sport_key === sport_key)!.variant_key;
      const cfg = cfgOf(mod, variant_key);
      const declared = leagueDefault(mod, cfg);
      const cut = cutTiebreakers(declared);
      const w = oneWin(mod, cfg);
      expect(w.win.won, `premise: ${sport_key}'s winner won`).toBe(1);
      expect(w.loss.lost, `premise: ${sport_key}'s loser lost`).toBe(1);

      // Once: "kim" typed first, then "ann", "bo". Kim beats Ann, Ann beats Bo, Bo beats Kim.
      const sides = ["kim", "ann", "bo"];
      const once = [beat(w, "kim", "ann"), beat(w, "ann", "bo"), beat(w, "bo", "kim")];
      const onceRows = ranked(sides, once, cut);
      const onceOrder = [...onceRows].sort((a, b) => a.rank - b.rank).map((r) => r.entrantId);
      expect(cutTies(onceRows, 2), `${sport_key} Once`).toEqual([
        { entrantIds: ["ann", "bo", "kim"], ranked: onceOrder, place: 1, seats: 2, straddles: true, byLot: true },
      ]);
      expect(tossThrough(openTie(cutTies(onceRows, 2))!)).toEqual(onceOrder.slice(0, 2));

      // Twice: Max beats both twice; Ann and Bo win one each against the other.
      const twiceSides = ["max", "ann", "bo"];
      const twice = [
        beat(w, "max", "ann"), beat(w, "max", "ann"), beat(w, "max", "bo"), beat(w, "max", "bo"),
        beat(w, "ann", "bo"), beat(w, "bo", "ann"),
      ];
      const twiceRows = ranked(twiceSides, twice, cut);
      const twiceOrder = [...twiceRows].sort((a, b) => a.rank - b.rank).map((r) => r.entrantId);
      expect(twiceOrder[0], `${sport_key} Twice: four wins of four lead`).toBe("max");
      expect(cutTies(twiceRows, 2), `${sport_key} Twice`).toEqual([
        { entrantIds: ["ann", "bo"], ranked: twiceOrder.slice(1), place: 2, seats: 1, straddles: true, byLot: true },
      ]);

      // Every match Not played: the engine draws no lot on a table with no counted match (its anti-goal 3) and leaves
      // the class in seed order, the typing order. The cut still asks (nobody is silently through), but not by lot.
      const empty = ranked(sides, [], cut);
      expect(cutTies(empty, 2), `${sport_key} nothing played`).toEqual([
        { entrantIds: ["ann", "bo", "kim"], ranked: sides, place: 1, seats: 2, straddles: true, byLot: false },
      ]);

      // The witness: under the declared default, a seed step separates the level sides by typing order and the cut
      // sees nothing; every other sport's default already reaches the lot, so it reports the same ties.
      const hidden = declared.includes("seed");
      expect(cutTies(ranked(sides, once, declared), 2).length, `${sport_key} Once, declared default`).toBe(hidden ? 0 : 1);
      expect(cutTies(ranked(twiceSides, twice, declared), 2).length, `${sport_key} Twice, declared default`).toBe(hidden ? 0 : 1);
      if (hidden) hiders.push(sport_key);
      sports++;
    }
    expect(sports).toBe(9);
    expect(hiders.sort()).toEqual(["icehockey", "tennis"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The engine premise on a real league (plan Step 2): D3 and D5 stand on it
// ---------------------------------------------------------------------------------------------------------------------

const created: string[] = [];
afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  for (const id of created) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the stored lot on a real league (plan T2 Step 2)", () => {
  it("a circle under Once through the real write path: all three level to the lot on the ACTIVE stage; that order = the order after completeStage = the stored draw; the cut asks pick 2 of 3", async () => {
    // single-sport: chess, so the test picks each winner (a resignation decides the game for the other side, the rulebook); a rally sport's walk picks one the test cannot steer.
    const chess = (await listQuickMatchSports()).find((s) => s.sport_key === "boardgame");
    expect(chess, "premise: chess is offered").toBeDefined();
    const out = await createQuickMatch(
      CreateQuickMatch.parse({
        name: `QM cut ${randomUUID().slice(0, 8)}`,
        sport_key: "boardgame",
        variant_key: chess!.variants[0]!.variant_key,
        kind: chess!.kinds.at(-1)!,
        format: "league",
        sides: ["Asha", "Ben", "Cleo"],
        plays: 1,
      }),
      { visitorHash: hashVisitorKey(mintVisitorKey()), mailAllowed: async () => true },
    );
    created.push(out.competitionId);
    const stages = await sql<{ id: string; status: string }[]>`
      select id, status from stages where division_id = ${out.divisionId} order by seq`;
    expect(stages, "premise: a league is one stage").toHaveLength(1);
    const stageId = stages[0]!.id;
    const fixtures = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stageId} order by round_no, fixture_no`;
    expect(fixtures, "premise: a round robin of 3 is 3·2/2 matches").toHaveLength(3);
    const ids = [...new Set(fixtures.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))].sort();
    expect(ids).toHaveLength(3);

    // The circle: ids[0] beats ids[1], ids[1] beats ids[2], ids[2] beats ids[0].
    const pair = (x: string, y: string) => [x, y].sort().join("|");
    const winnerOf = new Map([
      [pair(ids[0]!, ids[1]!), ids[0]!],
      [pair(ids[1]!, ids[2]!), ids[1]!],
      [pair(ids[0]!, ids[2]!), ids[2]!],
    ]);
    for (const f of fixtures) {
      const winner = winnerOf.get(pair(f.home_entrant_id, f.away_entrant_id))!;
      await scoreEvent(systemAuth(), f.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(systemAuth(), f.id, { expected_seq: 1, type: "boardgame.result", payload: { winner, method: "resign" } });
      const [row] = await sql<{ winner: string | null }[]>`select outcome->>'winner' as winner from fixtures where id = ${f.id}`;
      expect(row?.winner, "premise: the resignation decided the game").toBe(winner);
    }

    const byRank = (rows: StandingsRow[]) => [...rows].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)).map((r) => r.entrantId);
    const live = (await getStandings(systemAuth(), stageId)).rows as StandingsRow[];
    expect(live).toHaveLength(3);
    for (const r of live) {
      expect(r.tieUnbroken, `${r.entrantId}: level on every step`).toBe(true);
      expect(r.tieBreak?.key, `${r.entrantId}: ordered by the lot`).toBe("lots");
      expect([...(r.tieBreak?.with ?? [])].sort()).toEqual(ids.filter((id) => id !== r.entrantId));
    }
    const liveOrder = byRank(live);
    const [{ status: liveStatus } = { status: "" }] = await sql<{ status: string }[]>`select status from stages where id = ${stageId}`;
    expect(liveStatus, "premise: read while the stage is ACTIVE").toBe("active");

    await completeStage(systemAuth(), stageId, { publish: false });
    const done = (await getStandings(systemAuth(), stageId)).rows as StandingsRow[];
    expect(byRank(done), "the live order is the completed order (D3: the question is asked before the league completes)").toEqual(liveOrder);
    const draws = await sql<{ drawn_order: string[] }[]>`
      select drawn_order from stage_lots_draws where stage_id = ${stageId} and superseded_at is null`;
    expect(draws, "one live draw for the one class").toHaveLength(1);
    expect(draws[0]!.drawn_order, "and it is the order the guests saw (D5: the toss reveals it)").toEqual(liveOrder);

    // The seam: the stored rows, read by cutRowOf, give the guests' question.
    const ties = cutTies(done.map(cutRowOf), 2);
    expect(ties).toEqual([{ entrantIds: ids, ranked: liveOrder, place: 1, seats: 2, straddles: true, byLot: true }]);
    expect(tossThrough(ties[0]!)).toEqual(liveOrder.slice(0, 2));
  }, 60_000);
});
