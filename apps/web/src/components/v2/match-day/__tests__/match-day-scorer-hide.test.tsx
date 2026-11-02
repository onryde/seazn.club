// Match Day E2 item 6 — what the HOST (court-focus.tsx's ScorerPanel) tells the shared panel: where the organiser's Hide is
// remembered, and when the panel starts open. The panel's own behaviour is `device-link-panel-hide.test.tsx`; this file is the
// seam between them, driven through the real CourtFocus / NoCourtFocus (the inert-seam class: a `hide` prop nothing passes is
// a Hide button nobody ever sees).
//
// The expected values are the brief's, written as a table, never read back from the component:
//   - open by default when the court's match is CALLED (the hand-over is next) or PLAYING with the desk saying nobody scores it;
//   - hidden by default otherwise (a scorer is on: the scoreboard comes first);
//   - remembered PER COURT (a match on no court: per match).
import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import en from "@/dictionaries/en/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MatchDayCourt, MatchDayFixture } from "@/lib/match-day/types";
import { scorerMemoryKey } from "@/lib/match-day/view";
import { DeviceLinkPanel, type DeviceLinkHide } from "@/components/v2/device-link-panel";
import { CourtFocus, NoCourtFocus, type MatchDayCtx } from "@/components/v2/match-day/court-focus";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";

const dict = en as Dict;
const ctx: MatchDayCtx = {
  competitionId: "comp-1",
  orgSlug: "acme",
  compSlug: "open",
  locale: "en",
  tz: "Europe/London",
  dict,
  scoreDict: publicEn as Dict,
  viewerPlan: "pro",
  readOnly: false,
};

const fx = (o: Partial<MatchDayFixture> = {}): MatchDayFixture => ({
  id: "f-1",
  division_id: "d-1",
  division_name: "Girls U14",
  division_slug: "girls-u14",
  fixture_no: 7,
  sport_key: "badminton",
  stage_label: "Swiss round 3",
  round: { code: "R3", label: "Round 3", coded: false },
  home: "Zara Khan",
  away: "Ella Brooks",
  home_entrant_id: "e-1",
  away_entrant_id: "e-2",
  headline: "0 – 0",
  summary: null,
  serving: null,
  started_at: "2026-10-31T11:20:00.000Z",
  called_at: null,
  stream: null,
  scorer_attention: null,
  live_video: null,
  format_line: null,
  ...o,
});
const court = (o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: "c-3",
  court_name: "Court 3",
  venue_id: "venue-1",
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "playing",
  current: fx(),
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  ...o,
});
const called = (o: Partial<MatchDayCourt> = {}) =>
  court({ state: "called", current: fx({ started_at: null, headline: null, called_at: "2026-10-31T11:31:00.000Z" }), ...o });
const scored = (attention: MatchDayFixture["scorer_attention"], o: Partial<MatchDayCourt> = {}) =>
  court({ current: fx({ scorer_attention: attention }), ...o });

/** The `hide` prop the focus hands the shared panel, found by expanding the hookless ScorerPanel the focus mounts. */
const expandScorer = (node: ReactNode) => {
  const els = walk(node);
  const scorer = els.filter((e) => typeof e.type === "function" && "memoryKey" in propsOf(e));
  return [...els, ...scorer.flatMap((e) => walk((e.type as (p: unknown) => ReactNode)(e.props)))];
};
const panelsOf = (island: { tree: () => ReactElement[] }) => island.tree().filter((e) => e.type === DeviceLinkPanel);
const hideOfPanels = (panels: ReactElement[]): DeviceLinkHide | undefined => {
  expect(panels, "exactly one Remote scoring panel").toHaveLength(1);
  return propsOf(panels[0]!).hide as DeviceLinkHide | undefined;
};
const courtFocus = (c: MatchDayCourt, c2: MatchDayCtx = ctx): Parameters<typeof CourtFocus>[0] => ({
  ctx: c2,
  court: c,
  backLabel: "All courts",
  onBack: () => {},
  onChanged: () => {},
  onRefused: () => {},
  notice: null,
  refreshKey: "k",
  divisions: null,
});
const noCourt = (f: MatchDayFixture): Parameters<typeof NoCourtFocus>[0] => ({ ctx, fixture: f, backLabel: "All courts", onBack: () => {}, onChanged: () => {} });
const hideOf = (props: Parameters<typeof CourtFocus>[0]) => hideOfPanels(panelsOf(renderIsland(CourtFocus, props, expandScorer)));
const hideOfNoCourt = (props: Parameters<typeof NoCourtFocus>[0]) => hideOfPanels(panelsOf(renderIsland(NoCourtFocus, props, expandScorer)));

