// Spectator surface W2, Task 11 — the competition hub's Overview tab.
//
// ── THE ONE RULE THIS FILE IMPLEMENTS ──────────────────────────────────────
// Owner-approved composition, "Option B": **the section order is driven by
// `landingStatus().kind`.** The top of the panel is always the most live thing
// that exists, and a section with nothing to say is ABSENT rather than held
// open as an empty shell. On `live` the Live-now rail leads; with no live rung
// next-up leads and there is no rail at all; on `dates`/`empty` the register
// CTA leads and there is neither rail nor next-up nor table preview.
//
// ONE `switch` does both jobs — `overviewPlan` below picks the status COPY and
// the section ORDER together. Not two mechanisms, and deliberately not "one
// hardcoded order, filtered": a hardcoded order cannot fail when a rung is
// added, and `LandingStatus` has SIX rungs of which `match_day` was missed
// entirely by an earlier wave because the only thing watching was a hand-written
// dictionary coverage list, which cannot fail when a rung appears. A `switch`
// with a `never` default can, and does, at COMPILE time.
//
// ── ONE DOM, BRANCHED ──────────────────────────────────────────────────────
// 320-767: one column, the ladder's order.
// 768 (`md`): still one column; the grids inside it widen — next-up 3-up,
//   table previews 2-up.
// 1024 (`lg`): the column splits into a main column (status, live rail, next
//   up, description) and a side rail (table previews, register CTA, sponsors).
//   The ladder still picks what leads the main column.
//
// The split is `display: contents` plus explicit CSS `order`, and it is one
// tree rather than two because the ladder INTERLEAVES the two columns: on
// `dates` the register CTA (side) leads and the description (main) follows it,
// while on `live` the rail and next-up (main) come before the tables (side).
// So neither "main then side" nor "side then main" is a source order that can
// express every rung. Below `lg` the two wrappers are `display: contents` —
// not boxes at all — so their children are the root grid's own items and
// `order-N` sequences them; from `lg` the wrappers become blocks, take a
// column each, and `order` stops applying, at which point the source order
// inside each wrapper (which is the ladder's) is what shows.
//
// NO `"use client"`, following `table-tab.tsx`: nothing here is stateful. The
// interactive parts of this subtree — `StandingsTableView`'s disclosure, every
// `next/link` — carry their own directives.
import Link from "next/link";
import type { ReactNode } from "react";
import type { Dict as PublicDict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { UTC, fmtDate, fmtTime } from "@/lib/format";
import { landingStatus, sortHubMatches, type LandingStatus } from "@/lib/matches-hub";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { StandingsTableView } from "../standings-table-view";
import { MatchCard } from "./match-card";

export interface OverviewTabProps {
  doc: CompetitionHubDocT;
  dict: PublicDict;
  /** The viewer's locale — `plural()`'s `Intl.PluralRules` and `MatchCard`'s
   *  `Intl.RelativeTimeFormat`. NOT threaded into any date: `fmtDate`/`fmtTime`
   *  pin `en-GB` repo-wide (`lib/format.ts:10`) and take no locale parameter. */
  locale: Locale;
  /** `Date.now()` at render, passed down rather than read here so a card's
   *  "Starts in 2 hours" is stable across a server render and its hydration. */
  now: number;
  /** The org's sponsor board. An async server component (`resolveSponsors` plus
   *  a `sponsors.tiers` entitlement read), so it cannot be built here. */
  sponsorsSlot?: ReactNode;
  /** The competition's own prose — HTML from the database, sanitised on the
   *  server. This tab only decides where it sits. */
  descriptionSlot?: ReactNode;
  // NO `onOpenTab`. The brief declares one and then, in its own Step 3, argues
  // itself out of the only use it had: the table preview's "Full division" link
  // keeps the document's `fullHref` "because the tab is one tap away on the
  // rail". That argument applies to every other in-panel tab link too, so
  // nothing on this tab calls it — and a declared-but-dead prop is worse than
  // an absent one, because the caller believes it works. This is the SAME
  // finding Task 7's review made about `MatchCard`'s `compact` in the same
  // brief; it is applied here rather than repeated one file later.
}

// ------------------------------------------------------------- the sections

/** Everything this tab can show below the status line. Six ids, and the ladder
 *  in `overviewPlan` is the only thing that decides which of them appear and in
 *  what order. */
export type OverviewSection =
  | "live"
  | "next"
  | "tables"
  | "register"
  | "description"
  | "sponsors";

/** Which column a section belongs to from `lg` up. The status line is not in
 *  here: it is always first in the main column, and that is not a ladder
 *  decision. */
const MAIN_COLUMN: ReadonlySet<OverviewSection> = new Set<OverviewSection>([
  "live",
  "next",
  "description",
]);

/** `order-1` … `order-6`, written as LITERALS so Tailwind's scanner sees all
 *  six — an `order-${n}` template is invisible to it and the classes would
 *  simply not exist in the stylesheet. Six is the whole domain
 *  (`OverviewSection` has six members), so an index can never fall off the end.
 *  Same trick `standings-table-view.tsx`'s `COLUMN_SIZES` uses. */
const ORDER_CLASS = ["order-1", "order-2", "order-3", "order-4", "order-5", "order-6"] as const;

// The ladders themselves. Named constants rather than inline arrays because
// three of the six rungs share one, and sharing it is the POINT: `next` and
// `match_day` differ in what they SAY, not in what they show, and `dates` and
// `empty` likewise. A reader who sees two identical inline arrays cannot tell
// deliberate agreement from a copy-paste.
//
// Read them against each other, because what is ABSENT from each is the design:
//
//  • `live` is the only rung that can have a live match — every other rung is
//    below `landingStatus`'s own `live` check — so `"live"` appears in exactly
//    one order. Putting it in another would be a section that provably cannot
//    render, which is dead weight dressed as a decision.
//  • `finished` means every fixture is completed, so the upcoming set is empty
//    by construction and `"next"` is left out of that rung for the same reason.
//  • `dates`/`empty` exclude the table preview, and that one IS a choice rather
//    than an impossibility: a competition with dates and a standings table is
//    reachable (a season entered in bulk), and previewing it above the sign-up
//    would bury the one thing a visitor to a not-yet-started competition can
//    actually do.
const LIVE_ORDER = [
  "live",
  "next",
  "tables",
  "register",
  "description",
  "sponsors",
] as const satisfies readonly OverviewSection[];
const NEXT_ORDER = [
  "next",
  "tables",
  "register",
  "description",
  "sponsors",
] as const satisfies readonly OverviewSection[];
const FINISHED_ORDER = [
  "tables",
  "register",
  "description",
  "sponsors",
] as const satisfies readonly OverviewSection[];
const PRESEASON_ORDER = [
  "register",
  "description",
  "sponsors",
] as const satisfies readonly OverviewSection[];

export interface OverviewPlan {
  /** The status sentence, or null when the rung has nothing to say — which is
   *  only `dates` with neither date. A blank `<p>` reads as content that failed
   *  to load, and `landing.status.empty` would be a lie about a competition
   *  that does have divisions, so the line is absent instead. */
  copy: string | null;
  order: readonly OverviewSection[];
}

/** The competition's calendar dates. `day numeric / month long / year numeric`,
 *  matching `info-tab.tsx`'s `DATE_OPTS` so the same two fields do not read two
 *  ways on two tabs of one page. */
const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  year: "numeric",
};

