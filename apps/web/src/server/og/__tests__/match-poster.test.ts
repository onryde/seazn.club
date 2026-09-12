import { describe, expect, it } from "vitest";
import { matchPosterModel, type MatchPosterInput } from "@/server/og/match-poster";
import { monogramInk, autoColour } from "@/components/ui/entity-logo";
import type { MatchCentreDocT, SideT } from "@/server/public-site/match-centre-schema";

// The PURE half of the match poster (mirrors og/model.test and post-card.test):
// which variant, which paint, which slots fill. A satori tree cannot be
// inspected from a route, so everything worth asserting is decided here.

const side = (over: Partial<SideT> = {}): SideT => ({
  entrantId: "e1",
  name: "Southend Blue Blazers",
  short: "SBB",
  colour: null,
  badgeUrl: null,
  ...over,
});

const header = (over: Partial<MatchCentreDocT["header"]> = {}): MatchCentreDocT["header"] => ({
  live: false,
  status: "decided",
  sides: [
    side({ entrantId: "h", name: "Southend Blue Blazers", short: "SBB", colour: "#2563eb" }),
    side({ entrantId: "a", name: "Southend Queens", short: "SQ", colour: "#db2777" }),
  ],
  scoreLines: ["83/6", "71/7"],
  subLines: ["8.0 ov", "8.0 ov"],
  battingIndex: null,
  statusLine: null,
  rateLine: null,
  phase: null,
  strength: null,
  pillNote: null,
  metaLine: "8-over match · Round 1 · Garon Park",
  updatedAt: "2026-09-05T13:00:00.000Z",
  ...over,
});

const performers: NonNullable<MatchCentreDocT["cricket"]>["topPerformers"] = [
  {
    role: "batter",
    person: { personId: "p1", name: "Arjun Mehta", masked: false },
    side: side(),
    line: "34",
    detail: "(21)",
    innings: 1,
  },
  {
    role: "bowler",
    person: { personId: "p2", name: "Farhan Qureshi", masked: false },
    side: side(),
    line: "3/11",
    detail: "(2.0)",
    innings: 2,
  },
  {
    role: "batter",
    person: { personId: "p3", name: "A Third Person", masked: false },
    side: side(),
    line: "20",
    detail: null,
    innings: 1,
  },
];

const copy: MatchPosterInput["copy"] = {
  statusLine: null,
  pillNote: null,
  live: "Live",
  result: "Result",
  vs: "vs",
  topBatter: "Top batter",
  topBowler: "Top bowler",
  poweredBy: "Powered by seazn",
};

const input = (over: Partial<MatchPosterInput> = {}): MatchPosterInput => ({
  branding: [null, null],
  orgName: "Southend Cricket Club",
  logo: null,
  competitionName: "Southend Premier League 2026",
  divisionName: "Men's T8",
  stageName: "Round 1",
  header: header(),
  topPerformers: null,
  copy,
  ...over,
});

