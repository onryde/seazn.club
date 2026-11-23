// W5 follow-ups C (owner 2026-11-23, Option A "by round"): the competition hub serves a BIG division's open rounds and every other round as
// a `roundPages` header (`lib/hub-round-paging.ts`); the Matches tab reads it by round and loads a folded round from the cached document.
// The scene is the perf report's cap shape generated here: a 71-team double league (4,970 cards, half played) beside a small knockout
// division. Expected values are counted off the scene, never off the window.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { CompetitionHubDoc, type CompetitionHubDocT, type HubMatchT } from "@/server/public-site/competition-hub-schema";
import { hubBucketTotals, hubRoundKey, hubRoundMatches, windowHubDoc } from "@/lib/hub-round-paging";
import { MatchesTab } from "../matches-hub/matches-tab";
import { landingStatus } from "@/lib/matches-hub";
import { hubRoundsFor } from "../matches-hub/hub-rounds";
import { hubDoc, knockoutView, koRound, m } from "./hub-fixtures";

vi.mock("@/server/usecases/public", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/public")>()),
  publicPollRateLimit: async () => {},
  publicCompetitionHub: async () => sceneDoc,
}));
import { GET as hubRoundsGET } from "@/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/hub-rounds/route";
import { GET as hubGET } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/hub/route";

const NOW = Date.parse("2026-09-05T12:00:00Z");
const DAY = 86_400_000;
/** 142 rounds of 35: rounds 1-71 completed, 72-142 upcoming. */
function bigLeague(): HubMatchT[] {
  const out: HubMatchT[] = [];
  for (let r = 1; r <= 142; r++) {
    for (let s = 1; s <= 35; s++) {
      const done = r <= 71;
      out.push(m(`L${r}-${s}`, done ? "completed" : "upcoming", new Date(NOW + (r - 72) * DAY).toISOString(), "premier", { roundNo: r }));
    }
  }
  return out;
}
const smallCup = (): HubMatchT[] => [
  m("K1", "completed", "2026-09-01T10:00:00Z", "cup", { stageName: "Cup", roundNo: 1 }),
  m("K2", "upcoming", "2026-09-08T10:00:00Z", "cup", { stageName: "Cup", roundNo: 2 }),
];
const scene = () => hubDoc({ matches: [...bigLeague(), ...smallCup()], knockouts: [] });
let sceneDoc: CompetitionHubDocT = scene();