/**
 * IN UTC, and that is load-bearing. `HubInfo.startsOn`/`endsOn` are pg `date`
 * columns — calendar days, not instants — so `new Date("2026-09-01")` is UTC
 * midnight and formatting it in ANY zone behind UTC prints the day before. The
 * same rule is written out at length on `info-tab.tsx`'s `competitionDateLine`,
 * which formats the same two fields for the Info tab.
 *
 * This is NOT that function, and the difference is the dictionary: that one
 * joins with a hardcoded en-dash and, for a start date alone, renders the bare
 * date. Here the two shapes are TRANSLATED templates (`landing.status.dates`
 * "{from} – {to}", `landing.status.datesFrom` "From {from}"), and the second is
 * a preposition that differs in all four locales. The shared part — that the
 * zone is UTC and never the competition's — travels as the imported `UTC`
 * constant rather than as a repeated string literal.
 *
 * An end date with no start date falls to `datesFrom` on the END date, because
 * the alternative is saying nothing at all about a competition that does carry
 * a date. The schema permits the pair (`HubInfo` nulls both independently) and
 * no builder emits it today.
 */
function datesCopy(dict: PublicDict, startsOn: string | null, endsOn: string | null): string | null {
  const from = startsOn ? fmtDate(UTC, startsOn, DATE_OPTS) : "";
  const to = endsOn ? fmtDate(UTC, endsOn, DATE_OPTS) : "";
  if (from && to) return t(dict, "landing.status.dates", { from, to });
  if (from || to) return t(dict, "landing.status.datesFrom", { from: from || to });
  return null;
}

