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
/*
 * R6-3 (owner ruling, 2026-08-30) adds the SEVENTH, `advisory` — the FIH green
 * card, and the first widening of this list since B4 opened it.
 *
 * The argument is hockey's discipline model, not a preference for more
 * colours. `sports/hockey/hockey.ts` declares `disciplineColors: [green,
 * yellow, red]`: three physical cards an umpire holds up, every one of them a
 * swatch rather than a word. That is ONE SIGNAL AT THREE STRENGTHS, and two
 * tokens cannot carry three strengths — mapping green onto `caution` would
 * make a green card and a yellow card the same colour, which is the exact
 * information loss `caution`/`dismissal` were split out to prevent.
 *
 * Tennis's precedent does NOT transfer, and the reason is worth stating
 * because it is the obvious counter-argument: R4 ruled that tennis's
 * four-step ladder takes the tones at its ENDS and words its middles. That
 * works because tennis's ladder genuinely IS words (an enum rendered as
 * choice-row labels). Hockey's is three coloured pieces of card.
 *
 * Six of the seven sports never use `advisory` and never should: it is
 * absent from every palette but hockey's, which is what
 * `sport-theme.test.ts`'s "overrides only" locks keep honest.
 */
export const SPORT_TOKENS = ["board", "board-2", "ink", "led", "advisory", "caution", "dismissal"] as const;
export type SportToken = (typeof SPORT_TOKENS)[number];
export type SportPalette = Readonly<Record<SportToken, string>>;

/**
 * The subset a `SheetChoiceStep` option may name (types.ts's `tone`). A SUBSET
 * of `SPORT_TOKENS`, never a parallel list — a second vocabulary for the same
 * values is the drift this programme has already paid for twice (see
 * `_INDEX.md`'s "TWO progression vocabularies" and the v2 fidelity ladder).
 */
