"use client";
// Spectator surface W2, Task 8 — the competition hub's Matches tab: a filter
// rail, a division rail, and the chosen list grouped by the day it is played
// on AT THE VENUE.
//
// Copy, bucketing and ordering are NOT decided here: they live in
// `lib/matches-hub.ts` (`defaultMatchesFilter`, `sortHubMatches`, `groupByDay`)
// so a pure suite can enumerate them; every string comes from the dictionary
// through `t()`; every timestamp goes through `format.ts` with the FIXTURE's
// own zone, never the viewer's. Two things this file does decide, each written
// out where it happens: it RECONCILES the spectator's remembered choice against
// what is currently renderable (a chip that is gone cannot be un-pressed), and
// it flips the day-group order for the completed bucket so a Results list opens
// on the most recent day.
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

/**
 * Whether a day group states the zone its times are in.
 *
 * EXPORTED and structurally typed on purpose (review F4): inlined in the JSX,
 * the `viewerZone` arm was unkillable — `renderToStaticMarkup` takes the
 * server snapshot, so every static-markup test renders the caption-shown arm
 * and a mutant that deleted the comparison survived the whole suite. As three
 * lines behind a name, every arm is witnessable with no DOM at all. What still
 * needs a browser is only whether `useSyncExternalStore` returns the right
 * zone, and that belongs to Task 11/12's e2e.
 *
 * Three reasons to say nothing, and the third is a correctness fix rather than
 * a tidy-up (review P2):
 *   • the unscheduled group has no instant — `fmtZoneAbbrev` falls back to
 *     `new Date()` and would cheerfully print a zone for a fixture that has no
 *     time to state one at;
 *   • the group's fixtures DISAGREE about their zone. `DayGroup.tz` is the
 *     FIRST item's zone and `lib/matches-hub.ts:120-123` says so in as many
 *     words — "meaningful for the common case (one competition, one zone) and
 *     only that". Two fixtures in different zones can share a day key, and
 *     captioning that group "times in BST" over a card showing an IST kick-off
 *     tells a spectator something false. Silence is the honest answer; each
 *     card still carries its own time in its own zone;
 *   • the viewer is already in that zone, where the caption is only noise.
 */
export function showZoneCaption(
  group: { key: string; tz: string; items: readonly { tz: string }[] },
  viewerZone: string | null,
): boolean {
  if (group.key === UNSCHEDULED_KEY) return false;
  if (!group.items.every((item) => item.tz === group.tz)) return false;
  return viewerZone !== group.tz;
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
  const [chosenDivision, setDivision] = useState<string | null>(initialDivision ?? null);

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

  // RECONCILED against what is renderable, not merely remembered (review F1).
  // A chip exists only while its bucket has matches, so a chosen bucket that
  // empties took its own chip with it and left the rail with NOTHING pressed
  // above the empty-filter sentence. Two ways in, both real: `?filter=live` on
  // a hub with no live match, and — the common one — a live match ENDING under
  // a spectator who tapped Live, because `use-live-competition.ts` swaps the
  // whole document on every tick (design R10). Falling back to the ladder moves
  // the view on its own instead of stranding it.
  //
  // `counts[chosen] > 0` also catches an out-of-domain `?filter=` value that a
  // Task 11/12 caller reads off a URL: `counts["nonsense"]` is `undefined`,
  // `undefined > 0` is false, and the ladder answers.
  const filter =
    chosen !== null && counts[chosen] > 0 ? chosen : defaultMatchesFilter(counts);

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
  // ONE expression of which chips exist, read by both the rail and the
  // reconciliation below. Writing the two conditions separately gave the
  // reconciliation a `showDivisionRail &&` conjunct that no test could kill,
  // because with a single division, filtering by it removes nothing — an
  // unkillable guard is decoration (AGENTS.md 3). Derived instead, the
  // invariant "a chosen division always has a chip that can clear it" is
  // structural rather than asserted twice.
  const divisionChips = divisions.length > 1 ? divisions : [];
  const showDivisionRail = divisionChips.length > 0;

  // RECONCILED the same way as the filter, and this one is worse if it is not
  // (review F2): a chosen division with no chip on screen has no ALL chip
  // either, because suppressing the rail suppresses the way out of it. The
  // spectator's only escape was editing the URL. Honouring the choice only
  // while a chip that can clear it is rendered closes every route in at once:
  //   • `?division=<slug>` naming a division the hub carries but no fixture
  //     belongs to (the document carries every division — see above);
  //   • a bare `?division=`, which `URLSearchParams.get` returns as `""` —
  //     `?? null` kept that, and `""` matches no slug, so All rendered
  //     UNPRESSED above an empty list. No division has slug `""`, so the same
  //     `some()` folds it away without a separate truthiness clause;
  //   • the live document dropping the chosen division's last fixture, or its
  //     second-to-last, which pulls the whole rail.
  const division = divisionChips.some((d) => d.slug === chosenDivision) ? chosenDivision : null;
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
  // `sortHubMatches` reads completed newest-first and `groupByDay` then re-sorts
  // the GROUPS ascending, so the intent survives inside a day and is inverted
  // between days: a Results list opened on the competition's FIRST match day
  // and a spectator scrolled to the bottom for last night. Controller ruling
  // (review F9): reverse the dated groups for the completed bucket only.
  // Deliberately done HERE and not in `groupByDay` — that helper is merged, is
  // separately tested, and its ascending order is right for the other two
  // buckets. Unscheduled stays last in both directions: it is not a day, so it
  // has no place in a chronology.
  const byDay = groupByDay(shown);
  const groups =
    filter === "completed"
      ? [
          ...byDay.filter((g) => g.key !== UNSCHEDULED_KEY).reverse(),
          ...byDay.filter((g) => g.key === UNSCHEDULED_KEY),
        ]
      : byDay;

  return (
    // `min-w-0` on the root (review P3): everything below it is protected, but
    // Task 11/12 mounts this component inside a layout nobody has written yet,
    // and a flex or grid parent breaks the truncate chain ABOVE here.
    <div className="min-w-0 space-y-3">
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
          {divisionChips.map((d) =>
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
                  {showZoneCaption(g, viewerZone) ? (
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
