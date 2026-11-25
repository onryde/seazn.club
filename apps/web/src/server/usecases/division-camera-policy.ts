import "server-only";
// server/usecases/division-camera-policy.ts — the ONE rule for changing a division's OWN camera policy (the "Camera during online play"
// setting, `divisions.camera_policy`; spec 2026-10-09 §5.1 D9), and its two writers' shared half:
//
//   * the division save (`patchDivision`, divisions/patch.ts): the organiser picks Off / Optional / Required / the competition's setting
//     in Division settings — it reads the row with `lockDivisionCameraRow`, gates and audits with `auditDivisionCameraChange`, and
//     writes the column in its own UPDATE;
//   * the Online Chess receipt (online-package/pay.ts, spec 2026-11-23-online-chess-credits-design.md §8.4-§8.6, Task 15): the
//     organiser answers "Fair-play camera: Yes / No" and pays, and `writeDivisionCameraChoice` writes that answer to the same setting
//     in the payment's own transaction, so the receipt and the settings never disagree.
//
// The rule, whichever door: only a real CHANGE of the stored value is gated and audited (a re-send of the current value never 409s
// and leaves no row); the gate judges what PLAYERS get, the division-level EFFECTIVE policy (clearing `off` to inherit a `required`
// competition is a tightening although null has no rank); once a round of the division has been opened the requirement may only be
// relaxed (409 POLICY_LOCKED); and the audit row is written in the same transaction as the change it describes (ruling Q2), so a
// refused or rolled-back change never leaves a row saying it happened. `fixtureCameraPolicyAt` reads those rows back as evidence.
import type postgres from "postgres";
import { HttpError } from "@/lib/errors";
import {
  CAMERA_POLICY_CHANGED, assertCameraPolicyForSport, assertPolicyChange, effectivePolicy, readCameraPolicy, type CameraPolicy,
} from "@/server/external-play/camera-policy";
import { anyRoundOpened } from "@/server/external-play/round-open";
import { audit } from "./audit";

type AnySql = postgres.TransactionSql | postgres.Sql;

/** The camera facts of one division, as a change reads them: its sport, its competition, its OWN stored policy and the competition's
 *  (the floor it inherits when its own is null). */
export interface DivisionCameraRow {
  sport_key: string;
  competition_id: string;
  camera_policy: string | null;
  competition_policy: string;
}

/** The division's camera facts under `for no key update` of the division row: the "before" a change replaces, pinned until the
 *  transaction ends. A division that does not exist is a 404. */
export async function lockDivisionCameraRow(tx: AnySql, divisionId: string): Promise<DivisionCameraRow> {
  const [cur] = await tx<DivisionCameraRow[]>`
    select d.sport_key, d.competition_id, d.camera_policy,
           c.camera_policy as competition_policy
      from divisions d
      join competitions c on c.id = d.competition_id
     where d.id = ${divisionId}
       for no key update of d`;
  if (!cur) throw new HttpError(404, "division not found");
  return cur;
}

/** The gate and the audit of a change of the division's own policy from what `cur` stores to `to` (null = inherit the competition's).
 *  The caller writes the column. Answers whether the stored value changes (false: a re-send, nothing gated, nothing audited). Throws
 *  422 CAMERA_POLICY_SPORT for a sport that cannot play online and 409 POLICY_LOCKED for a tightening after a round opened. */
export async function auditDivisionCameraChange(
  tx: AnySql,
  a: { cur: DivisionCameraRow; to: CameraPolicy | null; divisionId: string; orgId: string; actorId: string | null; roundOpened: boolean },
): Promise<boolean> {
  assertCameraPolicyForSport(a.cur.sport_key, a.to);
  const stored = readCameraPolicy(a.cur.camera_policy);
  if (a.to === stored) return false;
  const floor = readCameraPolicy(a.cur.competition_policy);
  const effectiveFrom = effectivePolicy({ stage: null, division: stored, competition: floor });
  const effectiveTo = effectivePolicy({ stage: null, division: a.to, competition: floor });
  assertPolicyChange({ from: effectiveFrom, to: effectiveTo, windowOpened: a.roundOpened });
  await audit(
    tx,
    a.cur.competition_id,
    a.orgId,
    CAMERA_POLICY_CHANGED,
    { divisionId: a.divisionId, stageId: null, from: stored, to: a.to, effectiveFrom, effectiveTo, roundOpened: a.roundOpened },
    a.actorId,
  );
  return true;
}

/** The policy "Fair-play camera: Yes" writes on a division whose own effective policy is off: Required, the setting under which the
 *  camera supervises play (a player cannot take their seat until it is live). A division already on (Optional or Required, its own
 *  or the competition's) keeps what it has. */
export const CAMERA_CHOICE_ON: CameraPolicy = "required";

/** What the division's own policy must become for the division-level effective policy to say `cameras` (Yes: not off; No: off), or
 *  `undefined` when it already says it and nothing is written. Pure: `stored` is the division's own value, `floor` the competition's. */
export function cameraChoiceTarget(a: { stored: CameraPolicy | null; floor: CameraPolicy | null; cameras: boolean }): CameraPolicy | undefined {
  const effective = effectivePolicy({ stage: null, division: a.stored, competition: a.floor });
  if ((effective !== "off") === a.cameras) return undefined;
  return a.cameras ? CAMERA_CHOICE_ON : "off";
}

/** The receipt's camera answer written to the division's own policy, on the caller's transaction (the pay door's privileged one:
 *  `stage_round_opens` is sealed, so `anyRoundOpened` needs it). The caller holds the `division:` lock. Reads the row `for no key
 *  update`, gates and audits through `auditDivisionCameraChange` (the division save's own rule), and writes the column only when the
 *  division-level effective policy does not already say the answer. "Has a round opened" is asked on the DATABASE clock. Answers the
 *  change it made, or null when the setting already said it. */
export async function writeDivisionCameraChoice(
  tx: AnySql,
  a: { divisionId: string; orgId: string; actorId: string | null; cameras: boolean },
): Promise<{ from: CameraPolicy | null; to: CameraPolicy } | null> {
  const cur = await lockDivisionCameraRow(tx, a.divisionId);
  const from = readCameraPolicy(cur.camera_policy);
  const to = cameraChoiceTarget({ stored: from, floor: readCameraPolicy(cur.competition_policy), cameras: a.cameras });
  if (to === undefined) return null;
  const [clock] = await tx<{ now: Date }[]>`select now() as now`;
  const roundOpened = await anyRoundOpened(tx, a.divisionId, clock!.now);
  await auditDivisionCameraChange(tx, { cur, to, divisionId: a.divisionId, orgId: a.orgId, actorId: a.actorId, roundOpened });
  const written = await tx`update divisions set camera_policy = ${to} where id = ${a.divisionId} returning id`;
  if (written.length !== 1) throw new HttpError(404, "division not found");
  return { from, to };
}
