import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { StageRail } from "@/components/v2/desk/stage-rail";
import enDict from "@/dictionaries/en/ui.json";
import { ApiV1Error } from "@/lib/client-v1";
import type { SwissRoundControl } from "@/lib/swiss-rounds-edit";

const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));

// W5 Task 17c (owner ruling 2026-11-18): below `md` the stage's actions live in the Stage tools bottom sheet, and the panel's
// outcome lines (green notice, amber warning, red error) are said at the TOP of the page, outside it. A sheet that stays open
// puts a scrim over every one of them. So the sheet closes when ANY stage action settles - success, no-op or refusal - and the
// line is what shows. Closed on the settle, never on the tap: a refusal must still be there to read.
//
// Driven through the real handlers the rail is handed (`onAct`, `swissRounds.onAddRound`), with the sheet opened through the
// rail's own toggle, exactly as the phone opens it. Markup-only (vitest is node): the scrim and the focus return are the
// e2e's (`e2e/mobile/rules-panels.spec.ts`); this pins the state the scrim is a function of.

const EN = enDict as unknown as Record<string, string>;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const byTestId = (tree: ReactElement[], id: string) => tree.filter((el) => propsOf(el)["data-testid"] === id);

const stage = (kind: "league" | "swiss") => ({
  id: "s1",
  seq: 1,
  kind,
  name: kind === "swiss" ? "Swiss" : "League",
  config: kind === "swiss" ? { rounds: 3 } : {},
  progression: null,
  status: "active",
});

const ids = ["e1", "e2", "e3", "e4"];
// Six decided-or-open lines of a four-player league: one still open, so Complete and the rest are all on the rail.
const leagueFixtures = Array.from({ length: 6 }, (_, i) => ({
  id: `f${i + 1}`,
  stage_id: "s1",
  pool_id: null,
  round_no: Math.floor(i / 2) + 1,
  seq_in_round: (i % 2) + 1,
  fixture_no: i + 1,
  home_entrant_id: ids[i % 4]!,
  away_entrant_id: ids[(i + 1) % 4]!,
  scheduled_at: null,
  venue: null,
  court_label: null,
  court_id: null,
  court_name: null,
  status: i < 5 ? "decided" : "scheduled",
  outcome: null,
  ext_key: `rr-${i}`,
}));

const baseProps = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
  entrantNames: Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])),
  activeEntrantIds: ids,
  entrantSeeds: Object.fromEntries(ids.map((id, i) => [id, i + 1])),
  canEdit: true,
  divisionStatus: "active",
};

type Act = (id: string, action: "generate" | "complete" | "unpair" | "delete") => Promise<boolean>;

/** The panel on a phone: the sheet opened through the rail's own toggle, the answer to every request fed by `answer`. */
async function mountOpen(kind: "league" | "swiss", answer: (path: string, init?: { method?: string }) => Promise<unknown>) {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation((path: string, init?: { method?: string }) => answer(path, init));
  const control: SwissRoundControl = {
    started: true,
    rounds: 3,
    chess: false,
    field: 4,
    addRound: { canAddRound: true, refusal: null, field: 4, hardMax: 5 },
    finish: { canFinish: false, refusal: null, finishedAfter: 3, inProgress: false, completeInstead: false },
  } as unknown as SwissRoundControl;
  const island = renderIsland(StagesPanel, {
    ...baseProps,
    stages: [stage(kind)],
    fixtures: leagueFixtures,
    ...(kind === "swiss" ? { swissRoundControls: { s1: control } } : {}),
  } as never);
  await flush();
  const railOf = () => island.tree().find((el) => el.type === StageRail)!;
  (propsOf(railOf()).onToggleOpen as (id: string) => void)("s1");
  expect(propsOf(railOf()).open, "rig: the phone sheet is open before the action").toBe(true);
  return {
    island,
    railOf,
    sheetOpen: () => propsOf(railOf()).open as boolean,
    act: propsOf(railOf()).onAct as Act,
  };
}

const refused = (code: string, message = "refused", status = 409, extra: Record<string, unknown> = {}) => new ApiV1Error(message, status, code, extra);

type Case = {
  label: string;
  action: "generate" | "complete" | "unpair" | "delete";
  answer: () => Promise<unknown>;
  landed: boolean;
  /** which panel-level line carries the outcome, and a sentence that must be in it */
  line: { testid: string | null; text: string };
};

