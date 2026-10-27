// Owed 108 fix (b), web half — the phone-live EDGE. Pure: the use-case reads the tracker, passes the beat in, and stores what
// this returns (capture-phone.ts `postBeat`, the only writer; stream-sessions.ts `heartbeat` serves `edge`).
//
// The relay (the Fly compositor) is outbound-only, so web can only tell it something in the reply to its ~5 s heartbeat. When
// the phone's connection comes back after an outage the relay is waiting out its own back-off; a per-session counter in that
// reply, bumped once per not-live → live edge, lets it reconnect at once (docs/contracts/relay-job.v1.json heartbeatReply
// `phoneLiveEdge`). It acts once per INCREASE, so the counter is monotonic and stored; this file is only the rule.
//
// The signal is the PHONE'S OWN beat (`state`), never Cloudflare Input A's status: the phone's beat arrives whether or not an
// organiser page is open, and a Cloudflare read is only taken when a tick runs.
import type { CapturePhoneState } from "@/server/api-v1/capture-schemas";
import { type SessionState, isActive } from "./session";

/** The beat states in which the phone is SENDING VIDEO. `degraded` is a weak connection that still publishes (capture spec
 *  W12: "silence, reconnecting and degraded only warn" — and the panel words it a weak connection, stream-session-view.ts),
 *  so publishing → degraded → publishing is not an outage. `reconnecting` has lost the video; `paired` … `connecting` have
 *  not started it; `ended` has stopped it. */
export const PHONE_LIVE_STATES = ["publishing", "degraded"] as const satisfies readonly CapturePhoneState[];
export const isPhoneLive = (state: CapturePhoneState): boolean => (PHONE_LIVE_STATES as readonly string[]).includes(state);

/** Whether a session in this state still has a relay to nudge: any ACTIVE state but `ending`. An ending session's relay is
 *  being told to flush and exit (`desiredState: "ending"`), and a finished one is gone — neither is an outage to recover from,
 *  so the phone coming back is not an edge for them. The counter then stands where it was. */
export const phoneLiveTracked = (state: SessionState): boolean => isActive(state) && state !== "ending";

/** What is persisted per session (fixture_stream_sessions.phone_live_edge / phone_live / phone_live_beat_at, V476).
 *  `edge`: null until the session's phone has been live once; 0 at that first live; +1 per later edge. `live` and `beatAt`:
 *  the last beat the tracker APPLIED (null together with no beat at all). */
export interface PhoneLiveTracker { edge: number | null; live: boolean | null; beatAt: Date | null }
export const NO_PHONE_LIVE: PhoneLiveTracker = { edge: null, live: null, beatAt: null };

/**
 * Folds one beat of the session's phone into the tracker.
 *
 *  - A LATE delivery — an `at` EARLIER than the last applied beat's — is not an edge and is not applied: it returns `prev`
 *    untouched. A `reconnecting` beat that a bad network delivers after the `publishing` beat that followed it would otherwise
 *    read as a fresh outage and turn the NEXT live beat into a phantom edge. An EQUAL `at` is applied, in arrival order: the
 *    phone's timestamp may have whole-second resolution (RFC 3339 requires seconds, no more), so two different beats can share
 *    one, and dropping the second of `publishing` then `reconnecting` in one second would hide the outage. A DUPLICATE (the
 *    same beat sent twice) is harmless that way — it carries the state the tracker already holds, so it is no edge.
 *  - The first live beat sets the counter to 0: there is no outage to recover from, so it does not count.
 *  - After that, a live beat is an edge when the beat BEFORE it was not live, or when the phone was SILENT before it
 *    (`silentBefore`: no beat for the not-responding window, domain/pairing.ts `isNotResponding`). The silence case is the
 *    outage the phone's own beats cannot report — they travel the same dead network the video does, so the first beat back may
 *    already say `publishing`.
 *  - One edge per beat at most, and the counter never goes down.
 */
export function stepPhoneLive(prev: PhoneLiveTracker, beat: { state: CapturePhoneState; at: Date }, silentBefore: boolean): PhoneLiveTracker {
  // A counter with no recorded side is a corrupted row (V476's CHECK refuses it) — never guess which side it was on.
  if (prev.edge !== null && (prev.live === null || prev.beatAt === null)) {
    throw new RangeError(`stepPhoneLive: a counter of ${prev.edge} with no last beat (live=${String(prev.live)}, beatAt=${String(prev.beatAt)})`);
  }
  if (prev.beatAt !== null && beat.at.getTime() < prev.beatAt.getTime()) return prev;
  const live = isPhoneLive(beat.state);
  let edge = prev.edge;
  if (live) {
    if (edge === null) edge = 0;
    else if (prev.live === false || silentBefore) edge += 1;
  }
  return { edge, live, beatAt: beat.at };
}
