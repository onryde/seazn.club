// Task 5 (R1 chassis): the Scorebug's night-tile token pairs, checked
// against the real WCAG 2.x contrast formula rather than trusted by eye.
// `contrastRatio` is implemented HERE from the spec formula (not imported
// from a library) per the task brief. Hex values in ../tokens are not
// invented — they are copied verbatim from the --mk-* custom properties in
// apps/web/src/app/globals.css (globals.css is the token authority per
// .superpowers/sdd/2026-08-15-scorepad-v3-r1-chassis/pins.md §7 — scout-
// verified 2026-08-16 against globals.css:436-439, no disagreement found).
import { describe, it, expect } from "vitest";
import { NIGHT_TILE_PAIRS, NIGHT_TILE_CLASSES, SCORE_TEXT_PX, SCORE_TEXT_SIZE_CLASS } from "../tokens";

/** WCAG 2.x relative luminance of one sRGB channel (0-255) -> linear.
 *  https://www.w3.org/TR/WCAG21/#dfn-relative-luminance */
function srgbChannelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio — (L1+0.05)/(L2+0.05)
 *  with L1 the lighter of the two relative luminances. */
export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("contrastRatio (WCAG 2.x formula)", () => {
  it("is 21:1 for pure black on pure white (the formula's known extreme)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
  it("is 1:1 for identical colors", () => {
    expect(contrastRatio("#150b36", "#150b36")).toBeCloseTo(1, 5);
  });
  it("is symmetric in argument order", () => {
    expect(contrastRatio("#150b36", "#f5f0e8")).toBeCloseTo(contrastRatio("#f5f0e8", "#150b36"), 10);
  });

  // Fix round 1 (review, Important): the three checks above are all
  // gamma-INVARIANT — 0 and 1 map to themselves whether or not
  // srgbChannelToLinear's power-curve branch runs at all (0/12.92=0,
  // ((1+0.055)/1.055)^2.4=1), so a mutant that deletes sRGB linearisation
  // entirely (returns the normalised channel `s` unchanged) still passes
  // all three, AND still clears every real token pair's floor below
  // (naive/no-gamma values: creamOnNight 8.738 vs its 4.5 floor,
  // creamOnNight2 7.023 vs 4.5, limeOnNight 7.444 vs 3.0 — all still
  // "pass" without gamma correction at all). #767676 on white is the
  // standard reference gray where gamma-correct and naive-linear
  // contrast diverge enough to flip a real AA verdict: correct
  // (gamma-applied) ratio is ~4.5422 (clears the 4.5 floor, barely, for
  // real); naive (gamma deleted) is ~2.0478 (fails it outright). A
  // mutant deleting srgbChannelToLinear's curve is only catchable via a
  // pair like this one, not via an endpoint or an already-generous pair.
  it("distinguishes gamma-correct from naive-linear luminance (#767676 on white)", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.5422, 3);
  });
});

describe("night-tile token pairs meet WCAG AA", () => {
  it("cream-on-night (who-line/hint text on the base tile) clears the normal-text floor (4.5:1)", () => {
    const { bg, fg } = NIGHT_TILE_PAIRS.creamOnNight;
    expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
  });

  it("cream-on-night-2 (context/strip band text) clears the normal-text floor (4.5:1)", () => {
    const { bg, fg } = NIGHT_TILE_PAIRS.creamOnNight2;
    expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
  });

  it("lime-on-night (the score digits) clears the large-text floor (3.0:1) at its actual rendered size", () => {
    // scorebug.tsx renders `big` at Tailwind text-4xl (36px) + font-bold —
    // both comfortably inside WCAG's "large text" definition (>=24px
    // regular, or >=18.66px bold), which is what licenses the lower 3.0
    // bar for this pair instead of the 4.5 normal-text bar. This isn't
    // asserted from a comment alone: SCORE_TEXT_PX is the same constant
    // scorebug.tsx is documented to render `big` at, checked below.
    const { bg, fg } = NIGHT_TILE_PAIRS.limeOnNight;
    expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(3.0);
  });

  it("the lime pair's large-text carve-out is backed by an actual >=24px rendered size", () => {
    expect(SCORE_TEXT_PX).toBeGreaterThanOrEqual(24);
  });
});

