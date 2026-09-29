// The organiser page objects (W1c Task 5): their PURE parts, and the product
// facts each one clicks by. The clicking itself is walked live in Task 8; what
// is proven here is everything a browser is not needed to prove — the routes,
// the fold gate (Review Focus 3), the standings reader's refusals, the labels a
// case's pictures are filed under, the two-answer wait the builder makes, and
// every composed id a page object builds from a stage, a fixture or a tab.
//
// Expected values come from the product's own TEXT (routes.ts, the components,
// the dictionaries), read here — never from the page objects under test.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FLOOR_MS, SLACK_MS, TAP_PACE_MS } from "../lib/browser/budget.ts";
import { NoProductResponse } from "../lib/browser/respond.ts";
import { COMPETITION_ENDS_ON } from "../lib/browser/pages/competition.ts";
import { FORFEIT_SIDE_TESTID_PREFIX, FORFEIT_TESTID, PROMPT_REASON_TESTID, PROMPT_SUBMIT_TESTID, TAP_WAIT_TIMEOUT_MS } from "../../bench/lib/drivers/scorer.ts";
import { LandedElsewhere, ScreenNeverShowed, UnsafeSelectorValue, actBudget, attrEquals, awaitScreen, boundActions, entrantNameMatcher, exactPath, navBudget, selectorValue, shotLabel, stepBudget, visit } from "../lib/browser/pages/ctx.ts";
import { BUILDER_TABS, BuiltOtherThanAsked, StagesForAnotherDivision, assertBuiltAsAsked, awaitDivisionAndStages } from "../lib/browser/pages/division-builder.ts";
import { EntrantNotAsTyped, assertEntrantAsTyped } from "../lib/browser/pages/entrants.ts";
import { ForfeitNeedsBothSides, eventsPath, forfeitBudgets, forfeitSteps, postForfeit } from "../lib/browser/pages/fixture-console.ts";
import { START_UNACKNOWLEDGED, isUnacknowledgedStart } from "../lib/browser/pages/launch.ts";
import { ORGANISER_TABS, PUBLIC_TABS, paths } from "../lib/browser/pages/paths.ts";
import { PUBLIC_STANDINGS_TAB, championFrom, publicPanelSelector, publicTabSelector } from "../lib/browser/pages/public-division.ts";
import { ALL_FILTER, fixtureLinkSelector, fixtureRowSelector } from "../lib/browser/pages/run-sheet.ts";
import { GeneratedWithoutFixtureNumbers, newestCreatedFixtureNo, openFoldIfFolded, railSheetSelector, railTriggerSelector } from "../lib/browser/pages/stage-rail.ts";
import { UnreadableStandingsRow, standingsCellsOf, tablesFromCells } from "../lib/browser/pages/standings.ts";
import { DATA, NAME } from "../lib/browser/selectors.ts";
import { RefusedCall } from "../lib/driver/types.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const V2 = "apps/web/src/components/v2";
const ORG_DIV_PAGE = "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx";
const PUBLIC_DIV_PAGE = "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx";

/** The template literal routes.ts returns for `name`, filled with `vars` — the
 *  product's own route, never a string typed here. `nth` picks among several
 *  in one builder (division's tab and tab-less arms). */
function productRoute(name: string, vars: Record<string, string>, nth = 0): string {
  const body = new RegExp(`\\n  ${name}: \\([^)]*\\) =>([^\\n]*(?:\\n    [^\\n]*)*)`).exec(src("apps/web/src/lib/routes.ts"))?.[1];
  expect(body, `routes.ts has no ${name} builder`).toBeDefined();
  const tpl = [...body!.matchAll(/`([^`]*)`/g)].map((m) => m[1]!)[nth];
  expect(tpl, `routes.ts ${name} has no template literal #${nth}`).toBeDefined();
  return tpl!.replace(/\$\{(\w+)\}/g, (_, v: string) => {
    expect(vars[v], `routes.ts ${name} interpolates \${${v}}`).toBeDefined();
    return vars[v]!;
  });
}
/** A `const NAME = ["a", "b"] as const;` literal's members, read from the product. */
function literalList(file: string, decl: RegExp): string[] {
  const m = decl.exec(src(file));
  expect(m, `${file} no longer declares ${decl.source}`).not.toBeNull();
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("paths: the routes the product serves", () => {
  it("paths: the organiser and public routes the product serves (text-pinned to the app router folders)", () => {
    expect(paths.division("o", "c", "d", "fixtures")).toBe("/o/o/c/c/d/d?tab=fixtures");
    expect(paths.fixture("o", "c", "d", 7)).toBe("/o/o/c/c/d/d/f/7");
    expect(paths.publicDivision("o", "c", "d", "standings")).toBe("/shared/o/c/d?tab=standings");
    for (const dir of ["apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]", "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]"]) expect(existsSync(join(REPO, dir))).toBe(true);
  });

  it("every builder is routes.ts's own template, in both of division's arms; every folder exists", () => {
    const v = { org: "o", comp: "c", div: "d", no: "7", tab: "entrants" };
    const pairs: [string, string][] = [
      [paths.competitionNew("o"), productRoute("competitionNew", v)],
      [paths.competition("o", "c"), productRoute("competition", v)],
      [paths.divisionNew("o", "c"), productRoute("divisionNew", v)],
      [paths.division("o", "c", "d", "entrants"), productRoute("division", v, 0)],
      [paths.division("o", "c", "d"), productRoute("division", v, 1)],
      [paths.fixture("o", "c", "d", 7), productRoute("fixture", v)],
    ];
    for (const [ours, product] of pairs) expect(ours).toBe(product);
    expect(pairs.length).toBe(6);
    // The public division page is routes.shared's join, with the tab the page's Tabs read on the client.
    expect(src("apps/web/src/lib/routes.ts")).toContain('["/shared", orgSlug, compSlug, divSlug].filter(Boolean).join("/")');
    expect(paths.publicDivision("o", "c", "d")).toBe("/shared/o/c/d");
    expect(src("apps/web/src/components/public-site/use-tab-param.ts")).toContain('useSearchParam("tab")');
    const dirs = ["o/[orgSlug]/c/new", "o/[orgSlug]/c/[compSlug]", "o/[orgSlug]/c/[compSlug]/d/new", "o/[orgSlug]/c/[compSlug]/d/[divSlug]", "o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]"];
    for (const d of dirs) expect(existsSync(join(REPO, "apps/web/src/app", d, "page.tsx")), d).toBe(true);
    expect(dirs.length).toBe(5);
  });

  it("the tabs a page object asks for are the tabs each page honours (the organiser's TABS, the public page's ids)", () => {
    const organiser = literalList(ORG_DIV_PAGE, /const TABS = \[([^\]]*)\] as const;/);
    const publicIds = literalList(PUBLIC_DIV_PAGE, /ids=\{\[([^\]]*)\]\}/);
    expect(organiser.length).toBeGreaterThan(0);
    expect(publicIds.length).toBeGreaterThan(0);
    expect(ORGANISER_TABS.length).toBeGreaterThan(0);
    for (const t of ORGANISER_TABS) expect(organiser, t).toContain(t);
    for (const t of PUBLIC_TABS) expect(publicIds, t).toContain(t);
    expect(PUBLIC_TABS).toContain(PUBLIC_STANDINGS_TAB);
  });
});

