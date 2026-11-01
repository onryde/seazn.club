// W3 Task 12 Phase 2 (X-SW-17, BG-SW-1) — the panel's half of the Swiss stage controls, driven through the real island:
// the rail gets `swissRounds` (the server's `listSwissRoundControls` row, the stage's rows and two writes) for a Swiss
// stage only; Save PATCHes `{ rounds }` and says the saved count; "Add a round" POSTs and says the round; a refusal from
// the More menu is said in the panel's error line, one from the dialog is not (the dialog says it). And the chess colours
// switch on a boardgame Swiss card: on/off before the first start, fixed after it with its OWN sentence
// (SWISS_CHESS_LOCKED) — never the rounds one, whose recoveries do nothing for a colour change (controller ruling).
//
// Run in English and in French: a non-English locale is the only way a raw English sentence and the localised one
// differ. The expected sentences are that dictionary's own copy, never read off the code under test. Another sport:
// the switch is a chess control, so badminton's Swiss card has none.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { StageRail } from "@/components/v2/desk/stage-rail";
import { ApiV1Error } from "@/lib/client-v1";
import enUi from "@/dictionaries/en/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { SwissRoundControl } from "@/lib/swiss-rounds-edit";
import type { SwissRoundsRail } from "@/components/v2/desk/swiss-rounds-dialog";

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

type Loc = "en" | "fr";
const DICTS: Record<Loc, Record<string, string>> = {
  en: enUi as unknown as Record<string, string>,
  fr: frUi as unknown as Record<string, string>,
};
const active = vi.hoisted(() => ({ locale: "en" as "en" | "fr" }));
const MSG = {
  en: (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS.en as unknown as Dict, key, vars),
  fr: (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS.fr as unknown as Dict, key, vars),
};
const PLURAL = {
  en: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(DICTS.en as unknown as Dict, key, count, "en", vars),
  fr: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(DICTS.fr as unknown as Dict, key, count, "fr", vars),
};
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMsg: () => MSG[active.locale],
  useMsgPlural: () => PLURAL[active.locale],
  useLocaleOrDefault: () => active.locale,
}));
const LOCALES: Loc[] = ["en", "fr"];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

const ENTRANTS = ["e1", "e2", "e3", "e4", "e5", "e6"];
const SWISS = { id: "s1", seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null, status: "active" };
const LEAGUE = { id: "s2", seq: 2, kind: "league", name: "League", config: {}, progression: null, status: "pending" };
const control = (over: Partial<SwissRoundControl> = {}): SwissRoundControl => ({
  started: false,
  rounds: 3,
  chess: true,
  field: 6,
  addRound: { canAddRound: true, refusal: null, field: 6, hardMax: 5 },
  ...over,
});
const base = {
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
  sportKey: "boardgame",
  stages: [SWISS, LEAGUE],
  fixtures: [],
};

const byClass = (tree: ReactElement[], cls: string) =>
  tree.filter((el) => el.type === "p" && String(propsOf(el).className ?? "").includes(cls)).map((el) => textOf(el));
const notices = (tree: ReactElement[]) => byClass(tree, "bg-emerald-50");
const errors = (tree: ReactElement[]) => byClass(tree, "bg-red-50");

async function mount(props: Record<string, unknown>, answer: (path: string, init?: { method?: string; json?: unknown }) => Promise<unknown>) {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation((path: string, init?: { method?: string; json?: unknown }) =>
    init?.method === "PATCH" || String(path).includes("/swiss/add-round") ? answer(path, init) : Promise.resolve({}),
  );
  const island = renderIsland(StagesPanel, { ...base, ...props } as never);
  await flush();
  return island;
}
const railOf = (tree: ReactElement[], stageId: string) =>
  tree.filter((el) => el.type === StageRail).find((el) => (propsOf(el).stage as { id: string }).id === stageId)!;
