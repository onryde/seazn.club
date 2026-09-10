"use client";
// Spectator surface W2, Task 8 — the competition hub's Matches tab: a filter
// rail, a division rail, and the chosen list grouped by the day it is played
// on AT THE VENUE.
//
// This component decides NOTHING about copy, order or bucketing. Every one of
// those lives in `lib/matches-hub.ts` (`defaultMatchesFilter`, `sortHubMatches`,
// `groupByDay`) so it can be enumerated by a pure suite; every string comes
// from the dictionary through `t()`; every timestamp goes through
// `format.ts` with the FIXTURE's own zone, never the viewer's. What is left
// here is the wiring, and the product decisions written out at each one.
import { useState, useSyncExternalStore } from "react";
import { fmtDate, fmtZoneAbbrev } from "@/lib/format";
import type { Dict as PublicDict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import {
  MATCH_BUCKETS,
  UNSCHEDULED_KEY,
  defaultMatchesFilter,
  groupByDay,
  sortHubMatches,
  type BucketCounts,
  type MatchBucket,
} from "@/lib/matches-hub";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { MatchCard } from "./match-card";

export interface MatchesTabProps {
  doc: CompetitionHubDocT;
  dict: PublicDict;
  locale: Locale;
  /** `Date.now()` at render, passed down rather than read here so the card's
   *  "Starts in 2 hours" is stable across a server render and its hydration. */
  now: number;
  /**
   * A `?filter=` deep link, or a caller that knows better than the ladder.
   * SEEDS the state; it does not pin it — once the spectator picks a chip
   * theirs wins, and a later poll never moves it back.
   */
  initialFilter?: MatchBucket | null;
  /** A `?division=` deep link. `null`/absent means All. */
  initialDivision?: string | null;
}

// R1: one DOM, branched. The rail scrolls horizontally at every width and
// bleeds to the phone edge below `md` so a chip is never half-cut by the
// page gutter — `-mx-4 px-4` against the public page's own `px-4`.
const RAIL_CLASS = "flex gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4";

// `min-h-11` is the 44px tap target (AGENTS.md). NOTE the divergence from
// `PublicTabRail`, which splits the button (hit area) from an inner span (the
// pill) precisely so `min-h-11` does not stretch the pill background: a chip
// here carries its COUNT as a direct text child ("Live 2"), so there is no
// inner span to put the pill on without breaking that. The chip therefore IS
// the tap target, 44px tall — which is the ordinary shape of a mobile filter
// chip, and a deliberate difference from the tab rail directly above it
// rather than a copy of it that went wrong.
const CHIP_CLASS =
  "inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm tabular-nums transition";
const CHIP_ON = "bg-accent font-semibold text-accent-ink shadow-sm";
const CHIP_OFF = "font-medium text-ink-muted hover:bg-accent-soft hover:text-accent-strong";

const DAY_OPTS: Intl.DateTimeFormatOptions = {
  weekday: "long",
  day: "numeric",
  month: "long",
};

// The viewer's OWN zone, read the way `scorepad/v3/scorebug.tsx`'s
// `useIsPhone` reads `matchMedia` and for the same reasons: it is a value the
// BROWSER owns and components only read, `getServerSnapshot` gives the server
// render a defined answer so hydration cannot mismatch, and it costs no extra
// render. The brief specified `useState` + a mount `useEffect`
// (`client-time.tsx:30-38`'s older shape); that is precisely the "cascading
// render" `react-hooks/set-state-in-effect` warns about, and writing it that
// way added a fresh lint warning to a file that otherwise has none.
//
// `subscribe` is a no-op on purpose — unlike a media query, a zone does not
// change under a running tab. It still has to be module-level and stable, or
// React re-subscribes on every render.
const subscribeToViewerZone = () => () => {};
/** Cached because `getSnapshot` must return a value that does not change
 *  identity between calls, or React re-renders forever. */
let cachedViewerZone: string | null | undefined;
function readViewerZone(): string | null {
  if (cachedViewerZone === undefined) {
    try {
      cachedViewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      // An engine without a resolvable zone keeps the caption. Stating the
      // zone to someone who might already be in it beats hiding it from
      // someone who is not.
      cachedViewerZone = null;
    }
  }
  return cachedViewerZone;
}
/** The SERVER cannot know the viewer's zone, so it renders the caption. That
 *  is the harmless arm: the caption disappears after hydration for the
 *  viewers it is noise for, and never disappears for the ones who need it. */
function readViewerZoneOnServer(): string | null {
  return null;
}

/** Attribute ORDER is load-bearing and not cosmetic: the suite matches
 *  `data-testid="…"[^>]*aria-pressed="…"`, and `[^>]*` cannot cross the `>`
 *  that ends an opening tag — so an attribute that moves ahead of
 *  `data-testid` reds a test about something else entirely. The same hazard
 *  `tab-rail.tsx:137-143` writes up for its own roving `tabIndex`. */
function chip(testid: string, label: string, pressed: boolean, onPress: () => void) {
  return (
    <button
      key={testid}
      data-testid={testid}
      aria-pressed={pressed}
      type="button"
      onClick={onPress}
      className={`${CHIP_CLASS} ${pressed ? CHIP_ON : CHIP_OFF}`}
    >
      {label}
    </button>
  );
}

export function MatchesTab({
  doc,
  dict,
  locale,
  now,
  initialFilter,
  initialDivision,
}: MatchesTabProps) {
  // `null` here means "the spectator has not chosen", NOT "no filter" — the
  // ladder answers for them until they do. Storing the CHOICE rather than the
  // resolved filter is what keeps a polling document honest: a hub that had
  // no fixtures when it first rendered and gains them on the next poll picks
  // up the ladder's answer, where a filter frozen at mount would sit on
  // `null` and show the empty-filter state beside a full rail.
  const [chosen, setChosen] = useState<MatchBucket | null>(initialFilter ?? null);
  const [division, setDivision] = useState<string | null>(initialDivision ?? null);

  // The zone caption is DROPPED when the venue's zone is the viewer's own —
  // "times in BST" is noise to someone already in BST.
  //
  // `renderToStaticMarkup` takes the SERVER snapshot, so the suite below pins
  // the caption-shown arm only; the post-hydration arm needs a browser and is
  // Task 11/12's e2e. Stated rather than left implicit, because a static-markup
  // test that could not see the other arm is exactly the kind of gap that gets
  // read later as coverage.
  const viewerZone = useSyncExternalStore(
    subscribeToViewerZone,
    readViewerZone,
    readViewerZoneOnServer,
  );

  // Counts are over ALL matches, deliberately: a chip is a TOTAL, so it does
  // not change under the division filter. A count that fell to zero while its
  // own chip stayed on screen would read as "this filter is broken" rather
  // than "this division has none of those".
  const counts: BucketCounts = { live: 0, upcoming: 0, completed: 0 };
  for (const match of doc.matches) counts[match.bucket] += 1;

  const filter = chosen ?? defaultMatchesFilter(counts);

  // The ABSOLUTE empty case, stated first and before any rail is built —
  // `defaultMatchesFilter`'s own rule, repeated here because it is the same
  // rule: a competition with no fixtures has nothing to filter, and three
  // chips reading zero above an empty list is worse than one sentence.
  if (doc.matches.length === 0) {
    return (
      <p data-testid="mh-matches-empty" className="py-8 text-center text-sm text-ink-muted">
        {t(dict, "matchesHub.empty")}
      </p>
    );
  }

  // Only divisions that actually have a fixture: a hub document carries every
  // division, including ones drawn but not scheduled, and a chip for one of
  // those is a dead end with the spectator's tap already spent. And with one
  // division there is nothing to choose between, so the whole rail goes —
  // which also takes the redundant per-card chip with it below.
  const withMatches = new Set(doc.matches.map((match) => match.divisionSlug));
  const divisions = doc.divisions.filter((d) => withMatches.has(d.slug));
  const showDivisionRail = divisions.length > 1;
  // The card's own division chip repeats what the rail already says once the
  // spectator has narrowed to a division — `MatchCard`'s `showDivision` exists
  // for exactly this caller.
  const showDivisionOnCards = showDivisionRail && division === null;

  const shown = sortHubMatches(
    doc.matches.filter(
      (match) =>
        match.bucket === filter && (division === null || match.divisionSlug === division),
    ),
  );
  const groups = groupByDay(shown);

  return (
    <div className="space-y-3">
      <div
        data-testid="mh-filters"
        role="group"
        tabIndex={0}
        aria-label={t(dict, "matchesHub.filtersLabel")}
        className={RAIL_CLASS}
      >
        {MATCH_BUCKETS.filter((bucket) => counts[bucket] > 0).map((bucket) =>
          chip(
            `mh-filter-${bucket}`,
            `${t(dict, `matchesHub.filter.${bucket}`)} ${counts[bucket]}`,
            bucket === filter,
            () => setChosen(bucket),
          ),
        )}
      </div>

      {showDivisionRail ? (
        <div
          data-testid="mh-divisions"
          role="group"
          tabIndex={0}
          aria-label={t(dict, "matchesHub.divisionsLabel")}
          className={RAIL_CLASS}
        >
          {chip("mh-division-all", t(dict, "matchesHub.division.all"), division === null, () =>
            setDivision(null),
          )}
          {divisions.map((d) =>
            chip(`mh-division-${d.slug}`, d.name, division === d.slug, () => setDivision(d.slug)),
          )}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p
          data-testid="mh-matches-empty-filter"
          className="py-8 text-center text-sm text-ink-muted"
        >
          {t(dict, "matchesHub.emptyFilter")}
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => {
            const first = g.items[0];
            const dated = g.key !== UNSCHEDULED_KEY;
            return (
              <section key={g.key} data-testid={`mh-day-${g.key}`}>
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                  <h3 className="font-display text-sm font-semibold text-ink">
                    {dated
                      ? // en-GB, in every locale. `format.ts:10` pins `LOCALE`
                        // and `fmtDate` takes no locale parameter — a
                        // repo-wide, deliberate deferral, not an oversight
                        // here. The copy AROUND this heading is translated.
                        fmtDate(g.tz, first.scheduledAt, DAY_OPTS)
                      : t(dict, "matchesHub.unscheduled")}
                  </h3>
                  {/* No caption on the unscheduled group: `fmtZoneAbbrev`
                      falls back to `new Date()` when there is no instant, so
                      it would cheerfully print a zone for a fixture that has
                      no time to state one at. */}
                  {dated && viewerZone !== g.tz ? (
                    <span className="text-xs text-ink-muted">
                      {t(dict, "matchesHub.timesIn", {
                        tz: fmtZoneAbbrev(g.tz, first.scheduledAt),
                      })}
                    </span>
                  ) : null}
                </div>
                {/* Two-up from `md`: more of the list on one screen, and NO
                    new control — the same cards, laid out wider. `min-w-0` on
                    the cell because a grid item defaults to `min-width: auto`
                    and the card truncates three of its own strings. */}
                <ul className="grid gap-2 md:grid-cols-2">
                  {g.items.map((match) => (
                    <li key={match.fixtureId} className="min-w-0">
                      <MatchCard
                        match={match}
                        dict={dict}
                        locale={locale}
                        now={now}
                        showDivision={showDivisionOnCards}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
