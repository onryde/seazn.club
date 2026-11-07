// The day read for a Match Day code (capture S4 design §5, §9.3; MD-1 Task 3): the courts in the code's scope with their
// Now / Next / finished matches, the matches with no court (a whole-competition code only), and the approvals waiting.
// Plus the route's door (`GET /api/v1/match-day-code`, Bearer md_…) and the answer's shape against its contract twin.
// Real Postgres required; skipped without DATABASE_URL.
//
// One sport on purpose: the read reads no sport — a row's `sport_key` is copied from its division, and only decides which
// pad the phone opens (§5 "Several sports in one competition need no special handling").
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { CaptureMatchdayDay } from "@/server/api-v1/capture-schemas";
import { mintMatchDayCode, revokeMatchDayCode, resolveMatchDayCode, type MatchDayCodeRow, type MatchDayScope } from "../match-day-codes";
import { getMatchDayForCode } from "../match-day-code-view";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { ensureDeviceLink } from "../device-links";
import { at, iso, place, seedDay, setStatus, T0, type Day } from "./_match-day-seed";
import { GET } from "@/app/api/v1/match-day-code/route";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
vi.stubEnv("OAUTH_BASE_URL", "https://md.test.seazn.club");

const HAS_DB = !!process.env.DATABASE_URL;
const GENERIC = { name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } };
/** The read's instant: 10:30 UTC on Saturday 7 November, 11:30 in Amsterdam — inside the code's day. */
const NOW = at(30);
const tokenOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** A code for Saturday 7 November in the org's zone, minted at T0 (the mint refuses a day already over by the clock). */
async function codeFor(day: Day, scope: MatchDayScope, canApprove = false): Promise<{ code: MatchDayCodeRow; token: string }> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
  try {
    const { row, url } = await mintMatchDayCode(day.auth, day.comp.id, { scope, day: "2026-11-07", canApprove });
    return { code: row, token: tokenOf(url) };
  } finally {
    vi.useRealTimers();
  }
}

/** Finish a match at `minutes` after T0: the status first (V432's trigger stamps finished_at with the clock), then the
 *  stamp itself, which the trigger keeps once the status is already finished. */
async function finishAt(fixtureId: string, minutes: number): Promise<void> {
  await setStatus(fixtureId, "decided");
  await sql`update fixtures set finished_at = ${iso(minutes)} where id = ${fixtureId}`;
}

async function roundNo(fixtureId: string): Promise<number> {
  const [r] = await sql<{ round_no: number }[]>`select round_no from fixtures where id = ${fixtureId}`;
  return r!.round_no;
}

