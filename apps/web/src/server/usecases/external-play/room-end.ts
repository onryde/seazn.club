import "server-only";
// T17B fix 2 (D8b) — the camera room ends with the game.
//
// Measured on stg: after the checkmate both players' cameras kept publishing until the sweep's teardown six
// minutes later (job 3, every 5 minutes). The controller's ruling: the server ends the meeting best-effort, without
// blocking, when the result is recorded — the game's end read from Lichess (reconcile) and the organiser's settle
// (resolve) — and the sweep stays the backstop.
//
// Best effort, both ways: the work runs after the caller's answer (`deferred`: Next's after() in a request, at once
// outside one), and a vendor failure is logged and left — endMeeting stamps `ended_at` only once the vendor has
// deactivated the room, so a failed end leaves the row for job 3's next pass. The room is ended only when job 3
// would end it at the result (sweep.ts meetingIsDone): the bridge is finished, or the fixture is no longer
// playable. A game still on keeps its room, whoever calls.
import { sql } from "@/lib/db";
import { deferred } from "@/lib/deferred";
import { endMeeting } from "@/server/external-play/video/realtimekit";
import { log } from "@/server/logger";
import { PLAYABLE_FIXTURE_STATUSES } from "./bridge-close";

export type RoomEndDeps = {
  /** Where the end runs: `deferred` (after the answer) by default. */
  defer?: (task: () => Promise<unknown>) => void;
  /** Test seam: the vendor's end (T7's endMeeting). */
  endMeeting?: (meetingId: string) => Promise<void>;
};

/** End `fixtureId`'s camera room, after the answer, if its game is over for us. Never throws, never blocks. */
export function endRoomAtResult(fixtureId: string, deps: RoomEndDeps = {}): void {
  (deps.defer ?? deferred)(async () => {
    const [room] = await sql<{ meetingId: string }[]>`
      select m.meeting_id as "meetingId"
        from fixture_video_meetings m
        join fixtures f on f.id = m.fixture_id
        left join fixture_external_play ep on ep.fixture_id = m.fixture_id
       where m.fixture_id = ${fixtureId}
         and m.ended_at is null
         and (ep.status = 'finished' or f.status not in ${sql(PLAYABLE_FIXTURE_STATUSES as string[])})`;
    if (!room) return;
    try {
      await (deps.endMeeting ?? endMeeting)(room.meetingId);
    } catch (err) {
      log.warn(
        { fixtureId, meetingId: room.meetingId, err: err instanceof Error ? err.message : String(err) },
        "camera room: ending it at the result failed — the sweep's teardown ends it",
      );
    }
  });
}
