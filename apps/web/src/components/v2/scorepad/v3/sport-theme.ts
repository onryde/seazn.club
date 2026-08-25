// v3/sport-theme.ts — the PER-SPORT VISUAL IDENTITY layer (R3/task B4).
//
// Owner ruling R3-6 (2026-08-24, `docs/superpowers/specs/2026-08-15-
// scoringpad-v3-prompts/_INDEX.md`) REVERSES the 2026-08-15 theme lock. Skins
// stop being purely structural and gain a bounded visual voice; R4-R7 each owe
// one too. `_RULES.md` and the design of record's §2 both still assert the old
// "one family identity" rationale and are STALE on that point — read the
// ruling, not them.
//
// THE ONE CONSTRAINT THAT SHAPES THIS FILE: cricket must render
// byte-identical. The ruling's own words — "build the token layer so that
// cricket's current values ARE the default token set. Cricket then renders
// byte-identical, its R2/R2b/R2c sign-offs stand, and only football
// overrides." So:
//
//   - the DEFAULTS live in globals.css's `:root` as ALIASES of the product's
//     own `--mk-*` vars (not copies), which is what makes a skin that
//     declares nothing indistinguishable from the pre-B4 build;
//   - `SPORT_PALETTES` holds overrides ONLY, and has no `cricket` entry;
//   - `sportThemeStyle` returns `undefined` (not `{}`) for a sport with no
//     override, so cricket's pad root gains no `style` attribute at all.
//
// `__tests__/sport-theme.test.ts` locks all three, plus the rendered result.
//
// WHY A CLOSED VOCABULARY. A skin picks a NAME; the chassis owns the value.
// Eleven skins each free-handing hex would reproduce, one sport at a time,
// exactly the "monster-button monotony"-shaped problem this programme keeps
// designing out: no shared floor, no contrast gate that can see the whole set,
// and no one-line revert if the owner rejects a direction at sign-off. Every
// value in this file is contrast-computed in `__tests__/contrast.test.ts`
// against the surface it actually paints on — adding a token without adding
// its pairs there is the failure mode that ships an unreadable board.
//
// The hexes are NOT rendered from here. Tailwind's scanner cannot see a JS
// value (../tokens.ts's own header has the full reasoning), so painting goes
// through the `.pad-*` classes in globals.css, which read `var(--sport-*)`.
// This module exists to (a) emit the override custom properties for the pad
// root and (b) give the node-environment contrast/identity suites a plain-data
// copy of the same values. If the two ever disagree, globals.css wins and THIS
// file is what is wrong — the same standing rule ../tokens.ts already carries.
import type { CSSProperties } from "react";

/**
 * The closed set. Deliberately SMALL: a board ground, the band one shade off
 * it, the ink on both, one accent, and the two card-code colours.
 *
 * `caution`/`dismissal` are the load-bearing pair and the reason the ruling
 * exists at all: yellow and red are the only colours in football's visual
 * language that carry MEANING — a referee does not raise a "destructive
 * action" — and before B4 a red card rendered in the chassis's generic
 * `destructive` red, identical to Abandon, while a yellow rendered as neutral
 * `standard`. They are the one place in this pad where colour is INFORMATION
 * rather than decoration.
 */
export const SPORT_TOKENS = ["board", "board-2", "ink", "led", "caution", "dismissal"] as const;
export type SportToken = (typeof SPORT_TOKENS)[number];
export type SportPalette = Readonly<Record<SportToken, string>>;

/**
 * The subset a `SheetChoiceStep` option may name (types.ts's `tone`). A SUBSET
 * of `SPORT_TOKENS`, never a parallel list — a second vocabulary for the same
 * values is the drift this programme has already paid for twice (see
 * `_INDEX.md`'s "TWO progression vocabularies" and the v2 fidelity ladder).
 */
export const SPORT_TONES = ["caution", "dismissal"] as const;
export type SportTone = (typeof SPORT_TONES)[number];

/**
 * What globals.css's `:root --sport-*` block resolves to with no override in
 * scope — i.e. exactly what the pre-B4 build painted, for the four tokens that
 * had a pre-B4 value.
 *
 * `led` is `#9ae600`, NOT `#a3e635`. `text-lime-400` compiles to
 * `var(--color-lime-400)`, and Tailwind v4 (4.3.1) sets that to
 * `oklch(84.1% 0.238 128.85)` — the v4 palette is oklch and no longer equals
 * the v3 hex `--mk-lime` still holds. Taking that oklch to sRGB gives #9ae600
 * (the CSS Color 4 §13.2 gamut map and a naive clip agree to the byte). This
 * is why the default LED aliases `--color-lime-400` rather than `--mk-lime`:
 * the friendlier-looking alias would have shifted cricket's score digits.
 * globals.css:52's "tailwind's lime-400 IS --mk-lime (#a3e635)" was written
 * under v3 and is now false — corrected in place by this task.
 *
 * `caution`/`dismissal` are NEW (nothing rendered a card colour before B4):
 * the app's existing daylight signal pair, stated as literal hex in globals
 * .css precisely so they cannot drift the way `lime-400` just did.
 */
