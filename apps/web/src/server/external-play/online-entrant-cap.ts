import "server-only";
// The hard entrant cap of an ONLINE chess division (owner ruling 2026-11-21): min(the plan's `entrants.per_division.max`,
// ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION), on every plan, for a division that plays online (`divisionPlaysOnline`) and for no other.
// Over-the-board chess and every other sport keep the plan's own cap, untouched.
//
// It is a CAPACITY limit, not a plan upsell, and the two refusals differ for exactly that reason:
//   - a plan cap BELOW the online cap (Community's 64) is the one that binds, and an upgrade does lift it: the plan's own 402
//     answers, with its upgrade copy, as it always did;
//   - a plan cap AT OR ABOVE the online cap (or none: null = unlimited) is not what stops the division, and no plan lifts the
//     online cap: ONLINE_DIVISION_FULL answers - a 422 with its own code, never the plan-limit 402, never upgrade wording.
// The tie goes to the online cap (a plan of exactly 128, an Event Pass's 128): there an upgrade would change nothing.
//
// ONE count answers the online cap at every door (fix round 1, review C1): an entrant that is not withdrawn or disqualified, plus a
// sign-up that holds a spot (`SPOT_HOLDERS`: pending, paid, confirmed) and has not become an entrant yet (entrant_id null, never a solo
// free agent) - `onlineHeldSql`. The first two doors used to count entrants rows (withdrawn included, sign-ups ignored) and the other three counted
// registrations only, so a division fed by both could pass either door at 127 and end at 200. A withdrawn entrant no longer holds a
// place; a sign-up holds one from the moment it is let in; a registration that becomes an entrant is the SAME place (it leaves the
// second term and enters the first), so confirming never grows the count. The plan's own cap keeps its own count, untouched.
//
// The count is judged against min(plan cap, 128) for EVERY division that plays online (re-review N2): where the online cap binds
// (a plan at or above it, or none) its own refusal answers; where a LOWER plan cap does (a size pack's 96) the plan's refusal answers
// - on the same count, so direct adds and sign-ups share one allowance instead of 96 + 96.
//
// A place is not always freed when a registration leaves (re-review N1): an organiser may have withdrawn the entrant from the table
// already and filled the place. So the AUTOMATIC promotions (a withdrawal, an expiry, a lapsed pay window, a rejection) ask the count
// too - `onlineCapHoldsPromotion`, `openOnlineCapGuard` - and serve nobody while the division already holds its cap. A source test
// (online-entrant-cap.test.ts) pins that every automatic site carries the guard.
//
// The doors that ask, each after taking the `division:` advisory lock (so two of them cannot both pass on the last place):
// createEntrants (usecases/entrants.ts; it takes the lock only for a sport that can play online - an arrival into any other division
// never queues on the division lock, W3 T9 review m7), Reinstate (the same file), the public sign-up (registration-submit.ts), the organiser's
// Promote / Confirm / Waive (registrations/waitlist.ts), the one door that makes a division online (usecases/divisions.ts), and - a
// read, no lock - the public places-left count (registrations/settings.ts). The sign-up and the promote take the lock only for a
// division of a sport that can play online, like createEntrants (`sport_key` is fixed at creation). The registration capacity a save may promise
// (registrations/settings.ts) compares a number, not a count.
//
// LOCK ORDER (review I2). Global: `division:` advisory -> row locks (patchDivision's N1 comment). Taken here:
//   createEntrants / Reinstate: `division:` -> entrants/registrations rows;
//   submit:   `division:` for every cart division (sorted ids) -> `registration_settings ... for update` (sorted ids) -> inserts;
//   promote / confirm / waive: the registration's own row (the caller locks it first) -> `division:` -> `registration_settings ... for
//     update`. A registration row before `division:` is the edge materialise's late entry already makes (confirm -> `division:`), so no
//     new edge appears, and no path takes `registration_settings` and THEN waits for `division:` (submit used to, via materialise ->
//     late entry; it now holds `division:` first). The online switch holds `division:` already (a config save takes it first).
//   automatic promotion (withdraw / expiry / lapse / reject): the registration's own row -> `division:` (taken right after that lock, before any
//     entrant row is written, `lockForPromotionCap`) -> entrants rows; it takes no `registration_settings` lock, so no new cycle with submit.
import type postgres from "postgres";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { assertWithinLimit, getLimit } from "@/lib/entitlements";
// The two vocabularies the count below reads, from their dependency-free leaves (usecases/entrants.ts, which owns `DEPARTED_STATUSES`,
// imports THIS module): `DEPARTED_STATUS_KEYS` is the list `DEPARTED_STATUSES` is pinned to (departed-vocabulary-is-single-sourced.test.ts).
import { DEPARTED_STATUS_KEYS } from "@/lib/departed-status-keys";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import {
  ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION,
  ONLINE_DIVISION_FULL,
  ONLINE_PLAY_TOO_MANY_ENTRANTS,
} from "@/lib/online-chess";
import { log } from "@/server/logger";
import { divisionPlaysOnline, supportsOnlinePlay } from "./online-play";

