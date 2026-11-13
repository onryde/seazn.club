// The day read for a Match Day code (capture S4 design §5, §9.3; MD-1 Task 3): the courts in the code's scope with their
// Now / Next / finished matches, the matches with no court (a whole-competition code only), and the approvals waiting.
// Plus the route's door (`GET /api/v1/match-day-code`, Bearer md_…) and the answer's shape against its contract twin.
// Real Postgres required; skipped without DATABASE_URL.
//
// One sport on purpose: the read reads no sport — a row's `sport_key` is copied from its division, and only decides which
// pad the phone opens (§5 "Several sports in one competition need no special handling").
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

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
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
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
      // A league round is its R{n} code, the same as round_label (F-T8-3); both seats have entrants, so no slot text.
      round_tag: `R${await roundNo(f[0]!)}`,
      home: expect.any(String),
      away: expect.any(String),
      home_slot: null,
      away_slot: null,
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

  it("a row's summary is the desk's short score, never the full headline: a badminton match in play and a finished one", async () => {
    // single-sport: badminton — a set sport, whose full headline carries every game's score (the controller's ruling: the
    // phone's 320 dp row shows the desk's short form, `compactScore`, court-list.tsx's row score).
    const div = await createDivision(day.auth, day.comp.id, {
      name: "Shuttle",
      slug: "shuttle-" + randomUUID().slice(0, 6),
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    await createEntrants(day.auth, div.id, ["B1", "B2", "B3", "B4"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
    const [stage] = await createStages(day.auth, div.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    await startDivision(day.auth, div.id);
    await generateStageFixtures(day.auth, stage!.id);
    const [playing, done] = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id}
         and home_entrant_id is not null and away_entrant_id is not null order by round_no, seq_in_round limit 2`;
    const send = async (id: string, type: string, payload: unknown = {}) => {
      const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${id}`;
      await scoreEvent(day.auth, id, { expected_seq: n, type, payload } as never);
    };
    // In play on Court 3: the first game 21–15 to home, then 9–4 in the second.
    await place(day, playing!.id, 0, day.courts.c3);
    await send(playing!.id, "core.start");
    await send(playing!.id, "badminton.game.summary", { home: 21, away: 15 });
    for (let i = 0; i < 9; i++) await send(playing!.id, "badminton.rally", { wonBy: playing!.home_entrant_id });
    for (let i = 0; i < 4; i++) await send(playing!.id, "badminton.rally", { wonBy: playing!.away_entrant_id });
    // Finished on Court 2 today: 21–15, 21–18.
    await place(day, done!.id, -60, day.courts.c2);
    await send(done!.id, "core.start");
    await send(done!.id, "badminton.game.summary", { home: 21, away: 15 });
    await send(done!.id, "badminton.game.summary", { home: 21, away: 18 });
    await sql`update fixtures set finished_at = ${iso(-10)} where id = ${done!.id}`;

    const [{ headline }] = await sql<{ headline: string }[]>`select summary->>'headline' as headline from match_states where fixture_id = ${playing!.id}`;
    expect(headline, "premise: the engine's headline is the long form, not the desk's short one").toBe("1 — 0 · 21–15 (9–4)");
    expect(headline).not.toBe("1–0 · 9–4");
    const { code } = await codeFor(day, { kind: "competition" });
    const view = await getMatchDayForCode(code, NOW);
    const rows = view.courts.flatMap((c) => [...(c.now ? [c.now] : []), ...c.next, ...c.finished]);
    // As the desk's court row shows them: sets won · live points; the same form once finished.
    expect(rows.find((r) => r.fixture_id === playing!.id)).toMatchObject({ status: "in_play", summary: "1–0 · 9–4" });
    expect(rows.find((r) => r.fixture_id === done!.id)).toMatchObject({ status: "finished", summary: "2–0" });
    expect(CaptureMatchdayDay.safeParse(view).success).toBe(true);
  });

  it("a tennis row in play reads sets · games · points, with the level words in English (DEFAULT_LOCALE, the controller's ruling)", async () => {
    // single-sport: tennis — the one nested (three-level) kernel; its live game carries "Ad", a level word the desk composes
    // from the dictionary. The read pins DEFAULT_LOCALE (English) for every phone, so the literal below is English.
    const div = await createDivision(day.auth, day.comp.id, {
      name: "Court Tennis",
      slug: "tennis-" + randomUUID().slice(0, 6),
      sport_key: "tennis",
      variant_key: "tour",
      config: {},
    });
    await createEntrants(day.auth, div.id, ["T1", "T2"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
    const [stage] = await createStages(day.auth, div.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    await startDivision(day.auth, div.id);
    await generateStageFixtures(day.auth, stage!.id);
    const [m] = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id}
         and home_entrant_id is not null and away_entrant_id is not null limit 1`;
    const point = async (by: string) => {
      const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${m!.id}`;
      await scoreEvent(day.auth, m!.id, { expected_seq: n, type: "tennis.point", payload: { by } } as never);
    };
    const H = m!.home_entrant_id;
    const A = m!.away_entrant_id;
    await place(day, m!.id, 0, day.courts.c3);
    const [{ n: seq0 }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${m!.id}`;
    await scoreEvent(day.auth, m!.id, { expected_seq: seq0, type: "core.start", payload: {} } as never);
    // Set 1 to home: six games of four straight points (6–0). Set 2: games alternate H A H A H (3–2 to home), each four
    // straight points; then the live game goes 15–0, 15–15, 30–15, 30–30, 40–30, 40–40 (deuce) and home takes the advantage.
    for (let g = 0; g < 6; g++) for (let i = 0; i < 4; i++) await point(H);
    for (const winner of [H, A, H, A, H]) for (let i = 0; i < 4; i++) await point(winner);
    for (const by of [H, A, H, A, H, A, H]) await point(by);

    const { code } = await codeFor(day, { kind: "competition" });
    const view = await getMatchDayForCode(code, NOW);
    const rows = view.courts.flatMap((c) => [...(c.now ? [c.now] : []), ...c.next, ...c.finished]);
    // sets won · games of the set in play · the game's points ("Ad" is the English advantage call, home leading).
    expect(rows.find((r) => r.fixture_id === m!.id)).toMatchObject({ status: "in_play", sport_key: "tennis", summary: "1–0 · 3–2 · Ad–40" });
    expect(CaptureMatchdayDay.safeParse(view).success).toBe(true);
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

  describe("tags and slot labels (F-T8-3, F-T8-4)", () => {
    /** A four-entrant knockout in its own division: two semi-finals, then the final, whose seats wait for the semi-finals.
     *  Every match is planned on Court 1 today, so the day read lists all three. */
    async function knockoutDay(): Promise<{ sf: string[]; fin: string }> {
      const division = await createDivision(day.auth, day.comp.id, { ...GENERIC, name: "Cup", slug: "cup-ko" });
      await createEntrants(day.auth, division.id, ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
      const [ko] = await createStages(day.auth, division.id, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
      await generateStageFixtures(day.auth, ko!.id);
      await sql`update divisions set status = 'active' where id = ${division.id}`;
      const rows = await sql<{ id: string; round_no: number; seq_in_round: number }[]>`
        select id, round_no, seq_in_round from fixtures where stage_id = ${ko!.id} order by round_no, seq_in_round`;
      expect(rows.map((r) => [r.round_no, r.seq_in_round]), "premise: two semi-finals and a final").toEqual([[1, 1], [1, 2], [2, 1]]);
      for (const [i, r] of rows.entries()) await place(day, r.id, 120 + i * 30, day.courts.c1);
      return { sf: [rows[0]!.id, rows[1]!.id], fin: rows[2]!.id };
    }
    const rowOf = (view: Awaited<ReturnType<typeof getMatchDayForCode>>, id: string) =>
      view.courts.flatMap((c) => [...(c.now ? [c.now] : []), ...c.next, ...c.finished]).find((r) => r.fixture_id === id)!;

    it("the two semi-finals read apart (SF·1, SF·2), the final is F, and round_label is unchanged", async () => {
      const { sf, fin } = await knockoutDay();
      const { code } = await codeFor(day, { kind: "competition" });
      const view = await getMatchDayForCode(code, NOW);
      expect([rowOf(view, sf[0]!), rowOf(view, sf[1]!), rowOf(view, fin)].map((r) => [r.round_label, r.round_tag])).toEqual([
        ["SF", "SF·1"],
        ["SF", "SF·2"],
        ["F", "F"],
      ]);
      expect(CaptureMatchdayDay.safeParse(view).success).toBe(true);
    });

    it("an empty seat reads as the desk words it; a seat with an entrant has no slot text", async () => {
      const { sf, fin } = await knockoutDay();
      // A seated seat can still carry a label stored from before its draw: the entrant's name wins, so no slot text.
      await sql`update fixtures set home_slot_label = ${sql.json({ key: "slot.winner_match", params: { round: 1, seq: 2 } })} where id = ${sf[0]!}`;
      const { code } = await codeFor(day, { kind: "competition" });
      const view = await getMatchDayForCode(code, NOW);
      const final = rowOf(view, fin);
      expect([final.home, final.away]).toEqual([null, null]);
      // The desk's own text for a seat fed by a semi-final (the board's "Winner of SF·1").
      expect([final.home_slot, final.away_slot]).toEqual(["Winner of SF·1", "Winner of SF·2"]);
      // A semi-final's seats are seated: the name is there, the slot text is not.
      const semi = rowOf(view, sf[0]!);
      expect([semi.home === null, semi.away === null, semi.home_slot, semi.away_slot]).toEqual([false, false, null, null]);
    });

    it("R116-4: an empty seat a walkover was won over names her, marked withdrawn, never its stored label", async () => {
      const { sf, fin } = await knockoutDay();
      const [one] = await sql<{ home_entrant_id: string; name: string }[]>`
        select f.home_entrant_id, e.display_name as name from fixtures f join entrants e on e.id = f.home_entrant_id where f.id = ${sf[0]!}`;
      const [two] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${sf[1]!}`;
      // Ruling 116's dead seat: she won SF·1, withdrew, and the final was awarded over her empty seat.
      await sql`update fixtures set home_entrant_id = null, away_entrant_id = ${two!.home_entrant_id},
        home_slot_label = ${sql.json({ key: "bracket.slot.bye" })}, status = 'forfeited',
        outcome = ${sql.json({ kind: "award", winner: two!.home_entrant_id, loser: one!.home_entrant_id, reason: "withdrew" })}
        where id = ${fin}`;
      await sql`update fixtures set finished_at = ${iso(20)} where id = ${fin}`; // the status change stamps the wall clock
      const { code } = await codeFor(day, { kind: "competition" });
      const view = await getMatchDayForCode(code, NOW);
      const final = rowOf(view, fin);
      expect([final.home, final.home_slot, final.away_slot]).toEqual([null, `${one!.name} (withdrawn)`, null]);
      expect(CaptureMatchdayDay.safeParse(view).success).toBe(true);
    });

    it("with no feed edge a seat reads its stored label; with neither feed nor label it is null", async () => {
      const { fin } = await knockoutDay();
      await sql`update fixtures set winner_to_fixture = null, winner_to_slot = null where winner_to_fixture = ${fin}`;
      await sql`update fixtures set home_slot_label = ${sql.json({ key: "slot.winner_match", params: { round: 1, seq: 2 } })}, away_slot_label = null where id = ${fin}`;
      const { code } = await codeFor(day, { kind: "competition" });
      const final = rowOf(await getMatchDayForCode(code, NOW), fin);
      expect([final.home_slot, final.away_slot]).toEqual(["Winner of SF·2", null]);
    });
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
      // Swiss round 1 is still to play, and the draw's league is decided but not completed on the desk: the draw is listed
      // WAITING (F-T8-2), the Swiss is not listed.
      expect((await getMatchDayForCode(code, NOW)).approvals).toEqual([
        { kind: "draw", stage_id: finalsId, division_name: "Open", label: "Finals", round: null, waiting: "stage_complete" },
      ]);
      const seated = await sql<{ n: number }[]>`
        select count(*)::int as n from fixtures where stage_id = ${swissId} and round_no = 1 and home_entrant_id is not null`;
      expect(seated[0]!.n, "the premise: round 1 is seated").toBe(2);
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      await sql`update fixtures set status = 'decided' where stage_id = ${swissId} and round_no = 1`;
      // The pairing gate's own rule (stages.ts): an abandoned board holds the round until the organiser settles it, so it
      // holds the approval too — the phone never offers a pairing the server would refuse STAGE_NOT_READY.
      const [held] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${swissId} and round_no = 1 limit 1`;
      await setStatus(held!.id, "abandoned");
      expect((await getMatchDayForCode(code, NOW)).approvals.map((a) => a.kind), "an abandoned board holds the round").toEqual(["draw"]);
      await setStatus(held!.id, "decided");
      const view = await getMatchDayForCode(code, NOW);
      expect(view.can_approve).toBe(true);
      expect(view.approvals).toEqual([
        // Fix M1: a draw has no round; a Swiss approval names the round awaiting pairing (round 1 played: round 2).
        { kind: "draw", stage_id: finalsId, division_name: "Open", label: "Finals", round: null, waiting: null },
        { kind: "swiss", stage_id: swissId, division_name: "Swiss Open", label: "Swiss", round: 2, waiting: null },
      ]);
      expect(CaptureMatchdayDay.safeParse(view).success).toBe(true);
      // Round 2 seated: nothing waits until it is played.
      await sql`
        update fixtures f set home_entrant_id = r1.home_entrant_id, away_entrant_id = r1.away_entrant_id
          from fixtures r1
         where f.stage_id = ${swissId} and f.round_no = 2 and r1.stage_id = f.stage_id and r1.round_no = 1
           and r1.seq_in_round = f.seq_in_round`;
      expect((await getMatchDayForCode(code, NOW)).approvals.map((a) => a.kind)).toEqual(["draw"]);
      // Round 2 played: round 3 is the one awaiting pairing now.
      await sql`update fixtures set status = 'decided' where stage_id = ${swissId} and round_no = 2`;
      const later = (await getMatchDayForCode(code, NOW)).approvals.find((a) => a.kind === "swiss");
      expect(later).toEqual({ kind: "swiss", stage_id: swissId, division_name: "Swiss Open", label: "Swiss", round: 3, waiting: null });
    });

    it("approvals is listed with can_approve false too", async () => {
      const { leagueId, finalsId } = await drawDivision();
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      const { code } = await codeFor(day, { kind: "competition" }, false);
      const view = await getMatchDayForCode(code, NOW);
      expect(view.can_approve).toBe(false);
      expect(view.approvals).toEqual([{ kind: "draw", stage_id: finalsId, division_name: "Open", label: "Finals", round: null, waiting: null }]);
    });

    it("F-T8-2 — a draw is waiting only while every match of its source is decided: one match still to play lists none; a forfeit counts as decided", async () => {
      const { leagueId } = await drawDivision();
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const [last] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${leagueId} limit 1`;
      await setStatus(last!.id, "scheduled");
      expect((await getMatchDayForCode(code, NOW)).approvals, "one match still to play").toEqual([]);
      await setStatus(last!.id, "in_play");
      expect((await getMatchDayForCode(code, NOW)).approvals, "one match in play").toEqual([]);
      await setStatus(last!.id, "abandoned");
      expect((await getMatchDayForCode(code, NOW)).approvals, "an abandoned match holds the stage, as it holds a Swiss round").toEqual([]);
      await setStatus(last!.id, "forfeited");
      expect((await getMatchDayForCode(code, NOW)).approvals.map((a) => a.waiting)).toEqual(["stage_complete"]);
      await setStatus(last!.id, "finalized");
      expect((await getMatchDayForCode(code, NOW)).approvals.map((a) => a.waiting)).toEqual(["stage_complete"]);
    });

    it("F-T8-2 — completing the stage turns the waiting draw into a ready one (waiting null); the contract accepts both", async () => {
      const { leagueId } = await drawDivision();
      const { code } = await codeFor(day, { kind: "competition" }, true);
      const waiting = await getMatchDayForCode(code, NOW);
      expect(waiting.approvals.map((a) => [a.kind, a.waiting])).toEqual([["draw", "stage_complete"]]);
      expect(CaptureMatchdayDay.safeParse(waiting).success).toBe(true);
      await sql`update stages set status = 'complete' where id = ${leagueId}`;
      const ready = await getMatchDayForCode(code, NOW);
      expect(ready.approvals.map((a) => [a.kind, a.waiting])).toEqual([["draw", null]]);
      expect(CaptureMatchdayDay.safeParse(ready).success).toBe(true);
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
