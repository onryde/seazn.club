// Spectator surface W2, Task 11 — `CompetitionLanding`, the client root that
// finally mounts the five tabs the last four tasks built.
//
// What this file is ABOUT is the join, not the panels: which tabs exist, which
// one is active, what happens to a spectator's choice when the document changes
// under them, and the fact that exactly ONE panel renders. Every panel's own
// contract is pinned in its own suite and is not restated here.
//
// TWO ENVIRONMENTS, on purpose:
//  • `renderToStaticMarkup` for the first-paint contract — this component is
//    mounted on an ISR route, so what the server emits is what a crawler and a
//    cold visitor get, and it must not depend on a browser.
//  • the shared `_hook-harness` (`renderIsland`) for anything that happens over
//    TIME — a poll that swaps the document, a tap that moves the tab. `apps/web`
//    vitest is `environment: "node"` with no jsdom, so this is the only way to
//    drive state at all.
//
// WHAT NEITHER CAN SEE, stated rather than left implicit: the `?tab=` deep link
// itself. `useTabParam` is `useSyncExternalStore`, and `renderToStaticMarkup`
// AND the harness both answer it with the server snapshot (null) by contract —
// which is the right production behaviour on an ISR page and is exactly why the
// reconciliation is extracted as `activeTab` and unit-tested below against real
// values. Whether React re-reads the store after hydration is React's contract,
// and belongs to the post-mount e2e leg after Task 12.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import {
  CompetitionHubDoc,
  type CompetitionHubDocT,
} from "@/server/public-site/competition-hub-schema";

vi.mock("../competition-hub-data", () => ({ fetchCompetitionHub: vi.fn() }));

/** A Supabase stub that RECORDS the channel names it was asked for, so the
 *  realtime wiring can be asserted as "this document's divisions, subscribed"
 *  rather than "something was called". Shape lifted from
 *  `use-live-competition.test.tsx`, trimmed to what this file needs. */
const rt = vi.hoisted(() => {
  const names: string[] = [];
  interface Ch {
    on: () => Ch;
    subscribe: (cb: (s: string) => void) => Ch;
    unsubscribe: () => void;
  }
  const channel = (name: string): Ch => {
    names.push(name);
    const ch: Ch = {
      on: () => ch,
      subscribe: (cb) => {
        cb("SUBSCRIBED");
        return ch;
      },
      unsubscribe: () => {},
    };
    return ch;
  };
  return { names, channel, reset: () => void (names.length = 0) };
});
vi.mock("@/lib/supabase-browser", () => ({ supabaseBrowser: () => ({ channel: rt.channel }) }));

import { fetchCompetitionHub } from "../competition-hub-data";
import { HUB_POLL_MS } from "../use-live-competition";
import { OverviewTab } from "../matches-hub/overview-tab";
import { MatchesTab } from "../matches-hub/matches-tab";
import { TableTab } from "../matches-hub/table-tab";
import { StatsTab } from "../matches-hub/stats-tab";
import { TeamsTab } from "../matches-hub/teams-tab";
import { InfoTab } from "../matches-hub/info-tab";
import {
  CompetitionLanding,
  activeTab,
  panelFor,
  type LandingTabId,
} from "../matches-hub/competition-landing";
import { board, hubDoc, leader, m, tableView, team } from "./hub-fixtures";

const dict = en as Dict;

const render = (
  initial: CompetitionHubDocT,
  over: { sponsorsSlot?: ReactNode; descriptionSlot?: ReactNode; shareSlot?: ReactNode } = {},
) =>
  renderToStaticMarkup(
    <CompetitionLanding
      initial={initial}
      dict={dict}
      locale="en"
      sponsorsSlot={over.sponsorsSlot}
      descriptionSlot={over.descriptionSlot}
      shareSlot={over.shareSlot}
    />,
  );

/** The whole opening tag carrying a testid, attribute order irrelevant. */
const tagOf = (h: string, testid: string): string => {
  const at = h.indexOf(`data-testid="${testid}"`);
  expect(at, `${testid} is in the markup`).toBeGreaterThan(-1);
  return h.slice(h.lastIndexOf("<", at), h.indexOf(">", at) + 1);
};

