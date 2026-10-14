import "server-only";
// Camera policy for online chess (spec 2026-10-09 §5.1, owner decisions D5/D9).
// TWO sections: pure predicates (this half) and the database reader below.
//
// THREE levels, each a column (V439; controller ruling Q1=D, 2026-10-09):
// stages.camera_policy → divisions.camera_policy → competitions.camera_policy.
// Stage and division are nullable (null = inherit); the competition's is NOT
// NULL with default 'off', so the chain always has a floor and every row of
// pre-existing data reads 'off' (spec §5.1: "Off for all existing data").
// Columns, not config keys: divisions.config / stages.config are
// sport-module-validated snapshots that strip unknown keys.
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { CAMERA_POLICIES, type CameraPolicy } from "@/lib/camera-policy";
import { supportsOnlinePlay } from "./online-play";

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

/** A camera requirement exists only for a sport that can be played online.
 *  `off` and null (inherit) are accepted for every sport — they require
 *  nothing — mirroring onlinePlay's own 'off'-for-all, 'lichess'-for-boardgame
 *  rule (ONLINE_PLAY_SPORT). */
export function assertCameraPolicyForSport(sportKey: string, policy: CameraPolicy | null): void {
  if (policy === null || policy === "off" || supportsOnlinePlay(sportKey)) return;
  throw new HttpError(
    422,
    "A camera requirement is only available for divisions that can be played online",
    "CAMERA_POLICY_SPORT",
  );
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

/** The D9 audit row's type (divisions.ts writes it in the same transaction
 *  as the change it describes). */
export const CAMERA_POLICY_CHANGED = "chess.camera_policy_changed";

/** The policy IN FORCE for one fixture at `at` (review M4) — what the
 *  players were told when the match began, never what the settings say now:
 *  D9 lets an organiser relax the requirement after a round opened, and a
 *  downgrade after the match must not erase the evidence of a match played
 *  under Required.
 *
 *  Only the DIVISION level moves after the open with a writer, and every such
 *  move is audited (`effectiveFrom`: the division-level policy before it). So:
 *  a stage's own value wins and has no writer; otherwise the EARLIEST change
 *  of this division after `at` says what was in force then (its
 *  `effectiveFrom`); no change since ⇒ the current policy. An audit row whose
 *  policy cannot be read THROWS — a guess either way would invent or erase
 *  evidence. */
export async function fixtureCameraPolicyAt(fixtureId: string, at: Date): Promise<CameraPolicy> {
  const [row] = await sql<
    { stagePolicy: unknown; divisionPolicy: unknown; competitionPolicy: unknown; changedFrom: unknown; changed: boolean }[]
  >`
    select s.camera_policy as "stagePolicy",
           d.camera_policy as "divisionPolicy",
           c.camera_policy as "competitionPolicy",
           ce.payload->'effectiveFrom' as "changedFrom",
           ce.id is not null as changed
      from fixtures f
      left join stages s on s.id = f.stage_id
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      left join lateral (
        select e.id, e.payload from competition_events e
         where e.competition_id = d.competition_id and e.type = ${CAMERA_POLICY_CHANGED}
           and e.payload->>'divisionId' = d.id::text and e.created_at > ${at}
         order by e.created_at, e.id
         limit 1
      ) ce on true
     where f.id = ${fixtureId}`;
  if (!row) return "off";
  const stage = readCameraPolicy(row.stagePolicy);
  if (stage === null && row.changed) {
    const then = readCameraPolicy(row.changedFrom);
    if (then === null) {
      throw new HttpError(
        500,
        `a ${CAMERA_POLICY_CHANGED} row for fixture ${fixtureId}'s division has no readable effectiveFrom`,
        "CAMERA_POLICY_AUDIT_UNREADABLE",
      );
    }
    return then;
  }
  return effectivePolicy({
    stage,
    division: readCameraPolicy(row.divisionPolicy),
    competition: readCameraPolicy(row.competitionPolicy),
  });
}

/** The competition's own policy — the floor of the chain, and what the
 *  division settings screen shows as INHERITED when the division sets nothing.
 *  The caller has already resolved `competitionId` through a tenant-scoped
 *  read (the division page), so the privileged client only re-reads a row the
 *  viewer was allowed to reach. A missing row reads "off", like
 *  `fixtureCameraPolicy`. */
export async function competitionCameraPolicy(competitionId: string): Promise<CameraPolicy> {
  const [row] = await sql<{ policy: unknown }[]>`
    select camera_policy as policy from competitions where id = ${competitionId}`;
  return readCameraPolicy(row?.policy) ?? "off";
}
