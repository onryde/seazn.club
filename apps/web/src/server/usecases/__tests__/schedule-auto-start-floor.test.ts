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
const { putCourtCalendar } = await import("../venues");
const { boardMetrics } = await import("@seazn/engine/scheduling");
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
async function seedSwiss(
  window: { startAt: number; endAt: number; sessions: [number, number][]; blackouts?: [number, number][] },
  shape: Shape = {},
) {
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
      blackouts: (window.blackouts ?? []).map(([from, to]) => ({ from: iso(from), to: iso(to) })),
      sessionWindows: window.sessions.map(([from, to]) => ({ from: iso(from), to: iso(to) })),
    },
    tz: "UTC",
  });
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  return { auth, stageId: stage.id, fixtures, courts, competitionId: competition.id, divisionId: division.id };
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

/** The board as the database holds it: id -> [start, court], `null`s for a card with no time. */
async function stored(seed: Seed) {
  const rows = await sql<{ id: string; scheduled_at: Date | null; court_id: string | null }[]>`
    select id, scheduled_at, court_id from fixtures where stage_id = ${seed.stageId}`;
  return new Map(rows.map((r) => [r.id, [r.scheduled_at?.getTime() ?? null, r.court_id] as const]));
}

/**
 * Applies the proposal through the real write gate and checks the counts against what the database then
 * holds: a card on no proposal is exactly where it was (apply writes only what it is handed), `moved` is
 * the proposal's rows that are not where they were, and nothing that had a time is without one.
 */
async function applyAndAudit(seed: Seed, out: Awaited<ReturnType<typeof autoSchedule>>) {
  const before = await stored(seed);
  await apply(seed, out);
  const after = await stored(seed);
  const listed = new Map(out.assignments.map((a) => [a.fixture_id, a]));
  let changed = 0;
  let lost = 0;
  let audited = 0;
  for (const [id, was] of before) {
    const now = after.get(id)!;
    const proposed = listed.get(id);
    if (proposed === undefined) expect(now).toEqual(was);
    else expect(now).toEqual([Date.parse(proposed.scheduled_at), proposed.court_id]);
    if (now[0] !== was[0] || now[1] !== was[1]) changed++;
    if (was[0] !== null && now[0] === null) lost++;
    audited++;
  }
  expect(audited).toBe(seed.fixtures.length);
  expect(out.solver.lost).toBe(lost);
  if (out.solver.mode === "polish") expect(out.solver.moved).toBe(changed);
  return { before, after };
}

