// Capture QR v2 §6.8.3 (ask 10), §6.8.5 (W19) and §6.12 (W24, O5) — domain/phone-lost.ts. Pure: `now` passed in.
// Every threshold is computed from the declared constants (AGENTS.md #19).
import { describe, expect, it } from "vitest";
import {
  PHONE_LOST_LIVE_MINUTES, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS, POLL_FAR_SECONDS, POLL_NEAR_SECONDS,
  POLL_STARTING_SECONDS, RECONNECT_QUIET_SECONDS, WARMING_TIMEOUT_MINUTES,
} from "../../config";
import { type CountdownRead, livePhoneLost, lostCountdown, warmingPhoneLost } from "../phone-lost";
import { OPEN_SESSION_MAX_POLL_SECONDS, pollSecondsFor } from "../poll-seconds";
import { ACTIVE_STATES } from "../session";

const NOW = new Date("2026-10-01T12:00:00Z");
const S = 1000, MIN = 60_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const LOST_MS = PHONE_LOST_LIVE_MINUTES * MIN;
const QUIET_MS = RECONNECT_QUIET_SECONDS * S;
const FLOOR = PHONE_SILENT_FLOOR_SECONDS;
/** The cadence an OPEN session is answered at, read from the §6.6 table itself (every active state, no window). */
const OPEN_CADENCES = [...new Set(ACTIVE_STATES.map((open) => pollSecondsFor({ open, fixtureStatus: "scheduled", scheduledAt: null, finished: false }, NOW)))];