describe("matchPosterModel — the three states the board's one layout carries", () => {
  it("a decided fixture is the RESULT variant: the board's chip, sentence, scores and performers", () => {
    const m = matchPosterModel(
      input({
        header: header({ statusLine: { key: "x" } }),
        topPerformers: performers,
        copy: { ...copy, statusLine: "Blue Blazers won by 12 runs" },
      }),
    );
    expect(m.variant).toBe("result");
    expect(m.chip).toBe("Result · Men's T8 · Round 1");
    expect(m.chipLive).toBe(false);
    expect(m.hero).toBe("Blue Blazers won by 12 runs");
    expect(m.sides[0].score).toBe("83/6");
    expect(m.sides[0].sub).toBe("8.0 ov");
    // The board draws exactly two performer boxes; a third is not a third box.
    expect(m.performers.map((p) => `${p.role} ${p.name} ${p.line}`)).toEqual([
      "Top batter Arjun Mehta 34",
      "Top bowler Farhan Qureshi 3/11",
    ]);
    // The foot line stands alongside the performers rather than instead of
    // them: the portrait renders the boxes, the 630px landscape has no room
    // for them and renders this line, and one model serves both.
    expect(m.footNote).toBe("8-over match · Round 1 · Garon Park");
  });

  it("an in-play fixture is the LIVE variant: the live chip, the chase line, and the rate line in the foot", () => {
    const m = matchPosterModel(
      input({
        header: header({
          status: "in_play",
          live: true,
          battingIndex: 1,
          rateLine: "CRR 8.44 · RRR 9.71",
          statusLine: { key: "x" },
          pillNote: { key: "y" },
        }),
        topPerformers: performers,
        copy: { ...copy, statusLine: "Queens need 34 from 21", pillNote: "12.3 ov" },
      }),
    );
    expect(m.variant).toBe("live");
    expect(m.chip).toBe("Live · 12.3 ov");
    expect(m.chipLive).toBe(true);
    expect(m.hero).toBe("Queens need 34 from 21");
    expect(m.footNote).toBe("CRR 8.44 · RRR 9.71");
    // Performers are the RESULT variant's foot; a live match's foot is the rate.
    expect(m.performers).toEqual([]);
    // The side that is NOT batting is the one held back.
    expect([m.sides[0].dim, m.sides[1].dim]).toEqual([true, false]);
  });

  it("a scheduled fixture is the UPCOMING variant: no scores on the tiles, the stage as the hero", () => {
    const m = matchPosterModel(
      input({
        // A stale summary that still carries a scoreline must not leak onto a
        // poster for a match nobody has played.
        header: header({ status: "scheduled", statusLine: { key: "x" } }),
        copy: { ...copy, statusLine: "Starts Sat 5 Sep, 14:00" },
      }),
    );
    expect(m.variant).toBe("upcoming");
    expect(m.chip).toBe("Men's T8 · Round 1");
    expect(m.hero).toBe("Round 1");
    expect(m.sides.map((s) => s.score)).toEqual([null, null]);
    expect(m.sides.map((s) => s.sub)).toEqual([null, null]);
    expect(m.footNote).toBe("Starts Sat 5 Sep, 14:00");
    expect([m.sides[0].dim, m.sides[1].dim]).toEqual([false, false]);
  });
});

describe("matchPosterModel — the tile paint, which is the whole of Option A", () => {
  it("each side gets ITS OWN colour, never one accent for both", () => {
    const m = matchPosterModel(input());
    expect(m.sides[0].bg).toBe("#2563eb");
    expect(m.sides[1].bg).toBe("#db2777");
    expect(m.sides[0].bg).not.toBe(m.sides[1].bg);
    // Ink is contrast-picked against the tile, not a constant.
    expect(m.sides[0].ink).toBe(monogramInk("#2563eb")!.ink);
  });

  it("a side that declares no colour still gets a tile, derived from its NAME", () => {
    const m = matchPosterModel(
      input({
        header: header({
          sides: [
            side({ name: "Zara Okonkwo", short: "ZO", colour: null }),
            side({ name: "Mia Lindqvist", short: "ML", colour: null }),
          ],
        }),
      }),
    );
    // Not a grey slab, not the same slab twice — two individuals who can never
    // have a club still read as two different things.
    expect(m.sides[0].bg).toBe(monogramInk(autoColour("Zara Okonkwo"))!.bg);
    expect(m.sides[1].bg).toBe(monogramInk(autoColour("Mia Lindqvist"))!.bg);
    expect(m.sides[0].bg).not.toBe(m.sides[1].bg);
  });

  it("two colourless sides that DERIVE the same colour do not get the same tile", () => {
    // Found by rendering a real fixture, not by reading: `autoColour`'s palette
    // has sixteen entries, and these two names land on the same one (#b7791f),
    // so a poster whose whole idea is "two crests in two colours" painted one
    // colour twice. Asserted through autoColour rather than against a hex
    // literal, so a change to the palette moves this test with it.
    expect(autoColour("Northfield CC")).toBe(autoColour("Riverside FC"));
    const m = matchPosterModel(
      input({
        header: header({
          sides: [
            side({ name: "Northfield CC", short: "NOR", colour: null }),
            side({ name: "Riverside FC", short: "RIV", colour: null }),
          ],
        }),
      }),
    );
    expect(m.sides[0].bg).toBe(monogramInk(autoColour("Northfield CC"))!.bg);
    expect(m.sides[1].bg).not.toBe(m.sides[0].bg);
  });

  it("a colour an organiser CHOSE is never stepped, even when both sides chose the same one", () => {
    // The other half of the rule: a derived colour is nobody's identity and may
    // move; a chosen one is, and two clubs in the same navy is the fixture.
    const m = matchPosterModel(
      input({
        header: header({
          sides: [side({ colour: "#2563eb" }), side({ name: "Other Club", colour: "#2563eb" })],
        }),
      }),
    );
    expect([m.sides[0].bg, m.sides[1].bg]).toEqual(["#2563eb", "#2563eb"]);
  });

  it("a badge is carried only when satori can actually fetch it", () => {
    const m = matchPosterModel(
      input({
        header: header({
          sides: [
            side({ badgeUrl: "https://cdn.example.com/a.png" }),
            // A relative path would throw inside satori and take the WHOLE
            // image down — the tile falls back to paint instead.
            side({ badgeUrl: "/uploads/b.png" }),
          ],
        }),
      }),
    );
    expect(m.sides[0].badgeUrl).toBe("https://cdn.example.com/a.png");
    expect(m.sides[1].badgeUrl).toBeNull();
  });
});