// Review Focus 3: the rail folds below 768 behind stage-rail-trigger, and a page
// object written at 1280 fails at 320 with a timeout that reads as a product
// defect. The gate keys on the trigger's own visibility — at 768/834 it is
// md:hidden, and clicking a hidden control throws (AGENTS class 22).
describe("the stage rail's fold", () => {
  type Seen = string[];
  const fakePage = (width = 1280) => ({ viewportSize: () => ({ width, height: 900 }) });
  function fakeLocator(o: { visible?: boolean; attached?: boolean; onClick?: () => void }, seen: Seen = []) {
    return {
      isVisible: async () => { seen.push("isVisible"); return o.visible ?? false; },
      click: async () => { seen.push("click"); o.onClick?.(); },
      waitFor: async (w?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }) => {
        seen.push(`waitFor:${w?.state}:${w?.timeout}`);
        if (!(o.attached ?? false)) { const e = new Error("locator.waitFor: Timeout exceeded"); e.name = "TimeoutError"; throw e; }
      },
    };
  }

  it("fold gate keys on trigger visibility, never width: visible → open, hidden → leave", async () => {
    const opened: string[] = [];
    expect(await openFoldIfFolded(fakePage(), fakeLocator({ visible: true, onClick: () => opened.push("t") }), fakeLocator({ attached: true }), 1000)).toBe("opened");
    expect(await openFoldIfFolded(fakePage(), fakeLocator({ visible: false, onClick: () => opened.push("x") }), fakeLocator({ attached: true }), 1000)).toBe("unfolded");
    expect(opened).toEqual(["t"]);
  });

  it("the width is never read: a visible trigger at 1280 still opens, a hidden one at 320 is never clicked", async () => {
    const clicks: string[] = [];
    expect(await openFoldIfFolded(fakePage(1280), fakeLocator({ visible: true, onClick: () => clicks.push("desktop") }), fakeLocator({ attached: true }), 1000)).toBe("opened");
    expect(await openFoldIfFolded(fakePage(320), fakeLocator({ visible: false, onClick: () => clicks.push("phone") }), fakeLocator({ attached: true }), 1000)).toBe("unfolded");
    expect(clicks).toEqual(["desktop"]);
  });

  it("opening waits for the sheet ATTACHED within the budget, never visible (class 22); a hidden trigger waits for nothing", async () => {
    const sheet: Seen = [];
    await openFoldIfFolded(fakePage(), fakeLocator({ visible: true }), fakeLocator({ attached: true }, sheet), 4321);
    expect(sheet).toEqual(["isVisible", "waitFor:attached:4321"]);
    const untouched: Seen = [];
    await openFoldIfFolded(fakePage(), fakeLocator({ visible: false }), fakeLocator({ attached: true }, untouched), 4321);
    expect(untouched).toEqual([]);
  });

  it("a second call on a sheet already open does not click again (a second click on the trigger closes it)", async () => {
    const clicks: string[] = [];
    expect(await openFoldIfFolded(fakePage(320), fakeLocator({ visible: true, onClick: () => clicks.push("again") }), fakeLocator({ visible: true, attached: true }), 1000)).toBe("opened");
    expect(clicks).toEqual([]);
  });

  it("a sheet that never attaches after the click is a TimeoutError, not a silent 'opened'", async () => {
    await expect(openFoldIfFolded(fakePage(), fakeLocator({ visible: true }), fakeLocator({ attached: false }), 1000)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("the rail's sheet and trigger are the ids stage-rail.tsx composes from the stage id", () => {
    const rail = src(`${V2}/desk/stage-rail.tsx`);
    const prefix = /const sheetId = `([\w-]+)\$\{stage\.id\}`;/.exec(rail)?.[1];
    expect(prefix).toBeDefined();
    expect(rail).toContain("id={sheetId}");
    expect(rail).toContain("aria-controls={sheetId}");
    expect(rail).toContain('data-testid="stage-rail-trigger"');
    expect(railSheetSelector("s-1")).toBe(`[id="${prefix}s-1"]`);
    expect(railTriggerSelector("s-1")).toBe(`[data-testid="stage-rail-trigger"][aria-controls="${prefix}s-1"]`);
  });
});

// generateUi proves the screen by waiting on the newest run-sheet row. Every
// fixture row carries a number: fixtures.fixture_no is NOT NULL, numbered by a
// BEFORE INSERT trigger (db/migration/deltas/V263__routing_slugs.sql:37-53).
describe("generate: the run-sheet row that proves the screen", () => {
  const fx = (fixture_no: number | null) => ({ fixture_no });

  it("empty case first: nothing created is nothing new to draw, whatever already exists", () => {
    expect(newestCreatedFixtureNo({ created: 0, fixtures: [] })).toBeNull();
    // A second Generate on a drawn stage answers created 0 with the existing rows.
    expect(newestCreatedFixtureNo({ created: 0, fixtures: [fx(1), fx(2)] })).toBeNull();
  });

  it("rows created: the newest is the highest fixture number, in any order", () => {
    expect(newestCreatedFixtureNo({ created: 3, fixtures: [fx(3), fx(7), fx(5)] })).toBe(7);
    expect(newestCreatedFixtureNo({ created: 1, fixtures: [fx(1)] })).toBe(1);
  });

  it("rows created with no fixture number among them is refused by name, never a silently skipped screen check", () => {
    const cases = [{ created: 2, fixtures: [] }, { created: 1, fixtures: [fx(null)] }, { created: 2, fixtures: [fx(null), fx(0)] }];
    for (const out of cases) expect(() => newestCreatedFixtureNo(out), JSON.stringify(out)).toThrow(GeneratedWithoutFixtureNumbers);
    expect(cases.length).toBe(3);
    expect(() => newestCreatedFixtureNo(cases[0]!)).toThrow(/2 fixtures/);
  });
});

// The rank cell's text, as standings-table.tsx renders it: a plain rank chip;
// a tied row's chip, its "*" and — because the popover panel is ALWAYS in the
// markup, `hidden` while closed (standings-popover.tsx) — the tie note after
// it; a qualification row's chip and marker. textContent reads all of it.
describe("tablesFromCells: the standings a page shows, as it shows them", () => {
  it("tablesFromCells: empty case first, then rank order kept as the page shows it (never re-sorted)", () => {
    expect(tablesFromCells([])).toEqual({ rows: [] });
    expect(tablesFromCells([["2", "B"], ["1", "A"]]).rows).toEqual([{ rank: 2, name: "B" }, { rank: 1, name: "A" }]);
  });

  it("the rank is the cell's leading number, whatever the chip carries after it", () => {
    const cells = [["1", "Ann"], ["2*Tied with Bea on head-to-head", "Cal"], ["3 Q", "Dee"], ["  12  ", "  Eve  "]];
    expect(tablesFromCells(cells).rows).toEqual([{ rank: 1, name: "Ann" }, { rank: 2, name: "Cal" }, { rank: 3, name: "Dee" }, { rank: 12, name: "Eve" }]);
    // A second read of the same cells answers the same (pure).
    expect(tablesFromCells(cells)).toEqual(tablesFromCells(cells));
  });

  it("a row it cannot read is refused by name and position, never guessed", () => {
    const unreadable: (readonly string[])[][] = [
      [["", "Ann"]],         // rankChip(undefined) renders an empty chip
      [["—", "Ann"]],
      [["1", ""]],           // no name
      [["1", "   "]],
      [["1"]],               // a row with no name cell at all
    ];
    for (const cells of unreadable) expect(() => tablesFromCells(cells), JSON.stringify(cells)).toThrow(UnreadableStandingsRow);
    expect(() => tablesFromCells([["1", "A"], ["x", "B"]])).toThrow(/row 2/);
    expect(unreadable.length).toBe(5);
  });
});

// A DOM small enough to fake: element children, attributes, text, and the one
// attribute-selector shape the extractors pass ([a] or [a="v"]). No DOM
// package ships in this repo, and apps/web vitest is node-only.
interface FakeEl { tagName: string; children: FakeEl[]; textContent: string | null; nextElementSibling: FakeEl | null; getAttribute(n: string): string | null; matches(s: string): boolean; querySelector(s: string): FakeEl | null }
function el(tag: string, attrs: Record<string, string> = {}, kids: (FakeEl | string)[] = []): FakeEl {
  const children = kids.filter((k): k is FakeEl => typeof k !== "string");
  const node: FakeEl = {
    tagName: tag.toUpperCase(), children, nextElementSibling: null,
    get textContent() { return kids.map((k) => (typeof k === "string" ? k : k.textContent ?? "")).join(""); },
    getAttribute: (n) => attrs[n] ?? null,
    matches(s) {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
      if (m === null) throw new Error(`fake DOM: unsupported selector ${s}`);
      return m[2] === undefined ? m[1]! in attrs : attrs[m[1]!] === m[2];
    },
    querySelector(s) {
      for (const c of children) { if (c.matches(s)) return c; const deep = c.querySelector(s); if (deep !== null) return deep; }
      return null;
    },
  };
  children.forEach((c, i) => { c.nextElementSibling = children[i + 1] ?? null; });
  return node;
}
const SEL = { rowHeader: DATA.standingsRowHeader.selector, name: DATA.standingsRowName.selector };

describe("reading the page's own tables and banner", () => {
  // standings-table.tsx: <table><caption/><thead/><tbody> rows of td(rank) +
  // th[scope=row](span[title=name]) + metric tds; the qualification cut line
  // is a <tr> with one td and no th.
  const row = (rank: (FakeEl | string)[], name: string, logo = false) => el("tr", {}, [
    el("td", {}, rank),
    el("th", { scope: "row" }, [el("span", {}, [...(logo ? [el("img", { alt: "" })] : []), el("span", { title: name }, [name.slice(0, 5)]), el("span", { title: "Withdrawn" }, ["W"])])]),
    el("td", {}, ["9"]),
  ]);
  const table = (...rows: FakeEl[]) => el("table", {}, [el("caption", {}, ["Pool A"]), el("thead", {}, [el("tr", {}, [el("th", { scope: "col", title: "Points" }, ["Pts"])])]), el("tbody", {}, rows)]);

  it("empty case first: no tables reads as none, a table with no rows as one empty table", () => {
    expect(standingsCellsOf([], SEL)).toEqual([]);
    expect(standingsCellsOf([table()], SEL)).toEqual([[]]);
  });

  it("each row is its rank cell's text and its row header's FULL name (title), in page order; the cut line and the header row are not rows", () => {
    const tie = el("button", {}, [el("span", {}, ["2"]), el("span", { "aria-hidden": "true" }, ["*"])]);
    const cells = standingsCellsOf([
      table(row(["1"], "Matrix Player 3", true), row([tie, el("span", { role: "note", hidden: "" }, ["Tied on points"])], "Matrix Player 1"), el("tr", { "data-testid": "qual-cut" }, [el("td", { colspan: "4" }, ["Qualify"])]), row(["3"], "Matrix Player 2")),
      table(row(["1"], "Matrix Player 4")),
    ], SEL);
    expect(cells).toEqual([[["1", "Matrix Player 3"], ["2*Tied on points", "Matrix Player 1"], ["3", "Matrix Player 2"]], [["1", "Matrix Player 4"]]]);
    expect(cells.flat().length).toBe(4);
    // The row header's selectors are the product's (standings-table.tsx), pinned by selectors.test.ts.
    expect(SEL).toEqual({ rowHeader: '[scope="row"]', name: "[title]" });
  });

  it("a row whose header carries no title reads an empty name, which tablesFromCells then refuses", () => {
    const bare = el("tr", {}, [el("td", {}, ["1"]), el("th", { scope: "row" }, ["Ann"])]);
    const cells = standingsCellsOf([table(bare)], SEL);
    expect(cells).toEqual([[["1", ""]]]);
    expect(() => tablesFromCells(cells[0]!)).toThrow(UnreadableStandingsRow);
  });

  it("only a TBODY row is a row: a thead or tfoot row that carries a row header with a title is not read", () => {
    const header = (name: string) => el("tr", {}, [el("th", { scope: "row" }, [el("span", { title: name }, [name])])]);
    const t = el("table", {}, [el("thead", {}, [header("Head row")]), el("tbody", {}, [row(["1"], "Matrix Player 1")]), el("tfoot", {}, [el("tr", {}, [el("td", {}, ["—"]), el("th", { scope: "row" }, [el("span", { title: "Totals" }, ["Totals"])])])])]);
    const cells = standingsCellsOf([t], SEL);
    expect(cells).toEqual([[["1", "Matrix Player 1"]]]);
    // Three sections each carry a row header; only the tbody's is read.
    expect(t.children.filter((s) => s.querySelector(SEL.rowHeader) !== null).length).toBe(3);
  });

  it("the row header must be a TH: a tbody cell that says scope=row but is a TD is not the header, so its row is not read", () => {
    const tdHeader = el("tr", {}, [el("td", { scope: "row" }, [el("span", { title: "Ann" }, ["Ann"])]), el("td", {}, ["9"])]);
    const cells = standingsCellsOf([table(row(["1"], "Matrix Player 1"), tdHeader)], SEL);
    expect(cells).toEqual([[["1", "Matrix Player 1"]]]);
    expect(tdHeader.children[0]!.matches(SEL.rowHeader)).toBe(true);
  });

  it("the banner's label is found through the whitespace JSX puts around it", () => {
    const label = NAME.championLabel.text;
    const padded = el("div", {}, [el("p", {}, [`  ${label} \n`]), el("p", {}, ["Matrix Player 4"])]);
    expect(championFrom(padded.children, label)).toBe("Matrix Player 4");
  });

  it("the champion is the text of the paragraph after the one that says the banner's label; no banner is null", () => {
    const label = NAME.championLabel.text;
    const banner = el("div", {}, [el("p", {}, [label]), el("p", {}, ["  Matrix Player 2 "])]);
    const ps = [el("p", {}, ["Intro"]), ...banner.children];
    expect(championFrom(ps, label)).toBe("Matrix Player 2");
    expect(championFrom([el("p", {}, ["Intro"])], label)).toBeNull();
    expect(championFrom([], label)).toBeNull();
    // The label paragraph with nothing after it is no champion, not a crash.
    expect(championFrom([el("div", {}, [el("p", {}, [label])]).children[0]!], label)).toBeNull();
    // Only an EXACT label paragraph counts ("Champions League" is not the banner).
    expect(championFrom(el("div", {}, [el("p", {}, [`${label}s League`]), el("p", {}, ["X"])]).children, label)).toBeNull();
  });
});

describe("the shared steps", () => {
  it("visit lands where it was sent: onboarding is completed and the page revisited; landing anywhere else is refused by name", async () => {
    const base = "http://localhost:3999";
    const gotos: string[] = [];
    const posts: string[] = [];
    const fake = (landings: string[]) => {
      let current = "about:blank";
      return {
        goto: async (url: string, o: { timeout: number }) => { gotos.push(`${url} @${o.timeout}`); current = landings.shift() ?? url; return null; },
        url: () => current,
        request: { post: async (u: string) => { posts.push(u); return { ok: () => true, status: () => 200 }; } },
      };
    };
    const t = navBudget({ holdMs: 3000 });
    await visit({ base, holdMs: 3000, page: fake([`${base}/onboarding`]) }, "/o/org/c/new");
    expect(gotos).toEqual([`${base}/o/org/c/new @${t}`, `${base}/o/org/c/new @${t}`]);
    expect(posts).toEqual(["/api/onboarding/complete", "/api/tour"]);
    // A second visit that lands at once: one goto, no onboarding.
    gotos.length = 0;
    posts.length = 0;
    await visit({ base, holdMs: 3000, page: fake([]) }, "/o/org/c/c1/d/d1?tab=entrants");
    expect(gotos).toEqual([`${base}/o/org/c/c1/d/d1?tab=entrants @${t}`]);
    expect(posts).toEqual([]);
    await expect(visit({ base, holdMs: 3000, page: fake([`${base}/sign-in`]) }, "/o/org/c/new")).rejects.toThrow(LandedElsewhere);
    // Onboarding again on the revisit is refused, never looped.
    await expect(visit({ base, holdMs: 3000, page: fake([`${base}/onboarding`, `${base}/onboarding`]) }, "/o/org/c/new")).rejects.toThrow(/\/onboarding/);
  });

  it("the page budgets are budgetMs in the product's constants: a navigation is the floor; each request an action waits on adds a tap and its slack", () => {
    expect(navBudget({ holdMs: 3000 })).toBe(FLOOR_MS);
    expect(actBudget({ holdMs: 3000 }, 1)).toBe(FLOOR_MS + TAP_PACE_MS + SLACK_MS);
    expect(actBudget({ holdMs: 3000 }, 3) - actBudget({ holdMs: 3000 }, 2)).toBe(TAP_PACE_MS + SLACK_MS);
  });

  // Controller ruling F (T5 N1): execute.ts bounds each step's waitFor by the
  // caller's waitMs but taps with a bare click()/fill(), which Playwright
  // bounds by the PAGE's default. That default must be one step's own bound,
  // in the constants, or "every step's worst case" is a claim about 30 s.
  it("the page's default action timeout is one step's bound in the constants, whatever the hold, and boundActions sets exactly that", () => {
    const want = Math.max(FLOOR_MS, TAP_PACE_MS + SLACK_MS);
    let checked = 0;
    for (const holdMs of [500, 3000, 10_000, 60_000]) {
      const set: number[] = [];
      const ms = boundActions({ setDefaultTimeout: (t: number) => { set.push(t); } }, { holdMs });
      expect(ms, `holdMs ${holdMs}`).toBe(want);
      expect(set, `holdMs ${holdMs}`).toEqual([want]);
      expect(stepBudget({ holdMs })).toBe(want);
      // One authority: the forfeit's per-step bound is this same number.
      expect(forfeitBudgets({ holdMs }, 1).stepMs).toBe(want);
      checked++;
    }
    expect(checked).toBe(4);
    // A hold that is no duration is refused before any page is touched.
    const set: number[] = [];
    expect(() => boundActions({ setDefaultTimeout: (t: number) => { set.push(t); } }, { holdMs: Number.NaN })).toThrow(/holdMs/);
    expect(set).toEqual([]);
  });

  it("a value composed into a selector is refused by name when it could break out of its quotes", () => {
    expect(selectorValue("stage id", "3f2a9c1e-77b0-4c1d-9d1e-0a0b0c0d0e0f")).toBe("3f2a9c1e-77b0-4c1d-9d1e-0a0b0c0d0e0f");
    const bad = ['a"b', "a\\b", "a]b", "", "a b"];
    for (const v of bad) expect(() => selectorValue("stage id", v), v).toThrow(UnsafeSelectorValue);
    expect(bad.length).toBe(5);
    expect(() => railSheetSelector('x"]')).toThrow(UnsafeSelectorValue);
    // A run-sheet row is its fixture number, a positive integer, in the product's own li[data-fixture-no].
    expect(fixtureRowSelector(7)).toBe(DATA.fixtureRow.selector.replace("]", '="7"]'));
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => fixtureRowSelector(n), String(n)).toThrow(UnsafeSelectorValue);
  });

  it("a fixture's console link is an href selector over routes.fixture, each slug refused by name when it could break out of its quotes", () => {
    expect(fixtureLinkSelector("matrix-org", "cup-2026", "open_a", 7)).toBe(`[href="${paths.fixture("matrix-org", "cup-2026", "open_a", 7)}"]`);
    const unsafe = [["a\"b", "c", "d"], ["a", "c]d", "d"], ["a", "c", "d\"] , a[href"]] as const;
    for (const [org, comp, div] of unsafe) expect(() => fixtureLinkSelector(org, comp, div, 7), `${org} ${comp} ${div}`).toThrow(UnsafeSelectorValue);
    expect(unsafe.length).toBe(3);
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => fixtureLinkSelector("o", "c", "d", n), String(n)).toThrow(UnsafeSelectorValue);
  });

  it("an entrant's row is found by its WHOLE name: Player 1 never matches Player 10", () => {
    const m = entrantNameMatcher("Matrix Player 1");
    // entrants-panel.tsx renders the name, then a ▸/▾ span, inside the disclosure button.
    expect(m.test("Matrix Player 1▸")).toBe(true);
    expect(m.test("  Matrix Player 1 ▾")).toBe(true);
    expect(m.test("Matrix Player 10▸")).toBe(false);
    expect(m.test("Matrix Player 1b▸")).toBe(false);
    expect(m.test("A Matrix Player 1▸")).toBe(false);
    // Regex characters in a name are literal.
    expect(entrantNameMatcher("A & B (x)").test("A & B (x)▸")).toBe(true);
    expect(entrantNameMatcher("A.B").test("AxB▸")).toBe(false);
  });

  it("exactPath matches the whole pathname only, with regex characters literal", () => {
    expect(exactPath("/api/v1/entrants/e.1/withdraw").test("/api/v1/entrants/e.1/withdraw")).toBe(true);
    expect(exactPath("/api/v1/entrants/e.1/withdraw").test("/api/v1/entrants/ex1/withdraw")).toBe(false);
    expect(exactPath("/api/v1/entrants/e1/withdraw").test("/api/v1/entrants/e1/withdraw/x")).toBe(false);
  });

  it("shot labels: the first shot under a label keeps it, a repeat in the same case is numbered, another case starts over", () => {
    const a = {};
    const b = {};
    expect(shotLabel(a, "09-finalized")).toBe("09-finalized");
    expect(shotLabel(a, "09-finalized")).toBe("09-finalized-2");
    expect(shotLabel(a, "09-finalized")).toBe("09-finalized-3");
    expect(shotLabel(a, "05-generated")).toBe("05-generated");
    expect(shotLabel(b, "09-finalized")).toBe("09-finalized");
  });

  it("a screen wait that runs out is ScreenNeverShowed, naming what never showed; any other failure passes through", async () => {
    const timeout = () => { const e = new Error("page.waitForURL: Timeout 15000ms exceeded"); e.name = "TimeoutError"; return Promise.reject(e); };
    await expect(awaitScreen(timeout, "the division page", 15000)).rejects.toThrow(ScreenNeverShowed);
    await expect(awaitScreen(timeout, "the division page", 15000)).rejects.toThrow(/the division page.*15000 ms/);
    const closed = () => Promise.reject(new Error("Target page, context or browser has been closed"));
    await expect(awaitScreen(closed, "x", 1)).rejects.toThrow(/has been closed/);
    await expect(awaitScreen(closed, "x", 1)).rejects.not.toThrow(ScreenNeverShowed);
    await expect(awaitScreen(() => Promise.resolve(), "x", 1)).resolves.toBeUndefined();
  });
});

