// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.1-7.2): the fixed ids of the one platform
// system org and system user that hold every guest-created quick match, and the limits the create path enforces itself.
//
// Import-free on purpose: `server/api-v1/schemas.ts` imports this file relatively, so nothing here may pull in a module.
// The ids and the email are written verbatim into the `V*__quick_matches.sql` migration that seeds the rows; change one
// and you change both.

/** The system org that holds every quick match. Private, no human members. */
export const QUICK_MATCH_SYSTEM_ORG_ID = "00000000-0000-4000-8000-00000000a001";
/** The actor for every guest-created row. No password, no Google link: it can never sign in. */
export const QUICK_MATCH_SYSTEM_USER_ID = "00000000-0000-4000-8000-00000000a002";
/** `.invalid` is reserved (RFC 2606), so no mail is ever deliverable to it. */
export const QUICK_MATCH_SYSTEM_USER_EMAIL = "quick-matches@system.seazn.invalid";
export const QUICK_MATCH_SYSTEM_ORG_SLUG = "seazn-quick-matches";

/** Sides in one quick match, inclusive. */
export const QUICK_MATCH_MAX_SIDES = 6;
export const QUICK_MATCH_MIN_SIDES = 2;
/** League plays per pair (legs), at most. */
export const QUICK_MATCH_MAX_PLAYS = 4;
/** Alive (unexpired, unsaved) quick matches one visitor key may hold. */
export const QUICK_MATCH_MAX_ALIVE_PER_VISITOR = 5;
/** Days without activity before an unsaved quick match expires. */
export const QUICK_MATCH_EXPIRY_DAYS = 7;
/** Hours before expiry that the reminder email goes out. */
export const QUICK_MATCH_REMINDER_HOURS_BEFORE = 24;
/** The competition's `ends_on`, this many days after it is created. */
export const QUICK_MATCH_ENDS_ON_DAYS = 365;
