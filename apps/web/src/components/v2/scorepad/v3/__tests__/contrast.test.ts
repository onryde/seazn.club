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
// PAD_CLASS_HEX is deliberately NOT derived from NIGHT_TILE_PAIRS — it is
// independently sourced from globals.css itself. A table derived FROM
// NIGHT_TILE_PAIRS would make this whole block circular: it would agree with
// itself no matter what NIGHT_TILE_CLASSES said.
//
// R3/task B4 (owner ruling R3-6, per-sport visual identity) moved the render
// path off Tailwind utilities naming a FIXED colour and onto globals.css's
// `.pad-*` rules, which read `var(--sport-*)`. The table below therefore now
// resolves those classes with NO override in scope — i.e. cricket, and every
// sport before its own wave. It is still independently sourced, and the chain
// is one step longer, not different in kind:
//
//   .pad-board { background-color: var(--sport-board) }   [globals.css]
//   :root { --sport-board: var(--mk-night) }              [globals.css]
//   --mk-night: #150b36                                   [globals.css:487]
//
// `pad-led` is the one entry that needed real work. It defaults to
// `var(--color-lime-400)` — the exact var `text-lime-400` compiled to — and
// under Tailwind v4 (4.3.1 here) that theme entry is
// `oklch(84.1% 0.238 128.85)`, NOT the `#a3e635` this table asserted from R1
// until B4. #9ae600 is that oklch taken to sRGB (the CSS Color 4 §13.2 gamut
// map and a naive clip agree to the byte). The verdict never moved — 12.09:1
// against a 3.0 floor — but the oracle had been measuring a colour the build
// stopped painting at the v4 upgrade, so it is corrected rather than noted.
// See ../tokens.ts's NIGHT_TILE_PAIRS.limeOnNight for the same note at the
// token, and __tests__/sport-theme.test.ts for the cricket-is-unchanged locks.
const PAD_CLASS_HEX: Record<string, string> = {
  "pad-board": "#150b36",
  "pad-board-2": "#1d1145",
  "pad-ink": "#f5f0e8",
  "pad-led": "#9ae600",
  "pad-led-dot": "#9ae600",
  "pad-led-edge": "#9ae600",
};

const TAILWIND_TEXT_SIZE_PX: Record<string, number> = {
  "text-4xl": 36,
};