describe("C: the hub serves a big division by round", () => {
  it("premise: 4,970 cards in the big division, over the paging line; the small one is not", () => {
    expect(scene().matches.filter((x) => x.divisionSlug === "premier").length).toBe(4970);
  });

  it("the served document keeps round 72's cards and the small division whole, heads all 142 rounds, and is a fraction of the bytes", () => {
    const full = scene();
    const served = windowHubDoc(full);
    const premier = served.matches.filter((x) => x.divisionSlug === "premier");
    expect([...new Set(premier.map((x) => x.roundNo))]).toEqual([72]);
    expect(premier.length).toBe(35);
    expect(served.matches.filter((x) => x.divisionSlug === "cup").map((x) => x.fixtureId)).toEqual(["K1", "K2"]);
    expect(served.roundPages!.map((p) => p.roundNo)).toEqual(Array.from({ length: 142 }, (_, i) => i + 1));
    expect(served.roundPages!.filter((p) => p.open).map((p) => p.roundNo)).toEqual([72]);
    expect(JSON.stringify(served).length / JSON.stringify(full).length).toBeLessThan(0.1);
    // The schema keeps the headers (an unknown key would be stripped) and the document is still self-consistent.
    expect(CompetitionHubDoc.parse(served).roundPages!.length).toBe(142);
  });

  it("the chips' totals over the served document are the whole document's", () => {
    const full = scene();
    const whole = { live: 0, upcoming: 0, completed: 0 };
    for (const x of full.matches) whole[x.bucket] += 1;
    expect(hubBucketTotals(windowHubDoc(full))).toEqual(whole);
    expect(whole.completed, "anti-vacuity").toBe(71 * 35 + 1);
  });

  it("a knockout's matches are never paged, even in a big division: every fixture a knockout view names stays served", () => {
    const league = bigLeague();
    const ko = m("F1", "upcoming", "2026-12-01T10:00:00Z", "premier", { stageName: "Play-offs", roundNo: 1 });
    const full = hubDoc({ matches: [...league, ko], knockouts: [] });
    const withKo = { ...full, knockouts: [{ ...(full.knockouts[0] ?? {}), rounds: [koRound("final", "Final", ["F1"])], championFixtureId: null } as never] };
    const served = windowHubDoc(withKo);
    expect(served.matches.some((x) => x.fixtureId === "F1")).toBe(true);
    expect(served.roundPages!.some((p) => p.stageName === "Play-offs"), "a bracket round is no page").toBe(false);
  });

  it("a small competition, and an empty one, are served as they are (the same document)", () => {
    const small = hubDoc({ matches: smallCup() });
    expect(windowHubDoc(small)).toBe(small);
    const empty = hubDoc({ matches: [] });
    expect(windowHubDoc(empty)).toBe(empty);
  });

  it("a folded round's cards come out of the whole document: every round swept, each exactly its own; unknown is null", () => {
    const full = scene();
    const served = windowHubDoc(full);
    let cards = 0;
    for (const p of served.roundPages!) {
      const rows = hubRoundMatches(full, "premier", p.key)!;
      expect(rows.map((x) => x.fixtureId)).toEqual(full.matches.filter((x) => x.divisionSlug === "premier" && x.roundNo === p.roundNo).map((x) => x.fixtureId));
      cards += rows.length;
    }
    expect(cards).toBe(4970);
    expect(hubRoundMatches(full, "cup", served.roundPages![0]!.key), "another division's slug finds nothing").toBeNull();
    expect(hubRoundMatches(full, "premier", hubRoundKey({ divisionId: "d-premier", stageName: "League", roundNo: 999 }))).toBeNull();
  });

  it("the hub-rounds route answers a folded round from the cached document, 400 without a key, 404 for one it does not have", async () => {
    sceneDoc = scene();
    const params = Promise.resolve({ orgSlug: sceneDoc.orgSlug, competitionSlug: sceneDoc.competitionSlug, divisionSlug: "premier" });
    const key = windowHubDoc(sceneDoc).roundPages!.find((p) => p.roundNo === 100)!.key;
    const ok = await hubRoundsGET(new Request(`http://x/hub-rounds?key=${encodeURIComponent(key)}`), { params });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toMatch(/s-maxage=30/);
    expect(((await ok.json()) as { data: HubMatchT[] }).data.map((x) => x.roundNo)).toEqual(Array(35).fill(100));
    expect((await hubRoundsGET(new Request("http://x/hub-rounds"), { params })).status).toBe(400);
    expect((await hubRoundsGET(new Request("http://x/hub-rounds?key=nope"), { params })).status).toBe(404);
  });

  it("the Matches tab reads the big division by round: under Upcoming its 71 rounds, round 72 open with its cards, the rest shut", () => {
    const served = windowHubDoc(scene());
    const html = renderToStaticMarkup(<MatchesTab doc={served} dict={en as Dict} locale="en" now={NOW} initialFilter="upcoming" initialDivision="premier" />);
    const rounds = [...html.matchAll(/data-testid="mh-round" data-round-key="([^"]*)" data-state="([^"]*)" data-open="(true|false)"/g)];
    expect(rounds.length).toBe(71);
    expect(rounds.filter((r) => r[3] === "true").length, "only round 72 is open").toBe(1);
    // Each card links its fixture once (`MatchCard`'s one href) - a list, not a set, so a card drawn twice is seen.
    const linked = [...html.matchAll(/\/fixtures\/(L\d+-\d+)"/g)].map((x) => x[1]);
    expect(linked.sort(), "round 72's 35 cards, once each, and no other").toEqual(Array.from({ length: 35 }, (_, i) => `L72-${i + 1}`).sort());
    expect(html).not.toContain("/fixtures/L73-");
    // The chip says the competition's total, not what was served.
    expect(html).toContain(`${(en as Dict)["matchesHub.filter.upcoming"]} ${71 * 35 + 1}`);
  });

  it("a part-played open round shows, under each chip, only that chip's cards", () => {
    const full = scene();
    // Round 72 part played: its first five are results.
    for (const x of full.matches) if (x.roundNo === 72 && Number(x.fixtureId.split("-")[1]) <= 5) x.bucket = "completed";
    const served = windowHubDoc(full);
    const draw = (filter: "upcoming" | "completed") =>
      [...renderToStaticMarkup(<MatchesTab doc={served} dict={en as Dict} locale="en" now={NOW} initialFilter={filter} initialDivision="premier" />).matchAll(/\/fixtures\/(L72-\d+)"/g)].map((x) => x[1]);
    expect(draw("upcoming").length).toBe(30);
    expect(draw("completed").sort()).toEqual(["L72-1", "L72-2", "L72-3", "L72-4", "L72-5"]);
  });

  it("C1: a big division's knockout stays on the Matches TAB: a live final is listed under Live, and the chip counts what is listed", () => {
    // A groups-then-knockout shape: the 4,970-card league, then a play-off stage whose final is being played.
    const final = m("F1", "live", "2026-09-05T11:00:00Z", "premier", { stageName: "Play-offs", roundNo: 1 });
    const semi = m("S1", "completed", "2026-09-04T11:00:00Z", "premier", { stageName: "Play-offs", roundNo: 0 });
    const full = hubDoc({
      matches: [...bigLeague(), semi, final, ...smallCup()],
      knockouts: [knockoutView("ko", "premier", [koRound("sf", "Semi-final", ["S1"]), koRound("final", "Final", ["F1"])])],
    });
    const served = windowHubDoc(full);
    const tab = (filter: "live" | "completed") =>
      renderToStaticMarkup(<MatchesTab doc={served} dict={en as Dict} locale="en" now={NOW} initialFilter={filter} initialDivision="premier" />);
    const live = tab("live");
    expect(live, "the Live chip names one match").toContain(`${(en as Dict)["matchesHub.filter.live"]} 1`);
    const liveCards = [...live.matchAll(/\/fixtures\/([A-Z]\d[^"]*)"/g)].map((x) => x[1]);
    expect(liveCards, "and the tab lists that one match: the final").toEqual(["F1"]);
    expect(live).not.toContain('data-testid="mh-matches-empty-filter"');
    // Under Results the semi-final is listed beside the league's finished rounds (their headers).
    expect(tab("completed")).toContain("/fixtures/S1\"");
  });

  it("C2: a late entrant's catch-up rounds never move the hub's frontier: through the sequence rounds 72-73 stay served and the landing never says finished", () => {
    // Round 72 part played (the current round), then a late entry's five catch-up rounds 143-147, one match each.
    const step = (played: number) => {
      const league = bigLeague().map((x) =>
        x.roundNo === 72 && Number(x.fixtureId.split("-")[1]) <= 10 ? { ...x, bucket: "completed" as const } : x,
      );
      const catchUps = [143, 144, 145, 146, 147].map((r, i) =>
        m(`C${r}`, i < played ? "completed" : "upcoming", new Date(NOW + (i < played ? -1 : 40 + i) * 86_400_000).toISOString(), "premier", { roundNo: r, catchUp: true }),
      );
      return windowHubDoc(hubDoc({ matches: [...league, ...catchUps, ...smallCup()] }));
    };
    let checked = 0;
    for (const [name, played] of [["late entry", 0], ["one catch-up result", 1], ["every catch-up played", 5]] as const) {
      const served = step(played);
      const rounds = [...new Set(served.matches.filter((x) => x.divisionSlug === "premier").map((x) => x.roundNo))];
      expect(rounds, name).toEqual([72, 73]);
      const status = landingStatus({ matches: served.matches, divisions: served.divisions.length, startsOn: null, endsOn: null, now: new Date(NOW) });
      expect(status.kind, name).not.toBe("finished");
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("Results lists the finished rounds most recent first", () => {
    const served = windowHubDoc(scene());
    expect(hubRoundsFor(served.roundPages!, "completed").slice(0, 3).map((p) => p.roundNo)).toEqual([71, 70, 69]);
    expect(hubRoundsFor(served.roundPages!, "live")).toEqual([]);
  });
});


describe("C: the page's hub poll is served windowed, as the page is; the v1 reader without the param gets every card (review I3)", () => {
  const read = async (qs: string) => {
    sceneDoc = scene();
    const res = await hubGET(new Request(`http://x/hub${qs}`), { params: Promise.resolve({ orgSlug: "o", slug: "c" }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: CompetitionHubDocT }).data;
  };
  it("?window=rounds (the page's poll): a big division's open round and its round headers, not its 4,970 cards", async () => {
    const data = await read("?window=rounds");
    expect(data.matches.filter((x) => x.divisionSlug === "premier").map((x) => x.roundNo)).toEqual(Array(35).fill(72));
    expect(data.roundPages?.length).toBe(142);
  });
  it("no param: every one of the 4,970 cards, no round headers", async () => {
    const data = await read("");
    expect(data.matches.filter((x) => x.divisionSlug === "premier").length).toBe(4970);
    expect(data.roundPages).toBeUndefined();
  });
});
