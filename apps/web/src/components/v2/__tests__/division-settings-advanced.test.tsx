// W2e Task 33 (B3-2) - the Settings "Advanced overrides (JSON)" box.
//
// Its placeholder used to read `e.g. { "progressScore": true }` - a key the engine deleted in W2e D6 (generic MAJOR 4) and strips
// on parse, shown to an organiser as the example to copy. The placeholder now names a key the division's OWN module declares in
// `ruleKeys`, with the value the division already holds for it: pasted as it stands it is a valid, do-nothing patch, so the example
// always works whatever the sport.
//
// Where each expected value comes from: the keys a sport declares are the ENGINE's own (`sportTopKeys`, read off `module.ruleKeys`);
// whether a patch "works" is the module's own `configSchema`. The sweep is every sport in the registry (`builtinModules`), reports
// how many it judged, and judging none fails it. The component is driven through the hook harness (node env, no DOM - AGENTS.md
// class 2): a helper alone proves nothing about the box the organiser sees.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";
import { sportTopKeys, type AnySportModule, type EffectiveEntrantModel } from "@seazn/engine/sport";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useLocale: () => "en",
    useLocaleOrDefault: () => "en",
    useMsg: () => (key: string, vars?: Record<string, string | number>) => {
      const raw = (enUi as Record<string, string>)[key];
      if (typeof raw !== "string") return key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
    },
  };
});

import { DivisionSettings } from "@/components/v2/division-settings";

type Cfg = Record<string, unknown>;
const presetsOf = (m: AnySportModule): Record<string, Cfg> => m.variants as Record<string, Cfg>;
/** The config the engine stores for a variant: its preset parsed through the schema (the module's defaults fill the rest). */
const storedFor = (m: AnySportModule, variant: string): Cfg => m.configSchema.parse(presetsOf(m)[variant]) as Cfg;

const ENTRANT_MODEL: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };

/** The Settings island of a division of sport `m`, saved under `variant`, as the organiser opens it. */
function mount(m: AnySportModule, variant: string, config: Cfg) {
  const variants = Object.keys(presetsOf(m)).map((key) => ({ key, name: key.toUpperCase(), system: true, config: presetsOf(m)[key]! }));
  return renderIsland(
    DivisionSettings,
    {
      division: { id: "d1", name: "Open", sport_key: m.key, variant_key: variant, config, logo_url: null, logo_storage_path: null },
      orgId: "org1", variants, structureLocked: false, lockedFields: [], stages: [], canEdit: true,
      divisionPathPrefix: "/o/org/c/comp/d/", fixturesHref: "/o/org/c/comp/d/div/fixtures", embed: null, danger: null,
      entrantModel: ENTRANT_MODEL, entrantModelSource: "sport", autoPosts: false, canAutoPost: false, showSeeds: true, viewerPlan: "community",
    } as unknown as Parameters<typeof DivisionSettings>[0],
  );
}

/** The Advanced box's textarea, found by what it is. */
const advancedBox = (tree: ReactElement[]): ReactElement => {
  const boxes = tree.filter((e) => e.type === "textarea");
  if (boxes.length !== 1) throw new Error(`expected exactly one textarea on the Settings tab, found ${boxes.length}`);
  return boxes[0]!;
};

describe("the Advanced placeholder names a key the module declares, for every sport", () => {
  it("the Advanced placeholder names a key the module declares, for every sport", () => {
    let judged = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(presetsOf(m))[0]!;
      const saved = storedFor(m, variant);
      const placeholder = propsOf(advancedBox(mount(m, variant, saved).tree()))["placeholder"];
      expect(typeof placeholder, `${m.key}: the box carries a placeholder`).toBe("string");

      // It is JSON an organiser can paste: one key, an object patch.
      const example = JSON.parse(placeholder as string) as Cfg;
      const keys = Object.keys(example);
      expect(keys, `${m.key}: one key`).toHaveLength(1);

      // The key is one THIS sport declares - the engine's own list, not a key kept in the web.
      const declared = sportTopKeys(m);
      expect(declared.has(keys[0]!), `${m.key}: "${keys[0]}" is declared by the module (declares ${[...declared].join(", ")})`).toBe(true);

      // "Always works": laid over the division's own config, the module accepts it and it changes nothing.
      const merged = m.configSchema.safeParse({ ...saved, ...example });
      expect(merged.success, `${m.key}: the example is a patch the module accepts`).toBe(true);
      expect(merged.data, `${m.key}: the example is a do-nothing patch`).toEqual(saved);
      judged++;
    }
    // Anti-vacuity: every sport in the registry, and the registry is not empty.
    expect(builtinModules.length).toBeGreaterThan(0);
    expect(judged).toBe(builtinModules.length);
  });

  it("the key moves with the sport: the sports do not all show one example", () => {
    const shown = new Set<string>();
    for (const m of builtinModules) {
      const variant = Object.keys(presetsOf(m))[0]!;
      const placeholder = propsOf(advancedBox(mount(m, variant, storedFor(m, variant)).tree()))["placeholder"] as string;
      shown.add(Object.keys(JSON.parse(placeholder) as Cfg)[0]!);
    }
    // A fixed example, true for one sport, would pass the sweep above for that sport alone; the registry spans several.
    expect(shown.size).toBeGreaterThan(1);
  });

  it("a division whose saved config holds none of the declared keys shows an empty patch, never a key the module does not declare", () => {
    // The empty case: nothing to copy. An unparseable `e.g.` string, or the dropped key, would read as an instruction.
    for (const m of builtinModules) {
      const variant = Object.keys(presetsOf(m))[0]!;
      const placeholder = propsOf(advancedBox(mount(m, variant, {}).tree()))["placeholder"] as string;
      expect(JSON.parse(placeholder), `${m.key}`).toEqual({});
    }
  });

  it("shows the value the division holds for the key, and skips a declared key it does not hold for the next one", () => {
    let judged = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(presetsOf(m))[0]!;
      const saved = storedFor(m, variant);
      const declared = [...sportTopKeys(m)].filter((k) => Object.hasOwn(saved, k));
      expect(declared.length, `${m.key}: the saved config holds at least two declared keys, or the skip below proves nothing`).toBeGreaterThan(1);
      const [first, second] = declared as [string, string];

      // The value is the division's own, not a default of the sport's: a value no schema default can equal.
      const sentinel = "a-value-the-module-never-defaults-to";
      const shownFirst = JSON.parse(propsOf(advancedBox(mount(m, variant, { ...saved, [first]: sentinel }).tree()))["placeholder"] as string) as Cfg;
      expect(shownFirst, `${m.key}`).toEqual({ [first]: sentinel });

      // A declared key the saved config lacks is passed over: the box names the next one it holds, not an empty or absent value.
      const { [first]: _dropped, ...withoutFirst } = saved;
      void _dropped;
      const shownNext = JSON.parse(propsOf(advancedBox(mount(m, variant, withoutFirst).tree()))["placeholder"] as string) as Cfg;
      expect(shownNext, `${m.key}`).toEqual({ [second]: saved[second] });
      judged++;
    }
    expect(judged).toBe(builtinModules.length);
  });
});
