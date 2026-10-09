import "server-only";
// Camera policy for online chess (spec 2026-10-09 §5.1, owner decisions D5/D9).
// TWO sections: pure predicates (this half) and the database reader below.
//
// THREE levels, each a column (V432; controller ruling Q1=D, 2026-10-09):
// stages.camera_policy → divisions.camera_policy → competitions.camera_policy.
// Stage and division are nullable (null = inherit); the competition's is NOT
// NULL with default 'off', so the chain always has a floor and every row of
// pre-existing data reads 'off' (spec §5.1: "Off for all existing data").
// Columns, not config keys: divisions.config / stages.config are
// sport-module-validated snapshots that strip unknown keys.
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { CAMERA_POLICIES, type CameraPolicy } from "@/lib/camera-policy";

export { CAMERA_POLICIES, type CameraPolicy };

export function policyRank(p: CameraPolicy): 0 | 1 | 2 {
  const i = CAMERA_POLICIES.indexOf(p);
  if (i !== 0 && i !== 1 && i !== 2) {
    // Not "cannot happen" in a comment: an unranked policy would make
    // assertPolicyChange compare -1 and silently allow every change.
    throw new HttpError(500, `unranked camera policy '${String(p)}'`, "CAMERA_POLICY_UNRANKED");
  }
  return i;
}

/** The NEAREST level that is set wins, including when it is less strict than
 *  what it inherits — an organiser who turns one stage's camera off meant it.
 *  Nothing set anywhere ⇒ `off`. */
export function effectivePolicy(a: {
  stage: CameraPolicy | null;
  division: CameraPolicy | null;
  competition: CameraPolicy | null;
}): CameraPolicy {
  return a.stage ?? a.division ?? a.competition ?? "off";
}

/** D9. Before any round of the division is opened an organiser may set
 *  anything. Afterwards the requirement may only be RELAXED, and the caller
 *  writes an audit row either way — otherwise an org could flip required→off
 *  to erase a camera flag after the fact, or off→required at T−5 and strand a
 *  field that has no camera set up. A no-op (from === to) is always allowed so
 *  a re-send of the current value never 409s. */
export function assertPolicyChange(a: {
  from: CameraPolicy;
  to: CameraPolicy;
  windowOpened: boolean;
}): void {
  if (!a.windowOpened) return;
  if (policyRank(a.to) <= policyRank(a.from)) return;
  throw new HttpError(
    409,
    "A round has been opened — the camera requirement can only be relaxed from here",
    "POLICY_LOCKED",
  );
}

/** Read a stored camera_policy column value. Null or unrecognised ⇒ `null`
 *  (inherit). Deliberately NOT `readOnlinePlay`'s shape, which defaults to
 *  "off": an explicit "off" overrides what it inherits, a null falls through. */
export function readCameraPolicy(raw: unknown): CameraPolicy | null {
  return CAMERA_POLICIES.find((p) => p === raw) ?? null;
}

/** Validate an incoming write. `null`/`undefined` ⇒ `null`, meaning "clear
 *  this level's own value and inherit", never "off". */
export function assertCameraPolicyValue(value: unknown): CameraPolicy | null {
  if (value === undefined || value === null) return null;
  const found = CAMERA_POLICIES.find((p) => p === value);
  if (!found) {
    throw new HttpError(
      422,
      "camera_policy must be 'off', 'optional' or 'required'",
      "CAMERA_POLICY_INVALID",
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Database reader.

/** The effective policy for one fixture: its stage's own value, else its
 *  division's, else its competition's (NOT NULL — the floor). One query; a
 *  fixture that does not exist reads `off` rather than throwing, because every
 *  caller's answer to "no such fixture" is already "no camera to gate on". */
export async function fixtureCameraPolicy(fixtureId: string): Promise<CameraPolicy> {
  const [row] = await sql<
    { stagePolicy: unknown; divisionPolicy: unknown; competitionPolicy: unknown }[]
  >`
    select s.camera_policy as "stagePolicy",
           d.camera_policy as "divisionPolicy",
           c.camera_policy as "competitionPolicy"
      from fixtures f
      left join stages s on s.id = f.stage_id
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
     where f.id = ${fixtureId}`;
  if (!row) return "off";
  return effectivePolicy({
    stage: readCameraPolicy(row.stagePolicy),
    division: readCameraPolicy(row.divisionPolicy),
    competition: readCameraPolicy(row.competitionPolicy),
  });
}
