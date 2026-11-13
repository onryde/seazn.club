// Registration reference numbers (v3/05 §3, PROMPT-34): human-quotable,
// crockford-style alphabet with no look-alikes, self-checking, retryable.
import { describe, expect, it } from "vitest";
import {
  REF_ALPHABET,
  entryReference,
  entryReferenceOf,
  formatRefCode,
  generateRefCode,
  isValidRefCode,
  normalizeRefCode,
  parseEntryReference,
  parseSearchReference,
  parseTypedReference,
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

// Per-entry references (registration redesign spec §6.2, B5 T17, orchestrator ruling 2026-11-13). The rule: a cart of one
// entry is quoted by its cart reference alone; a cart of two or more suffixes each entry with its stored, 1-based cart
// position. `cartSize` is the cart's STORED size (`registration_groups.cart_size`, V519): how many entries it was sent with,
// never decremented. A reference someone quoted on a bank transfer therefore never changes after submit — not on a
// withdrawal, and not when a sibling's division is deleted.
describe("entryReference", () => {
  const ref = generateRefCode();

  it("a one-entry cart is quoted by the cart reference alone", () => {
    expect(entryReference(ref, 1, 1)).toBe(ref);
  });

  it("an entry of a 2+ cart carries its position as a suffix", () => {
    expect(entryReference(ref, 2, 3)).toBe(`${ref}-2`);
    expect(entryReference(ref, 1, 2)).toBe(`${ref}-1`);
  });

  it("a lone survivor of a 3-entry cart keeps its suffix (the stored size is 3, not the 1 left)", () => {
    expect(entryReference(ref, 3, 3)).toBe(`${ref}-3`);
  });

  it("refuses a position or cart size that cannot belong to a stored entry", () => {
    const bad: Array<[number, number]> = [
      [0, 2], // positions start at 1
      [-1, 2],
      [1.5, 2],
      [Number.NaN, 2],
      [1, 0], // the entry itself is in the cart, so the cart holds at least one
      [1, 2.5],
      [3, 2], // the stored size is the largest position the cart ever reached
      [2, 1],
    ];
    for (const [position, cartSize] of bad) {
      expect(() => entryReference(ref, position, cartSize), `${position}/${cartSize}`).toThrow(RangeError);
    }
    expect(bad.length).toBe(8);
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

// Registration redesign B5 T18: the one reading of an entry's reference off a `registrations ⨝ registration_groups` row, so the pay
// page, the reminder and promotion mails, the status page and (T19) the organiser's views all quote the SAME string.
describe("entryReferenceOf", () => {
  it("is the entry's own reference: bare for a one-entry cart, suffixed with its position for a 2+ cart", () => {
    const ref = generateRefCode();
    expect(entryReferenceOf({ ref_code: ref, cart_position: 1, cart_size: 1 })).toBe(ref);
    expect(entryReferenceOf({ ref_code: ref, cart_position: 1, cart_size: 2 })).toBe(`${ref}-1`);
    expect(entryReferenceOf({ ref_code: ref, cart_position: 2, cart_size: 2 })).toBe(`${ref}-2`);
  });

  it("a cart whose reference mint ran out of retries has none, so no entry does (ref_code is nullable)", () => {
    expect(entryReferenceOf({ ref_code: null, cart_position: 2, cart_size: 3 })).toBeNull();
  });

  it("is entryReference over the row's three columns: a lone survivor of a 3-entry cart is still -3", () => {
    const ref = generateRefCode();
    const row = { ref_code: ref, cart_position: 3, cart_size: 3 };
    expect(entryReferenceOf(row)).toBe(entryReference(ref, 3, 3));
    expect(entryReferenceOf(row)).toBe(`${ref}-3`);
  });

  it("refuses a row the database cannot hold (position past the size), by entryReference's own name", () => {
    expect(() => entryReferenceOf({ ref_code: generateRefCode(), cart_position: 3, cart_size: 1 })).toThrow(RangeError);
  });
});

// Registration redesign B5 T18 review (m1): a person types, pastes or reads out the reference the mails now print, `SZ-XXXX-XXXX-2`, into
// /r/<ref> and the by-ref lookups. The suffix names the entry; the cart's reference is what finds the cart.
describe("parseTypedReference", () => {
  it("a bare reference reads as before, however it was typed: any case, with or without the SZ and the dashes, spaces anywhere", () => {
    const ref = generateRefCode();
    const bare = ref.replace(/^SZ-/, "").replace("-", "");
    for (const typed of [ref, ref.toLowerCase(), ` ${ref} `, `sz ${bare.slice(0, 4)} ${bare.slice(4)}`, bare, `SZ${bare}`]) {
      expect(parseTypedReference(typed), JSON.stringify(typed)).toEqual({ refCode: ref, position: null });
    }
  });

  it("a suffixed reference reads as the cart's reference and the entry's number, in any case and trimmed", () => {
    const ref = generateRefCode();
    expect(parseTypedReference(`${ref}-2`)).toEqual({ refCode: ref, position: 2 });
    expect(parseTypedReference(` ${ref.toLowerCase()}-12 `)).toEqual({ refCode: ref, position: 12 });
  });

  it("is parseEntryReference's own reading of what entryReference prints, for every position the column holds", () => {
    let checked = 0;
    for (let i = 0; i < 10; i++) {
      const ref = generateRefCode();
      for (const [position, size] of [[1, 1], [1, 2], [2, 2], [7, 9], [32767, 32767]] as const) {
        const printed = entryReference(ref, position, size);
        expect(parseTypedReference(printed), printed).toEqual({ refCode: ref, position: size === 1 ? null : position });
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity").toBe(50);
  });

  it("refuses what no entry can carry: position 0, a leading zero, past the column, a negative or a non-number", () => {
    const ref = generateRefCode();
    const refused = [`${ref}-0`, `${ref}-02`, `${ref}-32768`, `${ref}-99999999`, `${ref}--1`, `${ref}-x`, `${ref}-2-3`, `${ref}2`];
    for (const typed of refused) expect(parseTypedReference(typed), typed).toBeNull();
    expect(refused.length, "anti-vacuity").toBe(8);
  });

  it("the checksum still rejects a mistyped cart reference, with or without a suffix", () => {
    const ref = generateRefCode();
    const chars = ref.replace("SZ-", "").replace(/-/g, "").split("");
    chars[2] = REF_ALPHABET[(REF_ALPHABET.indexOf(chars[2]!) + 1) % REF_ALPHABET.length]!;
    const typo = formatRefCode(chars.join(""));
    expect(parseTypedReference(typo)).toBeNull();
    expect(parseTypedReference(`${typo}-2`)).toBeNull();
  });

  it("refuses nothing-shaped input", () => {
    for (const typed of ["", "   ", "SZ", "-2", "hello", "SZ-ABCD"]) expect(parseTypedReference(typed), JSON.stringify(typed)).toBeNull();
  });
});

// Registration redesign B5 T19 (controller ruling 2026-11-13): the organiser's SEARCH box reads a reference looser than /r/ does. A
// bank statement or a pasted mail line strips the dashes and spaces, so `SZ-ABCD-EFGH-2` reaches the box as `SZABCDEFGH2`, `SZ ABCD
// EFGH 2` or `sz-abcd-efgh-2.`; `parseTypedReference` (the /r/ and by-ref lookups) stays strict and keeps refusing `${ref}2`.
describe("parseSearchReference", () => {
  /** A reference whose payload does not start with SZ, so the prefix-less spellings below are unambiguous. */
  const plainRef = () => {
    for (;;) {
      const ref = generateRefCode();
      if (!ref.startsWith("SZ-SZ")) return ref;
    }
  };

  it("reads a bare cart reference however it was spelled: any case, with or without the SZ, dashes, spaces and trailing punctuation", () => {
    const ref = plainRef();
    const bare = ref.replace(/^SZ-/, "").replace("-", "");
    const spellings = [ref, ref.toLowerCase(), ` ${ref} `, `SZ${bare}`, `sz ${bare.slice(0, 4)} ${bare.slice(4)}`, bare, bare.toLowerCase(), `${ref}.`, `(${ref}),`, `SZ_${bare}`];
    for (const typed of spellings) expect(parseSearchReference(typed), JSON.stringify(typed)).toEqual({ refCode: ref, position: null });
    expect(spellings.length, "anti-vacuity").toBe(10);
  });

  it("reads an entry's reference the same way, with the separators stripped as a bank statement leaves them", () => {
    const ref = plainRef();
    const bare = ref.replace(/^SZ-/, "").replace("-", "");
    for (const position of [1, 2, 9, 10, 12, 32767]) {
      const spellings = [
        `${ref}-${position}`,
        `${ref.toLowerCase()}-${position}`,
        `SZ${bare}${position}`,
        `sz${bare.toLowerCase()}${position}`,
        `SZ ${bare.slice(0, 4)} ${bare.slice(4)} ${position}`,
        `${ref}${position}`,
        `${ref}-${position}.`,
        `${bare}${position}`,
        `  ${ref}  -  ${position}  `,
      ];
      for (const typed of spellings) expect(parseSearchReference(typed), JSON.stringify(typed)).toEqual({ refCode: ref, position });
      expect(spellings.length, "anti-vacuity").toBe(9);
    }
  });

  it("a payload that itself starts with SZ is read with or without the prefix", () => {
    let ref = generateRefCode();
    for (let i = 0; i < 20000 && !ref.startsWith("SZ-SZ"); i++) ref = generateRefCode();
    expect(ref.startsWith("SZ-SZ"), "premise: drew a reference whose payload starts with SZ").toBe(true);
    const bare = ref.replace(/^SZ-/, "").replace("-", "");
    for (const typed of [ref, `SZ${bare}`, bare]) expect(parseSearchReference(typed), typed).toEqual({ refCode: ref, position: null });
    for (const typed of [`${ref}-3`, `SZ${bare}3`, `${bare}3`]) expect(parseSearchReference(typed), typed).toEqual({ refCode: ref, position: 3 });
  });

  it("is a superset of parseTypedReference: everything it reads, it reads the same", () => {
    let checked = 0;
    for (let i = 0; i < 20; i++) {
      const ref = generateRefCode();
      for (const typed of [ref, ref.toLowerCase(), ` ${ref} `, `${ref}-2`, ` ${ref.toLowerCase()}-12 `]) {
        const strict = parseTypedReference(typed);
        expect(strict, typed).not.toBeNull();
        expect(parseSearchReference(typed), typed).toEqual(strict);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity").toBe(100);
  });

  it("the /r/ reader stays strict: the same loose spellings are refused there", () => {
    const ref = generateRefCode();
    const bare = ref.replace(/^SZ-/, "").replace("-", "");
    for (const typed of [`${ref}2`, `SZ${bare}2`, `SZ ${bare.slice(0, 4)} ${bare.slice(4)} 2`, `${ref}-2.`]) {
      expect(parseTypedReference(typed), typed).toBeNull();
      expect(parseSearchReference(typed), typed).not.toBeNull();
    }
  });

  it("refuses what no entry can carry: position 0, a leading zero, past the column; and a mistyped, short, long or non-reference input", () => {
    const ref = plainRef();
    const bare = ref.replace(/^SZ-/, "").replace("-", "");
    const refused = [`${ref}-0`, `${ref}-02`, `SZ${bare}02`, `${ref}-32768`, `${ref}-99999999`, `${ref}-x`, `SZ${bare}2X`, "", "   ", "SZ", "-2", "hello", "SZ-ABCD", `SZ-${bare.slice(0, 7)}`];
    for (const typed of refused) expect(parseSearchReference(typed), JSON.stringify(typed)).toBeNull();
    // The checksum still rejects one flipped character, with or without a suffix.
    const chars = bare.split("");
    chars[2] = REF_ALPHABET[(REF_ALPHABET.indexOf(chars[2]!) + 1) % REF_ALPHABET.length]!;
    const typo = chars.join("");
    for (const typed of [typo, `SZ${typo}`, `SZ${typo}2`, formatRefCode(typo), `${formatRefCode(typo)}-2`]) expect(parseSearchReference(typed), typed).toBeNull();
    expect(refused.length, "anti-vacuity").toBe(14);
  });
});
