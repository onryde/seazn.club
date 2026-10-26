// The email outbox's closed vocabularies (spec docs/superpowers/specs/2026-10-19-email-outbox-design.md,
// "The row" and "Statuses"). Pure declarations: no I/O, no imports, so the core, the kind hooks and the tests
// can all read them without a cycle.
//
// The same two lists are typed again as CHECK constraints: the statuses in db/migration/deltas/V470__email_outbox.sql, the kinds
// (as last redefined) in V474__email_outbox_phase3_wave3.sql. They are two copies of one fact, so outbox-schema.test.ts reads the
// constraint definitions back from the catalogue and requires them to name exactly these members.

export const OUTBOX_KINDS = [
  "magic_link",
  "chess_invite",
  "registration_confirmation",
  "payment_reminder",
  "registration_promoted",
  "refund_issued",
  "solo_signup_assigned",
  // Phase 3 wave 2, in the spec's table order.
  "registration_dispute_alert",
  "registration_dispute_lost",
  "sponsor_invoice",
  "sponsor_receipt",
  "sponsor_refund",
  "sponsor_dispute_alert",
  "sponsor_dispute_won",
  "sponsor_dispute_lost",
  "pass_revoked",
  "trial_ending",
  // Phase 3 wave 3, in the spec's table order.
  "email_verification",
  "funnel_claim",
  "email_change_confirmation",
  "email_change_notice",
  "account_deletion",
  "org_invite",
  "claim_invite",
  "official_invite",
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/**
 * What each kind IS, as the phase-3 spec's kind table declares it (docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md):
 *  - `to` (the spec's legend A, L, S): `account` is an account, resolved at send so a changed or deleted account is followed
 *    (spec §6); `literal` is a literal address, sent as it stands; `staff` is `STAFF_ALERT_EMAIL`.
 *  - `transactional`: whether the mail ignores the marketing suppression list. Each kind keeps its sender's flag from before it
 *    joined the outbox: the sign-in link, the chess invite, the trial-ending notice and seven of wave 3's eight account and invite
 *    mails are transactional; the registration, refund, dispute, sponsor and pass mails, and the org invite (`sendInviteEmail`
 *    passed no flag), are not.
 *
 * A declaration, like the lists above: pure data for the core, the writers and the tests to read.
 */
export const OUTBOX_KIND_FACTS: Readonly<Record<OutboxKind, { to: "account" | "literal" | "staff"; transactional: boolean }>> = {
  magic_link: { to: "literal", transactional: true },
  chess_invite: { to: "account", transactional: true },
  registration_confirmation: { to: "literal", transactional: false },
  payment_reminder: { to: "literal", transactional: false },
  registration_promoted: { to: "literal", transactional: false },
  refund_issued: { to: "literal", transactional: false },
  solo_signup_assigned: { to: "literal", transactional: false },
  registration_dispute_alert: { to: "account", transactional: false },
  registration_dispute_lost: { to: "account", transactional: false },
  sponsor_invoice: { to: "literal", transactional: false },
  sponsor_receipt: { to: "literal", transactional: false },
  sponsor_refund: { to: "literal", transactional: false },
  sponsor_dispute_alert: { to: "account", transactional: false },
  sponsor_dispute_won: { to: "account", transactional: false },
  sponsor_dispute_lost: { to: "account", transactional: false },
  pass_revoked: { to: "account", transactional: false },
  trial_ending: { to: "account", transactional: true },
  email_verification: { to: "literal", transactional: true },
  funnel_claim: { to: "literal", transactional: true },
  email_change_confirmation: { to: "literal", transactional: true },
  email_change_notice: { to: "literal", transactional: true },
  account_deletion: { to: "literal", transactional: true },
  org_invite: { to: "literal", transactional: false },
  claim_invite: { to: "literal", transactional: true },
  official_invite: { to: "literal", transactional: true },
};

/** Mail ABOUT an account that is addressed to a literal address (phase-3 D5, wave 3): its verification and its email change. These kinds
 *  name no account (`recipient_user_id` is null), so deleting the account finds them by their ref, `user / <the account>`
 *  (account-deletion.ts `accountMail`). The deletion notice is not among them: it is written after the deletion's sweep, to tell the
 *  person it happened. */
export const ACCOUNT_MAIL_KINDS: readonly OutboxKind[] = ["email_verification", "email_change_confirmation", "email_change_notice"];

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

/** Kept between a row's `expires_at` and the end of Resend's key life: a lease that lapses just before the last allowed
 *  moment is noticed by the slowest tick (`STG_TICK_MS`), and its re-send still lands inside the key's life. At least one
 *  lease; the tick cadence is added so the whole "crash, wait out the lease, wait for the next tick" fits. */
export const EXPIRY_MARGIN_MS = LEASE_MS + STG_TICK_MS;

/** The furthest out a row's `expires_at` may be at enqueue time (I1, Task 4 review). A row is claimable until its
 *  `expires_at`, and the worker re-sends an ambiguous row under the SAME key; if a row could outlive the key, that re-send
 *  could mail twice. `enqueueEmail` refuses anything further out, so the guarantee holds by construction instead of by
 *  every caller remembering it. The two phase-1 kinds sit far inside it: a sign-in link lives 15 min, a chess invite until
 *  its board's check-in deadline. */
export const MAX_EXPIRY_MS = RESEND_IDEMPOTENCY_TTL_MS - EXPIRY_MARGIN_MS;

/** The name of the Resend message tag that carries a row's id (`{ outbox: <row id> }`). The sender attaches it (attempt.ts) and
 *  the webhook reads it (provider-events.ts) to find a row whose 2xx never recorded Resend's message id: one fact, two
 *  modules, so it is typed once here. */
export const OUTBOX_TAG_NAME = "outbox";

/** The Resend `Idempotency-Key` for a row: the same row always sends under the same key, so an overlapping retry and a
 *  slow first attempt produce one email (spec "Goals", "Never twice"). */
export const idempotencyKey = (id: string): string => `email-outbox/${id}`;

// ---------------------------------------------------------------------------
// The retry worker's tick (spec "The retry worker"): bounded work per tick, paced for Resend's rate limit.
// ---------------------------------------------------------------------------

/** Rows one tick claims at most. At a few hundred emails a day this is a ceiling, not a throughput target; what is
 *  left over is reached by the next tick. */
export const WORKER_BATCH_SIZE = 20;

/** Resend's rate limit: 2 requests a second. */
export const RESEND_REQUESTS_PER_SECOND = 2;

/** The shortest gap between two requests that stays inside that limit. */
export const RESEND_MIN_INTERVAL_MS = 1000 / RESEND_REQUESTS_PER_SECOND;

/** Added to Resend's floor so the pacing is never AT the limit: a timer that fires a few ms early, a request that starts
 *  late, or a clock step cannot push two requests inside one 500 ms window (M1, Task 4 review). */
export const PACING_HEADROOM_MS = 100;

/** At least this long between the start of one attempt and the next one: Resend's floor plus headroom (600 ms). */
export const MIN_SEND_INTERVAL_MS = RESEND_MIN_INTERVAL_MS + PACING_HEADROOM_MS;

/**
 * How long `dispatchNow` (the in-request first attempts a route runs right after its transaction commits) keeps claiming
 * rows, measured from the start of the call; once it has elapsed, every id not yet claimed stays `queued` with `attempts`
 * untouched (exactly what the first-429 stop leaves) and the worker sends it, paced.
 *
 * Why 10 s: the sends are paced at `MIN_SEND_INTERVAL_MS` (600 ms, inside Resend's 2 requests a second), so a call can
 * make ceil(10 000 / 600) = 17 attempts in it. That answers a normal club round in the request (a chess round is two
 * seats a board, so 8 boards, on one address per seat) while bounding what pacing can add to the organiser's wait for the
 * answer: the paced waits stop at 10 s, plus at most one request still in flight (`SEND_TIMEOUT_MS`, 15 s, only when
 * Resend hangs; a healthy send is a few hundred ms). A bigger round is not lost: its tail reads `retrying` in the
 * response and the worker (every minute in production, 20 rows a tick at the same pacing) sends it. The FIRST attempt of
 * a call is never held back by this budget: a single-row call (the sign-in link) behaves exactly as it did before pacing.
 */
export const DISPATCH_NOW_BUDGET_MS = 10_000;

/** A row's `created_at` is the START of the transaction that wrote it (`now()`), and `dispatchNow` begins only after that transaction
 *  has committed: a big round's write can run this long first. An allowance, not a measurement (final review M2). */
export const DISPATCH_NOW_TX_ALLOWANCE_MS = 5_000;

/**
 * How long past `DISPATCH_NOW_BUDGET_MS` a request's `dispatchNow` can still be working on a row it claimed: the last claim is made
 * just inside the budget and its request runs to `SEND_TIMEOUT_MS`; and the write transaction before it (`DISPATCH_NOW_TX_ALLOWANCE_MS`).
 */
export const DISPATCH_NOW_MARGIN_MS = SEND_TIMEOUT_MS + DISPATCH_NOW_TX_ALLOWANCE_MS;

/**
 * The first-attempt window (final review M2): a `queued` row that has never been attempted (`attempts = 0`) and is younger than this
 * belongs to the request that wrote it - its `dispatchNow` is still sending the round, paced - so the worker leaves it alone. Without
 * it a tick that lands mid-round sends the same round at the same time, and the two loops together exceed Resend's 2 requests a
 * second and each stop at the first 429. Only never-attempted rows wait: a retry (`attempts > 0`) and a `sending` row whose lease
 * lapsed are the worker's from the moment they are due. A row whose `dispatchNow` died (or deferred it past the budget) is sent by
 * the first tick after the window.
 */
export const FIRST_ATTEMPT_WINDOW_MS = DISPATCH_NOW_BUDGET_MS + DISPATCH_NOW_MARGIN_MS;

/** A tick stops claiming once it has run this long less the hook reserve (`HOOK_RESERVE_MS`); the hooks may run to this
 *  mark. Under prod's 60 s cadence, and (with one more pacing wait and one
 *  more request, `SEND_TIMEOUT_MS`) under the cron Worker's 60 s per-job timeout, which route.test.ts derives. */
export const TICK_BUDGET_MS = 40_000;

/** The share of the tick budget kept back for the kind hooks and the re-drive (hook starvation, Task 4 review): the SEND
 *  loop stops at `budget * (1 - HOOK_RESERVE_FRACTION)`, so a send backlog (or a slow Resend) can never use the whole tick
 *  and defer every hook for ever. A fraction and not a fixed time, so an injected shorter budget keeps the proportion. */
export const HOOK_RESERVE_FRACTION = 0.25;

/** The reserve at the default budget (10 s of 40 s): the sends are over by `TICK_BUDGET_MS - HOOK_RESERVE_MS`, hooks may
 *  run to `TICK_BUDGET_MS`. */
export const HOOK_RESERVE_MS = TICK_BUDGET_MS * HOOK_RESERVE_FRACTION;

/**
 * The elapsed time after which the send loop claims nothing more (N1, Task 4 re-review). A claim just under it can still
 * wait out one pacing interval and then run a request to its timeout, so the cut-off is the send share of the budget
 * (the budget less the hook reserve) LESS `MIN_SEND_INTERVAL_MS` and `SEND_TIMEOUT_MS`: the last attempt ends inside the
 * send share, and the reserve is whole. One formula, for the injected budgets of the tests and for the default.
 */
export const claimCutoffMs = (budgetMs: number): number =>
  budgetMs * (1 - HOOK_RESERVE_FRACTION) - SEND_TIMEOUT_MS - MIN_SEND_INTERVAL_MS;

/** `claimCutoffMs` at the default budget: 40 s less the 10 s reserve, the 15 s timeout and the 0.6 s pacing = 14.4 s. */
export const CLAIM_CUTOFF_MS = claimCutoffMs(TICK_BUDGET_MS);

/** Rows each of the worker's two ending statements (expire, exhaust) ends at most in one tick (M2, Task 4 review). Every
 *  ended row costs a kind hook afterwards, so an unbounded statement after an outage would turn one tick into minutes of
 *  hooks. The oldest go first and the rest drain over the next ticks. */
export const ENDING_BATCH_SIZE = 100;

/** Badly-ended rows a tick re-drives at most (a kind's `findUnapplied`): a backlog drains over several ticks. */
export const REDRIVE_LIMIT = 50;

// ---------------------------------------------------------------------------
// Retention (spec "Credentials at rest" / the 90-day purge, Task 8).
// ---------------------------------------------------------------------------

/** A row older than this (by `created_at`) is deleted by the worker's last step, whatever its status. By then the body is long
 *  gone (a CHECK nulls it when a row stops being retryable) and the row is only history: the arbiter's status column reads the
 *  newest rows of a live round, which are days old, not months. */
export const RETENTION_DAYS = 90;

/** Rows one purge call deletes at most (one bounded statement per tick: a backlog, after a long outage of the worker, drains over
 *  the next ticks instead of making one tick a long delete). */
export const PURGE_BATCH = 500;