// Task A3 (R2 wave, silent-desync closure): before this block, scorebug.tsx
// hand-matched NIGHT_TILE_PAIRS's colours in its OWN literal Tailwind
// classes ("bg-night", "text-cream", "text-lime-400"). Editing scorebug.tsx
// changed what rendered without changing what this FILE measures, because
// nothing tied the two together — a class edit there was invisible here.
// The fix: scorebug.tsx no longer owns those literals at all — it imports
// NIGHT_TILE_CLASSES/SCORE_TEXT_SIZE_CLASS from ../tokens and renders
// those verbatim, so the class name lives in exactly ONE place. This block
// proves that place agrees with what NIGHT_TILE_PAIRS was proven against.
//
// TAILWIND_UTILITY_HEX is deliberately NOT derived from NIGHT_TILE_PAIRS —
// it's independently sourced from globals.css's `@theme inline` block
// (bg-night/-night-2/text-cream <- --mk-night/-night-2/-cream,
// globals.css:51-55 + :436-439) and Tailwind's own built-in palette
// (lime-400 = #a3e635 upstream default; globals.css:52 notes it
// coincidentally equals --mk-lime). A table derived FROM NIGHT_TILE_PAIRS
// would make this whole block circular — it would agree with itself no
// matter what NIGHT_TILE_CLASSES said.
const TAILWIND_UTILITY_HEX: Record<string, string> = {
  "bg-night": "#150b36",
  "bg-night-2": "#1d1145",
  "text-cream": "#f5f0e8",
  "text-lime-400": "#a3e635",
};

const TAILWIND_TEXT_SIZE_PX: Record<string, number> = {
  "text-4xl": 36,
};

describe("scorebug.tsx renders exactly what this file measures (the wiring, not just the token)", () => {
  it("NIGHT_TILE_CLASSES resolve to the same hex NIGHT_TILE_PAIRS was proven against", () => {
    expect(TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.tileBg]).toBe(NIGHT_TILE_PAIRS.creamOnNight.bg);
    expect(TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.tileBg]).toBe(NIGHT_TILE_PAIRS.limeOnNight.bg);
    expect(TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.bandBg]).toBe(NIGHT_TILE_PAIRS.creamOnNight2.bg);
    expect(TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.creamText]).toBe(NIGHT_TILE_PAIRS.creamOnNight.fg);
    expect(TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.creamText]).toBe(NIGHT_TILE_PAIRS.creamOnNight2.fg);
    expect(TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.limeText]).toBe(NIGHT_TILE_PAIRS.limeOnNight.fg);
  });

  it("the muted/subtle cream variants (hint + context/strip text) are still the SAME cream name, not an independent colour", () => {
    // Not independently AA-tested against the /70,/80 opacity blend — a
    // pre-existing R1 scope choice (contrast.test.ts, above, checks
    // full-opacity cream only). This only guards that the hue can't drift
    // out from under those variants unnoticed.
    expect(NIGHT_TILE_CLASSES.creamTextMuted).toBe(`${NIGHT_TILE_CLASSES.creamText}/70`);
    expect(NIGHT_TILE_CLASSES.creamTextSubtle).toBe(`${NIGHT_TILE_CLASSES.creamText}/80`);
  });

  it("re-derives AA from the class-resolved hex directly, not by trusting the agreement check above", () => {
    expect(
      contrastRatio(TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.tileBg], TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.creamText]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.bandBg], TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.creamText]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.tileBg], TAILWIND_UTILITY_HEX[NIGHT_TILE_CLASSES.limeText]),
    ).toBeGreaterThanOrEqual(3.0);
  });

  it("SCORE_TEXT_SIZE_CLASS renders the same pixel size SCORE_TEXT_PX licenses the large-text floor for", () => {
    expect(TAILWIND_TEXT_SIZE_PX[SCORE_TEXT_SIZE_CLASS]).toBe(SCORE_TEXT_PX);
  });
});
