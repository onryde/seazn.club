// A full Auto-schedule never proposes a time before the later of the division's
// start time and now, while the division's schedule has not ended. 2026-11-25,
// stg: matches were laid down at 00:00 that morning (almost a day in the past),
// and again at 05:30 against a saved 10:00 start, because the solver's window is
// the whole DAYS the schedule covers.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const { sql } = await import("@/lib/db");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { applySchedule, autoSchedule, putScheduleSettings } = await import("../schedule");
const { ScheduleMetrics, ScheduleSolverInfo } = await import("@/server/api-v1/schemas");
const { seedCourts } = await import("./_seed");
type AuthCtx = import("@/server/api-v1/auth").AuthCtx;

const HAS_DB = !!process.env.DATABASE_URL;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MATCH_MINUTES = 30;
const midnight = (offsetDays: number) => Math.floor(Date.now() / DAY) * DAY + offsetDays * DAY;
const iso = (t: number) => new Date(t).toISOString();

interface Shape {
  /** Swiss is the reported board (end barrier); a league keeps the weaker start-floor round order. */
  kind?: "swiss" | "league";
  entrants?: number;
  courts?: number;
}

/** The reported board: 8 entrants, 3 Swiss rounds of 4, two courts, nothing paired yet. */
async function seedSwiss(window: { startAt: number; endAt: number; sessions: [number, number][] }, shape: Shape = {}) {
  const kind = shape.kind ?? "swiss";
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Floor " + suffix}, ${"floor-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score',
      ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })}, true)
    on conflict do nothing`;
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Floor " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Singles",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: shape.entrants ?? 8 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(
    auth,
    division.id,
    kind === "swiss"
      ? { seq: 1, kind, name: "Swiss", config: { rounds: 3 } }
      : { seq: 1, kind, name: "League", config: {} },
  );
  const courts = await seedCourts(orgId, shape.courts ?? 2);
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: iso(window.startAt),
      endAt: iso(window.endAt),
      matchMinutes: MATCH_MINUTES,
      gapMinutes: 0,
      courts,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: window.sessions.map(([from, to]) => ({ from: iso(from), to: iso(to) })),
    },
    tz: "UTC",
  });
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  return { auth, stageId: stage.id, fixtures, courts };
}

async function starts(seed: Awaited<ReturnType<typeof seedSwiss>>) {
  const out = await autoSchedule(seed.auth, seed.stageId, { only_unlocked: false, mode: "build" });
  const round = new Map(seed.fixtures.map((f) => [f.id, f.round_no]));
  return {
    out,
    rows: out.assignments.map((a) => ({ round: round.get(a.fixture_id)!, start: Date.parse(a.scheduled_at) })),
  };
}

type Seed = Awaited<ReturnType<typeof seedSwiss>>;

async function place(fixtureId: string, at: number, courtId: string, locked = false) {
  await sql`
    update fixtures set scheduled_at = ${iso(at)}, court_id = ${courtId}, schedule_locked = ${locked}
    where id = ${fixtureId}`;
}

const inRound = (seed: Seed, round: number) => seed.fixtures.filter((f) => f.round_no === round);

/** Lays `fixtures` down one per hour from 10:00 on `day`, alternating courts, and returns where each went. */
async function layDown(seed: Seed, fixtures: Seed["fixtures"], day: number, locked = false) {
  const at = new Map<string, { at: number; court: string }>();
  for (const [i, f] of fixtures.entries()) {
    const slot = { at: midnight(day) + (10 + i) * HOUR, court: seed.courts[i % seed.courts.length]! };
    await place(f.id, slot.at, slot.court, locked);
    at.set(f.id, slot);
  }
  return at;
}

/** Every card in `expected` comes back exactly where it was; reports how many it checked. */
function expectUnmoved(
  out: Awaited<ReturnType<typeof autoSchedule>>,
  expected: Map<string, { at: number; court: string }>,
) {
  let checked = 0;
  for (const [id, was] of expected) {
    const now = out.assignments.filter((a) => a.fixture_id === id);
    expect(now).toHaveLength(1);
    expect([Date.parse(now[0]!.scheduled_at), now[0]!.court_id]).toEqual([was.at, was.court]);
    checked++;
  }
  expect(checked).toBe(expected.size);
  expect(checked).toBeGreaterThan(0);
}

const run = (seed: Seed, mode: "build" | "polish") =>
  autoSchedule(seed.auth, seed.stageId, { only_unlocked: mode === "polish", mode });

const apply = (seed: Seed, out: Awaited<ReturnType<typeof autoSchedule>>) =>
  applySchedule(seed.auth, seed.stageId, {
    assignments: out.assignments.map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_id: a.court_id,
    })),
    source: "auto",
  });

const windowWarnings = (out: Awaited<ReturnType<typeof autoSchedule>>) =>
  out.conflicts.filter((c) => c.code === "warn.window");

function expectRoundsInOrder(rows: { round: number; start: number }[]) {
  for (const r of [2, 3]) {
    const earlierEnds = Math.max(...rows.filter((x) => x.round === r - 1).map((x) => x.start)) + MATCH_MINUTES * 60_000;
    expect(Math.min(...rows.filter((x) => x.round === r).map((x) => x.start))).toBeGreaterThanOrEqual(earlierEnds);
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 5 });
});

describe.skipIf(!HAS_DB)("autoSchedule start floor", () => {
  it("places the whole Swiss board no earlier than now when the start has already passed", async () => {
    const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
    const before = Date.now();
    const { out, rows } = await starts(seed);
    expect(rows).toHaveLength(12);
    expect(Math.min(...rows.map((r) => r.start))).toBeGreaterThanOrEqual(before);
    expectRoundsInOrder(rows);
    expect(out.conflicts.filter((c) => c.code === "warn.window")).toEqual([]);
  }, 120_000);

  it("honours the start TIME, even when play hours open earlier that day", async () => {
    const sessions: [number, number][] = [3, 4].map((d) => [midnight(d) + 5 * HOUR, midnight(d) + 20 * HOUR]);
    const startAt = midnight(3) + 10 * HOUR;
    const seed = await seedSwiss({ startAt, endAt: midnight(4) + 23 * HOUR, sessions });
    const { rows } = await starts(seed);
    expect(rows).toHaveLength(12);
    expect(Math.min(...rows.map((r) => r.start))).toBeGreaterThanOrEqual(startAt);
    expectRoundsInOrder(rows);
  }, 120_000);

  it("still places on past days once the schedule has ended, so old results can be entered", async () => {
    const startAt = midnight(-10) + 10 * HOUR;
    const endAt = midnight(-9) + 23 * HOUR;
    const seed = await seedSwiss({ startAt, endAt, sessions: [] });
    const { rows } = await starts(seed);
    expect(rows).toHaveLength(12);
    expect(Math.max(...rows.map((r) => r.start))).toBeLessThan(midnight(-8));
  }, 120_000);

  it("does not call a card pinned earlier today (or yesterday) outside dates", async () => {
    const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
    const pinned = seed.fixtures.find((f) => f.round_no === 1)!;
    const pinnedAt = midnight(-1) + 10 * HOUR;
    await sql`
      update fixtures set scheduled_at = ${iso(pinnedAt)}, court_id = ${seed.courts[0]!}, schedule_locked = true
      where id = ${pinned.id}`;
    const { out } = await starts(seed);
    const kept = out.assignments.find((a) => a.fixture_id === pinned.id);
    expect(Date.parse(kept!.scheduled_at)).toBe(pinnedAt);
    expect(out.conflicts.filter((c) => c.code === "warn.window")).toEqual([]);
  }, 120_000);

  it("Improve times keeps cards already in the past and moves nothing else before now", async () => {
    const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(4) + 23 * HOUR, sessions: [] });
    // Round 1 was due yesterday morning; rounds 2 and 3 sit loosely two and three days out, so there
    // is plenty for the pass to pull earlier - and yesterday is the earliest room in the window.
    const placed = new Map<string, number>();
    const seen = new Map<number, number>();
    for (const f of seed.fixtures) {
      const n = seen.get(f.round_no) ?? 0;
      seen.set(f.round_no, n + 1);
      const day = f.round_no === 1 ? -1 : f.round_no;
      const at = midnight(day) + (10 + n) * HOUR;
      placed.set(f.id, at);
      await sql`
        update fixtures set scheduled_at = ${iso(at)}, court_id = ${seed.courts[n % 2]!} where id = ${f.id}`;
    }
    const before = Date.now();
    const out = await autoSchedule(seed.auth, seed.stageId, { only_unlocked: true, mode: "polish" });
    expect(out.assignments).toHaveLength(12);
    let past = 0;
    let ahead = 0;
    for (const a of out.assignments) {
      const was = placed.get(a.fixture_id)!;
      const now = Date.parse(a.scheduled_at);
      if (was < before) {
        expect(now).toBe(was);
        past++;
      } else {
        expect(now).toBeGreaterThanOrEqual(before);
        ahead++;
      }
    }
    expect([past, ahead]).toEqual([4, 8]);
    expect(out.solver.locked_kept).toBe(0);
    expect(out.conflicts.filter((c) => c.code === "warn.window")).toEqual([]);
  }, 120_000);

  describe("a card that must stay and starts before the floor is held", () => {
    for (const mode of ["build", "polish"] as const) {
      it(`${mode}: keeps a card pinned an hour before the start time, and places all the rest after it`, async () => {
        const startAt = midnight(3) + 9 * HOUR;
        const seed = await seedSwiss({ startAt, endAt: midnight(4) + 23 * HOUR, sessions: [] });
        const pinned = inRound(seed, 1)[0]!;
        await place(pinned.id, midnight(3) + 8 * HOUR, seed.courts[0]!, true);
        const out = await run(seed, mode);
        expect(out.assignments).toHaveLength(12);
        expect(out.metrics).toMatchObject({ placed: 12, total: 12 });
        expectUnmoved(out, new Map([[pinned.id, { at: midnight(3) + 8 * HOUR, court: seed.courts[0]! }]]));
        const others = out.assignments.filter((a) => a.fixture_id !== pinned.id);
        expect(others).toHaveLength(11);
        expect(Math.min(...others.map((a) => Date.parse(a.scheduled_at)))).toBeGreaterThanOrEqual(startAt);
        expect(windowWarnings(out)).toEqual([]);
        expect(out.solver.locked_kept).toBe(1);
        await apply(seed, out);
      }, 120_000);
    }

    it("polish: with every card in the past, hands the board back unchanged without asking the solver", async () => {
      const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
      const was = new Map([
        ...(await layDown(seed, inRound(seed, 1), -1)),
        ...new Map(
          (await Promise.all(
            [...inRound(seed, 2), ...inRound(seed, 3)].map(async (f, i) => {
              const slot = { at: midnight(-1) + (15 + i) * HOUR, court: seed.courts[i % 2]! };
              await place(f.id, slot.at, slot.court);
              return [f.id, slot] as const;
            }),
          )),
        ),
      ]);
      expect(Math.max(...[...was.values()].map((v) => v.at))).toBeLessThan(Date.now());
      const out = await run(seed, "polish");
      expect(out.assignments).toHaveLength(12);
      expectUnmoved(out, was);
      expect(out.metrics).toMatchObject({ placed: 12, total: 12 });
      ScheduleSolverInfo.parse(out.solver);
      ScheduleMetrics.parse(out.metrics);
      expect(out.solver).toMatchObject({
        engine: "greedy",
        status: "ok",
        mode: "polish",
        moved: 0,
        lost: 0,
        locked_kept: 0,
        tiers_completed: 0,
        elapsed_ms: 0,
        budget_expired: false,
      });
      expect(out.conflicts).toEqual([]);
    }, 120_000);

    it("polish: holds a card that sits between now and the rounded-up floor", async () => {
      const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(4) + 23 * HOUR, sessions: [] });
      const step = 5 * 60_000;
      const at = Math.ceil(Date.now() / step) * step - 1_000;
      const card = inRound(seed, 1)[0]!;
      await place(card.id, at, seed.courts[0]!);
      const out = await run(seed, "polish");
      expectUnmoved(out, new Map([[card.id, { at, court: seed.courts[0]! }]]));
      expect(out.assignments).toHaveLength(12);
    }, 120_000);

    it("ignore_locks: polish still holds a past pin, build is free to move it", async () => {
      const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
      const card = inRound(seed, 1)[0]!;
      const at = midnight(-1) + 10 * HOUR;
      await place(card.id, at, seed.courts[0]!, true);
      const body = { only_unlocked: true, ignore_locks: true } as const;
      const polished = await autoSchedule(seed.auth, seed.stageId, { ...body, mode: "polish" });
      expectUnmoved(polished, new Map([[card.id, { at, court: seed.courts[0]! }]]));
      const before = Date.now();
      const built = await autoSchedule(seed.auth, seed.stageId, { ...body, only_unlocked: false, mode: "build" });
      const moved = built.assignments.find((a) => a.fixture_id === card.id)!;
      expect(Date.parse(moved.scheduled_at)).toBeGreaterThanOrEqual(before);
    }, 120_000);

    for (const mode of ["build", "polish"] as const) {
      it(`${mode}: past cards do not count against the room left (no CAPACITY_IMPOSSIBLE)`, async () => {
        // Play hours: yesterday (all past) and one hour tomorrow on two courts, so 4 slots remain.
        const sessions: [number, number][] = [
          [midnight(-1) + 8 * HOUR, midnight(-1) + 23 * HOUR],
          [midnight(1) + 10 * HOUR, midnight(1) + 11 * HOUR],
        ];
        const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(1) + 23 * HOUR, sessions });
        const past = [...inRound(seed, 1), ...inRound(seed, 2), ...inRound(seed, 3).slice(0, 2)];
        const was = new Map<string, { at: number; court: string }>();
        for (const [i, f] of past.entries()) {
          const slot = { at: midnight(-1) + (8 + i) * HOUR, court: seed.courts[i % 2]! };
          // BUILD moves an unpinned past card, so only pins are held there.
          await place(f.id, slot.at, slot.court, mode === "build");
          was.set(f.id, slot);
        }
        expect(was.size).toBe(10);
        const out = await run(seed, mode);
        expectUnmoved(out, was);
        expect(out.assignments).toHaveLength(12);
        expect(out.metrics).toMatchObject({ placed: 12, total: 12 });
      }, 120_000);
    }

    for (const kind of ["swiss", "league"] as const) {
      for (const mode of ["build", "polish"] as const) {
        it(`${kind} ${mode}: never places an earlier round after a held later one, and the proposal applies`, async () => {
          const seed = await seedSwiss(
            { startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] },
            { kind, entrants: kind === "swiss" ? 8 : 4 },
          );
          const held = await layDown(seed, inRound(seed, 2), -1, mode === "build");
          const first = inRound(seed, 1).map((f) => f.id);
          expect(held.size).toBeGreaterThan(0);
          expect(first.length).toBeGreaterThan(0);
          const out = await run(seed, mode);
          expectUnmoved(out, held);
          expect(out.assignments.filter((a) => first.includes(a.fixture_id))).toEqual([]);
          let explained = 0;
          for (const id of first) {
            const why = out.conflicts.filter((c) => c.fixture_id === id);
            expect(why.map((c) => c.details?.kind)).toEqual(["no_slot_round_barrier"]);
            expect(why[0]!.details).toMatchObject({ round_no: 1, other_round_no: 2 });
            expect(held.has(why[0]!.details!.other_fixture_id!)).toBe(true);
            explained++;
          }
          expect(explained).toBe(first.length);
          // Round 3 is still free to go ahead of the floor.
          expect(out.assignments).toHaveLength(seed.fixtures.length - first.length);
          expect(out.metrics).toMatchObject({
            placed: seed.fixtures.length - first.length,
            total: seed.fixtures.length,
          });
          await apply(seed, out);
        }, 120_000);
      }
    }

    for (const kind of ["swiss", "league"] as const) {
      it(`${kind} polish: a placed card it cannot keep behind a held later round is counted lost, not moved`, async () => {
        const seed = await seedSwiss(
          { startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] },
          { kind, entrants: kind === "swiss" ? 8 : 4 },
        );
        const held = await layDown(seed, inRound(seed, 2), -1);
        // Round 1 sits on the board for tomorrow, after the round that should follow it.
        const first = await layDown(seed, inRound(seed, 1), 1);
        expect(first.size).toBeGreaterThan(0);
        const out = await run(seed, "polish");
        expectUnmoved(out, held);
        expect(out.assignments.filter((a) => first.has(a.fixture_id))).toEqual([]);
        // `moved` is the engine's count: any proposed card that is not where it was, one that had no time
        // included. That is round 3 here. The round 1 cards are on no proposal, so they are not moves.
        expect(out.solver).toMatchObject({ lost: first.size, moved: inRound(seed, 3).length });
        expect(out.metrics.placed).toBe(out.assignments.length);
        ScheduleSolverInfo.parse(out.solver);
      }, 120_000);
    }

    // The organiser's pin is not the auto pass's to drop, even where it already breaks round order against
    // a held card. The unpinned round 1 cards, which the pass would have to place, are still refused. No
    // apply here: pins that contradict the round order give a proposal apply refuses, held or not (seen
    // 2026-11-26 with both pins ahead of the floor).
    for (const kind of ["swiss", "league"] as const) {
      for (const mode of ["build", "polish"] as const) {
        it(`${kind} ${mode}: keeps a pin ahead of the floor that is already behind a held later round`, async () => {
          const seed = await seedSwiss(
            { startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] },
            { kind, entrants: kind === "swiss" ? 8 : 4 },
          );
          const held = await layDown(seed, inRound(seed, 2), -1, mode === "build");
          const pinned = inRound(seed, 1)[0]!;
          const slot = { at: midnight(1) + 12 * HOUR, court: seed.courts[0]! };
          await place(pinned.id, slot.at, slot.court, true);
          const out = await run(seed, mode);
          expectUnmoved(out, new Map([...held, [pinned.id, slot]]));
          expect(out.conflicts.filter((c) => c.fixture_id === pinned.id)).toEqual([]);
          expect(out.assignments).toHaveLength(seed.fixtures.length - (inRound(seed, 1).length - 1));
          expect(out.metrics.placed).toBe(out.assignments.length);
          expect(out.solver.locked_kept).toBe(mode === "build" ? held.size + 1 : 1);
        }, 120_000);
      }
    }

    // Swiss only: on a LEAGUE the engine's greedy board (solver unreachable) places an earlier round
    // after a later-round pin and then drops the pin, with or without a held card (seen 2026-11-26).
    it("swiss: a pin at or after the floor does not make a held board contradictory", async () => {
      const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
      const held = await layDown(seed, inRound(seed, 1), -1, true);
      const ahead = inRound(seed, 3)[0]!;
      const at = midnight(2) + 12 * HOUR;
      await place(ahead.id, at, seed.courts[0]!, true);
      const out = await run(seed, "build");
      expectUnmoved(out, new Map([...held, [ahead.id, { at, court: seed.courts[0]! }]]));
      expect(out.assignments).toHaveLength(seed.fixtures.length);
      expect(out.solver.contradictory_pins).toBeUndefined();
      expect(out.solver.locked_kept).toBe(held.size + 1);
      await apply(seed, out);
    }, 120_000);

    for (const mode of ["build", "polish"] as const) {
      it(`${mode}: two past cards double-booked on one court both come back unchanged`, async () => {
        const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
        const [a, b] = inRound(seed, 1);
        const slot = { at: midnight(-1) + 10 * HOUR, court: seed.courts[0]! };
        await place(a!.id, slot.at, slot.court, true);
        await place(b!.id, slot.at, slot.court, true);
        const out = await run(seed, mode);
        expectUnmoved(out, new Map([[a!.id, slot], [b!.id, slot]]));
        expect(out.assignments).toHaveLength(12);
        expect(out.solver.contradictory_pins).toBeUndefined();
        expect(out.solver.status).not.toBe("infeasible");
        expect(out.solver.locked_kept).toBe(2);
      }, 120_000);

      it(`${mode}: two matches in progress on one court do not make the rest of the board infeasible`, async () => {
        const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
        const [a, b] = inRound(seed, 1);
        // Both started ten minutes ago, so both still hold the court past the start floor.
        const slot = { at: Date.now() - 10 * 60_000, court: seed.courts[0]! };
        await place(a!.id, slot.at, slot.court, true);
        await place(b!.id, slot.at, slot.court, true);
        const out = await run(seed, mode);
        expectUnmoved(out, new Map([[a!.id, slot], [b!.id, slot]]));
        expect(out.assignments).toHaveLength(12);
        expect(out.solver.contradictory_pins).toBeUndefined();
        expect(out.solver.status).not.toBe("infeasible");
        // The court they hold is still held: nothing new lands on it before they finish.
        const others = out.assignments.filter((x) => x.fixture_id !== a!.id && x.fixture_id !== b!.id);
        expect(others).toHaveLength(10);
        for (const x of others.filter((o) => o.court_id === slot.court)) {
          expect(Date.parse(x.scheduled_at)).toBeGreaterThanOrEqual(slot.at + 30 * 60_000);
        }
      }, 120_000);
    }

    it("build: places a window that starts at 23:00 and has all of the next day (1 court)", async () => {
      const seed = await seedSwiss(
        { startAt: midnight(3) + 23 * HOUR, endAt: midnight(4) + 23 * HOUR, sessions: [] },
        { courts: 1 },
      );
      const out = await run(seed, "build");
      expect(out.assignments).toHaveLength(12);
    }, 120_000);

    it("build: cards held on the first day do not eat the other days' share of the daily cap", async () => {
      // 6 cards pinned on the day the schedule starts, before a 23:00 start: 2 free slots that day, 6 cards
      // left. A cap that does not count the 6 is 4 (2 that day + 4 the next), too low for the next day alone.
      const seed = await seedSwiss(
        { startAt: midnight(3) + 23 * HOUR, endAt: midnight(4) + 23 * HOUR, sessions: [] },
        { courts: 1 },
      );
      const held = await layDown(seed, [...inRound(seed, 1), ...inRound(seed, 2).slice(0, 2)], 3, true);
      expect(held.size).toBe(6);
      const out = await run(seed, "build");
      expectUnmoved(out, held);
      expect(out.assignments).toHaveLength(12);
      await apply(seed, out);
    }, 120_000);
  });
});
