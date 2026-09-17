// The board's action toolbar — ONE action set, aimed by a stage selector.
//
// Before this, the three solver buttons were rendered inside a `.map` over
// every unfinished stage: a division with a League and a Stepladder finals
// stage put SIX solver buttons in the row, each pair captioned with the same
// two sentences, and the row's length was a function of the format. The
// duplication is what this file pins down — a regression here is invisible in
// every other spec, because each individual button still renders correctly and
// still posts the right body. What breaks is that there are N of them.
//
// There is no DOM (vitest `environment: "node"`, no jsdom), so the board is
// mounted through the shared hook harness and every button is fired through its
// own production `onClick`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import type { BoardDivision, BoardFixture, BoardStage } from "../board/types";
import { StagePicker, StagePickerMarkup, type StagePickerProps } from "../board/stage-picker";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn(), search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/o/acme/competitions/c1/schedule",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// `useLocale`/`usePlural` THROW outside a DictProvider and the harness has no
// provider tree; `useMsg` falls back to the real English catalog there, which is
// the production path, so any copy asserted below is the shipped copy.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { plural: pluralRuntime } = await import("@/lib/i18n-runtime");
  const { messages } = await import("@/lib/messages");
  return {
    ...actual,
    useLocale: () => "en" as const,
    usePlural:
      () =>
      (key: string, count: number, vars?: Record<string, string | number>) =>
        pluralRuntime(messages, key, count, "en", vars),
  };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, track: vi.fn() };
});

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  auto: {} as Record<string, unknown>,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      if (url.endsWith("/schedule/auto")) return Promise.resolve(net.auto);
      if (url.endsWith("/schedule/apply")) return Promise.resolve({ applied: 1, conflicts: [] });
      return Promise.resolve({ conflicts: [] });
    },
  };
});

import { ScheduleBoard } from "../schedule-board";

const DIVISIONS: BoardDivision[] = [
  { id: "d1", name: "Under 12s", slug: "u12", status: "active", seq: 4, schedule_locked: false },
];

/** The shape in the bug report: one division, two unfinished stages. */
const TWO_STAGES: BoardStage[] = [
  { id: "s1", division_id: "d1", name: "League", kind: "round_robin", ordinal: 1 },
  { id: "s2", division_id: "d1", name: "Stepladder finals", kind: "stepladder", ordinal: 2 },
] as unknown as BoardStage[];

const FIXTURES: BoardFixture[] = [
  {
    id: "f1",
    stage_id: "s1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    venue: null,
    court_label: "Court 1",
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  } as unknown as BoardFixture,
];

const SETTINGS = {
  tz: "Europe/London",
  config: {
    startAt: "2026-08-01T09:00:00.000Z",
    endAt: "2026-08-01T18:00:00.000Z",
    matchMinutes: 60,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
  },
} as unknown as Parameters<typeof ScheduleBoard>[0]["settings"];

type BoardProps = Parameters<typeof ScheduleBoard>[0];

const baseProps = (stages: BoardStage[] = TWO_STAGES): BoardProps =>
  ({
    divisions: DIVISIONS,
    stages,
    fixtures: FIXTURES,
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    activeEntrantCounts: { d1: 2 },
    feedLabels: {},
    settings: SETTINGS,
    canEdit: true,
    constraintsAllowed: true,
    canManage: true,
    aiAllowed: true,
    currency: "usd",
    competitionStart: "2026-08-01",
    competitionEnd: "2026-08-02",
    officialsWithBlackout: 0,
    competition: { id: "c1", divisionSettings: { d1: SETTINGS } },
  }) as unknown as BoardProps;

/** StagePicker (comp board only) owns its own <details> ref + dismiss
 *  listeners via hooks, so the harness — one component deep — cannot expand
 *  into it directly. `StagePickerMarkup` is the hookless half that actually
 *  renders the chip and menu; find StagePicker in the top tree and call the
 *  markup component with a throwaway ref, the same way `expandRows` in
 *  create-org-form.test.tsx expands a hookless child. */
const expandBoard = (node: ReactNode): ReactElement[] => {
  const top = walk(node);
  const pickers = top.filter((el) => el.type === StagePicker);
  return [
    ...top,
    ...pickers.flatMap((el) =>
      walk(
        StagePickerMarkup({
          ...(propsOf(el) as unknown as StagePickerProps),
          rootRef: { current: null },
          close: () => {},
        }),
      ),
    ),
  ];
};

const localStore = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => void localStore.set(k, v),
  },
  matchMedia: () => ({ matches: false }),
  get location() {
    return { search: nav.search };
  },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every element carrying `prop === value` — the count is the claim here. */
