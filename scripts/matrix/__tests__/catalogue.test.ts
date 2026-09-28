// The frozen row list (design §3, R11). Empty case first (R13): the catalogue
// must never be empty, and a key the product does not know must never quietly
// become a league (buildTemplateStages' silent fallback, format-templates.ts:334).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGE_TEMPLATES, buildTemplateStages } from "../../../apps/web/src/components/v2/format-templates.ts";
import { builtinModules } from "@seazn/engine/sports";
import {
  API_ONLY_ROWS, BUILDER_DEFAULT_KNOBS, BUILDER_KNOB_BOUNDS, BUILDER_PREFERRED_VARIANT, ROW_KEYS, RowBuildDeferred,
  SPORT_KEYS, TEMPLATE_ROW_KEYS, UnknownRow, builderDefaultVariant, cellId, stagesForRow,
} from "../lib/catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUILDER = readFileSync(resolve(REPO, "apps/web/src/components/v2/division-builder.tsx"), "utf8");

/** Parses the builder's PREFERRED_VARIANT literal. Fails LOUDLY when an entry
 *  cannot be parsed (a computed key, a duplicate, an unquoted value) instead of
 *  dropping it — a dropped entry would let the builder drift while the pin
 *  stays green. The entry count comes from splitting the literal on commas,
 *  independently of the entry regex. */
