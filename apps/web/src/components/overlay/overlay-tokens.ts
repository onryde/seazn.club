// The overlay's colour authority — for the parts globals.css and sport-theme.ts
// do not already own, and ONLY those parts.
//
//  - The seven `:root` defaults and the per-sport resolution are NOT re-typed
//    here. `ROOT_SPORT_DEFAULTS` and `paletteFor` are ALIASES of sport-theme.ts's
//    own `DEFAULT_SPORT_PALETTE` and `resolveSportPalette` — whose docstring
//    already names this consumer ("so a contrast or capture harness can index it
//    blindly"). The names exist because the corpus (spec §4.2, `W1-step-one.md`,
//    `R2-compositor.md`) binds on them; the VALUES have exactly one home. A
//    second typed mirror of the same `:root` block, each with its own proof,
//    would let a globals.css change move one and not the other and leave the pad
//    and the overlay disagreeing about a colour with both suites green.
//    `__tests__/contrast.test.ts` parses globals.css and proves the ONE
//    remaining copy equal to it on every run.
//  - OVERLAY_PAIR_ROLES / OVERLAY_ALPHA_ROLES are the TABLE the contrast gate
//    walks (registry over branching). Adding a painted pair to a theme is one
//    row here; the sweep then covers it for every sport.
//  - OVERLAY_PAIR_EXCEPTIONS is the ONE mechanism for a pair that misses its
//    floor. It RECORDS the miss and pins it two-sided; it never hides it. There
//    is deliberately no way to scope a role to fewer sports — narrowing a role
//    is how a sub-floor value disappears from a sweep while still being painted.
//
// WHY THE ELEVEN KEYS ARE A LITERAL AND NOT `Object.keys(V3_SKINS)`. The pad's
// skin registry statically imports eleven `"use client"` skin modules (cricket
// alone is ~138 KB and pulls `@seazn/engine/core` and `.../sports/cricket`) and
// populates an `Object.create(null)` by side-effect assignment, so a bundler
// cannot tree-shake it. Importing it here to call `Object.keys` would put that
// whole graph into the overlay route, the compositor and the organiser panel —
// and the overlay is an OBS browser source, where page weight is the feature.
// The registry is still the AUTHORITY: `__tests__/contrast.test.ts` asserts this
// literal equals `Object.keys(V3_SKINS)` in both directions, which is where the
// requirement belongs and is the shape `v3/__tests__/a11y-sweep-totality.test.ts`
// already uses for `V3_SKIN_CASE_KEYS`.
//
// ELEVEN SPORTS, NOT NINE. `SPORT_PALETTES` is OVERRIDES ONLY: cricket and
// generic have no entry at all, and boardgame and carrom omit `caution` and
// `dismissal`, so all four fall through to `:root`'s `--sport-dismissal`.
// Anything that enumerates "the sports" off `Object.keys(SPORT_PALETTES)` is
// short by four, and the four it misses include cricket — whose OUT slab is the
// dismissal tone's headline use.
import {
  DEFAULT_SPORT_PALETTE,
  resolveSportPalette,
  type SportPalette,
  type SportToken,
} from "@/components/v2/scorepad/v3/sport-theme";
import { contrastRatio } from "@/lib/contrast";

/** globals.css `:root` — `--sport-board: var(--mk-night)` etc. THE alias of
 *  sport-theme.ts's `DEFAULT_SPORT_PALETTE`, not a copy of it (see the header).
 *  Proven equal to the stylesheet by `__tests__/contrast.test.ts`; globals.css
 *  wins if they ever disagree, and sport-theme.ts is what is wrong. */
export const ROOT_SPORT_DEFAULTS: SportPalette = DEFAULT_SPORT_PALETTE;

