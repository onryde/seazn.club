// v3/tokens.ts — night-tile token pairs for the Scorebug (R1 chassis, Task
// 5). This is the ONE visual element the product owner kept from the
// previous pad ("the ice-hockey moment"), generalised into the family
// identity: a stadium-night LCD tile sitting inside the daylight product
// shell (docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md).
//
// Hex values are NOT invented here: they are copied verbatim from the
// --mk-* custom properties in apps/web/src/app/globals.css (globals.css is
// the token authority per
// .superpowers/sdd/2026-08-15-scorepad-v3-r1-chassis/pins.md §7 —
// scout-verified 2026-08-16 against globals.css:436-439; no disagreement
// found between the brief's hexes and globals.css's).
//
// scorebug.tsx does NOT import these hex strings for rendering — Tailwind
// utility classes can't take a JS value at runtime (see NIGHT_TILE_CLASSES
// below for why). It DOES import NIGHT_TILE_CLASSES/SCORE_TEXT_SIZE_CLASS,
// the utility class NAMES themselves (bg-night, text-cream, text-lime-400;
// see globals.css:51-55's "Stadium-night utilities... lime needs no token,
// tailwind's lime-400 IS --mk-lime" comment) — this is now the ONLY place
// those class names are spelled out as literals (Task A3, R2 wave; see
// NIGHT_TILE_CLASSES's own comment for the fix history). This module also
// exists because contrast.test.ts runs in vitest's node environment (no
// jsdom, no CSS engine — see task-5-brief.md) and needs a plain-data copy
// of the same values to compute WCAG ratios against; if the hexes and
// globals.css ever disagree, globals.css wins and THIS file is what's
// wrong.
//
// "Lime discipline" (globals.css:705-706): lime is reserved for hairline
// strokes, the LIVE signal, eyebrow ticks, and night focus rings — never
// small body text, and never on a light background. scorebug.tsx honours
// that by using lime ONLY for the large-text score digits (NIGHT_TILE_
// PAIRS.limeOnNight below), never for the strip/hint/context copy, which
// all render in cream instead — see NIGHT_TILE_PAIRS.creamOnNight(2).

export interface ContrastPair {
  readonly bg: string;
  readonly fg: string;
}

export const NIGHT_TILE_PAIRS = {
  /** Who-line names and the tappable half's hint text, on the tile's base
   *  surface (--mk-night). Normal-text AA floor applies (4.5:1). */
  creamOnNight: { bg: "#150b36", fg: "#f5f0e8" } as ContrastPair,
  /** Same text role, on the context/strip band — one shade up
   *  (--mk-night-2), the same night->night-2 two-tier surface
   *  .app-gantry already establishes elsewhere in this app. Normal-text
   *  AA floor applies (4.5:1). */
  creamOnNight2: { bg: "#1d1145", fg: "#f5f0e8" } as ContrastPair,
  /** The score digits ONLY. Large-text AA floor applies (3.0:1) — see
   *  SCORE_TEXT_PX below for the rendered size this is licensed by. */
  limeOnNight: { bg: "#150b36", fg: "#a3e635" } as ContrastPair,
} as const;

// Task A3 (R2 wave): the Tailwind utility class names that actually render
// NIGHT_TILE_PAIRS. Before this export existed, scorebug.tsx hand-matched
// the pairs above in its OWN literal classes ("bg-night", "text-cream",
// "text-lime-400") — a silent-desync seam, because a class edit there
// changed what rendered without changing what contrast.test.ts measures
// (contrast.test.ts only ever read NIGHT_TILE_PAIRS, never scorebug.tsx).
//
// The fix is NOT "derive the class name from the hex at runtime" — that's
// impossible here. Tailwind's static scanner extracts candidate classes by
// regexing raw source TEXT; it does not execute JS. A template literal
// like `` `bg-[${hex}]` `` never becomes a real candidate because the
// literal substring "bg-[#150b36]" never appears anywhere in the source —
// only the broken `bg-[${hex}]` text does. So the class-name STRING has to
// stay literal somewhere for Tailwind to generate its CSS. This object is
// that "somewhere": scorebug.tsx imports and applies these constants
// instead of restating the class names as its own literals, so there is
// now exactly ONE place a class edit can happen, and contrast.test.ts's
// "renders exactly what this file measures" block checks that place
// against NIGHT_TILE_PAIRS (independently — see that test's own
// TAILWIND_UTILITY_HEX comment for why it isn't circular).
export const NIGHT_TILE_CLASSES = {
  /** Base tile surface — backs NIGHT_TILE_PAIRS.creamOnNight/.limeOnNight's `bg`. */
  tileBg: "bg-night",
  /** Context line + strip band surface, one shade up — backs
   *  NIGHT_TILE_PAIRS.creamOnNight2's `bg`. */
  bandBg: "bg-night-2",
  /** Who-line names + strip's accented text, full opacity — backs
   *  NIGHT_TILE_PAIRS.creamOnNight/.creamOnNight2's `fg`. */
  creamText: "text-cream",
  /** Tappable hint text + strip's non-accented text: same cream, 70%
   *  opacity. The /70 blend IS independently AA-tested against the ground
   *  it actually renders on — see NIGHT_TILE_ALPHA_TEXT below and
   *  contrast.test.ts's "alpha (translucent) text meets WCAG AA" block
   *  (Task A4, R2 wave; R1 left this unchecked, full-opacity cream only).
   *  This constant still keeps the HUE sourced from creamText so it can't
   *  drift to a different colour unnoticed even if the alpha changes. */
  creamTextMuted: "text-cream/70",
  /** Context line label: same cream, 80% opacity. Same AA coverage as
   *  creamTextMuted, via NIGHT_TILE_ALPHA_TEXT.contextLine below. */
  creamTextSubtle: "text-cream/80",
  /** Score digits — backs NIGHT_TILE_PAIRS.limeOnNight's `fg`. */
  limeText: "text-lime-400",
} as const;

