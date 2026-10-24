// The Arbiter Panel's MOUNT of the round column (spec 2026-10-24-arbiter-round-column-design.md §5.1, §5.2; plan Task 8): what the
// panel hands the column, the waiting list and the decision area, and what a press does on the way back.
//
// arbiter-panel.test.tsx reads MARKUP (`renderToStaticMarkup`: no DOM, no clicks). This file drives the seams markup cannot see
// (AGENTS recurring classes 1 and 2) through the hook harness (`renderIsland`, no DOM in this workspace), one level at a time:
//
//     ArbiterPanel  ->  ArbiterScreen  ->  RoundColumn / WaitingList  ->  RoundQueueCards / CheckinHero / a row's button
//
// Each hop re-renders the child island from the props its parent really handed it, so a press at the bottom runs the panel's own
// reducers and the panel's own `useOpenRound`, with the network doubled at `apiV1`. The clock is the one thing faked: `useExtendClock`
// answers a fixed instant, and `band-poll` is stubbed (it reaches for `document`).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, walk, type Props } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { ArbiterBoard, ArbiterFlag, ArbiterRound } from "@/lib/arbiter-view";
import { CHECKIN_EXTEND_MAX, emptyExtendTally, type CheckinExtendState } from "@/lib/checkin-extend";
import type { Dict } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { OpenRoundPairing, OpenRoundView } from "@/lib/open-round";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import type { NeedsOrganiserExternalPlayRow } from "@/server/usecases/external-play/queue";
import { ConfirmDialog } from "../confirm-dialog";
import { extendBoardPath } from "../checkin-extend-ui";
import { ArbiterPanel, ArbiterScreen, type ArbiterScreenProps } from "../arbiter-panel";
import { CheckinHero, RoundColumn, WaitingList, type RoundColumnData } from "../arbiter/round-column";
import { RoundQueueCards } from "../arbiter/round-queue-cards";
import { useOpenRound } from "../desk/use-open-round";
import { useExtendClock } from "../use-extend-clock";

const NOW = vi.hoisted(() => Date.parse("2026-10-24T12:00:00.000Z"));
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

type Call = { url: string; json?: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    // Each request waits until the test answers it: "in flight" is a real state here.
    apiV1: (url: string, options?: { json?: unknown }) =>
      new Promise((resolve, reject) => net.calls.push({ url, json: options?.json, resolve, reject })),
  };
});

// The panel's effects: polling reaches for `document`, the clock is a timer. Neither is under test.
vi.mock("../desk/band-poll", () => ({ browserBandPollDeps: () => ({}), startBandPolling: () => () => undefined }));
vi.mock("../use-extend-clock", () => ({ useExtendClock: vi.fn(() => NOW) }));
// The hook the panel calls ONCE for the round on screen (C9): the real hook, wrapped in a spy so its arguments and results are readable.
vi.mock("../desk/use-open-round", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desk/use-open-round")>();
  return { ...actual, useOpenRound: vi.fn(actual.useOpenRound) };
});
// `useFmt` (the screen's formatter) needs a DictProvider; the harness has none, so the lookups are the English dictionary's own.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(enUi as unknown as Dict, key, vars),
    usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(enUi as unknown as Dict, key, count, "en", vars),
    useLocale: () => "en",
  };
});

const EN = enUi as Record<string, string>;
const SLUGS = { org: "club", comp: "autumn", div: "open" };

// ---- fixtures: boards that never join a camera (`cameraPolicy: "off"`), so no effect reaches for `window` -----------------------

