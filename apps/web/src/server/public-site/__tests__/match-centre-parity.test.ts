// Spectator surface W1, Task 9 — the parity test that proves every key
// `buildMatchCentre` (match-centre.ts) can actually emit exists as a
// non-empty string in all four locale dictionaries. Unlike Task 8's
// dictionary-coverage test (match-centre-dictionary.test.ts), which derives
// its vocabulary from RENDERER-side sources (components/public-site/**,
// server/public-site/** as a whole, lib/timeline-keys.ts) plus a few
// hand-pinned dynamic families, THIS test derives its vocabulary from
// match-centre.ts's OWN exported kind lists (`DISMISSAL_KINDS`,
// `RESULT_KINDS`, `BALL_GLYPH_KINDS`) and a source scan of ONLY that one
// file — so a change to the builder's own vocabulary (a renamed kind, a new
// fixed key) is caught here even before any renderer names it.
//
// No DB needed — pure source/dictionary inspection.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BALL_GLYPH_KINDS, BALL_LINE_KEYS, DISMISSAL_KINDS, RESULT_KINDS, RESULT_MARGIN_KEYS } from "../match-centre";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__ -> public-site.
const MATCH_CENTRE_SOURCE = join(HERE, "../match-centre.ts");

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS: Record<(typeof LOCALES)[number], Dict> = { en, es, fr, nl } as unknown as Record<
  (typeof LOCALES)[number],
  Dict
>;

/** Strip `//` line comments and `/* ... *\/` block comments before scanning —
 *  the brief's own instruction ("exclude comments"). In practice every
 *  comment in match-centre.ts references a key via BACKTICKS
 *  (`` `matchCentre.result.forfeit` ``), never a double-quoted literal, so
 *  this makes no observable difference today (verified by hand: the one
 *  comment-line double-quoted match, a `dismissal.out_unknown` citation at
 *  the top of `dismissalMsg`, duplicates a REAL code literal two lines
 *  below it) — stripped anyway so a future comment written differently
 *  can't silently inflate the required vocabulary.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every double-quoted `"matchCentre.…"` / `"timeline.…"` / `"term.…"`
 *  literal in match-centre.ts's own source — the fixed keys the builder
 *  emits outside its three dynamic kind families (which use backtick
 *  templates, e.g. `` `matchCentre.dismissal.${d.kind}` ``, and so never
 *  match this double-quote-only regex — the three families are covered
 *  separately below via the module's own exported kind lists). A key ending
 *  in "." is excluded (same guard as Task 8's scanner) though none of
 *  match-centre.ts's own literals are bare prefixes today.
 */
const KEY_LITERAL = /"((?:matchCentre|timeline|term)\.[A-Za-z0-9_.]+)"/g;

function scanFixedKeys(): string[] {
  const source = stripComments(readFileSync(MATCH_CENTRE_SOURCE, "utf8"));
  const keys = new Set<string>();
  for (const match of source.matchAll(KEY_LITERAL)) {
    const key = match[1]!;
    if (!key.endsWith(".")) keys.add(key);
  }
  return [...keys];
}

const FIXED_KEYS = scanFixedKeys();

const DERIVED_KEYS = [
  ...new Set([
    ...FIXED_KEYS,
    ...DISMISSAL_KINDS.map((k) => `matchCentre.dismissal.${k}`),
    ...RESULT_KINDS.map((k) => `matchCentre.result.${k}`),
    // `matchCentre.ballLine.*` (with `.one`/`.other` on the four kinds that
    // carry a run count), NOT `matchCentre.ball.*`: the latter prefix belongs
    // to the glyph-label family and the two collided on `wicket`, which is
    // how a wicket line shipped rendering the bare word "Wicket".
    ...BALL_LINE_KEYS,
    // The worded cricket margin (owner decision 2026-09-16): unit × DLS ×
    // `.one`/`.other`, derived from the same table `cricketMarginMsg` reads.
    ...RESULT_MARGIN_KEYS,
  ]),
].sort();

