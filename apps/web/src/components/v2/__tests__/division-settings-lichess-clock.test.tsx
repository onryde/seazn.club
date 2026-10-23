// Owner staging test 2026-10-19: with Online play = Lichess, Settings → Match rules still showed three free clock
// fields (time per side, increment, move delay), and saving anything off the server's curated list answered "Online
// play needs one of the supported time controls: 3+0, 3+2, …". The organiser could only find the list by failing.
//
// Now, while Online play is Lichess, ONE select of the supported controls replaces the free time and increment
// inputs; move delay is not offered (Lichess has none); the clock family follows from the choice. Online play = Off
// brings the free fields back. UX only: the server still validates, and the select writes the SAME config fields the
// free inputs write (`clock.base`/`clock.increment` in seconds, `variant` the family).
//
// The options come from the server's own catalogue (`SHIP1_TIME_CONTROLS`) — the test reads it from there and from the
// refusal the server itself raises, never from a retyped list. The family words are the Lichess speed rule's, worked
// by hand below from scalachess `Speed.scala` as time-controls.ts documents it (estimate = limit + 40 × increment;
// Blitz 180–479, Rapid 480–1499), not from the code under test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { expandWithHooks, propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { MatchRuleFields } from "@/components/v2/match-rules";
import { RuleFieldControl } from "@/components/v2/stage-rules/rule-field-control";
import { DivisionSettings } from "@/components/v2/division-settings";
import { SPORT_RULES } from "@/lib/match-rules";
import { HttpError } from "@/lib/errors";
import { assertTimeControl, SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
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

const EN = uiEn as Record<string, string>;
const INDIVIDUAL_ONLY: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

type Cfg = Record<string, unknown>;
const propsFor = (config: Cfg, onlineChessOffered = true, sport = "boardgame") =>
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
  }) as Parameters<typeof DivisionSettings>[0];
const mount = (config: Cfg, onlineChessOffered = true, sport = "boardgame") =>
  renderIsland(DivisionSettings, propsFor(config, onlineChessOffered, sport));
type Island = ReturnType<typeof mount>;

const byTestId = (island: Island, id: string) => island.tree().filter((n) => propsOf(n)["data-testid"] === id);
const PICKER = "division-time-control";
const picker = (island: Island): ReactElement | undefined => byTestId(island, PICKER)[0];
const optionsOf = (island: Island) =>
  walk(propsOf(picker(island)!).children as ReactElement[])
    .filter((n) => n.type === "option")
    .map((o) => ({ value: String(propsOf(o).value), label: textOf(o).trim() }));
const pickedValue = (island: Island) => String(propsOf(picker(island)!).value);

