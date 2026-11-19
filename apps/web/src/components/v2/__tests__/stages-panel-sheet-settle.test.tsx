import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { StageRail } from "@/components/v2/desk/stage-rail";
import { UpgradeGate } from "@/components/upgrade-gate";
import { OnlineGameExistsNotice } from "@/components/v2/online-game-exists-notice";
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

const walkChildren = (el: ReactElement): ReactElement[] => walk((propsOf(el) as { children?: unknown }).children as never);
const refused = (code: string, message = "refused", status = 409, extra: Record<string, unknown> = {}) => new ApiV1Error(message, status, code, extra);

type Case = {
  label: string;
  action: "generate" | "complete" | "unpair" | "delete";
  answer: () => Promise<unknown>;
  landed: boolean;
  /** which panel-level line carries the outcome: a sentence that must be in it, or (for the two components) the component */
  line: { testid: string | null; text: string; component?: unknown };
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
  {
    label: "refusal: a paywall (PAYMENT_REQUIRED, the upgrade gate)",
    action: "generate",
    answer: async () => {
      throw refused("PAYMENT_REQUIRED", "pay", 402, { feature_key: "x" });
    },
    landed: false,
    line: { testid: null, text: "", component: UpgradeGate },
  },
  {
    label: "refusal: Unpair over an online game (the online-game notice)",
    action: "unpair",
    answer: async () => {
      throw refused("ONLINE_GAME_EXISTS", "game", 409);
    },
    landed: false,
    line: { testid: null, text: "", component: OnlineGameExistsNotice },
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
      if (c.line.component === undefined) expect(outside, `${c.label}: the outcome is said on the page`).toContain(c.line.text);
      // Fix round 2 (I1): EVERY outcome line is tagged for the phone scroll - the paywall gate and the online-game notice too -
      // and the component is INSIDE the tagged wrapper, not beside it.
      const tagged = tree.filter((el) => propsOf(el)["data-outcome-line"] !== undefined);
      expect(tagged.length, `${c.label}: an outcome line is tagged data-outcome-line`).toBeGreaterThan(0);
      if (c.line.component !== undefined) {
        expect(
          tagged.some((w) => (walkChildren(w) as ReactElement[]).some((el) => el.type === c.line.component)),
          `${c.label}: the component sits inside a tagged wrapper`,
        ).toBe(true);
      }
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

// Fix round 2 (m1): the lines announce themselves. Markup, anchored on `="` (an omitted attribute never reads `role="..."`).
describe("W5 T17c fix 2 the outcome lines carry their roles", () => {
  it("the red line is role=alert; the green notice and the amber caution are role=status", async () => {
    let checked = 0;
    for (const [testid, role, answer] of [
      ["schedule-error", "alert", async () => { throw refused("INTERNAL", "boom", 500); }],
      ["schedule-notice", "status", async () => ({ completed: true })],
      ["schedule-warning", "alert-not", async () => { throw refused("STAGE_COMPLETED_SEEDING_FAILED", "no seats", 409); }],
    ] as const) {
      const m = await mountOpen("league", answer as () => Promise<unknown>);
      await m.act("s1", testid === "schedule-warning" ? "generate" : "complete");
      await flush();
      const [line] = byTestId(m.island.tree(), testid);
      expect(line, `${testid}: the line is on the page`).toBeTruthy();
      const html = renderToStaticMarkup(line!);
      if (role === "alert-not") expect(html, "the amber caution is a status, not an alert").toContain('role="status"');
      else expect(html, `${testid} role`).toContain(`role="${role}"`);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// Fix round 2 (I2): the scroll fires on EVERY phone-width settle, sheet open or not (Finish and the Rounds chip close the sheet
// themselves before their dialog), and never from `md` up. window / document are stubbed: vitest is node.
describe("W5 T17c fix 2 a settle at a phone width scrolls the outcome line into view, sheet open or not", () => {
  afterEach(() => vi.unstubAllGlobals());
  function stub(phone: boolean, rect: { top: number; bottom: number } = { top: 200, bottom: 230 }) {
    const scrolled: string[] = [];
    const line = {
      style: {} as Record<string, string>,
      getBoundingClientRect: () => rect,
      scrollIntoView: vi.fn((o: unknown) => scrolled.push(JSON.stringify(o))),
    };
    const form = { style: {} as Record<string, string>, scrollIntoView: vi.fn() };
    vi.stubGlobal("window", {
      innerHeight: 800,
      matchMedia: (q: string) => ({ matches: q.includes("767.98") ? phone : false }),
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("document", {
      querySelector: (sel: string) => (sel === "[data-outcome-line]" ? line : sel === '[data-testid="stage-add-match-form"]' ? form : sel === "header" ? { getBoundingClientRect: () => ({ bottom: 58 }) } : null),
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    return { line, form, scrolled };
  }
  const settles = [
    ["act, sheet open", true, "act"],
    ["act, sheet already closed", false, "act"],
    ["swissStageWrite (Add a round), sheet already closed (Finish / Rounds chip close it first)", false, "swiss"],
  ] as const;

  it("phone: every settle scrolls once, under the sticky header (margin = header bottom + 8)", async () => {
    let checked = 0;
    for (const [label, openSheet, kind] of settles) {
      const env = stub(true);
      const m = await mountOpen(kind === "swiss" ? "swiss" : "league", async () => (kind === "swiss" ? { rounds: 4 } : { completed: true }));
      if (!openSheet) (propsOf(m.railOf()).onToggleOpen as (id: string) => void)("s1"); // close it again, as Finish does
      expect(m.sheetOpen(), `${label}: rig`).toBe(openSheet);
      if (kind === "swiss") await (propsOf(m.railOf()).swissRounds as { onAddRound: (id: string, f: "more") => Promise<unknown> }).onAddRound("s1", "more");
      else await (propsOf(m.railOf()).onAct as Act)("s1", "complete"); // the CURRENT handler (its closure sees the sheet as it is now)
      await flush();
      expect(env.line.scrollIntoView, `${label}: scrolled`).toHaveBeenCalledTimes(1);
      expect(env.line.style.scrollMarginTop, `${label}: just under the header`).toBe("66px");
      expect(env.scrolled[0], `${label}: block start, smooth`).toContain('"block":"start"');
      checked++;
      vi.unstubAllGlobals();
    }
    expect(checked).toBe(settles.length);
  });

  // B5 fix wave fix round 1 (controller ruling: the organiser SEES the outcome at every width): from `md` up the line is brought into
  // view only when it is not fully visible under the header (`block: "nearest"`); a line already in view never moves the page.
  // Window 800px tall, header bottom 58: [200, 230] is in view; [-286, -256] (1280 measure) above it; [20, 50] under the header;
  // [790, 820] below the fold.
  it("md and up: a line already in view never scrolls", async () => {
    const env = stub(false);
    const m = await mountOpen("league", async () => ({ completed: true }));
    await m.act("s1", "complete");
    await flush();
    expect(env.line.scrollIntoView, "desktop, line in view: no scroll").not.toHaveBeenCalled();
  });

  it("md and up: a line off screen (above, under the header, below) is brought into view once, nearest, under the header", async () => {
    let checked = 0;
    for (const [label, rect] of [
      ["above the viewport", { top: -286, bottom: -256 }],
      ["under the sticky header", { top: 20, bottom: 50 }],
      ["below the fold", { top: 790, bottom: 820 }],
    ] as const) {
      const env = stub(false, rect);
      const m = await mountOpen("league", async () => ({ completed: true }));
      await m.act("s1", "complete");
      await flush();
      expect(env.line.scrollIntoView, `${label}: scrolled once`).toHaveBeenCalledTimes(1);
      expect(env.scrolled[0], `${label}: block nearest`).toContain('"block":"nearest"');
      expect(env.line.style.scrollMarginTop, `${label}: clears the header`).toBe("66px");
      checked++;
      vi.unstubAllGlobals();
    }
    expect(checked).toBe(3);
  });
});

// B5 fix wave G2 (batch review I2): the waiting strips say their outcome in the PANEL's lines too (the strip vanishes once the player
// is placed), at the top of the page — so a phone settle from either strip, and the card's own Rebuild (the knockout strip's Rebuild
// button runs it), scrolls the first outcome line under the header exactly as `act` does; from `md` up nothing scrolls. Driven
// through the real callbacks the panel hands each strip; window / document stubbed (vitest is node). The in-view proof (hit test)
// is the e2e's (`e2e/mobile/organiser-console.spec.ts`).
describe("B5 G2 a waiting strip's outcome scrolls into view on a phone", () => {
  afterEach(() => vi.unstubAllGlobals());
  async function mountStrips(phone: boolean, answer: () => Promise<unknown>, rect: { top: number; bottom: number } = { top: 200, bottom: 230 }) {
    const line = { style: {} as Record<string, string>, getBoundingClientRect: () => rect, scrollIntoView: vi.fn() };
    vi.stubGlobal("window", {
      innerHeight: 800,
      matchMedia: (q: string) => ({ matches: q.includes("767.98") ? phone : false }),
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("document", {
      querySelector: (sel: string) => (sel === "[data-outcome-line]" ? line : sel === "header" ? { getBoundingClientRect: () => ({ bottom: 58 }) } : null),
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation(answer);
    const waiter = { entrantId: "e9", stageId: "s1", name: "Late Ana", paid: false };
    const island = renderIsland(StagesPanel, {
      ...baseProps,
      stages: [stage("league"), { ...stage("league"), id: "s2", seq: 2, kind: "knockout", name: "Final" }],
      fixtures: leagueFixtures,
      tableWaiting: [waiter],
      knockoutWaiting: [{ ...waiter, stageId: "s2" }],
    } as never);
    await flush();
    const propsByName = (name: string) => {
      const el = island.tree().find((e) => typeof e.type === "function" && (e.type as { name?: string }).name === name);
      expect(el, `rig: the ${name} is mounted`).toBeTruthy();
      return propsOf(el!);
    };
    return { line, propsByName };
  }
  const said = { done: ["Late Ana joined Group A."], todo: [] };
  const settles: [string, (p: (n: string) => Record<string, unknown>) => unknown][] = [
    ["table strip: placed", (p) => (p("TableWaitingStrip").onPlaced as (s: typeof said) => void)(said)],
    ["table strip: Rebuild refused (handed to the panel)", (p) => (p("TableWaitingStrip").onRebuildRefused as (e: unknown) => void)(refused("ONLINE_GAME_EXISTS", "game"))],
    ["knockout strip: placed", (p) => (p("KnockoutWaitingStrip").onPlaced as (s: typeof said) => void)(said)],
    ["knockout strip: Rebuild (the card's rebuildStage)", (p) => (p("KnockoutWaitingStrip").onRebuild as () => void)()],
  ];

  it("phone: every settle from either strip scrolls the outcome line once, under the header", async () => {
    let checked = 0;
    for (const [label, settle] of settles) {
      const m = await mountStrips(true, async () => ({ created: 4, existing: 0, removed: 4, slots: { kept: 0, freed: 0, unscheduled: 0 } }));
      settle(m.propsByName);
      await flush();
      await flush();
      expect(m.line.scrollIntoView, `${label}: scrolled once`).toHaveBeenCalledTimes(1);
      expect(m.line.style.scrollMarginTop, `${label}: just under the header`).toBe("66px");
      checked++;
      vi.unstubAllGlobals();
    }
    expect(checked).toBe(settles.length);
  });

  it("md and up: a settle whose line is already in view never scrolls", async () => {
    let checked = 0;
    for (const [label, settle] of settles) {
      const m = await mountStrips(false, async () => ({ created: 4, existing: 0, removed: 4, slots: { kept: 0, freed: 0, unscheduled: 0 } }));
      settle(m.propsByName);
      await flush();
      await flush();
      expect(m.line.scrollIntoView, `${label}: desktop, line in view: no scroll`).not.toHaveBeenCalled();
      checked++;
      vi.unstubAllGlobals();
    }
    expect(checked).toBe(settles.length);
  });

  // Fix round 1: at 1280 the strip's place / Rebuild line measured top -286 / -186 (off screen) — it is brought into view, nearest.
  it("md and up: a settle whose line is off screen brings it into view once, nearest", async () => {
    let checked = 0;
    for (const [label, settle] of settles) {
      const m = await mountStrips(false, async () => ({ created: 4, existing: 0, removed: 4, slots: { kept: 0, freed: 0, unscheduled: 0 } }), { top: -286, bottom: -256 });
      settle(m.propsByName);
      await flush();
      await flush();
      expect(m.line.scrollIntoView, `${label}: scrolled once`).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(m.line.scrollIntoView.mock.calls[0]![0]), `${label}: nearest`).toContain('"block":"nearest"');
      checked++;
      vi.unstubAllGlobals();
    }
    expect(checked).toBe(settles.length);
  });
});

// Fix round 2 (m2): the sheet's Add match opens its form inside the card, behind the scrim.
describe("W5 T17c fix 2 Add match leaves the sheet and brings its form into view (phone only)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    ["phone", true],
    ["md and up", false],
  ])("%s", async (_label, phone) => {
    const scrolled: string[] = [];
    const form = { style: {} as Record<string, string>, scrollIntoView: vi.fn((o: unknown) => scrolled.push(JSON.stringify(o))) };
    vi.stubGlobal("window", { matchMedia: (q: string) => ({ matches: q.includes("767.98") ? phone : false }), addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("document", {
      querySelector: (sel: string) => (sel === '[data-testid="stage-add-match-form"]' ? form : sel === "header" ? { getBoundingClientRect: () => ({ bottom: 58 }) } : null),
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const m = await mountOpen("league", async () => ({}));
    (propsOf(m.railOf()).onToggleAddMatch as (id: string) => void)("s1");
    await flush();
    expect(propsOf(m.railOf()).addingTo, "the form is open").toBe("s1");
    expect(m.sheetOpen(), phone ? "phone: the sheet closed behind the form" : "md: no sheet to close (the rig opened it; it is left as it was)").toBe(!phone);
    if (phone) {
      expect(form.scrollIntoView, "phone: the form is brought into view").toHaveBeenCalledTimes(1);
      expect(form.style.scrollMarginTop).toBe("66px");
    } else {
      expect(form.scrollIntoView, "md: nothing scrolls").not.toHaveBeenCalled();
    }
  });
});
