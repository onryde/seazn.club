// Capture QR v2 §6.8.3 (ask 10), §6.8.5 (W19) and §6.12 (W24, O5) — domain/phone-lost.ts. Pure: `now` passed in.
// Every threshold is computed from the declared constants (AGENTS.md #19).
import { describe, expect, it } from "vitest";
import {
  PHONE_LOST_LIVE_MINUTES, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS, POLL_FAR_SECONDS, POLL_NEAR_SECONDS,
  POLL_STARTING_SECONDS, RECONNECT_QUIET_SECONDS, WARMING_TIMEOUT_MINUTES,
} from "../../config";
import { livePhoneLost, lostCountdown, warmingPhoneLost } from "../phone-lost";

const NOW = new Date("2026-10-01T12:00:00Z");
const S = 1000, MIN = 60_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const LOST_MS = PHONE_LOST_LIVE_MINUTES * MIN;
const QUIET_MS = RECONNECT_QUIET_SECONDS * S;

describe("warmingPhoneLost — ask 10 (§6.8.3)", () => {
  const warming = { state: "warming" as const, firstIngestAt: null, hasCurrentPairing: true, lastBeatAt: NOW, answeredPollSeconds: POLL_NEAR_SECONDS, heardGoLive: true };
  const silentAfter = (c: number): number => Math.max(PHONE_SILENT_FLOOR_SECONDS, c + PHONE_SILENT_SLACK_SECONDS) * S;

  it("the empty case first: a phone that just beat, on a session that never had video, is not lost", () => {
    expect(warmingPhoneLost(warming, NOW)).toBe(false);
  });

  it("no current pairing → lost, in each pre-video state", () => {
    for (const state of ["requested", "provisioning", "warming"] as const) {
      expect(warmingPhoneLost({ ...warming, state, hasCurrentPairing: false, lastBeatAt: null }, NOW), state).toBe(true);
    }
  });

  it("not yet heard go-live: silent at max(floor, cadence + slack) for each cadence — 1 ms short is not lost", () => {
    let checked = 0;
    for (const c of [POLL_STARTING_SECONDS, POLL_NEAR_SECONDS, POLL_FAR_SECONDS]) {
      const i = { ...warming, heardGoLive: false, answeredPollSeconds: c };
      expect(warmingPhoneLost({ ...i, lastBeatAt: ago(silentAfter(c) - 1) }, NOW), `${c}s short`).toBe(false);
      expect(warmingPhoneLost({ ...i, lastBeatAt: ago(silentAfter(c)) }, NOW), `${c}s at`).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a 60 s-cadence phone that has not heard go-live is NOT ended at 60 s, and IS ended at 90 s", () => {
    const i = { ...warming, heardGoLive: false, answeredPollSeconds: POLL_FAR_SECONDS };
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(60 * S) }, NOW)).toBe(false);
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(90 * S) }, NOW)).toBe(true);
  });

  it("a phone that has heard go-live beats at least every 10 s, so silent is exactly the floor (ask 10's 60 s)", () => {
    const i = { ...warming, heardGoLive: true, answeredPollSeconds: POLL_FAR_SECONDS };
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(PHONE_SILENT_FLOOR_SECONDS * S - 1) }, NOW)).toBe(false);
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(PHONE_SILENT_FLOOR_SECONDS * S) }, NOW)).toBe(true);
  });

  it("first_ingest_at set → never (that is W19's case), however silent and even with no pairing", () => {
    expect(warmingPhoneLost({ ...warming, firstIngestAt: ago(MIN), lastBeatAt: ago(LOST_MS * 4) }, NOW)).toBe(false);
    expect(warmingPhoneLost({ ...warming, firstIngestAt: ago(MIN), hasCurrentPairing: false, lastBeatAt: null }, NOW)).toBe(false);
  });

  it("only requested, provisioning and warming are checked: ending, live, completed and failed never are", () => {
    for (const state of ["ending", "live", "completed", "failed"] as const) {
      expect(warmingPhoneLost({ ...warming, state, hasCurrentPairing: false, lastBeatAt: null }, NOW), state).toBe(false);
    }
  });

  it("the floor is a parameter, so tunable() can shorten it (§6.15)", () => {
    expect(warmingPhoneLost({ ...warming, lastBeatAt: ago(5 * S) }, NOW)).toBe(false);
    expect(warmingPhoneLost({ ...warming, lastBeatAt: ago(5 * S) }, NOW, 5)).toBe(true);
  });

  it("a current pairing with no last beat is refused by name (the column is NOT NULL)", () => {
    expect(() => warmingPhoneLost({ ...warming, lastBeatAt: null }, NOW)).toThrow(/lastBeatAt/);
  });
});