describe("the launch and the builder", () => {
  it("the start is retried through the gate on exactly the product's unacknowledged-warnings refusal", () => {
    // schedule-board.ts names the code; launch-actions.tsx opens the gate on it.
    const code = /export const PUBLISH_UNACKNOWLEDGED = "([A-Z_]+)";/.exec(src("apps/web/src/lib/schedule-board.ts"))?.[1];
    expect(code).toBeDefined();
    expect(START_UNACKNOWLEDGED).toBe(code);
    expect(src(`${V2}/launch-actions.tsx`)).toContain("onConfirm={() => void start(true)}");
    expect(isUnacknowledgedStart(new RefusedCall("POST", "/api/v1/divisions/d/start", 422, code!, "warnings"))).toBe(true);
    const blocking = /export const PUBLISH_BLOCKED = "([A-Z_]+)";/.exec(src("apps/web/src/lib/schedule-board.ts"))?.[1];
    expect(isUnacknowledgedStart(new RefusedCall("POST", "/api/v1/divisions/d/start", 422, blocking!, "blocked"))).toBe(false);
    expect(isUnacknowledgedStart(new RefusedCall("POST", "/api/v1/divisions/d/start", 422, null, null))).toBe(false);
    expect(isUnacknowledgedStart(new Error(code))).toBe(false);
  });

  it("the builder has BUILDER_TABS tabs, so the walk to Create is bounded by the product's own tab count", () => {
    const tabs = literalList(`${V2}/division-builder.tsx`, /const TAB_ORDER = \[([^\]]*)\] as const;/);
    expect(BUILDER_TABS).toBe(tabs.length);
  });

  it("a division stored as another sport or variant than the builder was set to is refused by name, never returned as built", () => {
    const asked = { sportKey: "badminton", variantKey: "bo3" };
    expect(() => assertBuiltAsAsked({ sport_key: "badminton", variant_key: "bo3" }, asked)).not.toThrow();
    // The builder's own default sport: a pick the page dropped reads exactly so.
    expect(() => assertBuiltAsAsked({ sport_key: "generic", variant_key: "bo3" }, asked)).toThrow(BuiltOtherThanAsked);
    expect(() => assertBuiltAsAsked({ sport_key: "badminton", variant_key: "bo1" }, asked)).toThrow(/variant_key/);
  });

  it("an entrant stored other than typed — kind, name or seed — is refused by name; a blank seed is sent and read back as null", () => {
    const sent = { displayName: "Matrix Player 1", seed: 1, kind: "individual" as const };
    const got = { id: "e1", display_name: "Matrix Player 1", seed: 1, kind: "individual", status: "registered" };
    expect(() => assertEntrantAsTyped(sent, got)).not.toThrow();
    const wrong = [{ ...got, kind: "pair" }, { ...got, display_name: "Matrix Player 10" }, { ...got, seed: 2 }, { ...got, seed: null }];
    for (const w of wrong) expect(() => assertEntrantAsTyped(sent, w), JSON.stringify(w)).toThrow(EntrantNotAsTyped);
    expect(wrong.length).toBe(4);
    expect(() => assertEntrantAsTyped({ ...sent, seed: null }, { ...got, seed: null })).not.toThrow();
    expect(() => assertEntrantAsTyped({ ...sent, seed: null }, got)).toThrow(/seed/);
  });

  it("the competition ends on the day HttpDriver's own create sends", () => {
    expect(src("scripts/matrix/lib/driver/http-driver.ts")).toContain(`ends_on: "${COMPETITION_ENDS_ON}"`);
  });
});