const CASES: Case[] = [
  { label: "Generate lands", action: "generate", answer: async () => ({ created: 6, existing: 0 }), landed: true, line: { testid: null, text: "Generated 6 fixture(s)" } },
  { label: "Complete lands", action: "complete", answer: async () => ({ completed: true }), landed: true, line: { testid: null, text: EN["schedule.notice.completed"]! } },
  {
    label: "Complete on an already complete stage (the no-op)",
    action: "complete",
    answer: async () => ({ completed: false, already_complete: true }),
    landed: true,
    line: { testid: null, text: EN["schedule.notice.alreadyComplete"]! },
  },
  { label: "Complete is not ready", action: "complete", answer: async () => ({ completed: false }), landed: true, line: { testid: null, text: EN["schedule.notice.notReady"]! } },
  { label: "Unpair lands", action: "unpair", answer: async () => ({ cleared: 4, round: 2 }), landed: true, line: { testid: null, text: "Cleared pairings for round 2" } },
  { label: "Delete lands", action: "delete", answer: async () => ({}), landed: true, line: { testid: null, text: EN["schedule.notice.stageDeleted"]! } },
  {
    label: "refusal: a generic server error (red line)",
    action: "complete",
    answer: async () => {
      throw refused("INTERNAL", "Something broke on the server", 500);
    },
    landed: false,
    line: { testid: "schedule-error", text: "Something broke on the server" },
  },
  {
    label: "refusal: a precondition (amber line)",
    action: "generate",
    answer: async () => {
      throw refused("STAGE_COMPLETED_SEEDING_FAILED", "no seats", 409);
    },
    landed: false,
    line: { testid: "schedule-warning", text: "no seats" },
  },
  {
    label: "refusal: Unpair failed (red line)",
    action: "unpair",
    answer: async () => {
      throw refused("STAGE_HAS_RESULTS", "has results", 409);
    },
    landed: false,
    line: { testid: "schedule-error", text: EN["schedule.error.unpairFailed"]! },
  },
  {
    label: "refusal: a dropped connection",
    action: "generate",
    answer: async () => {
      throw new TypeError("Failed to fetch");
    },
    landed: false,
    line: { testid: "schedule-error", text: "Failed to fetch" },
  },
];

describe("W5 T17c the phone Stage tools sheet closes when a stage action settles, so the outcome line shows", () => {
  it("every action, success and refusal: the sheet is open before, closed after, and the line is on the page outside the rail", async () => {
    let checked = 0;
    for (const c of CASES) {
      const m = await mountOpen("league", () => c.answer());
      const landed = await m.act("s1", c.action);
      await flush();
      expect(landed, `${c.label}: the answer's own verdict is unchanged`).toBe(c.landed);
      expect(m.sheetOpen(), `${c.label}: the sheet closed on the settle`).toBe(false);
      const tree = m.island.tree();
      // The line is the panel's, not the rail's: the rail is a LEAF in this tree (no `children`; its sheet is its own render), so
      // a sentence found in the walked tree is, by construction, outside the sheet. The guard keeps that premise honest.
      expect(propsOf(tree.find((el) => el.type === StageRail)!).children, "premise: the rail is a leaf here").toBeUndefined();
      const outside = textOf(tree);
      expect(outside, `${c.label}: the outcome is said on the page`).toContain(c.line.text);
      if (c.line.testid !== null) expect(byTestId(tree, c.line.testid), `${c.label}: in its own channel`).toHaveLength(1);
      checked++;
    }
    expect(checked, "anti-vacuity: every case ran").toBe(CASES.length);
    expect(CASES.filter((c) => c.landed).length, "both sides covered: successes").toBeGreaterThan(0);
    expect(CASES.filter((c) => !c.landed).length, "both sides covered: refusals").toBeGreaterThan(0);
  });

  it("closed on the settle, never on the tap: the sheet is still open while the request is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    const m = await mountOpen("league", () => new Promise((resolve) => (release = resolve)));
    const pending = m.act("s1", "complete");
    await flush();
    expect(m.sheetOpen(), "the request has not answered: the sheet is as the organiser left it").toBe(true);
    release({ completed: true });
    await pending;
    await flush();
    expect(m.sheetOpen(), "answered: closed").toBe(false);
  });

  it("the sequence: reopen, act again - it closes again (not a once-only close)", async () => {
    const m = await mountOpen("league", async () => ({ completed: false, already_complete: true }));
    await m.act("s1", "complete");
    await flush();
    expect(m.sheetOpen()).toBe(false);
    (propsOf(m.railOf()).onToggleOpen as (id: string) => void)("s1");
    expect(m.sheetOpen(), "reopened").toBe(true);
    await (propsOf(m.railOf()).onAct as Act)("s1", "complete");
    await flush();
    expect(m.sheetOpen(), "closed again").toBe(false);
  });

  it("the Swiss stage writes (Add a round) close the sheet too: landed and refused", async () => {
    let checked = 0;
    for (const answer of [
      async () => ({ rounds: 4 }),
      async () => {
        throw refused("SWISS_ROUNDS_LOCKED", "locked", 409);
      },
    ]) {
      const m = await mountOpen("swiss", answer);
      const rails = propsOf(m.railOf()).swissRounds as { onAddRound: (id: string, from: "more" | "dialog") => Promise<unknown> } | undefined;
      expect(rails, "rig: the rail was handed the Swiss rounds writes").toBeTruthy();
      await rails!.onAddRound("s1", "more");
      await flush();
      expect(m.sheetOpen(), `add a round (${checked === 0 ? "landed" : "refused"}): the sheet closed`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("another stage's sheet is not closed by this stage's action (only the one that acted)", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation(async () => ({ completed: true }));
    const two = [stage("league"), { ...stage("league"), id: "s2", seq: 2, name: "Second" }];
    const island = renderIsland(StagesPanel, { ...baseProps, stages: two, fixtures: leagueFixtures } as never);
    await flush();
    const rails = () => island.tree().filter((el) => el.type === StageRail);
    expect(rails(), "rig: two rails").toHaveLength(2);
    // one sheet open at a time (the panel's single `openRailFor`): open s2, act on s1 - s2 stays as it was.
    (propsOf(rails()[1]!).onToggleOpen as (id: string) => void)("s2");
    await (propsOf(rails()[0]!).onAct as Act)("s1", "complete");
    await flush();
    expect(propsOf(rails()[1]!).open, "s2's sheet is not s1's to close").toBe(true);
  });
});
