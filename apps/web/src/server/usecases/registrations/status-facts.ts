import "server-only";
// What the /register/status page states beyond the cart's own rows (see ./index.ts): the one venue a competition's published
// fixtures share, and how each entry's fee was settled. Registration redesign B4 T14 (spec §5.2, §5.3); read once per page by
// `buildGroupStatusView` (group-status.ts).
//
// THE CONTRACT T15 RENDERS (register/status/view-model.ts: whatHappensNext, cartMoneySummary), all on the views group-status.ts
// returns:
//
//   GroupStatusView.competition_starts_on  string | null   competitions.starts_on as 'YYYY-MM-DD' (a `date`; lib/db.ts keeps
//                                                          dates as plain strings, never a timestamp). null = no date set.
//   GroupStatusView.competition_ends_on    string | null   competitions.ends_on, same shape. May EQUAL starts_on (a one-day
//                                                          event): "runs {start} to {end}" only when the two differ.
//   GroupStatusView.venue_name             string | null   non-null ONLY when every fixture that names a venue, in a division
//                                                          whose schedule is published (`status <> 'setup'`), names the same one
//                                                          (`competitionVenueName`). null with no fixtures, with two or more
//                                                          venues, and while every placed division is still a draft.
//   GroupEntryView.settled_by              SettledBy | null how THIS entry's fee was settled (`settledBy`): "card" (a Stripe
//                                                          checkout took it), "offline" (the organiser's Mark paid), "waived"
//                                                          (Confirm without payment). null = nothing settled it: unpaid,
//                                                          waitlisted, or a free entry the organiser confirmed.
//
// Invariants T15 relies on:
//   - settled_by is HISTORY, never status: it outlives a refund and a withdrawal. What was sent back is the entry's own
//     `refunded_cents` (paid = amount_cents − refunded_cents, floored at 0, for "card" and "offline" only).
//   - "waived" is neither paid nor due. A waiver confirms the entry WITHOUT touching its `amount_cents` (organiser-actions.ts,
//     spec FP11), so a status- or amount-based sum shows a comped entry as "Paid £15.00".
//   - The organiser's own Confirm is an approval, never a settlement, even when its event says `paid: true` (see `settlementOf`).

import { sql } from "@/lib/db";

/** How an entry's fee was settled. See the contract above. */
export type SettledBy = "card" | "offline" | "waived";

/** One `competition_events` row of the settlement family, as written for one registration. */
export interface SettlementEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** The event types any settle path writes for a registration. The ONE list (B4 review m4): pay-page.ts's "paid on" date reads it
 *  too, so a new settle path's event type is added here once. Not every row of these types settles anything: `settlementOf`
 *  decides. */
export const SETTLEMENT_EVENT_TYPES = [
  "registration.confirmed",
  "registration.paid_awaiting_approval",
  "registration.offline_paid",
  "registration.fee_waived",
] as const;

/** What ONE event says about the money, pinned against each writer:
 *
 *  - `registration.fee_waived` {registration_id, fee_cents}: confirmRegistrationWaived → waived.
 *  - `registration.offline_paid` {registration_id, amount_cents[, awaiting_approval]}: markRegistrationPaidOffline → offline.
 *  - `registration.paid_awaiting_approval` {registration_id, amount_cents}: the card webhook on a manual division
 *    (confirmPaidRegistration, checkout-completion.ts), its only writer → card.
 *  - `registration.confirmed` has TWO writers. The card webhook's {registration_id, entrant_id, paid: true, amount_cents}
 *    (confirmPaidRegistration) → card. The organiser's Confirm {registration_id, paid} (confirmRegistration,
 *    organiser-actions.ts) → null: an approval. Its `paid: true` means an EARLIER event took the money (a card payment or Mark
 *    paid awaiting approval), so it cannot tell card from cash. The webhook's payload names an amount and the organiser's never
 *    has (both shapes unchanged since PROMPT-20a), so the amount is what tells them apart. */
export function settlementOf(e: SettlementEvent): SettledBy | null {
  switch (e.type) {
    case "registration.fee_waived":
      return "waived";
    case "registration.offline_paid":
      return "offline";
    case "registration.paid_awaiting_approval":
      return "card";
    case "registration.confirmed":
      return "amount_cents" in e.payload ? "card" : null;
    default:
      return null;
  }
}

/** The LATEST settling event wins; `events` are one registration's, oldest first. An event that settles nothing (the organiser's
 *  approval) is skipped, never read as the answer. Empty → null. */
export function settledBy(events: readonly SettlementEvent[]): SettledBy | null {
  let answer: SettledBy | null = null;
  for (const e of events) answer = settlementOf(e) ?? answer;
  return answer;
}

/** How each of `registrationIds` settled, keyed by registration id; an entry nothing settled is absent. One read for the whole
 *  cart, scoped to the cart's competition (every event of the family is written against the entry's own competition). */
export async function settlementsByRegistration(
  competitionId: string,
  registrationIds: readonly string[],
): Promise<Map<string, SettledBy>> {
  const out = new Map<string, SettledBy>();
  // No empty-cart guard: postgres.js renders `sql([])` as `in (null)`, which matches nothing (a guard here was an untestable
  // skipped query, mutation M8).
  const rows = await sql<(SettlementEvent & { registration_id: string })[]>`
    select payload->>'registration_id' as registration_id, type, payload
    from competition_events
    where competition_id = ${competitionId}
      and type in ${sql(SETTLEMENT_EVENT_TYPES as unknown as string[])}
      and payload->>'registration_id' in ${sql(registrationIds as string[])}
    order by created_at, id`;
  const byRegistration = new Map<string, SettlementEvent[]>();
  for (const r of rows) {
    const list = byRegistration.get(r.registration_id) ?? [];
    list.push({ type: r.type, payload: r.payload });
    byRegistration.set(r.registration_id, list);
  }
  for (const [id, events] of byRegistration) {
    const how = settledBy(events);
    if (how !== null) out.set(id, how);
  }
  return out;
}

/** A venue line only when exactly one venue is named (spec §5.2, FP1); the read stops at two. */
export function onlyVenue(names: readonly string[]): string | null {
  return names.length === 1 ? names[0]! : null;
}

/** The one venue every placed fixture of the competition shares, or null. `competitions` has no venue (FP1): a fixture names
 *  one (`fixtures.venue_id`, V374, written from its court at schedule apply). Fixtures carry no `competition_id` (V214), hence
 *  the join through divisions. A division still in `setup` is an unpublished schedule: the public site hides its venue
 *  (public_fixtures_v, withCourtVenueNames), so it never names one here. A fixture with no venue yet is not a second venue. */
export async function competitionVenueName(competitionId: string): Promise<string | null> {
  const rows = await sql<{ name: string }[]>`
    select distinct v.name
    from fixtures f
    join divisions d on d.id = f.division_id
    join venues v on v.id = f.venue_id
    where d.competition_id = ${competitionId}
      and d.status <> 'setup'
    limit 2`;
  return onlyVenue(rows.map((r) => r.name));
}
