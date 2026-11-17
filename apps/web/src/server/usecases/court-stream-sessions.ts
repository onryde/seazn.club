import "server-only";
// Court stream (spec seazn.club.capture docs/specs/2026-11-14-court-stream-design.md §5.4; plan Task 7): one court, one
// video at a time. A court start is start-THEN-end (the spec's handover order): once the new match's session exists, every
// other open session of the same court link ends here. Called after EVERY successful court start — the court phone's own
// start (capture-court.ts), the automatic start (Task 8) and the desk's restart (Task 9).
//
// Controller ruling R4: a session ended by a handover latches its match (`markAutoStartBlocked`) while that match is still
// in play, so the court never streams it again by itself once the newer match is done; the desk can restart it by hand.
import { sql } from "@/lib/db";
import { ACTIVE_STATES, isActive } from "@/server/relay/domain/session";
import { recordEvent } from "@/server/relay/telemetry";
import { markAutoStartBlocked } from "./stream-codes";
// The stream-sessions modules directly, never the barrel: the desk's restart (stream-sessions/start.ts) calls this module, and
// the barrel would close an import cycle through it.
import { apply } from "./stream-sessions/apply";
import type { SessionDeps } from "./stream-sessions/deps";
import { endCourtBroadcastSoon } from "./stream-sessions/court-end";

const IN_PLAY = "in_play";

/**
 * End every ACTIVE session of court link `linkId` created before `keepSid` (by `(created_at, id)`; never a newer one, so two
 * racing court starts cannot end each other), `auto_stopped`, each with a `court_handover` event
 * `{to: keepSid}`, and latch each ended session's match while it is still in play (R4). Returns the sids it ended, oldest
 * first. A session that ended on its own in between is skipped (no event, no latch): `apply`'s command is decided on the
 * locked row. `source` names who handed the court over in the event trail ("phone" by default; the desk's restart passes "client").
 */
export async function endOtherCourtSessions(
  a: { linkId: string; keepSid: string; actorUserId: string; source?: "client" | "phone" },
  deps: SessionDeps,
): Promise<string[]> {
  const others = await sql<{ id: string; org_id: string; fixture_id: string }[]>`
    select id, org_id, fixture_id from fixture_stream_sessions
     where court_link_id = ${a.linkId} and state in ${sql([...ACTIVE_STATES])}
       -- Fix I1: only sessions OLDER than the kept one, so of two racing starts the newest always survives.
       and (created_at, id) < (select k.created_at, k.id from fixture_stream_sessions k where k.id = ${a.keepSid})
     order by created_at, id`;
  // Who handed the court over, for the event trail: the court phone's start and the automatic start are "phone" (the default), the
  // desk's restart from the match page is "client" (final review m-5).
  const source = a.source ?? "phone";
  const ended: string[] = [];
  for (const s of others) {
    let stopped = false;
    await apply(s.id, (row) => {
      stopped = isActive(row.state);
      return stopped ? { type: "stop", reason: "auto_stopped" } : null;
    }, deps, { userId: a.actorUserId, source });
    if (!stopped) continue;
    // The finished match's YouTube end is scheduled now, not left to the cron.
    endCourtBroadcastSoon(s.id, deps);
    await sql.begin(async (tx) => {
      await recordEvent(tx, {
        sessionId: s.id, orgId: s.org_id, source, kind: "event", type: "court_handover", actorUserId: a.actorUserId,
        occurredAt: deps.now(), payload: { to: a.keepSid },
      });
      // R4: the match's status read under a share lock, so a result landing now is ordered with the latch.
      const [f] = await tx<{ status: string }[]>`select status from fixtures where id = ${s.fixture_id} for share`;
      if (f?.status === IN_PLAY) await markAutoStartBlocked(s.org_id, s.fixture_id, deps.now(), a.actorUserId, tx);
    });
    ended.push(s.id);
  }
  return ended;
}
