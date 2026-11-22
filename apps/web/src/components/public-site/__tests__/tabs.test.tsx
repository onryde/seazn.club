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
const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const IDS = ["schedule", "standings", "entrants"];

// Spanish on purpose: English labels would be indistinguishable from the
// hardcoded array this test exists to keep out.
const ES = ["Calendario", "Clasificación", "Participantes"];

function render(labels = ES) {
  return renderToStaticMarkup(
    <Tabs ids={IDS} labels={labels} label="Pestañas de la división">
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
  });

  const standingsOnly = () => [null, <p key="b">STANDINGS PANEL</p>, null];

  it("the server's `initial` panel is the one shown and selected; the absent panels are empty and hidden", () => {
    const h = renderToStaticMarkup(
      <Tabs ids={IDS} labels={ES} label="x" initial={1}>
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
    const island = renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", initial: 1, children: standingsOnly() });
    const tab = (id: string) => island.tree().find((el) => (el.props as { id?: string }).id === `tab-${id}`)!;
    let taps = 0;
    (tab("entrants").props as { onClick: () => void }).onClick();
    taps += 1;
    expect(nav.replace).toHaveBeenCalledWith("/live/o/c/d?tab=entrants#top", { scroll: false });
    expect(replaceState, "an absent panel is a load, not a toggle").not.toHaveBeenCalled();
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
    const island = renderIsland(Tabs, { ids: IDS, labels: ES, label: "x", children: [<p key="a">A</p>, <p key="b">B</p>, <p key="c">C</p>] });
    for (const id of IDS) ((island.tree().find((el) => (el.props as { id?: string }).id === `tab-${id}`)!.props) as { onClick: () => void }).onClick();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(3);
  });
});