/** Every tab BUTTON the rail drew, in rail order. `PublicTabRail` emits
 *  `${prefix}-tab-${id}`, and `mh-tab-panel-${id}` shares that prefix — hence
 *  the negative lookahead, or the panel counts as a seventh tab. */
const railTabs = (h: string): string[] =>
  [...h.matchAll(/data-testid="mh-tab-(?!panel-)([a-z]+)"/g)].map(([, id]) => id!);

/** Every PANEL ROOT in the markup. The five sibling tabs and the Overview all
 *  carry `mh-<tabId>` on their own root — which is why Task 11 added the two
 *  that were missing. A COUNT over this is what says "exactly one panel drew";
 *  `mh-tab-panel-<id>` cannot, because that names the tab the rail selected,
 *  not the component that rendered. */
const panelRoots = (h: string): string[] =>
  ["overview", "matches", "table", "stats", "teams", "info"].filter((id) =>
    h.includes(`data-testid="mh-${id}"`),
  );

// ------------------------------------------------------------ the documents

/** Every tab a W2 document can offer: matches, tables, leaders and teams all
 *  present, so `deriveHubTabs` emits all six. */
const docAll = hubDoc({
  matches: [m("l1", "live", "2026-09-05T10:00:00.000Z", "premier")],
  tables: [tableView("t8-s1-overall", "premier")],
  leaders: [board("premier", "runs", [leader("p1", "Arjun Mehta", null)])],
  teams: [team("e1", "Riverside Rovers", null, null)],
});

describe("CompetitionLanding — first paint", () => {
  it("renders only the tabs the document lists — no Stats tab without leaders (positive pair: Teams is there)", () => {
    const h = render(hubDoc({ leaders: [], teams: [team("e1", "A", null, null)] }));
    expect(h).not.toContain(`data-testid="mh-tab-stats"`);
    expect(h).toContain(`data-testid="mh-tab-teams"`);
    expect(h).toContain(`data-testid="mh-tab-panel-overview"`); // first tab is active at first paint
    expect(h).toContain(`data-testid="mh-root"`);
  });

  it("the rail is EXACTLY the document's tabs, in the document's order — a list, not a containment check", () => {
    // The brief's mandated mutant is "render every tab regardless of
    // `doc.tabs`", and a containment check cannot see it: a rail carrying all
    // six contains every id a three-tab document names. So the rail is read as
    // a LIST, on a document whose tab set is a strict subset.
    expect(railTabs(render(docAll))).toEqual([
      "overview",
      "matches",
      "table",
      "stats",
      "teams",
      "info",
    ]);
    const sparse = hubDoc({ teams: [team("e1", "A", null, null)] });
    expect(sparse.tabs).toEqual(["overview", "teams", "info"]); // what the document says
    expect(railTabs(render(sparse))).toEqual(["overview", "teams", "info"]); // what the rail drew
  });

  it("exactly ONE panel renders — the other five are absent, not hidden", () => {
    // The second half of the same mutant. `Tabs` (the division page's rail)
    // ships every panel and toggles `hidden`; this root renders one. A test
    // that only asserted the active panel's presence passes on a root that
    // renders all six.
    expect(panelRoots(render(docAll))).toEqual(["overview"]);
  });

  it("the panel is the APG container: role, both ids, and an UNCONDITIONAL tab stop", () => {
    const h = render(docAll);
    const panel = tagOf(h, "mh-tab-panel-overview");
    expect(panel).toContain(`role="tabpanel"`);
    expect(panel).toContain(`id="mh-tab-panel-overview"`);
    expect(panel).toContain(`aria-labelledby="mh-tab-overview"`);
    // `tabIndex={0}` UNCONDITIONALLY, copied from W1's own root with its
    // rationale intact (`match-centre.tsx:110-124`): the Info panel contains no
    // focusable element at all, so a keyboard user arrowing along the rail and
    // pressing Tab lands PAST the content the rail just selected. Which panels
    // hold a focusable child is document-dependent — a table's scroll region
    // exists only when there are rows — so a conditional would be a rule that
    // silently changed with the data.
    expect(panel).toContain(`tabindex="0"`);
    // And it is there on the Info panel too, which is the panel the rationale
    // is ABOUT. Asserting it only on Overview (which has links) would prove the
    // easy case.
    const infoOnly = hubDoc({});
    expect(infoOnly.tabs).toEqual(["overview", "info"]);
    expect(tagOf(render(infoOnly), "mh-tab-panel-overview")).toContain(`tabindex="0"`);
  });

  it("every tab LABEL comes from the dictionary — the one defect this surface has already shipped twice", () => {
    // Found by the mutation sweep: replacing the label lookup with a literal
    // survived the whole suite, because every assertion here read a TESTID and
    // testids are untranslated by design. That is precisely the defect
    // `tabs.test.tsx` was written for — the division rail's labels were
    // hardcoded English at the call site while the four keys had shipped in all
    // four locales and nothing rendered them.
    //
    // Spanish on purpose: English labels are indistinguishable from a literal.
    const h = renderToStaticMarkup(
      <CompetitionLanding initial={docAll} dict={es as Dict} locale="es" />,
    );
    for (const id of ["overview", "matches", "table", "stats", "teams", "info"] as const) {
      const label = es[`landing.tab.${id}`];
      expect(label, `landing.tab.${id} ships in es`).toBeTypeOf("string");
      expect(h, `landing.tab.${id}`).toContain(`>${label}</span>`);
    }
    // The rail's own accessible name too, and the positive pair: the English
    // words are nowhere in the Spanish render.
    expect(h).toContain(`aria-label="${es["landing.tabsLabel"]}"`);
    expect(h).not.toContain(`>${en["landing.tab.overview"]}</span>`);
  });

  it("the rail is named from the dictionary, and the panel is wired to the rail's button id", () => {
    const h = render(docAll);
    expect(h).toContain(`aria-label="${en["landing.tabsLabel"]}"`);
    // The button the panel names really exists and is the selected one — an
    // `aria-labelledby` pointing at nothing is worse than none.
    expect(tagOf(h, "mh-tab-overview")).toContain(`aria-selected="true"`);
    expect(tagOf(h, "mh-tab-matches")).toContain(`aria-selected="false"`);
  });

  it("the transport is on the root, and reads `poll` before any realtime channel is up", () => {
    // Anchored on `="`: React serialises an omitted prop as "$undefined", so a
    // bare `data-transport` probe passes in both states.
    expect(tagOf(render(docAll), "mh-root")).toContain(`data-transport="poll"`);
  });

  it("the slots reach the Overview panel, and the Info panel gets the share bar as well", () => {
    const slots = {
      descriptionSlot: <p>ABOUT THIS CUP</p>,
      sponsorsSlot: <p>SPONSOR BOARD</p>,
      shareSlot: <p>SHARE BAR</p>,
    };
    const overview = render(docAll, slots);
    expect(overview).toContain("ABOUT THIS CUP");
    expect(overview).toContain("SPONSOR BOARD");
    // The share bar belongs to Info — the Overview has no slot for it, and a
    // root that handed it to both would render it twice on one competition.
    expect(overview).not.toContain("SHARE BAR");
  });
});

