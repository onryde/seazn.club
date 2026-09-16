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
import { useDivisionParam, useTabParam, writeTabParam } from "../use-tab-param";
import { useLiveCompetition } from "../use-live-competition";
import { useNow } from "../match-centre/use-now";
import { OverviewTab } from "./overview-tab";
import { MatchesTab } from "./matches-tab";
import { TableTab } from "./table-tab";
import { KnockoutTab } from "./knockout-tab";
import { StatsTab } from "./stats-tab";
import { TeamsTab } from "./teams-tab";
import { InfoTab } from "./info-tab";

/**
 * Every tab THIS BUNDLE has a panel for — an ALLOWLIST, and the difference from
 * a list of exclusions is which way a gap fails.
 *
 * An exclusion names the ids known to have no panel, so an id the document
 * learns AFTER this bundle shipped slips straight through it: a spectator
 * whose page loaded yesterday's bundle polls today's document, the rail offers
 * the new tab, and `panelFor` throws. The allowlist names what CAN render, so
 * anything else — `gallery` (W4's reserved slot), or an id nobody has invented
 * yet — is simply not offered, and a `?tab=` naming it falls back like any
 * other unknown id.
 *
 * `LandingTabId` is DERIVED from this list, which keeps `panelFor`'s `never`
 * switch exhaustive over exactly it: add an id here without a panel arm and
 * `tsc` refuses; add an arm without the id and the tab never shows.
 * `knockout` is the worked example: the document derived that tab one task
 * before its panel existed, this list kept it off the rail meanwhile, and
 * plan 2026-09-13's Task 2 added the id and the arm together.
 */
export const RENDERABLE_TABS = [
  "overview",
  "matches",
  "table",
  "knockout",
  "stats",
  "teams",
  "info",
] as const satisfies readonly CompetitionHubTabIdT[];
export type LandingTabId = (typeof RENDERABLE_TABS)[number];
const RENDERABLE: ReadonlySet<string> = new Set(RENDERABLE_TABS);

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
 * The tap is considered FIRST and the arrival second, so a tap wins for good —
 * no later re-render drags a spectator back to the tab they arrived on.
 *
 * WHAT THIS LADDER DOES *NOT* DO, corrected after the final review said the
 * opposite: it does not "fall back through the deep link" when a tap stops
 * being renderable. It cannot, and the earlier version of this sentence
 * described a rung that is unreachable by construction. `onChange` writes the
 * tap into `?tab=`, so the arrival value is gone from the URL the moment a
 * spectator taps anything, and `arrivalTab` (below) then correctly reports
 * "no arrival". The two rungs are therefore mutually exclusive in practice —
 * the tap if there is one, otherwise the arrival — which is the same shape
 * `tabs.tsx` writes as `picked ?? fromUrl`. The `find` is still the right code:
 * it is what drops EITHER value when the tab it names is not renderable.
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
  arrived: string | null,
): LandingTabId {
  const renderable = new Set<string>(tabs);
  const chosen = [manualTab, arrived].find((id) => id !== null && renderable.has(id));
  return (chosen as LandingTabId | undefined) ?? tabs[0] ?? "overview";
}

/**
 * The tab this spectator ARRIVED on — which is not the same thing as the tab
 * currently in the URL, and conflating the two was the final review's C1.
 *
 * `onChange` writes every tap into `?tab=` (deliberately: what a spectator
 * shares should be what they are looking at), and `useTabParam` re-reads
 * `window.location.search` on every render. So from the first tap onward the
 * live parameter is OUR OWN WRITE echoed back, and a component that keeps
 * feeding it to `activeTab` is reading its own output as an input. Two things
 * broke, and the second is a live defect a spectator can feel:
 *
 *   • the render-phase `setManualTab(null)` below forgot the STATE and not the
 *     URL, so when a withdrawn tab's data was republished on a later poll the
 *     echoed parameter matched again and pulled the spectator into that tab
 *     MID-READ — verbatim the defect that clear was added to fix;
 *   • the arrival rung of `activeTab` could only ever hold the same id as the
 *     tap rung, so it was dead by construction.
 *
 * Neutralising our own write is enough, and is deliberately narrower than "stop
 * reading the URL after the first tap": `useTabParam` subscribes to `popstate`
 * so that Back/Forward still moves the page, and a blunt `hasTapped` flag would
 * throw that away for the rest of the session. Only the exact value we last
 * wrote is discounted.
 *
 * NOTE the consequence, rather than leaving it to be rediscovered: our write
 * DESTROYS the original arrival value, so after a tap there is no arrival to
 * fall back to. That is why the ladder above says the two rungs are mutually
 * exclusive instead of claiming a fallback chain.
 */