describe("livePhoneLost — W19 (§6.8.5), both clocks and a fresh read", () => {
  const lost = { state: "live" as const, firstIngestAt: ago(LOST_MS * 2), phoneBeatAt: ago(LOST_MS), freshReadConnected: false, lastConnectedSampleAt: ago(LOST_MS) };

  it("all three conjuncts at exactly PHONE_LOST_LIVE_MINUTES → lost", () => {
    expect(livePhoneLost(lost, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(true);
  });

  it("each clock 1 s short, alone → not lost (three cases: the beat, the video, and both falling back to first ingest)", () => {
    expect(livePhoneLost({ ...lost, phoneBeatAt: ago(LOST_MS - S) }, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(false);
    expect(livePhoneLost({ ...lost, lastConnectedSampleAt: ago(LOST_MS - S) }, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(false);
    expect(livePhoneLost({ ...lost, phoneBeatAt: null, lastConnectedSampleAt: null, firstIngestAt: ago(LOST_MS - S) }, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(false);
  });

  it("a fresh read that says connected → not lost (the phone still pushes video)", () => {
    expect(livePhoneLost({ ...lost, freshReadConnected: true }, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(false);
  });

  it("first_ingest_at null → not lost (that is ask 10's case)", () => {
    expect(livePhoneLost({ ...lost, firstIngestAt: null }, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(false);
  });

  it("phoneBeatAt null falls back to first ingest: an old first ingest is lost, a recent one is not", () => {
    expect(livePhoneLost({ ...lost, phoneBeatAt: null }, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(true);
    expect(livePhoneLost({ ...lost, phoneBeatAt: null, firstIngestAt: ago(LOST_MS - S), lastConnectedSampleAt: ago(LOST_MS) }, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(false);
  });

  it("warming with first ingest is a reconnect (still live for W19); ending, requested and completed are never checked", () => {
    expect(livePhoneLost({ ...lost, state: "warming" }, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(true);
    for (const state of ["ending", "requested", "provisioning", "completed", "failed"] as const) {
      expect(livePhoneLost({ ...lost, state }, NOW, PHONE_LOST_LIVE_MINUTES), state).toBe(false);
    }
  });

  it("lostMinutes is the parameter, not the constant: at 1 minute, a 1-minute silence is lost", () => {
    const short = { ...lost, phoneBeatAt: ago(MIN), lastConnectedSampleAt: ago(MIN) };
    expect(livePhoneLost(short, NOW, PHONE_LOST_LIVE_MINUTES)).toBe(false);
    expect(livePhoneLost(short, NOW, 1)).toBe(true);
  });
});

describe("lostCountdown — W24 on the server clock (§6.12, O5)", () => {
  const cfg = { lostMinutes: PHONE_LOST_LIVE_MINUTES, warmingMinutes: WARMING_TIMEOUT_MINUTES, quietSeconds: RECONNECT_QUIET_SECONDS };
  const live = (beatMs: number, videoMs: number) => ({
    state: "live" as const, firstIngestAt: ago(LOST_MS * 2), warmingAt: ago(LOST_MS * 3), phoneBeatAt: ago(beatMs),
    ingestConnected: false, lastConnectedSampleAt: ago(videoMs),
  });

  it("the empty case first: the input is connected → null (live and warming alike)", () => {
    expect(lostCountdown({ ...live(LOST_MS, LOST_MS), ingestConnected: true }, NOW, cfg)).toBeNull();
    expect(lostCountdown({ state: "warming", firstIngestAt: null, warmingAt: ago(5 * MIN), phoneBeatAt: null, ingestConnected: true, lastConnectedSampleAt: null }, NOW, cfg)).toBeNull();
  });

  it("live, no video and no beat for RECONNECT_QUIET_SECONDS − 1 s → null; at the quiet hold → the countdown", () => {
    expect(lostCountdown(live(QUIET_MS - S, QUIET_MS - S), NOW, cfg)).toBeNull();
    expect(lostCountdown(live(QUIET_MS, QUIET_MS), NOW, cfg)).toEqual({ kind: "live", elapsedMs: QUIET_MS, remainingMs: LOST_MS - QUIET_MS });
  });

  it("O5: video gone 10 min while the phone still beats (inside the quiet hold) → null — W19 cannot fire", () => {
    expect(lostCountdown(live(QUIET_MS - S, 10 * MIN), NOW, cfg)).toBeNull();
    expect(lostCountdown(live(5 * S, 10 * MIN), NOW, cfg)).toBeNull();
  });

  it("§6.12's rule, not the brief's example: a beat 2 min ago is past the quiet hold, so it counts down from the 2-min silence", () => {
    expect(lostCountdown(live(2 * MIN, 10 * MIN), NOW, cfg)).toEqual({ kind: "live", elapsedMs: 2 * MIN, remainingMs: LOST_MS - 2 * MIN });
  });

  it("ordering differential: beat 12 min, video 9 min → elapsed is the SHORTER silence (9 min); the longer would say 12", () => {
    const c = lostCountdown(live(12 * MIN, 9 * MIN), NOW, cfg);
    expect(c).toEqual({ kind: "live", elapsedMs: 9 * MIN, remainingMs: LOST_MS - 9 * MIN });
    expect(c!.elapsedMs).not.toBe(12 * MIN);
  });

  it("no beat ever and no connected sample: both clocks run from first ingest", () => {
    const i = { ...live(0, 0), phoneBeatAt: null, lastConnectedSampleAt: null, firstIngestAt: ago(3 * MIN) };
    expect(lostCountdown(i, NOW, cfg)).toEqual({ kind: "live", elapsedMs: 3 * MIN, remainingMs: LOST_MS - 3 * MIN });
  });

  it("a warming reconnect (first ingest set) counts down like live", () => {
    expect(lostCountdown({ ...live(MIN, MIN), state: "warming" }, NOW, cfg)).toEqual({ kind: "live", elapsedMs: MIN, remainingMs: LOST_MS - MIN });
  });

  it("past W19's end but not yet ticked: remaining is 0, never negative", () => {
    expect(lostCountdown(live(LOST_MS + MIN, LOST_MS + MIN), NOW, cfg)).toEqual({ kind: "live", elapsedMs: LOST_MS + MIN, remainingMs: 0 });
  });

  it("lostMinutes is read from cfg: at 1 minute, a 30 s silence leaves 30 s", () => {
    expect(lostCountdown(live(QUIET_MS, QUIET_MS), NOW, { ...cfg, lostMinutes: 1 })).toEqual({ kind: "live", elapsedMs: QUIET_MS, remainingMs: MIN - QUIET_MS });
  });

  describe("warming (no video yet)", () => {
    const warming = (sinceMs: number | null) => ({
      state: "warming" as const, firstIngestAt: null, warmingAt: sinceMs === null ? null : ago(sinceMs), phoneBeatAt: ago(S),
      ingestConnected: false, lastConnectedSampleAt: null,
    });
    const WARMING_MS = WARMING_TIMEOUT_MINUTES * MIN;

    it("30 s after warmingAt → warming, remaining = warmingAt + WARMING_TIMEOUT_MINUTES − now; 1 s short → null", () => {
      expect(lostCountdown(warming(QUIET_MS - S), NOW, cfg)).toBeNull();
      expect(lostCountdown(warming(QUIET_MS), NOW, cfg)).toEqual({ kind: "warming", elapsedMs: QUIET_MS, remainingMs: WARMING_MS - QUIET_MS });
    });

    it("past the warming deadline but not yet failed: remaining is 0", () => {
      expect(lostCountdown(warming(WARMING_MS + S), NOW, cfg)).toEqual({ kind: "warming", elapsedMs: WARMING_MS + S, remainingMs: 0 });
    });

    it("a session from before V430 (warming_at null) shows nothing rather than a guessed clock", () => {
      expect(lostCountdown(warming(null), NOW, cfg)).toBeNull();
    });

    it("requested, provisioning, ending and the terminal states never count down", () => {
      for (const state of ["requested", "provisioning", "ending", "completed", "failed"] as const) {
        expect(lostCountdown({ ...warming(5 * MIN), state }, NOW, cfg), state).toBeNull();
        expect(lostCountdown({ ...live(5 * MIN, 5 * MIN), state }, NOW, cfg), `${state} with ingest`).toBeNull();
      }
    });
  });
});
