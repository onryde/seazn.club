import "server-only";
// server/usecases/online-package/refund.ts — the full refund of an Online Chess package, and the package half of the doors that
// take a division away: a division delete, a competition delete, online play switched off (spec
// 2026-11-23-online-chess-credits-design.md §7.1, §7.3, §7.4 item 4, §7.5, §7.6, §11; decision 14, P6, P7).
//
//  * A FULL REFUND is only for a paid, unfrozen, unrefunded row (§7.4 item 4). It returns whatever a move down has not already
//    returned: every bought credit, and the included credits debited in the current UTC month (P6); included credits of an
//    earlier month are forfeited (counted, never written). The return is written FIRST (`refundForPackage`, which refuses a
//    refunded or frozen row before any write), then the row in ONE statement (`refunded_at`, `credits_refunded` and
//    `credits_forfeited` together: V560 holds refunded ⇒ refunded + forfeited = paid per statement), then the settle step of a
//    reversed pack (§7.5) on the same transaction. A second call writes nothing. One clock, the database's: no `now` is taken.
//  * A FROZEN row (a round has opened, P7, P8) is never refunded: the doors leave it, and a direct call is refused by name.
//  * THE DOORS (§7.3): the delete and the switch-off run as the tenant role inside `withTenant`; the sealed rows are written in its privileged
//    epilogue, so the refund commits or rolls back WITH the delete. The packages are read and locked in its privileged
//    prelude BEFORE the delete — the delete cascades `division_id` to null (`on delete set null`), so the epilogue
//    addresses each row by the id the prelude read, never by its division. Lock order (§7.3, §11): the `division:` locks in
//    ascending division id, then the org money lock (only when there is money to return), then each package row `for update`.
//    Paid and unfrozen: refunded. Unpaid: the row is DELETED (§7.1: there is no "closed, unpaid" state). Frozen: left as it is.
//    Never flag-gated.
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { OnlineSize } from "@/lib/online-chess-package";
import { lockDivisionForCap } from "@/server/external-play/online-entrant-cap";
import { lockOrg } from "@/server/usecases/stream-credits";
import { refundForPackage } from "./ledger";
import { backFor } from "./quote";
import { livePackage, livePackageById } from "./read";
import { settleReversals } from "./settle";
import type { PackageRow } from "./types";

/** The competition's DIVISIONS lock (review m1). A competition delete reads its divisions in its prelude and plans their packages;
 *  a division created after that read — and paid before the delete's cascade — would go with the competition and leave its paid
 *  package live, orphaned (`division_id` null). A division create holds this lock SHARED from its prelude to its commit (two creates
 *  never wait for each other); the competition delete takes it EXCLUSIVE as its prelude's FIRST statement, so a create either
 *  committed before the delete read the list (its package is in the plan, paid or not, under its `division:` lock) or waits for
 *  the delete and meets no competition (404). Lock order: this, then the `division:` locks, then the org money lock. An advisory
 *  key, never the competition row `for update` (the review's ruling: a row lock here deadlocks). Keyed on the id lower-cased: both
 *  doors take it from a route parameter. */
export const competitionDivisionsLockKey = (competitionId: string): string => `competition-divisions:${competitionId.toLowerCase()}`;
export async function lockCompetitionDivisions(tx: Tx, competitionId: string, mode: "shared" | "exclusive"): Promise<void> {
  const key = competitionDivisionsLockKey(competitionId);
  if (mode === "shared") await tx`select pg_advisory_xact_lock_shared(hashtext(${key}))`;
  else await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
}

/** What the prelude decided for the packages of the divisions a door takes away: the paid, unfrozen rows to refund, and the ids of
 *  the unpaid rows to delete. A frozen row is in neither: it is left alone. */
export type PackageDeletePlan = { refund: PackageRow[]; drop: string[] /* unpaid ids */ };

/** What a refund (or a door's refunds, summed) gave back, by bucket, and gave up (the included credits of an earlier month). */
export type RefundResult = { pack: number; monthly: number; forfeited: number };

