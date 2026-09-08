// The overlay's colour authority — for the parts globals.css and sport-theme.ts
// do not already own.
//
//  - Per-sport values come from SPORT_PALETTES (sport-theme.ts) at run time
//    through `paletteFor`; nothing per-sport is typed here.
//  - ROOT_SPORT_DEFAULTS mirrors globals.css's `:root { --sport-* }` block, which
//    is what a sport with no palette entry resolves to (cricket, generic —
//    `_THEMES.md` §2). It is a MIRROR: __tests__/contrast.test.ts parses the
//    stylesheet and proves it equal on every run, resolving `var(--mk-night)`
//    and `var(--color-lime-400, #9ae600)` through the same sheet, so a change to
//    globals.css that forgets this file reds a test instead of shipping two
//    truths.
//  - OVERLAY_PAIR_ROLES / OVERLAY_ALPHA_ROLES are the TABLE the contrast gate
//    walks (registry over branching). Adding a painted pair to a theme is one
//    row here; the sweep then covers it for every sport that paints it.
//
// ELEVEN SPORTS, NOT NINE. `SPORT_PALETTES` is OVERRIDES ONLY: cricket and
// generic have no entry at all, and boardgame and carrom omit `caution` and
// `dismissal`, so all four fall through to `:root`'s `--sport-dismissal`.
// Anything that enumerates "the sports" off `Object.keys(SPORT_PALETTES)` is
// short by four, and the four it misses include cricket — whose OUT slab is
// the dismissal tone's headline use. `OVERLAY_SPORT_KEYS` therefore comes from
// the pad's skin registry (`V3_SKINS`), the one authority for which sports the
// product can render.
import { V3_SKINS } from "@/components/v2/scorepad/v3/registry";
import {
  SPORT_PALETTES,
  SPORT_TOKENS,
  type SportPalette,
  type SportToken,
} from "@/components/v2/scorepad/v3/sport-theme";
import { contrastRatio } from "@/lib/contrast";

/** globals.css `:root` — `--sport-board: var(--mk-night)` etc. Proven equal to
 *  the stylesheet by `__tests__/contrast.test.ts`; globals.css wins if they
 *  ever disagree, and this file is what is wrong (the same standing rule
 *  sport-theme.ts already carries). */
export const ROOT_SPORT_DEFAULTS: SportPalette = {
  board: "#150b36",
  "board-2": "#1d1145",
  ink: "#f5f0e8",
  led: "#9ae600",
  advisory: "#16a34a",
  caution: "#d97706",
  dismissal: "#dc2626",
};

/** Colours outside the seven sport tokens (`_THEMES.md` §2 "fixed colours", §5).
 *
 *  `slabDismissalInk` is the LIGHT CANDIDATE, not the resolved ink. Under owner
 *  pick 5C (2026-09-08) the moments slab's `dismissal` ink is derived per sport
 *  — `slabDismissalInkFor` below is what a caller wants. This constant is the
 *  fixed half of that derivation, and `_THEMES.md` §5 names it by value
 *  ("whichever of `#fff5f5` and that sport's own `--sport-board` …"), which is
 *  how the test proves this line against the sheet. */
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

/** Every sport the overlay can be asked to render, from the pad's skin registry
 *  (see this file's header). Sorted so a test's output is stable. */
export const OVERLAY_SPORT_KEYS: readonly string[] = Object.keys(V3_SKINS).sort();

/** The sport's seven resolved tokens: the `:root` defaults with that sport's
 *  overrides applied. An unknown key resolves to the defaults, which is the
 *  same fall-through the stylesheet gives a pad root with no override. */
export function paletteFor(sportKey: string): SportPalette {
  const overrides = SPORT_PALETTES[sportKey] ?? {};
  const out: Record<SportToken, string> = { ...ROOT_SPORT_DEFAULTS };
  for (const token of SPORT_TOKENS) {
    const v = overrides[token];
    if (v !== undefined) out[token] = v;
  }
  return out;
}

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
  /** A sport token, or the marker for §5's derived slab ink (`slabDismissalInkFor`). */
  fg: SportToken | "slabDismissalInk";
  bg: SportToken;
  /** 4.5 = normal text (WCAG AA); 3 = large text (≥ 24 px, or ≥ 18.66 px bold) and UI. */
  floor: 4.5 | 3;
  /**
   * Which sports actually PAINT this pair. `"all"` for the eleven; a list when
   * the sheet scopes the use to fewer, so a pair one sport paints does not red
   * ten sports that never show it. The same idiom as `OVERLAY_THEMES[].sports`.
   */
  sports: "all" | readonly string[];
  where: string;
}

/** Solid-on-solid pairs the bar, the bug, the slate and the W2 slab paint
 *  (`_THEMES.md` §3–§5). */
