// P6 fix round 1, finding #2 (CRITICAL, addition beyond the review's literal
// 4-file list): this fixture detail PAGE has the exact same bug pattern as
// bracket.tsx/schedule.tsx/og-model.ts/slideshow-data.ts (a hardcoded-English
// msg() with no way to reach a real locale) and is explicitly named as an
// affected "fixture" surface in the finding's own text, even though the
// dispatch's file list cites og/model.ts (the OG card) for that word. Same
// bug, same fix: resolve via the org's own default_locale.
//
// generateMetadata is a plain async function (no render) — the cheapest,
// highest-confidence way to prove the fix, and it computes home/away with
// the exact same formula the default export's page body duplicates.
import { describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchCentreDoc, type MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import publicEn from "@/dictionaries/en/public.json";
import publicEs from "@/dictionaries/es/public.json";
import publicFr from "@/dictionaries/fr/public.json";
import publicNl from "@/dictionaries/nl/public.json";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

// Real dictionaries, not a table typed into this test (rule 19/reference_
// html_grep_for_dictionary_copy...): Dutch's own `matchCentre.status.live`
// is "Live" too (an accepted loanword), so a hardcoded ">Live<" absence
// check would be a FALSE positive for nl — the assertions below compare
// against each locale's OWN real dictionary value instead.
const PUBLIC_DICTS: Record<string, Record<string, unknown>> = { en: publicEn, es: publicEs, fr: publicFr, nl: publicNl };
const UI_DICTS: Record<string, Record<string, unknown>> = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl };

const getPublicFixture = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicFixture: (...a: unknown[]) => getPublicFixture(...a),
}));

// Task 14d — the page itself no longer reads `searchParams` (the ISR
// contract, public-isr-contract.test.ts, forbids it); the `?tab=` deep link
// is read client-side instead, inside `<MatchCentreWithTabParam>`
// (`useSearchParams`, next/navigation). `notFound` stays REAL — nothing
// here exercises the `!data` branch, and a full replacement would silently
// swallow a future accidental use of it.
const useSearchParams = vi.fn(() => new URLSearchParams());
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useSearchParams: () => useSearchParams() };
});

const baseData = (
  locale: string,
  fixtureOver: Record<string, unknown> = {},
  entrantNamesOver: Record<string, string> = {},
) => ({
  org: { id: "o1", name: "Test Org", slug: "test-org", branded: false, branding: {}, logo: null, about: null, default_locale: locale, card_payments: false },
  competition: { id: "c1", org_id: "o1", name: "Test Comp", slug: "test-comp", description: null, starts_on: null, ends_on: null, branding: {}, status: "active", visibility: "public" },
  division: { id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: "generic", variant_key: "score", status: "active", module_version: "1.0.0", tiebreakers: null, sport_name: null, entrant_count: 2 },
  fixture: {
    id: "f1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
    home_entrant_id: null, away_entrant_id: null, home_slot_label: null, away_slot_label: null,
    scheduled_at: null, venue: null, court_label: null, venue_name: null, court_name: null,
    status: "scheduled", outcome: null, summary: null, last_seq: null,
    ...fixtureOver,
  },
  entrantNames: entrantNamesOver,
  realtime: false,
});

// Task 14 — `getPublicFixture` now also returns `matchCentre` (Task 9); a
// full band-3 cricket document exercises the REAL `<MatchCentre>` tree (tab
// rail + court card + scorecard tab), not the `LiveScoreBody` fallback the
// bare `baseData()` fixture above still takes (no `matchCentre` field —
// `MatchCentre` degrades to its own documented `mc-fallback`, unaffected by
// this task's page-wiring change, which is why the pre-existing tests above
// needed no update).
const baseDataWithMC = (
  locale: string,
  matchCentre: MatchCentreDocT,
  fixtureOver: Record<string, unknown> = {},
  entrantNamesOver: Record<string, string> = {},
) => ({
  ...baseData(locale, fixtureOver, entrantNamesOver),
  matchCentre,
});

