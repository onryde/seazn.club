// The setup screen's format choice (quick match plan 5 Task 6; spec docs/superpowers/specs/
// 2026-11-12-quick-match-league-knockout-design.md §3, §12): three whole choices, League | League → Final (top 2) |
// League → Semi-finals → Final (top 4), offered by side count and by the variant's C23 `knockoutAllowed`.
//
// Expected values are the spec's §3 offer table and §12's sign-off line, typed here on purpose: never read from the module
// under test, nor from its constants (a constant that moved would move both sides of the assertion). The mapping to the
// create's fields is proven against the REAL consumer, `CreateQuickMatch`, so a shape the schema refuses reds here.
//
// Sport: none. The choice reads only a side count and the variant's `knockoutAllowed`; which variants allow a knockout is the
// offer probe's (quick-match-offer.test.ts) and the page test's.
import { describe, expect, it } from "vitest";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { effectiveShape, isSetupShape, SETUP_SHAPES, shapesOffered, shapeToFormat, type SetupShape } from "../quick-match-shape";

/** Spec §3 (and §12: "with 2 sides neither knockout row is offered"; "the top-4 row is disabled ... below 4 sides"). */
const SPEC_TABLE: Record<number, [SetupShape, boolean][]> = {
  2: [["league", true]],
  3: [
    ["league", true],
    ["final", true],
    ["semis", false],
  ],
  4: [
    ["league", true],
    ["final", true],
    ["semis", true],
  ],
  5: [
    ["league", true],
    ["final", true],
    ["semis", true],
  ],
  6: [
    ["league", true],
    ["final", true],
    ["semis", true],
  ],
};

describe("shapesOffered: the rows the list shows, by side count and C23", () => {
  it("follows spec §3 at 2..6 sides, both ways of knockoutAllowed; 10 cases checked", () => {
    let checked = 0;
    for (let sides = 2; sides <= 6; sides++) {
      const allowed = shapesOffered(sides, true).map((r) => [r.shape, r.enabled]);
      expect(allowed, `${sides} sides, knockout allowed`).toEqual(SPEC_TABLE[sides]);
      checked++;
      // C23: a variant that may only play League offers only League, at every side count (spec §3's first bullet).
      const leagueOnly = shapesOffered(sides, false).map((r) => [r.shape, r.enabled]);
      expect(leagueOnly, `${sides} sides, knockout NOT allowed`).toEqual([["league", true]]);
      checked++;
    }
    expect(checked, "anti-vacuity: 5 side counts × 2").toBe(10);
  });

  it("a disabled row names why (the one-line reason key); an enabled row names none", () => {
    const rows = shapesOffered(3, true);
    expect(rows.find((r) => r.shape === "semis")).toEqual({ shape: "semis", enabled: false, reason: "quickMatch.setup.shape.semisNeeds" });
    let enabled = 0;
    for (let sides = 2; sides <= 6; sides++) {
      for (const r of shapesOffered(sides, true).filter((x) => x.enabled)) {
        expect(r.reason, `${sides} ${r.shape}`).toBeNull();
        enabled++;
      }
    }
    // 1 + 2 + 3 + 3 + 3.
    expect(enabled).toBe(12);
  });

  it("the list keeps the spec's order: League, then Final, then Semi-finals (the stacked list of §12)", () => {
    expect(SETUP_SHAPES).toEqual(["league", "final", "semis"]);
    expect(shapesOffered(6, true).map((r) => r.shape)).toEqual(["league", "final", "semis"]);
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
});
