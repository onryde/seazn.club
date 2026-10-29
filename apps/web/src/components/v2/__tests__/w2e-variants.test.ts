// W2e Task 29 (B1-2; owner D1, D2) - the variant pickers, the 3x15 default, the Settings variant switch, and the editor's
// refusals, driven the way an organiser meets them.
//
// Where each expected value comes from: the variants, their declared keys and their parsed numbers are the ENGINE's own
// (`module.variants`, `configSchema.parse`); every sentence is read from the dictionaries on disk (en, es) or built by the
// engine's own sentence functions. Nothing below is a number typed from the code under test, except the owner's D2
// ("a new badminton division is 3x15") which is the ruling itself.
//
// Node env, no DOM (AGENTS.md class 2): the islands are driven through the hook harness (`renderIsland`): the handler the
// harness found is invoked, with the transport stubbed at `apiV1`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";
import { BO1_MATCH_TIEBREAK, type AnySportModule } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { hydrateRuleValues, rulesFor } from "@/lib/match-rules";
import { PREFERRED_VARIANT, pickVariant } from "@/lib/preferred-variant";
import { variantWordKey } from "@/lib/variant-label-keys";
import {
  configUnderVariant,
  divisionFormatPatch,
  ruleValuesAfterVariantSwitch,
  type VariantPreset,
} from "../division-format-patch";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

const { activeDict, net } = vi.hoisted(() => ({
  activeDict: { current: {} as Record<string, string> },
  net: { calls: [] as { url: string; options?: { method?: string; json?: unknown } }[] },
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useLocale: () => "en" as const,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => {
      const raw = activeDict.current[key];
      if (typeof raw !== "string") return key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
    },
  };
});
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, options });
      if (url.includes("/venues")) return Promise.resolve([]);
      if (url.endsWith("/divisions")) return Promise.resolve({ id: "d1", slug: "open" });
      return Promise.resolve({});
    }),
  };
});

import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { DivisionSettings } from "@/components/v2/division-settings";
import { sportOptionsFrom } from "@/lib/sport-options";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

