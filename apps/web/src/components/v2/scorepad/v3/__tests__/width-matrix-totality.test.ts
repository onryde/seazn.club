// R8/WS-M fix round 1, item 3 — the pin that keeps the SEVEN-WIDTH matrix
// total.
//
// `e2e/mobile.spec.ts` is the only place anything narrower than 375 or wider
// than 430 ever runs, and it names every sport it covers by hand inside test
// bodies. Nothing tied that set to `V3_SKINS`: a twelfth sport would be forced
// into `e2e/v3-skin-catalog.ts` by `a11y-sweep-totality.test.ts` beside this
// file, get its a11y sweep — and still ship with ZERO width coverage, silently.
// This is that test's sibling for the other spec.
//
// Same posture as `a11y-sweep-totality.test.ts`: pure, no DB, no browser, so
// it runs in every job and cannot self-skip; it imports the declaration MODULE
// rather than scanning the spec's source text (that file's own header explains
// why a regex over TypeScript is the worse instrument, and this repo has the
// poisoned-scan scar to prove it).
//
// It fails in BOTH directions — a catalog sport accounted for nowhere, and a
// coverage entry naming a sport the catalog does not own.
import { describe, expect, it } from "vitest";
import { V3_SKIN_CASE_KEYS } from "../../../../../../e2e/v3-skin-catalog";
import {
  WIDTH_MATRIX_ACCOUNTED_KEYS,
  WIDTH_MATRIX_CLOCK_SPORTS,
  WIDTH_MATRIX_PAD_RENDER_ONLY,
  WIDTH_MATRIX_PAD_SWEEPS,
  WIDTH_MATRIX_PAD_UNCOVERED,
} from "../../../../../../e2e/v3-width-matrix-coverage";

describe("R8/WS-M — the seven-width matrix accounts for every v3 skin", () => {
  it("accounts for exactly the sports the skin catalog owns, no more and no fewer", () => {
    // The catalog is itself pinned to `V3_SKINS` by `a11y-sweep-totality`, so
    // this transitively pins the width matrix to the real registry. Sorted on
    // both sides: this is about the SET, not the order.
    expect([...WIDTH_MATRIX_ACCOUNTED_KEYS].sort()).toEqual([...V3_SKIN_CASE_KEYS].sort());
  });

  it("puts each sport in exactly ONE tier — swept, render-only, or uncovered", () => {
    expect(new Set(WIDTH_MATRIX_ACCOUNTED_KEYS).size).toBe(WIDTH_MATRIX_ACCOUNTED_KEYS.length);
  });

  it("gives every weaker-than-swept entry a written reason, so a gap can never be a bare name", () => {
    for (const c of WIDTH_MATRIX_PAD_RENDER_ONLY) expect(c.where.length, c.key).toBeGreaterThan(40);
    for (const c of WIDTH_MATRIX_PAD_UNCOVERED) expect(c.why.length, c.key).toBeGreaterThan(40);
  });

  it("the clock pair mobile.spec.ts actually loops over is itself swept — the one tier that cannot drift", () => {
    // `WIDTH_MATRIX_CLOCK_SPORTS` is read BACK by mobile.spec.ts's own
    // parameterised clock test, so unlike the declarations above it is proved
    // by use, not by assertion. This checks the two lists agree.
    for (const [key] of WIDTH_MATRIX_CLOCK_SPORTS) {
      expect(WIDTH_MATRIX_PAD_SWEEPS, `${key} is looped over but not declared swept`).toContain(key);
    }
  });
});
