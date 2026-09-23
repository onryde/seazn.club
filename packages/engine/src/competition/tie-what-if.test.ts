// Tie-break what-if (spec 2026-09-22 §3.4, R5; controller rulings OQ1/M6/M11).
//
// Expected margins come from the ENGINE'S OWN comparator: `ahead()` plays the
// row ONE more match of its average size with net margin m (own − opponent),
// leaves the rival as it is, ranks the two with `rankStandings`, and a target
// m must put the row strictly ahead while m − 1 must not. Every ledger is
// scaled by 2·played so the hypothetical one stays integral (compareRatio uses
// BigInt, and an average match can hold half a goal).
//
// Each key has a case whose answer is neither the average match size nor 1
// (the two constants a lazy formula lands on). The module cases read the
// cascade from `defaultTiebreakers` and the skip from `matchPointsBounds`.
//
// Mutants (swept 2026-09-23, killers named in the task-3 report): floorDiv →
// Math.round / Math.ceil; the `+ 1` dropped; rw/rl swapped; the rule test
// `>` → `>=` (boundary cases); the safe test `<=` → `<`; tieDecidingKey
// reading cascade[0], ignoring winsOnly, skipping more than `wins`, or not
// requiring `points` first; game_ratio / board_ratio dropped from the keys.
import { describe, expect, it } from "vitest";
import type { TiebreakerKey } from "../sport/module.ts";
import { badminton } from "../sports/setbased/badminton.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";
import { carrom } from "../sports/carrom/index.ts";
import type { StandingsRow } from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";
import { tieDecidingKey, tieKeyValue, tieWhatIf } from "./tie-what-if.ts";

const row = (id: string, played: number, metrics: Record<string, number>, won = 0): StandingsRow => ({
  entrantId: id, played, won, drawn: 0, lost: 0, points: 6, metrics,
});

const ONLY_WINS = { winsOnly: true } as const;
const NOT_ONLY_WINS = { winsOnly: false } as const;

// The ledger each ratio comparator reads (tiebreakers.ts COMPARATORS). If a
// pair here were wrong, `ahead()` would rank on an empty ledger and the
// oracle assertions below would fail — the map checks itself.
const LEDGER = {
  set_ratio: ["sets_won", "sets_lost"],
  game_ratio: ["games_won", "games_lost"],
  board_ratio: ["boards_won", "boards_lost"],
  point_ratio: ["points_won", "points_lost"],
} as const;
type RatioKey = keyof typeof LEDGER;

/** Is `me` strictly ahead of `rival` on `cascade` after one more average-size
 *  match with net margin `m`, per the engine? `m` may be fractional (a whole
 *  average match); p·m must be an integer. */
function ahead(
  me: StandingsRow,
  rival: StandingsRow,
  key: RatioKey | "diff" | "for",
  m: number,
  cascade: readonly TiebreakerKey[] = [key],
): boolean {
  const p = me.played;
  const k = 2 * p;
  const scaled = (r: StandingsRow) =>
    Object.fromEntries(Object.entries(r.metrics).map(([name, v]) => [name, k * v])) as Record<string, number>;
  const mine = scaled(me);
  if (key === "diff" || key === "for") {
    const f = me.metrics.gf!;
    const a = me.metrics.ga!;
    mine.gf = k * f + (f + a) + p * m;
    mine.ga = k * a + (f + a) - p * m;
    mine.gd = mine.gf - mine.ga;
  } else {
    const [wk, lk] = LEDGER[key];
    const w = me.metrics[wk] ?? 0;
    const l = me.metrics[lk] ?? 0;
    mine[wk] = k * w + (w + l) + p * m;
    mine[lk] = k * l + (w + l) - p * m;
  }
  const ranked = rankStandings([{ ...me, metrics: mine }, { ...rival, metrics: scaled(rival) }], { cascade }).rows;
  return ranked[0]!.entrantId === me.entrantId && ranked[0]!.tieUnbroken !== true;
}

/** A target's two oracle legs: m is enough, m − 1 is not. */
function expectTightTarget(me: StandingsRow, rv: StandingsRow, key: RatioKey | "diff" | "for", m: number) {
  expect(ahead(me, rv, key, m), `m = ${m} puts the row ahead`).toBe(true);
  expect(ahead(me, rv, key, m - 1), `m − 1 = ${m - 1} does not`).toBe(false);
}