function boardOf(fixtureId: string, boardNo: number, over: Partial<ArbiterBoard> = {}): ArbiterBoard {
  return {
    fixtureId,
    fixtureNo: boardNo + 10,
    boardNo,
    white: { name: `White ${boardNo}`, personId: null },
    black: { name: `Black ${boardNo}`, personId: null },
    state: { kind: "live", moveNo: 5 },
    clock: null,
    cameraPolicy: "off",
    videoOverridden: false,
    cameraReport: null,
    sides: { home: { state: "none", endedAt: null, evidenceAt: null }, away: { state: "none", endedAt: null, evidenceAt: null } },
    canResync: false,
    playable: true,
    canSettle: false,
    whiteSide: "home",
    tiebreakOwed: false,
    noResultOffer: { kind: "void" },
    checkin: null,
    seats: null,
    flags: [],
    ...over,
  };
}
const FLAG: ArbiterFlag = { id: "fl-1", kind: "out_of_band_play", at: iso(NOW - 5 * MIN), plies: null };
/** Opened ten minutes ago, closes in eight: NOW is inside it. */
const WINDOW: CheckinExtendState = { canExtend: true, refusal: null, extensionsLeft: CHECKIN_EXTEND_MAX, opensAt: iso(NOW - 10 * MIN), deadlineAt: iso(NOW + 8 * MIN) };
const SEATS = { white: { here: false, invites: ["sent" as const] }, black: { here: true, invites: [] } };
const checkingIn = (id: string, no: number) => boardOf(id, no, { state: { kind: "checking_in" }, checkin: WINDOW, seats: SEATS });
const finished = (id: string, no: number) => boardOf(id, no, { state: { kind: "result", score: "1-0", noResult: false }, playable: false, flags: [FLAG] });

const ROUND = (boards: ArbiterBoard[], over: Partial<ArbiterRound> = {}): ArbiterRound => ({
  stageId: "st1",
  stageName: "Open Swiss",
  roundNo: 3,
  timeControl: "10+5",
  boards,
  ownBoards: 0,
  current: true,
  extendableBoards: 0,
  ...over,
});
/** Round 3 in check-in: f1 live, f2 finished (flagged), f4 and f6 checking in (white not here), f5 on hold. */
const CK_ROUND = () => ROUND([boardOf("f1", 1), finished("f2", 2), checkingIn("f4", 4), boardOf("f5", 5, { state: { kind: "on_hold" } }), checkingIn("f6", 6)], { extendableBoards: 2 });
/** The same round once every check-in has ended: f4 and f6 now play. */
const PLAYING = () => ROUND([boardOf("f1", 1), finished("f2", 2), boardOf("f4", 4), boardOf("f5", 5, { state: { kind: "on_hold" } }), boardOf("f6", 6)]);

const pairing = (fixtureId: string, boardNo: number): OpenRoundPairing => ({ fixtureId, boardNo, whiteName: `White ${boardNo}`, blackName: `Black ${boardNo}`, invitedAt: iso(NOW - 10 * MIN), owedSeats: 1, canResend: true });
const VIEW = (over: Partial<OpenRoundView> = {}): OpenRoundView => ({
  stageId: "st1",
  stageName: "Open Swiss",
  roundNo: 3,
  state: "open",
  openedAt: iso(NOW - 10 * MIN),
  deadlineAt: iso(NOW + 8 * MIN),
  windowMinutes: DEADLINE_AFTER_MS / MIN,
  staggered: false,
  batches: [],
  staggerSpanMinutes: 0,
  scheduledAt: null,
  press: "reinvite",
  earlierInPlay: [],
  pairings: [pairing("f4", 4), pairing("f6", 6)],
  extendableBoards: 2,
  extendWindows: [],
  extendRefusals: emptyExtendTally(),
  ...over,
});
const FLAGGED_F2 = (round: ArbiterRound): FlaggedBoard => ({ ...round.boards.find((b) => b.fixtureId === "f2")!, roundNo: 3, stageName: "Open Swiss" });
const HELD_F5: NeedsOrganiserExternalPlayRow = {
  fixtureId: "f5",
  fixtureNo: 15,
  homeName: "White 5",
  awayName: "Black 5",
  scheduledAt: null,
  reason: "no_show_white",
  lastError: null,
  whiteSide: "home",
  revokedSeat: null,
  roundNo: 3,
  boardNo: 5,
  stageName: "Open Swiss",
  canResync: false,
  seated: false,
  noResultOffer: { kind: "void" },
};
const DATA = (round: ArbiterRound, over: Partial<RoundColumnData> = {}): RoundColumnData => ({
  views: [VIEW()],
  held: [HELD_F5],
  flagged: [FLAGGED_F2(round)],
  ownFlagged: 0,
  tz: "Europe/London",
  awaitsStart: false,
  ...over,
});

