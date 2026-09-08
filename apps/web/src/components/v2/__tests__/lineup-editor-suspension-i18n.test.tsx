// B05 — the discipline gate's refusal reached the organiser as raw English.
//
// `gateLineupSuspensions` (server/usecases/discipline.ts) throws
// `HttpError(422, suspendedPlayersMessage(names), "SUSPENDED_PLAYER",
// { suspended: [{ person_id, full_name }] })`, and `save()`'s catch
// (lineup-editor.tsx) branched only on ELIGIBILITY_VIOLATION — every other
// coded 422 fell through to `setError(err.message)`, i.e. the English sentence
// `suspendedPlayersMessage` built. That function's own doc comment flags the
// English as a known gap ("the family moves together or not at all"): the fix
// is not to localize the server, it is to render off the CODE plus the
// structured `suspended` list the error already carries, which is exactly what
// the eligibility violations beside it now do.
//
// INTERACTION test (`renderIsland`), not a static render: the bug is in what
// `save()` does with a fetch REJECTION, which no static render reaches — the
// same reason `lineup-editor-eligibility-gate.test.tsx` beside this file is one.
// `renderIsland` has no `DictProvider`, so `useMsg` falls back to the shipped
// ENGLISH catalog. That is still a real discrimination here: the dictionary
// sentence is deliberately worded differently from `suspendedPlayersMessage`'s,
// so an inert seam (the server sentence still winning) is visible even in en.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { LineupEditor } from "@/components/v2/lineup-editor";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";
import type { SideInfo } from "@/components/v2/fixture-console";
import { suspendedPlayersMessage } from "@/lib/registration-rules";
import en from "@/dictionaries/en/ui.json";

const enText = en as unknown as Record<string, string>;
const KEY = "divset.entrants.eligibilityGate.issue.suspendedPlayer";

/** What the dictionary says once the real names are interpolated — derived,
 *  never typed in, so a copy change moves this test with it. */
function expectedBanner(names: string[]): string {
  return enText[KEY].replace("{names}", names.join(", "));
}

const scenario = vi.hoisted(() => ({
  suspended: undefined as { person_id: string; full_name: string }[] | undefined,
  names: [] as string[],
  calls: 0,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async () => {
      scenario.calls += 1;
      const { suspendedPlayersMessage: serverSentence } =
        await import("@/lib/registration-rules");
      throw new actual.ApiV1Error(
        serverSentence(scenario.names),
        422,
        "SUSPENDED_PLAYER",
        scenario.suspended === undefined ? {} : { suspended: scenario.suspended },
      );
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

function baseProps() {
  const side: SideInfo = { id: "ent-h", name: "Home", members: [member(1)], lineup: [] };
  return {
    fixtureId: "f1",
    side,
    positionGroups: [],
    roles: [],
    lineupSize: 1,
    canEdit: true,
    onSaved: () => {},
  };
}

function findSaveButton(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find(
    (e) => e.type === "button" && propsOf(e).className === "btn btn-primary px-3 py-1.5 text-xs",
  );
  if (!el) throw new Error("save button not found");
  return el;
}

async function saveAndReadBanner(
  names: string[],
  suspended: { person_id: string; full_name: string }[] | undefined,
) {
  scenario.names = names;
  scenario.suspended = suspended;
  scenario.calls = 0;
  const island = renderIsland(LineupEditor, baseProps());
  (propsOf(findSaveButton(island.tree())).onClick as () => void)();
  await vi.waitFor(() => {
    expect(scenario.calls).toBe(1);
    expect(textOf(island.tree())).not.toBe("");
  });
  // The banner text only appears after the rejection has been handled.
  await vi.waitFor(() => {
    expect(textOf(island.tree())).toMatch(/suspension/i);
  });
  return island;
}

describe("LineupEditor — a 422 SUSPENDED_PLAYER is said in the organiser's own language, off the code", () => {
  it("renders the dictionary sentence with the banned player's name, not the server's English one", async () => {
    const island = await saveAndReadBanner(
      ["Alex Doe"],
      [{ person_id: "p1", full_name: "Alex Doe" }],
    );
    const text = textOf(island.tree());
    expect(text).toContain(expectedBanner(["Alex Doe"]));
    expect(text).not.toContain(suspendedPlayersMessage(["Alex Doe"]));
  });

  it("names EVERY banned player — two rosters with different bans read differently", async () => {
    // A key that interpolates nothing passes a test that only checks for
    // non-English text (AGENTS.md rule 19). Pin the names, and pin that the
    // two renders differ, so a constant cannot satisfy both.
    const one = textOf(
      (
        await saveAndReadBanner(["Alex Doe"], [{ person_id: "p1", full_name: "Alex Doe" }])
      ).tree(),
    );
    const two = textOf(
      (
        await saveAndReadBanner(
          ["Alex Doe", "Sam Roe"],
          [
            { person_id: "p1", full_name: "Alex Doe" },
            { person_id: "p2", full_name: "Sam Roe" },
          ],
        )
      ).tree(),
    );
    expect(one).toContain(expectedBanner(["Alex Doe"]));
    expect(one).not.toContain("Sam Roe");
    expect(two).toContain(expectedBanner(["Alex Doe", "Sam Roe"]));
    expect(one).not.toEqual(two);
  });

  it("falls back to the server's English sentence when the error carries no names — never a bare placeholder", async () => {
    const island = await saveAndReadBanner(["Alex Doe"], undefined);
    const text = textOf(island.tree());
    expect(text).not.toContain("{names}");
    expect(text).toContain(suspendedPlayersMessage(["Alex Doe"]));
  });

  it("does NOT open the override dialog — a ban is refused at the banner, not offered as an override here", async () => {
    const island = await saveAndReadBanner(
      ["Alex Doe"],
      [{ person_id: "p1", full_name: "Alex Doe" }],
    );
    const dialog = island.tree().find((e) => e.type === EligibilityOverrideDialog);
    expect(dialog).toBeDefined();
    expect(propsOf(dialog!).open).toBe(false);
  });
});