describe("tieDecidingKey", () => {
  it("states the empty cases first: no cascade, no `points`, nothing after it, `points` not the primary key", () => {
    expect(tieDecidingKey([], ONLY_WINS)).toBeNull();
    expect(tieDecidingKey(["set_ratio", "wins"], NOT_ONLY_WINS)).toBeNull();
    expect(tieDecidingKey(["points"], NOT_ONLY_WINS)).toBeNull();
    // Rows level on points are ordered by `wins` first here — the key after
    // `points` does not decide anything, so there is no rule to name.
    expect(tieDecidingKey(["wins", "points", "set_ratio"], NOT_ONLY_WINS)).toBeNull();
  });
  it("is the key right AFTER points, not the first key", () => {
    expect(tieDecidingKey(["points", "set_ratio", "wins"], NOT_ONLY_WINS)).toBe("set_ratio");
  });
  it("skips `wins` only when points come from wins alone (OQ1), and only `wins`", () => {
    expect(tieDecidingKey(["points", "wins", "set_ratio"], ONLY_WINS)).toBe("set_ratio");
    expect(tieDecidingKey(["points", "wins", "set_ratio"], NOT_ONLY_WINS)).toBe("wins");
    expect(tieDecidingKey(["points", "wins"], ONLY_WINS)).toBeNull();
    expect(tieDecidingKey(["points", "h2h_points", "set_ratio"], ONLY_WINS)).toBe("h2h_points");
  });
});

describe("tieWhatIf — the cascade and the skip read off real modules", () => {
  // Badminton pays 2 for every win and 0 otherwise, so rows level on points
  // are level on wins: the target lands on set_ratio, the next key.
  it("badminton default cascade: `wins` is skipped and the target is on set ratio", () => {
    const b = badminton.matchPointsBounds(badminton.configSchema.parse({}));
    expect(b.winsOnly).toBe(true);
    const me = { ...row("me", 3, { sets_won: 5, sets_lost: 3 }, 2), points: 2 * b.winFloor };
    const rv = { ...row("rv", 3, { sets_won: 4, sets_lost: 2 }, 2), points: 2 * b.winFloor };
    expect(tieWhatIf(me, rv, badminton.defaultTiebreakers, { winsOnly: b.winsOnly })).toEqual({
      kind: "target",
      key: "set_ratio",
      margin: 2,
    });
    expectTightTarget(me, rv, "set_ratio", 2);
    // The same answer through the FULL default cascade, `wins` included.
    expect(ahead(me, rv, "set_ratio", 2, badminton.defaultTiebreakers)).toBe(true);
    // The differential: without the skip, `wins` decides and there is no target.
    expect(tieWhatIf(me, rv, badminton.defaultTiebreakers, NOT_ONLY_WINS)).toEqual({
      kind: "rule",
      key: "wins",
      mine: "2",
      theirs: "2",
    });
  });
  // Interpretation (task-3 report): the deciding key is the cascade's, not
  // "the first key the two rows differ on today". Level on sets NOW, the next
  // match still moves the set ratio, so the target stays on set_ratio; point
  // ratio decides only if the sets END level (m − 1 here).
  it("badminton, sets level now: the target stays on set ratio; point ratio decides only if the sets end level", () => {
    const b = badminton.matchPointsBounds(badminton.configSchema.parse({}));
    const me = { ...row("me", 3, { sets_won: 4, sets_lost: 4, points_won: 150, points_lost: 140 }, 2), points: 4 };
    const rv = { ...row("rv", 3, { sets_won: 3, sets_lost: 3, points_won: 120, points_lost: 125 }, 2), points: 4 };
    expect(tieWhatIf(me, rv, badminton.defaultTiebreakers, { winsOnly: b.winsOnly })).toEqual({
      kind: "target",
      key: "set_ratio",
      margin: 1,
    });
    expectTightTarget(me, rv, "set_ratio", 1);
    // At m − 1 = 0 the set ratios end exactly level, and the engine's own
    // cascade hands the pair to point_ratio.
    const flat = rankStandings(
      [
        { ...me, metrics: { ...me.metrics, sets_won: 5, sets_lost: 5 } },
        rv,
      ],
      { cascade: badminton.defaultTiebreakers },
    ).rows;
    expect(flat[0]!.tieBreak?.key).toBe("point_ratio");
  });
  // Volleyball's 3-2 win pays 2 and its 2-3 loss pays 1, so rows level on
  // points can differ on wins: `wins` stays the deciding key, rule only.
  it("volleyball default cascade: `wins` decides, so no target — the rule and both win counts", () => {
    const b = volleyball.matchPointsBounds(volleyball.configSchema.parse({}));
    expect(b.winsOnly).toBe(false);
    const me = row("me", 3, { sets_won: 9, sets_lost: 6 }, 3); // three 3-2 wins
    const rv = row("rv", 3, { sets_won: 6, sets_lost: 3 }, 2); // 3-0, 3-0, 0-3
    expect(tieWhatIf(me, rv, volleyball.defaultTiebreakers, { winsOnly: b.winsOnly })).toEqual({
      kind: "rule",
      key: "wins",
      mine: "3",
      theirs: "2",
    });
  });
  it("carrom default cascade: no draws, but a no-result pays — `wins` still decides", () => {
    const cfg = carrom.configSchema.parse({});
    const b = carrom.matchPointsBounds(cfg);
    expect(carrom.supportsDraws(cfg, "league")).toBe(false);
    const got = tieWhatIf(row("me", 2, { boards_won: 9, boards_lost: 4 }, 1), row("rv", 2, { boards_won: 8, boards_lost: 2 }, 2), carrom.defaultTiebreakers, { winsOnly: b.winsOnly });
    expect(got).toEqual({ kind: "rule", key: "wins", mine: "1", theirs: "2" });
  });
});

