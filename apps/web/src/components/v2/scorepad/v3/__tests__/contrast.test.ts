// Task 5 (R1 chassis): the Scorebug's night-tile token pairs, checked
// against the real WCAG 2.x contrast formula rather than trusted by eye.
// `contrastRatio` is implemented HERE from the spec formula (not imported
// from a library) per the task brief. Hex values in ../tokens are not
// invented — they are copied verbatim from the --mk-* custom properties in
// apps/web/src/app/globals.css (globals.css is the token authority per
// .superpowers/sdd/2026-08-15-scorepad-v3-r1-chassis/pins.md §7 — scout-
// verified 2026-08-16 against globals.css:436-439, no disagreement found).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NIGHT_TILE_PAIRS,
  NIGHT_TILE_CLASSES,
  NIGHT_TILE_ALPHA_TEXT,
  SCORE_TEXT_PX,
  SCORE_TEXT_SIZE_CLASS,
} from "../tokens";

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
    // The /70,/80 opacity blend IS now independently AA-tested — see
    // "alpha (translucent) text meets WCAG AA..." below (Task A4, R2
    // wave), which composites these exact classes over the ground they
    // actually render on and re-derives AA from the result. This test
    // stays anyway: it guards something that block doesn't — that the HUE
    // can't drift to a different colour unnoticed. A class edit from
    // "text-cream/70" to some other family's "/70" would either throw in
    // resolveAlphaClass (no TAILWIND_UTILITY_HEX entry) or, if that other
    // family happened to be registered too, get judged on ITS OWN
    // contrast rather than being caught as "wrong colour" per se; this
    // string check anchors specifically to creamText, already proven
    // equal to NIGHT_TILE_PAIRS.creamOnNight.fg above.
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