function setOnline(island: Island, value: "off" | "lichess") {
  const select = byTestId(island, "division-online-play")[0]!;
  (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}
function choose(island: Island, key: string) {
  (propsOf(picker(island)!).onChange as (e: { target: { value: string } }) => void)({ target: { value: key } });
}

/** The labels of the free rule fields the Match rules grid renders RIGHT NOW (the child expanded, as the browser
 *  does). Empty when the grid is hidden or every boardgame field is omitted. */
function freeFieldLabels(island: Island): string[] {
  const grid = island.tree().find((n) => n.type === MatchRuleFields);
  if (!grid) return [];
  // W2c: each field is a `RuleFieldControl` (stage-rules/rule-field-control.tsx) and its label lives inside it, so the
  // grid is expanded one level further, as the browser renders it.
  return walk(expandWithHooks(MatchRuleFields, grid.props as Parameters<typeof MatchRuleFields>[0]))
    .filter((n) => n.type === RuleFieldControl)
    .flatMap((c) => walk(expandWithHooks(RuleFieldControl, c.props as Parameters<typeof RuleFieldControl>[0])))
    .filter((n) => n.type === "span" && propsOf(n).className === "label")
    .map((n) => textOf(n).trim());
}
const TIME_LABEL = "Time per side (minutes)";
const INCREMENT_LABEL = "Increment per move (seconds, Fischer)";
const DELAY_LABEL = "Move delay (seconds, Bronstein/US delay)";
const FAMILY_LABEL = "Clock family";
const RUNGS_LABEL = "Tie-break games, in order";

async function save(island: Island) {
  const button = island.tree().find((n) => n.type === "button" && textOf(n).trim() === "Save match rules");
  expect(button, "premise: the Save match rules button is there").toBeDefined();
  const before = net.calls.filter((c) => c.url === "/api/v1/divisions/d1").length;
  (propsOf(button!).onClick as () => void)();
  await vi.waitFor(() => expect(net.calls.filter((c) => c.url === "/api/v1/divisions/d1")).toHaveLength(before + 1));
  const sent = net.calls.filter((c) => c.url === "/api/v1/divisions/d1").at(-1)!;
  return (sent.json as { config: Cfg }).config;
}

/** Hand-worked from the Lichess rule (see the header): the family word a control is played as. */
const familyWord = (limitSeconds: number, incrementSeconds: number) => {
  const estimate = limitSeconds + 40 * incrementSeconds;
  const key = estimate < 180 ? "bullet" : estimate < 480 ? "blitz" : estimate < 1500 ? "rapid" : "classical";
  return { key, word: EN[`variant.boardgame.${key}`]! };
};
/** The hand-worked table the rule above gives for the eight shipped controls: key → [estimate seconds, family]. */
const WORKED: Record<string, [number, string]> = {
  "3+0": [180, "blitz"],
  "3+2": [260, "blitz"],
  "5+0": [300, "blitz"],
  "5+3": [420, "blitz"],
  "10+0": [600, "rapid"],
  "10+5": [800, "rapid"],
  "15+0": [900, "rapid"],
  "15+10": [1300, "rapid"],
};

beforeEach(() => {
  net.calls.length = 0;
});

describe("Online play = Lichess: the clock is a picker of the supported controls", () => {
  it("offers exactly the server's catalogue — read from it and from the server's own refusal, never retyped", () => {
    const island = mount({ variant: "rapid", onlinePlay: "lichess", clock: { base: 600, increment: 5 } });
    expect(picker(island), "the picker renders for a Lichess division").toBeDefined();
    const values = optionsOf(island)
      .map((o) => o.value)
      .filter((v) => v !== "");
    // The catalogue the setup gate checks against...
    expect(values).toEqual(SHIP1_TIME_CONTROLS.map((t) => t.key));
    // ...and the list the server itself hands back when it refuses a clock (the sentence's `controls`).
    let refusal: HttpError | undefined;
    try {
      assertTimeControl({ base: 7200 });
    } catch (e) {
      refusal = e as HttpError;
    }
    expect(refusal?.code).toBe("INVALID_TIME_CONTROL");
    expect(values).toEqual(refusal!.extra!.controls);
    // Anti-vacuity: a list of nothing would equal itself.
    expect(values.length).toBeGreaterThan(0);
    expect(values.length).toBe(SHIP1_TIME_CONTROLS.length);
  });

  it("labels each option '<control> · <clock family word>', the family the Lichess speed rule puts it in", () => {
    const island = mount({ variant: "rapid", onlinePlay: "lichess", clock: { base: 600, increment: 5 } });
    const options = optionsOf(island).filter((o) => o.value !== "");
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      const [estimate, family] = WORKED[tc.key]!;
      // The worked table agrees with the rule applied to the catalogue's own numbers (a changed entry reds here).
      expect(tc.limitSeconds + 40 * tc.incrementSeconds, `${tc.key}: estimate`).toBe(estimate);
      expect(familyWord(tc.limitSeconds, tc.incrementSeconds).key, `${tc.key}: family`).toBe(family);
      const option = options.find((o) => o.value === tc.key);
      expect(option?.label, tc.key).toBe(`${tc.key} · ${EN[`variant.boardgame.${family}`]}`);
      checked++;
    }
    expect(checked).toBe(SHIP1_TIME_CONTROLS.length);
    // Not one word for all: both families are present, so a constant family cannot pass.
    expect(new Set(options.map((o) => o.label.split(" · ")[1])).size).toBe(2);
  });

  it("replaces the free time and increment inputs; move delay and the family field are not offered", () => {
    const island = mount({ variant: "rapid", onlinePlay: "lichess", clock: { base: 600, increment: 5 } });
    const free = freeFieldLabels(island);
    for (const label of [TIME_LABEL, INCREMENT_LABEL, DELAY_LABEL, FAMILY_LABEL]) {
      expect(free, `${label} is replaced by the picker`).not.toContain(label);
    }
    // Every boardgame rule field is one the picker replaces, except W2c's tie-break rungs (BG-KO-3): not a clock, so the
    // grid still draws it under Lichess (rebase ruling D1, 2026-10-23: the rungs stay the organiser's). A field added later
    // must be a deliberate choice.
    expect(SPORT_RULES.boardgame!.map((f) => f.key).sort()).toEqual(
      ["clockBaseMinutes", "clockDelaySeconds", "clockIncrementSeconds", "tiebreakRungs", "variant"],
    );
    expect(free, "the one field the picker does not stand in for").toEqual([RUNGS_LABEL]);
  });

  it("Online play = Off keeps the free fields and no picker (the control is a Lichess aid, not a replacement)", () => {
    const island = mount({ variant: "classical" });
    expect(picker(island), "no picker while Off").toBeUndefined();
    const free = freeFieldLabels(island);
    expect(free, "anti-vacuity: the grid renders its fields").toHaveLength(5);
    expect(free).toEqual(expect.arrayContaining([TIME_LABEL, INCREMENT_LABEL, DELAY_LABEL, FAMILY_LABEL, RUNGS_LABEL]));
  });

  it("another sport never gets the picker, even with a stray onlinePlay in its config; its rule fields are untouched", () => {
    const island = mount({ onlinePlay: "lichess" }, true, "football");
    expect(picker(island)).toBeUndefined();
    const grid = island.tree().find((n) => n.type === MatchRuleFields);
    expect(grid, "football's grid renders").toBeDefined();
    expect((grid!.props as { omit?: unknown }).omit ?? [], "nothing omitted for another sport").toEqual([]);
    expect(freeFieldLabels(island).length, "anti-vacuity: football has rule fields").toBeGreaterThan(0);
  });

  it("the picker follows the online-play STATE, not the club's flag: a division already online keeps its picker when the flag is off", () => {
    const island = mount({ variant: "rapid", onlinePlay: "lichess", clock: { base: 600, increment: 5 } }, false);
    expect(byTestId(island, "division-online-play"), "premise: the Online play select is hidden").toHaveLength(0);
    expect(pickedValue(island)).toBe("10+5");
  });
});