describe("tieWhatIf — ratio keys", () => {
  it("A: set ratio — margin 4, not the match size 5, not 1", () => {
    const me = row("me", 4, { sets_won: 12, sets_lost: 8 });
    const rv = row("rv", 4, { sets_won: 11, sets_lost: 6 });
    expect(tieWhatIf(me, rv, ["points", "set_ratio"], ONLY_WINS)).toEqual({ kind: "target", key: "set_ratio", margin: 4 });
    expectTightTarget(me, rv, "set_ratio", 4);
  });
  it("C: already ahead — 'lose by no more than 1' is a negative margin", () => {
    const me = row("me", 3, { points_won: 6, points_lost: 3 });
    const rv = row("rv", 3, { points_won: 4, points_lost: 3 });
    expect(tieWhatIf(me, rv, ["points", "point_ratio"], ONLY_WINS)).toEqual({ kind: "target", key: "point_ratio", margin: -1 });
    expectTightTarget(me, rv, "point_ratio", -1);
  });
  // m = 9 lands EXACTLY level with the rival (132/72 = 22/12), so the strict
  // "+ 1" is what makes it 10 — neither the average match (17) nor 1.
  it("game ratio: margin 10 — an exact tie at 9 is not ahead", () => {
    const me = row("me", 2, { games_won: 20, games_lost: 14 });
    const rv = row("rv", 2, { games_won: 22, games_lost: 12 });
    expect(tieWhatIf(me, rv, ["points", "game_ratio"], ONLY_WINS)).toEqual({ kind: "target", key: "game_ratio", margin: 10 });
    expectTightTarget(me, rv, "game_ratio", 10);
  });
  it("board ratio: margin 2 on an average match of 11/3 boards", () => {
    const me = row("me", 3, { boards_won: 7, boards_lost: 4 });
    const rv = row("rv", 3, { boards_won: 6, boards_lost: 3 });
    expect(tieWhatIf(me, rv, ["points", "board_ratio"], ONLY_WINS)).toEqual({ kind: "target", key: "board_ratio", margin: 2 });
    expectTightTarget(me, rv, "board_ratio", 2);
  });
  it("a margin larger than an average match → rule only, with both values", () => {
    const me = row("me", 4, { sets_won: 5, sets_lost: 3 }); // average match 2 sets; needs 4
    const rv = row("rv", 4, { sets_won: 6, sets_lost: 2 });
    expect(tieWhatIf(me, rv, ["points", "set_ratio"], ONLY_WINS)).toEqual({ kind: "rule", key: "set_ratio", mine: "1.67", theirs: "3.00" });
    expect(ahead(me, rv, "set_ratio", 2)).toBe(false); // even a whole average match (+2) is not enough
  });
  it("a rival with an unbeaten ratio (x/0) → rule only", () => {
    const got = tieWhatIf(row("me", 2, { sets_won: 4, sets_lost: 2 }), row("rv", 2, { sets_won: 4, sets_lost: 0 }), ["points", "set_ratio"], ONLY_WINS);
    expect(got).toEqual({ kind: "rule", key: "set_ratio", mine: "2.00", theirs: "∞" });
  });
  it("no matches played → rule only (a ledger carried in at played 0 included)", () => {
    expect(tieWhatIf(row("me", 0, {}), row("rv", 1, { sets_won: 2, sets_lost: 0 }), ["points", "set_ratio"], ONLY_WINS)?.kind).toBe("rule");
    expect(tieWhatIf(row("me", 0, { sets_won: 2, sets_lost: 1 }), row("rv", 1, { sets_won: 2, sets_lost: 1 }), ["points", "set_ratio"], ONLY_WINS))
      .toEqual({ kind: "rule", key: "set_ratio", mine: "2.00", theirs: "2.00" });
  });
  it("a rival with no ratio ledger at all (0/0) → rule only, never a NaN margin", () => {
    expect(tieWhatIf(row("me", 2, { sets_won: 3, sets_lost: 2 }), row("rv", 2, {}), ["points", "set_ratio"], ONLY_WINS))
      .toEqual({ kind: "rule", key: "set_ratio", mine: "1.50", theirs: "—" });
  });
  it("far ahead: losing by a whole average match still keeps the lead → safe", () => {
    const me = row("me", 2, { points_won: 100, points_lost: 10 });
    const rv = row("rv", 2, { points_won: 50, points_lost: 50 });
    expect(tieWhatIf(me, rv, ["points", "point_ratio"], ONLY_WINS)).toEqual({ kind: "safe", key: "point_ratio" });
    expect(ahead(me, rv, "point_ratio", -55)).toBe(true); // −(average match) = −110/2
  });
});