describe("match-centre parity — every key buildMatchCentre can emit exists in all four dictionaries", () => {
  it("the source scan and the exported kind families both found a real vocabulary, not an empty one", () => {
    expect(FIXED_KEYS.length).toBeGreaterThanOrEqual(15);
    expect(DISMISSAL_KINDS.length).toBe(12);
    // 10 since `shootout` joined `WIN_METHODS`: football's and ice hockey's win
    // method was missing, so it fell through to `regulation` and the page lost
    // "on penalties" entirely. Kept EXACT rather than a floor — this number
    // moving is what forces the four dictionaries to gain the key alongside,
    // which is the per-locale assertion below.
    expect(RESULT_KINDS.length).toBe(10);
    expect(BALL_GLYPH_KINDS.length).toBe(7);
    // 11, not 7: four of the seven kinds inflect, so each contributes a
    // `.one` and an `.other`. EXACT for the same reason `RESULT_KINDS` is —
    // this number moving is what forces all four dictionaries to gain the
    // new form alongside.
    expect(BALL_LINE_KEYS.length).toBe(11);
    // 10: runs, wickets, DLS runs, DLS wickets and the innings victory, each a
    // `.one` and an `.other`. EXACT, for the same reason as the two above.
    expect(RESULT_MARGIN_KEYS.length).toBe(10);
    expect(DERIVED_KEYS.length).toBeGreaterThanOrEqual(30);
  });

  for (const locale of LOCALES) {
    it(`${locale} has every key buildMatchCentre can emit as a non-empty string`, () => {
      const dict = DICTS[locale];
      const missing: string[] = [];
      for (const key of DERIVED_KEYS) {
        const value = dict[key];
        if (typeof value !== "string" || value === "") missing.push(key);
      }
      expect(missing).toEqual([]);
    });
  }

  it("every locale's template names EXACTLY the same {param} set as English, for every key", () => {
    const paramsOf = (s: string): string[] =>
      [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
    const mismatches: string[] = [];
    for (const key of DERIVED_KEYS) {
      const enValue = DICTS.en[key];
      if (typeof enValue !== "string") continue; // reported by the existence test above
      const enParams = paramsOf(enValue);
      for (const locale of LOCALES) {
        if (locale === "en") continue;
        const value = DICTS[locale][key];
        if (typeof value !== "string") continue; // ditto
        const params = paramsOf(value);
        if (params.join(",") !== enParams.join(",")) {
          mismatches.push(`${locale}:${key} — en=[${enParams.join(",")}] ${locale}=[${params.join(",")}]`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  /**
   * The `.one`/`.other` narrowing in `ballLineCategory` is an ASSUMPTION about
   * the shipped locales, so it is asserted rather than trusted: for every
   * locale, every inflecting kind, and every run count a single delivery can
   * carry, the key the builder will name must actually exist. If a fifth
   * locale ever needs a third CLDR form for these magnitudes, this reds —
   * instead of a spectator reading a raw dictionary key off the page.
   *
   * 0..6 is the real domain: 0-6 off the bat, and byes/leg byes/penalties in
   * the same range. It deliberately includes 0 (English "0 runs" — the plural
   * form, which is the case a naive `count === 1 ? one : other` would get
   * right but a `count > 1` test would not) and 1 (the only singular).
   */
  it("every locale resolves a REAL template for every inflecting kind at every run count a ball can carry", () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      for (const kind of ["runs", "bye", "legbye", "penalty"]) {
        for (let runs = 0; runs <= 6; runs += 1) {
          const category = new Intl.PluralRules(locale).select(runs) === "one" ? "one" : "other";
          const key = `matchCentre.ballLine.${kind}.${category}`;
          if (typeof DICTS[locale][key] !== "string") missing.push(`${locale}:${key} (runs=${runs})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * Same narrowing, applied to a MARGIN: a count that can be 0 (a chase won
   * with the last man out on the winning run — French selects `one` there)
   * or run into the hundreds (an innings victory). Every margin family, every
   * locale, a spread of real magnitudes — the key the builder names must exist.
   */
  it("every locale resolves a REAL template for every margin family at every magnitude a margin can reach", () => {
    const families = [...new Set(RESULT_MARGIN_KEYS.map((k) => k.replace(/\.(one|other)$/, "")))];
    expect(families.length).toBe(5);
    const missing: string[] = [];
    for (const locale of LOCALES) {
      for (const family of families) {
        for (const count of [0, 1, 2, 3, 11, 21, 100, 101, 250]) {
          const category = new Intl.PluralRules(locale).select(count) === "one" ? "one" : "other";
          const key = `${family}.${category}`;
          if (typeof DICTS[locale][key] !== "string") missing.push(`${locale}:${key} (count=${count})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * The collision this namespace exists to prevent, pinned in both directions.
   * `matchCentre.ball.wicket` is the GLYPH label ("Wicket"); the line the
   * commentary tab renders is `matchCentre.ballLine.wicket`. They are
   * different strings with different jobs, and the bug was the line resolving
   * to the label — so asserting the line key merely EXISTS would pass in
   * exactly the broken state. Both halves are asserted: the line carries the
   * over notation and the bowler like every other ball line, and the label
   * does not.
   */
  it("the ball-LINE and glyph-LABEL families stay separate — a wicket line is not the bare glyph label", () => {
    for (const locale of LOCALES) {
      const line = DICTS[locale]["matchCentre.ballLine.wicket"];
      const label = DICTS[locale]["matchCentre.ball.wicket"];
      expect(typeof line, `${locale}: the wicket LINE must exist`).toBe("string");
      expect(typeof label, `${locale}: the wicket glyph LABEL must exist`).toBe("string");
      expect(line, `${locale}: the wicket line must not be the glyph label`).not.toBe(label);
      expect(line as string, `${locale}: a ball line carries the over notation`).toContain("{over}");
      expect(line as string, `${locale}: a ball line names the bowler`).toContain("{bowler}");
      expect(label as string, `${locale}: the glyph label takes no params`).not.toContain("{");
    }
  });
});
