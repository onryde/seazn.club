// Match Day E2 item 5 — the venue filter, driven (the shell's state and the filter's own checklist), under the node-env hook harness.
//
// The brief's rules, as assertions: the filter exists only when the courts span more than one venue; its default is the venues with
// a match today in this competition (else all); the URL carries the choice (`?venue=`) and wins on load; it intersects with the
// division chips; the summary line follows it; exactly one venue drops the "(Venue)" suffix; it is DISPLAY ONLY (no request the
// page makes carries it, so every call guard still sees every court); the checklist is a real checklist with 44px rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";

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
/** The address as Next's `useSearchParams` reads it: null outside the app router (the static suites), else a live query string. */
const nav = vi.hoisted(() => ({ search: null as null | URLSearchParams }));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useSearchParams: () => nav.search };
});
const poll = vi.hoisted(() => ({ tick: null as null | (() => void) }));
vi.mock("@/components/v2/desk/band-poll", () => ({
  browserBandPollDeps: () => ({}),
  startBandPolling: (_live: boolean, tick: () => void) => {
    poll.tick = tick;
    return () => {};
  },
}));

import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import type { MatchDayCourt, MatchDayFixture, MatchDayView } from "@/lib/match-day/types";
import { headerCountParts, venueOptions } from "@/lib/match-day/view";
import { CourtFocus } from "../court-focus";
import { CourtList } from "../court-list";
import { MatchDayShell, type MatchDayShellProps } from "../match-day-shell";
import { VenueFilter } from "../venue-filter";
import { NO_FROZEN_NAMES } from "@/lib/match-day/frozen-names";
import { NeedsYou, type NeedsYouItem } from "@/components/v2/desk/needs-you";

const dict = en as Dict;
const DICTS: Record<Locale, Dict> = { en, es, fr, nl } as Record<Locale, Dict>;

const HALL_A = { id: "v-a", name: "Hall A" };
const HALL_B = { id: "v-b", name: "Hall B" };
const court = (id: string, name: string, venue: { id: string; name: string }, o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: id,
  court_name: name,
  venue_id: venue.id,
  venue_name: venue.name,
  sport_noun: "court",
  state: "free",
  current: null,
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  ...o,
});
const fixture = (id: string, division: string): MatchDayFixture => ({
  id,
  division_id: division,
  division_name: division,
  division_slug: division,
  fixture_no: 1,
  sport_key: "badminton",
  stage_label: "League",
  round: { code: "R1", label: "Round 1", coded: false },
  home: "Ana",
  away: "Ben",
  home_entrant_id: "e-1",
  away_entrant_id: "e-2",
  headline: null,
  summary: null,
  serving: null,
  started_at: "2026-10-31T11:00:00.000Z",
  called_at: null,
  stream: null,
  scorer_attention: null,
  live_video: null,
  format_line: null,
});

// Two venues; "Court 1" is in both, so the server has qualified both names.
const A1 = court("c-a1", "Court 1 (Hall A)", HALL_A, { state: "playing", current: fixture("f-a1", "d-1") });
const A2 = court("c-a2", "Court 2", HALL_A);
const B1 = court("c-b1", "Court 1 (Hall B)", HALL_B, { state: "playing", current: fixture("f-b1", "d-2") });
const B2 = court("c-b2", "Court 3", HALL_B);
const B3 = court("c-b3", "Court 4", HALL_B);

const view = (courts: MatchDayCourt[], venues_today: string[], now = "2026-10-31T11:30:00.000Z"): MatchDayView => ({
  competition_id: "comp-1",
  date: "2026-10-31",
  tz: "Europe/London",
  now,
  courts,
  playing_no_court: [],
  needs_you: [],
  results_owed: 0,
  fixtures_today: 0,
  venues_today,
});

const props = (initial: MatchDayView, o: Partial<MatchDayShellProps> = {}): MatchDayShellProps => ({
  competitionId: "comp-1",
  competitionName: "Westway Open",
  orgSlug: "acme",
  compSlug: "westway-open",
  locale: "en",
  divisions: [],
  initial,
  dict,
  scoreDict: publicEn as Dict,
  viewerPlan: "pro",
  frozenNames: NO_FROZEN_NAMES,
  ...o,
});

