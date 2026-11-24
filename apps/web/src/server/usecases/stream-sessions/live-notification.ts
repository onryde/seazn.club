import "server-only";
// server/usecases/stream-sessions/live-notification.ts — a Cloudflare live-input notification, RECORDED (Task 27b; owner
// ask 2026-11-22: every connection drop the moment it happens, not only when a poll catches it).
//
// The stream tick polls a passthrough session's input every 1 min (prod) / 5 min (stg): a drop and a reconnect inside one
// gap left no trace. Cloudflare pushes live_input.connected / .disconnected / .errored (relay/cf-live-notification.ts has the
// contract and the parse), and the webhook route hands each one here, in this app's words.
//
// A RECORD, never a decision. The poll stays the decider: warming → live, the phone-lost ends and D3's `since` all read the
// poll (latestPollSample and phone-lost's last_connected_at filter `source = 'poll'`; outputSinceExpr reads only the poll's
// `source = 'ingest'` events). So nothing here touches the session row beyond the row lock the event's seq needs, whatever the
// session's state: a notification for an ended session is still the phone's history.
//
// What is written, in ONE transaction (the tick's R-1 shape: an event without its sample, or a sample without its event, is
// never served): an `ingest_status` event (source `webhook`, V410's source for a vendor's push; kind observed) from the
// input's last known word to the event's, and a fixture_stream_samples row with source `notification` (V545). Over the
// session's sample cap the sample is `capped`, and the session gets ONE `samples_capped` event, as a beat's does.
//
// The last known word is the newest sample AT OR BEFORE the notification's MOMENT, of the SAME input: its own notifications,
// and for the camera the poll's samples too (the poll reads the camera input only, and only for passthrough). By moment, not
// by arrival: Cloudflare documents no ordering, so a drop delivered after a later reconnect chains from what was true at the
// drop, and a delivery landing after the next poll never chains from that newer poll. A record is never rewritten: an
// earlier-recorded notification keeps the `from` it was written with when a late one lands before it in time.
// Cloudflare documents no delivery id and no retry policy, so a second delivery is recognised by its natural key, the input,
// the event and the moment, under the row lock.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { SAMPLES_PER_SESSION_CAP } from "@/server/relay/config";
import type { IngestState } from "@/server/relay/ports";
import { recordEvent, recordSample } from "@/server/relay/telemetry";
import { lockRow } from "./session-row";

/** One live-input notification, provider-neutral: the route maps Cloudflare's body to this. */
export interface LiveNotification {
  /** The live input's uid, as fixture_stream_inputs.ingest_input_id holds it. */
  inputUid: string;
  /** The provider's own event name, verbatim (`live_input.disconnected`). */
  event: string;
  /** What the event means in the port's words. */
  word: IngestState;
  /** The provider's error code, when it gave one. */
  reason: string | null;
  /** When it happened, per the provider; null = unknown, recorded at the moment it arrived. */
  at: Date | null;
}

export type LiveNotificationOutcome =
  /** No input row names the uid: another environment's input on the shared account, or a session long deleted. */
  | { outcome: "unknown_input" }
  /** More than one input row names the uid: a write nothing makes. Refused by name; nothing written. */
  | { outcome: "ambiguous_input" }
  /** This notification was already recorded (a second delivery). */
  | { outcome: "duplicate"; sessionId: string }
  | { outcome: "recorded"; sessionId: string; role: string; from: string | null; sample: "written" | "capped" };

export async function recordLiveNotification(n: LiveNotification, arrivedAt: Date): Promise<LiveNotificationOutcome> {
  const owners = await sql<{ session_id: string; role: string; org_id: string }[]>`
    select i.session_id, i.role, s.org_id
      from fixture_stream_inputs i join fixture_stream_sessions s on s.id = i.session_id
     where i.ingest_input_id = ${n.inputUid}
     limit 2`;
  if (owners.length === 0) return { outcome: "unknown_input" };
  if (owners.length > 1) {
    // Every input row holds the uid Cloudflare answered when it was created, and Cloudflare never issues one twice.
    log.error({ inputUid: n.inputUid, sessionIds: owners.map((o) => o.session_id) },
      "stream live notification: an input uid is named by more than one input row — refused, nothing written");
    return { outcome: "ambiguous_input" };
  }
  const { session_id: sessionId, role, org_id: orgId } = owners[0]!;
  const at = n.at ?? arrivedAt;
  return sql.begin(async (tx): Promise<LiveNotificationOutcome> => {
    await lockRow(tx, sessionId);
    const [seen] = await tx<{ id: string }[]>`
      select id from fixture_stream_events
       where session_id = ${sessionId} and type = 'ingest_status' and source = 'webhook' and occurred_at = ${at}
         and payload->>'inputUid' = ${n.inputUid} and payload->>'event' = ${n.event}
       limit 1`;
    if (seen) return { outcome: "duplicate", sessionId };
    const [prev] = await tx<{ ingest_state: string | null }[]>`
      select ingest_state from fixture_stream_samples
       where session_id = ${sessionId} and sampled_at <= ${at}
         and ((source = 'poll' and ${role === "camera"}) or (source = 'notification' and raw->>'inputUid' = ${n.inputUid}))
       order by sampled_at desc, id desc
       limit 1`;
    const from = prev?.ingest_state ?? null;
    await recordEvent(tx, {
      sessionId, orgId, source: "webhook", kind: "observed", type: "ingest_status", from, to: n.word, occurredAt: at,
      payload: { event: n.event, reason: n.reason, role, inputUid: n.inputUid },
    });
    const sample = await recordSample(tx, {
      sessionId, source: "notification", ingestState: n.word, ingestReason: n.reason, sampledAt: at,
      raw: { event: n.event, role, inputUid: n.inputUid, at: n.at?.toISOString() ?? null },
    });
    if (sample === "capped") {
      // Task 27b review m2: the cap's ONE event, as heartbeat.ts's sampleBeat writes it (under this row lock, so two capped
      // deliveries cannot both write it).
      const [{ n: capped }] = await tx<{ n: number }[]>`
        select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and type = 'samples_capped'`;
      if (capped === 0) {
        await recordEvent(tx, { sessionId, orgId, source: "webhook", kind: "event", type: "samples_capped", occurredAt: arrivedAt,
          payload: { count: SAMPLES_PER_SESSION_CAP } });
      }
    }
    return { outcome: "recorded", sessionId, role, from, sample };
  });
}

/** Task 46 carry (enc-boundary claim 4): the newest recorded webhook word for the session's input of `role`, as a SQL fragment for a
 *  select over `fixture_stream_sessions` aliased `s` (usecases/capture-delivery.ts). It lives HERE because this module writes those
 *  `ingest_status` rows and owns their payload (`{event, reason, role, inputUid}`): the capture tables are named only by their
 *  writers. The newest by the event's MOMENT (`occurred_at`), then by the order recorded (`seq`), matched on the input's uid, so a
 *  deleted input (uid nulled by the retention pass) matches nothing. Events, not the samples beside them: a session over its sample
 *  cap stops writing samples, never events. */
export function latestWebhookEvent(role: "camera" | "programme") {
  return sql`(select e.payload->>'event' from fixture_stream_events e
              join fixture_stream_inputs i on i.session_id = s.id and i.role = ${role} and i.ingest_input_id = e.payload->>'inputUid'
             where e.session_id = s.id and e.type = 'ingest_status' and e.source = 'webhook'
             order by e.occurred_at desc, e.seq desc limit 1)`;
}
