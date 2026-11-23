// W5 follow-ups C (owner 2026-11-23, Option A "by round"): a BIG division's Schedule tab ships the live and the next round's rows
// and every other round as a header with its counts; the round loader beside the page (`../rounds/route.ts`) answers one folded
// round, or one team across every round, out of the same cached document. Both are driven through their REAL producer (the page
// and the route, behind the loader seam) - never a fixture on both ends.
//
// Every expected value comes from the SCENE (its statuses, its rounds, its pairings), never from the paging code: a round's
// counts are counted off the scene's own fixtures, the rows a round loads are the scene's fixtures of that round.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { forEachSportAsync } from "@seazn/engine/testkit";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/table-withdrawals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/table-withdrawals")>()),
  loadTableWithdrawals: async () => [],
}));
vi.mock("@/server/public-site/points-adjustments", () => ({ loadPointsAdjustments: async () => [] }));
vi.mock("@/server/public-site/bestnth-basis", () => ({ loadBestNthBases: async () => new Map() }));
vi.mock("@/server/public-site/table-row-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/table-row-facts")>()),
  loadRrLateJoins: async () => new Map(),
}));
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));
vi.mock("@/server/usecases/public", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/public")>()),
  publicRateLimit: async () => {},
}));

import { PackedSchedule } from "@/components/public-site/packed-schedule";
import { PagedSchedule } from "@/components/public-site/paged-schedule";
import { unpackRows } from "@/lib/packed-rows";
import { ROUND_PAGING_MIN_FIXTURES } from "@/lib/round-paging";
import type { PagedScheduleData, ScheduleRoundsAnswer } from "@/lib/schedule-paging";
import type { PublicFixture } from "@/server/public-site/data";
import DivisionHomePage from "../page";
import { GET as roundsGET } from "../rounds/route";

function find(node: unknown, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const child of node) find(child, type, out);
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) find(value, type, out);
  }
  return out;
}

const T0 = Date.UTC(2026, 9, 1, 9, 0);
type Status = PublicFixture["status"];
const fx = (id: string, stage: string, round: number, seq: number, home: string | null, away: string | null, status: Status, extra: Partial<PublicFixture> = {}) =>
  ({
    id, division_id: "d1", stage_id: stage, pool_id: null, round_no: round, seq_in_round: seq, home_entrant_id: home, away_entrant_id: away,
    status, scheduled_at: new Date(T0 + (round * 7 + seq) * 3_600_000).toISOString(), venue: null, court_label: null, venue_name: null,
    court_name: null, outcome: status === "decided" && home ? { winner: home } : null, summary: null, home_slot_label: null,
    away_slot_label: null, last_seq: null, ext_key: null, ...extra,
  }) as unknown as PublicFixture;
const entrant = (id: string, name: string) =>
  ({ id, display_name: name, seed: null, kind: "individual", status: "active", members: [], badge_url: null, team_display: null }) as unknown;

/** A single round robin by the circle method: n entrants (n even), n-1 rounds of n/2 matches, every pairing once. */
function roundRobin(n: number, statusOf: (round: number, seq: number) => Status) {
  const ids = Array.from({ length: n }, (_, i) => `e${i + 1}`);
  const fixtures: PublicFixture[] = [];
  const ring = [...ids];
  for (let round = 1; round < n; round++) {
    for (let k = 0; k < n / 2; k++) {
      fixtures.push(fx(`f${round}-${k + 1}`, "lg", round, k + 1, ring[k]!, ring[n - 1 - k]!, statusOf(round, k + 1)));
    }
    ring.splice(1, 0, ring.pop()!);
  }
  return { ids, fixtures };
}

const N = 22; // 231 fixtures, 21 rounds of 11: over the paging line
const midSeason = (round: number, seq: number): Status =>
  round <= 5 ? "decided" : round === 6 ? (seq <= 2 ? "in_play" : seq <= 6 ? "decided" : "scheduled") : "scheduled";

