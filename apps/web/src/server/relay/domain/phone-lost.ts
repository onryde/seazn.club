// Capture QR v2 §6.8.3 (ask 10), §6.8.5 (W19) and §6.12 (W24, O5): when a session's phone is lost, and the panel's
// countdown to that end. Pure: `now` passed in; the tunable timings are REQUIRED parameters (§6.15), never the
// environment and never a default, so tsc forces each use-case call site to pass `tunable(…)`.
import { POLL_NEAR_SECONDS, STALE_HEARTBEAT_SECONDS_COMPOSED } from "../config";
import { isSilent, silentAfterMs } from "./pairing";
import { OPEN_SESSION_MAX_POLL_SECONDS } from "./poll-seconds";
import type { SessionState } from "./session";

const since = (at: Date, now: Date): number => now.getTime() - at.getTime();
const PRE_VIDEO: readonly SessionState[] = ["requested", "provisioning", "warming"];
/** §5.4: `warming` with first ingest is a reconnect, still live for W19 and W24. `ending` is already stopping. */
const LIVE_FOR_W19: readonly SessionState[] = ["live", "warming"];

/** Ask 10 (§6.8.3): a session that never received ingest, in requested/provisioning/warming, whose phone is silent
 *  (§6.9) or which no longer has a current pairing, is ended `phone_lost` (no credit is spent). The clock is always
 *  §6.9's max(floor, cadence + slack): a phone that has not heard go-live is on its waiting cadence, so an organiser
 *  Go live is never ended before it could hear; one that has heard it is answered at an open session's cadence (at
 *  most OPEN_SESSION_MAX_POLL_SECONDS), so a stale waiting cadence never stretches its clock past ask 10's 60 s. Only
 *  the floor is tunable (I-3): a shortened floor never ends a phone between two healthy beats. */
export type Ask10Phone = { hasCurrentPairing: boolean; lastBeatAt: Date | null; answeredPollSeconds: number; heardGoLive: boolean };

/** Ask 10's cadence (§6.8.3): what the phone was answered, capped at an open session's once it has heard go-live. */
const ask10CadenceSeconds = (p: Ask10Phone): number =>
  (p.heardGoLive ? Math.min(p.answeredPollSeconds, OPEN_SESSION_MAX_POLL_SECONDS) : p.answeredPollSeconds);

export function warmingPhoneLost(i: { state: SessionState; firstIngestAt: Date | null } & Ask10Phone, now: Date, floorSeconds: number): boolean {
  if (i.firstIngestAt !== null || !PRE_VIDEO.includes(i.state)) return false;
  if (!i.hasCurrentPairing) return true;
  if (i.lastBeatAt === null) throw new RangeError("warmingPhoneLost: a current pairing always has lastBeatAt (last_beat_at is NOT NULL)");
  return isSilent(i.lastBeatAt, ask10CadenceSeconds(i), now, floorSeconds);
}

/** W19 (§6.8.5): all three — no beat for lostMinutes (from first ingest if none), a fresh read not connected, and no
 *  connected sample for lostMinutes (from first ingest if none). Both clocks, never one. */
export function livePhoneLost(i: {
  state: SessionState; firstIngestAt: Date | null; phoneBeatAt: Date | null;
  freshReadConnected: boolean; lastConnectedSampleAt: Date | null;
}, now: Date, lostMinutes: number): boolean {
  if (i.firstIngestAt === null || !LIVE_FOR_W19.includes(i.state)) return false;
  const limitMs = lostMinutes * 60_000;
  const beatAge = since(i.phoneBeatAt ?? i.firstIngestAt, now);
  const videoAge = since(i.lastConnectedSampleAt ?? i.firstIngestAt, now);
  return beatAge >= limitMs && !i.freshReadConnected && videoAge >= limitMs;
}

/** R2008 (owner ruling 2026-10-19, "apply your rec"): whether the phone has been silent for `lostMinutes` — timed from its
 *  last beat, else from `floorAt` (W19's own fallback: the first sign the stream was up). With neither there is nothing to
 *  time it from, so it cannot be judged silent (false, never true). */