describe("the host's rule for when the panel starts open", () => {
  // [label, court, expected initiallyOpen, expected followLink] — from the brief's wording.
  const TABLE: [string, MatchDayCourt, boolean, boolean][] = [
    ["called: the hand-over is next (it checks for a live link at its first read)", called(), true, true],
    ["playing, the desk says nobody is scoring", scored("no_scorer"), true, false],
    ["playing, a scorer is on but not recording", scored("not_recording"), false, false],
    ["playing, nothing the desk complains of", scored(null), false, false],
  ];

  it("the table, row by row (count reported; zero fails)", () => {
    let checked = 0;
    for (const [label, c, initiallyOpen, followLink] of TABLE) {
      const hide = hideOf(courtFocus(c));
      expect(hide, label).toBeDefined();
      expect(hide!.initiallyOpen, label).toBe(initiallyOpen);
      expect(hide!.followLink, label).toBe(followLink);
      checked++;
    }
    expect(checked).toBe(TABLE.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the heading the host hands over is the court's own: the 'Remote scoring' title, and the scorer mark when the desk raises one", () => {
    const withMark = hideOf(courtFocus(scored("no_scorer")))!;
    const plain = hideOf(courtFocus(scored(null)))!;
    const text = (n: ReactNode): string => JSON.stringify(n);
    expect(text(withMark.heading)).toContain("Remote scoring");
    expect(text(withMark.heading)).toContain("no_scorer");
    expect(text(plain.heading)).toContain("Remote scoring");
    expect(text(plain.heading)).not.toContain("no_scorer");
  });

  it("a match on NO court: open only while nobody scores it, remembered per match", () => {
    expect(hideOfNoCourt(noCourt(fx({ scorer_attention: "no_scorer" })))).toMatchObject({ initiallyOpen: true, followLink: false });
    expect(hideOfNoCourt(noCourt(fx({ scorer_attention: "not_recording" })))).toMatchObject({ initiallyOpen: false, followLink: false });
    expect(hideOfNoCourt(noCourt(fx({ scorer_attention: null })))).toMatchObject({ initiallyOpen: false, followLink: false });
  });
});

describe("where the choice is remembered", () => {
  it("per COURT: the key follows the court, not the match on it — the next match on a court inherits its organiser's choice", () => {
    const first = hideOf(courtFocus(scored(null, { court_id: "c-3", current: fx({ id: "m-1" }) })))!;
    const next = hideOf(courtFocus(scored(null, { court_id: "c-3", current: fx({ id: "m-2" }) })))!;
    expect(first.storageKey).toBe(scorerMemoryKey("c-3"));
    expect(next.storageKey).toBe(first.storageKey);
  });

  it("two courts never share a choice (count reported)", () => {
    const keys = ["c-1", "c-2", "c-3", "c-4"].map((id) => hideOf(courtFocus(scored(null, { court_id: id })))!.storageKey);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
  });

  it("a called and a playing match on the SAME court share it too (a hide survives the call turning into play)", () => {
    expect(hideOf(courtFocus(called({ court_id: "c-9" })))!.storageKey).toBe(hideOf(courtFocus(scored(null, { court_id: "c-9" })))!.storageKey);
  });

  it("a match on no court is remembered under the match, and never collides with a court's key", () => {
    const key = hideOfNoCourt(noCourt(fx({ id: "m-77" })))!.storageKey;
    expect(key).toBe(scorerMemoryKey("fixture-m-77"));
    expect(key).not.toBe(hideOf(courtFocus(scored(null, { court_id: "m-77" })))!.storageKey);
    expect(hideOfNoCourt(noCourt(fx({ id: "m-78" })))!.storageKey).not.toBe(key);
  });

  it("the key is namespaced (nothing else on the page can read or clobber it by accident)", () => {
    expect(scorerMemoryKey("c-3")).toMatch(/^seazn\.matchDay\.scorer\./);
    expect(scorerMemoryKey("a")).not.toBe(scorerMemoryKey("b"));
  });
});

describe("a view-only reader has no panel, so no Hide", () => {
  it("readOnly: no Remote scoring panel at all (nothing to hide)", () => {
    const island = renderIsland(CourtFocus, courtFocus(called(), { ...ctx, readOnly: true }), expandScorer);
    expect(panelsOf(island)).toHaveLength(0);
    // The sibling case is not vacuous: the same court for an editor does mount one.
    expect(panelsOf(renderIsland(CourtFocus, courtFocus(called()), expandScorer))).toHaveLength(1);
  });
});
