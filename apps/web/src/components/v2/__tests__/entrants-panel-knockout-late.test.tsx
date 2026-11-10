// W4 app-A Task 19 (X-LE-10 / X-LE-3 desk half; b6a carry B3 #3, B3 re-review, T13 review #4): what the ENTRANTS TAB says about
// a started root knockout. "Add to bracket" from the rail lands on this tab's own add form (never a second form); the
// answer of the add (`late_entry`, T9/T10), of a Reinstate (T19: the PATCH reply carries it) and of a Withdraw / Disqualify
// (T13: the cascade's `lucky_loser`) is said here — in the organiser's language, by code, never the server's English.
//
// Driven through the panel's real handlers: the add form's `onSubmit`, and each row's own `onPatch` / `onWithdraw` /
// `onDisqualify` (the functions its buttons call), against a mocked wire; the notice is read back off the re-rendered panel.
// Expected sentences are the approved English (task-19 brief, b6a-carry) and the shipped French typed out here, never read
// off the component or the notice builder. Single-sport by nature: the panel reads an answer's case, names and ids only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { EntrantsPanel, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import fr from "@/dictionaries/fr/ui.json";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
const confirmMock = vi.hoisted(() => ({ answer: true, calls: [] as unknown[] }));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async (opts: unknown) => {
    confirmMock.calls.push(opts);
    return confirmMock.answer;
  },
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));
const active = vi.hoisted(() => ({ locale: "en" as "en" | "fr" }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => {
      const real = actual.useMsg();
      return active.locale === "fr" ? (key: string, vars?: Record<string, string | number>) => tRuntime(fr as unknown as Dict, key, vars) : real;
    },
    useMsgPlural: () => {
      const real = actual.useMsgPlural();
      return active.locale === "fr"
        ? (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(fr as unknown as Dict, key, count, "fr", vars)
        : real;
    },
  };
});

const api = vi.hoisted(() => ({ post: null as null | (() => unknown), patch: null as null | (() => unknown), withdraw: null as null | (() => unknown), calls: [] as { url: string; method?: string; json?: unknown }[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn(async (url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, method: options?.method, json: options?.json });
      if (url.endsWith("/withdraw") && options?.method === "POST") {
        if (!api.withdraw) throw new Error("no withdraw answer queued");
        return api.withdraw();
      }
      if (url.endsWith("/entrants") && options?.method === "POST") {
        if (!api.post) throw new Error("no POST answer queued");
        return api.post();
      }
      if (url.includes("/api/v1/entrants/") && options?.method === "PATCH") {
        if (!api.patch) throw new Error("no PATCH answer queued");
        return api.patch();
      }
      if (url.startsWith("/api/v1/persons?")) return { items: [], nextCursor: null };
      return [];
    }),
  };
});
const { ApiV1Error } = await import("@/lib/client-v1");

const NO_ELIGIBILITY: EntrantsPanelEligibility = { category: null, age_min: null, age_max: null, eligibility_note: null };
const MODEL: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };
const entrant = (id: string, display_name: string, status = "confirmed") => ({ id, division_id: "div-1", kind: "individual", display_name, seed: null, status, members: [] });
const ROSTER = [entrant("e1", "Ana"), entrant("e2", "Ben"), entrant("e3", "Cy"), entrant("e4", "Dee", "withdrawn")];

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
    knockoutLateEntry: true,
    ...over,
  } as never);
  const byTestId = (id: string) => island.tree().filter((el) => propsOf(el)["data-testid"] === id);
  const add = async (answer: () => unknown) => {
    api.post = answer;
    const form = island.tree().find((el) => propsOf(el).importControls !== undefined);
    if (!form) throw new Error("no add form");
    await (propsOf(form).onSubmit as (p: Record<string, unknown>) => Promise<unknown>)({ kind: "individual", display_name: "Zoe" });
  };
  const row = (id: string) => {
    const el = island.tree().find((e) => (propsOf(e).entrant as { id?: string } | undefined)?.id === id);
    if (!el) throw new Error(`no row ${id}`);
    return propsOf(el) as { onPatch: (p: Record<string, unknown>) => unknown; onWithdraw: () => Promise<void>; onDisqualify: () => Promise<void> };
  };
  const lines = (testid: string) => byTestId(testid).map((el) => ({ tone: propsOf(el)["data-tone"], text: textOf([el]) }));
  const error = () => {
    const el = byTestId("entrants-error")[0];
    return el ? textOf([el]) : null;
  };
  return { island, add, row, byTestId, lines, error };
}
const koResult = (o: Record<string, unknown>) => ({ format: "knockout", entrant_id: "e9", stage_id: "s1", ...o });
const created = (late_entry?: Record<string, unknown>) => () => ({ ...entrant("e9", "Zoe"), ...(late_entry ? { late_entry } : {}) });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  api.post = api.patch = api.withdraw = null;
  api.calls = [];
  confirmMock.answer = true;
  confirmMock.calls = [];
  active.locale = "en";
});

