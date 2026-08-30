// Registration hub — Registrants tab pure derivations (RS005 W2a/W2b): the
// status-pill style map, "is any filter active" (which of the two empty
// states to show), the CSV export href builder, and (W2b) the row-expand
// detail's own pure derivations — the consent chip style map, the
// payment-state word, and the answers label lookup. Pure and
// dependency-light (no React, no i18n, no DB) so every boundary is
// unit-testable without a component render or a database — same convention
// as registration-hub-row-derive.ts/registration-hub-status.ts for the
// Settings tab.
import type { RegistrationListRow } from "@/server/usecases/registrations";
import type { RegistrationFormField } from "@/server/api-v1/schemas";
import type { RegistrantsFilters, ConsentStatus } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import { isTerminalRegistrationStatus } from "@/lib/registration-status";

/** Keyed by `Record<..., string>` against the REAL status union (not a
 *  hand-copied string literal list) so a missing entry is a compile error,
 *  not just a runtime gap — RS005 W1a's own history is that a `rejected`
 *  status was missed from a hand-kept list twice before W1b made
 *  `RegistrationStatus.options` the single source; this file has the same
 *  drift shape and gets the same guard, doubled by a completeness test
 *  (registration-hub-registrant-derive.test.ts) that iterates the real
 *  enum rather than trusting a count. */
export const REGISTRANT_STATUS_STYLE: Record<RegistrationListRow["status"], string> = {
  pending: "bg-amber-100 text-amber-700",
  paid: "bg-blue-100 text-blue-700",
  confirmed: "bg-green-100 text-green-700",
  waitlisted: "bg-purple-100 text-purple-700",
  withdrawn: "bg-slate-100 text-slate-500",
  expired: "bg-slate-100 text-slate-500",
  rejected: "bg-red-100 text-red-700",
};

/** Whether any filter NARROWS the row set — sort is deliberately excluded,
 *  it only orders. Drives which of the two empty states renders (task 5):
 *  zero rows with no active filter reads "no registrations at all" (RS004's
 *  designed empty panel, pointing at Settings/the register link); zero rows
 *  WITH one or more active reads "filters matched nothing" (a clear-filters
 *  affordance) instead. Reads off the SANITIZED filters
 *  (`fetchRegistrantRows`'s returned `.filters`, never the raw query
 *  string), so a dropped malformed value (an unknown status, a
 *  cross-competition division_id) never counts as "active" here either —
 *  it was ignored, so as far as this decision is concerned it was never
 *  there. */
export function hasActiveFilters(filters: RegistrantsFilters): boolean {
  return (
    filters.status !== null ||
    filters.divisionId !== null ||
    filters.kind !== null ||
    filters.freeAgent ||
    filters.consentPending ||
    filters.text !== ""
  );
}

/** The API's own query param names/convention (registration-list-query.ts,
 *  on this wave's do-not-touch list, read only) — `division_id`/`q`/1-0
 *  booleans — so the export always matches what `fetchRegistrantRows` sent
 *  `listRegistrations` to build what's on screen. `sort` is ALWAYS included,
 *  even at the default, so the exported rows are ordered exactly like the
 *  visible table regardless of that route's own default. */
function registrantsQueryString(filters: RegistrantsFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.divisionId) params.set("division_id", filters.divisionId);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.freeAgent) params.set("free_agent", "1");
  if (filters.consentPending) params.set("consent_pending", "1");
  if (filters.text) params.set("q", filters.text);
  params.set("sort", filters.sort);
  return params.toString();
}

/** CSV export link — GET /api/v1/competitions/{id}/registrations/export,
 *  read-scope only (the route's own `requireResourceAuth(..., "read")`), so
 *  this renders for a viewer as well as an editor (owner ruling: "CSV
 *  export IS available to a viewer"). A plain href, not a client fetch —
 *  the codebase's established convention for every export button
 *  (documents-menu.tsx's own header comment; officiating-lane.tsx's rota
 *  PDF link is the single-button case this mirrors most closely). */
