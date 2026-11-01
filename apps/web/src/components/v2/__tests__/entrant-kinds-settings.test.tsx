// Match Day C4 (owner, 2026-10-31): the entrant kinds - what an entrant in this division looks like (individual, pair, team), the
// default, the team extras - moved from the division Settings tab to the TOP of the Entrants tab (`entrant-kinds-settings.tsx`),
// for the organiser only. Every behaviour the Settings block had moves with it, unchanged: the chess individual-only ruling
// (owner 2026-10-26), the sport-default / overridden caption and Reset, the wholesale-config save, and the server's "withdraw
// them first" refusal, which is shown as the server words it (the lock lives in `patchDivision`, not in the form).
// Static markup (node env) for "is the control on the screen"; the hook harness for what Save and Reset send.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { EntrantKindsSettings } from "@/components/v2/entrant-kinds-settings";
import { CHESS_INDIVIDUAL_ONLY, CHESS_SPORT_KEY } from "@/lib/chess-individual-only";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));
const { refreshMock, net } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  net: { calls: [] as { url: string; init: { method?: string; json?: unknown } }[], refuse: null as Error | null },
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: async (url: string, init: { method?: string; json?: unknown } = {}) => {
      net.calls.push({ url, init });
      if (net.refuse) throw net.refuse;
      return {};
    },
  };
});
import { ApiV1Error } from "@/lib/client-v1";

const EN = enUi as Record<string, string>;
const INDIVIDUAL_ONLY: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };
const TEAM_MODEL: EffectiveEntrantModel = { kinds: ["individual", "pair", "team"], defaultKind: "individual", squadNumbers: true, captain: true, maxTeamMembers: null };
const WIDENED = { kinds: ["individual", "team"], defaultKind: "team", squadNumbers: true, captain: true };

type P = ComponentProps<typeof EntrantKindsSettings>;
const props = (over: Partial<P> = {}): P => ({
  divisionId: "d1",
  sportKey: "football",
  config: {},
  entrantModel: INDIVIDUAL_ONLY,
  canEdit: true,
  ...over,
});
const render = (over: Partial<P> = {}): string => renderToStaticMarkup(<EntrantKindsSettings defaultOpen {...props(over)} />);
const closed = (over: Partial<P> = {}): string => renderToStaticMarkup(<EntrantKindsSettings {...props(over)} />);

const button = (tree: ReactElement[], pick: (el: ReactElement) => boolean): ReactElement => {
  const el = tree.find((e) => e.type === "button" && pick(e));
  expect(el, "premise: the button is on the page").toBeDefined();
  return el!;
};
const click = (el: ReactElement) => (propsOf(el).onClick as () => void)();
const kindChip = (tree: ReactElement[], kind: string) => button(tree, (e) => propsOf(e)["data-kind"] === kind);
const saveButton = (tree: ReactElement[]) => button(tree, (e) => textOf(e).trim() === EN["divset.entrants.save"]);
const resetButton = (tree: ReactElement[]) => button(tree, (e) => textOf(e).trim() === EN["divset.entrants.reset"]);
const patches = () => net.calls.filter((c) => c.init.method === "PATCH");

beforeEach(() => {
  net.calls = [];
  net.refuse = null;
  refreshMock.mockClear();
});

