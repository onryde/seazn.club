// W3 T10 (X-SW-12; controller ruling 1): "Add late player" opens the Entrants tab's EXISTING add form, so the notice
// after the add is said HERE, from the server's own answer (`late_entry` on the created row, T9). And a refusal is
// said in the organiser's language, by its code, never the server's English.
//
// Driven through the panel's real add path: the form's `onSubmit` (the same function its button calls) posts to the
// mocked API, and the notice is read back off the re-rendered panel. Expected copy is the en dictionary's with the
// values put in by hand here (`fill`), never `lateEntryNotice`'s own output: that is the code under test.
import { describe, expect, it, vi } from "vitest";
import {
  propsOf,
  renderIsland,
  textOf,
} from "@/components/__tests__/_hook-harness";
import {
  EntrantsPanel,
  type EntrantsPanelEligibility,
} from "@/components/v2/entrants-panel";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

const api = vi.hoisted(() => ({
  next: null as null | (() => unknown),
  personsPage: null as null | (() => unknown),
  // W3 T12 Phase 2: the answer to "Add a round" (POST /stages/{id}/swiss/add-round), and the URLs it was sent to.
  addRound: null as null | (() => unknown),
  addRoundUrls: [] as string[],
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async (url: string, options?: { method?: string }) => {
      if (url.endsWith("/entrants") && options?.method === "POST") {
        const answer = api.next;
        if (!answer) throw new Error("no POST answer queued");
        return answer();
      }
      if (url.endsWith("/swiss/add-round") && options?.method === "POST") {
        api.addRoundUrls.push(url);
        if (!api.addRound) throw new Error("no add-round answer queued");
        return api.addRound();
      }
      if (url.startsWith("/api/v1/persons?"))
        return api.personsPage ? api.personsPage() : { items: [], nextCursor: null };
      return [];
    }),
  };
});
const { ApiV1Error } = await import("@/lib/client-v1");

const EN = en as unknown as Record<string, string>;
const fill = (key: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
    EN[key]!,
  );

const NO_ELIGIBILITY: EntrantsPanelEligibility = {
  category: null,
  age_min: null,
  age_max: null,
  eligibility_note: null,
};
const MODEL: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};
const entrant = (id: string, display_name: string) => ({
  id,
  division_id: "div-1",
  kind: "individual",
  display_name,
  seed: null,
  status: "confirmed",
  members: [],
});
const ROSTER = [
  entrant("e1", "Ana"),
  entrant("e2", "Ben"),
  entrant("e3", "Cy"),
];

function mount(over: Record<string, unknown> = {}) {
  const island = renderIsland(EntrantsPanel, {
    divisionId: "div-1",
    entrants: ROSTER,
    canEdit: true,
    positionGroups: [],
    roles: [],
    eligibility: NO_ELIGIBILITY,
    entrantModel: MODEL,
    viewerPlan: "community" as const,
    divisionStatus: "active",
    swissLateEntry: { openOnlineRounds: [] },
    ...over,
  } as never);
  const submit = async (answer: () => unknown) => {
    api.next = answer;
    const form = island
      .tree()
      .find((el) => propsOf(el).importControls !== undefined);
    if (!form) throw new Error("no add form");
    await (
      propsOf(form).onSubmit as (p: Record<string, unknown>) => Promise<unknown>
    )({ kind: "individual", display_name: "Zoe" });
  };
  const lines = () =>
    // `tree()` is already the walked, flat list of every element.
    island
      .tree()
      .filter((el) => propsOf(el)["data-testid"] === "entrants-late-entry-line")
      .map((el) => ({ tone: propsOf(el)["data-tone"], text: textOf([el]) }));
  const error = () => {
    const el = island
      .tree()
      .find((e) => propsOf(e)["data-testid"] === "entrants-error");
    return el ? textOf([el]) : null;
  };
  return { island, submit, lines, error };
}

