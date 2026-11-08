// The recent strip's stub (plan 2 Task 4; Task 9 fills it and replaces this file's cases). Its one rule today is a guard:
// rows handed over before Task 9 are refused, never silently dropped. The setup page mounts it with none
// (play-page.test.tsx renders that page). Sport: not applicable (no sport is read).
import { describe, expect, it } from "vitest";
import { RecentStrip } from "../recent-strip";

describe("RecentStrip (stub until plan 2 Task 9)", () => {
  it("renders nothing with no rows", () => {
    expect(RecentStrip({ title: "Your recent quick matches", items: [] })).toBeNull();
  });

  it("refuses rows rather than drop them (the guard, reached)", () => {
    expect(() =>
      RecentStrip({ title: "Your recent quick matches", items: [{ token: "qm_x", name: "Badminton", createdAt: "2026-11-08" }] }),
    ).toThrow(/Task 9/);
  });
});
