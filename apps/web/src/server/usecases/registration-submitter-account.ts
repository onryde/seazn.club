import type postgres from "postgres";
import type { Tx } from "@/lib/db";

// WHO THE SUBMITTER'S OWN ROW BELONGS TO, when the row itself does not say.
//
// `deriveLinkUserId` (registrations.ts) ties a self-registered player's `registration_players.user_id` to the signed-in account only for an
// adult WITH a date of birth, so the submitter of a division that does not ask for one has an untied row - yet they ARE the account that
// submitted the cart (`registration_groups.user_id`, written once at submit and never changed), and the submit asked THAT session's Lichess
// link before it accepted the entry. Two doors need the same answer and must not be able to disagree about it:
//
//   the seat   (`materialise`)   resolves the row's person BY the account, so the board - which reads a link by the person's account - finds it;
//   the gate   (online-seat-gate.ts)   reads that account's link to decide whether the seat would be refused.
//
// This module is the one statement of which row that is. `registering_self` is not stored, so it is inferred from what only the submitter's
// own row looks like, and every clause is load-bearing (each has its own killer in online-seat-gate-writers.test.ts).

type Db = Tx | postgres.Sql;

/** A `registration_players` row with the account that submitted its cart. */
export interface PlayerAccountRow {
  user_id: string | null;
  /** `registration_groups.user_id`: who was signed in when the cart was submitted. Not tied to a date of birth, as `user_id` is. */
  cart_user: string | null;
  no_dob: boolean;
  guardian_name: string | null;
  source: string;
  /** The row was consented in the very transaction that wrote it: `consent_at` is the transaction's own `now()`, as `created_at` is. */
  at_submit: boolean | null;
}

/** The columns `submitterAccount` reads, for a query that selects from `registration_players rp` joined to `registration_groups g`. */
export const accountColumns = (db: Db) => db`
  rp.user_id, g.user_id as cart_user, (rp.dob is null) as no_dob, rp.guardian_name, rp.source,
  (rp.consent_at = rp.created_at) as at_submit`;

/** The account to resolve a registrant by when their OWN row names none, or null when there is no such account.
 *    - `captain_entered`: not a joiner's own row (`self_joined`), not an organiser's placement;
 *    - consented in the submit's own transaction: a teammate the captain typed in has no consent yet, and one who claimed their spot did
 *      so later, in a transaction of their own - neither is the submitter, and the cart's account is not theirs;
 *    - no date of birth and no guardian: a minor, or an entry made on a guardian's behalf, is untied ON PURPOSE (the account is the
 *      guardian's, not the player's), and an adult with a date of birth who is untied was untied for a reason the row does not show. */
export function submitterAccount(row: PlayerAccountRow): string | null {
  if (row.cart_user === null) return null;
  if (row.source !== "captain_entered") return null;
  if (row.at_submit !== true) return null;
  if (!row.no_dob) return null;
  if (row.guardian_name !== null) return null;
  return row.cart_user;
}

/** The entry's rows that are the submitter's own, by row id -> the cart's account. A caller prefers a row's OWN `user_id` to this
 *  (`row.user_id ?? accounts.get(row.id)`): the cart's account is only what to use when the row names none. */
export async function submitterAccounts(db: Db, registrationId: string): Promise<Map<string, string>> {
  const rows = await db<(PlayerAccountRow & { id: string })[]>`
    select rp.id, ${accountColumns(db)}
      from registration_players rp
      join registrations r on r.id = rp.registration_id
      left join registration_groups g on g.id = r.group_id
     where rp.registration_id = ${registrationId}`;
  return new Map(
    rows.flatMap((r): [string, string][] => {
      const account = submitterAccount(r);
      return account === null ? [] : [[r.id, account]];
    }),
  );
}
