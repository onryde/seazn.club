// Owner ruling 2026-10-25 ("apply rec", older item 6): switching a chess division to online play while players cannot be
// paired online must WARN, naming who, and must NOT block - clubs switch first and collect links later. Fix rounds 1 and 2
// (controller): "cannot be paired" covers three kinds, each in its OWN sentence - players with no Lichess link, players whose
// link must be reconnected, and entrants with no player on them. This drives the real Division rules strip (Match Day C2 moved Online play there from Settings): the warning sits under the Online
// play select the moment Lichess is chosen (before any save), stays while the SAVED division is online, is absent when
// nobody is short, each sentence shows independently of the other, and the select and the save stay usable.
//
// Expected sentences come from the shipped dictionary and Intl (plural rules, list format), never from the helper that
// builds them. The island is rendered bare, so these read the English catalogue; the other three locales are covered by the
// dictionary-shape cases at the end, and by the parity check.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DivisionRulesStrip, expandRules, stripPropsOf } from "./_rules-strip";
import { BANNED_RE } from "@/components/v2/arbiter/__tests__/_banned-copy";
import { LINK_GAP_NAMES_SHOWN } from "@/lib/online-link-gaps";
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

type Cfg = Record<string, unknown>;
type List = { count: number; names: string[] };
type Gaps = { unlinked: List; reconnect: List; empty: List };
const NONE: List = { count: 0, names: [] };
const NO_GAPS: Gaps = { unlinked: NONE, reconnect: NONE, empty: NONE };
// Match Day C2: Online play moved with the match rules to the Division rules strip (Fixtures tab), its warning with it.
const propsFor = (config: Cfg, gaps: Gaps | undefined, onlineChessOffered = true, sport = "boardgame") =>
  stripPropsOf({
    division: { id: "d1", sport_key: sport, variant_key: sport === "boardgame" ? "classical" : "standard", config },
    variants: [{ key: sport === "boardgame" ? "classical" : "standard", name: "Standard" }],
    onlineChessOffered,
    lichessGaps: gaps,
  });
const mount = (config: Cfg, gaps: Gaps | undefined, onlineChessOffered = true, sport = "boardgame") =>
  renderIsland(DivisionRulesStrip, propsFor(config, gaps, onlineChessOffered, sport), expandRules);
type Island = ReturnType<typeof mount>;

