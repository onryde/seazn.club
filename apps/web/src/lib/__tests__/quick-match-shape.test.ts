// The setup screen's format choice (quick match plan 5 Task 6; spec docs/superpowers/specs/
// 2026-11-12-quick-match-league-knockout-design.md §3, §12): three whole choices, League | League → Final (top 2) |
// League → Semi-finals → Final (top 4), offered by side count and by the variant's C23 `knockoutAllowed`.
//
// Owner 2026-11-14 ("can we show default and disable like semifinal, other user doesn't know what format we have"): the list
// ALWAYS shows all three rows, in that order. A row that cannot be played yet is shown disabled with its one-line reason,
// never hidden: League → Final below three sides "Needs 3 or more sides", Semi-finals below four "Needs 4 or more sides", and
// on rules that may never play a knockout both knockout rows say "Not available for this sport", which wins over a side count.
//
// Expected values are the spec's §3 offer table, §12's sign-off line and the owner's 2026-11-14 ruling, typed here on purpose:
// never read from the module under test, nor from its constants (a constant that moved would move both sides of the
// assertion). The mapping to the create's fields is proven against the REAL consumer, `CreateQuickMatch`, so a shape the
// schema refuses reds here.
//
// Sport: none. The choice reads only a side count and the variant's `knockoutAllowed`; which variants allow a knockout is the
// offer probe's (quick-match-offer.test.ts) and the page test's.
import { describe, expect, it } from "vitest";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import {
  effectiveShape,
  isSetupShape,
  minSidesOf,
  SETUP_SHAPES,
  shapesOffered,
  shapeToFormat,
  type SetupShape,
} from "../quick-match-shape";

const NEEDS_3 = "quickMatch.setup.shape.finalNeeds";
const NEEDS_4 = "quickMatch.setup.shape.semisNeeds";
const NOT_FOR_SPORT = "quickMatch.setup.shape.notForSport";
type Row = [SetupShape, boolean, string | null];
const ALL_ON: Row[] = [
  ["league", true, null],
  ["final", true, null],
  ["semis", true, null],
];
/** Spec §3 and §12, as the owner amended them 2026-11-14: [row, can be picked, the reason a disabled row gives]. */
const SPEC_TABLE: Record<number, Row[]> = {
  2: [
    ["league", true, null],
    ["final", false, NEEDS_3],
    ["semis", false, NEEDS_4],
  ],
  3: [
    ["league", true, null],
    ["final", true, null],
    ["semis", false, NEEDS_4],
  ],
  4: ALL_ON,
  5: ALL_ON,
  6: ALL_ON,
};
/** Rules that may never play a knockout (C23): the rules' reason on both knockout rows, at every side count. */
const RULES_SAY_NO: Row[] = [
  ["league", true, null],
  ["final", false, NOT_FOR_SPORT],
  ["semis", false, NOT_FOR_SPORT],
];
const rowsOf = (sides: number, allowed: boolean): Row[] => shapesOffered(sides, allowed).map((r) => [r.shape, r.enabled, r.reason]);

describe("shapesOffered: the rows the list shows, by side count and C23 (owner 2026-11-14: always all three)", () => {
  it("the fewest sides first (two): all three rows, League pickable, both knockout rows disabled with how many sides they need", () => {
    expect(rowsOf(2, true)).toEqual(SPEC_TABLE[2]);
  });

  it("follows the table at 2..6 sides, both ways of knockoutAllowed; 10 cases checked", () => {
    let checked = 0;
    for (let sides = 2; sides <= 6; sides++) {
      expect(rowsOf(sides, true), `${sides} sides, knockout allowed`).toEqual(SPEC_TABLE[sides]);
      checked++;
      // C23: rules that may only play League still LIST both knockout rows, disabled with the rules' reason.
      expect(rowsOf(sides, false), `${sides} sides, knockout NOT allowed`).toEqual(RULES_SAY_NO);
      checked++;
    }
    expect(checked, "anti-vacuity: 5 side counts × 2").toBe(10);
  });

  it("no row is ever hidden: three rows in the list's order at every side count, both ways (counted)", () => {
    let rows = 0;
    for (let sides = 2; sides <= 6; sides++) {
      for (const allowed of [true, false]) {
        const shapes = shapesOffered(sides, allowed).map((r) => r.shape);
        expect(shapes, `${sides} ${allowed}`).toEqual(["league", "final", "semis"]);
        rows += shapes.length;
      }
    }
    expect(rows, "anti-vacuity: 10 lists × 3 rows").toBe(30);
  });

  it("when both reasons hold (two sides on rules that never play a knockout), the rules' reason wins", () => {
    expect(shapesOffered(2, false).find((r) => r.shape === "final")).toEqual({ shape: "final", enabled: false, reason: NOT_FOR_SPORT });
    expect(shapesOffered(3, false).find((r) => r.shape === "semis")).toEqual({ shape: "semis", enabled: false, reason: NOT_FOR_SPORT });
  });

  it("every disabled row names why and every enabled row names none (counted both ways)", () => {
    let enabled = 0;
    let disabled = 0;
    for (let sides = 2; sides <= 6; sides++) {
      for (const allowed of [true, false]) {
        for (const r of shapesOffered(sides, allowed)) {
          if (r.enabled) {
            expect(r.reason, `${sides} ${allowed} ${r.shape}`).toBeNull();
            enabled++;
          } else {
            expect(r.reason, `${sides} ${allowed} ${r.shape}`).not.toBeNull();
            disabled++;
          }
        }
      }
    }
    // Allowed: 1 + 2 + 3 + 3 + 3 enabled; not allowed: League alone at each of 5 counts.
    expect([enabled, disabled]).toEqual([12 + 5, 3 + 10]);
  });

  it("the list keeps the spec's order: League, then Final, then Semi-finals (the stacked list of §12)", () => {
    expect(SETUP_SHAPES).toEqual(["league", "final", "semis"]);
    expect(shapesOffered(6, true).map((r) => r.shape)).toEqual(["league", "final", "semis"]);
  });
});

