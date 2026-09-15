// N1e e5 (review-n1d G1) — the public Schedule renders on the division page's
// schedule tab AND the live embed schedule widget, and after N1d d5 it still
// printed English whatever the org's locale: the row rail's Live / Ended /
// TBD, the day headings (`toLocaleDateString("en-GB")`), the round view's short
// rail date (`lib/format.ts`, fixed en-GB), the day/round toggle and its group
// name, the entrant filter's screen-reader label, "Add to calendar",
// "times in {zone}" and the empty state.
//
// Both production callers are driven here with their data doors mocked, and
// the `Schedule` element each returns is rendered with the props it was
// handed: statically for the day view (its initial state), and through the
// hook harness with the toggle pressed for the round view. Every expected
// string is read from the dictionaries; the dates from `Intl` in the locale's
// own tag, in a locale whose weekday differs from en-GB's.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const embedDivisionData = vi.fn();
vi.mock("@/server/embed-data", () => ({
  embedDivisionData: (...a: unknown[]) => embedDivisionData(...a),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => undefined) }));
const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { fmtZoneAbbrev } from "@/lib/format";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { PublicFixture, PublicEntrant } from "@/server/public-site/data";
import EmbedWidgetPage from "@/app/embed/divisions/[id]/[widget]/page";
import DivisionHomePage from "@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page";
import { Schedule } from "../schedule";

const TZ = "UTC";
const DAY_1 = "2026-09-24";
const DAY_2 = "2026-09-25";

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "f1",
  division_id: "d1",
  stage_id: "st",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

/** A league with one match of every rail state: decided, in play, timed and
 *  waiting, untimed. */
const FIXTURES: PublicFixture[] = [
  F({ id: "l1", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: "decided", scheduled_at: `${DAY_1}T18:00:00.000Z` }),
  F({ id: "l2", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4", status: "in_play", scheduled_at: `${DAY_1}T18:00:00.000Z` }),
  F({ id: "l3", round_no: 2, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e3", scheduled_at: `${DAY_2}T18:00:00.000Z` }),
  F({ id: "l4", round_no: 2, seq_in_round: 2, home_entrant_id: "e2", away_entrant_id: "e4", scheduled_at: null }),
];

const entrant = (id: string, name: string, seed: number): PublicEntrant => ({
  id,
  division_id: "d1",
  kind: "individual",
  display_name: name,
  seed,
  status: "active",
  members: [],
  team_display: null,
  badge_url: null,
});

const divisionPayload = (locale: string, fixtures: PublicFixture[]) => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: locale },
  competition: {
    id: "c1",
    org_id: "o1",
    name: "Test Comp",
    slug: "test-comp",
    description: null,
    starts_on: null,
    ends_on: null,
    branding: {},
    status: "active",
    visibility: "public",
  },
  division: {
    id: "d1",
    competition_id: "c1",
    name: "Open",
    slug: "open",
    description: null,
    sport_key: "generic",
    variant_key: "score",
    status: "active",
    module_version: "1.0.0",
    tiebreakers: null,
    sport_name: null,
    entrant_count: 4,
  },
  stages: [{ id: "st", division_id: "d1", seq: 1, kind: "league", name: "League", status: "active" }],
  pools: [],
  fixtures,
  standings: [],
  entrants: [entrant("e1", "Side 1", 1), entrant("e2", "Side 2", 2), entrant("e3", "Side 3", 3), entrant("e4", "Side 4", 4)],
  tz: TZ,
});

type Surface = "division schedule tab" | "embed schedule widget";
const SURFACES: Surface[] = ["division schedule tab", "embed schedule widget"];
type ScheduleProps = Parameters<typeof Schedule>[0];

function findSchedule(node: unknown): ReactElement<ScheduleProps> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSchedule(child);
      if (found) return found;
    }
  } else if (isValidElement(node)) {
    if (node.type === Schedule) return node as ReactElement<ScheduleProps>;
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) {
      const found = findSchedule(value);
      if (found) return found;
    }
  }
  return undefined;
}

