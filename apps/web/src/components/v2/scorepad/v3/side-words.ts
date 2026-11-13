// What the pad calls each side where it says the side word ("Goal / Home", the HOME over a half you tap, "Serving Home",
// "Rally recorded — Home"). Every v3 skin says it through ONE key per side, `scorepad.attribution.home`/`.away`
// (each skin's `SIDE_LABEL`), resolved by the `t` the skin factory and the chassis are handed.
//
// Sign-off 2026-11-12 (controller, PO rec): a quick match's sides are name-only entrants, with no members, so nothing on
// the pad could name them and every side word read Home/Away while the card above the pad said "Red Bibs" and "Blue
// Bibs". A side with NO members is now called by its name in place of the side word.
//
// Decided per FIXTURE (review m1, controller ruling 2026-11-13): when either side is called by its name, BOTH are, so a
// fixture between a rostered team and a name-only one never reads "Goal / Home" beside "Goal / Riverside FC". A fixture
// whose two sides both have a roster (an organiser's singles entrants, pairs, rostered teams) keeps the side words.
//
// One seam for every skin rather than ~90 call sites: `ScorePad` (registry.tsx) builds the words from the two
// `SideInfo`s and wraps BOTH translators with them — the one the skin factory is built with and the chassis's own
// (`PadHostV3`, which receives the words as a prop). Driven end to end by __tests__/name-only-sides.test.tsx.
import type { TFn } from "./context-strip";
import type { PadHostView } from "./types";

type Side = "home" | "away";

/** The side-word keys every skin's `SIDE_LABEL` resolves. */
export const SIDE_WORD_KEY: Readonly<Record<Side, string>> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

/** The name a side is called by in place of its side word. Only when at least one side has no members and a non-blank
 *  name; then every side with a non-blank name has one. */
export type SideWords = Readonly<Partial<Record<Side, string>>>;

export function sideWordsFrom(
  sides: Readonly<Record<Side, { readonly members: readonly unknown[] }>>,
  entrantNames: PadHostView["entrantNames"],
): SideWords {
  const names: Partial<Record<Side, string>> = {};
  let nameOnly = false;
  for (const side of ["home", "away"] as const) {
    const name = entrantNames[side]?.trim();
    if (!name) continue;
    names[side] = name;
    if (sides[side].members.length === 0) nameOnly = true;
  }
  return nameOnly ? names : {};
}

/** `t`, except that a side's word key resolves to that side's name where `words` has one. Any other key, and a side
 *  without a word, goes to `t` untouched; no words at all hands back `t` itself. */
export function withSideWords(t: TFn, words: SideWords): TFn {
  const { home, away } = words;
  if (home === undefined && away === undefined) return t;
  return (key, vars) => {
    if (key === SIDE_WORD_KEY.home && home !== undefined) return home;
    if (key === SIDE_WORD_KEY.away && away !== undefined) return away;
    return t(key, vars);
  };
}
