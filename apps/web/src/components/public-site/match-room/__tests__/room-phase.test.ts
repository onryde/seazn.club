import { describe, expect, it } from "vitest";
import { roomPhaseWire } from "../room-snapshot";
import { windowFor } from "@/server/external-play/window";

const OPENED = new Date("2026-10-09T10:00:00Z");

describe("roomPhaseWire (D12)", () => {
  it("the EMPTY case first: no round_opened_at is `not_opened`, whatever the clock or the schedule says", () => {
    let checked = 0;
    for (const now of ["2026-10-01T00:00:00Z", "2026-10-09T10:05:00Z", "2026-11-01T00:00:00Z"]) {
      expect(roomPhaseWire({ now: new Date(now), roundOpenedAt: null }), now).toBe("not_opened");
      checked += 1;
    }
    expect(checked, "anti-vacuity: clock positions checked against a null open").toBe(3);
  });

  it("the window is measured from round_opened_at — derived from windowFor, never a literal here", () => {
    const w = windowFor(OPENED);
    expect(roomPhaseWire({ now: new Date(w.opensAt.getTime() - 1), roundOpenedAt: OPENED })).toBe("before");
    expect(roomPhaseWire({ now: w.opensAt, roundOpenedAt: OPENED })).toBe("open");
    expect(roomPhaseWire({ now: new Date(w.deadline.getTime() - 1), roundOpenedAt: OPENED })).toBe("open");
    expect(roomPhaseWire({ now: w.deadline, roundOpenedAt: OPENED })).toBe("closed");
  });

  it("the SCHEDULED time cannot move the phase — that is the whole point of D12", () => {
    const now = new Date("2026-10-09T09:55:00Z");
    expect(roomPhaseWire({ now, roundOpenedAt: OPENED })).toBe("open");
    // The function takes no scheduledAt at all; a mutant that adds one has
    // nowhere to read it from. Pinned structurally:
    expect(roomPhaseWire.length, "roomPhaseWire takes exactly one argument").toBe(1);
  });
});
