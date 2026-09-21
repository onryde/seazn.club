// RS011 review fix 5: the bulk CSV import path (`CsvImport`'s `onImport`)
// used to call plain `run(...)`, not the `runGated(...)` wrapper its 3
// sibling roster-write call sites in this file use (`AddEntrantForm`'s
// onSubmit, a row's onPatch, sync-from-squad). The server gate still fired,
// but a violation surfaced only as a generic red error banner with no path
// to override except falling back to one-at-a-time adds. This proves the
// SAME 422 `ELIGIBILITY_VIOLATION` that opens `EligibilityOverrideDialog`
// for the other 3 paths now opens it for the bulk CSV path too.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { EntrantsPanel, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";
import { ApiV1Error } from "@/lib/client-v1";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async (url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, options });
      if (url.startsWith("/api/v1/persons?")) return { items: [], nextCursor: null };
      if (url === "/api/v1/clubs") return [];
      if (url === "/api/v1/teams") return [];
      if (url.includes("/roster")) return [];
      if (url === "/api/v1/persons" && options?.method === "POST") {
        const body = options.json as { full_name: string };
        return { id: `p-${api.calls.length}`, full_name: body.full_name };
      }
      if (url.endsWith("/entrants") && options?.method === "POST") {
        // Round-2 review regression: only reject when NO override is
        // present, so a test can drive the confirm-retry to completion and
        // observe what the retried closure actually does (rather than only
        // ever seeing the dialog open, which the original fix-5 test did).
        const body = options.json as Array<{ eligibility_override?: unknown }>;
        if (body.some((e) => e.eligibility_override)) return {};
        throw new actual.ApiV1Error(
          "eligibility violation",
          422,
          "ELIGIBILITY_VIOLATION",
          {
            violations: [
              { code: "AGE_TOO_OLD", message: "Too old for this division.", playerIndex: 1, playerName: "Vet Player" },
            ],
            warnings: [],
          },
        );
      }
      return {};
    }),
  };
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

function panelProps() {
  return {
    divisionId: "div-1",
    entrants: [],
    canEdit: true,
    positionGroups: [],
    roles: [],
    eligibility: NO_ELIGIBILITY,
    entrantModel: MODEL,
    viewerPlan: "community" as const,
    divisionStatus: "setup",
  };
}

function findDialogElement(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find((e) => e.type === EligibilityOverrideDialog);
  if (!el) throw new Error("EligibilityOverrideDialog element not found in tree");
  return el;
}

// `CsvImport` is passed to `AddEntrantForm` as its `importControls` PROP, not
// as `children` — `walk()` (the hook harness's flattener) only recurses into
// `.children`, so `<CsvImport/>` never shows up as its own entry in the
// walked tree. Reach it via the ONE element carrying an `importControls`
// prop (`AddEntrantForm`, also unexpanded — the harness renders `EntrantsPanel`
// only, one level deep) instead.
function findCsvOnImport(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const formEl = tree.find((e) => propsOf(e).importControls !== undefined);
  if (!formEl) throw new Error("AddEntrantForm element (importControls prop) not found in tree");
  const csvEl = propsOf(formEl).importControls as ReactElement;
  return propsOf(csvEl).onImport as (rows: { name: string }[]) => Promise<unknown>;
}

describe("EntrantsPanel — bulk CSV import routes an ELIGIBILITY_VIOLATION through the override dialog (RS011 review fix 5)", () => {
  it("a 422 from the bulk create opens EligibilityOverrideDialog, not just the generic error banner", async () => {
    api.calls.length = 0;
    const island = renderIsland(EntrantsPanel, panelProps());

    expect(propsOf(findDialogElement(island.tree())).open).toBe(false);

    const onImport = findCsvOnImport(island.tree());
    // Fire and don't await to completion — runGated's promise stays pending
    // until the dialog is answered, exactly the behaviour under test.
    void onImport([{ name: "Vet Player" }]);

    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(true);
    });
    const dialogProps = propsOf(findDialogElement(island.tree()));
    expect(dialogProps.violations).toEqual([
      expect.objectContaining({ code: "AGE_TOO_OLD", playerName: "Vet Player" }),
    ]);

    // Clean up: cancel the pending gate so the fired-and-forgotten promise
    // above settles instead of leaking into the next test.
    (dialogProps.onCancel as () => void)();
    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(false);
    });
  });

  // Round-2 review regression: `runGated` re-invokes the SAME closure on a
  // confirmed retry. Person resolution (POST /api/v1/persons) must happen
  // exactly once, before the gate, never inside the retried closure — the
  // original fix-5 shape ran it again on retry against a stale `persons`
  // snapshot, silently minting a second, orphaned person per CSV row on
  // every override confirm.
  it("confirming the override does NOT re-create the person a second time", async () => {
    api.calls.length = 0;
    const island = renderIsland(EntrantsPanel, panelProps());

    const onImport = findCsvOnImport(island.tree());
    void onImport([{ name: "Vet Player" }]);

    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(true);
    });
    const personPostsBeforeConfirm = api.calls.filter(
      (c) => c.url === "/api/v1/persons" && c.options?.method === "POST",
    ).length;
    expect(personPostsBeforeConfirm).toBe(1);

    const dialogProps = propsOf(findDialogElement(island.tree()));
    (dialogProps.onConfirm as (reason: string) => void)("confirmed by organiser");

    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(false);
    });

    const personPostsAfterConfirm = api.calls.filter(
      (c) => c.url === "/api/v1/persons" && c.options?.method === "POST",
    ).length;
    expect(personPostsAfterConfirm).toBe(1);

    // And the retried entrants POST actually carried the override, proving
    // the confirm path ran a real second network call, not a no-op.
    const entrantsCalls = api.calls.filter((c) => c.url.endsWith("/entrants") && c.options?.method === "POST");
    expect(entrantsCalls).toHaveLength(2); // first (422) + retry (succeeds)
    const retryBody = entrantsCalls[1]!.options!.json as Array<{ eligibility_override?: { reason: string } }>;
    expect(retryBody[0]!.eligibility_override).toEqual({ reason: "confirmed by organiser" });
  });
});