function scene(opts: { sport?: string; fixtures?: PublicFixture[]; stages?: unknown[] } = {}) {
  const rr = roundRobin(N, midSeason);
  return {
    org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: "en" },
    competition: { id: "c1", org_id: "o1", name: "Cup", slug: "cup", description: null, starts_on: null, ends_on: null, branding: {}, status: "active", visibility: "public" },
    division: {
      id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: opts.sport ?? "badminton", variant_key: null,
      status: "active", module_version: null, tiebreakers: null, sport_name: null, entrant_count: N, config: {},
    },
    stages: opts.stages ?? [{ id: "lg", division_id: "d1", seq: 1, kind: "league", name: "League", status: "active" }],
    pools: [],
    fixtures: opts.fixtures ?? rr.fixtures,
    standings: [],
    entrants: rr.ids.map((id, i) => entrant(id, `Player ${String(i + 1).padStart(2, "0")}`)),
    tz: "UTC",
  };
}
const params = { orgSlug: "test-org", competitionSlug: "cup", divisionSlug: "open" };
async function pagedProps(data: ReturnType<typeof scene>) {
  getPublicDivision.mockResolvedValue(data);
  const root = await DivisionHomePage({ params: Promise.resolve(params) });
  const paged = find(root, PagedSchedule);
  const small = find(root, PackedSchedule);
  return { paged: paged[0]?.props as { data: PagedScheduleData } | undefined, small: small.length };
}
async function ask(data: ReturnType<typeof scene>, q: string): Promise<{ status: number; body: { data?: ScheduleRoundsAnswer } }> {
  getPublicDivision.mockResolvedValue(data);
  const res = await roundsGET(new Request(`http://x/live/test-org/cup/open/rounds?${q}`), { params: Promise.resolve(params) });
  return { status: res.status, body: res.status === 200 ? await res.json() : {} };
}
const roundOf = (f: PublicFixture) => f.round_no;
const keyOfRound = (data: PagedScheduleData, round: number) => data.groups.find((g) => g.roundNo === round)!.key;
const bucket = (s: Status) => (s === "in_play" ? "live" : s === "scheduled" ? "upcoming" : "result");

