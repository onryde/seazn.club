// W2e Task 25 review M4 — the differentials that the nested-kernel stryker equivalence rows rest on, committed as a counted
// test (they were run once, in a scratch script, and quoted in stryker-equivalent.json).
//
// Rows in packages/engine/stryker-equivalent.json that this file stands behind:
//   src/sports/nested/kernel.ts:973:27 (LogicalOperator, ConditionalExpression -> true)   reachableLiveGames' fromBefore, the origin cell
//   src/sports/nested/kernel.ts:973:38 (ConditionalExpression -> true)                    "
//   src/sports/nested/kernel.ts:973:51 (EqualityOperator x >= 0, ConditionalExpression -> true)   its read of the cell above
//   src/sports/nested/kernel.ts:973:100 (ConditionalExpression -> true, EqualityOperator y >= 0)  its read of the cell to the left
//   src/sports/nested/kernel.ts:966:7 (LogicalOperator && for ||)                         the guard that refuses a fractional score
//   src/sports/nested/kernel.ts:921:14 (MethodExpression Math.max)                        reachableLiveTbScore's lower side
//   src/sports/nested/kernel.ts:922:10 (ConditionalExpression -> false)                   its `lo === 0` shortcut
//
// A stryker equivalence claim is "the mutant answers exactly what the original answers, everywhere the product reaches". The
// only proof of that is the two answers set side by side over the whole reachable domain, so this file does exactly that, with
// the four things such a proof owes (docs/superpowers/TEST-STRATEGY.md):
//  1. ANTI-VACUITY. Every sweep counts its cells and pins the count to the figure the rows quote, derived from the sweep's
//     declared bounds. Zero cells, or a table that is all one answer, fails.
//  2. A POSITIVE CONTROL. A copy that is NOT equivalent must differ from the original on this table; if it does not, the table
//     cannot see a difference and its 0-difference verdict on the real mutants means nothing.
//  3. THE PREMISES, as assertions. Each row's reason leans on facts that are not in the line it excuses: `tiebreakAt` and every
//     tie-break target and margin are positive integers (the engine's own config schema), and a typed array answers a negative or
//     fractional index with `undefined`. They are asserted here, and each one has a TEETH case: with the premise withdrawn the
//     mutant DOES differ, so a move of the premise reddens this file instead of silently voiding the rows.
//  4. NO COPY OF THE ANSWER. The original is the engine's own function (`reachableLiveGames`, exported) or, for the private
//     `reachableLiveTbScore`, the engine's strict write path (a tie-break summary is refused as "not a reachable final score"
//     exactly when `reachableTbScore` says so). The mutants are one-token copies of the source lines, and each copy is itself
//     checked against the engine so a drifted copy cannot stand in for a mutant.
//
// If a row here stops holding the file goes red; the repair is to re-classify the stryker row (it is no longer equivalent), not
// to widen a sweep until it passes.
/* eslint-disable no-constant-binary-expression -- the copies below are stryker's own mutants; a constant operand IS the mutation */
import { describe, expect, it } from "vitest";
import { EngineError } from "../src/core/errors.ts";
import { foldMatchWithStoppage } from "../src/core/events.ts";
import type { LineupPair } from "../src/core/types.ts";
import { reachableLiveGames, type NestedCfg } from "../src/sports/nested/kernel.ts";
import { tennis } from "../src/sports/tennis/tennis.ts";
import { defaultLineupPair, makeEnvelope } from "../src/testkit/helpers.ts";

type Rules = { gamesTo: number; winBy: number; tiebreakAt: number | null };
type Cells = { readonly [index: number]: number | undefined };

const range = (from: number, to: number, step = 1): number[] => {
  const out: number[] = [];
  for (let n = from; n <= to + 1e-9; n += step) out.push(Math.round(n * 1e6) / 1e6);
  return out;
};

// ---------------------------------------------------------------------------
// One-token copies of kernel.ts:964-979 (reachableLiveGames). `base` is the source line verbatim; every other entry changes
// exactly the token the stryker key names.
// ---------------------------------------------------------------------------

interface Step {
  x: number;
  y: number;
  width: number;
  reached: Cells;
}
type FromBefore = (s: Step) => boolean;

