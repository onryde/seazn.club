// Engine mutation debt (sport-free lane) — the DLS Standard Edition primitives in dls.ts, pinned against the method itself:
// the published 2002 D/L Standard Edition resource table (engine/11-sources.md) and spec 04 §2.5's three target rules,
//   R2 < R1 : T = ⌊S1 × R2/R1⌋ + 1      R2 = R1 : T = S1 + 1      R2 > R1 : T = ⌊S1 + G50 × (R2 − R1)/100⌋ + 1
// and the par rule the file states for R2 ≤ R1 (par = ⌊S1 × R2used/R1⌋). Every expected number below is hand arithmetic on
// those rules or a cell read off the published table — never a value this file's code produced.
//
// Single-sport on purpose: Duckworth–Lewis–Stern is cricket's rain rule and no other sport declares resources.
import { describe, expect, it } from "vitest";
import { DLS_G50, DLS_STANDARD_TABLE, dlsPar, dlsTarget, resources, resourcesFromBalls } from "./dls.ts";

describe("the published table's shape — overs left 0..50 by wickets lost 0..9", () => {
  // Properties the method defines, not values read off this file: 51 rows (0..50 overs left) of 10 columns (0..9 wickets
  // lost); no overs left is no resources; a full 50 overs with nobody out is 100%; and resources never DROP when a side has
  // more overs left, nor RISE when it has lost more wickets.
  it("51 rows of 10 finite percentages, zero with no overs left, 100 at the top", () => {
    expect(DLS_STANDARD_TABLE).toHaveLength(51);
    let cells = 0;
    for (const [overs, row] of DLS_STANDARD_TABLE.entries()) {
      expect(row, `row ${overs}`).toHaveLength(10);
      for (const v of row) {
        if (!Number.isFinite(v) || v < 0 || v > 100) expect.fail(`row ${overs}: ${String(v)} is not a percentage`);
        cells++;
      }
    }
    expect(cells).toBe(510);
    expect(DLS_STANDARD_TABLE[0]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(DLS_STANDARD_TABLE[50]?.[0]).toBe(100);
  });

  it("through resources(): every whole over and wicket count reads a percentage, monotone in both directions", () => {
    let checked = 0;
    for (let overs = 0; overs <= 50; overs++) {
      for (let wickets = 0; wickets <= 9; wickets++) {
        const r = resources(overs, wickets);
        if (!Number.isFinite(r)) expect.fail(`${overs} overs, ${wickets} down: ${String(r)}`);
        if (overs > 0 && r < resources(overs - 1, wickets)) expect.fail(`${overs} overs, ${wickets} down reads less than ${overs - 1}`);
        if (wickets > 0 && r > resources(overs, wickets - 1)) expect.fail(`${overs} overs, ${wickets} down reads more than ${wickets - 1} down`);
        checked++;
      }
    }
    expect(checked).toBe(510);
  });
});

describe("resources — the top of the published table (50 overs left)", () => {
  // The published Standard Edition row for 50 overs remaining, wickets lost 0..9 (2002 table, as hosted by the ICC). 100.0 is
  // the method's own definition: a whole 50-over innings with all ten wickets in hand IS 100% of a side's resources.
  const ROW_50 = [100.0, 93.4, 85.1, 74.9, 62.7, 49.0, 34.9, 22.0, 11.9, 4.7];

  it("reads row 50 exactly, for every wicket column, and never reaches past the table", () => {
    let checked = 0;
    for (const [wickets, published] of ROW_50.entries()) {
      expect(resources(50, wickets), `50 overs, ${wickets} down`).toBe(published);
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("an innings with MORE than 50 overs left reads as 50 (the table has no row 51)", () => {
    expect(resources(50.5, 0)).toBe(100);
    expect(resources(60, 3)).toBe(74.9);
  });

  it("just inside the top row a fractional over still interpolates (49.5 overs, 0 down: halfway from 99.1 to 100.0)", () => {
    // 99.1 + 0.5 × (100.0 − 99.1) = 99.55
    expect(resources(49.5, 0)).toBeCloseTo(99.55, 10);
  });

  it("a full ODI innings in balls — 300 balls, nobody out, 10-wicket all-out — is 100%", () => {
    expect(resourcesFromBalls(300, 0, 10)).toBe(100);
  });
});

describe("dlsTarget — spec 04 §2.5", () => {
  it("no first-innings resources (R1 = 0) is the degenerate plain target S1 + 1, whatever R2 is", () => {
    // R1 = 0 is exactly the boundary of the `r1 <= 0` guard: a chase with resources (56.6 = 20 overs) must NOT go through the
    // G50 rule (⌊200 + 245 × 56.6/100⌋ + 1 = 339) — there was nothing to compare it with.
    expect(dlsTarget(200, 0, 56.6)).toBe(201);
    expect(dlsTarget(200, 0, 0)).toBe(201);
    expect(dlsTarget(200, -3, 56.6)).toBe(201);
  });

  it("R2 < R1 scales the first-innings score down: 250 off 50 overs, chase cut to 20 (R2 56.6) ⇒ 142", () => {
    // ⌊250 × 56.6/100⌋ + 1 = ⌊141.5⌋ + 1 = 142
    expect(dlsTarget(250, 100, 56.6)).toBe(142);
  });

  it("R2 > R1 adds G50 runs, never scales up: 200 off a 40-over first innings (R1 89.3), 50-over chase (R2 100) ⇒ 227", () => {
    // ⌊200 + 245 × (100 − 89.3)/100⌋ + 1 = ⌊200 + 26.215⌋ + 1 = 227. The R2 < R1 ratio would read ⌊200 × 100/89.3⌋ + 1 = 224.
    expect(DLS_G50).toBe(245);
    expect(dlsTarget(200, 89.3, 100)).toBe(227);
  });

  it("R2 = R1 is S1 + 1 — swept over every innings length the table publishes and first-innings totals 0..400", () => {
    // R = the table's own 0-down cell for n overs (the resources a side starts an n-over innings with). The rule is exact, and
    // it is NOT what the ratio rule gives in floating point: ⌊S1 × R/R⌋ reads 221 for S1 = 222, R = 75.1 (30 overs), because
    // 222 × 75.1 / 75.1 = 221.99999999999997.
    expect(dlsTarget(222, 75.1, 75.1)).toBe(223);
    let checked = 0;
    for (const row of DLS_STANDARD_TABLE) {
      const r = row[0] as number;
      if (r <= 0) continue;
      for (let s1 = 0; s1 <= 400; s1++) {
        if (dlsTarget(s1, r, r) !== s1 + 1) expect.fail(`S1 ${s1}, R1 = R2 = ${r}: ${dlsTarget(s1, r, r)}, want ${s1 + 1}`);
        checked++;
      }
    }
    expect(checked).toBe(50 * 401);
  });
});

describe("dlsPar — the live par / abandonment number", () => {
  it("no first-innings resources (R1 = 0) has no par at all — 0, however much of the chase is used", () => {
    // Positive pair below: with R1 > 0 the same chase has a par.
    expect(dlsPar(200, 0, 56.6, 25)).toBe(0);
    expect(dlsPar(200, 0, 0, 0)).toBe(0);
    expect(dlsPar(200, 100, 56.6, 25)).toBe(50); // ⌊200 × 25/100⌋
  });

  it("a chase with no resources available has a par of 0", () => {
    expect(dlsPar(200, 100, 0, 0)).toBe(0);
  });

  it("R2 ≤ R1 is the exact Standard Edition par ⌊S1 × used/R1⌋, NOT the target pro-rated (which floors twice)", () => {
    // 200 off 50 overs (R1 100); chase cut to 20 overs (R2 56.6); abandoned 2 overs short, 6 down (6.6 left) ⇒ used 50.0.
    // Exact: ⌊200 × 50/100⌋ = 100. Pro-rating the target instead reads ⌊(114 − 1) × 50/56.6⌋ = ⌊99.82⌋ = 99 — a tie read
    // as a one-run loss.
    expect(dlsPar(200, 100, 56.6, 50)).toBe(100);
  });

  it("R2 > R1 pro-rates the revised target by resources used (the file's documented approximation)", () => {
    // Target 227 (above); half the 100% chase used ⇒ ⌊(227 − 1) × 50/100⌋ = 113.
    expect(dlsPar(200, 89.3, 100, 50)).toBe(113);
  });
});