// Task A4 (R2 wave): the block above (Task A3) proved AA only for
// NIGHT_TILE_PAIRS' FULL-opacity colours. scorebug.tsx also renders text
// through NIGHT_TILE_CLASSES.creamTextMuted (text-cream/70) and
// .creamTextSubtle (text-cream/80) — HalfContent's tappable-half hint span,
// the strip's non-accented items, and the context line — and nothing
// checked the colour a sighted user actually sees there: translucent cream
// composited over the tile's night ground, not the opaque #f5f0e8 the pairs
// above test against. Cricket (R2's first converted sport) renders its
// context line ("T20 · Over 0.5 · RR 14.4") and over-dots strip through
// exactly these two classes, so this was about to ship the first converted
// sport's most-read text with its contrast never checked.
//
// hexToRgb/rgbToHex/compositeOver are hand-rolled here — same stance as
// contrastRatio above (implemented from the spec, not imported).
// compositeOver does standard "source-over" alpha blending directly on the
// sRGB (gamma-encoded, 0-255) channel values: how a browser actually paints
// a translucent Tailwind text colour over an opaque background. This is
// NOT a linear-light blend — `color-interpolation` only governs SVG
// gradients/filters, not ordinary text/fill compositing, and mixing any
// colour with `transparent` (which is what Tailwind's opacity modifier
// compiles to) collapses to the same result regardless of the mix
// colourspace, since the transparent endpoint contributes zero premultiplied
// colour — so this matches real rendering independent of that detail.
//
// resolveAlphaClass parses the base colour AND the alpha fraction out of
// the CLASS STRING itself (NIGHT_TILE_ALPHA_TEXT.*.textClass), not a
// hand-copied number — the same reason NIGHT_TILE_CLASSES exists: a class
// edit (e.g. creamTextMuted going from /70 to /50) can't silently desync
// from what gets measured here. Same bug class Task A3 closed for colour,
// closed here for alpha.
function hexToRgb(hex: string): readonly [number, number, number] {
  const n = hex.replace("#", "");
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

function compositeOver(fgHex: string, alpha: number, bgHex: string): string {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  return rgbToHex([
    alpha * fg[0] + (1 - alpha) * bg[0],
    alpha * fg[1] + (1 - alpha) * bg[1],
    alpha * fg[2] + (1 - alpha) * bg[2],
  ]);
}

function resolveAlphaClass(cls: string): { hex: string; alpha: number } {
  const m = /^(.+)\/(\d+(?:\.\d+)?)$/.exec(cls);
  const base = m ? m[1] : cls;
  const alpha = m ? Number(m[2]) / 100 : 1;
  const hex = TAILWIND_UTILITY_HEX[base];
  if (!hex) {
    throw new Error(`resolveAlphaClass: no TAILWIND_UTILITY_HEX entry for base class "${base}" (from "${cls}")`);
  }
  return { hex, alpha };
}

describe("alpha (translucent) text meets WCAG AA at its EFFECTIVE composited colour, not the base token", () => {
  it("every alpha-text render site is small text, not large — the 4.5 floor below is the right one, never the lime score's 3.0", () => {
    // 11px (text-[11px]: hint, context line) / 12px (text-xs: strip muted)
    // — nowhere near WCAG's large-text carve-out (>=24px regular or
    // >=18.66px bold), unlike the lime score, which needs
    // SCORE_TEXT_PX/SCORE_TEXT_SIZE_CLASS above specifically because IT
    // claims the lower, more permissive floor and has to prove it.
    for (const site of Object.values(NIGHT_TILE_ALPHA_TEXT)) {
      expect(site.sizePx).toBeLessThan(18.66);
    }
  });

  it("hint text (text-cream/70 on the tile's base ground) clears the normal-text floor (4.5:1) at its composited colour", () => {
    const site = NIGHT_TILE_ALPHA_TEXT.hint;
    const { hex, alpha } = resolveAlphaClass(site.textClass);
    const bgHex = TAILWIND_UTILITY_HEX[site.bgClass];
    const composited = compositeOver(hex, alpha, bgHex);
    expect(contrastRatio(bgHex, composited)).toBeGreaterThanOrEqual(4.5);
  });

  it("strip non-accent text (text-cream/70 on the band) clears the normal-text floor (4.5:1) at its composited colour", () => {
    const site = NIGHT_TILE_ALPHA_TEXT.stripMuted;
    const { hex, alpha } = resolveAlphaClass(site.textClass);
    const bgHex = TAILWIND_UTILITY_HEX[site.bgClass];
    const composited = compositeOver(hex, alpha, bgHex);
    expect(contrastRatio(bgHex, composited)).toBeGreaterThanOrEqual(4.5);
  });

  it("context line (text-cream/80 on the band) clears the normal-text floor (4.5:1) at its composited colour", () => {
    const site = NIGHT_TILE_ALPHA_TEXT.contextLine;
    const { hex, alpha } = resolveAlphaClass(site.textClass);
    const bgHex = TAILWIND_UTILITY_HEX[site.bgClass];
    const composited = compositeOver(hex, alpha, bgHex);
    expect(contrastRatio(bgHex, composited)).toBeGreaterThanOrEqual(4.5);
  });
});

// Defect 1 (R2 review finding, docs/superpowers/plans/2026-08-16-scorepad-
// v3-r2-cricket.md): commit 792121a5 (task A3) set out to close the silent
// desync between THIS file's token math and scorebug.tsx's rendered
// classes — but every block above only ever reads ../tokens, never
// scorebug.tsx itself. A reviewer reintroduced a bare literal in place of a
// token reference ("text-night-2" where the lime score digits belong —
// night-2 is close to the tile's own night ground, so this is near-zero
// contrast, not merely a desync-risk) and the whole v3 suite (268/268 at the
// time) stayed green, because nothing anywhere renders this component or
// reads its source text. This block is that missing check: it reads
// scorebug.tsx's ACTUAL source (comments stripped first, so this file's own
// prose — e.g. scorebug.tsx's header comment saying "stadium-night" — can
// never false-positive) and fails if a literal that must route through a
// token appears bare, or if the "night" background family is ever paired
// with a "text-" prefix at all (no token does this — see NIGHT_TILE_CLASSES,
// ../tokens.ts — so it is banned outright, which is what actually catches a
// WRONG literal like the reviewer's, not merely a correct-but-undesynced
// one). Mutation-proved in this task's own report: reintroducing
// "text-night-2" at the score digits turns the "%s" case for "text-night"
// red; restoring the token reference turns it green again.
describe("scorebug.tsx's SOURCE TEXT carries no bare literal duplicating (or misusing) a night-tile token", () => {
  const scorebugSrc = readFileSync(join(process.cwd(), "src/components/v2/scorepad/v3/scorebug.tsx"), "utf8");
  // Strips both comment styles before matching, so prose mentioning these
  // words in English (this file's own comments included) can never trip a
  // false positive — only literal Tailwind classes in actual code can.
  const codeOnly = scorebugSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const bannedLiterals: readonly string[] = [
    NIGHT_TILE_CLASSES.tileBg, // "bg-night" — substring also flags "bg-night-2" (bandBg)
    NIGHT_TILE_CLASSES.creamText, // "text-cream" — substring also flags /70, /80 (creamTextMuted/creamTextSubtle)
    NIGHT_TILE_CLASSES.limeText, // "text-lime-400" — the score digits' colour
    SCORE_TEXT_SIZE_CLASS, // "text-4xl" — the score-size class
    // Not a real token at all (NIGHT_TILE_CLASSES has no text-* entry for
    // the night family — it is background-only, tileBg/bandBg) — banned
    // unconditionally rather than as a "duplicates a token" check. This is
    // the literal the reviewer actually used; see the mutation proof above.
    "text-night",
  ];

  it.each(bannedLiterals)("never appears as a bare literal outside a token reference: %s", (literal) => {
    expect(codeOnly.includes(literal)).toBe(false);
  });
});