/**
 * THE LADDER. One `switch` over `LandingStatus["kind"]`, picking the status
 * copy and the section order together.
 *
 * The `default` is an exhaustiveness guard, not a runtime fallback: in that
 * branch `status` has been narrowed to `never`, so adding a seventh rung to
 * `LandingStatus` without adding a case here is a COMPILE error — which is the
 * whole reason this is a switch and not a lookup table keyed on `kind`. A
 * lookup table with a missing key returns `undefined` and renders a page with
 * no status and no sections, silently. The throw is what happens if one is
 * reached anyway (a document parsed by an older build, a cast), and it names
 * the rung so the report is one line long.
 */
export function overviewPlan(
  status: LandingStatus,
  dict: PublicDict,
  locale: Locale,
): OverviewPlan {
  switch (status.kind) {
    case "empty":
      return { copy: t(dict, "landing.status.empty"), order: PRESEASON_ORDER };
    case "live":
      return {
        copy: plural(dict, "landing.status.live", status.n, locale),
        order: LIVE_ORDER,
      };
    case "next":
      return {
        // The venue's OWN zone, carried on the fixture — never the viewer's and
        // never a platform default. `fmtDate`'s default options are
        // weekday/day/month, so this reads "Sat 5 Sept 14:00".
        copy: t(dict, "landing.status.next", {
          when: `${fmtDate(status.tz, status.at)} ${fmtTime(status.tz, status.at)}`,
        }),
        order: NEXT_ORDER,
      };
    case "match_day":
      // Same sections as `next`, different sentence. Today's fixtures are
      // overdue rather than ahead of us — that is what put this rung below
      // `next` — but they are still the most live thing the competition has, so
      // next-up leads and the rail is absent (there is no live match, by
      // construction: `landingStatus` checks `live` first).
      return { copy: t(dict, "landing.status.matchDay"), order: NEXT_ORDER };
    case "finished":
      return { copy: t(dict, "landing.status.finished"), order: FINISHED_ORDER };
    case "dates":
      return {
        copy: datesCopy(dict, status.startsOn, status.endsOn),
        order: PRESEASON_ORDER,
      };
    default: {
      const unhandled: never = status;
      throw new Error(
        `overviewPlan: unhandled landingStatus kind ${JSON.stringify(unhandled)} — ` +
          `add a case above (and a section order for it) rather than a fallback.`,
      );
    }
  }
}

// ------------------------------------------------------------------ classes

/** How many upcoming matches the tab teases. Three because that is one full
 *  row of the `md:grid-cols-3` grid below; the Matches tab holds the rest and
 *  is one tap away on the rail. */
