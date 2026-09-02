// Truth-in-copy guard for FIELD HOCKEY'S FORMAT NUMBERS in the scoring help
// tree (ScoringPad v3, R8 sweep).
//
// WHY THIS EXISTS. `content/help/scoring/hockey.md` told scorers that the
// `youth` format "shortens the quarters to ten minutes and changes nothing
// else". The engine has declared three overrides on that variant since W5
// (#416) — `periods`, `strength` AND `suspensions.classes` — so a scorer
// running a youth division was told the team strength and the card durations
// were the adult ones, and both were wrong on the pad in front of them. The
// sentence was not invented here: it was copied forward from
// `packages/engine/src/sports/hockey/DOMAIN.md`'s "Shorter quarters for youth"
// row, whose note still read "The only thing the variant changes" two waves
// after the row below it superseded it. One stale row, two documents.
//
// WHY IT DERIVES RATHER THAN TABULATES. AGENTS.md failure class 19: a table of
// expected numbers typed into a test asserts yesterday's rulebook and goes
// stale in exactly the way the prose did. Every number below is read out of
// `hockey.configSchema.parse(hockey.variants[...])` — the same parse the pad
// itself runs — so changing a variant in the engine moves this test with it
// instead of leaving it green against the old figures.
//
// WHY IT PINS THE ASSOCIATION, NOT JUST THE PRESENCE. Same failure class: a
// page that carries `10v11`, `6v7`, "two", "five", "one" and "three" SOMEWHERE
// satisfies a containment check while attributing every one of them to the
// wrong format. So each number must sit next to the format label it belongs to
// (`PROXIMITY` chars), inside a sentence that names that format.
//
// LOCATION. `src/lib/__tests__/` — the unit shards run the whole apps/web
// suite, and the smoke-db job additionally selects `src/server src/lib`
// (.github/workflows/ci.yml), so a guard parked here runs in both.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hockey } from "@seazn/engine/sports/hockey";

const PAGE = join(process.cwd(), "content/help/scoring/hockey.md");

/** How close a number has to sit to the thing it describes. Wide enough for
 *  "a green is two minutes", narrow enough that the OTHER card's duration in
 *  the same sentence cannot stand in for it — which is the swap this bound
 *  exists to catch. Pinned by the mutation transcript in the commit. */
const PROXIMITY = 20;

/** Keyed by the value, NOT by position — a positional array silently maps 15
 *  to whatever sits at index 15, which read `undefined` here and quietly
 *  narrowed the quarter-length check to the numeral. Caught by the first red
 *  run; recorded because the failure mode is a WEAKER guard, not a louder one. */
const WORDS: Readonly<Record<number, string>> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven",
  8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 15: "fifteen",
  20: "twenty", 30: "thirty",
};

/** A number as the page is allowed to write it: the numeral or the English
 *  word. Anchored on word boundaries so 3 does not match inside `3/1/0`. */
function numberAlt(n: number): string {
  const word = WORDS[n];
  return word === undefined ? `\\b${n}\\b` : `(?:\\b${n}\\b|\\b${word}\\b)`;
}

interface CardClass {
  readonly minutes: number | null;
}
interface HockeyCfg {
  readonly periods: { readonly count: number; readonly minutes: number };
  readonly strength: { readonly base: number; readonly min: number };
  readonly suspensions: { readonly classes: Record<string, CardClass> };
}

/** The cfg the product would actually run for a named variant — parsed through
 *  the module's own schema, never hand-written, so every default the schema
 *  applies is present exactly as the pad sees it. */
function cfgFor(variant: string | null): HockeyCfg {
  // Named `sport`, not `module` — `@next/next/no-assign-module-variable`.
  const sport = hockey as unknown as {
    variants?: Record<string, unknown>;
    configSchema: { parse: (value: unknown) => unknown };
  };
  const preset = variant === null ? {} : (sport.variants ?? {})[variant];
  expect(preset, `hockey module declares no variant "${variant}"`).toBeDefined();
  return sport.configSchema.parse(preset) as HockeyCfg;
}

/** The two format families the page names, each with the label the prose uses
 *  for it. `fih-outdoor` and `fih-shootout` share every number checked here —
 *  asserted below rather than assumed — so one "FIH" row covers both. */
const FORMATS = [
  { label: "FIH", variant: "fih-outdoor" },
  { label: "Youth", variant: "youth" },
] as const;

function sentences(markdown: string): string[] {
  return markdown.split(/(?<=[.!?])\s+/);
}

/** Sentences that name this format. */
function sentencesNaming(markdown: string, label: string): string[] {
  const re = new RegExp(`\\b${label}\\b`, "i");
  return sentences(markdown).filter((s) => re.test(s));
}

/** Whether some sentence naming `label` puts `after` within PROXIMITY chars of
 *  `anchor`. Direction matters: the page reads "a green is two minutes", so the
 *  anchor comes first and a swapped pair pushes the wrong number out of range
 *  (or behind the anchor) rather than quietly satisfying the check. */
