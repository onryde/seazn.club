import "server-only";
// server/usecases/stream-sessions/live-notification.ts — a Cloudflare live-input notification, RECORDED (Task 27b; owner
// ask 2026-11-22: every connection drop the moment it happens, not only when a poll catches it).
//
// The stream tick polls a passthrough session's input every 1 min (prod) / 5 min (stg): a drop and a reconnect inside one
// gap left no trace. Cloudflare pushes live_input.connected / .disconnected / .errored (relay/cf-live-notification.ts has the
// contract and the parse), and the webhook route hands each one here, in this app's words.
//
// A RECORD, never a decision. The poll stays the decider: warming → live, the phone-lost ends and D3's `since` all read the
// poll (latestPollSample and phone-lost's last_connected_at filter `source = 'poll'`; outputSinceExpr skips the events this
// writes). So nothing here touches the session row beyond the row lock the event's seq needs, whatever the session's state:
// a notification for an ended session is still the phone's history.
//
// What is written, in ONE transaction (the tick's R-1 shape: an event without its sample, or a sample without its event, is
// never served): an `ingest_status` event (source ingest, kind observed) from the input's last known word to the event's,
// and a fixture_stream_samples row with source `notification` (V543). The last known word is the newest sample AT OR BEFORE
// the notification's moment of the SAME input: its own notifications, and for the camera the poll's samples too (the poll
// reads the camera input only, and only for passthrough). Cloudflare documents no delivery id and no retry policy, so a
// second delivery is recognised by its natural key, the input, the event and the moment, under the row lock.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
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
       where session_id = ${sessionId} and type = 'ingest_status' and source = 'ingest' and occurred_at = ${at}
         and payload->>'via' = 'notification' and payload->>'inputUid' = ${n.inputUid} and payload->>'event' = ${n.event}
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
      sessionId, orgId, source: "ingest", kind: "observed", type: "ingest_status", from, to: n.word, occurredAt: at,
      payload: { via: "notification", event: n.event, reason: n.reason, role, inputUid: n.inputUid },
    });
    const sample = await recordSample(tx, {
      sessionId, source: "notification", ingestState: n.word, ingestReason: n.reason, sampledAt: at,
      raw: { event: n.event, role, inputUid: n.inputUid, at: n.at?.toISOString() ?? null },
    });
    return { outcome: "recorded", sessionId, role, from, sample };
  });
}