export const DEFAULT_SPORT_PALETTE: SportPalette = {
  board: "#150b36", // --mk-night
  "board-2": "#1d1145", // --mk-night-2
  ink: "#f5f0e8", // --mk-cream
  led: "#9ae600", // Tailwind v4 lime-400, oklch(84.1% 0.238 128.85) -> sRGB
  caution: "#d97706",
  dismissal: "#dc2626",
};

/**
 * OVERRIDES ONLY, per sport key (`SkinDefV3.key`). A sport absent from this
 * table inherits every default — which is the mechanism, not an oversight.
 *
 * FOOTBALL (R3-6's recorded table, calibrated deliberately against the
 * generic-default trap; do not re-derive it). Current AI-generated design
 * clusters on cream/serif/terracotta, near-black + one acid accent, and
 * broadsheet hairlines. The product's locked theme — night `#150b36` with lime
 * `#a3e635` — already sits inside the second cluster, so leaning football
 * FURTHER into lime-on-night would be picking the default and calling it a
 * decision. Football moves into its own vernacular instead:
 *
 *   board       floodlit turf at night — near-black with a green cast, NOT
 *               "pitch green", which is the generic sports-app answer
 *   board-2     the band under the scores
 *   led         the FOURTH OFFICIAL'S BOARD amber — the signature
 *   caution     a yellow card is yellow
 *   dismissal   a red card is red
 *   ink         cool off-white, legible on the board in daylight
 *
 * The stated aesthetic risk: football rejects the family's lime accent. Lime
 * is the PRODUCT's brand colour; amber is the SPORT's, and on a surface used
 * pitch-side under floodlights the sport's signal should win. If that reads as
 * fragmentation at sign-off, this table makes it a one-line revert per sport.
 */
/*
 * NULL-PROTOTYPE, for the same reason `registry.ts` gives `V3_SKINS` (see its
 * own header): a plain object literal answers `SPORT_PALETTES["constructor"]`
 * with an inherited `Object.prototype` member, and all three readers below
 * index this table by a bare string. That would make `sportThemeAttr` emit
 * `data-sport-theme="constructor"` while `sportThemeStyle` emits no
 * `--sport-*` properties at all — breaking the invariant the two are always
 * written together, which is exactly what `[data-sport-theme]
 * .pad-half:focus-visible` in globals.css leans on: the ring would resolve
 * against the shared `:root` default the scoping exists to avoid.
 *
 * Not reachable from today's engine sport keys. It is one word to make it
 * unreachable by construction instead of by inspection, and the sibling table
 * already made that choice.
 */
