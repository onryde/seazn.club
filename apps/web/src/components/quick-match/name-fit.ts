// A side's name set large (quick match League + Knockout sign-off qlk14s1, 2026-11-14): at 320 the champion card's 2rem type
// was narrower than the 43-character name's longest word ("FEATHERSTONEHAUGH-"), so `[overflow-wrap:anywhere]` split it
// mid-word. Every name the home sets large is sized to fit its longest unbreakable run instead (home.tsx: the champion, a
// winner, the page's title, the hero's sides, the tie's title), which is what this counts.

/** Characters as a reader counts them (Unicode grapheme clusters). */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The longest run of `name` a line cannot break inside, in characters as a reader sees them: grapheme clusters, so an
 *  accent typed as a letter plus a combining mark, or an emoji with a skin tone, is one character, not the two or more
 *  code points (or UTF-16 units) it is stored as. A line breaks at a space and after a hyphen ("Featherstonehaugh-" /
 *  "Bray"), so a run ends at either. At least 1: the type divides by it, and a blank name must not make that a division by
 *  zero. */
export function longestUnbreakableRun(name: string): number {
  let longest = 1;
  for (const word of name.split(/\s+/)) {
    for (const run of word.split(/(?<=-)/)) longest = Math.max(longest, [...graphemes.segment(run)].length);
  }
  return longest;
}