/** Colours outside the seven sport tokens (`_THEMES.md` §2 "fixed colours", §5).
 *
 *  `slabDismissalInk` is the LIGHT CANDIDATE, not the resolved ink. Under owner
 *  pick 5C (2026-09-08) the moments slab's `dismissal` ink is derived per sport
 *  — `slabDismissalInkFor` below is what a caller wants. This constant is the
 *  fixed half of that derivation, and `_THEMES.md` §5 names it by value
 *  ("whichever of `#fff5f5` and that sport's own `--sport-board` …"), which is
 *  how the test proves this line against the sheet.
 *
 *  Both values are PAINTED, so both carry a pair role below — a fixed colour
 *  with only a value-equality check is a colour nothing measures on a ground. */
export const OVERLAY_FIXED = {
  liveDot: "#ef4444",
  slabDismissalInk: "#fff5f5",
} as const;

/** §4a slate (owner pick 1A, 2026-09-08). `headlineInk: "ink"` means "the
 *  sport's own ink token at full strength" — §4a's own "ink 100 %". The two
 *  alphas and the indicator hex are all stated in §4a and parsed from it by
 *  the test, so this block is a mirror rather than a second authority. */
export const SLATE_TOKENS = {
  headlineInk: "ink" as "ink" | `#${string}`,
  /** §4a `line: Geist 27/500 ink 70 %`. */
  lineInkAlpha: 0.7,
  /** §4a `brand: "seazn" Barlow 30/600 … ink 75 %`. */
  brandInkAlpha: 0.75,
  /** §4a signal-lost: one 15-px dot beside the line — the live dot's own hex. */
  indicator: "#ef4444",
} as const;

/** Every sport the overlay can be asked to render. A LITERAL, alphabetical,
 *  proven equal to the pad's `V3_SKINS` by the test rather than imported from
 *  it — see this file's header for why that import would cost the overlay its
 *  whole reason for existing. */
export const OVERLAY_SPORT_KEYS: readonly string[] = [
  "badminton",
  "boardgame",
  "carrom",
  "cricket",
  "football",
  "generic",
  "hockey",
  "icehockey",
  "tabletennis",
  "tennis",
  "volleyball",
];

/** The sport's seven resolved tokens: the `:root` defaults with that sport's
 *  overrides applied. THE alias of sport-theme.ts's `resolveSportPalette`, whose
 *  own docstring names this caller. Always complete; an unknown key resolves to
 *  the full default set. */
export const paletteFor: (sportKey: string) => SportPalette = resolveSportPalette;

/**
 * The moments slab's `dismissal` ink for one sport (owner pick 5C, 2026-09-08,
 * `_THEMES.md` §5): whichever of `#fff5f5` and that sport's own `--sport-board`
 * measures the higher WCAG contrast against that sport's own `--sport-dismissal`.
 *
 * WHY A DERIVATION AND NOT A CONSTANT. `dismissal` is the only one of the seven
 * tokens that is a LIGHT colour in six palettes and a DARK one in five, so no
 * single ink clears 4.5:1 across the eleven sports — six fail either way. A
 * fixed `#fff5f5` measures 2.35–3.07 on the six light-red palettes; a fixed
 * `board` measures 3.01–4.46 on the five dark-red ones. The maximum of the two
 * clears 4.5 for ten of eleven, with hockey at 4.46 recorded as a named
 * exception in OVERLAY_PAIR_EXCEPTIONS rather than waived.
 *
 * Ties go to the light candidate, which only arises if a palette ever sets
 * `dismissal` equidistant from both — no sport does today.
 */
export function slabDismissalInkFor(sportKey: string): string {
  const p = paletteFor(sportKey);
  const light = contrastRatio(OVERLAY_FIXED.slabDismissalInk, p.dismissal);
  const dark = contrastRatio(p.board, p.dismissal);
  return light >= dark ? OVERLAY_FIXED.slabDismissalInk : p.board;
}