const fromBeforeBase: FromBefore = ({ x, y, width, reached }) =>
  (x === 0 && y === 0) || (x > 0 && reached[(x - 1) * width + y] === 1) || (y > 0 && reached[x * width + y - 1] === 1);

// The seven mutants on line 973.
const GAMES_MUTANTS: Record<string, FromBefore> = {
  "973:27 LogicalOperator (x === 0 || y === 0)": ({ x, y, width, reached }) =>
    x === 0 || y === 0 || (x > 0 && reached[(x - 1) * width + y] === 1) || (y > 0 && reached[x * width + y - 1] === 1),
  "973:27 ConditionalExpression -> true": ({ y, x, width, reached }) =>
    (true && y === 0) || (x > 0 && reached[(x - 1) * width + y] === 1) || (y > 0 && reached[x * width + y - 1] === 1),
  "973:38 ConditionalExpression -> true": ({ x, y, width, reached }) =>
    (x === 0 && true) || (x > 0 && reached[(x - 1) * width + y] === 1) || (y > 0 && reached[x * width + y - 1] === 1),
  "973:51 EqualityOperator (x >= 0)": ({ x, y, width, reached }) =>
    (x === 0 && y === 0) || (x >= 0 && reached[(x - 1) * width + y] === 1) || (y > 0 && reached[x * width + y - 1] === 1),
  "973:51 ConditionalExpression -> true": ({ x, y, width, reached }) =>
    (x === 0 && y === 0) || (true && reached[(x - 1) * width + y] === 1) || (y > 0 && reached[x * width + y - 1] === 1),
  "973:100 ConditionalExpression -> true": ({ x, y, width, reached }) =>
    (x === 0 && y === 0) || (x > 0 && reached[(x - 1) * width + y] === 1) || (true && reached[x * width + y - 1] === 1),
  "973:100 EqualityOperator (y >= 0)": ({ x, y, width, reached }) =>
    (x === 0 && y === 0) || (x > 0 && reached[(x - 1) * width + y] === 1) || (y >= 0 && reached[x * width + y - 1] === 1),
};

// Positive controls: genuinely different walks. Each must be seen to differ, or the table is blind.
const GAMES_CONTROLS: Record<string, FromBefore> = {
  "control: never steps from the left (y > 0 -> false)": ({ x, y, width, reached }) =>
    (x === 0 && y === 0) || (x > 0 && reached[(x - 1) * width + y] === 1) || (false && reached[x * width + y - 1] === 1),
  "control: never steps from above (x > 0 -> false)": ({ x, y, width, reached }) =>
    (x === 0 && y === 0) || (false && reached[(x - 1) * width + y] === 1) || (y > 0 && reached[x * width + y - 1] === 1),
};

/** Guard variants for line 966's integer check. `base` is the source; the mutant is the 966:7 LogicalOperator. */
type Refuse = (h: number, a: number, bound: number) => boolean;
const refuseBase: Refuse = (h, a, bound) =>
  !Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h >= bound || a >= bound;
const refuse966Mutant: Refuse = (h, a, bound) =>
  (!Number.isInteger(h) && !Number.isInteger(a)) || h < 0 || a < 0 || h >= bound || a >= bound;

const typedCells = (length: number): Cells => new Uint8Array(length);
/** A table that answers every NEGATIVE index with 1: the premise "a typed array reads undefined there" withdrawn. */
const hostileCells = (length: number): Cells => {
  const cells = new Uint8Array(length);
  return new Proxy(cells, {
    get: (target, key) => (typeof key === "string" && /^-\d+$/.test(key) ? 1 : Reflect.get(target, key)),
  });
};

