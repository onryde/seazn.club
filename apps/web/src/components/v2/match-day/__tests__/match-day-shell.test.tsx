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
import type { MatchDayCourt, MatchDayView } from "@/lib/match-day/types";
import { CourtFocus } from "../court-focus";
import { CourtList } from "../court-list";
import { MatchDayShell, type MatchDayShellProps } from "../match-day-shell";
import { NeedsYou, type NeedsYouItem } from "@/components/v2/desk/needs-you";

const court = (id: string, name: string, o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: id,
  court_name: name,
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "free",
  current: null,
  in_use_by: null,
  free_since: null,
  queue: [],
  ...o,
});

const view = (courts: MatchDayCourt[], now: string): MatchDayView => ({
  competition_id: "comp-1",
  date: "2026-10-31",
  tz: "Europe/London",
  now,
  courts,
  needs_you: [],
  results_owed: 0,
  fixtures_today: 0,
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
});
