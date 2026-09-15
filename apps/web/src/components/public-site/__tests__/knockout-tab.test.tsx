// The competition hub's Knockout tab (plan 2026-09-13, Task 2): a round rail
// with match cards at every width, and a one-sided Draw tree on large screens
// behind a switch that defaults to Rounds.
//
// TWO ENVIRONMENTS, as the landing suite uses them:
//  • `renderToStaticMarkup` for what each control OPENS AT — the round the rail
//    presses, the view the switch shows, the division the rail narrows to.
//    AGENTS.md 19: a reachability test is satisfied by any value, so these pin
//    the value.
//  • `_hook-harness`'s `renderIsland` for what a TAP does, and what a later poll
//    does to a choice already made.
//
// WHAT NEITHER CAN SEE, stated so a green run is not read as a measurement:
//  • whether a class is IN EFFECT at a width. The Draw exists only from `lg`
//    and the switch hides below it; these tests pin the class TOKENS that ask
//    for that, and Task 3's e2e is what proves the browser obeys them.
//  • the rail scrolling its pressed chip into view. Refs never attach in either
//    environment, so the layout effect that sets `scrollLeft` is inert here;
//    `revealScrollLeft`'s arithmetic is pinned below as a pure function, and
//    the DOM half belongs to Task 3's e2e.
//  • `?view=` itself. `useSearchParam` is `useSyncExternalStore`, answered with
//    the server snapshot (null) by both environments, so the browser SOURCE is
//    stubbed below — and only the source: the mode rule stays real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type {
  CompetitionHubDocT,
  HubMatchT,
  KnockoutViewT,
} from "@/server/public-site/competition-hub-schema";

/** The ONE browser fact this environment cannot produce: `?view=`. Any other
 *  name reads as absent, so a component that asked for the wrong parameter
 *  would never see the stub's value. */
const url = vi.hoisted(() => ({ view: null as string | null }));
vi.mock("../use-tab-param", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../use-tab-param")>()),
  useSearchParam: (name: string) => (name === "view" ? url.view : null),
}));

import { initials } from "@/components/ui/entity-logo";
import { MatchCard, type MatchCardProps } from "../matches-hub/match-card";
import { MatchesTab } from "../matches-hub/matches-tab";
import {
  KnockoutTab,
  defaultRoundKey,
  knockoutMode,
  nextLine,
  pendingSide,
  revealScrollLeft,
} from "../matches-hub/knockout-tab";
import { hubDoc, knockoutView, koRound, koSide, m } from "./hub-fixtures";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const dict = en as Dict;

afterEach(() => {
  url.view = null;
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------ the documents

type Side = ReturnType<typeof koSide>;
const QF = "Quarter-finals";
const SF = "Semi-finals";
const TP = "Third place";
const F = "Final";
/** A real entrant. */
const S = (name: string) => koSide(name);
/** A slot with nobody in it yet — `entrantId: ""`, the slot sentence as name. */
const tbd = (label: string) => koSide(label, null);

/** A knockout match: id, bucket, the round label it carries, its two sides and
 *  who won. The score line follows the winner so a Draw node has one to show. */
function ko(
  id: string,
  bucket: HubMatchT["bucket"],
  roundLabel: string,
  sides: [Side, Side],
  winnerIndex: 0 | 1 | null = null,
  divisionSlug = "premier",
): HubMatchT {
  return m(id, bucket, "2026-09-05T10:00:00.000Z", divisionSlug, {
    stageName: "Cup",
    roundLabel,
    winnerIndex,
    header: {
      sides,
      scoreLines: winnerIndex === null ? [null, null] : winnerIndex === 0 ? ["2", "0"] : ["1", "2"],
    },
  });
}

/** An 8-draw in bracket order: QF, SF, the third-place round in front of the
 *  final (plan R3), then the final. */
const ROUNDS = [
  koRound("main-1", QF, ["q1", "q2", "q3", "q4"]),
  koRound("main-2", SF, ["s1", "s2"]),
  koRound("third-place", TP, ["t1"]),
  koRound("main-3", F, ["f1"]),
];
const VIEW = "premier-cup";

/**
 * MID-EVENT, round 0 still being played. Its quarter-finals hold every "next"
 * branch at once, which is what lets one render pin all four:
 *   q1 decided (Ana)                         → "Ana goes through…"
 *   q2 open, partner q1 decided              → "Winner meets Ana…"
 *   q3 open, partner q4 open with both known → "…the winner of Gus v Hal…"
 *   q4 LIVE, partner q3 has an empty slot    → "Winner goes through…"
 */
const MID_MATCHES = [
  ko("q1", "completed", QF, [S("Ana"), S("Ben")], 0),
  ko("q2", "upcoming", QF, [S("Cara"), S("Dev")]),
  ko("q3", "upcoming", QF, [S("Eli"), tbd("Winner of R1 6")]),
  ko("q4", "live", QF, [S("Gus"), S("Hal")]),
  ko("s1", "upcoming", SF, [S("Ana"), tbd("Winner of QF 2")]),
  ko("s2", "upcoming", SF, [tbd("Winner of QF 3"), tbd("Winner of QF 4")]),
  ko("t1", "upcoming", TP, [tbd("Loser of SF 1"), tbd("Loser of SF 2")]),
  ko("f1", "upcoming", F, [tbd("Winner of SF 1"), tbd("Winner of SF 2")]),
];
const MID = hubDoc({ matches: MID_MATCHES, knockouts: [knockoutView("cup", "premier", ROUNDS)] });

/**
 * LATER: every quarter-final decided, one semi decided. The first round with an
 * unfinished fixture is the SEMI-FINALS — not round 0, and not the third-place
 * round or the final, both of which are ALSO unfinished. That is what makes
 * "the FIRST unfinished round" differential against every simpler rule.
 */
const LATER_MATCHES = [
  ko("q1", "completed", QF, [S("Ana"), S("Ben")], 0),
  ko("q2", "completed", QF, [S("Cara"), S("Dev")], 1),
  ko("q3", "completed", QF, [S("Eli"), S("Fay")], 0),
  ko("q4", "completed", QF, [S("Gus"), S("Hal")], 1),
  ko("s1", "completed", SF, [S("Ana"), S("Dev")], 1),
  ko("s2", "upcoming", SF, [S("Eli"), S("Hal")]),
  ko("t1", "upcoming", TP, [S("Ana"), tbd("Loser of SF 2")]),
  ko("f1", "upcoming", F, [S("Dev"), tbd("Winner of SF 2")]),
];
const LATER = hubDoc({
  matches: LATER_MATCHES,
  knockouts: [knockoutView("cup", "premier", ROUNDS)],
});

/**
 * DONE: everything decided. The final's winner is the AWAY side (Eli beat Dev),
 * so a banner that read `sides[0]` would crown the loser.
 */
const DONE_MATCHES = [
  ...LATER_MATCHES.slice(0, 5),
  ko("s2", "completed", SF, [S("Eli"), S("Hal")], 0),
  ko("t1", "completed", TP, [S("Ana"), S("Hal")], 0),
  ko("f1", "completed", F, [S("Dev"), S("Eli")], 1),
];
const doneDoc = (championFixtureId: string | null) =>
  hubDoc({
    matches: DONE_MATCHES,
    knockouts: [knockoutView("cup", "premier", ROUNDS, { championFixtureId })],
  });

/** A second division's two-round plate, for the division rail. */
const PLATE_MATCHES = [
  ko("p1", "completed", SF, [S("Ivy"), S("Jon")], 0, "sunday-league"),
  ko("p2", "completed", SF, [S("Kit"), S("Lou")], 1, "sunday-league"),
  ko("p3", "upcoming", F, [S("Ivy"), S("Lou")], null, "sunday-league"),
];
const PLATE_ROUNDS = [koRound("main-1", SF, ["p1", "p2"]), koRound("main-2", F, ["p3"])];
const plateView = (over: Partial<KnockoutViewT> = {}) =>
  knockoutView("plate", "sunday-league", PLATE_ROUNDS, { stageName: "Plate", ...over });
const MULTI = hubDoc({
  matches: [...MID_MATCHES, ...PLATE_MATCHES],
  knockouts: [knockoutView("cup", "premier", ROUNDS), plateView()],
});

/**
 * DOUBLES, a 4-draw (review F5). A pair entrant is NAMED "A / B"
 * (`stages.ts`, `members.join(" / ")`), so a slot waiting on two of them under
 * the old "{a} / {b}" copy read "Ana Lee / Bo Kim / Cy Po / Di Wu", with
 * nothing to say where one team ends. d1 is unplayed; d2 is decided, its winner
 * already in the final's away slot.
 */
const DOUBLES = hubDoc({
  matches: [
    ko("d1", "upcoming", SF, [S("Ana Lee / Bo Kim"), S("Cy Po / Di Wu")]),
    ko("d2", "completed", SF, [S("Eve Ng / Fay Ho"), S("Gil Ma / Hu Li")], 0),
    ko("df", "upcoming", F, [tbd("Winner of SF 1"), S("Eve Ng / Fay Ho")]),
  ],
  knockouts: [knockoutView("cup", "premier", [koRound("main-1", SF, ["d1", "d2"]), koRound("main-2", F, ["df"])])],
});

// ------------------------------------------------------------ helpers

const render = (
  doc: CompetitionHubDocT,
  over: { initialDivision?: string | null; dict?: Dict; locale?: "en" | "es" } = {},
) =>
  renderToStaticMarkup(
    <KnockoutTab
      doc={doc}
      dict={over.dict ?? dict}
      locale={over.locale ?? "en"}
      now={NOW}
      initialDivision={over.initialDivision}
    />,
  );

/** The whole opening tag carrying a testid, attribute order irrelevant. */
const tagOf = (h: string, testid: string): string => {
  const at = h.indexOf(`data-testid="${testid}"`);
  expect(at, `${testid} is in the markup`).toBeGreaterThan(-1);
  return h.slice(h.lastIndexOf("<", at), h.indexOf(">", at) + 1);
};

/** The class TOKENS on the element carrying a testid — token-exact, so
 *  `lg:hidden` is not satisfied by `max-lg:hidden` (AGENTS.md's
 *  `md:hidden`-inside-`max-md:hidden` trap). */
const classOf = (h: string, testid: string): string[] => {
  const cls = tagOf(h, testid).match(/ class="([^"]*)"/)?.[1];
  expect(cls, `${testid} carries a class`).toBeDefined();
  return cls!.split(" ");
};

/** Every round chip carrying `aria-pressed="true"`. A COUNT: the defect a
 *  reconciliation exists to prevent is ZERO pressed chips, which every
 *  `toContain` passes. */
const pressedRounds = (h: string) =>
  [...h.matchAll(/data-testid="(mh-knockout-round-[^"]+)"[^>]*aria-pressed="true"/g)].map(
    (x) => x[1],
  );

/** The card ids the page shows, in order. */
const cardIds = (h: string) =>
  [...h.matchAll(/data-testid="mh-match-([^"]+)"/g)]
    .map((x) => x[1]!)
    .filter((id) => !["side-0", "side-1", "division", "live", "result", "status", "starts"].includes(id));