type PanelProps = Parameters<typeof ArbiterPanel>[0];
const PANEL = (over: Partial<PanelProps> = {}): PanelProps => {
  const round = over.round === undefined ? CK_ROUND() : over.round;
  return { round, requested: null, slugs: SLUGS, initialFixtureId: "f1", column: round === null ? DATA(ROUND([])) : DATA(round), ...over };
};

// ---- driving the chain -----------------------------------------------------------------------------------------------------

type Ui = Pick<ReturnType<typeof renderIsland<unknown>>, "tree" | "text" | "batch" | "unmount"> & { rerender: (nextProps: PanelProps) => void };
const mountPanel = (p: PanelProps = PANEL()) => renderIsland(ArbiterPanel, p);
/** The ArbiterScreen element the panel last returned: its props are exactly what the panel handed down. */
const screenEl = (ui: Ui): ReactElement => ui.tree()[0]!;
const screenProps = (ui: Ui) => propsOf(screenEl(ui)) as unknown as ArbiterScreenProps;
/** Re-render a child element as its own island, from the props its parent really gave it. */
const island = (el: ReactElement) => renderIsland(el.type as unknown as (p: Props) => ReactNode, propsOf(el));
const findOne = (tree: ReactElement[], type: unknown, what: string): ReactElement => {
  const hits = tree.filter((e) => e.type === type);
  expect(hits, what).toHaveLength(1);
  return hits[0]!;
};
const screenIsland = (ui: Ui) => island(screenEl(ui));
const columnEl = (ui: Ui) => findOne(screenIsland(ui).tree(), RoundColumn, "one RoundColumn");
const waitingEl = (ui: Ui) => findOne(screenIsland(ui).tree(), WaitingList, "one WaitingList");
const testid = (el: ReactElement) => propsOf(el)["data-testid"];
const byTestid = (tree: ReactElement[], id: string, fixtureId?: string) =>
  tree.filter((e) => testid(e) === id && (fixtureId === undefined || propsOf(e)["data-fixture-id"] === fixtureId));
/** The screen's markup for the props the panel last handed it, in the real English provider. */
const markup = (ui: Ui) =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as unknown as Dict} locale="en">
      <ArbiterScreen {...screenProps(ui)} />
    </DictProvider>,
  );
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
/** Open tags (with their attributes) of every button carrying this test id. */
const buttonTags = (h: string, id: string) => [...h.matchAll(new RegExp(`<button\\b[^>]*data-testid="${id}"[^>]*>`, "g"))].map((m) => m[0]);
const disabled = (tag: string) => tag.includes('disabled=""');

beforeEach(() => {
  net.calls.length = 0;
  router.refresh.mockClear();
  vi.mocked(useOpenRound).mockClear();
  vi.mocked(useExtendClock).mockClear();
});

// ======================================================================================================================================

describe("on.select reaches ANY board of the round (ruling 4): the queue's 'Review board' through the column to the panel's reducer", () => {
  /** Panel -> Screen -> RoundColumn -> RoundQueueCards: the 'Review board N' button for `fixtureId`, its onClick as the browser would fire it. */
  function reviewButton(ui: Ui, fixtureId: string): ReactElement {
    const column = island(columnEl(ui));
    const queue = island(findOne(column.tree(), RoundQueueCards, "the queue in the column")).tree();
    const buttons = byTestid(queue, "arbiter-column-review").filter((b) => propsOf(b)["data-target"] === "select");
    expect(buttons.length, "anti-vacuity: select buttons in the queue").toBeGreaterThan(0);
    // Each card carries its fixture on its <li>; a button belongs to the card that contains it.
    const card = byTestid(queue, "arbiter-column-card", fixtureId);
    expect(card, `a card for ${fixtureId}`).toHaveLength(1);
    const own = walk(card[0]!).filter((e) => testid(e) === "arbiter-column-review" && propsOf(e)["data-target"] === "select");
    expect(own, `${fixtureId}: its Review button`).toHaveLength(1);
    return own[0]!;
  }

  it("a FINISHED board and an ON-HOLD board are both selected, and each becomes the board on screen", () => {
    const ui = mountPanel();
    expect(screenProps(ui).decision.boardId, "premise: opens on f1").toBe("f1");
    const round = CK_ROUND();
    expect(round.boards.find((b) => b.fixtureId === "f2")!.state.kind, "premise: f2 is over").toBe("result");
    expect(round.boards.find((b) => b.fixtureId === "f5")!.state.kind, "premise: f5 is on hold").toBe("on_hold");
    let checked = 0;
    for (const [fixtureId, boardNo] of [["f2", 2], ["f5", 5]] as const) {
      (propsOf(reviewButton(ui, fixtureId)).onClick as () => void)();
      expect(screenProps(ui).decision.boardId, `${fixtureId} is selected`).toBe(fixtureId);
      const nav = /<nav[\s\S]*?<\/nav>/.exec(markup(ui))![0];
      const pressed = [...nav.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!));
      expect(pressed, `${fixtureId}: the board list shows it pressed`).toHaveLength(1);
      expect(pressed[0], `${fixtureId}`).toContain(`Board ${boardNo}`);
      checked += 1;
    }
    expect(checked, "anti-vacuity: boards selected").toBe(2);
  });

  it("the screen hands the column the panel's own select, and the waiting list too", () => {
    const ui = mountPanel();
    const select = screenProps(ui).on.select;
    expect(propsOf(columnEl(ui)).on).toMatchObject({ select });
    expect(propsOf(waitingEl(ui)).on).toMatchObject({ select });
    // And the waiting list's board label is the same press: f6 is not selected until it is pressed.
    expect(screenProps(ui).decision.boardId).toBe("f1");
    const label = byTestid(island(waitingEl(ui)).tree(), "arbiter-waiting-board")[0]!;
    (propsOf(label).onClick as () => void)();
    expect(screenProps(ui).decision.boardId, "the first waiting row's board").toBe("f4");
  });
});

