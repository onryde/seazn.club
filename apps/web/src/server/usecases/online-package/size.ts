import "server-only";
// server/usecases/online-package/size.ts — the package half of the division SAVE (create, and patch): choosing or changing an
// unpaid size, writing the unpaid row when online play turns on, and refunding or deleting it when online play turns off (spec
// 2026-11-23-online-chess-credits-design.md §7.1, §7.3, §7.4 item 2, §7.6; P14, P17).
//
// The save runs as the tenant role inside `withTenant`, and the package table is write-sealed, so the work comes in withTenant's
// three phases, one function each (§7.3: "the checks run in the tenant callback, under the division lock the prelude took"):
//   1. `prepareOnlineSave`  — PRELUDE (privileged): the `division:` lock, the stored online state, and, when the save turns online
//                             play off, the package plan (`planPackageDelete`, which takes the money lock when there is money).
//   2. `decideOnlineSize`   — TENANT CALLBACK: what size the save writes, if any, every refusal judged here (`assertSizeFits`).
//   3. `applyOnlineSave`    — EPILOGUE (privileged): write the unpaid row (`writeOnlineSize`), or refund / delete the package
//                             (`applyPackageDelete`), committing or rolling back with the division's own writes.
//
//  * P14: a division turning online opens at the smallest size that holds the places it holds (16 for none), computed ONCE, when
//    the row is written; a request may name a size instead, and then it must fit (`assertSizeFits`). The default is never refused:
//    it is unpaid, the rounds door and the round-1 payment gate police the rounds (§7.6), and an API caller that sends no size
//    (every caller before the size select ships) must still be able to turn online play on.
//  * A re-send of a stored 'lichess' with no size (every Entrants and format save re-sends the whole config) writes NOTHING.
//  * A size on a PAID row changes only through the payment (`payOnlinePackage`: money moves either way), and a FROZEN row never
//    changes: this door refuses both, unless the size asked is the one the row already has (a re-send).
//  * Switching online play off is never flag-gated and never refused for money: paid → refunded, unpaid → deleted, frozen → left.
//    Switching it on again writes a fresh unpaid row at the default; the earlier choice is not remembered (§7.1).
import type { Tx } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { ONLINE_PACKAGE_CODES, sizeFor, type OnlineSize } from "@/lib/online-chess-package";
import { countOnlineHeld, lockDivisionForCap } from "@/server/external-play/online-entrant-cap";
import { divisionPlaysOnline } from "@/server/external-play/online-play";
import { formatNotSupported, roundsAboveMax, roundsNeedSize } from "./format";
import { clampCapacity } from "./pay";
import { refusalFor, readPackageFacts } from "./quote";
import { livePackage } from "./read";
import { applyPackageDelete, planPackageDelete, type PackageDeletePlan, type RefundResult } from "./refund";
import type { PackageFacts } from "./types";

/** The refusals of the size door, each the leaf's code (plan Global Constraints), judged in the quote's ONE order (`refusalFor`):
 *  - below the places held: 422 ONLINE_SIZE_FULL { size, nextSize }, `nextSize` the smallest size that holds them;
 *  - above what the plan allows (P17): the plan's own 402 (`entrants.per_division.max`), as every entrant cap answers it;
 *  - more Swiss rounds than any size includes (P10): 422 ONLINE_ROUNDS_ABOVE_MAX;
 *  - more Swiss rounds than this size includes (P1, P15): 422 ONLINE_ROUNDS_NEED_SIZE { nextSize }, the smallest size that does. */