function cricketDocFor(status: "in_play" | "decided"): MatchCentreDocT {
  const doc: MatchCentreDocT = {
    fixtureId: "f1",
    sportKey: "cricket",
    derivedComplete: true,
    header: {
      live: status === "in_play",
      status,
      sides: [
        { entrantId: "home", name: "Home XI", short: "HOM", colour: null, badgeUrl: null },
        { entrantId: "away", name: "Away XI", short: "AWY", colour: null, badgeUrl: null },
      ],
      scoreLines: status === "decided" ? ["245/6", "180"] : ["156/4", null],
      subLines: [null, null],
      battingIndex: status === "in_play" ? 0 : null,
      statusLine:
        status === "decided"
          ? { key: "matchCentre.result.regulation", params: { winner: "Home XI", margin: "65 runs" } }
          : null,
      rateLine: null,
      phase: null,
      strength: null,
      updatedAt: new Date().toISOString(),
    },
    tabs: ["summary", "scorecard", "info"],
    // `cricket.live`/`topPerformers`/`innings` all-empty is SummaryTab's own
    // "pre-play" case (`summary-tab.tsx`'s `isPrePlay`), which falls back to
    // `LiveScoreBody` — exactly the OLD path this test proves the page no
    // longer takes for a fixture that IS actually in play or decided, so
    // each status gets the minimal real content that keeps it out of that
    // fallback: an (empty) live block while in play, a top performer once
    // decided.
    cricket: {
      band: 3,
      toss: null,
      innings: [],
      live:
        status === "in_play"
          ? { striker: null, nonStriker: null, bowler: null, batters: [], bowling: [], thisOver: [], partnership: null, lastWicket: null }
          : null,
      topPerformers:
        status === "decided"
          ? [
              {
                role: "batter",
                person: { personId: "p1", name: "A. Batter", masked: false },
                side: { entrantId: "home", name: "Home XI", short: "HOM", colour: null, badgeUrl: null },
                line: "82 (54)",
                detail: null,
                innings: 1,
              },
            ]
          : [],
    },
    timeline: null,
    sets: null,
    info: { rows: [], calendarHref: "/d/cal.ics", divisionHref: "/d", competitionHref: "/c" },
  };
  MatchCentreDoc.parse(doc); // fails loudly if this literal fixture drifts from the schema
  return doc;
}

const meta = async (locale: string, fixtureOver: Record<string, unknown> = {}) => {
  getPublicFixture.mockResolvedValue(baseData(locale, fixtureOver));
  const { generateMetadata } = await import("../page");
  return generateMetadata({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open", fixtureId: "f1" }),
  });
};

describe("FixturePage generateMetadata — org-locale slot labels (P6 finding #2)", () => {
  it("resolves both slots via the org's default_locale, not hardcoded English", async () => {
    const m = await meta("es", {
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
    });
    expect(m.title).toBe("Ganador del Grupo A vs Ganador del Grupo B — Open");
  });

  it("English org still reads exactly as before (back-compat)", async () => {
    const m = await meta("en", {
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
    });
    expect(m.title).toBe("Winner of Group A vs Winner of Group B — Open");
  });
});

// Task 14, Step 1(a) — the match-centre document is now the ONE source for
// the decided fixture's score+result, so the title stops going stale the
// moment a spectator shares it (the pre-Task-14 title never carried a score
// at all).
describe("FixturePage generateMetadata — score + result in the title (Task 14)", () => {
  it("a decided cricket fixture's title carries both raw score lines AND the localised result phrase", async () => {
    getPublicFixture.mockResolvedValue(
      baseDataWithMC(
        "en",
        cricketDocFor("decided"),
        { status: "decided", home_entrant_id: "home", away_entrant_id: "away" },
        { home: "Home XI", away: "Away XI" },
      ),
    );
    const { generateMetadata } = await import("../page");
    const m = await generateMetadata({
      params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open", fixtureId: "f1" }),
    });
    expect(m.title).toContain("HOM 245/6"); // score line 1
    expect(m.title).toContain("AWY 180"); // score line 2
    expect(m.title).toContain("Home XI won 65 runs"); // the result phrase, resolved from header.statusLine
  });

  it("a SCHEDULED fixture's title is untouched — no bare, empty parentheses", async () => {
    getPublicFixture.mockResolvedValue(
      baseDataWithMC(
        "en",
        cricketDocFor("in_play"),
        { status: "scheduled", home_entrant_id: "home", away_entrant_id: "away" },
        { home: "Home XI", away: "Away XI" },
      ),
    );
    const { generateMetadata } = await import("../page");
    const m = await generateMetadata({
      params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open", fixtureId: "f1" }),
    });
    expect(m.title).toBe("Home XI vs Away XI — Open");
    expect(m.title).not.toContain("(");
  });
});

// P9 pass 3c-3: fixture.venue/court_label are frozen since pass 3a — this
// page's default export (subheading text + SportsEvent JSON-LD) must render
// venue_name/court_name (data.ts's derived, join-backed fields) instead.
// No jsdom: walk the returned element tree, same convention as
// officials-fixture-locale.test.tsx / server-component-page-test memory.
function collectText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isValidElement(node)) {
    return collectText((node.props as { children?: unknown }).children);
  }
  return "";
}