function pairedNear(markdown: string, label: string, anchor: string, after: string): boolean {
  const re = new RegExp(`${anchor}[^.!?]{0,${PROXIMITY}}?${after}`, "i");
  return sentencesNaming(markdown, label).some((s) => re.test(s));
}

describe("field hockey help copy ⇄ the engine's own format declarations", () => {
  const markdown = readFileSync(PAGE, "utf8");

  it("reads the page it is guarding (the scan is not vacuous)", () => {
    expect(markdown.length).toBeGreaterThan(1000);
    expect(markdown).toMatch(/^title: Scoring field hockey$/m);
    for (const { label } of FORMATS) {
      expect(
        sentencesNaming(markdown, label).length,
        `hockey.md never names the "${label}" format`,
      ).toBeGreaterThan(0);
    }
  });

  it("the two FIH presets really do share every number this guard checks", () => {
    // The fixture assumption behind one "FIH" row covering both. If a future
    // wave gives `fih-shootout` its own strength or card ladder, this reds and
    // the page owes that format a sentence of its own.
    const outdoor = cfgFor("fih-outdoor");
    const shootout = cfgFor("fih-shootout");
    expect(shootout.strength).toEqual(outdoor.strength);
    expect(shootout.suspensions.classes).toEqual(outdoor.suspensions.classes);
    expect(shootout.periods).toEqual(outdoor.periods);
  });

  it("youth diverges from FIH on every number checked (the guard can witness a regression)", () => {
    // AGENTS.md failure class 19: if the right answer equalled the wrong one,
    // every assertion below would pass against copy that ignored the variant
    // entirely — which is precisely the defect this file exists for.
    const adult = cfgFor("fih-outdoor");
    const youth = cfgFor("youth");
    expect(youth.periods.minutes).not.toBe(adult.periods.minutes);
    expect(youth.strength.base).not.toBe(adult.strength.base);
    for (const key of ["green", "yellow"]) {
      const a = adult.suspensions.classes[key]?.minutes;
      const y = youth.suspensions.classes[key]?.minutes;
      expect(typeof a, `adult ${key} has no numeric duration`).toBe("number");
      expect(typeof y, `youth ${key} has no numeric duration`).toBe("number");
      expect(y, `${key} is the same length in both formats`).not.toBe(a);
    }
  });

  it("does not repeat DOMAIN.md's superseded 'nothing else changes' claim", () => {
    // The literal regression. `youth` overrides three cfg branches, and the
    // page said one.
    expect(
      markdown,
      "hockey.md still tells scorers the youth format changes nothing but its quarters",
    ).not.toMatch(/changes nothing else/i);
  });

  it("quotes each format's quarter length beside that format's own name", () => {
    for (const { label, variant } of FORMATS) {
      const { periods } = cfgFor(variant);
      expect(
        pairedNear(markdown, label, numberAlt(periods.minutes), "minute"),
        `hockey.md does not say ${label} plays ${periods.minutes}-minute quarters`,
      ).toBe(true);
    }
  });

  it("quotes each format's strength chip beside that format's own name", () => {
    // The chip is `${home}v${away}` (`period/suspensions.ts`'s `strengthChip`),
    // hidden while both sides stand at `strength.base` — so one card against
    // the home side reads base-1 v base. Derived, not typed in: 10v11 on the
    // eleven-a-side FIH formats, 6v7 on seven-a-side youth.
    for (const { label, variant } of FORMATS) {
      const { strength } = cfgFor(variant);
      const chip = `${strength.base - 1}v${strength.base}`;
      expect(
        pairedNear(markdown, label, chip, `\\b${label}\\b`),
        `hockey.md does not attribute the strength chip \`${chip}\` to ${label}`,
      ).toBe(true);
    }
  });

  it("quotes each format's own card durations beside that card's colour", () => {
    for (const { label, variant } of FORMATS) {
      const classes = cfgFor(variant).suspensions.classes;
      for (const [colour, cls] of Object.entries(classes)) {
        if (cls.minutes === null) continue; // red is permanent — no duration to quote
        expect(
          pairedNear(markdown, label, `\\b${colour}\\b`, numberAlt(cls.minutes)),
          `hockey.md does not say a ${colour} card runs ${cls.minutes} minute(s) on ${label} ` +
            `— every card duration must sit beside its own colour, in a sentence naming its format`,
        ).toBe(true);
      }
    }
  });

  it("says a red card has no duration to quote", () => {
    // Positive evidence, not silence: `classIsPermanent` skips the Minutes step
    // only for a class declaring `minutes: null`, and a scorer who does not know
    // that reads the missing step as a bug.
    const red = cfgFor("fih-outdoor").suspensions.classes.red;
    expect(red?.minutes, "fixture assumption: hockey's red is permanent").toBeNull();
    expect(markdown, "hockey.md never says a red card has no duration step").toMatch(
      // `\bred\b`, not bare `red` — "declared", "scored" and "recorded" all
      // carry the substring, and an unanchored probe passes on prose that never
      // mentions a card at all.
      /\bred\b[^.!?]{0,120}?(no duration|rest of the match|skipped)/i,
    );
  });
});