// division-builder.tsx:423-444: Create POSTs the division, then (only after its
// answer) the stages under the new division's id. Both answers are the
// product's; the stages wait must exist before the click, like the first.
describe("awaitDivisionAndStages: the builder's two answers", () => {
  interface FakeResponse { request(): { method(): string }; url(): string; status(): number; json(): Promise<unknown> }
  const BASE = "http://localhost:3999";
  const resp = (method: string, path: string, status: number, body: unknown): FakeResponse => ({
    request: () => ({ method: () => method }), url: () => `${BASE}${path}`, status: () => status, json: () => Promise.resolve(body),
  });
  function fakePage() {
    type W = { pred: (r: FakeResponse) => boolean; resolve: (r: FakeResponse) => void; timer: ReturnType<typeof setTimeout> };
    const waiters: W[] = [];
    return {
      page: {
        waitForResponse(pred: (r: FakeResponse) => boolean, o: { timeout: number }): Promise<FakeResponse> {
          return new Promise((resolveW, reject) => {
            const w: W = { pred, resolve: resolveW, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); const e = new Error("Timeout"); e.name = "TimeoutError"; reject(e); }, o.timeout) };
            waiters.push(w);
          });
        },
      } as unknown as Parameters<typeof awaitDivisionAndStages>[0],
      waiting: () => waiters.length,
      emit(r: FakeResponse) { for (const w of [...waiters]) if (w.pred(r)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(r); } },
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const DIV = { id: "div-1", slug: "open", sport_key: "generic", variant_key: "score" };
  const STAGES = [{ id: "st-1", seq: 1, kind: "league" }];

  it("both answers, in the product's order: the division, then its stages", async () => {
    const f = fakePage();
    const out = awaitDivisionAndStages(f.page, "comp-1", async () => {
      // Both waits exist before the click lands.
      expect(f.waiting()).toBe(2);
      f.emit(resp("POST", "/api/v1/competitions/comp-1/divisions", 201, { ok: true, data: DIV }));
      await tick();
      f.emit(resp("POST", "/api/v1/divisions/div-1/stages", 201, { ok: true, data: STAGES }));
    }, 1000);
    await expect(out).resolves.toEqual({ division: DIV, stages: STAGES });
  });

  it("a division the product refused is that RefusedCall, and nothing waits on for stages that will never be posted", async () => {
    const f = fakePage();
    const out = awaitDivisionAndStages(f.page, "comp-1", async () => {
      f.emit(resp("POST", "/api/v1/competitions/comp-1/divisions", 402, { ok: false, error: { code: "PAYMENT_REQUIRED", message: "no", feature_key: "divisions.max" } }));
    }, 50);
    await expect(out).rejects.toMatchObject({ name: "RefusedCall", code: "PAYMENT_REQUIRED", featureKey: "divisions.max" });
  });

  it("stages the product refused are that RefusedCall (the division exists, the builder landed nowhere)", async () => {
    const f = fakePage();
    const out = awaitDivisionAndStages(f.page, "comp-1", async () => {
      f.emit(resp("POST", "/api/v1/competitions/comp-1/divisions", 201, { ok: true, data: DIV }));
      await tick();
      f.emit(resp("POST", "/api/v1/divisions/div-1/stages", 422, { ok: false, error: { code: "SWISS_ROUNDS_REQUIRED", message: "rounds" } }));
    }, 1000);
    await expect(out).rejects.toMatchObject({ name: "RefusedCall", code: "SWISS_ROUNDS_REQUIRED" });
  });

  it("stages posted under ANOTHER division's id are refused by name, not returned as this one's", async () => {
    const f = fakePage();
    const out = awaitDivisionAndStages(f.page, "comp-1", async () => {
      f.emit(resp("POST", "/api/v1/competitions/comp-1/divisions", 201, { ok: true, data: DIV }));
      await tick();
      f.emit(resp("POST", "/api/v1/divisions/div-OTHER/stages", 201, { ok: true, data: STAGES }));
    }, 1000);
    await expect(out).rejects.toThrow(StagesForAnotherDivision);
  });

  it("a click that posts nothing is NoProductResponse('no-response'), not a hang", async () => {
    const f = fakePage();
    await expect(awaitDivisionAndStages(f.page, "comp-1", async () => undefined, 30)).rejects.toMatchObject({ name: "NoProductResponse", reason: "no-response" });
    expect(NoProductResponse).toBeDefined();
  });
});

