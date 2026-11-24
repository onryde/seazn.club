import "server-only";
// server/usecases/capture-delivery.ts — Task 46 (owner 2026-11-24, apply-rec): the ONE read behind the beat answer's
// `delivery` (capture-schemas CaptureDelivery). runBeat (capture-phone.ts, step 7) calls it on the pool, after the beat's
// transaction, only for an answer that tells the phone to publish (go-live, live); relay/domain/delivery.ts turns what it
// returns into the wire's members.
//
// Where each fact is stored (the brief: "decide the value mapping from what is STORED"):
//   - the relay's own beat: fixture_stream_sessions.last_heartbeat (the Machine's beat as sent, scrubbed) and heartbeat_at
//     (the server's clock when it was stored), both written by stream-sessions/heartbeat.ts — a superseded attempt's beat and
//     a beat overtaken by the attempt's final never write them;
//   - Cloudflare's live-input notifications: fixture_stream_events rows `type = 'ingest_status'`, `source = 'webhook'`, their
//     payload `{event, reason, role, inputUid}`, written by stream-sessions/live-notification.ts. Events, not the samples
//     beside them: a session over its sample cap stops writing samples, never events.
// "The latest recorded webhook for that input" is the newest by the event's MOMENT (occurred_at, Cloudflare's own time when it
// sent one) and then by the order it was recorded (seq): Cloudflare documents no delivery order, so a drop delivered after a
// later reconnect never reads as now. "That input" is the session's input of the role, matched on its uid; a deleted input's uid
// is nulled (relay-sweep.ts's retention pass), so its notifications no longer match.
//
// Seazn-hosted sessions only (the brief: "a session that has a relay/programme (Seazn-hosted composed sessions)"): the row is
// read only when destination_kind is `seazn` (V541, written once at admission; a Seazn session always runs composed), so any
// other session — a passthrough, a composed one on a pasted key, every court session (courts cannot pick Seazn, spec
// 2026-11-20 §7 call 2) — reads no row and its answer carries no `delivery`.
import { sql } from "@/lib/db";
import type { StoredDelivery } from "@/server/relay/domain/delivery";

/** The stored facts for session `sid`, or null when it is not a Seazn-hosted session (or no longer exists). One statement. */
export async function readDeliveryFacts(sid: string): Promise<StoredDelivery | null> {
  const [row] = await sql<{ last_heartbeat: unknown; heartbeat_at: Date | null; camera_event: string | null; programme_event: string | null }[]>`
    select s.last_heartbeat, s.heartbeat_at,
           (select e.payload->>'event' from fixture_stream_events e
              join fixture_stream_inputs i on i.session_id = s.id and i.role = 'camera' and i.ingest_input_id = e.payload->>'inputUid'
             where e.session_id = s.id and e.type = 'ingest_status' and e.source = 'webhook'
             order by e.occurred_at desc, e.seq desc limit 1) as camera_event,
           (select e.payload->>'event' from fixture_stream_events e
              join fixture_stream_inputs i on i.session_id = s.id and i.role = 'programme' and i.ingest_input_id = e.payload->>'inputUid'
             where e.session_id = s.id and e.type = 'ingest_status' and e.source = 'webhook'
             order by e.occurred_at desc, e.seq desc limit 1) as programme_event
      from fixture_stream_sessions s
     where s.id = ${sid} and s.destination_kind = 'seazn'`;
  if (row === undefined) return null;
  return { relayBeat: row.last_heartbeat, relayBeatAt: row.heartbeat_at, cameraEvent: row.camera_event, programmeEvent: row.programme_event };
}