/**
 * WCAG 2.x "large text": >=24px at regular weight, or >=18.66px (~19px) at
 * bold. scorebug.tsx renders the score (`ScorebugHalf.big`) at Tailwind
 * `text-4xl` (36px) + `font-bold`, comfortably inside either branch of that
 * definition — which is what licenses NIGHT_TILE_PAIRS.limeOnNight to be
 * judged against the 3.0 large-text floor rather than the stricter 4.5
 * normal-text floor. Keep this in sync with scorebug.tsx's actual class if
 * it ever changes; contrast.test.ts asserts this value directly.
 */
export const SCORE_TEXT_PX = 36;

/**
 * The Tailwind text-size utility `ScorebugHalf.big` actually renders at —
 * scorebug.tsx imports this instead of restating "text-4xl" as its own
 * literal, same reasoning as NIGHT_TILE_CLASSES above (Tailwind's default
 * preset sizes text-4xl at 2.25rem/36px, matching SCORE_TEXT_PX exactly;
 * contrast.test.ts checks the two agree via TAILWIND_TEXT_SIZE_PX rather
 * than trusting this comment).
 */
export const SCORE_TEXT_SIZE_CLASS = "text-4xl";

export interface AlphaTextSite {
  /** The NIGHT_TILE_CLASSES alpha-variant class actually rendered
   *  ("text-cream/70" or "text-cream/80"). contrast.test.ts's
   *  resolveAlphaClass parses the base colour AND the alpha fraction out
   *  of this STRING directly, not from a hand-copied number, so a class
   *  edit here (e.g. creamTextMuted going from /70 to /50) can't silently
   *  desync from what gets measured — the same guarantee NIGHT_TILE_CLASSES
   *  itself gives for colour, extended here to alpha. */
  readonly textClass: string;
  /** The NIGHT_TILE_CLASSES background class this text renders on, per
   *  scorebug.tsx's actual DOM nesting (not a prop — read from the
   *  component's structure directly). Keep in sync if that structure
   *  changes. */
  readonly bgClass: string;
  /** Rendered pixel size (see the literal Tailwind class noted per entry
   *  below). Every site here is far under WCAG's large-text carve-out
   *  (>=24px regular, >=18.66px bold), so contrast.test.ts judges all
   *  three at the stricter 4.5:1 floor — never the 3.0 SCORE_TEXT_PX
   *  licenses for the lime score above. */
  readonly sizePx: number;
}

// Task A4 (R2 wave): R1/A3 (NIGHT_TILE_CLASSES above) proved AA only for
// NIGHT_TILE_PAIRS' FULL-opacity cream/lime. scorebug.tsx ALSO renders text
// through NIGHT_TILE_CLASSES.creamTextMuted (text-cream/70) and
// .creamTextSubtle (text-cream/80) — HalfContent's tappable-half hint span,
// the stat strip's non-accented items, and the context line — and nothing
// checked the colour a sighted user actually sees there: translucent cream
// composited over the tile's night ground, not the opaque #f5f0e8
// NIGHT_TILE_PAIRS tests against. Cricket (R2's first converted sport)
// renders its context line ("T20 · Over 0.5 · RR 14.4") and over-dots strip
// through exactly these two classes, making this the first converted
// sport's most-read text — see contrast.test.ts's "alpha (translucent)
// text meets WCAG AA" block for the composited-colour AA check itself.
//
// Two other alpha classes exist in scorebug.tsx (divide-cream/10, a
// divider border; hover:bg-cream/[0.04], a hover-state background wash) —
// deliberately NOT listed here. Neither is text; WCAG 1.4.3 (the AA floor
// this whole file enforces) governs text contrast, not decorative borders
// or hover-only background feedback.
export const NIGHT_TILE_ALPHA_TEXT = {
  /** HalfContent's tappable-half hint span ("text-[11px] font-medium"). */
  hint: {
    textClass: NIGHT_TILE_CLASSES.creamTextMuted, // text-cream/70
    bgClass: NIGHT_TILE_CLASSES.tileBg, // bg-night
    sizePx: 11, // scorebug.tsx: text-[11px]
  } as AlphaTextSite,
  /** The stat strip's non-accented items (StripItem.accent !== true;
   *  "text-xs font-medium"). */
  stripMuted: {
    textClass: NIGHT_TILE_CLASSES.creamTextMuted, // text-cream/70
    bgClass: NIGHT_TILE_CLASSES.bandBg, // bg-night-2
    sizePx: 12, // scorebug.tsx: text-xs (Tailwind default scale = 12px)
  } as AlphaTextSite,
  /** The context line ("text-[11px] tracking-wide"). */
  contextLine: {
    textClass: NIGHT_TILE_CLASSES.creamTextSubtle, // text-cream/80
    bgClass: NIGHT_TILE_CLASSES.bandBg, // bg-night-2
    sizePx: 11, // scorebug.tsx: text-[11px]
  } as AlphaTextSite,
} as const;