export function phoneSilentFor(phoneBeatAt: Date | null, floorAt: Date | null, now: Date, lostMinutes: number): boolean {
  const from = phoneBeatAt ?? floorAt;
  return from !== null && since(from, now) >= lostMinutes * 60_000;
}

/** R2008: the composed analogue of W19's first two clauses — the camera is GONE. A composed session never records first
 *  ingest (only the passthrough poll writes it) and records no connected samples, so the evidence is the COMPOSITOR's own:
 *  the `programmePhase` of its beats, as the beat route logged each change (`programme_phase` events).
 *  - `liveOnceAt`: the first beat that reported `live`. A stream that never had a camera is not judged here — its end is
 *    `composedNeverLive`'s. It is also the floor the phone's silence falls back to.
 *  - `reconnectingSince`: when the camera's OUTAGE began — the start of the unbroken run of `reconnecting`/`waiting` phases
 *    that the CURRENT attempt's latest phase closes; null while the latest phase is anything else (`live`, none reported) or
 *    was last written by a superseded attempt. `waiting` counts like `reconnecting` (review I2): a compositor restarted
 *    during an outage (a replacement attempt) opens on `waiting`, and the camera is exactly as gone. A camera that returns at
 *    any minute resets the clock: the phase left the run (`live`).
 *  Both clocks must reach `lostMinutes`, as W19's must. Only a `live` session is judged: composed `warming` is the Machine
 *  booting (ask 10's), `ending` is already stopping. */
export function composedCameraGone(i: {
  state: SessionState; phoneBeatAt: Date | null; liveOnceAt: Date | null; reconnectingSince: Date | null;
}, now: Date, lostMinutes: number): boolean {
  if (i.state !== "live" || i.liveOnceAt === null || i.reconnectingSince === null) return false;
  return phoneSilentFor(i.phoneBeatAt, i.liveOnceAt, now, lostMinutes) && since(i.reconnectingSince, now) >= lostMinutes * 60_000;
}

/** R2008: the composed W19 — the camera is gone AND a fresh read of the camera's input (A) says it is not publishing.
 *  The read is the third clause, as in W19: the compositor's own `input` word can cycle back to `connected` while the
 *  camera is gone (Cloudflare sends no event when a source stops), so only Cloudflare's reading of A can say the phone is
 *  still pushing video. */
export function composedCameraLost(i: {
  state: SessionState; phoneBeatAt: Date | null; liveOnceAt: Date | null; reconnectingSince: Date | null; freshReadConnected: boolean;
}, now: Date, lostMinutes: number): boolean {
  return composedCameraGone(i, now, lostMinutes) && !i.freshReadConnected;
}

/** R2008 (review minor): whether the compositor's evidence about the camera can decide ANYTHING — the one gate in front of
 *  the facts query. Both rules need a LIVE session, and the latest phase the compositor stored must be one a rule reads:
 *  `waiting` (the never-live rule, and a restarted compositor's outage) or `reconnecting` (the camera-gone rule). Any other
 *  stored phase — `live`, `frozen`, `final`, none, one this build does not know — means the camera is in, or nothing is
 *  said, so no rule can fire and the query is not made. */
export function cameraEvidenceMatters(i: { state: SessionState; storedPhase: string | null }): boolean {
  return i.state === "live" && (i.storedPhase === "waiting" || i.storedPhase === "reconnecting");
}

/** R2008 (review minor): whether a beat's phase is worth a `programme_phase` row, given the last row logged for the session
 *  (`to`, `attempt`; null = none) and the attempt that beat belongs to. A row is written for what a rule reads — a phase
 *  CHANGE the log does not already hold, and a break in a run — and for nothing else:
 *  - not a repeat of the phase the log holds (a blip back to it after a `frozen`);
 *  - not `frozen` out of `live` (the half-second hold a flickering camera makes over and over: not an outage — and it is the
 *    only toggle that can grow the table without bound); a `frozen` after any OTHER logged phase is a row, because it ends
 *    that run (the compositor's table cannot do it, and a compositor bug must never extend an outage);
 *  - not a second 'no phase', and not a first one when nothing was ever logged (a compositor that reports none writes none);
 *  - always a new attempt's first row (its beat is another process's: a phase the log holds from a predecessor is no claim
 *    about THIS Machine's camera). */
