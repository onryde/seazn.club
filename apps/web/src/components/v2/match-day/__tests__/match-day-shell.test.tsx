// Match Day's shell, DRIVEN (task A3 fix round 2: M5b, M6b). The static suite (match-day-ssr.test.tsx) renders one instant;
// these two behaviours are sequences — a refusal, then the refresh it triggers; a court opened, lost, then back — so the shell
// runs under the node-env hook harness (components/__tests__/_hook-harness.tsx), with the network and the poll schedule stubbed
// and the poll's own tick driven by hand. Its children are not expanded: the assertions read the props the shell hands them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";

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

/** The band poll's schedule is a browser's (visibility, timers): stubbed, and its tick kept so a test can fire it. */
const poll = vi.hoisted(() => ({ tick: null as null | (() => void) }));
vi.mock("@/components/v2/desk/band-poll", () => ({
  browserBandPollDeps: () => ({}),
  startBandPolling: (_live: boolean, tick: () => void) => {
    poll.tick = tick;
    return () => {};
  },
}));

import en from "@/dictionaries/en/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MatchDayCourt, MatchDayFixture, MatchDayView } from "@/lib/match-day/types";
import { CourtFocus, NoCourtFocus } from "../court-focus";
import { CourtList, NoCourtList } from "../court-list";
import { MatchDayShell, type MatchDayShellProps } from "../match-day-shell";
import { NeedsYou, type NeedsYouItem } from "@/components/v2/desk/needs-you";

const court = (id: string, name: string, o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
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
  ...o,
});

const view = (courts: MatchDayCourt[], now: string, playing_no_court: MatchDayFixture[] = []): MatchDayView => ({
  competition_id: "comp-1",
  date: "2026-10-31",
  tz: "Europe/London",
  now,
  courts,
  playing_no_court,
  needs_you: [],
  results_owed: 0,
  fixtures_today: 0,
  venues_today: [],
});

const C1 = court("c-1", "Court 1");
const C2 = court("c-2", "Court 2");

