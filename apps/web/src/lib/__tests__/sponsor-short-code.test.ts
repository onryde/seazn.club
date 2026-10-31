// R4 sponsors on stream, S3 "R7 addition" (owner ruling R7: a short code on the stream lower third). A viewer reads
// `seazn.club/s/<code>` off a broadcast and types it, so the alphabet must hold no character that reads as another:
// no 0/O, no 1/I/L. The expected alphabet is DERIVED from that rule — [0-9A-Z] minus the five — never copied from the
// constant under test. The DB CHECK agreeing with the constant is proved against a live schema in
// server/sponsors/__tests__/migration.test.ts.
import { describe, expect, it } from "vitest";
import {
  SPONSOR_SHORT_CODE_ALPHABET,
  SPONSOR_SHORT_CODE_MAX_LENGTH,
  SPONSOR_SHORT_CODE_MIN_LENGTH,
  SPONSOR_SHORT_CODE_PATTERN,
} from "@/lib/sponsor-short-code";

/** R7: the characters a viewer misreads. */
const AMBIGUOUS = ["0", "O", "1", "I", "L"];
const DIGITS_AND_UPPER = [..."0123456789", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const EXPECTED = DIGITS_AND_UPPER.filter((c) => !AMBIGUOUS.includes(c));

describe("lib/sponsor-short-code — the unambiguous alphabet (R7)", () => {
  it("is exactly [0-9A-Z] without 0/O/1/I/L, each character once (count reported)", () => {
    const chars = [...SPONSOR_SHORT_CODE_ALPHABET];
    expect(new Set(chars).size, "no duplicate characters").toBe(chars.length);
    expect([...chars].sort()).toEqual([...EXPECTED].sort());
    expect(chars.length, "alphabet size").toBe(36 - AMBIGUOUS.length);
  });

  it("codes are 4 to 8 characters (R7)", () => {
    expect(SPONSOR_SHORT_CODE_MIN_LENGTH).toBe(4);
    expect(SPONSOR_SHORT_CODE_MAX_LENGTH).toBe(8);
  });

  it("the pattern accepts every alphabet character and refuses every ambiguous one, lowercase, and an out-of-range length (counts reported)", () => {
    let accepted = 0;
    for (const c of EXPECTED) {
      expect(SPONSOR_SHORT_CODE_PATTERN.test(c.repeat(4)), c).toBe(true);
      accepted++;
    }
    expect(accepted, "alphabet characters accepted").toBe(31);
    let refused = 0;
    for (const c of AMBIGUOUS) {
      // One bad character among good ones: the pattern must look at every position, not just the first.
      expect(SPONSOR_SHORT_CODE_PATTERN.test(`AB${c}C`), c).toBe(false);
      refused++;
    }
    expect(refused, "ambiguous characters refused").toBe(AMBIGUOUS.length);
    expect(SPONSOR_SHORT_CODE_PATTERN.test("abcd"), "lowercase").toBe(false);
    expect(SPONSOR_SHORT_CODE_PATTERN.test("ABC"), "3 chars").toBe(false);
    expect(SPONSOR_SHORT_CODE_PATTERN.test("ABCD"), "4 chars").toBe(true);
    expect(SPONSOR_SHORT_CODE_PATTERN.test("ABCDEFGH"), "8 chars").toBe(true);
    expect(SPONSOR_SHORT_CODE_PATTERN.test("ABCDEFGHJ"), "9 chars").toBe(false);
    // A sponsor uuid (the /s/ route's other segment shape) is never a code.
    expect(SPONSOR_SHORT_CODE_PATTERN.test("6f1c2a9e-0b7d-4c1e-9a3f-2d5e8b7c4a10"), "a uuid").toBe(false);
  });
});