export function programmePhaseRowMatters(phase: string | null, last: { to: string | null; attempt: number | null } | null, attempt: number): boolean {
  if (last === null) return phase !== null;
  if (phase === null && last.to === null) return false;
  if (last.attempt !== attempt) return true;
  if (phase === last.to) return false;
  if (phase === "frozen" && last.to === "live") return false;
  return true;
}

/** R2008 (owner ruling 2026-10-19): a COMPOSED session went live — the first `playing` beat, which is where the credit is
 *  taken — and its camera NEVER appeared: no `live` programme phase from any attempt, for `lostMinutes` counted from when
 *  the session went live. The viewer never saw video, so the stream is cancelled and the credit returned (a different end
 *  from `composedCameraLost`: there is no camera to have lost, so no phone-silence clause and no read of the camera's input —
 *  a phone that beats and a camera Cloudflare sees but the compositor never published still shows the viewer nothing).
 *  What "never" is made of, from the `programme_phase` log:
 *  - `liveOnceAt` null — no beat of any attempt ever said `live`.
 *  - `waitedOnly` — the log holds `waiting` and nothing else. Any other phase (`reconnecting` is reachable only from `live`,
 *    and a beat that reported none ends a run) means the camera WAS in, or the log is not the whole story.
 *  - the log began with the session (`logBeganAt` no later than one composed stale-beat window after `startedAt`): the first
 *    beat that makes a session live is also the first to log a phase, so a log that begins later belongs to a session that
 *    was already running when the log did (a deploy mid-broadcast, whose camera we then know nothing of) and is not judged.
 *  A compositor that never reports a phase (an older image) has no log at all, and nothing is judged. */
function neverLiveArmed(i: { state: SessionState; startedAt: Date | null; liveOnceAt: Date | null; waitedOnly: boolean; logBeganAt: Date | null }): i is typeof i & { startedAt: Date } {
  if (i.state !== "live" || i.startedAt === null || i.liveOnceAt !== null || !i.waitedOnly || i.logBeganAt === null) return false;
  return i.logBeganAt.getTime() - i.startedAt.getTime() <= STALE_HEARTBEAT_SECONDS_COMPOSED * 1000;
}

export function composedNeverLive(i: {
  state: SessionState; startedAt: Date | null; liveOnceAt: Date | null; waitedOnly: boolean; logBeganAt: Date | null;
}, now: Date, lostMinutes: number): boolean {
  return neverLiveArmed(i) && since(i.startedAt, now) >= lostMinutes * 60_000;
}

/** The countdown names the end it counts to (controller ruling 2026-10-04): `live` W19's, or — composed (R2008) — the
 *  never-live cancellation; `warming` the warming timeout or ask 10's, whichever lands first. elapsedMs is the silence that
 *  end is timed from: since warming entry for the timeout, since the last beat for ask 10, the shorter of the two silences
 *  for W19 (and for the composed camera-gone), since the session went live for never-live. */
export type LostCountdown =
  | { kind: "live"; reason: "phone_lost" | "camera_never_live"; elapsedMs: number; remainingMs: number }
  | { kind: "warming"; reason: "no_inbound_timeout" | "phone_lost"; elapsedMs: number; remainingMs: number };

type Word = "connected" | "disconnected" | "unknown";
/** What THIS tick read of the phone's input (stream-sessions.ts `TickObservation`), the reading its ends were judged on.
 *  - `fresh`: the word W19 judges, a claimed read's own or a coalesced sample young enough to stand for one; undefined =
 *    none (a failed read, a no-evidence read, an older sample).
 *  - `served`: the word `current.ingest` carries, fresh or carried by a no-evidence read (G-a); null = no word at all.
 *  - `failed`: this tick's STATUS read threw (N1). A read that threw has no fresh word. */
export type CountdownRead = { fresh: Word | undefined; served: Word | null; failed: boolean };