/** The sentence under one card, as a reader hears it (tags and the decorative
 *  arrow stripped). */
const nextText = (h: string, fixtureId: string): string | null => {
  const found = h.match(new RegExp(`data-testid="mh-knockout-next-${fixtureId}"[^>]*>(.*?)</p>`));
  return found ? found[1]!.replace(/<[^>]+>/g, "").replace(/^→/, "") : null;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

// ------------------------------------------------------------ the tests

describe("KnockoutTab — the panel root", () => {
  it("carries the hub's panel handle and min-w-0", () => {
    // `mh-<tabId>` is how the landing root proves exactly ONE panel drew, and
    // `min-w-0` keeps every card's truncation working inside whatever grid or
    // flex parent mounts this.
    const tokens = classOf(render(MID), "mh-knockout");
    expect(tokens).toContain("min-w-0");
  });

  it("a document with NO knockout views renders the root and nothing else (unreachable through the hub, which offers no tab)", () => {
    expect(render(hubDoc({}))).toBe(`<div data-testid="mh-knockout" class="min-w-0"></div>`);
  });
});

describe("KnockoutTab — which round it opens on", () => {
  it("MID-EVENT: opens on the FIRST round still holding an unfinished fixture — not round 0, not a later unfinished round", () => {
    const h = render(LATER);
    expect(pressedRounds(h)).toEqual([`mh-knockout-round-${VIEW}-main-2`]);
    // The list IS that round: both semis, in seq order, and nothing else.
    expect(cardIds(h)).toEqual(["s1", "s2"]);
  });

  it("round 0 still being played opens on round 0 (the positive pair — the rule is not 'skip the first')", () => {
    const h = render(MID);
    expect(pressedRounds(h)).toEqual([`mh-knockout-round-${VIEW}-main-1`]);
    expect(cardIds(h)).toEqual(["q1", "q2", "q3", "q4"]);
  });

  it("ALL DECIDED: opens on the LAST round — the Final, not the third-place round in front of it", () => {
    const h = render(doneDoc(null));
    expect(pressedRounds(h)).toEqual([`mh-knockout-round-${VIEW}-main-3`]);
    expect(cardIds(h)).toEqual(["f1"]);
  });

  it("defaultRoundKey, enumerated over the three documents", () => {
    const rule = (doc: CompetitionHubDocT) =>
      defaultRoundKey(doc.knockouts[0]!, new Map(doc.matches.map((x) => [x.fixtureId, x])));
    expect(rule(MID)).toBe("main-1");
    expect(rule(LATER)).toBe("main-2");
    expect(rule(doneDoc(null))).toBe("main-3");
  });

  // The four rungs (fix round 1, ruling 1): a LIVE round, else the round the
  // CHAMPION was crowned in, else the first unfinished round, else the last.
  // Each case is one where the rung's answer differs from the next rung's, so
  // deleting or reordering any rung is visible.
  const opensOn = (doc: CompetitionHubDocT) => pressedRounds(render(doc));

  it("rung 1 — LIVE beats an EARLIER unfinished round: a live losers' round opens ahead of an upcoming winners' round in front of it", () => {
    const doc = hubDoc({
      matches: [
        ko("w1", "completed", "Winners' round 1", [S("Ana"), S("Ben")], 0),
        ko("w2", "upcoming", "Winners' final", [S("Ana"), S("Cara")]),
        ko("l1", "live", "Losers' round 1", [S("Ben"), S("Dev")]),
        ko("g1", "upcoming", "Grand final", [tbd("Winner of WB"), tbd("Winner of LB")]),
      ],
      knockouts: [
        knockoutView(
          "de",
          "premier",
          [
            koRound("WB-1", "Winners' round 1", ["w1"], "WB"),
            koRound("WB-2", "Winners' final", ["w2"], "WB"),
            koRound("LB-1", "Losers' round 1", ["l1"], "LB"),
            koRound("GF-3", "Grand final", ["g1"], "GF"),
          ],
          { kind: "double_elim", drawable: false },
        ),
      ],
    });
    expect(opensOn(doc)).toEqual(["mh-knockout-round-premier-de-LB-1"]);
  });

  it("rung 1 — with TWO live rounds, the EARLIER one in rail order opens (winners' before losers')", () => {
    // Task 2 fix round 2: every other rung-1 case has exactly one live round,
    // so "the last live round" passed them all.
    const doc = hubDoc({
      matches: [
        ko("w1", "live", "Winners' final", [S("Ana"), S("Ben")]),
        ko("l1", "live", "Losers' final", [S("Cara"), S("Dev")]),
        ko("g1", "upcoming", "Grand final", [tbd("Winner of WB"), tbd("Winner of LB")]),
      ],
      knockouts: [
        knockoutView(
          "de",
          "premier",
          [
            koRound("WB-1", "Winners' final", ["w1"], "WB"),
            koRound("LB-1", "Losers' final", ["l1"], "LB"),
            koRound("GF-2", "Grand final", ["g1"], "GF"),
          ],
          { kind: "double_elim", drawable: false },
        ),
      ],
    });
    expect(opensOn(doc)).toEqual(["mh-knockout-round-premier-de-WB-1"]);
  });

  it("rung 1 — LIVE beats the CHAMPION's round: a live bronze match beside a decided final opens on the bronze", () => {
    const matches = [
      ...DONE_MATCHES.filter((x) => x.fixtureId !== "t1"),
      ko("t1", "live", TP, [S("Ana"), S("Hal")]),
    ];
    const doc = hubDoc({
      matches,
      knockouts: [knockoutView("cup", "premier", ROUNDS, { championFixtureId: "f1" })],
    });
    expect(opensOn(doc)).toEqual([`mh-knockout-round-${VIEW}-third-place`]);
  });

  it("rung 2 — the CHAMPION's round beats an unfinished one: a finished double-elim whose unowed reset still reads scheduled opens on the first grand final", () => {
    // The builder now leaves an unowed reset off the rail (ruling 2), so a
    // fresh document never carries this round. A document cached before that
    // change does, and the tab must still open on the round the title was won.
    const doc = hubDoc({
      matches: [
        ko("w1", "completed", "Winners' final", [S("Ana"), S("Ben")], 0),
        ko("l1", "completed", "Losers' final", [S("Ben"), S("Cara")], 0),
        ko("g1", "completed", "Grand final", [S("Ana"), S("Ben")], 0),
        ko("g2", "upcoming", "Grand final (reset)", [S("Ben"), S("Ana")]),
      ],
      knockouts: [
        knockoutView(
          "de",
          "premier",
          [
            koRound("WB-1", "Winners' final", ["w1"], "WB"),
            koRound("LB-1", "Losers' final", ["l1"], "LB"),
            koRound("GF-3", "Grand final", ["g1"], "GF"),
            koRound("GF-4", "Grand final (reset)", ["g2"], "GF"),
          ],
          { kind: "double_elim", drawable: false, championFixtureId: "g1" },
        ),
      ],
    });
    expect(opensOn(doc)).toEqual(["mh-knockout-round-premier-de-GF-3"]);
  });
});

describe("KnockoutTab — the round rail", () => {
  it("is a focusable, NAMED group that scrolls — the name is the dictionary's", () => {
    const h = render(MID);
    expect(h).toMatch(
      new RegExp(`data-testid="mh-knockout-rail-${VIEW}"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="Rounds"`),
    );
    for (const token of ["overflow-x-auto", "max-md:-mx-4", "max-md:px-4"]) {
      expect(classOf(h, `mh-knockout-rail-${VIEW}`), token).toContain(token);
    }
  });

  it("one chip per round in BRACKET order, each a 44px tap target", () => {
    const h = render(MID);
    const at = (key: string) => h.indexOf(`data-testid="mh-knockout-round-${VIEW}-${key}"`);
    expect(at("main-1")).toBeGreaterThan(-1);
    expect(at("main-1")).toBeLessThan(at("main-2"));
    expect(at("main-2")).toBeLessThan(at("third-place"));
    expect(at("third-place")).toBeLessThan(at("main-3"));
    expect(classOf(h, `mh-knockout-round-${VIEW}-main-2`)).toContain("min-h-11");
  });

  it("each chip's badge is its OWN round's done/total, on a document where they differ", () => {
    const h = render(LATER);
    const chip = (key: string, label: string, badge: string) =>
      new RegExp(
        `data-testid="mh-knockout-round-${VIEW}-${key}"[^>]*>${label}<span[^>]*>${badge.replace("/", "\\/")}</span></button>`,
      );
    expect(h).toMatch(chip("main-1", QF, "4/4"));
    expect(h).toMatch(chip("main-2", SF, "1/2"));
    expect(h).toMatch(chip("third-place", TP, "0/1"));
    expect(h).toMatch(chip("main-3", F, "0/1"));
  });

  it("a round with a LIVE fixture shows a dot that is NAMED for a screen reader, instead of a count", () => {
    const h = render(MID);
    const qf = h.match(new RegExp(`data-testid="mh-knockout-round-${VIEW}-main-1"[^>]*>(.*?)</button>`))?.[1];
    expect(qf, "the QF chip's content").toBeDefined();
    expect(qf).toContain(`<span class="sr-only">Live</span>`);
    expect(qf).toMatch(/<span aria-hidden="true" class="[^"]*rounded-full[^"]*"><\/span>/);
    expect(qf).not.toMatch(/\d\/4/);
    // The positive pair on the same rail: a round with nothing live keeps its count.
    const sf = h.match(new RegExp(`data-testid="mh-knockout-round-${VIEW}-main-2"[^>]*>(.*?)</button>`))?.[1];
    expect(sf).toContain(">0/2</span>");
    expect(sf).not.toContain("sr-only");
  });

  it("WRAPS from lg instead of scrolling, and stays a swipe rail below it — the round rail and the division rail alike (C1)", () => {
    // At 1280 a double-elimination rail cut its last chip mid-word, and a
    // mouse has no way to scroll a rail sideways. Token-exact: a bare
    // `flex-wrap` would wrap the phone rail too, which is the swipe rail the
    // owner signed off.
    const h = render(MULTI);
    for (const testid of [`mh-knockout-rail-${VIEW}`, "mh-knockout-divisions"]) {
      const tokens = classOf(h, testid);
      expect(tokens, testid).toContain("lg:flex-wrap");
      expect(tokens, testid).not.toContain("flex-wrap");
      expect(tokens, testid).toContain("overflow-x-auto");
    }
    // Still a focusable, named group at every width (AGENTS.md 23): tabindex
    // cannot vary by media query, so wrapping does not take it away.
    expect(h).toMatch(/data-testid="mh-knockout-divisions"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="/);
  });

  it("rails carry snap-x snap-proximity with scroll padding equal to the inset; every chip is snap-start (C-1)", () => {
    // Visual gate C-1: at phone widths the rail's leading chip read
    // "uarter-finals", "ualifier 1", "als 2/2". The fix is `snap-x
    // snap-proximity` on the track, `snap-start` on each chip, and scroll
    // padding EQUAL to the track's own inset padding. The reveal effect aligns
    // a chip to that padding, so if the two differed, every reveal would land
    // off a snap point and the browser would move it again. Proximity, not
    // mandatory: a hand swipe that stops far from any chip is left where it
    // stopped. The division rail is the same rail (`HUB_RAIL_CLASS`).
    //
    // Tokens only. That Chromium obeys them, and what the reveal does under
    // them, was measured by the N2 harness, not here.
    const h = render(MULTI);
    for (const testid of [`mh-knockout-rail-${VIEW}`, "mh-knockout-divisions"]) {
      const tokens = classOf(h, testid);
      expect(tokens, testid).toEqual(
        expect.arrayContaining(["snap-x", "snap-proximity", "max-md:px-4", "max-md:scroll-px-4"]),
      );
      expect(tokens, testid).not.toContain("snap-mandatory");
    }
    for (const testid of [`mh-knockout-round-${VIEW}-main-1`, `mh-knockout-round-${VIEW}-main-3`, "mh-knockout-division-all"]) {
      expect(classOf(h, testid), testid).toContain("snap-start");
    }
  });

  it("exactly one chip is pressed PER VIEW when two views render", () => {
    const h = render(MULTI);
    expect(pressedRounds(h)).toEqual([
      `mh-knockout-round-${VIEW}-main-1`,
      "mh-knockout-round-sunday-league-plate-main-2",
    ]);
  });
});

describe("KnockoutTab — the cards (D1)", () => {
  it("a Knockout card carries no STAGE · ROUND caption — the stage heading and the pressed chip already say it — while the SAME match on the Matches tab keeps it", () => {
    const h = render(LATER);
    expect(cardIds(h)).toEqual(["s1", "s2"]); // the premise: cards rendered
    expect(h).not.toMatch(/>Cup · /);
    // The positive pair, same document: the Matches tab's card is the default
    // MatchCard and keeps its caption.
    const matches = renderToStaticMarkup(<MatchesTab doc={LATER} dict={dict} locale="en" now={NOW} />);
    expect(matches).toMatch(/>Cup · (Quarter-finals|Semi-finals|Third place|Final)</);
  });
});

describe("KnockoutTab — a slot still waiting on its feeder (D2)", () => {
  // The feeder of bracket round k+1's fixture j, side s, is round k's fixture
  // 2j+s — `generateSingleElim`'s own wiring (`homeFrom: winnerOf(prev[2i])`,
  // `awayFrom: winnerOf(prev[2i+1])`), the relationship the tree's connectors
  // draw, and verified against two real hub documents in the fix-round report.
  // The third-place fixture's sides are the semi-finals' LOSERS.
  const index = (doc: CompetitionHubDocT) => new Map(doc.matches.map((x) => [x.fixtureId, x]));
  const pair = (a: string, b: string) => ({ key: "knockout.pendingPair", vars: { a, b } });

  it("pendingSide, enumerated on MID: a pair only where the feeder is undecided with BOTH sides known", () => {
    const view = MID.knockouts[0]!;
    const mx = index(MID);
    // s1's home is Ana, already through: the real entrant stays.
    expect(pendingSide(view, "s1", 0, mx)).toBeNull();
    // s1's away ← q2 (index 1): not started, Cara v Dev.
    expect(pendingSide(view, "s1", 1, mx)).toEqual(pair("Cara", "Dev"));
    // s2's home ← q3 (index 2): one side is itself a slot → unchanged.
    expect(pendingSide(view, "s2", 0, mx)).toBeNull();
    // s2's away ← q4 (index 3): LIVE, Gus v Hal.
    expect(pendingSide(view, "s2", 1, mx)).toEqual(pair("Gus", "Hal"));
    // The final ← the semis, neither of which has both sides yet.
    expect(pendingSide(view, "f1", 0, mx)).toBeNull();
    expect(pendingSide(view, "f1", 1, mx)).toBeNull();
    // Round 0 has no feeder, even for a slot with nobody in it.
    expect(pendingSide(view, "q3", 1, mx)).toBeNull();
  });

  it("THIRD PLACE is fed by the semi-finals' LOSERS: one undecided semi reads 'Loser of Eli v Hal' there and 'Eli or Hal' in the final", () => {
    // LATER: s1 decided (Dev beat Ana), s2 not started (Eli v Hal). Ana is in
    // the bronze match and Dev in the final; the other slot of each waits on s2.
    const view = LATER.knockouts[0]!;
    const mx = index(LATER);
    expect(pendingSide(view, "f1", 1, mx)).toEqual(pair("Eli", "Hal"));
    expect(pendingSide(view, "t1", 1, mx)).toEqual({ key: "knockout.pendingLoser", vars: { a: "Eli", b: "Hal" } });
    expect(pendingSide(view, "t1", 0, mx)).toBeNull();
    expect(pendingSide(view, "f1", 0, mx)).toBeNull();
  });

  it("a FILLED slot is the real entrant even while its feeder is open again — a corrected result reopens the match, the advanced name stays", () => {
    // The mutation sweep found this gate unwitnessed: in every other document
    // a filled slot's feeder is already decided, so the decided-feeder gate
    // answered for it. A score correction that takes q1 back into play does
    // not empty s1's home slot, and a pair there would hide the entrant who
    // is actually in it.
    const matches = MID_MATCHES.map((x) => (x.fixtureId === "q1" ? ko("q1", "live", QF, [S("Ana"), S("Ben")]) : x));
    const doc = hubDoc({ matches, knockouts: [knockoutView("cup", "premier", ROUNDS)] });
    expect(pendingSide(doc.knockouts[0]!, "s1", 0, index(doc))).toBeNull();
    // The positive pair on the same document: the empty slot beside it still pairs.
    expect(pendingSide(doc.knockouts[0]!, "s1", 1, index(doc))).toEqual(pair("Cara", "Dev"));
  });

  it("a DECIDED feeder never pairs: a semi that ended with nobody through (abandoned) leaves both waiting slots their own sentence", () => {
    const matches = LATER_MATCHES.map((x) =>
      x.fixtureId === "s2" ? ko("s2", "completed", SF, [S("Eli"), S("Hal")]) : x,
    );
    const doc = hubDoc({ matches, knockouts: [knockoutView("cup", "premier", ROUNDS)] });
    expect(pendingSide(doc.knockouts[0]!, "f1", 1, index(doc))).toBeNull();
    expect(pendingSide(doc.knockouts[0]!, "t1", 1, index(doc))).toBeNull();
  });

  it("a slot fed by a BYE never pairs — the bye's empty side is not an entrant — while its neighbour fed by a real pair does", () => {
    // `generateSingleElim` awards a bye at generation: round 0 holds the real
    // entrant against an empty "Bye" side, already decided.
    const doc = hubDoc({
      matches: [
        ko("b1", "completed", QF, [S("Ivy"), tbd("Bye")], 0),
        ko("b2", "upcoming", QF, [S("Jon"), S("Kit")]),
        ko("bs", "upcoming", SF, [tbd("Winner of R1·1"), tbd("Winner of R1·2")]),
      ],
      knockouts: [
        knockoutView("bye", "premier", [koRound("main-1", QF, ["b1", "b2"]), koRound("main-2", SF, ["bs"])]),
      ],
    });
    const view = doc.knockouts[0]!;
    expect(pendingSide(view, "bs", 0, index(doc))).toBeNull();
    expect(pendingSide(view, "bs", 1, index(doc))).toEqual(pair("Jon", "Kit"));
  });

  it("a NON-drawable view never pairs, on the very shape that pairs when it can be drawn", () => {
    const flat = knockoutView("cup", "premier", ROUNDS, { drawable: false });
    const mx = index(MID);
    expect(pendingSide(flat, "s1", 1, mx)).toBeNull();
    expect(pendingSide(flat, "s2", 1, mx)).toBeNull();
    // The positive pair: the same rounds, drawable.
    expect(pendingSide(MID.knockouts[0]!, "s1", 1, mx)).toEqual(pair("Cara", "Dev"));
  });

  /** One Draw node's markup, from its testid to the end of its link. */
  const nodeOf = (h: string, id: string) => {
    const at = h.indexOf(`data-testid="mh-knockout-node-${id}"`);
    expect(at, `node ${id}`).toBeGreaterThan(-1);
    return h.slice(at, h.indexOf("</a>", at));
  };

  it("the Draw: a node waiting on a live or unplayed pair names the pair in the empty slot's muted style; a slot whose feeder is not ready keeps its sentence", () => {
    url.view = "draw";
    const h = render(MID);
    expect(nodeOf(h, "s1")).toMatch(/<span class="[^"]*italic[^"]*" title="Cara or Dev">Cara or Dev<\/span>/);
    expect(nodeOf(h, "s1")).not.toContain("Winner of QF 2");
    expect(nodeOf(h, "s1")).toContain(">Ana<");
    expect(nodeOf(h, "s2")).toContain(">Gus or Hal<");
    expect(nodeOf(h, "s2")).toContain(">Winner of QF 3<");
    expect(nodeOf(h, "f1")).toContain(">Winner of SF 1<");
    expect(nodeOf(h, "f1")).toContain(">Winner of SF 2<");
  });

  it("the Draw's bronze node reads the loser sentence while the final above it reads the pair — one semi, two slots", () => {
    url.view = "draw";
    const h = render(LATER);
    expect(nodeOf(h, "f1")).toContain(">Eli or Hal<");
    expect(nodeOf(h, "t1")).toContain(">Loser of Eli v Hal<");
    expect(nodeOf(h, "t1")).not.toContain("Eli or Hal");
    expect(nodeOf(h, "t1")).not.toContain("Loser of SF 2");
    // D4: the node's 184px column truncates a long pair, so every name carries
    // its DISPLAYED text as its title — the pair and the loser sentence, never
    // the engine's slot label behind them, and never the other side's name.
    const titled = (node: string) =>
      [...node.matchAll(/ title="([^"]*)">([^<]*)<\/span>/g)].map((x) => [x[1], x[2]]);
    expect(titled(nodeOf(h, "f1"))).toEqual([
      ["Dev", "Dev"],
      ["Eli or Hal", "Eli or Hal"],
    ]);
    expect(titled(nodeOf(h, "t1"))).toEqual([
      ["Ana", "Ana"],
      ["Loser of Eli v Hal", "Loser of Eli v Hal"],
    ]);
  });

  it("the copy is the dictionary's — Spanish renders both sentences in Spanish", () => {
    url.view = "draw";
    const h = render(LATER, { dict: es as Dict, locale: "es" });
    const fill = (key: string) =>
      (es as Record<string, string>)[key]!.replace("{a}", "Eli").replace("{b}", "Hal");
    expect(nodeOf(h, "f1")).toContain(`>${esc(fill("knockout.pendingPair"))}<`);
    expect(nodeOf(h, "t1")).toContain(`>${esc(fill("knockout.pendingLoser"))}<`);
    expect(fill("knockout.pendingLoser")).not.toBe("Loser of Eli v Hal");
    // The pair's separator is a WORD now (F5), so it is a locale's to choose —
    // and Spanish's is not English's.
    expect(fill("knockout.pendingPair")).not.toBe("Eli or Hal");
  });

  it("F5: a slot waiting on two DOUBLES entrants reads 'Ana Lee / Bo Kim or Cy Po / Di Wu' — each entrant's own name already carries ' / ', so the pair's separator is a word", () => {
    url.view = "draw";
    const h = render(DOUBLES);
    expect(nodeOf(h, "df")).toContain(">Ana Lee / Bo Kim or Cy Po / Di Wu<");
    expect(nodeOf(h, "df")).toContain(">Eve Ng / Fay Ho<");
    expect(nodeOf(h, "df")).not.toContain("Winner of SF 1");
    expect(nodeOf(h, "df")).not.toContain("Ana Lee / Bo Kim / Cy Po / Di Wu");
  });
});

describe("KnockoutTab — the Draw's crest (owner ruling v1, option b)", () => {
  // Three surfaces draw a match, and until this ruling only the Draw had no
  // crest: the Rounds cards carry one (`MatchCard`, via `EntityLogo`) and so
  // does the division page's bracket (`bracket.tsx`), which is going to
  // redirect here. The owner picked option (b): a crest ONLY where the side
  // has a real badge, and NOTHING otherwise — no placeholder tile, no "?". A
  // tree node is narrow, so a grey tile on 32 individual players costs every
  // name ~20px and says nothing, while a team draw — where the logo is the
  // point — gets it. The Rounds cards keep all three crest states.
  //
  // The chip is the division bracket's, read out of its SOURCE, so the two
  // trees cannot drift apart without this suite saying so.
  //
  // A class scan, not a measurement: vitest is `environment: "node"`, so these
  // pin what the markup ASKS for. That the name really ellipsizes beside the
  // chip is a browser's to show.
  const BRACKET_CHIP = readFileSync(new URL("../bracket.tsx", import.meta.url), "utf8").match(
    /<img src=\{badge\} alt="" className="([^"]+)" \/>/,
  )?.[1];
  const ANA_BADGE = "https://cdn.example.test/crests/ana.png";
  const LONG = "Oliver Whitcombe-Harrington of the North Harbour Racquets Club";
  const LONG_BADGE = "https://cdn.example.test/crests/whitcombe.png";
  const badged = (name: string, badgeUrl: string): Side => ({ ...S(name), badgeUrl });
  const CRESTS = hubDoc({
    matches: [
      ko("q1", "completed", QF, [badged("Ana", ANA_BADGE), S("Ben")], 0),
      ko("q2", "upcoming", QF, [badged(LONG, LONG_BADGE), S("Dev")]),
      // s1's away slot waits on q2, whose sides are both known, so the tab
      // renames it to the pair sentence — and there is still nobody in it.
      ko("s1", "upcoming", SF, [badged("Ana", ANA_BADGE), tbd("Winner of QF 2")]),
    ],
    knockouts: [
      knockoutView("cup", "premier", [koRound("main-1", QF, ["q1", "q2"]), koRound("main-2", SF, ["s1"])]),
    ],
  });
  const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** One Draw node's two side rows, in order. */
  const rowsOf = (h: string, id: string): [string, string] => {
    const at = h.indexOf(`data-testid="mh-knockout-node-${id}"`);
    expect(at, `node ${id}`).toBeGreaterThan(-1);
    const node = h.slice(at, h.indexOf("</a>", at));
    const rows = node
      .split(`<span class="flex h-[22px]`)
      .slice(1)
      .map((row) => `<span class="flex h-[22px]${row}`);
    expect(rows, `node ${id} has two side rows`).toHaveLength(2);
    return rows as [string, string];
  };
  /** A row whose FIRST child is its name span: nothing is drawn in front of the name. */
  const nameFirst = (name: string) =>
    new RegExp(`^<span class="flex h-\\[22px\\][^"]*"><span class="[^"]*" title="${reEsc(name)}">${reEsc(name)}</span>`);

  it("the premise: the division bracket's chip is found in its source, and it is the 14px box that fits a 22px row", () => {
    expect(BRACKET_CHIP, "bracket.tsx's crest <img>").toBeDefined();
    expect(BRACKET_CHIP!.split(" ")).toEqual(expect.arrayContaining(["h-3.5", "w-3.5"]));
  });

  it("a side WITH a badge draws the division bracket's chip, token for token, in front of its name", () => {
    url.view = "draw";
    const [ana, ben] = rowsOf(render(CRESTS), "q1");
    expect(ana).toMatch(
      new RegExp(
        `^<span class="flex h-\\[22px\\][^"]*"><img src="${reEsc(ANA_BADGE)}" alt="" class="${reEsc(BRACKET_CHIP!)}"/><span class="[^"]*" title="Ana">Ana</span>`,
      ),
    );
    expect(ben).toContain(">Ben</span>");
  });

  it("a side WITHOUT a badge draws its name and NO chip — no img, no placeholder, nothing in front of the name", () => {
    url.view = "draw";
    const h = render(CRESTS);
    const [ana, ben] = rowsOf(h, "q1");
    expect(ben).not.toContain("<img");
    expect(ben).not.toContain("data-crest");
    expect(ben).toMatch(nameFirst("Ben"));
    // The positive pair, same node: the badged side does draw one.
    expect(ana).toContain(`<img src="${ANA_BADGE}"`);
  });

  it("a PENDING slot keeps its italic feeder text and draws no chip, beside a badged entrant that does; a tree with no badge anywhere draws none", () => {
    url.view = "draw";
    const h = render(CRESTS);
    const [ana, slot] = rowsOf(h, "s1");
    const pair = `${LONG} or Dev`;
    expect(slot).toMatch(nameFirst(pair));
    expect(slot).toMatch(new RegExp(`<span class="[^"]*italic[^"]*" title="${reEsc(pair)}">`));
    expect(slot).not.toContain("<img");
    expect(ana).toContain(`<img src="${ANA_BADGE}"`);

    // MID carries no badge at all; its final still waits on the engine's own
    // "Winner of SF 1" sentence. Not one chip in the whole tree.
    const mid = render(MID);
    const tree = mid.slice(mid.indexOf(`data-testid="mh-knockout-draw-region-${VIEW}"`));
    expect(tree).toContain(">Winner of SF 1<");
    expect(tree).not.toContain("<img");
  });

  it("with a badge the name keeps min-w-0 flex-1 truncate and the chip shrink-0", () => {
    url.view = "draw";
    const [long] = rowsOf(render(CRESTS), "q2");
    expect(long).toContain(`<img src="${LONG_BADGE}"`);
    expect(long.match(/<img [^>]*class="([^"]*)"/)?.[1]?.split(" ")).toContain("shrink-0");
    expect(long.match(/^<span class="([^"]*)"/)?.[1]?.split(" ")).toEqual(expect.arrayContaining(["flex", "min-w-0"]));
    const name = long.match(new RegExp(`<span class="([^"]*)" title="${reEsc(LONG)}">${reEsc(LONG)}</span>`))?.[1];
    expect(name, "the long name's span, titled with the whole name").toBeDefined();
    expect(name!.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "truncate"]));
  });
});

