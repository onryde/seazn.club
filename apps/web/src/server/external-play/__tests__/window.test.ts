import { describe, expect, it } from "vitest";
import {
  DEADLINE_AFTER_MS, EMAIL_LEAD_MS, WINDOW_OPEN_LEAD_MS,
  checkInCounts, deadlineReason, roomPhase, windowFor,
} from "../window";

const T = new Date("2026-10-01T19:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);

describe("windowFor", () => {
  it("derives every edge from the constants, not literals", () => {
    const w = windowFor(T);
    expect(w.emailAt.getTime()).toBe(T.getTime() - EMAIL_LEAD_MS);
    expect(w.opensAt.getTime()).toBe(T.getTime() - WINDOW_OPEN_LEAD_MS);
    expect(w.deadline.getTime()).toBe(T.getTime() + DEADLINE_AFTER_MS);
  });
  it("pins the owner-approved values", () => {
    expect([EMAIL_LEAD_MS, WINDOW_OPEN_LEAD_MS, DEADLINE_AFTER_MS]).toEqual([900_000, 600_000, 1_200_000]);
  });
});

describe("roomPhase", () => {
  it("is before one ms ahead of T−10, open at T−10 exactly", () => {
    expect(roomPhase(at(-WINDOW_OPEN_LEAD_MS - 1), T)).toBe("before");
    expect(roomPhase(at(-WINDOW_OPEN_LEAD_MS), T)).toBe("open");
  });
  it("is open one ms before T+20, closed at T+20 exactly", () => {
    expect(roomPhase(at(DEADLINE_AFTER_MS - 1), T)).toBe("open");
    expect(roomPhase(at(DEADLINE_AFTER_MS), T)).toBe("closed");
  });
});

describe("checkInCounts", () => {
  it("null never counts", () => {
    expect(checkInCounts(null, T)).toBe(false);
  });
  it("a stamp before the window (e.g. before a reschedule) does not count", () => {
    expect(checkInCounts(at(-WINDOW_OPEN_LEAD_MS - 1), T)).toBe(false);
  });
  it("counts from T−10 inclusive to T+20 exclusive", () => {
    expect(checkInCounts(at(-WINDOW_OPEN_LEAD_MS), T)).toBe(true);
    expect(checkInCounts(at(DEADLINE_AFTER_MS - 1), T)).toBe(true);
    expect(checkInCounts(at(DEADLINE_AFTER_MS), T)).toBe(false);
  });
});

describe("deadlineReason (spec §9)", () => {
  it("neither checked in → no_show_both", () => {
    expect(deadlineReason({ whiteCheckedIn: false, blackCheckedIn: false, lichessStatus: null })).toBe("no_show_both");
  });
  it("white only → no_show_black", () => {
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: false, lichessStatus: null })).toBe("no_show_black");
  });
  it("black only → no_show_white", () => {
    expect(deadlineReason({ whiteCheckedIn: false, blackCheckedIn: true, lichessStatus: null })).toBe("no_show_white");
  });
  it("both, no game → not_started", () => {
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: null })).toBe("not_started");
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: "created" })).toBe("not_started");
  });
  it("both, aborted-family status → aborted", () => {
    for (const s of ["aborted", "noStart", "unknownFinish"]) {
      expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: s })).toBe("aborted");
    }
  });
  it("a started or finished game is never a deadline case", () => {
    for (const s of ["started", "mate", "resign", "outoftime", "draw"]) {
      expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: s })).toBeNull();
    }
  });
  it("a missing check-in outranks a Lichess status (order differential)", () => {
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: false, lichessStatus: "aborted" })).toBe("no_show_black");
  });
});
