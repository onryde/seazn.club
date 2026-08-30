// A build refused by the solver QUEUE must be answered immediately.
//
// THE HAZARD. `buildSchedule` returns `solver_busy` (a greedy board) without
// calling the placement service at all once `MAX_SOLVER_QUEUE` builds are in
// flight — build.ts's cap check is a single integer read placed ahead of
// everything else precisely so the third caller need not wait. A solve is an
// out-of-process RPC with a wall budget measured in tens of seconds
// (`autoSolverWallMs`), so anything that puts the refusal BEHIND that call —
// a wrapper that awaits the solve, an admission check moved below it, a
// limiter that queues on the same resource — turns an answer that was already
// computed into an HTTP response the organiser watches spin. That is not
// hypothetical: this file's original version existed because a
// `finally { await resetZ3() }` at this seam did exactly that, sending the
// excused caller to the back of a strict FIFO lock and making it wait out two
// full solver budgets anyway.
//
// RESTORED AFTER C8 (coverage loss 2). The original held the process-wide z3
// lock to stage the contention. C8 deleted the solver and the lock, and with
// it the only way to hold `queued` at its cap from outside the engine — the
// real solve simply completed and decremented. The placement client is where
// that ability moved: `buildSchedule` reaches it through a DYNAMIC
// `await import("./placement-client.ts")` (build.ts says why, at the import),
// so a spy on that module namespace is the call the engine makes, and a spy
// that never resolves pins two builds in flight for as long as this file
// wants them there.
//
// STRUCTURAL, NOT TIMED. The assertion is not "the third call was fast" —
// that is a claim about a machine. The placement client is HELD OPEN for the
// whole window, so a call that reaches the solver at all cannot settle, and
// one that is refused before it settles immediately. The 10-second race is the
// failure mode's shape, not a threshold: under the bug the promise is pending
// until the gate opens, however fast the box is.
//
// NON-VACUITY, three ways. The third call must come back reporting
// `solver_busy` from the greedy path (a run where the first two had already
// finished would settle promptly while proving nothing); the spy must show
// exactly two calls at that moment (the refusal never reached the service);
// and the cooldown limiter must show it really ran (below).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { SolveBuildOutcome } from "@seazn/engine/scheduling/placement-client";

/** Builds that have ENTERED the engine's `buildSchedule`, counted after the
 *  call so the engine's own synchronous `queued++` has certainly happened. */
const solver = vi.hoisted(() => ({ entered: 0 }));

/** A LIVE per-org cooldown counter.
 *
 *  The claim this file makes is about the fast-refusal path, and a limiter is
 *  exactly the kind of thing that quietly destroys it — the deleted
 *  `withZ3Teardown` wrapper did, by putting an `await` on a contended lock in
 *  front of an answer computed without taking it. `AUTO_SCHEDULE_COOLDOWN` now
 *  sits ahead of every auto run, so the assertion below has to hold WITH it
 *  running or it is no longer a proof about production.
 *
 *  It has to be forced. `rateLimit` is Upstash-only and `incrWindow` returns
 *  null with no REDIS_URL, so on an unmocked local run the limiter is inert and
 *  this file would go on passing with the cooldown parked on the critical path.
 *  `calls` is asserted non-empty for that reason. */
const limiter = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    buildSchedule: (input: Parameters<typeof actual.buildSchedule>[0]) => {
      const run = actual.buildSchedule(input);
      solver.entered++;
      return run;
    },
  };
});

vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return {
    ...actual,
    incrWindow: (key: string) => {
      limiter.calls.push(key);
      return Promise.resolve(limiter.calls.filter((k) => k === key).length);
    },
  };
});

const { sql } = await import("@/lib/db");
const placement = await import("@seazn/engine/scheduling/placement-client");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { autoSchedule, putScheduleSettings } = await import("../schedule");
const { seedCourts } = await import("./_seed");
type AuthCtx = import("@/server/api-v1/auth").AuthCtx;

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-08-01T09:00:00.000Z";
/** How long the third call is given to settle while the client is held open.
 *  Generous on purpose: under the fix it settles in milliseconds, and under
 *  the bug it cannot settle at all, so the size only affects how long a RED
 *  run takes. */