describe("KnockoutTab — a feeder label wraps on a phone instead of truncating (C-2)", () => {
  // Visual gate, pending-slot-cards-320: a 32-draw's semi-final cards both read
  // "Winner of Quarter-finals, matc…", so which quarter-final feeds which semi
  // could not be told apart. At 390 the same labels fit. This is that screen's
  // shape. The semi-finals are this view's FIRST round, so it opens on them and
  // no pair sentence replaces the document's own labels. One card is a real
  // entrant against a feeder label, the other is two feeder labels.
  //
  // A class scan (vitest is `environment: "node"`): it pins that each label is
  // in the markup whole and that its span asks to wrap below md. That it really
  // takes a second line at 320 is not something this environment can see.
  const labels = [
    "Winner of Quarter-finals, match 2",
    "Winner of Quarter-finals, match 3",
    "Winner of Quarter-finals, match 4",
  ];
  const FEEDERS = hubDoc({
    matches: [
      ko("s1", "upcoming", SF, [S("Amelia Hartley"), tbd(labels[0]!)]),
      ko("s2", "upcoming", SF, [tbd(labels[1]!), tbd(labels[2]!)]),
      ko("f1", "upcoming", F, [tbd("Winner of Semi-finals, match 1"), tbd("Winner of Semi-finals, match 2")]),
    ],
    knockouts: [knockoutView("cup", "premier", [koRound("main-1", SF, ["s1", "s2"]), koRound("main-2", F, ["f1"])])],
  });

  it("each semi-final card carries its feeder label WHOLE, in a span that wraps below md; the real entrant beside it keeps its ellipsis", () => {
    const h = render(FEEDERS);
    expect(cardIds(h)).toEqual(["s1", "s2"]);
    const nameClass = (title: string) => {
      const found = h.match(new RegExp(`<span class="([^"]*)" title="${title}">${title}</span>`))?.[1];
      expect(found, `"${title}", whole`).toBeDefined();
      return found!.split(" ");
    };
    for (const label of labels) {
      const tokens = nameClass(label);
      expect(tokens, label).toEqual(expect.arrayContaining(["break-words", "md:truncate"]));
      expect(tokens, `${label}: no truncation below md`).not.toContain("truncate");
    }
    const amelia = nameClass("Amelia Hartley");
    expect(amelia).toContain("truncate");
    expect(amelia).not.toContain("break-words");
  });
});