describe.skipIf(!HAS_DB)("the day read for a Match Day code", () => {
  let day: Day;
  /** The board every scope test reads (comp.fixtures f0..f5, a doubles round robin of four pairs):
   *  - f0 in play on Court 1 (Hall A), planned 10:00;
   *  - f1 planned on Court 1 at 11:00 — Court 1's Next;
   *  - f2 finished on Court 1 at 09:30 today;
   *  - f3 planned on Court 3 (Hall B) at 11:30;
   *  - f4 ready with no court and no time — Not on a court yet;
   *  - f5 finished on Court 2 YESTERDAY: no row anywhere, and Court 2 is Free. */
  let f: string[];
  beforeEach(async () => {
    day = await seedDay();
    f = day.comp.fixtures.map((x) => x.id);
    const { c1, c2, c3 } = day.courts;
    await place(day, f[0]!, 0, c1);
    await setStatus(f[0]!, "in_play");
    await place(day, f[1]!, 60, c1);
    await place(day, f[2]!, -120, c1);
    await finishAt(f[2]!, -30);
    await place(day, f[3]!, 90, c3);
    await place(day, f[4]!, null, null);
    await place(day, f[5]!, -24 * 60, c2);
    await finishAt(f[5]!, -24 * 60 + 40);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("competition scope lists every court, today's finished matches per court and no_court", async () => {
    const { code } = await codeFor(day, { kind: "competition" });
    const view = await getMatchDayForCode(code, NOW);
    expect(CaptureMatchdayDay.safeParse(view).success, "the answer matches its contract twin").toBe(true);
    expect(view.competition).toEqual({ id: day.comp.id, name: day.comp.name });
    expect(view.scope).toEqual({ kind: "competition", label: day.comp.name });
    expect(view).toMatchObject({
      day: "2026-11-07",
      tz: "Europe/Amsterdam",
      opens_at: "2026-11-06T23:00:00.000Z",
      expires_at: "2026-11-07T23:00:00.000Z",
      can_approve: false,
      online: [],
      approvals: [],
    });
    const { c1, c2, c3 } = day.courts;
    expect(view.courts.map((c) => c.court_id)).toEqual([c1, c2, c3]);
    const [one, two, three] = view.courts;
    expect(one).toMatchObject({ court_name: "Court 1", venue_name: "Hall A", state: "playing" });
    expect(one!.now).toEqual({
      fixture_id: f[0],
      sport_key: "generic",
      division_name: "Doubles",
      round_label: `R${await roundNo(f[0]!)}`,
      home: expect.any(String),
      away: expect.any(String),
      status: "in_play",
      scheduled_at: iso(0),
      summary: null,
    });
    expect(one!.next.map((r) => [r.fixture_id, r.status, r.scheduled_at])).toEqual([[f[1], "upcoming", iso(60)]]);
    expect(one!.finished.map((r) => [r.fixture_id, r.status])).toEqual([[f[2], "finished"]]);
    // Court 2's only match finished yesterday: free, and nothing listed on it.
    expect(two).toMatchObject({ court_name: "Court 2", venue_name: "Hall A", state: "free", now: null, next: [], finished: [] });
    expect(three).toMatchObject({ court_name: "Court 3", venue_name: "Hall B", state: "free", now: null, finished: [] });
    expect(three!.next.map((r) => r.fixture_id)).toEqual([f[3]]);
    expect(view.no_court.map((r) => [r.fixture_id, r.status, r.scheduled_at])).toEqual([[f[4], "upcoming", null]]);
    // Every one of the six is accounted for exactly once, except yesterday's.
    const listed = [...view.courts.flatMap((c) => [...(c.now ? [c.now] : []), ...c.next, ...c.finished]), ...view.no_court].map((r) => r.fixture_id);
    expect(listed.sort()).toEqual([f[0], f[1], f[2], f[3], f[4]].sort());
  });

  it("finished is today's, newest first", async () => {
    // A second match finished on Court 1 today, later than f2.
    await place(day, f[5]!, -60, day.courts.c1);
    await sql`update fixtures set finished_at = ${iso(-10)} where id = ${f[5]!}`;
    const { code } = await codeFor(day, { kind: "competition" });
    const view = await getMatchDayForCode(code, NOW);
    expect(view.courts[0]!.finished.map((r) => r.fixture_id)).toEqual([f[5], f[2]]);
  });

  it("venue scope lists only that venue's courts and an empty no_court", async () => {
    const { code } = await codeFor(day, { kind: "venue", venueId: day.venues.hallA });
    const view = await getMatchDayForCode(code, NOW);
    expect(view.scope).toEqual({ kind: "venue", label: "Hall A" });
    expect(view.courts.map((c) => c.court_id)).toEqual([day.courts.c1, day.courts.c2]);
    expect(view.no_court).toEqual([]);
    expect(view.courts[0]!.now?.fixture_id).toBe(f[0]);
    expect(CaptureMatchdayDay.safeParse(view).success).toBe(true);
  });

  it("courts scope lists exactly its courts", async () => {
    // Named out of the board's order: the answer keeps the board's order (Court 2, then Court 3).
    const { code } = await codeFor(day, { kind: "courts", courtIds: [day.courts.c3, day.courts.c2] });
    const view = await getMatchDayForCode(code, NOW);
    expect(view.scope).toEqual({ kind: "courts", label: "Court 2, Court 3" });
    expect(view.courts.map((c) => c.court_id)).toEqual([day.courts.c2, day.courts.c3]);
    expect(view.no_court).toEqual([]);
    expect(view.courts[1]!.next.map((r) => r.fixture_id)).toEqual([f[3]]);
  });

  it("a match moved off a courts code's courts drops out of its list", async () => {
    const { code } = await codeFor(day, { kind: "courts", courtIds: [day.courts.c3] });
    expect((await getMatchDayForCode(code, NOW)).courts[0]!.next.map((r) => r.fixture_id)).toEqual([f[3]]);
    await place(day, f[3]!, 90, day.courts.c2);
    const after = await getMatchDayForCode(code, NOW);
    expect(after.courts.map((c) => c.court_id)).toEqual([day.courts.c3]);
    expect(after.courts[0]!.next).toEqual([]);
  });

  describe("approvals", () => {
    /** A division in the same competition: a league of four, then `Finals`, a knockout drawn from it at setup. */
    async function drawDivision(): Promise<{ leagueId: string; finalsId: string }> {
      const division = await createDivision(day.auth, day.comp.id, { ...GENERIC, name: "Open", slug: "open-ko" });
      await createEntrants(day.auth, division.id, ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
      const [league] = await createStages(day.auth, division.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
      await generateStageFixtures(day.auth, league!.id);
      const [finals] = await createStages(day.auth, division.id, {
        seq: 2, kind: "knockout", name: "Finals", config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
      });
      await generateStageFixtures(day.auth, finals!.id);
      await sql`update divisions set status = 'active' where id = ${division.id}`;
      await sql`update fixtures set status = 'decided' where stage_id = ${league!.id}`;
      return { leagueId: league!.id, finalsId: finals!.id };
    }

    /** A Swiss of four over three rounds, round 1 seated (the first Generate mints the shells, the second seats round 1). */
    async function swissDivision(): Promise<{ swissId: string }> {
      const division = await createDivision(day.auth, day.comp.id, { ...GENERIC, name: "Swiss Open", slug: "swiss-open" });
      await createEntrants(day.auth, division.id, ["P", "Q", "R", "S"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
      const [swiss] = await createStages(day.auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null });
      await generateStageFixtures(day.auth, swiss!.id);
      await generateStageFixtures(day.auth, swiss!.id);
      return { swissId: swiss!.id };
    }

    it("approvals lists needs_draw stages and Swiss stages with an unseated next round", async () => {
      const { leagueId, finalsId } = await drawDivision();
      const { swissId } = await swissDivision();
      const { code } = await codeFor(day, { kind: "competition" }, true);
      // Neither is ready: the league is not complete (its draw has no source yet), and Swiss round 1 is still to play.
      expect((await getMatchDayForCode(code, NOW)).approvals).toEqual([]);
      const seated = await sql<{ n: number }[]>`
        select count(*)::int as n from fixtures where stage_id = ${swissId} and round_no = 1 and home_entrant_id is not null`;
      expect(seated[0]!.n, "the premise: round 1 is seated").toBe(2);
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      await sql`update fixtures set status = 'decided' where stage_id = ${swissId} and round_no = 1`;
      const view = await getMatchDayForCode(code, NOW);
      expect(view.can_approve).toBe(true);
      expect(view.approvals).toEqual([
        { kind: "draw", stage_id: finalsId, division_name: "Open", label: "Finals" },
        { kind: "swiss", stage_id: swissId, division_name: "Swiss Open", label: "Swiss" },
      ]);
      expect(CaptureMatchdayDay.safeParse(view).success).toBe(true);
      // Round 2 seated: nothing waits until it is played.
      await sql`
        update fixtures f set home_entrant_id = r1.home_entrant_id, away_entrant_id = r1.away_entrant_id
          from fixtures r1
         where f.stage_id = ${swissId} and f.round_no = 2 and r1.stage_id = f.stage_id and r1.round_no = 1
           and r1.seq_in_round = f.seq_in_round`;
      expect((await getMatchDayForCode(code, NOW)).approvals.map((a) => a.kind)).toEqual(["draw"]);
    });

    it("approvals is listed with can_approve false too", async () => {
      const { leagueId, finalsId } = await drawDivision();
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      const { code } = await codeFor(day, { kind: "competition" }, false);
      const view = await getMatchDayForCode(code, NOW);
      expect(view.can_approve).toBe(false);
      expect(view.approvals).toEqual([{ kind: "draw", stage_id: finalsId, division_name: "Open", label: "Finals" }]);
    });

    it("a venue code lists no approval for a stage with no match today on its courts", async () => {
      const { leagueId } = await drawDivision();
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      const { code } = await codeFor(day, { kind: "venue", venueId: day.venues.hallA }, true);
      expect((await getMatchDayForCode(code, NOW)).approvals).toEqual([]);
    });
  });

  describe("GET /api/v1/match-day-code", () => {
    const get = (bearer: string | null): Promise<Response> =>
      GET(new Request("https://test.local/api/v1/match-day-code", { headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` } }));

    it("GET with a withdrawn code is 410 MD_WITHDRAWN; with no bearer 401", async () => {
      const { code, token } = await codeFor(day, { kind: "competition" });
      await revokeMatchDayCode(day.auth, code.id);
      const gone = await get(token);
      expect(gone.status).toBe(410);
      expect((await gone.json()).error.code).toBe("MD_WITHDRAWN");
      const none = await get(null);
      expect(none.status).toBe(401);
      expect((await none.json()).error.code).toBe("MD_UNKNOWN");
      // A device link is no Match Day code.
      expect((await get(`dl_${randomBytes(32).toString("base64url")}`)).status).toBe(401);
    });

    it("GET before the day opens is 403 MD_NOT_OPEN with opens_at; inside it, 200 with the day", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
      const { row, url } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, day: "2026-11-08", canApprove: false });
      vi.setSystemTime(NOW);
      const early = await get(tokenOf(url));
      expect(early.status).toBe(403);
      expect((await early.json()).error).toMatchObject({ code: "MD_NOT_OPEN", opens_at: row.opensAt.toISOString() });
      const { token } = await codeFor(day, { kind: "competition" });
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const ok = await get(token);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      const body = await ok.json();
      expect(CaptureMatchdayDay.safeParse(body.data).success).toBe(true);
      expect(body.data.courts[0].now.fixture_id).toBe(f[0]);
    });

    it("the answer never contains the token or any /score/ link", async () => {
      // A live scoring link on a listed match: the list must still never carry it.
      await ensureDeviceLink(day.auth, f[1]!);
      const { code, token } = await codeFor(day, { kind: "competition" }, true);
      expect((await resolveMatchDayCode(token, NOW)).ok).toBe(true);
      const view = JSON.stringify(await getMatchDayForCode(code, NOW));
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const wire = await (await get(token)).text();
      for (const text of [view, wire]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain("/score/");
        expect(text).not.toContain("dl_");
        expect(text).not.toContain("md_");
      }
      expect(wire.length).toBeGreaterThan(200);
    });
  });
});