describe("on.extendBoard selects the board, then extends it (through a waiting row's +5)", () => {
  const rowExtend = (ui: Ui, fixtureId: string) => {
    const hits = byTestid(island(waitingEl(ui)).tree(), "arbiter-waiting-extend", fixtureId);
    expect(hits, `${fixtureId}: the row's +5`).toHaveLength(1);
    return propsOf(hits[0]!).onClick as () => void;
  };

  it("the board becomes the one on screen, the extend request goes out for IT, and its answer lands in the decision area", async () => {
    const ui = mountPanel();
    expect(screenProps(ui).decision.boardId, "premise: f1 is on screen").toBe("f1");
    ui.batch(() => rowExtend(ui, "f6")());
    const d = screenProps(ui).decision;
    expect(d.boardId, "selected").toBe("f6");
    expect(d.busy, "then extended").toEqual({ kind: "extend", boardId: "f6" });
    expect(net.calls.map((c) => c.url), "one request, for f6").toEqual([extendBoardPath("f6")]);
    // The answer: the board on screen is f6, so its decision area says so.
    net.calls[0]!.resolve({ fixtureId: "f6", extensions: 1, extensionsLeft: 2, addedMinutes: 5, deadlineAt: WINDOW.deadlineAt });
    await flush();
    const after = screenProps(ui).decision;
    expect(after.busy).toBeNull();
    expect(after.notice).toMatchObject({ boardId: "f6", kind: "extended", boardNo: 6 });
    const page = markup(ui);
    const from = page.indexOf('data-testid="arbiter-decision-group"');
    const decisionArea = page.slice(from, page.indexOf("<aside", from));
    expect(text(decisionArea), "in the decision area").toContain(
      EN["externalPlay.checkinExtend.notice.board"]!.replace("{minutes}", "5").replace("{n}", "6").replace("{time}", new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(WINDOW.deadlineAt))),
    );
    expect(router.refresh, "the page is re-read after the answer").toHaveBeenCalled();
  });

  it("a fixture that is not in the round does nothing: no selection, no request", () => {
    const ui = mountPanel();
    ui.batch(() => screenProps(ui).on.extendBoard("not-in-this-round"));
    expect(screenProps(ui).decision.boardId).toBe("f1");
    expect(screenProps(ui).decision.busy).toBeNull();
    expect(net.calls).toEqual([]);
  });

  it("one request at a time: a second +5 while the first is out sends nothing", () => {
    const ui = mountPanel();
    ui.batch(() => rowExtend(ui, "f6")());
    ui.batch(() => screenProps(ui).on.extendBoard("f4"));
    expect(net.calls, "still one request").toHaveLength(1);
    expect(screenProps(ui).decision.busy).toEqual({ kind: "extend", boardId: "f6" });
    expect(screenProps(ui).decision.boardId, "and the pane did not move to the board that was refused").toBe("f6");
  });

  // Review I1: the reducer's `select` ignores `busy`, so a second row's +5 used to MOVE the pane to its board while the runner refused
  // the extend; the first request's answer then found a deselected board and cleared the busy flag in silence - the answer was lost.
  it("a second row's +5 while the first is out changes nothing: the pane stays, nothing is sent, and the first answer still lands", async () => {
    const ui = mountPanel();
    ui.batch(() => rowExtend(ui, "f6")());
    expect(screenProps(ui).decision, "premise: f6 selected and extending").toMatchObject({ boardId: "f6", busy: { kind: "extend", boardId: "f6" } });
    const before = screenProps(ui).decision;

    ui.batch(() => rowExtend(ui, "f4")()); // the SECOND row's press, through its own bound handler
    expect(screenProps(ui).decision, "the whole decision state is untouched").toBe(before);
    expect(screenProps(ui).decision.boardId, "the selected board is unchanged").toBe("f6");
    expect(net.calls.map((c) => c.url), "no second request").toEqual([extendBoardPath("f6")]);

    net.calls[0]!.resolve({ fixtureId: "f6", extensions: 1, extensionsLeft: 2, addedMinutes: 5, deadlineAt: WINDOW.deadlineAt });
    await flush();
    const after = screenProps(ui).decision;
    expect(after.busy, "the request is answered").toBeNull();
    expect(after.boardId, "still on f6").toBe("f6");
    expect(after.notice, "its answer is shown, not dropped").toMatchObject({ boardId: "f6", kind: "extended", boardNo: 6 });
    const page = markup(ui);
    const from = page.indexOf('data-testid="arbiter-decision-group"');
    expect(text(page.slice(from, page.indexOf("<aside", from))), "in the decision area").toContain(
      EN["externalPlay.checkinExtend.notice.board"]!.replace("{minutes}", "5").replace("{n}", "6").replace("{time}", new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(WINDOW.deadlineAt))),
    );
  });

  it("every row's +5 is disabled while a request is in flight, and enabled when none is (the panel's own +5 rule)", () => {
    const ui = mountPanel();
    const rows = (u: Ui) => buttonTags(markup(u), "arbiter-waiting-extend");
    const idle = rows(ui);
    expect(idle.length, "anti-vacuity: at least two rows offer +5").toBeGreaterThanOrEqual(2);
    expect(idle.filter(disabled), "idle: none disabled").toEqual([]);
    ui.batch(() => rowExtend(ui, "f6")());
    const busy = rows(ui);
    expect(busy.length, "the same rows are still offered").toBe(idle.length);
    expect(busy.filter(disabled).length, "busy: every one disabled").toBe(busy.length);
  });

  it("a round-wide +5 in flight blocks a row's +5 as well: disabled, and a press does not move the pane or send", () => {
    const ui = mountPanel();
    ui.batch(() => screenProps(ui).on.extendRound());
    expect(screenProps(ui).roundExtend.busy, "premise: the round's +5 is out").toBe(true);
    expect(net.calls, "premise: one request").toHaveLength(1);
    const tags = buttonTags(markup(ui), "arbiter-waiting-extend");
    expect(tags.length, "anti-vacuity: rows offer +5").toBeGreaterThanOrEqual(2);
    expect(tags.filter(disabled).length, "all disabled").toBe(tags.length);
    ui.batch(() => rowExtend(ui, "f6")());
    expect(screenProps(ui).decision.boardId, "the pane did not move").toBe("f1");
    expect(screenProps(ui).decision.busy).toBeNull();
    expect(net.calls, "still only the round's request").toHaveLength(1);
  });
});

