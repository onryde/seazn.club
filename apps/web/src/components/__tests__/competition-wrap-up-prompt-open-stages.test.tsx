// W4 T21 review I1 (ruling 273, AN-1): the competition page's wrap-up prompt is the SECOND door to "completed" — its
// "Mark completed" PATCHes the status in one tap, and it exists for organisers who never open settings, which is the
// AN-1 population. It now lists the open stages exactly as the settings warning does (the same `OpenStagesWarning`,
// no new copy), and it still never refuses: "Mark completed" stays enabled and sends the PATCH.
//
// vitest runs `environment: "node"` with no jsdom: the island is driven through the shared hook harness, and the nested
// warning is asked WHETHER it mounts and with what (the harness does not expand children).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { CompetitionWrapUpPrompt } from "@/components/competition-wrap-up-prompt";
import { OpenStagesWarning } from "@/components/v2/open-stages-warning";
import { apiV1 } from "@/lib/client-v1";
import type { OpenStageRow } from "@/lib/open-stages";
import uiEn from "@/dictionaries/en/ui.json";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => "/",
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});
const api = vi.mocked(apiV1);

const ROWS: OpenStageRow[] = [
  { stageId: "s-ko", divisionName: "Men's Singles A", seq: 1, stageName: "Knockout", state: "final_decided", matchesLeft: 0 },
  { stageId: "s-mx", divisionName: "Mixed Doubles", seq: 1, stageName: "League", state: "matches_left", matchesLeft: 3 },
];

const mount = (o: { openStages?: OpenStageRow[]; canCompleteStages?: boolean } = {}) =>
  renderIsland(CompetitionWrapUpPrompt, {
    competitionId: "c1",
    endedOnLabel: "31 Aug 2026",
    settingsHref: "/o/org/c/comp/settings",
    openStages: o.openStages ?? ROWS,
    canCompleteStages: o.canCompleteStages ?? true,
  });
const warningOf = (tree: ReactElement[]) => tree.find((el) => el.type === OpenStagesWarning);
const markCompleted = (tree: ReactElement[]) =>
  tree.find((el) => el.type === "button" && JSON.stringify(propsOf(el).children ?? "").includes(uiEn["comp.wrapUp.complete"]))!;

beforeEach(() => {
  api.mockReset();
  refresh.mockReset();
});

describe("CompetitionWrapUpPrompt — the second completion door warns too (W4 T21 I1)", () => {
  it("empty case first: no open stages, no warning — and Mark completed is not described by one", () => {
    const tree = mount({ openStages: [] }).tree();
    expect(warningOf(tree)).toBeUndefined();
    expect(propsOf(markCompleted(tree))["aria-describedby"]).toBeUndefined();
  });

  it("lists the page's open stages with the settings warning itself, offering Complete stage where it may act", () => {
    const tree = mount().tree();
    const w = warningOf(tree);
    expect(w, "the warning mounts").toBeDefined();
    expect(propsOf(w!).stages).toBe(ROWS);
    expect(propsOf(w!).canComplete).toBe(true);
    expect(propsOf(markCompleted(tree))["aria-describedby"], "Mark completed is described by the warning").toBe(propsOf(w!).id);
    // A frozen competition still says what is open, but offers no write.
    expect(propsOf(warningOf(mount({ canCompleteStages: false }).tree())!).canComplete).toBe(false);
  });

  it("never refuses: with the warning on screen, Mark completed is enabled and PATCHes status 'completed'", async () => {
    api.mockResolvedValue({});
    const island = mount();
    const button = markCompleted(island.tree());
    expect(propsOf(button).disabled).toBe(false);
    (propsOf(button).onClick as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api).toHaveBeenCalledWith("/api/v1/competitions/c1", { method: "PATCH", json: { status: "completed" } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