describe("tieWhatIf — diff and for", () => {
  it("diff: need rgd − gd + 1", () => {
    const me = row("me", 4, { gf: 8, ga: 6, gd: 2 });
    const rv = row("rv", 4, { gf: 9, ga: 5, gd: 4 });
    expect(tieWhatIf(me, rv, ["points", "diff"], ONLY_WINS)).toEqual({ kind: "target", key: "diff", margin: 3 });
    expectTightTarget(me, rv, "diff", 3);
  });
  it("D: goals scored — margin −1 on a match size of 8", () => {
    const me = row("me", 4, { gf: 20, ga: 12, gd: 8 });
    const rv = row("rv", 4, { gf: 23, ga: 10, gd: 13 });
    expect(tieWhatIf(me, rv, ["points", "for"], ONLY_WINS)).toEqual({ kind: "target", key: "for", margin: -1 });
    expectTightTarget(me, rv, "for", -1);
  });
  // M6 boundaries: margin·played lands EXACTLY on ± the match size.
  it("boundary: the margin is exactly one whole average match (2·2 = 4) → still a target", () => {
    const me = row("me", 2, { gf: 4, ga: 0, gd: 4 });
    const rv = row("rv", 2, { gf: 5, ga: 0, gd: 5 });
    expect(tieWhatIf(me, rv, ["points", "diff"], ONLY_WINS)).toEqual({ kind: "target", key: "diff", margin: 2 });
    expectTightTarget(me, rv, "diff", 2);
  });
  it("boundary: losing by exactly one whole average match (−3·2 = −6) still keeps the lead → safe", () => {
    const me = row("me", 2, { gf: 6, ga: 0, gd: 6 });
    const rv = row("rv", 2, { gf: 2, ga: 0, gd: 2 });
    expect(tieWhatIf(me, rv, ["points", "diff"], ONLY_WINS)).toEqual({ kind: "safe", key: "diff" });
    expect(ahead(me, rv, "diff", -3)).toBe(true);
  });
});

