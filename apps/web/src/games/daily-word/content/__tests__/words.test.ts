// Sanity + invariant checks for the two word lists. These are audit-shaped
// (there's no "behavior" to fail without the fix, since the lists are
// static data) -- the load-bearing assertion is the superset check: if a
// future edit ever adds a word to answers.ts without also adding it to
// allowed.ts, answerFor() could return a day's answer that isValidGuess()
// itself would reject, breaking the game on that exact day. See this
// game's engine.ts and the design doc's Daily Word section.
import { describe, expect, it } from "vitest";
import { ANSWERS } from "../answers";
import { ALLOWED } from "../allowed";

const WORD_RE = /^[A-Z]{5}$/;

describe("ANSWERS", () => {
  it("has a few hundred entries", () => {
    expect(ANSWERS.length).toBeGreaterThanOrEqual(300);
  });

  it("every entry is exactly 5 uppercase A-Z letters", () => {
    for (const w of ANSWERS) expect(w).toMatch(WORD_RE);
  });

  it("has no duplicates", () => {
    expect(new Set(ANSWERS).size).toBe(ANSWERS.length);
  });
});

describe("ALLOWED", () => {
  it("is larger than ANSWERS", () => {
    expect(ALLOWED.length).toBeGreaterThan(ANSWERS.length);
  });

  it("every entry is exactly 5 uppercase A-Z letters", () => {
    for (const w of ALLOWED) expect(w).toMatch(WORD_RE);
  });

  it("has no duplicates", () => {
    expect(new Set(ALLOWED).size).toBe(ALLOWED.length);
  });

  it("is a strict superset of ANSWERS -- every possible daily answer is a legal guess", () => {
    const allowedSet = new Set(ALLOWED);
    for (const w of ANSWERS) expect(allowedSet.has(w)).toBe(true);
  });

  it("has at least ten thousand entries -- the real-dictionary rebuild (2026-08-27)", () => {
    // Regression guard for the whole rebuild, not just a specific word.
    // allowed.ts is now sourced from /usr/share/dict/words (Webster's
    // Second International, public domain -- see LICENSE.md): every real
    // 5-letter entry plus the regular ("+s") plural of every 4-letter
    // entry. A future edit that accidentally reverts allowed.ts to a
    // smaller, hand-authored version should fail loudly here, not just for
    // the specific words below.
    expect(ALLOWED.length).toBeGreaterThanOrEqual(10_000);
  });

  it("accepts common everyday plurals/verb-forms a real player types (regression: 'pears'/'rains'/'worms' were all rejected in live play)", () => {
    // Three live-play reports, 2026-08-27: typing "pears", then "rains",
    // then "worms" -- each a common, valid English word -- were rejected
    // as "not a word". Root cause was systemic and specific: the
    // dictionary this list is now built from is lemma-based (it lists
    // "pear"/"rain"/"worm" as headwords but not their plain "-s" plural
    // forms as separate entries), which is exactly why allowed.ts also
    // generates 4-letter-dictionary-word + "s" as its own source (see
    // LICENSE.md and allowed.ts's header). This locks in the three
    // reported cases plus a spot-check across the same class so it can't
    // silently regress.
    const allowedSet = new Set(ALLOWED);
    for (const w of ["PEARS", "RAINS", "WORMS", "BEARS", "WALKS", "WORKS", "TAKES", "MOVES"]) {
      expect(allowedSet.has(w), `expected ALLOWED to contain ${w}`).toBe(true);
    }
  });

  it("does not mis-pluralize 4-letter roots whose real plural is '+es', not '+s' (code review, 2026-08-27)", () => {
    // The 4-letter+s pluralization step blindly appended "s" to every
    // 4-letter dictionary root, which is wrong for roots ending in
    // s/x/z/ch/sh (their real plural adds "es", six letters, out of scope
    // for this game) -- shipping nonsense guesses like "fishs" (should be
    // "fishes"), "axess", "basss", "buzzs", "cashs", "dishs". Caught in
    // code review before merge, fixed by excluding that subset from
    // pluralization entirely rather than mis-pluralizing it.
    const allowedSet = new Set(ALLOWED);
    for (const bad of ["FISHS", "AXESS", "BASSS", "BUZZS", "CASHS", "DISHS", "WISHS", "MASSS"]) {
      expect(allowedSet.has(bad), `expected ALLOWED NOT to contain nonsense word ${bad}`).toBe(false);
    }
  });
});