function walk(
  h: number,
  a: number,
  rules: Rules,
  fromBefore: FromBefore,
  refuse: Refuse = refuseBase,
  makeCells: (length: number) => Cells = typedCells,
): boolean {
  const bound = rules.tiebreakAt === null ? 200 : rules.gamesTo + rules.winBy + 2; // kernel.ts setGamesBound
  if (refuse(h, a, bound)) return false;
  const live = (x: number, y: number): boolean => {
    const winner = x > y ? "home" : y > x ? "away" : null;
    const decided = winner !== null && Math.max(x, y) >= rules.gamesTo && Math.max(x, y) - Math.min(x, y) >= rules.winBy;
    return !decided && !(rules.tiebreakAt !== null && x === rules.tiebreakAt && y === rules.tiebreakAt);
  };
  const width = a + 1;
  const reached = makeCells((h + 1) * width);
  const writable = reached as unknown as Record<number, number>;
  for (let x = 0; x <= h; x++) {
    for (let y = 0; y <= a; y++) {
      writable[x * width + y] = fromBefore({ x, y, width, reached }) && live(x, y) ? 1 : 0;
    }
  }
  return reached[h * width + a] === 1;
}

// ---------------------------------------------------------------------------
// The premises, from the engine's own declarations.
// ---------------------------------------------------------------------------

const tourSet = (extra: Record<string, unknown>) => ({ gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7, ...extra });
const parses = (override: Record<string, unknown>): boolean =>
  tennis.configSchema.safeParse({ ...tennis.variants.tour, ...override }).success;

/** Every field a tie-break walk reads as a target or a margin, as an override that sets it to `value`. */
const POSITIVE_FIELDS: ReadonlyArray<readonly [string, (value: number) => Record<string, unknown>]> = [
  ["set.tiebreakAt", (v) => ({ set: tourSet({ tiebreakAt: v }) })],
  ["set.tiebreakTo", (v) => ({ set: tourSet({ tiebreakTo: v }) })],
  ["set.tiebreakWinBy", (v) => ({ set: tourSet({ tiebreakWinBy: v }) })],
  ["finalSet.matchTiebreakTo", (v) => ({ finalSet: { matchTiebreakTo: v } })],
  ["finalSet.tiebreakTo", (v) => ({ finalSet: { tiebreakTo: v } })],
  ["tiebreak.winBy", (v) => ({ tiebreak: { winBy: v } })],
];

