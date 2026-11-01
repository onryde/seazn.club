// Owner ruling 2026-11-01: the add-entrant form gets an inline "New player". A late arrival is often not in Players
// yet, so the organiser types a name, the person is created through the EXISTING `POST /api/v1/persons`, selected
// through the form's own pick path, and the organiser stays in the form. Every entrant kind, every format.
//
// Driven through the form's real handlers (typing is the input's onChange, a tap is the button's onClick) with the API
// mocked at `apiV1`. Expected copy is read from the en dictionary; expected names come from the test's own inputs.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { NewEntrantFields } from "@/components/v2/entrants-panel";
import type { EffectiveEntrantModel, EntrantKind } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

type Answer = () => unknown;
const api = vi.hoisted(() => ({ posts: [] as { full_name: string }[], answers: [] as (() => unknown)[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn(async (url: string, options?: { method?: string; json?: { full_name: string } }) => {
      if (url === "/api/v1/persons" && options?.method === "POST") {
        api.posts.push(options.json!);
        const answer = api.answers.shift();
        if (!answer) throw new Error("no POST /persons answer queued");
        return answer();
      }
      throw new Error(`unexpected apiV1 ${options?.method ?? "GET"} ${url}`);
    }),
  };
});
const { ApiV1Error } = await import("@/lib/client-v1");

const EN = en as unknown as Record<string, string>;
const person = (id: string, full_name: string) => ({ id, full_name, dob: null, gender: null });
const created = (id: string, full_name: string): Answer => () => person(id, full_name);

const modelOf = (kind: EntrantKind, maxTeamMembers: number | null = null): EffectiveEntrantModel => ({
  kinds: [kind],
  defaultKind: kind,
  squadNumbers: false,
  captain: false,
  maxTeamMembers,
});

function mount(kind: EntrantKind, directory = [person("p1", "Ana López"), person("p2", "Ben Okafor")], maxTeamMembers: number | null = null) {
  api.posts = [];
  api.answers = [];
  const onPersonCreated = vi.fn();
  const island = renderIsland(NewEntrantFields, {
    persons: directory,
    entrantModel: modelOf(kind, maxTeamMembers),
    busy: false,
    onSubmit: async () => undefined,
    onPersonCreated,
  } as never);
  const byTestId = (id: string): ReactElement | undefined => island.tree().find((el) => propsOf(el)["data-testid"] === id);
  const must = (id: string) => {
    const el = byTestId(id);
    if (!el) throw new Error(`no ${id}`);
    return el;
  };
  const type = (value: string) => (propsOf(must("new-player-name")).onChange as (e: unknown) => void)({ target: { value } });
  const tap = () => (propsOf(must("new-player-add")).onClick as () => Promise<void>)();
  const enter = () =>
    (propsOf(must("new-player-name")).onKeyDown as (e: unknown) => Promise<void> | void)({ key: "Enter", preventDefault: () => undefined });
  const selected = () =>
    island
      .tree()
      .filter((el) => el.type === "button" && propsOf(el)["aria-pressed"] === true)
      .map((el) => textOf([el]));
  const note = () => {
    const el = byTestId("new-player-note");
    return el ? { tone: propsOf(el)["data-tone"], text: textOf([el]) } : null;
  };
  const entrantName = () => {
    const el = island.tree().find((e) => e.type === "input" && propsOf(e).placeholder === EN["entrants.add.namePlaceholder.individual"]);
    return el ? propsOf(el).value : undefined;
  };
  return { island, must, byTestId, type, tap, enter, selected, note, entrantName, onPersonCreated };
}

describe("New player on the add-entrant form (owner ruling 2026-11-01)", () => {
  it("creates the typed person through POST /api/v1/persons, selects them, and stays in the form, for every kind", async () => {
    let checked = 0;
    for (const kind of ["individual", "pair", "team"] as const) {
      const f = mount(kind);
      f.type("  Zoe Ng  ");
      api.answers.push(created("p9", "Zoe Ng"));
      await f.tap();
      expect(api.posts, kind).toEqual([{ full_name: "Zoe Ng" }]);
      expect(f.selected(), `${kind}: the new person is picked`).toEqual(["Zoe Ng"]);
      expect(f.onPersonCreated, `${kind}: the panel's Players list learns the person`).toHaveBeenCalledWith(person("p9", "Zoe Ng"));
      expect(f.note(), kind).toEqual({ tone: "done", text: EN["entrants.add.newPlayer.created"]!.replace("{name}", "Zoe Ng") });
      expect(propsOf(f.must("new-player-name")).value, `${kind}: the field clears for the next one`).toBe("");
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("an individual's new person REPLACES an earlier pick, through the same pick path", async () => {
    const f = mount("individual");
    const ana = f.island.tree().find((el) => el.type === "button" && textOf([el]) === "Ana López")!;
    (propsOf(ana).onClick as () => void)();
    expect(f.selected(), "premise").toEqual(["Ana López"]);
    f.type("Zoe Ng");
    api.answers.push(created("p9", "Zoe Ng"));
    await f.tap();
    expect(f.selected()).toEqual(["Zoe Ng"]);
  });

  it("two New players back to back fill a pair; the third is refused with the seats full", async () => {
    const f = mount("pair");
    f.type("Zoe Ng");
    api.answers.push(created("p9", "Zoe Ng"));
    await f.tap();
    f.type("Yuki Sato");
    api.answers.push(created("p10", "Yuki Sato"));
    await f.tap();
    expect(api.posts.map((p) => p.full_name)).toEqual(["Zoe Ng", "Yuki Sato"]);
    expect(f.selected()).toEqual(["Zoe Ng", "Yuki Sato"]);
    f.type("Xia Wu");
    expect(propsOf(f.must("new-player-add")).disabled, "seats full").toBe(true);
    expect(propsOf(f.must("new-player-name")).disabled, "seats full").toBe(true);
    await f.tap(); // a stale tap from before the re-render still reaches the handler
    expect(api.posts, "no third person minted into a full pair").toHaveLength(2);
    expect(f.selected()).toEqual(["Zoe Ng", "Yuki Sato"]);
  });

  it("a team takes a free seat up to its cap, and no further", async () => {
    const f = mount("team", [person("p1", "Ana López")], 2);
    const ana = f.island.tree().find((el) => el.type === "button" && textOf([el]) === "Ana López")!;
    (propsOf(ana).onClick as () => void)();
    f.type("Zoe Ng");
    api.answers.push(created("p9", "Zoe Ng"));
    await f.tap();
    expect(f.selected()).toEqual(["Ana López", "Zoe Ng"]);
    expect(propsOf(f.must("new-player-add")).disabled).toBe(true);
  });

  it("a name Players already holds (any case, any spacing at the ends) selects that person and creates nothing", async () => {
    let checked = 0;
    for (const typed of ["ana lópez", "  ANA LÓPEZ  ", "Ana López"]) {
      const f = mount("individual");
      f.type(typed);
      await f.tap();
      expect(api.posts, typed).toEqual([]);
      expect(f.selected(), typed).toEqual(["Ana López"]);
      expect(f.note(), typed).toEqual({ tone: "done", text: EN["entrants.add.newPlayer.existing"] });
      expect(f.onPersonCreated).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a duplicate of someone already picked keeps them picked (never toggles them off)", async () => {
    const f = mount("pair");
    const ana = f.island.tree().find((el) => el.type === "button" && textOf([el]) === "Ana López")!;
    (propsOf(ana).onClick as () => void)();
    f.type("ana lópez");
    await f.tap();
    expect(f.selected()).toEqual(["Ana López"]);
    expect(api.posts).toEqual([]);
  });

  it("a person created moments ago is a duplicate too: the same name twice mints ONE person", async () => {
    const f = mount("pair");
    f.type("Zoe Ng");
    api.answers.push(created("p9", "Zoe Ng"));
    await f.tap();
    f.type("zoe ng");
    await f.tap();
    expect(api.posts).toHaveLength(1);
    expect(f.selected()).toEqual(["Zoe Ng"]);
    expect(f.note()?.text).toBe(EN["entrants.add.newPlayer.existing"]);
  });

  it("an empty or whitespace name is refused before any request: the button is off, and Enter says why", async () => {
    let checked = 0;
    for (const typed of ["", "   ", "\t"]) {
      const f = mount("individual");
      f.type(typed);
      expect(propsOf(f.must("new-player-add")).disabled, JSON.stringify(typed)).toBe(true);
      await f.enter();
      await f.tap();
      expect(api.posts, JSON.stringify(typed)).toEqual([]);
      expect(f.selected()).toEqual([]);
      expect(f.note(), JSON.stringify(typed)).toEqual({ tone: "error", text: EN["entrants.add.newPlayer.empty"] });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("Enter in the field creates, the same as the button", async () => {
    const f = mount("individual");
    f.type("Zoe Ng");
    api.answers.push(created("p9", "Zoe Ng"));
    await f.enter();
    expect(api.posts).toEqual([{ full_name: "Zoe Ng" }]);
    expect(f.selected()).toEqual(["Zoe Ng"]);
  });

  it("a double tap creates ONE person: the second tap lands while the first is in flight", async () => {
    const f = mount("individual");
    f.type("Zoe Ng");
    let release!: (v: unknown) => void;
    api.answers.push(() => new Promise((r) => (release = r)));
    const add = propsOf(f.must("new-player-add")).onClick as () => Promise<void>;
    const first = add();
    const second = add(); // the SAME stale handler, as a fast second tap is
    expect(propsOf(f.must("new-player-add")).disabled, "busy while in flight").toBe(true);
    expect(textOf([f.must("new-player-add")])).toBe(EN["entrants.add.newPlayer.creating"]);
    release(person("p9", "Zoe Ng"));
    await Promise.all([first, second]);
    expect(api.posts).toHaveLength(1);
    expect(f.selected()).toEqual(["Zoe Ng"]);
  });

  it("a failed create says so inline, picks nobody, keeps the typed name, and lets the organiser retry", async () => {
    const f = mount("individual");
    f.type("Zoe Ng");
    api.answers.push(() => {
      throw new ApiV1Error("English from the server", 500, "INTERNAL", undefined);
    });
    await f.tap();
    expect(f.note()).toEqual({ tone: "error", text: EN["entrants.add.newPlayer.failed"] });
    expect(f.selected()).toEqual([]);
    expect(propsOf(f.must("new-player-name")).value).toBe("Zoe Ng");
    expect(propsOf(f.must("new-player-add")).disabled).toBe(false);
    expect(f.onPersonCreated).not.toHaveBeenCalled();
    api.answers.push(created("p9", "Zoe Ng"));
    await f.tap();
    expect(f.selected()).toEqual(["Zoe Ng"]);
  });

  it("the new person's chip shows even when Players is longer than the picker's first eight", async () => {
    const many = Array.from({ length: 12 }, (_, i) => person(`p${i}`, `Player ${String(i).padStart(2, "0")}`));
    const f = mount("individual", many);
    f.type("Zoe Ng");
    api.answers.push(created("p99", "Zoe Ng"));
    await f.tap();
    expect(f.selected()).toEqual(["Zoe Ng"]);
  });

  it("before Players has loaded, New player waits: a duplicate check against a half-loaded list would mint a twin", async () => {
    // Seen on the label server (2026-11-01): a tap that beat the directory's load created a second "Oluwaseun …".
    api.posts = [];
    api.answers = [];
    const props = {
      persons: [] as ReturnType<typeof person>[],
      personsReady: false,
      entrantModel: modelOf("individual"),
      busy: false,
      onSubmit: async () => undefined,
      onPersonCreated: vi.fn(),
    };
    const island = renderIsland(NewEntrantFields, props as never);
    const el = (id: string) => island.tree().find((e) => propsOf(e)["data-testid"] === id)!;
    (propsOf(el("new-player-name")).onChange as (e: unknown) => void)({ target: { value: "ana lópez" } });
    expect(propsOf(el("new-player-add")).disabled, "off until Players has loaded").toBe(true);
    await (propsOf(el("new-player-add")).onClick as () => Promise<void>)();
    expect(api.posts, "no request against an unloaded directory").toEqual([]);

    island.rerender({ ...props, persons: [person("p1", "Ana López")], personsReady: true } as never);
    expect(propsOf(el("new-player-add")).disabled).toBe(false);
    await (propsOf(el("new-player-add")).onClick as () => Promise<void>)();
    expect(api.posts, "the loaded directory had them").toEqual([]);
    expect(
      island
        .tree()
        .filter((e) => e.type === "button" && propsOf(e)["aria-pressed"] === true)
        .map((e) => textOf([e])),
    ).toEqual(["Ana López"]);
  });

  it("adding the entrant clears New player's note with the rest of the form (it never outlives its pick)", async () => {
    const f = mount("individual");
    f.type("Zoe Ng");
    api.answers.push(created("p9", "Zoe Ng"));
    await f.tap();
    expect(f.note()?.text, "premise").toBe(EN["entrants.add.newPlayer.created"]!.replace("{name}", "Zoe Ng"));
    const add = f.island.tree().find((el) => el.type === "button" && textOf([el]) === EN["entrants.add.submit"])!;
    await (propsOf(add).onClick as () => Promise<void>)();
    expect(f.selected(), "premise: the form reset").toEqual([]);
    expect(f.note()?.text ?? "").toBe("");
  });

  it("the field caps at the API's own name bound", () => {
    const f = mount("individual");
    expect(propsOf(f.must("new-player-name")).maxLength).toBe(200);
  });

  it("an untouched entrant Name fills from the new person (the form's derived name)", async () => {
    const f = mount("individual");
    f.type("Zoe Ng");
    api.answers.push(created("p9", "Zoe Ng"));
    await f.tap();
    expect(f.entrantName()).toBe("Zoe Ng");
  });
});
