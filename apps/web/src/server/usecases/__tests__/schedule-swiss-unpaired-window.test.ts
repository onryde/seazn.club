// A Swiss division whose rounds are not paired yet must auto-schedule EVERY round, in order, inside its window - however
// many days the window spans.
//
// The report (stg, 2026-11-25): 8 entrants, 3 rounds, 2 courts, window moved to ONE day. The auto pass placed round 2,
// left rounds 1 and 3 unplaced ("feeds a later one"), and the board it applied sat outside the new dates. Cause: the
// default `max_fixtures_per_day` the auto pass injects (`withDefaultDaySpread`) counted the half-open window's EXCLUSIVE
// end day as a day, so N real days were capped for N+1 and the cap x days product fell short of the board (12 fixtures,
// one day: 6 a day). Over capacity the placer drops whatever it likes; with all three rounds unpaired every board is the
// same TBD-v-TBD shell, so it dropped round 1 and kept later rounds, which is the report.
//
// THE SEQUENCE this file drives, through the real usecases against a real database (the placement service is a closed
// port, so every pass is the greedy placer; the cap is applied before either solver, and greedy reports it as `no_slot`):
//   mint (no round paired) -> auto -> apply -> auto again -> Pair round 1 -> auto again,
// over one-, two- and three-day windows, and the same one-day window on a LEAGUE (another format: it must place its
// whole board too, and a wide window must still spread).
//
// single-sport: badminton - the rules read stage kind, round_no, the slot columns and the division's settings, never a
// sport field.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { applySchedule, autoSchedule, putScheduleSettings, type AutoScheduleOut } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { createCourt, createVenue } from "../venues";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A host nothing listens on: the real placement client dials it, fails `unavailable`, and the engine ships greedy. */
const CLOSED_PORT_HOST = "127.0.0.1:1";
const MINUTES = 30;
const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
/** Day 1 of every window, 10:00 UTC (the org zone is UTC, asserted by the rig). */
const DAY1 = Date.UTC(2030, 7, 1);

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  courts: string[];
  /** The window's first and last calendar day, as the settings carry them. */
  windowDays: number;
}

