// The frozen row list (design §3, R11). Empty case first (R13): the catalogue
// must never be empty, and a key the product does not know must never quietly
// become a league (buildTemplateStages' silent fallback, format-templates.ts:334).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGE_TEMPLATES, buildTemplateStages } from "../../../apps/web/src/lib/format-templates.ts";
import { deciderKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { TOP_LEVEL_STAGE_DECIDERS } from "../../../apps/web/src/lib/top-level-stage-deciders.ts";
import { STAGE_DECIDER_MOVED, StageConfig } from "../../../apps/web/src/server/api-v1/schemas.ts";
import {
  API_ONLY_ROWS, BUILDER_DEFAULT_KNOBS, BUILDER_KNOB_BOUNDS, BUILDER_PREFERRED_VARIANT, ROW_KEYS,
  SPORT_KEYS, TEMPLATE_ROW_KEYS, UnknownRow, builderDefaultVariant, builderStages, cellId, stagesForRow,
} from "../lib/catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUILDER = readFileSync(resolve(REPO, "apps/web/src/components/v2/division-builder.tsx"), "utf8");
/** The table the builder AND the /start funnel pick a new division's variant from (W2e: moved out of the builder). */
const PREFERRED = readFileSync(resolve(REPO, "apps/web/src/lib/preferred-variant.ts"), "utf8");
/** The product's one group → group → knockout shape (server/templates/catalog). */
const super8 = JSON.parse(readFileSync(resolve(REPO, "apps/web/src/server/templates/catalog/t20-super8.json"), "utf8")) as
  { divisions: { stages: { kind: string; groups?: number; progression?: unknown }[] }[] };
/** The product's own template build at the builder's defaults — the expected
 *  side of every API-only derivation, so no expected value is read back from
 *  catalogue.ts (TEST-STRATEGY: never derive from the code under test). */
const product = (key: string) => buildTemplateStages(key, BUILDER_DEFAULT_KNOBS);

/** Parses the PREFERRED_VARIANT literal (lib/preferred-variant.ts). Fails LOUDLY when an entry
 *  cannot be parsed (a computed key, a duplicate, an unquoted value) instead of
 *  dropping it — a dropped entry would let the builder drift while the pin
 *  stays green. The entry count comes from splitting the literal on commas,
 *  independently of the entry regex. */
function preferredVariantPin(src: string): Record<string, string> {
  const block = /const PREFERRED_VARIANT: Record<string, string> = \{([^}]*)\}/.exec(src)?.[1];
  if (block === undefined) throw new Error("PREFERRED_VARIANT literal not found in preferred-variant.ts");
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

const STAGES_TS = () => readFileSync(resolve(REPO, "apps/web/src/server/usecases/stages.ts"), "utf8");

/** A top-level function's text, from its header to its closing `\n}\n`.
 *  Throws on a missing header OR closer — never reads on to EOF. */
function fnBody(src: string, header: string): string {
  const at = src.indexOf(`\n${header}`);
  if (at < 0) throw new Error(`stages.ts: ${header} not found`);
  const end = src.indexOf("\n}\n", at);
  if (end < 0) throw new Error(`stages.ts: ${header} has no closer`);
  return src.slice(at, end);
}

/** The `case "<kind>":` arm of stages.ts's generate() — what the product's
 *  Generate builds per stage kind. A missing function, closer or arm throws,
 *  so the pin cannot pass on text it never found. */
function generateArm(kind: string, src: string = STAGES_TS()): string {
  const body = fnBody(src, "function generate(");
  const at = body.indexOf(`\n    case "${kind}":`);
  if (at < 0) throw new Error(`stages.ts generate(): no case "${kind}"`);
  const next = body.indexOf("\n    case ", at + 1);
  return body.slice(at, next < 0 ? undefined : next);
}

/** The stage-config key the knockout arm of generate() reads as its
 *  third-place flag (`thirdPlace: cfg.<key> === true`). */
function thirdPlaceKey(): string {
  const key = /\bthirdPlace: cfg\.(\w+) === true/.exec(generateArm("knockout"))?.[1];
  if (key === undefined) throw new Error("stages.ts generate(): the knockout arm no longer reads a third-place flag from cfg");
  return key;
}

const SCHEMAS_TS = (): string => readFileSync(resolve(REPO, "apps/web/src/server/api-v1/schemas.ts"), "utf8");

/** The body of api-v1/schemas.ts's StageConfig — a strictObject, so the POST /stages door 400s on any key outside it. */
function stageConfigBody(src: string = SCHEMAS_TS()): string {
  const start = src.indexOf("export const StageConfig = z\n  .strictObject({\n");
  if (start < 0) throw new Error("schemas.ts: StageConfig is no longer a z.strictObject");
  const end = src.indexOf("\n  })\n  .default({});", start);
  if (end < 0) throw new Error("schemas.ts: StageConfig's closing .default({}) not found");
  return src.slice(start, end);
}

/** The keys a `...NAME,` spread in a StageConfig body brings in, each of them a refusal.
 *  W2c Task 13b (R-13b-1) moved StageConfig's refusals out of the literal into a spread of `TOP_LEVEL_DECIDER_REFUSALS`,
 *  built as `Object.fromEntries(TOP_LEVEL_STAGE_DECIDERS.map((key) => [key, z.never(...)...]))` — so the keys are not
 *  in the shape's text any more. They are read from the spread's own declaration: its key source must be
 *  TOP_LEVEL_STAGE_DECIDERS (whose VALUE is imported) and every entry must be a `z.never`. A spread this cannot read
 *  that way THROWS: skipping it would drop refusals out of the scan, which is exactly the way it went blind before. */
function spreadRefusalKeys(body: string, src: string): string[] {
  const keys: string[] = [];
  for (const spread of body.matchAll(/^ {4}\.\.\.(\w+),/gm)) {
    const name = spread[1]!;
    const decl = new RegExp(`\\nconst ${name} = Object\\.fromEntries\\(\\s*(\\w+)\\.map\\(\\(\\w+\\) => \\[\\w+, z\\.never\\(`).exec(src);
    if (decl === null) throw new Error(`schemas.ts: StageConfig spreads ${name}, which is no longer an Object.fromEntries(<keys>.map((key) => [key, z.never(...)])) of refusals`);
    if (decl[1] !== "TOP_LEVEL_STAGE_DECIDERS") throw new Error(`schemas.ts: ${name} refuses the keys of ${decl[1]}, which this scan cannot resolve (it reads TOP_LEVEL_STAGE_DECIDERS)`);
    keys.push(...TOP_LEVEL_STAGE_DECIDERS);
  }
  return keys;
}

/** Config keys StageConfig declares only to REFUSE them (W2c Task 12: a top-level stage decider moved to `config.rules`
 *  and is refused loudly with `z.never`, saying so, rather than as an unrecognised key) — written in the shape, or
 *  brought in by the refusals spread (see spreadRefusalKeys). */
function refusedConfigKeys(src: string = SCHEMAS_TS()): string[] {
  const body = stageConfigBody(src);
  const keys = [...[...body.matchAll(/^ {4}(\w+): z\.never\(/gm)].map((m) => m[1]!), ...spreadRefusalKeys(body, src)];
  if (keys.length === 0) throw new Error("schemas.ts: StageConfig refuses no key");
  return keys;
}

/** The top-level keys of StageConfig (a refused one included: see refusedConfigKeys). */
function stageConfigKeys(src: string = SCHEMAS_TS()): string[] {
  const body = stageConfigBody(src);
  const keys = [...[...body.matchAll(/^ {4}(\w+): z\./gm)].map((m) => m[1]!), ...spreadRefusalKeys(body, src)];
  if (keys.length === 0) throw new Error("schemas.ts: StageConfig declares no keys");
  return keys;
}

/** Every whole decider any sport declares — read from the engine's own declarations here, NOT from the web lib's
 *  TOP_LEVEL_STAGE_DECIDERS that the schema's spread consumes (an expected value taken from the code under test). */
const ENGINE_DECIDER_KEYS = [...new Set((builtinModules as readonly AnySportModule[]).flatMap((m) => deciderKeysFor(m, null, null)))].sort();

describe("API-only rows — bodies derived from product authorities", () => {
  it("empty case first: an unknown row is still refused, never a silent league", () => {
    expect(() => stagesForRow("nope")).toThrow(UnknownRow);
    expect(() => stagesForRow("")).toThrow(UnknownRow);
  });

  it("every one of the 21 rows builds, seq 1..n, and none throws RowBuildDeferred", () => {
    let built = 0;
    for (const row of ROW_KEYS) {
      const s = stagesForRow(row);
      expect(s.length, row).toBeGreaterThan(0);
      expect(s.map((x) => x.seq), row).toEqual(s.map((_, i) => i + 1));
      built++;
    }
    expect(built).toBe(TEMPLATE_ROW_KEYS.length + API_ONLY_ROWS.length);
  });

  it("builderStages is the product's own buildTemplateStages at the builder's defaults — whole body, every template row", () => {
    let checked = 0;
    for (const row of TEMPLATE_ROW_KEYS) {
      expect(builderStages(row), row).toEqual(product(row));
      checked++;
    }
    expect(checked).toBe(16);
  });

  it("group_only = the builder's groups_ko stage 1, alone", () => {
    expect(stagesForRow("group_only")).toEqual([{ ...product("groups_ko")[0], seq: 1 }]);
  });

  it("group_only takes the builder's clamped poolCount knob; group_group_ko keeps the template's pool counts whatever the knob says", () => {
    const pools = (row: string, poolCount: number) =>
      stagesForRow(row, { ...BUILDER_DEFAULT_KNOBS, poolCount }).map((s) => (s.config as { pools?: { count: number } }).pools?.count ?? null);
    expect(pools("group_only", 3)).toEqual([3]);
    expect(pools("group_only", 99)).toEqual([BUILDER_KNOB_BOUNDS.poolCount.max]);
    const tpl = super8.divisions[0]!.stages.map((s) => s.groups ?? null);
    expect(tpl).toEqual([4, 2, null]); // the template declares pools on its two group stages only
    expect(tpl.slice(0, 2)).not.toContain(3); // 3 is neither template count, so a knob-following body cannot pass
    expect(pools("group_group_ko", 3)).toEqual(tpl);
  });

  it("group_group_ko matches t20-super8.json: kinds, pool counts and both progressions", () => {
    expect(super8.divisions).toHaveLength(1);
    const tpl = super8.divisions[0]!.stages;
    const got = stagesForRow("group_group_ko");
    expect(got.map((s) => s.kind)).toEqual(tpl.map((s) => s.kind));
    expect(got.slice(0, 2).map((s) => (s.config as { pools: { count: number } }).pools.count)).toEqual(tpl.slice(0, 2).map((s) => s.groups));
    expect(got.map((s) => s.progression ?? null)).toEqual(tpl.map((s) => s.progression ?? null));
    // Everything the template leaves to the builder is the builder's group stage.
    const group = product("groups_ko")[0]!;
    expect(got[0]).toEqual({ ...group, config: { ...group.config, pools: { count: tpl[0]!.groups } }, seq: 1 });
  });

  it("knockout_third_place sets config.thirdPlace, the key the product's knockout generate reads", () => {
    const key = thirdPlaceKey();
    expect(key).toBe("thirdPlace");
    const ko = product("knockout")[0]!;
    expect(stagesForRow("knockout_third_place")).toEqual([{ ...ko, config: { ...ko.config, [key]: true }, seq: 1 }]);
  });

  it("knockout_third_place is the builder's knockout PLUS thirdPlace: a config key the builder gains survives", () => {
    const at = STAGE_TEMPLATES.findIndex((t) => t.key === "knockout");
    expect(at).toBeGreaterThanOrEqual(0);
    const real = STAGE_TEMPLATES[at]!;
    STAGE_TEMPLATES[at] = { key: "knockout", build: (k) => real.build(k).map((s) => ({ ...s, config: { ...s.config, bracketReset: false } })) };
    try {
      const ko = product("knockout")[0]!;
      expect(ko.config).toHaveProperty("bracketReset", false); // the swap took
      const got = stagesForRow("knockout_third_place");
      expect(got).toEqual([{ ...ko, config: { ...ko.config, [thirdPlaceKey()]: true }, seq: 1 }]);
      for (const k of Object.keys(ko.config)) expect(got[0]!.config, k).toHaveProperty(k);
    } finally {
      STAGE_TEMPLATES[at] = real;
    }
    expect(product("knockout")[0]!.config).not.toHaveProperty("bracketReset");
  });

  it("an API-only key with no body is a named refusal, not a TypeError (the switch's default guard)", () => {
    const rows = API_ONLY_ROWS as unknown as string[];
    rows.push("zz_api_only");
    try {
      expect(() => stagesForRow("zz_api_only")).toThrow(UnknownRow);
    } finally {
      rows.splice(rows.indexOf("zz_api_only"), 1);
    }
    expect(API_ONLY_ROWS).toHaveLength(5);
  });

  it("generateArm fails loudly on source it cannot bound — no closer, no function, no arm", () => {
    const open = "\nfunction generate(\n  switch (kind) {\n    case \"knockout\": {\n      thirdPlace: cfg.thirdPlace === true,\n";
    expect(() => generateArm("knockout", open)).toThrow(/closer/);
    expect(() => generateArm("knockout", `${open}}\n`.replace("function generate(", "function generateX("))).toThrow(/not found/);
    expect(() => generateArm("league", `${open}  }\n}\n`)).toThrow(/no case "league"/);
    expect(generateArm("knockout", `${open}  }\n}\n`)).toContain("thirdPlace: cfg.thirdPlace === true");
  });

  it("every config key any row posts is one the product's POST /stages accepts: declared by the strict StageConfig, not refused by createStages", () => {
    const declared = stageConfigKeys();
    expect(declared).toContain("thirdPlace");
    const refused = refusedConfigKeys();
    // The refused set is exactly the decider set the ENGINE declares (R-13b-1), however the schema spells it.
    expect(ENGINE_DECIDER_KEYS.length, "anti-vacuity: the engine declares deciders").toBeGreaterThan(2);
    expect([...refused].sort()).toEqual(ENGINE_DECIDER_KEYS);
    for (const key of refused) expect(declared).toContain(key); // declared-but-refused: why the declared list alone is not enough
    // And the live schema refuses each one saying where it went — the text scan above is not left to vouch for itself.
    for (const key of refused) {
      const said = StageConfig.safeParse({ [key]: false }).error?.issues.map((i) => i.message) ?? [];
      expect(said, `StageConfig.${key}`).toContain(STAGE_DECIDER_MOVED);
    }
    expect(declared).toContain("rules"); // W2c Task 12: a create takes config.rules (validated by the usecase)
    let checked = 0;
    for (const row of ROW_KEYS) for (const s of stagesForRow(row)) for (const key of Object.keys(s.config)) {
      expect(declared, `${row}: config.${key}`).toContain(key);
      expect(refused, `${row}: config.${key}`).not.toContain(key);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the StageConfig scan reads a refusals spread, and throws on one it cannot read or on none (a skipped spread would drop refusals unseen)", () => {
    const shape = (spread: string, line = "    ...REF,\n") => `x\nexport const StageConfig = z\n  .strictObject({\n${line}    legs: z.number(),\n  })\n  .default({});\n${spread}`;
    const good = "\nconst REF = Object.fromEntries(\n  TOP_LEVEL_STAGE_DECIDERS.map((key) => [key, z.never({ error: MSG }).optional()]),\n);\n";
    expect(TOP_LEVEL_STAGE_DECIDERS.length, "anti-vacuity: the keys the spread contributes").toBeGreaterThan(2);
    expect(refusedConfigKeys(shape(good))).toEqual([...TOP_LEVEL_STAGE_DECIDERS]);
    expect(stageConfigKeys(shape(good))).toEqual(["legs", ...TOP_LEVEL_STAGE_DECIDERS]);
    expect(() => refusedConfigKeys(shape(good.replace("z.never", "z.unknown")))).toThrow(/no longer an Object\.fromEntries/);
    expect(() => refusedConfigKeys(shape(good.replace("TOP_LEVEL_STAGE_DECIDERS", "OTHER")))).toThrow(/cannot resolve/);
    expect(() => refusedConfigKeys(shape(""))).toThrow(/no longer an Object\.fromEntries/); // a spread with no declaration
    expect(() => refusedConfigKeys(shape(good, ""))).toThrow(/refuses no key/); // no spread, no z.never: nothing refused
  });

  it("page_playoff_only / stepladder_only = the builder's second stage with no feed", () => {
    expect(stagesForRow("page_playoff_only")).toEqual([{ ...product("group_playoffs")[1], progression: null, seq: 1 }]);
    expect(stagesForRow("stepladder_only")).toEqual([{ ...product("group_stepladder")[1], progression: null, seq: 1 }]);
    expect(stagesForRow("page_playoff_only")[0]!.kind).toBe("page_playoff");
    expect(stagesForRow("stepladder_only")[0]!.kind).toBe("stepladder");
  });

  it("a second call builds the same bodies, and editing one call's output never reaches the next (all 21 rows)", () => {
    let checked = 0;
    for (const row of ROW_KEYS) {
      const first = stagesForRow(row);
      const pristine = structuredClone(first);
      for (const s of first) {
        (s.config as Record<string, unknown>).zz = 1;
        if (s.progression) s.progression.sources[0]!.take.length = 0;
      }
      expect(stagesForRow(row), row).toEqual(pristine);
      checked++;
    }
    expect(checked).toBe(ROW_KEYS.length);
  });
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

  it("PREFERRED_VARIANT matches the product's literal, and the builder reads it from there", () => {
    const parsed = preferredVariantPin(PREFERRED);
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    expect(parsed).toEqual(BUILDER_PREFERRED_VARIANT);
    // The builder keeps no literal of its own any more: it picks through the shared table.
    expect(BUILDER).not.toMatch(/const PREFERRED_VARIANT\b/);
    expect(BUILDER).toMatch(/import \{ pickVariant \} from "@\/lib\/preferred-variant"/);
  });

  it("the PREFERRED_VARIANT pin reads either quote style, and refuses an entry it cannot parse", () => {
    const quoted = PREFERRED.replace(`hockey: "fih-outdoor"`, `"hockey": 'fih-outdoor'`);
    expect(quoted).not.toBe(PREFERRED);
    expect(preferredVariantPin(quoted)).toEqual(BUILDER_PREFERRED_VARIANT);
    const computed = PREFERRED.replace(`hockey: "fih-outdoor"`, `[HOCKEY]: "fih-outdoor"`);
    expect(computed).not.toBe(PREFERRED);
    expect(() => preferredVariantPin(computed)).toThrow(/parsed 4 of 5 entries/);
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