describe("CompetitionLanding — the gallery slot", () => {
  it("a document CANNOT claim a gallery tab in W2 — the schema refuses it, which is what makes the filter a guard and not a branch", () => {
    // R6, stated as the test rather than only in a comment. `CompetitionHubDoc`
    // demands `tabs` equal `deriveHubTabs()`'s output exactly
    // (`competition-hub-schema.ts:242-265`), and `deriveHubTabs` never emits
    // `gallery` — so no parseable document reaches the filter with one. The
    // filter exists for W4's document, which lifts the rule by DERIVING the
    // tab; until then this is dead code that is worth keeping and is not worth
    // pretending to exercise.
    const claimed = { ...docAll, tabs: [...docAll.tabs, "gallery"] };
    const parsed = CompetitionHubDoc.safeParse(claimed);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("tabs");
  });

  it("and if one ever arrives anyway, it is not in the rail and not a panel", () => {
    // The guard's own behaviour, driven with a document built past the schema
    // — the only way to reach it, and the shape W4 will produce legitimately.
    const rogue = { ...docAll, tabs: [...docAll.tabs, "gallery"] } as CompetitionHubDocT;
    const h = render(rogue);
    expect(railTabs(h)).toEqual(["overview", "matches", "table", "stats", "teams", "info"]);
    expect(h).not.toContain(`data-testid="mh-tab-gallery"`);
    expect(h).not.toContain(`data-testid="mh-tab-panel-gallery"`);
  });
});