export const SPORT_PALETTES: Readonly<Record<string, Partial<SportPalette>>> = Object.assign(Object.create(null) as Record<string, Partial<SportPalette>>, {
  football: {
    board: "#0b1f16",
    "board-2": "#122e21",
    ink: "#f2f7f4",
    led: "#ffb703",
    caution: "#ffd60a",
    dismissal: "#d00000",
  },
  /*
   * TENNIS (R4-4, owner-ruled 2026-08-25 off the published comps sheet).
   * Deep hardcourt blue, and the ball's optic yellow spent on exactly ONE
   * thing: the serving PLAYER's pip and the strip digits. The signature is the
   * umpire's-chair strip — sets, games, next server, ends.
   *
   *   board       deep hardcourt blue
   *   board-2     the band the names and points sit on
   *   led         the ball's optic yellow — the serve pip, and nothing else
   *   caution     the code-violation warning
   *   dismissal   the end of the ladder (default)
   *   ink         cool near-white
   *
   * Chosen over clay (its own second colour IS white, so the pip would have
   * nothing to be, and cream+terracotta is one of the three clusters generated
   * design defaults to) and over grass (Wimbledon purple measures 1.37:1 on the
   * green, so the identity's signature colour could never appear at all, and a
   * second dark-green board collides with football's floodlit turf in the same
   * sign-off sheet).
   *
   * WHY `dismissal` IS NOT A CARD RED. Football's `#d00000` sits at 3.01:1 on
   * its own board and is correct there, because it paints a CARD — a swatch,
   * not a word. Tennis has no cards: its ladder (warning → point penalty →
   * game penalty → default, `nested/kernel.ts:250-255`) is words, so this tone
   * lands on TEXT and has to clear 4.5. The comps sheet was first published
   * with `#c1272d`, which measures 2.63:1 and would have shipped a fail behind
   * a hand-computed number that said otherwise. `#fa5252` is 4.68:1.
   *
   * Do NOT assume the suite catches this by itself. `contrast.test.ts` holds a
   * tone to the TEXT floor only once it finds that tone actually used as text
   * in the chassis or skin sources (R3's tone licence, which resolves the
   * `var(--pad-tone)` alias graph before scanning). Reverting this value to
   * `#c1272d` today reds NOTHING, because the tennis skin does not exist yet —
   * established by mutation, not assumed. The floor is therefore pinned
   * EXPLICITLY in `contrast.test.ts`, so it bites from the moment the palette
   * lands rather than from the moment some skin happens to reference it.
   *
   * Also recorded, because two tokens cannot carry a four-step ladder: the
   * ENDS take `caution` and `dismissal`; point penalty and game penalty read as
   * words in the sanction sheet and carry no colour of their own.
   */
  tennis: {
    board: "#0b2545",
    "board-2": "#13315c",
    ink: "#f4f7fb",
    led: "#d9f000",
    caution: "#f2a900",
    dismissal: "#fa5252",
  },
});

/** The custom-property name a token is emitted under. One place, so the
 *  `--sport-` prefix cannot drift between this module, globals.css and the
 *  suites that read the emitted style. */
export function sportCustomProperty(token: SportToken): string {
  return `--sport-${token}`;
}

/** Every token's value for a sport: its overrides layered over the defaults.
 *  ALWAYS complete — an unknown key resolves to the full default set, never a
 *  partial palette, so a contrast or capture harness can index it blindly. */
export function resolveSportPalette(skinKey: string): SportPalette {
  const overrides = SPORT_PALETTES[skinKey];
  return overrides === undefined ? DEFAULT_SPORT_PALETTE : { ...DEFAULT_SPORT_PALETTE, ...overrides };
}

/**
 * The inline style the pad root carries for this sport, or `undefined` when
 * the sport declares nothing.
 *
 * `undefined` rather than `{}` is load-bearing, not a micro-optimisation:
 * React serialises an empty style object as a real `style=""` attribute, which
 * would change cricket's own root markup — and "changes nothing about cricket"
 * is the ruling's own gate on this task.
 *
 * Emits the OVERRIDES ONLY (not the resolved set): a sport that overrides the
 * board but not the ink should keep inheriting whatever `:root` says the ink
 * is, so a later product-theme change still reaches it.
 */
/**
 * The pad root's `data-sport-theme` value, or `undefined` for a sport that
 * overrides nothing.
 *
 * R3 review round. Custom properties alone cannot carry this: a CSS rule can
 * READ `var(--sport-led)` but cannot ask "did anyone override it", and the
 * default value is a real colour, so `.pad-half:focus-visible { outline-color:
 * var(--sport-led) }` painted CRICKET'S ring lime — a moved pixel on a
 * signed-off surface, which ruling R3-6 forbids outright. The attribute is
 * what lets globals.css scope a sport-coloured rule to the sports that
 * actually have a colour, so every un-overriding skin keeps the platform's own
 * value BY CONSTRUCTION rather than by a per-sport carve-out.
 *
 * Exactly the same `undefined` discipline `sportThemeStyle` documents below,
 * and for the same reason: React omits an `undefined` attribute entirely, so
 * cricket's root markup is byte-identical to what it was before the token
 * layer existed. Deliberately paired with `sportThemeStyle` on ONE element —
 * `sport-theme.test.ts` pins that the two are emitted together, so a rule
 * scoped to the attribute can never find itself without the properties.
 */
export function sportThemeAttr(skinKey: string): string | undefined {
  return SPORT_PALETTES[skinKey] === undefined ? undefined : skinKey;
}

export function sportThemeStyle(skinKey: string): CSSProperties | undefined {
  const overrides = SPORT_PALETTES[skinKey];
  if (overrides === undefined) return undefined;
  const style: Record<string, string> = {};
  for (const token of SPORT_TOKENS) {
    const value = overrides[token];
    if (value !== undefined) style[sportCustomProperty(token)] = value;
  }
  return Object.keys(style).length === 0 ? undefined : (style as CSSProperties);
}