export function arrivalTab(deepLinked: string | null, selfWritten: string | null): string | null {
  // ONE line, and the `null` cases need no guard of their own — which is worth
  // stating because the first version of this function carried one
  // (`if (deepLinked === null || selfWritten === null) return deepLinked`) and
  // the sweep proved it EQUIVALENT: deleting it changed no answer on any of the
  // five input shapes. `null === null` does read as an echo here, and returning
  // `null` for it is the same answer the guard gave. A redundant line that
  // claims to prevent something is the overclaim class this wave keeps paying
  // for, so it is gone rather than kept for reassurance.
  return deepLinked === selfWritten ? null : deepLinked;
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
  // NO `sponsorsSlot`. The sponsor board is not a panel of this root any more:
  // `page.tsx` renders it BELOW this whole component, so it is present on every
  // tab rather than only on the two that happened to have a slot for it
  // (owner ruling 2026-09-12; `sponsors-board.tsx`'s header has the reasoning).
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
  // The division a shared link names. Read here, at the root that owns the
  // URL, rather than inside `MatchesTab`, so the tab stays a component its
  // tests can hand a value to — which is how `initialDivision` was tested
  // for a whole wave while nothing in production ever passed it.
  const deepLinkedDivision = useDivisionParam();

  // Only an explicit TAP is stored. Which tab is actually active is a plain
  // derivation every render (`activeTab`), never synced through an effect —
  // W1's root settled on this shape for the same reason: a poll that drops the
  // chosen tab falls back on the very next render, with no extra render pass
  // and no `react-hooks/set-state-in-effect` warning.
  const [manualTab, setManualTab] = useState<LandingTabId | null>(null);

  // The URL write is `writeTabParam` (`use-tab-param.ts`), which carries the
  // `replaceState`-never-`pushState` reasoning and, more importantly, the
  // hazard it creates: what it writes is what `useTabParam` reads straight back
  // on the next render. `selfWritten` plus `arrivalTab` is what stops that echo
  // being mistaken for a spectator's arrival.
  // The last value THIS component put in the URL, remembered so the parameter
  // it reads back can be told apart from one a spectator arrived with — see
  // `arrivalTab`. Kept separately from `manualTab` on purpose: `manualTab` is
  // cleared when its tab stops being renderable, and the URL is not, so a
  // single piece of state cannot answer both questions.
  const [selfWritten, setSelfWritten] = useState<string | null>(null);

  const onChange = useCallback((tab: LandingTabId) => {
    setManualTab(tab);
    setSelfWritten(tab);
    writeTabParam(tab);
  }, []);

  // Derived from THIS render's document, so a competition that publishes its
  // first standings table between ticks grows a Table tab without a reload.
  const tabs = doc.tabs.filter((id): id is LandingTabId => RENDERABLE.has(id));
  const active = activeTab(tabs, manualTab, arrivalTab(deepLinked, selfWritten));

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
          descriptionSlot,
          shareSlot,
          initialDivision: deepLinkedDivision,
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
  descriptionSlot?: ReactNode;
  shareSlot?: ReactNode;
  /** `?division=` — the seed for the tabs that FILTER by division: Matches,
   *  Knockout, and (since the division-page parity ruling, 2026-09-16) Table
   *  and Teams. Stats groups by division and has nothing to seed. */
  initialDivision?: string | null;
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
 * where every panel has one signature, and these do not: `StatsTab` reads
 * nothing but the document and the dictionary, while `TableTab` and `TeamsTab`
 * also take the `?division=` seed (and Teams the locale).
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
          descriptionSlot={a.descriptionSlot}
        />
      );
    case "matches":
      return (
        <MatchesTab
          doc={a.doc}
          dict={a.dict}
          locale={a.locale}
          now={a.now}
          initialDivision={a.initialDivision}
        />
      );
    case "table":
      return <TableTab doc={a.doc} dict={a.dict} initialDivision={a.initialDivision} />;
    case "knockout":
      return (
        <KnockoutTab
          doc={a.doc}
          dict={a.dict}
          locale={a.locale}
          now={a.now}
          initialDivision={a.initialDivision}
        />
      );
    case "stats":
      return <StatsTab doc={a.doc} dict={a.dict} />;
    case "teams":
      return <TeamsTab doc={a.doc} dict={a.dict} locale={a.locale} initialDivision={a.initialDivision} />;
    case "info":
      return (
        <InfoTab
          doc={a.doc}
          dict={a.dict}
          locale={a.locale}
          descriptionSlot={a.descriptionSlot}
          shareSlot={a.shareSlot}
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
