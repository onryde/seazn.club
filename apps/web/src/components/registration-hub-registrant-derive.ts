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
 * refunded; then a zero-fee entry is simply "free" (never "awaiting
 * payment" — there is nothing to await); then an offline mark; then a
 * paid/confirmed status with no offline mark reads as a captured card
 * payment; anything left (an unpaid fee-bearing entry) is "awaitingPayment".
 */
export function deriveRegistrantPaymentState(
  row: Pick<
    RegistrationListRow,
    "amount_cents" | "refunded_cents" | "disputed_at" | "offline_marked_paid_at" | "status"
  >,
): RegistrantPaymentState {
  if (row.disputed_at !== null) return "disputed";
  if (row.refunded_cents > 0) {
    return row.refunded_cents >= row.amount_cents ? "refunded" : "partiallyRefunded";
  }
  if (row.amount_cents === 0) return "free";
  if (row.offline_marked_paid_at !== null) return "paidOffline";
  if (row.status === "paid" || row.status === "confirmed") return "paid";
  return "awaitingPayment";
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
}

/** withdrawn/rejected/expired — a registration in any of these never moves
 *  again (RS005 W3 dispatch's own definition). Read as a Set, not a switch,
 *  so `canWithdraw` below is one membership check rather than a branch per
 *  status that could omit one. */
const TERMINAL_REGISTRANT_STATUSES: ReadonlySet<RegistrationListRow["status"]> = new Set([
  "withdrawn",
  "rejected",
  "expired",
]);

/**
 * Which of the Registrants tab's row-level mutating controls are legal for
 * ONE row, taken literally from the RS005 W3 dispatch's own task-3 rule —
 * never re-derived by hand at a button call site, so this function and the
 * completeness sweep in its test file can't drift apart the way
 * REGISTRANT_STATUS_STYLE's hand-kept status list once did (RS005 W1a).
 *
 * approve/reject: legal ONLY on a `manual`-approval division, and ONLY while
 * the entry is still awaiting a decision (`pending`, or `paid` — a division
 * can charge a fee before an organiser has reviewed it). `approveRegistration`/
 * `rejectRegistration` (registration-approval.ts) 422 outside this rule
 * (auto-approval division, or a status past "awaiting decision") — showing
 * the button anyway would hand an organiser a control that cannot work.
 * Deliberately does NOT also exclude an already-refunded 'paid' row the way
 * `approveRegistration` itself additionally does: the dispatch's own
 * legality rule stops at "pending, or paid on a manual division", and that
 * narrower server-side refusal is exactly what this wave's 4xx-revert path
 * (RegistrationHubRegistrantActions) exists to surface instead of silently
 * pre-empting here.
 *
 * withdraw: legal for any NON-terminal status — an organiser can withdraw a
 * still-live entry regardless of its approval mode or review state.
 *
 * promote: legal ONLY for a `waitlisted` entry — every other status has
 * nothing to promote FROM.
 */
export function deriveRegistrantActionFlags(
  row: Pick<RegistrationListRow, "status" | "approval">,
): RegistrantActionFlags {
  const awaitingManualDecision =
    row.approval === "manual" && (row.status === "pending" || row.status === "paid");
  return {
    canApprove: awaitingManualDecision,
    canReject: awaitingManualDecision,
    canWithdraw: !TERMINAL_REGISTRANT_STATUSES.has(row.status),
    canPromote: row.status === "waitlisted",
  };
}
