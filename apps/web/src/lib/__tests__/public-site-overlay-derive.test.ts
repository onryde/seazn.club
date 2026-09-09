// The four ScoreSummary readers the stream overlay needs and nothing else owned
// (W1 scope 2). They live beside `servingSide`/`setBreakdown` in
// `lib/public-site.ts` for the reason R5 states: one home for every "read the
// public summary without an engine import" derivation.
//
// Driven off the REAL cricket summary shape (`packages/engine/src/sports/
// cricket/cricket.ts:3285-3325`: `detail.innings[] = { entrantId, runs,
// wickets, legalBalls, declared, closed }`) for `battingEntrantId` and
// `chaseNeed`, and off the overlay ENDPOINT's `cricket.innings[]` (Task 0,
// design §3.2: `{ runs, wickets, legalBalls, ballsLimit }`, projected from the
// folded state) for `chaseBalls` — amended 2026-09-07. No summary field is
// invented here; the clock is not a reader at all (it is the stage's timer).
import { describe, expect, it } from "vitest";
import { battingEntrantId, chaseBalls, chaseNeed } from "@/lib/public-site";
import { formatClock } from "@/lib/overlay-model";

const innings = (entrantId: string, runs: number, closed: boolean) => ({
  entrantId, runs, wickets: 2, legalBalls: 60, ballsLimit: 120, declared: false, closed,
});

describe("battingEntrantId", () => {
  it("names the entrant of the last innings that has not closed", () => {
    const summary = { detail: { innings: [innings("e-home", 180, true), innings("e-away", 91, false)] } };
    expect(battingEntrantId(summary)).toBe("e-away");
  });

  it("is null once every innings has closed", () => {
    const summary = { detail: { innings: [innings("e-home", 180, true), innings("e-away", 181, true)] } };
    expect(battingEntrantId(summary)).toBeNull();
  });

  it("is null for a sport whose detail carries no innings at all", () => {
    expect(battingEntrantId({ detail: { sets: [{ home: 21, away: 15, closed: true }] } })).toBeNull();
    expect(battingEntrantId({ detail: null })).toBeNull();
    expect(battingEntrantId(null)).toBeNull();
  });
});

describe("chaseNeed", () => {
  it("is the first innings' total plus one, less what the chasing side has", () => {
    const summary = { detail: { innings: [innings("e-home", 180, true), innings("e-away", 91, false)] } };
    expect(chaseNeed(summary)).toBe(90);
  });

  it("prefers an explicit revised target when the detail carries one (DLS)", () => {
    const summary = {
      detail: { target: 160, targetSource: "dls", innings: [innings("e-home", 180, true), innings("e-away", 91, false)] },
    };
    expect(chaseNeed(summary), "the revised target replaces the first innings' total, it does not add to it").toBe(69);
  });

  it("is null in the first innings, and null once the chase is complete", () => {
    expect(chaseNeed({ detail: { innings: [innings("e-home", 91, false)] } })).toBeNull();
    expect(chaseNeed({ detail: { innings: [innings("e-home", 180, true), innings("e-away", 181, true)] } })).toBeNull();
  });

  it("is null for a sport with no innings", () => {
    expect(chaseNeed({ detail: { periods: [{ phase: "H1", home: 1, away: 0 }] } })).toBeNull();
  });
});

describe("chaseBalls (amended 2026-09-07: reads OverlayLiveData.cricket, the endpoint's innings off the folded state)", () => {
  // The denominator `_THEMES.md` §3 draws: "Need 45 off 45". Task 0's endpoint
  // carries `ballsLimit` beside `legalBalls`; this is the only place that
  // subtracts. Whether a chase is IN PROGRESS is `chaseNeed`'s call (summary);
  // the model asks this only when `chaseNeed` is non-null.
  const inn = (runs: number, legalBalls: number, ballsLimit: number | null) => ({ runs, wickets: 2, legalBalls, ballsLimit });

  it("is the chasing innings' quota less the legal balls it has faced", () => {
    expect(chaseBalls({ innings: [inn(180, 120, 120), inn(91, 60, 120)] }), "120 quota less 60 bowled").toBe(60);
  });

  it("follows a DLS-revised quota rather than the format's original", () => {
    expect(chaseBalls({ innings: [inn(180, 120, 120), inn(91, 60, 90)] })).toBe(30);
  });

  it("is null where the format declares no quota, null in the first innings, and null with no cricket at all", () => {
    // A timed/unlimited format carries `ballsLimit: null` (cricket.ts:440) —
    // "off null balls" must never render, so the line falls back to runs only.
    expect(chaseBalls({ innings: [inn(180, 120, 120), inn(91, 60, null)] })).toBeNull();
    expect(chaseBalls({ innings: [inn(91, 60, 120)] })).toBeNull();
    expect(chaseBalls(undefined)).toBeNull();
    expect(chaseBalls(null)).toBeNull();
  });

  it("never goes negative when the quota has been overshot", () => {
    expect(chaseBalls({ innings: [inn(180, 120, 120), inn(91, 130, 120)] })).toBe(0);
  });
});

describe("formatClock (overlay-model.ts)", () => {
  it("formats mm:ss with minutes unbounded, zero-padded seconds", () => {
    expect(formatClock(761)).toBe("12:41");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(5400)).toBe("90:00");
    expect(formatClock(6252)).toBe("104:12");
  });
  it("floors fractional seconds and clamps negatives to zero", () => {
    expect(formatClock(59.9)).toBe("00:59");
    expect(formatClock(-3)).toBe("00:00");
  });
});
