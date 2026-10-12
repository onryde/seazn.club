// T16 (T19 carry) — the panel's Unpair and Rebuild CALL the game-exists
// classifier: a refused write over a board an online game stands behind paints
// OnlineGameExistsNotice linking to the arbiter panel, not the generic
// "unpair failed" line or the server's English. Drives the real island (the
// hook harness): the rail's Unpair, and the roster-drift banner's Rebuild.
// The refusal's real producer is online-game-exists-route.test.tsx's.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { StageRail } from "@/components/v2/desk/stage-rail";
import { OnlineGameExistsNotice } from "@/components/v2/online-game-exists-notice";
import { ApiV1Error } from "@/lib/client-v1";
import { ONLINE_GAME_EXISTS_CODE } from "@/lib/open-round";

const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const ARBITER = "/o/org/c/comp/d/div/arbiter";
const props = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
  entrantNames: { e1: "E1", e2: "E2" },
  activeEntrantIds: ["e1", "e2"],
  entrantSeeds: { e1: 1, e2: 2 },
  canEdit: true,
  stages: [{ id: "s1", seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null, status: "active" }],
  fixtures: [],
  rosterDrift: { s1: { ghosts: [{ id: "e9", display_name: "Gone Gus" }], unplaced: [] } },
  arbiterHref: ARBITER,
};

const notices = (tree: ReactElement[]) => tree.filter((el) => el.type === OnlineGameExistsNotice);
const redLines = (tree: ReactElement[]) =>
  tree.filter((el) => el.type === "p" && String(propsOf(el).className ?? "").includes("bg-red-50"));
const refuseWith = (code: string, suffix: string) => {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation((path: string) =>
    String(path).endsWith(suffix) ? Promise.reject(new ApiV1Error("server English", 409, code)) : Promise.resolve({}),
  );
};

async function pressUnpair() {
  const island = renderIsland(StagesPanel, props);
  await flush();
  const rails = island.tree().filter((el) => el.type === StageRail);
  expect(rails, "premise: the stage rail is rendered").toHaveLength(1);
  await (propsOf(rails[0]!).onAct as (id: string, a: string) => Promise<boolean>)("s1", "unpair");
  await flush();
  return island;
}

async function pressRebuild() {
  const island = renderIsland(StagesPanel, props);
  await flush();
  const btn = island.tree().filter((el) => propsOf(el)["data-testid"] === "roster-drift-rebuild");
  expect(btn, "premise: the rebuild button is rendered").toHaveLength(1);
  (propsOf(btn[0]!).onClick as () => void)();
  await flush();
  await flush();
  return island;
}

describe("StagesPanel — a write refused over an online game", () => {
  it("Unpair: the notice, linking to the arbiter panel — and no generic red line", async () => {
    refuseWith(ONLINE_GAME_EXISTS_CODE, "/unpair");
    const island = await pressUnpair();
    expect(apiV1Mock.mock.calls.some(([p]) => String(p).endsWith("/stages/s1/unpair"))).toBe(true);
    const found = notices(island.tree());
    expect(found).toHaveLength(1);
    expect(propsOf(found[0]!).arbiterHref).toBe(ARBITER);
    expect(redLines(island.tree())).toHaveLength(0);
  });

  it("positive pair: another Unpair refusal is the generic line, never the notice", async () => {
    refuseWith("STAGE_NOT_READY", "/unpair");
    const island = await pressUnpair();
    expect(notices(island.tree())).toHaveLength(0);
    expect(redLines(island.tree())).toHaveLength(1);
  });

  it("Rebuild: the notice, never the server's English", async () => {
    refuseWith(ONLINE_GAME_EXISTS_CODE, "/rebuild");
    const island = await pressRebuild();
    expect(apiV1Mock.mock.calls.some(([p]) => String(p).endsWith("/stages/s1/rebuild"))).toBe(true);
    expect(notices(island.tree())).toHaveLength(1);
    expect(redLines(island.tree())).toHaveLength(0);
  });

  it("the next action clears it: a second, successful Unpair leaves no notice", async () => {
    refuseWith(ONLINE_GAME_EXISTS_CODE, "/unpair");
    const island = await pressUnpair();
    expect(notices(island.tree())).toHaveLength(1);
    apiV1Mock.mockImplementation(() => Promise.resolve({ cleared: 2, round: 1 }));
    const rail = island.tree().filter((el) => el.type === StageRail)[0]!;
    await (propsOf(rail).onAct as (id: string, a: string) => Promise<boolean>)("s1", "unpair");
    await flush();
    expect(notices(island.tree())).toHaveLength(0);
  });
});