describe("C9: ONE handle per round on screen, shared by the hero and the rows", () => {
  it("the panel calls useOpenRound once per render, with the round on screen's view, and hands that handle to the screen", () => {
    const ui = mountPanel();
    const calls = vi.mocked(useOpenRound).mock.calls;
    expect(calls.length, "anti-vacuity: the hook ran").toBeGreaterThan(0);
    // `useExtendClock` is called exactly once per render pass of the panel, so equal counts mean exactly one `useOpenRound` per pass.
    expect(calls.length, "once per render pass").toBe(vi.mocked(useExtendClock).mock.calls.length);
    const view = (screenProps(ui).column.views[0])!;
    for (const [arg] of calls) expect(arg, "the round on screen's view").toBe(view);
    const handle = vi.mocked(useOpenRound).mock.results.at(-1)!.value;
    expect(screenProps(ui).openRound, "the screen's handle is the hook's").toBe(handle);
  });

  it("the hook gets null when there is no round, and when no view is the round on screen's", () => {
    const none = mountPanel(PANEL({ round: null, initialFixtureId: null }));
    expect(vi.mocked(useOpenRound).mock.calls.at(-1)![0], "no round").toBeNull();
    expect(screenProps(none).openRound).toBe(vi.mocked(useOpenRound).mock.results.at(-1)!.value);
    vi.mocked(useOpenRound).mockClear();
    mountPanel(PANEL({ column: DATA(CK_ROUND(), { views: [VIEW({ roundNo: 9 })] }) }));
    expect(vi.mocked(useOpenRound).mock.calls.at(-1)![0], "a view of another round").toBeNull();
  });

  it("the column and the waiting list read the SAME handle object the screen was given", () => {
    const ui = mountPanel();
    const handle = screenProps(ui).openRound;
    expect(propsOf(columnEl(ui)).openRound).toBe(handle);
    expect(propsOf(waitingEl(ui)).openRound).toBe(handle);
    // ... and the hero inside the column is given it too (the column hands its own prop down).
    const hero = findOne(island(columnEl(ui)).tree(), CheckinHero, "the hero");
    expect(propsOf(hero).openRound).toBe(handle);
  });

  it("busy: resend, entered by a ROW's Resend, disables the hero's reinvite and every row's Resend", () => {
    const ui = mountPanel();
    const before = markup(ui);
    expect(buttonTags(before, "arbiter-column-reinvite"), "premise: the hero offers a reinvite").toHaveLength(1);
    expect(buttonTags(before, "arbiter-waiting-resend"), "premise: two rows offer Resend").toHaveLength(2);
    for (const tag of [...buttonTags(before, "arbiter-column-reinvite"), ...buttonTags(before, "arbiter-waiting-resend")]) expect(disabled(tag), "idle: enabled").toBe(false);

    const row = byTestid(island(waitingEl(ui)).tree(), "arbiter-waiting-resend", "f4")[0]!;
    (propsOf(row).onClick as () => void)();
    expect(net.calls, "one POST").toHaveLength(1);
    expect(screenProps(ui).openRound.state.busy).toEqual({ kind: "resend", fixtureId: "f4" });

    const busy = markup(ui);
    const rows = buttonTags(busy, "arbiter-waiting-resend");
    expect(rows).toHaveLength(2);
    for (const tag of rows) expect(disabled(tag), tag).toBe(true);
    expect(disabled(buttonTags(busy, "arbiter-column-reinvite")[0]!), "the hero's reinvite").toBe(true);
    // Only the row that was pressed says it is working.
    expect(rows.map((t) => t.includes('aria-busy="true"'))).toEqual([true, false]);
    // A second press while it is out goes nowhere (R1), from either control.
    (propsOf(byTestid(island(waitingEl(ui)).tree(), "arbiter-waiting-resend", "f6")[0]!).onClick as () => void)();
    expect(net.calls, "still one POST").toHaveLength(1);
  });

  it("busy, entered by the HERO's press (ask, then confirm): every row's Resend is disabled as well", () => {
    const ui = mountPanel();
    const hero = () => island(findOne(island(columnEl(ui)).tree(), CheckinHero, "the hero"));
    (propsOf(byTestid(hero().tree(), "arbiter-column-reinvite")[0]!).onClick as () => void)();
    expect(screenProps(ui).openRound.state.confirming, "the confirmation is up").toBe(true);
    const confirm = findOne(hero().tree(), ConfirmDialog, "the hero's confirmation");
    expect(propsOf(confirm).open, "premise: it is open").toBe(true);
    (propsOf(confirm).onConfirm as () => void)();
    expect(net.calls, "one POST").toHaveLength(1);
    expect(screenProps(ui).openRound.state.busy).toEqual({ kind: "open" });

    const busy = markup(ui);
    const rows = buttonTags(busy, "arbiter-waiting-resend");
    expect(rows).toHaveLength(2);
    for (const tag of rows) expect(disabled(tag), tag).toBe(true);
    expect(disabled(buttonTags(busy, "arbiter-column-reinvite")[0]!)).toBe(true);
    // Pressing a row now sends nothing.
    (propsOf(byTestid(island(waitingEl(ui)).tree(), "arbiter-waiting-resend", "f4")[0]!).onClick as () => void)();
    expect(net.calls, "still one POST").toHaveLength(1);
  });
});

