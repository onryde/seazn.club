import "server-only";
// server/usecases/online-package/read.ts — reading a division's Online Chess package (spec 2026-11-23-online-chess-credits-design.md
// §7.1, §7.3). The row is written only on the privileged pool and READ by both: the money writers lock it, the cap doors and
// the rules strip read it as app_user under V549's org-scoped policy.
import type { sql, Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isOnlineSize } from "@/lib/online-chess-package";
import type { PackageRow } from "./types";

interface RawPackageRow {
  id: string;
  org_id: string;
  division_id: string | null;
  division_name: string;
  size: number;
  cameras_paid: boolean | null;
  credits_paid: number;
  credits_refunded: number;
  credits_forfeited: number;
  paid_at: Date | null;
  paid_by: string | null;
  frozen_at: Date | null;
  refunded_at: Date | null;
  created_at: Date;
}

/** The division's LIVE package: its one row with `refunded_at` null (V549's partial unique index holds at most one), paid,
 *  unpaid or frozen alike; null when it has none (online play off, never chosen, or only refunded history).
 *  `forUpdate` locks the row until the caller's transaction ends: the third lock of spec §7.3 (after the `division:` lock and
 *  the org money lock), so it needs the privileged pool — app_user holds SELECT only, and `for update` needs UPDATE.
 *  As app_user the read policy scopes it to the current org: another org's division reads as none.
 *  The size is ASSERTED on the ladder before the row leaves here (V549's CHECK guarantees it; the assertion is the guard
 *  that keeps a corrupt row from being priced at all). */
export async function livePackage(db: Tx | typeof sql, divisionId: string, opts: { forUpdate?: boolean } = {}): Promise<PackageRow | null> {
  const [r] = await db<RawPackageRow[]>`
    select id, org_id, division_id, division_name, size, cameras_paid, credits_paid, credits_refunded, credits_forfeited,
           paid_at, paid_by, frozen_at, refunded_at, created_at
      from division_online_packages
     where division_id = ${divisionId} and refunded_at is null
     ${opts.forUpdate ? db`for update` : db``}`;
  if (!r) return null;
  if (!isOnlineSize(r.size)) {
    throw new HttpError(500, `Online Chess package ${r.id} holds size ${r.size}, which is not on the ladder; refusing to price it`, "online_package_size_invalid");
  }
  return {
    id: r.id,
    orgId: r.org_id,
    divisionId: r.division_id,
    divisionName: r.division_name,
    size: r.size,
    camerasPaid: r.cameras_paid,
    creditsPaid: r.credits_paid,
    creditsRefunded: r.credits_refunded,
    creditsForfeited: r.credits_forfeited,
    paidAt: r.paid_at,
    paidBy: r.paid_by,
    frozenAt: r.frozen_at,
    refundedAt: r.refunded_at,
    createdAt: r.created_at,
  };
}
