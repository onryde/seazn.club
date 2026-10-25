// Owner ruling 2026-10-25 ("apply rec", older item 6): switching a chess division to online play while players have no
// Lichess link must WARN, naming who, and must NOT block - clubs switch first and collect links later. This drives the real
// DivisionSettings island: the warning sits under the Online play select the moment Lichess is chosen (before any save),
// stays while the SAVED division is online, is absent when nobody is unlinked, and the select and the save stay usable.
//
// Expected sentences come from the shipped dictionary and Intl (plural rules, list format), never from the helper that
// builds them. The island is rendered bare, so these read the English catalogue; the other three locales are covered by the
// dictionary-shape cases at the end, and by the parity check.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DivisionSettings } from "@/components/v2/division-settings";
import { BANNED_RE } from "@/components/v2/arbiter/__tests__/_banned-copy";
import { UNLINKED_NAMES_SHOWN } from "@/lib/online-unlinked";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const net = vi.hoisted(() => ({ calls: [] as { url: string; json?: unknown }[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: async (url: string, options?: { json?: unknown }) => {
      net.calls.push({ url, json: options?.json });
      return {};
    },
  };
});

beforeEach(() => {
  net.calls.length = 0;
});

const EN = uiEn as Record<string, string>;
const INDIVIDUAL_ONLY: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

type Cfg = Record<string, unknown>;
type Unlinked = { count: number; names: string[] };
const propsFor = (config: Cfg, unlinked: Unlinked | undefined, onlineChessOffered = true, sport = "boardgame") =>
  ({
    division: {
      id: "d1",
      name: "Open",
      sport_key: sport,
      variant_key: sport === "boardgame" ? "classical" : "standard",
      config,
      logo_url: null,
      logo_storage_path: null,
      camera_policy: null,
      inherited_camera_policy: "off",
    },
    orgId: "org1",
    variants: [{ key: sport === "boardgame" ? "classical" : "standard", name: "Standard" }],
    structureLocked: false,
    lockedFields: [],
    stages: [],
    canEdit: true,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: null,
    danger: null,
    entrantModel: INDIVIDUAL_ONLY,
    entrantModelSource: "sport",
    autoPosts: false,
    canAutoPost: true,
    showSeeds: true,
    viewerPlan: "community",
    onlineChessOffered,
    unlinkedLichess: unlinked,
  }) as Parameters<typeof DivisionSettings>[0];
const mount = (config: Cfg, unlinked: Unlinked | undefined, onlineChessOffered = true, sport = "boardgame") =>
  renderIsland(DivisionSettings, propsFor(config, unlinked, onlineChessOffered, sport));
type Island = ReturnType<typeof mount>;

const byTestId = (island: Island, id: string) => island.tree().filter((n) => propsOf(n)["data-testid"] === id);
const WARNING = "division-online-unlinked";
const warning = (island: Island) => byTestId(island, WARNING);
const select = (island: Island) => byTestId(island, "division-online-play")[0]!;
function setOnline(island: Island, value: "off" | "lichess") {
  (propsOf(select(island)).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

const OFF: Cfg = { variant: "classical", clock: { base: 600, increment: 5 } };
const ON: Cfg = { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } };
const two: Unlinked = { count: 2, names: ["Ann Unlinked", "Ben Unlinked"] };

/** What Intl says a list of these items reads as in English ("A and B", "A, B, and C"). */
const listEn = (items: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);
const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

describe("the online-play switch warns about players with no Lichess link, and never blocks", () => {
  it("empty case first: nobody unlinked -> no warning, for an absent summary and for a zero one, on and off", () => {
    let checked = 0;
    for (const cfg of [OFF, ON]) {
      for (const unlinked of [undefined, { count: 0, names: [] }]) {
        const island = mount(cfg, unlinked);
        setOnline(island, "lichess");
        expect(warning(island), `saved ${String(cfg.onlinePlay)}, unlinked ${JSON.stringify(unlinked)}`).toHaveLength(0);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every combination was checked").toBe(4);
  });

  it("the switch moment: choosing Lichess shows the warning, naming the players, before anything is saved", () => {
    const island = mount(OFF, two);
    expect(warning(island), "premise: not shown while online play is Off").toHaveLength(0);

    setOnline(island, "lichess");

    expect(warning(island)).toHaveLength(1);
    expect(net.calls.filter((c) => c.url === "/api/v1/divisions/d1"), "nothing was saved: this is the switch, not the save").toHaveLength(0);
    // 2 -> "other"; two names -> "A and B". Template from the dictionary, the list from Intl.
    expect(textOf(warning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.unlinked.other"]!, { count: 2, names: listEn(two.names) }));
  });

  it("turning it back to Off takes the warning away again (negative with its positive pair)", () => {
    const island = mount(OFF, two);
    setOnline(island, "lichess");
    expect(warning(island)).toHaveLength(1);

    setOnline(island, "off");

    expect(warning(island)).toHaveLength(0);
  });

  it("after the switch: a division SAVED as online keeps showing the warning while anyone is unlinked", () => {
    const island = mount(ON, two);

    expect(warning(island)).toHaveLength(1);
    expect(textOf(warning(island)[0]!)).toContain("Ann Unlinked");
  });

  it("a single unlinked player reads in the singular, from the dictionary's .one", () => {
    const island = mount(ON, { count: 1, names: ["Solo Unlinked"] });

    expect(textOf(warning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.unlinked.one"]!, { count: 1, names: "Solo Unlinked" }));
  });

  it("a long list is cut at the cap and the rest folded into 'N more', the count staying the true total", () => {
    const total = UNLINKED_NAMES_SHOWN + 3;
    const shown = Array.from({ length: UNLINKED_NAMES_SHOWN }, (_, i) => `Player ${i + 1}`);
    const island = mount(ON, { count: total, names: shown });

    const text = textOf(warning(island)[0]!).trim();

    const more = fill(EN["divset.onlinePlay.unlinkedMore.other"]!, { count: 3 });
    expect(text).toBe(fill(EN["divset.onlinePlay.unlinked.other"]!, { count: total, names: listEn([...shown, more]) }));
    expect(text).toContain(`${total} players`);
    expect(text).not.toContain(`Player ${UNLINKED_NAMES_SHOWN + 1}`);
  });

  it("exactly as many names as the count folds nothing: no 'more'", () => {
    const names = Array.from({ length: UNLINKED_NAMES_SHOWN }, (_, i) => `Player ${i + 1}`);
    const island = mount(ON, { count: names.length, names });

    const text = textOf(warning(island)[0]!).trim();

    expect(text).toBe(fill(EN["divset.onlinePlay.unlinked.other"]!, { count: names.length, names: listEn(names) }));
    expect(text).not.toContain(fill(EN["divset.onlinePlay.unlinkedMore.other"]!, { count: 1 }));
  });

  // The ruling: ALLOW the switch. These are the guards a later "just disable it" would break - each is mutated by hand.
  it("the warning does not block: the Online play select is enabled, and Save match rules still saves Lichess", async () => {
    const island = mount(OFF, two);
    setOnline(island, "lichess");

    expect(propsOf(select(island)).disabled, "the select is not disabled by the warning").toBe(false);
    const button = island.tree().find((n) => n.type === "button" && textOf(n).trim() === "Save match rules");
    expect(button, "premise: the Save match rules button is there").toBeDefined();
    expect(propsOf(button!).disabled, "the save button is not disabled by the warning").toBe(false);

    (propsOf(button!).onClick as () => void)();
    await vi.waitFor(() => expect(net.calls.filter((c) => c.url === "/api/v1/divisions/d1")).toHaveLength(1));
    const sent = net.calls.find((c) => c.url === "/api/v1/divisions/d1")!;
    expect((sent.json as { config: Cfg }).config.onlinePlay, "the PATCH carries the switch").toBe("lichess");
  });

  it("another sport never shows it: no Online play control, so no warning, even handed an unlinked list", () => {
    const island = mount({}, two, true, "football");

    expect(byTestId(island, "division-online-play")).toHaveLength(0);
    expect(warning(island)).toHaveLength(0);
  });

  it("a club not offered online chess has no online control and no warning", () => {
    const island = mount(ON, two, false);

    expect(byTestId(island, "division-online-play")).toHaveLength(0);
    expect(warning(island)).toHaveLength(0);
  });

  it("the warning is announced politely and wraps a long name instead of widening the page", () => {
    const long = "Maximilian Alexander Featherstonehaugh-Cholmondeley";
    const island = mount(ON, { count: 1, names: [long] });

    const el = warning(island)[0]!;
    expect(propsOf(el).role).toBe("status");
    expect(String(propsOf(el).className)).toMatch(/\bbreak-words\b/);
    expect(textOf(el)).toContain(long);
  });
});

describe("the warning copy exists in all four locales, with its plural forms and placeholders", () => {
  const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;

  it("every locale carries .one and .other of both keys, with {count} and {names} where the sentence needs them, and no banned dash or arrow", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const form of ["one", "other"]) {
        const sentence = dict[`divset.onlinePlay.unlinked.${form}`];
        const more = dict[`divset.onlinePlay.unlinkedMore.${form}`];
        expect(sentence, `${locale} unlinked.${form}`).toBeTypeOf("string");
        expect(more, `${locale} unlinkedMore.${form}`).toBeTypeOf("string");
        expect(sentence, `${locale} unlinked.${form} names its players`).toContain("{names}");
        expect(sentence, `${locale} unlinked.${form} carries the count`).toContain("{count}");
        expect(more, `${locale} unlinkedMore.${form} carries the count`).toContain("{count}");
        expect(sentence, `${locale} unlinked.${form}`).not.toMatch(BANNED_RE);
        expect(more, `${locale} unlinkedMore.${form}`).not.toMatch(BANNED_RE);
        checked += 2;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 2 forms x 2 keys").toBe(16);
  });

  it("the non-English sentences are translated, not copied from English", () => {
    let checked = 0;
    for (const locale of ["es", "fr", "nl"]) {
      for (const form of ["one", "other"]) {
        const key = `divset.onlinePlay.unlinked.${form}`;
        expect(LOCALES[locale]![key], `${locale} ${key}`).not.toBe(EN[key]);
        checked++;
      }
    }
    expect(checked).toBe(6);
  });
});