describe("the screen's wiring of the column and the waiting list (every prop, by identity)", () => {
  it("grid path: the column and the waiting list are handed the panel's data, clock, handle and presses, and the column is placed 'grid'", () => {
    const ui = mountPanel();
    const p = screenProps(ui);
    const col = propsOf(columnEl(ui));
    expect(col.round, "round").toBe(p.round);
    expect(col.requested, "requested").toBeNull();
    expect(col.data, "data (views, held, flagged, ownFlagged, tz, awaitsStart)").toBe(p.column);
    expect(col.nowMs, "nowMs").toBe(NOW);
    expect(col.slugs, "slugs").toBe(p.slugs);
    expect(col.openRound, "openRound").toBe(p.openRound);
    expect(col.on, "on").toEqual({ select: p.on.select, extendBoard: p.on.extendBoard });
    expect(col.placement, "placement").toBe("grid");
    expect(isValidElement(col.roundExtend), "roundExtend is the panel's bar").toBe(true);
    const bar = propsOf(col.roundExtend as ReactElement);
    expect(bar.round, "the bar is about this round").toBe(p.round);
    expect(bar.state, "... with its state").toBe(p.roundExtend);
    expect(bar.onExtend, "... and its press").toBe(p.on.extendRound);
    expect(bar.nowMs).toBe(NOW);

    const wl = propsOf(waitingEl(ui));
    expect(wl.boards, "boards").toBe(p.round!.boards);
    expect(wl.view, "view: the round on screen's").toBe(p.column.views[0]);
    expect(wl.openRound, "openRound").toBe(p.openRound);
    expect(wl.nowMs, "nowMs").toBe(NOW);
    expect(wl.on, "on").toEqual({ select: p.on.select, extendBoard: p.on.extendBoard });
  });

  it("the paths with no grid place the column 'solo'; round null has no bar and no waiting list; no boards gets the bar", () => {
    const none = mountPanel(PANEL({ round: null, initialFixtureId: null }));
    const colNone = propsOf(columnEl(none));
    expect(colNone.placement).toBe("solo");
    expect(colNone.roundExtend, "no round: no bar").toBeNull();
    expect(screenIsland(none).tree().filter((e) => e.type === WaitingList)).toHaveLength(0);

    const own = mountPanel(PANEL({ round: ROUND([], { ownBoards: 2 }), initialFixtureId: null }));
    const colOwn = propsOf(columnEl(own));
    expect(colOwn.placement).toBe("solo");
    expect(isValidElement(colOwn.roundExtend), "no boards: the bar rides the status block").toBe(true);
    expect(screenIsland(own).tree().filter((e) => e.type === WaitingList)).toHaveLength(0);
  });

  it("no column on the notices: requested, and the I3 path (the board asked for is not in the round)", () => {
    const requested = mountPanel(PANEL({ round: null, requested: "unavailable", initialFixtureId: "nope" }));
    expect(screenIsland(requested).tree().filter((e) => e.type === RoundColumn)).toHaveLength(0);
    const i3 = mountPanel(PANEL({ initialFixtureId: "not-in-this-round" }));
    expect(screenIsland(i3).tree().filter((e) => e.type === RoundColumn)).toHaveLength(0);
    expect(screenIsland(i3).tree().filter((e) => e.type === WaitingList)).toHaveLength(0);
  });
});

