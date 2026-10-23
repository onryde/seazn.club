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
