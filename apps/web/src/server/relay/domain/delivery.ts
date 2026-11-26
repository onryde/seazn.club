// Task 46 (owner 2026-11-24, apply-rec) — the beat answer's delivery facts (capture-schemas CaptureDelivery), from what the
// server STORES. Pure: no DB, no network, no clock (`now` is the caller's). The read is usecases/capture-delivery.ts; the
// wire builder (beat-answer.ts wireBeatAnswer) decides which answers carry it and omits an empty one.
//
// The value mapping, stored → wire:
//   relayOutput    ← last_heartbeat.output          (RelayHeartbeat: connecting | connected | backoff), verbatim
//   programmePhase ← last_heartbeat.programmePhase  (lib/relay-phase PROGRAMME_PHASES), verbatim
//   fps            ← last_heartbeat.fps             rounded to a whole number
//   kbps           ← last_heartbeat.bitrateKbps     rounded to a whole number
//     …each only while heartbeat_at is at most DELIVERY_RELAY_FRESH_MS old ("3 relay beats", the brief), and never from the
//     Machine's FINAL beat (state `stopped`: the process that sent it has exited, so its output is no fact about now).
//   cameraIngest / programmeIngest ← the latest recorded Cloudflare live-input event for that input (fixture_stream_events
//     `ingest_status`, source `webhook`, payload.event): live_input.connected | .disconnected | .errored → connected |
//     disconnected | errored. The event name, not the event's `to_state`: the port folds `errored` into `unknown`, and an
//     errored input is a fact the phone can show.
//     …EXCEPT a `disconnected` the relay's own newer beat contradicts (`ingestOf`): a late notification for a DEAD leg (the
//     phone's SRT leg, torn down after it fell back to RTMPS) names the input, not the protocol or the connection, and carries a
//     moment newer than the reconnect, so nothing in the notification tells it from a real drop (stg 2026-11-26, session c02f56a0:
//     the phone was told "camera-ingest disconnected" while on air). The relay is the one reader that sees the input's frames.
// Unknown or absent → the member is omitted, never null. A stored word the wire does not name is unknown: each member is
// checked against the wire's own schema, so nothing outside the contract is ever sent.
import { CaptureDelivery } from "@/server/api-v1/capture-schemas";
import { DELIVERY_RELAY_FRESH_MS } from "../config";

/** What the read hands over, as stored. */
export type StoredDelivery = {
  /** fixture_stream_sessions.last_heartbeat: the Machine's beat, stored as sent (scrubbed); null when it has sent none. */
  relayBeat: unknown;
  /** fixture_stream_sessions.heartbeat_at: when that beat was stored, on the server's clock. */
  relayBeatAt: Date | null;
  /** payload.event of the latest recorded live-input notification for the session's camera / programme input; null when none. */
  cameraEvent: string | null;
  programmeEvent: string | null;
  /** That notification's moment (fixture_stream_events.occurred_at: Cloudflare's own time when it sent one); null when none. */
  cameraEventAt: Date | null;
  programmeEventAt: Date | null;
};

type Ingest = NonNullable<CaptureDelivery["cameraIngest"]>;
/** Cloudflare's documented live-input events (relay/cf-live-notification.ts). A domain file imports only the constants, its
 *  siblings and the capture contract (domain-purity.test.ts), so delivery.test.ts types this list against `CfLiveEvent`
 *  and sweeps every event through it: one Cloudflare adds fails there until it is mapped here. */
const INGEST_OF: Readonly<Record<string, Ingest>> = {
  "live_input.connected": "connected",
  "live_input.disconnected": "disconnected",
  "live_input.errored": "errored",
};
const wordOf = (event: string | null): Ingest | undefined =>
  event !== null && Object.hasOwn(INGEST_OF, event) ? INGEST_OF[event] : undefined;

/** The relay's beat says the camera is arriving: its input link is up AND the programme is on the camera's frames (`live`; a
 *  waiting, frozen, reconnecting or final programme is not the camera on air). */
const cameraArriving = (beat: Record<string, unknown>): boolean => beat.input === "connected" && beat.programmePhase === "live";
/** The relay's beat says its push to the programme input is up. */
const programmeUp = (beat: Record<string, unknown>): boolean => beat.output === "connected";

/** The notification's word for one input, except that a `disconnected` is outranked (told `connected`) when ALL of: the relay's
 *  stored beat is a fact about now (`liveBeat`), it shows this input working (`proves`), and it was stored AFTER the notification.
 *  The last is what keeps a real drop: a beat older than the notification cannot know of it, so it never contradicts it — and a
 *  notification with no moment, or one at the beat's own moment, is no ordering, so it stands. The relay's next beat after a real
 *  drop shows the input down (backoff / reconnecting), so a `connected` told in the gap lasts at most one beat. Only
 *  `disconnected` is outranked: `errored` is a fact the phone can show, and `connected` needs no help. */
function ingestOf(
  event: string | null, eventAt: Date | null, beat: Record<string, unknown> | null, beatAt: Date | null,
  proves: (beat: Record<string, unknown>) => boolean,
): Ingest | undefined {
  const word = wordOf(event);
  if (word !== "disconnected" || beat === null || beatAt === null || eventAt === null) return word;
  return beatAt.getTime() > eventAt.getTime() && proves(beat) ? "connected" : word;
}

/** The stored beat, when it is a fact about now: an object, fresh, and not the Machine's final beat. */
function liveBeat(s: StoredDelivery, now: Date): Record<string, unknown> | null {
  if (s.relayBeatAt === null || typeof s.relayBeat !== "object" || s.relayBeat === null || Array.isArray(s.relayBeat)) return null;
  if (now.getTime() - s.relayBeatAt.getTime() > DELIVERY_RELAY_FRESH_MS) return null;
  const beat = s.relayBeat as Record<string, unknown>;
  return beat.state === "stopped" ? null : beat;
}

const rounded = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);

export function deliveryOf(s: StoredDelivery, now: Date): CaptureDelivery {
  const beat = liveBeat(s, now);
  const candidates: { [K in keyof CaptureDelivery]-?: unknown } = {
    relayOutput: beat?.output,
    programmePhase: beat?.programmePhase,
    fps: rounded(beat?.fps),
    kbps: rounded(beat?.bitrateKbps),
    cameraIngest: ingestOf(s.cameraEvent, s.cameraEventAt, beat, s.relayBeatAt, cameraArriving),
    programmeIngest: ingestOf(s.programmeEvent, s.programmeEventAt, beat, s.relayBeatAt, programmeUp),
  };
  const out: Record<string, unknown> = {};
  for (const [member, value] of Object.entries(candidates)) {
    if (value === undefined || value === null) continue;
    // The wire's own member schema: a word or number outside the contract is unknown, so omitted.
    if (CaptureDelivery.shape[member as keyof CaptureDelivery].safeParse(value).success) out[member] = value;
  }
  return out as CaptureDelivery;
}