// ---- the phase flip: what keeps its place, what is kept --------------------------------------------------------------------------
//
// React keeps a component's state across a re-render only if the component is the same TYPE at the same POSITION under the same
// parent, with the same key. This workspace has no DOM reconciler (`environment: "node"`), so the state itself cannot be watched
// surviving; its precondition can: the path of types, keys and child indices from the root to the queue must be the same before and
// after the flip. (The behaviour itself is the e2e walkthrough's: plan Task 13.)

/** The route from `node` to the first element `hit` accepts: one `type#key` per element and one `[index]` per array of children. */
function routeTo(node: ReactNode, hit: (e: ReactElement) => boolean, trail: string[] = []): string[] | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = routeTo(node[i] as ReactNode, hit, [...trail, `[${i}]`]);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const type = typeof node.type === "string" ? node.type : ((node.type as { name?: string }).name ?? "anonymous");
  const here = [...trail, `${type}#${node.key ?? ""}`];
  if (hit(node)) return here;
  const kids = (node.props as { children?: ReactNode }).children;
  return routeTo(Array.isArray(kids) ? kids : [kids], hit, here);
}
/** The island's whole output (its root element), not the flattened list. */
const rootOf = (Component: (p: never) => ReactNode, props: unknown): ReactNode =>
  renderIsland(Component as unknown as (p: unknown) => ReactNode, props, (n) => [n as ReactElement]).tree()[0]!;