/** A division of `players` individuals on two courts; the window is `days` whole days, 10:00 on day 1 to 20:00 on the last. */
async function division(players: number, days: number): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    starts_on: "2030-08-01",
    ends_on: new Date(DAY1 + (days - 1) * DAY_MS).toISOString().slice(0, 10),
    name: "Unpaired window " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const div = await createDivision(auth, comp.id, {
    name: "Singles",
    slug: "singles-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  await createEntrants(
    auth,
    div.id,
    Array.from({ length: players }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const venue = await createVenue(auth, { name: "Hall", sort: 0 });
  const courts: string[] = [];
  for (let i = 0; i < 2; i++) courts.push((await createCourt(auth, venue.id, { name: `Court ${i + 1}`, sort: i, tags: [] })).id);
  await putScheduleSettings(auth, div.id, {
    // NO explicit division-wide cap: the default day spread is the thing under test.
    config: {
      startAt: new Date(DAY1 + 10 * 60 * MIN).toISOString(),
      endAt: new Date(DAY1 + (days - 1) * DAY_MS + 20 * 60 * MIN).toISOString(),
      matchMinutes: MINUTES,
      gapMinutes: 0,
      courts,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const [org] = await sql<{ timezone: string | null }[]>`select timezone from organizations where id = ${auth.orgId}`;
  expect(org?.timezone ?? "UTC", "rig: the org zone is UTC").toBe("UTC");
  return { auth, divisionId: div.id, courts, windowDays: days };
}

async function stageOf(rig: Rig, kind: "swiss" | "league", config: Record<string, unknown>): Promise<string> {
  const [stage] = await createStages(rig.auth, rig.divisionId, [{ seq: 1, kind, name: kind, config, progression: null }]);
  return stage!.id;
}

const roundOf = async (stageId: string) =>
  new Map(
    (await sql<{ id: string; round_no: number }[]>`select id, round_no from fixtures where stage_id = ${stageId}`).map((r) => [r.id, r.round_no]),
  );

const run = (rig: Rig, stageId: string) => autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });

async function applyAuto(rig: Rig, stageId: string, out: AutoScheduleOut): Promise<void> {
  await applySchedule(rig.auth, stageId, {
    assignments: out.assignments.map((a) => ({ fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_id: a.court_id })),
    source: "auto",
  });
}

/** Every fixture placed, no conflict, every start inside the window and no earlier than its opening time, and (for a
 *  round sequence) round r+1 starting no earlier than round r's last board ends. Returns how many it judged. */
async function expectWholeBoard(rig: Rig, stageId: string, out: AutoScheduleOut, label: string, rounds: boolean): Promise<number> {
  const total = (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId}`)[0]!.n;
  expect(total, `${label}: rig has a board`).toBeGreaterThan(0);
  expect(out.conflicts, `${label}: no conflict`).toEqual([]);
  expect(out.assignments.length, `${label}: every fixture placed`).toBe(total);
  const open = DAY1 + 10 * 60 * MIN;
  const close = DAY1 + rig.windowDays * DAY_MS;
  for (const a of out.assignments) {
    const at = Date.parse(a.scheduled_at);
    expect(at, `${label}: ${a.fixture_id} starts at or after the window opens`).toBeGreaterThanOrEqual(open);
    expect(at + MINUTES * MIN, `${label}: ${a.fixture_id} ends inside the window`).toBeLessThanOrEqual(close);
  }
  if (rounds) {
    const roundNo = await roundOf(stageId);
    const byRound = new Map<number, { first: number; last: number }>();
    for (const a of out.assignments) {
      const r = roundNo.get(a.fixture_id)!;
      const at = Date.parse(a.scheduled_at);
      const cur = byRound.get(r) ?? { first: Infinity, last: -Infinity };
      byRound.set(r, { first: Math.min(cur.first, at), last: Math.max(cur.last, at + MINUTES * MIN) });
    }
    const order = [...byRound.keys()].sort((x, y) => x - y);
    expect(order.length, `${label}: more than one round to order`).toBeGreaterThan(1);
    for (let i = 1; i < order.length; i++) {
      expect(byRound.get(order[i]!)!.first, `${label}: round ${order[i]} starts after round ${order[i - 1]} ends`).toBeGreaterThanOrEqual(
        byRound.get(order[i - 1]!)!.last,
      );
    }
  }
  return out.assignments.length;
}

describe.runIf(HAS_DB)("an unpaired Swiss division auto-schedules every round, in order, inside its window", () => {
  for (const days of [1, 2, 3]) {
    it(`${days}-day window: mint, auto, apply, auto again, Pair round 1, auto again`, async () => {
      vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
      const rig = await division(8, days);
      const stageId = await stageOf(rig, "swiss", { rounds: 3 });
      await generateStageFixtures(rig.auth, stageId); // mint: three rounds of TBD v TBD, none paired

      const unpaired = await sql<{ n: number }[]>`
        select count(*)::int as n from fixtures where stage_id = ${stageId} and home_entrant_id is null and away_entrant_id is null`;
      expect(unpaired[0]!.n, "rig: no round is paired yet (12 shells: 3 rounds x 4 boards)").toBe(12);

      let judged = 0;
      const first = await run(rig, stageId);
      judged += await expectWholeBoard(rig, stageId, first, "first auto", true);
      await applyAuto(rig, stageId, first);

      // A second run over the board it just wrote: the same whole board, not a smaller one.
      const second = await run(rig, stageId);
      judged += await expectWholeBoard(rig, stageId, second, "second auto", true);

      // Pair round 1: its boards are seated; rounds 2 and 3 stay shells. A third run must still place all three.
      await generateStageFixtures(rig.auth, stageId);
      const seated = await sql<{ n: number }[]>`
        select count(*)::int as n from fixtures where stage_id = ${stageId} and round_no = 1
          and home_entrant_id is not null and away_entrant_id is not null`;
      expect(seated[0]!.n, "rig: round 1 is paired").toBe(4);
      const third = await run(rig, stageId);
      judged += await expectWholeBoard(rig, stageId, third, "auto after Pair round 1", true);

      expect(judged, "anti-vacuity: three passes judged 12 fixtures each").toBe(36);
    }, 120_000);
  }

  it("a league on the same one-day window places its whole board too, and a wide window still spreads it over the days", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    // 6 players = 15 fixtures in one league stage.
    const oneDay = await division(6, 1);
    const leagueOne = await stageOf(oneDay, "league", {});
    await generateStageFixtures(oneDay.auth, leagueOne);
    const outOne = await run(oneDay, leagueOne);
    expect(await expectWholeBoard(oneDay, leagueOne, outOne, "league, one day", false)).toBe(15);

    // Three days: every fixture placed, and the default cap still spreads (nothing piled on a single day).
    const threeDays = await division(6, 3);
    const leagueThree = await stageOf(threeDays, "league", {});
    await generateStageFixtures(threeDays.auth, leagueThree);
    const outThree = await run(threeDays, leagueThree);
    expect(await expectWholeBoard(threeDays, leagueThree, outThree, "league, three days", false)).toBe(15);
    const perDay = new Map<string, number>();
    for (const a of outThree.assignments) perDay.set(a.scheduled_at.slice(0, 10), (perDay.get(a.scheduled_at.slice(0, 10)) ?? 0) + 1);
    expect(perDay.size, "the board is spread over every day of the window").toBe(3);
    expect(Math.max(...perDay.values()), "no day holds more than ceil(15 / 3)").toBeLessThanOrEqual(5);
  }, 120_000);
});
