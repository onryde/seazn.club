// Review 3 of #857, m2. The rain-delay shift answers `{ shifted, skipped }`
// and the panel threw it away: a shift that left a played match where it was
// said nothing about it, so the organiser read "everything moved". The panel
// now says both. Driven through the real island (the hook harness) against a
// mocked wire — the join between the response and the copy is the thing under
// test, so only a click can witness it.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ConstraintsPanel } from "../constraints-panel";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));

const shift = vi.hoisted(() => ({ answer: {} as unknown }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string) => Promise.resolve(url === "/api/v1/schedule/shift" ? shift.answer : {})),
  };
});

const EN = enUi as unknown as Record<string, string>;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const props = {
  divisionId: "d1",
  initialSettings: { division_id: "d1", config: { courts: ["Court 1"], matchMinutes: 30, gapMinutes: 0, constraints: {} } },
  canEdit: true,
  orgTz: "UTC",
  viewerPlan: "community" as const,
};

const byTestid = (tree: ReactElement[], id: string) => tree.filter((el) => propsOf(el)["data-testid"] === id);

async function shiftWith(answer: unknown) {
  shift.answer = answer;
  const island = renderIsland(ConstraintsPanel, props);
  await flush();
  const button = island
    .tree()
    .find((el) => el.type === "button" && textOf(el) === EN["constraints.bulkShift.button"]);
  expect(button, "the shift button").toBeDefined();
  (propsOf(button!).onClick as () => Promise<void>)();
  await flush();
  await flush();
  return island;
}

describe("ConstraintsPanel — a rain-delay shift says what it moved and what it left", () => {
  it("names the played matches it left in place, beside the count it moved", async () => {
    const island = await shiftWith({ shifted: 3, skipped: { decided: 2, locked: 1 }, seq: 9 });
    expect(byTestid(island.tree(), "bulk-shift-outcome").map(textOf)).toEqual(["Moved 3 matches."]);
    expect(byTestid(island.tree(), "bulk-shift-kept").map(textOf)).toEqual([
      EN["history.danger.keptPlayed.other"]!.replace("{count}", "2"),
    ]);
  });

  it("says nothing about kept matches when the shift left none", async () => {
    const island = await shiftWith({ shifted: 1, skipped: { decided: 0, locked: 0 }, seq: 9 });
    expect(byTestid(island.tree(), "bulk-shift-outcome").map(textOf)).toEqual([EN["constraints.bulkShift.done.one"]]);
    expect(byTestid(island.tree(), "bulk-shift-kept")).toEqual([]);
  });
});