type Cfg = Record<string, unknown>;
const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no module ${key}`);
  return m;
};
const presetsOf = (m: AnySportModule): Record<string, Cfg> => m.variants as Record<string, Cfg>;
/** The config the engine stores for a variant: its preset parsed through the schema (the module's defaults fill the rest). */
const storedFor = (m: AnySportModule, variant: string): Cfg => m.configSchema.parse(presetsOf(m)[variant]) as Cfg;
/** What the server stores for a PATCH: `{...variant.config, ...patch}` parsed (patchDivision does exactly this). */
const serverStores = (m: AnySportModule, variant: string, patch: Cfg): Cfg =>
  m.configSchema.parse({ ...presetsOf(m)[variant], ...patch }) as Cfg;
const defaultsOf = (m: AnySportModule): Cfg => m.configSchema.parse({}) as Cfg;
/** A module whose schema has no default for a required key (generic: `resultMode`, `allowDraws` come from the variant alone). */
const hasDefaults = (m: AnySportModule): boolean => m.configSchema.safeParse({}).success;

/** The Settings form as the organiser meets it: opened on `from`, the variant select moved to `to`, nothing else typed. */
function switchFrom(m: AnySportModule, from: string, to: string, edit: (values: Record<string, string>) => Record<string, string> = (v) => v): Cfg {
  const saved = storedFor(m, from);
  const presets = presetsOf(m);
  const opened = hydrateRuleValues(m.key, saved);
  const afterSelect = ruleValuesAfterVariantSwitch({
    sportKey: m.key, ruleValues: opened, divisionConfig: saved,
    savedPreset: presets[from], fromPreset: presets[from], toPreset: presets[to],
    savedKey: from, fromKey: from, toKey: to,
  });
  const patch = divisionFormatPatch({
    sportKey: m.key, divisionConfig: saved, savedVariantKey: from, variantKey: to,
    savedVariantPreset: presets[from], variantPreset: presets[to],
    ruleValues: edit(afterSelect), pointsFieldKeys: [], pointsValues: {}, savedPoints: undefined, advanced: null,
  });
  return serverStores(m, to, JSON.parse(JSON.stringify(patch)) as Cfg);
}

const BADMINTON = moduleOf("badminton");
const triple = (c: Cfg) => [c.setTo, c.finalSetTo, c.cap];
// The engine's own numbers for the two formats: the premise the switch tests stand on.
const THREE_BY_21 = triple(storedFor(BADMINTON, "bwf"));
const THREE_BY_15 = triple(storedFor(BADMINTON, "bwf-3x15"));

describe("W2e T29 premises (the numbers below are the engine's, and they differ)", () => {
  it("bwf is 21/21/30 and bwf-3x15 is 15/15/21 in the engine's own declaration", () => {
    expect(THREE_BY_21).toEqual([21, 21, 30]);
    expect(THREE_BY_15).toEqual([15, 15, 21]);
  });
});

describe("D2 a new badminton division defaults to bwf-3x15 in the builder and the funnel", () => {
  const rows = (sport: string) => Object.keys(presetsOf(moduleOf(sport))).map((key) => ({ sport_key: sport, key, name: key, is_system: true, config: presetsOf(moduleOf(sport))[key]! }));
  const SPORTS: SportOption[] = sportOptionsFrom(
    builtinModules.map((m) => ({ key: m.key, name: m.key })),
    builtinModules.flatMap((m) => rows(m.key)),
  );
  const mount = (sports: SportOption[] = SPORTS) =>
    renderIsland(DivisionBuilder, {
      competitionId: "c1", orgSlug: "org", compSlug: "comp", sports,
      constraintsAllowed: true, archivedSlotsExplainRefusal: false, viewerPlan: "community",
    });
  const variantSelectOf = (h: ReturnType<typeof mount>): ReactElement => {
    const sel = h.tree().find((e) => e.type === "select" && propsOf(e)["data-testid"] === "division-builder-variant");
    if (!sel) throw new Error("no variant select");
    return sel;
  };
  const sportSelectOf = (h: ReturnType<typeof mount>): ReactElement => {
    const sel = h.tree().find((e) => e.type === "select" && Array.isArray(propsOf(e).children) && (propsOf(e).children as ReactElement[]).some?.((c) => propsOf(c)?.value === "badminton"));
    if (!sel) throw new Error("no sport select");
    return sel;
  };

  it("the builder opens a badminton division on bwf-3x15, and the picker lists the three the engine declares", () => {
    const badmintonFirst = SPORTS.filter((s) => s.key === "badminton");
    const h = mount(badmintonFirst);
    expect(propsOf(variantSelectOf(h)).value).toBe("bwf-3x15");
    const keys = (propsOf(variantSelectOf(h)).children as ReactElement[]).map((o) => propsOf(o).value);
    expect(keys.sort()).toEqual(Object.keys(presetsOf(BADMINTON)).sort());
  });

  it("choosing badminton from another sport lands on bwf-3x15 too (the sport switch re-picks)", () => {
    const h = mount();
    expect(SPORTS[0]!.key, "premise: the first sport is not badminton").not.toBe("badminton");
    (propsOf(sportSelectOf(h)).onChange as (e: { target: { value: string } }) => void)({ target: { value: "badminton" } });
    expect(propsOf(variantSelectOf(h)).value).toBe("bwf-3x15");
  });

  it("every sport is offered its preferred variant when the table names one, else its first (counted)", () => {
    let preferred = 0;
    let fallback = 0;
    for (const s of SPORTS) {
      const picked = pickVariant(s.key, s.variants);
      const named = PREFERRED_VARIANT[s.key];
      if (named !== undefined && s.variants.some((v) => v.key === named)) {
        expect(picked, s.key).toBe(named);
        preferred++;
      } else {
        expect(picked, s.key).toBe(s.variants[0]!.key);
        fallback++;
      }
    }
    expect(preferred, "anti-vacuity: the table names five sports").toBe(5);
    expect(preferred + fallback).toBe(builtinModules.length);
    // Every entry the table carries is a variant the engine declares (a typo would silently fall back to the first).
    for (const [sport, variant] of Object.entries(PREFERRED_VARIANT)) expect(Object.keys(presetsOf(moduleOf(sport))), sport).toContain(variant);
    expect(pickVariant("constructor", [{ key: "x" }]), "an inherited name is not a table entry").toBe("x");
    expect(pickVariant("badminton", []), "no variants offered picks nothing").toBe("");
  });
});

describe("variant switch applies the target variant's fields (Review Focus 3)", () => {
  it("variant switch applies the target variant's fields: bwf -> bwf-3x15 stores 15/15/21 and back stores 21/21/30", () => {
    const toNew = switchFrom(BADMINTON, "bwf", "bwf-3x15");
    expect(triple(toNew)).toEqual(THREE_BY_15);
    // And the whole parsed config is the target's: nothing of the old variant's survives in a key the target declares.
    for (const [k, v] of Object.entries(presetsOf(BADMINTON)["bwf-3x15"]!)) expect(toNew[k], k).toEqual(v);

    const back = switchFrom(BADMINTON, "bwf-3x15", "bwf");
    expect(triple(back)).toEqual(THREE_BY_21);
    // The sequence: a division SAVED on 3x15 goes back through the same door and comes out 21/21/30, then 15/15/21 again.
    const saved = toNew;
    const presets = presetsOf(BADMINTON);
    const patch = divisionFormatPatch({
      sportKey: "badminton", divisionConfig: saved, savedVariantKey: "bwf-3x15", variantKey: "bwf",
      savedVariantPreset: presets["bwf-3x15"], variantPreset: presets.bwf,
      ruleValues: ruleValuesAfterVariantSwitch({
        sportKey: "badminton", ruleValues: hydrateRuleValues("badminton", saved), divisionConfig: saved,
        savedPreset: presets["bwf-3x15"], fromPreset: presets["bwf-3x15"], toPreset: presets.bwf,
        savedKey: "bwf-3x15", fromKey: "bwf-3x15", toKey: "bwf",
      }),
      pointsFieldKeys: [], pointsValues: {}, savedPoints: undefined, advanced: null,
    });
    expect(triple(serverStores(BADMINTON, "bwf", JSON.parse(JSON.stringify(patch)) as Cfg))).toEqual(THREE_BY_21);
  });

  it("the stale-form shape: ruleValues still hydrated from the OLD config (the select's re-read not run) must not keep the old numbers either", () => {
    // The door's own contract, not only the island's: the patch drops the keys either preset declares from the stored base,
    // and a hydrated rule field the organiser did not touch is the caller's to re-read. Here the caller did not, so the OLD
    // values ride back in through the rule fields - this documents which half owns what.
    const saved = storedFor(BADMINTON, "bwf");
    const presets = presetsOf(BADMINTON);
    const patch = divisionFormatPatch({
      sportKey: "badminton", divisionConfig: saved, savedVariantKey: "bwf", variantKey: "bwf-3x15",
      savedVariantPreset: presets.bwf, variantPreset: presets["bwf-3x15"],
      ruleValues: {}, pointsFieldKeys: [], pointsValues: {}, savedPoints: undefined, advanced: null,
    });
    expect(triple(serverStores(BADMINTON, "bwf-3x15", JSON.parse(JSON.stringify(patch)) as Cfg)), "no rule values at all: the preset alone").toEqual(THREE_BY_15);
  });

  it("a format save without a variant change keeps 21/21/30 (and 15/15/21 on 3x15), for an untouched form and for an edit to another field", () => {
    const presets = presetsOf(BADMINTON);
    for (const variant of ["bwf", "bwf-3x15"] as const) {
      const saved = storedFor(BADMINTON, variant);
      const opened = hydrateRuleValues("badminton", saved);
      const same = divisionFormatPatch({
        sportKey: "badminton", divisionConfig: saved, savedVariantKey: variant, variantKey: variant,
        savedVariantPreset: presets[variant], variantPreset: presets[variant],
        ruleValues: opened, pointsFieldKeys: [], pointsValues: {}, savedPoints: undefined, advanced: null,
      });
      expect(triple(serverStores(BADMINTON, variant, JSON.parse(JSON.stringify(same)) as Cfg)), variant).toEqual(triple(saved));
      // Another field edited (best of 5): the numbers do not move.
      const edited = divisionFormatPatch({
        sportKey: "badminton", divisionConfig: saved, savedVariantKey: variant, variantKey: variant,
        savedVariantPreset: presets[variant], variantPreset: presets[variant],
        ruleValues: { ...opened, bestOf: "5" }, pointsFieldKeys: [], pointsValues: {}, savedPoints: undefined, advanced: null,
      });
      const after = serverStores(BADMINTON, variant, JSON.parse(JSON.stringify(edited)) as Cfg);
      expect(triple(after), `${variant} with best of 5`).toEqual(triple(saved));
      expect(after.bestOf).toBe(5);
    }
    expect(triple(storedFor(BADMINTON, "bwf")), "premise: the two stored configs really differ").not.toEqual(triple(storedFor(BADMINTON, "bwf-3x15")));
  });

  it("a number the organiser typed AFTER choosing the variant is theirs, even if it equals what the old variant had", () => {
    // 3x21 -> 3x15, then the organiser types 21 into 'points to win a set': 21 is the old variant's number AND a deliberate one.
    const stored = switchFrom(BADMINTON, "bwf", "bwf-3x15", (v) => ({ ...v, setTo: "21" }));
    expect(stored.setTo).toBe(21);
    expect(stored.finalSetTo, "the number they did not touch is the variant's").toBe(15);
  });

  it("the old variant's number does not survive a switch for ANY declared key, in any ordered pair of any sport's variants (counted)", () => {
    let pairs = 0;
    let keysChecked = 0;
    const withoutDefaults = new Set<string>();
    for (const m of builtinModules) {
      const presets = presetsOf(m);
      const variants = Object.keys(presets);
      for (const from of variants) {
        for (const to of variants) {
          if (from === to) continue;
          const result = switchFrom(m, from, to);
          const wanted = storedFor(m, to);
          const defaults = hasDefaults(m) ? defaultsOf(m) : undefined;
          if (defaults === undefined) withoutDefaults.add(m.key);
          // Every key the target declares reads the target's value...
          for (const key of Object.keys(presets[to]!)) {
            expect(result[key], `${m.key} ${from} -> ${to}: ${key}`).toEqual(wanted[key]);
            keysChecked++;
          }
          // ...and every key only the SOURCE declared falls back to the module's default, not to what the source wrote.
          for (const key of Object.keys(presets[from]!)) {
            if (Object.hasOwn(presets[to]!, key) || defaults === undefined) continue;
            expect(result[key], `${m.key} ${from} -> ${to}: ${key} (only ${from} declared it)`).toEqual(defaults[key]);
            keysChecked++;
          }
          pairs++;
        }
      }
    }
    expect(pairs, "anti-vacuity: the sweep reached the sports' variants").toBeGreaterThan(30);
    expect(keysChecked, "anti-vacuity: and their keys").toBeGreaterThan(60);
    // The only module that skips the fall-back-to-default half is the one whose schema has no defaults to fall back to.
    expect([...withoutDefaults]).toEqual(["generic"]);
  });

  it("cricket: ballsPerOver is not carried across The Hundred <-> T20, and the overs the grid shows follow the variant", () => {
    const cricket = moduleOf("cricket");
    const toT20 = switchFrom(cricket, "hundred", "t20");
    expect(toT20.ballsPerOver, "T20 has six-ball overs; The Hundred's five must not ride along").toBe(defaultsOf(cricket).ballsPerOver);
    expect(toT20.ballsPerInnings).toBe(storedFor(cricket, "t20").ballsPerInnings);
    const toHundred = switchFrom(cricket, "t20", "hundred");
    expect(toHundred.ballsPerOver).toBe(storedFor(cricket, "hundred").ballsPerOver);
    expect(toHundred.ballsPerInnings).toBe(storedFor(cricket, "hundred").ballsPerInnings);
    // The grid after the select: 20 overs of the variant it now shows, not the 20 of the old one.
    const presets = presetsOf(cricket);
    const shown = ruleValuesAfterVariantSwitch({
      sportKey: "cricket", ruleValues: hydrateRuleValues("cricket", storedFor(cricket, "hundred")), divisionConfig: storedFor(cricket, "hundred"),
      savedPreset: presets.hundred, fromPreset: presets.hundred, toPreset: presets.t20, savedKey: "hundred", fromKey: "hundred", toKey: "t20",
    });
    expect(shown.overs, "T20: 120 balls of six").toBe(String((storedFor(cricket, "t20").ballsPerInnings as number) / (defaultsOf(cricket).ballsPerOver as number)));
    // An overs count typed AFTER the switch is read in the variant picked.
    const typed = switchFrom(cricket, "hundred", "t20", (v) => ({ ...v, overs: "10" }));
    expect(typed.ballsPerInnings, "10 six-ball overs").toBe(10 * (defaultsOf(cricket).ballsPerOver as number));
  });

  it("configUnderVariant: the same variant, or no preset known, changes nothing", () => {
    const saved = storedFor(BADMINTON, "bwf");
    expect(configUnderVariant(saved, presetsOf(BADMINTON).bwf, presetsOf(BADMINTON).bwf, true)).toBe(saved);
    const noPreset: VariantPreset = undefined;
    expect(configUnderVariant(saved, noPreset, noPreset, false)).toEqual(saved);
  });
});

describe("the Settings island: choosing a variant shows its numbers and saves them", () => {
  const ENTRANT_MODEL: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };
  const variantsOf = (m: AnySportModule) => Object.keys(presetsOf(m)).map((key) => ({ key, name: key.toUpperCase(), system: true, config: presetsOf(m)[key]! }));
  const props = (variant: string, m: AnySportModule = BADMINTON) =>
    ({
      division: { id: "d1", name: "Open", sport_key: m.key, variant_key: variant, config: storedFor(m, variant), logo_url: null, logo_storage_path: null },
      orgId: "org1", variants: variantsOf(m), structureLocked: false, lockedFields: [], stages: [], canEdit: true,
      divisionPathPrefix: "/o/org/c/comp/d/", fixturesHref: "/o/org/c/comp/d/div/fixtures", embed: null, danger: null,
      entrantModel: ENTRANT_MODEL, entrantModelSource: "sport", autoPosts: false, canAutoPost: false, showSeeds: true, viewerPlan: "community",
    }) as unknown as Parameters<typeof DivisionSettings>[0];
  const mount = (variant: string, m: AnySportModule = BADMINTON) => renderIsland(DivisionSettings, props(variant, m));
  type H = ReturnType<typeof mount>;
  const variantSelect = (h: H): ReactElement => {
    const sel = h.tree().find((e) => e.type === "select" && propsOf(e)["data-testid"] === "division-settings-variant");
    if (!sel) throw new Error("variant <select> not found");
    return sel;
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const rulesPatch = async (h: H): Promise<{ variant_key: string; config: Cfg }> => {
    net.calls.length = 0;
    const save = h.tree().find((n) => n.type === "button" && textOf(n).trim() === enUi["divset.saveRules"]);
    if (!save) throw new Error("no save-rules button");
    (propsOf(save).onClick as () => void)();
    await flush();
    const call = net.calls.find((c) => c.options?.method === "PATCH");
    if (!call) throw new Error("no PATCH was sent");
    return (call.options as { json: { variant_key: string; config: Cfg } }).json;
  };
  const gridValues = (h: H): Record<string, string> => {
    const grid = h.tree().find((e) => typeof propsOf(e).sportKey === "string" && propsOf(e).values !== undefined && typeof propsOf(e).onChange === "function");
    if (!grid) throw new Error("no rule grid");
    return propsOf(grid).values as Record<string, string>;
  };

  beforeEach(() => {
    activeDict.current = enUi as Record<string, string>;
    net.calls.length = 0;
  });

  it("variant switch applies the target variant's fields: the select moves 3x21 to 3x15, the grid shows 15/15/21, and Save PATCHes a config the server stores as 15/15/21", async () => {
    const h = mount("bwf");
    expect(gridValues(h).setTo, "premise: opened on the stored 21").toBe("21");
    (propsOf(variantSelect(h)).onChange as (e: { target: { value: string } }) => void)({ target: { value: "bwf-3x15" } });
    expect(propsOf(variantSelect(h)).value).toBe("bwf-3x15");
    expect([gridValues(h).setTo, gridValues(h).finalSetTo, gridValues(h).cap]).toEqual(THREE_BY_15.map(String));
    const sent = await rulesPatch(h);
    expect(sent.variant_key).toBe("bwf-3x15");
    expect(triple(serverStores(BADMINTON, sent.variant_key, sent.config))).toEqual(THREE_BY_15);
  });

  it("the sequence: a division on 3x15 switched to 3x21 saves 21/21/30, and switching there and back before saving saves what the final variant says", async () => {
    const h = mount("bwf-3x15");
    (propsOf(variantSelect(h)).onChange as (e: { target: { value: string } }) => void)({ target: { value: "bwf" } });
    expect(triple(serverStores(BADMINTON, "bwf", (await rulesPatch(h)).config))).toEqual(THREE_BY_21);

    const twice = mount("bwf");
    const pick = (to: string) => (propsOf(variantSelect(twice)).onChange as (e: { target: { value: string } }) => void)({ target: { value: to } });
    pick("short");
    pick("bwf-3x15");
    expect([gridValues(twice).setTo, gridValues(twice).finalSetTo, gridValues(twice).cap]).toEqual(THREE_BY_15.map(String));
    const sent = await rulesPatch(twice);
    expect(sent.variant_key).toBe("bwf-3x15");
    expect(triple(serverStores(BADMINTON, sent.variant_key, sent.config))).toEqual(THREE_BY_15);
  });

  it("a format save without a variant change keeps 21/21/30 on a 3x21 division (the select untouched)", async () => {
    const h = mount("bwf");
    const sent = await rulesPatch(h);
    expect(sent.variant_key).toBe("bwf");
    expect(triple(serverStores(BADMINTON, "bwf", sent.config))).toEqual(THREE_BY_21);
  });

  it("cricket: The Hundred -> T20 saves six-ball overs - ballsPerOver is no field, so only the presets know it is the Hundred's", async () => {
    const cricket = moduleOf("cricket");
    const h = mount("hundred", cricket);
    expect(storedFor(cricket, "hundred").ballsPerOver, "premise: the division was saved with five-ball overs").not.toBe(defaultsOf(cricket).ballsPerOver);
    (propsOf(variantSelect(h)).onChange as (e: { target: { value: string } }) => void)({ target: { value: "t20" } });
    const sent = await rulesPatch(h);
    expect(sent.variant_key).toBe("t20");
    const stored = serverStores(cricket, "t20", sent.config);
    expect(stored.ballsPerOver).toBe(defaultsOf(cricket).ballsPerOver);
    expect(stored.ballsPerInnings).toBe(storedFor(cricket, "t20").ballsPerInnings);
  });

  it("a number typed into the grid after the switch is sent as typed", async () => {
    const h = mount("bwf");
    (propsOf(variantSelect(h)).onChange as (e: { target: { value: string } }) => void)({ target: { value: "bwf-3x15" } });
    const grid = h.tree().find((e) => propsOf(e).sportKey === "badminton" && typeof propsOf(e).onChange === "function" && propsOf(e).values !== undefined)!;
    (propsOf(grid).onChange as (next: Record<string, string>) => void)({ ...gridValues(h), cap: "25" });
    const sent = await rulesPatch(h);
    expect(serverStores(BADMINTON, sent.variant_key, sent.config).cap).toBe(25);
    expect(serverStores(BADMINTON, sent.variant_key, sent.config).setTo).toBe(15);
  });
});

describe("TN-CF-1 the tennis fields refuse best of 1 with a match tie-break in the editor", () => {
  const rows = (m: AnySportModule) => Object.keys(presetsOf(m)).map((key) => ({ sport_key: m.key, key, name: key, is_system: true, config: presetsOf(m)[key]! }));
  const tennisModule = moduleOf("tennis");
  const TENNIS: SportOption[] = sportOptionsFrom([{ key: "tennis", name: "Tennis" }], rows(tennisModule));
  const mountBuilder = () =>
    renderIsland(DivisionBuilder, {
      competitionId: "c1", orgSlug: "org", compSlug: "comp", sports: TENNIS,
      constraintsAllowed: true, archivedSlotsExplainRefusal: false, viewerPlan: "community",
    });
  type B = ReturnType<typeof mountBuilder>;
  const gridOf = (h: B): ReactElement => {
    const g = h.tree().find((e) => typeof propsOf(e).sportKey === "string" && typeof propsOf(e).onChange === "function" && propsOf(e).values !== undefined);
    if (!g) throw new Error("no rule grid");
    return g;
  };
  const typeRules = (h: B, next: Record<string, string>) => (propsOf(gridOf(h)).onChange as (v: Record<string, string>) => void)({ ...(propsOf(gridOf(h)).values as Record<string, string>), ...next });
  const clickButton = (h: B, label: string) => {
    const el = h.tree().find((e) => e.type === "button" && textOf(e).trim() === label);
    if (!el) throw new Error(`no button ${label}`);
    (propsOf(el).onClick as () => void)();
  };
  const nameIt = (h: B) => {
    const input = h.tree().find((e) => e.type === "input" && propsOf(e).placeholder === activeDict.current["wizard.divisionNamePlaceholder"]);
    (propsOf(input!).onChange as (e: unknown) => void)({ target: { value: "Open" } });
  };
  const eligibilityHidden = (h: B): boolean => {
    const sec = h.tree().find((e) => e.type === "section" && /\bcard\b/.test(String(propsOf(e).className)) && textOf(e).includes(enUi["wizard.tab.eligibility"]));
    return /\bhidden\b/.test(String(propsOf(sec!).className));
  };
  const SENTENCE = (dict: Record<string, string>) => dict["rules.err.bo1MatchTiebreak"]!;

  beforeEach(() => {
    activeDict.current = enUi as Record<string, string>;
    net.calls.length = 0;
  });

  it("TN-CF-1 the builder: best of 1 with a match tie-break stops Next on the basics tab and says why; one field of the pair fixed, Next goes on", () => {
    const h = mountBuilder();
    nameIt(h);
    typeRules(h, { bestOf: "1", finalSet: "mtb10" });
    expect(propsOf(gridOf(h)).state, "the grid is told").toBeDefined();
    clickButton(h, enUi["wizard.next"]);
    expect(h.text()).toContain(SENTENCE(enUi as Record<string, string>));
    expect(eligibilityHidden(h), "still on the basics tab").toBe(true);
    typeRules(h, { finalSet: "tb10" });
    clickButton(h, enUi["wizard.next"]);
    expect(eligibilityHidden(h), "off the basics tab").toBe(false);
    expect(h.text()).not.toContain(SENTENCE(enUi as Record<string, string>));
  });

  it("TN-CF-1 the builder says it in Spanish too, and tells the grid which fields it is about", () => {
    activeDict.current = esUi as Record<string, string>;
    const h = mountBuilder();
    nameIt(h);
    typeRules(h, { bestOf: "1", finalSet: "mtb7" });
    const state = propsOf(gridOf(h)).state as { invalid: Map<string, string[]> };
    expect([...state.invalid.keys()].sort()).toEqual(["bestOf", "finalSet"]);
    clickButton(h, esUi["wizard.next"]);
    expect(h.text()).toContain(SENTENCE(esUi as Record<string, string>));
    expect(SENTENCE(esUi as Record<string, string>)).not.toBe(SENTENCE(enUi as Record<string, string>));
    expect(h.text(), "not the engine's English constant").not.toContain(BO1_MATCH_TIEBREAK);
  });

  it("TN-CF-1 the builder's Create refuses it too, when the rules were broken after the basics tab was passed (the guard is reached through the grid's handler)", async () => {
    const h = mountBuilder();
    nameIt(h);
    clickButton(h, enUi["wizard.tab.scheduling"]);
    typeRules(h, { bestOf: "1", finalSet: "mtb10" });
    net.calls.length = 0;
    clickButton(h, enUi["wizard.create"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(net.calls.filter((c) => c.url.endsWith("/divisions")), "no division was POSTed").toEqual([]);
    expect(h.text()).toContain(SENTENCE(enUi as Record<string, string>));
  });

  it("TN-CF-1 Settings: Save is refused before any PATCH, in the reader's language; the pair mended, the PATCH goes", async () => {
    const ENTRANT_MODEL: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };
    const h = renderIsland(DivisionSettings, {
      division: { id: "d1", name: "Open", sport_key: "tennis", variant_key: "tour", config: storedFor(tennisModule, "tour"), logo_url: null, logo_storage_path: null },
      orgId: "org1", variants: rows(tennisModule), structureLocked: false, lockedFields: [], stages: [], canEdit: true,
      divisionPathPrefix: "/o/org/c/comp/d/", fixturesHref: "/o/org/c/comp/d/div/fixtures", embed: null, danger: null,
      entrantModel: ENTRANT_MODEL, entrantModelSource: "sport", autoPosts: false, canAutoPost: false, showSeeds: true, viewerPlan: "community",
    } as unknown as Parameters<typeof DivisionSettings>[0]);
    const grid = () => h.tree().find((e) => typeof propsOf(e).sportKey === "string" && typeof propsOf(e).onChange === "function" && propsOf(e).values !== undefined)!;
    const typeIt = (next: Record<string, string>) => (propsOf(grid()).onChange as (v: Record<string, string>) => void)({ ...(propsOf(grid()).values as Record<string, string>), ...next });
    const save = async () => {
      net.calls.length = 0;
      const btn = h.tree().find((n) => n.type === "button" && textOf(n).trim() === enUi["divset.saveRules"])!;
      (propsOf(btn).onClick as () => void)();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return net.calls.filter((c) => c.options?.method === "PATCH");
    };
    typeIt({ bestOf: "1", finalSet: "mtb10" });
    expect([...(propsOf(grid()).state as { invalid: Map<string, string[]> }).invalid.keys()].sort(), "the grid is told which fields").toEqual(["bestOf", "finalSet"]);
    expect(await save(), "no PATCH while the pair is refused").toEqual([]);
    expect(h.text()).toContain(SENTENCE(enUi as Record<string, string>));
    typeIt({ finalSet: "same" });
    expect((await save()).length, "the PATCH goes once the pair is mended").toBe(1);
  });

  it("VB-CF-1 Settings: a set target below the floor is refused before any PATCH (volleyball)", async () => {
    const volleyball = moduleOf("volleyball");
    const ENTRANT_MODEL: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };
    const h = renderIsland(DivisionSettings, {
      division: { id: "d1", name: "Open", sport_key: "volleyball", variant_key: "indoor", config: storedFor(volleyball, "indoor"), logo_url: null, logo_storage_path: null },
      orgId: "org1", variants: rows(volleyball), structureLocked: false, lockedFields: [], stages: [], canEdit: true,
      divisionPathPrefix: "/o/org/c/comp/d/", fixturesHref: "/o/org/c/comp/d/div/fixtures", embed: null, danger: null,
      entrantModel: ENTRANT_MODEL, entrantModelSource: "sport", autoPosts: false, canAutoPost: false, showSeeds: true, viewerPlan: "community",
    } as unknown as Parameters<typeof DivisionSettings>[0]);
    const grid = h.tree().find((e) => typeof propsOf(e).sportKey === "string" && typeof propsOf(e).onChange === "function" && propsOf(e).values !== undefined)!;
    (propsOf(grid).onChange as (v: Record<string, string>) => void)({ ...(propsOf(grid).values as Record<string, string>), setTo: "3" });
    net.calls.length = 0;
    const btn = h.tree().find((n) => n.type === "button" && textOf(n).trim() === enUi["divset.saveRules"])!;
    (propsOf(btn).onClick as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(net.calls.filter((c) => c.options?.method === "PATCH")).toEqual([]);
    expect(h.text()).toContain(enUi["rules.err.setTargetBelowFloor"]!.replace("{min}", "5"));
  });
});

describe("pickers print the localised variant label, with the raw name as fallback", () => {
  const optionsOf = (select: ReactElement): { value: string; text: string }[] =>
    (propsOf(select).children as ReactElement[]).map((o) => ({ value: String(propsOf(o).value), text: textOf(o).trim() }));
  const ORG_PRESET = { key: "club-night", name: "Club night (to 11)", system: false, config: { setTo: 11 } };
  const sportWith = (extra: SportOption["variants"]): SportOption[] => [
    {
      key: "badminton",
      name: "Badminton",
      variants: [
        ...Object.keys(presetsOf(BADMINTON)).map((key) => ({ key, name: key.toUpperCase(), system: true, config: presetsOf(BADMINTON)[key]! })),
        ...extra,
      ],
    } as SportOption,
  ];
  const builderSelect = (sports: SportOption[]): ReactElement => {
    const h = renderIsland(DivisionBuilder, {
      competitionId: "c1", orgSlug: "org", compSlug: "comp", sports,
      constraintsAllowed: true, archivedSlotsExplainRefusal: false, viewerPlan: "community",
    });
    const sel = h.tree().find((e) => e.type === "select" && propsOf(e)["data-testid"] === "division-builder-variant");
    if (!sel) throw new Error("no variant select");
    return sel;
  };

  beforeEach(() => {
    activeDict.current = enUi as Record<string, string>;
  });

  it("anti-vacuity: the two locales really differ for every badminton variant the picker lists", () => {
    for (const key of ["variant.badminton.bwf", "variant.badminton.bwf3x15", "variant.badminton.short"] as const) {
      expect(esUi[key], key).not.toBe(enUi[key]);
      expect(rulesFor("badminton").length).toBeGreaterThan(0);
    }
  });

  it("the builder prints the dictionary's word for each system variant, in English and in Spanish", () => {
    for (const [dict, name] of [[enUi, "en"], [esUi, "es"]] as const) {
      activeDict.current = dict as Record<string, string>;
      const opts = optionsOf(builderSelect(sportWith([])));
      expect(opts.map((o) => o.value).sort()).toEqual(Object.keys(presetsOf(BADMINTON)).sort());
      const text = Object.fromEntries(opts.map((o) => [o.value, o.text]));
      expect(text.bwf, name).toBe(dict["variant.badminton.bwf"]);
      expect(text["bwf-3x15"], name).toBe(dict["variant.badminton.bwf3x15"]);
      expect(text.short, name).toBe(dict["variant.badminton.short"]);
    }
  });

  it("an org's own preset keeps the name the organiser gave it, marked as the org's, never relabelled", () => {
    const opts = optionsOf(builderSelect(sportWith([ORG_PRESET])));
    const mine = opts.find((o) => o.value === "club-night")!;
    expect(mine.text).toContain(ORG_PRESET.name);
    expect(mine.text).toContain(enUi["wizard.orgPreset"]);
    // Even where it reuses a system key: the name is the organiser's.
    const reused = optionsOf(builderSelect(sportWith([{ ...ORG_PRESET, key: "bwf", name: "Our 21s" }])));
    expect(reused.filter((o) => o.value === "bwf").map((o) => o.text.replace(enUi["wizard.orgPreset"], "").trim()).sort()).toEqual(["Our 21s", enUi["variant.badminton.bwf"]].sort());
  });

  it("a system variant no map names falls back to its raw name (counted over the engine's variants)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      for (const key of Object.keys(presetsOf(m))) {
        const word = variantWordKey(m.key, key);
        expect(word, `${m.key}/${key}: every shipped variant has a word`).toBeDefined();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
    // A key the map lacks (an engine variant added without its word) prints the raw name, never blank or the key's neighbour.
    const sel = builderSelect([{ key: "badminton", name: "Badminton", variants: [{ key: "newest", name: "Newest Format", system: true, config: {} }] } as SportOption]);
    expect(optionsOf(sel)).toEqual([{ value: "newest", text: "Newest Format" }]);
  });

  it("the BWF date hint shows for bwf and bwf-3x15 only, in the reader's language, linked to the select", () => {
    const hintOf = (h: { tree: () => ReactElement[] }) => h.tree().find((e) => propsOf(e)["data-testid"] === "division-variant-hint");
    for (const [dict, label] of [[enUi, "en"], [esUi, "es"]] as const) {
      activeDict.current = dict as Record<string, string>;
      const seen: Record<string, boolean> = {};
      for (const key of Object.keys(presetsOf(BADMINTON))) {
        const sports = sportWith([]);
        sports[0] = { ...sports[0]!, variants: sports[0]!.variants.filter((v) => v.key === key) } as SportOption;
        const h = renderIsland(DivisionBuilder, {
          competitionId: "c1", orgSlug: "org", compSlug: "comp", sports,
          constraintsAllowed: true, archivedSlotsExplainRefusal: false, viewerPlan: "community",
        });
        const hint = hintOf(h);
        seen[key] = hint !== undefined;
        const sel = h.tree().find((e) => e.type === "select" && propsOf(e)["data-testid"] === "division-builder-variant")!;
        if (hint !== undefined) {
          expect(textOf(hint).trim(), `${label} ${key}`).toBe(dict["variant.badminton.hint3x15"]);
          expect(propsOf(hint).role).toBe("note");
          expect(propsOf(sel)["aria-describedby"], "the select is described by the hint").toBe(propsOf(hint).id);
        } else {
          expect(propsOf(sel)["aria-describedby"]).toBeUndefined();
        }
      }
      expect(seen, label).toEqual({ bwf: true, "bwf-3x15": true, short: false });
    }
    expect(esUi["variant.badminton.hint3x15"]).not.toBe(enUi["variant.badminton.hint3x15"]);
  });

  it("the hint carries the date the owner gave (4 January 2027) and names both formats", () => {
    expect(enUi["variant.badminton.hint3x15"]).toMatch(/4 January 2027/);
    expect(enUi["variant.badminton.hint3x15"]).toContain("3×15");
    expect(enUi["variant.badminton.hint3x15"]).toContain("3×21");
    expect(esUi["variant.badminton.hint3x15"]).toMatch(/4 de enero de 2027/);
  });

  it("the Settings picker prints the same words and the hint, and leaves an org preset's name alone", () => {
    const ENTRANT_MODEL: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };
    const variants = [...sportWith([ORG_PRESET])[0]!.variants];
    for (const [dict, label] of [[enUi, "en"], [esUi, "es"]] as const) {
      activeDict.current = dict as Record<string, string>;
      const h = renderIsland(DivisionSettings, {
        division: { id: "d1", name: "Open", sport_key: "badminton", variant_key: "bwf-3x15", config: storedFor(BADMINTON, "bwf-3x15"), logo_url: null, logo_storage_path: null },
        orgId: "org1", variants, structureLocked: false, lockedFields: [], stages: [], canEdit: true,
        divisionPathPrefix: "/o/org/c/comp/d/", fixturesHref: "/o/org/c/comp/d/div/fixtures", embed: null, danger: null,
        entrantModel: ENTRANT_MODEL, entrantModelSource: "sport", autoPosts: false, canAutoPost: false, showSeeds: true, viewerPlan: "community",
      } as unknown as Parameters<typeof DivisionSettings>[0]);
      const sel = h.tree().find((e) => e.type === "select" && propsOf(e)["data-testid"] === "division-settings-variant")!;
      const text = Object.fromEntries(optionsOf(sel).map((o) => [o.value, o.text]));
      expect(text.bwf, label).toBe(dict["variant.badminton.bwf"]);
      expect(text["bwf-3x15"], label).toBe(dict["variant.badminton.bwf3x15"]);
      expect(text["club-night"], label).toBe(ORG_PRESET.name);
      const hint = h.tree().find((e) => propsOf(e)["data-testid"] === "division-variant-hint");
      expect(hint && textOf(hint).trim(), label).toBe(dict["variant.badminton.hint3x15"]);
    }
  });
});