describe("the knockout note above the add form (X-LE-3)", () => {
  it("the empty case first: no note unless the division takes knockout late entry; present when it does (the same form, never a second)", () => {
    expect(mount({ knockoutLateEntry: false }).byTestId("entrants-knockout-late-note")).toHaveLength(0);
    expect(mount({ knockoutLateEntry: undefined }).byTestId("entrants-knockout-late-note")).toHaveLength(0);
    const on = mount();
    const note = on.byTestId("entrants-knockout-late-note");
    expect(note).toHaveLength(1);
    expect(textOf(note[0]!)).toBe("This knockout has started. A player you add here takes a free place in round 1: a bye, or a withdrawn player's place.");
    // one add form, and it is the one `#add-entrant` anchors
    expect(on.island.tree().filter((el) => propsOf(el).importControls !== undefined)).toHaveLength(1);
    expect(on.island.tree().some((el) => propsOf(el).id === "add-entrant")).toBe(true);
    // a running Swiss's own note is not this one
    expect(on.byTestId("entrants-swiss-late-note")).toHaveLength(0);
  });
});

describe("an add into a started knockout says what it did (X-LE-3), and refusals in the organiser's words", () => {
  it("the bye: who the late player plays; a withdrawn place: whose; an unscheduled match is flagged", async () => {
    const bye = mount();
    await bye.add(created(koResult({ case: "bye", fixture_id: "f1", opponent_id: "e3", scheduled: true })));
    expect(bye.lines("entrants-late-entry-line")).toEqual([{ tone: "done", text: "Zoe plays Cy, who had a bye." }]);

    const slot = mount();
    await slot.add(created(koResult({ case: "withdrawn_slot", fixture_id: "f2", opponent_id: "e2", withdrawn_id: "e4", scheduled: false })));
    expect(slot.lines("entrants-late-entry-line")).toEqual([
      { tone: "done", text: "Zoe takes Dee's place against Ben." },
      { tone: "todo", text: "1 new match is unscheduled." },
    ]);
    expect(slot.error()).toBeNull();
  });

  it("no slot left (409 KO_LATE_ENTRY_NO_SLOT) is said in English and in French, never the server's sentence", async () => {
    const en = mount();
    await en.add(() => {
      throw new ApiV1Error("The server's English", 409, "KO_LATE_ENTRY_NO_SLOT", { can_rebuild: false });
    });
    expect(en.error()).toBe("Round 1 complete; no slot left.");
    active.locale = "fr";
    const french = mount();
    await french.add(() => {
      throw new ApiV1Error("The server's English", 409, "KO_LATE_ENTRY_NO_SLOT", { can_rebuild: false });
    });
    expect(french.error()).toBe("1er tour complet ; il ne reste aucune place.");
    expect(french.error()).not.toBe("Round 1 complete; no slot left.");
  });

  // B6a fix round 1 (review #2; RB4-L6, owner ruling): with no slot and nothing started the server KEEPS the player and answers 201
  // `rebuild_offered` (it used to refuse 409 with details.can_rebuild, which this panel ignored). The panel says it as the amber
  // late-entry line - no red error, the player is on the list - pointing at the button the waiting strip wears.
  it("no slot, nothing started (201 rebuild_offered): an amber line names Rebuild fixtures - in English and in French - and no error", async () => {
    const en = mount();
    await en.add(created(koResult({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" })));
    expect(en.lines("entrants-late-entry-line")).toEqual([
      { tone: "todo", text: "No slot is left, but nothing has started: use Rebuild fixtures to add Zoe." },
    ]);
    expect(en.error(), "an offer is no refusal").toBeNull();
    active.locale = "fr";
    const french = mount();
    await french.add(created(koResult({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" })));
    expect(french.lines("entrants-late-entry-line")).toEqual([
      { tone: "todo", text: "Il ne reste aucune place, mais rien n'a commencé : utilisez Reconstruire les matchs pour ajouter Zoe." },
    ]);
  });

  it("the offer, then a bye on the next add: the second answer replaces the first (the sequence)", async () => {
    const p = mount();
    await p.add(created(koResult({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" })));
    expect(p.lines("entrants-late-entry-line"), "premise: the offer is showing").toHaveLength(1);
    await p.add(created(koResult({ case: "bye", fixture_id: "f1", opponent_id: "e3", scheduled: true })));
    expect(p.lines("entrants-late-entry-line")).toEqual([{ tone: "done", text: "Zoe plays Cy, who had a bye." }]);
  });

  it("a fed knockout (422 KO_LATE_ENTRY_FED_STAGE) names the stage the player belongs in", async () => {
    const p = mount();
    await p.add(() => {
      throw new ApiV1Error("The server's English", 422, "KO_LATE_ENTRY_FED_STAGE", { stage: "Group stage" });
    });
    expect(p.error()).toBe("This knockout is filled from Group stage. Add the player there.");
  });

  it("a refusal drops the previous notice, and an unknown failure keeps its own message", async () => {
    const p = mount();
    await p.add(created(koResult({ case: "bye", fixture_id: "f1", opponent_id: "e3", scheduled: true })));
    expect(p.lines("entrants-late-entry-line"), "premise: a notice was showing").toHaveLength(1);
    await p.add(() => {
      throw new ApiV1Error("x", 409, "KO_LATE_ENTRY_NO_SLOT", {});
    });
    expect(p.lines("entrants-late-entry-line")).toEqual([]);
    await p.add(() => {
      throw new Error("Network down");
    });
    expect(p.error()).toBe("Network down");
  });
});

describe("a Reinstate into a started knockout says how the player rejoins (K13, B3 re-review)", () => {
  const reinstate = async (p: ReturnType<typeof mount>, reply: () => unknown) => {
    api.patch = reply;
    await p.row("e4").onPatch({ status: "registered" });
    await flush();
  };

  it("waiting: the same flag sentence the desk uses, as a to-do", async () => {
    const p = mount();
    await reinstate(p, () => ({ ...entrant("e4", "Dee", "registered"), late_entry: koResult({ entrant_id: "e4", case: "waiting" }) }));
    expect(p.lines("entrants-departure-line")).toEqual([{ tone: "todo", text: "1 late player waiting — add to bracket" }]);
  });

  it("played on: back on the list, but their place in the bracket has been played on — said, never a silent flip", async () => {
    const p = mount();
    await reinstate(p, () => ({ ...entrant("e4", "Dee", "registered"), late_entry: koResult({ entrant_id: "e4", case: "refused", reason: "KO_LATE_ENTRY_PLAYED_ON" }) }));
    expect(p.lines("entrants-departure-line")).toEqual([{ tone: "todo", text: "Dee is back on the list, but their place in the bracket has been played on." }]);
  });

  it("a SWISS-shaped late_entry on the reply is not this notice's to say: nothing (only a knockout answer is read here)", async () => {
    const p = mount();
    // case "b" would be said as "... plays <bye holder> on a new board" if it were read; a Swiss reinstate has always been silent here.
    await reinstate(p, () => ({
      ...entrant("e4", "Dee", "registered"),
      late_entry: { format: "swiss", entrant_id: "e4", stage_id: "s1", case: "b", round: 2, bye_holder_id: "e3", new_board: { fixture_id: "f9", scheduled: false } },
    }));
    expect(p.lines("entrants-departure-line")).toEqual([]);
    expect(p.error(), "premise: it is silent, not failing").toBeNull();
  });

  it("a plain reinstate (no late_entry) says nothing and clears the earlier line (the second call)", async () => {
    const p = mount();
    await reinstate(p, () => ({ ...entrant("e4", "Dee", "registered"), late_entry: koResult({ entrant_id: "e4", case: "waiting" }) }));
    expect(p.lines("entrants-departure-line"), "premise: a line was showing").toHaveLength(1);
    await reinstate(p, () => entrant("e4", "Dee", "registered"));
    expect(p.lines("entrants-departure-line")).toEqual([]);
  });
});

describe("a Withdraw or Disqualify names the lucky loser who took the seat (T13 review #4)", () => {
  const withdraw = async (p: ReturnType<typeof mount>, reply: () => unknown) => {
    api.withdraw = reply;
    await p.row("e3").onWithdraw();
    await flush();
  };

  it("the empty cases first: no lucky loser, no field at all (an older reply), and a cancelled confirm say nothing", async () => {
    const none = mount();
    await withdraw(none, () => ({ entrant_id: "e3", lucky_loser: null }));
    expect(none.lines("entrants-departure-line")).toEqual([]);
    const old = mount();
    await withdraw(old, () => ({ entrant_id: "e3" }));
    expect(old.lines("entrants-departure-line")).toEqual([]);
    const cancelled = mount();
    confirmMock.answer = false;
    await withdraw(cancelled, () => ({ entrant_id: "e3", lucky_loser: { entrant_id: "e2", fixture_id: "f1" } }));
    expect(cancelled.lines("entrants-departure-line")).toEqual([]);
    expect(api.calls.filter((c) => c.url.endsWith("/withdraw"))).toHaveLength(2); // the two that were confirmed, not the cancelled one
  });

  it("withdraw: who takes whose place, green; a second withdraw with no lucky loser clears it", async () => {
    const p = mount();
    await withdraw(p, () => ({ entrant_id: "e3", lucky_loser: { entrant_id: "e2", fixture_id: "f1" } }));
    expect(p.lines("entrants-departure-line")).toEqual([{ tone: "done", text: "Ben takes Cy's place in round 1, as the best loser." }]);
    await withdraw(p, () => ({ entrant_id: "e3", lucky_loser: null }));
    expect(p.lines("entrants-departure-line")).toEqual([]);
  });

  it("disqualify: the same line, read off the patch reply's cascade", async () => {
    const p = mount();
    api.patch = () => ({ ...entrant("e3", "Cy", "disqualified"), cascade: { entrant_id: "e3", lucky_loser: { entrant_id: "e1", fixture_id: "f1" } } });
    await p.row("e3").onDisqualify();
    await flush();
    expect(p.lines("entrants-departure-line")).toEqual([{ tone: "done", text: "Ana takes Cy's place in round 1, as the best loser." }]);
  });

  it("said where the add form is not: a locked roster (a fed knockout's division) still shows the line", async () => {
    const p = mount({ rosterLocked: true, knockoutLateEntry: false });
    expect(p.byTestId("entrants-late-entry-notice"), "premise: the add section is not drawn").toHaveLength(0);
    await withdraw(p, () => ({ entrant_id: "e3", lucky_loser: { entrant_id: "e2", fixture_id: "f1" } }));
    expect(p.lines("entrants-departure-line")).toEqual([{ tone: "done", text: "Ben takes Cy's place in round 1, as the best loser." }]);
  });

  it("in the organiser's language: French names the same two people", async () => {
    active.locale = "fr";
    const p = mount();
    await withdraw(p, () => ({ entrant_id: "e3", lucky_loser: { entrant_id: "e2", fixture_id: "f1" } }));
    expect(p.lines("entrants-departure-line")).toEqual([{ tone: "done", text: "Ben prend la place de Cy au 1er tour, en tant que meilleur perdant." }]);
  });
});