/** The `Schedule` element a production caller builds for an org in `locale`. */
async function scheduleFrom(surface: Surface, locale: string, fixtures = FIXTURES) {
  let root: unknown;
  if (surface === "embed schedule widget") {
    embedDivisionData.mockResolvedValue({ ok: true, data: { ...divisionPayload(locale, fixtures), sponsors: [] } });
    root = await EmbedWidgetPage({ params: Promise.resolve({ id: "d1", widget: "schedule" }) });
  } else {
    getPublicDivision.mockResolvedValue(divisionPayload(locale, fixtures));
    root = await DivisionHomePage({
      params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
    });
  }
  const schedule = findSchedule(root);
  expect(schedule, `${surface} builds a Schedule`).toBeDefined();
  return schedule!;
}

/** The round view: the day view's un-pressed toggle, pressed. */
function roundViewHtml(schedule: ReactElement<ScheduleProps>): string {
  const island = renderIsland(Schedule, schedule.props);
  const toggle = island.tree().find((el) => el.type === "button" && propsOf(el)["aria-pressed"] === false);
  expect(toggle, "the day view offers the round view").toBeDefined();
  (propsOf(toggle!).onClick as () => void)();
  return renderToStaticMarkup(island.tree()[0]!);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** Rendered as a whole text node, or as an aria-label. */
const shows = (html: string, text: string, as: "text" | "aria-label" = "text") =>
  as === "text" ? html.includes(`>${esc(text)}<`) : html.includes(`aria-label="${esc(text)}"`);

type Probe = { what: string; ns: "public" | "ui"; key: string; vars?: Record<string, string>; as?: "aria-label" };
const zone = fmtZoneAbbrev(TZ, `${DAY_1}T18:00:00.000Z`);
/** Every G1 string the day view shows or announces, by dictionary key. */
const DAY_VIEW_PROBES: Probe[] = [
  { what: "row rail, in play", ns: "public", key: "matchesHub.live" },
  { what: "row rail, decided", ns: "public", key: "matchesHub.ended" },
  { what: "row rail, no time yet", ns: "ui", key: "schedule.tbd" },
  { what: "untimed day heading", ns: "public", key: "matchCentre.status.timeTbd" },
  { what: "filter's first option", ns: "public", key: "division.filter.allEntrants" },
  { what: "filter's screen-reader label", ns: "public", key: "division.filter.showFor" },
  { what: "view toggle's group name", ns: "public", key: "division.view.label", as: "aria-label" },
  { what: "view toggle, day", ns: "public", key: "division.view.day" },
  { what: "view toggle, round", ns: "public", key: "division.view.round" },
  { what: "calendar link", ns: "public", key: "division.calendar" },
  { what: "zone caption", ns: "public", key: "division.timesIn", vars: { zone } },
];

async function valueOf(locale: "en" | "es", probe: Pick<Probe, "ns" | "key" | "vars">) {
  return t(await getDictionary(locale, probe.ns), probe.key as Parameters<typeof t>[1], probe.vars);
}

/** Day heading and short rail date, as `Intl` writes them in a locale tag. */
const longDay = (key: string, tag: string) =>
  new Date(`${key}T12:00`).toLocaleDateString(tag, { weekday: "long", day: "numeric", month: "long" });
/** N1f f3 (review-n1e m2): the rail date is day + short month, with NO
 *  weekday. The weekday form below is what it used to be, and it needed
 *  68-72px in a ~56px rail, so every locale's date ended in an ellipsis; it is
 *  kept here so the clipped form cannot come back unnoticed. Widths for all
 *  four locales in all twelve months: `schedule-rail-fits.test.ts`. */
const shortDay = (key: string, tag: string) =>
  new Date(`${key}T12:00`).toLocaleDateString(tag, { day: "numeric", month: "short" });
const clippedWeekdayDay = (key: string, tag: string) =>
  new Date(`${key}T12:00`).toLocaleDateString(tag, { weekday: "short", day: "numeric", month: "short" });

describe.each(SURFACES)("public Schedule in the org's locale: %s (N1e e5)", (surface) => {
  it("es org, day view: every rail word, the toggle and its group name, the filter label, the calendar link and the zone caption are the es dictionary's; no English value is left", async () => {
    const html = renderToStaticMarkup(await scheduleFrom(surface, "es"));
    for (const probe of DAY_VIEW_PROBES) {
      const [es, en] = await Promise.all([valueOf("es", probe), valueOf("en", probe)]);
      expect(es, `${probe.what}: the premise, es differs from en`).not.toBe(en);
      expect({ what: probe.what, es: shows(html, es, probe.as) }).toEqual({ what: probe.what, es: true });
      expect({ what: probe.what, en: shows(html, en, probe.as) }).toEqual({ what: probe.what, en: false });
    }
  });

  it("es org, day view: the day headings are written in es, where the weekday differs from en-GB's", async () => {
    const html = renderToStaticMarkup(await scheduleFrom(surface, "es"));
    for (const day of [DAY_1, DAY_2]) {
      expect(longDay(day, "es"), "the premise: es names the day differently").not.toBe(longDay(day, "en-GB"));
      expect({ day, es: shows(html, longDay(day, "es")), enGB: shows(html, longDay(day, "en-GB")) }).toEqual({
        day,
        es: true,
        enGB: false,
      });
    }
  });

  it("es org, round view: the rail's short date is written in es, not en-GB", async () => {
    const html = roundViewHtml(await scheduleFrom(surface, "es"));
    expect(shortDay(DAY_2, "es"), "the premise: es abbreviates the day differently").not.toBe(shortDay(DAY_2, "en-GB"));
    expect({ es: shows(html, shortDay(DAY_2, "es")), enGB: shows(html, shortDay(DAY_2, "en-GB")) }).toEqual({
      es: true,
      enGB: false,
    });
    expect(shows(html, clippedWeekdayDay(DAY_2, "es")), "the weekday form is what got clipped").toBe(false);
    // N1g g5 (review-n1f m5): the round view heads its groups by ROUND, so no
    // heading names a day and the rail's short date is the only date a
    // spectator sees there — the day view's case above finds these same long
    // day names, so their absence here is not a probe that can never match.
    for (const day of [DAY_1, DAY_2]) {
      expect({ day, heading: shows(html, longDay(day, "es")) }).toEqual({ day, heading: false });
    }
  });

  it("es org, no fixtures: the empty state is the es dictionary's", async () => {
    const html = renderToStaticMarkup(await scheduleFrom(surface, "es", []));
    const probe = { ns: "public", key: "division.scheduleEmpty" } as const;
    const [es, en] = await Promise.all([valueOf("es", probe), valueOf("en", probe)]);
    expect(es).not.toBe(en);
    expect({ es: shows(html, es), en: shows(html, en) }).toEqual({ es: true, en: false });
  });

  it("en org (positive pair): the same probes see every en value and the en-GB dates", async () => {
    const schedule = await scheduleFrom(surface, "en");
    const html = renderToStaticMarkup(schedule);
    for (const probe of DAY_VIEW_PROBES) {
      expect({ what: probe.what, en: shows(html, await valueOf("en", probe), probe.as) }).toEqual({ what: probe.what, en: true });
    }
    expect(shows(html, longDay(DAY_1, "en-GB"))).toBe(true);
    expect(shows(roundViewHtml(schedule), shortDay(DAY_2, "en-GB"))).toBe(true);
    expect(shows(roundViewHtml(schedule), clippedWeekdayDay(DAY_2, "en-GB"))).toBe(false);
    const empty = renderToStaticMarkup(await scheduleFrom(surface, "en", []));
    expect(shows(empty, await valueOf("en", { ns: "public", key: "division.scheduleEmpty" }))).toBe(true);
  });
});
