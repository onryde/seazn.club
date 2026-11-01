// Task B3: the court card's small figures beside the big score, driven through the REAL producer and the REAL consumer —
// `buildMatchCentre` builds the header from the engine's own fold of a recorded stream, and `CourtCard` renders it. The expected
// text is the documented format from the engine's own fields (`courtSubLinesOracle`: `detail.games`, the folded `state.points`),
// never the reader's own path, and never the headline.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registry, type AnySportModule } from "@seazn/engine/sport";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { courtSubLinesOracle, goldenMoments, liveSidesOf, tennisMatchTiebreak, type GoldenMoment } from "@/lib/score/__tests__/_golden";
import type { PublicFixture } from "@/server/public-site/data";
import { buildMatchCentre } from "@/server/public-site/match-centre";
import type { SideT } from "@/server/public-site/match-centre-schema";
import { CourtCard } from "../court-card";

const dict = en as Dict;
/** The two sides, carrying the entrant ids the engine's own summary names (the big score is looked up by entrant). */
const sidesOf = (summary: unknown): [SideT, SideT] => {
  const [h, a] = (summary as { perSide: { entrantId: string }[] }).perSide;
  return [
    { entrantId: h!.entrantId, name: "Riverside", short: "RVS", colour: null, badgeUrl: null },
    { entrantId: a!.entrantId, name: "Oakdale", short: "OAK", colour: null, badgeUrl: null },
  ];
};

/** The court card the public page paints for `summary`, built by the real match-centre builder. */
function cardFor(sportKey: string, summary: unknown, inPlay: boolean): string {
  const cfg = (registry.latest(sportKey) as AnySportModule).configSchema.parse({});
  const sides = sidesOf(summary);
  const fixture = {
    id: "fx1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
    home_entrant_id: sides[0].entrantId, away_entrant_id: sides[1].entrantId, home_slot_label: null, away_slot_label: null,
    scheduled_at: "2026-09-25T09:00:00.000Z", venue: null, court_label: null, venue_name: null, court_name: null,
    status: inPlay ? "in_play" : "decided", outcome: null, summary, last_seq: null,
  } as PublicFixture;
  const doc = buildMatchCentre({
    fixture, sportKey, cfg, events: [], lineups: { home: [], away: [] }, sides, venueTz: "UTC", locale: "en",
    now: new Date("2026-09-25T10:00:00.000Z"), hrefs: { division: "/d/1", competition: "/c/1", calendar: null },
    stage: null, moduleVersion: null, formatLabel: null,
  });
  return renderToStaticMarkup(<CourtCard header={doc.header} dict={dict} />);
}

const text = (html: string, id: string): string => {
  const at = html.indexOf(`data-testid="${id}"`);
  expect(at, `${id} is rendered`).toBeGreaterThan(-1);
  const body = html.slice(html.indexOf(">", at) + 1, html.indexOf("</span>", at));
  return body.replace(/<[^>]*>/g, "");
};
/** The small figure after a side's big score (`mc-score-i`): the span that follows it. */
const subOf = (html: string, i: 0 | 1): string => {
  const at = html.indexOf(`data-testid="mc-score-${i}"`);
  const afterBig = html.indexOf("</span>", at) + "</span>".length;
  const next = html.slice(afterBig, afterBig + 200);
  const m = /^<span[^>]*>([^<]*)<\/span>/.exec(next);
  return m === null ? "" : m[1]!;
};
const inPlayMoment = (key: string, pick: (m: GoldenMoment) => boolean): GoldenMoment => {
  const m = [...goldenMoments(key)].reverse().find((x) => !x.decided && pick(x));
  if (m === undefined) throw new Error(`no in-play ${key} moment to render`);
  return m;
};
const detail = (m: { summary: { detail?: unknown } }) => m.summary.detail as Record<string, unknown>;

describe("CourtCard — a set sport's small figures, through buildMatchCentre from the engine's own folds", () => {
  it("tennis mid-game: sets won large, then the set's games in parentheses and the game's points", () => {
    const m = inPlayMoment("tennis", (x) => {
      const d = detail(x);
      const g = d.games as { home: number; away: number };
      return d.gameKind === "standard" && g.home !== g.away && liveSidesOf(x)![0] !== liveSidesOf(x)![1] && (x.summary.perSide as { line: string }[])[0]!.line !== g.home.toString();
    });
    const html = cardFor("tennis", m.summary, true);
    const games = detail(m).games as { home: number; away: number };
    const sides = liveSidesOf(m)!;
    const won = (m.summary.perSide as { line: string }[]).map((p) => p.line);
    expect(text(html, "mc-score-0")).toBe(won[0]);
    expect(text(html, "mc-score-1")).toBe(won[1]);
    expect(subOf(html, 0)).toBe(`(${games.home}) ${sides[0]}`);
    expect(subOf(html, 1)).toBe(`(${games.away}) ${sides[1]}`);
    // The three levels are three different figures, so a swap of two of them could not pass.
    expect(new Set([won[0], String(games.home), sides[0]]).size).toBe(3);
  });

  it("tennis in a set tie-break reads (games) then the tie-break's points; a match tie-break reads its points alone", () => {
    const tb = inPlayMoment("tennis", (x) => detail(x).gameKind === "tiebreak" && liveSidesOf(x) !== null && liveSidesOf(x)![0] !== liveSidesOf(x)![1]);
    const html = cardFor("tennis", tb.summary, true);
    const games = detail(tb).games as { home: number; away: number };
    expect(subOf(html, 0)).toBe(`(${games.home}) ${liveSidesOf(tb)![0]}`);
    const mtb = tennisMatchTiebreak(["H", "H", "A", "H", "A"]);
    const mtbHtml = cardFor("tennis", mtb.summary, true);
    expect(subOf(mtbHtml, 0)).toBe("(3)");
    expect(subOf(mtbHtml, 1)).toBe("(2)");
  });

  it("a finished set of 7–6(5) never reads as live points: the decided card has no small figure at all", () => {
    const done = [...goldenMoments("tennis")].reverse().find(
      (x) => x.decided && (detail(x).sets as { closed: boolean; tb?: unknown }[]).every((s) => s.closed) && (detail(x).sets as { tb?: unknown }[]).some((s) => s.tb !== undefined),
    );
    expect(done, "a recorded finished match with a tie-break set").toBeDefined();
    const html = cardFor("tennis", done!.summary, false);
    expect(subOf(html, 0)).toBe("");
    expect(subOf(html, 1)).toBe("");
  });

  it.each(["badminton", "tabletennis", "volleyball"])("%s mid-set: games won large, the open set's points beside them", (key) => {
    const m = inPlayMoment(key, (x) => liveSidesOf(x) !== null && liveSidesOf(x)![0] !== liveSidesOf(x)![1]);
    const html = cardFor(key, m.summary, true);
    const [a, b] = courtSubLinesOracle(m, true);
    expect(subOf(html, 0)).toBe(a);
    expect(subOf(html, 1)).toBe(b);
    const won = (m.summary.perSide as { line: string }[]).map((p) => p.line);
    expect(text(html, "mc-score-0")).toBe(won[0]);
    expect(text(html, "mc-score-1")).toBe(won[1]);
  });

  it("a sport with no set table paints no small figure from this reader (football's own header is unchanged)", () => {
    const m = [...goldenMoments("football")].reverse().find((x) => !x.decided)!;
    const html = cardFor("football", m.summary, true);
    expect(subOf(html, 0)).toBe("");
    expect(subOf(html, 1)).toBe("");
  });
});