describe("KnockoutTab — the champion banner", () => {
  it("present when the view names a champion fixture: the WINNER's name, and who they beat in which round", () => {
    const h = render(doneDoc("f1"));
    const at = h.indexOf(`data-testid="mh-knockout-champion-${VIEW}"`);
    expect(at).toBeGreaterThan(-1);
    const banner = h.slice(at, h.indexOf(`data-testid="mh-knockout-rail-${VIEW}"`));
    expect(banner).toContain(">Champion<");
    // Eli won the final as the AWAY side; Dev lost it.
    expect(banner).toContain(">Eli<");
    expect(banner).toContain(">Beat Dev in the Final<");
    expect(banner).not.toContain(">Dev<");
    expect(banner).not.toContain("walkover");
    for (const token of ["bg-court", "text-court-ink"]) {
      expect(classOf(h, `mh-knockout-champion-${VIEW}`), token).toContain(token);
    }
  });

  it("a final won by FORFEIT says so — 'Won the Final by walkover against Dev', never 'Beat Dev'", () => {
    // The builder's own forfeited final carries exactly this status line
    // (`competition-hub.test.ts` witnesses it on the real producer).
    const forfeited = DONE_MATCHES.map((x) =>
      x.fixtureId === "f1"
        ? {
            ...x,
            header: {
              ...x.header,
              status: "other" as const,
              statusLine: { key: "matchCentre.status.forfeited" },
            },
          }
        : x,
    );
    const h = render(
      hubDoc({
        matches: forfeited,
        knockouts: [knockoutView("cup", "premier", ROUNDS, { championFixtureId: "f1" })],
      }),
    );
    const at = h.indexOf(`data-testid="mh-knockout-champion-${VIEW}"`);
    expect(at).toBeGreaterThan(-1);
    const banner = h.slice(at, h.indexOf(`data-testid="mh-knockout-rail-${VIEW}"`));
    expect(banner).toContain(">Eli<");
    expect(banner).toContain(">Won the Final by walkover against Dev<");
    expect(banner).not.toContain("Beat Dev");
  });

  it("ABSENT on the same finished draw when the document names no champion (the builder withholds it, the tab does not second-guess)", () => {
    expect(render(doneDoc(null))).not.toContain(`data-testid="mh-knockout-champion-`);
  });
});

