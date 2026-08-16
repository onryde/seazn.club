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
// scorebug.tsx does NOT import these hex strings for rendering — it uses
// the Tailwind utilities the same --mk-* vars already back (bg-night,
// text-cream, text-lime-400; see globals.css:51-55's "Stadium-night
// utilities... lime needs no token, tailwind's lime-400 IS --mk-lime"
// comment). This module exists because contrast.test.ts runs in vitest's
// node environment (no jsdom, no CSS engine — see task-5-brief.md) and
// needs a plain-data copy of the same values to compute WCAG ratios
// against; if the two ever disagree, globals.css wins and THIS file is
// what's wrong.
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
