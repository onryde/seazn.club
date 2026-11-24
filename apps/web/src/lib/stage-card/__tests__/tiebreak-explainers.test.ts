// The one-line plain-language explainer under each tie-break step ("Buchholz" = "Total score of the opponents you played").
// Every expected value here comes from the engine's own declarations - its `TiebreakerKey` union (read from the shipped
// declaration file, since a type has no runtime value), every sport's default / preset orders and the keys it offers - and
// never from the code under test.
//
// Anti-vacuity (TEST-STRATEGY 2): each sweep reports how many cells it visited and a zero fails; the counts are asserted
// against the engine's registry and key union, not a number typed here.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { offerableKeys } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import type { TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import { unitExplainKey, unitLabelKey } from "@/lib/stage-card/summaries";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const LOCALES = { en, es, fr, nl } as const;
type LocaleKey = keyof typeof LOCALES;
const dictOf = (locale: LocaleKey): Record<string, string> => LOCALES[locale] as unknown as Record<string, string>;
const TABLE_KINDS: readonly TableStageKind[] = ["league", "group", "swiss", "americano"];
const EXPLAIN = "div.detail.tiebreak.explain.";

/** The engine's `TiebreakerKey` union, read from its shipped declaration (`sport/module.d.ts`). */
function engineKeyUnion(): string[] {
  const index = createRequire(import.meta.url).resolve("@seazn/engine/sport");
  const decl = readFileSync(join(dirname(index), "module.d.ts"), "utf8");
  const body = /export type TiebreakerKey = ([^;]+);/.exec(decl)?.[1];
  if (body === undefined) throw new Error("premise: TiebreakerKey declaration not found in the engine's module.d.ts");
  return [...body.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
}

describe("tie-break explainers", () => {
  it("premise: the engine's key union is read, and every key a sport declares or offers is in it", () => {
    const union = new Set(engineKeyUnion());
    expect(union.size, "anti-vacuity: the union was parsed").toBeGreaterThan(20);
    for (const k of ["buchholz", "buchholz_cut1", "lots", "direct", "set_ratio", "point_ratio"]) expect(union.has(k), `${k} is in the union`).toBe(true);
    let seen = 0;
    const outside: string[] = [];
    const visited = forEachSport(({ key, module }) => {
      for (const kind of TABLE_KINDS) {
        const keys: TiebreakerKey[] = [...defaultOrderOf(module, kind)];
        for (const preset of module.tablePresets?.(kind).tiebreakers ?? []) keys.push(...preset.keys);
        const cfg = declaredCfgs(module)[0]!.cfg;
        keys.push(...offerableKeys([], 0, { module, cfg, stageKind: kind, crossGroup: false }));
        for (const k of keys) {
          seen++;
          if (!union.has(k)) outside.push(`${key} ${kind}: ${k}`);
        }
      }
    });
    expect(visited).toBe(builtinModules.length);
    expect(seen, "anti-vacuity: keys visited").toBeGreaterThan(0);
    expect(outside).toEqual([]);
  });

  it("every TiebreakerKey x every sport resolves an explainer in all four locales (one line, translated)", () => {
    const union = engineKeyUnion();
    let checked = 0;
    const problems: string[] = [];
    const visited = forEachSport(({ key: sport }) => {
      for (const rung of union) {
        const k = unitExplainKey(rung, sport);
        const english = dictOf("en")[k];
        for (const locale of Object.keys(LOCALES) as LocaleKey[]) {
          checked++;
          const text = dictOf(locale)[k];
          if (typeof text !== "string" || text.trim() === "") problems.push(`${locale} ${sport}/${rung}: ${k} missing`);
          else if (/[\r\n]/.test(text) || text.length > 110) problems.push(`${locale} ${sport}/${rung}: not one short line (${text.length})`);
          else if (locale !== "en" && text === english) problems.push(`${locale} ${sport}/${rung}: copied English`);
          else if (text === dictOf(locale)[unitLabelKey(rung, sport)]) problems.push(`${locale} ${sport}/${rung}: explainer repeats the label`);
        }
      }
    });
    expect(visited, "every registry sport").toBe(builtinModules.length);
    expect(checked, "anti-vacuity: (sport, key, locale) cells").toBe(visited * union.length * Object.keys(LOCALES).length);
    expect(checked).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it("the sport-specific explainer follows the same path as the label (badminton counts games, tennis sets)", () => {
    for (const rung of ["set_ratio", "set_diff", "h2h_set_ratio"]) {
      const shared = `${EXPLAIN}${rung}`;
      // single-sport: the badminton/tennis pair witnesses the sport-specific label path ("game" vs "set" wording); the full-sport sweep is the forEachSport tests above.
      expect(unitExplainKey(rung, "badminton"), `badminton ${rung}`).toBe(`${shared}.badminton`);
      // single-sport: same pair - badminton is the "game" wording side; the full-sport sweep is the forEachSport tests above.
      expect(dictOf("en")[`${shared}.badminton`], `badminton ${rung} says games`).toMatch(/game/i);
      // single-sport: same pair - tennis is the "set" wording side; the full-sport sweep is the forEachSport tests above.
      expect(unitExplainKey(rung, "tennis"), `tennis ${rung}`).toBe(shared);
      expect(dictOf("en")[shared], `${rung} shared says sets`).toMatch(/set/i);
    }
    expect(unitExplainKey("buchholz", "badminton")).toBe(`${EXPLAIN}buchholz`);
    expect(dictOf("en")[`${EXPLAIN}buchholz`]).toBe("Total score of the opponents you played.");
    expect(dictOf("en")[`${EXPLAIN}buchholz_cut1`]).toBe("Buchholz without your weakest opponent.");
  });

  it("no dead copy: every explainer key in the dictionary is one some (sport, key) pair resolves to - in all four locales alike", () => {
    const union = engineKeyUnion();
    const reached = new Set<string>();
    forEachSport(({ key: sport }) => {
      for (const rung of union) reached.add(unitExplainKey(rung, sport));
    });
    for (const locale of Object.keys(LOCALES) as LocaleKey[]) {
      const written = Object.keys(dictOf(locale)).filter((k) => k.startsWith(EXPLAIN));
      expect(written.length, `anti-vacuity: ${locale} has explainers`).toBeGreaterThan(0);
      expect(written.sort(), `${locale}: written = reached`).toEqual([...reached].sort());
    }
  });
});