describe("the entrant kinds block - what the organiser sees on the Entrants tab", () => {
  it("opened: the sport-default caption, all three kinds selectable, a default-kind select and Save", () => {
    const html = render();
    expect(html).toContain(EN["divset.entrants.kinds"]);
    for (const kind of ["individual", "pair", "team"]) expect(html, kind).toMatch(new RegExp(`data-kind="${kind}"`));
    expect(html).toContain('data-testid="entrants-sport-default"');
    expect(html).toContain(EN["divset.entrants.defaultKind"]);
    expect(html).toContain(EN["divset.entrants.save"]);
    expect(html).toContain(EN["divset.entrants.note"]!.replace(/'/g, "&#x27;"));
  });

  it("closed (the default): one header row that names the ticked kinds in words - not the controls", () => {
    const html = closed({ entrantModel: TEAM_MODEL });
    expect(html).toContain(EN["divset.entrants.kinds"]);
    expect(html).toContain(`${EN["divset.entrants.kind.individual"]}, ${EN["divset.entrants.kind.pair"]}, ${EN["divset.entrants.kind.team"]}`);
    expect(html).toContain('aria-expanded="false"');
    expect(html, "the body is folded").not.toContain("data-kind=");
    expect(html).not.toContain(EN["divset.entrants.save"]);
  });

  it("ticks only the effective model's kinds", () => {
    const html = render();
    expect(html).toMatch(/data-kind="individual"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-kind="team"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/data-kind="pair"[^>]*aria-pressed="false"/);
  });

  it("reveals the squad-number and captain toggles only while team is ticked", () => {
    expect(render()).not.toContain(EN["divset.entrants.squadNumbers"]);
    const withTeam = render({ entrantModel: { ...TEAM_MODEL, kinds: ["team", "individual"], defaultKind: "team" } });
    expect(withTeam).toContain(EN["divset.entrants.squadNumbers"]);
    expect(withTeam).toContain(EN["divset.entrants.captain"]);
  });

  it("offers Reset only when the config carries a saved override", () => {
    const sport = render({ config: {} });
    expect(sport).not.toContain(EN["divset.entrants.reset"]);
    expect(sport).toContain("entrants-sport-default");
    const override = render({ config: { entrants: { kinds: ["individual", "team"], defaultKind: "individual" } } });
    expect(override).toContain(EN["divset.entrants.reset"]);
    expect(override).not.toContain("entrants-sport-default");
  });

  it("billing-frozen / read-only (canEdit=false): the chips and the default are disabled, there is no Save and no Reset", () => {
    const html = render({ canEdit: false, config: { entrants: { kinds: ["individual"], defaultKind: "individual" } } });
    expect(html).not.toContain(EN["divset.entrants.save"]);
    expect(html).not.toContain(EN["divset.entrants.reset"]);
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    for (const kind of ["individual", "pair", "team"]) expect(html, kind).toMatch(new RegExp(`data-kind="${kind}"[^>]*disabled=""`));
  });
});

// Owner ruling 2026-10-26: chess divisions are individual-only. The block must not OFFER pair, team or a default kind for chess,
// must keep offering them for every other sport, and must still render a legacy widened row (a division saved before the ruling)
// without crashing - naming it and offering Reset, never a Save.
describe("chess is individual-only (unchanged by the move)", () => {
  it("offers no kind chips, default select, team options or Save; says why", () => {
    const html = render({ sportKey: CHESS_SPORT_KEY });
    expect(html).toContain('data-testid="entrants-chess-only"');
    expect(html).toContain(EN["divset.entrants.chessOnly"]);
    for (const absent of ["data-kind=", EN["divset.entrants.defaultKind"]!, EN["divset.entrants.teamOptions"]!, EN["divset.entrants.save"]!, "entrants-sport-default", "entrants-chess-legacy", EN["divset.entrants.reset"]!]) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it("a legacy widened row still renders, names the leftover setup and offers Reset - not the team controls", () => {
    const html = render({ sportKey: CHESS_SPORT_KEY, entrantModel: TEAM_MODEL, config: { entrants: WIDENED } });
    expect(html).toContain('data-testid="entrants-chess-legacy"');
    expect(html).toContain(EN["divset.entrants.reset"]);
    for (const absent of ["data-kind=", EN["divset.entrants.teamOptions"]!, EN["divset.entrants.squadNumbers"]!, EN["divset.entrants.save"]!]) expect(html, absent).not.toContain(absent);
  });

  it("a viewer-state legacy row (canEdit=false) sees the line but no Reset", () => {
    const html = render({ sportKey: CHESS_SPORT_KEY, config: { entrants: WIDENED }, canEdit: false });
    expect(html).toContain('data-testid="entrants-chess-legacy"');
    expect(html).not.toContain(EN["divset.entrants.reset"]);
  });

  it("an individual-only override left by an earlier Save is not legacy: nothing to reset", () => {
    expect(render({ sportKey: CHESS_SPORT_KEY, config: { entrants: { kinds: ["individual"], defaultKind: "individual" } } })).not.toContain("entrants-chess-legacy");
  });

  it("every OTHER sport in the registry still offers all three kinds and Save (positive pair, swept)", () => {
    const others = builtinModules.filter((m) => m.key !== CHESS_SPORT_KEY);
    expect(others.length).toBeGreaterThan(1);
    let checked = 0;
    for (const m of others) {
      const html = render({ sportKey: m.key, entrantModel: TEAM_MODEL });
      for (const kind of ["individual", "pair", "team"]) expect(html, `${m.key} offers ${kind}`).toMatch(new RegExp(`data-kind="${kind}"`));
      expect(html, m.key).not.toContain("entrants-chess-only");
      expect(html, m.key).toContain(EN["divset.entrants.save"]);
      checked += 1;
    }
    expect(checked).toBe(others.length);
  });

  it("the same widened model on a team sport renders the team controls (the chess branch is not a global hide)", () => {
    const html = render({ sportKey: "football", entrantModel: TEAM_MODEL, config: { entrants: WIDENED } });
    expect(html).toContain(EN["divset.entrants.teamOptions"]);
    expect(html).not.toContain("entrants-chess-legacy");
  });
});

describe("Save and Reset send what the Settings block sent", () => {
  it("Save: ticking team, then Save, PATCHes the division with the stored config plus the new entrants override", () => {
    const stored = { variant: "standard", points: { win: 3 } };
    const island = renderIsland(EntrantKindsSettings, props({ config: stored }));
    click(kindChip(island.tree(), "team"));
    click(saveButton(island.tree()));
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toBe("/api/v1/divisions/d1");
    // Same wholesale-config contract as before: the server merges the variant preset with the sent config and re-validates.
    expect(patches()[0]!.init.json).toEqual({
      config: { ...stored, entrants: { kinds: ["individual", "team"], defaultKind: "individual", squadNumbers: false, captain: false } },
    });
  });

  it("Save without a team kind carries no team extras", () => {
    const island = renderIsland(EntrantKindsSettings, props({ entrantModel: TEAM_MODEL }));
    click(kindChip(island.tree(), "team")); // untick team
    click(saveButton(island.tree()));
    expect((patches()[0]!.init.json as { config: { entrants: Record<string, unknown> } }).config.entrants).toEqual({ kinds: ["individual", "pair"], defaultKind: "individual" });
  });

  it("the last ticked kind cannot be unticked, and a default that falls out re-points at the first remaining kind", () => {
    const island = renderIsland(EntrantKindsSettings, props());
    click(kindChip(island.tree(), "individual")); // refused: would empty the list
    expect(propsOf(kindChip(island.tree(), "individual"))["aria-pressed"]).toBe(true);
    click(kindChip(island.tree(), "team"));
    click(kindChip(island.tree(), "individual")); // individual was the default: the default moves to team
    click(saveButton(island.tree()));
    const sent = (patches()[0]!.init.json as { config: { entrants: { kinds: string[]; defaultKind: string } } }).config.entrants;
    expect(sent.kinds).toEqual(["team"]);
    expect(sent.defaultKind).toBe("team");
  });

  it("Reset: drops the entrants key from the stored config and says so", async () => {
    const stored = { variant: "standard", entrants: { kinds: ["individual", "team"], defaultKind: "team" } };
    const island = renderIsland(EntrantKindsSettings, props({ config: stored }));
    click(resetButton(island.tree()));
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.init.json).toEqual({ config: { variant: "standard" } });
    await vi.waitFor(() => expect(island.text()).toContain(EN["divset.entrants.resetDone"]));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("after a Reset the chips follow the sport default the page hands back (state re-syncs from props)", () => {
    const widened: EffectiveEntrantModel = { ...INDIVIDUAL_ONLY, kinds: ["individual", "team"], defaultKind: "team" };
    const island = renderIsland(EntrantKindsSettings, props({ entrantModel: widened, config: { entrants: WIDENED } }));
    expect(propsOf(kindChip(island.tree(), "team"))["aria-pressed"]).toBe(true);
    island.rerender(props({ entrantModel: INDIVIDUAL_ONLY, config: {} }));
    expect(propsOf(kindChip(island.tree(), "team"))["aria-pressed"], "the chips follow the new model").toBe(false);
    expect(propsOf(kindChip(island.tree(), "individual"))["aria-pressed"]).toBe(true);
    expect(island.text()).toContain(EN["divset.entrants.sportDefault"]);
  });

  it("the server's lock refusal (a kind with active entrants) is shown to the organiser as the server words it", async () => {
    net.refuse = new ApiV1Error("entrants of kind 'team' already exist — withdraw them first", 409, "CONFLICT");
    const island = renderIsland(EntrantKindsSettings, props({ entrantModel: TEAM_MODEL }));
    click(kindChip(island.tree(), "team"));
    click(saveButton(island.tree()));
    await vi.waitFor(() => expect(island.text()).toContain("withdraw them first"));
    expect(island.text(), "a refused save does not claim to have saved").not.toContain(EN["divset.entrants.saved"]);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("CHESS_INDIVIDUAL_ONLY reads in the organiser's language, never the server's English", async () => {
    const SERVER = "Chess divisions take individual players only (server English)";
    net.refuse = new ApiV1Error(SERVER, 422, CHESS_INDIVIDUAL_ONLY);
    const island = renderIsland(EntrantKindsSettings, props());
    click(kindChip(island.tree(), "pair"));
    click(saveButton(island.tree()));
    await vi.waitFor(() => expect(island.text()).toContain(EN["divset.err.chessIndividualOnly"]));
    expect(island.text()).not.toContain(SERVER);
  });

  it("a successful Save says so and refreshes the page", async () => {
    const island = renderIsland(EntrantKindsSettings, props());
    click(kindChip(island.tree(), "pair"));
    click(saveButton(island.tree()));
    await vi.waitFor(() => expect(island.text()).toContain(EN["divset.entrants.saved"]));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

describe("the copy it needs exists in all four locales, in each locale's own words", () => {
  it("every entrant-kind string, translated (counted)", () => {
    const KEYS = [
      "divset.entrants.desc", "divset.entrants.sportDefault", "divset.entrants.overridden", "divset.entrants.kinds",
      "divset.entrants.kind.individual", "divset.entrants.kind.pair", "divset.entrants.kind.team", "divset.entrants.defaultKind",
      "divset.entrants.teamOptions", "divset.entrants.squadNumbers", "divset.entrants.captain", "divset.entrants.save",
      "divset.entrants.reset", "divset.entrants.chessOnly", "divset.entrants.chessLegacy", "divset.entrants.saved",
      "divset.entrants.resetDone", "divset.entrants.note",
    ] as const;
    const dicts = [enUi, esUi, frUi, nlUi] as Record<string, string>[];
    let checked = 0;
    for (const key of KEYS) {
      for (const d of dicts) {
        expect(typeof d[key] === "string" && d[key]!.trim().length > 0, key).toBe(true);
        checked++;
      }
      expect(new Set(dicts.map((d) => d[key])).size, `${key} is translated, not copied`).toBeGreaterThan(1);
    }
    expect(checked).toBe(KEYS.length * dicts.length);
  });

  it("the effective model the component is given comes from the engine's own declarations (premise for the page wiring)", () => {
    // Guards the fixtures above: the engine's chess model is individual-only, and a widened override widens a team sport.
    const chess = builtinModules.find((m) => m.key === CHESS_SPORT_KEY)!;
    expect(effectiveEntrantModel(chess.entrantModel ?? null).kinds).toEqual(["individual"]);
    const football = builtinModules.find((m) => m.key === "football")!;
    expect(effectiveEntrantModel(football.entrantModel ?? null, { entrants: WIDENED }).kinds).toContain("team");
  });
});
