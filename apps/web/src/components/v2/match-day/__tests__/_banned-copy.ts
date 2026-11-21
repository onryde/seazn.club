// The characters the round column's copy never carries (spec 2026-10-24-arbiter-round-column-design.md §9): the en dash, the em dash,
// the two arrows and the diagonal arrow. Defined ONCE; round-column-copy.test.ts (the dictionaries) and the two suites that guard other
// Lichess-link copy (register-lichess-card, division-settings-online-link-gaps) import it, so a character added or dropped here moves all
// of them. (It lived beside the Arbiter Panel's column until the page was retired into Match Day.)
//
// Built from code points, not typed: a `\u` escape in a source edit is mangled by tooling in this repo.
export const BANNED_CODE_POINTS: readonly number[] = [0x2013, 0x2014, 0x2192, 0x2190, 0x2197];

/** The banned characters as strings, in the order above. */
export const BANNED: readonly string[] = BANNED_CODE_POINTS.map((c) => String.fromCharCode(c));

/** Matches any one of them. Not global: `.test` and `.toMatch` carry no `lastIndex` between calls. */
export const BANNED_RE = new RegExp(`[${BANNED.join("")}]`);