const replaceState = vi.fn();
beforeEach(() => {
  net.calls = [];
  net.next = null;
  poll.tick = null;
  nav.search = null;
  replaceState.mockClear();
  vi.stubGlobal("window", {
    history: { replaceState },
    location: { href: "https://seazn.test/o/acme/c/westway-open/match-day" },
    matchMedia: () => ({ matches: false }),
    scrollTo: () => {},
  });
});
afterEach(() => vi.unstubAllGlobals());

const filterOf = (tree: ReactElement[]) => tree.find((e) => e.type === VenueFilter);
const listOf = (tree: ReactElement[]) => propsOf(tree.find((e) => e.type === CourtList)!);
const listed = (tree: ReactElement[]) => (listOf(tree).courts as MatchDayCourt[]).map((c) => c.court_id);
const names = (tree: ReactElement[]) => (listOf(tree).courts as MatchDayCourt[]).map((c) => c.court_name);
const choose = (island: { tree: () => ReactElement[] }, ids: string[]) =>
  (propsOf(filterOf(island.tree())!).onChange as (s: ReadonlySet<string>) => void)(new Set(ids));
const countsOf = (tree: ReactElement[]) => {
  const dots = tree.find((e) => propsOf(e).testId === "md-counts")!;
  return propsOf(dots).parts as string[];
};

