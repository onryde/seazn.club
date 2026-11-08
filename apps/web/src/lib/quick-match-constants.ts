// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.1-7.2): the fixed ids of the one platform
// system org and system user that hold every guest-created quick match, and the limits the create path enforces itself.
//
// Import-free on purpose: `server/api-v1/schemas/quick-match.ts` imports this file relatively, so nothing here may pull in a module.
// The ids, the slug and the email are written verbatim into the migration that seeds the rows,
// db/migration/deltas/V506__quick_matches.sql (its number is reassigned at merge if main has moved past it); change one
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
/** Extra league matches ("Add a match", the decider, spec C5) one quick match may hold: the `adhoc-<n>` fixtures that
 *  anyone with the home link can add. Bounds anonymous writes (spec §4; plan 2 pre-flight D4). The refusal's copy,
 *  `quickMatch.flash.adhocLimit`, interpolates this number as `{max}`. */
export const QUICK_MATCH_MAX_ADHOC = 10;

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
  /** The create's per-IP limit (QUICK_MATCH_CREATE_LIMIT): the limiter's own 429 carries no code, so the create route
   *  names it here for the setup page's `?e=` (plan 2 T3). */
  RATE_LIMITED: "QUICK_MATCH_RATE_LIMITED",
  /** A create refused or failed with no code of its own to show: a form the schema refuses, a server without
   *  DEVICE_LINK_KEK, an unexpected error. The setup page shows its generic line (plan 2 T3). */
  CREATE_FAILED: "QUICK_MATCH_CREATE_FAILED",
  /** A Score tap on a match whose two sides are not both known yet: a knockout seat waiting for its feeders, or a bye
   *  (`ensureGuestDeviceLink`, device-links.ts, spec C18). The home shows `quickMatch.flash.notReady`. */
  SIDES_UNKNOWN: "QUICK_MATCH_SIDES_UNKNOWN",
  /** A Score tap past the mint limit (DEVICE_LINK_MINT_LIMIT, per quick match): the limiter's own 429 carries no code, so
   *  the Score route names it for the home's `?e=` (plan 2 T6, pre-flight A7). The home shows `quickMatch.flash.linkLimit`. */
  LINK_LIMITED: "QUICK_MATCH_LINK_LIMITED",
  /** A home action naming a match that is not part of this quick match: a fixture of another quick match or org, or a
   *  fixture id that is no uuid (the Score route, plan 2 T6). The home shows `quickMatch.flash.notFound`. */
  NOT_FOUND: "QUICK_MATCH_NOT_FOUND",
  /** A home action refused or failed with no code of its own to show: a finalized or cancelled match (the device link's
   *  code-less 422), a server without DEVICE_LINK_KEK, an unexpected error (plan 2 T6). The home shows its generic line. */
  ACTION_FAILED: "QUICK_MATCH_ACTION_FAILED",
  /** "Add a match" past `QUICK_MATCH_MAX_ADHOC` extra matches (plan 2 Task 8, pre-flight D4). */
  ADHOC_LIMIT: "QUICK_MATCH_ADHOC_LIMIT",
  /** A programmer error, never a guest's refusal (500): a create given an email but no base URL to build the link mail's
   *  link from (`createQuickMatch`, plan 3 Amend T1 [B2]). The create route always passes one, and reports a 5xx as a fault
   *  whatever its code. */
  BASE_URL_MISSING: "QUICK_MATCH_BASE_URL_MISSING",
} as const;
