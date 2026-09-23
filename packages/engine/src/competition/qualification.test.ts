// Standings qualification status — spec 2026-09-22 §3 (R3: never wrong; R4: a
// tie at the line is never Through/Out).
//
// Bounds come from the generic module's own declaration (Task 1), never typed.
// The EMPTY and no-status cases are stated first. The R4 case is one where the
// wrong constant (`>` instead of `≥`) prints "Through" and the right one does not.
//
// Mutants killed — each applied ALONE and run against this file (2026-09-23).
// Killers are test titles; "BF n" = the brute force red with n violations
// (the pre-flight port of this file counted the same n for a–g).
//  (a) through `≥` → `>`          — "R4: a rival who can only DRAW LEVEL…",
//      "a withdrawn rival still counts…", "r = 0 while…", BF 19 032
//  (b) out `>` → `≥`              — "Out after a loss needs lossCeil…", BF 18 090
//  (c) win_k `≥` → `>`            — "win_k for k > 1", "is computed for open rows
//      only…", BF 12 033. NOT the R4 test: its k = 1 target (3W) no rival reaches.
//  (d) win_k target uses max, not winFloor — BF 3 954 only. The volleyball- and
//      ice-hockey-shaped systems are the only ones here with winFloor < max.
//  (e) through counts rivals' WORST, not best — "R4…", "win_k for k > 1",
//      "a withdrawn rival still counts…", "r = 0…", "is computed for open rows
//      only…", BF 326 659. NOT "through when no rival can reach": there every
//      rival's best AND worst sit below A's worst, so the swap changes nothing.
//  (f) inactive rival not counted — "a withdrawn rival still counts…", BF 54 330
//  (g) ifYouLose `hi` uses min    — "Out after a loss needs lossCeil…", BF 44
//  (h) anyPlayed/complete guard dropped — "no match played yet…" and "stage
//      complete…"; each half dropped alone reds its own one.
// Beyond the brief's list (a killer was ADDED for those marked +):
//  through fully swapped (rival worst ≥ own best) BF 1 985 900 · through on own
//  best BF 400 392 · out on rival best vs own worst BF 2 432 159 · ifYouLose `lo`
//  uses lossCeil BF 9 631 · win_k's non-wins at max BF 54 111 · myWorst from hi
//  BF 8 694 · myBest from lo BF 44 · win_k target from hi BF 937 ·
//  +ifYouLose with r = 0 — "is null for an open row with no match left to lose" ·
//  +needs_help not open — "a Needs-help row gets one too…" · win_k not open /
//  every row open — the open-rows and Through/Out-rows if-you-lose tests ·
//  +integer-cut guard — "a cut that is not a whole number…" · +inactive row keeps
//  its remaining — "a withdrawn rival is frozen even when…" · +negative remaining
//  unclamped — "a negative remaining count…" · tieRival: no reverse / `i <= cut`
//  — "below the line…"; +touching ranges `<` — "ranges that meet at one score…";
//  +missing-entrant guards — "null for an entrant missing…"; +overlap from the
//  wrong end of the rival's range — "a rival whose range spans yours…".
import { describe, expect, it } from "vitest";
import { generic } from "../sports/generic/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import type { MatchPointsBounds } from "../sport/module.ts";
import {
  qualificationStatus,
  tieRival,
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
  it("a negative remaining count reads as no match left, never as points taken away", () => {
    // cut 1: B is final on W, level with A's final W, so A is not Through (R4).
    // Read literally, −1 match would drop B's best to W − W = 0: a false Through.
    expect(statusOf(table({ A: W, B: W }, { cut: 1, r: { A: 0, B: -1 } }), "A")).toEqual({ kind: "needs_help" });
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
    expect(qualificationStatus(mk(hockey))?.get("B")?.ifYouLose).not.toEqual({ kind: "out" });
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
  it("is null for an open row with no match left to lose", () => {
    const res = qualificationStatus(table({ A: 2 * W, B: 2 * W, C: W }, { cut: 2, r: { A: 0, B: 0, C: 1 } }));
    expect(res?.get("A")).toEqual({ status: { kind: "needs_help" }, ifYouLose: null });
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
  ];
  // Measured 2026-09-23: seed 12345 × 20 000 trials enumerates exactly 5 548 289
  // (row, outcome) checks, and the pre-flight port of this file counted the same.
  // The seed is fixed, so the count is exact; any drop means the enumeration
  // shrank. Change the generator and you re-measure this number.
  const CHECKED_FLOOR = 5_548_289;
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
        const pool = ids.filter((id) => active.get(id)).sort(() => rnd() - 0.5);
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
          if (r!.ifYouLose && !firstIsBye && o.lostFirst.has(row.entrantId)) check(r!.ifYouLose, " if-lose");
          checked++;
        }
      }
    }
    // One assertion over the whole run (review M5): the count says how wrong a
    // mutant is, the samples say where — both reproducible from the seed.
    expect(violations, `first violations: ${sample.join(" | ")}`).toBe(0);
    expect(checked).toBeGreaterThanOrEqual(CHECKED_FLOOR); // the enumeration actually ran
  }, 60_000);
});
