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
/** C16: two sides is always a league; a knockout needs three. The create refuses a smaller one (FORMAT_NOT_OFFERED), the
 *  preview table holds none, and the setup screen hides its format row below it. */
export const QUICK_MATCH_KNOCKOUT_MIN_SIDES = QUICK_MATCH_MIN_SIDES + 1;
/** The match name's and a side name's longest, in UTF-16 units after trimming. `CreateQuickMatch` REFUSES a longer one,
 *  never clips it (E1), and the setup inputs carry the same bound so the browser stops it first. */
export const QUICK_MATCH_NAME_MAX = 80;
export const QUICK_MATCH_SIDE_NAME_MAX = 60;
/** The setup inputs' `pattern` for the match name and each side name: at least one non-space character. The schema TRIMS,
 *  so a leading or trailing space is fine and only an all-space name is refused; this lets the browser say so first
 *  (branch review A M2), where `required` alone passes "   ". */
export const QUICK_MATCH_NON_BLANK_PATTERN = ".*\\S.*";
/** The email input's `pattern`: zod 4's own `.email()` regex (what `CreateQuickMatch` checks), respelled to compile under the
 *  `v` flag HTML patterns use (zod's bare `-` in a class is a syntax error there), and anchored by the browser. The
 *  browser's own `type="email"` check passes `ravi@gmail`; this stops it, and the other addresses the schema refuses, before
 *  the post (branch review A I2). The setup form's test proves it agrees with the schema on a counted table. */
export const QUICK_MATCH_EMAIL_PATTERN = "(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+\\-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}";
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
  /** A guest's Score tap on a quick match past its expiry (`ensureGuestDeviceLink`, device-links.ts). Never a flash: the
   *  Score route lands it on the bare home, the dead screen (plan 2 T6 review m1). */
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
  /** "Add a match" past `QUICK_MATCH_MAX_ADHOC` extra matches (plan 2 Task 8, pre-flight D4). The home shows
   *  `quickMatch.flash.adhocLimit` with the cap as `{max}`. */
  ADHOC_LIMIT: "QUICK_MATCH_ADHOC_LIMIT",
  /** "Add a match" naming the same side twice (plan 2 Task 8): the home shows `quickMatch.flash.sameSide`. */
  SAME_SIDE: "QUICK_MATCH_SAME_SIDE",
  /** "Add a match" posted for a knockout (spec C5: a knockout has a winner by construction and takes no extra match; plan 2
   *  Task 8). The home never draws the control there, so only a crafted post meets it: `quickMatch.flash.leagueOnly`. */
  LEAGUE_ONLY: "QUICK_MATCH_LEAGUE_ONLY",
  /** A programmer error, never a guest's refusal (500): a create given an email but no base URL to build the link mail's
   *  link from (`createQuickMatch`, plan 3 Amend T1 [B2]). The create route always passes one, and reports a 5xx as a fault
   *  whatever its code. */
  BASE_URL_MISSING: "QUICK_MATCH_BASE_URL_MISSING",
  /** NOT a refusal (branch review B m3, controller ruling 2026-11-08): the create MADE the match but sent no link mail, because
   *  the per-IP mail bucket or the per-inbox one refused, or the limiter is down (both fail closed). The address is not stored.
   *  The route lands on the new home with `?e=` this code, and the home prints `quickMatch.flash.emailLimited` as information,
   *  never as an error: the link is right there to share or bookmark. */
  EMAIL_LIMITED: "QUICK_MATCH_EMAIL_LIMITED",
  /** The form's only fault is its email address, which `CreateQuickMatch`'s zod `.email()` refused (branch review A I2). The
   *  setup screen shows `quickMatch.errors.emailInvalid`, keeping what was typed. */
  EMAIL_INVALID: "QUICK_MATCH_EMAIL_INVALID",
  /** The create's Cloudflare Turnstile check refused (owner 2026-11-12: "yes we need turnstile"): no token (a post without the
   *  script carries none), a token Cloudflare refuses, or Cloudflare unreachable, which fails closed. The guest's refusal,
   *  never a fault: the setup screen shows #1136's shared `turnstile.error`, keeping what was typed. */
  TURNSTILE_FAILED: "QUICK_MATCH_TURNSTILE_FAILED",
} as const;
