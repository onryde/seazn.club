// Capture QR v2 §6.6 (W17) — domain/poll-seconds.ts, the cadence the beat answer tells the phone. First row that
// applies wins. Every value and the window are read from the declared constants.
import { describe, expect, it } from "vitest";
import { POLL_FAR_SECONDS, POLL_NEAR_SECONDS, POLL_NEAR_WINDOW_MINUTES, POLL_STARTING_SECONDS } from "../../config";
import { pollSecondsFor } from "../poll-seconds";
import type { SessionState } from "../session";

const NOW = new Date("2026-10-01T12:00:00Z");
const WINDOW_MS = POLL_NEAR_WINDOW_MINUTES * 60_000;
/** The kick-off `ms` after the near window opens: negative = the window is already open. */
const kickOffWithWindowOpeningIn = (ms: number): Date => new Date(NOW.getTime() + WINDOW_MS + ms);
const idle = { open: null, fixtureStatus: "scheduled", scheduledAt: null, finished: false } as const;

describe("pollSecondsFor — every §6.6 row", () => {
  it("the empty case first: no session, no scheduled_at, not started → far", () => {
    expect(pollSecondsFor(idle, NOW)).toBe(POLL_FAR_SECONDS);
  });

  it("an open session in requested or provisioning → starting", () => {
    for (const open of ["requested", "provisioning"] as const) expect(pollSecondsFor({ ...idle, open }, NOW), open).toBe(POLL_STARTING_SECONDS);
  });

  it("any other open session → near (warming, live, ending)", () => {
    for (const open of ["warming", "live", "ending"] as const) expect(pollSecondsFor({ ...idle, open }, NOW), open).toBe(POLL_NEAR_SECONDS);
  });

  it("an open session outranks a finished fixture: the broadcast still needs the near cadence", () => {
    expect(pollSecondsFor({ ...idle, open: "live", fixtureStatus: "decided", finished: true }, NOW)).toBe(POLL_NEAR_SECONDS);
  });

  it("no session, fixture in_play → near, with or without scheduled_at", () => {
    expect(pollSecondsFor({ ...idle, fixtureStatus: "in_play" }, NOW)).toBe(POLL_NEAR_SECONDS);
    expect(pollSecondsFor({ ...idle, fixtureStatus: "in_play", scheduledAt: kickOffWithWindowOpeningIn(3_600_000) }, NOW)).toBe(POLL_NEAR_SECONDS);
  });

  it(`T−${POLL_NEAR_WINDOW_MINUTES} min ± 1 s: one second before the window is far; the window's edge and inside it are near`, () => {
    expect(pollSecondsFor({ ...idle, scheduledAt: kickOffWithWindowOpeningIn(1000) }, NOW)).toBe(POLL_FAR_SECONDS);
    expect(pollSecondsFor({ ...idle, scheduledAt: kickOffWithWindowOpeningIn(0) }, NOW)).toBe(POLL_NEAR_SECONDS);
    expect(pollSecondsFor({ ...idle, scheduledAt: kickOffWithWindowOpeningIn(-1000) }, NOW)).toBe(POLL_NEAR_SECONDS);
  });

  it("past kick-off and not finished (a late start) → near", () => {
    expect(pollSecondsFor({ ...idle, scheduledAt: new Date(NOW.getTime() - 3_600_000) }, NOW)).toBe(POLL_NEAR_SECONDS);
  });

  it("finished → far, inside the window and past kick-off", () => {
    for (const status of ["decided", "finalized", "forfeited", "abandoned", "cancelled"]) {
      expect(pollSecondsFor({ ...idle, fixtureStatus: status, finished: true, scheduledAt: kickOffWithWindowOpeningIn(-1000) }, NOW), status).toBe(POLL_FAR_SECONDS);
    }
  });

  it("a terminal session passed as the OPEN one is refused by name", () => {
    for (const open of ["completed", "failed"] as SessionState[]) expect(() => pollSecondsFor({ ...idle, open }, NOW), open).toThrow(/not open/);
  });

  it("every answer is one of the three declared cadences, and all three are reached", () => {
    const seen = new Set<number>();
    let checked = 0;
    for (const open of [null, "requested", "provisioning", "warming", "live", "ending"] as const) {
      for (const fixtureStatus of ["scheduled", "in_play", "decided"]) {
        for (const scheduledAt of [null, kickOffWithWindowOpeningIn(1000), kickOffWithWindowOpeningIn(-1000)]) {
          seen.add(pollSecondsFor({ open, fixtureStatus, scheduledAt, finished: fixtureStatus === "decided" }, NOW));
          checked++;
        }
      }
    }
    expect(checked).toBe(6 * 3 * 3);
    expect([...seen].sort((a, b) => a - b)).toEqual([POLL_STARTING_SECONDS, POLL_NEAR_SECONDS, POLL_FAR_SECONDS].sort((a, b) => a - b));
  });
});
