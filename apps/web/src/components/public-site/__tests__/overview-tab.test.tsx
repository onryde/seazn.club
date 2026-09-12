// Spectator surface W2, Task 11 — the Overview tab.
//
// The owner-approved composition (Option B) makes ONE thing the subject of this
// file: **the section order is DERIVED from `landingStatus().kind`, not
// hardcoded and filtered.** So most of what is pinned below is a ladder, and
// the assertions are shaped for a ladder — a LIST of what rendered and where,
// never "does the page contain X", because the two defects a ladder ships are
// "everything is in the same place whatever the status" and "one rung answers
// for another", and both pass every containment check.
//
// `apps/web` vitest is `environment: "node"`: no DOM, no cascade, no layout.
// What that costs this file specifically is that the `lg` column split and the
// CSS `order` property are pinned as CLASS TOKENS on the elements that carry
// them, which is markup — it is not a claim that anything painted in that
// order. The paint belongs to the post-mount visual leg after Task 12, and no
// assertion here pretends otherwise.
//
// Two brief corrections are pinned rather than only recorded:
//  • `MatchCard` has NO `compact` prop — it was deliberately deleted in Task 7
//    review (`match-card.tsx:52-57` names this task), and the brief's Step 3
//    still passes one. Under TS that is an excess-property error, so the brief
//    as written does not compile; the `<li>` sizing IS the density, and it is
//    asserted below as such.
//  • the brief's `/data-testid="mh-table-row-/g` count matches ZERO.
//    `StandingsTableView` emits `${testid}-row-${entrantId}`
//    (`standings-table-view.tsx:273`), so with `testid="mh-table-preview-<id>"`
//    the rows are `mh-table-preview-<id>-row-<entrantId>`. The corrected form
//    is used below; the brief's would have read `undefined` against correct
//    code.
//
// Attribute-order note: every tag is read WHOLE through `tagOf`, the idiom
// Task 10's suite settled on. `next/link` spreads its props, so a
// `data-testid="…"[^>]*href="…"` probe silently depends on a serialisation
// order this file does not control — and the brief's own live-rail regex is
// written that way.
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { LandingStatus } from "@/lib/matches-hub";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import {
  OverviewTab,
  nextUpMatches,
  overviewPlan,
  type OverviewSection,
} from "../matches-hub/overview-tab";
import { division, hubDoc, info, m, tableRow, tableView } from "./hub-fixtures";

const dict = en as Dict;

/**
 * ONE sample of EVERY rung, keyed by kind.
 *
 * A `Record<LandingStatus["kind"], …>` and not a `[…] as LandingStatus[]`
 * (review N3). The array form was a cast, and a cast suppresses exactly the
 * alarm these loops exist to raise: adding a seventh member to `LandingStatus`
 * left the array at six, so `overviewPlan`'s `never` default would force a new
 * `case` to be written while nothing forced a test ROW — which is the
 * "hand-written coverage list that cannot fail when a rung appears" that
 * `overview-tab.tsx`'s own header argues against, reintroduced one layer up in
 * the suite. As a keyed record a new kind is a missing property, and the
 * typecheck gate reaches test files.
 */
const EVERY_RUNG = {
  empty: { kind: "empty" },
  live: { kind: "live", n: 1 },
  next: { kind: "next", at: "2026-09-05T13:00:00.000Z", tz: "Europe/London" },
  match_day: { kind: "match_day" },
  finished: { kind: "finished" },
  dates: { kind: "dates", startsOn: "2026-09-01", endsOn: null },
} satisfies Record<LandingStatus["kind"], LandingStatus>;

const ALL_RUNGS: LandingStatus[] = Object.values(EVERY_RUNG);

/** One instant, used as `now` everywhere, so every relative sentence and every
 *  ladder rung in this file is reproducible. Midday UTC on 5 September 2026,
 *  the day `hub-fixtures` dates its documents around. */
const NOW = Date.parse("2026-09-05T12:00:00.000Z");

interface RenderOver {
  dict?: Dict;
  locale?: Locale;
  now?: number;
  descriptionSlot?: ReactNode;
}

const render = (doc: CompetitionHubDocT, over: RenderOver = {}) =>
  renderToStaticMarkup(
    <OverviewTab
      doc={doc}
      dict={over.dict ?? dict}
      locale={over.locale ?? "en"}
      now={over.now ?? NOW}
      descriptionSlot={over.descriptionSlot}
    />,
  );

/** The whole OPENING TAG carrying a testid, attribute order irrelevant — Task
 *  10's `stats-teams-info-tabs.test.tsx:67` idiom, lifted rather than
 *  re-derived. */
const tagOf = (h: string, testid: string): string => {
  const at = h.indexOf(`data-testid="${testid}"`);
  expect(at, `${testid} is in the markup`).toBeGreaterThan(-1);
  return h.slice(h.lastIndexOf("<", at), h.indexOf(">", at) + 1);
};

/** One tag's class tokens. */
const classesOf = (h: string, testid: string): string[] =>
  tagOf(h, testid)
    .match(/class="([^"]*)"/)?.[1]
    ?.split(" ") ?? [];

/** One `<li>`'s markup, from its testid to the first `</li>` after it. Task
 *  10's `stats-teams-info-tabs.test.tsx` idiom: a claim about ONE card read off
 *  the whole panel is satisfied by any other card saying the same thing, and
 *  this file renders two rails at once on purpose. No card nests a list. */
const cardHtml = (h: string, testid: string): string => {
  const at = h.indexOf(`data-testid="${testid}"`);
  expect(at, `${testid} is in the markup`).toBeGreaterThan(-1);
  return h.slice(at, h.indexOf("</li>", at));
};

/**
 * Which section landed at which CSS `order`, in the order the ladder put them.
 *
 * A LIST of `[section, order]` pairs read off the rendered markup, because the
 * source order is NOT the visual order here: below `lg` the two column wrappers
 * are `display: contents`, so their children are the grid's own items and the
 * `order-N` class is what sequences them. An `indexOf` comparison would pin the
 * wrapper split instead, and would pass on a page whose ladder did nothing.
 */
function ladder(h: string): [OverviewSection, number][] {
  return [...h.matchAll(/data-testid="mh-sec-([a-z]+)"/g)]
    .map(([, id]) => {
      const token = classesOf(h, `mh-sec-${id}`).find((c) => /^order-\d+$/.test(c));
      expect(token, `mh-sec-${id} carries an order-N class`).toBeDefined();
      return [id as OverviewSection, Number(token!.slice("order-".length))] as [
        OverviewSection,
        number,
      ];
    })
    .sort((a, b) => a[1] - b[1]);
}

/** Just the section ids, top to bottom. */
const sections = (h: string): OverviewSection[] => ladder(h).map(([id]) => id);

/** The fixture ids in one of the two rails, in render order. A LIST, so
 *  "which matches" and "how many" are one assertion — a count alone is
 *  satisfied by a rail that took the wrong fixtures. */
const cardIds = (h: string, rail: "live-now" | "next-up"): string[] =>
  [...h.matchAll(new RegExp(`data-testid="mh-${rail}-card-([a-z0-9-]+)"`, "g"))].map(
    ([, id]) => id!,
  );

/** One section's markup, from its own testid to the next section's — so a
 *  negative assertion can be scoped to it rather than to the whole tab. */
function sectionHtml(h: string, id: OverviewSection): string {
  const start = h.indexOf(`data-testid="mh-sec-${id}"`);
  expect(start, `the ${id} section`).toBeGreaterThan(-1);
  const next = h.indexOf(`data-testid="mh-sec-`, start + 1);
  return next === -1 ? h.slice(start) : h.slice(start, next);
}

// ---------------------------------------------------------------- documents

/** Two live matches, pairwise distinct in every axis a mutant could confuse:
 *  different fixture ids, different divisions, different kick-off instants and
 *  four different entrant names. "Southend Queens" is the W0 defect's own
 *  witness — the live rail used to render scores with no names at all. */
