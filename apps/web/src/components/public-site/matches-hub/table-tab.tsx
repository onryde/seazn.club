// Spectator surface W2, Task 9 — the competition hub's Table tab: every
// standings table the competition publishes, grouped under the division it
// belongs to.
//
// This component decides almost nothing, and that is deliberate. The TABLE is
// `StandingsTableView` (Task 2) — every column, every fold, every width and the
// phone disclosure live there. The DOCUMENT is the builder's: `doc.tables`
// arrives already ordered (live stage before complete, then `seq`, then pool),
// already formatted, already resolved into the org's locale, and every view
// already carries its own `divisionSlug`, `divisionName` and `fullHref`. So
// nothing here re-derives a name, a link or an order.
//
// What it does decide is written out where it happens, and there are three
// things:
//
//  • the tab-level EMPTY sentence, which the hub itself cannot reach —
//    `deriveHubTabs` gives a competition no Table tab until it has a table, so
//    this is the arm a direct render or a stale deep link lands on;
//  • ONE crown per DIVISION rather than one per table, because that is what a
//    champion is (see the strip below);
//  • two-up from `md` only when a division has more than one table.
//
// NO `"use client"`. Nothing here is stateful — the only interactive parts of
// this subtree are `StandingsTableView`'s own disclosure and its link, and that
// file carries its own directive. Leaving it off lets Task 11 render the tab in
// a server component (the whole table arrives in the HTML, which is the point
// of the phone composition) while the live client tree can import it just the
// same.
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { TableViewT } from "@/server/public-site/competition-hub-schema";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { StandingsTableView } from "../standings-table-view";

export interface TableTabProps {
  doc: CompetitionHubDocT;
  dict: PublicDict;
}

/**
 * `doc.tables` under one entry per division, in first-appearance order.
 *
 * By `divisionId`, and by a MAP rather than by adjacent runs: the two are the
 * same function on every document `competition-hub.ts` can build, because it
 * loops divisions outermost — but on a document whose tables interleave, the
 * run version prints the same division heading twice with another division
 * wedged between them, and the spectator has no way to read that as one
 * division. `Map` preserves insertion order, so the group order is the order
 * each division's FIRST table appears in and the order within a group is the
 * document's.
 */
function byDivision(tables: readonly TableViewT[]): TableViewT[][] {
  const groups = new Map<string, TableViewT[]>();
  for (const view of tables) {
    const group = groups.get(view.divisionId);
    if (group) group.push(view);
    else groups.set(view.divisionId, [view]);
  }
  return [...groups.values()];
}