const props = (initial: MatchDayView): MatchDayShellProps => ({
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
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function parts(tree: ReactElement[]) {
  const focus = tree.find((e) => e.type === CourtFocus);
  const list = tree.find((e) => e.type === CourtList)!;
  const listBox = tree.find((e) => propsOf(e)["data-testid"] === "md-list")!;
  return {
    focus: focus === undefined ? null : propsOf(focus),
    list: propsOf(list),
    listHiddenOnPhone: String(propsOf(listBox).className).split(/\s+/).includes("max-md:hidden"),
    lost: tree.some((e) => propsOf(e)["data-testid"] === "md-lost"),
  };
}

beforeEach(() => {
  net.calls = [];
  net.next = null;
  poll.tick = null;
});

describe("M5b — a refusal is held through the refresh it triggers", () => {
  it("onRefused shows the notice on the court it came from, refreshes, and the notice is still there after the refresh lands", async () => {
    const island = renderIsland(MatchDayShell, props(view([C1, C2], "2026-10-31T11:00:00.000Z")));
    (parts(island.tree()).list.onSelect as (id: string) => void)("c-1");
    const before = parts(island.tree()).focus!;
    expect(before.court).toMatchObject({ court_id: "c-1" });
    expect(before.notice).toBeNull();

    net.next = view([C1, C2], "2026-10-31T11:00:30.000Z");
    (before.onRefused as (m: string) => void)("Zara Khan is on Court 2.");
    await settle();

    // The refresh really ran and landed (the view moved on), and the refusal is still on screen.
    expect(net.calls).toEqual(["/api/v1/competitions/comp-1/match-day"]);
    const after = parts(island.tree()).focus!;
    expect(after.refreshKey).toBe("2026-10-31T11:00:30.000Z");
    expect(after.notice).toBe("Zara Khan is on Court 2.");
    // Dismissed, it goes.
    (after.onDismissNotice as () => void)();
    expect(parts(island.tree()).focus!.notice).toBeNull();
  });
});

describe("M6b — a phone that lost its court goes back to the list, and stays there", () => {
  it("opened on a phone, the court leaves the list (back to the list, saying so); when it comes back the phone stays on the list", async () => {
    const island = renderIsland(MatchDayShell, props(view([C1, C2], "2026-10-31T11:00:00.000Z")));
    (parts(island.tree()).list.onSelect as (id: string) => void)("c-1");
    let p = parts(island.tree());
    // Opened: the phone shows the court full-screen over a hidden list.
    expect(p.focus!.hiddenOnPhone).toBe(false);
    expect(p.listHiddenOnPhone).toBe(true);
    expect(poll.tick).not.toBeNull();

    // Court 1 leaves the list (its day, or a filter): the page says so and the phone is on the list.
    net.next = view([C2], "2026-10-31T11:00:30.000Z");
    poll.tick!();
    await settle();
    p = parts(island.tree());
    expect(p.lost).toBe(true);
    expect(p.focus).toBeNull();
    expect(p.listHiddenOnPhone).toBe(false);

    // It comes back: the desktop focuses it again, but a phone that was sent back to the list is not jumped into it.
    net.next = view([C1, C2], "2026-10-31T11:01:00.000Z");
    poll.tick!();
    await settle();
    p = parts(island.tree());
    expect(p.lost).toBe(false);
    expect(p.focus!.court).toMatchObject({ court_id: "c-1" });
    expect(p.focus!.hiddenOnPhone).toBe(true);
    expect(p.listHiddenOnPhone).toBe(false);
    expect(net.calls).toHaveLength(2);
  });
});

describe("A4 — Needs you opens from the header's button, results owed first, and follows the poll", () => {
  const row = (kind: NeedsYouItem["kind"], severity: NeedsYouItem["severity"], key = kind): NeedsYouItem => ({
    key,
    kind,
    severity,
    title: `${kind} title`,
    sub: `${kind} sub`,
    action: { label: `${kind} action`, href: `/x/${kind}` },
  });
  /** The desk's order: severity first (needs-you.tsx), so the red no_scorer row arrives before the amber owed one. */
  const desk = [row("no_scorer", "red"), row("unscheduled", "amber"), row("result_missing", "amber"), row("registrations_waiting", "slate")];
  const toggleOf = (tree: ReactElement[]) => tree.find((e) => propsOf(e)["data-testid"] === "md-needs-you-toggle");
  const listOf = (tree: ReactElement[]) => tree.find((e) => e.type === NeedsYou);
  const boxOf = (tree: ReactElement[]) => tree.find((e) => propsOf(e)["data-testid"] === "md-needs-you");

  it("EMPTY CASE FIRST: no rows — no button, no list", () => {
    const island = renderIsland(MatchDayShell, props(view([C1], "2026-10-31T11:00:00.000Z")));
    expect(toggleOf(island.tree())).toBeUndefined();
    expect(listOf(island.tree())).toBeUndefined();
  });

  it("closed at first; a tap opens the desk's own list with the owed rows FIRST; a poll moves the list; a second tap closes it", async () => {
    const island = renderIsland(MatchDayShell, props({ ...view([C1], "2026-10-31T11:00:00.000Z"), needs_you: desk, results_owed: 2 }));
    let tree = island.tree();
    expect(propsOf(toggleOf(tree)!)["aria-expanded"]).toBe(false);
    expect(propsOf(boxOf(tree)!).hidden).toBe(true);
    expect(listOf(tree)).toBeUndefined();

    (propsOf(toggleOf(tree)!).onClick as () => void)();
    tree = island.tree();
    expect(propsOf(toggleOf(tree)!)["aria-expanded"]).toBe(true);
    expect(propsOf(boxOf(tree)!).hidden).toBe(false);
    const items = propsOf(listOf(tree)!).items as NeedsYouItem[];
    expect(items.map((i) => i.kind)).toEqual(["result_missing", "no_scorer", "unscheduled", "registrations_waiting"]);

    // The poll brings a day where the owed result was entered: the open list follows it.
    net.next = { ...view([C1], "2026-10-31T11:00:30.000Z"), needs_you: desk.filter((r) => r.kind !== "result_missing"), results_owed: 0 };
    poll.tick!();
    await settle();
    tree = island.tree();
    expect((propsOf(listOf(tree)!).items as NeedsYouItem[]).map((i) => i.kind)).toEqual(["no_scorer", "unscheduled", "registrations_waiting"]);

    (propsOf(toggleOf(tree)!).onClick as () => void)();
    tree = island.tree();
    expect(propsOf(toggleOf(tree)!)["aria-expanded"]).toBe(false);
    expect(listOf(tree)).toBeUndefined();
  });

  it("m5 — open, a poll EMPTIES the list (button gone), a later poll brings rows back: the button returns CLOSED, the list does not reopen unasked", async () => {
    const island = renderIsland(MatchDayShell, props({ ...view([C1], "2026-10-31T11:00:00.000Z"), needs_you: desk, results_owed: 2 }));
    (propsOf(toggleOf(island.tree())!).onClick as () => void)();
    expect(propsOf(toggleOf(island.tree())!)["aria-expanded"]).toBe(true);
    expect(listOf(island.tree())).toBeDefined();

    net.next = { ...view([C1], "2026-10-31T11:00:30.000Z"), needs_you: [], results_owed: 0 };
    poll.tick!();
    await settle();
    expect(toggleOf(island.tree())).toBeUndefined();
    expect(listOf(island.tree())).toBeUndefined();

    net.next = { ...view([C1], "2026-10-31T11:01:00.000Z"), needs_you: [row("unscheduled", "amber")], results_owed: 0 };
    poll.tick!();
    await settle();
    const tree = island.tree();
    expect(toggleOf(tree), "the button is back").toBeDefined();
    expect(propsOf(toggleOf(tree)!)["aria-expanded"]).toBe(false);
    expect(propsOf(boxOf(tree)!).hidden).toBe(true);
    expect(listOf(tree)).toBeUndefined();
    expect(net.calls).toHaveLength(2);
  });
});

describe("B4 — a match on no court, opened, ended; Needs you's Find a court; a view-only reader", () => {
  const match = (id: string, home: string, away: string): MatchDayFixture => ({
    id,
    division_id: "d-1",
    division_name: "Cup",
    division_slug: "cup",
    fixture_no: 3,
    sport_key: "generic",
    stage_label: "Knockout",
    round: { code: "QF", label: "Quarter-finals", coded: true },
    home,
    away,
    home_entrant_id: `${id}-h`,
    away_entrant_id: `${id}-a`,
    headline: null,
    summary: null,
    serving: null,
    started_at: "2026-10-31T10:40:00.000Z",
    called_at: null,
    stream: null,
    scorer_attention: null,
    live_video: null,
    format_line: null,
  });
  const M1 = match("m-1", "Ana", "Ben");
  const M2 = match("m-2", "Cleo", "Dan");
  const noCourtParts = (tree: ReactElement[]) => {
    const list = tree.find((e) => e.type === NoCourtList);
    const focus = tree.find((e) => e.type === NoCourtFocus);
    const listBox = tree.find((e) => propsOf(e)["data-testid"] === "md-list")!;
    return {
      list: list === undefined ? null : propsOf(list),
      focus: focus === undefined ? null : propsOf(focus),
      listHiddenOnPhone: String(propsOf(listBox).className).split(/\s+/).includes("max-md:hidden"),
      lost: tree.find((e) => propsOf(e)["data-testid"] === "md-lost"),
    };
  };

  it("EMPTY CASE FIRST: no courts and nothing on no court — no list at all, no focus", () => {
    const tree = renderIsland(MatchDayShell, props(view([], "2026-10-31T11:00:00.000Z"))).tree();
    expect(tree.find((e) => e.type === NoCourtList)).toBeUndefined();
    expect(tree.find((e) => e.type === NoCourtFocus)).toBeUndefined();
    expect(tree.find((e) => propsOf(e)["data-testid"] === "md-empty")).toBeDefined();
  });

  it("R3 (fix round 1): the group is titled in its matches' own word — 'court' for a generic sport, 'board' once they are all chess, 'court' again when they mix — on every poll", async () => {
    const chess = (id: string): MatchDayFixture => ({ ...match(id, "Kim", "Lee"), sport_key: "chess" });
    const island = renderIsland(MatchDayShell, props(view([C1], "2026-10-31T11:00:00.000Z", [M1])));
    const nounOf = () => noCourtParts(island.tree()).list!.noun;
    expect(nounOf()).toBe("court");
    net.next = view([C1], "2026-10-31T11:00:30.000Z", [chess("m-3"), chess("m-4")]);
    poll.tick!();
    await settle();
    expect(nounOf()).toBe("board");
    net.next = view([C1], "2026-10-31T11:01:00.000Z", [chess("m-3"), M1]);
    poll.tick!();
    await settle();
    expect(nounOf()).toBe("court");
    expect(net.calls, "two polls after the first view, each drawn").toHaveLength(2);
  });

  it("tapped on a phone, the match opens full-screen; it ENDS on the next poll — lost, by its match, the phone back on the list; a new match arriving is not jumped into", async () => {
    const island = renderIsland(MatchDayShell, props(view([C1], "2026-10-31T11:00:00.000Z", [M1, M2])));
    let p = noCourtParts(island.tree());
    // Courts first: the desktop opens Court 1; the group is listed under it.
    expect((p.list!.fixtures as MatchDayFixture[]).map((f) => f.id)).toEqual(["m-1", "m-2"]);
    expect(p.focus).toBeNull();
    (p.list!.onSelect as (f: MatchDayFixture) => void)(M2);
    p = noCourtParts(island.tree());
    expect(p.focus!.fixture).toMatchObject({ id: "m-2" });
    expect(p.focus!.hiddenOnPhone).toBe(false);
    expect(p.listHiddenOnPhone).toBe(true);
    expect(p.list!.selectedId).toBe("m-2");
    // A playing match on no court keeps the poll fast.
    expect(poll.tick).not.toBeNull();

    net.next = view([C1], "2026-10-31T11:00:30.000Z", [M1]);
    poll.tick!();
    await settle();
    p = noCourtParts(island.tree());
    expect(p.focus).toBeNull();
    expect(p.lost, "the page says the match left").toBeDefined();
    expect(JSON.stringify(propsOf(p.lost!).children)).toContain("Cleo v Dan");
    expect(p.listHiddenOnPhone).toBe(false);

    net.next = view([C1], "2026-10-31T11:01:00.000Z", [M1, M2]);
    poll.tick!();
    await settle();
    p = noCourtParts(island.tree());
    expect(p.focus!.fixture).toMatchObject({ id: "m-2" });
    expect(p.focus!.hiddenOnPhone, "a phone sent back to the list stays there").toBe(true);
    expect(net.calls).toHaveLength(2);
  });

  const unscheduled: NeedsYouItem = {
    key: "d-1:unscheduled",
    kind: "unscheduled",
    severity: "amber",
    title: "2 matches unscheduled",
    sub: "sub",
    action: { label: "Open the schedule board", href: "/x/schedule" },
  };
  const openList = (island: { tree: () => ReactElement[] }) => {
    const toggle = island.tree().find((e) => propsOf(e)["data-testid"] === "md-needs-you-toggle")!;
    (propsOf(toggle).onClick as () => void)();
    return propsOf(island.tree().find((e) => e.type === NeedsYou)!);
  };

  it("Find a court (fix round 1, R2): the shell opens the court the SERVER chose for the division — not the first free one on its own list — full-screen on a phone, and the list closes", () => {
    // Both courts free; the server said Court 2 (the one the division's ready match may use).
    const withAlt: NeedsYouItem = {
      ...unscheduled,
      alt: { label: "Find a court", href: "/o/acme/c/westway-open/match-day?court=c-2", court_id: "c-2" },
    };
    const island = renderIsland(MatchDayShell, props({ ...view([C1, C2], "2026-10-31T11:00:00.000Z"), needs_you: [withAlt] }));
    expect(parts(island.tree()).focus!.court, "premise: Court 1 opens first").toMatchObject({ court_id: "c-1" });
    const list = openList(island);
    expect(list.items, "the rows as the server sent them").toEqual([withAlt]);
    (list.onAlt as (i: NeedsYouItem) => void)(withAlt);
    const tree = island.tree();
    const p = parts(tree);
    expect(p.focus!.court).toMatchObject({ court_id: "c-2" });
    expect(p.focus!.hiddenOnPhone).toBe(false);
    expect(tree.find((e) => e.type === NeedsYou), "the list closed").toBeUndefined();
  });

  it("Find a court with no usable court free (court_id null): the list closes and a phone is on the court list; a row the server gave none keeps none", () => {
    const busy = [court("c-1", "Court 1", { state: "called" }), court("c-2", "Court 2", { state: "in_use_elsewhere" })];
    const toList: NeedsYouItem = { ...unscheduled, alt: { label: "Find a court", href: "/o/acme/c/westway-open/match-day", court_id: null } };
    const bare: NeedsYouItem = { ...unscheduled, key: "d-2:unscheduled" };
    const island = renderIsland(MatchDayShell, props({ ...view(busy, "2026-10-31T11:00:00.000Z"), needs_you: [toList, bare] }));
    (parts(island.tree()).list.onSelect as (id: string) => void)("c-2");
    expect(parts(island.tree()).listHiddenOnPhone).toBe(true);
    const list = openList(island);
    const items = list.items as NeedsYouItem[];
    expect(items.map((i) => (i.alt === undefined ? "none" : i.alt.court_id))).toEqual([null, "none"]);
    (list.onAlt as (i: NeedsYouItem) => void)(toList);
    const tree = island.tree();
    expect(parts(tree).listHiddenOnPhone).toBe(false);
    expect(tree.find((e) => e.type === NeedsYou)).toBeUndefined();
  });

  it("a view-only reader: the rows are there on every poll, and no Needs-you button ever is", async () => {
    const island = renderIsland(MatchDayShell, {
      ...props({ ...view([C1], "2026-10-31T11:00:00.000Z"), needs_you: [unscheduled] }),
      readOnly: true,
    });
    const toggle = () => island.tree().find((e) => propsOf(e)["data-testid"] === "md-needs-you-toggle");
    expect(toggle()).toBeUndefined();
    net.next = { ...view([C1], "2026-10-31T11:00:30.000Z"), needs_you: [unscheduled, { ...unscheduled, key: "d-2:unscheduled" }] };
    poll.tick!();
    await settle();
    expect(net.calls).toHaveLength(1);
    expect(toggle()).toBeUndefined();
    expect(island.tree().find((e) => e.type === NeedsYou)).toBeUndefined();
  });
});

describe("E2-2 — the shell hands the list its courts in group order, and the desktop opens on the first of them", () => {
  it("playing, called, up next, then free — whatever order the server sent — and no court is lost on the way", () => {
    const sent = [
      court("c-1", "Court 1"),
      court("c-2", "Court 2", { state: "called" }),
      court("c-3", "Court 3", { state: "playing" }),
      court("c-4", "Court 4"),
    ];
    const island = renderIsland(MatchDayShell, props(view(sent, "2026-10-31T11:00:00.000Z")));
    const p = parts(island.tree());
    const listed = (p.list.courts as MatchDayCourt[]).map((c) => c.court_id);
    expect(listed).toEqual(["c-3", "c-2", "c-1", "c-4"]);
    expect([...listed].sort()).toEqual(sent.map((c) => c.court_id).sort());
    // The desktop's default focus is the head of that list: the court that is playing, not the first the server named.
    expect(p.focus!.court).toMatchObject({ court_id: "c-3" });
  });

  it("a court that starts playing between two polls moves to the head, and the list follows the poll", async () => {
    const island = renderIsland(MatchDayShell, props(view([C1, C2], "2026-10-31T11:00:00.000Z")));
    expect((parts(island.tree()).list.courts as MatchDayCourt[]).map((c) => c.court_id)).toEqual(["c-1", "c-2"]);
    net.next = view([C1, court("c-2", "Court 2", { state: "playing" })], "2026-10-31T11:00:30.000Z");
    poll.tick!();
    await settle();
    expect((parts(island.tree()).list.courts as MatchDayCourt[]).map((c) => c.court_id)).toEqual(["c-2", "c-1"]);
  });
});

describe("m1 — a closure follows the browser's clock between polls (fix round 1)", () => {
  // The hours are declared here, then the clock is walked across them: Court 1 has a break 14:00-15:00 (a "later" closure at 13:58),
  // Court 2 is closed until 14:30 at 14:00. Nothing re-polls; only the minute tick moves.
  const later = { kind: "later" as const, from: "2026-10-31T14:00:00.000Z", until: "2026-10-31T15:00:00.000Z" };
  const shutUntil = { kind: "now" as const, until: "2026-10-31T14:30:00.000Z" };
  const closureOf = (island: { tree: () => ReactElement[] }, id: string) =>
    (parts(island.tree()).list.courts as MatchDayCourt[]).find((c) => c.court_id === id)!.closure;
  const orderOf = (island: { tree: () => ReactElement[] }) => (parts(island.tree()).list.courts as MatchDayCourt[]).map((c) => c.court_id);

  const run = (fn: () => void) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      fn();
    } finally {
      vi.useRealTimers();
    }
  };

  it("a break to come begins on the minute tick (later -> now), ends on a later one (now -> none), and the court changes group with it — no poll in between", () => {
    run(() => {
      vi.setSystemTime(Date.parse("2026-10-31T13:58:00.000Z"));
      const island = renderIsland(
        MatchDayShell,
        props(view([court("c-1", "Court 1", { closure: later }), court("c-2", "Court 2")], "2026-10-31T13:58:00.000Z")),
      );
      expect(closureOf(island, "c-1")).toEqual(later);
      expect(orderOf(island)).toEqual(["c-1", "c-2"]);

      // 14:00:30 - the break has begun: the card is "closed now" and the court drops behind the free one.
      vi.setSystemTime(Date.parse("2026-10-31T14:00:30.000Z"));
      vi.advanceTimersByTime(60_000);
      expect(closureOf(island, "c-1")).toEqual({ kind: "now", until: later.until });
      expect(orderOf(island)).toEqual(["c-2", "c-1"]);
      expect(net.calls).toEqual([]);

      // 15:02 - it has reopened.
      vi.setSystemTime(Date.parse("2026-10-31T15:02:00.000Z"));
      vi.advanceTimersByTime(60_000);
      expect(closureOf(island, "c-1")).toBeNull();
      expect(orderOf(island)).toEqual(["c-1", "c-2"]);
      expect(net.calls).toEqual([]);
    });
  });

  it("a court closed until 14:30 reopens on the tick after 14:30, and not one before", () => {
    run(() => {
      vi.setSystemTime(Date.parse("2026-10-31T14:00:00.000Z"));
      const island = renderIsland(MatchDayShell, props(view([court("c-1", "Court 1", { closure: shutUntil })], "2026-10-31T14:00:00.000Z")));
      // Advancing the timers moves the fake clock a minute too, so each tick is set up one minute before the instant it reads.
      const tickAt = (iso: string) => {
        vi.setSystemTime(Date.parse(iso) - 60_000);
        vi.advanceTimersByTime(60_000);
      };
      for (const at of ["14:10:00", "14:29:59"]) {
        tickAt(`2026-10-31T${at}.000Z`);
        expect(closureOf(island, "c-1"), at).toEqual(shutUntil);
      }
      tickAt("2026-10-31T14:30:00.000Z");
      expect(closureOf(island, "c-1")).toBeNull();
    });
  });

  it("a client clock BEHIND the view never un-closes a court the view already said was shut", () => {
    run(() => {
      // The browser thinks it is 13:00; the server's view, read at 14:10, says Court 1 is closed until 14:30.
      vi.setSystemTime(Date.parse("2026-10-31T13:00:00.000Z"));
      const island = renderIsland(MatchDayShell, props(view([court("c-1", "Court 1", { closure: shutUntil })], "2026-10-31T14:10:00.000Z")));
      vi.advanceTimersByTime(60_000);
      expect(closureOf(island, "c-1")).toEqual(shutUntil);
    });
  });

  it("no court has a closure: the tick changes nothing (the same courts, in the same order)", () => {
    run(() => {
      vi.setSystemTime(Date.parse("2026-10-31T11:00:00.000Z"));
      const island = renderIsland(MatchDayShell, props(view([C1, C2], "2026-10-31T11:00:00.000Z")));
      const before = parts(island.tree()).list.courts as MatchDayCourt[];
      vi.setSystemTime(Date.parse("2026-10-31T11:05:00.000Z"));
      vi.advanceTimersByTime(60_000);
      const after = parts(island.tree()).list.courts as MatchDayCourt[];
      // The SAME court objects: a tick that changed nothing for a court hands it back untouched.
      expect(after).toHaveLength(2);
      after.forEach((c, i) => expect(c).toBe(before[i]));
      expect(orderOf(island)).toEqual(["c-1", "c-2"]);
    });
  });

  it("the focused court's panel follows too: the open court's closure is the clock's, not the poll's", () => {
    run(() => {
      vi.setSystemTime(Date.parse("2026-10-31T13:58:00.000Z"));
      const island = renderIsland(MatchDayShell, props(view([court("c-1", "Court 1", { closure: later })], "2026-10-31T13:58:00.000Z")));
      expect((parts(island.tree()).focus!.court as MatchDayCourt).closure).toEqual(later);
      vi.setSystemTime(Date.parse("2026-10-31T14:05:00.000Z"));
      vi.advanceTimersByTime(60_000);
      expect((parts(island.tree()).focus!.court as MatchDayCourt).closure).toEqual({ kind: "now", until: later.until });
    });
  });
});