const allWithProp = (tree: ReactElement[], prop: string, value: unknown): ReactElement[] =>
  tree.filter((node) => propsOf(node)[prop] === value);

const withProp = (tree: ReactElement[], prop: string, value: unknown): ReactElement => {
  const el = allWithProp(tree, prop, value)[0];
  if (!el) throw new Error(`nothing rendered with ${prop}="${String(value)}"`);
  return el;
};

/** The URL of the last POST to a stage's auto endpoint. */
const lastAutoUrl = () => net.calls.filter((c) => c.url.endsWith("/schedule/auto")).at(-1)?.url;

/** Every solver action confirms before it runs (2026-09-17) — click the
 *  button, then the confirm dialog's own `onConfirm`, exactly as an
 *  organiser's two taps do. */
const CONFIRM_TESTID: Record<string, string> = {
  "schedule-auto": "schedule-rebuild",
  "schedule-reflow": "schedule-reflow-confirm",
  "schedule-polish": "schedule-polish-confirm",
};
const runAction = async (
  island: { tree: () => ReactElement[] },
  testid: string,
  expandTree: (tree: ReactElement[]) => ReactElement[] = (t) => t,
) => {
  await (propsOf(withProp(expandTree(island.tree()), "data-testid", testid)).onClick as () => void)();
  const dialog = withProp(expandTree(island.tree()), "testId", CONFIRM_TESTID[testid]!);
  await (propsOf(dialog).onConfirm as () => void)();
};

beforeEach(() => {
  net.calls.length = 0;
  net.auto = { assignments: [], conflicts: [] };
  nav.refresh.mockClear();
});