export interface OverlayPairRole {
  id: string;
  /** A sport token, or a marker for a colour outside the seven: `slabDismissalInk`
   *  resolves through `slabDismissalInkFor`, `liveDot` through `OVERLAY_FIXED`. */
  fg: SportToken | "slabDismissalInk" | "liveDot";
  bg: SportToken;
  /**
   * 4.5 = normal text (WCAG AA). 3 = large text (≥ 24 px, or ≥ 18.66 px bold)
   * AND non-text graphical objects (WCAG 1.4.11) — a card CHIP, an LED bar and
   * a live dot are all shapes in a colour, not words. `sport-theme.ts`'s own
   * `SPORT_TOKENS` note states that licence for the discipline tones in terms:
   * "they carry the swatch obligations … and not the 4.5 text floor".
   *
   * Every row's `where` says WHICH of the two it is, because that is the whole
   * justification for the number.
   */
  floor: 4.5 | 3;
  where: string;
}

/** Solid-on-solid pairs the bar, the bug, the slate and the W2 slab paint
 *  (`_THEMES.md` §3–§5). Every role applies to every sport: a role scoped to
 *  fewer sports is how a sub-floor value leaves a sweep while still being
 *  painted, so a miss is recorded in OVERLAY_PAIR_EXCEPTIONS instead. */
export const OVERLAY_PAIR_ROLES: readonly OverlayPairRole[] = [
  // ---- TEXT (4.5) --------------------------------------------------------
  { id: "ink-on-board", fg: "ink", bg: "board", floor: 4.5, where: "TEXT — §3 team cell name Barlow 45/600, §4 row code 48/600, §4a slate headline 96/800" },
  { id: "ink-on-board-2", fg: "ink", bg: "board-2", floor: 4.5, where: "TEXT — §3 live cell 'Live' Geist 24/600 and brand cell, §4 header" },
  { id: "board-on-led-line", fg: "board", bg: "led", floor: 4.5, where: "TEXT — §5 led-tone slab line Geist 21/600 (boundary, goal, ace, set/match point)" },
  { id: "board-on-caution", fg: "board", bg: "caution", floor: 4.5, where: "TEXT — §5 yellow-card slab line Geist 21/600. NOT the §3 chip, which is a swatch: see caution-swatch-on-board" },
  {
    id: "slab-ink-on-dismissal",
    fg: "slabDismissalInk",
    bg: "dismissal",
    floor: 4.5,
    where: "TEXT — §5 wicket / red-card slab headline and line, ink DERIVED per sport (owner pick 5C)",
  },

  // ---- LARGE TEXT (3) ----------------------------------------------------
  { id: "board-on-led-headline", fg: "board", bg: "led", floor: 3, where: "LARGE TEXT — §5 led-tone slab headline Barlow 96/800" },

  // ---- GRAPHICAL OBJECTS / LARGE NUMERALS (3, WCAG 1.4.11) ---------------
  { id: "led-on-board", fg: "led", bg: "board", floor: 3, where: "GRAPHICAL + LARGE — §3/§4 LED score Barlow 78/69, the 8-px LED bar, the serve/striker dots, §4a warming dots" },
  { id: "led-on-board-2", fg: "led", bg: "board-2", floor: 3, where: "GRAPHICAL + LARGE — §4 side-in-play row: LED score and inset bar on board-2" },
  {
    id: "live-dot-on-board-2",
    fg: "liveDot",
    bg: "board-2",
    floor: 3,
    where: "GRAPHICAL — §3 live cell dot 15 px and §4 header dot 13.5 px, both on the board-2 ground",
  },
  {
    id: "live-dot-on-board",
    fg: "liveDot",
    bg: "board",
    floor: 3,
    where: "GRAPHICAL — §4a slate signal-lost dot 15 px, on the slate ground (board)",
  },
  {
    id: "advisory-swatch-on-board",
    fg: "advisory",
    bg: "board",
    floor: 3,
    where: "GRAPHICAL — §3 green-card chip 13.5×18 (hockey's FIH green card) on the detail-band ground. The chip is a SWATCH; the name and minute beside it are ink-on-board",
  },
  { id: "advisory-swatch-on-board-2", fg: "advisory", bg: "board-2", floor: 3, where: "GRAPHICAL — the same green-card chip on §4's header / side-in-play ground" },
  { id: "caution-swatch-on-board", fg: "caution", bg: "board", floor: 3, where: "GRAPHICAL — §3 yellow-card chip 13.5×18 on the detail-band ground" },
  { id: "caution-swatch-on-board-2", fg: "caution", bg: "board-2", floor: 3, where: "GRAPHICAL — the same yellow-card chip on §4's header / side-in-play ground" },
  {
    id: "dismissal-swatch-on-board",
    fg: "dismissal",
    bg: "board",
    floor: 3,
    where: "GRAPHICAL — §3 red-card chip 13.5×18, and §5's 'while a wicket slab shows, the bug's LED bar and score take the dismissal colour' (a bar and a Barlow 69/700 numeral)",
  },
  {
    id: "dismissal-swatch-on-board-2",
    fg: "dismissal",
    bg: "board-2",
    floor: 3,
    where: "GRAPHICAL — the same red-card chip and wicket LED bar over §4's side-in-play row ground (board-2)",
  },
];