/** One package a door refunded, for the analytics (events.ts): what the row was (size, camera price) and what its refund gave back.
 *  Collected by `applyPackageDelete` as it refunds; sent after the door's commit, so a rolled-back refund is never reported. */
export type RefundedPackage = { size: OnlineSize; cameras: boolean; back: RefundResult };

/** The PRELUDE half (privileged, before the role drops): take each division's `division:` lock in ascending id order, read every
 *  LIVE package of those divisions that belongs to `orgId` (paid, unpaid and frozen alike) under those locks, and sort them; then
 *  take the org money lock when one of them holds money to return. Scoped to the org: the prelude runs with the pool's privileges,
 *  so a division id of another org must read as nothing (the tenant callback then 404s it and the transaction rolls back). */
export async function planPackageDelete(ptx: Tx, a: { orgId: string; divisionIds: string[] }): Promise<PackageDeletePlan> {
  // As given (the key every other `division:` locker hashes: the id its route passed), deduplicated and ascending.
  const ids = [...new Set(a.divisionIds)].sort();
  for (const id of ids) await lockDivisionForCap(ptx, id);
  if (ids.length === 0) return { refund: [], drop: [] };
  const live = await ptx<{ id: string }[]>`
    select id from division_online_packages
     where org_id = ${a.orgId} and division_id in ${ptx(ids)} and refunded_at is null
     order by division_id`;
  const plan: PackageDeletePlan = { refund: [], drop: [] };
  for (const { id } of live) {
    const row = (await livePackageById(ptx, id))!;
    if (row.frozenAt !== null) continue; // a round opened: nothing changes (P7)
    if (row.paidAt === null) plan.drop.push(row.id);
    else plan.refund.push(row);
  }
  if (plan.refund.length > 0) await lockOrg(ptx, a.orgId);
  return plan;
}

/** The EPILOGUE half (privileged, after the tenant writes, on the same transaction): refund each planned paid row and delete each
 *  planned unpaid one, by the ids the prelude read. Answers the credits returned and forfeited, summed. A refund that fails throws,
 *  and the whole transaction — the delete with it — rolls back: money first (§7.3). */
export async function applyPackageDelete(
  etx: Tx, orgId: string, plan: PackageDeletePlan, refunded?: RefundedPackage[],
): Promise<RefundResult> {
  const total: RefundResult = { pack: 0, monthly: 0, forfeited: 0 };
  for (const row of plan.refund) {
    if (row.orgId !== orgId.toLowerCase()) {
      throw new HttpError(500, `Online Chess package ${row.id} does not belong to organisation ${orgId}; nothing was refunded`, "online_package_not_of_org");
    }
    const r = await refundOnlinePackageLocked(etx, row);
    // A paid package always holds its size's price in value (V560 and the pay door's books), so a real refund returns or forfeits
    // something: an all-zero answer is `refundOnlinePackageLocked`'s no-op on a row already refunded, which is no event.
    if (refunded !== undefined && r.pack + r.monthly + r.forfeited > 0) refunded.push({ size: row.size, cameras: row.camerasPaid === true, back: r });
    total.pack += r.pack;
    total.monthly += r.monthly;
    total.forfeited += r.forfeited;
  }
  for (const id of plan.drop) {
    // Still unpaid, unfrozen and live under the locks the prelude took: anything else is a writer that changed it on this
    // transaction, a named 500 rather than deleting a row that now records money.
    const gone = await etx`
      delete from division_online_packages
       where id = ${id} and org_id = ${orgId} and paid_at is null and frozen_at is null and refunded_at is null
      returning id`;
    if (gone.length !== 1) {
      throw new HttpError(500, `Online Chess package ${id} was no longer an unpaid package when its division went; nothing was deleted`, "online_package_not_unpaid");
    }
  }
  return total;
}

/** The full refund of ONE package (§7.4 item 4), on the caller's transaction, under the division lock (when the division still
 *  exists) and the org money lock. Re-reads the row by id `for update` (the third lock) and acts on what it finds:
 *  refunded → writes nothing (a second call); frozen → 409 `online_package_frozen` (P7: never refunded); unpaid → 500
 *  `online_package_unpaid` (nothing was paid; the doors delete such a row instead). Otherwise: the return in P21's order
 *  (`backFor`, the quote's own split, which nets the credits a move down already forfeited), the row in one statement, then the
 *  settle step (§7.5). */