const NEXT_UP = 3;

/** `text-xl` flat, NOT the `text-xl md:text-2xl` the Table/Stats/Teams tabs put
 *  on their division headings. Those head a full-width panel; from `lg` these
 *  can sit in a 20rem side rail, where `text-2xl` over a `text-lg` table
 *  caption is a heading wider than the table it heads. It stays `text-xl` and
 *  not `text-lg` for the reason `table-tab.tsx` writes up: `StandingsTableView`
 *  captions at `font-display text-lg font-semibold`, so a `text-lg` section
 *  heading is the same size as the thing inside it and the grouping stops being
 *  visible exactly on the phone, where it matters most. */
const HEADING_CLASS = "min-w-0 font-display text-xl font-semibold tracking-tight text-ink";

/** The 44px tap target (AGENTS.md), on the element that carries the href — the
 *  same shape `info-tab.tsx`'s `LINK_CLASS` uses, in the accent fill it uses
 *  for its own register CTA. */
const REGISTER_CLASS =
  "inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-full border border-accent bg-accent px-5 text-sm font-semibold text-accent-ink transition hover:opacity-90";

export function OverviewTab({
  doc,
  dict,
  locale,
  now,
  sponsorsSlot,
  descriptionSlot,
}: OverviewTabProps) {
  const status = landingStatus({
    matches: doc.matches,
    // How many divisions the competition HAS, not how many have fixtures — the
    // empty rung is about a competition nobody has drawn yet.
    divisions: doc.divisions.length,
    startsOn: doc.info.startsOn,
    endsOn: doc.info.endsOn,
    now: new Date(now),
  });
  const plan = overviewPlan(status, dict, locale);

  // Ordered by `sortHubMatches`, never by document order: inside a bucket it
  // reads soonest-first, which is what both of these rails mean.
  const live = sortHubMatches(doc.matches.filter((x) => x.bucket === "live"));
  const upNext = sortHubMatches(doc.matches.filter((x) => x.bucket === "upcoming")).slice(
    0,
    NEXT_UP,
  );

  // What each section would render, or null when it has nothing to say. Built
  // for every section regardless of the ladder, and then INTERSECTED with the
  // ladder below — so "this rung excludes the tables" and "this document has no
  // table" stay two different facts, decided in two different places.
  const content: Record<OverviewSection, ReactNode> = {
    live:
      live.length === 0 ? null : (
        <>
          <h2 className={HEADING_CLASS}>{t(dict, "landing.liveNow")}</h2>
          {/* A scrolling rail, so it owes a tab stop, a role and an accessible
              name — AGENTS.md 23, where an unnamed one tripped axe at SERIOUS
              impact. `role="list"` explicitly because Tailwind's preflight
              removes list styling, which takes the list semantics with it in
              Safari/VoiceOver. The `-mx-4 px-4` edge bleed below `md` is the
              public page's own gutter, so a card is never half-cut by it. */}
          <ul
            data-testid="mh-live-now"
            className="flex gap-3 overflow-x-auto pb-1 max-md:-mx-4 max-md:px-4"
            role="list"
            tabIndex={0}
            aria-label={t(dict, "landing.liveNow")}
          >
            {live.map((match) => (
              <li
                key={match.fixtureId}
                className="min-w-[260px] max-w-[320px] shrink-0"
                data-testid={`mh-live-now-card-${match.fixtureId}`}
              >
                {/* NO `compact`: the prop does not exist. Task 7's review
                    deleted it after it shipped dead — declared in the brief,
                    with no branch in the card's markup, so this exact caller
                    would have passed it and got an identical card back with
                    nothing red to say so (`match-card.tsx:52-57`). The `<li>`'s
                    floor and ceiling ARE the rail's density; a real dense
                    variant comes back with a markup branch and a test proving
                    the two differ. */}
                <MatchCard match={match} dict={dict} locale={locale} now={now} />
              </li>
            ))}
          </ul>
        </>
      ),
    next:
      upNext.length === 0 ? null : (
        <>
          <h2 className={HEADING_CLASS}>{t(dict, "landing.nextUp")}</h2>
          <ul
            data-testid="mh-next-up"
            className="grid gap-3 md:grid-cols-3"
            role="list"
            aria-label={t(dict, "landing.nextUp")}
          >
            {upNext.map((match) => (
              <li
                key={match.fixtureId}
                className="min-w-0"
                data-testid={`mh-next-up-card-${match.fixtureId}`}
              >
                <MatchCard match={match} dict={dict} locale={locale} now={now} />
              </li>
            ))}
          </ul>
        </>
      ),
    tables:
      doc.tables.length === 0 ? null : (
        <>
          <h2 className={HEADING_CLASS}>{t(dict, "landing.tables")}</h2>
          {/* 2-up from `md`, and back to 1-up from `lg` — from there these sit
              in a 20rem side rail, and two columns inside it would put the
              points column, the number a table exists for, behind a scroll.
              `min-w-0` on the cell because a grid item defaults to
              `min-width: auto`. */}
          <ul
            data-testid="mh-tables"
            className="grid gap-4 md:grid-cols-2 lg:grid-cols-1"
            role="list"
            aria-label={t(dict, "landing.tables")}
          >
            {doc.tables.map((view) => (
              <li key={view.id} className="min-w-0">
                <StandingsTableView
                  view={view}
                  dict={dict}
                  // Per VIEW, never per division: a division publishes an
                  // overall table and one per pool, so a division-keyed prefix
                  // emits duplicate ids on the ordinary document.
                  testid={`mh-table-preview-${view.id}`}
                  preview={3}
                  // The full link goes to the DIVISION page, not to this hub's
                  // own Table tab. The tab is one tap away on the rail above;
                  // the division page is not, and it is the only place the rest
                  // of the table lives.
                  showFullLink
                />
              </li>
            ))}
          </ul>
        </>
      ),
    register: !doc.info.registrationOpen ? null : (
      <Link
        data-testid="mh-register"
        href={doc.info.registerHref}
        className={REGISTER_CLASS}
      >
        {t(dict, "landing.register")}
      </Link>
    ),
    // Each slot brings its own chrome — `info-tab.tsx` states the rule and this
    // follows it: a heading over an absent block reads as content that failed
    // to load rather than content that does not exist.
    description: descriptionSlot ?? null,
    sponsors: sponsorsSlot ?? null,
  };

  // The ladder's order, minus the sections with nothing in it. Numbered over
  // what SURVIVES rather than over the ladder's own indices, so the CSS orders
  // are 1..n with no gaps — a gap is harmless to CSS and confusing to read.
  const shown = plan.order.filter((id) => content[id] !== null);
  const orderClass = new Map<OverviewSection, string>(
    shown.map((id, i) => [id, ORDER_CLASS[i]!]),
  );

  const section = (id: OverviewSection) => (
    <section
      key={id}
      data-testid={`mh-sec-${id}`}
      className={`${orderClass.get(id)} min-w-0 space-y-3`}
    >
      {content[id]}
    </section>
  );

  return (
    <div
      data-testid="mh-overview"
      className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
    >
      <div data-testid="mh-overview-main" className="contents min-w-0 lg:block lg:space-y-6">
        {plan.copy === null ? null : (
          <p
            data-testid="mh-status"
            data-kind={status.kind}
            className="order-first min-w-0 text-base font-semibold text-ink"
          >
            {plan.copy}
          </p>
        )}
        {shown.filter((id) => MAIN_COLUMN.has(id)).map(section)}
      </div>
      <div data-testid="mh-overview-side" className="contents min-w-0 lg:block lg:space-y-6">
        {shown.filter((id) => !MAIN_COLUMN.has(id)).map(section)}
      </div>
    </div>
  );
}
