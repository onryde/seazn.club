// Standings qualification status — spec 2026-09-22 §3 (R3: never wrong; R4: a
// tie at the line is never Through/Out).
//
// Bounds come from the generic module's own declaration (Task 1), never typed.
// The EMPTY and no-status cases are stated first. The R4 case is one where the
// wrong constant (`>` instead of `≥`) prints "Through" and the right one does not.
//
// Mutants killed — each applied ALONE and run against this file (re-run
// 2026-09-23 after review fix 1). Killers are test titles; "BF n" = the brute
// force red with n violations. Fix 1 added two negative-payout systems and a
// Fisher–Yates pairing, so these counts differ from the pre-flight port's.
//  (a) through `≥` → `>`          — "R4: a rival who can only DRAW LEVEL…", "a
//      withdrawn rival still counts…", "r = 0 while…", "is null for an open row
//      with no match left…", "a forfeit loss can drop you level…", BF 14 316
//  (b) out `>` → `≥`              — "Out after a loss needs lossCeil…", "a
//      Needs-help row gets one too…", "a forfeit loss can drop you level…", BF 18 719
//  (c) win_k `≥` → `>`            — "win_k for k > 1", "is computed for open rows
//      only…", "a Needs-help row gets one too…", "Win-k counts a forfeit loss…",
//      BF 11 123. NOT the R4 test: its k = 1 target (3W) no rival reaches.
//  (d) win_k target uses max, not winFloor — "Win-k counts a forfeit loss…",
//      BF 634 (only systems with winFloor < max can see it)
//  (e) through counts rivals' WORST, not best — "R4…", "win_k for k > 1", "a
//      withdrawn rival still counts…", "r = 0…", "is computed for open rows
//      only…", "is null for an open row…", BF 319 368. NOT "through when no rival
//      can reach": every rival's best AND worst sit below A's worst there.
//  (f) inactive rival not counted — "a withdrawn rival still counts…", BF 54 189
//  (g) ifYouLose `hi` uses min    — "Out after a loss needs lossCeil…", BF 525
//  (h) anyPlayed/complete guard dropped — each half alone reds its own test.
// The four `min` terms (review fix 1 — all four SURVIVED before it, since every
// hand table ran at min = 0 and the brute force at min ≥ 0):
//  worstCase's min — "a forfeit loss can drop you level…", BF 1 389 · myWorst's
//  min — same test, BF 236 · win_k's (r−k)·min — "Win-k counts a forfeit
//  loss…", BF 83 · ifYouLose `lo`'s min — "a forfeit loss can drop you
//  level…", BF 104.
// Beyond the brief's list (+ = a killer was ADDED for it):
//  through fully swapped BF 4 395 595 · through on own best BF 380 162 · out on
//  rival best vs own worst BF 3 218 531 · ifYouLose `lo` uses lossCeil BF 5 519
//  · win_k's non-wins at max BF 52 198 · myWorst from hi BF 5 519 · myBest from
//  lo BF 525 (each also by hand tests) · +win_k target from hi — "Win-k after a
//  loss counts from the loss's FLOOR…" (BF 937 before fix 1, 0 after it) ·
//  +ifYouLose with r = 0 — "is null for an open row with no match left…" ·
//  +needs_help not open — "a Needs-help row gets one too…" · +integer-cut guard
//  — "a cut that is not a whole number…" · +each malformed-input clause
//  (missing / non-finite / negative / fractional count, non-finite points,
//  withdrawn rows' count unread, their points read) — its own no-status test ·
//  +inactive row keeps its remaining — "a withdrawn rival is frozen even
//  when…" · +helper clamp and `?? 0` — "a missing or negative count reads as no
//  match left" · tieRival: no reverse / `i <= cut` — "below the line…";
//  +touching ranges `<` — "ranges that meet at one score…"; +missing-entrant
//  guards — "null for an entrant missing…"; +overlap from the wrong end —
//  "a rival whose range spans yours…".
import { describe, expect, it } from "vitest";
import { generic } from "../sports/generic/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import type { MatchPointsBounds } from "../sport/module.ts";
import { PointsRule, pointsRuleBounds } from "./points.ts";
import {
  bestCase,
  qualificationStatus,
  tieRival,
  worstCase,
  type QualificationInput,
  type QualRow,
  type QualStatus,
} from "./qualification.ts";