describe("warmingPhoneLost — ask 10 (§6.8.3)", () => {
  const warming = { state: "warming" as const, firstIngestAt: null, hasCurrentPairing: true, lastBeatAt: NOW, answeredPollSeconds: POLL_NEAR_SECONDS, heardGoLive: true };
  const silentAfter = (c: number): number => Math.max(PHONE_SILENT_FLOOR_SECONDS, c + PHONE_SILENT_SLACK_SECONDS) * S;

  it("the empty case first: a phone that just beat, on a session that never had video, is not lost", () => {
    expect(warmingPhoneLost(warming, NOW, FLOOR)).toBe(false);
  });

  it("no current pairing → lost, in each pre-video state", () => {
    for (const state of ["requested", "provisioning", "warming"] as const) {
      expect(warmingPhoneLost({ ...warming, state, hasCurrentPairing: false, lastBeatAt: null }, NOW, FLOOR), state).toBe(true);
    }
  });

  it("not yet heard go-live: silent at max(floor, cadence + slack) for each cadence — 1 ms short is not lost", () => {
    let checked = 0;
    for (const c of [POLL_STARTING_SECONDS, POLL_NEAR_SECONDS, POLL_FAR_SECONDS]) {
      const i = { ...warming, heardGoLive: false, answeredPollSeconds: c };
      expect(warmingPhoneLost({ ...i, lastBeatAt: ago(silentAfter(c) - 1) }, NOW, FLOOR), `${c}s short`).toBe(false);
      expect(warmingPhoneLost({ ...i, lastBeatAt: ago(silentAfter(c)) }, NOW, FLOOR), `${c}s at`).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a 60 s-cadence phone that has not heard go-live is NOT ended at 60 s, and IS ended at 90 s", () => {
    const i = { ...warming, heardGoLive: false, answeredPollSeconds: POLL_FAR_SECONDS };
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(60 * S) }, NOW, FLOOR)).toBe(false);
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(90 * S) }, NOW, FLOOR)).toBe(true);
  });

  it("an open session is answered at most every OPEN_SESSION_MAX_POLL_SECONDS — the §6.6 table's own value", () => {
    expect(OPEN_CADENCES.length).toBeGreaterThan(0);
    expect(OPEN_SESSION_MAX_POLL_SECONDS).toBe(Math.max(...OPEN_CADENCES));
  });

  it("a phone that has heard go-live is judged on an open session's cadence, never a stale waiting one: silent at ask 10's 60 s, not at 90 s", () => {
    // In production the go-live answer stores the open cadence, so this pair is a stale row; the cap keeps §6.8.3's
    // "silent is exactly 60 s" for it instead of stretching to the waiting cadence's 90 s.
    const i = { ...warming, heardGoLive: true, answeredPollSeconds: POLL_FAR_SECONDS };
    const at = Math.max(FLOOR, OPEN_SESSION_MAX_POLL_SECONDS + PHONE_SILENT_SLACK_SECONDS) * S;
    expect(at).toBe(60 * S);   // ask 10's number, typed from the spec: the declarations must still produce it
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(at - 1) }, NOW, FLOOR)).toBe(false);
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(at) }, NOW, FLOOR)).toBe(true);
  });

  // I-3 (B3 review; plan §T12: only the floor shortens, PHONE_SILENT_SLACK_SECONDS is not tunable, and the threshold
  // stays max(floor, poll + slack)). T12's walkthroughs run with the floor shortened to seconds. A phone beating on
  // its answered cadence must never be ended between two beats, heard go-live or not.
  it("a SHORTENED floor never ends a healthily beating phone: lost only at max(floor, cadence + slack), heard go-live or not", () => {
    let checked = 0;
    for (const floor of [1, 3, 5]) {
      for (const heardGoLive of [true, false]) {
        for (const c of OPEN_CADENCES) {
          const i = { ...warming, heardGoLive, answeredPollSeconds: c };
          const label = `floor ${floor}s, cadence ${c}s, heard ${heardGoLive}`;
          expect(warmingPhoneLost({ ...i, lastBeatAt: ago((c - 1) * S) }, NOW, floor), `${label}: beat 1 s before the next is due`).toBe(false);
          const at = Math.max(floor, c + PHONE_SILENT_SLACK_SECONDS) * S;
          expect(warmingPhoneLost({ ...i, lastBeatAt: ago(at - 1) }, NOW, floor), `${label}: 1 ms short`).toBe(false);
          expect(warmingPhoneLost({ ...i, lastBeatAt: ago(at) }, NOW, floor), `${label}: at the threshold`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBe(3 * 2 * OPEN_CADENCES.length);
  });

  it("first_ingest_at set → never (that is W19's case), however silent and even with no pairing", () => {
    expect(warmingPhoneLost({ ...warming, firstIngestAt: ago(MIN), lastBeatAt: ago(LOST_MS * 4) }, NOW, FLOOR)).toBe(false);
    expect(warmingPhoneLost({ ...warming, firstIngestAt: ago(MIN), hasCurrentPairing: false, lastBeatAt: null }, NOW, FLOOR)).toBe(false);
  });

  it("only requested, provisioning and warming are checked: ending, live, completed and failed never are", () => {
    for (const state of ["ending", "live", "completed", "failed"] as const) {
      expect(warmingPhoneLost({ ...warming, state, hasCurrentPairing: false, lastBeatAt: null }, NOW, FLOOR), state).toBe(false);
    }
  });

  it("the floor is a parameter, so tunable() can shorten it (§6.15): it moves the threshold down to cadence + slack, no further", () => {
    const i = { ...warming, answeredPollSeconds: POLL_NEAR_SECONDS };
    const cadenceAt = (POLL_NEAR_SECONDS + PHONE_SILENT_SLACK_SECONDS) * S;
    expect(cadenceAt).toBeLessThan(FLOOR * S);   // or a shortened floor could not be witnessed here
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(cadenceAt) }, NOW, FLOOR)).toBe(false);
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(cadenceAt) }, NOW, 5)).toBe(true);
    // …and a longer one lengthens it.
    expect(warmingPhoneLost({ ...i, lastBeatAt: ago(FLOOR * S) }, NOW, FLOOR * 2)).toBe(false);
  });

  it("m-1: the floor is REQUIRED, so a use-case cannot fall back to the constant and skip tunable(…) — tsc reds an unused @ts-expect-error", () => {
    const omitted = () =>
      // @ts-expect-error — floorSeconds has no default (§6.15, D1)
      warmingPhoneLost(warming, NOW);
    expect(omitted).toBeTypeOf("function");   // never called: the check is the type error above
  });

  it("a current pairing with no last beat is refused by name (the column is NOT NULL)", () => {
    expect(() => warmingPhoneLost({ ...warming, lastBeatAt: null }, NOW, FLOOR)).toThrow(/lastBeatAt/);
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
  const cfg = {
    lostMinutes: PHONE_LOST_LIVE_MINUTES, warmingMinutes: WARMING_TIMEOUT_MINUTES, quietSeconds: RECONNECT_QUIET_SECONDS, silentFloorSeconds: FLOOR,
  };
  const DOWN: CountdownRead = { fresh: "disconnected", served: "disconnected", failed: false };
  /** The warming session's phone, beating on the starting cadence a second ago: ask 10 is not armed. */
  const BEATING = { hasCurrentPairing: true, lastBeatAt: ago(S), answeredPollSeconds: POLL_STARTING_SECONDS, heardGoLive: true };
  const live = (beatMs: number, videoMs: number) => ({
    state: "live" as const, firstIngestAt: ago(LOST_MS * 2), warmingAt: ago(LOST_MS * 3), phoneBeatAt: ago(beatMs),
    read: DOWN, lastConnectedSampleAt: ago(videoMs), phone: BEATING,
  });
  const WORDS = ["connected", "disconnected", "unknown"] as const;

  it("the empty case first (live): unless THIS tick's fresh word is `disconnected` → null. W19 judges the fresh word only (m-3), so a served `disconnected` that is only CARRIED (a no-evidence read, fresh undefined) shows nothing either", () => {
    const seen = { shown: 0, none: 0, refused: 0 };
    for (const fresh of [...WORDS, undefined]) {
      for (const served of [...WORDS, null]) {
        for (const failed of [false, true]) {
          const read = { fresh, served, failed };
          if (failed && fresh !== undefined) {
            // A read that threw has no word: a fresh word beside `failed` is a caller that broke the TickObservation contract.
            expect(() => lostCountdown({ ...live(LOST_MS, LOST_MS), read }, NOW, cfg), `fresh ${fresh} on a failed read`).toThrow(RangeError);
            seen.refused++;
            continue;
          }
          const c = lostCountdown({ ...live(LOST_MS, LOST_MS), read }, NOW, cfg);
          if (fresh === "disconnected") { expect(c?.kind, `fresh ${fresh}, served ${served}`).toBe("live"); seen.shown++; }
          else { expect(c, `fresh ${fresh}, served ${served}, failed ${failed}`).toBeNull(); seen.none++; }
        }
      }
    }
    // 4 fresh × 4 served × 2: the 12 failed reads that still carry a fresh word are refused; of the 20 others, 4 are fresh disconnected.
    expect(seen).toEqual({ shown: 4, none: 16, refused: 12 });
  });

  it("live, no video and no beat for RECONNECT_QUIET_SECONDS − 1 s → null; at the quiet hold → the countdown", () => {
    expect(lostCountdown(live(QUIET_MS - S, QUIET_MS - S), NOW, cfg)).toBeNull();
    expect(lostCountdown(live(QUIET_MS, QUIET_MS), NOW, cfg)).toEqual({ kind: "live", reason: "phone_lost", elapsedMs: QUIET_MS, remainingMs: LOST_MS - QUIET_MS });
  });

  it("O5: video gone 10 min while the phone still beats (inside the quiet hold) → null — W19 cannot fire", () => {
    expect(lostCountdown(live(QUIET_MS - S, 10 * MIN), NOW, cfg)).toBeNull();
    expect(lostCountdown(live(5 * S, 10 * MIN), NOW, cfg)).toBeNull();
  });

  it("§6.12's rule, not the brief's example: a beat 2 min ago is past the quiet hold, so it counts down from the 2-min silence", () => {
    expect(lostCountdown(live(2 * MIN, 10 * MIN), NOW, cfg)).toEqual({ kind: "live", reason: "phone_lost", elapsedMs: 2 * MIN, remainingMs: LOST_MS - 2 * MIN });
  });

  it("ordering differential: beat 12 min, video 9 min → elapsed is the SHORTER silence (9 min); the longer would say 12", () => {
    const c = lostCountdown(live(12 * MIN, 9 * MIN), NOW, cfg);
    expect(c).toEqual({ kind: "live", reason: "phone_lost", elapsedMs: 9 * MIN, remainingMs: LOST_MS - 9 * MIN });
    expect(c!.elapsedMs).not.toBe(12 * MIN);
  });

  it("no beat ever and no connected sample: both clocks run from first ingest", () => {
    const i = { ...live(0, 0), phoneBeatAt: null, lastConnectedSampleAt: null, firstIngestAt: ago(3 * MIN) };
    expect(lostCountdown(i, NOW, cfg)).toEqual({ kind: "live", reason: "phone_lost", elapsedMs: 3 * MIN, remainingMs: LOST_MS - 3 * MIN });
  });

  it("a warming reconnect (first ingest set) counts down like live", () => {
    expect(lostCountdown({ ...live(MIN, MIN), state: "warming" }, NOW, cfg)).toEqual({ kind: "live", reason: "phone_lost", elapsedMs: MIN, remainingMs: LOST_MS - MIN });
  });

  it("past W19's end but not yet ticked: remaining is 0, never negative", () => {
    expect(lostCountdown(live(LOST_MS + MIN, LOST_MS + MIN), NOW, cfg)).toEqual({ kind: "live", reason: "phone_lost", elapsedMs: LOST_MS + MIN, remainingMs: 0 });
  });

  it("lostMinutes is read from cfg: at 1 minute, a 30 s silence leaves 30 s", () => {
    expect(lostCountdown(live(QUIET_MS, QUIET_MS), NOW, { ...cfg, lostMinutes: 1 })).toEqual({ kind: "live", reason: "phone_lost", elapsedMs: QUIET_MS, remainingMs: MIN - QUIET_MS });
  });

  describe("warming (no video yet)", () => {
    const warming = (sinceMs: number | null) => ({
      state: "warming" as const, firstIngestAt: null, warmingAt: sinceMs === null ? null : ago(sinceMs), phoneBeatAt: ago(S),
      read: DOWN, lastConnectedSampleAt: null, phone: BEATING,
    });
    const WARMING_MS = WARMING_TIMEOUT_MINUTES * MIN;

    it("controller ruling 2026-10-04: the warming timeout fires whatever the WORD (M-4: unknown and a no-evidence read run it on schedule), so every read that answered shows the countdown — fresh or carried, any word but connected", () => {
      let shown = 0;
      for (const fresh of [...WORDS, undefined]) {
        for (const served of ["disconnected", "unknown", null] as const) {
          if (fresh !== undefined && fresh !== served) continue;   // a fresh word IS the served one; only a carry differs
          expect(lostCountdown({ ...warming(5 * MIN), read: { fresh, served, failed: false } }, NOW, cfg), `fresh ${fresh}, served ${served}`)
            .toEqual({ kind: "warming", reason: "no_inbound_timeout", elapsedMs: 5 * MIN, remainingMs: WARMING_MS - 5 * MIN });
          shown++;
        }
      }
      // fresh disconnected/unknown (2) + undefined with served disconnected, unknown or null (3).
      expect(shown).toBe(5);
    });

    it("N1: a phone read that THREW → null, because heldByUnknownIngest holds warming_timeout while the ingest cannot be seen; the same session whose read answered shows it (the pair)", () => {
      expect(lostCountdown({ ...warming(5 * MIN), read: { fresh: undefined, served: null, failed: true } }, NOW, cfg)).toBeNull();
      expect(lostCountdown({ ...warming(5 * MIN), read: { fresh: undefined, served: null, failed: false } }, NOW, cfg)?.kind).toBe("warming");
    });

    it("a served `connected` word → null: the observation takes the session live, so the timeout never fires (fresh, or carried by a no-evidence read); `disconnected` is the pair", () => {
      for (const fresh of ["connected", undefined] as const) {
        expect(lostCountdown({ ...warming(5 * MIN), read: { fresh, served: "connected", failed: false } }, NOW, cfg), `fresh ${fresh}`).toBeNull();
      }
      expect(lostCountdown({ ...warming(5 * MIN), read: { fresh: undefined, served: "disconnected", failed: false } }, NOW, cfg)?.kind).toBe("warming");
    });

    it("30 s after warmingAt → warming, remaining = warmingAt + WARMING_TIMEOUT_MINUTES − now; 1 s short → null", () => {
      expect(lostCountdown(warming(QUIET_MS - S), NOW, cfg)).toBeNull();
      expect(lostCountdown(warming(QUIET_MS), NOW, cfg)).toEqual({ kind: "warming", reason: "no_inbound_timeout", elapsedMs: QUIET_MS, remainingMs: WARMING_MS - QUIET_MS });
    });

    it("past the warming deadline but not yet failed: remaining is 0", () => {
      expect(lostCountdown(warming(WARMING_MS + S), NOW, cfg)).toEqual({ kind: "warming", reason: "no_inbound_timeout", elapsedMs: WARMING_MS + S, remainingMs: 0 });
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

    // Controller ruling 2026-10-04: the countdown targets the EARLIEST end that will fire and carries that end's reason.
    // Ask 10 is armed once beats have stopped: no beat for the longer of the phone's own cadence (a beat it owed is
    // missing) and the quiet hold (O5's measure of a phone gone quiet). It then fires at its silence threshold. Every
    // figure below is §6.9's arithmetic over the declared constants, never lostCountdown's.
    describe("the earliest end: ask 10 once beats have stopped (controller ruling 2026-10-04)", () => {
      const phone = (beatAgoMs: number, answeredPollSeconds: number, heardGoLive: boolean) =>
        ({ hasCurrentPairing: true, lastBeatAt: ago(beatAgoMs), answeredPollSeconds, heardGoLive });
      /** §6.8.3: the cadence ask 10 judges on, and §6.9's threshold over it. */
      const judged = (answered: number, heard: boolean) => (heard ? Math.min(answered, OPEN_SESSION_MAX_POLL_SECONDS) : answered);
      const thresholdMs = (answered: number, heard: boolean) => Math.max(FLOOR, judged(answered, heard) + PHONE_SILENT_SLACK_SECONDS) * S;
      /** Armed once a beat the phone owed is a full near poll late (B7 re-review m-a): the go-live beat's round trip
       *  never arms it. */
      const armMs = (answered: number, heard: boolean) => Math.max(QUIET_MS, (judged(answered, heard) + POLL_NEAR_SECONDS) * S);

      it("armed exactly when beats have stopped: 1 s short → the warming timeout; at it → phone_lost, remaining = the silence threshold − the beat's age (each cadence the phone can be on)", () => {
        let checked = 0;
        for (const [answered, heard] of [[POLL_STARTING_SECONDS, true], [POLL_NEAR_SECONDS, true], [POLL_FAR_SECONDS, true], [POLL_NEAR_SECONDS, false], [POLL_FAR_SECONDS, false]] as const) {
          const label = `answered ${answered} s, ${heard ? "heard" : "not heard"} go-live`;
          const arm = armMs(answered, heard);
          expect(arm, `PREMISE ${label}: armed before ask 10 fires`).toBeLessThan(thresholdMs(answered, heard));
          const short = lostCountdown({ ...warming(5 * MIN), phone: phone(arm - S, answered, heard) }, NOW, cfg);
          expect(short?.reason, `${label}: 1 s short of armed`).toBe("no_inbound_timeout");
          expect(lostCountdown({ ...warming(5 * MIN), phone: phone(arm, answered, heard) }, NOW, cfg), label)
            .toEqual({ kind: "warming", reason: "phone_lost", elapsedMs: arm, remainingMs: thresholdMs(answered, heard) - arm });
          checked++;
        }
        expect(checked).toBe(5);
      });

      it("m-a: a far-cadence phone right after Go live shows NO countdown while its go-live beat is in flight; the pair: a beat a full near poll late arms it", () => {
        let checked = 0;
        // The phone has not heard go-live, so it beats on its waiting (far) cadence: its previous beat was one cadence plus
        // the round trip ago, and the beat that hears go-live is due now. Go live was 2 s ago.
        for (const rtt of [S, 5 * S, POLL_NEAR_SECONDS * S - S]) {
          const p = phone(POLL_FAR_SECONDS * S + rtt, POLL_FAR_SECONDS, false);
          expect(lostCountdown({ ...warming(2 * S), phone: p }, NOW, cfg), `round trip ${rtt / S} s`).toBeNull();
          checked++;
        }
        expect(checked).toBe(3);
        const late = phone((POLL_FAR_SECONDS + POLL_NEAR_SECONDS) * S, POLL_FAR_SECONDS, false);
        expect(lostCountdown({ ...warming(2 * S), phone: late }, NOW, cfg)?.reason, "the pair").toBe("phone_lost");
      });

      it("ordering differential: an armed ask 10 that lands AFTER the warming deadline does not displace it; the same phone 1 min earlier in warming lands before it and does", () => {
        const p = phone(armMs(POLL_STARTING_SECONDS, true), POLL_STARTING_SECONDS, true);
        const toAsk10 = thresholdMs(POLL_STARTING_SECONDS, true) - armMs(POLL_STARTING_SECONDS, true);
        const lateInWarming = WARMING_MS - toAsk10 + 5 * S;   // the warming deadline is 5 s BEFORE ask 10's
        expect(lostCountdown({ ...warming(lateInWarming), phone: p }, NOW, cfg)).toEqual({ kind: "warming", reason: "no_inbound_timeout", elapsedMs: lateInWarming, remainingMs: WARMING_MS - lateInWarming });
        const earlier = lateInWarming - MIN;
        expect(lostCountdown({ ...warming(earlier), phone: p }, NOW, cfg)?.reason).toBe("phone_lost");
      });

      it("a tie goes to the warming timeout: the tick expires before it judges ask 10", () => {
        const p = phone(armMs(POLL_STARTING_SECONDS, true), POLL_STARTING_SECONDS, true);
        const toAsk10 = thresholdMs(POLL_STARTING_SECONDS, true) - armMs(POLL_STARTING_SECONDS, true);
        expect(lostCountdown({ ...warming(WARMING_MS - toAsk10), phone: p }, NOW, cfg)?.reason).toBe("no_inbound_timeout");
      });

      it("armed ask 10 shows even inside the warming quiet hold: the real end is coming (a phone silent since before Go live)", () => {
        const beat = armMs(POLL_FAR_SECONDS, false) + 10 * S;
        expect(lostCountdown({ ...warming(10 * S), phone: phone(beat, POLL_FAR_SECONDS, false) }, NOW, cfg))
          .toEqual({ kind: "warming", reason: "phone_lost", elapsedMs: beat, remainingMs: thresholdMs(POLL_FAR_SECONDS, false) - beat });
        expect(lostCountdown({ ...warming(10 * S) }, NOW, cfg), "the pair: a beating phone inside the hold shows nothing").toBeNull();
      });

      it("a status read that threw holds the timeout, NOT ask 10: armed → the ask-10 target even when it lands after the held deadline; not armed → nothing fires, so null", () => {
        const failed: CountdownRead = { fresh: undefined, served: null, failed: true };
        const p = phone(armMs(POLL_STARTING_SECONDS, true), POLL_STARTING_SECONDS, true);
        const toAsk10 = thresholdMs(POLL_STARTING_SECONDS, true) - armMs(POLL_STARTING_SECONDS, true);
        const lateInWarming = WARMING_MS - toAsk10 + 5 * S;
        expect(lostCountdown({ ...warming(lateInWarming), phone: p, read: failed }, NOW, cfg)).toEqual({ kind: "warming", reason: "phone_lost", elapsedMs: armMs(POLL_STARTING_SECONDS, true), remainingMs: toAsk10 });
        expect(lostCountdown({ ...warming(lateInWarming), read: failed }, NOW, cfg)).toBeNull();
      });

      it("a `connected` word → null even with ask 10 armed: the observation takes the session live, out of ask 10's reach", () => {
        const p = phone(armMs(POLL_FAR_SECONDS, false), POLL_FAR_SECONDS, false);
        expect(lostCountdown({ ...warming(5 * MIN), phone: p, read: { fresh: "connected", served: "connected", failed: false } }, NOW, cfg)).toBeNull();
        expect(lostCountdown({ ...warming(5 * MIN), phone: p }, NOW, cfg)?.reason, "the pair").toBe("phone_lost");
      });

      it("no current pairing: ask 10 is owed NOW (the next tick ends it), so phone_lost at 0 — there is no beat to time it from", () => {
        expect(lostCountdown({ ...warming(5 * MIN), phone: { hasCurrentPairing: false, lastBeatAt: null, answeredPollSeconds: 0, heardGoLive: false } }, NOW, cfg))
          .toEqual({ kind: "warming", reason: "phone_lost", elapsedMs: 0, remainingMs: 0 });
      });

      it("the floor is read from cfg (§6.15, tunable): a 10 s floor cannot pull ask 10 inside cadence + slack", () => {
        const p = phone(QUIET_MS, POLL_STARTING_SECONDS, true);
        const c = lostCountdown({ ...warming(5 * MIN), phone: p }, NOW, { ...cfg, silentFloorSeconds: 10 });
        expect(c).toEqual({ kind: "warming", reason: "phone_lost", elapsedMs: QUIET_MS, remainingMs: Math.max(10, POLL_STARTING_SECONDS + PHONE_SILENT_SLACK_SECONDS) * S - QUIET_MS });
      });
    });
  });
});
