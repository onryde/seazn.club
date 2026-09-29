// Review 3 of #857, m1. `undoRefusalMessage` is pinned on its own
// (stages-panel-undo-refusal.test.ts), but nothing pinned that the panel's
// Undo actually CALLS it: a call site that went back to `err.message` would
// paint the engine's English sentence and leave every other suite green. This
// drives the real island: a run-sheet reschedule arms Undo, the Undo is
// refused as played, and the panel's error line is read back.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { RunSheet } from "@/components/v2/desk/run-sheet";
import { ApiV1Error } from "@/lib/client-v1";
import { PLAYED_REFUSAL_CODE } from "@/lib/played-fixture-statuses";
import enUi from "@/dictionaries/en/ui.json";

const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));
// The fixture stream panel (imported through the run sheet) reads the checkout-return URL and strips it (G5).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const EN = enUi as unknown as Record<string, string>;
const ENGINE = "a match this change touches has started or finished, so it can't be undone or redone";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  stages: [{ id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active" }],
  fixtures: [
    {
      id: "f1",
      stage_id: "s1",
      pool_id: null,
      round_no: 1,
      seq_in_round: 1,
      fixture_no: 1,
      home_entrant_id: "e1",
      away_entrant_id: "e2",
      scheduled_at: null,
      venue: null,
      court_label: null,
      court_id: null,
      court_name: null,
      status: "scheduled",
      outcome: null,
      ext_key: "lg-1",
    },
  ],
};

/** The panel's red error line(s), as text. */
const errorLines = (tree: ReactElement[]): string[] =>
  tree
    .filter((el) => el.type === "p" && String(propsOf(el).className ?? "").includes("bg-red-50"))
    .map((el) => textOf(el));

describe("StagesPanel — Undo says a played refusal in the reader's language", () => {
  it("a refused Undo paints the dictionary's sentence, never the engine's English", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation((path: string) =>
      String(path).endsWith("/undo")
        ? Promise.reject(new ApiV1Error(ENGINE, 422, PLAYED_REFUSAL_CODE))
        : Promise.resolve({}),
    );
    const island = renderIsland(StagesPanel, props);
    await flush();

    // A reschedule from the run sheet is what arms the panel's Undo.
    const sheets = island.tree().filter((el) => el.type === RunSheet);
    expect(sheets).toHaveLength(1);
    (propsOf(sheets[0]!).onRescheduled as () => void)();

    const undo = island.tree().filter((el) => propsOf(el)["data-testid"] === "schedule-undo");
    expect(undo, "Undo is not offered after a reschedule").toHaveLength(1);
    (propsOf(undo[0]!).onClick as () => void)();
    await flush();
    await flush();

    expect(apiV1Mock.mock.calls.some(([path]) => String(path).endsWith("/divisions/d1/undo"))).toBe(true);
    expect(errorLines(island.tree())).toEqual([EN["history.error.played"]]);
  });
});
