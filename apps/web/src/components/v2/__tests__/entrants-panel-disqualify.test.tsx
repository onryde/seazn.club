// Ruling 258 (owner "yes add both", 2026-11-02): T15 shipped "a disqualification cascades like a withdrawal" server-side
// only (`PATCH /entrants/{id}` `{status: "disqualified"}` -> `patchEntrant` -> `withdrawEntrantCascade`), and nothing in
// the UI sent it - the owner picked "disqualified" in a match's forfeit dialog and the player was paired again in round 2.
// The Entrants row now carries Disqualify beside Withdraw. This is the inert-seam proof (AGENTS.md class 1): the real row
// button's real `onClick`, through the panel's real handler, to the wire - the confirm that guards it, and the PATCH it
// sends. Ruling 259: no reason or notes field, so the body is the status and nothing else.
//
// Driven with `_hook-harness.tsx`'s `renderIsland` in two levels (the panel, then the row element it renders), the way
// `fixture-console-forfeit-hooks.test.tsx` drives the dialog its console opens. The static markup half (labels in four
// locales, which rows carry the control) is `entrants-panel-row-i18n.test.tsx`.
// single-sport: none - the Entrants panel reads no sport; what varies is the entrant's kind and status, swept below.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { EntrantsPanel, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const confirmMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<boolean>>(async () => false));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

type Call = { url: string; options?: { method?: string; json?: unknown } };
const wire = vi.hoisted(() => ({ calls: [] as unknown[], reject: null as null | Error }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn(async (url: string, options?: { method?: string; json?: unknown }) => {
      wire.calls.push({ url, options });
      if (wire.reject && options?.method !== undefined) throw wire.reject;
      return { items: [], nextCursor: null };
    }),
  };
});
const calls = () => wire.calls as Call[];
/** The writes the panel sent: everything but the GET reads its own effects make. */
const writes = () => calls().filter((c) => c.options?.method !== undefined && c.options.method !== "GET");

const NO_ELIGIBILITY: EntrantsPanelEligibility = { category: null, age_min: null, age_max: null, eligibility_note: null };
const MODEL: EffectiveEntrantModel = {
  kinds: ["individual", "pair", "team"],
  defaultKind: "individual",
  squadNumbers: true,
  captain: true,
  maxTeamMembers: null,
};
const entrant = (id: string, display_name: string, over: Record<string, unknown> = {}) => ({
  id,
  division_id: "div-1",
  kind: "individual",
  team_id: null,
  display_name,
  seed: null,
  status: "registered",
  badge_url: null,
  members: [],
  ...over,
});

const byTestid = (tree: ReactElement[], testid: string) => tree.filter((e) => propsOf(e)["data-testid"] === testid);

/** The panel, and the row it draws for `id`, rendered as its own island so its buttons are in the tree. */
function mount(entrants: ReturnType<typeof entrant>[], over: Record<string, unknown> = {}) {
  const panel = renderIsland(EntrantsPanel, {
    divisionId: "div-1",
    entrants,
    canEdit: true,
    positionGroups: [],
    roles: [],
    eligibility: NO_ELIGIBILITY,
    entrantModel: MODEL,
    viewerPlan: "community" as const,
    divisionStatus: "active",
    ...over,
  } as never);
  const rowOf = (id: string) => {
    const el = panel.tree().find((e) => typeof e.type === "function" && (propsOf(e).entrant as { id?: string } | undefined)?.id === id && propsOf(e).onDisqualify !== undefined);
    if (el === undefined) throw new Error(`no entrants row element for ${id}`);
    return renderIsland(el.type as never, propsOf(el) as never);
  };
  return { panel, rowOf };
}

beforeEach(() => {
  wire.calls.length = 0;
  wire.reject = null;
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => false);
});

// Ruling 260 (orchestrator, applying ruling 259: a disqualification is the same cascade as a withdrawal): the confirm is as
// truthful as Withdraw's. The LEAD is the ruling's sentence, typed here; the rest is Withdraw's own body, read from ITS key -
// never retyped into this test, so a change to Withdraw's policy copy moves both confirms (one authority per fact).
const SIGNED_LEAD = "They are marked disqualified rather than withdrawn; the effect on their matches is the same as a withdrawal:";
const WITHDRAW_BODY = (en as Record<string, string>)["confirm.withdrawEntrant.body"]!;
const DQ_BODY = `${SIGNED_LEAD} ${WITHDRAW_BODY}`;