const SETTLE_MS = 10_000;
const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Busy " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
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
  const courts = await seedCourts(orgId, 2);
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { auth, stageId: stage.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 5 });
});

describe.skipIf(!HAS_DB)("a queue-refused build is answered without queuing", () => {
  it("returns solver_busy while the placement client is still held open by someone else", async () => {
    const { auth, stageId } = await seedStage();
    solver.entered = 0;
    limiter.calls.length = 0;

    /** Solves parked inside the client. Nothing resolves them but `release`. */
    const parked: (() => void)[] = [];
    let released = false;
    const release = (): void => {
      released = true;
      for (const resume of parked.splice(0)) resume();
    };
    // A board is never asserted here — this file is about WHEN the third call
    // answers, not about what the other two eventually contain — so the
    // parked calls reject on release rather than fabricating a placement
    // board. `buildSchedule` maps a rejection to a greedy `solver_unavailable`
    // board, which is a settled outcome for the two holders and costs this
    // file no stub it would then have to keep true.
    const solveBuild = vi
      .spyOn(placement, "solveBuild")
      .mockImplementation(
        () =>
          new Promise<SolveBuildOutcome>((_resolve, reject) => {
            const fail = () => reject(new Error("parked by schedule-auto-solver-busy-latency.test.ts"));
            if (released) fail();
            else parked.push(fail);
          }),
      );

    const build = () => autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    const first = build();
    const second = build();
    void first.catch(() => {});
    void second.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Wait until BOTH are inside the CLIENT — not merely inside the engine.
      // `solver.entered` moves as soon as `buildSchedule` is called, which is
      // before the cap is even read; only a call the client has received
      // proves the queue is genuinely at its cap of two. Polling rather than
      // sleeping: the two calls each do a database read first, and how long
      // that takes is not this test's claim.
      const deadline = Date.now() + 30_000;
      while (solveBuild.mock.calls.length < 2) {
        if (Date.now() > deadline) throw new Error("the first two builds never reached the client");
        await sleep(25);
      }
      // …and both really are the engine's own calls, not something else in
      // the process reaching placement.
      expect(solver.entered).toBe(2);

      const third = build();
      void third.catch(() => {});
      const outcome = await Promise.race([
        third.then((result) => ({ kind: "settled" as const, result })),
        new Promise<{ kind: "pending" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "pending" }), SETTLE_MS);
        }),
      ]);

      expect(outcome.kind).toBe("settled");
      // Narrowed by the assertion above; the guard keeps tsc honest.
      if (outcome.kind !== "settled") throw new Error("unreachable");
      // …and it settled because the QUEUE refused it, not because the client
      // was never contended. This is what stops a run where the first two
      // builds finished early from passing on an empty queue.
      expect(outcome.result.solver.status).toBe("solver_busy");
      expect(outcome.result.solver.engine).toBe("greedy");
      // THE COST THE REFUSAL AVOIDS, stated at the seam: the answer was
      // produced without a third request to a service whose wall budget is
      // tens of seconds. `solver.entered` is 3 — the engine was entered — so
      // this is specifically about what the engine did NOT do inside.
      expect(solveBuild).toHaveBeenCalledTimes(2);
      expect(solver.entered).toBe(3);
      // A greedy board is still a board: the organiser gets a timetable, which
      // is the whole reason the cap answers rather than refusing.
      expect(outcome.result.assignments.length).toBeGreaterThan(0);
      // …and the cooldown was LIVE for all of it. Without this the mock could be
      // wired to nothing and the paragraph above would be a claim about a
      // limiter that never ran — the same inert-limiter trap that makes an
      // unmocked `rateLimit` test vacuous. Three runs, three INCRs, all on the
      // org's own key.
      expect(limiter.calls).toEqual(Array(3).fill(`rl:auto-schedule:${auth.orgId}`));
    } finally {
      if (timer) clearTimeout(timer);
      // `queued` is module state in the engine and this file shares a process
      // with every other suite in its worker: a build left parked would refuse
      // every build that follows it, whatever happened above.
      release();
      await Promise.allSettled([first, second]);
      solveBuild.mockRestore();
    }
  }, 180_000);
});
