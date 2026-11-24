import "server-only";
// server/usecases/online-package/gate.ts — the payment door at "Open round" (spec 2026-11-23-online-chess-credits-design.md §7.6
// "openRound" and "Pay and open", §8.5; decisions 12 and 15; P8, P18, P20). Asked by `openRound` INSIDE its transaction, under the
// `division:` lock it already holds, only once the open has decided it will open something (a press that opens nothing writes
// nothing, so it must pay nothing), and LAST - after the invites are attached and queued (review m4), so the org money lock this
// takes is held for the payment and the freeze alone, never across the fan-out:
//
//  * A FROZEN row asks nothing. A round of this division has opened before (P8), or the row is the backfill's grandfathered one
//    (frozen, never paid): every later open of every round goes through with nothing asked, whatever the balance and whatever the
//    division has grown into. `quote.covers` is false on a frozen row by design, so the frozen check comes first and the quote is
//    never asked of one.
//  * Otherwise the live package must be PAID and COVER the division as it stands (`quote.covers`: places held, Swiss rounds counted,
//    cameras), or the open is refused 402 ONLINE_CHESS_UNPAID carrying the quote for the STORED size (decision 15: the organiser chose
//    it; it is never silently re-picked) and, when that size is itself refused, the smallest size that would hold the division.
//  * `pay` (the organiser confirmed the receipt that 402 showed): the payment runs FIRST, on this transaction (`payOnlinePackageInTx`:
//    the org money lock, the row lock, the quote under them, the debit), then the cover is asked again of the row it left. The debit,
//    the stamp and the freeze commit together or not at all: a refusal in the open before the gate, in the gate, or at the commit
//    rolls the payment back with the round (and the queued invites with it: they are sent after the commit).
//  * Then the package FREEZES (P8), on the database clock, in a statement V549's CHECK holds: `paid_at` is set before or with
//    `frozen_at` (frozen and unpaid is only ever the backfill's row).
//
// The locks, in the spec's order: the caller's `division:` lock (then the bridge rows its fan-out takes), then the org money lock,
// then the package row `for update`. The
// money facts the transaction cannot read (the plan's monthly rate, the plan's entrant cap) are read by the caller BEFORE it
// (lib/db.ts forbids a pooled read inside one) and passed in as `money`.
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { OpenRoundPayment } from "@/lib/open-round";
import {
  ONLINE_PACKAGE_CODES, ONLINE_SIZES, includedRounds, sizeAllowedByPlan, type OnlineSize,
} from "@/lib/online-chess-package";
import { lockOrg } from "@/server/usecases/stream-credits";
import { formatNotSupported } from "./format";
import { payOnlinePackageInTx, refusedStageKind, type PayInput } from "./pay";
import { quoteLocked, readPackageFacts, type PackageQuote } from "./quote";
import { livePackage } from "./read";
import type { PackageFacts, PackageRow } from "./types";

/** Read by the caller before its transaction: the org's plan rate (`streamMonthlyRate`) and the plan's per-division entrant cap
 *  (`getLimit(..., "entrants.per_division.max", competitionId)`, null = unlimited). */
export type GateMoney = { rate: number; planCap: number | null };

/** What the gate did. `asked` false: the row was frozen and nothing was asked or written. `movedUp`: a payment on this open moved the
 *  size UP (P18: the caller promotes the waitlist after its commit). `payment`: what the press's `pay` did, for the answer (review
 *  m1, m2) - null when no `pay` was sent; `applied` false with 0 credits when it moved nothing (a frozen row ignores it; a row
 *  already paid at that size and camera state is step 1 of the pay door, which returns BEFORE it compares the confirmed total, so
 *  that total is never reported as paid). */
export type GateResult = { asked: boolean; movedUp: boolean; payment: OpenRoundPayment | null };

/** The largest size on the ladder: the most places Online Chess holds in one division. */
const LARGEST: OnlineSize = ONLINE_SIZES[ONLINE_SIZES.length - 1]!;

/** The smallest size that holds the division as it stands (its places, its Swiss rounds) and the plan allows, or null when none
 *  does. Offered beside a refused stored size, never charged: the organiser confirms it with its own receipt. */
function smallestHolding(facts: PackageFacts): OnlineSize | null {
  return ONLINE_SIZES.find((s) => s >= facts.held && includedRounds(s) >= facts.rounds && sizeAllowedByPlan(s, facts.planCap)) ?? null;
}

/** The 402's sentence: what stands between this division and round 1, in the organiser's terms. No size can hold it (places above
 *  the largest size, or more Swiss rounds than any size includes) comes first, because nothing can be bought; then a paid package
 *  the division has outgrown; then the unpaid one. `next` is the size offered beside a refused stored size. */
