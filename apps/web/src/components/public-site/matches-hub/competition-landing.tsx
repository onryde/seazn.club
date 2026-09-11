"use client";
// Spectator surface W2, Task 11 — THE MOUNT. Five tabs built over four tasks,
// a status ladder, a live transport and a tab rail, joined into one client root:
//
//     mh-root[data-transport] → PublicTabRail → role="tabpanel" → the active tab
//
// The shape is W1's match-centre root (`match-centre/match-centre.tsx:107-120`)
// and the divergences from it are deliberate and listed where they happen. The
// whole tree is derived from `doc` on EVERY render, so a poll that delivers a
// new document moves every tab, the rail and the status line together and
// nothing is ever reloaded (design R10).
//
// ── THE THING THAT KEEPS GOING WRONG ON THIS SURFACE ───────────────────────
// A remembered CHOICE plus a conditionally-rendered CONTROL is a stranded state
// unless something reconciles them, and the document here changes under the
// spectator on every poll tick. Task 8 shipped this defect in its filter rail —
// a chosen bucket that emptied left the rail with nothing pressed and no
// on-screen escape — and the trigger was not a crafted URL but an ordinary
// live match ending. The same hole is one line wide here: a spectator reading
// Stats when the last leader board empties would be looking at a panel whose
// tab is no longer on the rail. `activeTab` below reconciles on every render
// rather than syncing in an effect, and it is exported and unit-tested because
// its deep-link arm is unreachable from any render in a DOM-less environment.
import { useCallback, useState, type ReactNode } from "react";
import type { Dict as PublicDict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type {
  CompetitionHubDocT,
  CompetitionHubTabIdT,
} from "@/server/public-site/competition-hub-schema";
import { PublicTabRail } from "../tab-rail";
import { useTabParam } from "../use-tab-param";
import { useLiveCompetition } from "../use-live-competition";
import { useNow } from "../match-centre/use-now";
import { OverviewTab } from "./overview-tab";
import { MatchesTab } from "./matches-tab";
import { TableTab } from "./table-tab";
import { StatsTab } from "./stats-tab";
import { TeamsTab } from "./teams-tab";
import { InfoTab } from "./info-tab";

/**
 * Every tab this root can actually render.
 *
 * `gallery` is excluded at the TYPE level rather than handled and ignored, and
 * that is what makes the panel switch below exhaustive without a dead case: W4
 * lifts the reservation by teaching `deriveHubTabs` to DERIVE the tab, and on
 * the day it does, this alias stops excluding it and `tsc` points at the one
 * switch that needs a new arm.
 */
export type LandingTabId = Exclude<CompetitionHubTabIdT, "gallery">;

/**
 * Which tab is showing: the spectator's tap, else the `?tab=` deep link, else
 * the document's first tab — and each of the first two only while it names a
 * tab that is STILL RENDERABLE.
 *
 * The membership test is not belt-and-braces. It is doing four jobs at once,
 * and three of them are live:
 *   • a tap whose tab's data disappeared on a later poll (the Task 8 defect);
 *   • a `?tab=` naming a tab this competition does not have — a link shared
 *     from a competition that did, or one that did last week;
 *   • a bare `?tab=`, which `URLSearchParams.get` returns as `""`. No tab has
 *     that id, so the same test folds it away with no separate truthiness
 *     clause (Task 8's review found `?? null` keeping exactly this);
 *   • `?tab=gallery`, which type-checks against the document's own union and
 *     is nonetheless not renderable here.
 *
 * The tap is considered FIRST and the deep link second, so a tap wins for good
 * — no later re-render drags a spectator back to the tab they arrived on — but
 * a tap that stops being renderable falls back through the deep link rather
 * than jumping straight to the default.
 *
 * The final `"overview"` is a crash guard, not a rule. `tabs` cannot be empty
 * for any parseable document (`deriveHubTabs` always emits `overview` and
 * `info`, and the schema demands the two match), so what it catches is a
 * hand-built document whose tabs are `["gallery"]` and filter to nothing —
 * where `tabs[0]!` would be `undefined` and the panel id would read
 * `mh-tab-panel-undefined`.
 */
export function activeTab(
  tabs: readonly LandingTabId[],
  manualTab: string | null,
  deepLinked: string | null,
): LandingTabId {
  const renderable = new Set<string>(tabs);
  const chosen = [manualTab, deepLinked].find((id) => id !== null && renderable.has(id));
  return (chosen as LandingTabId | undefined) ?? tabs[0] ?? "overview";
}

export interface CompetitionLandingProps {
  /** The server-rendered document. Also the poll's seed and its fallback: a
   *  failed refresh keeps the last good one rather than throwing to the UI. */
  initial: CompetitionHubDocT;
  /**
   * ONE dictionary and ONE locale, handed to every panel.
   *
   * Task 10's review F9 books the decision here, so it is made here: this root
   * does not MIX. It forwards the single locale it is given, and whether that
   * is the org's or the viewer's is the page's call (Task 12) — the division
   * page's precedent is the ORG's (`[divisionSlug]/page.tsx` resolves
   * `getDictionary(orgLocale, "public")` precisely because the route is ISR and
   * a per-visitor read would make every cached copy wrong for somebody).
   *
   * What is NOT in this root's gift, and is worth stating where the props are:
   * `competition-hub.ts:368` builds the whole document in the org's
   * `default_locale`, so every pre-resolved string in it — board labels,
   * `divisionName` everywhere — is org-language whatever is passed here; and
   * `lib/format.ts:10` pins `en-GB` for every date on the surface. So a page
   * that chose to pass a viewer locale would produce three languages in one
   * panel. Passing the org's collapses it to two.
   */
  dict: PublicDict;
  locale: Locale;
  /** The org's sponsor board — an async server component, so it arrives as a
   *  slot. Reaches the Overview and the Info tab; only one panel is ever
   *  mounted, so it is never rendered twice. */
  sponsorsSlot?: ReactNode;
  /** The competition's own prose, sanitised server-side. */
  descriptionSlot?: ReactNode;
  /** The share bar — a client island with a clipboard and a toast. Info only:
   *  the Overview has no slot for it, deliberately, because a share control
   *  above the live scores is not what a spectator came for. */
  shareSlot?: ReactNode;
}

/**
 * How often the clock feeding the cards is re-read.
 *
 * NOT `useNow()`'s 1 Hz default. Nothing on this surface changes faster than a
 * minute — `MatchCard`'s relative sentence is minute-granular by construction
 * (`Intl.RelativeTimeFormat` over minutes or hours) and the status ladder turns
 * on kick-off times — while a 1 Hz tick re-renders the whole active panel,
 * standings tables included, once a second for as long as the tab is open. W1
 * uses the default because its consumer is an "updated Xs ago" line that really
 * does count seconds; this one has no such line.
 */
const NOW_TICK_MS = 30_000;

export function CompetitionLanding({
  initial,
  dict,
  locale,
  sponsorsSlot,
  descriptionSlot,
  shareSlot,
}: CompetitionLandingProps) {
  const { doc, transport } = useLiveCompetition({
    // From the DOCUMENT, not from props of their own: the two slugs and the
    // realtime flag are already on it, and a second way to say them is a second
    // thing to drift.
    orgSlug: initial.orgSlug,
    competitionSlug: initial.competitionSlug,
    initial,
    realtime: initial.realtime,
  });
  const now = useNow(NOW_TICK_MS);
  const deepLinked = useTabParam();

  // Only an explicit TAP is stored. Which tab is actually active is a plain
  // derivation every render (`activeTab`), never synced through an effect —
  // W1's root settled on this shape for the same reason: a poll that drops the
  // chosen tab falls back on the very next render, with no extra render pass
  // and no `react-hooks/set-state-in-effect` warning.
  const [manualTab, setManualTab] = useState<LandingTabId | null>(null);

  // `history.replaceState`, never `push` — a tab is not a page in the browser's
  // history sense, and stacking entries would make Back walk the tab bar
  // instead of leaving the competition. It deliberately does not fire
  // `popstate`, which is why `useTabParam`'s store does not need to hear about
  // it: the tap has already moved `manualTab`, which outranks the URL.
  const onChange = useCallback((tab: LandingTabId) => {
    setManualTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  }, []);

  // Derived from THIS render's document, so a competition that publishes its
  // first standings table between ticks grows a Table tab without a reload.
  const tabs = doc.tabs.filter((id): id is LandingTabId => id !== "gallery");
  const active = activeTab(tabs, manualTab, deepLinked);

  // FORGET a choice that has stopped being renderable, rather than merely
  // ignoring it for this render (review M2 — AGENTS.md 13's "check both
  // directions" applied to the reconciliation above).
  //
  // `activeTab` already moves the spectator off a tab whose data disappeared.
  // Keeping the dead choice in state meant that when the data came BACK on a
  // later poll — a leader board repopulating, a withdrawn standings table
  // republished — `active` jumped to it with no spectator action, mid-read.
  // Being moved once because the thing you were reading no longer exists is
  // unavoidable; being yanked out of the Overview five minutes later because it
  // exists again is not, and the spectator has no idea why it happened.
  //
  // The trade is that a transient blip loses the choice permanently. That is
  // the cheaper mistake: a failed poll keeps the last good document
  // (`use-live-competition.ts` swallows and holds), so reaching here at all
  // means the document really no longer carries the tab.
  //
  // A render-phase update, not an effect: React's own sanctioned "adjust state
  // when the props change" pattern (`useBoardActions` clears its optimistic
  // overrides the same way). It discards the in-progress render and re-runs
  // from the top, which converges immediately — `manualTab` is null on the
  // second pass and the condition is false. An effect here would cost an extra
  // committed render and trip `react-hooks/set-state-in-effect`.
  if (manualTab !== null && !tabs.includes(manualTab)) setManualTab(null);

  return (
    <div data-testid="mh-root" data-transport={transport} className="min-w-0 space-y-4">
      <PublicTabRail
        tabs={tabs.map((id) => ({ id, label: t(dict, `landing.tab.${id}`) }))}
        active={active}
        onChange={onChange}
        ariaLabel={t(dict, "landing.tabsLabel")}
        testidPrefix="mh"
      />
      {/* ONE `role="tabpanel"` container at the single call site, rather than
          one inside each of the six panel components — there is only ever one
          panel rendered at a time, so this gives the exact same DOM contract
          without touching six files. W1's root made the same call
          (`match-centre.tsx:107-120`).

          `tabIndex={0}` is UNCONDITIONAL, and the rationale is W1's, verified
          against this document rather than carried along with the code: the
          Info panel here contains prose, a definition list and a set of links,
          and the Overview's `dates`/`empty` rungs can render a status sentence
          and nothing else — so a keyboard user arrowing along the rail and
          pressing Tab would land PAST the content the rail had just selected.
          Which panels hold a focusable child is DOCUMENT-dependent (a table's
          scroll region exists only when there are rows to scroll), so a
          conditional would be a rule that silently changed with the data. */}
      <div
        role="tabpanel"
        tabIndex={0}
        id={`mh-tab-panel-${active}`}
        aria-labelledby={`mh-tab-${active}`}
        data-testid={`mh-tab-panel-${active}`}
      >
        {panelFor(active, {
          doc,
          dict,
          locale,
          now,
          sponsorsSlot,
          descriptionSlot,
          shareSlot,
        })}
      </div>
    </div>
  );
}

export interface PanelArgs {
  doc: CompetitionHubDocT;
  dict: PublicDict;
  locale: Locale;
  now: number;
  sponsorsSlot?: ReactNode;
  descriptionSlot?: ReactNode;
  shareSlot?: ReactNode;
}

/**
 * The active tab's panel. A `switch` with a `never` default rather than a
 * lookup table keyed on the id, and the difference is the failure mode: a table
 * with a missing key hands back `undefined` and renders an EMPTY panel under a
 * tab the rail is happily pointing at, silently. A switch cannot compile with a
 * member missing.
 *
 * Note the props each panel takes differ, which is the other reason this is not
 * a table — `TAB_PANELS`-style uniformity (W1's `tab-panels.ts`) only works
 * where every panel has one signature, and these five do not: `TableTab`,
 * `StatsTab` and `TeamsTab` read nothing but the document and the dictionary.
 *
 * EXPORTED for its own test, and the mutation sweep is why: replacing the
 * `never` default with `if (unhandled) return null` survived the whole suite,
 * because no render can reach it — which is the point of the guard and also
 * means the guard had no witness. It has one now.
 */
export function panelFor(active: LandingTabId, a: PanelArgs): ReactNode {
  switch (active) {
    case "overview":
      return (
        <OverviewTab
          doc={a.doc}
          dict={a.dict}
          locale={a.locale}
          now={a.now}
          sponsorsSlot={a.sponsorsSlot}
          descriptionSlot={a.descriptionSlot}
        />
      );
    case "matches":
      return <MatchesTab doc={a.doc} dict={a.dict} locale={a.locale} now={a.now} />;
    case "table":
      return <TableTab doc={a.doc} dict={a.dict} />;
    case "stats":
      return <StatsTab doc={a.doc} dict={a.dict} />;
    case "teams":
      return <TeamsTab doc={a.doc} dict={a.dict} />;
    case "info":
      return (
        <InfoTab
          doc={a.doc}
          dict={a.dict}
          locale={a.locale}
          descriptionSlot={a.descriptionSlot}
          shareSlot={a.shareSlot}
          sponsorsSlot={a.sponsorsSlot}
        />
      );
    default: {
      const unhandled: never = active;
      throw new Error(
        `CompetitionLanding: no panel for tab ${JSON.stringify(unhandled)} — ` +
          `add a case above rather than a fallback.`,
      );
    }
  }
}
