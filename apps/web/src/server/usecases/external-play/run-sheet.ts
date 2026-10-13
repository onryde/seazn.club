import "server-only";
// T16 — the run sheet's online-chess facts (canvas RunSheetDesktop): per
// board, its camera policy, its OPEN flags and whether it is held for the
// organiser. Read for the organiser only (the page's `editable`), like the
// queue beside it. Never gated by the online-chess flag: these chips lead to
// FINISHING play (settle, review), which T20 never gates.
//
// fixture_play_flags is SEALED (FORCE RLS, no app_user policy): it is read
// with the privileged `sql`, and only after the caller's organisation has been
// proven to own the division.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { RunSheetOnlinePlay } from "@/lib/run-sheet-groups";
import type { AuthCtx } from "@/server/api-v1/auth";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import { readOnlinePlay, supportsOnlinePlay } from "@/server/external-play/online-play";
import { isPlayableFixtureStatus } from "./preflight";
import { readNeedsReason } from "./queue";


export async function listRunSheetOnlinePlay(auth: AuthCtx, divisionId: string): Promise<Record<string, RunSheetOnlinePlay>> {
  const [division] = await sql<{ id: string; sportKey: string; config: unknown }[]>`
    select d.id, d.sport_key as "sportKey", d.config from divisions d
      join competitions c on c.id = d.competition_id
     where d.id = ${divisionId} and c.org_id = ${auth.orgId}`;
  if (!division) throw new HttpError(404, "division not found", "NOT_FOUND");

  // D12: in an online division, a board whose round nobody has opened is a fact too (it owes no result yet).
  const online = supportsOnlinePlay(division.sportKey) && readOnlinePlay(division.config) === "lichess";

  // Every board with a bridge row or an open flag, and (online) every board of an unopened round — nothing else has
  // an online fact to show. stage_round_opens is SEALED: the privileged `sql`, after the org check above.
  const rows = await sql<
    {
      fixtureId: string;
      stageId: string;
      fixtureStatus: string;
      bridgeStatus: string | null;
      needsReason: unknown;
      cameraFlags: number;
      connectionProblems: number;
      offSeaznFlags: number;
      roundOpened: boolean;
    }[]
  >`
    select f.id as "fixtureId", f.stage_id as "stageId", f.status as "fixtureStatus",
           ep.status as "bridgeStatus", ep.needs_reason as "needsReason",
           -- V433's CHECK names exactly three kinds, and each is its own chip: the player's lost camera (amber), OUR
           -- side's connection problems (quiet — T16 fix round 1, I3), moves made off Seazn (amber).
           count(fl.id) filter (where fl.kind = 'camera_lost')::int as "cameraFlags",
           count(fl.id) filter (where fl.kind = 'camera_connection_problems')::int as "connectionProblems",
           count(fl.id) filter (where fl.kind = 'out_of_band_play')::int as "offSeaznFlags",
           sro.id is not null as "roundOpened"
      from fixtures f
      left join fixture_external_play ep on ep.fixture_id = f.id
      left join fixture_play_flags fl on fl.fixture_id = f.id and fl.org_id = ${auth.orgId} and fl.closed_at is null
      left join stage_round_opens sro on sro.stage_id = f.stage_id and sro.round_no = f.round_no
     where f.division_id = ${divisionId} and f.org_id = ${auth.orgId}
     group by f.id, ep.fixture_id, sro.id
    having ep.fixture_id is not null or count(fl.id) > 0 or (${online} and sro.id is null and f.round_no is not null)`;
  if (rows.length === 0) return {};

  // One policy per stage (stage → division → competition), through the ONE
  // reader every other surface asks.
  const policyByStage = new Map<string, Awaited<ReturnType<typeof fixtureCameraPolicy>>>();
  for (const r of rows) {
    if (!policyByStage.has(r.stageId)) policyByStage.set(r.stageId, await fixtureCameraPolicy(r.fixtureId));
  }

  const out: Record<string, RunSheetOnlinePlay> = {};
  for (const r of rows) {
    // All three read the FIXTURE too: a result written by any path ends the game, whatever the bridge row still says.
    const playable = isPlayableFixtureStatus(r.fixtureStatus);
    const unopened = online && !r.roundOpened && playable;
    // A settled board of an unopened round with no other fact: nothing to show.
    if (r.bridgeStatus === null && r.cameraFlags + r.connectionProblems + r.offSeaznFlags === 0 && !unopened) continue;
    const held = r.bridgeStatus === "needs_organiser" && playable;
    out[r.fixtureId] = {
      cameraPolicy: policyByStage.get(r.stageId)!,
      cameraFlagCount: r.cameraFlags,
      connectionProblemCount: r.connectionProblems,
      offSeaznFlagCount: r.offSeaznFlags,
      held: held ? readNeedsReason(r.needsReason) : null,
      live: r.bridgeStatus === "live" && playable,
      unopened,
    };
  }
  return out;
}
