// RS011 review round 3, finding 1: `save()` (PUT
// /fixtures/{id}/lineups/{entrantId}) can 422 ELIGIBILITY_VIOLATION
// (`putLineup` -> `gateRosterEligibility`, server/usecases/fixtures.ts) — the
// Zod schema already accepts an optional `eligibility_override`
// (PutLineup, api-v1/schemas.ts), but `save()` never sent it and its catch
// just rendered the generic error banner with no way to override and retry.
// This is an INTERACTION test on purpose (`renderIsland`, not
// `renderToStaticMarkup`, the convention the rest of this file's tests use):
// the bug is in what save() does with a fetch REJECTION, which a static
// render can never exercise (repo standing trap: "pure-builder tests cannot
// see wiring"). `onClick` fires-and-forgets (`() => void save()`, same
// convention `entrants-panel.tsx`'s CSV path uses), so every wait below polls
// with `vi.waitFor` rather than awaiting the click handler's own return.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { LineupEditor } from "@/components/v2/lineup-editor";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";
import type { SideInfo } from "@/components/v2/fixture-console";

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async (url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, options });
      const body = options?.json as { eligibility_override?: { reason: string } } | undefined;
      if (!body?.eligibility_override) {
        throw new actual.ApiV1Error(
          "eligibility violation",
          422,
          "ELIGIBILITY_VIOLATION",
          {
            violations: [
              {
                code: "AGE_TOO_OLD",
                message: "Too old for this division.",
                playerIndex: 1,
                playerName: "Vet Player",
              },
            ],
            warnings: [],
          },
        );
      }
      return {};
    }),
  };
});

function member(i: number): SideInfo["members"][number] {
  return {
    person_id: `p${i}`,
    full_name: `Player ${i}`,
    squad_number: i,
    default_position_key: null,
    is_captain: false,
    roles: [],
  };
}

function findSaveButton(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find(
    (e) => e.type === "button" && propsOf(e).className === "btn btn-primary px-3 py-1.5 text-xs",
  );
  if (!el) throw new Error("save button not found");
  return el;
}

function findDialogElement(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find((e) => e.type === EligibilityOverrideDialog);
  if (!el) throw new Error("EligibilityOverrideDialog element not found in tree");
  return el;
}

function baseProps(onSaved: () => void) {
  const side: SideInfo = { id: "ent-h", name: "Home", members: [member(1)], lineup: [] };
  return {
    fixtureId: "f1",
    side,
    positionGroups: [],
    roles: [],
    lineupSize: 1,
    canEdit: true,
    onSaved,
  };
}

describe("LineupEditor — a 422 ELIGIBILITY_VIOLATION opens the override dialog and a confirmed retry resends the PUT with eligibility_override (RS011 review round 3, finding 1)", () => {
  it("Save -> 422 opens EligibilityOverrideDialog with the server's violations", async () => {
    api.calls.length = 0;
    const onSaved = vi.fn();
    const island = renderIsland(LineupEditor, baseProps(onSaved));

    expect(propsOf(findDialogElement(island.tree())).open).toBe(false);

    (propsOf(findSaveButton(island.tree())).onClick as () => void)();

    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(true);
    });
    const dialogProps = propsOf(findDialogElement(island.tree()));
    expect(dialogProps.violations).toEqual([
      expect.objectContaining({ code: "AGE_TOO_OLD", playerName: "Vet Player" }),
    ]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.options?.json).not.toHaveProperty("eligibility_override");
  });

  it("confirming the dialog retries the PUT with eligibility_override attached, and the retry succeeds", async () => {
    api.calls.length = 0;
    const onSaved = vi.fn();
    const island = renderIsland(LineupEditor, baseProps(onSaved));

    (propsOf(findSaveButton(island.tree())).onClick as () => void)();
    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(true);
    });

    (propsOf(findDialogElement(island.tree())).onConfirm as (reason: string) => void)(
      "confirmed by organiser",
    );

    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(false);
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(textOf(island.tree())).toContain("Lineup saved.");

    expect(api.calls).toHaveLength(2); // first (422) + retry (succeeds)
    const retryJson = api.calls[1]!.options!.json as {
      eligibility_override?: { reason: string };
    };
    expect(retryJson.eligibility_override).toEqual({ reason: "confirmed by organiser" });
  });

  it("cancelling the dialog leaves the lineup unsaved and does not retry", async () => {
    api.calls.length = 0;
    const onSaved = vi.fn();
    const island = renderIsland(LineupEditor, baseProps(onSaved));

    (propsOf(findSaveButton(island.tree())).onClick as () => void)();
    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(true);
    });
    (propsOf(findDialogElement(island.tree())).onCancel as () => void)();

    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(false);
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.calls).toHaveLength(1); // no retry fired
  });
});
