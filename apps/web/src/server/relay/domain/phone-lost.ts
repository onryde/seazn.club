// Capture QR v2 §6.8.3 (ask 10), §6.8.5 (W19) and §6.12 (W24, O5): when a session's phone is lost, and the panel's
// countdown to that end. Pure: `now` passed in; the tunable timings are REQUIRED parameters (§6.15), never the
// environment and never a default, so tsc forces each use-case call site to pass `tunable(…)`.
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

/** The countdown names the end it counts to (controller ruling 2026-10-04): `live` only W19's; `warming` the warming
 *  timeout or ask 10's, whichever lands first. elapsedMs is the silence that end is timed from: since warming entry for
 *  the timeout, since the last beat for ask 10, the shorter of the two silences for W19. */
export type LostCountdown =
  | { kind: "live"; reason: "phone_lost"; elapsedMs: number; remainingMs: number }
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
 *      phone's own cadence (a beat it owed is missing) and `quietSeconds` (O5's measure of a phone gone quiet). It reads
 *      no ingest word. A pairing that is no longer current owes it now (the next tick makes it): 0 and 0, since there
 *      is no beat to time it from.
 *    A `connected` word shows neither: the observation takes the session live instead.
 *  remainingMs never goes below 0: past the end, the next tick makes it. */
export function lostCountdown(i: {
  state: SessionState; firstIngestAt: Date | null; warmingAt: Date | null; phoneBeatAt: Date | null;
  read: CountdownRead; lastConnectedSampleAt: Date | null; phone: Ask10Phone;
}, now: Date, cfg: { lostMinutes: number; warmingMinutes: number; quietSeconds: number; silentFloorSeconds: number }): LostCountdown | null {
  if (i.read.failed && i.read.fresh !== undefined) throw new RangeError("lostCountdown: a status read that threw has no fresh word");
  const quietMs = cfg.quietSeconds * 1000;
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

/** Ask 10's countdown once it is armed (see lostCountdown), else null. */
function ask10Countdown(p: Ask10Phone, now: Date, cfg: { quietSeconds: number; silentFloorSeconds: number }): { elapsedMs: number; remainingMs: number } | null {
  if (!p.hasCurrentPairing) return { elapsedMs: 0, remainingMs: 0 };
  if (p.lastBeatAt === null) throw new RangeError("lostCountdown: a current pairing always has lastBeatAt (last_beat_at is NOT NULL)");
  const cadence = ask10CadenceSeconds(p);
  const beatAge = since(p.lastBeatAt, now);
  if (beatAge < Math.max(cfg.quietSeconds, cadence) * 1000) return null;
  return { elapsedMs: beatAge, remainingMs: Math.max(0, silentAfterMs(cadence, cfg.silentFloorSeconds) - beatAge) };
}
