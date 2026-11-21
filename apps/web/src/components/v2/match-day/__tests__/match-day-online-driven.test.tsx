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

const net = vi.hoisted(() => ({
  calls: [] as string[],
  next: null as unknown,
  /** The join route's POSTs (`/external-play/arbiter`), kept apart from `calls` so the day's own reads are counted on their own. */
  joins: [] as { url: string; side: string }[],
  /** What the join route answers: a token by default; a test sets a refusal. */
  joinRefusal: null as null | { code: string; status: number },
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { json?: { side: string } }) => {
      if (url.includes("/external-play/arbiter")) {
        net.joins.push({ url, side: options!.json!.side });
        if (net.joinRefusal !== null) return Promise.reject(new actual.ApiV1Error(net.joinRefusal.code, net.joinRefusal.status, net.joinRefusal.code));
        return Promise.resolve({ authToken: `tok|${url}|${options!.json!.side}`, participantId: "p", side: options!.json!.side, players: ["pl"], reused: false });
      }
      net.calls.push(url);
      return Promise.resolve(net.next);
    },
  };
});
/** The SDK at its one boundary: a join that succeeds and leaves, counted. The real chain (serial, keys, ladder) runs over it. */
const sdk = vi.hoisted(() => ({ connects: [] as string[], leaves: [] as string[], open: new Map<string, number>() }));
vi.mock("../online/arbiter-camera", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../online/arbiter-camera")>();
  return {
    ...actual,
    joinArbiter: async ({ authToken }: { authToken: string }) => {
      sdk.connects.push(authToken);
      sdk.open.set(authToken, (sdk.open.get(authToken) ?? 0) + 1);
      return {
        tile: () => ({ present: true, live: true, track: null }),
        onChange: () => () => undefined,
        onFault: () => () => undefined,
        leave: async () => {
          sdk.leaves.push(authToken);
          sdk.open.set(authToken, (sdk.open.get(authToken) ?? 1) - 1);
        },
      };
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
import type { ArbiterBoard } from "@/lib/arbiter-view";
import type { MatchDayCourt, MatchDayOnlineRound, MatchDayView } from "@/lib/match-day/types";
import { mayPress, type Reader } from "@/lib/match-day/online";
import { NO_FROZEN_NAMES } from "@/lib/match-day/frozen-names";
import { NeedsYou, type NeedsYouItem } from "@/components/v2/desk/needs-you";
import { CourtFocus } from "../court-focus";
import { MatchDayShell, type MatchDayShellProps } from "../match-day-shell";
import { OnlineList } from "../online-list";
import { BoardFocus } from "../board-focus";
import { RoundFocus } from "../round-focus";
import { arbiterRound, checkinRound, earlier, held, live, onlineView, pairedRound, present, round, withState } from "./_online-fixtures";

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
  ...o,
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const at = (n: number) => `2026-11-19T18:0${n}:00.000Z`;

/** What the shell handed its children, read off the element tree. */
function parts(tree: ReactElement[]) {
  const list = tree.find((e) => e.type === OnlineList);
  const boardPanel = tree.find((e) => e.type === BoardFocus);
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
  net.joins = [];
  net.joinRefusal = null;
  sdk.connects = [];
  sdk.leaves = [];
  sdk.open = new Map();
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
    // Back (MD-R35): the phone is on the list AND the board is out of focus - a hidden panel would keep its cameras joined behind the list.
    // The desktop's focus falls back to its default (the first round); a desktop has no Back to press.
    (p.board!.onBack as () => void)();
    const back = parts(island.tree());
    expect(back.listHiddenOnPhone).toBe(false);
    expect(back.board, "the board is no longer the focus").toBeNull();
    expect(back.round, "the default focus is the day's first round, hidden behind the list on a phone").toMatchObject({ hiddenOnPhone: true });
    expect(back.selected, "no board row is highlighted: the round is").toMatchObject({ kind: "round" });
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

describe("MD-R30: a 402 seen by the round panel lifts every press that starts play, for good (until the page reloads)", () => {
  // `frozen` is read when the page loads; a freeze that lands under an open page is only learned from a press answered 402. The panel tells the shell
  // (`onFrozen`), the shell keeps it and folds it into the reader every panel is handed - so the press goes inert without waiting for a reload.
  it("onFrozen flips the round panel's AND the board panel's reader to frozen: start is gone, the decisions that finish play stay; a poll does not take it back", async () => {
    const v = { ...night(), online_rounds: [round("stage-1:3", "playing", arbiterRound([live(5, { fixtureId: "b-9" })]))] };
    const island = renderIsland(MatchDayShell, props(v, { focusRoundKey: "stage-1:3" }));
    const roundReader = () => parts(island.tree()).round!.reader as Reader;
    expect(roundReader(), "before: not frozen, and start is offered").toEqual({ editor: true, offered: true, frozen: false });
    expect(mayPress(roundReader(), "start")).toBe(true);
    expect(typeof parts(island.tree()).round!.onFrozen, "anti-vacuity: the shell hands the panel the callback").toBe("function");
    (parts(island.tree()).round!.onFrozen as () => void)();
    expect(roundReader(), "after: frozen").toEqual({ editor: true, offered: true, frozen: true });
    expect(mayPress(roundReader(), "start"), "no press that starts play").toBe(false);
    expect(mayPress(roundReader(), "finish"), "the decisions that finish play stay (the freeze exempts results)").toBe(true);
    // the same callback again is harmless; a poll whose page still says `frozen: false` does not lift it
    (parts(island.tree()).round!.onFrozen as () => void)();
    net.next = { ...v, now: at(1) };
    poll.tick!();
    await settle();
    expect(roundReader(), "a poll cannot say the competition is unfrozen: only a reload can").toEqual({ editor: true, offered: true, frozen: true });
    // a board opened afterwards is the same competition: its panel reads the freeze too
    (parts(island.tree()).list!.onOpenBoard as (id: string) => void)("b-9");
    expect(parts(island.tree()).board!.reader, "the board panel's reader").toEqual({ editor: true, offered: true, frozen: true });
    // and a page that loads frozen=false and never saw a 402 is not frozen (the flag is state of THIS page, not of the module)
    const fresh = renderIsland(MatchDayShell, props(v, { focusRoundKey: "stage-1:3" }));
    expect(parts(fresh.tree()).round!.reader).toMatchObject({ frozen: false });
  });
});

describe("Needs you opens boards and rounds in place (the desk's own rows, §9)", () => {
  const row = (kind: NeedsYouItem["kind"]): NeedsYouItem => ({ key: kind, kind, severity: "red", title: `${kind} title`, sub: `${kind} sub`, action: { label: `${kind} action`, href: `/x/${kind}` } });
  const withNeeds = () => ({ ...night(), needs_you: [row("no_scorer")] });
  const toggleOf = (tree: ReactElement[]) => tree.find((e) => propsOf(e)["data-testid"] === "md-needs-you-toggle")!;
  const needsOf = (tree: ReactElement[]) => tree.find((e) => e.type === NeedsYou);

  it("onOpenBoard opens the board and CLOSES the list; onOpenRound opens the round and closes it", () => {
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
  it("a round in check-in with no court on the page polls at the live cadence; a round only paired does not", () => {
    renderIsland(MatchDayShell, props(onlineView([checkinRound("s:3")])));
    expect(poll.live).toBe(true);
    poll.live = null;
    renderIsland(MatchDayShell, props(onlineView([pairedRound("s:3")])));
    expect(poll.live).toBe(false);
    poll.live = null;
    renderIsland(MatchDayShell, props(onlineView([]), {}));
    expect(poll.live, "a day of nothing is quiet").toBe(false);
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

// ---- the cameras of the board in focus, produced by the REAL chain (Task 9) -----------------------------------------------------------------
// shell -> meetingKeysOf -> useArbiterJoins -> browserSerial -> the join route (doubled at apiV1) -> the SDK (doubled at joinArbiter). Nothing
// below the shell is a fixture: the keys, the POSTs and the leaves are what the real code produces from a board the day's own view carried.

describe("the board in focus's cameras: only a watchable side is joined, only for an editor, and a board left is a board let go", () => {
  const joinable = (camera: "live" | "off" = "live") => ({ ...present(camera), joinable: true });
  /** The pre-minted room: open, a player participant on file, nobody counted in (the join would refuse it). */
  const preMinted = () => present("live");
  const camBoard = (id: string, sides: ArbiterBoard["sides"]) =>
    live(5, { fixtureId: id, boardNo: 1, white: { name: "Chen", personId: null }, black: { name: "Silva", personId: null }, cameraPolicy: "required", sides });
  const nightOf = (boards: ArbiterBoard[], now = at(0)): MatchDayView => ({ ...onlineView([round("stage-1:3", "playing", arbiterRound(boards))]), now });
  const both = () => ({ home: joinable(), away: joinable() });
  const drive = async (island: ReturnType<typeof renderIsland<MatchDayShellProps>>, boards: ArbiterBoard[], polls: number, tweak: (v: MatchDayView) => MatchDayView = (v) => v) => {
    for (let i = 1; i <= polls; i += 1) {
      net.next = tweak(nightOf(boards, at(i)));
      poll.tick!();
      await settle();
    }
  };

  it("EMPTY CASE FIRST: no board focused is no join at all - however many polls, whatever the boards' sides say", async () => {
    const boards = [camBoard("cam-0", both())];
    const island = renderIsland(MatchDayShell, props(nightOf(boards)));
    await settle();
    await drive(island, boards, 3);
    expect(parts(island.tree()).board, "nothing opened").toBeNull();
    expect(net.joins, "no POST").toEqual([]);
    expect(sdk.connects).toEqual([]);
    island.unmount();
  });

  it("a board whose rooms are pre-minted but whose players have not arrived POSTs NOTHING across three polls; the pair (both arrived) POSTs once a side and never again", async () => {
    const waiting = [camBoard("cam-pre", { home: preMinted(), away: preMinted() })];
    const a = renderIsland(MatchDayShell, props(nightOf(waiting), { focusBoardId: "cam-pre" }));
    await settle();
    await drive(a, waiting, 3);
    expect(net.joins, "open but not joinable: nothing to join").toEqual([]);
    expect((parts(a.tree()).board!.joins as { views: Map<string, unknown> }).views.size).toBe(0);
    a.unmount();

    const here = [camBoard("cam-here", both())];
    const b = renderIsland(MatchDayShell, props(nightOf(here), { focusBoardId: "cam-here" }));
    await settle();
    expect(net.joins.map((j) => j.side).sort(), "one POST for each player's meeting").toEqual(["away", "home"]);
    await drive(b, here, 3);
    expect(net.joins, "three polls later still two").toHaveLength(2);
    expect(sdk.connects, "and two SDK joins").toHaveLength(2);
    const views = (parts(b.tree()).board!.joins as { views: Map<string, { kind: string }> }).views;
    expect([...views.values()].map((v) => v.kind)).toEqual(["watching", "watching"]);
    b.unmount();
  });

  it("(pair) a side that arrives on a LATER poll is joined then, and only that side", async () => {
    const early = [camBoard("cam-late", { home: joinable(), away: preMinted() })];
    const island = renderIsland(MatchDayShell, props(nightOf(early), { focusBoardId: "cam-late" }));
    await settle();
    expect(net.joins.map((j) => j.side)).toEqual(["home"]);
    await drive(island, [camBoard("cam-late", both())], 1);
    expect(net.joins.map((j) => j.side), "the home side was not asked again").toEqual(["home", "away"]);
    island.unmount();
  });

  it("a view-only member and a club not offered online chess never join, whatever the board's sides say (the pair above joins)", async () => {
    const boards = [camBoard("cam-viewer", both())];
    let checked = 0;
    for (const [label, over] of [["view-only", { readOnly: true }], ["not offered", {}]] as const) {
      // The club's flag is the ROUND's (`offered`), and every poll carries it too.
      const tweak = (v: MatchDayView): MatchDayView => (label === "not offered" ? { ...v, online_rounds: v.online_rounds.map((r) => ({ ...r, offered: false })) } : v);
      const island = renderIsland(MatchDayShell, props(tweak(nightOf(boards)), { focusBoardId: "cam-viewer", ...over }));
      await settle();
      await drive(island, boards, 2, tweak);
      expect(net.joins, label).toEqual([]);
      expect(sdk.connects, label).toEqual([]);
      island.unmount();
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("SEQUENCE: open board A, then B, then A again - A's two meetings are left when B opens, B's when A returns, no meeting is ever joined twice at once, and the return POSTs nothing", async () => {
    const boards = [camBoard("cam-A", both()), { ...camBoard("cam-B", both()), boardNo: 2 }];
    const island = renderIsland(MatchDayShell, props(nightOf(boards)));
    const open = async (id: string) => {
      (parts(island.tree()).list!.onOpenBoard as (id: string) => void)(id);
      await settle();
      await settle();
    };
    const maxOpen = () => Math.max(0, ...sdk.open.values());
    await open("cam-A");
    expect(net.joins).toHaveLength(2);
    expect([...sdk.open.values()].reduce((a, b) => a + b, 0), "A's two meetings are live").toBe(2);
    await open("cam-B");
    expect(net.joins, "B: two more POSTs").toHaveLength(4);
    expect(sdk.leaves.filter((l) => l.includes("cam-A")), "A's meetings were left").toHaveLength(2);
    expect([...sdk.open.entries()].filter(([k, n]) => k.includes("cam-A") && n > 0), "no A meeting stays joined").toEqual([]);
    await open("cam-A");
    expect(net.joins, "back to A: the kept tokens, no new POST").toHaveLength(4);
    expect(sdk.leaves.filter((l) => l.includes("cam-B")), "B's meetings were left").toHaveLength(2);
    expect(sdk.connects, "A, B, A again: six SDK joins").toHaveLength(6);
    expect(maxOpen(), "no meeting was ever joined twice at once").toBe(1);
    island.unmount();
    await settle();
    expect([...sdk.open.values()].reduce((a, b) => a + b, 0), "the page going away left everything").toBe(0);
  });

  it("MD-R35 (phone): 'Back to the list' LEAVES both meetings - the board is no longer in focus, nothing is held in a hidden panel - and opening the board again rejoins on the kept tokens", async () => {
    const boards = [camBoard("cam-back", both())];
    const island = renderIsland(MatchDayShell, props(nightOf(boards)));
    const total = () => [...sdk.open.values()].reduce((a, b) => a + b, 0);
    (parts(island.tree()).list!.onOpenBoard as (id: string) => void)("cam-back");
    await settle();
    await settle();
    expect(total(), "premise: the opened board's two meetings are joined").toBe(2);
    expect(parts(island.tree()).board, "premise: its panel is on the screen").not.toBeNull();
    expect(parts(island.tree()).listHiddenOnPhone, "premise: the list is hidden behind it on a phone").toBe(true);

    // The phone's Back (the one control that leaves a board on a phone): the list shows, and the board is let go.
    (parts(island.tree()).board!.onBack as () => void)();
    await settle();
    await settle();
    const after = parts(island.tree());
    expect(after.listHiddenOnPhone, "the list is back").toBe(false);
    expect(after.board, "no board is in focus: nothing is keeping its meetings").toBeNull();
    expect(total(), "both meetings were left").toBe(0);
    expect(sdk.leaves, "by the SDK's own leave, twice").toHaveLength(2);
    // A poll while on the list asks for nothing and joins nothing.
    net.next = nightOf(boards, at(1));
    poll.tick!();
    await settle();
    expect(net.joins, "no new POST on the list").toHaveLength(2);
    expect(total(), "and still nothing joined").toBe(0);
    // Open it again: both meetings are joined again, on the tokens the first visit kept (no new POST).
    (parts(island.tree()).list!.onOpenBoard as (id: string) => void)("cam-back");
    await settle();
    await settle();
    expect(total(), "the return joins both meetings again").toBe(2);
    expect(net.joins, "without a new POST: the kept tokens").toHaveLength(2);
    island.unmount();
    await settle();
    expect(total(), "the page going away left everything").toBe(0);
  });

  it("MD-R35 (desktop): the focused board's meetings are held across polls while it stays in focus - there is no Back to press (the control is `md:hidden`), so the desktop's focus is untouched", async () => {
    const boards = [camBoard("cam-desk", both())];
    const island = renderIsland(MatchDayShell, props(nightOf(boards), { focusBoardId: "cam-desk" }));
    await settle();
    await drive(island, boards, 3);
    const total = () => [...sdk.open.values()].reduce((a, b) => a + b, 0);
    expect(parts(island.tree()).board, "still in focus").not.toBeNull();
    expect(total(), "both meetings still joined after three polls").toBe(2);
    expect(sdk.leaves, "nothing was left").toEqual([]);
    expect(net.joins, "and nothing was asked again").toHaveLength(2);
    island.unmount();
  });

  it("SEQUENCE through the shell's own poll: refused NOT_STARTED -> the day's next poll while the side is still watchable -> joined, with no press (the poll key reaches the hook)", async () => {
    net.joinRefusal = { code: "VIDEO_MEETING_NOT_STARTED", status: 409 };
    const boards = [camBoard("cam-flip", both())];
    const island = renderIsland(MatchDayShell, props(nightOf(boards), { focusBoardId: "cam-flip" }));
    await settle();
    const kinds = () => [...(parts(island.tree()).board!.joins as { views: Map<string, { kind: string }> }).views.values()].map((v) => v.kind);
    expect(kinds(), "refused: the player has not arrived as far as the route knows").toEqual(["notStarted", "notStarted"]);
    expect(net.joins).toHaveLength(2);
    net.joinRefusal = null; // the flag flipped: the loader's `joinable` was right
    await drive(island, boards, 1);
    expect(kinds()).toEqual(["watching", "watching"]);
    expect(net.joins, "exactly one more POST a side, from the poll").toHaveLength(4);
    island.unmount();
  });

  it("VIDEO_BUSY from the join route is a `busy` tile that waits, not an error: the panel is handed `busy` for both sides", async () => {
    net.joinRefusal = { code: "VIDEO_BUSY", status: 503 };
    const boards = [camBoard("cam-busy", both())];
    const island = renderIsland(MatchDayShell, props(nightOf(boards), { focusBoardId: "cam-busy" }));
    await settle();
    const views = (parts(island.tree()).board!.joins as { views: Map<string, { kind: string }> }).views;
    expect([...views.values()].map((v) => v.kind)).toEqual(["busy", "busy"]);
    expect(sdk.connects, "nothing joined").toEqual([]);
    island.unmount();
  });

  it("VIDEO_UNAVAILABLE (the vendor is down) reaches the panel as `unavailable` - the one answer the outage card keys on", async () => {
    net.joinRefusal = { code: "VIDEO_UNAVAILABLE", status: 503 };
    const boards = [camBoard("cam-down", both())];
    const island = renderIsland(MatchDayShell, props(nightOf(boards), { focusBoardId: "cam-down" }));
    await settle();
    const views = (parts(island.tree()).board!.joins as { views: Map<string, { kind: string }> }).views;
    expect([...views.values()].map((v) => v.kind)).toEqual(["unavailable", "unavailable"]);
    island.unmount();
  });
});