describe("C: the public Schedule of a big division pages by round", () => {
  it("premise: the scene is over the paging line, and a small division keeps the whole list as before", async () => {
    const data = scene();
    expect(data.fixtures.length).toBe(231);
    expect(data.fixtures.length).toBeGreaterThan(ROUND_PAGING_MIN_FIXTURES);
    const big = await pagedProps(data);
    expect(big.paged, "a big division renders the paged schedule").toBeDefined();
    expect(big.small).toBe(0);
    const small = await pagedProps(scene({ fixtures: data.fixtures.slice(0, ROUND_PAGING_MIN_FIXTURES) }));
    expect(small.paged, "at the line: no paging").toBeUndefined();
    expect(small.small).toBe(1);
  });

  it("open rounds chosen: the live round and the next round ship their rows, nothing else does", async () => {
    const data = scene();
    const { paged } = await pagedProps(data);
    const groups = paged!.data.groups;
    expect(groups.map((g) => g.roundNo), "every round, in play order").toEqual(Array.from({ length: N - 1 }, (_, i) => i + 1));
    expect(groups.filter((g) => g.open).map((g) => g.roundNo)).toEqual([6, 7]);
    expect(Object.fromEntries(groups.map((g) => [g.roundNo, g.state]))).toMatchObject({ 1: "finished", 5: "finished", 6: "live", 7: "next", 8: "upcoming", 21: "upcoming" });
    // The rows shipped are exactly the scene's fixtures of rounds 6 and 7, unpacked from the wire as they would be.
    const shipped = groups.flatMap((g) => (g.rows ? unpackRows(JSON.parse(JSON.stringify(g.rows)) as never) : [])) as PublicFixture[];
    const want = data.fixtures.filter((f) => f.round_no === 6 || f.round_no === 7);
    expect(shipped.map((f) => f.id).sort()).toEqual(want.map((f) => f.id).sort());
    expect(shipped.length, "anti-vacuity: two rounds of rows").toBe(22);
  });

  it("folded rounds ship as counts only: no rows, no row extras, and the counts are the scene's own", async () => {
    const data = scene();
    // A folded round with an unfilled seat, so a folded seat label exists to leak.
    data.fixtures.push(fx("tbd-1", "lg", 21, 12, null, null, "scheduled"));
    const { paged } = await pagedProps(data);
    const folded = paged!.data.groups.filter((g) => !g.open);
    expect(folded.length, "anti-vacuity").toBe(19);
    for (const g of folded) {
      expect(g.rows, `round ${g.roundNo}: no rows`).toBeUndefined();
      const own = data.fixtures.filter((f) => roundOf(f) === g.roundNo);
      expect({ live: g.live, upcoming: g.upcoming, result: g.result, total: g.total }, `round ${g.roundNo}`).toEqual({
        live: own.filter((f) => bucket(f.status) === "live").length,
        upcoming: own.filter((f) => bucket(f.status) === "upcoming").length,
        result: own.filter((f) => bucket(f.status) === "result").length,
        total: own.length,
      });
    }
    const shippedIds = new Set(paged!.data.groups.filter((g) => g.open).flatMap((g) => unpackRows(g.rows!).map((f) => f.id)));
    const extraIds = Object.keys(paged!.data.extras.slotLabels).map((k) => k.split(":")[0]!);
    expect(extraIds.every((id) => shippedIds.has(id)), "no folded row's seat label rides the page").toBe(true);
    expect(Object.keys(paged!.data.extras.slotLabels)).not.toContain("tbd-1:home");
  });

  it("the round loader returns exactly that round's rows - every round of the division, swept", async () => {
    const data = scene();
    const { paged } = await pagedProps(data);
    let rows = 0;
    for (const g of paged!.data.groups) {
      const { status, body } = await ask(data, `round=${encodeURIComponent(g.key)}`);
      expect(status, `round ${g.roundNo}`).toBe(200);
      const answer = body.data!;
      expect(answer.kind).toBe("round");
      if (answer.kind !== "round") continue;
      expect(answer.rows.map((f) => f.id), `round ${g.roundNo}`).toEqual(data.fixtures.filter((f) => roundOf(f) === g.roundNo).map((f) => f.id));
      rows += answer.rows.length;
    }
    expect(rows, "anti-vacuity: every fixture came back once").toBe(data.fixtures.length);
  });

  it("a folded round with an unfilled seat brings its seat label with it (the extras follow the rows)", async () => {
    const data = scene();
    data.fixtures.push(fx("tbd-1", "lg", 21, 12, null, null, "scheduled"));
    const { paged } = await pagedProps(data);
    const { body } = await ask(data, `round=${encodeURIComponent(keyOfRound(paged!.data, 21))}`);
    const answer = body.data!;
    expect(answer.kind === "round" && answer.rows.some((f) => f.id === "tbd-1")).toBe(true);
    expect(Object.keys(answer.extras.slotLabels).sort()).toEqual(["tbd-1:away", "tbd-1:home"]);
  });

  it("team search covers every round: a team's answer is its every match, round by round, whatever is open or folded", async () => {
    const data = scene();
    let teams = 0;
    for (const id of ["e1", "e7", "e22"]) {
      const { status, body } = await ask(data, `entrant=${id}`);
      expect(status).toBe(200);
      const answer = body.data!;
      if (answer.kind !== "entrant") throw new Error("premise: a team answer");
      const mine = data.fixtures.filter((f) => f.home_entrant_id === id || f.away_entrant_id === id);
      expect(mine.length, "premise: a round robin plays everyone").toBe(N - 1);
      expect(answer.rounds.flatMap((r) => r.rows.map((f) => f.id))).toEqual(mine.map((f) => f.id));
      // One round per round it plays - folded (1-5, 8-21) and open (6, 7) alike.
      expect(answer.rounds.length).toBe(N - 1);
      teams += 1;
    }
    expect(teams).toBe(3);
  });

  it("refuses by name: no question, two questions, a round or a team the division does not have", async () => {
    const data = scene();
    expect((await ask(data, "")).status).toBe(400);
    expect((await ask(data, "round=x&entrant=e1")).status).toBe(400);
    expect((await ask(data, "round=")).status).toBe(400);
    expect((await ask(data, `round=${encodeURIComponent(JSON.stringify(["lg", "Round 99"]))}`)).status).toBe(404);
    expect((await ask(data, "entrant=nobody")).status).toBe(404);
    getPublicDivision.mockResolvedValue(null);
    const res = await roundsGET(new Request("http://x/rounds?entrant=e1"), { params: Promise.resolve(params) });
    expect(res.status).toBe(404);
  });

  it("the empty division: no paging, and the loader has no round to give", async () => {
    const data = scene({ fixtures: [] });
    const { paged, small } = await pagedProps(data);
    expect(paged).toBeUndefined();
    expect(small).toBe(1);
    expect((await ask(data, `round=${encodeURIComponent(JSON.stringify(["lg", "Round 1"]))}`)).status).toBe(404);
    const team = await ask(data, "entrant=e1");
    expect(team.status).toBe(200);
    expect(team.body.data!.kind === "entrant" && team.body.data!.rounds).toEqual([]);
  });

  it("everything finished: the last round opens, the other twenty fold as finished", async () => {
    const data = scene({ fixtures: roundRobin(N, () => "decided").fixtures });
    const { paged } = await pagedProps(data);
    const groups = paged!.data.groups;
    expect(groups.every((g) => g.state === "finished")).toBe(true);
    expect(groups.filter((g) => g.open).map((g) => g.roundNo)).toEqual([N - 1]);
    expect(groups.filter((g) => !g.open).length).toBe(N - 2);
  });

  it("a round with a void (a cancelled match) is still a finished round, and the void counts among its results", async () => {
    const voided = roundRobin(N, (round, seq) => (round === 3 && seq === 4 ? "cancelled" : midSeason(round, seq))).fixtures;
    const { paged } = await pagedProps(scene({ fixtures: voided }));
    const r3 = paged!.data.groups.find((g) => g.roundNo === 3)!;
    expect(r3).toMatchObject({ state: "finished", open: false, result: 11, upcoming: 0 });
    // A void in the live round's own place (round 7 is next) does not move the open rounds.
    expect(paged!.data.groups.filter((g) => g.open).map((g) => g.roundNo)).toEqual([6, 7]);
  });

  it("a knockout folds by bracket round, named as the round view names it", async () => {
    // 256 entrants: 128 + 64 + ... + 1 = 255 matches, over the line; the first two rounds played, the third live.
    const fixtures: PublicFixture[] = [];
    let count = 128;
    for (let round = 1; count >= 1; round++, count /= 2) {
      for (let seq = 1; seq <= count; seq++) {
        const status: Status = round <= 2 ? "decided" : round === 3 && seq === 1 ? "in_play" : "scheduled";
        fixtures.push(fx(`k${round}-${seq}`, "ko", round, seq, round === 1 ? `e${seq}` : null, round === 1 ? `e${seq + 128}` : null, status));
      }
    }
    const { paged } = await pagedProps(scene({ fixtures, stages: [{ id: "ko", division_id: "d1", seq: 1, kind: "knockout", name: "Cup", status: "active" }] }));
    const groups = paged!.data.groups;
    expect(groups.length, "eight bracket rounds").toBe(8);
    expect(groups.at(-1)!.label).toBe("Final");
    expect(groups.filter((g) => g.open).map((g) => g.roundNo)).toEqual([3, 4]);
  });

  it("another sport: every sport in the registry pages the same scene the same way (paging reads statuses and rounds only)", async () => {
    const visited = await forEachSportAsync(async ({ key }) => {
      const { paged } = await pagedProps(scene({ sport: key }));
      expect(paged, key).toBeDefined();
      expect(paged!.data.groups.filter((g) => g.open).map((g) => g.roundNo), key).toEqual([6, 7]);
    });
    expect(visited, "anti-vacuity: the registry is not empty").toBeGreaterThan(1);
  });
});
