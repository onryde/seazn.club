import "server-only";
// D16 (§5.6.3) - the opponent's presence pill is the opponent's OWN browser's word, relayed. Each player is in a meeting of
// their own now, so the viewer's browser cannot see the opponent at all, and nothing is read from the vendor (its report
// is the same browser telemetry, in batches, at a call each). A player's tab reports its camera's CURRENT state here, on
// every change and again every CAMERA_REPORT_HEARTBEAT_MS in both states; this stamps it on the caller's own player
// participant row, on the SERVER's clock, and the room snapshot (room.ts) reads it back for the opponent.
//
// It makes no RealtimeKit call, so it spends nothing from the platform's call budget, and NOTHING ELSE READS IT: not the
// seat gate, not camera_lost, not the evidence read, the teardown or any flag. A client-claimed signal is exactly what the
// design rejects as a safeguard (§5.2, §10); the source guard pins that these columns are named in two files only - this
// one, which writes them, and room.ts, whose snapshot composer reads them.
import { sql } from "@/lib/db";
import { CAMERA_FAULT_PING_LIMIT, CAMERA_REPORT_LIMIT, rateLimit } from "@/lib/rate-limit";
import { HttpError } from "@/lib/errors";
import { publishExternalPlayLobby } from "@/lib/realtime";
import { CAMERA_REPORT_STALE_MS } from "@/components/public-site/match-room/room-snapshot";
import type { RoomCameraReport } from "@/server/api-v1/schemas";
import { storedPlayerParticipant } from "./preflight";
import { resolveRoom, ROOM_NOT_FOUND, type RoomDeps, type RoomIdentity } from "./room";

/** What the report did to the stored row: `written` (a new state and stamp), `refreshed` (the same state, a younger stamp) or
 *  `ignored` (a heartbeat that disagreed with a state still fresh: the stored row is untouched). */
export type CameraReportOutcome = "written" | "refreshed" | "ignored";

/**
 * POST camera-report. The caller must be one of the board's two players, and the row stamped is their `storedPlayerParticipant`
 * on their OWN side (the one rule for which participant is a person's), in a meeting still open; anything else - a stranger, a
 * player never seated in a meeting, an ended meeting - is the room's one 404, like every identity failure.
 *
 * A CHANGE (`heartbeat: false`) always writes its state and pings the opponent's room. A HEARTBEAT is judged against the
 * stored row, in four cases:
 *   - it names the state already stored: it refreshes the stamp and pings nobody;
 *   - nothing is stored yet: it writes the state and the stamp, and pings nobody;
 *   - it names a different state and the stored row is still fresh: it is ignored, the stamp untouched - what makes a
 *     reordered pair harmless (a `live` heartbeat in flight when the camera went off lands after the `off` change, finds a
 *     fresh row, and is dropped, so a stale "live" is never stranded);
 *   - it names a different state and the stored row is no longer fresh (CAMERA_REPORT_STALE_MS, the pill's own test for
 *     "unknown"): it is applied as a change is, and pings. Without this, when the tab that made the deciding change closes,
 *     the surviving tab's heartbeats would be ignored for ever and the pill would read unknown until the camera next
 *     changed.
 * The ping is rate-limited per seat (CAMERA_FAULT_PING_LIMIT, as camera-fault's is): past it the row is written and the ping
 * skipped. The route itself is limited (CAMERA_REPORT_LIMIT, 429).
 */
export async function reportOwnCamera(
  identity: RoomIdentity,
  fixtureId: string,
  body: RoomCameraReport,
  deps: RoomDeps = {},
): Promise<{ outcome: CameraReportOutcome }> {
  const now = deps.now ?? new Date();
  const r = await resolveRoom(identity, fixtureId);
  const { personId, side } = r.player;
  // After identity (a stranger is the 404 and spends none of a seat's budget), before anything is written.
  await rateLimit(`room-camera-report:${fixtureId}:${personId}`, CAMERA_REPORT_LIMIT);

  const participantId = await storedPlayerParticipant(sql, { fixtureId, side, personId });
  if (participantId === null) throw ROOM_NOT_FOUND();

  const verdict = await sql.begin(async (tx): Promise<{ outcome: CameraReportOutcome; ping: boolean } | null> => {
    const [row] = await tx<{ state: string | null; at: Date | null }[]>`
      select p.camera_reported as state, p.camera_reported_at as at
        from fixture_video_participants p
        join fixture_video_meetings m on m.fixture_id = p.fixture_id and m.side = p.side
       where p.fixture_id = ${fixtureId} and p.side = ${side} and p.participant_id = ${participantId}
         and p.preset = 'player' and m.ended_at is null
         for update of p`;
    if (!row) return null;
    const fresh = row.at !== null && now.getTime() - row.at.getTime() < CAMERA_REPORT_STALE_MS;
    let outcome: CameraReportOutcome;
    let ping: boolean;
    if (!body.heartbeat) {
      outcome = "written";
      ping = true;
    } else if (row.state === null) {
      outcome = "written";
      ping = false;
    } else if (row.state === body.state) {
      outcome = "refreshed";
      ping = false;
    } else if (fresh) {
      return { outcome: "ignored", ping: false };
    } else {
      outcome = "written";
      ping = true;
    }
    await tx`
      update fixture_video_participants set camera_reported = ${body.state}, camera_reported_at = ${now}
       where fixture_id = ${fixtureId} and side = ${side} and participant_id = ${participantId}`;
    return { outcome, ping };
  });
  if (verdict === null) throw ROOM_NOT_FOUND();
  if (verdict.ping && (await pingAllowed(fixtureId, personId))) await (deps.publish ?? publishExternalPlayLobby)(fixtureId);
  return { outcome: verdict.outcome };
}

/** The ping's budget: spent only by a change; a 429 skips the ping (the opponent's next read catches up). */
async function pingAllowed(fixtureId: string, personId: string): Promise<boolean> {
  try {
    await rateLimit(`room-camera-report-ping:${fixtureId}:${personId}`, CAMERA_FAULT_PING_LIMIT);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return false;
    throw err;
  }
}