/** `metrics` describe the rows on the proposal, all of them: the engine's own measure over that set. */
async function expectMetricsOfProposal(seed: Seed, out: Awaited<ReturnType<typeof autoSchedule>>) {
  const sides = await sql<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where division_id = ${seed.divisionId}`;
  const entrantsOf = new Map(
    sides.map((f) => [f.id, [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null)]),
  );
  const rows = out.assignments.map((a) => ({
    fixtureId: a.fixture_id,
    court: a.court_id,
    startAt: Date.parse(a.scheduled_at),
    endAt: Date.parse(a.ends_at),
    entrants: entrantsOf.get(a.fixture_id)!,
    people: [],
  }));
  expect(rows.length).toBeGreaterThan(0);
  const m = boardMetrics(rows, seed.courts, seed.fixtures.length);
  expect(out.metrics).toEqual({
    makespan_minutes: m.makespanMinutes,
    worst_idle_gap_minutes: m.worstIdleGapMinutes,
    court_imbalance_minutes: m.courtImbalanceMinutes,
    placed: rows.length,
    total: seed.fixtures.length,
  });
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

    // Round 2 has been played (held), round 1 was postponed to tomorrow, round 3 sits later. The pass
    // cannot put round 1 behind round 2, so it keeps its time, and what it does with round 3 has to fit
    // AROUND that time: apply writes only what the proposal lists.
    for (const kind of ["swiss", "league"] as const) {
      for (const mode of ["build", "polish"] as const) {
        it(`${kind} ${mode}: a postponed round 1 keeps its time, the proposal applies around it, nothing is counted lost`, async () => {
          const seed = await seedSwiss(
            { startAt: midnight(-1), endAt: midnight(4) + 23 * HOUR, sessions: [] },
            { kind, entrants: kind === "swiss" ? 8 : 4 },
          );
          const held = await layDown(seed, inRound(seed, 2), -1, mode === "build");
          const first = await layDown(seed, inRound(seed, 1), 1);
          await layDown(seed, inRound(seed, 3), 3);
          expect(first.size).toBeGreaterThan(0);
          const out = await run(seed, mode);
          expectUnmoved(out, held);
          const { after } = await applyAndAudit(seed, out);
          let kept = 0;
          for (const [id, was] of first) {
            expect(after.get(id)).toEqual([was.at, was.court]);
            // Improve times leaves it put ON the proposal; a full run cannot place it and says why.
            if (mode === "polish") expectUnmoved(out, new Map([[id, was]]));
            else expect(out.assignments.filter((a) => a.fixture_id === id)).toEqual([]);
            // No time was offered for it: the card says why it was not moved.
            if (mode === "build") expect(out.conflicts.filter((c) => c.fixture_id === id).length).toBeGreaterThan(0);
            kept++;
          }
          expect(kept).toBe(first.size);
          if (mode === "polish") {
            const order = out.conflicts.filter((c) => c.code.toLowerCase().includes("order") && held.has(c.fixture_id));
            expect(order.length).toBeGreaterThan(0);
          }
          expect(out.solver.lost).toBe(0);
          expect(out.solver.status).not.toBe("already_optimal");
          await expectMetricsOfProposal(seed, out);
        }, 120_000);
      }
    }

    // The organiser's pin is not the auto pass's to drop, even where it already breaks round order against
    // a held card. The unpinned round 1 cards, which the pass would have to place, are still refused.
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
          await applyAndAudit(seed, out);
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

    // The normal path reports a pin's own clash (the control). A held board has to say the same.
    it("a double booking is reported on both cards by the normal path, and by a board that is held entirely", async () => {
      const clash = (out: Awaited<ReturnType<typeof autoSchedule>>) =>
        new Set(out.conflicts.filter((c) => c.details?.kind === "court_double_booking").map((c) => c.fixture_id));
      const ahead = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
      const [p, q] = inRound(ahead, 1);
      await place(p!.id, midnight(1) + 10 * HOUR, ahead.courts[0]!, true);
      await place(q!.id, midnight(1) + 10 * HOUR, ahead.courts[0]!, true);
      expect(clash(await run(ahead, "build"))).toEqual(new Set([p!.id, q!.id]));

      let checked = 0;
      for (const others of ["all held", "some free"] as const) {
        const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
        const [a, b] = inRound(seed, 1);
        const slot = { at: midnight(-1) + 8 * HOUR, court: seed.courts[0]! };
        await place(a!.id, slot.at, slot.court, true);
        await place(b!.id, slot.at, slot.court, true);
        const rest = seed.fixtures.filter((f) => f.id !== a!.id && f.id !== b!.id);
        const was = new Map([[a!.id, slot], [b!.id, slot]]);
        if (others === "all held") {
          for (const [i, f] of rest.entries()) {
            const at = { at: midnight(-1) + (9 + i) * HOUR, court: seed.courts[i % 2]! };
            await place(f.id, at.at, at.court, true);
            was.set(f.id, at);
          }
        }
        const out = await run(seed, "build");
        expectUnmoved(out, was);
        expect(out.assignments).toHaveLength(12);
        expect(clash(out), others).toEqual(new Set([a!.id, b!.id]));
        expect(out.solver.contradictory_pins).toBeUndefined();
        await applyAndAudit(seed, out);
        checked++;
      }
      expect(checked).toBe(2);
    }, 120_000);

    for (const mode of ["build", "polish"] as const) {
      it(`${mode}: the metrics are measured over every row on the proposal, held ones included`, async () => {
        const seed = await seedSwiss({ startAt: midnight(-1), endAt: midnight(2) + 23 * HOUR, sessions: [] });
        // Held on one court only, so a measure that skips them reads a different court spread and length.
        for (const [i, f] of inRound(seed, 1).entries()) await place(f.id, midnight(-1) + (8 + i) * HOUR, seed.courts[0]!, true);
        const out = await run(seed, mode);
        expect(out.assignments).toHaveLength(12);
        await expectMetricsOfProposal(seed, out);
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

// The pass's own default per-day cap is a way to spread a board, never a reason to place less of it:
// whatever the room estimate behind it misses, no card is left off that a run without it would place.
describe.skipIf(!HAS_DB)("autoSchedule default day cap never places fewer", () => {
  const TWO_DAYS = { startAt: midnight(3), endAt: midnight(4) + 23 * HOUR, sessions: [] as [number, number][] };
  const dayOf = (t: number) => Math.floor((t - midnight(0)) / DAY);
  const perDay = (out: Awaited<ReturnType<typeof autoSchedule>>) => {
    const n = new Map<number, number>();
    for (const a of out.assignments) {
      const d = dayOf(Date.parse(a.scheduled_at));
      n.set(d, (n.get(d) ?? 0) + 1);
    }
    return Object.fromEntries([...n].sort(([a], [b]) => a - b));
  };
  const decide = async (seed: Seed, fixtures: Seed["fixtures"], day: number) => {
    const was = await layDown(seed, fixtures, day);
    for (const id of was.keys()) await sql`update fixtures set status = 'decided' where id = ${id}`;
    return was;
  };

  it("places all six free cards when six decided cards already sit on one of the two days", async () => {
    const seed = await seedSwiss(TWO_DAYS);
    const done = await decide(seed, [...inRound(seed, 1), ...inRound(seed, 2).slice(0, 2)], 3);
    expect(done.size).toBe(6);
    const out = await run(seed, "build");
    expect(out.assignments).toHaveLength(6);
    await apply(seed, out);
  }, 120_000);

  it("still spreads, counting the decided cards, when the cap that counts them fits", async () => {
    // Four decided on day 3, eight to place over days 3 to 5: four a day on the two empty days. A cap
    // sized without the four is three, which fits only six.
    const seed = await seedSwiss({ ...TWO_DAYS, endAt: midnight(5) + 23 * HOUR });
    await decide(seed, inRound(seed, 1), 3);
    const out = await run(seed, "build");
    expect(out.assignments).toHaveLength(8);
    expect(perDay(out)).toEqual({ 4: 4, 5: 4 });
    await apply(seed, out);
  }, 120_000);

  it("places the whole board when the second day is blacked out", async () => {
    const seed = await seedSwiss({ ...TWO_DAYS, blackouts: [[midnight(4), midnight(5)]] });
    const out = await run(seed, "build");
    expect(out.assignments).toHaveLength(12);
    await apply(seed, out);
  }, 120_000);

  it("places the whole board when every court is closed on the second day", async () => {
    const seed = await seedSwiss(TWO_DAYS);
    let closed = 0;
    for (const court of seed.courts) {
      await putCourtCalendar(seed.auth, court, {
        hours: [],
        exceptions: [{ date: iso(midnight(4)).slice(0, 10), closed: true, open_min: null, close_min: null }],
      });
      closed++;
    }
    expect(closed).toBe(2);
    const out = await run(seed, "build");
    expect(out.assignments).toHaveLength(12);
    await apply(seed, out);
  }, 120_000);

  it("places the whole board when another division fills the second day's play hours", async () => {
    // Ten hours on day 3, one hour on day 4, and that hour is another division's on both courts.
    const sessions: [number, number][] = [
      [midnight(3) + 10 * HOUR, midnight(3) + 20 * HOUR],
      [midnight(4) + 10 * HOUR, midnight(4) + 11 * HOUR],
    ];
    const seed = await seedSwiss({ ...TWO_DAYS, sessions });
    const other = await createDivision(seed.auth, seed.competitionId, {
      name: "Doubles",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await createEntrants(
      seed.auth,
      other.id,
      Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `D${i + 1}`, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(seed.auth, other.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(seed.auth, stage!.id);
    let booked = 0;
    for (const [i, f] of fixtures.slice(0, 4).entries()) {
      await place(f.id, midnight(4) + 10 * HOUR + Math.floor(i / 2) * 30 * 60_000, seed.courts[i % 2]!);
      booked++;
    }
    expect(booked).toBe(4);
    const out = await run(seed, "build");
    expect(out.assignments).toHaveLength(12);
    await apply(seed, out);
  }, 120_000);

  it("keeps a cap the organiser set, even where it leaves cards unplaced", async () => {
    const seed = await seedSwiss(TWO_DAYS);
    await decide(seed, [...inRound(seed, 1), ...inRound(seed, 2).slice(0, 2)], 3);
    const [row] = await sql<{ config: Record<string, unknown> }[]>`
      select config from schedule_settings where division_id = ${seed.divisionId}`;
    await sql`
      update schedule_settings set config = ${sql.json({
        ...row!.config,
        constraints: {
          ...((row!.config.constraints as object | undefined) ?? {}),
          hard: [{ type: "max_fixtures_per_day", count: 3, scope: { kind: "division", divisionId: seed.divisionId } }],
        },
      } as never)}
      where division_id = ${seed.divisionId}`;
    const out = await run(seed, "build");
    expect(out.assignments).toHaveLength(3);
    expect(perDay(out)).toEqual({ 4: 3 });
  }, 120_000);
});