/**
 * A named, recorded miss. Every entry is asserted TWO-SIDED by the sweep
 * (`>= atLeast` AND `< below`), the shape scorepad/v3's own hockey pin uses:
 * a one-sided floor would keep passing after the exception ENDED and would
 * never say so, and a skip would say nothing at all. `below` is required to be
 * the role's own floor, so an exception cannot license a wider miss than the
 * floor it excuses.
 *
 * `status` separates a decision from a QUESTION. `ruled` means the sheet or an
 * owner ruling has accepted the number. `unruled` means the pair is measurably
 * under its floor on a theme that is ALREADY APPROVED (§3/§4), the owner has
 * not yet been asked, and the row exists so the number is asserted rather than
 * merely disclosed in a comment — an absent symptom means suppressed, not safe.
 * An `unruled` row is a finding owed to `_INDEX.md`, not a permanent licence.
 */
export interface OverlayPairException {
  roleId: string;
  sport: string;
  atLeast: number;
  below: 4.5 | 3;
  status: "ruled" | "unruled";
  why: string;
}

export const OVERLAY_PAIR_EXCEPTIONS: readonly OverlayPairException[] = [
  {
    roleId: "slab-ink-on-dismissal",
    sport: "hockey",
    atLeast: 3.0,
    below: 4.5,
    status: "ruled",
    why: "_THEMES.md §5: hockey's #ff5a4d takes its own board #06323c at 4.46 — the best of the two candidates and still under the text floor. 'Recorded, not waived'; a palette move in either direction reds this row.",
  },
  {
    roleId: "dismissal-swatch-on-board-2",
    sport: "football",
    atLeast: 2.5,
    below: 3,
    status: "unruled",
    why: "Football's #d00000 on its own band #122e21 is 2.56 — under WCAG 1.4.11's 3:1 for a graphical object, so a red-card chip (and §5's wicket LED bar) on the side-in-play row is the one card chip in the set that is not reliably distinguishable from its ground. Not a T1 design; §3/§4 are already approved. Owner decision owed: darken the chip's own ground, give the chip a --sport-board hairline (the pad's own remedy for a wash), or accept. `atLeast` is the measured value rounded down, so a further slip reds.",
  },
  {
    roleId: "live-dot-on-board-2",
    sport: "hockey",
    atLeast: 2.7,
    below: 3,
    status: "unruled",
    why: "The fixed live dot #ef4444 on hockey's band #0a4657 is 2.75 — under 3:1 for a graphical object. Hockey's is the only band the fixed dot fails on (every other sport is 3.44–4.82) and §4a's signal-lost dot on the BOARD clears at 3.65, so this is one ground, not the dot. Owner decision owed: a per-sport dot, a hairline, or accept. `atLeast` is the measured value rounded down.",
  },
];

