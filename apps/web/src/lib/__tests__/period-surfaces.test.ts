// Public-surface extractors for the period/nested kernels (v6/00 §5):
// goals-by-period, strength chip, discipline list, serving side. Each fails
// without its extractor — the scorebug and /live wall read these.
import { describe, expect, it } from "vitest";
import {
  DISCIPLINE_LABEL_KEYS,
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
} from "../public-site";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

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
    expect(disciplineLabel("double_minor", (k) => t(en as Dict, k))).toBe("Double minor");
  });
});

// ---------------------------------------------------------------------------
// Review MINOR 9 (product ruling 2026-09-10, `_THEMES.md` §2a): THE CARD LABEL
// IS OWED IN FOUR LOCALES. `disciplineLabel` used to build it from the class
// key — `replace(/_/g," ")` plus title case — so a French, Spanish or Dutch
// stream rendered "Bench minor" and "Game misconduct" in English on air. F13
// did not introduce it (those lines already rendered) but it made five more
// classes visually prominent on a broadcast.
//
// EVERY CASE BELOW IS NON-ENGLISH ON PURPOSE. An English-only test cannot
// witness an anglicised label — it passes whether the label came from the
// dictionary or from the class key — which is precisely how this shipped past
// the four-locale rule.
// ---------------------------------------------------------------------------
const LOCALES = { en, fr, es, nl } as Record<string, unknown>;

/** What the pre-ruling implementation produced: the class key, underscores to
 *  spaces, first letter upper-cased. Kept here so the English arm can be held
 *  byte-identical rather than described as "unchanged". */
const anglicised = (classKey: string): string => {
  const label = classKey.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
};

describe("disciplineLabel is dictionary copy, not the class key in English (MINOR 9)", () => {
  const classes = Object.keys(DISCIPLINE_LABEL_KEYS);

  it("covers §2a's ten classes and nothing invented", () => {
    // The empty case FIRST: an empty map answers every `it.each` below
    // vacuously. The membership itself is derived from the sheet in
    // `overlay-model.test.ts` (which already parses §2a); this is the floor.
    expect(classes.length, "the key map is empty — every sweep below is vacuous").toBe(10);
    expect([...classes].sort()).toEqual([
      "bench_minor",
      "double_minor",
      "game_misconduct",
      "green",
      "major",
      "match",
      "minor",
      "misconduct",
      "red",
      "yellow",
    ]);
  });

  for (const locale of ["fr", "es", "nl"]) {
    it(`${locale}: every class resolves to that locale's own words`, () => {
      const dict = LOCALES[locale] as Dict;
      const english = en as Record<string, string>;
      for (const classKey of classes) {
        const label = disciplineLabel(classKey, (k) => t(dict, k));
        const key = DISCIPLINE_LABEL_KEYS[classKey]!;
        expect(label, `${locale} ${classKey} fell through to the key — copy missing`).not.toBe(key);
        expect(label, `${locale} ${classKey} is still the anglicised class key`).not.toBe(
          anglicised(classKey),
        );
        expect(label, `${locale} ${classKey} is not this locale's declared copy`).toBe(
          (dict as Record<string, string>)[key],
        );
        // The differential that makes the assertion above non-vacuous: the
        // locale's word must actually DIFFER from English, or a dictionary
        // that merely copied the English through would pass everything here.
        expect(label, `${locale} ${classKey} is byte-identical to English`).not.toBe(english[key]);
      }
    });
  }

  it("en is byte-identical to what the class-key derivation produced — English output does not move", () => {
    // The ruling is about the other three locales. Changing the English words
    // as a side effect would be an unasked-for copy change on a live
    // broadcast graphic, so this pins them.
    for (const classKey of classes) {
      expect(disciplineLabel(classKey, (k) => t(en as Dict, k)), classKey).toBe(anglicised(classKey));
    }
  });

  it("an UNDECLARED class still renders something readable rather than a raw key", () => {
    // The last-resort arm. §2a's intent is that a future class is a MISSING
    // KEY rather than a silently-anglicised label, and the completeness test
    // in `overlay-model.test.ts` is what enforces that: it reds the moment
    // §2a gains a row without a key. What must never happen on air is
    // `overlay.card.whatever` in the graphic, so the fallback stays.
    const msg = (k: string) => t(fr as Dict, k);
    expect(disciplineLabel("no_such_class", msg)).toBe("No such class");
    expect(disciplineLabel("no_such_class", msg)).not.toContain("overlay.card");
  });

  it("the resolver is actually CALLED — a mutant that ignored it would pass an English-only test", () => {
    const seen: string[] = [];
    disciplineLabel("bench_minor", (k) => {
      seen.push(k);
      return "SENTINEL";
    });
    expect(seen).toEqual(["overlay.card.benchMinor"]);
    expect(disciplineLabel("bench_minor", () => "SENTINEL")).toBe("SENTINEL");
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