describe("the toolbar renders one action set, whatever the format's stage count", () => {
  /**
   * The regression this whole file exists for.
   *
   * A `.map` over stages renders a button per stage, and every per-button
   * assertion in the sibling specs still passes while the row grows without
   * bound. Asserting the COUNT is the only shape that catches it — and it also
   * guards the e2e specs, which drive `getByTestId("schedule-auto")` under
   * Playwright strict mode: a second element with the same id turns every one of
   * those clicks into a strict-mode violation rather than a click.
   */
  it("renders exactly one of each solver button for a two-stage division", () => {
    const island = renderIsland(ScheduleBoard, baseProps());
    const tree = island.tree();

    for (const testid of ["schedule-auto", "schedule-reflow", "schedule-polish"]) {
      expect(allWithProp(tree, "data-testid", testid), `${testid} count`).toHaveLength(1);
    }
  });

  /** One caption for the group, carried as a hover title, not one per button or stage. */
  it("captions the group once", () => {
    const island = renderIsland(ScheduleBoard, baseProps());
    const bars = allWithProp(island.tree(), "data-testid", "schedule-action-bar");
    expect(bars).toHaveLength(1);
    expect(propsOf(bars[0]!).title).toBe(
      "Rebuild → fix clashes → tighten times. Locked cards stay put.",
    );
  });

  /**
   * The selector is what replaces the repetition, so it has to name every stage
   * the old row had a button for — one option per unfinished stage, the first
   * one live by default.
   */
  it("offers one selector option per unfinished stage, defaulting to the first", () => {
    const island = renderIsland(ScheduleBoard, baseProps());
    const options = allWithProp(island.tree(), "data-testid", "schedule-stage");

    expect(options.map((o) => propsOf(o).children)).toStrictEqual(["League", "Stepladder finals"]);
    expect(options.map((o) => propsOf(o)["aria-pressed"])).toStrictEqual([true, false]);
  });

  /**
   * The wiring, not the paint: picking a stage has to change WHICH stage the
   * solver runs on. A selector that renders correctly and leaves the action
   * pointed at stage one rebuilds the wrong half of the board, silently, and
   * every render assertion above still passes.
   */
  it("aims the action set at the picked stage", async () => {
    const island = renderIsland(ScheduleBoard, baseProps());

    await runAction(island, "schedule-auto");
    await flush();
    expect(lastAutoUrl()).toBe("/api/v1/stages/s1/schedule/auto");

    const finals = allWithProp(island.tree(), "data-testid", "schedule-stage")[1]!;
    (propsOf(finals).onClick as () => void)();

    const after = island.tree();
    expect(allWithProp(after, "data-testid", "schedule-stage").map((o) => propsOf(o)["aria-pressed"]))
      .toStrictEqual([false, true]);

    await runAction(island, "schedule-auto");
    await flush();
    expect(lastAutoUrl()).toBe("/api/v1/stages/s2/schedule/auto");
  });

  /**
   * The buttons stayed short when the stage moved out of the label, so the
   * group has to say what it is pointed at some other way. The selector shows
   * it; this is the answer for someone hovering the button they are about to
   * press — and it follows the selection rather than naming stage one forever.
   */
  it("names the stage the action group is pointed at", () => {
    const island = renderIsland(ScheduleBoard, baseProps());
    const group = withProp(island.tree(), "data-testid", "schedule-auto");
    // The title lives on the group that wraps the three buttons, so walk to it
    // by looking for the element whose title mentions the live stage.
    const titled = island
      .tree()
      .filter((el) => typeof propsOf(el).title === "string")
      .map((el) => propsOf(el).title as string);
    expect(group).toBeTruthy();
    expect(titled).toContain("Runs on League");

    const finals = allWithProp(island.tree(), "data-testid", "schedule-stage")[1]!;
    (propsOf(finals).onClick as () => void)();

    const after = island
      .tree()
      .filter((el) => typeof propsOf(el).title === "string")
      .map((el) => propsOf(el).title as string);
    expect(after).toContain("Runs on Stepladder finals");
    expect(after).not.toContain("Runs on League");
  });

  /** A division with nothing to choose between shows no chooser. */
  it("drops the selector when only one stage can run", async () => {
    const island = renderIsland(ScheduleBoard, baseProps([TWO_STAGES[0]!]));
    const tree = island.tree();

    expect(allWithProp(tree, "data-testid", "schedule-stage")).toHaveLength(0);
    await runAction(island, "schedule-auto");
    await flush();
    expect(lastAutoUrl()).toBe("/api/v1/stages/s1/schedule/auto");
  });

  /**
   * A finished stage was never in the old row either — the `.map` filtered on
   * `status !== "complete"`. The selector inherits that filter, so a completed
   * League leaves the finals as the only option, and the actions aim at it.
   */
  it("leaves completed stages out of the selector and out of the aim", async () => {
    const stages = [
      { ...TWO_STAGES[0], status: "complete" },
      TWO_STAGES[1],
    ] as unknown as BoardStage[];
    const island = renderIsland(ScheduleBoard, baseProps(stages));
    const tree = island.tree();

    expect(allWithProp(tree, "data-testid", "schedule-stage")).toHaveLength(0);
    await runAction(island, "schedule-auto");
    await flush();
    expect(lastAutoUrl()).toBe("/api/v1/stages/s2/schedule/auto");
  });

  /**
   * …AND STILL SAYS WHICH STAGE THAT IS. Review finding on #650: a finished
   * league beside a live playoff stage is the ordinary shape of a competition
   * mid-way through, and it is the one case where no selector renders. The old
   * button label named the stage whenever the DIVISION had more than one
   * (`stages.length > 1`), so that board read "Auto-schedule Playoffs";
   * gating the name on how many stages can still RUN dropped it entirely and
   * left a destructive rebuild pointed at a stage nobody had named.
   *
   * Visible, not a hover title: the label it replaced was on screen at every
   * width, and a `title` is desktop-only.
   */
  it("still names the stage when only one of several can run", () => {
    const stages = [
      { ...TWO_STAGES[0], status: "complete" },
      TWO_STAGES[1],
    ] as unknown as BoardStage[];
    const tree = renderIsland(ScheduleBoard, baseProps(stages)).tree();

    const chip = withProp(tree, "data-testid", "schedule-stage-static");
    expect(propsOf(chip).children).toBe("Stepladder finals");
    expect(
      tree.filter((el) => typeof propsOf(el).title === "string").map((el) => propsOf(el).title),
    ).toContain("Runs on Stepladder finals");
  });

  /** One stage in the whole division names nothing — there is nothing to
   *  confuse it with, which is exactly what the old label did too. */
  it("names nothing when the division has a single stage", () => {
    const tree = renderIsland(ScheduleBoard, baseProps([TWO_STAGES[0]!])).tree();

    expect(allWithProp(tree, "data-testid", "schedule-stage-static")).toHaveLength(0);
    expect(
      tree.filter((el) => typeof propsOf(el).title === "string").map((el) => propsOf(el).title),
    ).not.toContain("Runs on League");
  });
});

/**
 * Competition-wide board (comp board), several divisions with a runnable
 * stage each. Before this, the page baked the division into the stage
 * NAME ("Under 12s · League"), because the flat pill row had no other way
 * to tell two divisions' same-named stage apart — and with five divisions
 * the pill row, grouped or not, pushed the solver buttons into a ragged
 * wrap. The comp board now carries ONE chip naming the target
 * ("Under 12s · League") and a menu behind it, grouped by division; the
 * single-division board keeps its pills, where two or three of them fit.
 */