function findScript(node: unknown): { props: Record<string, unknown> } | null {
  if (!isValidElement(node)) return null;
  if (node.type === "script") return node as unknown as { props: Record<string, unknown> };
  const children = (node.props as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const c of children) {
      const hit = findScript(c);
      if (hit) return hit;
    }
    return null;
  }
  return findScript(children);
}

// Task 14 — `matchCentre`/`entrantNamesOver`/`locale` are new, optional, and
// additive: every PRE-EXISTING call site (`render({...fixtureOver})`) keeps
// its exact original behaviour (`baseData`, English, no document).
//
// Task 14d — `tab` no longer reaches `FixturePage` itself (it took a
// `searchParams` prop pre-14d; the page component now takes only `params` —
// see page.tsx's own history). It's threaded through the `useSearchParams`
// MOCK instead, so this helper still proves the deep link end-to-end: page
// → `<MatchCentreWithTabParam>` → `useSearchParams` → the real `<MatchCentre>`
// tab selection, the same path a real browser takes once hydrated.
const render = async (
  fixtureOver: Record<string, unknown> = {},
  matchCentre?: MatchCentreDocT,
  entrantNamesOver: Record<string, string> = {},
  locale: string = "en",
  tab?: string,
) => {
  getPublicFixture.mockResolvedValue(
    matchCentre
      ? baseDataWithMC(locale, matchCentre, fixtureOver, entrantNamesOver)
      : baseData(locale, fixtureOver, entrantNamesOver),
  );
  useSearchParams.mockReturnValue(new URLSearchParams(tab ? { tab } : {}));
  const { default: FixturePage } = await import("../page");
  return FixturePage({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open", fixtureId: "f1" }),
  });
};

describe("FixturePage default export — derived court/venue name (P9 cutover)", () => {
  it("subheading shows venue_name/court_name, never the stale venue/court_label", async () => {
    const tree = await render({
      venue: "Stale Building",
      court_label: "Stale Court",
      venue_name: "Riverside Sports Hall",
      court_name: "Court 3",
    });
    const text = collectText(tree);
    expect(text).toContain("Riverside Sports Hall");
    expect(text).toContain("Court 3");
    expect(text).not.toContain("Stale Building");
    expect(text).not.toContain("Stale Court");
  });

  it("SportsEvent JSON-LD location is the derived venue_name, not the stale venue", async () => {
    const tree = await render({ venue: "Stale Building", venue_name: "Riverside Sports Hall" });
    const script = findScript(tree);
    expect(script).not.toBeNull();
    const html = (script!.props.dangerouslySetInnerHTML as { __html: string }).__html;
    const ld = JSON.parse(html) as { location?: { name?: string } };
    expect(ld.location?.name).toBe("Riverside Sports Hall");
    expect(html).not.toContain("Stale Building");
  });

  it("no venue_name at all omits JSON-LD location, never a blank/undefined placeholder", async () => {
    const tree = await render({});
    const script = findScript(tree);
    const html = (script!.props.dangerouslySetInnerHTML as { __html: string }).__html;
    const ld = JSON.parse(html) as { location?: unknown };
    expect(ld.location).toBeUndefined();
  });
});

// Task 14, Step 1(b) — the match centre replaces the legacy bare scorebug.
// Real HTML (`renderToStaticMarkup`), not `collectText`: `<MatchCentre>` is a
// separate component the tree-walk above only sees one level into (by
// design — see `_hook-harness`'s own doc comment), so proving its INSIDE
// needs an actual render.
describe("FixturePage default export — the match centre replaces the legacy scorebug (Task 14)", () => {
  it("a band-3 cricket fixture's HTML has the tab rail (mc-tab-scorecard) and the court card, never the old bare `font-display text-5xl` headline block", async () => {
    const tree = await render(
      { status: "in_play", home_entrant_id: "home", away_entrant_id: "away" },
      cricketDocFor("in_play"),
      { home: "Home XI", away: "Away XI" },
    );
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('data-testid="mc-tab-scorecard"');
    expect(html).toContain('data-testid="mc-court-card"');
    // live-score.tsx:193 (pre-Task-14) — LiveScoreBody's own bare headline,
    // now only ever reachable from MatchCentre's fallback/non-cricket path.
    expect(html).not.toContain("font-display text-5xl");
  });

  // `mc-tab-scorecard` above is the TAB RAIL's own button testid
  // (`tab-rail.tsx`), rendered from `doc.tabs` regardless of what
  // `TAB_PANELS` maps that tab id to — it would pass even against a
  // placeholder. This selects the tab via `?tab=` and asserts the REAL
  // `ScorecardTab`'s own root (`data-testid="mc-scorecard"`, present even
  // with zero innings — `scorecard-tab.tsx`), which only a wired real panel
  // renders.
  it("selecting the scorecard tab via ?tab= renders the REAL ScorecardTab panel, not an empty placeholder", async () => {
    const tree = await render(
      { status: "in_play", home_entrant_id: "home", away_entrant_id: "away" },
      cricketDocFor("in_play"),
      { home: "Home XI", away: "Away XI" },
      "en",
      "scorecard",
    );
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('data-testid="mc-tab-panel-scorecard"');
    expect(html).toContain('data-testid="mc-scorecard"');
  });
});