describe("scorebug.tsx renders exactly what this file measures (the wiring, not just the token)", () => {
  it("NIGHT_TILE_CLASSES resolve to the same hex NIGHT_TILE_PAIRS was proven against", () => {
    expect(PAD_CLASS_HEX[NIGHT_TILE_CLASSES.tileBg]).toBe(NIGHT_TILE_PAIRS.creamOnNight.bg);
    expect(PAD_CLASS_HEX[NIGHT_TILE_CLASSES.tileBg]).toBe(NIGHT_TILE_PAIRS.limeOnNight.bg);
    expect(PAD_CLASS_HEX[NIGHT_TILE_CLASSES.bandBg]).toBe(NIGHT_TILE_PAIRS.creamOnNight2.bg);
    expect(PAD_CLASS_HEX[NIGHT_TILE_CLASSES.creamText]).toBe(NIGHT_TILE_PAIRS.creamOnNight.fg);
    expect(PAD_CLASS_HEX[NIGHT_TILE_CLASSES.creamText]).toBe(NIGHT_TILE_PAIRS.creamOnNight2.fg);
    expect(PAD_CLASS_HEX[NIGHT_TILE_CLASSES.limeText]).toBe(NIGHT_TILE_PAIRS.limeOnNight.fg);
  });

  it("the muted/subtle cream variants (hint + context/strip text) are still the SAME cream name, not an independent colour", () => {
    // The /70,/80 opacity blend IS now independently AA-tested — see
    // "alpha (translucent) text meets WCAG AA..." below (Task A4, R2
    // wave), which composites these exact classes over the ground they
    // actually render on and re-derives AA from the result. This test
    // stays anyway: it guards something that block doesn't — that the HUE
    // can't drift to a different colour unnoticed. A class edit from
    // "text-cream/70" to some other family's "/70" would either throw in
    // resolveAlphaClass (no PAD_CLASS_HEX entry) or, if that other
    // family happened to be registered too, get judged on ITS OWN
    // contrast rather than being caught as "wrong colour" per se; this
    // string check anchors specifically to creamText, already proven
    // equal to NIGHT_TILE_PAIRS.creamOnNight.fg above.
    expect(NIGHT_TILE_CLASSES.creamTextMuted).toBe(`${NIGHT_TILE_CLASSES.creamText}-70`);
    expect(NIGHT_TILE_CLASSES.creamTextSubtle).toBe(`${NIGHT_TILE_CLASSES.creamText}-80`);
  });

  it("re-derives AA from the class-resolved hex directly, not by trusting the agreement check above", () => {
    expect(
      contrastRatio(PAD_CLASS_HEX[NIGHT_TILE_CLASSES.tileBg], PAD_CLASS_HEX[NIGHT_TILE_CLASSES.creamText]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(PAD_CLASS_HEX[NIGHT_TILE_CLASSES.bandBg], PAD_CLASS_HEX[NIGHT_TILE_CLASSES.creamText]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(PAD_CLASS_HEX[NIGHT_TILE_CLASSES.tileBg], PAD_CLASS_HEX[NIGHT_TILE_CLASSES.limeText]),
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
  // B4: the alpha now rides a globals.css class SUFFIX (`pad-ink-70`) rather
  // than a Tailwind opacity modifier (`text-cream/70`) — the guarantee is
  // unchanged, because it is still parsed out of the CLASS STRING itself and
  // never hand-copied. Two digits minimum on purpose: `pad-board-2` is a
  // SURFACE, not an alpha variant, and must stay opaque here.
  const m = /^(pad-[a-z]+)-(\d{2,3})$/.exec(cls);
  const base = m ? m[1] : cls;
  const alpha = m ? Number(m[2]) / 100 : 1;
  const hex = PAD_CLASS_HEX[base];
  if (!hex) {
    throw new Error(`resolveAlphaClass: no PAD_CLASS_HEX entry for base class "${base}" (from "${cls}")`);
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
    const bgHex = PAD_CLASS_HEX[site.bgClass];
    const composited = compositeOver(hex, alpha, bgHex);
    expect(contrastRatio(bgHex, composited)).toBeGreaterThanOrEqual(4.5);
  });

  it("strip non-accent text (text-cream/70 on the band) clears the normal-text floor (4.5:1) at its composited colour", () => {
    const site = NIGHT_TILE_ALPHA_TEXT.stripMuted;
    const { hex, alpha } = resolveAlphaClass(site.textClass);
    const bgHex = PAD_CLASS_HEX[site.bgClass];
    const composited = compositeOver(hex, alpha, bgHex);
    expect(contrastRatio(bgHex, composited)).toBeGreaterThanOrEqual(4.5);
  });

  it("context line (text-cream/80 on the band) clears the normal-text floor (4.5:1) at its composited colour", () => {
    const site = NIGHT_TILE_ALPHA_TEXT.contextLine;
    const { hex, alpha } = resolveAlphaClass(site.textClass);
    const bgHex = PAD_CLASS_HEX[site.bgClass];
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
    // B4: the four literals ABOVE are now also "the pre-token colour" — a
    // reintroduction would paint a fixed hue that no longer follows the
    // sport, which is a strictly worse bug than the desync they were banned
    // for. The three below are the post-B4 equivalents: every `.pad-*` class
    // must arrive through NIGHT_TILE_CLASSES, never be retyped here.
    // Substring matching does the rest ("pad-board" also flags
    // "pad-board-2"; "pad-ink" flags "-70"/"-80"/"-rule"; "pad-led" flags
    // "-dot"/"-edge"/"-panel"), so this stays three entries as the class set
    // grows.
    "pad-board",
    "pad-ink",
    "pad-led",
  ];

  it.each(bannedLiterals)("never appears as a bare literal outside a token reference: %s", (literal) => {
    expect(codeOnly.includes(literal)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R3/task B4 — EVERY SPORT'S PALETTE, not just the default one.
//
// Owner ruling R3-6 turned one fixed palette into a per-sport one, so a
// contrast suite that only measures the defaults now measures whatever the
// LAST un-themed sport happens to render and calls the whole set proven. The
// blocks below iterate `SPORT_PALETTES` + the defaults, so a sport added in R4
// -R7 is covered the day its entry lands, never the day someone remembers to
// add a test — the same "collect from the source, don't hand-list" stance the
// skins' own copy-truth suites take.
//
// Why this is the wave that has to be strict about it: football's accent is
// AMBER and its cards are YELLOW and RED. Amber-on-dark and yellow-on-dark are
// exactly the pairs a reviewer's eye passes and the formula fails (or the
// reverse) — bright hues read as high-contrast while their relative luminance
// says otherwise. Every ratio here is computed; none is eyeballed.
//
// The floors, and what licenses each:
//   4.5  ink and LED text on the board/band. The LED panel renders at 12px
//        (`text-xs`, scorebug.tsx) with a 0.85em label, nowhere near WCAG's
//        large-text carve-out, so the accent gets the STRICT floor here — not
//        the 3.0 the 36px score digits are separately licensed for above.
//   3.0  the card swatch's boundary against the sheet (WCAG 1.4.11, non-text).
// ---------------------------------------------------------------------------
import {
  DEFAULT_SPORT_PALETTE,
  SPORT_PALETTES,
  SPORT_TONES,
  resolveSportPalette,
  sportCustomProperty,
} from "../sport-theme";
import { parseCss, readGlobalsCss } from "./_globals-css";

/** Default + one entry per sport that overrides. Named so a failure message
 *  says WHICH sport is unreadable, not merely that something is. */
const PALETTES: readonly (readonly [string, ReturnType<typeof resolveSportPalette>])[] = [
  ["default (cricket, and every sport before its own wave)", DEFAULT_SPORT_PALETTE],
  ...Object.keys(SPORT_PALETTES).map(
    (key) => [key, resolveSportPalette(key)] as readonly [string, ReturnType<typeof resolveSportPalette>],
  ),
];

describe.each(PALETTES)("board palette meets WCAG AA — %s", (_name, palette) => {
  it("ink on the board clears the normal-text floor (4.5:1)", () => {
    expect(contrastRatio(palette.board, palette.ink)).toBeGreaterThanOrEqual(4.5);
  });

  it("ink on the band clears the normal-text floor (4.5:1)", () => {
    expect(contrastRatio(palette["board-2"], palette.ink)).toBeGreaterThanOrEqual(4.5);
  });

  it("the LED accent on its panel ground clears the STRICT floor (4.5:1), not the score's large-text 3.0", () => {
    // The panel's ground is `--sport-board` inside the `--sport-board-2` band
    // (globals.css `.pad-led-panel`) — a real recess, and both ends are named
    // tokens rather than a mixed value, which is what lets this be computed
    // exactly instead of approximated.
    expect(contrastRatio(palette.board, palette.led)).toBeGreaterThanOrEqual(4.5);
  });

  it("the LED accent also clears 4.5:1 on the BAND, where the serving dot and top hairline sit", () => {
    expect(contrastRatio(palette["board-2"], palette.led)).toBeGreaterThanOrEqual(4.5);
  });

  it("the two alpha ink variants clear 4.5:1 at their COMPOSITED colour on both grounds", () => {
    for (const alpha of [0.7, 0.8]) {
      for (const ground of [palette.board, palette["board-2"]]) {
        expect(contrastRatio(ground, compositeOver(palette.ink, alpha, ground))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

// The card code renders on the DAYLIGHT sheet (guided-sheet.tsx's choice row),
// not the night board — a different ground with a different obligation, and
// the place the naive answer goes wrong. A yellow FILL on the pale wash it
// sits in is about 1.15:1: nowhere near WCAG 1.4.11's 3:1 for a graphical
// object. So the swatch's boundary is carried by its `--sport-board` hairline
// (globals.css `.pad-card-swatch`), and the fill is deliberately NOT
// load-bearing. Both facts are asserted, so a later "simplify" that drops the
// border reds here instead of shipping an invisible yellow card.
const SHEET_GROUND = "#ffffff"; // guided-sheet.tsx choiceButtonClass: bg-white
const SHEET_LABEL = "#314158"; // text-slate-700, Tailwind v4 oklch(37.2% .044 257.287) -> sRGB
const WASH_ALPHA = 0.12; // globals.css .pad-tone-wash
const WASH_HOVER_ALPHA = 0.2; // globals.css .pad-tone-wash:hover

describe.each(PALETTES)("card-code tones meet WCAG on the sheet — %s", (_name, palette) => {
  it.each([...SPORT_TONES])("%s: the option label stays readable on its tinted wash (4.5:1)", (tone) => {
    for (const alpha of [WASH_ALPHA, WASH_HOVER_ALPHA]) {
      const wash = compositeOver(palette[tone], alpha, SHEET_GROUND);
      expect(contrastRatio(wash, SHEET_LABEL)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([...SPORT_TONES])("%s: the swatch's dark hairline carries the 1.4.11 boundary (3:1), not the fill", (tone) => {
    const wash = compositeOver(palette[tone], WASH_ALPHA, SHEET_GROUND);
    expect(contrastRatio(wash, palette.board)).toBeGreaterThanOrEqual(3.0);
  });

  it.each([...SPORT_TONES])("%s: and the FILL alone would NOT have — the reason the hairline exists", (tone) => {
    // A live assertion, not a comment: if a future palette picked a tone dark
    // enough to carry its own boundary this would red, and the right response
    // is to re-derive the rule, not to delete the border.
    const wash = compositeOver(palette[tone], WASH_ALPHA, SHEET_GROUND);
    const fillOnWash = contrastRatio(wash, palette[tone]);
    const hairlineOnWash = contrastRatio(wash, palette.board);
    expect(hairlineOnWash).toBeGreaterThan(fillOnWash);
  });
});

// ---------------------------------------------------------------------------
// R3/task D — THE TILE GRID's own translucent text, which this file had never
// measured.
//
// Everything above measures the SCOREBUG. tile-grid.tsx renders a second
// piece of alpha text — `TileSpec.sublabel`, the word that says WHICH SIDE a
// tile belongs to — and nothing checked it, because until football no skin
// declared one on a `primary` tile. On violet-600 that is the one tile ground
// in this chassis that is neither white nor the night board, and white at 70%
// composites there to #d9bdff: 3.55:1 at 11px, a real WCAG AA failure on the
// most load-bearing word of a two-lane board. An axe scan in
// scorepad-skins.spec.ts is what found it; this is the cheap gate that keeps
// it found.
//
// BOTH halves are parsed out of tile-grid.tsx's own SOURCE — the opacity from
// the sublabel span and the ground from `KIND_CLASS.primary` — so neither can
// desync from what ships, the same stance `resolveAlphaClass` above takes for
// the scorebug's classes.
// ---------------------------------------------------------------------------

describe("tile-grid.tsx's sublabel clears WCAG AA on every tile ground it can land on", () => {
  const tileGridSrc = readFileSync(join(process.cwd(), "src/components/v2/scorepad/v3/tile-grid.tsx"), "utf8");
  const codeOnly = tileGridSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  /** Tailwind's own values for the two literals `KIND_CLASS` uses as a tile's
   *  ground, and the text colour each pairs with. Hand-copied ONCE, here,
   *  because Tailwind's palette is not importable — the CLASS NAMES are read
   *  from the source below, so a change of class reds this rather than
   *  silently measuring the old one. */
  /** Tailwind's own values for every literal `KIND_CLASS` uses as a tile's
   *  ground or its text, read out of the BUILT stylesheet rather than from
   *  memory: v3's palette moved several of these (slate-700 is #314158, not
   *  the #334155 older references quote; red-600 is #e40014, not #dc2626),
   *  and the difference is enough to flip a 4.35 into a 4.5. The CLASS NAMES
   *  are parsed from the source below, so a change of class reds this rather
   *  than silently measuring the old one. */
  const TAILWIND: Readonly<Record<string, string>> = {
    "violet-600": "#7f22fe",
    white: "#ffffff",
    transparent: "#ffffff", // a transparent tile composites over the pad's white ground
    "slate-500": "#62748e",
    "slate-600": "#45556c",
    "slate-700": "#314158",
    // BOTH declarations ship for this one, and they are not the same colour:
    // the stylesheet emits `--color-red-600:#e40014` as an sRGB fallback AND
    // `lab(48.4493% 77.4328 61.5452)`, which every browser this app supports
    // actually composites — that converts to #e7000b. Measuring the fallback
    // overstates the margin (4.59 vs the real 4.54). The rule for this table
    // is therefore: where a token ships two declarations, record the one the
    // BROWSER uses, not the one that is easier to read out of the file. The
    // R4 commit that added this row claimed to "read the built stylesheet"
    // and read the wrong half of it.
    "red-600": "#e7000b",
  };

  function sublabelAlpha(): number {
    const spans = [...codeOnly.matchAll(/text-\[11px\]\s+opacity-(\d{2,3})/g)].map((m) => Number(m[1]));
    expect(spans.length, "tile-grid.tsx must still render the sublabel as 11px alpha text").toBeGreaterThan(0);
    expect(new Set(spans).size, "both sublabel branches must carry the SAME opacity").toBe(1);
    return spans[0]! / 100;
  }

  /** Every per-kind tone override on the sublabel, as a kind -> tone map.
   *
   *  This used to be a single `.match()` that returned a tone only when the
   *  FIRST override in the file happened to be the kind being asked about.
   *  Its own comment claimed the opposite — "parsed rather than hand-listed so
   *  adding a second override cannot silently escape the sweep" — and a second
   *  override would have done exactly that: `sublabelToneFor("destructive")`
   *  would answer undefined, the sweep would measure the INHERITED text-red-600
   *  instead of the override, and the new tone would go unverified. Third
   *  instance of the same shape in this one file (the kinds sweep sliced to
   *  four before counting; the red-600 row read the sRGB fallback rather than
   *  the lab() value browsers composite), which is why this one is a map. */
  function sublabelTones(): ReadonlyMap<string, string> {
    // Take the sublabel span's WHOLE class template first, then find every
    // per-kind ternary inside it. Anchoring the ternary to the
    // `text-[11px] opacity-NN` prefix — which the first two attempts at this
    // did — can only ever see the FIRST override, because the second one is
    // preceded by the first, not by the prefix. Proven by mutation: adding a
    // second override (`destructive` -> a failing light red) left the suite
    // green under the anchored form.
    const templates = [...codeOnly.matchAll(/className=\{`([^`]*text-\[11px\][^`]*)`\}/g)].map((m) => m[1]!);
    expect(templates.length, "tile-grid.tsx must still build the sublabel class as a template literal").toBeGreaterThan(0);
    const out = new Map<string, string>();
    for (const tpl of templates) {
      for (const m of tpl.matchAll(/tile\.kind === "(\w+)"\s*\?\s*"text-([\w-]+)"/g)) {
        const [, kind, tone] = m;
        const seen = out.get(kind!);
        // Both sublabel branches render the same overrides, so a repeat is
        // expected — a CONFLICT between the two branches is not.
        expect(seen === undefined || seen === tone, `tile-grid.tsx gives kind "${kind}" two different sublabel tones`).toBe(true);
        out.set(kind!, tone!);
      }
    }
    return out;
  }

  function sublabelToneFor(kind: string): string | undefined {
    return sublabelTones().get(kind);
  }

  it("every per-kind sublabel tone override in the source is one the sweep below measures", () => {
    // The guard that makes the map honest: a tone declared for a kind that
    // KIND_CLASS does not know about would be parsed and then never measured.
    const kinds = new Set(kindsFromSource().map((k) => k.kind));
    for (const kind of sublabelTones().keys()) {
      expect(kinds.has(kind), `sublabel declares a tone for unknown tile kind "${kind}"`).toBe(true);
    }
  });

  /** Every tile kind, PARSED out of KIND_CLASS — never hand-listed.
   *
   *  R3 checked `primary` and `standard` only, while this describe's own name
   *  claimed every ground, and its comment justified the omission: "`primary`
   *  is the only KIND_CLASS ground that is a saturated colour rather than
   *  white/transparent, so it is the binding case: pass here and every other
   *  kind passes with room."
   *
   *  That is FALSE, and R4 paid for it. The binding case is not the saturated
   *  GROUND, it is the lightest TEXT — `minor`'s slate-500, which at 90% on
   *  white is 3.91:1. It went unmeasured for a wave and shipped a real axe
   *  failure the moment tennis put the first sublabel on a `minor` tile.
   *  Deriving the list from the source is the actual fix: a kind that exists
   *  is a kind that is measured, and a fifth one cannot be forgotten. */
  function kindsFromSource(): { kind: string; text: string; ground: string }[] {
    // Bounded to KIND_CLASS's OWN object literal, and NOT `.slice(0, 4)`.
    //
    // The first version of this sweep sliced to four before asserting there
    // were four, so the assertion could only ever catch FEWER kinds — a fifth
    // was silently dropped and never measured. That is the precise bug this
    // rewrite exists to prevent, reintroduced inside the fix for it; caught by
    // review, which added a fifth failing kind and watched the suite stay
    // green. Take the whole literal and let the cross-check below decide.
    const open = codeOnly.indexOf("const KIND_CLASS");
    expect(open, "tile-grid.tsx must still declare KIND_CLASS").toBeGreaterThan(-1);
    const block = codeOnly.slice(open, codeOnly.indexOf("};", open));
    const rows = [...block.matchAll(/(\w+):\s*"([^"]+)"/g)];

    // Cross-checked against the TYPE, in the other file, so neither side can
    // drift alone: a kind added to the union but not to KIND_CLASS, or to
    // KIND_CLASS but not measured here, reds.
    const typesSrc = readFileSync(join(process.cwd(), "src/components/v2/scorepad/v3/types.ts"), "utf8");
    const union = /export type TileKind\s*=\s*([^;]+);/.exec(typesSrc)?.[1] ?? "";
    const declared = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
    expect(declared.length, "types.ts must still declare the TileKind union as string literals").toBeGreaterThan(0);
    expect([...rows.map(([, k]) => k)].sort(), "every TileKind must have a KIND_CLASS row, and vice versa").toEqual(
      [...declared].sort(),
    );
    return rows.map(([, kind, classes]) => {
      const text = /text-([\w-]+)/.exec(classes)?.[1];
      const ground = /bg-([\w-]+)/.exec(classes)?.[1];
      expect(text, `KIND_CLASS.${kind} must declare a text colour`).toBeTruthy();
      expect(ground, `KIND_CLASS.${kind} must declare a ground`).toBeTruthy();
      return { kind: kind!, text: text!, ground: ground! };
    });
  }

  it("clears 4.5:1 on EVERY tile kind's own ground — parsed from KIND_CLASS, not hand-listed", () => {
    const alpha = sublabelAlpha();
    const failures: string[] = [];
    for (const { kind, text, ground } of kindsFromSource()) {
      const toneOverride = sublabelToneFor(kind);
      const fg = TAILWIND[toneOverride ?? text];
      const bg = TAILWIND[ground];
      expect(fg, `no measured value for text colour ${toneOverride ?? text} (kind ${kind})`).toBeTruthy();
      expect(bg, `no measured value for ground ${ground} (kind ${kind})`).toBeTruthy();
      const ratio = contrastRatio(compositeOver(fg!, alpha, bg!), bg!);
      if (ratio < 4.5) failures.push(`${kind}: ${ratio.toFixed(2)}:1 (${toneOverride ?? text} on ${ground})`);
    }
    expect(failures, `sublabel fails WCAG AA on: ${failures.join(", ")}`).toEqual([]);
  });

  it("the PRIMARY tile — white on violet-600, the ground football's Goal tiles use", () => {
    expect(codeOnly, "KIND_CLASS.primary must still be white text on violet-600").toContain(
      "bg-violet-600 font-semibold text-white",
    );
    const composited = compositeOver(TAILWIND.white!, sublabelAlpha(), TAILWIND["violet-600"]!);
    expect(contrastRatio(composited, TAILWIND["violet-600"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("the MINOR tile — the LIGHTEST text in the set, which is the real binding case", () => {
    // Tennis's Award-game tiles are the first `minor` tile anywhere to carry a
    // sublabel. Inheriting slate-500 at 90% is 3.91:1; the kind takes
    // slate-600 instead, which is 5.83:1.
    expect(codeOnly).toContain("bg-transparent font-medium text-slate-500");
    expect(sublabelToneFor("minor"), "the minor sublabel must keep its own darker tone").toBe("slate-600");
    const composited = compositeOver(TAILWIND["slate-600"]!, sublabelAlpha(), TAILWIND.white!);
    expect(contrastRatio(composited, TAILWIND.white!)).toBeGreaterThanOrEqual(4.5);
  });

  it("the STANDARD tile — slate-700 on white", () => {
    expect(codeOnly).toContain("bg-white font-medium text-slate-700");
    const composited = compositeOver(TAILWIND["slate-700"]!, sublabelAlpha(), TAILWIND.white!);
    expect(contrastRatio(composited, TAILWIND.white!)).toBeGreaterThanOrEqual(4.5);
  });

  it("the DESTRUCTIVE tile — red-600 on white, which passes by only 0.04", () => {
    // 4.54:1 against the lab() colour browsers actually composite (see the
    // TAILWIND note). Recorded with its margin BECAUSE it is thin: a palette
    // nudge of one step, or any future dimming of this element, drops it
    // under the floor. It was never measured at all before R4.
    expect(codeOnly).toContain("bg-white font-medium text-red-600");
    const composited = compositeOver(TAILWIND["red-600"]!, sublabelAlpha(), TAILWIND.white!);
    expect(contrastRatio(composited, TAILWIND.white!)).toBeGreaterThanOrEqual(4.5);
  });

  it("is measured at SMALL-text rules, never the score's large-text carve-out", () => {
    // 11px regular is nowhere near WCAG's >=24px regular / >=18.66px bold
    // carve-out, so 4.5 is the right floor above and 3.0 would be wrong.
    expect(codeOnly).toContain("text-[11px]");
    expect(codeOnly).not.toContain("text-[11px] font-bold");
  });
});

describe("the tones are NON-TEXT colours, and this is where that stops being a comment", () => {
  it("football's dismissal red would FAIL as text on its own board — 3.01:1, under the 4.5 floor", () => {
    // The single most load-bearing number in this file. #d00000 on #0b1f16 is
    // 3.01:1: it clears WCAG 1.4.11 for a graphical object by 0.01 and misses
    // the 4.5 text floor by a mile — and it looks perfectly bold to the eye,
    // which is precisely why "amber-on-dark and yellow-on-dark" got called out
    // as the pairs to compute rather than judge. `--sport-dismissal` is
    // therefore licensed for SWATCHES ONLY. A later wave putting a red-card
    // indicator on the night board as TEXT has to change this assertion first,
    // which is the point.
    const football = resolveSportPalette("football");
    expect(contrastRatio(football.board, football.dismissal)).toBeLessThan(4.5);
    expect(contrastRatio(football.board, football.dismissal)).toBeGreaterThanOrEqual(3.0);
  });

  // R4/tennis. The licence above is football's, and it is football-shaped: a
  // card IS a swatch, so a tone that fails the text floor is correct there.
  // Tennis has no cards. Its penalty ladder (warning -> point penalty -> game
  // penalty -> default, nested/kernel.ts:250-255) is WORDS, so both of its
  // tones land on text and both owe the full 4.5.
  //
  // Pinned here rather than left to the licence scan below, because that scan
  // is usage-driven: it can only see a tone once a skin renders text in it, so
  // it says nothing at all about a palette that has landed ahead of its skin.
  // Established by mutation — with the tennis skin absent, reverting
  // `dismissal` to the originally-specced #c1272d (2.63:1) reds NOTHING
  // without this block.
  it("tennis's tones are TEXT, not swatches, so both clear the 4.5 floor on its own board", () => {
    const tennis = resolveSportPalette("tennis");
    for (const tone of ["caution", "dismissal"] as const) {
      const ratio = contrastRatio(tennis.board, tennis[tone]);
      expect(ratio, `tennis --sport-${tone} is ${ratio.toFixed(2)}:1 on its own board`).toBeGreaterThanOrEqual(4.5);
    }
    // The pip is the identity: `led` carries the serving player's mark and the
    // strip digits, so it is text-adjacent at minimum and holds the same floor.
    expect(contrastRatio(tennis.board, tennis.led)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tennis["board-2"], tennis.ink)).toBeGreaterThanOrEqual(4.5);
  });

  // R3 review round — THIS LICENCE HAD ALMOST NO TEETH. It grepped globals.css
  // for the literal `color: var(--sport-<tone>)` and therefore missed the
  // unspaced form, any wrapper (`color-mix(...)`), an arbitrary Tailwind value
  // (`text-[var(--sport-dismissal)]`), an inline style, and — the one that
  // matters most — the indirection the chassis actually uses everywhere:
  // `.pad-tone-dismissal { --pad-tone: var(--sport-dismissal) }`, read back as
  // `var(--pad-tone)`. A rule painting text from `--pad-tone` would have sailed
  // straight through the assertion written to forbid exactly that.
  //
  // Rewritten to resolve the ALIAS GRAPH out of globals.css itself, and to scan
  // the chassis source as well as the stylesheet.
  describe("the licence, enforced through every route a tone can reach text", () => {
    const rules = parseCss(readGlobalsCss());
    /** Text-colour properties. `-webkit-text-fill-color` is in the list because
     *  it WINS over `color` wherever both are set, so forbidding `color` alone
     *  would leave the exact bypass a determined edit reaches for. */
    const TEXT_PROPS = ["color", "-webkit-text-fill-color"];

    /** Every custom property that resolves, transitively, to a tone. Computed
     *  to a fixpoint rather than hand-listed, so a THIRD indirection added
     *  later is covered the day it lands. */
    function toneAliases(): Set<string> {
      const aliases = new Set(SPORT_TONES.map((tone) => sportCustomProperty(tone)));
      for (let pass = 0; pass < 8; pass++) {
        const before = aliases.size;
        for (const rule of rules) {
          for (const raw of rule.declarations.split(";")) {
            const colon = raw.indexOf(":");
            if (colon === -1) continue;
            const name = raw.slice(0, colon).trim();
            const value = raw.slice(colon + 1);
            if (!name.startsWith("--")) continue;
            if ([...aliases].some((alias) => value.includes(`var(${alias}`))) aliases.add(name);
          }
        }
        if (aliases.size === before) break;
      }
      return aliases;
    }

    it("resolves the indirection the chassis actually uses — --pad-tone IS a tone", () => {
      // Vacuity guard: if this stopped finding `--pad-tone`, every assertion
      // below would still pass while checking nothing that ships.
      const aliases = toneAliases();
      expect([...aliases]).toContain("--pad-tone");
      expect(aliases.size).toBeGreaterThan(SPORT_TONES.length);
    });

    it("no rule in globals.css sets a TEXT colour from a tone, by any route", () => {
      const aliases = [...toneAliases()];
      const offenders: string[] = [];
      for (const rule of rules) {
        for (const raw of rule.declarations.split(";")) {
          const colon = raw.indexOf(":");
          if (colon === -1) continue;
          const name = raw.slice(0, colon).trim();
          const value = raw.slice(colon + 1);
          if (!TEXT_PROPS.includes(name)) continue;
          if (aliases.some((alias) => value.includes(`var(${alias}`))) {
            offenders.push(`${rule.selector} { ${name}:${value.trim()} }`);
          }
        }
      }
      expect(offenders, `a tone is painted as text:\n${offenders.join("\n")}`).toEqual([]);
    });

    it("and no chassis or skin file reaches one through an arbitrary utility or an inline style", () => {
      // The two routes that never touch globals.css at all: Tailwind's
      // arbitrary-value syntax, and a React `style={{ color: … }}`. Comments
      // stripped first so prose naming a token cannot false-positive.
      const files = [
        "scorebug.tsx",
        "tile-grid.tsx",
        "guided-sheet.tsx",
        "detail-dock.tsx",
        "swap-sheet.tsx",
        "context-strip.tsx",
        "activity.tsx",
        "action-form.tsx",
        "recording-chip.tsx",
        "pad-host.tsx",
        "skins/football.tsx",
        "skins/cricket.tsx",
      ];
      const aliases = [...toneAliases()];
      for (const file of files) {
        const src = readFileSync(join(process.cwd(), "src/components/v2/scorepad/v3", file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        for (const alias of aliases) {
          expect(
            src.includes(`text-[var(${alias}`),
            `${file}: text-[var(${alias})] paints a tone as text`,
          ).toBe(false);
          expect(
            new RegExp(String.raw`color["']?\s*:\s*[^;\n}]*var\(` + alias).test(src),
            `${file}: an inline text colour reads ${alias}`,
          ).toBe(false);
        }
      }
    });
  });
});
