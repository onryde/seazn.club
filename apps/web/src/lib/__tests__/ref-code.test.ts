// Registration reference numbers (v3/05 §3, PROMPT-34): human-quotable,
// crockford-style alphabet with no look-alikes, self-checking, retryable.
import { describe, expect, it } from "vitest";
import {
  REF_ALPHABET,
  entryReference,
  formatRefCode,
  generateRefCode,
  isValidRefCode,
  normalizeRefCode,
  parseEntryReference,
} from "@/lib/ref-code";

describe("REF_ALPHABET", () => {
  it("excludes the look-alike characters 0/O/1/I (and crockford's L/U)", () => {
    for (const ch of ["0", "O", "1", "I", "L", "U"]) {
      expect(REF_ALPHABET).not.toContain(ch);
    }
  });

  it("is uppercase and free of duplicates", () => {
    expect(REF_ALPHABET).toBe(REF_ALPHABET.toUpperCase());
    expect(new Set(REF_ALPHABET.split("")).size).toBe(REF_ALPHABET.length);
  });
});

describe("generateRefCode", () => {
  it("produces SZ-XXXX-XXXX with only alphabet characters", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRefCode();
      expect(code).toMatch(/^SZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      for (const ch of code.replace(/^SZ-/, "").replace(/-/g, "")) {
        expect(REF_ALPHABET).toContain(ch);
      }
    }
  });

  it("embeds a checksum that validates", () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidRefCode(generateRefCode())).toBe(true);
    }
  });

  it("draws fresh randomness each call (collision retry is meaningful)", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateRefCode()));
    expect(seen.size).toBe(200);
  });
});

describe("isValidRefCode", () => {
  it("rejects a single flipped character (checksum catches typos)", () => {
    const code = generateRefCode();
    const chars = code.replace("SZ-", "").replace(/-/g, "").split("");
    // flip one payload character to a different alphabet character
    const idx = 2;
    const flip = REF_ALPHABET[(REF_ALPHABET.indexOf(chars[idx]!) + 1) % REF_ALPHABET.length]!;
    chars[idx] = flip;
    expect(isValidRefCode(formatRefCode(chars.join("")))).toBe(false);
  });

  it("rejects garbage and wrong shapes", () => {
    expect(isValidRefCode("")).toBe(false);
    expect(isValidRefCode("SZ-0000-0000")).toBe(false); // excluded chars
    expect(isValidRefCode("XX-ABCD-EFGH")).toBe(false); // wrong prefix
    expect(isValidRefCode("SZ-ABC-DEFGH")).toBe(false); // wrong grouping
  });
});

describe("normalizeRefCode", () => {
  it("uppercases, trims and restores dashes from quoted forms", () => {
    const code = generateRefCode();
    const raw = code.toLowerCase().replace(/-/g, "");
    expect(normalizeRefCode(` ${raw} `)).toBe(code);
    expect(normalizeRefCode(code.toLowerCase())).toBe(code);
  });
});

// Per-entry references (registration redesign spec §6.2, B5 T17). The rule: a cart of one entry is quoted by its cart
// reference alone; a cart of two or more suffixes each entry with its stored, 1-based cart position. `cartSize` counts every
// entry the cart still holds, whatever its status, so a withdrawal never renames a sibling.
describe("entryReference", () => {
  const ref = generateRefCode();

  it("a one-entry cart is quoted by the cart reference alone", () => {
    expect(entryReference(ref, 1, 1)).toBe(ref);
  });

  it("an entry of a 2+ cart carries its position as a suffix", () => {
    expect(entryReference(ref, 2, 3)).toBe(`${ref}-2`);
    expect(entryReference(ref, 1, 2)).toBe(`${ref}-1`);
  });

  it("a position past the surviving count stays as stored (a sibling's division was deleted)", () => {
    // 3-entry cart, entry 2's division deleted: 2 entries survive, entry 3 keeps "-3" — never renumbered to "-2".
    expect(entryReference(ref, 3, 2)).toBe(`${ref}-3`);
  });

  it("refuses a position or cart size that cannot belong to a stored entry", () => {
    const bad: Array<[number, number]> = [
      [0, 2], // positions start at 1
      [-1, 2],
      [1.5, 2],
      [Number.NaN, 2],
      [1, 0], // the entry itself is in the cart, so the cart holds at least one
      [1, 2.5],
    ];
    for (const [position, cartSize] of bad) {
      expect(() => entryReference(ref, position, cartSize), `${position}/${cartSize}`).toThrow(RangeError);
    }
    expect(bad.length).toBe(6);
  });
});

describe("parseEntryReference", () => {
  it("reads a suffixed reference, case-insensitive and trimmed", () => {
    expect(parseEntryReference(" sz-abcd-efgh-2 ")).toEqual({ refCode: "SZ-ABCD-EFGH", position: 2 });
  });

  it("reads a bare cart reference with no position", () => {
    expect(parseEntryReference("SZ-ABCD-EFGH")).toEqual({ refCode: "SZ-ABCD-EFGH", position: null });
  });

  it("is null for anything that is not a reference", () => {
    const notRefs = [
      "hello",
      "",
      "   ",
      "SZ-ABCD-EFG", // short group
      "SZ-ABCD-EFGHJ", // long group
      "XX-ABCD-EFGH", // wrong prefix
      "SZ-ABCD-EFGI", // I is outside the alphabet (look-alike of 1)
      "SZ-ABCD-EFG0", // 0 is outside the alphabet (look-alike of O)
      "SZ-ABCD-EFGH-", // dangling dash
      "SZ-ABCD-EFGH-x",
      "SZ-ABCD-EFGH-2-3",
    ];
    for (const s of notRefs) expect(parseEntryReference(s), JSON.stringify(s)).toBeNull();
    expect(notRefs.length).toBe(11);
  });

  it("is null for position 0 (positions start at 1)", () => {
    const ref = generateRefCode();
    expect(parseEntryReference(`${ref}-0`)).toBeNull();
  });

  it("is null for a position the smallint column cannot hold", () => {
    // registrations.cart_position is smallint (V519): Postgres' smallint tops out at 32767.
    const ref = generateRefCode();
    expect(parseEntryReference(`${ref}-32767`)).toEqual({ refCode: ref, position: 32767 });
    expect(parseEntryReference(`${ref}-32768`)).toBeNull();
    expect(parseEntryReference(`${ref}-99999999999999999999`)).toBeNull();
  });

  it("reads back every reference entryReference writes", () => {
    let checked = 0;
    for (let i = 0; i < 20; i++) {
      const ref = generateRefCode();
      expect(parseEntryReference(entryReference(ref, 1, 1))).toEqual({ refCode: ref, position: null });
      checked++;
      for (const cartSize of [2, 3, 7]) {
        for (let position = 1; position <= cartSize; position++) {
          expect(parseEntryReference(entryReference(ref, position, cartSize))).toEqual({ refCode: ref, position });
          checked++;
        }
      }
    }
    expect(checked).toBe(20 * (1 + 2 + 3 + 7));
  });
});
