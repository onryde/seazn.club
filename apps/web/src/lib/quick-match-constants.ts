// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.1-7.2): the fixed ids of the one platform
// system org and system user that hold every guest-created quick match, and the limits the create path enforces itself.
//
// Import-free on purpose: `server/api-v1/schemas.ts` imports this file relatively, so nothing here may pull in a module.
// The ids, the slug and the email are written verbatim into the migration that seeds the rows,
// db/migration/deltas/V492__quick_matches.sql (its number is reassigned at merge if main has moved past it); change one
// and you change both. quick-match-migration.test.ts compares the seeded rows with these values.

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

/** Every quick match refusal's code (the third `HttpError` argument). The English message is for logs and API callers;
 *  plan 2 maps the code to copy, so a code a quick match path throws belongs here. quick-match-create.ts re-exports it. */
export const QUICK_MATCH_ERRORS = {
  TOO_MANY_ALIVE: "QUICK_MATCH_TOO_MANY_ALIVE",
  FORMAT_NOT_OFFERED: "QUICK_MATCH_FORMAT_NOT_OFFERED",
  SPORT_NOT_OFFERED: "QUICK_MATCH_SPORT_NOT_OFFERED",
  KIND_NOT_OFFERED: "QUICK_MATCH_KIND_NOT_OFFERED",
  VISITOR_INVALID: "QUICK_MATCH_VISITOR_INVALID",
  /** A guest's Score tap on a quick match past its expiry (`ensureGuestDeviceLink`, device-links.ts). */
  EXPIRED: "QUICK_MATCH_EXPIRED",
} as const;