const created = (late_entry?: Record<string, unknown>) => () => ({
  ...entrant("e9", "Zoe"),
  ...(late_entry ? { late_entry } : {}),
});

describe("EntrantsPanel — the late-entry notice after an add (W3 T10)", () => {
  it("(a) names the entrants whose match changed, asks for a reprint, and flags the unscheduled match", async () => {
    const p = mount();
    await p.submit(
      created({
        entrant_id: "e9",
        stage_id: "s1",
        case: "a",
        round: 2,
        repaired: { changed_entrant_ids: ["e2", "e1"] },
        new_board: { fixture_id: "f9", scheduled: false },
      }),
    );
    expect(p.lines()).toEqual([
      {
        tone: "done",
        text: fill("swiss.lateEntry.repaired.other", {
          round: 2,
          name: "Zoe",
          count: 2,
        }),
      },
      {
        tone: "todo",
        text: fill("swiss.lateEntry.tellChanged", { names: "Ana and Ben" }),
      },
      {
        tone: "todo",
        text: fill("swiss.lateEntry.reprintSheets", { round: 2 }),
      },
      { tone: "todo", text: fill("swiss.lateEntry.newMatchUnscheduled", {}) },
    ]);
    expect(p.error()).toBeNull();
  });

  it("(b) names the bye holder; the invite line only when that round is already open online", async () => {
    const answer = created({
      entrant_id: "e9",
      stage_id: "s1",
      case: "b",
      round: 3,
      bye_holder_id: "e3",
      new_board: { fixture_id: "f9", scheduled: true },
    });
    const offline = mount();
    await offline.submit(answer);
    expect(offline.lines()).toEqual([
      {
        tone: "done",
        text: fill("swiss.lateEntry.tookBye", {
          name: "Zoe",
          holder: "Cy",
          round: 3,
        }),
      },
    ]);

    const online = mount({ swissLateEntry: { openOnlineRounds: ["s1:3"] } });
    await online.submit(answer);
    expect(online.lines()).toEqual([
      {
        tone: "done",
        text: fill("swiss.lateEntry.tookBye", {
          name: "Zoe",
          holder: "Cy",
          round: 3,
        }),
      },
      {
        tone: "todo",
        text: fill("swiss.lateEntry.inviteOwed", {
          round: 3,
          name: "Zoe",
          holder: "Cy",
        }),
      },
    ]);
    // Another round open is not this one.
    const otherRound = mount({
      swissLateEntry: { openOnlineRounds: ["s1:2", "s2:3"] },
    });
    await otherRound.submit(answer);
    expect(otherRound.lines()).toHaveLength(1);
  });

  it("(c) says the round the entrant joins from; a second add replaces the first add's notice", async () => {
    const p = mount();
    await p.submit(
      created({
        entrant_id: "e9",
        stage_id: "s1",
        case: "a",
        round: 2,
        repaired: { changed_entrant_ids: [] },
      }),
    );
    expect(p.lines()).toEqual([
      {
        tone: "done",
        text: fill("swiss.lateEntry.repairedNoChange", {
          round: 2,
          name: "Zoe",
        }),
      },
    ]);
    await p.submit(
      created({ entrant_id: "e9", stage_id: "s1", case: "c", round: 4 }),
    );
    expect(p.lines()).toEqual([
      {
        tone: "done",
        text: fill("swiss.lateEntry.nextRound", { name: "Zoe", round: 4 }),
      },
    ]);
  });

  it("an ordinary add (no late_entry on the row) says nothing, and clears an earlier notice", async () => {
    const p = mount();
    await p.submit(
      created({ entrant_id: "e9", stage_id: "s1", case: "c", round: 4 }),
    );
    expect(p.lines(), "premise: a notice was showing").toHaveLength(1);
    await p.submit(created());
    expect(p.lines()).toEqual([]);
    expect(p.error()).toBeNull();
  });

  it("says each refusal in the organiser's words, by its code, and drops the previous notice", async () => {
    let checked = 0;
    for (const [code, status] of [
      ["SWISS_NO_ROUND_LEFT", 409],
      ["SWISS_OVER", 422],
    ] as const) {
      const p = mount();
      await p.submit(
        created({ entrant_id: "e9", stage_id: "s1", case: "c", round: 4 }),
      );
      expect(p.lines(), "premise").toHaveLength(1);
      await p.submit(() => {
        throw new ApiV1Error("English from the server", status, code, {
          canAddRound: true,
        });
      });
      expect(p.error(), code).toBe(EN[`swiss.refusal.${code}`]);
      expect(p.lines(), `${code}: no stale notice beside the refusal`).toEqual(
        [],
      );
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("EntrantsPanel — the running-Swiss note above the add form (W3 T10)", () => {
  const note = (over: Record<string, unknown>) =>
    mount(over)
      .island.tree()
      .find((el) => propsOf(el)["data-testid"] === "entrants-swiss-late-note");

  it("shows on a division with a running Swiss, over the open form; never without one, nor on a locked list", () => {
    const shown = mount({});
    expect(
      shown.island
        .tree()
        .find((el) => propsOf(el).importControls !== undefined),
      "premise: the form renders",
    ).toBeDefined();
    expect(textOf(shown.island.tree())).toContain(
      EN["entrants.swissLate.note"],
    );
    expect(note({ swissLateEntry: null }), "no running Swiss").toBeUndefined();
    expect(
      note({ swissLateEntry: undefined }),
      "every other caller",
    ).toBeUndefined();
    expect(
      note({ rosterLocked: true }),
      "a locked list has no form to explain",
    ).toBeUndefined();
    expect(note({ canEdit: false }), "a viewer").toBeUndefined();
  });

  it("the form carries the id the rail's link lands on", () => {
    const anchor = mount({})
      .island.tree()
      .find((el) => propsOf(el).id === "add-entrant");
    expect(anchor, "no #add-entrant on the Entrants tab").toBeDefined();
  });
});

describe("EntrantsPanel — New player waits for Players to load (owner ruling 2026-11-01)", () => {
  it("hands the form `personsReady` only once the directory has loaded, so the duplicate check sees everyone", async () => {
    let release!: (page: unknown) => void;
    const pending = new Promise((r) => (release = r));
    api.personsPage = () => pending;
    try {
      const p = mount();
      const form = () => p.island.tree().find((el) => propsOf(el).importControls !== undefined)!;
      expect(propsOf(form()).personsReady, "still loading").toBe(false);
      release({ items: [], nextCursor: null });
      await new Promise((r) => setTimeout(r, 0));
      expect(propsOf(form()).personsReady, "loaded").toBe(true);
    } finally {
      api.personsPage = null;
    }
  });
});

describe("EntrantsPanel — Players fails to load (review m1)", () => {
  it("says so under New player, keeps it off, and Retry loads Players and turns it on", async () => {
    api.personsPage = () => Promise.reject(new Error("network"));
    try {
      const p = mount();
      await new Promise((r) => setTimeout(r, 0));
      const form = () => p.island.tree().find((el) => propsOf(el).importControls !== undefined)!;
      expect(propsOf(form()).personsFailed, "the failure reaches the form").toBe(true);
      expect(propsOf(form()).personsReady, "New player stays off: its duplicate check has no list").toBe(false);

      api.personsPage = null; // the next load succeeds
      (propsOf(form()).onRetryPersons as () => void)();
      expect(propsOf(form()).personsFailed, "retrying clears the failure").toBe(false);
      await new Promise((r) => setTimeout(r, 0));
      expect(propsOf(form()).personsReady, "loaded on retry").toBe(true);
      expect(propsOf(form()).personsFailed).toBe(false);
    } finally {
      api.personsPage = null;
    }
  });
});

// W3 T12 Phase 2 — SWISS_NO_ROUND_LEFT's own sentence names the recovery, "Add a round"; the button stands under the
// error only while the server says it goes through (`canAddRound`, ruling C11) and names the Swiss to add it to
// (`stageId`). After it lands, the line says the round was added and to add the player again (the refused add wrote
// nothing). Single-sport by nature: the panel reads a code and two details; no sport reaches it.
describe("EntrantsPanel — Add a round on SWISS_NO_ROUND_LEFT (W3 T12 Phase 2)", () => {
  const noRoundLeft = (extra: Record<string, unknown>) => () => {
    throw new ApiV1Error("English from the server", 409, "SWISS_NO_ROUND_LEFT", extra);
  };
  const button = (p: ReturnType<typeof mount>) =>
    p.island.tree().find((e) => propsOf(e)["data-testid"] === "entrants-add-round");
  const added = (p: ReturnType<typeof mount>) => {
    const el = p.island.tree().find((e) => propsOf(e)["data-testid"] === "entrants-round-added");
    return el ? textOf([el]) : null;
  };

  it("offered when the server says Add a round goes through; it posts to the Swiss the refusal names, then says the round", async () => {
    api.addRoundUrls = [];
    const p = mount();
    await p.submit(noRoundLeft({ canAddRound: true, stageId: "s1" }));
    expect(p.error()).toBe(EN["swiss.refusal.SWISS_NO_ROUND_LEFT"]);
    expect(button(p), "the recovery the sentence names").toBeDefined();
    expect(textOf([button(p)!])).toBe(EN["stage.more.addRound"]);
    api.addRound = () => ({ rounds: 4, shells_added: 3 });
    (propsOf(button(p)!).onClick as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.addRoundUrls).toEqual(["/api/v1/stages/s1/swiss/add-round"]);
    expect(p.error(), "the refusal is answered").toBeNull();
    expect(button(p), "and its button gone").toBeUndefined();
    expect(added(p)).toBe(fill("entrants.lateEntry.roundAdded", { round: 4 }));
    // The next add clears the line.
    await p.submit(created());
    expect(added(p)).toBeNull();
  });

  it("not offered when it would only be refused, nor without the Swiss it names, nor for another refusal", async () => {
    let checked = 0;
    for (const [name, answer] of [
      ["canAddRound false", noRoundLeft({ canAddRound: false, stageId: "s1" })],
      ["no stageId", noRoundLeft({ canAddRound: true })],
      [
        "SWISS_OVER",
        () => {
          throw new ApiV1Error("English", 422, "SWISS_OVER", { canAddRound: true, stageId: "s1" });
        },
      ],
    ] as const) {
      const p = mount();
      await p.submit(answer);
      expect(p.error(), `${name}: the refusal is said`).not.toBeNull();
      expect(button(p), name).toBeUndefined();
      checked++;
    }
    expect(checked, "anti-vacuity: cases").toBe(3);
  });

  it("the button leaves with its refusal: a later add that lands clears the error, and the recovery with it", async () => {
    const p = mount();
    await p.submit(noRoundLeft({ canAddRound: true, stageId: "s1" }));
    expect(button(p), "premise: offered").toBeDefined();
    await p.submit(created());
    expect(p.error()).toBeNull();
    expect(button(p), "no Add a round beside no refusal").toBeUndefined();
  });

  it("a refused Add a round (the field changed meanwhile) says that refusal, and the button goes with the old one", async () => {
    const p = mount();
    await p.submit(noRoundLeft({ canAddRound: true, stageId: "s1" }));
    api.addRound = () => {
      throw new ApiV1Error("English", 422, "SWISS_ROUNDS_ABOVE_MAX", { rounds: 4, field: 4, hardMax: 3, canFinish: false });
    };
    (propsOf(button(p)!).onClick as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.error()).toBe(EN["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]);
    expect(button(p)).toBeUndefined();
    expect(added(p)).toBeNull();
  });
});