const GENERIC = generic.matchPointsBounds(
  generic.configSchema.parse({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false }),
);
const W = GENERIC.max; // one win, read from the module

function table(
  pts: Record<string, number>,
  opts: { r?: number | Record<string, number>; cut: number; inactive?: string[]; perMatch?: MatchPointsBounds; anyPlayed?: boolean; complete?: boolean },
): QualificationInput {
  const rows: QualRow[] = Object.entries(pts).map(([entrantId, points]) => ({
    entrantId, points, active: !(opts.inactive ?? []).includes(entrantId),
  }));
  const r = opts.r ?? 1;
  const remaining = new Map(rows.map((row) => [row.entrantId, typeof r === "number" ? r : (r[row.entrantId] ?? 0)]));
  return {
    rows, remaining, perMatch: opts.perMatch ?? GENERIC, cut: opts.cut,
    anyPlayed: opts.anyPlayed ?? true, complete: opts.complete ?? false,
  };
}
const statusOf = (input: QualificationInput, id: string) => qualificationStatus(input)?.get(id)?.status ?? null;

describe("no-status cases (stated first — an empty answer must not read as a status)", () => {
  it("no match played yet → null for the table", () => {
    expect(qualificationStatus(table({ A: 0, B: 0 }, { cut: 1, anyPlayed: false }))).toBeNull();
  });
  it("stage complete → null for the table", () => {
    expect(qualificationStatus(table({ A: 3 * W, B: 0 }, { cut: 1, complete: true }))).toBeNull();
  });
  it("cut < 1 or no rows → null", () => {
    expect(qualificationStatus(table({ A: W }, { cut: 0 }))).toBeNull();
    expect(qualificationStatus(table({}, { cut: 1 }))).toBeNull();
  });
  it("positive pair: the same table with a match played and not complete DOES produce statuses", () => {
    expect(qualificationStatus(table({ A: 3 * W, B: 0 }, { cut: 1 }))).not.toBeNull();
  });
  it("a withdrawn entrant's own row is null", () => {
    const res = qualificationStatus(table({ A: W, E: 3 * W }, { cut: 1, inactive: ["E"] }));
    expect(res?.get("E")).toBeNull();
    expect(res?.get("A")).not.toBeNull();
  });
  it("a cut that is not a whole number → null (no forecast from a malformed quota)", () => {
    // Same table as the positive pair above, which does produce statuses at cut 1.
    expect(qualificationStatus(table({ A: 3 * W, B: 0 }, { cut: 1.5 }))).toBeNull();
  });
  // Review fix 1 (controller ruling): malformed input fails CLOSED — the whole
  // table shows no status. Each base is the positive pair above (A 3W, B 0,
  // cut 1), which does. Read leniently, each of these could print a false
  // status: a missing count reads as "final", NaN as "never reaches", −1 as
  // points taken away (B final on W with −1 left: best W − W = 0 < A's W).
  it("an active row with no remaining count → null; a withdrawn row needs none", () => {
    const input = table({ A: 3 * W, B: 0 }, { cut: 1 });
    const remaining = new Map(input.remaining);
    remaining.delete("B");
    expect(qualificationStatus({ ...input, remaining })).toBeNull();
    // Positive pair: B withdrawn is frozen at its points, so its count is not read.
    const withdrawn = table({ A: 3 * W, B: 0 }, { cut: 1, inactive: ["B"] });
    const noCount = new Map(withdrawn.remaining);
    noCount.delete("B");
    expect(qualificationStatus({ ...withdrawn, remaining: noCount })?.get("A")).toEqual({
      status: { kind: "through" },
      ifYouLose: null,
    });
  });
  it("a non-finite remaining count on an active row → null", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(qualificationStatus(table({ A: 3 * W, B: 0 }, { cut: 1, r: { A: 1, B: bad } }))).toBeNull();
    }
  });
  it("a negative remaining count on an active row → null", () => {
    expect(qualificationStatus(table({ A: W, B: W }, { cut: 1, r: { A: 0, B: -1 } }))).toBeNull();
  });
  it("a fractional remaining count on an active row → null (a match count is whole)", () => {
    expect(qualificationStatus(table({ A: 3 * W, B: 0 }, { cut: 1, r: { A: 1, B: 0.5 } }))).toBeNull();
  });
  it("non-finite points on any row, a withdrawn rival's included → null", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(qualificationStatus(table({ A: 3 * W, B: bad }, { cut: 1 }))).toBeNull();
      // A withdrawn rival on NaN would never "reach" anyone: a false Through.
      expect(qualificationStatus(table({ A: 0, B: bad }, { cut: 1, inactive: ["B"] }))).toBeNull();
    }
  });
});