export const SPORT_TONES = ["advisory", "caution", "dismissal"] as const;
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
  // R6-3: `advisory` joins on the same terms `caution`/`dismissal` did — no
  // pre-B4 value exists because nothing painted a green card either, so this
  // is the app's own daylight signal set completing itself (green-600 beside
  // amber-600 and red-600), stated as literal hex for the same anti-drift
  // reason. Only hockey overrides it; every other sport inherits a value its
  // skin never names.
  advisory: "#16a34a",
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
   * ------------------------------------------------------------------------
   * THE PERIOD PAIR (R6-3, owner-ruled 2026-08-30). Hockey and ice hockey,
   * landing together one wave before either skin does, for the reason the
   * racquet block below already records: they share ONE engine
   * (`sports/period/kernel.ts`) and will be judged on one sign-off sheet, so
   * their identities are a set to be picked together or a set that drifts.
   * `contrast.test.ts` pins both EXPLICITLY, today, because its own tone
   * licence is usage-driven and can say nothing about a palette whose skin
   * does not exist yet.
   *
   * Placed HERE, between `football` and `tennis`, because that is their
   * alphabetical position among their immediate neighbours — R7 is editing
   * this same literal concurrently and lands its own sports at a different
   * point, so the two edits merge mechanically instead of colliding on one
   * trailing region.
   * ------------------------------------------------------------------------
   */

  /*
   * HOCKEY — the water-based pitch's deep teal, under an umpire's board.
   *
   *   board       the wet blue-green turf, floodlit
   *   board-2     the band under the names, one shade up the same surface
   *   led         the umpire's board amber — the signature
   *   advisory    the FIH GREEN CARD (Rules 14.1a) — R6-3's seventh token
   *   caution     the yellow card
   *   dismissal   the red card
   *   ink         cool off-white
   *
   * Chosen over "pitch green", which is both the generic sports-app answer and
   * a straight collision with football's floodlit turf on the same sheet. The
   * modern international game is played on a BLUE water-based surface with a
   * green surround, and no other sport in this programme owns teal.
   *
   * WHY THREE TONES AND NOT TWO: see `SPORT_TOKENS`'s own note above. All
   * three are SWATCHES — `disciplineColors` is three cards, not three words —
   * so they carry the swatch obligations (a readable label on the wash, the
   * `--sport-board` hairline for WCAG 1.4.11) and not the 4.5 text floor.
   * `dismissal` at 4.46:1 on its own board is therefore CORRECT and
   * deliberately pinned two-sided in `contrast.test.ts`: a later wave that
   * wants to word a red card on the night board has to change that assertion
   * first, exactly as football's own licence requires.
   */
  hockey: {
    board: "#06323c",
    "board-2": "#0a4657",
    ink: "#eef6f8",
    led: "#ffd23f",
    advisory: "#3ddc84",
    caution: "#ffd60a",
    dismissal: "#ff5a4d",
  },

  /*
   * ICE HOCKEY — the rink at night: near-black boards, and the ice's own cyan.
   *
   *   board       the arena in the dark, past the boards
   *   board-2     the band, one step up
   *   led         cold rink cyan — the power-play clock and the score digits
   *   caution     the minor/major end of the penalty ladder
   *   dismissal   misconduct through match penalty
   *   ink         cool near-white
   *
   * NO `advisory` OVERRIDE, deliberately: the green card is FIH's, not IIHF's,
   * and ice hockey's ladder (minor / double / major / misconduct / game
   * misconduct / match, `sports/icehockey/icehockey.ts`) has no third card
   * grade to name. It inherits the default it never paints, which is what
   * `SPORT_PALETTES` being OVERRIDES ONLY buys — and `contrast.test.ts` asserts
   * the absence, so a later "complete the palette" tidy-up reds instead of
   * quietly inventing a card this sport does not have.
   *
   * Its tones are WORDS, not swatches, so both owe the strict 4.5 on both
   * grounds — the same obligation the racquet family carries and the opposite
   * of hockey's, one entry above.
   */
  icehockey: {
    board: "#08090c",
    "board-2": "#14181f",
    ink: "#eef2f6",
    led: "#67e8f9",
    caution: "#ffc233",
    dismissal: "#ff6b6b",
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
  /*
   * ------------------------------------------------------------------------
   * THE RACQUET FAMILY (R5-3, owner-ruled 2026-08-27 off the published comps
   * sheet). All THREE land together, one wave before two of the three skins
   * do — R5 converts badminton only, and table tennis and volleyball follow
   * in later waves. That is deliberate, not premature: these three sports
   * share ONE engine (`sports/setbased/kernel.ts`) and will be judged on one
   * sign-off sheet, so their identities are a set to be picked together or a
   * set that drifts. `contrast.test.ts` pins all three EXPLICITLY, today,
   * because its own tone licence is usage-driven and can say nothing about a
   * palette whose skin does not exist yet (see tennis's note above, and the
   * `R5/racquet family` block in that file).
   *
   * ONE RULE ACROSS ALL THREE: `led` is spent on the SERVE and nothing else.
   * Who is serving is the one fact this family's boards could never state
   * (D-17) and the one this wave's engine reader finally answers, so the
   * accent goes to it exclusively rather than being sprayed across the score.
   * ------------------------------------------------------------------------
   */

  /*
   * BADMINTON — the maple sports-hall floor, with the BWF mat's teal.
   *
   *   board       varnished maple, seen from the umpire's chair
   *   board-2     the band under the names, one shade up the same timber
   *   led         the BWF competition mat's teal — the service mark, only
   *   caution     the umpire's YELLOW card (BWF Law 16.7.2.1, `warning`)
   *   dismissal   the RED and BLACK end of the same ladder, worded
   *   ink         warm off-white, the shuttle against the wood
   *
   * Chosen over "shuttlecock white on court green", which is both the
   * generic sports-app answer and a straight collision with football's
   * floodlit turf on the same sheet. Wood is what a badminton hall actually
   * looks like, and no other sport in this programme has it.
   *
   * WHY THE TONES ARE TEXT, NOT SWATCHES. The BWF umpire has three cards, so
   * a card-shaped reading is tempting — but the kernel does not model a card:
   * `sanctionAction` is `{kind: "enum", path: "level"}` over four WORDS
   * (`warning`/`penalty`/`expulsion`/`disqualification`, setbased/badminton.ts
   * declares all four), rendered as choice-row labels. Words owe 4.5:1, and
   * both of these clear it on both grounds — computed, not judged.
   */
  badminton: {
    board: "#241a14",
    "board-2": "#33261d",
    ink: "#f7f1e8",
    led: "#2fe0bd",
    caution: "#ffc233",
    dismissal: "#ff6b6b",
  },

  /*
   * TABLE TENNIS — the two-colour bat: graphite ground, ITTF-blue band, the
   * orange ball as the signal. NOT converted by R5; the palette lands now so
   * the family is picked as a set (see the block comment above).
   *
   *   board       the blade's graphite face
   *   board-2     the ITTF match table's blue, as the band
   *   led         the 40mm orange ball — the service mark, only
   *   caution     the umpire's yellow card (ITTF 3.5.2)
   *   dismissal   the red card, worded, one step warmer than badminton's so
   *               the two racquet boards never read as one palette
   *   ink         cool near-white
   */
  tabletennis: {
    board: "#101418",
    "board-2": "#0f2d40",
    ink: "#f2f6f8",
    led: "#ff9440",
    caution: "#ffd60a",
    dismissal: "#ff7a80",
  },

  /*
   * VOLLEYBALL — arena slate with the playing court's azure. NOT converted by
   * R5; same reasoning as table tennis above.
   *
   *   board       the arena floor's slate surround
   *   board-2     the playing court inside it
   *   led         FIVB court azure — the serving side's mark, only
   *   caution     the yellow card (FIVB 21.3)
   *   dismissal   the red card / expulsion end, worded
   *   ink         cool near-white
   *
   * CHOSEN OVER THE TRUER CORAL, and the reason is a rule rather than a
   * preference: volleyball is the one sport of these three where a referee
   * shows a card MID-RALLY, so `caution`/`dismissal` and the accent can be on
   * screen at the same instant. Coral sits one hue step from its own red
   * card, so the accent and the sanction would have read as the same signal
   * at exactly the moment they mean opposite things. Azure is a full hue away
   * from both card colours.
   */
  volleyball: {
    board: "#161d27",
    "board-2": "#232c39",
    ink: "#f4f7fa",
    led: "#4aa8ff",
    caution: "#ffd60a",
    dismissal: "#ff6b6b",
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