/** W24: the panel's countdown, on the server clock. null = nothing to show. Controller rulings 2026-10-04: a countdown
 *  shows IF AND ONLY IF the end it counts down to will fire at that deadline, and it names the EARLIEST end that will
 *  fire, with that end's reason. Each end is gated on exactly what it reads, and on nothing else.
 *  - live (first ingest set, live or a warming reconnect): W19's end, only on a FRESH `disconnected` (B7 review I-1).
 *    W19 needs a fresh read that is not connected and not unknown (m-3), so an `unknown` word, a carried word, a failed
 *    read and a connected input show nothing. After `quietSeconds` with no video AND no beat it counts down from the
 *    SHORTER of the two silences, because W19 needs both (§6.12). While the phone still beats (inside the quiet hold)
 *    W19 cannot fire, so there is no countdown (O5).
 *  - warming (no video yet), the earlier of two ends; a tie goes to the timeout, because the tick expires before it
 *    judges ask 10:
 *    - the warming timeout at warmingAt + warmingMinutes, shown after `quietSeconds` in warming. It fires whatever the
 *      WORD (M-4), so it is withheld only by a status read that THREW (N1: `heldByUnknownIngest` holds it).
 *    - ask 10 at the last beat + §6.9's silence threshold, once beats have STOPPED: no beat for the longer of the
 *      phone's own cadence plus one near poll (a beat it owed is missing, not merely in flight) and `quietSeconds`
 *      (O5's measure of a phone gone quiet). It reads
 *      no ingest word. A pairing that is no longer current owes it now (the next tick makes it): 0 and 0, since there
 *      is no beat to time it from.
 *    A `connected` word shows neither: the observation takes the session live instead.
 *  remainingMs never goes below 0: past the end, the next tick makes it. */
export function lostCountdown(i: {
  state: SessionState; firstIngestAt: Date | null; warmingAt: Date | null; phoneBeatAt: Date | null;
  read: CountdownRead; lastConnectedSampleAt: Date | null; phone: Ask10Phone;
  /** R2008: a COMPOSED session's camera facts (`cameraFactsOf`); absent or null for a passthrough one. */
  camera?: ComposedCountdownCamera | null;
}, now: Date, cfg: { lostMinutes: number; warmingMinutes: number; quietSeconds: number; silentFloorSeconds: number }): LostCountdown | null {
  if (i.read.failed && i.read.fresh !== undefined) throw new RangeError("lostCountdown: a status read that threw has no fresh word");
  const quietMs = cfg.quietSeconds * 1000;
  if (i.camera) return composedCountdown({ ...i.camera, state: i.state, phoneBeatAt: i.phoneBeatAt, read: i.read }, now, cfg.lostMinutes, quietMs);
  if (i.firstIngestAt !== null) {
    if (!LIVE_FOR_W19.includes(i.state) || i.read.fresh !== "disconnected") return null;
    const beatAge = since(i.phoneBeatAt ?? i.firstIngestAt, now);
    const videoAge = since(i.lastConnectedSampleAt ?? i.firstIngestAt, now);
    const elapsedMs = Math.min(beatAge, videoAge);
    if (elapsedMs < quietMs) return null;
    return { kind: "live", reason: "phone_lost", elapsedMs, remainingMs: Math.max(0, cfg.lostMinutes * 60_000 - elapsedMs) };
  }
  if (i.state !== "warming" || i.warmingAt === null) return null;   // a pre-V430 row has no warming_at: show nothing
  if (i.read.served === "connected") return null;
  const warmingElapsed = since(i.warmingAt, now);
  const timeoutLeft = i.read.failed ? null : Math.max(0, cfg.warmingMinutes * 60_000 - warmingElapsed);   // null: N1 holds it
  const ask10 = ask10Countdown(i.phone, now, cfg);
  if (ask10 !== null && (timeoutLeft === null || ask10.remainingMs < timeoutLeft)) return { kind: "warming", reason: "phone_lost", ...ask10 };
  if (timeoutLeft === null || warmingElapsed < quietMs) return null;
  return { kind: "warming", reason: "no_inbound_timeout", elapsedMs: warmingElapsed, remainingMs: timeoutLeft };
}

/** The compositor's evidence about a composed session's camera, as the countdown needs it — `cameraFactsOf`'s columns. */
export type ComposedCountdownCamera = {
  startedAt: Date | null; liveOnceAt: Date | null; reconnectingSince: Date | null; waitedOnly: boolean; logBeganAt: Date | null;
};

