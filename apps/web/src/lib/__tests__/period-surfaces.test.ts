// Public-surface extractors for the period/nested kernels (v6/00 §5):
// goals-by-period, strength chip, discipline list, serving side. Each fails
// without its extractor — the scorebug and /live wall read these.
import { describe, expect, it } from "vitest";
import {
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
} from "../public-site";

const periodSummary = {
  headline: "2 — 1 · P3",
  perSide: [],
  detail: {
    periods: [
      { phase: "P1", home: 1, away: 0 },
      { phase: "P2", home: 0, away: 1 },
      { phase: "P3", home: 1, away: 0 },
    ],
    strength: "5v4",
    discipline: [
      { side: "away", classKey: "minor", person: "p9" },
      { side: "home", classKey: "yellow" },
    ],
  },
};

describe("period-kernel public surfaces", () => {
  it("extracts goals by period", () => {
    expect(periodBreakdown(periodSummary)).toEqual([
      { phase: "P1", home: 1, away: 0 },
      { phase: "P2", home: 0, away: 1 },
      { phase: "P3", home: 1, away: 0 },
    ]);
    expect(periodBreakdown({ detail: {} })).toBeNull();
    expect(periodBreakdown(null)).toBeNull();
  });

  it("extracts the strength chip only when present", () => {
    expect(matchStrength(periodSummary)).toBe("5v4");
    expect(matchStrength({ detail: { strength: null } })).toBeNull();
    expect(matchStrength({ detail: {} })).toBeNull();
  });

  it("extracts the discipline list with labels", () => {
    const list = disciplineList(periodSummary);
    expect(list).toEqual([
      { side: "away", classKey: "minor", person: "p9" },
      { side: "home", classKey: "yellow" },
    ]);
    expect(disciplineLabel("double_minor")).toBe("Double minor");
  });
});

// F14 (product ruling 2026-09-10, `_THEMES.md` §2a): "a malformed discipline
// row must not erase the others". This used to `return null` on the FIRST
// entry it could not parse, discarding rows already accepted — so one bad row
// from the engine showed no cards at all, which on screen is indistinguishable
// from a clean match (AGENTS.md #6: an absent symptom can mean suppressed, not
// safe). Both directions are asserted here, because "skip the bad row" and
// "null means no data" are each satisfied on their own by the WRONG
// implementation: returning `[]` for everything passes the first, and the old
// return-null-on-first-bad-row passes the second.
describe("disciplineList survives a malformed row (F14)", () => {
  const withRows = (discipline: unknown) => ({ headline: "", perSide: [], detail: { discipline } });

  it("keeps the good rows either side of a bad one", () => {
    // Bad row BETWEEN two good ones: a `return null` on the first bad entry
    // loses the row before it as well as the row after, and an early `break`
    // would keep only the first — the middle position is what tells the three
    // implementations apart.
    const list = disciplineList(
      withRows([
        { side: "home", classKey: "minor" },
        { side: "sideline", classKey: "major" },
        { side: "away", classKey: "match", person: "p7" },
      ]),
    );
    expect(list, "one unreadable row erased the two readable ones").toEqual([
      { side: "home", classKey: "minor" },
      { side: "away", classKey: "match", person: "p7" },
    ]);
  });

  it("skips every shape of unreadable row, one at a time", () => {
    // Each row here is bad for a DIFFERENT reason the guard checks, so a
    // guard clause that stops rejecting one of them is caught on its own
    // rather than covered by its neighbour.
    for (const bad of [null, "minor", 7, {}, { side: "home" }, { classKey: "minor" }, { side: "both", classKey: "minor" }, { side: "home", classKey: 4 }]) {
      expect(disciplineList(withRows([bad, { side: "away", classKey: "red" }])), JSON.stringify(bad)).toEqual([
        { side: "away", classKey: "red" },
      ]);
    }
  });

  it("still returns null when there is no discipline data at all", () => {
    // The reserved meaning. `live-score.tsx:175/351` gates the whole panel on
    // `discipline !== null`, so an empty array here paints a "Discipline"
    // heading with no rows under it.
    expect(disciplineList({ detail: {} }), "no discipline key").toBeNull();
    expect(disciplineList({ detail: { discipline: [] } }), "an empty list").toBeNull();
    expect(disciplineList({ detail: { discipline: "minor" } }), "not a list").toBeNull();
    expect(disciplineList(null), "no summary").toBeNull();
    expect(disciplineList({}), "no detail").toBeNull();
  });

  it("returns null when EVERY row is unreadable — nothing to show is not an empty list", () => {
    expect(disciplineList(withRows([{ side: "nobody" }, null, 12]))).toBeNull();
  });
});

describe("nested-kernel public surfaces", () => {
  const tennisSummary = {
    headline: "1 — 0 · 7–6(5) · 3–2 (40–15)",
    perSide: [{ entrantId: "h" }, { entrantId: "a" }],
    detail: {
      sets: [
        { home: 7, away: 6, tb: { home: 7, away: 5 }, closed: true },
        { home: 3, away: 2, closed: false },
      ],
      serving: "away",
    },
  };

  it("tennis sets ride the shared set breakdown (closed + live)", () => {
    const breakdown = setBreakdown(tennisSummary, "tennis");
    expect(breakdown?.sets).toEqual([
      { home: 7, away: 6, closed: true },
      { home: 3, away: 2, closed: false },
    ]);
    // Task 14d — `unit` is a dictionary-KEY suffix ("game"/"set"), not a
    // display word (`public-site.ts:278-286`); the display word itself comes
    // from `matchCentre.unit.<unit>`/`matchCentre.col.<unit>` in the
    // dictionaries (see live-score.test.tsx's render-level assertions for
    // the actual English/French copy this key resolves to).
    expect(breakdown?.unit).toBe("set");
  });

  it("badminton games (a game-unit sport) also ride the shared set breakdown, with the 'game' enum", () => {
    const badmintonSummary = {
      headline: "1 — 0 (14–11)",
      perSide: [{ entrantId: "h" }, { entrantId: "a" }],
      detail: {
        sets: [{ home: 21, away: 15, closed: true }],
      },
    };
    const breakdown = setBreakdown(badmintonSummary, "badminton");
    expect(breakdown?.sets).toEqual([{ home: 21, away: 15, closed: true }]);
    expect(breakdown?.unit).toBe("game");
  });

  it("exposes the serving side for the serve dot", () => {
    expect(servingSide(tennisSummary)).toBe("away");
    expect(servingSide(periodSummary)).toBeNull();
  });
});