export const OVERLAY_PAIR_ROLES: readonly OverlayPairRole[] = [
  { id: "ink-on-board", fg: "ink", bg: "board", floor: 4.5, sports: "all", where: "§3 team cell name 45/600, §4 code 48/600, §4a headline 96/800" },
  { id: "ink-on-board-2", fg: "ink", bg: "board-2", floor: 4.5, sports: "all", where: "§3 live cell 'Live' 24/600 and brand cell, §4 header" },
  { id: "led-on-board", fg: "led", bg: "board", floor: 3, sports: "all", where: "§3/§4 LED score 78/69 px, the 8-px LED bar, §4a warming dots (UI)" },
  { id: "led-on-board-2", fg: "led", bg: "board-2", floor: 3, sports: "all", where: "§4 side-in-play row: LED score on board-2" },
  { id: "board-on-led-headline", fg: "board", bg: "led", floor: 3, sports: "all", where: "§5 led-tone slab headline 96/800 (large text)" },
  { id: "board-on-led-line", fg: "board", bg: "led", floor: 4.5, sports: "all", where: "§5 led-tone slab line Geist 21/600 (normal text)" },
  { id: "board-on-caution", fg: "board", bg: "caution", floor: 4.5, sports: "all", where: "§5 yellow-card slab line, §3 caution card chip" },
  { id: "board-on-advisory", fg: "board", bg: "advisory", floor: 4.5, sports: "all", where: "§3 green-card chip (hockey today) name + minute" },
  {
    id: "slab-ink-on-dismissal",
    fg: "slabDismissalInk",
    bg: "dismissal",
    floor: 4.5,
    sports: "all",
    where: "§5 wicket / red-card slab, ink DERIVED per sport (owner pick 5C)",
  },
  {
    id: "dismissal-on-board",
    fg: "dismissal",
    bg: "board",
    floor: 3,
    sports: "all",
    where: "§5 'while a wicket slab shows, the bug's LED bar and score take the dismissal colour' — bar and numeral, so the 3:1 graphical licence, NOT 4.5 (football is 3.01)",
  },
  {
    id: "dismissal-on-board-2",
    fg: "dismissal",
    bg: "board-2",
    floor: 3,
    sports: ["cricket"],
    // SCOPED DELIBERATELY. §5 grants the LED-bar-takes-dismissal behaviour to
    // the WICKET slab, and a wicket is cricket's. The bug's side-in-play row
    // ground is board-2, so cricket owes this pair (3.57) and no other sport
    // does. If W2 ever extends that behaviour to the RED-CARD slab, this row's
    // `sports` widens and football reds at 2.56 on its own band — which is a
    // finding for the sheet, not a floor to lower.
    where: "§5 wicket slab: LED bar / score in dismissal over the bug's side-in-play row (board-2)",
  },
];

/**
 * A named, recorded miss. `_THEMES.md` §5: "Hockey is 4.46 — a named exception,
 * recorded and not waived." Every entry is asserted TWO-SIDED by the sweep
 * (`>= atLeast` AND `< below`), the shape scorepad/v3's own hockey pin uses:
 * a one-sided floor would keep passing after the exception ENDED and would
 * never say so, and a skip would say nothing at all. `below` is required to be
 * the role's own floor, so an exception cannot license a wider miss than the
 * floor it excuses.
 */
export interface OverlayPairException {
  roleId: string;
  sport: string;
  atLeast: number;
  below: 4.5 | 3;
  why: string;
}

export const OVERLAY_PAIR_EXCEPTIONS: readonly OverlayPairException[] = [
  {
    roleId: "slab-ink-on-dismissal",
    sport: "hockey",
    atLeast: 3.0,
    below: 4.5,
    why: "_THEMES.md §5: hockey's #ff5a4d takes its own board #06323c at 4.46 — the best of the two candidates and still under the text floor. Recorded, not waived; a palette move in either direction reds this row.",
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
  { id: "ink70-on-board", fg: "ink", bg: "board", alpha: 0.7, floor: 4.5, where: "§3 context line 21/500 and meta 33/500; §4a slate line 27/500" },
  { id: "ink70-on-board-2", fg: "ink", bg: "board-2", alpha: 0.7, floor: 4.5, where: "§4 header brand Barlow 24/600" },
  { id: "ink65-on-board", fg: "ink", bg: "board", alpha: 0.65, floor: 4.5, where: "§4 row meta Barlow 30/500 (overs)" },
  { id: "ink65-on-board-2", fg: "ink", bg: "board-2", alpha: 0.65, floor: 4.5, where: "§4 header context Geist 19.5/500" },
  { id: "ink75-on-board", fg: "ink", bg: "board", alpha: 0.75, floor: 4.5, where: "§4a slate brand 'seazn' Barlow 30/600 on the slate ground" },
  { id: "ink75-on-board-2", fg: "ink", bg: "board-2", alpha: 0.75, floor: 4.5, where: "§3 brand cell 'seazn' Barlow 30/600" },
  { id: "ink85-on-board", fg: "ink", bg: "board", alpha: 0.85, floor: 4.5, where: "§4 footer Geist 21/500" },
  { id: "ink92-on-board", fg: "ink", bg: "board", alpha: 0.92, floor: 4.5, where: "§3 detail band Geist 24/500 (on board @ 90 %)" },
  {
    id: "ink50-on-board",
    fg: "ink",
    bg: "board",
    alpha: 0.5,
    floor: 3,
    where: "§3/§4 void-with-no-verdict: 'both sides ink 50 %'. Score 78/700, name 45/600, code 48/600 — all large text, so the 3:1 floor",
  },
  {
    id: "ink50-on-board-2",
    fg: "ink",
    bg: "board-2",
    alpha: 0.5,
    floor: 3,
    where: "§4 void-with-no-verdict over the bug's side-in-play row ground (board-2), same large-text floor",
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