describe("premises the nested-kernel equivalence rows lean on", () => {
  it("tiebreakAt, every tie-break target and every tie-break margin are positive integers in the engine's own schema (counted)", () => {
    let refused = 0;
    for (const [field, override] of POSITIVE_FIELDS) {
      // The pair that makes the refusal mean something: 1 is taken (so the override shape itself is valid), 0 and -1 are not.
      expect(parses(override(1)), `${field} = 1 is a legal config`).toBe(true);
      for (const bad of [0, -1]) {
        expect(parses(override(bad)), `${field} = ${bad} must be refused`).toBe(false);
        refused++;
      }
    }
    expect(refused, "6 fields x 2 refused values").toBe(12);
    // `tiebreakAt: null` (an advantage set) is the one non-positive value the schema takes, and the walk has its own branch for it.
    expect(parses({ set: tourSet({ tiebreakAt: null }) })).toBe(true);
  });

  it("a typed array answers a negative or a fractional index with undefined, and takes a fractional length without throwing", () => {
    const cells = new Uint8Array(6).fill(1);
    let checked = 0;
    for (const index of [-1, -2, -5, -6, 0.25, 0.5, 2.5]) {
      expect(cells[index], `index ${index}`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(7);
    expect(() => new Uint8Array(2.5)).not.toThrow();
    expect(new Uint8Array(2.5).length, "ToIndex truncates").toBe(2);
    // A write to a non-integer index is a no-op (no own property is created): the walk can never plant a value there.
    const writable = cells as unknown as Record<number, number>;
    writable[1.5] = 7;
    writable[-1] = 7;
    expect(cells[1.5]).toBeUndefined();
    expect(cells[-1]).toBeUndefined();
    expect(Object.keys(cells), "only the six real cells").toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// kernel.ts:973 and :966 — reachableLiveGames, the exported function, against its one-token copies.
// ---------------------------------------------------------------------------

describe("kernel.ts:973 — reachableLiveGames' fromBefore mutants answer what the engine answers, over 48,600 cells", () => {
  const GAMES_TO = range(1, 8);
  const WIN_BY = range(1, 3);
  const TIEBREAK_AT: Array<number | null> = [null, ...range(1, 8)];
  const SIDE = range(0, 14);
  const CELLS = GAMES_TO.length * WIN_BY.length * TIEBREAK_AT.length * SIDE.length * SIDE.length;

  const shapes: Rules[] = [];
  for (const gamesTo of GAMES_TO) for (const winBy of WIN_BY) for (const tiebreakAt of TIEBREAK_AT) shapes.push({ gamesTo, winBy, tiebreakAt });

  /** Cells where `variant` and the engine disagree, with the table's own tallies. */
  function sweep(variant: FromBefore): { cells: number; differs: number; live: number; liveOnAxis: number } {
    let cells = 0;
    let differs = 0;
    let live = 0;
    let liveOnAxis = 0;
    for (const rules of shapes) {
      for (const h of SIDE) {
        for (const a of SIDE) {
          const engine = reachableLiveGames(h, a, rules);
          if (walk(h, a, rules, variant) !== engine) differs++;
          if (engine) {
            live++;
            if (h === 0 || a === 0) liveOnAxis++;
          }
          cells++;
        }
      }
    }
    return { cells, differs, live, liveOnAxis };
  }

  it("the table is the figure the rows quote, and it holds both answers and live cells on the axes (anti-vacuity)", () => {
    expect(CELLS, "gamesTo 1-8 x winBy 1-3 x tiebreakAt null|1-8 x 0-14 a side").toBe(48_600);
    const base = sweep(fromBeforeBase);
    expect(base.cells).toBe(48_600);
    // The mutants only change cells with x = 0 or y = 0; a table with no live cell there could not see them.
    expect(base.live, "live cells").toBeGreaterThan(0);
    expect(base.live, "a table that is all true proves nothing either").toBeLessThan(base.cells);
    expect(base.liveOnAxis, "live cells on an axis").toBeGreaterThan(0);
  });

  it("the unmutated copy IS the engine on every cell, so a copy that drifted from kernel.ts cannot stand in for a mutant", () => {
    expect(sweep(fromBeforeBase).differs).toBe(0);
  });

  it("each of the seven mutants answers what the engine answers on every one of the 48,600 cells", () => {
    let mutants = 0;
    for (const [name, variant] of Object.entries(GAMES_MUTANTS)) {
      const result = sweep(variant);
      expect(result.cells, name).toBe(48_600);
      expect(result.differs, `${name}: cells where the mutant and the engine disagree`).toBe(0);
      mutants++;
    }
    expect(mutants, "the seven 973 rows").toBe(7);
  });

  it("POSITIVE CONTROL: a walk that is not equivalent is seen to differ on this table", () => {
    let controls = 0;
    for (const [name, variant] of Object.entries(GAMES_CONTROLS)) {
      expect(sweep(variant).differs, name).toBeGreaterThan(0);
      controls++;
    }
    expect(controls).toBe(2);
  });

  it("TEETH, tiebreakAt: with the premise `tiebreakAt is positive` withdrawn, the origin-cell mutants DO differ", () => {
    // tiebreakAt 0 makes 0-0 itself the tie-break cell, so nothing is reachable; a mutant that steps in from the axis then
    // answers true for a cell the engine does not reach. The schema refuses 0 (the premise test above), which is what keeps
    // 973:27 and 973:38 equivalent in product.
    const zeroRules: Rules[] = [];
    for (const gamesTo of GAMES_TO) for (const winBy of WIN_BY) zeroRules.push({ gamesTo, winBy, tiebreakAt: 0 });
    const differs = (variant: FromBefore): number => {
      let n = 0;
      for (const rules of zeroRules) {
        for (const h of range(0, 6)) for (const a of range(0, 6)) if (walk(h, a, rules, variant) !== walk(h, a, rules, fromBeforeBase)) n++;
      }
      return n;
    };
    for (const name of ["973:27 LogicalOperator (x === 0 || y === 0)", "973:27 ConditionalExpression -> true", "973:38 ConditionalExpression -> true"]) {
      expect(differs(GAMES_MUTANTS[name]!), name).toBeGreaterThan(0);
    }
  });

  it("TEETH, the 973:51 read mutants: they differ only with BOTH premises withdrawn (a table answering a negative index with 1 AND tiebreakAt 0)", () => {
    // 973:51 adds only a read of an index that is negative (x = 0). Two premises each keep that read from mattering: a typed array answers it with undefined, and tiebreakAt is positive, which makes an axis cell reachable
    // exactly when it is live (so a mutant that treats the cell as stepped-into adds nothing). The matrix below shows each premise
    // sufficient on its own and the mutants differing only when both are withdrawn, so a move of either premise leaves the rows
    // standing and a move of BOTH reddens this file.
    const shapesFor = (tiebreakAt: (gamesTo: number) => number | null): Rules[] => {
      const out: Rules[] = [];
      for (const gamesTo of range(2, 6)) for (const winBy of range(1, 2)) out.push({ gamesTo, winBy, tiebreakAt: tiebreakAt(gamesTo) });
      return out;
    };
    const differs = (variant: FromBefore, rules: Rules[], makeCells: (length: number) => Cells): number => {
      let n = 0;
      for (const r of rules) {
        for (const h of range(0, 6)) {
          for (const a of range(0, 6)) {
            if (walk(h, a, r, variant, refuseBase, makeCells) !== walk(h, a, r, fromBeforeBase, refuseBase, makeCells)) n++;
          }
        }
      }
      return n;
    };
    const positive = shapesFor((gamesTo) => gamesTo);
    const zero = shapesFor(() => 0);
    let checked = 0;
    for (const name of ["973:51 EqualityOperator (x >= 0)", "973:51 ConditionalExpression -> true"]) {
      const mutant = GAMES_MUTANTS[name]!;
      expect(differs(mutant, positive, typedCells), `${name}: both premises hold`).toBe(0);
      expect(differs(mutant, positive, hostileCells), `${name}: typed-array premise withdrawn alone`).toBe(0);
      expect(differs(mutant, zero, typedCells), `${name}: tiebreakAt-positive premise withdrawn alone`).toBe(0);
      expect(differs(mutant, zero, hostileCells), `${name}: both withdrawn`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(2);
    // The two 973:100 read mutants read the row above's last cell where the base reads nothing, and a negative index only at
    // 0-0 (already the origin). A y = 0 cell they add is live, and a live axis cell is reached anyway, so NO domain separates
    // them from the base, withdrawn premises included: those two rows rest on the axis being an unbroken run of live cells
    // (a leader's margin only grows along it), not on either premise. Recorded here as a measured fact, four ways.
    for (const name of ["973:100 ConditionalExpression -> true", "973:100 EqualityOperator (y >= 0)"]) {
      for (const [label, rules, cells] of [
        ["both hold", positive, typedCells],
        ["typed array withdrawn", positive, hostileCells],
        ["tiebreakAt positive withdrawn", zero, typedCells],
        ["both withdrawn", zero, hostileCells],
      ] as const) {
        expect(differs(GAMES_MUTANTS[name]!, rules, cells), `${name}, ${label}`).toBe(0);
      }
    }
  });

  it("each of the seven copies changes its expression: it differs from the source line on some step (the copies are mutants, not typos)", () => {
    // Every (x, y) on a 3x3 corner with every possible fill of the table: 9 x 512 = 4,608 steps. A copy that agreed with the
    // source on all of them would be the source again, and its 0-difference verdicts above would prove nothing. (Differing on a
    // STEP is not differing in product: the sweeps above are the product's domain.)
    const width = 3;
    const steps: Step[] = [];
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        for (let fill = 0; fill < 512; fill++) {
          // Cells 0-8 hold the fill; a negative index answers 1 (the typed-array premise withdrawn), so the x >= 0 and y >= 0
          // copies, whose only extra reads are negative, can be seen to read something the source does not.
          const bits = Array.from({ length: 9 }, (_, i) => (fill >> i) & 1);
          const reached = new Proxy(bits, { get: (t, k) => (typeof k === "string" && /^-\d+$/.test(k) ? 1 : Reflect.get(t, k)) }) as unknown as Cells;
          steps.push({ x, y, width, reached });
        }
      }
    }
    expect(steps.length).toBe(4_608);
    expect(steps.filter((s) => fromBeforeBase(s) !== fromBeforeBase(s))).toHaveLength(0);
    let mutants = 0;
    for (const [name, variant] of Object.entries(GAMES_MUTANTS)) {
      expect(steps.filter((s) => variant(s) !== fromBeforeBase(s)).length, name).toBeGreaterThan(0);
      mutants++;
    }
    expect(mutants).toBe(7);
  });
});

describe("kernel.ts:966:7 — the integer guard's && for ||, over fractional scores (quarters)", () => {
  const GAMES_TO = range(1, 6);
  const WIN_BY = range(1, 2);
  const SIDE = range(0, 10, 0.25);
  const shapes: Rules[] = [];
  for (const gamesTo of GAMES_TO) for (const winBy of WIN_BY) for (const tiebreakAt of [null, ...range(1, gamesTo)]) shapes.push({ gamesTo, winBy, tiebreakAt });
  // gamesTo g offers tiebreakAt null and 1..g, so g + 1 shapes per (gamesTo, winBy): sum over g = 1..6 of (g + 1) = 27, twice.
  const EXPECTED_SHAPES = 2 * (2 + 3 + 4 + 5 + 6 + 7);
  const EXPECTED_CELLS = EXPECTED_SHAPES * SIDE.length * SIDE.length;

  function sweep(refuse: Refuse): { cells: number; fractional: number; differs: number; throws: number } {
    let cells = 0;
    let fractional = 0;
    let differs = 0;
    let throws = 0;
    for (const rules of shapes) {
      for (const h of SIDE) {
        for (const a of SIDE) {
          if (!Number.isInteger(h) || !Number.isInteger(a)) fractional++;
          let answer: boolean;
          try {
            answer = walk(h, a, rules, fromBeforeBase, refuse);
          } catch {
            throws++;
            cells++;
            continue;
          }
          if (answer !== reachableLiveGames(h, a, rules)) differs++;
          cells++;
        }
      }
    }
    return { cells, fractional, differs, throws };
  }

  it("the table is counted and mostly fractional (anti-vacuity), and the engine refuses every fractional score", () => {
    expect(shapes.length).toBe(EXPECTED_SHAPES);
    expect(EXPECTED_SHAPES).toBe(54);
    expect(SIDE.length, "0 to 10 in quarters").toBe(41);
    const base = sweep(refuseBase);
    expect(base.cells).toBe(EXPECTED_CELLS);
    expect(EXPECTED_CELLS).toBe(90_774);
    expect(base.fractional, "cells with a fractional side").toBeGreaterThan(0);
    expect(base.differs, "the copy of the guard is the engine's").toBe(0);
    let fractionalTrue = 0;
    for (const rules of shapes) for (const h of SIDE) for (const a of SIDE) if ((!Number.isInteger(h) || !Number.isInteger(a)) && reachableLiveGames(h, a, rules)) fractionalTrue++;
    expect(fractionalTrue, "the engine answers false for every fractional score").toBe(0);
  });

  it("the && mutant answers what the engine answers on every cell, and nothing throws", () => {
    const result = sweep(refuse966Mutant);
    expect(result.cells).toBe(EXPECTED_CELLS);
    expect(result.throws, "a fraction past the guard throws").toBe(0);
    expect(result.differs, "cells where the mutant and the engine disagree").toBe(0);
  });

  it("the && mutant really lets a fractional score past the guard (the copy is a mutant, not the original)", () => {
    // The guard's own verdict, not the walk's: base refuses 2.5, the mutant (both sides must be fractional to refuse) does not.
    expect(refuseBase(2.5, 1, 9)).toBe(true);
    expect(refuse966Mutant(2.5, 1, 9)).toBe(false);
    expect(refuse966Mutant(2.5, 1.5, 9)).toBe(true);
  });

  it("POSITIVE CONTROL: a walk that rounds a fractional score down instead of refusing it is seen to differ from the engine", () => {
    // The guard is what makes the engine answer false for 2.5-1; an implementation that truncated would answer for 2-1. If this
    // table could not tell the two apart, the mutant's 0 differences above would say nothing about fractions.
    let differs = 0;
    for (const rules of shapes) {
      for (const h of SIDE) {
        for (const a of SIDE) {
          if (walk(Math.floor(h), Math.floor(a), rules, fromBeforeBase) !== reachableLiveGames(h, a, rules)) differs++;
        }
      }
    }
    expect(differs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// kernel.ts:921 and :922 — reachableLiveTbScore (private). The engine's answer is read off its strict write path.
// ---------------------------------------------------------------------------

type TbVariant = { low: (h: number, a: number) => number; zeroShortcut: boolean; alwaysLive?: boolean };

const tbWinner = (h: number, a: number, to: number, winBy: number): "home" | "away" | null => {
  const winner = h > a ? "home" : a > h ? "away" : null;
  if (winner === null) return null;
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  return hi >= to && hi - lo >= winBy ? winner : null;
};
/** kernel.ts:919-923. `low` is line 921's Math.min, `zeroShortcut` line 922's `lo === 0`. */
const liveTb = (h: number, a: number, to: number, winBy: number, v: TbVariant): boolean => {
  if (tbWinner(h, a, to, winBy) !== null) return false;
  const lo = v.low(h, a);
  return (v.zeroShortcut && lo === 0) || v.alwaysLive === true || tbWinner(lo, lo - 1, to, winBy) === null;
};
/** kernel.ts:898-905. */
const reachableTb = (h: number, a: number, to: number, winBy: number, v: TbVariant): boolean => {
  const winner = tbWinner(h, a, to, winBy);
  if (winner === null) return false;
  const prevH = winner === "home" ? h - 1 : h;
  const prevA = winner === "away" ? a - 1 : a;
  if (prevH < 0 || prevA < 0) return false;
  return liveTb(prevH, prevA, to, winBy, v);
};

const TB_BASE: TbVariant = { low: Math.min, zeroShortcut: true };
const TB_MUTANTS: Record<string, TbVariant> = {
  "921:14 MethodExpression (Math.max)": { low: Math.max, zeroShortcut: true },
  "922:10 ConditionalExpression -> false": { low: Math.min, zeroShortcut: false },
};
// Positive control: the function's whole point (a deciding point at a margin of one) removed.
const TB_CONTROL: TbVariant = { low: Math.min, zeroShortcut: true, alwaysLive: true };

describe("kernel.ts:921 and :922 — reachableLiveTbScore's mutants over 15,876 tie-break cells", () => {
  const TO = range(1, 12);
  const WIN_BY = range(1, 3);
  const SIDE = range(0, 20);
  const CELLS = TO.length * WIN_BY.length * SIDE.length * SIDE.length;

  const lineups: LineupPair = defaultLineupPair(tennis.positions);

  /** The engine's own verdict on a tie-break `h`-`a` to `to` by `winBy`, read off the write path: a first set of 7-6 whose
   *  tie-break block is `h`-`a`. "not a reachable final score" is `reachableTbScore` answering false; every other outcome, the
   *  later "tie-break winner must match the set winner" included, is it answering true. */
  function engineVerdict(to: number, winBy: number, h: number, a: number): boolean {
    const cfg: NestedCfg = tennis.configSchema.parse({
      ...tennis.variants.tour,
      set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: to, tiebreakWinBy: winBy },
    });
    const events = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "tennis.set_summary", payload: { home: 7, away: 6, tb: { home: h, away: a } } }),
    ];
    try {
      foldMatchWithStoppage(tennis, cfg, lineups, events, { strictFromSeq: 1 });
      return true;
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      if (e.message.includes("is not a reachable final score")) return false;
      if (e.message.includes("tie-break winner must match the set winner")) return true;
      throw e;
    }
  }

  // The engine's verdict per cell, taken once and shared by the cases below (15,876 strict folds).
  const engine = new Map<string, boolean>();
  const cellKey = (to: number, winBy: number, h: number, a: number): string => `${to}/${winBy}/${h}/${a}`;
  function engineTable(): Map<string, boolean> {
    if (engine.size > 0) return engine;
    const cfgByShape = new Map<string, NestedCfg>();
    for (const to of TO) {
      for (const winBy of WIN_BY) {
        cfgByShape.set(`${to}/${winBy}`, tennis.configSchema.parse({
          ...tennis.variants.tour,
          set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: to, tiebreakWinBy: winBy },
        }));
      }
    }
    for (const to of TO) for (const winBy of WIN_BY) for (const h of SIDE) for (const a of SIDE) engine.set(cellKey(to, winBy, h, a), engineVerdict(to, winBy, h, a));
    return engine;
  }

  it("the table is the figure the rows quote, and holds both verdicts (anti-vacuity)", () => {
    expect(CELLS, "to 1-12 x winBy 1-3 x 0-20 a side").toBe(15_876);
    const table = engineTable();
    expect(table.size).toBe(15_876);
    const reachable = [...table.values()].filter(Boolean).length;
    expect(reachable, "reachable final scores").toBeGreaterThan(0);
    expect(reachable, "and unreachable ones").toBeLessThan(table.size);
  });

  it("the unmutated copy of reachableTbScore IS the engine's strict-fold verdict on every cell", () => {
    const table = engineTable();
    let differs = 0;
    let cells = 0;
    for (const to of TO) for (const winBy of WIN_BY) for (const h of SIDE) for (const a of SIDE) {
      if (reachableTb(h, a, to, winBy, TB_BASE) !== table.get(cellKey(to, winBy, h, a))) differs++;
      cells++;
    }
    expect(cells).toBe(15_876);
    expect(differs).toBe(0);
  });

  it("each mutant answers what the engine answers, both on reachableTbScore (what the engine shows) and on reachableLiveTbScore itself", () => {
    const table = engineTable();
    let mutants = 0;
    for (const [name, variant] of Object.entries(TB_MUTANTS)) {
      let cells = 0;
      let againstEngine = 0;
      let againstOriginal = 0;
      for (const to of TO) for (const winBy of WIN_BY) for (const h of SIDE) for (const a of SIDE) {
        if (reachableTb(h, a, to, winBy, variant) !== table.get(cellKey(to, winBy, h, a))) againstEngine++;
        if (liveTb(h, a, to, winBy, variant) !== liveTb(h, a, to, winBy, TB_BASE)) againstOriginal++;
        cells++;
      }
      expect(cells, name).toBe(15_876);
      expect(againstEngine, `${name}: reachableTbScore, mutant vs engine`).toBe(0);
      expect(againstOriginal, `${name}: reachableLiveTbScore, mutant vs original`).toBe(0);
      mutants++;
    }
    expect(mutants, "the two rows").toBe(2);
  });

  it("POSITIVE CONTROL: a reachableLiveTbScore with no deciding-point check is seen to differ from the engine", () => {
    const table = engineTable();
    let differs = 0;
    for (const to of TO) for (const winBy of WIN_BY) for (const h of SIDE) for (const a of SIDE) {
      if (reachableTb(h, a, to, winBy, TB_CONTROL) !== table.get(cellKey(to, winBy, h, a))) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });

  it("TEETH, `to` positive: with a target of 0 the `lo === 0` shortcut is NOT redundant, so 922:10 is equivalent only while the schema refuses 0", () => {
    // tbWinner(0, -1, 0, winBy) is decided when the target is 0, so dropping the shortcut changes the answer at lo = 0. The
    // schema refuses a target of 0 (the premise test above); this is the case that shows why that refusal matters to the row.
    let differs = 0;
    for (const winBy of WIN_BY) for (const h of range(0, 6)) for (const a of range(0, 6)) {
      if (liveTb(h, a, 0, winBy, TB_MUTANTS["922:10 ConditionalExpression -> false"]!) !== liveTb(h, a, 0, winBy, TB_BASE)) differs++;
    }
    expect(differs).toBeGreaterThan(0);
    // And the reason the row gives for 922:10 at every target the schema takes: the leader of (0, -1) holds 0, below target.
    for (const to of TO) for (const winBy of WIN_BY) expect(tbWinner(0, -1, to, winBy), `to ${to} by ${winBy}`).toBeNull();
  });

  it("the two copies really are mutants: each differs from the original in the line it names", () => {
    expect(TB_MUTANTS["921:14 MethodExpression (Math.max)"]!.low(2, 5)).toBe(5);
    expect(TB_BASE.low(2, 5)).toBe(2);
    expect(TB_MUTANTS["922:10 ConditionalExpression -> false"]!.zeroShortcut).toBe(false);
    expect(TB_BASE.zeroShortcut).toBe(true);
  });
});