describe("activeTab — which tab wins, and what happens when its data disappears", () => {
  // Extracted and unit-tested rather than left inline, for the reason Task 8's
  // review found: the deep-link arm is unreachable from every render in this
  // environment, so inline it would be a branch no test could enter and every
  // mutant on it would survive.
  const tabs: LandingTabId[] = ["overview", "matches", "info"];

  it("nothing chosen and no deep link → the document's FIRST tab", () => {
    expect(activeTab(tabs, null, null)).toBe("overview");
  });

  it("a deep link wins over the default, and a TAP wins over the deep link", () => {
    expect(activeTab(tabs, null, "matches")).toBe("matches");
    // Arrived on ?tab=matches, then tapped Info: no later re-render may drag
    // the spectator back to the tab they arrived on.
    expect(activeTab(tabs, "info", "matches")).toBe("info");
  });

  it("a chosen tab whose DATA DISAPPEARED falls back — the document changes under a live page", () => {
    // The flagship reconciliation defect of this surface, twice over. Task 8
    // shipped a filter chip that left the rail with nothing pressed and no
    // on-screen escape, and the trigger was not a crafted URL — it was an
    // ordinary poll, because `use-live-competition` swaps the WHOLE document
    // every tick. Here: a spectator on Stats when the last leader board empties
    // has a panel whose tab is gone from the rail.
    expect(activeTab(tabs, "stats" as LandingTabId, null)).toBe("overview");
    // And the deep link is still considered after the tap is discarded, rather
    // than being skipped straight to the default.
    expect(activeTab(tabs, "stats" as LandingTabId, "matches")).toBe("matches");
  });

  it("an out-of-domain or EMPTY ?tab= falls through to the default", () => {
    expect(activeTab(tabs, null, "nonsense")).toBe("overview");
    // `URLSearchParams.get` returns "" for a bare `?tab=`, which is no tab's
    // id — the membership test is what folds it away, and a `?? default`
    // written against null would have kept it.
    expect(activeTab(tabs, null, "")).toBe("overview");
    // `gallery` is a real member of the tab union and is filtered out of
    // `tabs`, so a deep link naming it is out-of-domain HERE even though it
    // type-checks.
    expect(activeTab(tabs, null, "gallery")).toBe("overview");
  });

  it("panelFor has an arm for every renderable tab, and THROWS for anything else", () => {
    // The second `never` guard in this file, and the sweep is why it has a
    // test: replacing the default with `return null` survived everything,
    // because no render can reach it — which is the guard's whole point and
    // also meant it had no witness. A lookup table would have returned
    // `undefined` here and drawn an EMPTY panel under a tab the rail was
    // pointing at, silently.
    // Each arm is pinned to the COMPONENT it must render, not merely to
    // "something non-null". The sweep found that too: rewiring the `info` arm
    // to return the Overview panel survived a presence-only check, and it
    // would have shipped a competition whose Info tab showed the live scores.
    // Same family as Task 9's champion and Task 10's headings — a mutant that
    // binds several controls to one source is invisible to any assertion that
    // does not name each one.
    // Every value is distinctive and compared by IDENTITY (`toBe`), so an arm
    // that fabricates one rather than forwarding it is visible. `now` is a real
    // instant and not 0 for exactly that reason: the sweep found `now={0}` on
    // the Matches arm surviving a type-only check, which would have printed
    // "Starts in 481 months" on every upcoming card.
    const args = {
      doc: docAll,
      dict,
      locale: "en" as const,
      now: Date.parse("2026-09-05T12:00:00.000Z"),
      sponsorsSlot: <p>SPONSOR BOARD</p>,
      descriptionSlot: <p>ABOUT THIS CUP</p>,
      shareSlot: <p>SHARE BAR</p>,
    };
    // Which props each arm owes. The lists differ, which is the reason this is
    // a switch and not a uniform `TAB_PANELS` table — and pinning them here is
    // what makes the difference a contract rather than an accident.
    const expected = [
      ["overview", OverviewTab, ["doc", "dict", "locale", "now", "sponsorsSlot", "descriptionSlot"]],
      ["matches", MatchesTab, ["doc", "dict", "locale", "now"]],
      ["table", TableTab, ["doc", "dict"]],
      ["stats", StatsTab, ["doc", "dict"]],
      ["teams", TeamsTab, ["doc", "dict"]],
      ["info", InfoTab, ["doc", "dict", "locale", "descriptionSlot", "shareSlot", "sponsorsSlot"]],
    ] as const;
    for (const [id, Component, props] of expected) {
      const el = panelFor(id, args);
      expect(isValidElement(el), id).toBe(true);
      expect((el as ReactElement).type, id).toBe(Component);
      const got = (el as ReactElement).props as Record<string, unknown>;
      for (const name of props) {
        expect(got[name], `${id}.${name}`).toBe(args[name]);
      }
    }
    // And the share bar reaches Info ONLY — the Overview has no slot for it.
    expect(
      ((panelFor("overview", args) as ReactElement).props as Record<string, unknown>).shareSlot,
    ).toBeUndefined();
    expect(() => panelFor("gallery" as LandingTabId, args)).toThrow(/gallery/);
  });

  it("an EMPTY tab list cannot crash the page — it opens on Overview", () => {
    // Unreachable through a parsed document (`deriveHubTabs` always emits
    // `overview` and `info`, and `tabs` is `.min(1)`), so this is a crash guard
    // for a hand-built or future document — the `["gallery"]` case, which
    // filters to nothing. `tabs[0]!` would be `undefined` and every consumer of
    // `active` would then read a panel id of "undefined".
    expect(activeTab([], null, null)).toBe("overview");
    expect(activeTab([], "matches", "info")).toBe("overview");
  });
});

