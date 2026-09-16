import { describe, expect, it } from "vitest";
import { MatchPoster, matchPosterModel, type MatchPosterInput } from "@/server/og/match-poster";
import { monogramInk, autoColour } from "@/components/ui/entity-logo";
import type { MatchCentreDocT, SideT } from "@/server/public-site/match-centre-schema";

// The PURE half of the match poster (mirrors og/model.test and post-card.test):
// which variant, which paint, which slots fill. A satori tree cannot be
// inspected from a route, so everything worth asserting is decided here.

/** What an image resolved by `server/og/poster-image.ts` looks like: bytes,
 *  never a URL. */
const DATA_PREFIX = "data:image/png;base64,";

/**
 * Every `src` satori would be handed. There is no DOM here (`environment:
 * "node"`), so this walks the element tree by hand — and INVOKES the
 * function-typed elements with their real props, because `<Tile />` is where
 * the badge lives and an unrendered component element carries no children.
 */
function srcsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(srcsIn);
  if (node === null || typeof node !== "object") return [];
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  const props = el.props ?? {};
  if (typeof el.type === "function") {
    return srcsIn((el.type as (p: Record<string, unknown>) => unknown)(props));
  }
  const here = typeof props.src === "string" ? [props.src] : [];
  return [...here, ...srcsIn(props.children)];
}

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
  badges: [null, null],
  competitionName: "Southend Premier League 2026",
  divisionName: "Men's T8",
  stageName: "Round 1",
  header: header(),
  activeIndex: null,
  setLine: null,
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
          rateLine: "CRR 8.44 · RRR 9.71",
          statusLine: { key: "x" },
          pillNote: { key: "y" },
        }),
        activeIndex: 1,
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
    // The stage is the hero, so the chip carries the division ALONE — this
    // printed "TOURNAMENT · GROUP STAGE" above a 92px "GROUP STAGE".
    expect(m.chip).toBe("Men's T8");
    expect(m.hero).toBe("Round 1");
    expect(m.chip).not.toContain(m.hero!);
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

  it("a badge is carried only as bytes the poster fetcher already resolved", () => {
    const m = matchPosterModel(
      input({ badges: [`${DATA_PREFIX}AAAA`, null] }),
    );
    expect(m.sides[0].badgeUrl).toBe(`${DATA_PREFIX}AAAA`);
    // No badge is the monogram tile, which is the fallback for every refusal.
    expect(m.sides[1].badgeUrl).toBeNull();
  });

  it("a REMOTE badge URL never reaches the model, whatever the loader hands it", () => {
    // satori fetches whatever `src` it is given, server-side, on a public
    // route. `server/og/poster-image.ts` is the only thing allowed to make
    // that request, so the model refuses anything that is not already bytes —
    // a caller that forgets the fetcher renders monograms, not an SSRF.
    const m = matchPosterModel(
      input({
        badges: ["https://projectref.supabase.co/storage/v1/object/public/assets/a.png", "/uploads/b.png"],
        // The organiser-typed URL on the header is not a source of `src`
        // either: the loader resolves it, and only the resolution is drawn.
        header: header({
          sides: [
            side({ badgeUrl: "https://cdn.example.com/a.png" }),
            side({ badgeUrl: "https://cdn.example.com/b.png" }),
          ],
        }),
      }),
    );
    expect([m.sides[0].badgeUrl, m.sides[1].badgeUrl]).toEqual([null, null]);
  });

  it("a REMOTE org logo never reaches the model either", () => {
    expect(matchPosterModel(input({ logo: "https://cdn.example.com/logo.png" })).logo).toBeNull();
    expect(matchPosterModel(input({ logo: `${DATA_PREFIX}BBBB` })).logo).toBe(`${DATA_PREFIX}BBBB`);
  });

  it("no `src` ANYWHERE in the drawn tree is a remote URL, at either size", () => {
    // Model-level assertions only cover the two slots that exist today. This
    // walks what satori would actually be handed, so a third image added to
    // this layout later cannot quietly reopen the outbound request.
    const m = matchPosterModel(
      input({
        logo: "https://cdn.example.com/logo.png",
        badges: ["https://cdn.example.com/a.png", `${DATA_PREFIX}CCCC`],
      }),
    );
    for (const size of ["og", "poster"] as const) {
      const srcs = srcsIn(MatchPoster({ model: m, size }));
      // Anti-vacuous: one badge DID resolve, so the walk must find something.
      expect(srcs.length).toBeGreaterThan(0);
      expect(srcs.filter((src) => !src.startsWith("data:image/"))).toEqual([]);
    }
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
  it("a fixture with no stage keeps its chip and simply has no hero", () => {
    // Never the division name in both slots: one of them would be repeating
    // the other, which is the defect above in its other direction.
    const m = matchPosterModel(input({ stageName: null, header: header({ status: "scheduled" }) }));
    expect(m.chip).toBe("Men's T8");
    expect(m.hero).toBeNull();
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

  it("a live fixture with no rate line falls to the SET score, which is the fact a spectator wants", () => {
    // Tennis has no run rate, and this foot used to render empty.
    const m = matchPosterModel(
      input({ header: header({ status: "in_play", live: true }), setLine: "6–4 3–6 · 2–1" }),
    );
    expect(m.footNote).toBe("6–4 3–6 · 2–1");
  });

  it("and to the match's own line when there is no set score either", () => {
    const m = matchPosterModel(input({ header: header({ status: "in_play", live: true }) }));
    expect(m.footNote).toBe("8-over match · Round 1 · Garon Park");
  });

  it("a rate line still wins over the set score — a live cricket foot is the rate", () => {
    const m = matchPosterModel(
      input({
        header: header({ status: "in_play", live: true, rateLine: "CRR 8.44" }),
        setLine: "6–4",
      }),
    );
    expect(m.footNote).toBe("CRR 8.44");
  });
});


describe("matchPosterModel — which side is DOING something", () => {
  it("a live tennis match holds back the returner, not nobody", () => {
    // The bug this closes: the model asked `header.battingIndex`, which is
    // cricket's field, so a live tennis poster lit both players equally.
    const live = header({ status: "in_play", live: true, battingIndex: null });
    const serving0 = matchPosterModel(input({ header: live, activeIndex: 0 }));
    expect([serving0.sides[0].dim, serving0.sides[1].dim]).toEqual([false, true]);
    const serving1 = matchPosterModel(input({ header: live, activeIndex: 1 }));
    expect([serving1.sides[0].dim, serving1.sides[1].dim]).toEqual([true, false]);
  });

  it("a sport with no active side at all holds back neither", () => {
    // Football tracks no possession. Dimming "whoever is behind" mid-match
    // would be the poster editorialising about a result nobody has yet.
    const m = matchPosterModel(
      input({ header: header({ status: "in_play", live: true }), activeIndex: null }),
    );
    expect([m.sides[0].dim, m.sides[1].dim]).toEqual([false, false]);
  });

  it("the active side is irrelevant once the match is decided — the SCORE decides", () => {
    const m = matchPosterModel(input({ header: header({ scoreLines: ["1", "3"] }), activeIndex: 0 }));
    expect([m.sides[0].dim, m.sides[1].dim]).toEqual([true, false]);
  });
});
