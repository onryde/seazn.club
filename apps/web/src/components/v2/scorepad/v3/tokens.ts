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
// R3/task B4 (owner ruling R3-6, per-sport visual identity) re-pointed the
// class names below at globals.css's `.pad-*` rules, which read
// `var(--sport-*)` tokens — the DEFAULTS of which alias the very same
// `--mk-*`/`--color-lime-400` vars the old utilities compiled to, so nothing a
// skin has not opted into changes colour. The hex pairs here still describe
// the DEFAULT (cricket) palette; ./sport-theme.ts holds the vocabulary and the
// per-sport override table, and `__tests__/sport-theme.test.ts` locks the
// no-change claim.
//
// scorebug.tsx does NOT import these hex strings for rendering — Tailwind
// utility classes can't take a JS value at runtime (see NIGHT_TILE_CLASSES
// below for why). It DOES import NIGHT_TILE_CLASSES/SCORE_TEXT_SIZE_CLASS,
// the class NAMES themselves — this is the ONLY place they are spelled out as
// literals (Task A3, R2 wave; see NIGHT_TILE_CLASSES's own comment for the fix
// history). This module also
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
   *  SCORE_TEXT_PX below for the rendered size this is licensed by.
   *
   *  CORRECTED 2026-08-24 (R3/B4): `fg` read `#a3e635` from R1 until this
   *  task. That is Tailwind v3's `lime-400` (and still `--mk-lime`), but this
   *  app is on Tailwind v4.3.1, whose palette is oklch: `text-lime-400`
   *  compiles to `var(--color-lime-400)` = `oklch(84.1% 0.238 128.85)`, which
   *  is `#9ae600` in sRGB (the CSS Color 4 §13.2 gamut map and a naive clip
   *  agree to the byte). So the oracle was measuring a colour the build had
   *  not painted since the v4 upgrade. The VERDICT never moved — 12.29:1
   *  wrong vs 12.09:1 right, against a 3.0 floor — but a contrast oracle
   *  holding a hex the browser does not render is exactly the defect class
   *  this file exists to remove, so it is fixed rather than noted. */
  limeOnNight: { bg: "#150b36", fg: "#9ae600" } as ContrastPair,
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
// R3/task B4 (per-sport visual identity, owner ruling R3-6): every class below
// moved from a Tailwind utility naming a FIXED colour ("bg-night",
// "text-cream", "text-lime-400") to a `.pad-*` rule in globals.css reading a
// `var(--sport-*)` token. The seam this object exists to close is unchanged —
// the class-name string still lives in exactly ONE place — and so are the
// colours it resolves to: globals.css's `:root` defaults ALIAS the same
// `--mk-*`/`--color-lime-400` vars those utilities compiled to, so a skin that
// declares no override (cricket, and every sport before its own wave) paints
// exactly what it painted before. `__tests__/sport-theme.test.ts` locks that
// claim at the data, resolution AND rendered-markup levels; ./sport-theme.ts
// holds the token vocabulary and the per-sport override table.
export const NIGHT_TILE_CLASSES = {
  /** Base tile surface — backs NIGHT_TILE_PAIRS.creamOnNight/.limeOnNight's `bg`. */
  tileBg: "pad-board",
  /** Context line + strip band surface, one shade up — backs
   *  NIGHT_TILE_PAIRS.creamOnNight2's `bg`. */
  bandBg: "pad-board-2",
  /** Who-line names + strip's accented text, full opacity — backs
   *  NIGHT_TILE_PAIRS.creamOnNight/.creamOnNight2's `fg`. */
  creamText: "pad-ink",
  /** Tappable hint text + strip's non-accented text: same cream, 70%
   *  opacity. The /70 blend IS independently AA-tested against the ground
   *  it actually renders on — see NIGHT_TILE_ALPHA_TEXT below and
   *  contrast.test.ts's "alpha (translucent) text meets WCAG AA" block
   *  (Task A4, R2 wave; R1 left this unchecked, full-opacity cream only).
   *  This constant still keeps the HUE sourced from creamText so it can't
   *  drift to a different colour unnoticed even if the alpha changes. */
  creamTextMuted: "pad-ink-70",
  /** Context line label: same cream, 80% opacity. Same AA coverage as
   *  creamTextMuted, via NIGHT_TILE_ALPHA_TEXT.contextLine below. */
  creamTextSubtle: "pad-ink-80",
  /** Score digits — backs NIGHT_TILE_PAIRS.limeOnNight's `fg`. */
  limeText: "pad-led",
  /** The serving dot (`WhoLine.serving`) — the accent as a FILL, not text.
   *  Was a bare `bg-lime-400` literal in scorebug.tsx until B4; it is the
   *  same token as `limeText` and must follow the sport. */
  ledDot: "pad-led-dot",
  /** The tile's top hairline — the accent as a BORDER. Was a bare
   *  `border-lime-400` literal in scorebug.tsx until B4. A lime hairline on
   *  football's green board is precisely the "one family identity" leak
   *  ruling R3-6 retires. */
  ledEdge: "pad-led-edge",
  /** The tappable half itself: carries BOTH the hover wash (ink at 4%) and
   *  the focus ring (the accent). One class because both belong to one
   *  element — see globals.css's own note on why no `!important` is needed. */
  half: "pad-half",
  /** The divider between the two halves — replaces `divide-cream/10`, whose
   *  compiled `> :not(:last-child)` selector the rule mirrors. Applied
   *  ALONGSIDE Tailwind's `divide-x`, which still supplies the border WIDTH;
   *  only the colour is tokenised. */
  rule: "pad-ink-rule",
  /** THE SIGNATURE (R3-6) — the fourth official's added-time board. Rendered
   *  for a `StripItem` with `tone: "led"` and nothing else, so a sport that
   *  does not opt in keeps the plain strip it already had. */
  ledPanel: "pad-led-panel",
  /** The quieter label inside that panel ("ADDED"), beside its value. Same
   *  colour as the panel — no opacity step, so the panel needs exactly ONE
   *  contrast pair rather than a composited second one. */
  ledPanelLabel: "pad-led-panel-label",
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

// R3/task B4 — the card-code classes, kept HERE for the same single-source
// reason NIGHT_TILE_CLASSES exists: guided-sheet.tsx imports these instead of
// spelling the class names out itself, so a colour edit has exactly one place
// to happen and contrast.test.ts measures that place.
//
// These paint on the DAYLIGHT sheet, not the night board — the split
// tile-grid.tsx's header sets out ("lime and the display face mark 'this is a
// readout', never a control") is untouched by this task. What changes is that
// ONE choice step now carries colour as INFORMATION: `caution` and
// `dismissal` are the only colours in football's visual language that mean
// something, and before B4 a red card rendered in the chassis's generic
// `destructive` red — identical to Abandon — while a yellow rendered neutral.
//
// R6-3 adds `advisory`, hockey's FIH green card. Forced by `SportTone` rather
// than optional: `guided-sheet.tsx` indexes this record with a `SportTone`, so
// a tone with no class here is a tsc error, not a silently untinted option.
export const SPORT_TONE_CLASSES = {
  /** Sets `--pad-tone` for everything inside. On the BUTTON it selects the
   *  background wash; on a SWATCH it selects that swatch's fill, which is how
   *  one option can carry two colours (a second yellow is a yellow card and a
   *  red one, not a red card with a note). */
  advisory: "pad-tone-advisory",
  caution: "pad-tone-caution",
  dismissal: "pad-tone-dismissal",
  /** The option button's 12% tint of its own tone. Decorative: the label
   *  stays slate-700, which contrast.test.ts checks against the composited
   *  wash rather than against bare white. */
  wash: "pad-tone-wash",
  /** Wrapper for the 1-2 swatches, which overlap the way a referee holds a
   *  second yellow over the red. */
  stack: "pad-card-stack",
  /** One card. Its boundary against the pale sheet is carried by the
   *  `--sport-board` hairline, NEVER by the fill — yellow-on-wash is ~1.15:1
   *  and cannot meet WCAG 1.4.11 alone. Exactly the pair that passes by eye
   *  and fails when computed. */
  swatch: "pad-card-swatch",
} as const;
