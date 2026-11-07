// W4 T21 (AN-1, X-CH-8; owner pick R24 4A, ruling 273): completing a competition WARNS, never refuses. An inline warning
// under the Status select appears the moment "completed" is chosen — before Save, and Save is never blocked — listing
// every open stage with what it waits for, and offering Complete stage (the existing route) where nothing but the
// completion is left. Prod held a completed competition whose knockout final was decided and whose stage was never
// completed, so its bracket never ranked; nothing on the way to "completed" said so.
//
// vitest runs `environment: "node"` with no jsdom, so both islands are driven through the shared hook harness
// (_hook-harness.tsx). The settings island does not expand its children, so it is asked WHETHER it mounts the warning
// (and with what), and the warning island is driven on its own.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { CompetitionSettings } from "../competition-settings";
import { OpenStagesWarning } from "../open-stages-warning";
import { apiV1 } from "@/lib/client-v1";
import { plural, t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { OPEN_STAGE_STATES, type OpenStageRow } from "@/lib/open-stages";

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

const dict = uiEn as unknown as Dict;
const say = (key: string, vars?: Record<string, string | number>) => t(dict, key, vars);
const sayN = (key: string, n: number, vars?: Record<string, string | number>) => plural(dict, key, n, "en", vars);

const STAGES: OpenStageRow[] = [
  { stageId: "s-ko", divisionName: "Men's Singles A", seq: 1, stageName: "Knockout", state: "final_decided", matchesLeft: 0 },
  { stageId: "s-wd", divisionName: "Women's Doubles", seq: 2, stageName: "Knockout", state: "final_pending", matchesLeft: 3 },
  { stageId: "s-bd", divisionName: "Boys' Doubles", seq: 1, stageName: "Knockout", state: "final_held", matchesLeft: 1 },
  { stageId: "s-mx", divisionName: "Mixed Doubles", seq: 1, stageName: "League", state: "matches_left", matchesLeft: 3 },
  { stageId: "s-vt", divisionName: "Veterans", seq: 1, stageName: "League", state: "all_played", matchesLeft: 0 },
  { stageId: "s-jr", divisionName: "Juniors", seq: 1, stageName: "League", state: "no_matches", matchesLeft: 0 },
];

const mount = (
  o: { status?: string; openStages?: OpenStageRow[]; canEdit?: boolean; frozen?: boolean; suggestedStatus?: string | null } = {},
) =>
  renderIsland(CompetitionSettings, {
    competition: {
      id: "c1", name: "Harbourside Open", slug: "harbourside-open", description: null,
      starts_on: "2026-06-01", ends_on: "2026-08-31", visibility: "private", status: o.status ?? "live",
      frozen: o.frozen ?? false, discoverable: false, discovery: {}, branding: {},
    },
    orgId: "o1",
    canEdit: o.canEdit ?? true,
    discoveryBranding: false,
    viewerPlan: "pro",
    suggestedStatus: o.suggestedStatus ?? null,
    openStages: o.openStages ?? STAGES,
  });

const STATUSES = ["draft", "published", "live", "completed", "archived"];
const statusSelect = (tree: ReactElement[]) =>
  tree.find((el) => el.type === "select" && STATUSES.includes(propsOf(el).value as string))!;
const choose = (island: ReturnType<typeof mount>, value: string) =>
  (propsOf(statusSelect(island.tree())).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const warningOf = (tree: ReactElement[]) => tree.find((el) => el.type === OpenStagesWarning);
/** The click handler fires its request and returns (`onClick={() => void complete(id)}`): let it settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = async (el: ReactElement) => {
  (propsOf(el).onClick as () => void)();
  await flush();
};

beforeEach(() => {
  api.mockReset();
  refresh.mockReset();
});

describe("CompetitionSettings — completing warns about open stages, and never blocks Save (X-CH-8)", () => {
  it("premise: the copy is real — every key the warning reads is in the English catalog", () => {
    const keys = [
      "compset.openStages.heading.one", "compset.openStages.heading.other", "compset.openStages.body", "compset.openStages.row",
      "compset.openStages.completeFailed", "schedule.complete", "schedule.notice.notReady",
      ...OPEN_STAGE_STATES.flatMap((s) => (s === "matches_left" ? [`compset.openStages.state.${s}.one`, `compset.openStages.state.${s}.other`] : [`compset.openStages.state.${s}`])),
    ];
    let checked = 0;
    for (const k of keys) {
      expect(Object.hasOwn(uiEn, k), k).toBe(true);
      checked++;
    }
    expect(checked).toBe(keys.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("empty case first: no open stages — no warning, even with 'completed' chosen", () => {
    const island = mount({ openStages: [] });
    choose(island, "completed");
    expect(warningOf(island.tree())).toBeUndefined();
  });

  it("appears the moment 'completed' is chosen, before any save, listing every open stage", () => {
    const island = mount({ status: "live" });
    expect(warningOf(island.tree()), "live: no warning").toBeUndefined();
    choose(island, "completed");
    const w = warningOf(island.tree());
    expect(w, "completed chosen: the warning mounts").toBeDefined();
    expect(propsOf(w!).stages).toEqual(STAGES);
    expect(propsOf(w!).canComplete).toBe(true);
    expect(api, "nothing was saved to show it").not.toHaveBeenCalled();
    // Choosing another status takes it away again — it follows the form, not the saved row.
    choose(island, "archived");
    expect(warningOf(island.tree())).toBeUndefined();
  });

  it("AN-1's own shape: a competition SAVED as completed with a stage still open shows it on arrival", () => {
    expect(warningOf(mount({ status: "completed" }).tree())).toBeDefined();
  });

  it("the suggestion's one-tap 'Set to Completed' never waits for Save, so the warning shows beside it", () => {
    const island = mount({ status: "live", suggestedStatus: "completed" });
    expect(warningOf(island.tree())).toBeDefined();
    // The positive pair: a suggestion of anything else says nothing about open stages.
    expect(warningOf(mount({ status: "draft", suggestedStatus: "published" }).tree())).toBeUndefined();
  });

  it("Save is never blocked: with the warning on screen, Save still sends status 'completed'", async () => {
    api.mockResolvedValue({});
    const island = mount({ status: "live" });
    choose(island, "completed");
    expect(warningOf(island.tree())).toBeDefined();
    const form = island.tree().find((el) => el.type === "form")!;
    await (propsOf(form).onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
    expect(api).toHaveBeenCalledTimes(1);
    const [path, init] = api.mock.calls[0]! as [string, { method: string; json: { status: string } }];
    expect(path).toBe("/api/v1/competitions/c1");
    expect(init.method).toBe("PATCH");
    expect(init.json.status).toBe("completed");
  });

  it("who may act: a viewer who cannot edit sees no warning; a frozen competition warns but offers no Complete stage", () => {
    expect(warningOf(mount({ status: "completed", canEdit: false }).tree())).toBeUndefined();
    const frozen = warningOf(mount({ status: "completed", frozen: true }).tree());
    expect(frozen).toBeDefined();
    expect(propsOf(frozen!).canComplete).toBe(false);
  });

  it("the Status select is DESCRIBED by the warning while it shows", () => {
    const island = mount({ status: "completed" });
    const w = warningOf(island.tree())!;
    expect(propsOf(statusSelect(island.tree()))["aria-describedby"]).toBe(propsOf(w).id);
  });
});

describe("OpenStagesWarning — the list itself", () => {
  const warn = (stages: OpenStageRow[] = STAGES, canComplete = true) =>
    renderIsland(OpenStagesWarning, { id: "w", stages, canComplete });
  const completeButtons = (tree: ReactElement[]) =>
    tree.filter((el) => el.type === "button" && propsOf(el)["data-complete-stage"] !== undefined);

  it("states the count, says Save still works, and names each stage as '<division> · <n>. <stage>' with what it waits for", () => {
    const text = warn().text();
    expect(text).toContain(sayN("compset.openStages.heading", STAGES.length));
    expect(text).toContain(say("compset.openStages.body"));
    let checked = 0;
    for (const s of STAGES) {
      expect(text).toContain(say("compset.openStages.row", { division: s.divisionName, seq: s.seq, stage: s.stageName }));
      const line =
        s.state === "matches_left"
          ? sayN("compset.openStages.state.matches_left", s.matchesLeft)
          : say(`compset.openStages.state.${s.state}`);
      expect(text, s.state).toContain(line);
      checked++;
    }
    expect(checked).toBe(STAGES.length);
    // Every state the read can return has a row above (anchored on the declaration, not on this table).
    expect(new Set(STAGES.map((s) => s.state))).toEqual(new Set(OPEN_STAGE_STATES));
    // One stage reads singular.
    expect(warn([STAGES[0]!]).text()).toContain(sayN("compset.openStages.heading", 1));
  });

  it("offers Complete stage only where nothing but the completion is left — and never when it may not act", () => {
    const buttons = completeButtons(warn().tree());
    expect(buttons.map((b) => propsOf(b)["data-complete-stage"])).toEqual(["s-ko", "s-vt"]);
    expect(completeButtons(warn(STAGES, false).tree())).toEqual([]);
  });

  it("the Complete stage button is a full phone tap target, like the fixtures tab's own (min-h-11)", () => {
    const buttons = completeButtons(warn().tree());
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(String(propsOf(b).className).split(/\s+/)).toContain("min-h-11");
  });

  it("Complete stage POSTs the existing complete route for THAT stage, then refreshes the page", async () => {
    api.mockResolvedValue({ completed: true });
    const island = warn();
    const [first] = completeButtons(island.tree());
    await click(first!);
    expect(api).toHaveBeenCalledWith("/api/v1/stages/s-ko/complete", { method: "POST", json: {} });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a stage the server will not complete yet says so, in the reader's language; a failure says what to do", async () => {
    api.mockResolvedValueOnce({ completed: false });
    const island = warn();
    await click(completeButtons(island.tree())[0]!);
    expect(island.text()).toContain(say("schedule.notice.notReady"));
    expect(refresh).not.toHaveBeenCalled();
    api.mockRejectedValueOnce(new Error("boom"));
    await click(completeButtons(island.tree())[0]!);
    expect(island.text()).toContain(say("compset.openStages.completeFailed"));
    expect(island.text()).not.toContain("boom");
  });
});
