// A side's name set large (quick match League + Knockout sign-off qlk14s1, 2026-11-14): at 320 the champion card's 2rem type
// was narrower than the 43-character name's longest word ("FEATHERSTONEHAUGH-"), so `[overflow-wrap:anywhere]` split it
// mid-word. The card sizes the name to fit its longest unbreakable run instead (home.tsx, `championCard`), which is what
// this counts.

/** The longest run of `name` a line cannot break inside, in characters. A line breaks at a space and after a hyphen
 *  ("Featherstonehaugh-" / "Bray"), so a run ends at either. At least 1: the type divides by it, and a blank name must not
 *  make that a division by zero. */
export function longestUnbreakableRun(name: string): number {
  let longest = 1;
  for (const word of name.split(/\s+/)) {
    for (const run of word.split(/(?<=-)/)) longest = Math.max(longest, [...run].length);
  }
  return longest;
}