export function registrantsExportHref(competitionId: string, filters: RegistrantsFilters): string {
  return `/api/v1/competitions/${competitionId}/registrations/export?${registrantsQueryString(filters)}`;
}

// ---------------------------------------------------------------------------
// Row-expand detail (RS005 W2b).
// ---------------------------------------------------------------------------

/** `registration_players.consent_status` (V363 CHECK constraint) — no
 *  shared zod enum exists for the full 3-value set to iterate against (see
 *  the test file's own comment), so this is a hand-kept map like
 *  REGISTRANT_STATUS_STYLE was before RS005 W1b, just for a column that has
 *  no schema of its own to drift out of sync with. */
export const CONSENT_STATUS_STYLE: Record<ConsentStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  granted: "bg-green-100 text-green-700",
  guardian: "bg-blue-100 text-blue-700",
};

export type RegistrantPaymentState =
  | "disputed"
  | "refunded"
  | "partiallyRefunded"
  | "waitlisted"
  | "paidOffline"
  | "paid"
  | "awaitingPayment"
  | "free";

/**
 * The detail panel's "payment state" field (task 2) — distinct from
 * `row.status` (shown alongside it): status is the REGISTRATION's lifecycle,
 * this is the MONEY's. A rejected entry that was already paid and refunded
 * reads "Rejected · Refunded"; one that was never charged reads "Rejected ·
 * Awaiting payment" — the pairing is what tells an organiser whether money
 * actually moved, which `status` alone cannot say.
 *
 * Precedence, checked in order: a dispute wins over everything (Stripe has
 * already pulled the money back pending resolution); then refunded/partially
 * refunded; then a WAITLISTED entry reads "waitlisted", never "free" (RS005
 * F2 finding 2, below); then a genuinely zero-fee entry is "free" (never
 * "awaiting payment" — there is nothing to await); then a paid/confirmed
 * status is "paid" or "paidOffline" depending on `payment_intent_id`
 * (RS005 F2 finding 1, below); anything left (an unpaid fee-bearing entry,
 * still pending) is "awaitingPayment".
 *
 * RS005 F2 finding 1: this used to read `offline_marked_paid_at`, which
 * V363/V364 moved onto `registration_groups` — CART-level, shared by every
 * entry in the cart. Marking ONE entry paid (markRegistrationPaidOffline,
 * registrations.ts, stamps that column for the whole cart while confirming
 * only the one entry it was called for) made every OTHER still-pending
 * sibling in the same cart read "Paid offline" too. Fixed by reading
 * `payment_intent_id` instead, gated behind `status` — genuinely per-entry
 * truth:
 * - `status` (paid/confirmed) is THIS row's own column, written by a
 *   `where id = ${reg.id}` update scoped to exactly one entry (materialise/
 *   markRegistrationPaidOffline). Checked FIRST, so a still-pending sibling
 *   always falls through to "awaitingPayment" regardless of what happened
 *   elsewhere in its cart.
 * - `payment_intent_id` IS cart-level (registration_groups), but correctly
 *   so here: a cart pays through Stripe AT MOST ONCE for its full total
 *   (design §3, "one cart pays once" — RegistrationRow's own doc comment),
 *   so its presence/absence is uniform truth for every fee-bearing entry
 *   inside it. Once `status` has already confirmed THIS entry reached
 *   paid/confirmed, a null `payment_intent_id` means that could only have
 *   happened through the offline attestation path (approveRegistration and
 *   markRegistrationPaidOffline both refuse a fee-bearing, still-unpaid,
 *   card-less entry — see deriveRegistrantActionFlags below), never a card
 *   charge.
 *
 * RS005 F2 finding 2: a WAITLISTED entry's `amount_cents` is forced to 0 at
 * submit REGARDLESS of the division's real fee (registration-submit.ts:542,
 * `waitlisted ? 0 : live.fee_cents` — they are never charged at submit; they
 * pay on promotion, which re-snapshots the live fee). Reading that 0 as
 * "free" told an organiser a fee-bearing division's waitlisted entrant owed
 * nothing, right up until promotion re-quoted the real fee. This row alone
 * cannot say what that live fee actually is, so "waitlisted" says only
 * what's actually known: nothing has been charged yet — truthful whether
 * the division's real fee is zero or not.
 */
