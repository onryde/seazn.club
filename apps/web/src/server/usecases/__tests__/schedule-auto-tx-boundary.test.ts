// The auto pass must not hold a database transaction across the solve —
// z3's, for BUILD/POLISH historically, or the placement service's gRPC round
// trip, which is what BUILD/POLISH and (since C4, 2026-08-14, z3 retirement
// stage A) REFLOW all use now.
//
// THE HAZARD. `withTenant` pins a pooled connection for the whole of its
// callback. Before the solver wave the in-transaction work was a synchronous
// `slotFixtures` pass — microseconds. It is now up to `AUTO_SOLVER_WALL_MS` of
// solving (a network round trip to the placement service, or — historically,
// pre-C4, for REFLOW — a solver teardown that had to queue behind any
// concurrent solve's process-wide lock). A solve inside the transaction is
// therefore tens of seconds of idle-in-transaction per organiser click, and a
// handful of concurrent clicks exhausts the pool and stalls database traffic
// for the whole application — an outage reached from a feature that "works"
// in every functional test.
//
// WHY THIS IS A STRUCTURAL ASSERTION AND NOT A TIMING ONE. "The transaction was
// short" is a claim about a machine, not about the code: it passes on an idle
// laptop and flakes on a loaded CI box, and this repo already carries one
// wall-clock assertion that flakes for exactly that reason. So the test observes
// the SHAPE instead — it counts open `withTenant` frames and records the depth
// the solver was entered at. Depth 0 is the property; anything else means the
// solve is nested inside a transaction, however fast it happened to be.
//
// Both module mocks spread the real module, so everything except the two
// wrappers is the genuine implementation and the reads below hit a real
// Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/** Open `withTenant` frames, how many were opened, and the depth each solver
 *  entry point saw.
 *
 *  `depth` is a PROCESS-WIDE counter and `als` is the same depth carried down
 *  one async call chain. The difference is the whole reason this file has an
 *  AsyncLocalStorage in it: `seedStage` fires cache-invalidation and revalidate
 *  work it does not await, so a frame belonging to the SEED is often still open
 *  when `autoSchedule` starts. Reading the process-wide counter at the solver
 *  entry point therefore records somebody else's transaction as this call's
 *  nesting depth — which failed CI on 2026-08-24 (run 32787553112, polish leg,
 *  `expected [ 1 ] to deeply equal [ +0 ]`) on a branch that touches no
 *  scheduling code at all. The store answers the question the spec actually
 *  asks: was the solve nested inside a transaction OF ITS OWN CALL CHAIN. */
const tx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const state = {
    depth: 0,
    opens: 0,
    solveDepths: [] as number[],
    als: new AsyncLocalStorage<number>(),
    /** What the solver mock records. Named so the harness spec at the bottom of
     *  this file can call the SAME function the mock calls, and therefore catch
     *  a regression to `state.depth` here. */
    recordSolveDepth: () => {
      state.solveDepths.push(state.als.getStore() ?? 0);
    },
  };
  return state;
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    withTenant: async <T>(
      orgId: string,
      fn: (sql: never) => Promise<T>,
    ): Promise<T> => {
      tx.depth++;
      tx.opens++;
      const nested = (tx.als.getStore() ?? 0) + 1;
      try {
        return await tx.als.run(nested, () =>
          actual.withTenant(orgId, fn as never),
        );
      } finally {
        tx.depth--;
      }
    },
  };
});

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    // Recorded at CALL time, before awaiting: the question is what was open when
    // the solver was entered, not what is open when it finishes.
    //
    // From the STORE, not `tx.depth` — see the comment on `tx`. An unawaited
    // frame from elsewhere in the process must not be read as this solve's
    // nesting.
    buildSchedule: (input: Parameters<typeof actual.buildSchedule>[0]) => {
      tx.recordSolveDepth();
      return actual.buildSchedule(input);
    },
  };
});

const { sql } = await import("@/lib/db");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { autoSchedule, putScheduleSettings, applySchedule } =
  await import("../schedule");