export interface OverlayAlphaRole {
  id: string;
  fg: SportToken;
  bg: SportToken;
  alpha: number;
  floor: 4.5 | 3;
  where: string;
}

/** Ink painted at an alpha over its ground, measured as the COMPOSITE a viewer
 *  sees (`_THEMES.md` §2: "70 %, 65 %, 85 %, 92 % alphas for secondary text",
 *  plus §3's brand 75 % and void 50 %, and §4a's slate brand). */
export const OVERLAY_ALPHA_ROLES: readonly OverlayAlphaRole[] = [
  { id: "ink70-on-board", fg: "ink", bg: "board", alpha: 0.7, floor: 4.5, where: "TEXT — §3 team-cell meta Barlow 33/500 (overs); §4a slate line Geist 27/500" },
  { id: "ink70-on-board-2", fg: "ink", bg: "board-2", alpha: 0.7, floor: 4.5, where: "TEXT — §3 live-cell context line Geist 21/500 (the live cell's ground IS board-2); §4 header brand Barlow 24/600" },
  { id: "ink65-on-board", fg: "ink", bg: "board", alpha: 0.65, floor: 4.5, where: "TEXT — §4 row meta Barlow 30/500 (overs)" },
  { id: "ink65-on-board-2", fg: "ink", bg: "board-2", alpha: 0.65, floor: 4.5, where: "TEXT — §4 header context Geist 19.5/500" },
  { id: "ink75-on-board", fg: "ink", bg: "board", alpha: 0.75, floor: 4.5, where: "TEXT — §4a slate brand 'seazn' Barlow 30/600 on the slate ground" },
  { id: "ink75-on-board-2", fg: "ink", bg: "board-2", alpha: 0.75, floor: 4.5, where: "TEXT — §3 brand cell 'seazn' Barlow 30/600" },
  { id: "ink85-on-board", fg: "ink", bg: "board", alpha: 0.85, floor: 4.5, where: "TEXT — §4 footer Geist 21/500" },
  { id: "ink92-on-board", fg: "ink", bg: "board", alpha: 0.92, floor: 4.5, where: "TEXT — §3 detail band Geist 24/500 (band ground is board @ 90 %)" },
  {
    id: "ink50-on-board",
    fg: "ink",
    bg: "board",
    alpha: 0.5,
    floor: 3,
    where: "LARGE TEXT — §3/§4 void-with-no-verdict, 'both sides ink 50 %'. Score Barlow 78/700, name 45/600, code 48/600",
  },
  {
    id: "ink50-on-board-2",
    fg: "ink",
    bg: "board-2",
    alpha: 0.5,
    floor: 3,
    where: "LARGE TEXT — the same void treatment over §4's side-in-play row ground (board-2)",
  },
];

/**
 * THE export the corpus binds on (spec §4.2; `T1-theme-and-visual-gate.md`
 * item 8; `W1-step-one.md`; `R2-compositor.md`): one object. `_THEMES.md` §2
 * cites `OVERLAY_TOKENS` by name; the granular exports above exist for type
 * reuse and stay beside it — never a second vocabulary.
 */
export const OVERLAY_TOKENS = {
  root: ROOT_SPORT_DEFAULTS,
  fixed: OVERLAY_FIXED,
  slate: SLATE_TOKENS,
  sportKeys: OVERLAY_SPORT_KEYS,
  pairRoles: OVERLAY_PAIR_ROLES,
  alphaRoles: OVERLAY_ALPHA_ROLES,
  pairExceptions: OVERLAY_PAIR_EXCEPTIONS,
  paletteFor,
  slabDismissalInkFor,
} as const;
export type OverlayTokens = typeof OVERLAY_TOKENS;