describe("statuses on hand-built tables (generic 3/1/0, derived)", () => {
  it("through when no rival can reach you", () => {
    // A = 3W, rivals' best = W + W, W + W, 0 + W — all below A's worst (3W).
    expect(statusOf(table({ A: 3 * W, B: W, C: W, D: 0 }, { cut: 2 }), "A")).toEqual({ kind: "through" });
  });
  it("R4: a rival who can only DRAW LEVEL still blocks Through → Win and in", () => {
    // After 2 of 3 Swiss rounds: A 2W, B W, C W, D 0, one round left, top 2.
    // B's and C's best (2W) EQUALS A's worst (2W): with `>` A would be Through.
    const input = table({ A: 2 * W, B: W, C: W, D: 0 }, { cut: 2 });
    expect(statusOf(input, "A")).toEqual({ kind: "win_k", k: 1 });
  });
  it("out when N rivals are already beyond your best", () => {
    expect(statusOf(table({ A: 3 * W, B: W }, { cut: 1 }), "B")).toEqual({ kind: "out" });
  });
  it("win_k for k > 1", () => {
    // After round 1 of 3: A W, B W, C 0, D 0; two left, top 2. One win (2W) is
    // matched by three rivals' best; two wins (3W) only by B.
    expect(statusOf(table({ A: W, B: W, C: 0, D: 0 }, { cut: 2, r: 2 }), "A")).toEqual({ kind: "win_k", k: 2 });
  });
  it("needs help when even winning out is matched by N rivals", () => {
    expect(statusOf(table({ A: W, B: W, C: 0, D: 0 }, { cut: 2, r: 2 }), "C")).toEqual({ kind: "needs_help" });
  });
  it("a withdrawn rival still counts, frozen at its points", () => {
    // E (withdrawn, 3W) sits above A for good; with cut 2 only one place is left for A.
    const input = table({ A: 2 * W, B: W, E: 3 * W }, { cut: 2, inactive: ["E"] });
    expect(statusOf(input, "A")).toEqual({ kind: "win_k", k: 1 });
    // Positive pair: without E, A is through (B's best 2W ≥ 2W is one rival < 2).
    expect(statusOf(table({ A: 2 * W, B: W }, { cut: 2 }), "A")).toEqual({ kind: "through" });
  });
  it("r = 0 while the stage is still running: points are final for that row", () => {
    // cut 2: B (final 2W) and C (best W + W = 2W) both reach A's 2W, so not
    // Through (R4); nobody is beyond, so not Out; r = 0 gives no k, so Needs help.
    expect(statusOf(table({ A: 2 * W, B: 2 * W, C: W }, { cut: 2, r: { A: 0, B: 0, C: 1 } }), "A")).toEqual({ kind: "needs_help" });
    // Positive pair: once C cannot reach (C on 0, best W < 2W), A is Through.
    expect(statusOf(table({ A: 2 * W, B: 2 * W, C: 0 }, { cut: 2, r: { A: 0, B: 0, C: 1 } }), "A")).toEqual({ kind: "through" });
  });
  it("a withdrawn rival is frozen even when the remaining map still lists a match for it", () => {
    // cut 1: E (withdrawn, W) cannot reach A's final 2W. Counting E's listed
    // match would lift E's best to W + W = 2W, level with A, and block Through.
    expect(statusOf(table({ A: 2 * W, E: W }, { cut: 1, inactive: ["E"], r: { A: 0, E: 1 } }), "A")).toEqual({ kind: "through" });
  });
});