const { createVenue, createCourt } = await import("../venues");
type AuthCtx = import("@/server/api-v1/auth").AuthCtx;

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-08-01T09:00:00.000Z";
const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedStage(): Promise<{ auth: AuthCtx; stageId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  const auth: AuthCtx = {
    orgId,
    via: "session",
    userId: null,
    role: "owner",
    keyId: null,
  };
  const competition = await createCompetition(auth, {
    // #376: an end date is mandatory — a competition with no end can never
    // cross the pass line, so the schema requires one.
    ends_on: "2030-12-31",
    name: "TX " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  // P9 pass 3a: real courts.id values — ScheduleConfig.courts is CourtId[]
  // since pass 1.
  const venue = await createVenue(auth, { name: "Main", sort: 0 });
  const c1 = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });
  const c2 = await createCourt(auth, venue.id, { name: "C2", sort: 1, tags: [] });
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [c1.id, c2.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { auth, stageId: stage.id };
}

describe.skipIf(!HAS_DB)(
  "autoSchedule holds no transaction across the solve",
  () => {
    beforeEach(() => {
      tx.depth = 0;
      tx.opens = 0;
      tx.solveDepths = [];
    });

    it("enters the tier solver at transaction depth 0 (build)", async () => {
      const { auth, stageId } = await seedStage();
      // BOTH counters reset after seeding, not just `solveDepths`. `seedStage`
      // opens a dozen transactions of its own, and a count carried over from it
      // would satisfy the assertion below while saying nothing whatsoever about
      // `autoSchedule`.
      tx.solveDepths = [];
      tx.opens = 0;

      await autoSchedule(auth, stageId, {
        only_unlocked: false,
        mode: "build",
      });

      // The solver ran at all — otherwise `toEqual([0])` would be satisfied by an
      // empty array and this whole spec would assert nothing.
      expect(tx.solveDepths).toHaveLength(1);
      expect(tx.solveDepths).toEqual([0]);
      // …and a transaction really was opened during the call, so depth 0 at the
      // solve is a transaction that CLOSED, not one that never existed.
      //
      // COUNTED, not measured as peak concurrency. Peak depth was the obvious
      // choice and is the wrong one: `seedStage`'s writes fire cache-invalidation
      // and revalidate work WITHOUT awaiting it, so a background frame is often
      // still open when this call begins and the peak reads 2. Nothing is nested
      // inside `autoSchedule` — stack capture confirms the deeper frame is
      // `autoSchedule`'s OWN phase-1 read — so a peak assertion would pin the
      // harness's timing rather than the property under test.
      expect(tx.opens).toBeGreaterThan(0);
      // Nothing left open.
      expect(tx.depth).toBe(0);
    }, 120_000);

    it("enters the placement client at transaction depth 0 (reflow)", async () => {
      const { auth, stageId } = await seedStage();
      // Put a board down so REFLOW has an incumbent, THEN clear exactly one
      // fixture's slot before reflowing. C4 (2026-08-14, z3 retirement stage
      // A) changed what "has an incumbent" needs to mean here: `reflowExisting`
      // now freezes every already-placed card (locked or not) and skips
      // calling the placement client ENTIRELY when nothing is left free to
      // place — a fully-applied board alone (the original setup) now takes
      // that fast path and never reaches `buildSchedule` at all, which would
      // make this test vacuously pass with an EMPTY `tx.solveDepths` rather
      // than genuinely observing the depth the client was entered at. One
      // cleared fixture is enough to keep the client's own entry reachable.
      const first = await autoSchedule(auth, stageId, {
        only_unlocked: false,
        mode: "build",
      });
      await applySchedule(auth, stageId, {
        assignments: first.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_id: a.court_id,
        })),
        source: "auto",
      });
      await sql`
        update fixtures set scheduled_at = null, court_id = null
        where id = ${first.assignments[0]!.fixture_id}`;
      tx.solveDepths = [];
      tx.opens = 0;

      await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "reflow",
      });

      expect(tx.solveDepths).toHaveLength(1);
      expect(tx.solveDepths).toEqual([0]);
      expect(tx.opens).toBeGreaterThan(0);
      expect(tx.depth).toBe(0);
    }, 120_000);

    it("enters the tier solver at transaction depth 0 (polish)", async () => {
      const { auth, stageId } = await seedStage();
      tx.solveDepths = [];
      tx.opens = 0;

      await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "polish",
      });

      // Same four assertions as the other two modes. Consistency is the point:
      // a spec that checks less than its siblings is the one that goes stale
      // without anybody noticing.
      expect(tx.solveDepths).toHaveLength(1);
      expect(tx.solveDepths).toEqual([0]);
      expect(tx.opens).toBeGreaterThan(0);
      expect(tx.depth).toBe(0);
    }, 120_000);
  },
);

// Not DB-gated: this pins the HARNESS property the three specs above depend on.
// It calls `recordSolveDepth` — the same function the `buildSchedule` mock
// calls — so reverting that function to the process-wide `tx.depth` reds this
// spec. Without it the fix for the 2026-08-24 polish flake would be a change no
// test can see: the flake itself only reproduces on a loaded box.
describe("the depth recorded at the solver entry point", () => {
  it("is scoped to its own call chain, not the process", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A frame belonging to somebody else — the shape `seedStage`'s unawaited
    // cache-invalidation work leaves behind while the next call is starting.
    const foreign = tx.als.run(1, async () => {
      tx.depth++;
      try {
        await held;
      } finally {
        tx.depth--;
      }
    });
    await Promise.resolve();

    // The process-wide counter sees the foreign frame…
    expect(tx.depth).toBe(1);
    // …and what the solver mock records, from a chain that opened nothing,
    // does not.
    tx.solveDepths = [];
    tx.recordSolveDepth();
    expect(tx.solveDepths).toEqual([0]);

    release();
    await foreign;
    expect(tx.depth).toBe(0);
  });

  it("is NONZERO inside a frame of its own, so [0] is a real observation", () => {
    // Review gap, 2026-08-25: every other assertion in this file expects
    // `[0]`, which a store that returned `undefined` for any reason — a
    // broken `als.run`, a recorder that stopped reading it — would satisfy
    // too. Nothing proved the recorder can produce anything BUT zero. This
    // does: same recorder, called from inside a run() scope.
    tx.solveDepths = [];
    tx.als.run(1, () => tx.recordSolveDepth());
    tx.als.run(2, () => tx.recordSolveDepth());
    expect(tx.solveDepths).toEqual([1, 2]);
  });
});
