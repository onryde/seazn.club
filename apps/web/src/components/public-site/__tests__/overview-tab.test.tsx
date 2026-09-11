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
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { LandingStatus } from "@/lib/matches-hub";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { OverviewTab, overviewPlan, type OverviewSection } from "../matches-hub/overview-tab";
import { division, hubDoc, info, m, tableRow, tableView } from "./hub-fixtures";

const dict = en as Dict;

/** One instant, used as `now` everywhere, so every relative sentence and every
 *  ladder rung in this file is reproducible. Midday UTC on 5 September 2026,
 *  the day `hub-fixtures` dates its documents around. */
const NOW = Date.parse("2026-09-05T12:00:00.000Z");

interface RenderOver {
  dict?: Dict;
  locale?: Locale;
  now?: number;
  sponsorsSlot?: ReactNode;
  descriptionSlot?: ReactNode;
}

const render = (doc: CompetitionHubDocT, over: RenderOver = {}) =>
  renderToStaticMarkup(
    <OverviewTab
      doc={doc}
      dict={over.dict ?? dict}
      locale={over.locale ?? "en"}
      now={over.now ?? NOW}
      sponsorsSlot={over.sponsorsSlot}
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

  it("LIVE: the count is the number of live matches, pluralised through the dictionary", () => {
    const h = render(docLive2);
    expect(h).toContain("Live now: 2 matches");
    expect(tagOf(h, "mh-status")).toContain(`data-kind="live"`);
  });

  it("LIVE, one match: the SINGULAR key — a count that always reads .other is the plural defect", () => {
    const one = hubDoc({ matches: [m("l1", "live", "2026-09-05T10:00:00.000Z", "premier")] });
    // Terminated, so "1 match" cannot be satisfied by "1 matches".
    expect(render(one)).toMatch(/Live now: 1 match</);
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
    const h = render(docLive2, { dict: es as Dict, locale: "es" });
    expect(h).toContain(es["landing.status.live.other"].replace("{count}", "2"));
    expect(h).not.toContain("Live now: 2 matches");
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
    sponsorsSlot: <p>SPONSOR BOARD</p>,
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
      "sponsors",
    ]);
  });

  it("no live rung: next-up leads and there is NO rail at all — not an empty one", () => {
    const doc = hubDoc({ matches: docUpcoming4.matches, tables: [preview], info: open });
    const h = render(doc, SLOTS);
    expect(sections(h)).toEqual(["next", "tables", "register", "description", "sponsors"]);
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
    expect(sections(h)).toEqual(["next", "tables", "register", "description", "sponsors"]);
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
      "sponsors",
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
    expect(sections(h)).toEqual(["register", "description", "sponsors"]);
    expect(h).not.toContain(`data-testid="mh-tables"`);
  });

  it("empty: the same order as dates — a competition with nothing published still has a way in", () => {
    const h = render(hubDoc({ divisions: [], info: open }), SLOTS);
    expect(tagOf(h, "mh-status")).toContain(`data-kind="empty"`);
    expect(sections(h)).toEqual(["register", "description", "sponsors"]);
  });

  it("the order VALUES are 1..n with no gaps and no repeats — two sections at one order is no order", () => {
    const doc = hubDoc({ matches: LIVE_AND_NEXT, tables: [preview], info: open });
    expect(ladder(render(doc, SLOTS)).map(([, n]) => n)).toEqual([1, 2, 3, 4, 5, 6]);
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
      ["sponsors", 5],
    ]);
  });

  it("a rung the renderer does not handle THROWS rather than rendering a wrong page", () => {
    // R1's whole reason. `LandingStatus` has SIX rungs and the dictionary
    // coverage list that was supposed to catch a new one is hand-written, so it
    // cannot fail when a rung appears. The renderer can: under `tsc` a seventh
    // rung is a compile error at the `never`, and at runtime it is this throw.
    const rogue = { kind: "playoffs" } as unknown as LandingStatus;
    expect(() => overviewPlan(rogue, dict, "en")).toThrow(/playoffs/);
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
    const orderOf = (s: LandingStatus) => overviewPlan(s, dict, "en").order;
    expect(orderOf({ kind: "live", n: 1 })).toEqual([
      "live",
      "next",
      "tables",
      "register",
      "description",
      "sponsors",
    ]);
    expect(orderOf({ kind: "next", at: "2026-09-05T13:00:00.000Z", tz: "Europe/London" })).toEqual([
      "next",
      "tables",
      "register",
      "description",
      "sponsors",
    ]);
    // `match_day` SHARES `next`'s order and differs only in what it says. The
    // two are asserted separately, so a later change to one cannot silently
    // move the other.
    expect(orderOf({ kind: "match_day" })).toEqual([
      "next",
      "tables",
      "register",
      "description",
      "sponsors",
    ]);
    expect(orderOf({ kind: "finished" })).toEqual([
      "tables",
      "register",
      "description",
      "sponsors",
    ]);
    expect(orderOf({ kind: "dates", startsOn: null, endsOn: null })).toEqual([
      "register",
      "description",
      "sponsors",
    ]);
    expect(orderOf({ kind: "empty" })).toEqual(["register", "description", "sponsors"]);
    // `live` is the only rung that can carry a live match — every other rung
    // sits below `landingStatus`'s own live check — so a `"live"` entry in any
    // other order would be a section that provably cannot render.
    for (const rung of [
      { kind: "next", at: "2026-09-05T13:00:00.000Z", tz: "Europe/London" },
      { kind: "match_day" },
      { kind: "finished" },
      { kind: "dates", startsOn: null, endsOn: null },
      { kind: "empty" },
    ] as LandingStatus[]) {
      expect(orderOf(rung), rung.kind).not.toContain("live");
    }
  });

  it("every rung `landingStatus` can return IS handled — enumerated, not sampled", () => {
    // The positive pair for the throw above, and the thing that would have
    // caught `match_day` when it was missed.
    const rungs: LandingStatus[] = [
      { kind: "empty" },
      { kind: "live", n: 1 },
      { kind: "next", at: "2026-09-05T13:00:00.000Z", tz: "Europe/London" },
      { kind: "match_day" },
      { kind: "finished" },
      { kind: "dates", startsOn: "2026-09-01", endsOn: null },
    ];
    for (const rung of rungs) {
      const plan = overviewPlan(rung, dict, "en");
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
    expect(rail).toMatch(/aria-label="[^"]+"/);
    expect(h.match(/data-testid="mh-live-now-card-/g)?.length).toBe(2);
    // The W0 defect: the rail rendered scores with no names. All four names, so
    // a card bound to one side only is visible.
    for (const name of ["Southend Queens", "Harlow Foxes", "Riverside Rovers", "Kings Park Kites"]) {
      expect(h).toContain(name);
    }
  });

  it("the rail is named from the DICTIONARY, not from an English literal", () => {
    const h = render(docLive2, { dict: es as Dict, locale: "es" });
    expect(tagOf(h, "mh-live-now")).toContain(`aria-label="${es["landing.liveNow"]}"`);
    expect(h).toContain(es["landing.liveNow"]);
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

  it("the slots render where they are given, and their sections vanish when they are not", () => {
    const withSlots = render(closed, {
      descriptionSlot: <p>ABOUT THIS CUP</p>,
      sponsorsSlot: <p>SPONSOR BOARD</p>,
    });
    expect(sectionHtml(withSlots, "description")).toContain("ABOUT THIS CUP");
    expect(sectionHtml(withSlots, "sponsors")).toContain("SPONSOR BOARD");

    const without = render(closed);
    expect(without).not.toContain("ABOUT THIS CUP");
    expect(sections(without)).not.toContain("description");
    expect(sections(without)).not.toContain("sponsors");
  });

  it("a slot is rendered ONCE — a slot in two sections would duplicate a sponsor board", () => {
    const h = render(
      hubDoc({ matches: docLive2.matches, info: info({ registrationOpen: true }) }),
      { sponsorsSlot: <p>SPONSOR BOARD</p> },
    );
    expect(h.match(/SPONSOR BOARD/g)?.length).toBe(1);
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

  it("status, the live rail, next up and the description are the MAIN column; tables, register and sponsors the side rail", () => {
    const h = render(full, { descriptionSlot: <p>ABOUT</p>, sponsorsSlot: <p>SPONSORS</p> });
    const sideAt = h.indexOf(`data-testid="mh-overview-side"`);
    expect(sideAt).toBeGreaterThan(-1);
    const inMain = (id: string) => {
      const at = h.indexOf(`data-testid="${id}"`);
      expect(at, id).toBeGreaterThan(-1);
      return at < sideAt;
    };
    expect(inMain("mh-status"), "mh-status").toBe(true);
    expect(inMain("mh-sec-live"), "mh-sec-live").toBe(true);
    expect(inMain("mh-sec-next"), "mh-sec-next").toBe(true);
    expect(inMain("mh-sec-description"), "mh-sec-description").toBe(true);
    expect(inMain("mh-sec-tables"), "mh-sec-tables").toBe(false);
    expect(inMain("mh-sec-register"), "mh-sec-register").toBe(false);
    expect(inMain("mh-sec-sponsors"), "mh-sec-sponsors").toBe(false);
  });

  it("the status line is FIRST in the column whatever the ladder says", () => {
    // `order-first` rather than `order-none`: the sections are `order-1..6`, so
    // a status at 0 would work by arithmetic and break the moment a rung wanted
    // a zeroth section. This is the one element whose position is not a ladder
    // decision.
    expect(classesOf(render(full), "mh-status")).toContain("order-first");
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
    const h = render(full, { descriptionSlot: <p>ABOUT</p>, sponsorsSlot: <p>SPONSORS</p> });
    expect(classesOf(h, "mh-overview")).toContain("min-w-0");
    const ids = [...h.matchAll(/data-testid="mh-sec-([a-z]+)"/g)].map(([, id]) => id!);
    // EVERY section, not the first — a `min-w-0` that only reached the head of
    // the ladder is invisible to a one-section document.
    expect(ids.sort()).toEqual(
      ["description", "live", "next", "register", "sponsors", "tables"].sort(),
    );
    for (const id of ids) {
      expect(classesOf(h, `mh-sec-${id}`), `section ${id}`).toContain("min-w-0");
    }
  });
});