export function deriveRegistrantPaymentState(
  row: Pick<
    RegistrationListRow,
    "amount_cents" | "refunded_cents" | "disputed_at" | "payment_intent_id" | "status"
  >,
): RegistrantPaymentState {
  if (row.disputed_at !== null) return "disputed";
  if (row.refunded_cents > 0) {
    return row.refunded_cents >= row.amount_cents ? "refunded" : "partiallyRefunded";
  }
  if (row.status === "waitlisted") return "waitlisted";
  if (row.amount_cents === 0) return "free";
  if (row.status !== "paid" && row.status !== "confirmed") return "awaitingPayment";
  return row.payment_intent_id === null ? "paidOffline" : "paid";
}

/** Answers label lookup (task 2): the division's declared form-field LABEL
 *  for a raw answers key, falling back to the key itself when it is not (or
 *  no longer) declared — an organiser reading a bare key like "dietary_reqs"
 *  learns nothing; a division's own form_fields (registration_settings,
 *  V211/RS004) is the only place that mapping lives. */
export function answerLabel(key: string, fields: RegistrationFormField[]): string {
  return fields.find((f) => f.key === key)?.label ?? key;
}

/** The DOM anchor id a row's own `<details>` carries (registration-hub-
 *  registrant-table.tsx) and a cart-sibling link points at (registration-
 *  hub-registrant-detail.tsx) — ONE function shared by both sides, so they
 *  can never drift into two hand-typed `"registrant-" + id` copies. */
export function registrantRowAnchor(registrationId: string): string {
  return `registrant-${registrationId}`;
}

// ---------------------------------------------------------------------------
// Row-expand detail actions (RS005 W3).
// ---------------------------------------------------------------------------

export interface RegistrantActionFlags {
  canApprove: boolean;
  canReject: boolean;
  canWithdraw: boolean;
  canPromote: boolean;
  /** RS005 R1 finding 1's recovery path — see the block comment below. */
  canMarkPaid: boolean;
  /** RS005 R1 second wave finding — see the block comment below. */
  canResend: boolean;
  /** RS007 finding #16 — see the block comment below. */
  canRefund: boolean;
  /** RS009 — a solo sign-up still in the pool can be placed on a team. */
  canAssign: boolean;
  /** RS009 — a placed solo sign-up can be returned to the pool, until the
   *  division starts. Gated on `division_started` rather than shown-and-
   *  refused, for the same reason `canApprove` reads the division's LIVE fee:
   *  a control the server will refuse is worse than no control. */
  canUnassign: boolean;
}