export function assertSizeFits(size: OnlineSize, facts: PackageFacts): void {
  const refusal = refusalFor(size, facts, false);
  if (refusal === null) return;
  if (refusal === "below_held") {
    throw new HttpError(
      422,
      `This division holds ${facts.held} places, more than an Online Chess size of ${size} holds`,
      ONLINE_PACKAGE_CODES.sizeFull,
      { size, nextSize: sizeFor(facts.held) },
    );
  }
  if (refusal === "plan") throw new PaymentRequiredError("entrants.per_division.max", { size, planCap: facts.planCap });
  if (refusal === "rounds_above_max") throw roundsAboveMax(facts.rounds);
  if (refusal === "rounds") throw roundsNeedSize(size, facts.rounds);
  // `frozen` is judged by the door from the row, never here (`refusalFor` is asked with frozen = false).
  throw new HttpError(500, `Online Chess size ${size}: unexpected refusal ${refusal}`, "online_size_refusal_unknown");
}

/** What the prelude read and decided, handed to the callback and the epilogue. `storedOnline`: the division plays online as
 *  stored, before this save. `plan`: the package plan, made only when the save turns online play off. `liveSize`: the size of the
 *  live package as it stood before this save (null: none, or the division did not play online), so the caller, after the commit,
 *  can tell a size that moved UP and promote the waitlist into the new room (P18, registrations/promote-into-room.ts). */
export type OnlineSavePrelude = { storedOnline: boolean; plan: PackageDeletePlan | null; liveSize: OnlineSize | null };

/** PRELUDE of a save that names online play or a size: the `division:` lock first (the lock every money writer and format writer
 *  of the division takes; re-entrant, so the camera gate taking it too never waits), then the stored state, read under it and
 *  scoped to the org (a division of another org reads as not online, and the tenant callback 404s it). When the save turns online
 *  play off a division that plays online, the package plan, which takes the org money lock when there is money to return. */
export async function prepareOnlineSave(ptx: Tx, a: { orgId: string; divisionId: string; turnsOff: boolean }): Promise<OnlineSavePrelude> {
  await lockDivisionForCap(ptx, a.divisionId);
  const [d] = await ptx<{ sport_key: string; config: unknown }[]>`
    select sport_key, config from divisions where id = ${a.divisionId} and org_id = ${a.orgId}`;
  const storedOnline = d !== undefined && divisionPlaysOnline(d);
  const plan = storedOnline && a.turnsOff ? await planPackageDelete(ptx, { orgId: a.orgId, divisionIds: [a.divisionId] }) : null;
  const liveSize = storedOnline ? ((await livePackage(ptx, a.divisionId))?.size ?? null) : null;
  return { storedOnline, plan, liveSize };
}

/** TENANT CALLBACK: the size this save writes, or null for none. `onlineBefore` is the prelude's stored state (false for a new
 *  division), `onlineAfter` what the save leaves, `requested` the size the request named, `planCap` the plan's per-division cap
 *  read before the transaction (needed only when a size is requested). Under the division lock; reads as app_user.
 *    - not online after the save: no size; a requested one is 422 ONLINE_FORMAT_NOT_SUPPORTED;
 *    - turning on with no live row: the requested size (which must fit), else P14's default, sizeFor(places held);
 *    - otherwise only a requested size that differs from the live row's moves it: an unpaid row (must fit), never a paid one
 *      (409 `online_size_paid`) or a frozen one (409 `online_size_frozen`); no live row at all (an online division the
 *      migration should have given one): the requested size, which must fit. */
export async function decideOnlineSize(
  tx: Tx,
  a: { divisionId: string; onlineBefore: boolean; onlineAfter: boolean; requested?: OnlineSize; planCap: number | null },
): Promise<OnlineSize | null> {
  if (!a.onlineAfter) {
    if (a.requested !== undefined) throw formatNotSupported(null); // the pay door's own refusal of a division not online
    return null;
  }
  const live = await livePackage(tx, a.divisionId);
  if (!a.onlineBefore && live === null) {
    if (a.requested === undefined) {
      const held = await countOnlineHeld(tx, a.divisionId);
      const size = sizeFor(held);
      // "Cannot happen": the online switch refuses a division holding more than 256 before this runs (assertOnlinePlayFits).
      if (size === null) throw new HttpError(500, `An online division holding ${held} places has no Online Chess size`, "online_size_none");
      return size;
    }
    assertSizeFits(a.requested, await readPackageFacts(tx, a.divisionId, a.planCap));
    return a.requested;
  }
  if (a.requested === undefined) return null;
  if (live !== null) {
    if (live.size === a.requested) return null;
    if (live.frozenAt !== null) {
      throw new HttpError(409, "A round of this division has opened: its Online Chess size can no longer change", "online_size_frozen", { size: live.size });
    }
    if (live.paidAt !== null) {
      throw new HttpError(409, "This division's Online Chess size is paid for: change it through the payment, which moves the credits", "online_size_paid", { size: live.size });
    }
  }
  assertSizeFits(a.requested, await readPackageFacts(tx, a.divisionId, a.planCap));
  return a.requested;
}

