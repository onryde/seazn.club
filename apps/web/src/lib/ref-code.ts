// Registration reference numbers (v3/05 §3, PROMPT-34). Human-quotable,
// self-checking, generated server-side with a collision-retry loop against
// the registrations.ref_code unique index.
//
// Alphabet: crockford-base32 spirit — no 0/O, 1/I, and (per crockford) no
// L/U either, so a ref survives being read over a phone. 30 characters.
//
// Shape: 6 random chars + 2 checksum chars = SZ-XXXX-XXXX. The design doc's
// mask sketch (`SZ-XXXX-XX`) can't hold its own stated composition ("6 random
// chars + 2-char checksum, ~1B space at 6 chars"), so the composition wins:
// 30^6 ≈ 729M payload space, dash-grouped 4+4 for quotability.

export const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

const PAYLOAD_LEN = 6;
const CODE_LEN = PAYLOAD_LEN + 2; // + 2 checksum chars
const BASE = REF_ALPHABET.length; // 30
const MOD = BASE * BASE; // two check characters

/** Weighted polynomial checksum: every single-character flip and most
 *  transpositions change the sum (weights 31^k are all coprime to 900). */
function checksum(payload: string): string {
  let sum = 0;
  for (const ch of payload) {
    sum = (sum * 31 + REF_ALPHABET.indexOf(ch)) % MOD;
  }
  return `${REF_ALPHABET[Math.floor(sum / BASE)]}${REF_ALPHABET[sum % BASE]}`;
}

