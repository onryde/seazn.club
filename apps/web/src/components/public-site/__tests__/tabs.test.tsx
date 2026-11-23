// `Tabs` — the division home's switcher (Schedule / Standings / Entrants).
//
// TWO defects are pinned here, both of which were live on the merged spectator
// surface:
//
// 1. The labels were HARDCODED ENGLISH at the call site
//    (`[divisionSlug]/page.tsx`), so a Spanish, French or Dutch spectator read
//    "Schedule / Standings / Entrants". The four keys — `division.tab.schedule`
//    / `.standings` / `.entrants` and `division.tabsLabel` — had shipped in all
//    four locales the whole time and NOTHING rendered them: their only consumer
//    was `hub-dictionary.test.ts:70`, a coverage test asserting they exist. A
//    key guarded by a coverage test and read by no page looks covered and is
//    not, which is why the second test below reads the PAGE SOURCE rather than
//    this component — a component test can only prove `Tabs` renders what it is
//    handed, never that the caller hands it the dictionary.
//
// 2. `?tab=` was ignored (`useState(0)`, no query read), so every "Full
//    division" link the hub emits — `?tab=standings` at
//    `competition-hub.ts:584`, `?tab=entrants` at `:608` — landed on Schedule.
//
// WHAT THIS FILE CANNOT PROVE: the `?tab=` behaviour itself. `apps/web` vitest
// is `environment: "node"` with no DOM, so the mount effect never runs and
// `window.location` does not exist. What IS provable here is the server
// contract the fix depends on — index 0 active in the static render, so
// hydration cannot mismatch — plus the id wiring the effect needs. The deep
// link itself is booked to the post-mount e2e leg, alongside the Task 2
// geometry debt; `e2e/walkthrough/spectator-public-2.spec.ts` already drives
// `role="tab"` on this surface and is where it belongs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Tabs } from "../tabs";
import { DIVISION_TABS } from "@/lib/division-tabs";
import { renderIsland } from "@/components/__tests__/_hook-harness";