export function TableTab({ doc, dict }: TableTabProps) {
  // Stated first, before any grouping: a competition with no standings has no
  // divisions to head and nothing to lay out. Unreachable through the hub —
  // `deriveHubTabs` (`lib/matches-hub.ts:240`) only emits the `table` tab when
  // `tables > 0`, and `CompetitionHubDoc`'s refinement makes that a rule the
  // document must satisfy rather than a convention — so what this catches is a
  // direct render and a `?tab=table` deep link that outlived its data. A blank
  // panel would read as a broken page; a sentence reads as an empty one.
  if (doc.tables.length === 0) {
    return (
      // The panel ROOT is inside this branch too — see the root's own note
      // below. A handle that exists on one arm and not the other is not a
      // handle.
      <div data-testid="mh-table" className="min-w-0">
        <p data-testid="mh-table-empty" className="py-8 text-center text-sm text-ink-muted">
          {t(dict, "table.empty")}
        </p>
      </div>
    );
  }

  return (
    // `min-w-0` on the root for the same reason Task 8's carries one (review
    // P3): everything below here is protected, but Task 11/12 mounts this
    // inside a layout nobody has written yet, and a flex or grid parent breaks
    // the truncate chain ABOVE this component — `StandingsTableView` truncates
    // its caption and every entrant name.
    //
    // `data-testid="mh-table"` added by Task 11 (its R3), for the reason
    // `matches-tab.tsx`'s root writes up: the hub root needs a uniform handle
    // for WHICH panel drew, and the three Task 10 tabs already had one.
    <div data-testid="mh-table" className="min-w-0 space-y-6">
      {byDivision(doc.tables).map((views) => {
        const first = views[0]!;
        // ONE crown per division, not one per table. `divisionChampion`
        // (`server/public-site/champion.ts`) crowns a DIVISION, and the builder
        // hands that single `championId` to every table it publishes for it
        // (`competition-hub.ts:562,590`), so the crowned row appears in the
        // group table AND the super-eight table of the same division — a
        // per-table strip would print the same champion twice for one title.
        //
        // Searched across the division's views rather than the first of them,
        // because the champion is not necessarily in every table (a pool table
        // they were never in) nor at the top of the one they are in: a side
        // that qualifies second from its group and wins the final is second in
        // the group table this crown sits above.
        const champion = views.flatMap((v) => v.rows).find((r) => r.champion);
        return (
          <section key={first.divisionId} className="space-y-3">
            <div className="space-y-2">
              {/* Wraps rather than truncates: a heading is the one string on
                  this tab with room to take two lines, and an ellipsised
                  division name is a worse answer than a taller heading.
                  `text-xl` and not `text-lg`, at EVERY width and not only from
                  `md`: the table's own caption directly below it is
                  `font-display text-lg font-semibold`
                  (`standings-table-view.tsx`), so a `text-lg` division heading
                  is the same size as the stage name it contains, and the
                  grouping this tab is built around stops being visible exactly
                  on the phone, where it matters most. */}
              <h2
                data-testid={`mh-table-division-${first.divisionSlug}`}
                className="font-display text-xl font-semibold tracking-tight text-ink md:text-2xl"
              >
                {first.divisionName}
              </h2>
              {champion ? (
                // Gold is fixed podium vocabulary, deliberately outside the org
                // theme — the same rule `standings-table-view.tsx:110-118`
                // states for its medal chips, so a red-branded org still reads
                // gold as first place. The division page's own banner
                // (`[divisionSlug]/page.tsx:133-148`) is the loud version of
                // this; on a tab that may carry six divisions it is a strip.
                <p
                  data-testid={`mh-table-champion-${first.divisionSlug}`}
                  className="flex min-w-0 items-center gap-2 rounded-lg bg-amber-50/60 px-3 py-2"
                >
                  <span aria-hidden className="shrink-0 text-base leading-none">
                    🏆
                  </span>
                  <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                    {t(dict, "table.champion")}
                  </span>
                  <span className="min-w-0 truncate font-display text-sm font-semibold text-ink">
                    {champion.name}
                  </span>
                </p>
              ) : null}
            </div>
            {/* Two-up from `md` only when there IS a second table: a lone
                standings table stretched across half the page is narrower than
                it needs to be for no gain, and below `md` nothing goes two-up
                at all — a half-width table at 360 puts the points column, the
                number the table exists for, behind a scroll. `min-w-0` on the
                cell because a grid item defaults to `min-width: auto`. */}
            <ul className={`grid gap-4${views.length > 1 ? " md:grid-cols-2" : ""}`}>
              {views.map((view) => (
                <li key={view.id} className="min-w-0">
                  <StandingsTableView
                    view={view}
                    dict={dict}
                    testid={`mh-table-${view.id}`}
                    // Restates the child's own default
                    // (`standings-table-view.tsx:159` is `showFullLink = true`),
                    // so deleting it changes nothing — recorded because a kill
                    // list that shows `showFullLink={false}` dying would
                    // otherwise read as evidence the PROP is load-bearing
                    // (review F6). It is here because the brief names it and
                    // because the Overview tab's teaser will pass the opposite,
                    // which makes the intent worth stating at both call sites.
                    showFullLink
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