describe("KnockoutTab — the line under each card", () => {
  it("every branch, each on its own fixture, naming the NEXT round", () => {
    const h = render(MID);
    expect(nextText(h, "q1")).toBe("Ana goes through to the Semi-finals");
    expect(nextText(h, "q2")).toBe("Winner meets Ana in the Semi-finals");
    expect(nextText(h, "q3")).toBe("Winner meets the winner of Gus v Hal in the Semi-finals");
    expect(nextText(h, "q4")).toBe("Winner goes through to the Semi-finals");
  });

  it("the semi-finals point at the FINAL, stepping over the third-place round between them", () => {
    const matches = new Map(LATER.matches.map((x) => [x.fixtureId, x]));
    const view = LATER.knockouts[0]!;
    expect(nextLine(view, "main-2", "s1", matches)).toEqual({
      key: "knockout.next.through",
      vars: { name: "Dev", round: F },
    });
    expect(nextLine(view, "main-2", "s2", matches)).toEqual({
      key: "knockout.next.meets",
      vars: { name: "Dev", round: F },
    });
  });

  it("the final and the third-place round have no line — nothing comes after them", () => {
    const matches = new Map(MID.matches.map((x) => [x.fixtureId, x]));
    const view = MID.knockouts[0]!;
    expect(nextLine(view, "main-3", "f1", matches)).toBeNull();
    expect(nextLine(view, "third-place", "t1", matches)).toBeNull();
  });

  it("a NON-drawable view carries no line at all (its rounds do not feed each other in pairs)", () => {
    const flat = hubDoc({
      matches: MID_MATCHES,
      knockouts: [knockoutView("cup", "premier", ROUNDS, { drawable: false })],
    });
    const h = render(flat);
    expect(cardIds(h)).toEqual(["q1", "q2", "q3", "q4"]); // the cards are still there
    expect(h).not.toContain(`data-testid="mh-knockout-next-`);
    expect(nextLine(flat.knockouts[0]!, "main-1", "q1", new Map(MID_MATCHES.map((x) => [x.fixtureId, x])))).toBeNull();
  });

  it("a LIVE match carrying a winner does not yet 'go through' — only a finished one does", () => {
    const live = ko("q1", "live", QF, [S("Ana"), S("Ben")], 0);
    const matches = new Map([...MID_MATCHES.slice(1), live].map((x) => [x.fixtureId, x]));
    const line = nextLine(MID.knockouts[0]!, "main-1", "q1", matches);
    expect(line?.key).not.toBe("knockout.next.through");
    // And its partner no longer treats it as decided either.
    expect(nextLine(MID.knockouts[0]!, "main-1", "q2", matches)?.key).not.toBe("knockout.next.meets");
  });

  it("an odd round with no partner falls back to 'goes through', never a crash", () => {
    const odd = knockoutView("cup", "premier", [
      koRound("main-1", QF, ["q1", "q2", "q3"]),
      koRound("main-2", SF, ["s1", "s2"]),
    ]);
    const matches = new Map(MID_MATCHES.map((x) => [x.fixtureId, x]));
    expect(nextLine(odd, "main-1", "q3", matches)).toEqual({
      key: "knockout.next.advances",
      vars: { round: SF },
    });
  });

  it("the copy is the dictionary's — Spanish renders Spanish, with the same names and round", () => {
    const h = render(MID, { dict: es as Dict, locale: "es" });
    const want = (es as Record<string, string>)["knockout.next.through"]!
      .replace("{round}", SF)
      .replace("{name}", "Ana");
    expect(nextText(h, "q1")).toBe(want);
    expect(want).not.toBe("Ana goes through to the Semi-finals");
    expect(h).toContain(`aria-label="${esc((es as Record<string, string>)["knockout.roundsLabel"]!)}"`);
  });
});

