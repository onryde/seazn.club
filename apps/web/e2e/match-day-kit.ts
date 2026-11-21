// Seeds the Match Day online specs share (match-day-board-panel.spec.ts, e2e/mobile/match-surfaces.spec.ts). Not a spec.
import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { withDb } from "./helpers";

/** One side's ARRIVAL as the loader's `joinable` sees it: the room, the player on file in it, a counted check-in and a webhook presence
 *  row. `cameraOff` also stamps the browser's own fresh report "off" on the player's participant (the pill's word, `reportedCamera`). */
export async function putArrival(fixtureId: string, orgId: string, side: "home" | "away", personId: string, opts: { cameraOff?: boolean } = {}): Promise<void> {
  await withDb(async (sql) => {
    const meetingId = `e2e-mtg-${side}-${randomUUID().slice(0, 8)}`;
    const room = await sql`
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
      select f.id, ${side}, ${orgId}, ${meetingId}, f.home_entrant_id, f.away_entrant_id from fixtures f where f.id = ${fixtureId}`;
    expect(room.count, `room ${side} for ${fixtureId}`).toBe(1);
    const participantId = `e2e-pp-${side}-${randomUUID().slice(0, 8)}`;
    const player = opts.cameraOff
      ? await sql`
          insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, camera_reported, camera_reported_at)
          values (${fixtureId}, ${side}, ${personId}, 'player', ${participantId}, 'off', now())`
      : await sql`
          insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
          values (${fixtureId}, ${side}, ${personId}, 'player', ${participantId})`;
    expect(player.count, `the ${side} player on file for ${fixtureId}`).toBe(1);
    // The join admits a side by the server's flag: the counted check-in (EXTERNAL_PLAY_PRESENCE_PROOF unset, the local recipe) or the presence row
    // (set, CI's server). A seeded arrival carries both, so `joinable` holds in either state (the same pair the Arbiter Panel's old spec wrote, and what a real check-in leaves).
    const checkIn = await sql`
      insert into fixture_availability (fixture_id, person_id, org_id, status, checked_in_at)
      values (${fixtureId}, ${personId}, ${orgId}, 'in', now())
      on conflict (fixture_id, person_id) do update set checked_in_at = now()`;
    expect(checkIn.count, `the ${side} player's check-in for ${fixtureId}`).toBe(1);
    const presence = await sql`
      insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, joined_at, source)
      values (${meetingId}, ${`e2e-peer-${side}-${randomUUID().slice(0, 8)}`}, ${fixtureId}, ${side}, ${participantId}, ${personId}, now(), 'webhook')`;
    expect(presence.count, `the ${side} player's presence row for ${fixtureId}`).toBe(1);
  });
}
