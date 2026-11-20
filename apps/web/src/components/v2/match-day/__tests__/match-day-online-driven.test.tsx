// Match Day online, Task 6 - the shell DRIVEN (plan 2026-11-05-match-day-all-in-one.md; spec §5.2, §5.5, §6.3; MD-R2, MD-R7, O1, O4).
// The static suite (match-day-online-shell.test.tsx) paints one instant; what follows are SEQUENCES - a board opened, a poll that
// keeps it, a poll that takes it away, one that brings it back - so the shell runs under the node-env hook harness with the network
// and the poll's schedule stubbed and the tick driven by hand (the same seams as match-day-shell.test.tsx). Its children are not
// expanded: the assertions read the props the shell hands them, which is what the list, the panels and Needs you are built from.
//
// Where an expected value comes from: the freeze rule (O4) and the viewer rule are typed in the cell table below (start needs an
// editor, an offered club and no freeze; a view-only member can press nothing); the "left the list" name is the board's own
// "Board N · White v Black"; a count is the boards of the rounds the list was handed. Anti-vacuity: sweeps count their cells.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

const net = vi.hoisted(() => ({ calls: [] as string[], next: null as unknown }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string) => {
      net.calls.push(url);
      return Promise.resolve(net.next);
    },
  };
});
/** `useSearchParams` has no router outside the app: null is "no address to read" (the props speak). */
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useSearchParams: () => null }));
/** The band poll's schedule is a browser's: stubbed, with its tick and the cadence it was asked for kept. */
const poll = vi.hoisted(() => ({ tick: null as null | (() => void), live: null as null | boolean }));
vi.mock("@/components/v2/desk/band-poll", () => ({
  browserBandPollDeps: () => ({}),
  startBandPolling: (live: boolean, tick: () => void) => {
    poll.tick = tick;
    poll.live = live;
    return () => {};
  },
}));

import en from "@/dictionaries/en/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MatchDayCourt, MatchDayOnlineRound, MatchDayView } from "@/lib/match-day/types";
import { mayPress } from "@/lib/match-day/online";
import { NO_FROZEN_NAMES } from "@/lib/match-day/frozen-names";
import { NeedsYou, type NeedsYouItem } from "@/components/v2/desk/needs-you";
import { CourtFocus } from "../court-focus";
import { MatchDayShell, type MatchDayShellProps } from "../match-day-shell";
import { OnlineList } from "../online-list";
import { OnlineBoardPanel } from "../online-focus";
import { RoundFocus } from "../round-focus";
import { arbiterRound, checkinRound, earlier, held, live, onlineView, pairedRound, round, withState } from "./_online-fixtures";

const court = (id: string, name: string): MatchDayCourt => ({
  court_id: id,
  court_name: name,
  venue_id: "venue-1",
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "free",
  current: null,
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  stream_link: null,
});

