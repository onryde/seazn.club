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
import { hubDoc, knockoutView, koRound, m, team } from "./hub-fixtures";
import { TeamsTab } from "../matches-hub/teams-tab";

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

// Review I4: batch C's report assumed "every entrant plays the open round", so the Teams tab's calendar link (shown when the team has a
// DATED match among the document's matches) would survive the window. False for an odd-sized league or pool: one team sits out every
// round. When the window serves one round, that team's every dated match is in a folded round and its calendar link vanished. The
// expected set is the whole document's own render (the tab before windowing), never a list typed here.
describe("I4: an odd league's sit-out team keeps its Teams calendar link through the window", () => {
  /** A 21-team single league (circle method: 21 rounds of 10, one team sitting out each, 210 matches, over the paging line): rounds
   *  1-20 played, round 21 to play - so the window serves round 21 alone. */
  function oddLeague() {
    const ids = Array.from({ length: 21 }, (_, i) => `t${i + 1}`);
    const ring: (string | null)[] = [...ids, null];
    const matches: HubMatchT[] = [];
    const sitsOut: string[] = [];
    for (let r = 1; r <= 21; r++) {
      for (let k = 0; k < 11; k++) {
        const a = ring[k]!;
        const b = ring[21 - k]!;
        if (a === null || b === null) {
          sitsOut.push((a ?? b)!);
          continue;
        }
        const done = r <= 20;
        matches.push(
          m(`O${r}-${k}`, done ? "completed" : "upcoming", new Date(NOW + (r - 21) * DAY).toISOString(), "odd", {
            roundNo: r,
            header: { sides: [
              { entrantId: a, name: a, short: a, colour: null, badgeUrl: null },
              { entrantId: b, name: b, short: b, colour: null, badgeUrl: null },
            ] } as never,
          }),
        );
      }
      ring.splice(1, 0, ring.pop()!);
    }
    const teams = ids.map((id) => team(id, id, null, null, { divisionSlug: "odd" }));
    return { doc: hubDoc({ matches, teams }), sitsOut };
  }
  const calendarLinks = (doc: CompetitionHubDocT) =>
    [...renderToStaticMarkup(<TeamsTab doc={doc} dict={en as Dict} locale="en" />).matchAll(/data-testid="mh-team-(t\d+)-calendar"/g)].map((x) => x[1]).sort();

  it("premise: 210 matches over the paging line, the window serves round 21 alone, and its sit-out team is in none of it", () => {
    const { doc, sitsOut } = oddLeague();
    expect(doc.matches.length).toBe(210);
    const served = windowHubDoc(doc);
    expect([...new Set(served.matches.map((x) => x.roundNo))]).toEqual([21]);
    const out = sitsOut[20]!;
    expect(served.matches.some((x) => x.header.sides.some((sd) => sd.entrantId === out)), "the sit-out plays none of round 21").toBe(false);
  });

  it("the windowed document's Teams tab offers the same calendar links as the whole document's: every team, the sit-out included", () => {
    const { doc, sitsOut } = oddLeague();
    const whole = calendarLinks(doc);
    expect(whole.length, "anti-vacuity: the whole document offers every team its calendar").toBe(21);
    expect(whole).toContain(sitsOut[20]!);
    expect(calendarLinks(windowHubDoc(doc) as CompetitionHubDocT)).toEqual(whole);
  });

  it("a team with no dated match anywhere - none at all, or only undated ones in a folded round - gets no calendar link, windowed or not", () => {
    const { doc } = oddLeague();
    // t98 v t99 in folded round 3, never given a time.
    const tbd = m("TBD-1", "upcoming", null, "odd", {
      roundNo: 3,
      header: { sides: [
        { entrantId: "t98", name: "t98", short: "t98", colour: null, badgeUrl: null },
        { entrantId: "t99", name: "t99", short: "t99", colour: null, badgeUrl: null },
      ] } as never,
    });
    const undated = {
      ...doc,
      matches: [...doc.matches, tbd],
      teams: [...doc.teams, team("t98", "t98", null, null, { divisionSlug: "odd" }), team("t99", "t99", null, null, { divisionSlug: "odd" }), team("t97", "t97", null, null, { divisionSlug: "odd" })],
    };
    expect(windowHubDoc(undated).matches.some((x) => x.fixtureId === "TBD-1"), "premise: the undated match is folded").toBe(false);
    expect(calendarLinks(undated)).not.toContain("t99");
    for (const links of [calendarLinks(undated), calendarLinks(windowHubDoc(undated) as CompetitionHubDocT)]) {
      expect(links.filter((x) => ["t97", "t98", "t99"].includes(x))).toEqual([]);
      expect(links.length, "anti-vacuity: the league's own 21 keep theirs").toBe(21);
    }
  });
});

// Review N3: a postponed match behind a fully played last round. Through the hub's window: the match is served, Overview's next up
// (landingStatus "next") names its time, and the landing never reads "finished" while it is still to play.
describe("N3: a postponed match behind a fully played last round stays on the hub", () => {
  /** 15 rounds of 15 (225 cards): every round played except one match of round 5, postponed to two days ahead. */
  function seasonWithPostponed(played: boolean) {
    const at = new Date(NOW + 2 * DAY).toISOString();
    return hubDoc({
      matches: Array.from({ length: 225 }, (_, i) => {
        const round = Math.floor(i / 15) + 1;
        const postponed = round === 5 && i % 15 === 0 && !played;
        return m(`S${round}-${i % 15}`, postponed ? "upcoming" : "completed", postponed ? at : new Date(NOW - (16 - round) * DAY).toISOString(), "premier", { roundNo: round });
      }),
    });
  }

  it("postponed: served, next up names its time, the landing is not finished; once played: finished", () => {
    const served = windowHubDoc(seasonWithPostponed(false));
    expect(served.matches.map((x) => x.fixtureId), "the postponed match is served").toContain("S5-0");
    const status = landingStatus({ matches: served.matches, divisions: served.divisions.length, startsOn: null, endsOn: null, now: new Date(NOW) });
    expect(status).toEqual({ kind: "next", at: new Date(NOW + 2 * DAY).toISOString(), tz: expect.any(String) });
    const after = windowHubDoc(seasonWithPostponed(true));
    const end = landingStatus({ matches: after.matches, divisions: after.divisions.length, startsOn: null, endsOn: null, now: new Date(NOW) });
    expect(end.kind, "premise: the same season played out reads finished").toBe("finished");
  });
});

