// W2d T16 fix round 1, review I1: the points editor's draft FOLLOWS the props it is read from. It is driven through the real
// component's state (the node-env hook harness, `renderIsland`). A static render cannot see this, because it renders the
// first draft and nothing after (AGENTS.md class 2).
//
// The failure it pins: the draft was seeded once (`useState(() => …)`) and the section is not re-keyed, so a format save on
// the same card refreshed the stage's `rules` (best of 5 → 3) while the boxes kept best of 5's set scores. After the
// untick, the 2-0 / 2-1 boxes then opened BLANK: carry I1's blank volleyball editor through a sibling door.
//
// Both directions (class 13): a refresh that changes nothing the draft is read from keeps a dirty draft. Expected values are
// the engine's (`reachableOutcomes`, `tablePointsRule` over the stage's live cfg), never the model's.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";
import { reachableOutcomes } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { liveStageCfg } from "@/lib/stage-decider-off";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { StagePoints, type StagePointsProps } from "../../rules/points-editor";

vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: () => Promise.reject(new Error("this test saves nothing")),
}));

const volleyball = builtinModules.find((m) => m.key === "volleyball") as AnySportModule;
const ID = "11111111-1111-4111-8111-111111111111";
const DIVISION = volleyball.configSchema.parse(volleyball.variants.indoor) as Record<string, unknown>;
type Props = StagePointsProps;

const props = (stageConfig: Record<string, unknown>, over: Partial<Props> = {}): Props => ({
  stageId: ID,
  module: volleyball,
  kind: "league",
  stageConfig,
  divisionConfig: DIVISION,
  stored: (stageConfig as { points?: unknown }).points ?? null,
  pointsDict: undefined,
  scope: "stage",
  mode: "edit",
  started: false,
  onSaved: () => undefined,
  ...over,
});

/** The set scores a league stage under `stageConfig` reaches, and what the sport pays each, from the engine. */
function engineSets(stageConfig: Record<string, unknown>): Record<string, [number, number]> {
  const cfg = volleyball.configSchema.parse(liveStageCfg(DIVISION, { kind: "league", config: stageConfig }, volleyball));
  const scores = [...reachableOutcomes(volleyball, cfg, "league")].filter((k) => k.startsWith("set:")).map((k) => k.slice(4));
  const paid = volleyball.tablePointsRule(cfg, "league").bySetScore ?? {};
  return Object.fromEntries(scores.map((s) => [s, (paid[s] ?? paid["*"]) as [number, number]]));
}

const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined =>
  tree.find((e) => propsOf(e)["data-testid"] === id || propsOf(e).testId === id);
const setBoxes = (tree: ReactElement[]): Record<string, string> =>
  Object.fromEntries(
    tree
      .filter((e) => typeof propsOf(e).testId === "string" && /^stage-points-set-.+-[wl]$/.test(propsOf(e).testId as string))
      .map((e) => [propsOf(e).testId as string, propsOf(e).value as string]),
  );
const boxesFor = (sets: Record<string, [number, number]>): Record<string, string> =>
  Object.fromEntries(Object.entries(sets).flatMap(([s, [w, l]]) => [[`stage-points-set-${s}-w`, String(w)], [`stage-points-set-${s}-l`, String(l)]]));
function untick(island: ReturnType<typeof renderIsland<Props>>): void {
  const box = byTestId(island.tree(), "stage-points-use-division");
  expect(box, "the inherit checkbox").toBeDefined();
  island.batch(() => (propsOf(box!).onChange as (e: unknown) => void)({ target: { checked: false } }));
}

describe("review I1: the points draft re-seeds when the stage's rows change under it", () => {
  const BO3 = { rules: { bestOf: 3 } };

  it("premise: best of 3 and best of 5 reach DIFFERENT set scores (the right answer differs from the stale one)", () => {
    const five = Object.keys(engineSets({}));
    const three = Object.keys(engineSets(BO3));
    expect(five.length, "best of 5's scores").toBeGreaterThan(0);
    expect(three.length, "best of 3's scores").toBeGreaterThan(0);
    expect(three.filter((s) => five.includes(s)), "no score in common").toEqual([]);
  });

  it("a format save (best of 5 → 3) then the untick: the boxes hold the engine's 2-0 / 2-1 points, never blank, and no 3-x box is left", () => {
    const island = renderIsland(StagePoints, props({}));
    untick(island);
    expect(setBoxes(island.tree()), "best of 5: its own set scores").toEqual(boxesFor(engineSets({})));
    // Back to inheriting, then the stage's format row saves best of 3: the page refreshes, the card is not re-keyed.
    island.batch(() => (propsOf(byTestId(island.tree(), "stage-points-use-division")!).onChange as (e: unknown) => void)({ target: { checked: true } }));
    island.rerender(props(BO3));
    untick(island);
    const boxes = setBoxes(island.tree());
    const expected = boxesFor(engineSets(BO3));
    expect(Object.keys(expected).length, "checked: best of 3's boxes").toBeGreaterThan(0);
    expect(boxes, "best of 3's scores at the engine's points").toEqual(expected);
    expect(Object.values(boxes).filter((v) => v === ""), "no blank box").toEqual([]);
    expect(byTestId(island.tree(), "stage-points-refusal"), "nothing uncovered").toBeUndefined();
  });

  it("the second direction: a refresh that changes nothing the draft reads (a fresh but equal props object) keeps a typed, dirty draft", () => {
    const island = renderIsland(StagePoints, props(BO3));
    untick(island);
    const [first] = Object.keys(engineSets(BO3));
    const id = `stage-points-set-${first}-w`;
    island.batch(() => (propsOf(byTestId(island.tree(), id)!).onChange as (raw: string) => void)("9"));
    expect(propsOf(byTestId(island.tree(), id)!).value).toBe("9");
    island.rerender(props(structuredClone(BO3), { divisionConfig: structuredClone(DIVISION) }));
    expect(propsOf(byTestId(island.tree(), id)!).value, "the organiser's typed number survives the refresh").toBe("9");
    expect(propsOf(byTestId(island.tree(), "stage-points-use-division")!).checked, "still editing its own").toBe(false);
  });

  it("a points save elsewhere (a new stored rule) re-seeds the draft to it", () => {
    const island = renderIsland(StagePoints, props(BO3));
    const own = { ...volleyball.tablePointsRule(volleyball.configSchema.parse(liveStageCfg(DIVISION, { kind: "league", config: BO3 }, volleyball)), "league") };
    const sets = engineSets(BO3);
    const [first] = Object.keys(sets);
    const bySetScore = { ...own.bySetScore, [first!]: [5, 4] as [number, number] };
    island.rerender(props({ ...BO3, points: { ...own, bySetScore } }));
    expect(propsOf(byTestId(island.tree(), "stage-points-use-division")!).checked, "the stage now has its own rule").toBe(false);
    expect(propsOf(byTestId(island.tree(), `stage-points-set-${first}-w`)!).value).toBe("5");
    expect(propsOf(byTestId(island.tree(), `stage-points-set-${first}-l`)!).value).toBe("4");
  });
});
