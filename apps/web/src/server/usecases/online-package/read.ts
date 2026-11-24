import "server-only";
// server/usecases/online-package/read.ts — reading a division's Online Chess package (spec 2026-11-23-online-chess-credits-design.md
// §7.1, §7.3). The row is written only on the privileged pool and READ by both: the money writers lock it, the cap doors and
// the rules strip read it as app_user under V556's org-scoped policy. Also the two facts a division's stages decide, which
// the quote and the doors price a size against: whether its cameras are paid for (P9) and how many Swiss rounds it has (P15).
import type { sql, Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isOnlineSize } from "@/lib/online-chess-package";
import { effectivePolicy, readCameraPolicy } from "@/server/external-play/camera-policy";
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

/** The division's LIVE package: its one row with `refunded_at` null (V556's partial unique index holds at most one), paid,
 *  unpaid or frozen alike; null when it has none (online play off, never chosen, or only refunded history).
 *  `forUpdate` locks the row until the caller's transaction ends: the third lock of spec §7.3 (after the `division:` lock and
 *  the org money lock), so it needs the privileged pool — app_user holds SELECT only, and `for update` needs UPDATE.
 *  As app_user the read policy scopes it to the current org: another org's division reads as none.
 *  The size is ASSERTED on the ladder before the row leaves here (V556's CHECK guarantees it; the assertion is the guard
 *  that keeps a corrupt row from being priced at all). */
export async function livePackage(db: Tx | typeof sql, divisionId: string, opts: { forUpdate?: boolean } = {}): Promise<PackageRow | null> {
  const [r] = await db<RawPackageRow[]>`
    select id, org_id, division_id, division_name, size, cameras_paid, credits_paid, credits_refunded, credits_forfeited,
           paid_at, paid_by, frozen_at, refunded_at, created_at
      from division_online_packages
     where division_id = ${divisionId} and refunded_at is null
     ${opts.forUpdate ? db`for update` : db``}`;
  return r ? toPackageRow(r) : null;
}

/** One package row by its OWN id (spec §7.3: a door that takes a division away addresses its package by the id it read before
 *  the delete, because the delete sets `division_id` to null). Live only (`refunded_at` null) unless `includeRefunded`, so a
 *  refund can tell "already refunded" from "not there". `forUpdate` is `livePackage`'s third lock, on the privileged pool. */
export async function livePackageById(
  db: Tx | typeof sql, id: string, opts: { forUpdate?: boolean; includeRefunded?: boolean } = {},
): Promise<PackageRow | null> {
  const [r] = await db<RawPackageRow[]>`
    select id, org_id, division_id, division_name, size, cameras_paid, credits_paid, credits_refunded, credits_forfeited,
           paid_at, paid_by, frozen_at, refunded_at, created_at
      from division_online_packages
     where id = ${id} ${opts.includeRefunded ? db`` : db`and refunded_at is null`}
     ${opts.forUpdate ? db`for update` : db``}`;
  return r ? toPackageRow(r) : null;
}

/** A raw row as the doors read it, its size ASSERTED on the ladder first. */
function toPackageRow(r: RawPackageRow): PackageRow {
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

/** Whether the division is "with cameras" for the price (P9, owner decision 13): the EFFECTIVE camera policy of any stage is
 *  `optional` or `required` (an optional camera still spends camera minutes), and a division with no stage yet is judged by
 *  its own effective policy. The policy resolves nearest-level-wins, stage then division then competition (camera-policy.ts
 *  `effectivePolicy`), so a competition on `required` with its division set to `off` is "without", and a division set to
 *  `off` with one stage on `required` is "with". One row per stage; the left join answers a division with no stage as one row
 *  whose stage level is null, which is exactly "no stage: judge the division". A division that does not exist is a 404, never
 *  a quiet `false`: a quote for nothing is a bug upstream. */
export async function derivedCameras(db: Tx | typeof sql, divisionId: string): Promise<boolean> {
  const rows = await db<{ stage: unknown; division: unknown; competition: unknown }[]>`
    select s.camera_policy as stage, d.camera_policy as division, c.camera_policy as competition
      from divisions d
      join competitions c on c.id = d.competition_id
      left join stages s on s.division_id = d.id
     where d.id = ${divisionId}`;
  if (rows.length === 0) throw new HttpError(404, "division not found");
  return rows.some(
    (r) => effectivePolicy({ stage: readCameraPolicy(r.stage), division: readCameraPolicy(r.division), competition: readCameraPolicy(r.competition) }) !== "off",
  );
}

/** The Swiss rounds the division's size must include (P15): the sum of `config.rounds` over its Swiss stages. Knockout,
 *  double elimination, the play-off and the step ladder count nothing (decision 2: their games are always included), and so
 *  does a kind the online switch refuses. A Swiss stage with no usable round count (absent, null, not a whole number, below 1)
 *  counts 0: it plays no round — the stage door refuses to write one (STAGE_SWISS_ROUNDS_REQUIRED) and Generate and Start
 *  refuse to play one (CONFIG_INVALID) — so it costs nothing until a round count is declared, and every door that declares one
 *  re-asks the size (spec §7.6). It is never read as 1, and never as a product default: the round budget is declared up
 *  front, "never derived from field size" (the stage API). `exceptStageId` leaves one stage out: a rounds edit that is not stored yet
 *  adds its new count to the others' (format.ts `assertDivisionRoundsFit`). */
export async function countedRounds(db: Tx | typeof sql, divisionId: string, exceptStageId?: string): Promise<number> {
  const stages = await db<{ rounds: unknown }[]>`
    select config -> 'rounds' as rounds from stages
     where division_id = ${divisionId} and kind = 'swiss' ${exceptStageId === undefined ? db`` : db`and id <> ${exceptStageId}`}`;
  let total = 0;
  for (const s of stages) {
    if (typeof s.rounds === "number" && Number.isInteger(s.rounds) && s.rounds >= 1) total += s.rounds;
  }
  return total;
}