export async function refundOnlinePackageLocked(tx: Tx, row: PackageRow): Promise<RefundResult> {
  await lockOrg(tx, row.orgId);
  const now = await livePackageById(tx, row.id, { forUpdate: true, includeRefunded: true });
  if (now === null || now.orgId !== row.orgId.toLowerCase()) {
    throw new HttpError(500, `Online Chess package ${row.id} is not a package of organisation ${row.orgId}; nothing was refunded`, "online_package_not_of_org");
  }
  if (now.refundedAt !== null) return { pack: 0, monthly: 0, forfeited: 0 };
  if (now.frozenAt !== null) {
    throw new HttpError(409, `Online Chess package ${row.id} is frozen (a round has opened); it is never refunded`, "online_package_frozen");
  }
  if (now.paidAt === null) {
    throw new HttpError(500, `Online Chess package ${row.id} was never paid; there is nothing to refund`, "online_package_unpaid");
  }
  const back = await fullRefundOf(tx, now);
  // The return first: it refuses a refunded or frozen row and a return its ledger cannot account for, before any row is written.
  await refundForPackage(tx, { orgId: now.orgId, packageId: now.id, pack: back.pack, monthly: back.monthly, size: now.size });
  const returned = back.pack + back.monthly;
  const written = await tx`
    update division_online_packages
       set refunded_at = now(),
           credits_refunded = credits_refunded + ${returned},
           credits_forfeited = credits_forfeited + ${back.forfeited}
     where id = ${now.id} and paid_at is not null and frozen_at is null and refunded_at is null
    returning id`;
  if (written.length !== 1) {
    throw new HttpError(500, `Online Chess package ${now.id} was frozen or refunded under its refund; nothing was refunded`, "online_package_not_writable");
  }
  await settleReversals(tx, now.orgId);
  return { pack: back.pack, monthly: back.monthly, forfeited: back.forfeited };
}

/** What a FULL refund of `row` gives back and gives up, read now (§7.4 item 4): the row's value net of what a move down already
 *  returned or forfeited, split by `backFor` (the quote's own P21 order: bought credits, then this month's included, and only then
 *  the included credits of an earlier month, which are forfeited). ONE authority for the refund itself and for the figure the
 *  danger zone shows before it (`packageRefundPreview`). The caller has decided the row is paid, unfrozen and unrefunded. */
export async function fullRefundOf(tx: Tx, row: PackageRow): Promise<RefundResult> {
  const value = row.creditsPaid - row.creditsRefunded - row.creditsForfeited;
  return value > 0 ? backFor(tx, row, value) : { pack: 0, monthly: 0, forfeited: 0 };
}

/** What deleting `divisionId` or switching its Online play off would give back NOW (spec §11, review m2): its live package's full
 *  refund (`fullRefundOf`), as the credits that come back and the included credits of an earlier month that do not. Null when no
 *  door would move money: no package (online play off), unpaid (the row is deleted, nothing was paid) or frozen (a round has
 *  opened, P7). Read-only and lock-free: a figure to show before the organiser confirms; the door re-decides under its locks.
 *  The division is the caller's (the page proved it); a package of another org is a named 500, never a figure. */
export async function packageRefundPreview(orgId: string, divisionId: string): Promise<{ back: number; forfeited: number } | null> {
  return sql.begin("read only", async (tx) => {
    const row = await livePackage(tx, divisionId);
    if (row === null || row.paidAt === null || row.frozenAt !== null) return null;
    if (row.orgId !== orgId.toLowerCase()) {
      throw new HttpError(500, `Online Chess package ${row.id} does not belong to organisation ${orgId}; no refund was read`, "online_package_not_of_org");
    }
    const r = await fullRefundOf(tx, row);
    return { back: r.pack + r.monthly, forfeited: r.forfeited };
  }) as Promise<{ back: number; forfeited: number } | null>;
}