describe("if you lose", () => {
  it("is computed for open rows only, from your next match lost", () => {
    const res = qualificationStatus(table({ A: W, B: W, C: 0, D: 0 }, { cut: 2, r: 2 }));
    expect(res?.get("A")?.ifYouLose).toEqual({ kind: "needs_help" });
  });
  it("Out after a loss needs lossCeil — the right answer differs from min's", () => {
    // B has 0 and one match left; A is final on 1. Cut 1. If B loses:
    // generic loss pays 0 → B's best 0 < 1 → Out. Ice-hockey OT loss pays 1 →
    // B's best 1, not beyond → still open. Both bounds come from the modules.
    const hockey = icehockey.matchPointsBounds(icehockey.configSchema.parse({}));
    expect(hockey.lossCeil).toBeGreaterThan(GENERIC.lossCeil); // precondition of the differential
    const mk = (perMatch: MatchPointsBounds) =>
      table({ A: perMatch.lossCeil === 0 ? 1 : hockey.lossCeil, B: 0 }, { cut: 1, r: { A: 0, B: 1 }, perMatch });
    expect(qualificationStatus(mk(GENERIC))?.get("B")?.ifYouLose).toEqual({ kind: "out" });
    // Pinned to the true value: `.not.toEqual(out)` also passed on a null.
    expect(qualificationStatus(mk(hockey))?.get("B")?.ifYouLose).toEqual({ kind: "needs_help" });
  });
  it("is null for Through and Out rows", () => {
    const res = qualificationStatus(table({ A: 3 * W, B: 0 }, { cut: 1 }));
    expect(res?.get("A")?.ifYouLose).toBeNull();
    expect(res?.get("B")?.ifYouLose).toBeNull();
  });
  it("a Needs-help row gets one too — here a loss puts it Out", () => {
    // cut 1: A is final on 2W. B (W, one left) can only draw level by winning,
    // so it is not Win-and-in (R4) but Needs help; a loss leaves it on W < 2W.
    const res = qualificationStatus(table({ A: 2 * W, B: W }, { cut: 1, r: { A: 0, B: 1 } }));
    expect(res?.get("B")).toEqual({ status: { kind: "needs_help" }, ifYouLose: { kind: "out" } });
  });
  it("Win-k after a loss counts from the loss's FLOOR (min), not its ceiling (lossCeil)", () => {
    // Review fix 1: the brute force stopped reaching this case once its PRNG
    // sequence changed, so it is pinned here. Ice hockey: a regulation loss pays
    // min, an OT loss lossCeil. cut 1. A on 0 with two left; B final on exactly
    // A + min + winFloor — A after a regulation loss and then an OT win.
    const hockey = icehockey.matchPointsBounds(icehockey.configSchema.parse({}));
    expect(hockey.lossCeil).toBeGreaterThan(hockey.min); // precondition: the loss is not one number
    const res = qualificationStatus(
      table({ A: 0, B: hockey.min + hockey.winFloor }, { cut: 1, r: { A: 2, B: 0 }, perMatch: hockey }),
    );
    // Counting from lossCeil would say one win after the loss is enough; from
    // min, that win only draws A level with B (R4), so A needs help.
    expect(res?.get("A")?.ifYouLose).toEqual({ kind: "needs_help" });
  });
  it("is null for an open row with no match left to lose", () => {
    const res = qualificationStatus(table({ A: 2 * W, B: 2 * W, C: W }, { cut: 2, r: { A: 0, B: 0, C: 1 } }));
    expect(res?.get("A")).toEqual({ status: { kind: "needs_help" }, ifYouLose: null });
  });
});

