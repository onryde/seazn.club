// UI5 item 3 (owner, 2026-11-03): one person, one team per division - the console's half. The server refuses the write
// (entrants-one-team-per-division.test.ts, against Postgres); these are the three places an organiser meets the rule before
// and after it:
//
//   - the new-entrant picker: a person already on another entrant of the division is left out of the suggestions; a SEARCH
//     still finds them, shown disabled and labelled "On <team>", and the pick path ignores them; New player typing the name of
//     someone taken says so instead of picking them;
//   - the roster editor: the old amber "You can still save" advisory is now the same block, translated - Save stays off until
//     the person is removed; the candidates follow the picker's rule;
//   - the panel's refusal banner: 409 PERSON_ON_OTHER_TEAM is said in the organiser's language, naming each person and team
//     from the payload, never the server's English.
//
// The map the console reads (`/api/v1/divisions/{id}/roster` -> `divisionRoster`) shares the refusal's predicate on the
// server. Every expected string is read from the dictionaries; names come from the test's own inputs. Rendered through the
// hook harness (vitest runs `environment: "node"`); `useMsg` is bound to a chosen locale with the production lookup.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { EntrantsPanel, NewEntrantFields, RosterEditor, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import type { EffectiveEntrantModel, EntrantKind } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const active = vi.hoisted(() => ({ locale: "en" }));
vi.mock("@/components/i18n/dict-provider", async () => {
  const { t: translate, plural: pluralise } = await import("@/lib/i18n-runtime");
  const dicts: Record<string, unknown> = {
    en: (await import("@/dictionaries/en/ui.json")).default,
    es: (await import("@/dictionaries/es/ui.json")).default,
    fr: (await import("@/dictionaries/fr/ui.json")).default,
    nl: (await import("@/dictionaries/nl/ui.json")).default,
  };
  return {
    useLocaleOrDefault: () => active.locale,
    useMsg:
      () =>
      (key: string, vars?: Record<string, string | number>): string =>
        translate(dicts[active.locale] as never, key as never, vars),
    useMsgPlural:
      () =>
      (key: string, count: number, vars?: Record<string, string | number>): string =>
        pluralise(dicts[active.locale] as never, key, count, active.locale as never, vars),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

type Held = { person_id: string; entrant_id: string; entrant_name: string };
const api = vi.hoisted(() => ({
  roster: [] as { person_id: string; entrant_id: string; entrant_name: string }[],
  personsLoaded: 0,
  nextWrite: null as { message: string; status: number; code: string; extra: Record<string, unknown> } | null,
  writes: [] as string[],
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn(async (url: string, options?: { method?: string }) => {
      if (url.startsWith("/api/v1/persons?")) {
        api.personsLoaded++;
        return { items: [person("p-ada", "Ada Shared"), person("p-bo", "Bo Free")], nextCursor: null };
      }
      if (/^\/api\/v1\/divisions\/[^/]+\/roster$/.test(url)) return api.roster;
      if (/^\/api\/v1\/entrants\/[^/]+(\/roster\/sync)?$/.test(url) && (options?.method === "PATCH" || options?.method === "POST")) {
        api.writes.push(`${options.method} ${url}`);
        const failure = api.nextWrite;
        api.nextWrite = null;
        if (failure) throw new actual.ApiV1Error(failure.message, failure.status, failure.code, failure.extra);
        return { members: [] };
      }
      if (url.endsWith("/entrants") && options?.method === "POST") {
        api.writes.push(`POST ${url}`);
        const failure = api.nextWrite;
        api.nextWrite = null;
        if (failure) throw new actual.ApiV1Error(failure.message, failure.status, failure.code, failure.extra);
        return [];
      }
      if (url === "/api/v1/clubs" || url === "/api/v1/teams") return [];
      return {};
    }),
  };
});

const DICTS: Record<Locale, Record<string, string>> = { en, es, fr, nl } as never;
const say = (locale: Locale, key: string, vars: Record<string, string> = {}): string => {
  const v = DICTS[locale][key];
  expect(v, `${locale} has ${key}`).toBeTruthy();
  return Object.entries(vars).reduce((s, [k, x]) => s.replaceAll(`{${k}}`, x), v!);
};
function person(id: string, full_name: string) {
  return { id, full_name, dob: null, gender: null };
}
const modelOf = (kind: EntrantKind): EffectiveEntrantModel => ({ kinds: [kind], defaultKind: kind, squadNumbers: false, captain: false, maxTeamMembers: null });
const RED: Held = { person_id: "p-ada", entrant_id: "e-red", entrant_name: "Red" };
const heldIn = (rows: Held[]) => (personId: string) => rows.filter((r) => r.person_id === personId);

type Tree = ReturnType<ReturnType<typeof renderIsland>["tree"]>;
const chips = (tree: Tree) => tree.filter((el) => el.type === "button" && propsOf(el)["data-person"] !== undefined);
const chipOf = (tree: Tree, id: string) => chips(tree).find((el) => propsOf(el)["data-person"] === id);

function picker(kind: EntrantKind, held: Held[], directory = [person("p-ada", "Ada Shared"), person("p-bo", "Bo Free")]) {
  const island = renderIsland(NewEntrantFields, {
    persons: directory,
    entrantModel: modelOf(kind),
    busy: false,
    onSubmit: async () => undefined,
    heldBy: heldIn(held),
  } as never);
  const search = (value: string) => {
    const input = island.tree().find((el) => el.type === "input" && propsOf(el).placeholder === say(active.locale as Locale, "entrants.add.searchPlayers"));
    (propsOf(input!).onChange as (e: unknown) => void)({ target: { value } });
  };
  const selected = () => chips(island.tree()).filter((el) => propsOf(el)["aria-pressed"] === true).map((el) => propsOf(el)["data-person"]);
  return { island, search, selected };
}

describe("the new-entrant picker: one person, one team per division", () => {
  it("the empty case first: nobody held - every person is suggested, and none is disabled", () => {
    active.locale = "en";
    const f = picker("team", []);
    expect(chips(f.island.tree()).map((el) => propsOf(el)["data-person"])).toEqual(["p-ada", "p-bo"]);
    expect(chips(f.island.tree()).filter((el) => propsOf(el).disabled === true)).toHaveLength(0);
  });

  it("a person on another team is left out of the suggestions, for every kind", () => {
    active.locale = "en";
    let checked = 0;
    for (const kind of ["individual", "pair", "team"] as const) {
      const f = picker(kind, [RED]);
      expect(chips(f.island.tree()).map((el) => propsOf(el)["data-person"]), kind).toEqual(["p-bo"]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a search finds them, disabled and labelled On <team> in every locale; a tap picks nobody", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      active.locale = locale;
      const f = picker("team", [RED]);
      f.search("ada");
      const ada = chipOf(f.island.tree(), "p-ada");
      expect(ada, `${locale}: found by search`).toBeDefined();
      expect(propsOf(ada!).disabled, locale).toBe(true);
      expect(textOf([ada!]), locale).toContain(say(locale, "entrants.add.onOtherTeam", { team: "Red" }));
      (propsOf(ada!).onClick as () => void)();
      expect(f.selected(), `${locale}: the pick path ignores a held person`).toEqual([]);
      // The positive pair: Bo, held by nobody, picks.
      f.search("bo");
      (propsOf(chipOf(f.island.tree(), "p-bo")!).onClick as () => void)();
      expect(f.selected(), locale).toEqual(["p-bo"]);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    expect(new Set(LOCALES.map((l) => say(l, "entrants.add.onOtherTeam", { team: "Red" }))).size, "four different words").toBe(LOCALES.length);
  });

  it("New player typing the name of a held person says who holds them and picks nobody", async () => {
    active.locale = "fr";
    const f = picker("pair", [RED]);
    const byTestId = (id: string): ReactElement | undefined => f.island.tree().find((el) => propsOf(el)["data-testid"] === id);
    (propsOf(byTestId("new-player-name")!).onChange as (e: unknown) => void)({ target: { value: "ada shared" } });
    await (propsOf(byTestId("new-player-add")!).onClick as () => Promise<void>)();
    const note = byTestId("new-player-note")!;
    expect(propsOf(note)["data-tone"]).toBe("error");
    expect(textOf([note])).toBe(say("fr", "entrants.err.personOnOtherTeam", { name: "Ada Shared", team: "Red" }));
    expect(f.selected()).toEqual([]);
  });
});

const NO_ELIGIBILITY: EntrantsPanelEligibility = { category: null, age_min: null, age_max: null, eligibility_note: null };
const member = (person_id: string, full_name: string) => ({
  person_id, full_name, dob: null, gender: null, squad_number: null, default_position_key: null, is_captain: false, roles: [] as string[],
});

function roster(members: ReturnType<typeof member>[], held: Held[], onSave = vi.fn()) {
  const island = renderIsland(RosterEditor, {
    kind: "team",
    members,
    persons: [person("p-ada", "Ada Shared"), person("p-bo", "Bo Free"), person("p-cy", "Cy Taken")],
    positionGroups: [],
    roles: [],
    canEdit: true,
    busy: false,
    allowCaptain: false,
    allowSquadNumbers: false,
    entrantModel: modelOf("team"),
    eligibility: NO_ELIGIBILITY,
    conflictsFor: heldIn(held),
    onSave,
  } as never);
  const save = () => island.tree().find((el) => el.type === "button" && textOf([el]) === say(active.locale as Locale, "entrants.roster.save"))!;
  const block = () => island.tree().find((el) => propsOf(el)["data-testid"] === "entrant-roster-held");
  const candidates = () => chips(island.tree()).map((el) => propsOf(el)["data-person"]);
  return { island, save, block, candidates, onSave };
}

describe("the roster editor: the old advisory is a block now, translated", () => {
  it("the empty case first: nobody held - no block, Save waits only for an edit", () => {
    active.locale = "en";
    const r = roster([member("p-bo", "Bo Free")], []);
    expect(r.block()).toBeUndefined();
    expect(propsOf(r.save()).disabled, "nothing edited yet").toBe(true);
  });

  it("a member already on another team: the block names them and the team in every locale, and Save stays off", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      active.locale = locale;
      const r = roster([member("p-ada", "Ada Shared"), member("p-bo", "Bo Free")], [RED]);
      expect(textOf([r.block()!]), locale).toBe(say(locale, "entrants.roster.onOtherTeam", { name: "Ada Shared", team: "Red" }));
      expect(textOf([r.block()!]), `${locale}: never the old English`).not.toContain("You can still save");
      expect(propsOf(r.save()).disabled, locale).toBe(true);
      // An edit elsewhere on the roster (Bo removed) makes it dirty: Save is STILL off while Ada is held.
      const removes = r.island.tree().filter((el) => el.type === "button" && textOf([el]) === say(locale, "entrants.roster.remove"));
      (propsOf(removes[1]!).onClick as () => void)();
      expect(r.block(), `${locale}: Ada is still held`).toBeDefined();
      expect(propsOf(r.save()).disabled, `${locale}: dirty, and still blocked`).toBe(true);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("removing the held member clears the block and lets Save through; the save carries the rest", () => {
    active.locale = "en";
    const r = roster([member("p-ada", "Ada Shared"), member("p-bo", "Bo Free")], [RED]);
    const remove = r.island.tree().filter((el) => el.type === "button" && textOf([el]) === say("en", "entrants.roster.remove"));
    expect(remove, "one remove per member").toHaveLength(2);
    (propsOf(remove[0]!).onClick as () => void)();
    expect(r.block(), "the block goes with the person").toBeUndefined();
    expect(propsOf(r.save()).disabled).toBe(false);
    (propsOf(r.save()).onClick as () => void)();
    expect(r.onSave.mock.calls[0]![0].map((m: { person_id: string }) => m.person_id)).toEqual(["p-bo"]);
  });

  it("candidates follow the picker: a held person is not suggested, a search shows them disabled On <team>, a tap adds nobody", () => {
    active.locale = "nl";
    const cy: Held = { person_id: "p-cy", entrant_id: "e-blue", entrant_name: "Blue" };
    const r = roster([member("p-bo", "Bo Free")], [cy]);
    expect(r.candidates()).toEqual(["p-ada"]);
    const find = r.island.tree().find((el) => el.type === "input" && propsOf(el).placeholder === say("nl", "entrants.roster.findPlayer"))!;
    (propsOf(find).onChange as (e: unknown) => void)({ target: { value: "cy" } });
    const chip = chipOf(r.island.tree(), "p-cy")!;
    expect(propsOf(chip).disabled).toBe(true);
    expect(textOf([chip])).toContain(say("nl", "entrants.add.onOtherTeam", { team: "Blue" }));
    (propsOf(chip).onClick as () => void)();
    expect(r.block(), "nobody was added").toBeUndefined();
    expect(propsOf(r.save()).disabled, "and nothing is dirty").toBe(true);
  });
});

// The wiring: the panel reads the division's roster map into both pickers, and says the server's refusal in the organiser's
// language. Driven through the mounted panel's own handlers, as a tap would reach them.
type Row = { id: string; kind: string; team_id: string | null; display_name: string; seed: number | null; status: string; badge_url: string | null };
const entrantRow = (id: string, display_name: string): Row => ({ id, kind: "team", team_id: null, display_name, seed: null, status: "confirmed", badge_url: null });
const banner = (tree: Tree) => tree.find((e) => e.type === "p" && String(propsOf(e).className ?? "").includes("bg-red-50"));

async function mountPanel(entrants: Row[]) {
  api.personsLoaded = 0;
  api.writes.length = 0;
  api.nextWrite = null;
  const island = renderIsland(EntrantsPanel, {
    divisionId: "div-1",
    entrants,
    canEdit: true,
    positionGroups: [],
    roles: [],
    eligibility: NO_ELIGIBILITY,
    entrantModel: modelOf("team"),
    viewerPlan: "pro" as const,
    divisionStatus: "setup",
  });
  await vi.waitFor(() => expect(api.personsLoaded).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 0));
  return island;
}

describe("EntrantsPanel: the roster map reaches the picker, and PERSON_ON_OTHER_TEAM is said in the organiser's language", () => {
  it("the panel hands the add form the division's roster map: Ada is held by Red, Bo by nobody", async () => {
    active.locale = "en";
    api.roster = [RED];
    const island = await mountPanel([entrantRow("e-red", "Red")]);
    // The add form is a nested component the harness does not expand: its props are what the panel hands it, and the
    // picker's own rule over those props is pinned above (`NewEntrantFields`).
    const form = () => island.tree().find((e) => propsOf(e).importControls !== undefined)!;
    await vi.waitFor(() => expect((propsOf(form()).heldBy as (id: string) => Held[])("p-ada"), "after the map loads").toEqual([RED]));
    expect((propsOf(form()).heldBy as (id: string) => Held[])("p-bo")).toEqual([]);
    // The positive pair, the same mount shape: an empty map holds nobody.
    api.roster = [];
    const free = await mountPanel([entrantRow("e-red", "Red")]);
    const freeForm = free.tree().find((e) => propsOf(e).importControls !== undefined)!;
    expect((propsOf(freeForm).heldBy as (id: string) => Held[])("p-ada")).toEqual([]);
  });

  it("a refused roster save names each person and team from the payload, in Spanish, never the server's English", async () => {
    active.locale = "es";
    api.roster = [];
    const island = await mountPanel([entrantRow("e-blue", "Blue")]);
    api.nextWrite = {
      message: "Ada Shared is already on Red in this division; Bo Free is already on Gold in this division",
      status: 409,
      code: "PERSON_ON_OTHER_TEAM",
      extra: {
        conflicts: [
          { person_id: "p-ada", person_name: "Ada Shared", entrant_id: "e-red", entrant_name: "Red" },
          { person_id: "p-bo", person_name: "Bo Free", entrant_id: "e-gold", entrant_name: "Gold" },
        ],
      },
    };
    const row = island.tree().find((e) => propsOf(e).entrant !== undefined && (propsOf(e).entrant as Row).id === "e-blue")!;
    await (propsOf(row).onPatch as (patch: unknown) => Promise<unknown>)({ members: [{ person_id: "p-ada", is_captain: false, roles: [] }] });
    expect(api.writes, "premise: the save went to the server").toEqual(["PATCH /api/v1/entrants/e-blue"]);
    const shown = textOf([banner(island.tree())!]);
    expect(shown).toBe(
      [
        say("es", "entrants.err.personOnOtherTeam", { name: "Ada Shared", team: "Red" }),
        say("es", "entrants.err.personOnOtherTeam", { name: "Bo Free", team: "Gold" }),
      ].join(" "),
    );
    expect(shown).not.toContain("already on");
  });
});
