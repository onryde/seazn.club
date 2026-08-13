// health-input.test.ts — the DB/wire-shape -> HealthFixture[] adapter (D3),
// mirrors capacity-input.ts's own (untested-directly, but this module gets
// its own suite since the tz-bucketing arithmetic is worth pinning).
import { describe, expect, it } from "vitest";
import { healthFixturesFor, type HealthFixtureInput } from "@/lib/health-input";

describe("healthFixturesFor", () => {
  it("computes end from start+matchMinutes and a tz-correct dayKey, preserving home/away/pool/division", () => {
    // 2026-11-02T23:30:00Z is 2026-11-02 19:30 in America/New_York (UTC-4,
    // still DST that week) — chosen specifically so a naive UTC-slice
    // dayKey (which would read "2026-11-02" too, uselessly) can't hide a
    // bug; see the SECOND case below for the one that actually distinguishes.
    const startMs = Date.UTC(2026, 10, 2, 23, 30, 0);
    const input: HealthFixtureInput[] = [
      {
        fixtureId: "fx1",
        scheduledAtMs: startMs,
        court: "Court 1",
        home: "entrant-a",
        away: "entrant-b",
        roundNo: 2,
        poolId: "pool-1",
        divisionId: "div-1",
      },
    ];
    const out = healthFixturesFor(input, 45, "America/New_York");
    expect(out).toEqual([
      {
        fixtureId: "fx1",
        court: "Court 1",
        start: startMs,
        end: startMs + 45 * 60_000,
        dayKey: "2026-11-02",
        home: "entrant-a",
        away: "entrant-b",
        roundNo: 2,
        poolId: "pool-1",
        divisionId: "div-1",
      },
    ]);
  });

  it("resolves dayKey in the GIVEN tz, not UTC — a fixture past midnight UTC can still be the PREVIOUS calendar day locally", () => {
    // 2026-11-03T02:00:00Z is 2026-11-02 22:00 in America/New_York (UTC-4):
    // the UTC calendar day is the 3rd, the venue's is still the 2nd. A
    // UTC-slice implementation would answer "2026-11-03" here — wrong.
    const startMs = Date.UTC(2026, 10, 3, 2, 0, 0);
    const out = healthFixturesFor(
      [{ fixtureId: "fx2", scheduledAtMs: startMs, court: "Court 2" }],
      30,
      "America/New_York",
    );
    expect(out[0]!.dayKey).toBe("2026-11-02");
  });

  it("omits home/away/roundNo/poolId/divisionId entirely when undefined, rather than writing them as null", () => {
    const out = healthFixturesFor(
      [{ fixtureId: "fx3", scheduledAtMs: 0, court: "Court 1" }],
      30,
      "UTC",
    );
    expect(out).toEqual([{ fixtureId: "fx3", court: "Court 1", start: 0, end: 30 * 60_000, dayKey: "1970-01-01" }]);
    expect("home" in out[0]!).toBe(false);
    expect("away" in out[0]!).toBe(false);
  });
});