// Task 14, Step 1(c) — every literal string on the page goes through the
// request locale's dictionary. Both an in-play and a decided render per
// locale: "Live"/"Ended" are two DIFFERENT dictionary keys (CourtCard's
// status chip), so one fixture state cannot prove both are localised.
describe("FixturePage — no hardcoded English leaks outside lang=en (Task 14)", () => {
  for (const locale of ["en", "es", "fr", "nl"] as const) {
    it(`locale=${locale}`, async () => {
      const liveTree = await render(
        { status: "in_play", scheduled_at: null, home_entrant_id: "home", away_entrant_id: "away" },
        cricketDocFor("in_play"),
        { home: "Home XI", away: "Away XI" },
        locale,
      );
      const liveHtml = renderToStaticMarkup(liveTree);

      const decidedTree = await render(
        { status: "decided", home_entrant_id: "home", away_entrant_id: "away" },
        cricketDocFor("decided"),
        { home: "Home XI", away: "Away XI" },
        locale,
      );
      const decidedHtml = renderToStaticMarkup(decidedTree);

      // These three are never reachable from a band-3 cricket document with
      // real tabs — `LiveScoreBody` (Discipline/Goals by period/Winner:) is
      // only MatchCentre's own fallback for a missing/non-cricket document
      // — so this holds in EVERY locale, English included; a real
      // regression in any of the three would show here as much as in
      // fr/es/nl.
      for (const html of [liveHtml, decidedHtml]) {
        expect(html).not.toContain("Discipline");
        expect(html).not.toContain("Goals by period");
        expect(html).not.toContain("Winner:");
      }

      // The other two ARE real, translated copy — the assertion is that
      // THIS locale's own dictionary value shows up, derived from the
      // dictionaries themselves (never a table typed into the test — one
      // locale's translation can legitimately equal English, e.g. Dutch's
      // own "matchCentre.status.live" is "Live" too, an accepted loanword;
      // hardcoding ">Live<" absence for every non-English locale would be a
      // false positive there).
      const publicDict = PUBLIC_DICTS[locale]!;
      const uiDict = UI_DICTS[locale]!;
      expect(liveHtml).toContain(`>${publicDict["matchCentre.status.live"]}<`);
      expect(decidedHtml).toContain(`>${publicDict["matchCentre.status.decided"]}<`);
      // `ShareButton`'s aria-label now resolves through the `<DictProvider>`
      // this task wraps the page in (it had none before — the label was
      // always English regardless of locale).
      expect(liveHtml).toContain(uiDict["share.whatsapp"] as string);

      if (publicDict["matchCentre.status.live"] !== publicEn["matchCentre.status.live"]) {
        expect(liveHtml).not.toContain(">Live<");
      }
      if (locale !== "en") {
        expect(decidedHtml).not.toContain(">Ended<"); // "Ended" differs in es/fr/nl
        expect(liveHtml).not.toContain("Share on WhatsApp");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Stream overlay W1, Task 7 — the public match page's link to the club's own
// broadcast (design §3.9). The unit layer here is `environment: "node"`, so
// these drive the REAL page component and read its REAL HTML: the seam that
// matters is `getPublicFixture().fixture.stream_url` → an anchor on this page,
// and a test of `streamLinkLabelKey` alone could not see whether anything
// mounts it (recurring class 1, the inert seam).
//
// Two different URLs on purpose: an implementation that hardcoded one of them
// would satisfy a single-sample test (rule 19 — "prefer at least one case
// where the right answer differs from the wrong one's constant").
// ---------------------------------------------------------------------------
const TWITCH = "https://www.twitch.tv/seaznclub";
const YOUTUBE = "https://www.youtube.com/live/abc123";

const streamHtml = async (fixtureOver: Record<string, unknown>, locale = "en") =>
  renderToStaticMarkup(
    await render(
      { home_entrant_id: "home", away_entrant_id: "away", ...fixtureOver },
      cricketDocFor(fixtureOver.status === "in_play" ? "in_play" : "decided"),
      { home: "Home XI", away: "Away XI" },
      locale,
    ),
  );

describe("FixturePage — the public stream link (stream overlay W1, §3.9)", () => {
  it("a live fixture with a saved link renders it, opening at that exact URL", async () => {
    const html = await streamHtml({ status: "in_play", stream_url: TWITCH });
    expect(html).toContain('data-testid="public-stream-link"');
    // The value, not merely the attribute: `href="` anchors it (a bare
    // `data-*`/attribute probe passes against React's own `"$undefined"`).
    expect(html).toContain(`href="${TWITCH}"`);
    expect(html).toContain('target="_blank"');
    // R16's second, independent guard: `target="_blank"` without `noopener`
    // hands the opened tab a `window.opener` handle to this page, and the
    // href is organiser-supplied.
    expect(html).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/);
    expect(html).toContain(`>${publicEn["overlay.watchLive"]}</a>`);
  });

  it("a DIFFERENT saved link opens at that one — the href is the fixture's, not a constant", async () => {
    const html = await streamHtml({ status: "in_play", stream_url: YOUTUBE });
    expect(html).toContain(`href="${YOUTUBE}"`);
    expect(html).not.toContain(TWITCH);
  });

  it("the link sits under the headline and above the match centre, never inside it", async () => {
    const html = await streamHtml({ status: "in_play", stream_url: TWITCH });
    const link = html.indexOf('data-testid="public-stream-link"');
    const headline = html.indexOf("<h1");
    const centre = html.indexOf('data-testid="mc-court-card"');
    expect(headline, "the headline is rendered at all").toBeGreaterThanOrEqual(0);
    expect(centre, "the match centre is rendered at all").toBeGreaterThanOrEqual(0);
    expect(link).toBeGreaterThan(headline);
    expect(link).toBeLessThan(centre);
  });

  for (const status of ["scheduled", "in_play"] as const) {
    it(`${status} reads "Watch live", never "Replay"`, async () => {
      const html = await streamHtml({ status, stream_url: TWITCH });
      expect(html).toContain(`>${publicEn["overlay.watchLive"]}</a>`);
      expect(html).not.toContain(`>${publicEn["overlay.replay"]}</a>`);
    });
  }

  for (const status of ["decided", "finalized"] as const) {
    it(`${status} reads "Replay", never "Watch live"`, async () => {
      const html = await streamHtml({ status, stream_url: TWITCH });
      expect(html).toContain(`>${publicEn["overlay.replay"]}</a>`);
      expect(html).not.toContain(`>${publicEn["overlay.watchLive"]}</a>`);
    });
  }

  // The positive assertions above are each satisfied by "render the anchor
  // always"; these two are the negative half of the pair.
  it("no saved link renders NO anchor at all — not an empty or dead one", async () => {
    const html = await streamHtml({ status: "in_play", stream_url: null });
    expect(html).not.toContain("public-stream-link");
    expect(html).not.toContain(publicEn["overlay.watchLive"] as string);
  });

  for (const status of ["cancelled", "abandoned", "forfeited"] as const) {
    it(`a ${status} fixture shows no link even with one saved (§3.9 VOID_STATUSES)`, async () => {
      const html = await streamHtml({ status, stream_url: TWITCH });
      expect(html).not.toContain("public-stream-link");
      expect(html).not.toContain(TWITCH);
    });
  }

  // A key-existence check passes whether the label is wired or hardcoded
  // English; only a locale differential can tell the two apart.
  for (const locale of ["es", "fr", "nl"] as const) {
    it(`locale=${locale} labels the link from ITS OWN dictionary, not English`, async () => {
      const dict = PUBLIC_DICTS[locale]!;
      const live = await streamHtml({ status: "in_play", stream_url: TWITCH }, locale);
      const ended = await streamHtml({ status: "decided", stream_url: TWITCH }, locale);
      expect(live).toContain(`>${dict["overlay.watchLive"]}</a>`);
      expect(ended).toContain(`>${dict["overlay.replay"]}</a>`);
      expect(live).not.toContain(`>${publicEn["overlay.watchLive"]}</a>`);
      expect(ended).not.toContain(`>${publicEn["overlay.replay"]}</a>`);
    });
  }
});
