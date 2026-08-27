// Pure view-model logic for the registrant status page (RS007 rebuild).
// Zero React, zero DB — every export is a plain function of plain data, so
// the money/roster/link rules that matter most (never dangle a debt with no
// route to settle; cancel must call the PUBLIC write path, never the
// organiser one) are provable without a render.

export type EntryStatus =
  | "pending"
  | "paid"
  | "confirmed"
  | "waitlisted"
  | "withdrawn"
  | "expired"
  | "rejected";

/**
 * This entry's own pay-by deadline: its promotion clock if it was promoted
 * out of the waitlist, else the cart's shared deadline. Two different
 * columns on the server (registrations.promotion_expires_at vs
 * registration_groups.expires_at) because a promotion mints a checkout for
 * ONE entry — see promoteWaitlistedRow's doc comment in registrations.ts —
 * so the cart's shared clock cannot govern it without also moving every
 * sibling's own deadline.
 */
export function effectivePayDeadline(
  entryPromotionExpiresAt: string | null,
  cartExpiresAt: string | null,
): string | null {
  return entryPromotionExpiresAt ?? cartExpiresAt;
}

export type MoneyState =
  | { kind: "none" }
  | { kind: "stripe_due"; deadline: string | null }
  /** A card fee is due but the org's Connect account cannot currently take a
   *  payment — resumeRegistrationCheckout would 503. Its own state rather
   *  than folding into stripe_due so the page never renders a "Pay now"
   *  button that is guaranteed to fail on click. */
  | { kind: "stripe_unavailable" }
  | { kind: "offline_due"; deadline: string | null };

/**
 * What, if anything, this entry currently owes and how to settle it — the
 * single source both the pay control and the offline-instructions panel
 * read, so the two can never disagree about whether money is due right now.
 */
export function resolveMoneyState(
  entry: {
    status: EntryStatus;
    amount_cents: number;
    promotion_expires_at: string | null;
  },
  cart: {
    payment_method: "offline" | "stripe" | null;
    expires_at: string | null;
    charges_enabled: boolean;
  },
): MoneyState {
  const owes = entry.status === "pending" && entry.amount_cents > 0;
  if (!owes) return { kind: "none" };
  const deadline = effectivePayDeadline(entry.promotion_expires_at, cart.expires_at);
  if (cart.payment_method === "stripe") {
    return cart.charges_enabled ? { kind: "stripe_due", deadline } : { kind: "stripe_unavailable" };
  }
  return { kind: "offline_due", deadline };
}

/**
 * Gates the Cancel control. Mirrors withdrawCore's own write-side rules
 * (registrations.ts) rather than the looser `status !== "withdrawn"` some
 * older public reads use: 'rejected' always 422s there ("This registration
 * was rejected and cannot be withdrawn"), and 'expired' already freed its
 * spot with nothing left to cancel — offering the button on either would be
 * exactly the "names an action with no real route" trap the money rules
 * exist to avoid.
 */
export function canCancelEntry(status: EntryStatus): boolean {
  return status !== "withdrawn" && status !== "rejected" && status !== "expired";
}

export interface RosterCounts {
  claimed: number;
  total: number;
}

/** granted/guardian both mean a real person has confirmed the slot; pending
 *  is a captain-entered placeholder still awaiting its own claim. Claiming
 *  flips consent_status in place — it never adds or removes a row — so
 *  `total` is stable across a claim and only `claimed` moves. */
export function rosterCounts(
  players: { consent_status: "pending" | "granted" | "guardian" }[],
): RosterCounts {
  return {
    total: players.length,
    claimed: players.filter((p) => p.consent_status !== "pending").length,
  };
}

/**
 * The captain's claim link. The join PAGE itself is a later wave's build
 * (not this one's), so this only mints the href — using the register/join
 * API's own field names (`join_code`, `player_id`, PublicJoinRequest in
 * schemas.ts) so that page can read the query string with no remapping.
 * Omitting `playerId` is the generic entry-level link (previewJoinEntry/
 * joinTeamEntry's own "no player_id → insert a new player" fallback).
 */
export function claimHref(
  orgSlug: string,
  competitionSlug: string,
  joinCode: string,
  playerId?: string,
): string {
  const qs = new URLSearchParams({ join_code: joinCode });
  if (playerId) qs.set("player_id", playerId);
  return `/shared/${orgSlug}/${competitionSlug}/register/join?${qs.toString()}`;
}