describe("the console, the run sheet and the public page", () => {
  it("Finalize answers on the fixture's events route: the console sends core.finalize through send(), not /finalize", () => {
    const fc = src(`${V2}/fixture-console.tsx`);
    const button = /data-testid="score-finalize"[\s\S]{0,200}?onClick=\{\(\) => send\("([\w.]+)", \{\}\)\}/.exec(fc);
    expect(button?.[1]).toBe("core.finalize");
    expect(fc).toContain("await apiV1(`/api/v1/fixtures/${fixture.id}/events`, {");
    const re = eventsPath("fx-1");
    expect(re.test("/api/v1/fixtures/fx-1/events")).toBe(true);
    expect(re.test("/api/v1/fixtures/fx-1/finalize")).toBe(false);
    expect(re.test("/api/v1/fixtures/fx-10/events")).toBe(false);
  });

  it("a forfeit is the bench's own console route for the side `by` names; a fixture with an empty side, or a `by` on neither side, is refused", () => {
    const fx = { id: "fx-1", home_entrant_id: "e-home", away_entrant_id: "e-away" };
    const steps = forfeitSteps(fx, "e-away", "retired hurt");
    expect(steps).toEqual([
      { kind: "testid", testid: FORFEIT_TESTID },
      { kind: "testid", testid: `${FORFEIT_SIDE_TESTID_PREFIX}away` },
      { kind: "text", testid: PROMPT_REASON_TESTID, value: "retired hurt" },
      { kind: "testid", testid: PROMPT_SUBMIT_TESTID },
    ]);
    expect(forfeitSteps(fx, "e-home", "walkover")[1]).toEqual({ kind: "testid", testid: `${FORFEIT_SIDE_TESTID_PREFIX}home` });
    expect(() => forfeitSteps({ ...fx, away_entrant_id: null }, "e-home", "walkover")).toThrow(ForfeitNeedsBothSides);
    expect(() => forfeitSteps({ ...fx, home_entrant_id: null }, "e-away", "walkover")).toThrow(ForfeitNeedsBothSides);
    expect(() => forfeitSteps(fx, "e-other", "walkover")).toThrow(/matches neither/);
    // The side buttons are the console's own composition (fixture-console.tsx ForfeitButton).
    expect(src(`${V2}/fixture-console.tsx`)).toContain("data-testid={`score-forfeit-${sideKey}`}");
    expect(FORFEIT_SIDE_TESTID_PREFIX).toBe("score-forfeit-");
  });

  // AGENTS class 20: the forfeit is four steps, each waiting up to its own
  // bound for its control and then tapping it under the page's default (one
  // step's bound too, ruling F) — two bounded waits a step — and the events
  // answer lands only after the last. So the answer's wait must outlast every
  // step's worst case plus a round trip — derived here from the budget
  // constants, never from forfeitBudgets.
  it("a forfeit's answer is budgeted past every step's own worst case plus a round trip, for any number of steps", () => {
    const step = Math.max(FLOOR_MS, TAP_PACE_MS + SLACK_MS);
    let checked = 0;
    for (const holdMs of [500, 3000, 10_000]) {
      for (let n = 1; n <= 6; n++) {
        const b = forfeitBudgets({ holdMs }, n);
        expect(b.stepMs, `holdMs ${holdMs}`).toBe(step);
        expect(b.responseMs, `${n} steps, holdMs ${holdMs}`).toBeGreaterThanOrEqual(n * 2 * step + TAP_PACE_MS + SLACK_MS);
        checked++;
      }
    }
    expect(checked).toBe(18);
    // Never below the bench's own per-tap wait (execute.ts's contract).
    expect(forfeitBudgets({ holdMs: 3000 }, 4).stepMs).toBeGreaterThanOrEqual(TAP_WAIT_TIMEOUT_MS);
    // Empty case: no steps is no forfeit to wait on — refused by name.
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => forfeitBudgets({ holdMs: 3000 }, n), String(n)).toThrow(/steps/);
  });

  it("postForfeit taps every step within its step bound and waits on the answer past all of them", async () => {
    const fx = { id: "fx-1", home_entrant_id: "e-home", away_entrant_id: "e-away" };
    const steps = forfeitSteps(fx, "e-away", "walkover");
    const b = forfeitBudgets({ holdMs: 3000 }, steps.length);
    expect(steps.length).toBe(4);
    const submit = `[data-testid="${PROMPT_SUBMIT_TESTID}"]`;
    const stepWaits: number[] = [];
    /** The bound each click/fill ran under: its own timeout, else the page default. */
    const actWaits: number[] = [];
    const acts: string[] = [];
    let responseWait = 0;
    let deliver: (() => void) | null = null;
    // Playwright's own default until a page sets one (a real Page answers 30 s).
    let defaultMs = 30_000;
    const answer = { seq: 2, status: "in_progress", outcome: null, event_id: "ev-2" };
    const response = { request: () => ({ method: () => "POST" }), url: () => "http://localhost:3999/api/v1/fixtures/fx-1/events", status: () => 201, json: () => Promise.resolve({ ok: true, data: answer }) };
    const page = {
      setDefaultTimeout(ms: number) { defaultMs = ms; },
      waitForResponse(pred: (r: typeof response) => boolean, o: { timeout: number }) {
        responseWait = o.timeout;
        return new Promise((resolve) => { deliver = () => { if (pred(response)) resolve(response); }; });
      },
      locator: (sel: string) => ({
        waitFor: async (o?: { timeout?: number }) => { stepWaits.push(o?.timeout ?? defaultMs); },
        click: async (o?: { timeout?: number }) => { actWaits.push(o?.timeout ?? defaultMs); acts.push(`click ${sel}`); if (sel === submit) deliver!(); },
        fill: async (v: string, o?: { timeout?: number }) => { actWaits.push(o?.timeout ?? defaultMs); acts.push(`fill ${sel} ${v}`); },
        count: async () => 1,
      }),
      goto: async () => null,
      setViewportSize: async () => undefined,
    };
    // As BrowserDriver does to every case page (ruling F).
    boundActions(page, { holdMs: 3000 });
    const posted = await postForfeit(page as unknown as Parameters<typeof postForfeit>[0], { holdMs: 3000 }, fx.id, steps);
    expect(posted).toEqual(answer);
    expect(acts.length).toBe(steps.length);
    expect(acts.at(-1)).toBe(`click ${submit}`);
    expect(stepWaits).toEqual(steps.map(() => b.stepMs));
    // Every tap ran under the page default the driver set: one step's bound.
    expect(actWaits).toEqual(steps.map(() => b.stepMs));
    expect(responseWait).toBe(b.responseMs);
    // Every bounded wait the steps can spend, observed here, plus a round trip.
    const worst = [...stepWaits, ...actWaits].reduce((s, w) => s + w, 0);
    expect(worst).toBe(2 * steps.length * b.stepMs);
    expect(responseWait).toBeGreaterThanOrEqual(worst + TAP_PACE_MS + SLACK_MS);
  });

  it("a DATA selector narrowed to one value keeps its attribute and quotes the value; an unsafe value is refused", () => {
    expect(attrEquals(DATA.entrantKind.selector, "kind", "pair")).toBe('[data-kind="pair"]');
    expect(attrEquals(DATA.fixtureRow.selector, "no", "3")).toBe('li[data-fixture-no="3"]');
    expect(() => attrEquals(DATA.entrantStatus.selector, "status", 'x"]')).toThrow(UnsafeSelectorValue);
  });

  it("the run sheet's show-everything filter is the product's own value and pressed state", () => {
    const rs = src(`${V2}/desk/run-sheet.tsx`);
    expect(rs).toContain(`{ value: "${ALL_FILTER}", label: msg("runsheet.filter.all") }`);
    expect(rs).toContain("data-filter={f.value}");
    expect(rs).toContain("aria-pressed={filter === f.value}");
  });

  it("every link a run-sheet row renders goes to the fixture console, so the identity link is a true fallback for a Set-time row", () => {
    const row = src(`${V2}/desk/run-sheet-row.tsx`);
    const hrefs = [...row.matchAll(/href=\{([^}]+)\}/g)].map((m) => m[1]);
    expect(hrefs.length).toBe(2);
    expect(new Set(hrefs)).toEqual(new Set(["href"]));
    expect(src(`${V2}/stages-panel.tsx`)).toContain("hrefFor={(f) => routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}");
    // set_time is the one row action that is a <button>, not a link.
    expect(row).toMatch(/<button\s+type="button"\s+data-row-action="set_time"/);
  });

  it("the public standings tab and panel are the ids tabs.tsx composes, selected by aria-selected", () => {
    const tabs = src("apps/web/src/components/public-site/tabs.tsx");
    expect(tabs).toContain("id={`tab-${ids[i]}`}");
    expect(tabs).toContain("id={`panel-${ids[i]}`}");
    expect(tabs).toContain("aria-selected={i === active}");
    expect(publicTabSelector(PUBLIC_STANDINGS_TAB)).toBe(`[id="tab-${PUBLIC_STANDINGS_TAB}"][aria-selected="true"]`);
    expect(publicPanelSelector(PUBLIC_STANDINGS_TAB)).toBe(`[id="panel-${PUBLIC_STANDINGS_TAB}"]`);
  });
});