describe("KnockoutTab — the view switch and the Draw", () => {
  it("a drawable view gets the switch, in a container hidden below the large breakpoint, opening on Rounds", () => {
    const h = render(MID);
    expect(classOf(h, "mh-knockout-view")).toContain("max-lg:hidden");
    expect(tagOf(h, "mh-knockout-view-rounds")).toContain(`aria-pressed="true"`);
    expect(tagOf(h, "mh-knockout-view-draw")).toContain(`aria-pressed="false"`);
    expect(h).toMatch(/data-testid="mh-knockout-view"[^>]*role="group"[^>]*aria-label="View"/);
  });

  it("a NON-drawable view gets NO switch", () => {
    const flat = hubDoc({
      matches: MID_MATCHES,
      knockouts: [knockoutView("cup", "premier", ROUNDS, { drawable: false })],
    });
    const h = render(flat);
    expect(h).not.toContain(`data-testid="mh-knockout-view"`);
    expect(h).not.toContain(`data-testid="mh-knockout-view-draw"`);
  });

  it("with no ?view= there is no Draw at all, and the rounds are not hidden at any width", () => {
    const h = render(MID);
    expect(h).not.toContain(`data-testid="mh-knockout-draw-`);
    expect(classOf(h, `mh-knockout-rounds-${VIEW}`)).not.toContain("lg:hidden");
  });

  it("?view=draw: the tree renders inside a block shown only from the large breakpoint, and the rounds hide from it", () => {
    url.view = "draw";
    const h = render(MID);
    const draw = classOf(h, `mh-knockout-draw-${VIEW}`);
    expect(draw).toContain("hidden");
    expect(draw).toContain("lg:block");
    const rounds = classOf(h, `mh-knockout-rounds-${VIEW}`);
    expect(rounds).toContain("lg:hidden");
    // Below the breakpoint a shared `?view=draw` link therefore shows Rounds:
    // the rounds block carries no bare `hidden`.
    expect(rounds).not.toContain("hidden");
    expect(tagOf(h, "mh-knockout-view-draw")).toContain(`aria-pressed="true"`);
  });

  it("the Draw scrolls inside its own focusable, named region (AGENTS.md 23)", () => {
    url.view = "draw";
    const h = render(MID);
    expect(h).toMatch(
      new RegExp(
        `data-testid="mh-knockout-draw-region-${VIEW}"[^>]*role="region"[^>]*tabindex="0"[^>]*aria-label="Knockout draw"`,
      ),
    );
    expect(classOf(h, `mh-knockout-draw-region-${VIEW}`)).toContain("overflow-x-auto");
  });

  it("a NON-drawable view IGNORES ?view=draw — no tree, and its rounds stay visible at every width", () => {
    url.view = "draw";
    const flat = hubDoc({
      matches: MID_MATCHES,
      knockouts: [knockoutView("cup", "premier", ROUNDS, { drawable: false })],
    });
    const h = render(flat);
    expect(h).not.toContain(`data-testid="mh-knockout-draw-`);
    expect(classOf(h, `mh-knockout-rounds-${VIEW}`)).not.toContain("lg:hidden");
  });

  it("the tree: one column per round EXCEPT third place, in order, cells doubling, third place under the final", () => {
    url.view = "draw";
    const h = render(MID);
    const cols = [...h.matchAll(/data-testid="mh-knockout-col-premier-cup-([^"]+)"/g)].map((x) => x[1]);
    expect(cols).toEqual(["main-1", "main-2", "main-3"]);
    for (const key of cols) {
      expect(classOf(h, `mh-knockout-col-${VIEW}-${key}`), key).toContain("w-[184px]");
    }
    const colHtml = (key: string, until: string) =>
      h.slice(h.indexOf(`data-testid="mh-knockout-col-${VIEW}-${key}"`), until ? h.indexOf(until) : undefined);
    const heights = (s: string) => [...s.matchAll(/style="height:(\d+)px"/g)].map((x) => Number(x[1]));
    expect(heights(colHtml("main-1", `data-testid="mh-knockout-col-${VIEW}-main-2"`))).toEqual([64, 64, 64, 64]);
    expect(heights(colHtml("main-2", `data-testid="mh-knockout-col-${VIEW}-main-3"`))).toEqual([128, 128]);
    // The final's column: one 256px cell (64 · 2² for the third round of an
    // 8-draw), then the third-place node at round 0's 64px.
    expect(heights(colHtml("main-3", ""))).toEqual([256, 64]);
    // The third-place node sits in the FINAL's column, after the final's node.
    const finalCol = h.indexOf(`data-testid="mh-knockout-col-${VIEW}-main-3"`);
    expect(h.indexOf(`data-testid="mh-knockout-node-f1"`)).toBeGreaterThan(finalCol);
    expect(h.indexOf(`data-testid="mh-knockout-node-t1"`)).toBeGreaterThan(
      h.indexOf(`data-testid="mh-knockout-node-f1"`),
    );
    expect(h.slice(finalCol)).toContain(`>${TP}<`);
  });

  it("a node links to its match, bolds the winner, shows each side's score, and outlines a live match", () => {
    url.view = "draw";
    const h = render(MID);
    expect(tagOf(h, "mh-knockout-node-q1")).toContain(`href="/riverside/autumn-cup/premier/fixtures/q1"`);
    const node = (id: string) => h.slice(h.indexOf(`data-testid="mh-knockout-node-${id}"`), h.indexOf("</a>", h.indexOf(`data-testid="mh-knockout-node-${id}"`)));
    expect(node("q1")).toMatch(/<span class="[^"]*font-semibold[^"]*"[^>]*>Ana<\/span>/);
    expect(node("q1")).not.toMatch(/<span class="[^"]*font-semibold[^"]*"[^>]*>Ben<\/span>/);
    expect(node("q1")).toContain(">2</span>");
    expect(classOf(h, "mh-knockout-node-q4")).toContain("border-emerald-400");
    expect(classOf(h, "mh-knockout-node-q2")).not.toContain("border-emerald-400");
  });

  // C2 (fix round): at lg the switch sat on a row of its own — under the
  // division chips, or alone above the one division's heading, a ~70px band.
  // It now shares ONE row: the division chips on the left when there is a
  // rail, otherwise the division's heading; the switch on the right.
  //
  // What these REPLACE is the earlier "the switch is a direct child of the
  // root" pin, and its reason still holds: Tailwind v4's `space-y-*` is
  // `margin-block-end` on every child but the last, so a VISIBLE wrapper whose
  // only content is the switch (hidden below lg) would keep that margin as a
  // blank band on every phone. The wrappers below never hold the switch alone
  // — the heading, or the division rail, is always beside it and always shown
  // — and every class they carry is `lg:`-prefixed, so below lg each is a
  // plain block that lays out exactly as its content did without it.
  const lgOnly = (tokens: string[]) => tokens.filter((c) => !c.startsWith("lg:"));

  it("ONE division: the switch shares the division heading's row, in a bar that is a plain block below lg", () => {
    const h = render(MID);
    expect(h).toMatch(
      /^<div data-testid="mh-knockout" class="[^"]*"><section [^>]*><div data-testid="mh-knockout-titlebar-premier" class="[^"]*"><h2 data-testid="mh-knockout-heading-premier" class="[^"]*">Premier<\/h2><div data-testid="mh-knockout-view"/,
    );
    const bar = classOf(h, "mh-knockout-titlebar-premier");
    for (const token of ["lg:flex", "lg:items-center", "lg:justify-between"]) expect(bar, token).toContain(token);
    expect(lgOnly(bar), "nothing applies below lg").toEqual([]);
    expect(h.match(/data-testid="mh-knockout-view"/g)).toHaveLength(1);
    // No toolbar at all: there is no rail for the switch to sit beside.
    expect(h).not.toContain(`data-testid="mh-knockout-toolbar"`);
  });

  it("ONE division, TWO stages: still one heading row and one switch in it", () => {
    const h = render(
      hubDoc({
        matches: [...MID_MATCHES, ...PLATE_MATCHES.map((x) => ({ ...x, divisionSlug: "premier", divisionId: "d-premier", divisionName: "Premier" }))],
        knockouts: [
          knockoutView("cup", "premier", ROUNDS),
          knockoutView("plate", "premier", PLATE_ROUNDS, { stageName: "Plate", drawable: true }),
        ],
      }),
    );
    expect(h.match(/data-testid="mh-knockout-view"/g)).toHaveLength(1);
    expect(h).toMatch(/<\/h2><div data-testid="mh-knockout-view"/);
  });

  it("TWO divisions: the division chips lead the toolbar and the switch follows them in the same bar; no heading holds a switch", () => {
    const multi = render(MULTI);
    expect(multi).toMatch(
      /^<div data-testid="mh-knockout" class="[^"]*"><div data-testid="mh-knockout-toolbar" class="[^"]*"><div data-testid="mh-knockout-divisions"/,
    );
    // The switch opens straight after the division rail closes, and the bar
    // closes straight after the switch — both inside it.
    expect(multi).toMatch(/<\/button><\/div><div data-testid="mh-knockout-view"[^>]*>(<button[^>]*>[^<]*<\/button>){2}<\/div><\/div><section/);
    const bar = classOf(multi, "mh-knockout-toolbar");
    for (const token of ["lg:flex", "lg:items-start", "lg:justify-between"]) expect(bar, token).toContain(token);
    expect(lgOnly(bar), "nothing applies below lg").toEqual([]);
    expect(multi.match(/data-testid="mh-knockout-view"/g)).toHaveLength(1);
    expect(multi).not.toMatch(/<\/h2><div data-testid="mh-knockout-view"/);
  });

  it("the division rail is still FIRST in the panel and each heading still FIRST in its section — what a phone reads is unmoved", () => {
    const multi = render(MULTI);
    expect(multi.indexOf(`data-testid="mh-knockout-divisions"`)).toBeLessThan(multi.indexOf("<section"));
    expect(multi).toMatch(/<section [^>]*><div data-testid="mh-knockout-titlebar-premier" class="[^"]*"><h2 /);
    expect(multi).toMatch(/<section [^>]*><div data-testid="mh-knockout-titlebar-sunday-league" class="[^"]*"><h2 /);
  });

  it("?view=draw below lg: the stage lays out with a flex GAP, not space-y — the hidden tree leaves no margin under the rounds", () => {
    // `space-y-3` put `margin-block-end` on the rounds block because the
    // tree after it is not the last child — but below lg the tree is not
    // rendered, so that margin was 12px of nothing. A flex gap is only laid
    // between boxes that exist.
    url.view = "draw";
    const h = render(MID);
    const stage = classOf(h, `mh-knockout-stage-${VIEW}`);
    for (const token of ["flex", "flex-col", "gap-3"]) expect(stage, token).toContain(token);
    expect(stage.filter((c) => c.startsWith("space-y-"))).toEqual([]);
    // The tree is a direct child, straight after the rounds block…
    expect(h).toContain(
      `</ul></div><div data-testid="mh-knockout-draw-${VIEW}" class="hidden lg:block">`,
    );
    // …and neither carries a margin of its own to reintroduce the band.
    for (const testid of [`mh-knockout-rounds-${VIEW}`, `mh-knockout-draw-${VIEW}`]) {
      expect(classOf(h, testid).filter((c) => /^m[tby]?-/.test(c)), testid).toEqual([]);
    }
  });

  it("the switch follows the brackets ON SCREEN — narrowed to a division whose only bracket cannot be drawn, there is no switch", () => {
    const mixed = hubDoc({
      matches: [...MID_MATCHES, ...PLATE_MATCHES],
      knockouts: [knockoutView("cup", "premier", ROUNDS), plateView({ drawable: false })],
    });
    // Positive pair: All shows the drawable cup, so the switch is there.
    expect(render(mixed)).toContain(`data-testid="mh-knockout-view"`);
    const narrowed = render(mixed, { initialDivision: "sunday-league" });
    expect(narrowed).toContain(`data-testid="mh-knockout-stage-sunday-league-plate"`); // the premise
    expect(narrowed).not.toContain(`data-testid="mh-knockout-stage-${VIEW}"`);
    expect(narrowed).not.toContain(`data-testid="mh-knockout-view"`);
  });

  it("a 32-draw FITS a 1024px window: five 184px columns and four 12px gaps are 968px, inside the 977px column", () => {
    // 977 = 1024 − 15 (a classic, space-taking scrollbar) − 32 (the public
    // layout's `px-4`, both sides). The widths are READ off the markup, not
    // typed here, so moving the column class moves this sum with it.
    url.view = "draw";
    const sizes = [16, 8, 4, 2, 1];
    const labels = ["Round of 32", "Round of 16", QF, SF, F];
    const rounds = sizes.map((n, k) =>
      koRound(
        `main-${k + 1}`,
        labels[k]!,
        Array.from({ length: n }, (_, i) => `r${k}-${i + 1}`),
      ),
    );
    const doc = hubDoc({
      matches: rounds.flatMap((r) =>
        r.fixtureIds.map((id) => ko(id, "upcoming", r.label, [S(`Home ${id}`), S(`Away ${id}`)])),
      ),
      knockouts: [knockoutView("cup", "premier", rounds)],
    });
    const h = render(doc);
    const cols = [...h.matchAll(/data-testid="mh-knockout-col-premier-cup-[^"]+" class="([^"]*)"/g)].map(
      (x) => x[1]!.split(" "),
    );
    expect(cols).toHaveLength(5);
    const widths = cols.map((tokens) =>
      Number(tokens.find((c) => /^w-\[\d+px\]$/.test(c))?.match(/\d+/)?.[0]),
    );
    const row = h
      .match(new RegExp(`data-testid="mh-knockout-draw-region-${VIEW}"[^>]*><div class="([^"]*)"`))?.[1]
      ?.split(" ");
    const gapToken = row?.find((c) => /^gap-\d+$/.test(c));
    expect(gapToken, "the column row's gap").toBeDefined();
    // Tailwind v4 spacing: one unit is 0.25rem, 4px.
    const gap = Number(gapToken!.slice("gap-".length)) * 4;
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * (cols.length - 1);
    expect(widths).toEqual([184, 184, 184, 184, 184]);
    expect(total).toBe(968);
    expect(total).toBeLessThanOrEqual(977);
    // Every column is exactly as tall as round 0's sixteen 64px cells, so each
    // node sits centred against the two that feed it and the final is 1024px.
    const colHtml = (k: number) =>
      h.slice(
        h.indexOf(`data-testid="mh-knockout-col-${VIEW}-main-${k + 1}"`),
        k + 1 < sizes.length ? h.indexOf(`data-testid="mh-knockout-col-${VIEW}-main-${k + 2}"`) : undefined,
      );
    const heights = (s: string) => [...s.matchAll(/style="height:(\d+)px"/g)].map((x) => Number(x[1]));
    sizes.forEach((n, k) => {
      expect(heights(colHtml(k)), `column ${k}`).toEqual(Array.from({ length: n }, () => 64 * 2 ** k));
    });
  });

  it("connectors: an even node's stroke runs DOWN to its pair, an odd node's UP; the last column sends none out, and every later column has one coming in", () => {
    url.view = "draw";
    const h = render(MID);
    const col = (key: string, next?: string) =>
      h.slice(
        h.indexOf(`data-testid="mh-knockout-col-${VIEW}-${key}"`),
        next ? h.indexOf(`data-testid="mh-knockout-col-${VIEW}-${next}"`) : undefined,
      );
    /** Per cell, the class tokens of each decorative stroke before its node. */
    const strokes = (html: string) =>
      [...html.matchAll(/style="height:\d+px">(.*?)<a /g)].map((cell) =>
        [...cell[1]!.matchAll(/<span aria-hidden="true" class="([^"]*)"><\/span>/g)].map((s) =>
          s[1]!.split(" "),
        ),
      );
    const out = (spans: string[][]) => spans.filter((s) => s.includes("left-full"));
    const inn = (spans: string[][]) => spans.filter((s) => s.includes("right-full"));
    const down = ["top-1/2", "h-1/2", "border-t-2", "border-r-2"];
    const up = ["bottom-1/2", "h-1/2", "border-b-2", "border-r-2"];

    const quarters = strokes(col("main-1", "main-2"));
    expect(quarters).toHaveLength(4);
    quarters.forEach((spans, i) => {
      expect(out(spans), `QF ${i} sends one stroke out`).toHaveLength(1);
      expect(out(spans)[0], `QF ${i}`).toEqual(expect.arrayContaining(i % 2 === 0 ? down : up));
      expect(out(spans)[0], `QF ${i}`).not.toContain(i % 2 === 0 ? "bottom-1/2" : "top-1/2");
      expect(inn(spans), `QF ${i} has nothing coming in`).toEqual([]);
    });

    const semis = strokes(col("main-2", "main-3"));
    expect(semis.map((spans) => [out(spans).length, inn(spans).length])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(out(semis[0]!)[0]).toEqual(expect.arrayContaining(down));
    expect(out(semis[1]!)[0]).toEqual(expect.arrayContaining(up));

    // The final, then the third-place node under it: nothing goes out of the
    // last column, one stroke comes into the final, none into the bronze.
    const last = strokes(col("main-3"));
    expect(last.map((spans) => [out(spans).length, inn(spans).length])).toEqual([
      [0, 1],
      [0, 0],
    ]);
  });

  it("TWO drawable views share ONE switch — `?view=` is one parameter for the whole tab", () => {
    const h = render(
      hubDoc({
        matches: [...MID_MATCHES, ...PLATE_MATCHES],
        knockouts: [knockoutView("cup", "premier", ROUNDS), plateView({ drawable: true })],
      }),
    );
    expect(h.match(/data-testid="mh-knockout-view-draw"/g)).toHaveLength(1);
  });

  it("knockoutMode: a tap wins, else only the exact `draw` value opens the Draw", () => {
    expect(knockoutMode(null, null)).toBe("rounds");
    expect(knockoutMode(null, "draw")).toBe("draw");
    expect(knockoutMode(null, "")).toBe("rounds");
    expect(knockoutMode(null, "rounds")).toBe("rounds");
    expect(knockoutMode(null, "DRAW")).toBe("rounds");
    expect(knockoutMode("rounds", "draw")).toBe("rounds");
    expect(knockoutMode("draw", null)).toBe("draw");
  });
});

