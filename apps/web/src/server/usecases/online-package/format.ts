import "server-only";
// server/usecases/online-package/format.ts — what a division's FORMAT, ROUNDS and CAMERAS must stay inside, before round 1, for the
// package it bought (spec 2026-11-23-online-chess-credits-design.md §3 decisions 2, 5, 9, 13; §7.6; P9, P10, P11, P15, P16, P19).
// Three gates, one module, so the doors that ask them share ONE refusal each:
//
//   FORMAT   `assertOnlineFormat(kinds)` — Swiss and knockout only (P16: swiss, knockout, double_elim, page_playoff, stepladder). Asked
//            where a division turns online play on (its stored stages) and where a stage batch is written to an online division
//            (the batch's kinds). Every kind that is not on the leaf's allowed list is refused, americano included, and so is a kind
//            the product adds later: a new format is online-capable only when somebody lists it.
//   ROUNDS   `assertRoundsFit(rounds, row)` — the Swiss rounds the division's stages declare must fit the size's included rounds
//            (P1, P15), while the live row is NOT frozen (a round added mid-event is free, P11). `assertDivisionRoundsFit` reads the
//            row and the counted rounds in the caller's transaction.
//   CAMERAS  `divisionsNeedingCameraUpgrade` / `assertCamerasPaidFor` — a camera policy that turns cameras ON in Division settings is
//            refused for a PAID, unfrozen package that did not pay for them (P9, P19). Turning cameras OFF there is never asked here
//            (and returns nothing: the receipt's "No" is the one door that gives the camera price back, Task 15).
//
// Legacy: online divisions holding a league (or a ladder) exist on staging, and divisions written before these gates hold more
// rounds than their size includes. Every gate asks about the CHANGE a write makes, never about what already stands, so a legacy
// division stays readable and its unrelated saves keep working.
//
// An import-cycle guard: the stage and Swiss modules import THIS module, so it imports only the price leaf, the errors, the cap
// module's lock (which reaches this package's `read.ts` and nothing in `stages/`), and `./read` — never the barrel.
import type { sql, Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  ONLINE_ALLOWED_STAGE_KINDS,
  ONLINE_PACKAGE_CODES,
  includedRounds,
  packagePrice,
  sizeForRounds,
  type OnlineSize,
} from "@/lib/online-chess-package";
import { lockDivisionForCap } from "@/server/external-play/online-entrant-cap";
import { countedRounds, derivedCameras, livePackage } from "./read";
import type { PackageRow } from "./types";

/** 422 ONLINE_FORMAT_NOT_SUPPORTED (plan Global Constraints, carrying `kind`): the division does not play online at all (`kind`
 *  null), or it holds, or is given, a stage kind online play does not allow (P16). */
export function formatNotSupported(kind: string | null): HttpError {
  return new HttpError(
    422,
    kind === null ? "This division does not play online" : `Online Chess does not run a ${kind} stage`,
    ONLINE_PACKAGE_CODES.formatNotSupported,
    { kind },
  );
}

/** 422 ONLINE_ROUNDS_ABOVE_MAX: more Swiss rounds than any size includes (P10). One message for every door that says it, the size
 *  save's (`assertSizeFits`) included. */
export function roundsAboveMax(rounds: number): HttpError {
  return new HttpError(422, `${rounds} Swiss rounds is more than any Online Chess size includes`, ONLINE_PACKAGE_CODES.roundsAboveMax, { rounds });
}

/** 422 ONLINE_ROUNDS_NEED_SIZE { nextSize }: more Swiss rounds than `size` includes; `nextSize` is the smallest size that covers them. */
export function roundsNeedSize(size: OnlineSize, rounds: number): HttpError {
  return new HttpError(
    422,
    `${rounds} Swiss rounds need a larger Online Chess size than ${size}`,
    ONLINE_PACKAGE_CODES.roundsNeedSize,
    { nextSize: sizeForRounds(rounds) },
  );
}

/** One division a camera save would leave unpaid for: the division, its name, and the credits the camera price still owes. */
export type CameraUpgrade = { id: string; name: string; owed: number };

/** 422 ONLINE_CAMERAS_NEED_UPGRADE { divisions }: the Fair-play camera is not paid for on these divisions (all of them, whole). */
export function camerasNeedUpgrade(divisions: readonly CameraUpgrade[]): HttpError {
  return new HttpError(
    422,
    divisions.length === 1
      ? `The Fair-play camera is not paid for on ${divisions[0]!.name}: add it to the package first`
      : `The Fair-play camera is not paid for on ${divisions.length} divisions: add it to their packages first`,
    ONLINE_PACKAGE_CODES.camerasNeedUpgrade,
    { divisions },
  );
}