const docLive2 = hubDoc({
  matches: [
    // Deliberately NOT in kick-off order in the document, so "the rail renders
    // document order" and "the rail renders soonest-first" are separable.
    m("l2", "live", "2026-09-05T11:30:00.000Z", "sunday-league", {
      header: {
        sides: [
          { entrantId: "e3", name: "Southend Queens", short: "SQN", colour: null, badgeUrl: null },
          { entrantId: "e4", name: "Harlow Foxes", short: "HFX", colour: null, badgeUrl: null },
        ],
      },
    }),
    m("l1", "live", "2026-09-05T10:00:00.000Z", "premier", {
      header: {
        sides: [
          { entrantId: "e1", name: "Riverside Rovers", short: "RIV", colour: null, badgeUrl: null },
          { entrantId: "e2", name: "Kings Park Kites", short: "KPK", colour: null, badgeUrl: null },
        ],
      },
    }),
  ],
});

/**
 * The live pair PLUS one upcoming fixture.
 *
 * A `live` rung does NOT imply an upcoming one — a competition whose last two
 * fixtures are both in play has a live rail and nothing to come — so the
 * six-section ladder is only reachable on a document that carries both, and
 * `docLive2` alone renders five sections. That is correct behaviour and it is
 * exactly the kind of accident that makes a ladder test read as a subsequence,
 * so the two documents are kept separate and named for what they carry.
 */
const LIVE_AND_NEXT = [
  ...docLive2.matches,
  m("u1", "upcoming", "2026-09-05T18:00:00.000Z", "premier"),
];

/** Four upcoming matches, all AHEAD of `NOW` (so the ladder reads `next`), at
 *  four distinct times, plus one five-row table so the preview cap is
 *  differential. The document order is again not the time order. */
const docUpcoming4 = hubDoc({
  matches: [
    m("u4", "upcoming", "2026-09-05T16:00:00.000Z", "premier"),
    m("u1", "upcoming", "2026-09-05T13:00:00.000Z", "premier"),
    m("u3", "upcoming", "2026-09-05T15:00:00.000Z", "premier"),
    m("u2", "upcoming", "2026-09-05T14:00:00.000Z", "premier"),
  ],
  tables: [
    tableView("t8-s1-overall", "premier", {
      rows: [
        tableRow("e1", 1),
        tableRow("e2", 2),
        tableRow("e3", 3),
        tableRow("e4", 4),
        tableRow("e5", 5),
      ],
    }),
  ],
});

describe("OverviewTab — the status line", () => {
  it("EMPTY: the empty copy, and NOTHING else on the tab — no live rail, no next-up, no tables", () => {
    // A competition with no divisions answers "no" to every question below the
    // empty rung, which is exactly why `landingStatus` states it first. What
    // this pins is the SECOND half of that rule: an empty competition also has
    // no sections, so the tab is one sentence rather than three empty shells.
    const h = render(hubDoc({ divisions: [], matches: [], tables: [] }));
    expect(h).toContain(`data-testid="mh-status"`);
    expect(h).toContain(en["landing.status.empty"]);
    expect(tagOf(h, "mh-status")).toContain(`data-kind="empty"`);
    expect(h).not.toContain(`data-testid="mh-live-now"`);
    expect(h).not.toContain(`data-testid="mh-next-up"`);
    expect(h).not.toContain(`data-testid="mh-tables"`);
  });

  it("LIVE: NO status line — the rail says it, and the hero's chip already counted it", () => {
    // "Live now: 2 matches" used to render directly above a section headed
    // "Live now" holding exactly those two matches, on a page whose hero
    // carries a "2 live" chip. Three statements of one fact inside ~200px at
    // 320. The rail leads the rung, so the top of the panel still says what is
    // happening.
    const h = render(docLive2);
    expect(h).not.toContain(`data-testid="mh-status"`);
    expect(h).not.toContain("Live now: 2 matches");
    // The positive pair, and the half that keeps this from passing on a panel
    // that simply rendered nothing: the rail is there, first, with its own
    // heading.
    expect(h).toContain(`data-testid="mh-live-now"`);
    expect(sections(h)[0]).toBe("live");
    expect(h).toContain(en["landing.liveNow"]);

    // One live match, same rule — the singular had its own test because a
    // count that always reads `.other` is the plural defect, and that coverage
    // now belongs to the hero chip (`page.test.tsx`), which is where the count
    // still renders.
    const one = hubDoc({ matches: [m("l1", "live", "2026-09-05T10:00:00.000Z", "premier")] });
    expect(render(one)).not.toContain(`data-testid="mh-status"`);
  });

  it("NEXT: the earliest upcoming kick-off, in ITS OWN venue zone and not the viewer's", () => {
    const h = render(docUpcoming4);
    expect(tagOf(h, "mh-status")).toContain(`data-kind="next"`);
    // 13:00Z in Europe/London (the fixture zone, UTC+1 in September) is 14:00.
    // A status line formatted in UTC would read 13:00, and one formatted in a
    // fixed zone would read the same for every competition on the platform.
    expect(h).toContain("Next: Sat 5 Sept 14:00");
  });

  it("MATCH DAY: fixtures today whose kick-off has passed with nothing in play", () => {
    // Below `next` because a fixture still ahead of us has a TIME; above
    // `finished` because it is what catches the afternoon of the one day a
    // spectator came to watch. This is the rung an earlier wave missed
    // entirely, and the rung the renderer's `never` default now makes
    // impossible to miss.
    const h = render(
      hubDoc({ matches: [m("u1", "upcoming", "2026-09-05T09:00:00.000Z", "premier")] }),
    );
    expect(tagOf(h, "mh-status")).toContain(`data-kind="match_day"`);
    expect(h).toContain(en["landing.status.matchDay"]);
  });

  it("FINISHED: every fixture completed", () => {
    const h = render(
      hubDoc({ matches: [m("c1", "completed", "2026-09-01T10:00:00.000Z", "premier")] }),
    );
    expect(tagOf(h, "mh-status")).toContain(`data-kind="finished"`);
    expect(h).toContain(en["landing.status.finished"]);
  });

  it("DATES: both dates, formatted in UTC — a calendar date is a DAY, not an instant", () => {
    // `HubInfo.startsOn` is a pg `date`, so `new Date("2026-09-01")` is UTC
    // midnight and ANY zone behind UTC prints the day before. The division here
    // is in America/Los_Angeles precisely so a status line that reached for the
    // competition's own zone — the plausible mutation, and the live bug on
    // `page.tsx:74-75` of the public competition page — renders 31 August and
    // 19 September, and this assertion sees it.
    const h = render(
      hubDoc({
        divisions: [division("premier", { tz: "America/Los_Angeles" })],
        info: info({ startsOn: "2026-09-01", endsOn: "2026-09-20" }),
      }),
    );
    expect(tagOf(h, "mh-status")).toContain(`data-kind="dates"`);
    expect(h).toContain("1 September 2026 – 20 September 2026");
  });

  it("DATES, start only: the `datesFrom` key, not a range with an empty half", () => {
    const h = render(
      hubDoc({
        divisions: [division("premier")],
        info: info({ startsOn: "2026-09-01", endsOn: null }),
      }),
    );
    expect(h).toContain("From 1 September 2026");
    expect(h).not.toContain("–"); // positive pair for the range test above
  });

  it("DATES with NEITHER date: the status line is ABSENT, not a blank paragraph", () => {
    // The one rung with nothing to say. `landing.status.empty` would be a lie —
    // this competition HAS divisions — and an empty `<p>` is the "content that
    // failed to load" shape this surface's reviews keep catching.
    const h = render(
      hubDoc({
        divisions: [division("premier")],
        info: info({ startsOn: null, endsOn: null, registrationOpen: true }),
      }),
    );
    expect(h).not.toContain(`data-testid="mh-status"`);
    // Positive pair: the tab still rendered, and the ladder still ran.
    expect(h).toContain(`data-testid="mh-overview"`);
    expect(sections(h)).toEqual(["register"]);
  });

  it("translates: the status line is dictionary copy, never English baked in", () => {
    // Proven on the `finished` rung rather than `live`, which no longer has a
    // status line at all. `finished` is the right replacement because its
    // sentence is bare copy — `next`'s embeds a formatted date, so a passing
    // assertion there would be partly about `fmtDate` rather than about the
    // dictionary.
    const finished = hubDoc({
      matches: [m("c1", "completed", "2026-09-01T10:00:00.000Z", "premier")],
      info: info({ registrationOpen: true }),
    });
    const h = render(finished, { dict: es as Dict, locale: "es" });
    expect(h).toContain(es["landing.status.finished"]);
    expect(h).not.toContain("Finished");
  });
});