describe("the shell — when the filter exists and what it starts as", () => {
  it("one venue: no filter (and no venue ever written to the address)", () => {
    const island = renderIsland(MatchDayShell, props(view([A1, A2], ["v-a"])));
    expect(filterOf(island.tree())).toBeUndefined();
    expect(listed(island.tree())).toEqual(["c-a1", "c-a2"]);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("two venues, a match today at one: that venue only — and the 'Court 1' that two venues share loses its '(Venue)'", () => {
    const island = renderIsland(MatchDayShell, props(view([A1, A2, B1, B2, B3], ["v-b"])));
    expect(filterOf(island.tree())).toBeDefined();
    expect(listed(island.tree()).sort()).toEqual(["c-b1", "c-b2", "c-b3"]);
    expect(names(island.tree()).sort()).toEqual(["Court 1", "Court 3", "Court 4"]);
  });

  it("two venues, no match today anywhere: every venue, names as the server qualified them", () => {
    const island = renderIsland(MatchDayShell, props(view([A1, A2, B1, B2, B3], [])));
    expect(listed(island.tree()).sort()).toEqual(["c-a1", "c-a2", "c-b1", "c-b2", "c-b3"]);
    expect(names(island.tree())).toContain("Court 1 (Hall A)");
    expect(names(island.tree())).toContain("Court 1 (Hall B)");
  });

  it("matches today at BOTH venues: every venue", () => {
    const island = renderIsland(MatchDayShell, props(view([A1, A2, B1, B2, B3], ["v-a", "v-b"])));
    expect(listed(island.tree())).toHaveLength(5);
  });

  it("the URL's choice wins over the default: a venue, 'all', and a list", () => {
    const board = view([A1, A2, B1, B2, B3], ["v-b"]);
    expect(listed(renderIsland(MatchDayShell, props(board, { venueParam: "v-a" })).tree()).sort()).toEqual(["c-a1", "c-a2"]);
    expect(listed(renderIsland(MatchDayShell, props(board, { venueParam: "all" })).tree())).toHaveLength(5);
    expect(listed(renderIsland(MatchDayShell, props(board, { venueParam: "v-a,v-b" })).tree())).toHaveLength(5);
  });

  it("a court asked for by ?court= is never hidden by the default: its venue is added", () => {
    const board = view([A1, A2, B1, B2, B3], ["v-b"]);
    const island = renderIsland(MatchDayShell, props(board, { focusCourtId: "c-a2" }));
    expect(listed(island.tree())).toContain("c-a2");
    expect(propsOf(island.tree().find((e) => e.type === CourtFocus)!).court).toMatchObject({ court_id: "c-a2" });
    const focus = island.tree().find((e) => propsOf(e)["data-testid"] === "md-lost");
    expect(focus, "no 'left the list' notice for a court that is merely unlisted").toBeUndefined();
  });
});

describe("the shell — choosing", () => {
  it("choosing writes ?venue= to the address (every venue as 'all', some as ids), replacing, never pushing", () => {
    const island = renderIsland(MatchDayShell, props(view([A1, A2, B1, B2, B3], ["v-b"])));
    choose(island, ["v-a"]);
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/o/acme/c/westway-open/match-day?venue=v-a");
    expect(listed(island.tree()).sort()).toEqual(["c-a1", "c-a2"]);
    choose(island, ["v-a", "v-b"]);
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/o/acme/c/westway-open/match-day?venue=all");
    expect(listed(island.tree())).toHaveLength(5);
    expect(replaceState).toHaveBeenCalledTimes(2);
  });

  it("the summary line follows the filter: courts, playing and free are counted over the listed venues only", () => {
    const board = view([A1, A2, B1, B2, B3], ["v-a", "v-b"]);
    const island = renderIsland(MatchDayShell, props(board));
    expect(countsOf(island.tree())).toEqual(headerCountParts(dict, "en", "court", board.courts, []));
    choose(island, ["v-b"]);
    expect(countsOf(island.tree())).toEqual(headerCountParts(dict, "en", "court", [B1, B2, B3], []));
    expect(countsOf(island.tree())).toEqual(["3 courts", "1 playing", "2 free"]);
  });

  it("it intersects with the division chips: a chip narrows within the listed venues, not across them", () => {
    const board = view([A1, A2, B1, B2, B3], ["v-a", "v-b"]);
    const withChips = props(board, { divisions: [{ id: "d-1", name: "d-1" }, { id: "d-2", name: "d-2" }] });
    const island = renderIsland(MatchDayShell, withChips);
    const chip = (id: string) => island.tree().find((e) => propsOf(e)["data-testid"] === "md-division-chip" && textOf(e) === id)!;
    (propsOf(chip("d-1")).onClick as () => void)();
    // Division d-1 plays on Hall A's Court 1; every FREE court stays (a free court is where a chosen division's match can be called).
    expect(listed(island.tree()).sort()).toEqual(["c-a1", "c-a2", "c-b2", "c-b3"]);
    choose(island, ["v-a"]);
    expect(listed(island.tree()).sort()).toEqual(["c-a1", "c-a2"]);
    choose(island, ["v-b"]);
    expect(listed(island.tree()).sort()).toEqual(["c-b2", "c-b3"]);
  });

  it("DISPLAY ONLY: no request the page makes mentions the venue — the poll asks for the whole board, so every call guard still sees every court", async () => {
    const island = renderIsland(MatchDayShell, props(view([A1, A2, B1, B2, B3], ["v-b"])));
    choose(island, ["v-a"]);
    net.next = view([A1, A2, B1, B2, B3], ["v-b"], "2026-10-31T11:31:00.000Z");
    poll.tick!();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(net.calls).toEqual(["/api/v1/competitions/comp-1/match-day"]);
    expect(net.calls.join()).not.toMatch(/venue/i);
    // The view the poll brought holds every court; the page still lists the chosen venue only.
    expect(listed(island.tree()).sort()).toEqual(["c-a1", "c-a2"]);
  });

  it("the SEQUENCE: a venue chosen, a poll lands, the choice holds; the court the organiser opened leaves with its venue and the page says so", async () => {
    const island = renderIsland(MatchDayShell, props(view([A1, A2, B1, B2, B3], ["v-a", "v-b"])));
    (propsOf(island.tree().find((e) => e.type === CourtList)!).onSelect as (id: string) => void)("c-b2");
    choose(island, ["v-a"]);
    expect(island.tree().some((e) => propsOf(e)["data-testid"] === "md-lost")).toBe(true);
    net.next = view([A1, A2, B1, B2, B3], ["v-a", "v-b"], "2026-10-31T11:31:00.000Z");
    poll.tick!();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(listed(island.tree()).sort()).toEqual(["c-a1", "c-a2"]);
  });

  it("Needs you's 'Find a court' on a court in an unlisted venue shows that venue and opens the court", () => {
    const find: NeedsYouItem = {
      key: "d-1:unscheduled",
      kind: "unscheduled",
      severity: "amber",
      title: "1 match unscheduled",
      sub: "sub",
      action: { label: "Open the schedule board", href: "/x/schedule" },
      alt: { label: "Find a court", href: "/o/acme/c/westway-open/match-day?court=c-a2", court_id: "c-a2" },
    };
    const island = renderIsland(MatchDayShell, props({ ...view([A1, A2, B1, B2, B3], ["v-b"]), needs_you: [find] }));
    expect(listed(island.tree())).not.toContain("c-a2");
    const toggle = island.tree().find((e) => propsOf(e)["data-testid"] === "md-needs-you-toggle")!;
    (propsOf(toggle).onClick as () => void)();
    const list = propsOf(island.tree().find((e) => e.type === NeedsYou)!);
    (list.onAlt as (i: NeedsYouItem) => void)(find);
    expect(listed(island.tree())).toContain("c-a2");
    expect(propsOf(island.tree().find((e) => e.type === CourtFocus)!).court).toMatchObject({ court_id: "c-a2" });
  });
});

describe("the filter itself — a checklist, 44px rows, a sheet on a phone", () => {
  const options = venueOptions([A1, A2, B1, B2, B3]);
  const mount = (selected: string[], onChange = vi.fn()) =>
    renderIsland(VenueFilter, { dict, locale: "en" as Locale, options, selected: new Set(selected), onChange });
  const byId = (tree: ReactElement[], id: string) => tree.find((e) => propsOf(e)["data-testid"] === id);
  const openIt = (island: { tree: () => ReactElement[] }) => (propsOf(byId(island.tree(), "md-venue-trigger")!).onClick as () => void)();

  it("closed: one button saying what is listed — 'All venues', the venue's name, or 'N venues'", () => {
    const three = venueOptions([A1, B1, court("c-x", "Court 9", { id: "v-c", name: "Annex" })]);
    const summary = (selected: string[], opts = options) => {
      const island = renderIsland(VenueFilter, { dict, locale: "en" as Locale, options: opts, selected: new Set(selected), onChange: () => {} });
      return textOf(byId(island.tree(), "md-venue-summary")!);
    };
    expect(summary(["v-a", "v-b"])).toBe("All venues");
    expect(summary(["v-b"])).toBe("Hall B");
    expect(summary(["v-a", "v-c"], three)).toBe("2 venues");
    expect(byId(mount(["v-a"]).tree(), "md-venue-panel")).toBeUndefined();
  });

  it("open: 'Show all venues' and one row per venue with its court count — the brief's options", () => {
    const island = mount(["v-b"]);
    openIt(island);
    const tree = island.tree();
    expect(propsOf(byId(tree, "md-venue-trigger")!)["aria-expanded"]).toBe(true);
    const text = textOf(byId(tree, "md-venue-panel")!);
    expect(text).toContain("Show all venues");
    expect(text).toContain("Hall A");
    expect(text).toContain("2 courts");
    expect(text).toContain("Hall B");
    expect(text).toContain("3 courts");
    const boxes = tree.filter((e) => propsOf(e)["data-testid"] === "md-venue-option");
    expect(boxes.map((b) => [propsOf(b)["data-venue-id"], propsOf(b).checked])).toEqual([["v-a", false], ["v-b", true]]);
    expect(propsOf(byId(tree, "md-venue-all")!).checked).toBe(false);
  });

  it("'Show all venues' is checked exactly when every venue is, and checking it selects every venue", () => {
    const onChange = vi.fn();
    const island = mount(["v-a", "v-b"], onChange);
    openIt(island);
    expect(propsOf(byId(island.tree(), "md-venue-all")!).checked).toBe(true);
    const island2 = mount(["v-a"], onChange);
    openIt(island2);
    (propsOf(byId(island2.tree(), "md-venue-all")!).onChange as () => void)();
    expect(onChange).toHaveBeenLastCalledWith(new Set(["v-a", "v-b"]));
  });

  it("checking and unchecking a venue; unchecking the last one selects every venue rather than none", () => {
    const onChange = vi.fn();
    const island = mount(["v-a"], onChange);
    openIt(island);
    const box = (id: string) => island.tree().find((e) => propsOf(e)["data-venue-id"] === id)!;
    (propsOf(box("v-b")).onChange as () => void)();
    expect(onChange).toHaveBeenLastCalledWith(new Set(["v-a", "v-b"]));
    (propsOf(box("v-a")).onChange as () => void)();
    expect(onChange).toHaveBeenLastCalledWith(new Set(["v-a", "v-b"])); // the last selected venue off = every venue
  });

  it("every row is a 44px target and the phone has the sheet's way out (backdrop, Done) — both phone-only", () => {
    const island = mount(["v-a"]);
    openIt(island);
    const tree = island.tree();
    const labels = tree.filter((e) => e.type === "label");
    expect(labels).toHaveLength(1 + options.length);
    for (const l of labels) expect(String(propsOf(l).className)).toMatch(/\bmin-h-11\b/);
    expect(String(propsOf(byId(tree, "md-venue-trigger")!).className)).toMatch(/\bmin-h-11\b/);
    // Anchored on a space before "md:hidden": `max-md:hidden` would match a bare /md:hidden/.
    expect(String(propsOf(byId(tree, "md-venue-backdrop")!).className)).toMatch(/\smd:hidden\b/);
    const panel = String(propsOf(byId(tree, "md-venue-panel")!).className);
    expect(panel).toMatch(/max-md:fixed/);
    expect(panel).toMatch(/max-md:inset-x-0/);
    expect(panel).toMatch(/md:absolute/);
    const done = tree.find((e) => e.type === "button" && textOf(e) === "Done")!;
    expect(String(propsOf(done).className)).toMatch(/\bmin-h-11\b/);
    expect(textOf(done)).toBe(t(dict, "matchDay.venue.done"));
  });

  it("m6 — the trigger tells the truth about what it opens: expanded + controls, and NO haspopup (a checklist panel is not a menu, listbox or dialog)", () => {
    const island = mount(["v-a"]);
    const closed = propsOf(byId(island.tree(), "md-venue-trigger")!);
    expect(closed).not.toHaveProperty("aria-haspopup");
    expect(closed["aria-expanded"]).toBe(false);
    expect(closed["aria-controls"], "nothing to control while it is closed").toBeUndefined();
    openIt(island);
    const tree = island.tree();
    const open = propsOf(byId(tree, "md-venue-trigger")!);
    expect(open).not.toHaveProperty("aria-haspopup");
    expect(open["aria-expanded"]).toBe(true);
    const panel = propsOf(byId(tree, "md-venue-panel")!);
    expect(typeof panel.id).toBe("string");
    expect(String(panel.id).length).toBeGreaterThan(0);
    expect(open["aria-controls"], "the id of the panel it opened").toBe(panel.id);
    // The panel is a named group of real checkboxes - the role its contents earn.
    expect(panel.role).toBe("group");
    expect(panel["aria-label"]).toBe(t(dict, "matchDay.venue.label"));
  });

  it("a tap on the backdrop and Done both close it", () => {
    const island = mount(["v-a"]);
    openIt(island);
    (propsOf(byId(island.tree(), "md-venue-backdrop")!).onClick as () => void)();
    expect(byId(island.tree(), "md-venue-panel")).toBeUndefined();
    openIt(island);
    const done = island.tree().find((e) => e.type === "button" && textOf(e) === "Done")!;
    (propsOf(done).onClick as () => void)();
    expect(byId(island.tree(), "md-venue-panel")).toBeUndefined();
  });

  it("every locale: the trigger, 'Show all venues', Done and the count words, no raw key (counted)", () => {
    let checked = 0;
    for (const [locale, d] of Object.entries(DICTS) as [Locale, Dict][]) {
      const html = renderToStaticMarkup(
        <VenueFilter dict={d} locale={locale} options={options} selected={new Set(["v-a", "v-b"])} onChange={() => {}} />,
      );
      expect(html, locale).toContain(t(d, "matchDay.venue.triggerAll"));
      expect(html, locale).not.toMatch(/matchDay\./);
      for (const key of ["matchDay.venue.all", "matchDay.venue.done", "matchDay.venue.label", "matchDay.venue.triggerAll"]) {
        expect(t(d, key), `${locale} ${key}`).not.toMatch(/^matchDay\./);
        checked++;
      }
      for (const n of [1, 2, 3]) {
        expect(plural(d, "matchDay.venue.triggerMany", n, locale), `${locale} ${n}`).toContain(String(n));
        checked++;
      }
    }
    expect(checked).toBe(4 * 7);
  });
});

describe("I3 (fix round 1) — the venue filter survives Back: the ADDRESS is the authority, not the props the page was first rendered with", () => {
  // Why: Next restores a page on Back from its router cache, with the server props it was first rendered with - the venue the
  // address carried THEN (none). The address itself is right (the filter writes it with replaceState), so the shell reads that.
  const board = () => view([A1, A2, B1, B2, B3], ["v-b"]);
  const selectedOf = (tree: ReactElement[]) => [...(propsOf(filterOf(tree)!).selected as ReadonlySet<string>)].sort();

  it("stale props (no venue), an address that names one: the address wins, in every form it can take", () => {
    const rows: [string, string[]][] = [
      ["venue=v-a", ["c-a1", "c-a2"]],
      ["venue=all", ["c-a1", "c-a2", "c-b1", "c-b2", "c-b3"]],
      ["venue=v-a,v-b", ["c-a1", "c-a2", "c-b1", "c-b2", "c-b3"]],
      ["venue=v-a&venue=v-b", ["c-a1", "c-a2", "c-b1", "c-b2", "c-b3"]],
      ["court=zzz&venue=v-b", ["c-b1", "c-b2", "c-b3"]],
    ];
    let checked = 0;
    for (const [qs, expected] of rows) {
      nav.search = new URLSearchParams(qs);
      const island = renderIsland(MatchDayShell, props(board(), { venueParam: null }));
      expect(listed(island.tree()).sort(), qs).toEqual(expected);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("an address with NO venue is the default again, whatever the stale props said", () => {
    nav.search = new URLSearchParams("");
    const island = renderIsland(MatchDayShell, props(board(), { venueParam: "v-a" }));
    expect(listed(island.tree()).sort()).toEqual(["c-b1", "c-b2", "c-b3"]);
  });

  it("outside the app router (no search params at all) the props still speak - the static render and the first server paint", () => {
    nav.search = null;
    expect(listed(renderIsland(MatchDayShell, props(board(), { venueParam: "v-a" })).tree()).sort()).toEqual(["c-a1", "c-a2"]);
  });

  it("the SEQUENCE: choose a venue, leave the page, come Back to a page rendered from its cache - the choice and the address both hold", () => {
    // First visit: the page is rendered by the server with no ?venue= at all.
    const first = renderIsland(MatchDayShell, props(board(), { venueParam: null }));
    expect(listed(first.tree()).sort()).toEqual(["c-b1", "c-b2", "c-b3"]);
    choose(first, ["v-a"]);
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/o/acme/c/westway-open/match-day?venue=v-a");
    first.unmount();
    // Back: the router rebuilds the shell from the SAME stale props, while the address is what the filter wrote.
    nav.search = new URLSearchParams("venue=v-a");
    const back = renderIsland(MatchDayShell, props(board(), { venueParam: null }));
    expect(listed(back.tree()).sort()).toEqual(["c-a1", "c-a2"]);
    expect(selectedOf(back.tree()), "the filter control itself shows the choice").toEqual(["v-a"]);
    // And the next choice writes the address from there (it is not stuck on the props).
    choose(back, ["v-b"]);
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/o/acme/c/westway-open/match-day?venue=v-b");
    expect(listed(back.tree()).sort()).toEqual(["c-b1", "c-b2", "c-b3"]);
    expect(selectedOf(back.tree())).toEqual(["v-b"]);
  });

  it("a venue the address names that is no longer on the board falls through to the default (a stale link opens a page, never an empty one)", () => {
    nav.search = new URLSearchParams("venue=v-gone");
    expect(listed(renderIsland(MatchDayShell, props(board(), { venueParam: null })).tree()).sort()).toEqual(["c-b1", "c-b2", "c-b3"]);
  });
});
