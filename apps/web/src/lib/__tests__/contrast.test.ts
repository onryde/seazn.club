// The overlay's contrast formula — WCAG 2.x relative luminance and contrast
// ratio, lifted from the pad's own contrast.test.ts (scorepad/v3/__tests__)
// into a lib module so the overlay's test and the pad's can share ONE
// implementation instead of two copies. The pad's test-local copy is left in
// place this wave (scorepad/** is off-limits to this programme); recorded in
// _INDEX.md as a tidy owed to nobody in particular.
//
// Every case here exists to kill a specific way the formula can be wrong, not
// to demonstrate that it runs: the sRGB curve (a naive linear ramp flips a real
// AA verdict), the three luminance coefficients (a swap reorders the primaries
// without changing black or white), and the composite rounding.
import { describe, expect, it } from "vitest";
import { blendOver, contrastRatio, relativeLuminance } from "../contrast";

describe("contrastRatio (WCAG 2.x)", () => {
  it("is 21:1 for black on white and 1:1 for a colour on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#150b36", "#150b36")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#150b36", "#f5f0e8")).toBeCloseTo(contrastRatio("#f5f0e8", "#150b36"), 10);
  });

  // The one pair where gamma-correct and naive-linear luminance flip a real
  // AA verdict: correct ≈ 4.5422 (passes 4.5), naive ≈ 2.05 (fails). Every
  // other assertion in this file survives a mutant that deletes the sRGB
  // curve; this one does not.
  it("distinguishes gamma-correct from naive-linear luminance (#767676 on white)", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.5422, 3);
  });

  it("accepts 3-digit and upper-case hex", () => {
    expect(contrastRatio("#FFF", "#000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#F00", "#ff0000")).toBeCloseTo(1, 5);
  });

  it("refuses a value that is not a hex colour rather than scoring it", () => {
    // A silently-coerced NaN channel would make every ratio involving it 1:1 —
    // i.e. a sweep that reports every pair as identical and nothing as red.
    expect(() => contrastRatio("rebeccapurple", "#ffffff")).toThrow(/not a hex colour/);
    expect(() => contrastRatio("#12345", "#ffffff")).toThrow(/not a hex colour/);
  });
});

describe("relativeLuminance weights the three primaries as WCAG does", () => {
  // Black and white are 0 and 1 whatever the coefficients are, so they cannot
  // see a swapped weight. The primaries can: green carries 0.7152 of the
  // luminance, red 0.2126 and blue 0.0722, and a mutant that permutes them
  // reds here while leaving the two endpoints untouched.
  it("green ≫ red ≫ blue, at the spec's own coefficients", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 10);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(relativeLuminance("#00ff00")).toBeCloseTo(0.7152, 6);
    expect(relativeLuminance("#ff0000")).toBeCloseTo(0.2126, 6);
    expect(relativeLuminance("#0000ff")).toBeCloseTo(0.0722, 6);
  });
});

describe("blendOver (alpha text composited over its board)", () => {
  it("alpha 1 is the foreground, alpha 0 is the background", () => {
    expect(blendOver("#f5f0e8", "#150b36", 1)).toBe("#f5f0e8");
    expect(blendOver("#f5f0e8", "#150b36", 0)).toBe("#150b36");
  });

  it("70 % cream over night is between the two, per channel", () => {
    // r: 0.7·0xf5 + 0.3·0x15 = 171.5 + 6.3 = 177.8 → 178 = b2
    // g: 0.7·0xf0 + 0.3·0x0b = 168.0 + 3.3 = 171.3 → 171 = ab
    // b: 0.7·0xe8 + 0.3·0x36 = 162.4 + 16.2 = 178.6 → 179 = b3
    expect(blendOver("#f5f0e8", "#150b36", 0.7)).toBe("#b2abb3");
  });

  it("refuses an alpha outside 0..1", () => {
    expect(() => blendOver("#f5f0e8", "#150b36", 1.2)).toThrow(/alpha out of range/);
    expect(() => blendOver("#f5f0e8", "#150b36", -0.1)).toThrow(/alpha out of range/);
  });
});