describe("tieWhatIf — diff and for with nothing to reason from", () => {
  it("a missing for/against, difference or rival figure → rule only, never a NaN target", () => {
    const cascadeDiff: TiebreakerKey[] = ["points", "diff"];
    expect(tieWhatIf(row("me", 2, { gd: 1 }), row("rv", 2, { gf: 4, ga: 2, gd: 2 }), cascadeDiff, ONLY_WINS))
      .toEqual({ kind: "rule", key: "diff", mine: "+1", theirs: "+2" });
    expect(tieWhatIf(row("me", 2, { gf: 3, ga: 2 }), row("rv", 2, { gf: 4, ga: 2, gd: 2 }), cascadeDiff, ONLY_WINS))
      .toEqual({ kind: "rule", key: "diff", mine: null, theirs: "+2" });
    expect(tieWhatIf(row("me", 2, { gf: 3, ga: 2, gd: 1 }), row("rv", 2, {}), ["points", "for"], ONLY_WINS))
      .toEqual({ kind: "rule", key: "for", mine: "3", theirs: null });
  });
  it("every match goalless (average match size 0) → rule only, not 'safe' on a match that holds nothing", () => {
    expect(tieWhatIf(row("me", 2, { gf: 0, ga: 0, gd: 0 }), row("rv", 2, { gf: 1, ga: 3, gd: -2 }), ["points", "diff"], ONLY_WINS))
      .toEqual({ kind: "rule", key: "diff", mine: "0", theirs: "-2" });
  });
});

describe("tieWhatIf — rules that never get a target (R5)", () => {
  const keys: TiebreakerKey[] = [
    "h2h_points", "h2h_diff", "h2h_for", "direct", "buchholz", "buchholz_cut1", "sberger", "nrr", "fair_play", "seed", "lots",
  ];
  for (const key of keys) {
    it(`${key} → rule only`, () => {
      const got = tieWhatIf(row("me", 2, { buchholz: 5 }, 2), row("rv", 2, { buchholz: 6 }, 1), ["points", key], ONLY_WINS);
      expect(got?.kind).toBe("rule");
      expect(got?.key).toBe(key);
    });
  }
  it("wins, where it separates → rule with both win counts", () => {
    const got = tieWhatIf(row("me", 2, {}, 2), row("rv", 2, {}, 1), ["points", "wins"], NOT_ONLY_WINS);
    expect(got).toEqual({ kind: "rule", key: "wins", mine: "2", theirs: "1" });
  });
  it("no deciding key → null, not a rule", () => {
    expect(tieWhatIf(row("me", 2, {}, 2), row("rv", 2, {}, 1), ["points", "wins"], ONLY_WINS)).toBeNull();
  });
});

describe("tieKeyValue", () => {
  it("Buchholz prints through derivedMetricText, head-to-head has none", () => {
    expect(tieKeyValue(row("me", 2, { buchholz: 5.5 }), "buchholz")).toBe("5½");
    expect(tieKeyValue(row("me", 2, {}), "h2h_points")).toBeNull();
  });
  it("game ratio has its own text (derivedMetricText has no game_ratio case)", () => {
    expect(tieKeyValue(row("me", 2, { games_won: 20, games_lost: 14 }), "game_ratio")).toBe("1.43");
    expect(tieKeyValue(row("me", 2, { games_won: 6, games_lost: 0 }), "game_ratio")).toBe("∞");
  });
  it("difference is signed, goals scored plain, wins the count", () => {
    expect(tieKeyValue(row("me", 2, { gd: 2 }), "diff")).toBe("+2");
    expect(tieKeyValue(row("me", 2, { gd: -1 }), "diff")).toBe("-1");
    expect(tieKeyValue(row("me", 2, { gd: 0 }), "diff")).toBe("0");
    expect(tieKeyValue(row("me", 2, {}), "diff")).toBeNull();
    expect(tieKeyValue(row("me", 2, { gf: 20 }), "for")).toBe("20");
    expect(tieKeyValue(row("me", 2, {}, 3), "wins")).toBe("3");
  });
});