const props = (initial: MatchDayView, o: Partial<MatchDayShellProps> = {}): MatchDayShellProps => ({
  competitionId: "comp-1",
  competitionName: "Westway Open",
  orgSlug: "acme",
  compSlug: "westway-open",
  locale: "en",
  divisions: [],
  initial,
  dict: en as Dict,
  scoreDict: publicEn as Dict,
  viewerPlan: "pro",
  frozenNames: NO_FROZEN_NAMES,
  onlineEnabled: true,
  ...o,
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const at = (n: number) => `2026-11-19T18:0${n}:00.000Z`;

/** What the shell handed its children, read off the element tree. */
function parts(tree: ReactElement[]) {
  const list = tree.find((e) => e.type === OnlineList);
  const boardPanel = tree.find((e) => e.type === OnlineBoardPanel);
  const roundPanel = tree.find((e) => e.type === RoundFocus);
  const listBox = tree.find((e) => propsOf(e)["data-testid"] === "md-list")!;
  const lost = tree.find((e) => propsOf(e)["data-testid"] === "md-lost");
  const rounds = list === undefined ? [] : (propsOf(list).rounds as MatchDayOnlineRound[]);
  return {
    list: list === undefined ? null : propsOf(list),
    rounds,
    /** Every board row the list will draw: each listed round's boards, and its earlier-round boards. */
    boardRows: rounds.reduce((n, r) => n + (r.round?.boards.length ?? 0) + r.needs_decision.length, 0),
    board: boardPanel === undefined ? null : propsOf(boardPanel),
    round: roundPanel === undefined ? null : propsOf(roundPanel),
    court: tree.find((e) => e.type === CourtFocus) === undefined ? null : propsOf(tree.find((e) => e.type === CourtFocus)!),
    listHiddenOnPhone: String(propsOf(listBox).className).split(/\s+/).includes("max-md:hidden"),
    lost: lost === undefined ? null : JSON.stringify(propsOf(lost).children),
    selected: list === undefined ? null : propsOf(list).selected,
  };
}

beforeEach(() => {
  net.calls = [];
  net.next = null;
  poll.tick = null;
  poll.live = null;
});

/** A night: one round in check-in with three boards, the middle one a live game; ids are stable across polls. */
function night(over: { liveMove?: number; dropLive?: boolean; now?: string; flagged?: boolean } = {}): MatchDayView {
  const b1 = withState({ kind: "checking_in" }, { fixtureId: "b-1", boardNo: 1, white: { name: "Chen", personId: null }, black: { name: "Silva", personId: null } });
  const b2 = live(over.liveMove ?? 12, { fixtureId: "b-2", boardNo: 2, white: { name: "Okafor", personId: null }, black: { name: "Haas", personId: null } });
  const b3 = held(1, { fixtureId: "b-3", boardNo: 3, white: { name: "Rossi", personId: null }, black: { name: "Ng", personId: null } });
  const boards = over.dropLive === true ? [b1, b3] : [b1, b2, b3];
  const flagged = earlier(2, {
    ...withState({ kind: "cancelled" }, { flagCount: 1 }),
    fixtureId: "old-1",
    boardNo: 6,
    white: { name: "Hoff", personId: null },
    black: { name: "Fern", personId: null },
    stage_id: "stage-1",
    round_no: 2,
  });
  const r = round("stage-1:3", "playing", arbiterRound(boards), { needs_decision: over.flagged === true ? [flagged] : [] });
  return { ...onlineView([r]), now: over.now ?? at(0) };
}

describe("a board opened from the list: full-screen on a phone, kept through the polls, and 'left the list' when one takes it", () => {
  it("EMPTY CASE FIRST: nothing opened - no board panel, no notice, and the desktop's first row is focused", () => {
    const p = parts(renderIsland(MatchDayShell, props(night())).tree());
    expect(p.board).toBeNull();
    expect(p.lost).toBeNull();
    expect(p.round).toMatchObject({ round: { key: "stage-1:3" }, hiddenOnPhone: true });
    expect(p.listHiddenOnPhone).toBe(false);
    expect(p.boardRows).toBe(3);
  });

  it("a tap on a board row opens ITS board (by fixture id), names the row, and puts the phone on the panel", () => {
    const island = renderIsland(MatchDayShell, props(night()));
    (parts(island.tree()).list!.onOpenBoard as (id: string) => void)("b-2");
    const p = parts(island.tree());
    expect(p.board).toMatchObject({ hiddenOnPhone: false });
    expect((p.board!.row as { fixtureId: string }).fixtureId).toBe("b-2");
    expect(p.round).toBeNull();
    expect(p.selected).toMatchObject({ kind: "board", id: "b-2", name: "Board 2 · Okafor v Haas" });
    expect(p.listHiddenOnPhone).toBe(true);
    // Back: the phone is on the list; the board is still the desktop's focus.
    (p.board!.onBack as () => void)();
    const back = parts(island.tree());
    expect(back.listHiddenOnPhone).toBe(false);
    expect(back.board).toMatchObject({ hiddenOnPhone: true });
  });

  it("a poll that still lists the board keeps it focused - the NEW row, the same board - and the phone where it was", async () => {
    const island = renderIsland(MatchDayShell, props(night({ now: at(0) })));
    (parts(island.tree()).list!.onOpenBoard as (id: string) => void)("b-2");
    net.next = night({ liveMove: 31, now: at(1) });
    poll.tick!();
    await settle();
    const p = parts(island.tree());
    expect(p.lost).toBeNull();
    expect((p.board!.row as { fixtureId: string; state: unknown }).fixtureId).toBe("b-2");
    expect((p.board!.row as { state: unknown }).state).toEqual({ kind: "live", moveNo: 31 });
    expect(p.board).toMatchObject({ hiddenOnPhone: false });
    expect(p.listHiddenOnPhone).toBe(true);
    expect(net.calls).toHaveLength(1);
  });

  it("a board that LEAVES the list: the page says so, naming it - never another board - the phone is on the list, the list is one board shorter", async () => {
    const island = renderIsland(MatchDayShell, props(night()));
    (parts(island.tree()).list!.onOpenBoard as (id: string) => void)("b-2");
    expect(parts(island.tree()).boardRows).toBe(3);

    net.next = night({ dropLive: true, now: at(1) });
    poll.tick!();
    await settle();
    let p = parts(island.tree());
    expect(p.lost, "the page says the board left").not.toBeNull();
    expect(p.lost).toContain("Board 2 · Okafor v Haas");
    expect(p.board).toBeNull();
    expect(p.round, "never another row in its place").toBeNull();
    expect(p.boardRows).toBe(2);
    expect(p.listHiddenOnPhone).toBe(false);

    // It comes back: the desktop focuses it again; a phone sent back to the list is not jumped into it.
    net.next = night({ now: at(2) });
    poll.tick!();
    await settle();
    p = parts(island.tree());
    expect(p.lost).toBeNull();
    expect((p.board!.row as { fixtureId: string }).fixtureId).toBe("b-2");
    expect(p.board).toMatchObject({ hiddenOnPhone: true });
    expect(p.listHiddenOnPhone).toBe(false);
    expect(p.boardRows).toBe(3);
    expect(net.calls).toHaveLength(2);
  });
});

describe("O1 - a cancelled board with an open flag, opened by ?board=, then gone", () => {
  it("opens as a panel; the next view, without it, is 'left the list' with its name and no panel, and the list is one board shorter", async () => {
    const island = renderIsland(MatchDayShell, props(night({ flagged: true }), { focusBoardId: "old-1" }));
    let p = parts(island.tree());
    expect(p.board).toMatchObject({ hiddenOnPhone: false });
    expect((p.board!.row as { fixtureId: string; state: { kind: string } }).state.kind).toBe("cancelled");
    expect(p.lost).toBeNull();
    expect(p.boardRows).toBe(4);

    net.next = night({ flagged: false, now: at(1) });
    poll.tick!();
    await settle();
    p = parts(island.tree());
    expect(p.lost).toContain("Board 6 · Hoff v Fern");
    expect(p.board).toBeNull();
    expect(p.boardRows).toBe(3);
    expect(p.listHiddenOnPhone).toBe(false);
  });
});

describe("a stale ?board= (a board the page does not list) opens nothing, and keeps opening nothing", () => {
  it("no panel, no notice, the default focus; the board appearing in a later poll is NOT opened by the old address", async () => {
    const island = renderIsland(MatchDayShell, props(night({ dropLive: true }), { focusBoardId: "b-2" }));
    let p = parts(island.tree());
    expect(p.board).toBeNull();
    expect(p.lost).toBeNull();
    expect(p.round).toMatchObject({ hiddenOnPhone: true });
    expect(p.listHiddenOnPhone).toBe(false);

    net.next = night({ now: at(1) });
    poll.tick!();
    await settle();
    p = parts(island.tree());
    expect(p.board, "the stale address was never an open board").toBeNull();
    expect(p.lost).toBeNull();
    expect(p.boardRows).toBe(3);
  });
});

describe("a round opened, kept, and lost - read by the online rules, never resolveFocus (MD-R7)", () => {
  it("with a court on the page too: the round opens, polls keep it, and a poll without it is 'left the list' naming the round", async () => {
    const v = (rounds: MatchDayOnlineRound[], now: string) => ({ ...onlineView(rounds, { courts: [court("c-1", "Court 1")] }), now });
    const island = renderIsland(MatchDayShell, props(v([checkinRound("stage-1:3"), pairedRound("stage-2:1")], at(0))));
    // The court is the default; the round is not focused until opened.
    expect(parts(island.tree()).court).not.toBeNull();
    (parts(island.tree()).list!.onOpenRound as (key: string) => void)("stage-2:1");
    let p = parts(island.tree());
    expect(p.round).toMatchObject({ hiddenOnPhone: false });
    expect((p.round!.round as { key: string }).key).toBe("stage-2:1");
    expect(p.court, "the court gives the column up").toBeNull();
    expect(p.lost).toBeNull();

    net.next = v([checkinRound("stage-1:3"), pairedRound("stage-2:1", { phase: "before" })], at(1));
    poll.tick!();
    await settle();
    p = parts(island.tree());
    expect((p.round!.round as { key: string }).key).toBe("stage-2:1");
    expect(p.lost).toBeNull();

    net.next = v([checkinRound("stage-1:3")], at(2));
    poll.tick!();
    await settle();
    p = parts(island.tree());
    expect(p.lost).toContain("Online Rapid · Round 1");
    expect(p.round).toBeNull();
    expect(p.court, "never the court in its place").toBeNull();
    expect(p.listHiddenOnPhone).toBe(false);
  });
});

describe("the reader the shell builds for the panels (O4, MD-R21): {editor, offered, frozen}, cell by cell", () => {
  // The rule typed from the plan: Start needs an editor, an offered club and a competition that is not billing-frozen; the decisions
  // that finish play need only an editor (the freeze exempts results); watching needs an editor and an offered club. A view-only
  // member (readOnly) is not an editor and presses nothing.
  const cells: { readOnly: boolean; frozen: boolean; offered: boolean; start: boolean; finish: boolean; cameras: boolean }[] = [
    { readOnly: false, frozen: false, offered: true, start: true, finish: true, cameras: true },
    { readOnly: false, frozen: true, offered: true, start: false, finish: true, cameras: true },
    { readOnly: false, frozen: false, offered: false, start: false, finish: true, cameras: false },
    { readOnly: false, frozen: true, offered: false, start: false, finish: true, cameras: false },
    { readOnly: true, frozen: false, offered: true, start: false, finish: false, cameras: false },
    { readOnly: true, frozen: true, offered: true, start: false, finish: false, cameras: false },
    { readOnly: true, frozen: false, offered: false, start: false, finish: false, cameras: false },
    { readOnly: true, frozen: true, offered: false, start: false, finish: false, cameras: false },
  ];

  it("a round's panel and a board's panel each get the reader of THEIR viewer, flag and freeze, across all eight cells", () => {
    let checked = 0;
    for (const c of cells) {
      const v = { ...night(), online_rounds: [round("stage-1:3", "playing", arbiterRound([live(5, { fixtureId: "b-9" })]), { offered: c.offered })] };
      const label = JSON.stringify(c);
      const onRound = parts(renderIsland(MatchDayShell, props(v, { readOnly: c.readOnly, frozen: c.frozen, focusRoundKey: "stage-1:3" })).tree());
      const onBoard = parts(renderIsland(MatchDayShell, props(v, { readOnly: c.readOnly, frozen: c.frozen, focusBoardId: "b-9" })).tree());
      for (const reader of [onRound.round!.reader, onBoard.board!.reader] as { editor: boolean; offered: boolean; frozen: boolean }[]) {
        expect(reader, label).toEqual({ editor: !c.readOnly, offered: c.offered, frozen: c.frozen });
        expect(mayPress(reader, "start"), `start ${label}`).toBe(c.start);
        expect(mayPress(reader, "finish"), `finish ${label}`).toBe(c.finish);
        expect(mayPress(reader, "cameras"), `cameras ${label}`).toBe(c.cameras);
      }
      checked++;
    }
    expect(checked, "anti-vacuity: eight cells").toBe(8);
  });

  it("the freeze is the COMPETITION's: one round not offered and one offered on the same page each carry their own flag", () => {
    const v = onlineView([checkinRound("stage-1:3", { offered: true }), checkinRound("stage-2:1", { offered: false, division_id: "div-b" })]);
    const a = parts(renderIsland(MatchDayShell, props(v, { focusRoundKey: "stage-1:3", frozen: true })).tree());
    const b = parts(renderIsland(MatchDayShell, props(v, { focusRoundKey: "stage-2:1", frozen: true })).tree());
    expect(a.round!.reader).toEqual({ editor: true, offered: true, frozen: true });
    expect(b.round!.reader).toEqual({ editor: true, offered: false, frozen: true });
  });
});

describe("Needs you opens boards and rounds in place (the desk's own rows, §9)", () => {
  const row = (kind: NeedsYouItem["kind"]): NeedsYouItem => ({ key: kind, kind, severity: "red", title: `${kind} title`, sub: `${kind} sub`, action: { label: `${kind} action`, href: `/x/${kind}` } });
  const withNeeds = () => ({ ...night(), needs_you: [row("no_scorer")] });
  const toggleOf = (tree: ReactElement[]) => tree.find((e) => propsOf(e)["data-testid"] === "md-needs-you-toggle")!;
  const needsOf = (tree: ReactElement[]) => tree.find((e) => e.type === NeedsYou);

  it("the flag off: the list hands Needs you no board or round opener (its rows keep their links)", () => {
    const island = renderIsland(MatchDayShell, props(withNeeds(), { onlineEnabled: false }));
    (propsOf(toggleOf(island.tree())).onClick as () => void)();
    const needs = propsOf(needsOf(island.tree())!);
    expect(needs.onOpenBoard).toBeUndefined();
    expect(needs.onOpenRound).toBeUndefined();
  });

  it("the flag on: onOpenBoard opens the board and CLOSES the list; onOpenRound opens the round and closes it", () => {
    const island = renderIsland(MatchDayShell, props(withNeeds()));
    (propsOf(toggleOf(island.tree())).onClick as () => void)();
    expect(propsOf(toggleOf(island.tree()))["aria-expanded"]).toBe(true);
    (propsOf(needsOf(island.tree())!).onOpenBoard as (id: string) => void)("b-3");
    let p = parts(island.tree());
    expect((p.board!.row as { fixtureId: string }).fixtureId).toBe("b-3");
    expect(p.board).toMatchObject({ hiddenOnPhone: false });
    expect(needsOf(island.tree()), "the list closed").toBeUndefined();
    expect(propsOf(toggleOf(island.tree()))["aria-expanded"]).toBe(false);

    (propsOf(toggleOf(island.tree())).onClick as () => void)();
    (propsOf(needsOf(island.tree())!).onOpenRound as (key: string) => void)("stage-1:3");
    p = parts(island.tree());
    expect((p.round!.round as { key: string }).key).toBe("stage-1:3");
    expect(p.round).toMatchObject({ hiddenOnPhone: false });
    expect(p.board).toBeNull();
    expect(needsOf(island.tree())).toBeUndefined();
  });

  it("a board named by Needs you that the division chips HIDE is shown, not 'left the list': its division's chip is added", () => {
    const v = {
      ...onlineView([checkinRound("stage-1:3", { division_id: "div-chess" }), checkinRound("stage-2:1", { division_id: "div-blitz", division_name: "Blitz" })]),
      needs_you: [row("no_scorer")],
    };
    const blitzBoard = v.online_rounds[1]!.round!.boards[0]!.fixtureId;
    const island = renderIsland(MatchDayShell, props(v, { divisions: [{ id: "div-chess", name: "Rapid" }, { id: "div-blitz", name: "Blitz" }] }));
    const chips = () => island.tree().filter((e) => propsOf(e)["data-testid"] === "md-division-chip");
    // Choose Rapid only: Blitz's round and boards are filtered out.
    (propsOf(chips()[0]!).onClick as () => void)();
    expect(parts(island.tree()).rounds.map((r) => r.key)).toEqual(["stage-1:3"]);
    (propsOf(toggleOf(island.tree())).onClick as () => void)();
    (propsOf(needsOf(island.tree())!).onOpenBoard as (id: string) => void)(blitzBoard);
    const p = parts(island.tree());
    expect(p.lost, "not 'left the list'").toBeNull();
    expect((p.board!.row as { fixtureId: string }).fixtureId).toBe(blitzBoard);
    expect(p.rounds.map((r) => r.key).sort()).toEqual(["stage-1:3", "stage-2:1"]);
    expect(chips().filter((c) => propsOf(c)["aria-pressed"] === true)).toHaveLength(2);
  });
});

describe("the division chips narrow the online block", () => {
  it("a chip for a division with no round (a badminton division) lists no round - the block disappears and the page says so; the chip off brings it back", () => {
    const v = onlineView([checkinRound("stage-1:3", { division_id: "div-chess" })], { courts: [court("c-1", "Court 1")] });
    const island = renderIsland(MatchDayShell, props(v, { divisions: [{ id: "div-chess", name: "Rapid" }, { id: "div-otb", name: "Badminton" }] }));
    const chips = () => island.tree().filter((e) => propsOf(e)["data-testid"] === "md-division-chip");
    expect(parts(island.tree()).rounds).toHaveLength(1);
    (propsOf(chips()[1]!).onClick as () => void)();
    expect(parts(island.tree()).rounds).toHaveLength(0);
    (propsOf(chips()[1]!).onClick as () => void)();
    expect(parts(island.tree()).rounds).toHaveLength(1);
    (propsOf(chips()[0]!).onClick as () => void)();
    expect(parts(island.tree()).rounds).toHaveLength(1);
  });
});

describe("the poll cadence: an online night polls as a live one", () => {
  it("a round in check-in with no court on the page polls at the live cadence; a round only paired does not; the flag off ignores the rounds", () => {
    renderIsland(MatchDayShell, props(onlineView([checkinRound("s:3")])));
    expect(poll.live).toBe(true);
    poll.live = null;
    renderIsland(MatchDayShell, props(onlineView([pairedRound("s:3")])));
    expect(poll.live).toBe(false);
    poll.live = null;
    renderIsland(MatchDayShell, props(onlineView([checkinRound("s:3")]), { onlineEnabled: false }));
    expect(poll.live, "the flag off: a day of nothing is quiet").toBe(false);
  });

  it("a board that starts on the next poll moves the cadence from quiet to live", async () => {
    const island = renderIsland(MatchDayShell, props(onlineView([round("s:3", "playing", arbiterRound([held(1)]))])));
    expect(poll.live).toBe(false);
    net.next = onlineView([round("s:3", "playing", arbiterRound([live(1)]))]);
    poll.tick!();
    await settle();
    island.tree();
    expect(poll.live).toBe(true);
  });
});