describe("OverviewTab — the ladder decides the ORDER, and the order alone", () => {
  // The whole point of Option B: `landingStatus().kind` picks the section
  // sequence. These are read as LISTS so "everything always renders in the same
  // place" cannot pass, and every list below differs from every other.
  //
  // Both slots are given on every document here, and `registrationOpen` is true
  // on every one of them. A section with nothing to say is ABSENT by design, so
  // a ladder read off a document that could only fill three of six sections
  // would be a subsequence, and could not separate "this rung excludes the
  // tables" from "this document has no table". Given everything it could show,
  // what a rung does NOT show is the rung's own decision.
  const SLOTS: RenderOver = {
    descriptionSlot: <p>ABOUT THIS CUP</p>,
  };
  const preview = tableView("t8-s1-overall", "premier");
  const open = info({ startsOn: "2026-09-01", endsOn: "2026-09-20", registrationOpen: true });

  it("live: the Live-now rail LEADS, then next up, then the tables", () => {
    const doc = hubDoc({ matches: LIVE_AND_NEXT, tables: [preview], info: open });
    expect(sections(render(doc, SLOTS))).toEqual([
      "live",
      "next",
      "tables",
      "register",
      "description",
    ]);
  });

  it("no live rung: next-up leads and there is NO rail at all — not an empty one", () => {
    const doc = hubDoc({ matches: docUpcoming4.matches, tables: [preview], info: open });
    const h = render(doc, SLOTS);
    expect(sections(h)).toEqual(["next", "tables", "register", "description"]);
    // Absent, not empty — a `<ul>` with no children is a hole in the page.
    expect(h).not.toContain(`data-testid="mh-live-now"`);
  });

  it("match day: the same order as next — today's overdue fixtures ARE the most live thing", () => {
    const doc = hubDoc({
      matches: [m("u1", "upcoming", "2026-09-05T09:00:00.000Z", "premier")],
      tables: [preview],
      info: open,
    });
    const h = render(doc, SLOTS);
    expect(tagOf(h, "mh-status")).toContain(`data-kind="match_day"`);
    expect(sections(h)).toEqual(["next", "tables", "register", "description"]);
  });

  it("finished: the TABLE leads, and next-up is not in the order at all", () => {
    // `finished` means every fixture is completed, so the upcoming set is empty
    // BY CONSTRUCTION — a `next` entry in this rung's order could never render
    // anything, and a section nothing can fill is not an order decision, it is
    // dead weight that makes the next reader believe a case exists.
    const doc = hubDoc({
      matches: [m("c1", "completed", "2026-09-01T10:00:00.000Z", "premier")],
      tables: [preview],
      info: open,
    });
    expect(sections(render(doc, SLOTS))).toEqual([
      "tables",
      "register",
      "description",
    ]);
  });

  it("dates: the register CTA LEADS, and there is neither rail nor next-up nor table preview", () => {
    // Owner ruling, Option B: on a competition that has not started, the one
    // thing a visitor can DO leads. The table preview is EXCLUDED FROM THIS
    // RUNG'S ORDER rather than merely empty — a competition with dates and a
    // standings table is reachable (a season entered in bulk), and previewing
    // it above the sign-up would bury the call to action. So the document here
    // carries a table and the tab still shows none.
    const doc = hubDoc({ divisions: [division("premier")], tables: [preview], info: open });
    const h = render(doc, SLOTS);
    expect(tagOf(h, "mh-status")).toContain(`data-kind="dates"`);
    expect(sections(h)).toEqual(["register", "description"]);
    expect(h).not.toContain(`data-testid="mh-tables"`);
  });

  it("empty: the same order as dates — a competition with nothing published still has a way in", () => {
    const h = render(hubDoc({ divisions: [], info: open }), SLOTS);
    expect(tagOf(h, "mh-status")).toContain(`data-kind="empty"`);
    expect(sections(h)).toEqual(["register", "description"]);
  });

  it("the order VALUES are 1..n with no gaps and no repeats — two sections at one order is no order", () => {
    const doc = hubDoc({ matches: LIVE_AND_NEXT, tables: [preview], info: open });
    expect(ladder(render(doc, SLOTS)).map(([, n]) => n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a live rung with nothing to come drops next-up and RENUMBERS — the order is over what shows", () => {
    // The `live` rung's order carries `next`, and a competition whose last
    // fixtures are all in play has no upcoming one. The section is absent and
    // the ones after it close the gap, rather than leaving `order-2` unused
    // and the tables at 3 — which is invisible to CSS and confusing to read.
    const doc = hubDoc({ matches: docLive2.matches, tables: [preview], info: open });
    expect(ladder(render(doc, SLOTS))).toEqual([
      ["live", 1],
      ["tables", 2],
      ["register", 3],
      ["description", 4],
          ]);
  });

  it("a rung the renderer does not handle THROWS rather than rendering a wrong page", () => {
    // R1's whole reason. `LandingStatus` has SIX rungs and the dictionary
    // coverage list that was supposed to catch a new one is hand-written, so it
    // cannot fail when a rung appears. The renderer can: under `tsc` a seventh
    // rung is a compile error at the `never`, and at runtime it is this throw.
    const rogue = { kind: "playoffs" } as unknown as LandingStatus;
    expect(() => overviewPlan(rogue, dict)).toThrow(/playoffs/);
  });

  it("each rung's ORDER is pinned as itself, not only as what a document happened to render", () => {
    // The mutation sweep is why this test exists and why it reads the plan
    // rather than the markup. Swapping `finished`'s order for `next`'s SURVIVED
    // every render-level assertion in this file, and it survives them for a
    // sound reason: `finished` means every fixture is completed, so the
    // upcoming set is empty by construction, the `next` section renders nothing
    // and is filtered out, and the two orders produce byte-identical markup on
    // every document that can reach that rung. The difference is real but it
    // exists only in the DECLARATION — so that is the layer it is pinned at.
    //
    // Pinned as whole arrays rather than "contains"/"does not contain": the
    // defect a ladder ships is a wrong POSITION, and every containment check
    // passes on a shuffled list.
    const orderOf = (s: LandingStatus) => overviewPlan(s, dict).order;
    expect(orderOf({ kind: "live", n: 1 })).toEqual([
      "live",
      "next",
      "tables",
      "register",
      "description",
    ]);
    expect(orderOf({ kind: "next", at: "2026-09-05T13:00:00.000Z", tz: "Europe/London" })).toEqual([
      "next",
      "tables",
      "register",
      "description",
    ]);
    // `match_day` SHARES `next`'s order and differs only in what it says. The
    // two are asserted separately, so a later change to one cannot silently
    // move the other.
    expect(orderOf({ kind: "match_day" })).toEqual([
      "next",
      "tables",
      "register",
      "description",
    ]);
    expect(orderOf({ kind: "finished" })).toEqual([
      "tables",
      "register",
      "description",
    ]);
    expect(orderOf({ kind: "dates", startsOn: null, endsOn: null })).toEqual([
      "register",
      "description",
    ]);
    expect(orderOf({ kind: "empty" })).toEqual(["register", "description"]);
    // And the scope pairs with the order EXACTLY: non-null when the rung
    // renders the rail, null when it does not. Without this the three rungs
    // that never show next-up could carry any scope at all — a dead value no
    // mutant can kill, which is what the sweep found (setting `finished`'s to
    // "ahead" survived everything).
    for (const rung of ALL_RUNGS) {
      const plan = overviewPlan(rung, dict);
      expect(plan.nextUp !== null, `${rung.kind} pairs its scope with its order`).toBe(
        plan.order.includes("next"),
      );
    }
    // The two rungs that DO render it disagree about what "next" means, which
    // is the whole reason the scope exists — asserted by value, so collapsing
    // them to one predicate reds here as well as in the render tests.
    expect(overviewPlan({ kind: "live", n: 1 }, dict).nextUp).toBe("ahead");
    expect(
      overviewPlan({ kind: "next", at: "2026-09-05T13:00:00.000Z", tz: "UTC" }, dict).nextUp,
    ).toBe("ahead");
    expect(overviewPlan({ kind: "match_day" }, dict).nextUp).toBe("today");
    // `live` is the only rung that can carry a live match — every other rung
    // sits below `landingStatus`'s own live check — so a `"live"` entry in any
    // other order would be a section that provably cannot render.
    for (const rung of ALL_RUNGS.filter((r) => r.kind !== "live")) {
      expect(orderOf(rung), rung.kind).not.toContain("live");
    }
  });

  it("every rung `landingStatus` can return IS handled — enumerated, not sampled", () => {
    // The positive pair for the throw above, and the thing that would have
    // caught `match_day` when it was missed. Driven off `ALL_RUNGS` rather than
    // a hand-written list — an ANNOTATED array (`const x: LandingStatus[] = […]`)
    // has the same hole as the cast N3 was filed about: it accepts six entries
    // for a seven-member union without complaint.
    for (const rung of ALL_RUNGS) {
      const plan = overviewPlan(rung, dict);
      if (rung.kind === "live") {
        // THE ONE EXEMPTION, pinned rather than excused. The live rung's
        // sentence said "Live now: 1 match" directly above a section headed
        // "Live now" holding exactly that match, on a page whose hero already
        // carries a "1 live" chip. The rail IS the top of the panel here
        // (`LIVE_ORDER` puts `live` first), so the rule this guard protects —
        // the top of the panel says what is happening — is still satisfied.
        //
        // Asserted as `toBeNull`, not skipped: a `live` rung that started
        // producing copy again would red here, which is the whole point of
        // enumerating the union.
        expect(plan.copy, rung.kind).toBeNull();
        expect(plan.order[0], "the rail leads the live rung").toBe("live");
        expect(plan.order.length, rung.kind).toBeGreaterThan(0);
        continue;
      }
      expect(plan.copy, rung.kind).not.toBeNull();
      // The copy is a SENTENCE, not the key that was looked up — `t()` returns
      // the key itself on a miss, so this is what separates "rendered" from
      // "silently missing from the dictionary".
      expect(plan.copy, rung.kind).not.toMatch(/^landing\.status\./);
      expect(plan.order.length, rung.kind).toBeGreaterThan(0);
    }
  });
});

describe("OverviewTab — the Live-now rail", () => {
  it("one card per live match, WITH team names, in a focusable named scroll region", () => {
    const h = render(docLive2);
    const rail = tagOf(h, "mh-live-now");
    // AGENTS.md 23: a scrolling region owes a tab stop, a role and an
    // accessible name, or axe reds at SERIOUS impact.
    expect(rail).toContain(`role="list"`);
    expect(rail).toContain(`tabindex="0"`);
    // Named BY the visible heading (review M5), not by a second copy of the
    // same string — a screen reader announced "Live now, heading" then "Live
    // now, list". And the reference is checked to RESOLVE: an
    // `aria-labelledby` pointing at nothing leaves the region with no
    // accessible name at all, which a duplicated `aria-label` could not get
    // wrong. That is the risk the new mechanism adds, so it is the thing
    // asserted.
    expect(rail).toContain(`aria-labelledby="mh-live-now-label"`);
    expect(h).toMatch(/id="mh-live-now-label"[^>]*>[^<]*Live now/);
    expect(h.match(/data-testid="mh-live-now-card-/g)?.length).toBe(2);
    // The W0 defect: the rail rendered scores with no names. All four names, so
    // a card bound to one side only is visible.
    for (const name of ["Southend Queens", "Harlow Foxes", "Riverside Rovers", "Kings Park Kites"]) {
      expect(h).toContain(name);
    }
  });

  it("all three list names come from the DICTIONARY, not from English literals", () => {
    // The name now travels through the heading, so THIS is the assertion that
    // keeps it translated — and it covers all three lists rather than the rail
    // alone, because the same `aria-labelledby` rewrite touched all three and a
    // one-list assertion would leave two of them unwitnessed.
    const doc = hubDoc({
      matches: [...docLive2.matches, m("u1", "upcoming", "2026-09-05T18:00:00.000Z", "premier")],
      tables: [tableView("t8-s1-overall", "premier")],
    });
    const h = render(doc, { dict: es as Dict, locale: "es" });
    for (const [testid, key] of [
      ["mh-live-now", "landing.liveNow"],
      ["mh-next-up", "landing.nextUp"],
      ["mh-tables", "landing.tables"],
    ] as const) {
      expect(tagOf(h, testid), testid).toContain(`aria-labelledby="${testid}-label"`);
      expect(h, testid).toMatch(
        new RegExp(`id="${testid}-label"[^>]*>[^<]*${es[key].replace(/[.*+?^$()|[\]\\]/g, "\\$&")}`),
      );
    }
    // Positive pair: the English strings are nowhere in the Spanish render.
    expect(h).not.toContain(en["landing.liveNow"]);
    expect(h).not.toContain(en["landing.nextUp"]);
  });

  it("soonest kick-off first, not document order", () => {
    // The fixture document lists l2 (11:30) before l1 (10:00) precisely so
    // "renders whatever order it was handed" is a different answer from this.
    const h = render(docLive2);
    expect(h.indexOf(`data-testid="mh-live-now-card-l1"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-live-now-card-l2"`),
    );
  });

  it("the card carries its own width floor and ceiling — that IS the rail's density", () => {
    // `MatchCard` has no `compact` prop (Task 7's review deleted it as dead
    // rather than leave a caller believing it worked), so the `<li>` is what
    // makes a rail card a rail card. `shrink-0` is the half that matters in a
    // scrolling flex row: without it every card squashes to fit and the rail
    // never scrolls at all.
    const classes = classesOf(render(docLive2), "mh-live-now-card-l1");
    expect(classes).toContain("shrink-0");
    expect(classes).toContain("min-w-[260px]");
    expect(classes).toContain("max-w-[320px]");
  });

  it("a rail card's crest is 32; a next-up card's is 24 — both off ONE render", () => {
    // The rail is the only place on this page where a card is a hero rather
    // than a row: two names, a score, and the whole 260-320px card. Next up is
    // a three-column grid of rows, where the NAME is the identifier and a
    // bigger badge costs name width — so the two sizes are a DECISION, and a
    // decision read off one render is the only way to see that the rail did not
    // simply inherit whatever the card defaults to.
    //
    // `LIVE_AND_NEXT` is the document that carries both, which is why this is
    // not two renders compared across tests: on `docLive2` there is no next-up
    // section at all and the comparison would be against nothing.
    const h = render(hubDoc({ matches: LIVE_AND_NEXT }));
    expect(cardHtml(h, "mh-live-now-card-l1")).toContain("h-8 w-8");
    expect(cardHtml(h, "mh-live-now-card-l1")).not.toContain("h-6 w-6");
    expect(cardHtml(h, "mh-next-up-card-u1")).toContain("h-6 w-6");
    expect(cardHtml(h, "mh-next-up-card-u1")).not.toContain("h-8 w-8");
  });

  it("a competition with live matches in only one division still shows every one of them", () => {
    // The negative this pairs with is a rail accidentally scoped to one
    // division, which a two-division fixture cannot separate from a correct one
    // by count alone.
    const same = hubDoc({
      matches: [
        m("l1", "live", "2026-09-05T10:00:00.000Z", "premier"),
        m("l2", "live", "2026-09-05T10:30:00.000Z", "premier"),
        m("l3", "live", "2026-09-05T11:00:00.000Z", "premier"),
      ],
    });
    expect(render(same).match(/data-testid="mh-live-now-card-/g)?.length).toBe(3);
  });
});

describe("OverviewTab — next up and the table previews", () => {
  it("an OVERDUE fixture is not 'next' — the rail and the status line must name the same match", () => {
    // Review I1, and the finding neither the 773-test suite nor a 40-mutant
    // sweep could see, because NO document in the suite carried a
    // past-but-still-`upcoming` fixture. `bucket` is derived from the wire
    // status alone (`lib/matches-hub.ts:39-41`), so a fixture nobody started
    // stays `upcoming` for ever, while `landingStatus` deliberately drops past
    // kick-offs — "the page must not promise a kick-off that is already behind
    // us". The two sections of one panel therefore disagreed ON SCREEN: the
    // status announced Saturday's 15:00 while the first card under "Next up"
    // was four days stale.
    const doc = hubDoc({
      matches: [
        m("stale", "upcoming", "2026-09-01T09:00:00.000Z", "premier"),
        m("real", "upcoming", "2026-09-05T14:00:00.000Z", "premier"),
      ],
    });
    const h = render(doc);
    // Both halves on ONE render, which is what makes it an agreement test
    // rather than two independent assertions.
    expect(tagOf(h, "mh-status")).toContain(`data-kind="next"`);
    expect(h).toContain("Next: Sat 5 Sept 15:00"); // 14:00Z = 15:00 in Europe/London
    expect(cardIds(h, "next-up")).toEqual(["real"]);
  });

  it("on NEXT, a fixture on a LATER DAY is still next up — the scope is ahead-of-now, not today", () => {
    // The mirror of the match-day test, and the sweep is why it exists:
    // scoping `next` as `"today"` SURVIVED every assertion above, because every
    // document that reaches the `next` rung in this file happens to have its
    // fixtures on the same day as `now`. A competition whose next match is
    // tomorrow would have rendered "Next: Sun 6 Sept 14:00" above an EMPTY
    // next-up section — or rather above no section at all, since an empty one
    // is absent by design, which is the quieter version of the same bug.
    const doc = hubDoc({
      matches: [m("tomorrow", "upcoming", "2026-09-06T14:00:00.000Z", "premier")],
    });
    const h = render(doc);
    expect(tagOf(h, "mh-status")).toContain(`data-kind="next"`);
    expect(cardIds(h, "next-up")).toEqual(["tomorrow"]);
    expect(sections(h)).toContain("next");
  });

  it("MATCH DAY heads the section 'Today', not 'Next up' — an overdue card is not next", () => {
    // Review N2. The filter is right on this rung and stays: today's card is
    // still the day's card. The HEADING was the lie — a fixture that kicked off
    // three hours ago sitting under "Next up" is the same promise-you-cannot-
    // keep the `"ahead"` filter exists to stop, one element higher.
    //
    // The scope picks the word as well as the window, so the two cannot drift.
    const matchDay = hubDoc({
      matches: [m("today-1", "upcoming", "2026-09-05T09:00:00.000Z", "premier")],
    });
    const h = render(matchDay);
    expect(tagOf(h, "mh-status")).toContain(`data-kind="match_day"`);
    expect(h).toMatch(/id="mh-next-up-label"[^>]*>[^<]*Today</);
    expect(h).not.toContain(en["landing.nextUp"]);

    // Differential against the rung next door, on the same assertion: a genuine
    // `next` still reads "Next up". Without this pair, a heading hardcoded to
    // "Today" would pass the test above.
    const ahead = hubDoc({
      matches: [m("u1", "upcoming", "2026-09-05T14:00:00.000Z", "premier")],
    });
    const a = render(ahead);
    expect(tagOf(a, "mh-status")).toContain(`data-kind="next"`);
    expect(a).toMatch(/id="mh-next-up-label"[^>]*>[^<]*Next up</);
    expect(a).not.toContain(en["landing.today"]);
  });

  /** React's own text escaping, so an assertion compares like with like. */
  const escapeHtml = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");

  // Re-review P4 — this test was titled "in all four locales" and rendered
  // SPANISH only. The title was the thing under test as far as a reader was
  // concerned, and it was false: fr and nl could each have carried the English
  // word and nothing here would have said so. Read what a test ASSERTS, never
  // what it is called — the fix is to render the four rather than to rename the
  // one, because the four are what the claim was worth.
  it.each([
    ["es", es],
    ["fr", fr],
    ["nl", nl],
  ])("the Today heading is %s dictionary copy, not an English literal", (locale, dict) => {
    const matchDay = hubDoc({
      matches: [m("today-1", "upcoming", "2026-09-05T09:00:00.000Z", "premier")],
    });
    const h = render(matchDay, { dict: dict as Dict, locale: locale as Locale });
    // ESCAPED, not raw. French is "Aujourd'hui" and React serialises the
    // apostrophe as `&#x27;`, so a raw comparison reds on correct output. The
    // Spanish-only version of this test could never have shown that — "Hoy"
    // has nothing to escape — which is the second thing rendering all three
    // bought beyond the title being true.
    expect(h).toMatch(new RegExp(`id="mh-next-up-label"[^>]*>[^<]*${escapeHtml(dict["landing.today"])}`));
    // The negative pair, and it is only meaningful while the locale's own word
    // DIFFERS from English — assert that first, or this passes vacuously the
    // day a translation happens to coincide (nl `landing.sponsors` is
    // "Sponsors", which is exactly how that trap has bitten this repo before).
    expect(dict["landing.today"]).not.toBe(en["landing.today"]);
    expect(h).not.toContain(en["landing.today"]);
  });

  it("while a match is LIVE, an overdue fixture is not smuggled under a 'Next up' heading", () => {
    // Review N2's other half: the `live` rung's scope was pinned by VALUE only,
    // so no render test said which fixtures its rail actually shows. The
    // document carries a live match AND an overdue-today upcoming one.
    //
    // `live: "ahead"` is a CHOICE, not forced by `landingStatus` (which returns
    // at its live check and never computes a next fixture): while something is
    // in play the live rail is the story, and a section headed "Next up" has to
    // mean what it says. Nothing is hidden — the overdue fixture surfaces under
    // "Today" the moment the ladder drops to `match_day`, which the test above
    // pins.
    const doc = hubDoc({
      matches: [
        m("now-live", "live", "2026-09-05T11:00:00.000Z", "premier"),
        m("overdue", "upcoming", "2026-09-05T09:00:00.000Z", "premier"),
      ],
    });
    const h = render(doc);
    // The rung is proven by the LADDER it produced, not by the status line's
    // `data-kind` — the live rung no longer has a status line, and the rail
    // leading the order is the same fact stated where it still exists.
    expect(sections(h)[0], "the live rung leads with its rail").toBe("live");
    expect(cardIds(h, "live-now")).toEqual(["now-live"]);
    expect(cardIds(h, "next-up")).toEqual([]);
    // Absent, not an empty shell headed with a promise.
    expect(sections(h)).not.toContain("next");
  });

  it("MATCH DAY keeps today's overdue fixtures — the rung would otherwise empty its own rail", () => {
    // The other half of the same decision, and the reason the scope is a RUNG
    // decision rather than one predicate. `match_day` is reached only when no
    // upcoming fixture is ahead of `now` (`next` is checked first and would
    // have won), so filtering on "ahead" here would show nothing at all and
    // silently drop the rung's whole point — the afternoon of the one day a
    // spectator came to watch. Every fixture it shows is overdue, deliberately.
    //
    // The document carries a fixture from a PREVIOUS day as well, so "today's"
    // and "all upcoming" are different answers and the assertion can tell them
    // apart.
    const doc = hubDoc({
      matches: [
        m("lastweek", "upcoming", "2026-08-29T09:00:00.000Z", "premier"),
        m("today-1", "upcoming", "2026-09-05T09:00:00.000Z", "premier"),
        m("today-2", "upcoming", "2026-09-05T10:30:00.000Z", "premier"),
      ],
    });
    const h = render(doc);
    expect(tagOf(h, "mh-status")).toContain(`data-kind="match_day"`);
    expect(cardIds(h, "next-up")).toEqual(["today-1", "today-2"]);
  });

  it("the scope is the fixture's OWN venue day — and the case is differential BOTH ways against UTC", () => {
    // A 23:30 kick-off in Los Angeles is still 5 September there while it is
    // already the 6th in UTC, which is what makes a zone-blind implementation
    // wrong rather than merely unprincipled. Both instants below separate the
    // two answers; an assertion where LA and UTC happened to agree would prove
    // nothing, which is the trap this file's `fmtDate` tests already record.
    //
    //   fixture 2026-09-06T06:30Z → LA day 09-05, UTC day 09-06
    const late = m("late", "upcoming", "2026-09-06T06:30:00.000Z", "premier", {
      tz: "America/Los_Angeles",
    });
    //   now 2026-09-05T20:00Z → LA 13:00 on 09-05 (MATCHES), UTC day 09-05 (does not)
    //   → correct: included. Zone-blind: dropped.
    const sameDayInLA = Date.parse("2026-09-05T20:00:00.000Z");
    expect(nextUpMatches([late], "today", sameDayInLA).map((x) => x.fixtureId)).toEqual(["late"]);
    //   now 2026-09-06T12:00Z → LA 05:00 on 09-06 (does not match), UTC day 09-06 (matches)
    //   → correct: dropped. Zone-blind: included.
    const nextDayInLA = Date.parse("2026-09-06T12:00:00.000Z");
    expect(nextUpMatches([late], "today", nextDayInLA)).toEqual([]);

    // Re-review P2 — the two assertions above are differential for a mutant
    // that zone-blinds BOTH sides, and blind to one that zone-blinds only the
    // `now` side. Above, LA's day and UTC's day for `now` happen to coincide in
    // exactly the way that keeps the verdict unchanged, so
    // `dayKeyInZone(nowIso, "UTC")` survives them. A comparison has two sides
    // and a test that fixes one of them only proves the other.
    //
    // Tokyo separates them: UTC+9 puts `now` on a different UTC day from its
    // own venue day, which LA (behind UTC) cannot do at these hours.
    //
    //   fixture 2026-09-06T01:00Z → Tokyo 10:00 on 09-06
    const tokyo = m("tokyo", "upcoming", "2026-09-06T01:00:00.000Z", "premier", {
      tz: "Asia/Tokyo",
    });
    //   now 2026-09-05T22:00Z → Tokyo 07:00 on 09-06 (MATCHES the fixture's day),
    //   while the same instant is still 09-05 in UTC (does not).
    //   → correct: included. `now` read in UTC: dropped.
    const tokyoMorning = Date.parse("2026-09-05T22:00:00.000Z");
    expect(nextUpMatches([tokyo], "today", tokyoMorning).map((x) => x.fixtureId)).toEqual([
      "tokyo",
    ]);
  });

  it("an UNSCHEDULED fixture is in neither scope — 'next up' with no time is a blank, not a teaser", () => {
    const undated = m("tbd", "upcoming", null, "premier");
    const dated = m("real", "upcoming", "2026-09-05T14:00:00.000Z", "premier");
    expect(nextUpMatches([undated, dated], "ahead", NOW).map((x) => x.fixtureId)).toEqual(["real"]);
    expect(nextUpMatches([undated], "today", NOW)).toEqual([]);
    // `landingStatus`'s own `next` rung skips them for the same reason, and the
    // Matches tab lists them under their own Unscheduled heading.
    expect(nextUpMatches([undated], "ahead", NOW)).toEqual([]);
  });

  it("a null scope shows nothing, and an unusable clock does not throw out of a render", () => {
    const one = [m("u1", "upcoming", "2026-09-05T14:00:00.000Z", "premier")];
    // `null` is the rungs that do not render the rail at all.
    expect(nextUpMatches(one, null, NOW)).toEqual([]);
    // `new Date(NaN).toISOString()` THROWS, and `now` is a caller's value.
    expect(() => nextUpMatches(one, "today", Number.NaN)).not.toThrow();
    expect(nextUpMatches(one, "today", Number.NaN)).toEqual([]);
    expect(() => nextUpMatches(one, "ahead", Number.NaN)).not.toThrow();
  });

  it("the rail and the status line agree at EVERY clock value, NaN included", () => {
    // Review N1. The two halves guarded the same boundary in OPPOSITE
    // directions: `landingStatus` excludes on `at < nowMs`, which is false for
    // everything when `now` is NaN, so it returned `{kind:"next"}`; the rail
    // included on `at >= now`, which is ALSO false for everything, so it
    // rendered nothing. A sentence promising a kick-off above a panel with no
    // sections at all — I1's defect in the quiet direction, and the round that
    // fixed I1 added a NaN guard and a test that implied this case was handled.
    //
    // `!(at < now)` mirrors the exclusion instead of re-deriving its negation,
    // so the agreement is TOTAL rather than true-for-finite-clocks.
    const doc = hubDoc({
      matches: [m("u1", "upcoming", "2026-09-05T14:00:00.000Z", "premier")],
    });
    const h = render(doc, { now: Number.NaN });
    expect(tagOf(h, "mh-status")).toContain(`data-kind="next"`);
    // The promise is kept: the fixture the status line is about is on screen.
    expect(cardIds(h, "next-up")).toEqual(["u1"]);
    expect(sections(h)).toContain("next");
    // And the unit-level statement of the same rule, so the mirroring is pinned
    // where it is written and not only through a render.
    expect(nextUpMatches(doc.matches, "ahead", Number.NaN).map((x) => x.fixtureId)).toEqual(["u1"]);
    // A `scheduledAt` that will not parse is still excluded by BOTH halves —
    // the `Number.isNaN(at)` clause mirrors `landingStatus`'s `at === null`.
    const bad = [m("junk", "upcoming", "not-a-date", "premier")];
    expect(nextUpMatches(bad, "ahead", Number.NaN)).toEqual([]);
    expect(nextUpMatches(bad, "ahead", NOW)).toEqual([]);
  });

  it("a fixture starting at EXACTLY now is still next — no one-millisecond hole", () => {
    // Inclusive at the boundary, matching `landingStatus`'s own rule, so the
    // status line and the rail cannot disagree for the millisecond in between.
    const exact = m("exact", "upcoming", "2026-09-05T12:00:00.000Z", "premier");
    expect(nextUpMatches([exact], "ahead", NOW).map((x) => x.fixtureId)).toEqual(["exact"]);
    expect(nextUpMatches([exact], "ahead", NOW + 1)).toEqual([]);
  });

  it("the three EARLIEST upcoming matches only, though a fourth exists", () => {
    const h = render(docUpcoming4);
    expect(h.match(/data-testid="mh-next-up-card-/g)?.length).toBe(3);
    // WHICH three, not just how many: the document's first entry is the LAST
    // kick-off, so a `slice(0,3)` over document order keeps u4 and drops u3.
    for (const id of ["u1", "u2", "u3"]) {
      expect(h).toContain(`data-testid="mh-next-up-card-${id}"`);
    }
    expect(h).not.toContain(`data-testid="mh-next-up-card-u4"`);
    expect(h.indexOf("mh-next-up-card-u1")).toBeLessThan(h.indexOf("mh-next-up-card-u2"));
    expect(h.indexOf("mh-next-up-card-u2")).toBeLessThan(h.indexOf("mh-next-up-card-u3"));
  });

  it("the two rails PARTITION the document — each fixture is in exactly one of them, or neither", () => {
    // Found by the mutation sweep, which is the honest provenance: scoping the
    // live rail on `bucket !== "completed"` instead of `=== "live"` survived
    // every other assertion in this file, because the documents that counted
    // live cards had no upcoming fixture and the document that had one never
    // counted its live cards. A spectator would have read an upcoming match
    // under the "Live now" heading, and twice — once in each rail.
    //
    // So both rails are counted AND named on ONE document that carries all
    // three buckets. A count alone is not enough either: 1 and 1 is also what
    // "each rail took the first match it saw" produces.
    const mixed = hubDoc({
      matches: [
        m("l1", "live", "2026-09-05T10:00:00.000Z", "premier"),
        m("c1", "completed", "2026-09-01T10:00:00.000Z", "premier"),
        m("u1", "upcoming", "2026-09-05T13:00:00.000Z", "premier"),
      ],
    });
    const h = render(mixed);
    const ids = (rail: string) =>
      [...h.matchAll(new RegExp(`data-testid="mh-${rail}-card-([a-z0-9]+)"`, "g"))].map(
        ([, id]) => id,
      );
    expect(ids("live-now")).toEqual(["l1"]);
    expect(ids("next-up")).toEqual(["u1"]);
    // The completed fixture is in neither — the Matches tab owns Results.
    expect(h).not.toContain(`data-testid="mh-live-now-card-c1"`);
    expect(h).not.toContain(`data-testid="mh-next-up-card-c1"`);
  });

  it("each table previews its first THREE rows and keeps its full-division link", () => {
    const h = render(docUpcoming4);
    expect(h.match(/data-testid="mh-table-preview-t8-s1-overall-row-/g)?.length).toBe(3);
    expect(h).toContain(`data-testid="mh-table-preview-t8-s1-overall-full"`);
    // The rows it kept are the TOP three — a preview that took the last three
    // has the same count.
    for (const id of ["e1", "e2", "e3"]) {
      expect(h).toContain(`data-testid="mh-table-preview-t8-s1-overall-row-${id}"`);
    }
    expect(h).not.toContain(`data-testid="mh-table-preview-t8-s1-overall-row-e4"`);
  });

  it("at most THREE tables are previewed, however many the competition publishes (owner ruling)", () => {
    // The Overview is a summary; the Table tab carries the complete set,
    // grouped by division, one tap away on the rail. Uncapped, an eight-
    // division competition with two pools each put SIXTEEN previews in the
    // `lg` side rail.
    //
    // Five tables, pairwise-distinct ids, so this reds at four (a fourth id
    // appears) and at two (the third is missing) — a bare count would only
    // catch one of those directions.
    const five = hubDoc({
      matches: docUpcoming4.matches,
      tables: ["t1", "t2", "t3", "t4", "t5"].map((id) => tableView(id, "premier")),
    });
    const h = render(five);
    // One `-full` link per rendered view, so this is a count AND a roll-call.
    const ids = [...h.matchAll(/data-testid="mh-table-preview-(t[0-9])-full"/g)].map(
      ([, id]) => id!,
    );
    expect(ids).toEqual(["t1", "t2", "t3"]);
    // Deliberately NO "see all" affordance beside them and no new dictionary
    // key: the Table tab already is that affordance, and a second route to it
    // sitting next to the first is the duplicate-route problem in miniature.
    expect(h).not.toContain(`data-testid="mh-tables-more"`);
  });

  it("every preview names its DIVISION, on one-division documents as well as many", () => {
    // Final review C3 + C4. Commit 746583e97 fixed a defect found by driving
    // the built page — two divisions both running a league stage render two
    // tables whose captions both read "League" — in two halves. The
    // screen-reader half was pinned; the SIGHTED half was not, and replacing
    // its gate with `false` kept 329/329 green while restoring the exact
    // defect. A guard nothing kills is not tested.
    //
    // The gate itself is gone (C4): it was justified as "matching the rule the
    // Teams tab already follows", and no such rule exists — Teams, Table and
    // Stats all render their division heading unconditionally. The Overview was
    // the only surface with the gate, so a single-division competition showed
    // the division name on three tabs and not here.
    const two = hubDoc({
      matches: docUpcoming4.matches,
      tables: [
        tableView("premier-league", "premier", { caption: "League" }),
        tableView("sunday-league", "sunday-league", { caption: "League" }),
      ],
    });
    const h = render(two);
    // Both captions read "League", which is the document the defect needed —
    // so the division name is the ONLY thing telling the two tables apart.
    expect(h.match(/League/g)!.length).toBeGreaterThanOrEqual(2);
    const named = (id: string) =>
      h.slice(h.indexOf(`data-testid="mh-table-preview-${id}-division"`)).match(/>([^<]+)</)?.[1];
    expect(named("premier-league")).toBe("Premier");
    expect(named("sunday-league")).toBe("Sunday League");

    // And on a ONE-division document it is still there — four tabs agree.
    const one = hubDoc({
      matches: docUpcoming4.matches,
      tables: [tableView("premier-league", "premier")],
    });
    const single = render(one);
    expect(single.match(/data-testid="mh-table-preview-[a-z-]+-division"/g)).toHaveLength(1);
    expect(single).toContain(`data-testid="mh-table-preview-premier-league-division"`);
    // PRESENT is not SHOWN, and the sweep is why this line exists: reinstating
    // the gate as `hidden={doc.divisions.length <= 1}` leaves the testid in the
    // markup and restores the defect, so a containment check alone passes on
    // it. `hidden` is the one attribute that makes the element render and not
    // render at the same time.
    for (const h2 of [h, single]) {
      const tag = h2.slice(
        h2.lastIndexOf("<", h2.indexOf(`data-testid="mh-table-preview-premier-league-division"`)),
        h2.indexOf(">", h2.indexOf(`data-testid="mh-table-preview-premier-league-division"`)) + 1,
      );
      expect(tag).not.toContain("hidden");
    }
  });

  it("the preview division name is an <h3> — the section's own heading is the h2 above it", () => {
    // Final review C2. At `<h4>` the Overview's outline ran h2 → h4 → h3,
    // skipping a level INTO `StandingsTableView`'s `<h3>` caption below it,
    // while the Table tab nests the same two facts the other way up. Both the
    // level and the tag name were unpinned: `<h4>` → `<h3>` and `<h4>` →
    // `<span>` each survived the whole suite.
    const h = render(docUpcoming4);
    expect(h).toMatch(/<h3[^>]*data-testid="mh-table-preview-t8-s1-overall-division"/);
    // The section heading above it is the `<h2>`, so the two are a real
    // parent/child pair rather than two independent literals.
    expect(h).toMatch(/<h2[^>]*id="mh-tables-label"/);
    expect(h).not.toContain("<h4");
  });

  it("every table the document publishes gets its own preview, with its own id", () => {
    // A per-table id sourced from the DIVISION collides the moment a division
    // publishes an overall table and a pool table, which is the ordinary shape
    // of this document (`competition-hub.ts:562,590`).
    const two = hubDoc({
      matches: docUpcoming4.matches,
      tables: [
        tableView("premier-overall", "premier", { caption: "League" }),
        tableView("premier-pool-a", "premier", { caption: "Pool A" }),
      ],
    });
    const h = render(two);
    // One `-full` link per rendered view, so this is a COUNT of views and not
    // a containment check — a tab that rendered the first view twice contains
    // both ids below and fails here.
    expect([...h.matchAll(/data-testid="mh-table-preview-[a-z0-9-]+-full"/g)]).toHaveLength(2);
    expect(h).toContain(`data-testid="mh-table-preview-premier-overall"`);
    expect(h).toContain(`data-testid="mh-table-preview-premier-pool-a"`);
  });
});

describe("OverviewTab — the register CTA and the slots", () => {
  const open = hubDoc({
    divisions: [division("premier")],
    info: info({ startsOn: "2026-09-01", registrationOpen: true }),
  });
  const closed = hubDoc({
    divisions: [division("premier")],
    info: info({ startsOn: "2026-09-01", registrationOpen: false }),
  });

  it("registration OPEN → the CTA, at the document's own href, on a 44px tap target", () => {
    const h = render(open);
    // The tag read WHOLE, so the href and the tap area are pinned as the SAME
    // element — a `min-h-11` measured on a wrapper is not a tap target.
    const tag = tagOf(h, "mh-register");
    expect(tag).toContain(`href="${open.info.registerHref}"`);
    expect(classesOf(h, "mh-register")).toContain("min-h-11");
    expect(h).toContain(en["landing.register"]);
  });

  it("registration CLOSED → no CTA at all (the positive pair for the test above)", () => {
    const h = render(closed);
    expect(h).not.toContain(`data-testid="mh-register"`);
    // And the section it lived in goes with it — a heading over an absent
    // control reads as content that failed to load.
    expect(sections(h)).not.toContain("register");
  });

  it("the slot renders where it is given, and its section vanishes when it is not", () => {
    const withSlot = render(closed, { descriptionSlot: <p>ABOUT THIS CUP</p> });
    expect(sectionHtml(withSlot, "description")).toContain("ABOUT THIS CUP");

    const without = render(closed);
    expect(without).not.toContain("ABOUT THIS CUP");
    expect(sections(without)).not.toContain("description");
  });

  it("there is NO sponsors section — the board is the PAGE's, below every tab", () => {
    // Owner ruling 2026-09-12 (Option B). The board used to be a slot here and
    // in `InfoTab`, which meant a competition's sponsors vanished the moment a
    // spectator tapped Matches, Table, Stats or Teams. `page.tsx` renders it
    // below the whole tab panel now.
    //
    // Asserted on the LADDER as well as the markup: a section id left in
    // `OverviewSection` with nothing ever filling it renders nothing and looks
    // exactly like this test passing.
    for (const rung of ALL_RUNGS) {
      expect(overviewPlan(rung, dict).order, rung.kind).not.toContain("sponsors");
    }
    expect(render(closed, { descriptionSlot: <p>ABOUT THIS CUP</p> })).not.toContain(
      `data-testid="mh-sec-sponsors"`,
    );
  });

  it("CALLER CONTRACT: a slot that renders NOTHING still costs a section — pass undefined instead", () => {
    // Review I2, characterised rather than papered over. This tab keys the
    // section on whether the slot was GIVEN, because that is the only thing it
    // can see — an element returning null is still a non-null `ReactNode`
    // here, and no parent can ask a child what it will render without
    // rendering it.
    //
    // So the hole is real and the fix is the CALLER's. `page.tsx` gets it
    // right: it passes the prose only when there is prose to pass. This test
    // exists so the rule is written down in an executable place and so a later
    // "silent fix" here has to face it.
    const Empty = () => null;
    const h = render(closed, { descriptionSlot: <Empty /> });
    expect(sections(h)).toContain("description");
    // Empty in the literal sense: the section's element has no content at all.
    const at = h.indexOf(`data-testid="mh-sec-description"`);
    expect(h.slice(h.indexOf(">", at) + 1)).toMatch(/^<\/section>/);
    // Positive pair, and the shape the contract asks for: `undefined` costs
    // nothing at all.
    expect(sections(render(closed, { descriptionSlot: undefined }))).not.toContain("description");
  });

  it("a slot is rendered ONCE — a slot in two sections would duplicate the prose", () => {
    const h = render(
      hubDoc({ matches: docLive2.matches, info: info({ registrationOpen: true }) }),
      { descriptionSlot: <p>ABOUT THIS CUP</p> },
    );
    expect(h.match(/ABOUT THIS CUP/g)?.length).toBe(1);
  });
});

describe("OverviewTab — one DOM, branched", () => {
  const full = hubDoc({
    matches: LIVE_AND_NEXT,
    tables: [tableView("t8-s1-overall", "premier")],
    info: info({ registrationOpen: true }),
  });

  it("the main column and the side rail exist as ONE tree — `contents` below lg, real columns from lg", () => {
    // `display: contents` is what makes this one DOM rather than two: below
    // `lg` the wrappers are not boxes at all, so their children are the root
    // grid's own items and the ladder's `order-N` sequences them into a single
    // column. From `lg` the wrappers become blocks and each takes a column,
    // with the ladder's order surviving inside each one as source order.
    const h = render(full);
    for (const id of ["mh-overview-main", "mh-overview-side"]) {
      const classes = classesOf(h, id);
      expect(classes, id).toContain("contents");
      expect(classes, id).toContain("lg:block");
      expect(classes, id).toContain("min-w-0");
    }
  });

  it("the split only happens when the ladder put something in the MAIN column — and the tables follow it", () => {
    // Found by the owner looking at 1280, after I had MEASURED that width and
    // called it clean. On the `finished` rung there is no live rail and no
    // next-up, and a competition with no description leaves the main column
    // holding nothing but the one-line status. The split ran anyway:
    // `grid-template-columns` read back as `648px 320px` — a 648px column 24px
    // tall beside every table crushed into 320px, with most of the viewport
    // dead.
    //
    // The rule this tab is built on — "a section with nothing to say is ABSENT,
    // not held open as an empty shell" — had been applied to the sections and
    // not to the COLUMN holding them. One level too shallow.
    //
    // `mh-status` deliberately does NOT count as content: it is one line, it is
    // not a section, and mistaking it for content is exactly what happened.
    const finished = hubDoc({
      matches: [m("done", "completed", "2026-09-01T10:00:00.000Z", "premier")],
      tables: [tableView("t1", "premier", { rows: [tableRow("e1", 1)] })],
    });
    const collapsed = render(finished);
    expect(tagOf(collapsed, "mh-overview")).toContain('data-split="false"');
    expect(classesOf(collapsed, "mh-overview")).not.toContain(
      "lg:grid-cols-[minmax(0,1fr)_20rem]",
    );
    // The status line is present — so this is not passing because the panel is
    // empty, which would make the whole assertion vacuous.
    expect(collapsed).toContain(`data-testid="mh-status"`);

    // Positive pair: a document whose ladder fills the main column DOES split.
    const split = render(full);
    expect(tagOf(split, "mh-overview")).toContain('data-split="true"');
    expect(classesOf(split, "mh-overview")).toContain("lg:grid-cols-[minmax(0,1fr)_20rem]");

    // And the tables grid follows the same decision rather than a second one:
    // one column inside the 20rem rail (two would push Points behind a scroll),
    // two across the full width when there is no rail.
    const tables = classesOf(split, "mh-tables");
    expect(tables).toContain("lg:grid-cols-1");
    expect(tables).toContain("lg:group-data-[split=false]/ov:grid-cols-2");
    // The root carries the named group the child keys off — assert the PAIR,
    // because either half alone is a class that silently does nothing.
    expect(classesOf(split, "mh-overview")).toContain("group/ov");
  });

  it("status, the live rail, next up and the description are the MAIN column; tables and register the side rail", () => {
    const h = render(full, { descriptionSlot: <p>ABOUT</p> });
    // `full` is a LIVE document, which no longer carries a status line — the
    // rail is the top of that panel. The status line's own column placement is
    // asserted on a rung that still has one, two tests below.
    const sideAt = h.indexOf(`data-testid="mh-overview-side"`);
    expect(sideAt).toBeGreaterThan(-1);
    const inMain = (id: string) => {
      const at = h.indexOf(`data-testid="${id}"`);
      expect(at, id).toBeGreaterThan(-1);
      return at < sideAt;
    };
    expect(inMain("mh-sec-live"), "mh-sec-live").toBe(true);
    expect(inMain("mh-sec-next"), "mh-sec-next").toBe(true);
    expect(inMain("mh-sec-description"), "mh-sec-description").toBe(true);
    expect(inMain("mh-sec-tables"), "mh-sec-tables").toBe(false);
    expect(inMain("mh-sec-register"), "mh-sec-register").toBe(false);
  });

  it("the status line is FIRST in the column whatever the ladder says", () => {
    // `order-first` rather than `order-none`: the sections are `order-1..5`, so
    // a status at 0 would work by arithmetic and break the moment a rung wanted
    // a zeroth section. This is the one element whose position is not a ladder
    // decision.
    // On a rung that HAS a status line — `full` is live, and live has none.
    const dated = hubDoc({ divisions: [division("premier")], info: info({ registrationOpen: true }) });
    expect(classesOf(render(dated), "mh-status")).toContain("order-first");
    // …and it really is in the main column, which the live-document test above
    // cannot say any more.
    const h = render(dated);
    expect(h.indexOf('data-testid="mh-status"')).toBeLessThan(
      h.indexOf('data-testid="mh-overview-side"'),
    );
  });

  it("the grids widen from md, and the table previews go back to one-up in the lg side rail", () => {
    const h = render(full);
    // Live rail: a horizontal scroller at every width — its cards have a fixed
    // floor, so it does not become a grid.
    expect(classesOf(h, "mh-live-now")).toContain("overflow-x-auto");
    // Next up: 3-up from md.
    expect(classesOf(h, "mh-next-up")).toContain("md:grid-cols-3");
    // Tables: 2-up from md, and 1-up again from lg because from there they sit
    // in a 20rem side rail where two columns would put the points column — the
    // number the table exists for — behind a scroll.
    const tables = classesOf(h, "mh-tables");
    expect(tables).toContain("md:grid-cols-2");
    expect(tables).toContain("lg:grid-cols-1");
  });

  it("min-w-0 on the root, on every column and on every section — the truncate chain has no gaps", () => {
    // `MatchCard` truncates three of its own strings and `StandingsTableView`
    // truncates its caption and every entrant name; `truncate` needs `min-w-0`
    // on the WHOLE ancestor chain. Below `lg` the chain runs root → section
    // (the wrappers are not boxes); from `lg` it runs root → column → section.
    // So all three levels carry it.
    const h = render(full, { descriptionSlot: <p>ABOUT</p> });
    expect(classesOf(h, "mh-overview")).toContain("min-w-0");
    const ids = [...h.matchAll(/data-testid="mh-sec-([a-z]+)"/g)].map(([, id]) => id!);
    // EVERY section, not the first — a `min-w-0` that only reached the head of
    // the ladder is invisible to a one-section document.
    expect(ids.sort()).toEqual(["description", "live", "next", "register", "tables"].sort());
    for (const id of ids) {
      expect(classesOf(h, `mh-sec-${id}`), `section ${id}`).toContain("min-w-0");
    }
  });
});