/** FORMAT: refuses the first of `kinds` (in the order given) that Online Chess does not run. An empty list passes: a write that
 *  names no stage has no format to judge. */
export function assertOnlineFormat(kinds: readonly string[]): void {
  for (const kind of kinds) {
    if (!ONLINE_ALLOWED_STAGE_KINDS.includes(kind)) throw formatNotSupported(kind);
  }
}

/** ROUNDS: `rounds` Swiss rounds against the live row. No row (not online) and a FROZEN row (a round has opened: a round added
 *  mid-event is free, P11) are never asked. Above 10 is ABOVE_MAX whatever the size (P10); above what the row's size includes is
 *  NEED_SIZE with the size that covers them. A paid row is judged exactly like an unpaid one: the size it paid for. */
export function assertRoundsFit(rounds: number, row: PackageRow | null): void {
  if (row === null || row.frozenAt !== null) return;
  if (sizeForRounds(rounds) === null) throw roundsAboveMax(rounds);
  if (rounds > includedRounds(row.size)) throw roundsNeedSize(row.size, rounds);
}

/** ROUNDS in the caller's transaction (the division lock held): reads the live row, and the Swiss rounds the division's stages
 *  declare (P15), then judges them. `change` is a rounds EDIT that is not stored yet: the stage's own stored count is left out and
 *  its new count added, so the sum is what the division will declare. A division with no live row (not online) is not counted;
 *  whether a FROZEN row is excused is `assertRoundsFit`'s alone. */
export async function assertDivisionRoundsFit(
  tx: Tx | typeof sql, divisionId: string, change?: { stageId: string; rounds: number },
): Promise<void> {
  const row = await livePackage(tx, divisionId);
  if (row === null) return; // not online: nothing to count. A frozen row is `assertRoundsFit`'s to excuse - one authority for it.
  const rounds = change === undefined ? await countedRounds(tx, divisionId) : (await countedRounds(tx, divisionId, change.stageId)) + change.rounds;
  assertRoundsFit(rounds, row);
}

/** CAMERAS: of these divisions, the ones whose PAID, unfrozen package did not pay for the camera while the division's stages and
 *  policies now say it has cameras (P9: `derivedCameras`, read AFTER the write the caller made). Each with its name and the
 *  difference the camera column costs over the plain one at the paid size (the receipt's "Fair-play camera: Yes" at the paid size
 *  owes exactly this). An unpaid row is never listed (its quote follows the policy), nor a frozen one, nor one whose camera price was
 *  paid (P19: the policy turned off and back on in Division settings costs nothing more; only the receipt's "No" returns it).
 *
 *  Whole and in ONE order: the ids are deduplicated and taken ascending, each division's lock first (the order every writer of
 *  several divisions uses, so two saves over the same set cannot cross), and the answer lists every division that needs the
 *  upgrade, never the first. The package row is read plain under the division lock: the pay door takes the same lock before it
 *  writes the row, so the read cannot be torn. */
export async function divisionsNeedingCameraUpgrade(tx: Tx, divisionIds: readonly string[]): Promise<CameraUpgrade[]> {
  const ids = [...new Set(divisionIds)].sort();
  for (const id of ids) await lockDivisionForCap(tx, id);
  const need: CameraUpgrade[] = [];
  for (const id of ids) {
    const row = await livePackage(tx, id);
    if (row === null || row.frozenAt !== null || row.paidAt === null || row.camerasPaid === true) continue;
    if (!(await derivedCameras(tx, id))) continue;
    const [d] = await tx<{ name: string }[]>`select name from divisions where id = ${id}`;
    need.push({ id, name: d?.name ?? row.divisionName, owed: packagePrice(row.size, true) - packagePrice(row.size, false) });
  }
  return need;
}

/** CAMERAS, refused: throws 422 ONLINE_CAMERAS_NEED_UPGRADE listing every division in `divisionIds` that needs the upgrade. The
 *  caller's transaction rolls the camera write back with it, so nothing is saved for any of them. */
export async function assertCamerasPaidFor(tx: Tx, divisionIds: readonly string[]): Promise<void> {
  const need = await divisionsNeedingCameraUpgrade(tx, divisionIds);
  if (need.length > 0) throw camerasNeedUpgrade(need);
}
