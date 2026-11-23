// The clocks of walkthrough/seazn-hosted.spec.ts, as a function of the fake's connect delay (AGENTS.md class 20): every wait is
// DERIVED from the constants that set the pace, one term per wait in step order. Kept out of the spec so the CI wiring test
// (src/lib/__tests__/e2e-ci-wiring.test.ts) can read the walk's worst case at the job's own connect delay and hold e2e-seazn's
// `timeout-minutes` to it — importing a spec would run its `test(...)` calls. The spec's PoolHolder stays in the spec (one per member,
// under its own name: the pool's sweep in that same wiring test).
import { POLL_WAIT_MS, liveWaitMs, poolBudget } from "./stream-slot-pool";
import { SEAZN_VIDEO_POLL_FLOOR_MS } from "../../src/components/public-site/match-centre/seazn-video-schedule";

/** The org, the competition, its division started and its one fixture (the organiser's sign-in included). */
export const SEED_MS = 60_000;
/** One page load (the organiser's fixture page, the spectator's match page). */
export const NAV_MS = 30_000;

export interface SeaznWalkClock {
  /** From the Go live tap until the panel reads live: the fake's connect and two organiser polls, plus slack (the pool's own). */
  LIVE_WAIT_MS: number;
  /** The island's re-read: its floor (30 s, the schedule's own constant) plus slack. A Go live, a Stop and a newly signed recording
   *  each reach an open page on the NEXT read, so each of those waits is exactly one of these. Empty answers would back off past the
   *  floor (review I2), but the walk's fixture kicks off 10 minutes after it is seeded, and within the hour either side of kick-off
   *  the island holds the floor (re-review N1), so each wait stays one of these for a viewer who simply keeps watching. */
  ONE_RE_READ_MS: number;
  /** The Stop landing: the session reading completed (three polls-plus-slack). */
  END_MS: number;
  /** One server round trip or one short poll: a dialog closing, a beat, the recording control, the stream tick, a pill. */
  CALL_MS: number;
  /** stream-credits.spec.ts's key, taken only for the instant of the global tick: a wait of one pool cycle, as youtube-connect's. */
  CREDITS_KEY_WAIT_MS: number;
  /** The first hold of the stream-slot pool: the first Go live to the tick. */
  HOLD_1_MS: number;
  /** The second hold: Start another to the teardown. */
  HOLD_2_MS: number;
  /** The whole walk, one attempt: the test's own timeout. */
  WALK_MS: number;
}

export function seaznWalkClock(fakeConnectMs: number): SeaznWalkClock {
  const PAIR_MS = 2 * NAV_MS; // the fake phone: its own tab's load and the panel's pairing (helpers/fake-capture-phone.ts)
  const LIVE_WAIT_MS = liveWaitMs(fakeConnectMs);
  const ONE_RE_READ_MS = SEAZN_VIDEO_POLL_FLOOR_MS + 15_000;
  const END_MS = 3 * POLL_WAIT_MS;
  const CALL_MS = POLL_WAIT_MS;
  const budget = poolBudget(fakeConnectMs);
  const CREDITS_KEY_WAIT_MS = budget.cycleMs;
  /** One Go live, tap to a live panel: the session row, the composed session's facts, the stand-in's first beat, the live pill. */
  const GO_LIVE_MS = CALL_MS + LIVE_WAIT_MS + CALL_MS + LIVE_WAIT_MS;
  /** One Stop, tap to an Ended panel: the dialog, the stand-in's last beat, the session completing, the Ended pill. */
  const STOP_MS = CALL_MS + CALL_MS + END_MS + CALL_MS;
  /** The stream tick under W22's exclusion: the recording control, stream-credits' key, the tick. */
  const TICK_MS = CALL_MS + CREDITS_KEY_WAIT_MS + CALL_MS;
  /** The afterEach's end of an open session: the stop, the last beat, the forced terminal. */
  const TEARDOWN_MS = 3 * CALL_MS;
  // The two holds, one term per wait in step order. A composed session reserves two matches of recording (R2004), so each Go live
  // takes the WHOLE pool, as every composed walkthrough does (overlay-compositor.spec.ts). The pairing and the panel's reload come
  // before the first, and the pool is given back between them — once the first session is terminal and the tick has run — so the
  // replay check holds no slot.
  //  1. the first Go live; the open page turning live, its address reaching the player; the Stop; the open page losing the live
  //     player; the tick;
  //  2. Start another's idle pill; the second Go live; the open page turning live again, its address reaching the player; the
  //     provider-call poll; the teardown.
  const HOLD_1_MS = GO_LIVE_MS + ONE_RE_READ_MS + CALL_MS + STOP_MS + ONE_RE_READ_MS + TICK_MS;
  const HOLD_2_MS = CALL_MS + GO_LIVE_MS + ONE_RE_READ_MS + CALL_MS + CALL_MS + TEARDOWN_MS;
  // The walk, in step order: the seed; the fixture page; the spectator's page before kick-off and its first read; the pairing and the
  // panel's reload; the first hold (and its wait for the pool); the replay showing and its address reaching the player (outside any
  // hold); the second hold (and its wait).
  const WALK_MS =
    SEED_MS + NAV_MS + NAV_MS + NAV_MS + PAIR_MS + NAV_MS + budget.slotWaitMs + HOLD_1_MS + ONE_RE_READ_MS + CALL_MS + budget.slotWaitMs + HOLD_2_MS;
  return { LIVE_WAIT_MS, ONE_RE_READ_MS, END_MS, CALL_MS, CREDITS_KEY_WAIT_MS, HOLD_1_MS, HOLD_2_MS, WALK_MS };
}