describe("choosing a control saves the matching clock, in the shape the free inputs write", () => {
  it("every catalogue entry: the PATCH carries clock.base/increment in seconds, the family, and onlinePlay", async () => {
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      net.calls.length = 0;
      // A different stored clock each time, so a save that ignored the choice would show the stored one.
      const island = mount({ variant: "classical", onlinePlay: "lichess", clock: { base: 7200 } });
      choose(island, tc.key);
      expect(pickedValue(island), `${tc.key}: the select shows the choice`).toBe(tc.key);
      const config = await save(island);
      expect(config.clock, tc.key).toEqual({ base: tc.limitSeconds, increment: tc.incrementSeconds });
      expect(config.variant, `${tc.key}: the family follows`).toBe(WORKED[tc.key]![1]);
      expect(config.onlinePlay, tc.key).toBe("lichess");
      expect(config.clock, `${tc.key}: a Lichess clock has no delay`).not.toHaveProperty("delay");
      checked++;
    }
    expect(checked).toBe(SHIP1_TIME_CONTROLS.length);
  });

  it("the saved config is IDENTICAL to what the free inputs write for the same clock", async () => {
    const tc = SHIP1_TIME_CONTROLS.find((t) => t.key === "10+5")!;
    // Via the picker.
    const viaPicker = mount({ variant: "classical", onlinePlay: "lichess" });
    choose(viaPicker, tc.key);
    const pickerConfig = await save(viaPicker);
    // Via the free fields: Online play Off, type 10 and 5, family Rapid, then Online play Lichess at the end.
    net.calls.length = 0;
    const viaFields = mount({ variant: "classical" });
    const grid = viaFields.tree().find((n) => n.type === MatchRuleFields)!;
    const gridProps = grid.props as Parameters<typeof MatchRuleFields>[0];
    gridProps.onChange({ ...gridProps.values, variant: "rapid", clockBaseMinutes: "10", clockIncrementSeconds: "5" });
    setOnline(viaFields, "lichess");
    // The picker now stands in for those fields and already reads 10+5 from them.
    expect(pickedValue(viaFields)).toBe("10+5");
    const fieldConfig = await save(viaFields);
    expect(pickerConfig).toEqual(fieldConfig);
  });
});

