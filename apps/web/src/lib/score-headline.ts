// The device page's LED headline (device-score-pad.tsx's header), laid out in unbreakable runs. A headline is " · "
// groups ("1 — 0 · 21-18 (16-12)": sets won, then the open game), and a group may name both sides apart with " — ". A
// group is drawn whole, never broken inside (a number split across lines is unreadable), and lines break only between
// groups.
//
// Except a group too long for one line on the narrowest phone (sign-off qmc14a, quick match cricket, 2026-11-14): a
// cricket headline is the two innings, "10/0 (1) — 9/0 (1)", one group of 18 characters, which at the LED size ran off
// the header card at 320 and 390. Such a group is drawn as one run per side, the side dash kept on the left, so the line
// may break between the two sides and nowhere else. A group that fits stays one run, so a set-score sport's header is
// exactly as before.

const GROUP = " · ";
const SIDES = " — ";

/** The longest group drawn as one run: the characters of the LED's monospace numerals (about 0.6em each at 8.5vw, so
 *  27.2px at 320) that fit the header card's text box on a 320px phone (320 less the page's 16px gutters and the card's
 *  12px padding each side: 264px). A longer group splits at its side dash. */
export const LED_ONE_LINE_CHARS = 16;

/** The headline's groups, each as its runs: one run for a group that fits a line, else one per side with the side dash
 *  kept at the end of every run but the last. Joined back (runs by a space, groups by " · ") they are the headline
 *  exactly. */
export function headlineRuns(headline: string): string[][] {
  return headline.split(GROUP).map((group) => {
    if (group.length <= LED_ONE_LINE_CHARS) return [group];
    const sides = group.split(SIDES);
    return sides.map((side, i) => (i < sides.length - 1 ? `${side} —` : side));
  });
}