describe("KnockoutTab — which division", () => {
  it("views from TWO divisions: a rail led by All (pressed), then one chip per division, with the Matches tab's own copy", () => {
    const h = render(MULTI);
    expect(h).toMatch(
      /data-testid="mh-knockout-divisions"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="Filter by division"/,
    );
    expect(h).toMatch(/data-testid="mh-knockout-division-all"[^>]*aria-pressed="true"[^>]*>All divisions</);
    expect(h).toMatch(/data-testid="mh-knockout-division-premier"[^>]*aria-pressed="false"[^>]*>Premier</);
    expect(h).toMatch(
      /data-testid="mh-knockout-division-sunday-league"[^>]*aria-pressed="false"[^>]*>Sunday League</,
    );
    expect(h.indexOf(`data-testid="mh-knockout-division-all"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-knockout-division-premier"`),
    );
    // All = every division's views, each under its OWN heading — the second
    // group's name asserted too, because the first is the one a document-wide
    // read gets right by accident.
    expect(h).toContain(`data-testid="mh-knockout-stage-${VIEW}"`);
    expect(h).toContain(`data-testid="mh-knockout-stage-sunday-league-plate"`);
    expect(h).toMatch(/<h2 data-testid="mh-knockout-heading-premier" class="[^"]*">Premier<\/h2>/);
    expect(h).toMatch(/<h2 data-testid="mh-knockout-heading-sunday-league" class="[^"]*">Sunday League<\/h2>/);
  });

  it("TWO stages in ONE division: no rail — one division is no choice", () => {
    const h = render(
      hubDoc({
        matches: [...MID_MATCHES, ...PLATE_MATCHES.map((x) => ({ ...x, divisionSlug: "premier", divisionId: "d-premier", divisionName: "Premier" }))],
        knockouts: [
          knockoutView("cup", "premier", ROUNDS),
          knockoutView("plate", "premier", PLATE_ROUNDS, { stageName: "Plate" }),
        ],
      }),
    );
    expect(h).not.toContain(`data-testid="mh-knockout-divisions"`);
    expect(h).toContain(`data-testid="mh-knockout-stage-premier-plate"`);
    // One heading for the one division, two stage headings under it.
    expect(h.match(/<h2 /g)).toHaveLength(1);
    expect(h).toMatch(/<h3 [^>]*>Cup<\/h3>/);
    expect(h).toMatch(/<h3 [^>]*>Plate<\/h3>/);
  });

  it("?division= seeds the choice: only that division's bracket renders, and its chip is the pressed one", () => {
    const h = render(MULTI, { initialDivision: "sunday-league" });
    expect(h).toMatch(/data-testid="mh-knockout-division-sunday-league"[^>]*aria-pressed="true"/);
    expect(h).toMatch(/data-testid="mh-knockout-division-all"[^>]*aria-pressed="false"/);
    expect(h).toContain(`data-testid="mh-knockout-stage-sunday-league-plate"`);
    expect(h).not.toContain(`data-testid="mh-knockout-stage-${VIEW}"`);
  });

  it("an UNKNOWN slug falls back to All — both brackets render and All is pressed", () => {
    const h = render(MULTI, { initialDivision: "ghost" });
    expect(h).toMatch(/data-testid="mh-knockout-division-all"[^>]*aria-pressed="true"/);
    expect(h).toContain(`data-testid="mh-knockout-stage-${VIEW}"`);
    expect(h).toContain(`data-testid="mh-knockout-stage-sunday-league-plate"`);
  });

  it("a bare ?division= (the empty string) falls back to All too", () => {
    const h = render(MULTI, { initialDivision: "" });
    expect(h).toMatch(/data-testid="mh-knockout-division-all"[^>]*aria-pressed="true"/);
    expect(h).toContain(`data-testid="mh-knockout-stage-sunday-league-plate"`);
  });

  it("a division chosen while there is NO rail falls back to All (nothing on screen could clear it)", () => {
    const h = render(MID, { initialDivision: "sunday-league" });
    expect(h).not.toContain(`data-testid="mh-knockout-divisions"`);
    expect(h).toContain(`data-testid="mh-knockout-stage-${VIEW}"`);
  });

  it("headings: an <h2> per division in the Table tab's classes, an <h3> per stage, nothing deeper", () => {
    const h = render(MID);
    expect(h).toContain(
      `<h2 data-testid="mh-knockout-heading-premier" class="font-display text-xl font-semibold tracking-tight text-ink md:text-2xl">Premier</h2>`,
    );
    expect(h).toMatch(/<h3 class="[^"]*">Cup<\/h3>/);
    expect(h).not.toContain("<h4");
  });
});

// ------------------------------------------------------------ taps and polls