// W5 follow-ups B3: a tap on a panel the document does not carry loads it through the App Router. Its router is the one
// browser seam here; the spy records where it was sent.
const nav = vi.hoisted(() => ({ replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
// The `?tab=` a spectator arrived with. Null (the server snapshot the real hook answers here) unless a test sets it: the guard on
// a deep link to a panel this document does not carry is otherwise unreachable without a browser (review M1).
const deepLink = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../use-tab-param", () => ({ useTabParam: () => deepLink.value }));

const IDS = ["schedule", "standings", "entrants"];

// Spanish on purpose: English labels would be indistinguishable from the
// hardcoded array this test exists to keep out.
const ES = ["Calendario", "Clasificación", "Participantes"];

function render(labels = ES) {
  return renderToStaticMarkup(
    <Tabs ids={IDS} labels={labels} label="Pestañas de la división" basePath="/live/o/c/d">
      {[<p key="a">SCHEDULE PANEL</p>, <p key="b">STANDINGS PANEL</p>, <p key="c">ENTRANTS PANEL</p>]}
    </Tabs>,
  );
}

describe("Tabs", () => {
  it("renders the labels it is GIVEN — no English of its own", () => {
    const h = render();
    for (const label of ES) expect(h).toContain(label);
    // The positive pair: the words the old hardcoded array used are absent, so
    // a regression that reintroduces them here has somewhere to fail.
    for (const english of [">Schedule<", ">Standings<", ">Entrants<"]) {
      expect(h).not.toContain(english);
    }
  });

  it("names the tablist from the caller's string, not a literal", () => {
    expect(render()).toMatch(/role="tablist"[^>]*aria-label="Pestañas de la división"/);
  });

  it("wires every tab to its panel by the STABLE id, not by index or label", () => {
    const h = render();
    for (const id of IDS) {
      // Anchored on `="` — React serialises an omitted prop as "$undefined",
      // so a bare attribute-name probe passes in both states.
      expect(h).toMatch(new RegExp(`id="tab-${id}"[^>]*role="tab"[^>]*aria-controls="panel-${id}"`));
      expect(h).toMatch(new RegExp(`id="panel-${id}"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-${id}"`));
    }
  });

  it("the SERVER render always opens on the first tab — the contract that makes the ?tab= effect safe", () => {
    const h = render();
    // Exactly one, and it is the first. A count, not a containment check: two
    // selected tabs and zero selected tabs both survive `toContain`.
    expect([...h.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    expect(h).toMatch(/id="tab-schedule"[^>]*role="tab"[^>]*aria-selected="true"/);
    expect(h).toMatch(/id="tab-standings"[^>]*role="tab"[^>]*aria-selected="false"/);
    // Only the first panel is visible, and the other two are SHIPPED rather
    // than absent — that is what makes the tab switch instant and the page
    // crawlable, and it is why a `?tab=` deep link can be honoured on the
    // client at all.
    expect(h).toContain("STANDINGS PANEL");
    expect(h).toMatch(/id="panel-standings"[^>]*hidden/);
    expect(h).not.toMatch(/id="panel-schedule"[^>]*hidden/);
  });
});

describe("the division page's own call (source contract)", () => {
  // Same idiom as `lib/__tests__/public-image-contract.test.ts`: the wiring
  // lives in an async server component that this suite cannot render, so the
  // guard reads its source. Without it the i18n fix silently rots back to
  // literals and every test above still passes, because `Tabs` renders
  // whatever it is handed.
  const SRC = join(
    process.cwd(),
    "src/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx",
  );
  const src = readFileSync(SRC, "utf8");

  it("passes the four dictionary keys, and no hardcoded label array", () => {
    for (const key of [
      "division.tab.schedule",
      "division.tab.standings",
      "division.tab.entrants",
      "division.tabsLabel",
    ]) {
      expect(src).toContain(`t(dict, "${key}")`);
    }
    expect(src).not.toContain('labels={["Schedule", "Standings", "Entrants"]}');
  });

  it("passes the URL-facing ids UNTRANSLATED — a shared link must survive the reader's locale", () => {
    // W5 follow-ups B3: the ids live in `lib/division-tabs.ts`, shared with the proxy's `?tab=` rewrite; the page passes them.
    expect(src).toContain("ids={[...DIVISION_TABS]}");
    expect(DIVISION_TABS).toEqual(["schedule", "standings", "entrants"]);
  });

  it("resolves the dictionary from the ORG locale, never a per-visitor read", () => {
    // This page is ISR (`export const revalidate = 30`), so a request-scoped
    // Accept-Language read would make every cached copy wrong for somebody.
    expect(src).toContain('await getDictionary(orgLocale, "public")');
    expect(src).toContain("export const revalidate = 30");
  });
});

// W5 follow-ups B3 (perf-measure-report P3): the division page server-renders only the ACTIVE tab's panel and hands the
// others as null. The bar the server rendered must name that panel (so hydration matches), and a tap on a missing panel
// must load it from its own URL, while a tap on one that is here still only toggles.
describe("Tabs - only the active panel is in the document (B3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    nav.replace.mockReset();
    nav.prefetch.mockReset();
    deepLink.value = null;
  });

  const standingsOnly = () => [null, <p key="b">STANDINGS PANEL</p>, null];

  it("the server's `initial` panel is the one shown and selected; the absent panels are empty and hidden", () => {
    const h = renderToStaticMarkup(
      <Tabs ids={IDS} labels={ES} label="x" basePath="/live/o/c/d" initial={1}>
        {standingsOnly()}
      </Tabs>,
    );
    expect(h).toMatch(/id="tab-standings"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="tab-standings"/);
    expect(h).toMatch(/<div id="panel-standings" role="tabpanel" aria-labelledby="tab-standings">/);
    expect(h).toMatch(/<div id="panel-schedule" role="tabpanel" aria-labelledby="tab-schedule" hidden="">/);
    expect(h).toContain("STANDINGS PANEL");
  });

  it("a tap on an absent panel loads its URL through the router; a tap on the present one only toggles; Schedule drops ?tab", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { href: "https://seazn.club/live/o/c/d?tab=standings#top" }, history: { replaceState } });
    const island = renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", basePath: BASE, initial: 1, children: standingsOnly() });
    const tab = (id: string) => island.tree().find((el) => (el.props as { id?: string }).id === `tab-${id}`)!;
    let taps = 0;
    (tab("entrants").props as { onClick: () => void }).onClick();
    taps += 1;
    expect(nav.replace).toHaveBeenCalledWith("/live/o/c/d?tab=entrants#top", { scroll: false });
    expect(replaceState, "an absent panel is a load, not a toggle").not.toHaveBeenCalled();
    // Until that document arrives the panel on screen stays - never an empty one.
    expect((tab("standings").props as { "aria-selected"?: boolean })["aria-selected"], "the shown tab stays selected").toBe(true);
    expect((tab("entrants").props as { "aria-selected"?: boolean })["aria-selected"]).toBe(false);
    (tab("schedule").props as { onClick: () => void }).onClick();
    taps += 1;
    expect(nav.replace).toHaveBeenLastCalledWith("/live/o/c/d#top", { scroll: false });
    nav.replace.mockClear();
    (tab("standings").props as { onClick: () => void }).onClick();
    taps += 1;
    expect(nav.replace, "the present panel never navigates").not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(taps, "anti-vacuity").toBe(3);
  });

  it("every panel present (the empty case of B3): no tap ever navigates", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { href: "https://seazn.club/live/o/c/d" }, history: { replaceState } });
    const island = renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", basePath: BASE, children: [<p key="a">A</p>, <p key="b">B</p>, <p key="c">C</p>] });
    for (const id of IDS) ((island.tree().find((el) => (el.props as { id?: string }).id === `tab-${id}`)!.props) as { onClick: () => void }).onClick();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(3);
    expect(nav.prefetch, "nothing to load, nothing prefetched").not.toHaveBeenCalled();
  });

  // Review M2: the target was `window.location.pathname` + `?tab=`. A document served at another address (the internal
  // `tab/[tab]` path, reached directly) then sent the spectator to `.../tab/standings?tab=entrants`.
  it("the target is built from the division's base path, never the address the document was served at (M2)", () => {
    vi.stubGlobal("window", { location: { href: "https://seazn.club/live/o/c/d/tab/standings?ref=hub#top" }, history: { replaceState: vi.fn() } });
    const island = renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", basePath: BASE, initial: 1, children: standingsOnly() });
    tabOf(island, "entrants").onClick();
    expect(nav.replace).toHaveBeenCalledWith("/live/o/c/d?ref=hub&tab=entrants#top", { scroll: false });
    tabOf(island, "schedule").onClick();
    expect(nav.replace).toHaveBeenLastCalledWith("/live/o/c/d?ref=hub#top", { scroll: false });
  });

  // Review I3: B3 made a tap on an absent panel a navigation, and the tapped tab did nothing visible until the document arrived.
  it("on mount, each panel this document does not carry is prefetched at the address a tap sends it to - and the present one never (I3)", () => {
    vi.stubGlobal("window", { location: { href: "https://seazn.club/live/o/c/d?tab=standings" }, history: { replaceState: vi.fn() } });
    renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", basePath: BASE, initial: 1, children: standingsOnly() });
    const sent = nav.prefetch.mock.calls.map((c) => c[0] as string).sort();
    expect(sent, "schedule (the bare route) and entrants; never standings, which is here").toEqual(["/live/o/c/d", "/live/o/c/d?tab=entrants"]);
  });

  // 08127b251b: Standings to Entrants is the same route with another param, so React may keep this instance and hand it the
  // new document as props. Its absent panels differ, and are prefetched in their turn; a re-render of the same document is not.
  it("a new document handed to a kept instance prefetches ITS absent panels; a re-render of the same one prefetches nothing (I3)", () => {
    vi.stubGlobal("window", { location: { href: "https://seazn.club/live/o/c/d?tab=standings" }, history: { replaceState: vi.fn() } });
    const props = { ids: IDS, labels: ES, label: "x", basePath: BASE };
    const island = renderIsland(Tabs, { ...props, initial: 1, children: standingsOnly() });
    expect(nav.prefetch.mock.calls.map((c) => c[0] as string).sort()).toEqual(["/live/o/c/d", "/live/o/c/d?tab=entrants"]);
    nav.prefetch.mockClear();
    island.rerender({ ...props, initial: 1, children: standingsOnly() });
    expect(nav.prefetch, "the same document again: nothing new to fetch").not.toHaveBeenCalled();
    vi.stubGlobal("window", { location: { href: "https://seazn.club/live/o/c/d?tab=entrants" }, history: { replaceState: vi.fn() } });
    island.rerender({ ...props, initial: 2, children: [null, null, <p key="c">ENTRANTS PANEL</p>] });
    const sent = nav.prefetch.mock.calls.map((c) => c[0] as string).sort();
    expect(sent, "schedule and standings; never entrants, which is here").toEqual(["/live/o/c/d", "/live/o/c/d?tab=standings"]);
  });

  it("a tap on an absent panel shows at once: the tapped tab takes the active style and aria-busy while its document loads (I3)", () => {
    vi.stubGlobal("window", { location: { href: "https://seazn.club/live/o/c/d?tab=standings" }, history: { replaceState: vi.fn() } });
    const island = renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", basePath: BASE, initial: 1, children: standingsOnly() }, undefined, {
      transitionPending: true,
    });
    const ACTIVE = /(^|\s)bg-accent(\s|$)/;
    expect(IDS.filter((id) => tabOf(island, id)["aria-busy"] === true), "nothing is loading before a tap").toEqual([]);
    tabOf(island, "entrants").onClick();
    expect(tabOf(island, "entrants")["aria-busy"], "the tapped tab says it is loading").toBe(true);
    expect(tabOf(island, "entrants").className, "and looks active").toMatch(ACTIVE);
    expect(tabOf(island, "schedule")["aria-busy"]).not.toBe(true);
    expect(tabOf(island, "standings")["aria-selected"], "the panel on screen is still the one selected").toBe(true);
    expect(tabOf(island, "standings").className, "only one tab looks active").not.toMatch(ACTIVE);
  });

  it("the sequence without a load: a tap on the present panel never marks a tab busy (I3)", () => {
    vi.stubGlobal("window", { location: { href: "https://seazn.club/live/o/c/d?tab=standings" }, history: { replaceState: vi.fn() } });
    const island = renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", basePath: BASE, initial: 1, children: standingsOnly() }, undefined, {
      transitionPending: true,
    });
    tabOf(island, "standings").onClick();
    expect(IDS.filter((id) => tabOf(island, id)["aria-busy"] === true)).toEqual([]);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  // Review M1: `children[fromUrl] != null` kept a deep link from selecting a panel this document does not carry, and no test
  // reached it. The positive pair proves the link is read at all.
  it("a ?tab= deep link to a panel this document does not carry leaves the server's panel shown; to one it carries, selects it (M1)", () => {
    vi.stubGlobal("window", { location: { href: "https://seazn.club/live/o/c/d?tab=standings" }, history: { replaceState: vi.fn() } });
    deepLink.value = "standings";
    const scheduleOnly = renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", basePath: BASE, initial: 0, children: [<p key="a">A</p>, null, null] });
    expect(tabOf(scheduleOnly, "schedule")["aria-selected"], "the document's own panel stays").toBe(true);
    expect(tabOf(scheduleOnly, "standings")["aria-selected"], "never an empty one").toBe(false);
    const every = renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", basePath: BASE, children: [<p key="a">A</p>, <p key="b">B</p>, <p key="c">C</p>] });
    expect(tabOf(every, "standings")["aria-selected"], "the link is read").toBe(true);
    deepLink.value = null;
  });
});

const BASE = "/live/o/c/d";
type TabProps = { onClick: () => void; "aria-busy"?: boolean; "aria-selected"?: boolean; className: string };
function tabOf(island: { tree(): { props: unknown }[] }, id: string): TabProps {
  const el = island.tree().find((e) => (e.props as { id?: string }).id === `tab-${id}`);
  if (!el) throw new Error(`no tab-${id}`);
  return el.props as TabProps;
}