/**
 * Which of the Registrants tab's row-level mutating controls are legal for
 * ONE row, taken literally from the RS005 W3 dispatch's own task-3 rule —
 * never re-derived by hand at a button call site, so this function and the
 * completeness sweep in its test file can't drift apart the way
 * REGISTRANT_STATUS_STYLE's hand-kept status list once did (RS005 W1a).
 *
 * approve: legal ONLY on a `manual`-approval division, ONLY while the entry
 * is still awaiting a decision (`pending`, or `paid` — a division can charge
 * a fee before an organiser has reviewed it) — AND (RS005 R1 finding 1,
 * whole-branch review MAJOR) NOT while `awaitingOfflineFee` below holds.
 * `approveRegistration` (registration-approval.ts:128-133) 422s
 * "Awaiting payment — mark it paid first, or approve once payment arrives"
 * for exactly that case — a manual division's fee-bearing entry, still
 * `pending`, with no payment on file — which is the ORDINARY state of every
 * entry on a paid manual division between submit and payment, not an edge
 * case. That server check reads `settings.fee_cents` (the DIVISION's live
 * fee) and `reg.payment_intent_id`; this pure function only ever sees ONE
 * row, never the division's settings, so it substitutes `row.amount_cents`
 * — THIS entry's OWN quoted fee, frozen at submission (RegistrationRow's own
 * doc comment) — as the fee signal (RS005 R1 dispatch's own instruction:
 * "the row already carries what you need"). RS005 F2 finding 3 (whole-branch
 * review): the two DO diverge, routinely, once an organiser edits the
 * division's fee after this entry already exists — `approveRegistration`'s
 * own check (registration-approval.ts:128) reads `settings.fee_cents` FRESH
 * on every call, never this entry's frozen amount, so it moves the instant
 * the fee changes while this row's own `amount_cents` stays put. The
 * comment that used to stand here claimed the opposite ("does not
 * special-case either") — that was false; the wrong control renders and
 * 422s in EITHER edit direction (fee raised from under a pending entry, or
 * dropped to zero under one). The fix is `row.division_fee_cents`: the read
 * model now carries the DIVISION's live fee alongside the entry, so this
 * function reads exactly the value the server reads and is right on the
 * FIRST render. It briefly inferred the fee from the server's 4xx TEXT
 * instead; that only corrected itself after a failed click, coupled the UI
 * to error prose no test pins, and made two unrelated fixtures reword
 * themselves to avoid colliding with the match.
 * `row.payment_intent_id` is exact, not a proxy: it is the SAME cart-level
 * column `reg.payment_intent_id` resolves to server-side. Deliberately does
 * NOT also exclude an already-refunded 'paid' row the way `approveRegistration`
 * itself additionally does: the dispatch's own legality rule stops at
 * "pending, or paid on a manual division" (plus this wave's awaiting-payment
 * carve-out), and that narrower server-side refusal is exactly what the
 * 4xx-revert path (RegistrationHubRegistrantActions) exists to surface
 * instead of silently pre-empting here.
 *
 * reject: legal on the SAME awaiting-decision window as approve, but
 * deliberately WITHOUT the awaiting-payment exclusion —
 * `rejectRegistration` (registration-approval.ts:174-218) carries no such
 * check. An organiser can always decline a still-undecided entry outright,
 * whether or not a fee has arrived: declining before ever collecting money
 * is exactly the point, and gating reject the same way approve is gated
 * would remove a capability the server still grants.
 *
 * canMarkPaid: `markRegistrationPaidOffline`'s own rule (registrations.ts,
 * the checks at ~3102-3114) — status must still be `pending` ("Only pending
 * registrations can be marked paid" refuses every other status, including
 * `paid`), no `payment_intent_id` on file (a card payment refunds on the
 * payments trail instead), and a real fee owed (same `amount_cents` proxy
 * as approve's gate, same reasoning above). Identical to
 * `awaitingOfflineFee` below BY CONSTRUCTION, not coincidence: whenever an
 * offline fee is still owed on a still-pending row, approve is illegal and
 * markPaid is the only forward move — the two can never both be true for
 * the same row (see the "mutually exclusive" test). Deliberately carries NO
 * approval-mode check — the usecase itself has none: an organiser's
 * explicit mark-paid confirms the entry on a MANUAL division exactly as it
 * does on an AUTO one (registrations.test.ts: "...still confirm on a MANUAL
 * division — an organiser's explicit action IS the approval"), so gating
 * this control on `approval === "manual"` would leave the identical dead
 * end this wave fixes standing on every AUTO-approval, offline-fee division
 * instead.
 *
 * withdraw: legal for any NON-terminal status — an organiser can withdraw a
 * still-live entry regardless of its approval mode or review state.
 *
 * canResend: legal for any NON-terminal status — the SAME rule as withdraw,
 * sharing the SAME source (`isTerminalRegistrationStatus`,
 * @/lib/registration-status — dependency-free, so this client island can
 * import it without dragging registrations.ts's Stripe/email clients into
 * the bundle) rather than a second hand-kept list. RS005 R1 second-wave
 * finding: observed live, a WITHDRAWN entry rendered Resend and the send
 * succeeded — the mail is cart-shaped, so it told someone who had pulled
 * out that they were still registered and re-stated their cart's siblings
 * alongside it. `resendRegistrationConfirmation` (registrations.ts:1071)
 * now refuses the same three statuses server-side
 * (`isTerminalRegistrationStatus`) — this is the button-level courtesy, not
 * the enforcement boundary.
 *
 * promote: legal ONLY for a `waitlisted` entry — every other status has
 * nothing to promote FROM.
 *
 * canRefund (RS007 finding #16): mirrors `refundRegistration`'s own two
 * refusals (registrations.ts) exactly — "No payment to refund" when there is
 * no `payment_intent_id`, and "Already fully refunded" when
 * `amount_cents - refunded_cents <= 0`. Deliberately NOT gated on status:
 * the usecase is not either, and the case that matters most is a WITHDRAWN
 * entry — past `refund_lock_at`, `withdrawCore` refuses to auto-refund and
 * the registrant is told at that moment that "any refund is at the
 * organiser's discretion" (`confirm.cancelEntry.bodyDiscretion`). Hiding the
 * control on terminal statuses would leave exactly that promise unkeepable,
 * which is the gap this flag exists to close.
 *
 * Also deliberately NOT gated on the refund LOCK. Before the lock a
 * withdrawal refunds automatically and `refunded_cents` catches up, so the
 * flag falls false on its own; the lock is the boundary for what happens
 * AUTOMATICALLY, never a ceiling on what an organiser may choose to do. This
 * row does not carry the division's `refund_lock_at` in any case.
 */
