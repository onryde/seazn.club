// The email outbox's closed vocabularies (spec docs/superpowers/specs/2026-10-19-email-outbox-design.md,
// "The row" and "Statuses"). Pure declarations: no I/O, no imports, so the core, the kind hooks and the tests
// can all read them without a cycle.
//
// The same two lists are typed again as CHECK constraints in db/migration/deltas/V469__email_outbox.sql. They
// are two copies of one fact, so outbox-schema.test.ts reads the constraint definitions back from the catalogue
// and requires them to name exactly these members.

export const OUTBOX_KINDS = ["magic_link", "chess_invite"] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** Spec order: the happy path first (`queued` -> `sending` -> `sent` -> `delivered`, `delayed` between `sent` and
 *  `delivered`), then the other terminal states. Twelve members; the spec's "Statuses" paragraph is the authority. */
export const OUTBOX_STATUSES = [
  "queued",
  "sending",
  "sent",
  "delayed",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
  "expired",
  "dead",
  "replaced",
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** The only statuses that may hold `body_sealed`: the body is a live credential, so it is nulled the moment a row
 *  can no longer be retried (CHECK `email_outbox_body_only_while_retryable`). */
export const RETRYABLE_STATUSES: readonly OutboxStatus[] = ["queued", "sending"];

/** Non-terminal: a newer row for the same kind + ref + recipient supersedes these (the replace trigger). */
export const REPLACEABLE_STATUSES: readonly OutboxStatus[] = ["queued", "sending", "sent", "delayed"];

/** Rows that can still put a working email in the recipient's inbox. */
export const LIVE_STATUSES: readonly OutboxStatus[] = ["queued", "sending", "sent", "delayed", "delivered"];

/** Terminal states in which the email did not (or can no longer) arrive. `replaced` is not among them: a replaced
 *  row was superseded by a newer one, which carries the outcome. */
export const ENDED_BADLY_STATUSES: readonly OutboxStatus[] = [
  "bounced",
  "complained",
  "failed",
  "suppressed",
  "expired",
  "dead",
];

// ---------------------------------------------------------------------------
// The send schedule (spec "Goals", "Sending"). Typed here once; every bound that depends on it is derived in
// classify.test.ts, so a change to a number moves the bound with it.
// ---------------------------------------------------------------------------

/** Wait after attempt n before attempt n + 1: 1 min, 5 min, 15 min, 1 h, 6 h (spec "Goals"). */
export const RETRY_DELAYS_MS: readonly number[] = [1, 5, 15, 60, 360].map((minutes) => minutes * 60_000);

/** Attempts in all: the first, plus one per delay. After the last the row is `dead`. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Abort one request to Resend after this long (reported as a network failure, so the row retries). */
export const SEND_TIMEOUT_MS = 15_000;

/** How long a claimed row stays `sending` before the worker may take it again (a crashed attempt becomes due). */
export const LEASE_MS = 2 * 60_000;

/** Resend honours an Idempotency-Key for 24 h; a retry past that could mail twice. */
export const RESEND_IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

/** The slowest worker cadence (stg, owner ruling 2026-10-20): a retry is picked up at most this late. */
export const STG_TICK_MS = 5 * 60_000;

/** The Resend `Idempotency-Key` for a row: the same row always sends under the same key, so an overlapping retry and a
 *  slow first attempt produce one email (spec "Goals", "Never twice"). */
export const idempotencyKey = (id: string): string => `email-outbox/${id}`;