const byTestId = (island: Island, id: string) => island.tree().filter((n) => propsOf(n)["data-testid"] === id);
/** The no-link sentence, the reconnect sentence, and the amber box around whichever of them is there. */
const warning = (island: Island) => byTestId(island, "division-online-unlinked");
const reconnectWarning = (island: Island) => byTestId(island, "division-online-reconnect");
const emptyWarning = (island: Island) => byTestId(island, "division-online-empty");
const box = (island: Island) => byTestId(island, "division-online-link-gaps");
const select = (island: Island) => byTestId(island, "division-online-play")[0]!;
function setOnline(island: Island, value: "off" | "lichess") {
  (propsOf(select(island)).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

const OFF: Cfg = { variant: "classical", clock: { base: 600, increment: 5 } };
const ON: Cfg = { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } };
const twoList: List = { count: 2, names: ["Ann Unlinked", "Ben Unlinked"] };
const two: Gaps = { ...NO_GAPS, unlinked: twoList };
const reconnectOnly: Gaps = { ...NO_GAPS, reconnect: { count: 2, names: ["Cat Reconnect", "Dan Reconnect"] } };
const emptyOnly: Gaps = { ...NO_GAPS, empty: { count: 2, names: ["Table 4", "Table 9"] } };
const both: Gaps = { unlinked: twoList, reconnect: { count: 1, names: ["Eve Reconnect"] }, empty: NONE };
const all3: Gaps = { unlinked: twoList, reconnect: { count: 1, names: ["Eve Reconnect"] }, empty: { count: 1, names: ["Table 4"] } };

/** What Intl says a list of these items reads as in English ("A and B", "A, B, and C"). */
const listEn = (items: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);
const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

describe("the online-play switch warns about players who cannot be paired online, and never blocks", () => {
  it("empty case first: nobody short -> no warning at all, for an absent summary and for a zero one, on and off", () => {
    let checked = 0;
    for (const cfg of [OFF, ON]) {
      for (const gaps of [undefined, NO_GAPS]) {
        const island = mount(cfg, gaps);
        setOnline(island, "lichess");
        const where = `saved ${String(cfg.onlinePlay)}, gaps ${JSON.stringify(gaps)}`;
        expect(warning(island), `${where}: no-link sentence`).toHaveLength(0);
        expect(reconnectWarning(island), `${where}: reconnect sentence`).toHaveLength(0);
        expect(emptyWarning(island), `${where}: empty-entrant sentence`).toHaveLength(0);
        expect(box(island), `${where}: no empty amber box either`).toHaveLength(0);
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
    expect(textOf(warning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.unlinked.other"]!, { count: 2, names: listEn(twoList.names) }));
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
    const island = mount(ON, { ...NO_GAPS, unlinked: { count: 1, names: ["Solo Unlinked"] } });

    expect(textOf(warning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.unlinked.one"]!, { count: 1, names: "Solo Unlinked" }));
  });

  it("a long list is cut at the cap and the rest folded into 'N more', the count staying the true total", () => {
    const total = LINK_GAP_NAMES_SHOWN + 3;
    const shown = Array.from({ length: LINK_GAP_NAMES_SHOWN }, (_, i) => `Player ${i + 1}`);
    const island = mount(ON, { ...NO_GAPS, unlinked: { count: total, names: shown } });

    const text = textOf(warning(island)[0]!).trim();

    const more = fill(EN["divset.onlinePlay.gapMore.other"]!, { count: 3 });
    expect(text).toBe(fill(EN["divset.onlinePlay.unlinked.other"]!, { count: total, names: listEn([...shown, more]) }));
    expect(text).toContain(`${total} players`);
    expect(text).not.toContain(`Player ${LINK_GAP_NAMES_SHOWN + 1}`);
  });

  it("exactly as many names as the count folds nothing: no 'more'", () => {
    const names = Array.from({ length: LINK_GAP_NAMES_SHOWN }, (_, i) => `Player ${i + 1}`);
    const island = mount(ON, { ...NO_GAPS, unlinked: { count: names.length, names } });

    const text = textOf(warning(island)[0]!).trim();

    expect(text).toBe(fill(EN["divset.onlinePlay.unlinked.other"]!, { count: names.length, names: listEn(names) }));
    expect(text).not.toContain(fill(EN["divset.onlinePlay.gapMore.other"]!, { count: 1 }));
  });

  // The ruling: ALLOW the switch. These are the guards a later "just disable it" would break - each is mutated by hand.
  it("the warning does not block: the Online play select is enabled, and Save match rules still saves Lichess", async () => {
    const island = mount(OFF, two);
    setOnline(island, "lichess");

    expect(propsOf(select(island)).disabled, "the select is not disabled by the warning").toBe(false);
    const button = island.tree().find((n) => n.type === "button" && textOf(n).trim() === EN["rulesStrip.format.save"]);
    expect(button, "premise: the Save match format button is there").toBeDefined();
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

  // What this asserts is the CLASS CONTRACT, no more: the box is a polite live region, and each sentence carries the classes
  // that let an unbroken token wrap inside it. The proof that a 70-character token really stays inside the box is a browser
  // measurement (e2e/division-settings.spec.ts, "an unbroken name"): `environment: "node"` has no layout, so a class scan is
  // blind to the cascade - which is how `break-words` alone shipped a <p> 593px wide inside a 244px box.
  it("the box is a polite live region and every sentence carries the wrapping classes (min-w-0 and anywhere-wrap, beside break-words)", () => {
    const island = mount(ON, all3);

    const el = box(island)[0]!;
    expect(propsOf(el).role).toBe("status");
    expect(String(propsOf(el).className)).toMatch(/\bbreak-words\b/);
    let checked = 0;
    for (const sentence of [warning(island)[0]!, reconnectWarning(island)[0]!, emptyWarning(island)[0]!]) {
      const cls = String(propsOf(sentence).className);
      expect(cls, `${String(propsOf(sentence)["data-testid"])}: min-w-0`).toMatch(/(^|\s)min-w-0(\s|$)/);
      expect(cls, `${String(propsOf(sentence)["data-testid"])}: anywhere-wrap`).toContain("[overflow-wrap:anywhere]");
      checked++;
    }
    expect(checked, "anti-vacuity: all three sentences").toBe(3);
  });

  it("a long name is printed whole in its sentence (never truncated or dropped)", () => {
    const long = "Maximilian Alexander Featherstonehaugh-Cholmondeley";
    const island = mount(ON, { ...NO_GAPS, unlinked: { count: 1, names: [long] } });

    expect(textOf(warning(island)[0]!)).toContain(long);
  });
});

describe("three sentences, each shown on its own account (controller rulings, fix rounds 1 and 2)", () => {
  it("only reconnect players: the reconnect sentence alone, from the dictionary, and no no-link sentence", () => {
    const island = mount(ON, reconnectOnly);

    expect(reconnectWarning(island)).toHaveLength(1);
    expect(warning(island), "nobody is unlinked, so that sentence is absent").toHaveLength(0);
    expect(textOf(reconnectWarning(island)[0]!).trim()).toBe(
      fill(EN["divset.onlinePlay.reconnect.other"]!, { count: 2, names: listEn(reconnectOnly.reconnect.names) }),
    );
    expect(textOf(box(island)[0]!), "the box carries only that sentence").not.toContain(EN["divset.onlinePlay.unlinked.other"]!.split("{names}")[1]!);
  });

  it("only no-link players: the no-link sentence alone, and neither of the others", () => {
    const island = mount(ON, two);

    expect(warning(island)).toHaveLength(1);
    expect(reconnectWarning(island), "nobody must reconnect, so that sentence is absent").toHaveLength(0);
    expect(emptyWarning(island), "no empty entrant, so that sentence is absent").toHaveLength(0);
    expect(textOf(box(island)[0]!)).not.toContain("reconnect");
  });

  it("only empty entrants: their OWN sentence alone, from the dictionary - they are not counted as players without a link", () => {
    const island = mount(ON, emptyOnly);

    expect(emptyWarning(island)).toHaveLength(1);
    expect(warning(island), "an empty entrant is not a player with no link").toHaveLength(0);
    expect(reconnectWarning(island)).toHaveLength(0);
    expect(textOf(emptyWarning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.empty.other"]!, { count: 2, names: listEn(emptyOnly.empty.names) }));
  });

  it("a single empty entrant reads in the singular, from the dictionary's .one", () => {
    const island = mount(ON, { ...NO_GAPS, empty: { count: 1, names: ["Table 4"] } });

    expect(textOf(emptyWarning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.empty.one"]!, { count: 1, names: "Table 4" }));
  });

  it("all three at once: three separate sentences in ONE box, each with its own count and names, none leaking into another", () => {
    const island = mount(ON, all3);

    expect(box(island)).toHaveLength(1);
    expect([warning(island).length, reconnectWarning(island).length, emptyWarning(island).length]).toEqual([1, 1, 1]);
    expect(textOf(warning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.unlinked.other"]!, { count: 2, names: listEn(twoList.names) }));
    expect(textOf(reconnectWarning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.reconnect.one"]!, { count: 1, names: "Eve Reconnect" }));
    expect(textOf(emptyWarning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.empty.one"]!, { count: 1, names: "Table 4" }));
    expect(textOf(warning(island)[0]!)).not.toContain("Table 4");
    expect(textOf(emptyWarning(island)[0]!)).not.toContain("Ann Unlinked");
  });

  it("a long empty-entrant list is cut at the same cap and folds the rest into the shared 'N more'", () => {
    const total = LINK_GAP_NAMES_SHOWN + 4;
    const shown = Array.from({ length: LINK_GAP_NAMES_SHOWN }, (_, i) => `Table ${i + 1}`);
    const island = mount(ON, { ...NO_GAPS, empty: { count: total, names: shown } });

    const more = fill(EN["divset.onlinePlay.gapMore.other"]!, { count: 4 });
    expect(textOf(emptyWarning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.empty.other"]!, { count: total, names: listEn([...shown, more]) }));
  });

  it("the empty-entrant sentence follows the form's choice and does not block: absent while Off, shown at the switch, select and Save enabled", () => {
    const island = mount(OFF, emptyOnly);
    expect(emptyWarning(island), "premise: not shown while online play is Off").toHaveLength(0);

    setOnline(island, "lichess");

    expect(emptyWarning(island)).toHaveLength(1);
    expect(propsOf(select(island)).disabled).toBe(false);
    const button = island.tree().find((n) => n.type === "button" && textOf(n).trim() === EN["rulesStrip.format.save"]);
    expect(button).toBeDefined();
    expect(propsOf(button!).disabled).toBe(false);
    setOnline(island, "off");
    expect(box(island)).toHaveLength(0);
  });

  it("both kinds at once: two separate sentences, in one box, each with its own count and names", () => {
    const island = mount(ON, both);

    expect(box(island)).toHaveLength(1);
    expect(warning(island)).toHaveLength(1);
    expect(reconnectWarning(island)).toHaveLength(1);
    expect(textOf(warning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.unlinked.other"]!, { count: 2, names: listEn(twoList.names) }));
    // 1 -> the .one form, a witness that the reconnect sentence counts ITS OWN list and not the other's total.
    expect(textOf(reconnectWarning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.reconnect.one"]!, { count: 1, names: "Eve Reconnect" }));
    expect(textOf(warning(island)[0]!), "the names do not leak across the sentences").not.toContain("Eve Reconnect");
    expect(textOf(reconnectWarning(island)[0]!)).not.toContain("Ann Unlinked");
  });

  it("the reconnect sentence follows the form's choice too: absent while Off, shown at the switch, gone again on Off", () => {
    const island = mount(OFF, reconnectOnly);
    expect(reconnectWarning(island), "premise: not shown while online play is Off").toHaveLength(0);

    setOnline(island, "lichess");
    expect(reconnectWarning(island)).toHaveLength(1);

    setOnline(island, "off");
    expect(reconnectWarning(island)).toHaveLength(0);
    expect(box(island)).toHaveLength(0);
  });

  it("a long reconnect list is cut at the same cap and folds the rest into the shared 'N more'", () => {
    const total = LINK_GAP_NAMES_SHOWN + 2;
    const shown = Array.from({ length: LINK_GAP_NAMES_SHOWN }, (_, i) => `Re ${i + 1}`);
    const island = mount(ON, { ...NO_GAPS, reconnect: { count: total, names: shown } });

    const more = fill(EN["divset.onlinePlay.gapMore.other"]!, { count: 2 });
    expect(textOf(reconnectWarning(island)[0]!).trim()).toBe(fill(EN["divset.onlinePlay.reconnect.other"]!, { count: total, names: listEn([...shown, more]) }));
  });

  it("a reconnect-only warning does not block either: the select and Save stay enabled", () => {
    const island = mount(OFF, reconnectOnly);
    setOnline(island, "lichess");

    expect(reconnectWarning(island)).toHaveLength(1);
    expect(propsOf(select(island)).disabled).toBe(false);
    const button = island.tree().find((n) => n.type === "button" && textOf(n).trim() === EN["rulesStrip.format.save"]);
    expect(button).toBeDefined();
    expect(propsOf(button!).disabled).toBe(false);
  });
});

describe("the warning copy exists in all four locales, with its plural forms and placeholders", () => {
  const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;

  it("every locale carries .one and .other of all four keys, with {count} and {names} where the sentence needs them, and no banned dash or arrow", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const form of ["one", "other"]) {
        for (const kind of ["unlinked", "reconnect", "empty"]) {
          const sentence = dict[`divset.onlinePlay.${kind}.${form}`];
          expect(sentence, `${locale} ${kind}.${form}`).toBeTypeOf("string");
          expect(sentence, `${locale} ${kind}.${form} names its players`).toContain("{names}");
          expect(sentence, `${locale} ${kind}.${form} carries the count`).toContain("{count}");
          expect(sentence, `${locale} ${kind}.${form}`).not.toMatch(BANNED_RE);
          checked++;
        }
        const more = dict[`divset.onlinePlay.gapMore.${form}`];
        expect(more, `${locale} gapMore.${form}`).toBeTypeOf("string");
        expect(more, `${locale} gapMore.${form} carries the count`).toContain("{count}");
        expect(more, `${locale} gapMore.${form}`).not.toMatch(BANNED_RE);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 2 forms x 4 keys").toBe(32);
  });

  it("the old 'unlinkedMore' key is gone from every locale (one shared tail, named for what it is)", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      expect(Object.keys(dict).filter((k) => k.startsWith("divset.onlinePlay.unlinkedMore")), locale).toEqual([]);
    }
  });

  it("the non-English sentences are translated, not copied from English", () => {
    let checked = 0;
    for (const locale of ["es", "fr", "nl"]) {
      for (const form of ["one", "other"]) {
        for (const kind of ["unlinked", "reconnect", "empty"]) {
          const key = `divset.onlinePlay.${kind}.${form}`;
          expect(LOCALES[locale]![key], `${locale} ${key}`).not.toBe(EN[key]);
          checked++;
        }
      }
    }
    expect(checked).toBe(18);
  });
});