// ----------------------------------------------------------- the live island

/** Expand the ACTIVE panel one level, so a test can read what the panel drew
 *  rather than only which element was handed which props. Safe for `OverviewTab`
 *  specifically because it is hookless — the same thing `create-org-form`'s
 *  `expandRows` does for `BillRow`. `walk` never CALLS a child component, so
 *  the `StandingsTableView` elements inside stay unexpanded and their `useState`
 *  is never reached. */
function expandOverview(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  for (const el of walk(node)) {
    out.push(el);
    if (el.type === OverviewTab) {
      out.push(...walk(OverviewTab(propsOf(el) as never)));
    }
  }
  return out;
}

/** The testids of the cards in the Overview's Live-now rail, in render order. */
const liveCards = (tree: ReactElement[]): string[] =>
  tree
    .map((el) => String(propsOf(el)["data-testid"] ?? ""))
    .filter((id) => id.startsWith("mh-live-now-card-"))
    .map((id) => id.slice("mh-live-now-card-".length));

const ONE_LIVE = hubDoc({
  realtime: false,
  matches: [m("l1", "live", "2026-09-05T10:00:00.000Z", "premier")],
});
const TWO_LIVE = hubDoc({
  realtime: false,
  matches: [
    m("l1", "live", "2026-09-05T10:00:00.000Z", "premier"),
    m("l2", "live", "2026-09-05T10:30:00.000Z", "premier"),
  ],
});