function unpaidMessage(row: PackageRow, quote: PackageQuote, next: PackageQuote | null): string {
  if (quote.held > LARGEST) {
    return `${quote.held} places are held, more than Online Chess holds in one division (${LARGEST}): ${quote.held - LARGEST} must leave before round 1 can open`;
  }
  if (quote.refusal === "rounds_above_max") {
    return `${quote.rounds} Swiss rounds are more than Online Chess includes in one division (${includedRounds(LARGEST)}): lower the rounds before round 1 can open`;
  }
  const offer = next !== null ? `size ${next.size} costs ${next.owed} more credits` : quote.refusal === null ? `${quote.owed} more credits are needed` : null;
  if (row.paidAt !== null) {
    return `The Online Chess package paid for this division (size ${row.size}) no longer covers it${offer === null ? "" : `: ${offer}`}`;
  }
  if (quote.refusal === null) return `Round 1 needs a paid Online Chess package: size ${quote.size} costs ${quote.owed} credits`;
  return `Round 1 needs a paid Online Chess package, and size ${row.size} no longer holds this division${offer === null ? "" : `: ${offer}`}`;
}

/** The division's live package, under the caller's transaction, asserted present: every online division has one (V549's backfill,
 *  the online switch). None is a bug upstream, a named 500, and never a reason to open a round nobody paid for. */
async function liveOrRefuse(tx: Tx, divisionId: string, forUpdate: boolean): Promise<PackageRow> {
  const row = await livePackage(tx, divisionId, { forUpdate });
  if (row === null) {
    throw new HttpError(500, `Online Chess division ${divisionId} has no live package; the round was not opened`, "online_package_missing");
  }
  return row;
}

/** The first open's gate, on `openRound`'s transaction (the caller holds the `division:` lock). Frozen: nothing asked. Otherwise the
 *  optional payment, then the cover asked of the row as it stands (402 ONLINE_CHESS_UNPAID when it does not cover), then the freeze. */
export async function gateFirstOpen(
  tx: Tx,
  a: { orgId: string; divisionId: string; userId: string; pay?: PayInput },
  money: GateMoney,
): Promise<GateResult> {
  // Frozen is for good (V549: a frozen row is never refunded, and nothing un-freezes one), so an unlocked read under the division
  // lock settles it - and a later open never touches the org money lock.
  const first = await liveOrRefuse(tx, a.divisionId, false);
  if (first.frozenAt !== null) {
    const ignored = a.pay === undefined ? null : { applied: false, credits: 0, size: first.size, capacityLoweredTo: null };
    return { asked: false, movedUp: false, payment: ignored };
  }

  await lockOrg(tx, a.orgId);
  const before = await liveOrRefuse(tx, a.divisionId, true);
  const facts = await readPackageFacts(tx, a.divisionId, money.planCap);
  let movedUp = false;
  let payment: OpenRoundPayment | null = null;
  if (a.pay !== undefined) {
    // The pay door's own gates on a charge, but only the one an open has not already asked: the flag and the billing freeze were
    // asked by `openRound` before its transaction; the stage kinds online play runs (P16) are asked here, under the lock.
    const refusedKind = await refusedStageKind(tx, a.divisionId);
    const paid = await payOnlinePackageInTx(tx, { orgId: a.orgId, divisionId: a.divisionId, userId: a.userId, ...a.pay }, facts, {
      rate: money.rate,
      beforeCharge: () => {
        if (refusedKind !== null) throw formatNotSupported(refusedKind);
      },
    });
    movedUp = paid.applied && paid.package.size > before.size;
    payment = {
      applied: paid.applied,
      // The pay door's quote is the one it acted on: its owed was debited (> 0) or returned (< 0). Not applied, nothing moved.
      credits: paid.applied ? paid.quote.owed : 0,
      size: paid.package.size,
      capacityLoweredTo: paid.capacityLoweredTo,
    };
  }

  const row = await liveOrRefuse(tx, a.divisionId, true);
  const quote = await quoteLocked(tx, { orgId: a.orgId, divisionId: a.divisionId, size: row.size, rate: money.rate }, facts);
  if (!quote.covers) {
    const fits = quote.refusal === null ? null : smallestHolding(facts);
    const next = fits === null || fits === row.size
      ? null
      : await quoteLocked(tx, { orgId: a.orgId, divisionId: a.divisionId, size: fits, rate: money.rate }, facts);
    throw new HttpError(402, unpaidMessage(row, quote, next), ONLINE_PACKAGE_CODES.unpaid, { quote, next });
  }
  await freezeOnlinePackage(tx, row.id);
  return { asked: true, movedUp, payment };
}

/** P8: the package freezes at the first open of any round, on the transaction's clock. Only a PAID, live, not yet frozen row (V549:
 *  frozen and unpaid is the backfill's row alone, and the CHECK refuses any other); exactly that one row, or a named 500 that rolls
 *  the open back. */
export async function freezeOnlinePackage(tx: Tx, packageId: string): Promise<void> {
  const frozen = await tx`
    update division_online_packages set frozen_at = now()
     where id = ${packageId} and frozen_at is null and refunded_at is null and paid_at is not null
    returning id`;
  if (frozen.length !== 1) {
    throw new HttpError(500, `Online Chess package ${packageId} is not a paid, live, unfrozen package; the round was not opened`, "online_package_not_freezable");
  }
}