describe("opening an existing division", () => {
  it("a supported clock opens with ITS option selected — pinned per control, with neighbours that differ only by increment", () => {
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      const island = mount({
        variant: "rapid",
        onlinePlay: "lichess",
        clock: { base: tc.limitSeconds, increment: tc.incrementSeconds },
      });
      expect(pickedValue(island), `${tc.key} opens at ${tc.key}`).toBe(tc.key);
      checked++;
    }
    expect(checked).toBe(SHIP1_TIME_CONTROLS.length);
    // Sudden death stored WITHOUT an increment is the 0-increment control, exactly as the server reads it.
    expect(pickedValue(mount({ onlinePlay: "lichess", clock: { base: 180 } }))).toBe("3+0");
  });

  it("an unsupported clock opens with NO option selected and a prompt — never silently on the first one", () => {
    const UNSUPPORTED: [string, Cfg][] = [
      ["no clock at all", { variant: "classical", onlinePlay: "lichess" }],
      ["two hours, sudden death", { variant: "classical", onlinePlay: "lichess", clock: { base: 7200 } }],
      ["a supported base with an increment off the list", { variant: "rapid", onlinePlay: "lichess", clock: { base: 600, increment: 3 } }],
      ["a supported control plus a delay (Lichess has none)", { variant: "rapid", onlinePlay: "lichess", clock: { base: 600, increment: 5, delay: 3 } }],
      ["a delay of zero is still a delay clock", { variant: "rapid", onlinePlay: "lichess", clock: { base: 600, delay: 0 } }],
    ];
    const first = SHIP1_TIME_CONTROLS[0]!.key;
    let checked = 0;
    for (const [label, config] of UNSUPPORTED) {
      const island = mount(config);
      expect(pickedValue(island), label).toBe("");
      expect(pickedValue(island), `${label}: not the first option`).not.toBe(first);
      const prompt = optionsOf(island)[0]!;
      expect(prompt.value, `${label}: the empty option is the prompt`).toBe("");
      expect(prompt.label, label).toBe(EN["divset.timeControl.choose"]);
      expect(island.text(), `${label}: says why nothing is selected`).toContain(EN["divset.timeControl.unsupported"]);
      checked++;
    }
    expect(checked).toBe(UNSUPPORTED.length);
  });

  it("a supported clock shows no 'unsupported' prompt", () => {
    const island = mount({ variant: "rapid", onlinePlay: "lichess", clock: { base: 600, increment: 5 } });
    expect(island.text()).not.toContain(EN["divset.timeControl.unsupported"]);
  });

  it("an unsupported clock is not silently re-saved as a pick: saving untouched sends the stored clock for the server to refuse", async () => {
    const stored = { base: 7200 };
    const island = mount({ variant: "classical", onlinePlay: "lichess", clock: stored });
    const config = await save(island);
    expect(config.clock).toEqual(stored);
  });
});