export function deriveRegistrantActionFlags(
  row: Pick<
    RegistrationListRow,
    | "status"
    | "approval"
    | "amount_cents"
    | "refunded_cents"
    | "payment_intent_id"
    | "division_fee_cents"
    | "free_agent"
    | "assigned_team_id"
    | "division_started"
  >,
): RegistrantActionFlags {
  const awaitingManualDecision =
    row.approval === "manual" && (row.status === "pending" || row.status === "paid");
  // The DIVISION's live fee, which is exactly what both server gates read —
  // `approveRegistration` refuses while a fee is outstanding and
  // `markRegistrationPaidOffline` refuses when the division has none. The
  // entry's own `amount_cents` is the amount quoted at SUBMIT and stops
  // agreeing the moment an organiser edits the fee, because
  // putRegistrationSettings never re-quotes existing entries.
  //
  // This replaces an earlier correction that inferred the fee by matching
  // English substrings of the server's 4xx text ("mark it paid first" / "no
  // entry fee"). That worked only AFTER a failed click, coupled the UI to
  // error prose no test pins, and forced two unrelated test fixtures to be
  // reworded because their text collided with the match. Reading the same
  // value the server reads is correct on the FIRST render and cannot drift.
  const feeOwed = row.division_fee_cents > 0;
  const awaitingOfflineFee = row.status === "pending" && feeOwed && row.payment_intent_id === null;
  const nonTerminal = !isTerminalRegistrationStatus(row.status);
  return {
    canApprove: awaitingManualDecision && !awaitingOfflineFee,
    canReject: awaitingManualDecision,
    canWithdraw: nonTerminal,
    canPromote: row.status === "waitlisted",
    canMarkPaid: awaitingOfflineFee,
    canResend: nonTerminal,
    canRefund: row.payment_intent_id !== null && row.amount_cents - row.refunded_cents > 0,
    // A solo sign-up (an entry with no roster of its own) is the only kind of
    // row that can be placed on a team. `assigned_team_id` is derived from
    // the roster row pointing back at this entry, so these two flags are
    // mutually exclusive by construction and cannot both be true.
    // `waitlisted` is not terminal, so `nonTerminal` alone would offer Assign
    // on an entry that holds no capacity spot and was charged nothing — the
    // server refuses it, and a control the server refuses is worse than no
    // control (the same rule canApprove follows for the division's live fee).
    // Only a confirmed or paid entry may be seated — a pending one has not
    // paid, and assign is not a payment path. Mirrors assignSoloSignUp's own
    // refusal so the control is never offered where the server refuses.
    canAssign:
      row.free_agent &&
      row.assigned_team_id === null &&
      nonTerminal &&
      (row.status === "confirmed" || row.status === "paid"),
    canUnassign: row.free_agent && row.assigned_team_id !== null && !row.division_started,
  };
}