describe("a points rule where a loss COSTS points (min < 0): every `min` term is load-bearing", () => {
  // Review fix 1. Bounds come from the rule itself (forfeit winner 2, loser −1),
  // never typed. Sport bounds clamp min ≤ 0 and every shipped cfg is
  // nonnegative, so every other hand table here runs at min = 0, where each
  // `min` term is zero and deleting it changes nothing. ZERO is that wrong
  // reading; each case asserts the right answer AND that ZERO gives another.
  const NEG = pointsRuleBounds(
    PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: -1 } }),
  );
  const ZERO: MatchPointsBounds = { ...NEG, min: 0 };
  it("a forfeit loss can drop you level: not Through, and the rival below is not Out", () => {
    expect(NEG.min).toBeLessThan(0); // precondition of the differential
    // cut 1. A on one win, one match left; B final on exactly A + min, so A's
    // worst (a forfeit loss) finishes level with B.
    const pts = { A: NEG.max, B: NEG.max + NEG.min };
    const r = { A: 1, B: 0 };
    const res = qualificationStatus(table(pts, { cut: 1, r, perMatch: NEG }));
    // A: own worst uses min (qualification.ts myWorst) → level with B → Win and in.
    // If A loses: `lo` uses min → A may finish on B's points → Needs help, not Through.
    expect(res?.get("A")).toEqual({ status: { kind: "win_k", k: 1 }, ifYouLose: { kind: "needs_help" } });
    // B: A's worst uses min (worstCase) → A may fall level → B is not Out.
    expect(res?.get("B")?.status).toEqual({ kind: "needs_help" });
    // The wrong constant: at min = 0, A is Through and B is Out.
    const wrong = qualificationStatus(table(pts, { cut: 1, r, perMatch: ZERO }));
    expect([wrong?.get("A")?.status, wrong?.get("B")?.status]).toEqual([{ kind: "through" }, { kind: "out" }]);
  });
  it("Win-k counts a forfeit loss in the matches you do not win", () => {
    expect(NEG.min).toBeLessThan(0);
    // cut 1. A on one win with two left; B final on A + winFloor + min — what A
    // has after one win and one forfeit loss. One win is therefore not enough
    // (level with B, R4); two are.
    const pts = { A: NEG.max, B: NEG.max + NEG.winFloor + NEG.min };
    const r = { A: 2, B: 0 };
    expect(statusOf(table(pts, { cut: 1, r, perMatch: NEG }), "A")).toEqual({ kind: "win_k", k: 2 });
    // The wrong constant: at min = 0 one win (A + winFloor) already clears B.
    expect(statusOf(table(pts, { cut: 1, r, perMatch: ZERO }), "A")).toEqual({ kind: "win_k", k: 1 });
  });
});

describe("tieRival — nearest entrant across the line who can finish level on points", () => {
  it("above the line: the first reachable row below it", () => {
    const input = table({ A: 2 * W, B: W, C: W, D: 0 }, { cut: 2 });
    expect(tieRival(input, ["A", "B", "C", "D"], "B")).toBe("C");
  });
  it("below the line: the nearest reachable row above it", () => {
    const input = table({ A: 2 * W, B: W, C: W, D: 0 }, { cut: 2 });
    expect(tieRival(input, ["A", "B", "C", "D"], "C")).toBe("B");
  });
  it("null when no one across the line can draw level", () => {
    const input = table({ A: 3 * W, B: 0 }, { cut: 1 });
    expect(tieRival(input, ["A", "B"], "A")).toBeNull();
  });
  it("ranges that meet at one score overlap — a tie reachable only there still counts", () => {
    // cut 1: A 2W..3W, B W..2W — both finish on 2W if A loses and B wins.
    const input = table({ A: 2 * W, B: W }, { cut: 1 });
    expect(tieRival(input, ["A", "B"], "A")).toBe("B");
  });
  it("a rival whose range spans yours on both sides is reachable", () => {
    // cut 1: B W..2W (one left); C 0..3W (three left) — below B's floor AND above its ceiling.
    const input = table({ B: W, C: 0 }, { cut: 1, r: { B: 1, C: 3 } });
    expect(tieRival(input, ["B", "C"], "B")).toBe("C");
  });
  it("null for an entrant missing from the ranked order or from the rows", () => {
    const input = table({ A: 2 * W, B: W, C: W, D: 0 }, { cut: 2 });
    expect(tieRival(input, ["A", "B", "D"], "C")).toBeNull(); // in the rows, not in the order
    expect(tieRival(input, ["A", "B", "C", "D", "X"], "X")).toBeNull(); // in the order, not in the rows
  });
});

describe("bestCase / worstCase — exported, and read by tieRival on input nothing validated", () => {
  // qualificationStatus refuses a missing or negative count (null table); the
  // helpers instead read one as "no match left", so tieRival never treats a
  // rival as losing points it never had.
  it("a missing or negative count reads as no match left", () => {
    const input = table({ A: W, B: W }, { cut: 1, r: { A: -1, B: 1 } });
    const remaining = new Map(input.remaining);
    remaining.delete("B");
    const [a, b] = input.rows;
    expect([bestCase(input, a!), worstCase(input, a!)]).toEqual([W, W]);
    expect([bestCase({ ...input, remaining }, b!), worstCase({ ...input, remaining }, b!)]).toEqual([W, W]);
    // Positive pair: a real count moves the best case by one win per match.
    expect(bestCase(input, b!)).toBe(2 * W);
  });
});