/**
 * Classifies a write-action failure (cancel/pay/resend) by HTTP status alone
 * — never the raw server string — the same "map from HTTP status" contract
 * join-form.tsx's own `classifyJoinFailure` established. This is a SEPARATE
 * classifier from both `classifyJoinFailure` (join/view-model.ts) and
 * `classifySubmitFailure` (register-stepper's submit.ts): neither has a
 * rate-limited bucket (all three of THIS page's write routes now call
 * `publicRateLimit` — `checkout`/`withdraw`/`groups/{id}/resend` route.ts
 * files, verified directly), and 409 does not mean the same thing on every
 * surface either — see `resumeRegistrationCheckout`'s own
 * `REGISTRATION_CHECKOUT_CONFLICT` (a losing compare-and-swap on a
 * concurrent checkout mint — registrations.ts) vs. withdraw/resend, which
 * never emit a 409 at all today (only 404/422/503). One shared function
 * rather than three copies since all three write actions need the exact
 * same four-way split; each caller supplies its own action-specific copy
 * for the reachable buckets via its own `Record<StatusActionFailureKind,
 * string>` (mirrors `FAILURE_KEY` in join-form.tsx).
 *
 * Audit finding this fixes (RS007 follow-up): `err.message` — the server's
 * OWN un-localized English text (`apiV1`, client-v1.ts, reads
 * `payload.error.message` verbatim) — used to be the ONLY thing a public
 * visitor saw on any of these three buttons' failure paths. There is no
 * server-side i18n in this repo (deliberate), so that string can never be
 * the PRIMARY user-facing message on an otherwise fully localized page.
 *
 *  - notFound (404): the token/entryId/groupId no longer resolves — same
 *    "regByToken"/"group not found" shape `register.status.notFound`
 *    already covers for the page's own initial load, so failures here
 *    reuse that exact key rather than mint a near-duplicate.
 *  - conflict (409): a genuine concurrency race — "refresh and try again"
 *    is the honest advice (matches the checkout-mint race's own server
 *    message), never "click the exact same thing again blindly".
 *  - rateLimited (429): `publicRateLimit` tripped — transient, caused by
 *    request VOLUME rather than anything about this request's content.
 *  - generic: everything else (422 content-refused — e.g. "already
 *    rejected, cannot withdraw", "nothing to pay", "cart already
 *    terminal"; 503 Connect-not-live; 5xx; no response at all). These read
 *    fine under one honest "try again, or contact the organiser" fallback
 *    — the raw detail (kept as SECONDARY text, register-stepper's FIX 3
 *    convention — none of these three usecases' thrown messages interpolate
 *    the access token or any other secret, verified by reading
 *    withdrawCore/resumeRegistrationCheckout/resendRegistrationConfirmationPublic
 *    directly) still supplies whatever extra color the classification
 *    can't.
 */
export type StatusActionFailureKind = "notFound" | "conflict" | "rateLimited" | "generic";

export function classifyStatusActionFailure(status: number | undefined): StatusActionFailureKind {
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 429) return "rateLimited";
  return "generic";
}

// ---------------------------------------------------------------------------
// Public write-path URLs. Named constants, not inlined into the client
// components that call them, so the regression test proving "cancel calls
// withdrawRegistrationPublic, never withdrawRegistrationOrganiser" pins the
// SAME string the button actually fetches, not a hand-typed lookalike.
// ---------------------------------------------------------------------------

/** withdrawRegistrationPublic (registrations.ts) — actorId is always null on
 *  this path, unlike /api/v1/registrations/{id}/withdraw
 *  (withdrawRegistrationOrganiser, session-authenticated). The `/public/`
 *  segment is the entire difference and the entire risk. */
export const publicWithdrawPath = (entryId: string): string =>
  `/api/v1/public/registrations/${entryId}/withdraw`;

/** resumeRegistrationCheckout — mints/resumes a Stripe session for exactly
 *  this one entry (works the same for a fresh pending entry or a
 *  waitlist-promoted one). */
export const publicCheckoutPath = (entryId: string): string =>
  `/api/v1/public/registrations/${entryId}/checkout`;

/** resendRegistrationConfirmationPublic — GROUP-scoped (the confirmation
 *  mail is cart-shaped), so this is keyed by rid, not by one entry id. */
export const publicResendPath = (groupId: string): string =>
  `/api/v1/public/registrations/groups/${groupId}/resend`;