describe("matchPosterModel — the cases that dim the wrong side or none", () => {
  it("a tie dims neither side", () => {
    const m = matchPosterModel(input({ header: header({ scoreLines: ["2", "2"] }) }));
    expect([m.sides[0].dim, m.sides[1].dim]).toEqual([false, false]);
  });

  it("the loser is dimmed, whichever side it is", () => {
    const homeWon = matchPosterModel(input({ header: header({ scoreLines: ["3", "1"] }) }));
    expect([homeWon.sides[0].dim, homeWon.sides[1].dim]).toEqual([false, true]);
    const awayWon = matchPosterModel(input({ header: header({ scoreLines: ["1", "3"] }) }));
    expect([awayWon.sides[0].dim, awayWon.sides[1].dim]).toEqual([true, false]);
  });

  it("a set score the leading number cannot rank dims neither", () => {
    // "6-4 3-6" parses to 6 on both sides; a poster must not declare a winner
    // it cannot actually read.
    const m = matchPosterModel(input({ header: header({ scoreLines: ["6-4 3-6", "6-4 3-6"] }) }));
    expect([m.sides[0].dim, m.sides[1].dim]).toEqual([false, false]);
  });

  it("a cricket score dims by RUNS, which is the number the string leads with", () => {
    const m = matchPosterModel(input({ header: header({ scoreLines: ["83/6", "71/7"] }) }));
    expect([m.sides[0].dim, m.sides[1].dim]).toEqual([false, true]);
  });
});

describe("matchPosterModel — the headline slot says nothing rather than something false", () => {
  it("a live fixture with no sentence to print leaves the hero empty", () => {
    // Live tennis has no chase line, and an earlier cut fell back to the
    // division name — which rendered "MAIN DRAW" in 92px across the poster as
    // though it were the news.
    const m = matchPosterModel(input({ header: header({ status: "in_play", live: true }) }));
    expect(m.hero).toBeNull();
  });

  it("a decided fixture with no sentence to print leaves the hero empty", () => {
    const m = matchPosterModel(input({ header: header({ statusLine: null }) }));
    expect(m.hero).toBeNull();
  });
});

describe("matchPosterModel — nothing renders a stray separator", () => {
  it("a fixture with no stage still has a chip and a hero", () => {
    const m = matchPosterModel(input({ stageName: null, header: header({ status: "scheduled" }) }));
    expect(m.chip).toBe("Men's T8");
    expect(m.hero).toBe("Men's T8");
  });

  it("a live sport with no pill note reads just LIVE", () => {
    const m = matchPosterModel(input({ header: header({ status: "in_play", live: true }) }));
    expect(m.chip).toBe("Live");
  });

  it("a sport with no top performers falls back to the meta line rather than an empty foot", () => {
    const m = matchPosterModel(input({ topPerformers: null }));
    expect(m.performers).toEqual([]);
    expect(m.footNote).toBe("8-over match · Round 1 · Garon Park");
  });

  it("a live fixture with no rate line leaves the foot empty rather than printing the wrong fact", () => {
    // Tennis has no run rate. Reaching for `metaLine` here would print the
    // division's raw variant key ("grand-slam") across the foot of a poster.
    const m = matchPosterModel(input({ header: header({ status: "in_play", live: true }) }));
    expect(m.footNote).toBeNull();
  });
});