/** Does the ONLINE cap, rather than the plan, decide how many entrants this division holds? True for a division that plays online
 *  when the plan cap is absent (unlimited) or no lower than the online cap. */
export function onlineCapBinds(online: boolean, planCap: number | null): boolean {
  return online && (planCap === null || planCap >= ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION);
}

/** The most entrants the division may hold: the plan's cap, and for an online chess division no more than the online cap.
 *  null = no cap at all (unlimited plan, division not online). */
export function effectiveEntrantCap(online: boolean, planCap: number | null): number | null {
  if (!online) return planCap;
  return planCap === null ? ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION : Math.min(planCap, ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION);
}

/** The refusal of a door that would put an online chess division past its cap: 422 ONLINE_DIVISION_FULL, carrying `limit`. */
export function onlineDivisionFullError(): HttpError {
  return new HttpError(
    422,
    `Online chess divisions hold up to ${ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION} entrants.`,
    ONLINE_DIVISION_FULL,
    { limit: ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION },
  );
}

type Db = postgres.Sql | Tx;

/** The ONE online-cap count, as a SQL scalar: places held in `divisionId` (a SQL fragment - a column reference in a list query, or a
 *  bound id). Live entrants (not departed: `DEPARTED_STATUS_KEYS`) + sign-ups that hold a place (`SPOT_HOLDERS`: pending, paid, confirmed)
 *  and are not entrants yet (`entrant_id` null; never a solo free agent). A confirmed sign-up WITH an entrant is that entrant, counted
 *  once, in the first term; waitlisted / expired / rejected / withdrawn sign-ups hold nothing. */
export function onlineHeldSql(db: Db, divisionId: postgres.PendingQuery<postgres.Row[]>): postgres.PendingQuery<postgres.Row[]> {
  return db`(
    (select count(*)::int from entrants e where e.division_id = ${divisionId} and e.status not in ${db([...DEPARTED_STATUS_KEYS])})
    + (select count(*)::int from registrations r where r.division_id = ${divisionId}
         and r.status in ${db([...SPOT_HOLDERS])} and r.entrant_id is null and r.free_agent = false)
  )`;
}

/** Places held in one division, by the count above. Read inside the door's transaction, after `lockDivisionForCap`. */
export async function countOnlineHeld(db: Db, divisionId: string): Promise<number> {
  const [row] = await db<{ n: number }[]>`select ${onlineHeldSql(db, db`${divisionId}::uuid`)} as n`;
  return row!.n;
}

/** 1 when the entrant is still in the field (not withdrawn or disqualified), else 0: the place it holds in the count above. */
async function liveEntrantCount(tx: Tx, entrantId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from entrants where id = ${entrantId} and status not in ${tx([...DEPARTED_STATUS_KEYS])}`;
  return row!.n;
}

/** The `division:` advisory lock every format writer takes (same key spelling), for a door that is about to count and then write. */
export async function lockDivisionForCap(tx: Tx, divisionId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
}

/** Places an online division can still take under `cap` (the online cap, or a lower plan cap - `effectiveEntrantCap`): never below 0
 *  (a division over its cap, stored before the ruling, reads as full). */
export function onlineRoomLeft(held: number, cap: number = ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION): number {
  return Math.max(0, cap - held);
}

/** The division would hold `wouldBe` places after this write: refuse past the online cap, 422 ONLINE_DIVISION_FULL. */
export function assertOnlineRoom(wouldBe: number): void {
  if (wouldBe > ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION) throw onlineDivisionFullError();
}

/** The entrant door's judgements, from counts the caller read. A division that plays online is judged on `held` (the places it holds):
 *  against the online cap where that binds (a plan cap at or above it, or none), and against the plan's cap where THAT is lower (re-review
 *  N2: 96 added and 96 signed up is 192 places on a plan of 96, and neither count alone says so). The plan's own check on `rows` (every
 *  entrants row, withdrawn included) stays as it was, for every division. The online refusal comes first: at the tie (a plan of exactly
 *  128) no upgrade changes anything. */
export function assertEntrantRoom(
  division: { sport_key: string; config: unknown },
  planCap: number | null,
  counts: { rows: number; held: number },
  adding: number,
): void {
  const online = divisionPlaysOnline(division);
  if (onlineCapBinds(online, planCap)) assertOnlineRoom(counts.held + adding);
  assertWithinLimit(planCap, "entrants.per_division.max", counts.rows + adding);
  if (online) assertWithinLimit(planCap, "entrants.per_division.max", counts.held + adding);
}

/** `assertEntrantRoom` for createEntrants: reads both counts in the caller's transaction (`held` only for a division that plays online). */
export async function assertEntrantRoomIn(
  tx: Tx,
  divisionId: string,
  division: { sport_key: string; config: unknown },
  planCap: number | null,
  adding: number,
): Promise<void> {
  const held = divisionPlaysOnline(division) ? await countOnlineHeld(tx, divisionId) : 0;
  const [{ n: rows }] = await tx<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`;
  assertEntrantRoom(division, planCap, { rows, held }, adding);
}