/** R2008, I1: W24 for a composed session — shown IF AND ONLY IF the end it counts to will fire at that deadline, and named
 *  by that end. Two ends, mutually exclusive on `liveOnceAt`:
 *  - never live (`composedNeverLive`): from the quiet hold after the session went live, counting `lostMinutes` from then.
 *    It reads no word and no phone, so the countdown needs neither.
 *  - camera gone (`composedCameraLost`): only on a FRESH `disconnected` read, as W19's (m-3 — `connected`, `unknown`, a
 *    carried word and a failed read show nothing), counting from the SHORTER of the phone's silence and the reconnecting run
 *    because the end needs both, and only past the quiet hold on that shorter one (O5: a phone that still beats cannot be
 *    ended). remainingMs never goes below 0: past the end, the next tick makes it. */
function composedCountdown(i: ComposedCountdownCamera & { state: SessionState; phoneBeatAt: Date | null; read: CountdownRead }, now: Date, lostMinutes: number, quietMs: number): LostCountdown | null {
  const limitMs = lostMinutes * 60_000;
  if (neverLiveArmed(i)) {
    const elapsedMs = since(i.startedAt, now);
    return elapsedMs < quietMs ? null : { kind: "live", reason: "camera_never_live", elapsedMs, remainingMs: Math.max(0, limitMs - elapsedMs) };
  }
  const elapsedMs = cameraGoneElapsedMs(i, now);
  if (elapsedMs === null || elapsedMs < quietMs || i.read.fresh !== "disconnected") return null;
  return { kind: "live", reason: "phone_lost", elapsedMs, remainingMs: Math.max(0, limitMs - elapsedMs) };
}

/** The silence the composed camera-gone end is timed from: the SHORTER of the phone's silence and the outage (the end needs
 *  both), null when there is no outage to time — not live, never live, or the latest phase is not an outage's. The ONE
 *  measure the countdown and the tick's read share. */
function cameraGoneElapsedMs(i: { state: SessionState; phoneBeatAt: Date | null; liveOnceAt: Date | null; reconnectingSince: Date | null }, now: Date): number | null {
  if (i.state !== "live" || i.liveOnceAt === null || i.reconnectingSince === null) return null;
  return Math.min(since(i.phoneBeatAt ?? i.liveOnceAt, now), since(i.reconnectingSince, now));
}

/** R2008, I1: whether the tick should READ the camera's input (A) — from the moment the camera-gone countdown arms (the
 *  quiet hold on the shorter clock), not only at the limit: the countdown shows on a FRESH `disconnected` word and no other,
 *  so the word has to be there for it to show. A healthy stream (`live`, no outage) is never read. */
export function composedCameraWatched(i: { state: SessionState; phoneBeatAt: Date | null; liveOnceAt: Date | null; reconnectingSince: Date | null }, now: Date, quietSeconds: number): boolean {
  const elapsedMs = cameraGoneElapsedMs(i, now);
  return elapsedMs !== null && elapsedMs >= quietSeconds * 1000;
}

/** How late an owed beat runs before it counts as missing (B7 re-review m-a): one near poll. Without it a far-cadence
 *  phone's go-live beat, due one cadence after its last, armed a countdown for its round trip right after Go live. */
const BEAT_LATE_SECONDS = POLL_NEAR_SECONDS;

/** Ask 10's countdown once it is armed (see lostCountdown), else null. */
function ask10Countdown(p: Ask10Phone, now: Date, cfg: { quietSeconds: number; silentFloorSeconds: number }): { elapsedMs: number; remainingMs: number } | null {
  if (!p.hasCurrentPairing) return { elapsedMs: 0, remainingMs: 0 };
  if (p.lastBeatAt === null) throw new RangeError("lostCountdown: a current pairing always has lastBeatAt (last_beat_at is NOT NULL)");
  const cadence = ask10CadenceSeconds(p);
  const beatAge = since(p.lastBeatAt, now);
  if (beatAge < Math.max(cfg.quietSeconds, cadence + BEAT_LATE_SECONDS) * 1000) return null;
  return { elapsedMs: beatAge, remainingMs: Math.max(0, silentAfterMs(cadence, cfg.silentFloorSeconds) - beatAge) };
}