/** Dash-group a raw 8-char payload+checksum string as SZ-XXXX-XXXX. */
export function formatRefCode(chars: string): string {
  return `SZ-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

// Per-entry references (registration redesign spec §6.2). Every entry of a cart shares the cart's ref code; an entry is told
// apart by `registrations.cart_position`, its 1-based place in the cart. Both inputs are stored (V519) and never change after
// submit, because an offline bank transfer quotes the reference: a deleted sibling's division leaves a gap, so `…-3` still
// means the third entry the person sent, and a lone survivor of a 3-entry cart is still `…-3`.

/** The largest position `registrations.cart_position` (Postgres smallint) can hold. */
const MAX_CART_POSITION = 32767;

/** The reference to quote for one entry: the cart ref alone for a one-entry cart, `SZ-XXXX-XXXX-<position>` otherwise.
 *  `cartSize` is the cart's stored `registration_groups.cart_size` — how many entries it was sent with, never decremented —
 *  not a count of the entries that survive, so no withdrawal or division delete ever changes a reference. */
export function entryReference(refCode: string, position: number, cartSize: number): string {
  if (!Number.isInteger(position) || position < 1) {
    throw new RangeError(`entryReference: position must be an integer >= 1, got ${position}`);
  }
  if (!Number.isInteger(cartSize) || cartSize < position) {
    throw new RangeError(`entryReference: cartSize must be an integer >= the position (${position}), got ${cartSize}`);
  }
  return cartSize < 2 ? refCode : `${refCode}-${position}`;
}

/** The reference to quote for the entry a `registrations ⨝ registration_groups` row names (`regGroupCols`), or null when the cart has
 *  none (`registration_groups.ref_code` is nullable: a submit whose reference mint ran out of retries still commits the cart). The one
 *  reading of those three columns, so the pay page, the reminder and promotion mails, the status page and the organiser's views all
 *  quote the same string, and an offline transfer that quotes it matches what the organiser sees and searches (spec §6.3, §6.4). */
export function entryReferenceOf(row: { ref_code: string | null; cart_position: number; cart_size: number }): string | null {
  return row.ref_code === null ? null : entryReference(row.ref_code, row.cart_position, row.cart_size);
}

const ENTRY_REFERENCE = new RegExp(`^SZ-([${REF_ALPHABET}]{4}-[${REF_ALPHABET}]{4})(?:-([1-9][0-9]*))?$`);

/** Reads `SZ-XXXX-XXXX` (position null) or `SZ-XXXX-XXXX-<n>`, trimmed and case-insensitive, over the ref alphabet only.
 *  The checksum is not verified: a mistyped ref matches no row, which is all a search needs. Null for anything else,
 *  including position 0 and a position the column could never hold. */
export function parseEntryReference(input: string): { refCode: string; position: number | null } | null {
  const m = ENTRY_REFERENCE.exec(input.trim().toUpperCase());
  if (!m) return null;
  const refCode = `SZ-${m[1]}`;
  if (m[2] === undefined) return { refCode, position: null };
  const position = Number(m[2]);
  return position <= MAX_CART_POSITION ? { refCode, position } : null;
}

/** Unbiased random alphabet indices via rejection sampling. */
function randomChars(n: number): string {
  const chars: string[] = [];
  const buf = new Uint8Array(n * 2);
  while (chars.length < n) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (chars.length === n) break;
      if (byte >= 240) continue; // 240 = 8 * 30 — reject the biased tail
      chars.push(REF_ALPHABET[byte % BASE]!);
    }
  }
  return chars.join("");
}

export function generateRefCode(): string {
  const payload = randomChars(PAYLOAD_LEN);
  return formatRefCode(payload + checksum(payload));
}

/** Uppercase, strip separators/prefix noise, re-shape. Returns the canonical
 *  SZ-XXXX-XXXX form, or the cleaned input if it can't be a ref (callers
 *  then fail the validity check rather than throw). */
export function normalizeRefCode(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("SZ")) s = s.slice(2);
  return s.length === CODE_LEN ? formatRefCode(s) : raw.trim().toUpperCase();
}

export function isValidRefCode(raw: string): boolean {
  const m = /^SZ-([A-Z2-9]{4})-([A-Z2-9]{4})$/.exec(normalizeRefCode(raw));
  if (!m) return false;
  const chars = `${m[1]}${m[2]}`;
  for (const ch of chars) {
    if (!REF_ALPHABET.includes(ch)) return false;
  }
  const payload = chars.slice(0, PAYLOAD_LEN);
  return checksum(payload) === chars.slice(PAYLOAD_LEN);
}

/** A reference as a PERSON gives it: typed, pasted or read off a mail or a bank statement (B5 T18 review). Either the cart's `SZ-XXXX-XXXX`
 *  (read as `normalizeRefCode` always has: any case, with or without the `SZ` and the dashes, spaces anywhere) or an entry's own
 *  `SZ-XXXX-XXXX-<n>` (the mails print it; `parseEntryReference`'s strict dashed form, any case, trimmed). `refCode` is the cart's, which
 *  is what finds the cart; `position` is the entry number quoted, or null for a bare reference, for the caller to hold against the cart's
 *  size. Null for anything no entry could carry (position 0, past the column), and for a cart reference that fails its checksum. */
export function parseTypedReference(raw: string): { refCode: string; position: number | null } | null {
  const entry = parseEntryReference(raw);
  const refCode = entry ? entry.refCode : normalizeRefCode(raw);
  if (!isValidRefCode(refCode)) return null;
  return { refCode, position: entry?.position ?? null };
}

/** A reference as it reaches the organiser's SEARCH box (B5 T19, controller ruling 2026-11-13): the text a bank statement or a pasted
 *  mail line leaves behind, where the dashes and spaces are gone or doubled and punctuation trails: `SZABCDEFGH2`, `sz abcd efgh 2`,
 *  `(SZ-ABCD-EFGH-2).`. Everything but letters and digits is dropped, the rest is upper-cased, and the reference is read off the front:
 *  an optional `SZ`, the 8 code characters (alphabet and checksum verified), then optionally the entry's position as plain digits.
 *  A code is always exactly 8 characters, so a suffix never needs a separator to be told from it.
 *
 *  When the text does not START with a reference it is scanned for one (`findEmbeddedReference`): a payer writes the reference into a
 *  sentence and a bank prints it inside its own words, `PAYMENT SZ-ABCD-EFGH-2 THANK YOU` (T19 review m1).
 *
 *  Deliberately NOT `parseTypedReference`: that one reads what a person types into /r/ and the by-ref lookups, which have always
 *  refused `${ref}2` (the mails print `-2`, and a lookup that guessed would answer for the wrong cart on a typo). A search only lists
 *  rows, so being generous costs nothing, and the checksum keeps a name from being read as a reference. Same result shape, and
 *  anything `parseTypedReference` reads this reads identically.
 *
 *  A code whose payload itself starts with `SZ` is read both with the prefix first and without it; the first reading that holds up
 *  wins. Both can hold only on a checksum coincidence (about 1 in 800,000 for a typed reference), and the cost is one search missing. */
export function parseSearchReference(raw: string): { refCode: string; position: number | null } | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const body of s.startsWith("SZ") ? [s.slice(2), s] : [s]) {
    const chars = body.slice(0, CODE_LEN);
    const rest = body.slice(CODE_LEN);
    if (chars.length !== CODE_LEN || !isValidRefCode(formatRefCode(chars))) continue;
    if (rest === "") return { refCode: formatRefCode(chars), position: null };
    if (!/^[1-9][0-9]{0,4}$/.test(rest)) continue;
    const position = Number(rest);
    if (position <= MAX_CART_POSITION) return { refCode: formatRefCode(chars), position };
  }
  return findEmbeddedReference(raw.toUpperCase());
}

/** Up to three separator characters (a dash, spaces, a line break, a dot) may sit between the `SZ` and the code and between its characters. */
const SEPARATORS = "[^A-Z0-9]{0,3}";
const EMBEDDED_REFERENCE = `SZ${SEPARATORS}((?:[${REF_ALPHABET}]${SEPARATORS}){${CODE_LEN - 1}}[${REF_ALPHABET}])(?:-?([0-9]+))?`;

/** A reference inside other text (`parseSearchReference`'s second reading; `upper` is the text upper-cased): `SZ`, then the 8 code
 *  characters with up to three separators between any two, then the entry's position when it is ATTACHED to the code, directly or after
 *  one dash, which is how the mails print it (`…-2`). The `SZ` is required here: eight good characters in a sentence are a coincidence
 *  one time in 900, and only a prefix makes it a reference. A number merely SEPARATED from the code (`SZ-ABCD-EFGH 2025-11-13`) is not
 *  taken for its position, so the whole cart is found, a superset of the entry: a search that over-lists is better than one that misses.
 *  An attached position no entry can carry (`-0`, `-02`, past the column) rejects that reading, as it does at the front.
 *  Null when no reading holds up; the first valid one wins. */
function findEmbeddedReference(upper: string): { refCode: string; position: number | null } | null {
  const re = new RegExp(EMBEDDED_REFERENCE, "g");
  for (let m = re.exec(upper); m !== null; m = re.exec(upper)) {
    // The next attempt starts one character on, not after this match: a decoy `SZ` (`SZ SZ-ABCD-EFGH`) must not swallow the real one.
    re.lastIndex = m.index + 1;
    const refCode = formatRefCode(m[1]!.replace(/[^A-Z0-9]/g, ""));
    if (!isValidRefCode(refCode)) continue;
    if (m[2] === undefined) return { refCode, position: null };
    if (!/^[1-9][0-9]{0,4}$/.test(m[2])) continue;
    const position = Number(m[2]);
    if (position <= MAX_CART_POSITION) return { refCode, position };
  }
  return null;
}

/** Which parts of a search text may be a PART of a reference, for the search's partial-reference matches (B5 T19 review m1/m2, tightened
 *  2026-11-13). Every stored reference starts `SZ-` and carries 8 characters of a 30-character alphabet, so a short text is "in" some
 *  reference by chance (`sz` is in every one, `Ann` in about one in 4,500, a digit in about one in four), and a reference fragment
 *  that fired on any text would list random carts under a name search. A fragment is offered only when the text has the weight of one:
 *   - `dashless`: the letters and digits only, upper-cased, to be matched against the reference with its dashes taken out, from FOUR
 *     of them (`SZ7F3K`, `7F3KQ2` straddling the dash, `2345`, `PAYMENTSZ…`: what a bank statement leaves);
 *   - `written`: the text exactly as typed, to be matched against the dashed `SZ-ABCD-EFGH`, when it has a dash AND three characters
 *     beyond a leading `SZ` (`SZ-7F3`, `-7F3`: what a person types while reading a reference out; `SZ-7` and `-7F` are not enough).
 *  A bare digit, `N2`, `7F3` and `le` offer nothing and stay name and e-mail searches. The two are separate predicates because a text of
 *  four characters matches the dashed reference only where it also matches the dashless one, so `written` adds nothing for it. */
export function referenceFragmentsOf(raw: string): { written: string | null; dashless: string | null } {
  const written = raw.trim();
  const alnum = written.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const beyondTheSZ = alnum.startsWith("SZ") ? alnum.length - 2 : alnum.length;
  return {
    written: written.includes("-") && beyondTheSZ >= 3 ? written : null,
    dashless: alnum.length >= 4 ? alnum : null,
  };
}
