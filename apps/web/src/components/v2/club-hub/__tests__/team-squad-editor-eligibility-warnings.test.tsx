// RS011 review fix 1: `setTeamSquad` (server/usecases/teams.ts) computes
// `eligibility_warnings` on every save — one entry per enrolled division
// whose roster now fails an eligibility rule — but `TeamSquadEditor` was the
// ONLY UI caller of `PUT /teams/{id}/squad`, and it typed the response
// `{members}` only, so a real CATEGORY_MISMATCH/age-band violation was
// computed by the server and silently thrown away by the client. This is an
// INTERACTION test on purpose (`renderIsland`, not `renderToStaticMarkup`):
// the bug was never in what the component renders from its INITIAL props —
// it was in what it does with a fetch RESPONSE, which a static render can't
// exercise at all (repo standing trap: "the inert seam" / "pure-builder
// tests cannot see wiring").
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { TeamSquadEditor, type SquadMember } from "../team-squad-editor";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const testMsg = (key: string, vars?: Record<string, string | number>) => t(uiEn, key, vars);

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
  /** The PUT response this test wants back — set per-test before the save. */
  putResponse: null as unknown,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async (url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, options });
      return api.putResponse;
    }),
  };
});

function member(id: string, name: string): SquadMember {
  return {
    person_id: id,
    full_name: name,
    squad_number: null,
    default_position_key: null,
    is_captain: false,
    roles: [],
  };
}

function editorProps() {
  return {
    teamId: "team-1",
    initial: [member("p1", "Alice")],
    persons: [{ id: "p1", full_name: "Alice" }],
    canEdit: true,
    onSaved: () => {},
    onError: () => {},
    onPaywall: () => {},
  };
}

function findSaveButton(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find(
    (e) => e.type === "button" && propsOf(e).className === "btn btn-primary px-3 py-1",
  );
  if (!el) throw new Error("save button not found");
  return el;
}

describe("TeamSquadEditor — eligibility_warnings from PUT /teams/{id}/squad reach the UI (RS011 review fix 1)", () => {
  it("a save whose response carries a real CATEGORY_MISMATCH warning renders it, not just the member list", async () => {
    api.calls.length = 0;
    api.putResponse = {
      members: [member("p1", "Alice")],
      eligibility_warnings: [
        {
          division_id: "div-1",
          issues: [
            {
              code: "CATEGORY_MISMATCH",
              message: "This division is not open to your gender category.",
              playerIndex: 1,
              playerName: "Alice",
            },
          ],
        },
      ],
    };

    const island = renderIsland(TeamSquadEditor, editorProps());
    expect(textOf(island.tree())).not.toContain("This division is not open to your gender category.");

    await (propsOf(findSaveButton(island.tree())).onClick as () => Promise<void>)();

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.options?.method).toBe("PUT");
    const text = textOf(island.tree());
    expect(text).toContain(testMsg("clubs.squad.eligibilityWarning.label"));
    expect(text).toContain("Alice: This division is not open to your gender category.");
  });

  it("a save whose response carries NO warnings renders no eligibility banner at all", async () => {
    api.calls.length = 0;
    api.putResponse = { members: [member("p1", "Alice")], eligibility_warnings: [] };

    const island = renderIsland(TeamSquadEditor, editorProps());
    await (propsOf(findSaveButton(island.tree())).onClick as () => Promise<void>)();

    expect(textOf(island.tree())).not.toContain(testMsg("clubs.squad.eligibilityWarning.label"));
  });
});