describe("the stage selector is a target chip with a grouped menu on the comp board", () => {
  const TWO_DIVISIONS: BoardDivision[] = [
    { id: "d1", name: "Under 12s", slug: "u12", status: "active", seq: 1, schedule_locked: false },
    { id: "d2", name: "Under 14s", slug: "u14", status: "active", seq: 2, schedule_locked: false },
  ];

  /** Same stage NAME in both divisions — the shape a prefix used to disambiguate. */
  const STAGES_ACROSS_DIVISIONS: BoardStage[] = [
    { id: "s1", division_id: "d1", name: "League", kind: "round_robin", ordinal: 1 },
    { id: "s2", division_id: "d2", name: "League", kind: "round_robin", ordinal: 1 },
  ] as unknown as BoardStage[];

  const multiDivisionProps = (): BoardProps =>
    ({
      ...baseProps(STAGES_ACROSS_DIVISIONS),
      divisions: TWO_DIVISIONS,
      activeEntrantCounts: { d1: 2, d2: 2 },
      competition: {
        id: "c1",
        divisionSettings: { d1: SETTINGS, d2: SETTINGS },
      },
    }) as unknown as BoardProps;

  /** The chip names BOTH halves of the target: the division (which the bare
   *  stage name no longer carries) and the stage. */
  it("names the target division and stage on the chip", () => {
    const tree = renderIsland(ScheduleBoard, multiDivisionProps(), expandBoard).tree();

    expect(allWithProp(tree, "data-testid", "schedule-stage-picker")).toHaveLength(1);
    expect(propsOf(withProp(tree, "data-testid", "schedule-stage-picker-division")).children).toBe(
      "Under 12s",
    );
    expect(propsOf(withProp(tree, "data-testid", "schedule-stage-picker-stage")).children).toBe(
      "League",
    );
  });

  /** The menu lists every runnable stage under its division, stage names bare —
   *  two same-named stages are told apart by the group they sit in. */
  it("groups the menu by division and keeps the stage names bare", () => {
    const tree = renderIsland(ScheduleBoard, multiDivisionProps(), expandBoard).tree();

    const groups = allWithProp(tree, "data-testid", "schedule-stage-group");
    expect(groups.map((g) => propsOf(g)["data-division-id"])).toStrictEqual(["d1", "d2"]);

    const labels = allWithProp(tree, "data-testid", "schedule-stage-group-label");
    expect(labels.map((l) => (propsOf(l).children as unknown[]).at(-1))).toStrictEqual([
      "Under 12s",
      "Under 14s",
    ]);

    const options = allWithProp(tree, "data-testid", "schedule-stage");
    expect(options.map((o) => propsOf(o).children)).toStrictEqual(["League", "League"]);
    expect(options.map((o) => propsOf(o)["aria-selected"])).toStrictEqual([true, false]);
  });

  /** Picking from the menu re-aims the chip AND the solver — the wiring, not
   *  the paint, same claim as the single-division spec above. */
  it("aims the chip and the action set at the picked stage", async () => {
    const island = renderIsland(ScheduleBoard, multiDivisionProps(), expandBoard);

    const u14 = allWithProp(island.tree(), "data-testid", "schedule-stage")[1]!;
    (propsOf(u14).onClick as () => void)();

    const after = island.tree();
    expect(propsOf(withProp(after, "data-testid", "schedule-stage-picker-division")).children).toBe(
      "Under 14s",
    );
    expect(allWithProp(after, "data-testid", "schedule-stage").map((o) => propsOf(o)["aria-selected"]))
      .toStrictEqual([false, true]);

    await runAction(island, "schedule-auto", expandBoard);
    await flush();
    expect(lastAutoUrl()).toBe("/api/v1/stages/s2/schedule/auto");
  });

  /** The single-division board is untouched: pills, no chip, no groups. */
  it("keeps the pill row, and no chip, on a single-division board", () => {
    const tree = renderIsland(ScheduleBoard, baseProps()).tree();

    expect(allWithProp(tree, "data-testid", "schedule-stage-picker")).toHaveLength(0);
    expect(allWithProp(tree, "data-testid", "schedule-stage-group")).toHaveLength(0);
    expect(allWithProp(tree, "data-testid", "schedule-stage")).toHaveLength(2);
  });

  /** The trailing cluster's "Division" caption introduced freeze / publish /
   *  start, which only the single-division board renders. On the comp board
   *  it captioned nothing and sat alone at the right edge. */
  it("renders no 'Division' caption on the comp board", () => {
    const tree = renderIsland(ScheduleBoard, multiDivisionProps(), expandBoard).tree();
    const captions = tree
      .filter((el) => typeof propsOf(el).children === "string")
      .map((el) => propsOf(el).children as string);
    expect(captions).not.toContain("Division");
  });
});