describe("Entrants row: Disqualify sends the disqualification (ruling 258)", () => {
  it("the button asks first, in the signed words, with the destructive tone - and a cancelled confirm sends nothing", async () => {
    const { rowOf } = mount([entrant("e1", "Rohan Nair")]);
    const btn = byTestid(rowOf("e1").tree(), "entrant-row-disqualify");
    expect(btn, 'exactly one data-testid="entrant-row-disqualify"').toHaveLength(1);
    expect(btn[0]!.type).toBe("button");
    expect(textOf(btn[0]!)).toBe("Disqualify");

    await (propsOf(btn[0]!).onClick as () => Promise<void>)();
    expect(confirmMock, "one confirm").toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]![0]).toEqual({
      title: "Disqualify Rohan Nair?",
      body: DQ_BODY,
      confirmLabel: "Disqualify",
      tone: "danger",
    });
    // The inaccurate sentences the first draft carried ("Results already played stand" is false in a league under half played).
    expect((confirmMock.mock.calls[0]![0] as { body: string }).body).not.toContain("Results already played stand");
    expect(writes(), "the organiser said no: nothing is written").toEqual([]);
  });

  it("a confirmed Disqualify is exactly one PATCH /entrants/{id} {status: disqualified} - no reason, no notes (ruling 259) - and never the withdraw route", async () => {
    confirmMock.mockImplementation(async () => true);
    const { rowOf } = mount([entrant("e1", "Rohan Nair"), entrant("e2", "Asha Rao")]);
    // The SECOND entrant: the id on the wire is the row's own, not the first row's.
    const btn = byTestid(rowOf("e2").tree(), "entrant-row-disqualify")[0]!;
    await (propsOf(btn).onClick as () => Promise<void>)();
    expect(writes()).toEqual([{ url: "/api/v1/entrants/e2", options: { method: "PATCH", json: { status: "disqualified" } } }]);
    expect(Object.keys((writes()[0]!.options!.json as object)), "no reason or notes key rides with it").toEqual(["status"]);
    expect(confirmMock.mock.calls[0]![0], "the dialog names the SECOND entrant").toMatchObject({ title: "Disqualify Asha Rao?" });
  });

  it("the Withdraw beside it is unchanged: it still POSTs the withdraw route, so the two buttons cannot be swapped", async () => {
    confirmMock.mockImplementation(async () => true);
    const { rowOf } = mount([entrant("e1", "Rohan Nair")]);
    const row = rowOf("e1").tree();
    await (propsOf(byTestid(row, "entrant-row-withdraw")[0]!).onClick as () => Promise<void>)();
    expect(writes()).toEqual([{ url: "/api/v1/entrants/e1/withdraw", options: { method: "POST", json: {} } }]);
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({ title: "Withdraw Rohan Nair?" });
    // The two confirms say the same thing about the matches: Disqualify's body CONTAINS the body Withdraw sent (one key).
    const withdrawBody = (confirmMock.mock.calls[0]![0] as { body: string }).body;
    expect(withdrawBody, "premise: Withdraw sent its own long body").toBe(WITHDRAW_BODY);
    expect(WITHDRAW_BODY.length, "premise: the policy paragraph is long, not a stub").toBeGreaterThan(200);
    confirmMock.mockClear();
    await (propsOf(byTestid(rowOf("e1").tree(), "entrant-row-disqualify")[0]!).onClick as () => Promise<void>)();
    expect((confirmMock.mock.calls[0]![0] as { body: string }).body, "the DQ confirm contains Withdraw's body, taken from the same key").toContain(withdrawBody);
  });

  it("a refused PATCH shows its message on the panel (and the row stays offered)", async () => {
    confirmMock.mockImplementation(async () => true);
    wire.reject = new Error("entrant not found");
    const { panel, rowOf } = mount([entrant("e1", "Rohan Nair")]);
    await (propsOf(byTestid(rowOf("e1").tree(), "entrant-row-disqualify")[0]!).onClick as () => Promise<void>)();
    const banner = byTestid(panel.tree(), "entrants-error");
    expect(banner, "the refusal is said").toHaveLength(1);
    expect(textOf(banner[0]!)).toContain("entrant not found");
  });

  it("every kind in the field, setup and started alike: the button is there and sends the same PATCH (owner rule: all formats, all kinds)", async () => {
    confirmMock.mockImplementation(async () => true);
    let checked = 0;
    for (const divisionStatus of ["setup", "active"]) {
      for (const kind of ["individual", "pair", "team"]) {
        for (const status of ["registered", "confirmed"]) {
          wire.calls.length = 0;
          const id = `${kind}-${status}`;
          const { rowOf } = mount([entrant(id, `Name ${id}`, { kind, status })], { divisionStatus });
          const btn = byTestid(rowOf(id).tree(), "entrant-row-disqualify");
          expect(btn, `${divisionStatus} ${kind} ${status}`).toHaveLength(1);
          await (propsOf(btn[0]!).onClick as () => Promise<void>)();
          expect(writes(), `${divisionStatus} ${kind} ${status}`).toEqual([
            { url: `/api/v1/entrants/${id}`, options: { method: "PATCH", json: { status: "disqualified" } } },
          ]);
          checked++;
        }
      }
    }
    expect(checked, `rows checked: ${checked}`).toBe(12);
  });

  it("a departed entrant (withdrawn, disqualified) is offered Reinstate, not Disqualify; a viewer who cannot edit is offered nothing", () => {
    let checked = 0;
    for (const status of ["withdrawn", "disqualified"]) {
      const row = mount([entrant("e1", "Rohan Nair", { status })]).rowOf("e1").tree();
      expect(byTestid(row, "entrant-row-disqualify"), `${status}: nothing left to disqualify`).toHaveLength(0);
      expect(byTestid(row, "entrant-row-reinstate"), `${status}: the way back is offered`).toHaveLength(1);
      checked++;
    }
    const spectator = mount([entrant("e1", "Rohan Nair")], { canEdit: false }).rowOf("e1").tree();
    expect(byTestid(spectator, "entrant-row-disqualify"), "a viewer").toHaveLength(0);
    expect(byTestid(spectator, "entrant-row-withdraw"), "a viewer (the positive pair of the row rendering)").toHaveLength(0);
    expect(spectator.some((e) => textOf(e).includes("Rohan Nair")), "premise: the row rendered").toBe(true);
    expect(checked).toBe(2);
  });
});