const writes = () =>
  apiV1Mock.mock.calls.filter(([path, init]) => (init as { method?: string } | undefined)?.method === "PATCH" || String(path).includes("/swiss/add-round"));

describe.each(LOCALES)("StagesPanel — Swiss rounds and chess colours (X-SW-17, BG-SW-1) [%s]", (locale) => {
  const D = DICTS[locale];
  beforeEach(() => {
    active.locale = locale;
  });

  it("the rail gets swissRounds for the Swiss stage only, from the server's row; none without controls (a viewer)", async () => {
    const island = await mount({ swissRoundControls: { s1: control() } }, async () => ({}));
    const swissRail = propsOf(railOf(island.tree(), "s1")).swissRounds as SwissRoundsRail | undefined;
    expect(swissRail?.control, "the server's row, as sent").toEqual(control());
    expect(propsOf(railOf(island.tree(), "s2")).swissRounds, "a league stage has none").toBeUndefined();
    const bare = await mount({}, async () => ({}));
    expect(propsOf(railOf(bare.tree(), "s1")).swissRounds, "no controls read").toBeUndefined();
  });

  it("Save PATCHes { rounds } once and says the saved count; a refusal goes back to the dialog, not the panel's error line", async () => {
    const island = await mount({ swissRoundControls: { s1: control({ rounds: 5 }) } }, async (_p, init) => ({
      rounds: (init?.json as { rounds: number }).rounds,
      chess: true,
      swiss_rounds: { verdict: "ok", recommended: 3, safeMax: 3, hardMax: 5 },
      shells: { added: 0, removed: 6, slots_freed: 0 },
    }));
    const rail = propsOf(railOf(island.tree(), "s1")).swissRounds as SwissRoundsRail;
    expect(await rail.onSave("s1", 3)).toBeNull();
    await flush();
    expect(writes().map(([path, init]) => [path, init])).toEqual([["/api/v1/stages/s1", { method: "PATCH", json: { rounds: 3 } }]]);
    expect(notices(island.tree())).toEqual([fill(D["schedule.notice.roundsSaved.other"]!, { count: 3 })]);

    const refused = await mount({ swissRoundControls: { s1: control() } }, async () => {
      throw new ApiV1Error("server English", 409, "SWISS_ROUNDS_LOCKED", { canFinish: false, canAddRound: true });
    });
    const r = propsOf(railOf(refused.tree(), "s1")).swissRounds as SwissRoundsRail;
    expect(await r.onSave("s1", 2)).toEqual({ code: "SWISS_ROUNDS_LOCKED", extra: { canFinish: false, canAddRound: true }, message: "server English" });
    await flush();
    expect(errors(refused.tree()), "the dialog says it; the panel does not say it twice").toEqual([]);
  });

  it("Add a round POSTs and says the round; refused from the More menu the panel says why, from the dialog it does not", async () => {
    const island = await mount({ swissRoundControls: { s1: control({ started: true }) } }, async () => ({ rounds: 4, shells_added: 3 }));
    const rail = propsOf(railOf(island.tree(), "s1")).swissRounds as SwissRoundsRail;
    expect(await rail.onAddRound("s1", "more")).toBeNull();
    await flush();
    expect(writes().map(([path, init]) => [path, init])).toEqual([["/api/v1/stages/s1/swiss/add-round", { method: "POST", json: {} }]]);
    expect(notices(island.tree())).toEqual([fill(D["schedule.notice.roundAdded"]!, { round: 4 })]);

    const over = async () => {
      throw new ApiV1Error("server English", 422, "SWISS_OVER", { canAddRound: false });
    };
    const fromMore = await mount({ swissRoundControls: { s1: control({ started: true }) } }, over);
    await (propsOf(railOf(fromMore.tree(), "s1")).swissRounds as SwissRoundsRail).onAddRound("s1", "more");
    await flush();
    expect(errors(fromMore.tree())).toEqual([D["swiss.refusal.SWISS_OVER"]]);
    const fromDialog = await mount({ swissRoundControls: { s1: control({ started: true }) } }, over);
    await (propsOf(railOf(fromDialog.tree(), "s1")).swissRounds as SwissRoundsRail).onAddRound("s1", "dialog");
    await flush();
    expect(errors(fromDialog.tree())).toEqual([]);
  });

  it("BG-SW-1 the chess switch: on a boardgame Swiss for an organiser, on/off before the first start, PATCH { chess } on press", async () => {
    const island = await mount({ swissRoundControls: { s1: control({ chess: true }) } }, async () => ({ rounds: 3, chess: false }));
    const sw = island.tree().find((e) => propsOf(e)["data-testid"] === "stage-chess-switch")!;
    expect(sw, "the switch rendered").toBeDefined();
    expect(propsOf(sw).role).toBe("switch");
    expect(propsOf(sw)["aria-checked"]).toBe(true);
    expect(propsOf(sw).disabled).toBe(false);
    expect(textOf(sw)).toContain(D["stage.chess.label"]);
    expect(textOf(sw)).toContain(D["stage.chess.hint"]);
    (propsOf(sw).onClick as () => void)();
    await flush();
    expect(writes().map(([path, init]) => [path, init])).toEqual([["/api/v1/stages/s1", { method: "PATCH", json: { chess: false } }]]);
    expect(notices(island.tree())).toEqual([D["schedule.notice.chessOff"]]);
  });

  it("BG-SW-1 after the first start the switch is fixed and says so in the chess sentence — never the rounds one", async () => {
    const island = await mount({ swissRoundControls: { s1: control({ chess: true, started: true }) } }, async () => ({}));
    const sw = island.tree().find((e) => propsOf(e)["data-testid"] === "stage-chess-switch")!;
    expect(propsOf(sw).disabled).toBe(true);
    expect(propsOf(sw)["aria-checked"], "it still says what is set").toBe(true);
    expect(textOf(sw)).toContain(D["swiss.refusal.SWISS_CHESS_LOCKED"]);
    expect(textOf(sw)).not.toContain(D["swiss.refusal.SWISS_ROUNDS_LOCKED"]);
    expect(D["swiss.refusal.SWISS_CHESS_LOCKED"], "premise: two different sentences").not.toBe(D["swiss.refusal.SWISS_ROUNDS_LOCKED"]);

    // A press that races the first start: the server's SWISS_CHESS_LOCKED is said by ITS code, in the reader's language.
    const raced = await mount({ swissRoundControls: { s1: control({ chess: true }) } }, async () => {
      throw new ApiV1Error("server English", 422, "SWISS_CHESS_LOCKED", {});
    });
    (propsOf(raced.tree().find((e) => propsOf(e)["data-testid"] === "stage-chess-switch")!).onClick as () => void)();
    await flush();
    expect(errors(raced.tree())).toEqual([D["swiss.refusal.SWISS_CHESS_LOCKED"]]);
  });

  it("no chess switch for another sport, for a viewer, without the server's row, or on a league stage", async () => {
    const has = (t: ReactElement[]) => t.some((e) => propsOf(e)["data-testid"] === "stage-chess-switch");
    let checked = 0;
    // The positive pair first, so each absence below is the gate's.
    expect(has((await mount({ swissRoundControls: { s1: control() } }, async () => ({}))).tree())).toBe(true);
    for (const props of [
      { sportKey: "badminton", swissRoundControls: { s1: control() } },
      { canEdit: false, swissRoundControls: { s1: control() } },
      {},
      { stages: [LEAGUE], swissRoundControls: { s2: control() } },
    ]) {
      expect(has((await mount(props, async () => ({}))).tree()), JSON.stringify(Object.keys(props))).toBe(false);
      checked++;
    }
    expect(checked, "anti-vacuity: absent cases").toBe(4);
  });
});
