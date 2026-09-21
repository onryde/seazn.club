// F4, found by driving the product (2026-09-20): on a STARTED tournament the
// entrants tab rendered the complete Add-entrant form — Kind, Name, Seed,
// player search, an enabled "Add entrant" button and Import CSV — seconds
// after the Start dialog had promised the organiser "Entrant list closes …
// no one new can be added". Filling it in and pressing Add produced a 422
// (`This tournament has started — the entrant list is locked`) and nothing
// else. The product invited the organiser into a failure it already knew about.
//
// The form's ABSENCE is the assertion, so every row here states its positive
// pair first: a test that only checked "no form when locked" would pass on a
// panel that rendered nothing at all, and hiding the form on a `setup`
// division would be the worse of the two defects.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { EntrantsPanel, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: vi.fn(async () => ({ items: [], nextCursor: null })) };
});

const NO_ELIGIBILITY: EntrantsPanelEligibility = {
  category: null,
  age_min: null,
  age_max: null,
  eligibility_note: null,
};

const MODEL: EffectiveEntrantModel = {
  kinds: ["individual", "pair", "team"],
  defaultKind: "individual",
  squadNumbers: true,
  captain: true,
  maxTeamMembers: null,
};

function panel(over: Record<string, unknown>) {
  const island = renderIsland(EntrantsPanel, {
    divisionId: "div-1",
    entrants: [],
    canEdit: true,
    positionGroups: [],
    roles: [],
    eligibility: NO_ELIGIBILITY,
    entrantModel: MODEL,
    viewerPlan: "community" as const,
    ...over,
  });
  const tree = island.tree();
  return {
    // `AddEntrantForm` is the one element carrying an `importControls` prop —
    // the same handle `entrants-panel-csv-import-gate.test.tsx` uses, because
    // the harness renders one level deep and the form is not expanded.
    addForm: tree.find((el) => propsOf(el).importControls !== undefined),
    note: walk(tree).find((el) => propsOf(el)["data-testid"] === "entrants-roster-locked"),
    text: textOf(tree),
  };
}

describe("EntrantsPanel — the Add-entrant form when the entrant list is closed", () => {
  it("renders the form, and no locked note, while the list is still open", () => {
    const open = panel({ rosterLocked: false });
    expect(open.addForm, "the Add-entrant form is missing on an OPEN division").toBeDefined();
    expect(open.note).toBeUndefined();
  });

  it("defaults to open — omitting the prop must not hide an organiser's form", () => {
    // The prop is optional on purpose (one page passes it today). A default of
    // `true` would silently remove the control from every other call site.
    expect(panel({}).addForm).toBeDefined();
    expect(panel({}).note).toBeUndefined();
  });

  it("replaces the form with the locked note once the list is closed", () => {
    const locked = panel({ rosterLocked: true });
    expect(locked.addForm, "the dead Add-entrant form is still rendered on a locked list").toBeUndefined();
    expect(locked.note, "nothing explains why the form is gone").toBeDefined();
    // The sentence a customer reads, not the key: `useMsg` outside a provider
    // falls back to the shipped English catalog, which is the production path.
    expect(locked.text).toContain(en["entrants.locked.note"]);
  });

  it("renders nothing for a viewer who cannot edit — neither the form nor the note", () => {
    // `canEdit` gates both branches. Without this row the locked note would be
    // a new thing shown to spectators, who never had a form to lose.
    const spectator = panel({ rosterLocked: true, canEdit: false });
    expect(spectator.addForm).toBeUndefined();
    expect(spectator.note).toBeUndefined();
    expect(spectator.text).not.toContain(en["entrants.locked.note"]);
  });

  it("ships the note in all four locales, each one distinct", () => {
    const values = [en, es, fr, nl].map((d) => (d as Record<string, string>)["entrants.locked.note"]);
    for (const v of values) expect(v, "a locale is missing entrants.locked.note").toBeTruthy();
    expect(new Set(values).size, "two locales share a string — one was left in English").toBe(4);
  });
});