function preferredVariantPin(src: string): Record<string, string> {
  const block = /const PREFERRED_VARIANT: Record<string, string> = \{([^}]*)\}/.exec(src)?.[1];
  if (block === undefined) throw new Error("PREFERRED_VARIANT literal not found in division-builder.tsx");
  const entries = block.split(",").map((s) => s.replace(/\/\/.*$/gm, "").trim()).filter((s) => s.length > 0);
  const parsed = Object.fromEntries(
    [...block.matchAll(/["']?([\w-]+)["']?\s*:\s*["']([^"']+)["']/g)].map((m) => [m[1]!, m[2]!]),
  );
  if (Object.keys(parsed).length !== entries.length) {
    throw new Error(`PREFERRED_VARIANT: parsed ${Object.keys(parsed).length} of ${entries.length} entries: ${JSON.stringify(entries)}`);
  }
  return parsed;
}

/** The KO stage's take rule — where the `qualified` knob lands. */
const takeOf = (stages: { progression: { sources: { take: unknown[] }[] } | null }[]) => stages[1]!.progression!.sources[0]!.take;

describe("catalogue — empty case first", () => {
  it("is never empty: 16 template rows + 5 API-only rows, 11 sports", () => {
    expect(TEMPLATE_ROW_KEYS.length).toBe(16);
    expect(API_ONLY_ROWS.length).toBe(5);
    expect(ROW_KEYS.length).toBe(21);
    expect(new Set(ROW_KEYS).size).toBe(21);
    expect(SPORT_KEYS.length).toBe(11);
  });
});

describe("catalogue — rows", () => {
  it("every template row exists in the product's STAGE_TEMPLATES, and nothing there is missing from the catalogue", () => {
    const product = STAGE_TEMPLATES.map((t) => t.key).sort();
    expect([...TEMPLATE_ROW_KEYS].sort()).toEqual(product);
  });

  it("a misspelled key throws UnknownRow instead of building a league (Review Focus 2)", () => {
    expect(() => stagesForRow("swis")).toThrow(UnknownRow);
    expect(() => stagesForRow("")).toThrow(UnknownRow);
  });

  // stagesForRow has two refusal guards — the catalogue's own list and the
  // product's STAGE_TEMPLATES. While the two lists are equal (pinned above),
  // any bad key trips both, so deleting either one alone stays green (found by
  // mutation, AGENTS class 3). Each test below drives the lists APART, in
  // process, so exactly one guard stands between the key and a build.
  it("a product template the catalogue has not adopted is refused, not built (R11: rows change by reviewed diff)", () => {
    const unreviewed = { key: "zz_unreviewed", build: () => [{ kind: "knockout", name: "Unreviewed", config: {}, progression: null }] };
    STAGE_TEMPLATES.push(unreviewed);
    try {
      expect(() => stagesForRow("zz_unreviewed")).toThrow(UnknownRow);
    } finally {
      STAGE_TEMPLATES.splice(STAGE_TEMPLATES.indexOf(unreviewed), 1);
    }
  });

  it("a catalogue row the product has dropped is refused, not built as buildTemplateStages' league fallback", () => {
    const at = STAGE_TEMPLATES.findIndex((t) => t.key === "ladder");
    expect(at).toBeGreaterThan(0); // league is [0]: the fallback must differ from the dropped row
    const [dropped] = STAGE_TEMPLATES.splice(at, 1);
    try {
      expect(() => stagesForRow("ladder")).toThrow(UnknownRow);
    } finally {
      STAGE_TEMPLATES.splice(at, 0, dropped!);
    }
    expect(stagesForRow("ladder").map((s) => s.kind)).toEqual(["ladder"]);
  });

  it("API-only rows are a named refusal routed to W1b, not a build", () => {
    for (const row of API_ONLY_ROWS) {
      let caught: unknown;
      try { stagesForRow(row); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(RowBuildDeferred);
      expect((caught as RowBuildDeferred).wave).toBe("W1b");
    }
  });

  it("each single-kind row builds its OWN kind — the answer differs from the league fallback", () => {
    expect(stagesForRow("swiss").map((s) => s.kind)).toEqual(["swiss"]);
    expect(stagesForRow("knockout").map((s) => s.kind)).toEqual(["knockout"]);
    expect(stagesForRow("league").map((s) => s.kind)).toEqual(["league"]);
  });

  it("every template row builds its OWN template's stage graph (kind and name, derived from STAGE_TEMPLATES)", () => {
    let checked = 0;
    for (const row of TEMPLATE_ROW_KEYS) {
      const own = STAGE_TEMPLATES.find((t) => t.key === row)!.build(BUILDER_DEFAULT_KNOBS);
      expect(stagesForRow(row).map((s) => [s.kind, s.name]), row).toEqual(own.map((s) => [s.kind, s.name]));
      checked++;
    }
    expect(checked).toBe(16);
  });

  it("stamps seq 1..n and the builder's knob defaults (swiss rounds, legs)", () => {
    const ko = stagesForRow("league_ko");
    expect(ko.map((s) => s.seq)).toEqual([1, 2]);
    // The builder's carry default is "none", which applyStandingsCarry leaves
    // absent — a single-stage row cannot see a wrong carry, a finals stage can.
    expect(stagesForRow("league_ko")[1]!.progression!.carry).toBeUndefined();
    expect(stagesForRow("swiss")[0]!.config.rounds).toBe(BUILDER_DEFAULT_KNOBS.swissRounds);
    // buildTemplateStages overwrites legs with the knob (format-templates.ts:340):
    // triple_rr through the builder defaults is legs 1, not 3 — recorded as a
    // false premise, pinned here so a product change is seen.
    expect(stagesForRow("triple_rr")[0]!.config.legs).toBe(BUILDER_DEFAULT_KNOBS.legs);
  });

  it("clamps qualified and poolCount exactly like the builder — below the floor and above the ceiling", () => {
    const B = BUILDER_KNOB_BOUNDS; // text-pinned against division-builder.tsx below
    const at = (row: string, qualified: number, poolCount: number) =>
      buildTemplateStages(row, { ...BUILDER_DEFAULT_KNOBS, qualified, poolCount });

    // Below the floor: qualified 0 unclamped gives groups_ko's KO an EMPTY take
    // (n = 0, r = 0); clamped it is the product's own take at the floor.
    const low = stagesForRow("groups_ko", { ...BUILDER_DEFAULT_KNOBS, qualified: 0, poolCount: 0 });
    expect(low[0]!.config.pools).toEqual({ count: B.poolCount.min });
    expect(takeOf(low)).toEqual(takeOf(at("groups_ko", B.qualified.min, B.poolCount.min)));
    expect(takeOf(low)).not.toEqual(takeOf(at("groups_ko", 0, B.poolCount.min))); // the wrong answer differs
    expect(takeOf(stagesForRow("league_ko", { ...BUILDER_DEFAULT_KNOBS, qualified: 0 })))
      .toEqual([{ kind: "rankRange", from: 1, to: B.qualified.min }]);

    // Above the ceiling.
    const high = stagesForRow("groups_ko", { ...BUILDER_DEFAULT_KNOBS, qualified: 99, poolCount: 99 });
    expect(high[0]!.config.pools).toEqual({ count: B.poolCount.max });
    expect(takeOf(high)).toEqual(takeOf(at("groups_ko", B.qualified.max, B.poolCount.max)));
    expect(takeOf(stagesForRow("league_ko", { ...BUILDER_DEFAULT_KNOBS, qualified: 99 })))
      .toEqual([{ kind: "rankRange", from: 1, to: B.qualified.max }]);
  });

  it("cellId is row|sport", () => { expect(cellId("league", "generic")).toBe("league|generic"); });
});

describe("catalogue — builder parity (text pins; a builder change reds here)", () => {
  it("knob defaults match division-builder.tsx's useState literals", () => {
    const pick = (name: string) => Number(new RegExp(`const \\[${name}, set\\w+\\] = useState\\((\\d+)\\)`).exec(BUILDER)?.[1]);
    expect({ qualified: pick("qualified"), swissRounds: pick("swissRounds"), poolCount: pick("poolCount"), legs: pick("legs") })
      .toEqual(BUILDER_DEFAULT_KNOBS);
  });

  it("clamp bounds match division-builder.tsx's clampKnob calls", () => {
    const bounds = (name: string) => {
      const m = new RegExp(`clampKnob\\(${name}, (\\d+), (\\d+)\\)`).exec(BUILDER);
      return { min: Number(m?.[1]), max: Number(m?.[2]) };
    };
    expect({ qualified: bounds("qualified"), poolCount: bounds("poolCount") }).toEqual(BUILDER_KNOB_BOUNDS);
  });

  it("the standings carry defaults to 'none' (what stagesForRow applies)", () => {
    expect(BUILDER).toMatch(/useState<StandingsCarry>\("none"\)/);
  });

  it("PREFERRED_VARIANT matches the builder's literal", () => {
    const parsed = preferredVariantPin(BUILDER);
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    expect(parsed).toEqual(BUILDER_PREFERRED_VARIANT);
  });

  it("the PREFERRED_VARIANT pin reads either quote style, and refuses an entry it cannot parse", () => {
    const quoted = BUILDER.replace(`hockey: "fih-outdoor"`, `"hockey": 'fih-outdoor'`);
    expect(quoted).not.toBe(BUILDER);
    expect(preferredVariantPin(quoted)).toEqual(BUILDER_PREFERRED_VARIANT);
    const computed = BUILDER.replace(`hockey: "fih-outdoor"`, `[HOCKEY]: "fih-outdoor"`);
    expect(computed).not.toBe(BUILDER);
    expect(() => preferredVariantPin(computed)).toThrow(/parsed 3 of 4 entries/);
  });

  it("builderDefaultVariant: preferred when offered, else the first in builder order; empty refuses", () => {
    expect(() => builderDefaultVariant("generic", [])).toThrow(/no system variants/);
    expect(builderDefaultVariant("cricket", ["hundred", "odi", "t20", "test"])).toBe("t20");
    expect(builderDefaultVariant("generic", ["score", "win_loss"])).toBe("score");
    expect(builderDefaultVariant("cricket", ["hundred", "odi"])).toBe("hundred");
  });

  it("every preferred variant is a declared engine variant", () => {
    for (const [sport, variant] of Object.entries(BUILDER_PREFERRED_VARIANT)) {
      const m = builtinModules.find((x) => x.key === sport);
      expect(m, sport).toBeDefined();
      expect(Object.keys(m!.variants)).toContain(variant);
    }
  });
});
