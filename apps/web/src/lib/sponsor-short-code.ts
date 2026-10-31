// Sponsor short codes (R4 sponsors on stream, owner ruling R7): the stream lower third prints `seazn.club/s/<code>`,
// and a viewer types it from a broadcast. Client-safe: imports nothing.
//
// The alphabet is [0-9A-Z] without the characters a viewer misreads — 0/O and 1/I/L. Its ONE authority is this file:
// the DB CHECK on sponsor_short_codes.code (V483) states the same pattern as a literal (SQL cannot import it), and
// server/sponsors/__tests__/migration.test.ts reads the CHECK back and compares it to SPONSOR_SHORT_CODE_PATTERN.

export const SPONSOR_SHORT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SPONSOR_SHORT_CODE_MIN_LENGTH = 4;
export const SPONSOR_SHORT_CODE_MAX_LENGTH = 8;

/** A whole code: MIN..MAX alphabet characters, uppercase only. A sponsor uuid never matches (lowercase hex, hyphens). */
export const SPONSOR_SHORT_CODE_PATTERN = new RegExp(
  `^[${SPONSOR_SHORT_CODE_ALPHABET}]{${SPONSOR_SHORT_CODE_MIN_LENGTH},${SPONSOR_SHORT_CODE_MAX_LENGTH}}$`,
);
