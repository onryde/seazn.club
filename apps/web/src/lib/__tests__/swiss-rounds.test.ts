// Swiss Playoff's round budget scales with the field (owner: "scale with
// field size"). Every boundary is pinned on BOTH sides — an off-by-one in a
// `<=` chain is exactly the defect a single sample per band cannot see.
import { describe, expect, it } from "vitest";
import { SWISS_ROUNDS_BANDS, swissRoundsForFieldSize } from "@/lib/swiss-rounds";

describe("swissRoundsForFieldSize — the owner's table", () => {
  it.each([
    [2, 3],
    [8, 3],
    [9, 4],
    [16, 4],
    [17, 5],
    [32, 5],
    [33, 6],
    [64, 6],
    [65, 7],
    [1000, 7],
  ])("a field of %i plays %i rounds", (entrants, rounds) => {
    expect(swissRoundsForFieldSize(entrants)).toBe(rounds);
  });

  it("never returns fewer rounds for a bigger field (monotone across the whole range)", () => {
    let last = swissRoundsForFieldSize(1);
    for (let n = 2; n <= 130; n++) {
      const here = swissRoundsForFieldSize(n);
      expect(here, `field ${n}`).toBeGreaterThanOrEqual(last);
      last = here;
    }
  });

  it("floors a field too small to pair at the smallest band rather than returning 0", () => {
    // A division can legitimately be asked for a preview at 0/1 entrants.
    expect(swissRoundsForFieldSize(0)).toBe(3);
    expect(swissRoundsForFieldSize(1)).toBe(3);
    expect(swissRoundsForFieldSize(-4)).toBe(3);
  });

  it("truncates a non-integer field size rather than landing between bands", () => {
    expect(swissRoundsForFieldSize(8.9)).toBe(3); // still an 8-entrant field
    expect(swissRoundsForFieldSize(16.2)).toBe(4);
  });

  it("falls back to the smallest band for a non-finite field size", () => {
    // Both directions: a garbage read is garbage whichever way it overflows,
    // and neither should mint a 7-round event nobody asked for.
    expect(swissRoundsForFieldSize(Number.NaN)).toBe(3);
    expect(swissRoundsForFieldSize(Number.POSITIVE_INFINITY)).toBe(3);
    expect(swissRoundsForFieldSize(Number.NEGATIVE_INFINITY)).toBe(3);
  });

  // The table is data, not a chain of ifs typed twice: the test reads the
  // SAME declaration the function does, so moving a band moves both together
  // (AGENTS.md failure class 19 — derive the expectation from the source of
  // truth) while the explicit rows above still pin today's numbers.
  it("every declared band's upper bound and the value one past it disagree", () => {
    for (const band of SWISS_ROUNDS_BANDS) {
      expect(swissRoundsForFieldSize(band.upTo)).toBe(band.rounds);
      expect(swissRoundsForFieldSize(band.upTo + 1)).toBeGreaterThan(band.rounds);
    }
  });
});
