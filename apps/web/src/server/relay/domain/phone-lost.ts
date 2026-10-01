// Capture QR v2 §6.8.3 (ask 10), §6.8.5 (W19) and §6.12 (W24, O5): when a session's phone is lost, and the panel's
// countdown to that end. Pure: `now` passed in; the tunable timings are parameters (§6.15), never the environment.
import { PHONE_SILENT_FLOOR_SECONDS } from "../config";
import { isSilent } from "./pairing";
import type { SessionState } from "./session";

const since = (at: Date, now: Date): number => now.getTime() - at.getTime();
const PRE_VIDEO: readonly SessionState[] = ["requested", "provisioning", "warming"];
/** §5.4: `warming` with first ingest is a reconnect, still live for W19 and W24. `ending` is already stopping. */
const LIVE_FOR_W19: readonly SessionState[] = ["live", "warming"];

/** Ask 10 (§6.8.3): a session that never received ingest, in requested/provisioning/warming, whose phone is silent
 *  (§6.9) or which no longer has a current pairing, is ended `phone_lost` (no credit is spent). A phone that has heard
 *  go-live beats at least every 10 s, so its silence is exactly the floor; one that has not is still on its waiting
 *  cadence, so its clock is max(floor, cadence + slack) and an organiser Go live is never ended before it could hear. */
export function warmingPhoneLost(i: {
  state: SessionState; firstIngestAt: Date | null; hasCurrentPairing: boolean;
  lastBeatAt: Date | null; answeredPollSeconds: number; heardGoLive: boolean;
}, now: Date, floorSeconds: number = PHONE_SILENT_FLOOR_SECONDS): boolean {
  if (i.firstIngestAt !== null || !PRE_VIDEO.includes(i.state)) return false;
  if (!i.hasCurrentPairing) return true;
  if (i.lastBeatAt === null) throw new RangeError("warmingPhoneLost: a current pairing always has lastBeatAt (last_beat_at is NOT NULL)");
  return i.heardGoLive ? since(i.lastBeatAt, now) >= floorSeconds * 1000 : isSilent(i.lastBeatAt, i.answeredPollSeconds, now, floorSeconds);
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

export type LostCountdown = { kind: "warming" | "live"; elapsedMs: number; remainingMs: number };

/** W24: the panel's countdown, on the server clock. null = nothing to show.
 *  - live (first ingest set, live or a warming reconnect): after `quietSeconds` with no video AND no beat, it counts
 *    down to W19's end from the SHORTER of the two silences, because W19 needs both (§6.12). While the phone still
 *    beats (inside the quiet hold) W19 cannot fire, so there is no countdown (O5).
 *  - warming (no video yet): after `quietSeconds` in warming, it counts down to warmingAt + warmingMinutes.
 *  remainingMs never goes below 0: past the end, the next tick ends the session. */
export function lostCountdown(i: {
  state: SessionState; firstIngestAt: Date | null; warmingAt: Date | null; phoneBeatAt: Date | null;
  ingestConnected: boolean; lastConnectedSampleAt: Date | null;
}, now: Date, cfg: { lostMinutes: number; warmingMinutes: number; quietSeconds: number }): LostCountdown | null {
  if (i.ingestConnected) return null;
  const quietMs = cfg.quietSeconds * 1000;
  if (i.firstIngestAt !== null) {
    if (!LIVE_FOR_W19.includes(i.state)) return null;
    const beatAge = since(i.phoneBeatAt ?? i.firstIngestAt, now);
    const videoAge = since(i.lastConnectedSampleAt ?? i.firstIngestAt, now);
    const elapsedMs = Math.min(beatAge, videoAge);
    if (elapsedMs < quietMs) return null;
    return { kind: "live", elapsedMs, remainingMs: Math.max(0, cfg.lostMinutes * 60_000 - elapsedMs) };
  }
  if (i.state !== "warming" || i.warmingAt === null) return null;   // a pre-V430 row has no warming_at: show nothing
  const elapsedMs = since(i.warmingAt, now);
  if (elapsedMs < quietMs) return null;
  return { kind: "warming", elapsedMs, remainingMs: Math.max(0, cfg.warmingMinutes * 60_000 - elapsedMs) };
}