describe("CompetitionLanding — a poll re-renders the ACTIVE tab in place", () => {
  let replaceState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://seazn.club/shared/riverside/autumn-cup", search: "" },
      history: { replaceState },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    rt.reset();
  });

  /** The transport the root advertised, off the live tree. */
  const transportOf = (tree: ReactElement[]): unknown =>
    propsOf(tree.find((el) => propsOf(el)["data-testid"] === "mh-root")!)["data-transport"];

  const mount = (initial: CompetitionHubDocT) =>
    renderIsland(
      CompetitionLanding,
      { initial, dict, locale: "en" as const },
      expandOverview,
    );

  it("a new live match appears in the Live-now rail with no navigation at all", async () => {
    vi.mocked(fetchCompetitionHub).mockResolvedValue(TWO_LIVE);
    const island = mount(ONE_LIVE);
    expect(liveCards(island.tree())).toEqual(["l1"]); // positive pair: before the tick

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);

    expect(fetchCompetitionHub).toHaveBeenCalledWith("riverside", "autumn-cup");
    expect(liveCards(island.tree())).toEqual(["l1", "l2"]);
    // R10: in-place update, never a navigation. The poll must not touch the
    // URL — only a TAP does, and this test never taps.
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("the poll's document decides the RAIL too — a tab that gains data appears without a reload", async () => {
    // The whole document is swapped on every tick, so the tab set is derived
    // fresh. A root that captured `doc.tabs` at mount would leave a competition
    // that published its first standings table with no way to reach it until
    // the spectator reloaded.
    const withTable = hubDoc({
      realtime: false,
      matches: ONE_LIVE.matches,
      tables: [tableView("t8-s1-overall", "premier")],
    });
    vi.mocked(fetchCompetitionHub).mockResolvedValue(withTable);
    const island = mount(ONE_LIVE);
    const railIds = () =>
      island
        .tree()
        .filter((el) => el.type !== OverviewTab)
        .flatMap((el) => {
          const tabs = propsOf(el)["tabs"];
          return Array.isArray(tabs) ? tabs.map((x) => (x as { id: string }).id) : [];
        });
    expect(railIds()).toEqual(["overview", "matches", "info"]);

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(railIds()).toEqual(["overview", "matches", "table", "info"]);
  });

  it("a TAP moves the tab and writes it back to the URL with replaceState, never push", async () => {
    vi.mocked(fetchCompetitionHub).mockResolvedValue(ONE_LIVE);
    const island = mount(ONE_LIVE);
    const rail = island.tree().find((el) => Array.isArray(propsOf(el)["tabs"]));
    expect(rail, "the tab rail").toBeDefined();
    const onChange = propsOf(rail!)["onChange"] as (id: string) => void;

    onChange("matches");

    // The panel moved, and the Overview is gone rather than hidden.
    expect(liveCards(island.tree())).toEqual([]);
    const active = island.tree().find((el) => String(propsOf(el)["role"]) === "tabpanel");
    expect(propsOf(active!)["data-testid"]).toBe("mh-tab-panel-matches");
    // `replaceState`, not `pushState`: a tab is not a page, and stacking
    // history entries would make Back walk the tab bar instead of leaving the
    // competition.
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(String(replaceState.mock.calls[0]![2])).toContain("tab=matches");
  });

  it("the DOCUMENT's own realtime flag is what decides whether the hub subscribes", async () => {
    // Found by the mutation sweep: hardcoding `realtime: true` at the
    // `useLiveCompetition` call survived everything, because with no Supabase
    // URL in the environment the realtime effect returns early and the two
    // states are indistinguishable. That is the inert-seam shape AGENTS.md
    // opens with — a flag the document carries, threaded nowhere, with a green
    // suite. So the environment is given a URL here and the two arms are
    // driven against each other.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.mocked(fetchCompetitionHub).mockResolvedValue(ONE_LIVE);

    const off = mount(ONE_LIVE); // realtime: false on the document
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.names).toEqual([]);
    expect(transportOf(off.tree())).toBe("poll");

    rt.reset();
    const on = mount(hubDoc({ realtime: true, matches: ONE_LIVE.matches }));
    await vi.advanceTimersByTimeAsync(0);
    // One channel PER DIVISION with a live match, named from the document —
    // not "a channel was opened".
    expect(rt.names).toEqual(["division:d-premier"]);
    expect(transportOf(on.tree())).toBe("realtime");
  });

  it("a poll that REMOVES the chosen tab's data moves the spectator, rather than stranding them", async () => {
    // The live half of the `activeTab` unit test above, and the reason the
    // choice is reconciled on every render instead of synced in an effect: the
    // spectator taps Table, the competition's last standings table is withdrawn,
    // and the next tick hands down a document with no Table tab. A root that
    // held the choice would render `mh-tab-panel-table` above a rail with no
    // Table button on it.
    const withTable = hubDoc({
      realtime: false,
      matches: ONE_LIVE.matches,
      tables: [tableView("t8-s1-overall", "premier")],
    });
    vi.mocked(fetchCompetitionHub).mockResolvedValue(ONE_LIVE);
    const island = mount(withTable);
    const rail = island.tree().find((el) => Array.isArray(propsOf(el)["tabs"]));
    (propsOf(rail!)["onChange"] as (id: string) => void)("table");

    const activeId = () =>
      propsOf(island.tree().find((el) => String(propsOf(el)["role"]) === "tabpanel")!)[
        "data-testid"
      ];
    expect(activeId()).toBe("mh-tab-panel-table"); // positive pair: the tap took

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(activeId()).toBe("mh-tab-panel-overview");
  });
});