/** EPILOGUE helper: the division's unpaid row at `size` — a new one when it has no live row, else its size moved — then a stored
 *  registration capacity above the size lowered to it (§7.4 item 2, the payment's own clamp). The row must be unpaid and unfrozen:
 *  the callback refused anything else, so meeting one here is a named 500 that rolls the save back. The name is snapshotted for
 *  the credit history after a delete (§7.1). */
export async function writeOnlineSize(
  etx: Tx, a: { orgId: string; divisionId: string; divisionName: string; size: OnlineSize },
): Promise<{ capacityLoweredTo: number | null }> {
  const live = await livePackage(etx, a.divisionId, { forUpdate: true });
  if (live === null) {
    await etx`
      insert into division_online_packages (org_id, division_id, division_name, size)
      values (${a.orgId}, ${a.divisionId}, ${a.divisionName}, ${a.size})`;
  } else {
    if (live.orgId !== a.orgId.toLowerCase() || live.paidAt !== null || live.frozenAt !== null) {
      throw new HttpError(500, `Online Chess package ${live.id} is not an unpaid package of this organisation; its size was not changed`, "online_package_not_unpaid");
    }
    await etx`update division_online_packages set size = ${a.size}, division_name = ${a.divisionName} where id = ${live.id}`;
  }
  return { capacityLoweredTo: await clampCapacity(etx, a.divisionId, a.size) };
}

/** What a division save did to its Online Chess package, for the save's response (PATCH /divisions/{id} `online`): the capacity
 *  the size write lowered (null when it lowered none, or wrote no size), and what a switch-off's refund gave back by bucket and
 *  gave up (null when the save turned nothing off; all zeros for a switch-off whose row was unpaid or frozen). */
export type OnlineSaveResult = { capacityLoweredTo: number | null; refunded: RefundResult | null };

/** EPILOGUE of the save: the division as written (`division`, the row the callback returned) decides. Online play turned off on a
 *  division that played online → the prelude's plan is applied (refund the paid row, delete the unpaid one, leave a frozen one).
 *  Otherwise a size the callback decided → `writeOnlineSize`. Answers what moved, for the save's response. */
export async function applyOnlineSave(
  etx: Tx,
  a: { orgId: string; division: { id: string; name: string; sport_key: string; config: unknown }; prelude: OnlineSavePrelude; size: OnlineSize | null },
): Promise<OnlineSaveResult> {
  const onlineAfter = divisionPlaysOnline(a.division);
  if (a.prelude.storedOnline && !onlineAfter) {
    // "Cannot happen": online play turns off only through a save that names it off, and the prelude planned for exactly that.
    if (a.prelude.plan === null) {
      throw new HttpError(500, `Division ${a.division.id} stopped playing online without a package plan; nothing was saved`, "online_package_unplanned");
    }
    return { capacityLoweredTo: null, refunded: await applyPackageDelete(etx, a.orgId, a.prelude.plan) };
  }
  if (a.size === null) return { capacityLoweredTo: null, refunded: null };
  if (!onlineAfter) {
    throw new HttpError(500, `Division ${a.division.id} does not play online; its Online Chess size was not written`, "online_size_not_online");
  }
  return { ...(await writeOnlineSize(etx, { orgId: a.orgId, divisionId: a.division.id, divisionName: a.division.name, size: a.size })), refunded: null };
}