describe("the sequence: Lichess → Off → Lichess", () => {
  it("the free fields come back on Off, carrying what was picked, and the pick survives the round trip", () => {
    const island = mount({ variant: "classical" });
    // Off: free fields.
    expect(freeFieldLabels(island)).toContain(TIME_LABEL);
    expect(picker(island)).toBeUndefined();
    // → Lichess: picker, no free time/increment/delay.
    setOnline(island, "lichess");
    expect(picker(island), "picker appears").toBeDefined();
    expect(freeFieldLabels(island)).not.toContain(TIME_LABEL);
    expect(pickedValue(island), "nothing stored, nothing selected").toBe("");
    choose(island, "5+3");
    expect(pickedValue(island)).toBe("5+3");
    // → Off: the free fields return, holding the pick (5 minutes, 3 seconds, no delay, Blitz).
    setOnline(island, "off");
    expect(picker(island), "picker gone").toBeUndefined();
    expect(freeFieldLabels(island)).toEqual(expect.arrayContaining([TIME_LABEL, INCREMENT_LABEL, DELAY_LABEL, FAMILY_LABEL]));
    const grid = island.tree().find((n) => n.type === MatchRuleFields)!;
    expect((grid.props as { values: Record<string, string> }).values).toMatchObject({
      clockBaseMinutes: "5",
      clockIncrementSeconds: "3",
      clockDelaySeconds: "",
      variant: "blitz",
    });
    // → Lichess again: still 5+3.
    setOnline(island, "lichess");
    expect(pickedValue(island)).toBe("5+3");
  });

  it("a free-typed clock off the list, then Lichess: no selection; editing the delay out makes it a pick again", () => {
    const island = mount({ variant: "classical" });
    const grid = () => island.tree().find((n) => n.type === MatchRuleFields)!.props as Parameters<typeof MatchRuleFields>[0];
    grid().onChange({ ...grid().values, clockBaseMinutes: "10", clockIncrementSeconds: "5", clockDelaySeconds: "3" });
    setOnline(island, "lichess");
    expect(pickedValue(island), "10+5 with a delay is not 10+5").toBe("");
    // The delay field is hidden under Lichess, so choosing the control is the way out — and it clears the delay.
    choose(island, "10+5");
    expect(pickedValue(island)).toBe("10+5");
    setOnline(island, "off");
    expect((grid().values as Record<string, string>).clockDelaySeconds).toBe("");
  });

  it("the picker follows the SAVED config after a refresh (a new division prop), not a stale choice", () => {
    const island = mount({ variant: "rapid", onlinePlay: "lichess", clock: { base: 600, increment: 5 } });
    choose(island, "3+0");
    expect(pickedValue(island)).toBe("3+0");
    // The server stored 15+10 meanwhile (a save elsewhere, router.refresh()): the resync adopts it.
    island.rerender(propsFor({ variant: "rapid", onlinePlay: "lichess", clock: { base: 900, increment: 10 } }));
    expect(pickedValue(island)).toBe("15+10");
  });
});

describe("copy: the new strings exist in all four locales", () => {
  const KEYS = [
    "divset.timeControl.label",
    "divset.timeControl.choose",
    "divset.timeControl.help",
    "divset.timeControl.unsupported",
  ] as const;
  const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;
  it("each key is a non-empty string in en/es/fr/nl, and each locale words it differently from English", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const key of KEYS) {
        expect(typeof dict[key] === "string" && dict[key]!.trim().length > 0, `${locale} ${key}`).toBe(true);
        if (locale !== "en") expect(dict[key], `${locale} ${key} is translated`).not.toBe(EN[key]);
        checked++;
      }
    }
    expect(checked).toBe(Object.keys(LOCALES).length * KEYS.length);
  });
});