/** What a division that plays online and is full says in the log when a registration is confirmed into it past the cap. Never throws:
 *  a confirmation is often a card payment that has already moved (review I3). The cap holds upstream - a sign-up is counted from the
 *  moment it is let in (pending / paid), so confirming it moves its place from one term of the count to the other and never grows it,
 *  and every door that seats a waitlisted one asks first - so a line here means a door was missed. */
export async function logOnlineCapBreach(tx: Tx, divisionId: string): Promise<void> {
  const [division] = await tx<{ sport_key: string; config: unknown }[]>`select sport_key, config from divisions where id = ${divisionId}`;
  if (!division || !divisionPlaysOnline(division)) return;
  const held = await countOnlineHeld(tx, divisionId);
  if (held > ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION) {
    log.error(
      { divisionId, held, limit: ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION },
      "online chess division is over its entrant cap after a registration was confirmed into it",
    );
  }
}

/** What an AUTOMATIC promotion (a withdrawal, an expiry, a lapsed pay window, a rejection) needs to ask the cap: the plan's limit, which is
 *  an entitlement read and so cannot be made inside a transaction (a pooled connection is pinned for its whole callback). `undefined`
 *  for a division of a sport that can never play online - nothing to ask, no lock to take. */
export type OnlineCapGuard = { readonly planLimit: number | null };

/** Opened out of the transaction, like the seat gate beside it (`openPromotionSeatGate`). */
export async function openOnlineCapGuard(divisionId: string): Promise<OnlineCapGuard | undefined> {
  const [d] = await sql<{ org_id: string; competition_id: string; sport_key: string }[]>`
    select org_id, competition_id, sport_key from divisions where id = ${divisionId}`;
  if (!d || !supportsOnlinePlay(d.sport_key)) return undefined;
  return { planLimit: await getLimit(d.org_id, "entrants.per_division.max", d.competition_id) };
}

/** Take the division lock a promotion will need, EARLY: right after the caller's registration row lock and before any entrant row
 *  is written, so the order is registration row -> `division:` -> entrants (the edge materialise's late entry already makes), never
 *  an entrant row and then `division:` against a Reinstate going the other way. A no-op without a guard. */
export async function lockForPromotionCap(tx: Tx, divisionId: string, guard: OnlineCapGuard | undefined): Promise<void> {
  if (guard) await lockDivisionForCap(tx, divisionId);
}

/** Re-review N1: does an online division ALREADY hold its cap, so that an automatic promotion must not fill a place that is not there?
 *  A place can be freed twice - an organiser withdraws an entrant from the table (the registration is untouched) and the registrant
 *  then withdraws too - so "a registration left" is not "a place was freed". The truth is the count (`countOnlineHeld`, read under the
 *  `division:` lock) against `min(plan cap, 128)`: at or over it the promotion is skipped and the entry stays waitlisted, to be picked
 *  by the next place that really frees. A division that does not play online (config read under the lock) never holds anything back. */
export async function onlineCapHoldsPromotion(
  tx: Tx,
  divisionId: string,
  guard: OnlineCapGuard | undefined,
  leavingEntrantId: string | null = null,
): Promise<boolean> {
  if (!guard) return false;
  await lockDivisionForCap(tx, divisionId); // re-entrant: a no-op when the caller took it early
  const [division] = await tx<{ sport_key: string; config: unknown }[]>`select sport_key, config from divisions where id = ${divisionId}`;
  if (!division || !divisionPlaysOnline(division)) return false;
  const cap = effectiveEntrantCap(true, guard.planLimit)!;
  // The place that is LEAVING is not held (fix round 3): after Start a withdrawal's entrant leaves through the table withdrawal, run
  // after this transaction commits, so it is still live while the promotion is decided - count it and a started division at its cap
  // would never serve its waitlist. Excluded only while it IS live: an entrant already gone (an organiser withdrew it from the table
  // and filled the place) is not counted to begin with, so subtracting it again would free the place twice.
  const leaving = leavingEntrantId === null ? 0 : await liveEntrantCount(tx, leavingEntrantId);
  const held = (await countOnlineHeld(tx, divisionId)) - leaving;
  if (held < cap) return false;
  log.warn({ divisionId, held, cap }, "registrations: waitlist promotion held - the online division already holds its cap");
  return true;
}

/** The door that turns online play ON: a division already holding more places (`held`: the count above) than an online chess division may is refused, 422
 *  ONLINE_PLAY_TOO_MANY_ENTRANTS (`limit`, `entrants`). Its own code and sentence: the organiser's way out is removing entrants,
 *  which "full" would not say. */
export function assertOnlinePlayFits(entrants: number): void {
  if (entrants > ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION) {
    throw new HttpError(
      422,
      `This division has ${entrants} entrants and sign-ups, and online chess divisions hold up to ${ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION}. Remove some before turning online play on.`,
      ONLINE_PLAY_TOO_MANY_ENTRANTS,
      { limit: ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION, entrants },
    );
  }
}
