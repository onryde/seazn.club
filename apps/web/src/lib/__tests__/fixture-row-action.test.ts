// fixture-row-action.test.ts — the one authority for what a run-sheet row
// offers. Pure: no DB, no DOM, no engine import.
import { describe, expect, it } from "vitest";
import { fixtureRowAction, type RowActionInput } from "../fixture-row-action";

const TZ = "Europe/London";
// 2026-09-03T13:00:00Z — 14:00 London, comfortably inside the day either way.
const NOW = Date.UTC(2026, 8, 3, 13, 0);
const TODAY_1500 = "2026-09-03T14:00:00.000Z";
const TOMORROW_1000 = "2026-09-04T09:00:00.000Z";

function row(over: Partial<RowActionInput> = {}): RowActionInput {
  return {
    status: "scheduled",
    scheduledAt: TODAY_1500,
    hasOfficials: true,
    canEdit: true,
    tz: TZ,
    nowMs: NOW,
    ...over,
  };
}

describe("fixtureRowAction — the enumerated table", () => {
  it("in_play beats every other consideration, scheduled today or not", () => {
    expect(fixtureRowAction(row({ status: "in_play" })).kind).toBe("open_pad");
    expect(fixtureRowAction(row({ status: "in_play", scheduledAt: null })).kind).toBe("open_pad");
    expect(fixtureRowAction(row({ status: "in_play", hasOfficials: false })).kind).toBe("open_pad");
  });

  it("a scheduled fixture TODAY with no officials asks for a scorer", () => {
    expect(fixtureRowAction(row({ hasOfficials: false })).kind).toBe("assign_scorer");
  });

  it("a scheduled fixture NOT today with no officials does not — it is not today's problem", () => {
    expect(fixtureRowAction(row({ scheduledAt: TOMORROW_1000, hasOfficials: false })).kind).toBe("score");
  });

  it("a scheduled fixture with officials scores, today or not", () => {
    expect(fixtureRowAction(row()).kind).toBe("score");
    expect(fixtureRowAction(row({ scheduledAt: TOMORROW_1000 })).kind).toBe("score");
  });

  it("decided and finalized both read Result", () => {
    expect(fixtureRowAction(row({ status: "decided" })).kind).toBe("result");
    expect(fixtureRowAction(row({ status: "finalized" })).kind).toBe("result");
  });

  it("a scheduled fixture with no time offers Set time, and only to an editor", () => {
    expect(fixtureRowAction(row({ scheduledAt: null })).kind).toBe("set_time");
    expect(fixtureRowAction(row({ scheduledAt: null, canEdit: false })).kind).toBe("view");
  });

  it("abandoned, forfeited and cancelled are RESULTS, not open work", () => {
    // Not in the spec's table. Without an explicit branch they fall through to
    // the default, and a cancelled match would print "Score" — inviting an
    // organiser to score a match that will never be played.
    for (const status of ["abandoned", "forfeited", "cancelled"]) {
      expect(fixtureRowAction(row({ status })).kind, status).toBe("result");
    }
  });

  it("an unknown status never crashes and never invites scoring", () => {
    expect(fixtureRowAction(row({ status: "teleported" })).kind).toBe("view");
  });
});

describe("fixtureRowAction — the ORDER of the ladder, not just its branches", () => {
  // _RULES.md: a test that pins a ladder must pin the ORDER too — a case whose
  // expected value differs between two candidate orderings. If the
  // "scheduled today, no officials" rule were checked BEFORE in_play, this
  // fixture would read assign_scorer instead of open_pad.
  it("in_play + today + no officials is open_pad, which only the correct order gives", () => {
    expect(fixtureRowAction(row({ status: "in_play", hasOfficials: false })).kind).toBe("open_pad");
  });

  // And the mirror: if set_time were checked FIRST, an in_play fixture whose
  // time was cleared would read set_time.
  it("in_play with no time is open_pad, not set_time", () => {
    expect(fixtureRowAction(row({ status: "in_play", scheduledAt: null })).kind).toBe("open_pad");
  });
});

describe("fixtureRowAction — 'today' is the VENUE day, and the boundary is real", () => {
  it("23:30 local on the day before is NOT today", () => {
    // 2026-09-02T22:30Z = 23:30 London on the 2nd.
    expect(
      fixtureRowAction(row({ scheduledAt: "2026-09-02T22:30:00.000Z", hasOfficials: false })).kind,
    ).toBe("score");
  });

  it("00:30 local on the day itself IS today", () => {
    // 2026-09-02T23:30Z = 00:30 London on the 3rd.
    expect(
      fixtureRowAction(row({ scheduledAt: "2026-09-02T23:30:00.000Z", hasOfficials: false })).kind,
    ).toBe("assign_scorer");
  });

  it("the same instant in a different venue zone lands on a different day", () => {
    // NOW (2026-09-03T13:00Z) is itself past midnight in Auckland (+12, no
    // DST until the 27th) — "today" there is the 4th, not the 3rd. So the
    // instant that demonstrates the contrast has to be one that crosses INTO
    // the 4th, not one that stays on the 3rd:
    // 2026-09-03T23:30Z is 11:30 on the 4th in Auckland (today, +12) but
    // 00:30 on the 4th in London (NOT today — London's today is the 3rd).
    expect(
      fixtureRowAction(
        row({ scheduledAt: "2026-09-03T23:30:00.000Z", hasOfficials: false, tz: "Pacific/Auckland" }),
      ).kind,
    ).toBe("assign_scorer");
  });
});