// Brute force (spec §6): ≤ 6 entrants, ≤ 2 rounds, byes, draws and multi-value
// wins. Enumerate EVERY outcome; every Through must be safe in all of them, every
// Out dead in all, every Win-k safe whenever the row wins ≥ k, and the same for
// the if-you-lose status over the outcomes where the row loses its first match.
// Bounds are computed from each system's own outcome list, the oracle's
// declaration. Deterministic PRNG so a red is reproducible.
describe("brute force — statuses hold over every real outcome", () => {
  type Sys = { dec: [number, number][]; draw: number | null; bye: number };
  const SYSTEMS: Sys[] = [
    { dec: [[3, 0]], draw: 1, bye: 3 },
    { dec: [[3, 0], [2, 1]], draw: null, bye: 3 }, // volleyball-shaped
    { dec: [[3, 0], [2, 1]], draw: 1, bye: 3 }, // ice-hockey-shaped
    { dec: [[2, 0]], draw: 1, bye: 2 },
    { dec: [[1, 0]], draw: 0.5, bye: 1 },
    { dec: [[2, 1]], draw: 1.5, bye: 2 }, // a loss that scores
    // Review fix 1: a loss that COSTS points (a PointsRule may set one — the
    // forfeit case in points.test.ts has loserPoints −1). With min ≥ 0 a
    // dropped `min` term only makes an answer more cautious, which a soundness
    // oracle cannot see; with min < 0 each one prints a false status.
    { dec: [[3, -1]], draw: 1, bye: 3 },
    { dec: [[3, 0], [2, -1]], draw: null, bye: 3 },
  ];
  // Measured 2026-09-23 (fix round 1, 8 systems, Fisher–Yates pairing): seed
  // 12345 × 20 000 trials enumerates exactly 8 677 941 (row, outcome) checks, of
  // which 3 349 014 also check the row's if-you-lose status. The seed is fixed
  // and nothing here depends on the engine's sort, so both counts are exact; any
  // drop means the enumeration shrank. Change the generator and re-measure both.
  const CHECKED_FLOOR = 8_677_941;
  const CHECKED_IF_LOSE_FLOOR = 3_349_014;
  const boundsOf = (s: Sys): MatchPointsBounds => {
    const all = [...s.dec.flat(), ...(s.draw === null ? [] : [s.draw]), s.bye];
    return {
      max: Math.max(...all),
      min: Math.min(...all),
      winFloor: Math.min(...s.dec.map((d) => d[0]), s.bye),
      lossCeil: Math.max(...s.dec.map((d) => d[1])),
    };
  };
  it("20 000 random tables", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const ri = (n: number) => Math.floor(rnd() * n);
    let checked = 0;
    let checkedIfLose = 0;
    // Violations are counted, not thrown: an `expect` per check (5.5M of them)
    // ran ~31 s against ~7 s counted. The first few are kept for the red message.
    let violations = 0;
    const sample: string[] = [];
    const fail = (what: string) => {
      violations++;
      if (sample.length < 5) sample.push(what);
    };
    for (let trial = 0; trial < 20_000; trial++) {
      const n = 2 + ri(5);
      const ids = Array.from({ length: n }, (_, k) => `e${k}`);
      const sys = SYSTEMS[ri(SYSTEMS.length)]!;
      const b = boundsOf(sys);
      const cut = 1 + ri(n - 1);
      const pts = new Map(ids.map((id) => [id, ri(3) * b.max + ri(2) * (sys.draw ?? 0)]));
      const active = new Map(ids.map((id) => [id, rnd() > 0.15]));
      type M = { a: string; b: string | null };
      const matches: M[] = [];
      for (let round = 0, rounds = ri(3); round < rounds; round++) {
        // Fisher–Yates on the seeded PRNG: `sort(() => rnd() - 0.5)` would tie
        // the pairing (and so the pinned counts) to V8's comparator call order.
        const pool = ids.filter((id) => active.get(id));
        for (let k = pool.length - 1; k > 0; k--) {
          const j = ri(k + 1);
          [pool[k], pool[j]] = [pool[j]!, pool[k]!];
        }
        while (pool.length >= 2) matches.push({ a: pool.pop()!, b: pool.pop()! });
        if (pool.length === 1) matches.push({ a: pool.pop()!, b: null });
      }
      const input: QualificationInput = {
        rows: ids.map((id) => ({ entrantId: id, points: pts.get(id)!, active: active.get(id)! })),
        remaining: new Map(ids.map((id) => [id, matches.filter((m) => m.a === id || m.b === id).length])),
        perMatch: b, cut, anyPlayed: true, complete: false,
      };
      const res = qualificationStatus(input)!;
      // enumerate outcomes: final points, wins, and "lost its first real match"
      type O = { p: Map<string, number>; w: Map<string, number>; lostFirst: Set<string> };
      const outs: O[] = [];
      const rec = (i: number, p: Map<string, number>, w: Map<string, number>, lost: Set<string>, seen: Set<string>) => {
        if (i === matches.length) return void outs.push({ p: new Map(p), w: new Map(w), lostFirst: new Set(lost) });
        const m = matches[i]!;
        const opts: [number, number, 0 | 1, 0 | 1][] = m.b === null
          ? [[sys.bye, 0, 1, 0]]
          : [
              ...sys.dec.map(([x, y]) => [x, y, 1, 0] as [number, number, 0 | 1, 0 | 1]),
              ...sys.dec.map(([x, y]) => [y, x, 0, 1] as [number, number, 0 | 1, 0 | 1]),
              ...(sys.draw === null ? [] : [[sys.draw, sys.draw, 0, 0] as [number, number, 0 | 1, 0 | 1]]),
            ];
        for (const [pa, pb, wa, wb] of opts) {
          const firstA = !seen.has(m.a), firstB = m.b !== null && !seen.has(m.b);
          const np = new Map(p), nw = new Map(w), nl = new Set(lost), ns = new Set(seen);
          np.set(m.a, np.get(m.a)! + pa); nw.set(m.a, nw.get(m.a)! + wa); ns.add(m.a);
          if (m.b !== null) { np.set(m.b, np.get(m.b)! + pb); nw.set(m.b, nw.get(m.b)! + wb); ns.add(m.b); }
          if (firstA && m.b !== null && wb === 1) nl.add(m.a);
          if (firstB && wa === 1) nl.add(m.b!);
          rec(i + 1, np, nw, nl, ns);
        }
      };
      rec(0, new Map(pts), new Map(ids.map((id) => [id, 0])), new Set(), new Set());
      for (const row of input.rows) {
        const r = res.get(row.entrantId);
        if (!row.active) {
          if (r !== null) fail(`trial ${trial} ${row.entrantId} withdrawn row has a status`);
          continue;
        }
        const firstIsBye = matches.find((m) => m.a === row.entrantId || m.b === row.entrantId)?.b === null;
        for (const o of outs) {
          const mine = o.p.get(row.entrantId)!;
          const others = ids.filter((x) => x !== row.entrantId).map((x) => o.p.get(x)!);
          const safe = others.filter((q) => q >= mine).length < cut;
          const dead = others.filter((q) => q > mine).length >= cut;
          const check = (s: QualStatus, where: string) => {
            if (s.kind === "through" && !safe) fail(`trial ${trial} ${row.entrantId}${where} through`);
            if (s.kind === "out" && !dead) fail(`trial ${trial} ${row.entrantId}${where} out`);
            if (s.kind === "win_k" && o.w.get(row.entrantId)! >= s.k && !safe) fail(`trial ${trial} ${row.entrantId}${where} win_${s.k}`);
          };
          check(r!.status, "");
          if (r!.ifYouLose && !firstIsBye && o.lostFirst.has(row.entrantId)) {
            check(r!.ifYouLose, " if-lose");
            checkedIfLose++;
          }
          checked++;
        }
      }
    }
    // One assertion over the whole run (review M5): the count says how wrong a
    // mutant is, the samples say where — both reproducible from the seed.
    expect(violations, `first violations: ${sample.join(" | ")}`).toBe(0);
    expect(checked).toBeGreaterThanOrEqual(CHECKED_FLOOR); // the enumeration actually ran
    expect(checkedIfLose).toBeGreaterThanOrEqual(CHECKED_IF_LOSE_FLOOR); // …and reached if-you-lose
  }, 60_000);
});
