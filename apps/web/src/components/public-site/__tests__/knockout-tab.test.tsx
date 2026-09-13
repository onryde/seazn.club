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

import { MatchCard } from "../matches-hub/match-card";
import {
  KnockoutTab,
  defaultRoundKey,
  knockoutMode,
  nextLine,
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

  it("exactly one chip is pressed PER VIEW when two views render", () => {
    const h = render(MULTI);
    expect(pressedRounds(h)).toEqual([
      `mh-knockout-round-${VIEW}-main-1`,
      "mh-knockout-round-sunday-league-plate-main-2",
    ]);
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

  it("the switch and the division rail are DIRECT children of the root — no wrapper to keep its spacing where the switch is hidden", () => {
    // Tailwind v4's `space-y-*` is `margin-block-end` on every child but the
    // last (`tailwindcss/dist/lib.js`). A hidden element generates no box and
    // so no margin — but a VISIBLE wrapper whose only child is the hidden
    // switch keeps its margin, a blank band at the top of the panel on every
    // phone, for the commonest document there is: one division, one drawable
    // bracket. Only a browser sees the band; the structure that causes it is
    // what this pins.
    expect(render(MID)).toMatch(
      /^<div data-testid="mh-knockout" class="[^"]*"><div data-testid="mh-knockout-view"/,
    );
    const multi = render(MULTI);
    expect(multi).toMatch(
      /^<div data-testid="mh-knockout" class="[^"]*"><div data-testid="mh-knockout-divisions"/,
    );
    // …and the switch opens straight after the division rail closes.
    expect(multi).toMatch(/<\/button><\/div><div data-testid="mh-knockout-view"/);
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

  it("a chip already inside the window does not move the rail", () => {
    expect(revealScrollLeft(rail, { left: 100, width: 120 })).toBe(0);
  });

  it("a chip past the RIGHT edge scrolls just far enough to show its end", () => {
    // window ends at 390 - 16 = 374; the chip ends at 620.
    expect(revealScrollLeft(rail, { left: 500, width: 120 })).toBe(246);
  });

  it("a chip past the LEFT edge scrolls back to put its start at the gutter", () => {
    expect(revealScrollLeft({ ...rail, scrollLeft: 300 }, { left: -40, width: 120 })).toBe(244);
  });

  it("a chip WIDER than the window shows its start rather than its end", () => {
    expect(revealScrollLeft(rail, { left: 400, width: 500 })).toBe(384);
  });

  it("never scrolls to a negative offset", () => {
    expect(revealScrollLeft({ ...rail, scrollLeft: 10 }, { left: -100, width: 50 })).toBe(0);
  });
});
