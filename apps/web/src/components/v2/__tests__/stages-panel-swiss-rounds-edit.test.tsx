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
// W3 T13: the house confirm, answered per case (default: cancelled, as every earlier case here relied on).
const confirmMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<boolean>>(async () => false));
const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => confirmMock,
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
  finish: { canFinish: false, refusal: "nothing_played", finishedAfter: 0, inProgress: false, completeInstead: false },
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
  routerRefresh.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(false);
  apiV1Mock.mockImplementation((path: string, init?: { method?: string; json?: unknown }) =>
    isWrite(path, init) ? answer(path, init) : Promise.resolve({}),
  );
  const island = renderIsland(StagesPanel, { ...base, ...props } as never);
  await flush();
  return island;
}
const railOf = (tree: ReactElement[], stageId: string) =>
  tree.filter((el) => el.type === StageRail).find((el) => (propsOf(el).stage as { id: string }).id === stageId)!;
function isWrite(path: unknown, init: unknown): boolean {
  const p = String(path);
  return (
    (init as { method?: string } | undefined)?.method === "PATCH" ||
    p.includes("/swiss/add-round") ||
    p.includes("/swiss/finish") ||
    p.endsWith("/generate")
  );
}
const writes = () => apiV1Mock.mock.calls.filter(([path, init]) => isWrite(path, init));

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
    // The dialog says the panel's sentence: the rounds one, then only the recovery offered (Phase 2 fix) — this locale's.
    expect(await r.onSave("s1", 2)).toEqual({
      code: "SWISS_ROUNDS_LOCKED",
      extra: { canFinish: false, canAddRound: true },
      text: `${D["swiss.refusal.SWISS_ROUNDS_LOCKED"]} ${D["swiss.rounds.locked.add"]}`,
    });
    await flush();
    expect(errors(refused.tree()), "the dialog says it; the panel does not say it twice").toEqual([]);
    // T12 Fix round 1 (review m4): the desk's read was stale — refreshed, so the chip turns fixed and More offers Add a round.
    expect(routerRefresh, "a refusal refreshes the desk").toHaveBeenCalledTimes(1);
  });

  it("Save says the scheduled slots the removed rounds freed, as a Rebuild does — and nothing more when none (review m3)", async () => {
    let checked = 0;
    for (const [freed, form] of [
      [1, "one"],
      [2, "other"],
    ] as const) {
      const island = await mount({ swissRoundControls: { s1: control({ rounds: 5 }) } }, async () => ({
        rounds: 3,
        chess: true,
        swiss_rounds: null,
        shells: { added: 0, removed: 6, slots_freed: freed },
      }));
      await (propsOf(railOf(island.tree(), "s1")).swissRounds as SwissRoundsRail).onSave("s1", 3);
      await flush();
      expect(notices(island.tree()), `${freed} freed`).toEqual([
        `${fill(D["schedule.notice.roundsSaved.other"]!, { count: 3 })} ${fill(D[`schedule.notice.roundsSlotsFreed.${form}`]!, { count: freed })}`,
      ]);
      checked++;
    }
    expect(checked, "anti-vacuity: both plural forms").toBe(2);
  });

  it("a frozen timetable or a match's own format is said in this locale on every door — never the server's English (review m1)", async () => {
    let checked = 0;
    for (const [code, extra, said] of [
      ["SCHEDULE_LOCKED", {}, D["stage.error.scheduleFrozen"]!],
      [
        "FIXTURE_HAS_OWN_FORMAT",
        { fixture_id: "f7", fixture_no: 7 },
        fill(D["rules.err.fixtureHasOwnFormat"]!, { match: fill(D["rules.err.match"]!, { n: 7 }) }),
      ],
    ] as const) {
      const refuse = async () => {
        throw new ApiV1Error("server English", code === "SCHEDULE_LOCKED" ? 422 : 409, code, { ...extra });
      };
      // The dialog's Save: handed back for the dialog to say.
      const save = await mount({ swissRoundControls: { s1: control({ rounds: 5 }) } }, refuse);
      expect(await (propsOf(railOf(save.tree(), "s1")).swissRounds as SwissRoundsRail).onSave("s1", 3), `${code} Save`).toEqual({
        code,
        extra,
        text: said,
      });
      // More → Add a round, and the chess switch: said in the panel's own error line.
      const more = await mount({ swissRoundControls: { s1: control({ started: true }) } }, refuse);
      await (propsOf(railOf(more.tree(), "s1")).swissRounds as SwissRoundsRail).onAddRound("s1", "more");
      await flush();
      expect(errors(more.tree()), `${code} Add a round`).toEqual([said]);
      const chess = await mount({ swissRoundControls: { s1: control({ chess: true }) } }, refuse);
      (propsOf(chess.tree().find((e) => propsOf(e)["data-testid"] === "stage-chess-switch")!).onClick as () => void)();
      await flush();
      expect(errors(chess.tree()), `${code} chess`).toEqual([said]);
      expect(said, "premise: not the server's words").not.toContain("server English");
      checked++;
    }
    expect(checked, "anti-vacuity: codes").toBe(2);
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

  // -------------------------------------------------------------------------------------------------------------------
  // W3 T13 (RB3-20, X-SW-26) — Finish the Swiss now: the More item's write, and the recovery under a red line.
  // -------------------------------------------------------------------------------------------------------------------

  it("W3 T13 Finish confirms first, in this locale, with what goes (danger); cancelled nothing is sent; confirmed it POSTs once and says the round", async () => {
    const finished = { completed: true, events: [], finished_after: 3, shells_removed: 6, slots_freed: 0 };
    const island = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 5 }) } }, async () => finished);
    const rail = propsOf(railOf(island.tree(), "s1")).swissRounds as SwissRoundsRail;
    // Cancelled: nothing sent, nothing said.
    expect(await rail.onFinish("s1", { after: 3, rounds: 5 })).toBeNull();
    await flush();
    expect(writes(), "cancelled: nothing sent").toEqual([]);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      title: D["stage.finish.confirm.title"],
      body: [
        fill(D["stage.finish.confirm.final"]!, { round: 3 }),
        fill(D["stage.finish.confirm.removeMany"]!, { from: 4, to: 5 }),
        D["swiss.refusal.SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"],
      ].join(" "),
      confirmLabel: D["stage.finish.confirm.label"],
      tone: "danger",
    });
    // Confirmed: one POST, the round said.
    confirmMock.mockResolvedValueOnce(true);
    expect(await rail.onFinish("s1", { after: 3, rounds: 5 })).toBeNull();
    await flush();
    expect(writes().map(([path, init]) => [path, init])).toEqual([["/api/v1/stages/s1/swiss/finish", { method: "POST", json: {} }]]);
    expect(notices(island.tree())).toEqual([fill(D["schedule.notice.swissFinished"]!, { round: 3 })]);
    expect(routerRefresh).toHaveBeenCalled();

    // Slots the removed rounds held are said, as a Rebuild says them.
    const freed = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 5 }) } }, async () => ({ ...finished, slots_freed: 2 }));
    confirmMock.mockResolvedValueOnce(true);
    await (propsOf(railOf(freed.tree(), "s1")).swissRounds as SwissRoundsRail).onFinish("s1", { after: 3, rounds: 5 });
    await flush();
    expect(notices(freed.tree())).toEqual([
      `${fill(D["schedule.notice.swissFinished"]!, { round: 3 })} ${fill(D["schedule.notice.roundsSlotsFreed.other"]!, { count: 2 })}`,
    ]);
  });

  it("W3 T13 the confirm's body for one removed round, and for none (every round played)", async () => {
    const island = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 4 }) } }, async () => ({}));
    const rail = propsOf(railOf(island.tree(), "s1")).swissRounds as SwissRoundsRail;
    await rail.onFinish("s1", { after: 3, rounds: 4 });
    await rail.onFinish("s1", { after: 4, rounds: 4 });
    expect(confirmMock.mock.calls.map(([o]) => (o as { body: string }).body)).toEqual([
      [fill(D["stage.finish.confirm.final"]!, { round: 3 }), fill(D["stage.finish.confirm.removeOne"]!, { round: 4 }), D["swiss.refusal.SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"]].join(" "),
      fill(D["stage.finish.confirm.final"]!, { round: 4 }),
    ]);
  });

  it("W3 T13 a refused Finish is said in the panel's error line, in this locale, naming the boards still to decide", async () => {
    const island = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 5 }) } }, async () => {
      throw new ApiV1Error("server English", 409, "SWISS_FINISH_ROUND_UNDECIDED", {
        canFinish: false,
        boards: [
          { fixtureId: "f1", round: 4, board: 1 },
          { fixtureId: "f2", round: 4, board: 3 },
        ],
      });
    });
    confirmMock.mockResolvedValueOnce(true);
    await (propsOf(railOf(island.tree(), "s1")).swissRounds as SwissRoundsRail).onFinish("s1", { after: 3, rounds: 5 });
    await flush();
    const ref = (board: number) => fill(D["schedule.error.swissAbandonedRef"]!, { round: 4, board });
    expect(errors(island.tree())).toEqual([
      `${D["swiss.refusal.SWISS_FINISH_ROUND_UNDECIDED"]} ${fill(D["swiss.finish.owed"]!, { boards: `${ref(1)}, ${ref(3)}` })}`,
    ]);
    expect(island.tree().some((e) => propsOf(e)["data-testid"] === "schedule-finish-swiss"), "no Finish under its own refusal").toBe(false);
  });

  it("W3 T13 a Pair refused 409 with canFinish puts Finish under the red line; it confirms the refusal's plan; a refusal without it has none", async () => {
    const shrunk = (extra: Record<string, unknown>) => async () => {
      throw new ApiV1Error("server English", 409, "SWISS_ROUNDS_ABOVE_MAX", { rounds: 5, field: 4, hardMax: 3, ...extra });
    };
    const finishBtn = (t: ReactElement[]) => t.find((e) => propsOf(e)["data-testid"] === "schedule-finish-swiss");
    const offered = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 5 }) } }, shrunk({ canFinish: true, finish: { after: 3, rounds: 5 } }));
    await (propsOf(railOf(offered.tree(), "s1")).onAct as (id: string, a: string) => Promise<boolean>)("s1", "generate");
    await flush();
    expect(errors(offered.tree()), "the shrunk sentence").toEqual([
      `${D["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]} ${fill(D["swiss.rounds.shrunk.other"]!, { field: 4, count: 3 })}`,
    ]);
    expect(textOf(finishBtn(offered.tree())!)).toBe(D["stage.more.finishSwiss"]);
    (propsOf(finishBtn(offered.tree())!).onClick as () => void)();
    await flush();
    expect((confirmMock.mock.calls[0]![0] as { body: string }).body, "the refusal's plan: after 3 of 5").toContain(
      fill(D["stage.finish.confirm.removeMany"]!, { from: 4, to: 5 }),
    );
    // The SEQUENCE: the next Pair refused for another reason (no Swiss refusal) — its line, and no stale Finish under it.
    apiV1Mock.mockImplementation((path: string) =>
      String(path).endsWith("/generate")
        ? Promise.reject(new ApiV1Error("server English", 409, "STAGE_NOT_READY", { stageId: "s1" }))
        : Promise.resolve({}),
    );
    await (propsOf(railOf(offered.tree(), "s1")).onAct as (id: string, a: string) => Promise<boolean>)("s1", "generate");
    await flush();
    expect(errors(offered.tree()), "premise: another line").toHaveLength(1);
    expect(errors(offered.tree())[0], "premise: not the shrunk sentence").not.toContain(D["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]!);
    expect(finishBtn(offered.tree()), "the Finish offer went with its line").toBeUndefined();

    const withheld = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 5 }) } }, shrunk({ canFinish: false }));
    await (propsOf(railOf(withheld.tree(), "s1")).onAct as (id: string, a: string) => Promise<boolean>)("s1", "generate");
    await flush();
    expect(errors(withheld.tree()), "premise: refused").toHaveLength(1);
    expect(finishBtn(withheld.tree()), "canFinish false: no button that would only be refused").toBeUndefined();
  });

  it("W3 T13 Fix round 1 (review I1): a Swiss refusal said in the panel closes the phone's Stage-tools sheet, so its line and Finish show", async () => {
    const isOpen = (island: Awaited<ReturnType<typeof mount>>) => propsOf(railOf(island.tree(), "s1")).open as boolean;
    const openSheet = async (island: Awaited<ReturnType<typeof mount>>) => {
      (propsOf(railOf(island.tree(), "s1")).onToggleOpen as (id: string) => void)("s1");
      await flush();
      expect(isOpen(island), "premise: the sheet is open").toBe(true);
    };
    // Pair next pressed inside the sheet, refused with Finish offered.
    const paired = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 5 }) } }, async () => {
      throw new ApiV1Error("server English", 409, "SWISS_ROUNDS_ABOVE_MAX", { rounds: 5, field: 4, hardMax: 3, canFinish: true, finish: { after: 3, rounds: 5 } });
    });
    await openSheet(paired);
    await (propsOf(railOf(paired.tree(), "s1")).onAct as (id: string, a: string) => Promise<boolean>)("s1", "generate");
    await flush();
    expect(paired.tree().some((e) => propsOf(e)["data-testid"] === "schedule-finish-swiss"), "premise: Finish offered").toBe(true);
    expect(isOpen(paired), "the sheet closed over the refusal").toBe(false);
    // Add a round pressed from More (the panel says its refusal): the same.
    const added = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 3 }) } }, async () => {
      throw new ApiV1Error("server English", 409, "SWISS_ROUNDS_ABOVE_MAX", { rounds: 4, field: 4, hardMax: 3, canFinish: true, finish: { after: 3, rounds: 3 } });
    });
    await openSheet(added);
    await (propsOf(railOf(added.tree(), "s1")).swissRounds as SwissRoundsRail).onAddRound("s1", "more");
    await flush();
    expect(errors(added.tree()), "premise: refused in the panel").toHaveLength(1);
    expect(isOpen(added), "the sheet closed over the refusal").toBe(false);
  });

  it("W3 T13 Fix round 1: a Finish that did not complete the stage says so (m5); the backstop's STAGE_NOT_READY is said in this locale (I2)", async () => {
    const open = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 5 }) } }, async () => ({
      completed: false,
      events: [],
      finished_after: 3,
      shells_removed: 4,
      slots_freed: 0,
    }));
    confirmMock.mockResolvedValueOnce(true);
    await (propsOf(railOf(open.tree(), "s1")).swissRounds as SwissRoundsRail).onFinish("s1", { after: 3, rounds: 5 });
    await flush();
    expect(notices(open.tree())).toEqual([fill(D["schedule.notice.swissFinishedOpen"]!, { round: 3 })]);

    const backstop = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 5 }) } }, async () => {
      throw new ApiV1Error("swiss: rounds 1..3 do not complete the stage", 422, "STAGE_NOT_READY", { stageId: "s1" });
    });
    confirmMock.mockResolvedValueOnce(true);
    await (propsOf(railOf(backstop.tree(), "s1")).swissRounds as SwissRoundsRail).onFinish("s1", { after: 3, rounds: 5 });
    await flush();
    expect(errors(backstop.tree())).toEqual([D["stage.finish.notReady"]]);
  });

  it("W3 T13 Add a round at the hard maximum from More, with canFinish: Finish under the panel's line; the next write's line drops it", async () => {
    const island = await mount({ swissRoundControls: { s1: control({ started: true, rounds: 3 }) } }, async () => {
      throw new ApiV1Error("server English", 409, "SWISS_ROUNDS_ABOVE_MAX", { rounds: 4, field: 4, hardMax: 3, canFinish: true, finish: { after: 3, rounds: 3 } });
    });
    const rail = propsOf(railOf(island.tree(), "s1")).swissRounds as SwissRoundsRail;
    await rail.onAddRound("s1", "more");
    await flush();
    const has = () => island.tree().some((e) => propsOf(e)["data-testid"] === "schedule-finish-swiss");
    expect(has(), "offered under the line").toBe(true);
    await rail.onAddRound("s1", "dialog"); // the dialog's door says nothing in the panel: the line clears
    await flush();
    expect(errors(island.tree())).toEqual([]);
    expect(has(), "gone with its line").toBe(false);
  });
});
