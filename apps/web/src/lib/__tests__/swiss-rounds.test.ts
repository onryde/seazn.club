// Swiss Playoff's round budget scales with the field (owner: "scale with
// field size"). Every boundary is pinned on BOTH sides — an off-by-one in a
// `<=` chain is exactly the defect a single sample per band cannot see.
import { describe, expect, it } from "vitest";
import { SWISS_ROUNDS_BANDS, swissRoundsForFieldSize } from "@/lib/swiss-rounds";

describe("swissRoundsForFieldSize — the owner's table", () => {
  it.each([
    [2, 3],
    [8, 3],
    [9, 4],
    [16, 4],
    [17, 5],
    [32, 5],
    [33, 6],
    [64, 6],
    [65, 7],
    [1000, 7],
  ])("a field of %i plays %i rounds", (entrants, rounds) => {
    expect(swissRoundsForFieldSize(entrants)).toBe(rounds);
  });

  it("never returns fewer rounds for a bigger field (monotone across the whole range)", () => {
    let last = swissRoundsForFieldSize(1);
    for (let n = 2; n <= 130; n++) {
      const here = swissRoundsForFieldSize(n);
      expect(here, `field ${n}`).toBeGreaterThanOrEqual(last);
      last = here;
    }
  });

  it("floors a field too small to pair at the smallest band rather than returning 0", () => {
    // A division can legitimately be asked for a preview at 0/1 entrants.
    expect(swissRoundsForFieldSize(0)).toBe(3);
    expect(swissRoundsForFieldSize(1)).toBe(3);
    expect(swissRoundsForFieldSize(-4)).toBe(3);
  });

  it("truncates a non-integer field size rather than landing between bands", () => {
    expect(swissRoundsForFieldSize(8.9)).toBe(3); // still an 8-entrant field
    expect(swissRoundsForFieldSize(16.2)).toBe(4);
  });

  it("falls back to the smallest band for a non-finite field size", () => {
    // Both directions: a garbage read is garbage whichever way it overflows,
    // and neither should mint a 7-round event nobody asked for.
    expect(swissRoundsForFieldSize(Number.NaN)).toBe(3);
    expect(swissRoundsForFieldSize(Number.POSITIVE_INFINITY)).toBe(3);
    expect(swissRoundsForFieldSize(Number.NEGATIVE_INFINITY)).toBe(3);
  });

  // The table is data, not a chain of ifs typed twice: the test reads the
  // SAME declaration the function does, so moving a band moves both together
  // (AGENTS.md failure class 19 — derive the expectation from the source of
  // truth) while the explicit rows above still pin today's numbers.
  it("every declared band's upper bound and the value one past it disagree", () => {
    for (const band of SWISS_ROUNDS_BANDS) {
      expect(swissRoundsForFieldSize(band.upTo)).toBe(band.rounds);
      expect(swissRoundsForFieldSize(band.upTo + 1)).toBeGreaterThan(band.rounds);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// W3 Task 11 (SW-H2, RB3-3; rule X-SW-16) — round-count guidance, a warning above the safe maximum, a refusal above the
// hard maximum.
//
// THE AUTHORITY is the rulebook, not this module: rulebook-W3-swiss.md §3 ("Round count"), quoted below with its
// section. §3.1 "Bounds (n = active field at the time of pairing)":
//   Safe maximum ⌊n/2⌋ ("a rematch-free round is guaranteed whatever was paired before"; Dirac's theorem);
//   Hard maximum n − 1 for even n; n for odd n ("a legal Swiss cannot exist beyond it").
// §3.2 "Recommended rounds per field size (RB3-3)": Default = min(band(n), safeMax(n)), the band being the owner's table
// in this very file — read here as DATA (`SWISS_ROUNDS_BANDS`), never through `swissRoundsForFieldSize` (controller
// ruling R4: the sweep must not restate the production lookup in its expected path). The sweep below is therefore a
// consistency check of the formulas; the §3.2 table rows quoted after it are the independent witnesses — they are
// the mutation killers.
// Sport-independent by nature: the bounds are arithmetic on the field size (no sport reaches this module).
// ---------------------------------------------------------------------------------------------------------------------
import {
  SWISS_ROUNDS_BEYOND,
  SWISS_ROUNDS_PLURAL_KEYS,
  judgeSwissRounds,
  swissRoundsDefault,
  swissRoundsGuidance,
  swissRoundsGuidanceLine,
  swissRoundsNoticeOf,
  swissRoundsWarnNotice,
  type SwissRoundsJudgement,
  type SwissRoundsShrunk,
} from "@/lib/swiss-rounds";
import { swissRefusalText } from "@/lib/swiss-refusal-text";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Locale } from "@/lib/i18n-constants";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

/** The owner's band for a field of `n`, read off the declaration's ROWS (§3.2 "The band is the owner's existing table"). */
function bandFromData(n: number): number {
  for (const band of SWISS_ROUNDS_BANDS) if (n <= band.upTo) return band.rounds;
  return SWISS_ROUNDS_BEYOND;
}

/** §3.1's two bounds and §3.2's default, typed from the rulebook's own words. */
function rulebook(n: number): { recommended: number; safeMax: number; hardMax: number } {
  const safeMax = Math.floor(n / 2); // "⌊n/2⌋"
  const hardMax = n % 2 === 0 ? n - 1 : n; // "n − 1 for even n; n for odd n"
  return { recommended: Math.min(bandFromData(n), safeMax), safeMax, hardMax }; // "min(band(n), safeMax(n))"
}

describe("X-SW-16 round guidance (rulebook §3.1/§3.2)", () => {
  it("X-SW-16 guidance follows rulebook §3.1 for n = 2..130", () => {
    let checked = 0;
    for (let n = 2; n <= 130; n++) {
      expect(swissRoundsGuidance(n), `field ${n}`).toEqual(rulebook(n));
      checked++;
    }
    // Anti-vacuity: 2..130 inclusive is 129 fields. Zero checked is a failure.
    expect(checked, "fields checked").toBe(129);
  });

  // §3.2's table, row by row, as the rulebook prints it (rulebook-W3-swiss.md §3.2, "| n | 2 | 3 | 4 | 5 | 6 | 7 | 8 |"):
  //   safe max ⌊n/2⌋        | 1 | 1 | 2 | 2 | 3 | 3 | 4 |
  //   hard max               | 1 | 3 | 3 | 5 | 5 | 7 | 7 |
  //   recommended default    | 1 | 1 | 2 | 2 | 3 | 3 | 3 |
  // and its banded tail: "9–16 → 4", "17–32 → 5", "33–64 → 6", "65+ → 7" (each band's recommended default).
  it.each([
    // [n, recommended, safeMax, hardMax] — the brief's three anchors first: n=6 → 3/3/5; n=8 → 3/4/7; n=3 → 1/1/3.
    [6, 3, 3, 5],
    [8, 3, 4, 7],
    [3, 1, 1, 3],
    [2, 1, 1, 1],
    [4, 2, 2, 3],
    [5, 2, 2, 5],
    [7, 3, 3, 7],
  ])("§3.2 table: a field of %i — %i recommended, safe max %i, hard max %i", (n, recommended, safeMax, hardMax) => {
    expect(swissRoundsGuidance(n)).toEqual({ recommended, safeMax, hardMax });
  });

  it.each([
    [9, 4],
    [16, 4],
    [17, 5],
    [32, 5],
    [33, 6],
    [64, 6],
    [65, 7],
    [130, 7],
  ])("§3.2 table's banded tail: a field of %i recommends %i", (n, recommended) => {
    expect(swissRoundsGuidance(n).recommended).toBe(recommended);
  });

  // The ordering differential: the builder's old default 5 is the wrong answer for the field the rulebook's audit probe
  // names ("6 × 5 (builder default) dead-ends in 15.5% of events", §3.1), and the right one differs from it.
  it("n = 6 recommends 3, not the builder's old 5", () => {
    expect(swissRoundsGuidance(6).recommended).toBe(3);
    expect(swissRoundsGuidance(6).recommended).not.toBe(5);
  });

  it("refuses to guide a field too small to pair (under 2) or a non-integer field, by name", () => {
    for (const bad of [1, 0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => swissRoundsGuidance(bad), String(bad)).toThrow(/swiss round guidance needs a field of 2 or more/);
    }
  });
});

describe("X-SW-16 swissRoundsDefault — what a new Swiss's Rounds box opens at", () => {
  it("the field's recommendation; the band for up to 8 when there is no pairable field yet", () => {
    // §3.2: 6 → 3, 4 → 2, 40 → 6 (band 33–64); no field → the owner's first band, "up to 8 → 3".
    const cases: [number | undefined, number][] = [[6, 3], [4, 2], [40, 6], [2, 1], [undefined, 3], [0, 3], [1, 3]];
    let checked = 0;
    for (const [field, want] of cases) {
      expect(swissRoundsDefault(field), String(field)).toBe(want);
      checked++;
    }
    expect(checked).toBe(7);
  });
});

describe("X-SW-16 judgeSwissRounds — warn above the safe max, refuse above the hard max", () => {
  // §3.1's own audit probe and §3.1's correction, quoted:
  //   "6 × 5 (builder default) … 5 exceeds the safe maximum of 3 and is within the hard maximum of 5" → warn;
  //   "6×3 and 8×3 are within the safe maximum" → ok;
  //   "4×3, 5×5, 6×3, 7×5, 8×5, 10×5, 12×5, 8×3 … are within the hard maximum" → never refused;
  //   "SW-H1's example (4 × 5) is even and does hold" → refused;
  //   "For an odd field, n rounds is feasible … The impossibility starts at n+1" → 5 × 5 allowed, 5 × 6 refused.
  it.each([
    [5, 6, "warn"],
    [3, 6, "ok"],
    [3, 8, "ok"],
    [3, 4, "warn"],
    [5, 5, "warn"],
    [5, 7, "warn"],
    [5, 8, "warn"],
    [5, 10, "ok"],
    [5, 12, "ok"],
    [5, 4, "refuse"],
    [6, 5, "refuse"],
    [6, 6, "refuse"],
    [1, 2, "ok"],
    [2, 2, "refuse"],
  ] as const)("%i rounds over a field of %i: %s", (rounds, field, verdict) => {
    expect(judgeSwissRounds(rounds, field).verdict).toBe(verdict);
  });

  it("carries the field's guidance with every verdict", () => {
    expect(judgeSwissRounds(5, 6)).toEqual({ verdict: "warn", recommended: 3, safeMax: 3, hardMax: 5 });
    expect(judgeSwissRounds(5, 4)).toEqual({ verdict: "refuse", recommended: 2, safeMax: 2, hardMax: 3 });
    expect(judgeSwissRounds(3, 8)).toEqual({ verdict: "ok", recommended: 3, safeMax: 4, hardMax: 7 });
  });

  it("the verdict sweep: every round count from 1 to one past the hard max, for every field 2..130", () => {
    let checked = 0;
    const seen = new Set<string>();
    for (let n = 2; n <= 130; n++) {
      const { safeMax, hardMax } = rulebook(n);
      for (let rounds = 1; rounds <= hardMax + 1; rounds++) {
        // §3.2: "Between the safe and the hard maximum: allowed, with a plain warning"; "Above the hard maximum: refused".
        const want = rounds > hardMax ? "refuse" : rounds > safeMax ? "warn" : "ok";
        expect(judgeSwissRounds(rounds, n).verdict, `${rounds} over ${n}`).toBe(want);
        seen.add(want);
        checked++;
      }
    }
    // Every field contributes hardMax + 1 cases; the three verdicts all occur.
    expect(checked, "(rounds, field) pairs judged").toBe(
      Array.from({ length: 129 }, (_, i) => rulebook(i + 2).hardMax + 1).reduce((a, b) => a + b, 0),
    );
    expect([...seen].sort()).toEqual(["ok", "refuse", "warn"]);
  });

  it("refuses a round count that is not a whole number of at least 1, by name", () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() => judgeSwissRounds(bad, 8), String(bad)).toThrow(/swiss rounds must be a whole number of at least 1/);
    }
  });
});

const DICTS = { en, es, fr, nl } as unknown as Record<Locale, Record<string, string>>;
const LOCALES = Object.keys(DICTS) as Locale[];
const pluralIn = (locale: Locale) => (key: string, count: number, vars?: Record<string, string | number>) =>
  pluralRuntime(DICTS[locale], key, count, locale, vars);
const msgIn = (locale: Locale) => (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS[locale], key, vars);

describe("X-SW-16 the guidance line and the warn notice (4 locales)", () => {
  it("every plural base has .one and .other in all four locales, translated, with en's placeholders", () => {
    let checked = 0;
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const base of SWISS_ROUNDS_PLURAL_KEYS) {
      for (const form of ["one", "other"]) {
        const key = `${base}.${form}`;
        for (const locale of LOCALES) {
          const text = DICTS[locale][key];
          expect(typeof text === "string" && text.trim() !== "", `${locale}: ${key}`).toBe(true);
          expect(holes(text!), `${locale}: ${key} placeholders`).toEqual(holes(DICTS.en[key]!));
          if (locale !== "en") expect(text, `${locale}: ${key} is translated`).not.toBe(DICTS.en[key]);
          checked++;
        }
      }
    }
    expect(checked, "(key, form, locale) triples").toBe(SWISS_ROUNDS_PLURAL_KEYS.length * 2 * 4);
  });

  // The approved English, typed here (the brief's line "For {n} players: {recommended} rounds recommended, at most
  // {hardMax}", with the desk's noun "entrants" — a pair or a team is one), never read off the function under test.
  it("the guidance line for 8 entrants (§3.2: 3 recommended, hard max 7)", () => {
    expect(swissRoundsGuidanceLine(8, pluralIn("en"))).toBe("For 8 entrants: 3 rounds recommended, at most 7.");
  });

  it("the guidance line says ONE round for a field whose recommendation is 1 (n = 2 and 3), never '1 rounds'", () => {
    expect(swissRoundsGuidanceLine(2, pluralIn("en"))).toBe("For 2 entrants: 1 round recommended, at most 1.");
    expect(swissRoundsGuidanceLine(3, pluralIn("en"))).toBe("For 3 entrants: 1 round recommended, at most 3.");
    // Every locale picks its ONE form for a recommendation of 1 and its OTHER form for 3 (each dictionary's own copy).
    const fill = (s: string, v: Record<string, number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
    for (const locale of LOCALES) {
      const d = DICTS[locale];
      expect(swissRoundsGuidanceLine(3, pluralIn(locale)), locale).toBe(fill(d["swiss.rounds.guidance.one"]!, { n: 3, count: 1, hardMax: 3 }));
      expect(swissRoundsGuidanceLine(6, pluralIn(locale)), locale).toBe(fill(d["swiss.rounds.guidance.other"]!, { n: 6, count: 3, hardMax: 5 }));
    }
  });

  it("every locale fills the field, the recommendation and the hard max", () => {
    for (const locale of LOCALES) {
      const line = swissRoundsGuidanceLine(12, pluralIn(locale))!; // §3.2: 9–16 → 4; hard max 11
      expect(line, locale).toMatch(/12/);
      expect(line, locale).toMatch(/\b4\b/);
      expect(line, locale).toMatch(/11/);
      expect(line, locale).not.toMatch(/\{/);
    }
  });

  it("no guidance line for a field too small to pair (an empty division, one entrant)", () => {
    expect(swissRoundsGuidanceLine(0, pluralIn("en"))).toBeNull();
    expect(swissRoundsGuidanceLine(1, pluralIn("en"))).toBeNull();
  });

  const WARN_6x5: SwissRoundsJudgement = { verdict: "warn", recommended: 3, safeMax: 3, hardMax: 5 };

  it("the warn notice fills the safe max, the recommendation and the hard max from the judgement", () => {
    expect(swissRoundsWarnNotice(WARN_6x5, pluralIn("en"))).toBe(
      "With more than 3 rounds, a later round may have no pairing that avoids a rematch. If that happens, you can finish the Swiss with the rounds already played. Recommended for this field: 3, at most 5.",
    );
    // A field of 3 (safe max 1) says ONE round.
    expect(swissRoundsWarnNotice({ verdict: "warn", recommended: 1, safeMax: 1, hardMax: 3 }, pluralIn("en"))).toMatch(
      /^With more than 1 round, /,
    );
    for (const locale of LOCALES) {
      const line = swissRoundsWarnNotice({ verdict: "warn", recommended: 4, safeMax: 6, hardMax: 13 }, pluralIn(locale))!;
      expect(line, locale).toMatch(/\b6\b/);
      expect(line, locale).toMatch(/\b4\b/);
      expect(line, locale).toMatch(/\b13\b/);
      expect(line, locale).not.toMatch(/\{/);
    }
  });

  it("no warn notice without a warn verdict: absent, ok, or refuse", () => {
    expect(swissRoundsWarnNotice(undefined, pluralIn("en"))).toBeNull();
    expect(swissRoundsWarnNotice({ ...WARN_6x5, verdict: "ok" }, pluralIn("en"))).toBeNull();
    expect(swissRoundsWarnNotice({ ...WARN_6x5, verdict: "refuse" }, pluralIn("en"))).toBeNull();
  });

  // Fix round 1 (ruling on review m2): a running Swiss shrank to 4 under 5 rounds and a round within the new hard max
  // (§3.2: n = 4 → at most 3) still paired.
  const SHRUNK_6x5_TO_4: SwissRoundsShrunk = {
    verdict: "shrunk", rounds: 5, field: 4, recommended: 2, safeMax: 2, hardMax: 3, canFinish: true,
  };

  it("the shrunk notice names the field left and the rounds it can still reach, and both ways to finish", () => {
    expect(swissRoundsWarnNotice(SHRUNK_6x5_TO_4, pluralIn("en"))).toBe(
      "4 entrants left: this Swiss can reach at most 3 rounds. Finish after round 3, or finish now.",
    );
    // A field of 2 reaches ONE round.
    expect(swissRoundsWarnNotice({ ...SHRUNK_6x5_TO_4, field: 2, hardMax: 1 }, pluralIn("en"))).toBe(
      "2 entrants left: this Swiss can reach at most 1 round. Finish after round 1, or finish now.",
    );
    let checked = 0;
    for (const locale of LOCALES) {
      const line = swissRoundsWarnNotice({ ...SHRUNK_6x5_TO_4, field: 12, hardMax: 11 }, pluralIn(locale))!;
      expect(line, locale).toMatch(/\b12\b/);
      expect(line, locale).toMatch(/\b11\b/);
      expect(line, locale).not.toMatch(/\{/);
      if (locale !== "en") expect(line, `${locale} is translated`).not.toBe(swissRoundsWarnNotice({ ...SHRUNK_6x5_TO_4, field: 12, hardMax: 11 }, pluralIn("en")));
      checked++;
    }
    expect(checked, "locales").toBe(4);
  });

  it("re-review n1: before any round is complete (a round-1 Pair after no-shows withdrew) the shrunk notice never offers 'finish now'", () => {
    const later = { ...SHRUNK_6x5_TO_4, canFinish: false };
    expect(swissRoundsWarnNotice(later, pluralIn("en"))).toBe("4 entrants left: this Swiss can reach at most 3 rounds. Finish after round 3.");
    expect(swissRoundsWarnNotice({ ...later, field: 2, hardMax: 1 }, pluralIn("en"))).toBe(
      "2 entrants left: this Swiss can reach at most 1 round. Finish after round 1.",
    );
    let checked = 0;
    for (const locale of LOCALES) {
      const now = swissRoundsWarnNotice({ ...SHRUNK_6x5_TO_4, field: 12, hardMax: 11 }, pluralIn(locale))!;
      const notYet = swissRoundsWarnNotice({ ...later, field: 12, hardMax: 11 }, pluralIn(locale))!;
      expect(notYet, locale).toMatch(/\b12\b/);
      expect(notYet, locale).toMatch(/\b11\b/);
      expect(notYet, locale).not.toMatch(/\{/);
      expect(notYet, `${locale}: the not-yet line is its own copy, not the finish-now one`).not.toBe(now);
      expect(now.startsWith(notYet.slice(0, -1)), `${locale}: the not-yet line is the finish-now line without its last clause`).toBe(true);
      checked++;
    }
    expect(checked, "locales").toBe(4);
  });

  it("the answer's notice: a warn and a shrunk ride on it; ok, a refuse and nothing do not", () => {
    expect(swissRoundsNoticeOf(WARN_6x5)).toEqual(WARN_6x5);
    expect(swissRoundsNoticeOf(SHRUNK_6x5_TO_4)).toEqual(SHRUNK_6x5_TO_4);
    expect(swissRoundsNoticeOf({ ...WARN_6x5, verdict: "ok" })).toBeUndefined();
    expect(swissRoundsNoticeOf({ ...WARN_6x5, verdict: "refuse" })).toBeUndefined();
    expect(swissRoundsNoticeOf(null)).toBeUndefined();
    expect(swissRoundsNoticeOf(undefined)).toBeUndefined();
  });
});

describe("X-SW-16 swissRefusalText — a Swiss refusal in the reader's language", () => {
  it("SWISS_ROUNDS_ABOVE_MAX names the field's guidance after the refusal sentence", () => {
    expect(swissRefusalText("SWISS_ROUNDS_ABOVE_MAX", { rounds: 5, field: 4, hardMax: 3 }, msgIn("en"), pluralIn("en"))).toBe(
      `${SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message} For 4 entrants: 2 rounds recommended, at most 3.`,
    );
    for (const locale of LOCALES) {
      const text = swissRefusalText("SWISS_ROUNDS_ABOVE_MAX", { rounds: 5, field: 4, hardMax: 3 }, msgIn(locale), pluralIn(locale));
      expect(text.startsWith(DICTS[locale]["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]!), locale).toBe(true);
      expect(text, locale).not.toMatch(/\{/);
    }
  });

  it("a refusal after the field shrank under a running Swiss (canFinish) says what is left and that Finish resolves it", () => {
    // The Pair-next refusal's details: 6 × 5 shrank to 4 after round 1 (§3.2: a field of 4 pairs at most 3 rounds).
    expect(
      swissRefusalText("SWISS_ROUNDS_ABOVE_MAX", { rounds: 5, field: 4, hardMax: 3, canFinish: true }, msgIn("en"), pluralIn("en")),
    ).toBe(
      `${SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message} 4 entrants remain, enough for at most 3 rounds. You can finish the Swiss with the rounds already played.`,
    );
    // A field of 2 pairs at most ONE round.
    expect(
      swissRefusalText("SWISS_ROUNDS_ABOVE_MAX", { rounds: 3, field: 2, hardMax: 1, canFinish: true }, msgIn("en"), pluralIn("en")),
    ).toMatch(/2 entrants remain, enough for at most 1 round\. /);
    for (const locale of LOCALES) {
      const text = swissRefusalText("SWISS_ROUNDS_ABOVE_MAX", { rounds: 9, field: 6, hardMax: 5, canFinish: true }, msgIn(locale), pluralIn(locale));
      expect(text, locale).toMatch(/\b6\b/);
      expect(text, locale).toMatch(/\b5\b/);
      expect(text, locale).not.toMatch(/\{/);
      // Not the guidance line: once rounds are played the count is fixed (T12), so "recommended" would mislead.
      expect(text, locale).not.toContain(swissRoundsGuidanceLine(6, pluralIn(locale))!);
    }
  });

  it("a refusal whose details do not name a pairable field says the sentence alone; another code says its own", () => {
    expect(swissRefusalText("SWISS_ROUNDS_ABOVE_MAX", undefined, msgIn("en"), pluralIn("en"))).toBe(
      SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message,
    );
    expect(swissRefusalText("SWISS_ROUNDS_ABOVE_MAX", { field: "4" }, msgIn("en"), pluralIn("en"))).toBe(
      SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message,
    );
    expect(swissRefusalText("SWISS_OVER", { field: 4 }, msgIn("fr"), pluralIn("fr"))).toBe(fr["swiss.refusal.SWISS_OVER"]);
  });
});