describe("the check-in to playing flip keeps the queue where React will keep its state", () => {
  const screenRoute = (round: ArbiterRound) => {
    const ui = mountPanel(PANEL({ round, column: DATA(round) }));
    return routeTo(rootOf(ArbiterScreen as never, propsOf(screenEl(ui))), (e) => e.type === RoundColumn);
  };
  const queueRoute = (round: ArbiterRound, phase: "checkin" | "playing") => {
    const ui = mountPanel(PANEL({ round, column: DATA(round) }));
    const col = propsOf(columnEl(ui));
    expect(roundPhase(round), `premise: ${phase}`).toBe(phase);
    return routeTo(rootOf(RoundColumn as never, col), (e) => e.type === RoundQueueCards);
  };
  const roundPhase = (r: ArbiterRound) => (r.boards.some((b) => b.state.kind === "checking_in") ? "checkin" : "playing");

  it("the column sits at the same route in the screen before and after the flip", () => {
    const before = screenRoute(CK_ROUND());
    const after = screenRoute(PLAYING());
    expect(before, "anti-vacuity: the column was found").not.toBeNull();
    expect(after).toEqual(before);
    // The checker can see a difference: the no-grid path puts it elsewhere.
    const solo = routeTo(rootOf(ArbiterScreen as never, propsOf(screenEl(mountPanel(PANEL({ round: null, initialFixtureId: null }))))), (e) => e.type === RoundColumn);
    expect(solo, "a different path is a different route").not.toEqual(before);
  });

  it("inside the column, the queue is the aside's child 0 in check-in and in playing (the same element, so the same reducer state)", () => {
    const before = queueRoute(CK_ROUND(), "checkin");
    const after = queueRoute(PLAYING(), "playing");
    expect(before, "anti-vacuity: the queue was found").not.toBeNull();
    expect(after).toEqual(before);
    expect(before!.slice(-3), "the aside's first child").toEqual(["aside#", "[0]", "RoundQueueCards#"]);
  });

  it("the panel's own state rides the flip: the board on screen and the shared handle's confirmation (same round, so no reset)", () => {
    const ui = mountPanel();
    screenProps(ui).on.select("f2");
    const hero = island(findOne(island(columnEl(ui)).tree(), CheckinHero, "the hero"));
    (propsOf(byTestid(hero.tree(), "arbiter-column-reinvite")[0]!).onClick as () => void)();
    expect(screenProps(ui).openRound.state.confirming, "premise: a confirmation is up").toBe(true);
    const playing = PLAYING();
    ui.rerender(PANEL({ round: playing, column: DATA(playing), initialFixtureId: "f1" }));
    expect(screenProps(ui).decision.boardId, "the board stays").toBe("f2");
    expect(screenProps(ui).openRound.state.confirming, "the confirmation stays: same stage, same round").toBe(true);
    // A different ROUND on screen resets the handle (the hook is keyed by the round, not the panel).
    const next = ROUND(PLAYING().boards, { roundNo: 4 });
    ui.rerender(PANEL({ round: next, column: DATA(next, { views: [VIEW({ roundNo: 4 })] }), initialFixtureId: "f1" }));
    expect(screenProps(ui).openRound.state.confirming, "round 4: nothing carried over").toBe(false);
  });
});