describe("minSidesOf: the `{min}` a 'Needs {min} or more sides' reason reads", () => {
  it("League from two, League → Final from three, Semi-finals from four (spec §3)", () => {
    expect(SETUP_SHAPES.map((s) => [s, minSidesOf(s)])).toEqual([
      ["league", 2],
      ["final", 3],
      ["semis", 4],
    ]);
  });

  it("a row that needs more sides turns on at exactly its own minimum, never a side early or late (counted)", () => {
    let checked = 0;
    for (const shape of ["final", "semis"] as const) {
      const at = (sides: number) => shapesOffered(sides, true).find((r) => r.shape === shape)!;
      expect(at(minSidesOf(shape) - 1).enabled, `${shape} one side short`).toBe(false);
      expect(at(minSidesOf(shape)).enabled, `${shape} at its minimum`).toBe(true);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("shapeToFormat: one radio becomes the create's format and count (plan 5 D1)", () => {
  const base = {
    name: "Thursday Smash",
    sport_key: "badminton",
    variant_key: "bwf",
    kind: "individual",
    sides: ["Ines", "Mika", "Ravi", "Sofia"],
    plays: 1,
    email: null,
    locale: "en",
  };

  it("League is a league with no count; Final is the top 2; Semi-finals is the top 4", () => {
    expect(shapeToFormat("league")).toEqual({ format: "league", qualifiers: null });
    expect(shapeToFormat("final")).toEqual({ format: "league_knockout", qualifiers: 2 });
    expect(shapeToFormat("semis")).toEqual({ format: "league_knockout", qualifiers: 4 });
  });

  it("every shape's fields are a body the create's schema accepts, with the format and count it says; 3 checked", () => {
    let checked = 0;
    for (const shape of SETUP_SHAPES) {
      const parsed = CreateQuickMatch.safeParse({ ...base, ...shapeToFormat(shape) });
      expect(parsed.success, `${shape}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(parsed.data).toMatchObject(shapeToFormat(shape));
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("isSetupShape: only the three words, never a lookup that answers for anything else", () => {
  it("accepts the three and refuses the rest (a format word, a case change, a blank, an object key)", () => {
    for (const s of ["league", "final", "semis"]) expect(isSetupShape(s), s).toBe(true);
    for (const s of ["knockout", "league_knockout", "Final", "", " semis", "__proto__", "constructor", "toString"]) {
      expect(isSetupShape(s), JSON.stringify(s)).toBe(false);
    }
  });
});

describe("effectiveShape: a choice the list no longer offers falls back (plan 5 T6)", () => {
  it("the empty case first: League is always offered, so League stays League at every side count, either way of C23", () => {
    let checked = 0;
    for (let sides = 2; sides <= 6; sides++) {
      for (const allowed of [true, false]) {
        expect(effectiveShape("league", shapesOffered(sides, allowed)), `${sides} ${allowed}`).toBe("league");
        checked++;
      }
    }
    expect(checked).toBe(10);
  });

  it("an offered choice is kept: Final at 3 sides, Semi-finals at 4", () => {
    expect(effectiveShape("final", shapesOffered(3, true))).toBe("final");
    expect(effectiveShape("semis", shapesOffered(4, true))).toBe("semis");
  });

  it("Semi-finals at 3 sides falls to Final, the deepest knockout still offered; at 2 sides to League", () => {
    expect(effectiveShape("semis", shapesOffered(3, true))).toBe("final");
    expect(effectiveShape("semis", shapesOffered(2, true))).toBe("league");
    expect(effectiveShape("final", shapesOffered(2, true))).toBe("league");
  });

  it("a variant that may only play League takes any knockout choice back to League", () => {
    expect(effectiveShape("semis", shapesOffered(6, false))).toBe("league");
    expect(effectiveShape("final", shapesOffered(6, false))).toBe("league");
  });

  it("whatever was chosen, the choice that posts is a row that can be picked: every choice × 2..6 sides × C23 (counted)", () => {
    let checked = 0;
    for (const chosen of SETUP_SHAPES) {
      for (let sides = 2; sides <= 6; sides++) {
        for (const allowed of [true, false]) {
          const offered = shapesOffered(sides, allowed);
          const posted = effectiveShape(chosen, offered);
          expect(offered.find((r) => r.shape === posted)?.enabled, `${chosen} ${sides} ${allowed} → ${posted}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity: 3 × 5 × 2").toBe(30);
  });
});