describe("KnockoutTab — taps and polls", () => {
  const find = (tree: ReactElement[], testid: string) => {
    const el = tree.find((x) => propsOf(x)["data-testid"] === testid);
    expect(el, testid).toBeDefined();
    return el!;
  };
  const cards = (tree: ReactElement[]) =>
    tree.filter((x) => x.type === MatchCard).map((x) => (propsOf(x).match as HubMatchT).fixtureId);
  const pressed = (tree: ReactElement[], prefix: string) =>
    tree
      .filter((x) => String(propsOf(x)["data-testid"] ?? "").startsWith(prefix) && propsOf(x)["aria-pressed"] === true)
      .map((x) => propsOf(x)["data-testid"]);
  const tap = (tree: ReactElement[], testid: string) => (propsOf(find(tree, testid)).onClick as () => void)();

  /** A window whose `replaceState` really rewrites the location, as a browser does. */
  function stubLocation(href: string) {
    const loc = { href, search: new URL(href).search };
    const replaced: string[] = [];
    vi.stubGlobal("window", {
      location: loc,
      history: {
        replaceState: (_s: unknown, _t: unknown, next: string) => {
          replaced.push(next);
          const u = new URL(next);
          loc.href = u.toString();
          loc.search = u.search;
        },
      },
    });
    return replaced;
  }

  const mount = (doc: CompetitionHubDocT, initialDivision: string | null = null) =>
    renderIsland(KnockoutTab, { doc, dict, locale: "en" as const, now: NOW, initialDivision });

  it("tapping a round chip presses it and swaps the list — and the OTHER view's round does not move", () => {
    const island = mount(MULTI);
    expect(pressed(island.tree(), "mh-knockout-round-")).toEqual([
      `mh-knockout-round-${VIEW}-main-1`,
      "mh-knockout-round-sunday-league-plate-main-2",
    ]);
    tap(island.tree(), `mh-knockout-round-${VIEW}-main-3`);
    expect(pressed(island.tree(), "mh-knockout-round-")).toEqual([
      `mh-knockout-round-${VIEW}-main-3`,
      "mh-knockout-round-sunday-league-plate-main-2",
    ]);
    expect(cards(island.tree())).toEqual(["f1", "p3"]);
  });

  it("each bracket keeps its OWN round: tap the cup's semi-finals, then the plate's — the cup is still on its semi-finals", () => {
    const island = mount(MULTI);
    tap(island.tree(), `mh-knockout-round-${VIEW}-main-2`);
    tap(island.tree(), "mh-knockout-round-sunday-league-plate-main-1");
    expect(pressed(island.tree(), "mh-knockout-round-")).toEqual([
      `mh-knockout-round-${VIEW}-main-2`,
      "mh-knockout-round-sunday-league-plate-main-1",
    ]);
    expect(cards(island.tree())).toEqual(["s1", "s2", "p1", "p2"]);
  });

  it("the Draw switch writes `view=draw` into the URL and shows the tree; Rounds takes the parameter out", () => {
    const replaced = stubLocation("https://seazn.club/shared/riverside/autumn-cup?tab=knockout");
    const island = mount(MID);
    const hasDraw = () => island.tree().some((x) => propsOf(x)["data-testid"] === `mh-knockout-draw-${VIEW}`);
    expect(hasDraw()).toBe(false);

    tap(island.tree(), "mh-knockout-view-draw");
    expect(replaced).toEqual(["https://seazn.club/shared/riverside/autumn-cup?tab=knockout&view=draw"]);
    expect(hasDraw()).toBe(true);
    expect(propsOf(find(island.tree(), "mh-knockout-view-draw"))["aria-pressed"]).toBe(true);

    tap(island.tree(), "mh-knockout-view-rounds");
    expect(replaced.at(-1)).toBe("https://seazn.club/shared/riverside/autumn-cup?tab=knockout");
    expect(hasDraw()).toBe(false);
  });

  it("a division chip narrows the tab and writes `division=` back; All takes it out", () => {
    const replaced = stubLocation("https://seazn.club/shared/riverside/autumn-cup?tab=knockout");
    const island = mount(MULTI);
    tap(island.tree(), "mh-knockout-division-sunday-league");
    expect(replaced).toEqual([
      "https://seazn.club/shared/riverside/autumn-cup?tab=knockout&division=sunday-league",
    ]);
    expect(cards(island.tree())).toEqual(["p3"]);
    tap(island.tree(), "mh-knockout-division-all");
    expect(replaced.at(-1)).toBe("https://seazn.club/shared/riverside/autumn-cup?tab=knockout");
    expect(cards(island.tree())).toEqual(["q1", "q2", "q3", "q4", "p3"]);
  });

  /** The side names a card in the Rounds list was HANDED — `walk` never calls
   *  `MatchCard`, so this is the prop, the thing the card renders from. */
  const cardSides = (tree: ReactElement[], fixtureId: string) => {
    const card = tree.find((x) => x.type === MatchCard && (propsOf(x).match as HubMatchT).fixtureId === fixtureId);
    expect(card, `card ${fixtureId}`).toBeDefined();
    return (propsOf(card!).match as HubMatchT).header.sides.map((side) => side.name);
  };

  it("D1: every card in the Rounds list is told to drop its round caption", () => {
    const island = mount(MID);
    const handed = island.tree().filter((x) => x.type === MatchCard).map((x) => propsOf(x).showRound);
    expect(handed).toHaveLength(4);
    expect(handed.every((value) => value === false)).toBe(true);
  });

  it("D2 in the Rounds list: the final's card is handed the pair, the bronze card its loser sentence — the tree's own derivation", () => {
    const island = mount(LATER);
    tap(island.tree(), `mh-knockout-round-${VIEW}-main-3`);
    expect(cardSides(island.tree(), "f1")).toEqual(["Dev", "Eli or Hal"]);
    tap(island.tree(), `mh-knockout-round-${VIEW}-third-place`);
    expect(cardSides(island.tree(), "t1")).toEqual(["Ana", "Loser of Eli v Hal"]);
  });

  it("D2 in the Rounds list, NON-drawable: the semi-final card keeps the engine's sentence", () => {
    const island = mount(
      hubDoc({ matches: MID_MATCHES, knockouts: [knockoutView("cup", "premier", ROUNDS, { drawable: false })] }),
    );
    tap(island.tree(), `mh-knockout-round-${VIEW}-main-2`);
    expect(cardSides(island.tree(), "s1")).toEqual(["Ana", "Winner of QF 2"]);
    expect(cardSides(island.tree(), "s2")).toEqual(["Winner of QF 3", "Winner of QF 4"]);
  });

  // ── D3 through the REAL producer and consumer (fix round 2) ────────────────
  // `walk` never calls `MatchCard`, so the card a Rounds list HANDED is rendered
  // here by the real component: `withPendingSides` renames the side, `MatchCard`
  // decides its crest. A fixture on both ends would prove only the fixture.
  const cardHtml = (tree: ReactElement[], fixtureId: string) => {
    const card = tree.find((x) => x.type === MatchCard && (propsOf(x).match as HubMatchT).fixtureId === fixtureId);
    expect(card, `card ${fixtureId}`).toBeDefined();
    return renderToStaticMarkup(<MatchCard {...(propsOf(card!) as unknown as MatchCardProps)} />);
  };
  /** One side row of a rendered card, up to the next row or the card's footer. */
  const sideOf = (h: string, i: 0 | 1) => {
    const at = h.indexOf(`data-testid="mh-match-side-${i}"`);
    expect(at, `side ${i}`).toBeGreaterThan(-1);
    const ends = [h.indexOf(`data-testid="mh-match-side-`, at + 1), h.indexOf(`class="mt-2 flex`, at + 1)].filter(
      (x) => x > -1,
    );
    return h.slice(at, Math.min(...ends));
  };
  /** The placeholder crest: aria-hidden, marked, and nothing in it but "?". */
  const PENDING = /<span aria-hidden="true" data-crest="pending" class="[^"]*">\?<\/span>/;

  it("D3 on the Knockout cards: the pair, the loser sentence and the engine's slot label each wear the '?' placeholder; the real entrant beside each keeps its initials", () => {
    const later = mount(LATER);
    tap(later.tree(), `mh-knockout-round-${VIEW}-main-3`);
    const final = cardHtml(later.tree(), "f1");
    expect(sideOf(final, 1)).toContain(">Eli or Hal</span>"); // the premise: the pair was handed
    expect(sideOf(final, 1)).toMatch(PENDING);
    expect(sideOf(final, 1)).not.toContain(`>${initials("Eli or Hal")}<`);
    expect(sideOf(final, 0)).not.toContain("data-crest");
    expect(sideOf(final, 0)).toContain(`>${initials("Dev")}<`);

    tap(later.tree(), `mh-knockout-round-${VIEW}-third-place`);
    const bronze = cardHtml(later.tree(), "t1");
    expect(sideOf(bronze, 1)).toContain(">Loser of Eli v Hal</span>");
    expect(sideOf(bronze, 1)).toMatch(PENDING);
    expect(sideOf(bronze, 1)).not.toContain(`>${initials("Loser of Eli v Hal")}<`);
    expect(sideOf(bronze, 0)).not.toContain("data-crest");
    expect(sideOf(bronze, 0)).toContain(`>${initials("Ana")}<`);

    // MID opens on the quarter-finals (q4 is live), where q3's away slot is
    // still the engine's own sentence — round 0 has no feeder to pair.
    const mid = mount(MID);
    const q3 = cardHtml(mid.tree(), "q3");
    expect(sideOf(q3, 1)).toContain(">Winner of R1 6</span>");
    expect(sideOf(q3, 1)).toMatch(PENDING);
    expect(sideOf(q3, 1)).not.toContain(`>${initials("Winner of R1 6")}<`);
    expect(sideOf(q3, 0)).not.toContain("data-crest");
    expect(sideOf(q3, 0)).toContain(`>${initials("Eli")}<`);
  });

  it("D3 on the MATCHES tab too — the same MatchCard, so a pending bracket slot there wears the placeholder and a real entrant does not", () => {
    const h = renderToStaticMarkup(
      <MatchesTab doc={LATER} dict={dict} locale="en" now={NOW} initialFilter="upcoming" />,
    );
    const at = h.indexOf(`data-testid="mh-match-f1"`);
    expect(at, "the final's card is on the Matches tab").toBeGreaterThan(-1);
    const final = h.slice(at, h.indexOf("</a>", at));
    // The Matches tab does not rename: the engine's sentence, as the builder wrote it.
    expect(sideOf(final, 1)).toContain(">Winner of SF 2</span>");
    expect(sideOf(final, 1)).toMatch(PENDING);
    expect(sideOf(final, 1)).not.toContain(`>${initials("Winner of SF 2")}<`);
    expect(sideOf(final, 0)).not.toContain("data-crest");
    expect(sideOf(final, 0)).toContain(`>${initials("Dev")}<`);
  });

  it("F5 in the Rounds list: the doubles pair is handed whole with a word between the teams, and its crest is the placeholder", () => {
    const island = mount(DOUBLES);
    tap(island.tree(), `mh-knockout-round-${VIEW}-main-2`);
    expect(cardSides(island.tree(), "df")).toEqual(["Ana Lee / Bo Kim or Cy Po / Di Wu", "Eve Ng / Fay Ho"]);
    const h = cardHtml(island.tree(), "df");
    expect(sideOf(h, 0)).toMatch(PENDING);
    expect(sideOf(h, 0)).not.toContain(`>${initials("Ana Lee / Bo Kim or Cy Po / Di Wu")}<`);
    expect(sideOf(h, 1)).not.toContain("data-crest");
    expect(sideOf(h, 1)).toContain(`>${initials("Eve Ng / Fay Ho")}<`);
  });

  it("Round 2b on the Knockout cards: a round-0 BYE side is the empty box, while the next round's slot still waiting on a result keeps its '?'", () => {
    const doc = hubDoc({
      matches: [
        { ...ko("b1", "completed", QF, [S("Ivy"), tbd("Bye")], 0), byeSides: [false, true] },
        ko("b2", "upcoming", QF, [S("Jon"), S("Kit")]),
        ko("bs", "upcoming", SF, [S("Ivy"), tbd("Winner of R1·2")]),
      ],
      knockouts: [
        knockoutView("cup", "premier", [koRound("main-1", QF, ["b1", "b2"]), koRound("main-2", SF, ["bs"])]),
      ],
    });
    const island = mount(doc);
    const b1 = cardHtml(island.tree(), "b1");
    expect(sideOf(b1, 1)).toMatch(/<span aria-hidden="true" data-crest="empty" class="[^"]*"><\/span>/);
    expect(sideOf(b1, 1)).not.toContain('data-crest="pending"');
    expect(sideOf(b1, 0)).not.toContain("data-crest");

    tap(island.tree(), `mh-knockout-round-${VIEW}-main-2`);
    const bs = cardHtml(island.tree(), "bs");
    // bs's away slot is fed by b2 (unplayed, both known): the tab names the pair, the card keeps "?".
    expect(sideOf(bs, 1)).toContain(">Jon or Kit</span>");
    expect(sideOf(bs, 1)).toMatch(PENDING);
    expect(sideOf(bs, 1)).not.toContain('data-crest="empty"');
  });

  it("a chosen round that a later poll no longer carries falls back to the default — never a rail with nothing pressed", () => {
    const island = mount(LATER);
    tap(island.tree(), `mh-knockout-round-${VIEW}-main-3`);
    expect(pressed(island.tree(), "mh-knockout-round-")).toEqual([`mh-knockout-round-${VIEW}-main-3`]);

    // The next document has no final round (withdrawn and redrawn, say).
    const shorter = hubDoc({
      matches: LATER_MATCHES,
      knockouts: [knockoutView("cup", "premier", ROUNDS.slice(0, 2))],
    });
    island.rerender({ doc: shorter, dict, locale: "en", now: NOW, initialDivision: null });
    expect(pressed(island.tree(), "mh-knockout-round-")).toEqual([`mh-knockout-round-${VIEW}-main-2`]);
    expect(cards(island.tree())).toEqual(["s1", "s2"]);
  });
});

describe("revealScrollLeft — the arithmetic behind scrolling the pressed chip into view", () => {
  // The DOM half (reading two rects and a padding, writing `scrollLeft` from a
  // layout effect) cannot run without a browser; Task 3's e2e owns it. What is
  // pinned here is every arm of the decision.
  const rail = { scrollLeft: 0, left: 0, width: 390, padStart: 16, padEnd: 16 };

  // C-1 (visual gate): the rail left its leading chip cut mid-glyph
  // ("uarter-finals", "ualifier 1", "als 2/2"), because a reveal past the RIGHT
  // edge scrolled "just far enough to show its end", which is almost never a
  // chip boundary. Snapping the rail to chip starts did not fix that by itself.
  // Measured in Chromium (N2 harness, run B), the browser re-snapped that
  // mid-chip offset to the NEAREST chip start. In 59 of 620 load and tap cases,
  // that start was behind the pressed chip's end, so the chip the reveal exists
  // to show was left cut on the right. The reveal therefore lands on a chip
  // boundary itself. `starts` is every chip's left edge, in viewport
  // coordinates, in rail order.
  const starts = [16, 150, 290, 500];

  it("a chip already inside the window does not move the rail", () => {
    expect(revealScrollLeft(rail, { left: 150, width: 120 }, starts)).toBe(0);
  });

  it("a chip past the RIGHT edge scrolls to the FIRST chip boundary that shows it whole, never to a mid-chip offset (C-1)", () => {
    // The window is [16, 374]. The chip ends at 620, which is 246 past the window.
    // The old answer, 246, would put the chip that starts at 290 at 44, across
    // the gutter with its glyphs cut. The boundaries are 0 / 134 / 274 / 484 away.
    // 274 is the least that shows the pressed chip whole, and it lands the
    // chip at 290 exactly on the gutter.
    const next = revealScrollLeft(rail, { left: 500, width: 120 }, starts);
    expect(next).toBe(274);
    expect(starts.map((s) => s - next)).toContain(rail.padStart);
    expect(500 - next).toBeGreaterThanOrEqual(16);
    expect(620 - next).toBeLessThanOrEqual(374);
  });

  it("a boundary EXACTLY at the least shift is taken, not skipped for the next one", () => {
    // The chip at 262 is exactly 246 from the gutter, the least scroll that shows the pressed chip's end.
    expect(revealScrollLeft(rail, { left: 500, width: 120 }, [16, 262, 500])).toBe(246);
  });

  it("the pressed chip's OWN start, when no earlier boundary shows it whole", () => {
    // Showing its end needs 126. The earlier boundaries are 0 and 44 away, not enough.
    expect(revealScrollLeft(rail, { left: 300, width: 200 }, [16, 60, 300])).toBe(284);
  });

  it("a chip past the LEFT edge scrolls back to put its start at the gutter", () => {
    expect(revealScrollLeft({ ...rail, scrollLeft: 300 }, { left: -40, width: 120 }, [-40, 90])).toBe(244);
  });

  it("a chip WIDER than the window shows its start rather than its end, and never a LATER chip's boundary", () => {
    // Showing its end would need 526. The only boundary that far is the NEXT
    // chip's, 934 away, and it would scroll the pressed chip clean off the left.
    expect(revealScrollLeft(rail, { left: 400, width: 500 }, [16, 400, 950])).toBe(384);
  });

  it("never scrolls to a negative offset", () => {
    expect(revealScrollLeft({ ...rail, scrollLeft: 10 }, { left: -100, width: 50 }, [-100])).toBe(0);
  });
});
