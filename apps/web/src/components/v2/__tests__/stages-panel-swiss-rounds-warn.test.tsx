// W3 Task 11 (X-SW-16; brief M8) — the warn verdict's CONSUMER. The server returns `swiss_rounds` on a Generate whose
// round count is above the field's safe maximum (rulebook-W3-swiss.md §3.2 "allowed, with a plain warning"); nothing in
// a unit of `swissRoundsWarnNotice` proves the desk SAYS it. This drives the real island: the rail's Pair next is pressed,
// the Generate answers with a judgement, and the panel's notice line is read back.
//
// The expected sentence is the dictionary's own copy filled with the judgement's numbers, never read off the function
// under test. Single-sport by nature: the notice reads a judgement's numbers; no sport field reaches it.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { StageRail } from "@/components/v2/desk/stage-rail";
import { ApiV1Error } from "@/lib/client-v1";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import enUi from "@/dictionaries/en/ui.json";

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
  useConfirm: () => vi.fn(async () => false),
}));

const EN = enUi as unknown as Record<string, string>;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

const ENTRANTS = ["e1", "e2", "e3", "e4", "e5", "e6"];
const props = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "pro" as const,
  entrantNames: Object.fromEntries(ENTRANTS.map((e) => [e, e.toUpperCase()])),
  activeEntrantIds: ENTRANTS,
  entrantSeeds: Object.fromEntries(ENTRANTS.map((e, i) => [e, i + 1])),
  canEdit: true,
  stages: [{ id: "s1", seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 5 }, progression: null, status: "active" }],
  fixtures: [],
};

/** The panel's green notice line(s), as text. */
const noticeLines = (tree: ReactElement[]): string[] =>
  tree
    .filter((el) => el.type === "p" && String(propsOf(el).className ?? "").includes("bg-emerald-50"))
    .map((el) => textOf(el));
/** The panel's red error line(s), as text. */
const errorLines = (tree: ReactElement[]): string[] =>
  tree
    .filter((el) => el.type === "p" && String(propsOf(el).className ?? "").includes("bg-red-50"))
    .map((el) => textOf(el));

async function pressPairNext(answer: () => Promise<unknown>) {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation((path: string) => (String(path).endsWith("/generate") ? answer() : Promise.resolve({})));
  const island = renderIsland(StagesPanel, props);
  await flush();
  const rails = island.tree().filter((el) => el.type === StageRail);
  expect(rails, "the Swiss stage's rail").toHaveLength(1);
  await (propsOf(rails[0]!).onAct as (id: string, action: string) => Promise<boolean>)("s1", "generate");
  await flush();
  expect(apiV1Mock.mock.calls.some(([path]) => String(path) === "/api/v1/stages/s1/generate"), "Pair next reached the server").toBe(true);
  return island;
}

describe("StagesPanel — the Swiss round-count warning after Pair next (X-SW-16)", () => {
  it("X-SW-16 a warn verdict renders the safe-max notice after Pair next", async () => {
    // §3.2's table for a field of 6 under 5 rounds: 3 recommended, safe max 3, hard max 5.
    const island = await pressPairNext(async () => ({
      created: 0,
      existing: 0,
      fixtures: [],
      swiss_rounds: { verdict: "warn", recommended: 3, safeMax: 3, hardMax: 5 },
    }));
    const warn = fill(EN["swiss.rounds.warn.other"]!, { safeMax: 3, recommended: 3, hardMax: 5 });
    expect(warn, "premise: the copy names the three numbers").toMatch(/3 rounds.*3, at most 5/);
    expect(noticeLines(island.tree())).toEqual([`${EN["schedule.notice.nothingNew"]} ${warn}`]);
  });

  it("X-SW-16 an ok verdict renders no warn line (and neither does an answer without one)", async () => {
    for (const swiss_rounds of [{ verdict: "ok", recommended: 3, safeMax: 4, hardMax: 7 }, undefined]) {
      const island = await pressPairNext(async () => ({ created: 0, existing: 0, fixtures: [], ...(swiss_rounds ? { swiss_rounds } : {}) }));
      expect(noticeLines(island.tree()), String(swiss_rounds?.verdict)).toEqual([EN["schedule.notice.nothingNew"]]);
    }
  });

  it("a refused Pair next says SWISS_ROUNDS_ABOVE_MAX in the reader's language, with what the shrunk field still pairs", async () => {
    // The server's 409 after withdrawals shrank a 6 × 5 Swiss to 4 (§3.2: a field of 4 pairs at most 3 rounds).
    const island = await pressPairNext(() =>
      Promise.reject(
        new ApiV1Error(SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message, 409, "SWISS_ROUNDS_ABOVE_MAX", {
          rounds: 5,
          field: 4,
          hardMax: 3,
          canFinish: true,
        }),
      ),
    );
    expect(errorLines(island.tree())).toEqual([
      `${EN["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]} ${fill(EN["swiss.rounds.shrunk.other"]!, { field: 4, count: 3 })}`,
    ]);
    expect(noticeLines(island.tree())).toEqual([]);
  });
});
