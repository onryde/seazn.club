import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * D3 schedule health (own fresh free session — not an entitlement gate):
 * the real route returns a well-formed report AFTER a schedule is actually
 * APPLIED (auto alone proposes only, nothing persisted — see
 * capacityPrecheckSuite's own `/schedule/auto` calls above, none of which
 * apply), and refuses 409 SCHEDULE_NOT_APPLIED BEFORE that. A league stage
 * is table-shaped (TABLE_KINDS), so homeAwayAlternation must be PRESENT —
 * this is the one smoke assertion unit tests cannot make: the real route's
 * stage `kind` column actually reaches the gate, not just the pure lib's
 * own `isRoundRobin` boolean the engine suite already proves in isolation.
 */
export async function scheduleHealthSuite(): Promise<void> {
  const free = newSession();
  const healthOrgId = (await signIn(free, `delivered+dtx_health_${tag}@resend.dev`)).org_id;
  const healthVenue = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${healthOrgId}/venues`, "POST", { name: `Health Venue ${tag}` }),
  );
  const healthCourt1 = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${healthOrgId}/venues/${healthVenue.id}/courts`, "POST", {
      name: "Court 1",
    }),
  );
  const healthCourt2 = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${healthOrgId}/venues/${healthVenue.id}/courts`, "POST", {
      name: "Court 2",
    }),
  );
  const comp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `DTX Health ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Health",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(free, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "A", seed: 1 },
    { kind: "individual", display_name: "B", seed: 2 },
    { kind: "individual", display_name: "C", seed: 3 },
    { kind: "individual", display_name: "D", seed: 4 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "L", config: {} }),
  );
  await v1(free, `/api/v1/stages/${stage.id}/generate`, "POST");

  // BEFORE any schedule exists: 409, typed code.
  const before = await v1(free, `/api/v1/stages/${stage.id}/schedule/health`, "GET");
  const beforeErr = before.json.error;
  check(
    "schedule health: refuses 409 SCHEDULE_NOT_APPLIED before any fixture is scheduled",
    before.status === 409 && beforeErr?.code === "SCHEDULE_NOT_APPLIED",
  );

  await v1(free, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: "2026-09-01T09:00:00.000Z",
      endAt: "2026-09-01T23:59:00.000Z",
      matchMinutes: 60,
      gapMinutes: 0,
      courts: [healthCourt1.id, healthCourt2.id],
      perEntrantMinRest: 0,
      sessionWindows: [{ from: "2026-09-01T09:00:00.000Z", to: "2026-09-01T21:00:00.000Z" }],
    },
  });
  const auto = v1data<{
    assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
  }>(await v1(free, `/api/v1/stages/${stage.id}/schedule/auto`, "POST", { only_unlocked: true }));
  await v1(free, `/api/v1/stages/${stage.id}/schedule/apply`, "POST", {
    assignments: auto.assignments.map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_id: a.court_id,
    })),
    source: "auto",
  });

  const after = v1data<{
    stageId: string;
    computedAt: string;
    metrics: { key: string; score: number; explanation: { key: string }; offenders: unknown[] }[];
  }>(await v1(free, `/api/v1/stages/${stage.id}/schedule/health`, "GET"));
  check("schedule health: 200 after apply, echoes the stage id", after.stageId === stage.id);
  check(
    // 5, not 4 — a league stage IS table-shaped, so homeAwayAlternation
    // must be present, not merely tolerated as absent.
    "schedule health: all 5 metrics present for a league (table-shaped) stage, scores in [0,100]",
    after.metrics.length === 5 &&
      after.metrics.every((m) => Number.isInteger(m.score) && m.score >= 0 && m.score <= 100) &&
      after.metrics.every((m) => m.explanation.key.startsWith("schedule.health.explain.")),
  );
  check(
    "schedule health: homeAwayAlternation is one of the 5 (present, not skipped) for this table-shaped stage",
    after.metrics.some((m) => m.key === "homeAwayAlternation"),
  );

  // Review finding #1: `abandoned` occupies real court time and must count
  // as an applied fixture, the same as scheduled/in_play/decided/finalized/
  // forfeited — dropping it would shrink restSpread's span_e and invent a
  // phantom idle gap for gapDispersion/primeSlotFairness. Sharpest possible
  // proof: mark EVERY fixture on the stage abandoned directly (a real
  // status this app reaches via a match that started and was called off,
  // not reachable through this smoke session's own API surface) and
  // confirm the route still returns 200 with real metrics — if abandoned
  // were excluded, `stageFixtures` would return zero rows and this would
  // 409 SCHEDULE_NOT_APPLIED exactly like the "before" check above.
  {
    const url = process.env.DATABASE_URL;
    if (url) {
      const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
      const sql = postgres(url, {
        connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
        ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
        prepare: !url.includes(":6543"),
        max: 1,
      });
      try {
        await sql`update fixtures set status = 'abandoned' where stage_id = ${stage.id}`;
        const abandoned = v1data<{ metrics: { key: string; score: number }[] }>(
          await v1(free, `/api/v1/stages/${stage.id}/schedule/health`, "GET"),
        );
        check(
          "schedule health: a stage where every fixture is ABANDONED still returns 200 with all 5 metrics — abandoned counts as occupied, not excluded (#1)",
          abandoned.metrics.length === 5,
        );
      } finally {
        await sql.end();
      }
    } else {
      console.log("SKIP  schedule health: abandoned-status check (DATABASE_URL not set)");
    }
  }

  // ========================================================================
  // Joint (competition-scope) variant — coordinator addendum, D3 Scope item
  // 2 ("+ joint competition aggregation"), originally under-scoped in this
  // session's brief. A SECOND division in the SAME competition, deliberately
  // left UNSCHEDULED, so the joint call has one ready division and one empty
  // one — proving "aggregate every division, never short-circuit" (the
  // shape `aiPlanForCompetition`'s capacity guard uses) the same way that
  // guard's own tests do: report EVERY division, not just the first.
  // ========================================================================
  const div2 = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Health B",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(free, `/api/v1/divisions/${div2.id}/entrants`, "POST", [
    { kind: "individual", display_name: "C", seed: 1 },
    { kind: "individual", display_name: "D", seed: 2 },
    { kind: "individual", display_name: "E", seed: 3 },
  ]);
  const stage2 = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${div2.id}/stages`, "POST", { seq: 1, kind: "league", name: "L2", config: {} }),
  );
  await v1(free, `/api/v1/stages/${stage2.id}/generate`, "POST");
  // NO schedule-settings PUT, NO auto, NO apply for div2/stage2 — this
  // division stays deliberately unscheduled.

  const joint = v1data<{
    competitionId: string;
    computedAt: string;
    divisions: {
      divisionId: string;
      name: string;
      stages: (
        | { stageId: string; status: "empty" }
        | { stageId: string; status: "ready"; computedAt: string; metrics: { key: string; score: number; explanation: { key: string }; offenders: unknown[] }[] }
      )[];
    }[];
    combined: { metrics: { key: string; score: number }[] };
  }>(await v1(free, `/api/v1/competitions/${comp.id}/schedule/health`, "GET"));

  check(
    "joint schedule health: 200 for the WHOLE competition despite one division having no applied schedule — never aborts on the first offender",
    joint.competitionId === comp.id && joint.divisions.length === 2,
  );

  const jointDiv1 = joint.divisions.find((d) => d.divisionId === div.id);
  const jointDiv2 = joint.divisions.find((d) => d.divisionId === div2.id);
  check(
    "joint schedule health: the SCHEDULED division's stage reports status=ready with all 5 metrics",
    jointDiv1?.stages.length === 1 &&
      jointDiv1.stages[0].status === "ready" &&
      (jointDiv1.stages[0] as { metrics: unknown[] }).metrics.length === 5,
  );
  check(
    "joint schedule health: the UNSCHEDULED division's stage reports status=empty, not a thrown error for the whole call",
    jointDiv2?.stages.length === 1 && jointDiv2.stages[0].status === "empty",
  );

  // THE cross-check (coordinator's explicit ask): the scheduled stage's
  // entry INSIDE the joint response must be byte-for-byte the same report
  // `computeStageHealth` already produced for the standalone stage route
  // (`after`, above) — not a re-derivation. This is what would have caught
  // P1's actual bug (a SECOND config-building path silently omitting
  // `.tz`): a fork produces a DIFFERENT number here, not merely a missing
  // one, because a wrong/absent tz shifts every fixture's day-bucketing and
  // therefore gapDispersion/primeSlotFairness's scores.
  const jointStage1 = jointDiv1!.stages[0] as { status: "ready"; metrics: typeof after.metrics };
  check(
    "joint schedule health: the embedded stage report EXACTLY matches the standalone stage route's own report (no second implementation, no tz drift)",
    JSON.stringify(jointStage1.metrics) === JSON.stringify(after.metrics),
  );

  check(
    "joint schedule health: combined block is EXACTLY {gapDispersion, primeSlotFairness} — the two metrics 'meaningful' over the union (design doc, verbatim)",
    joint.combined.metrics.length === 2 &&
      new Set(joint.combined.metrics.map((m) => m.key)).size === 2 &&
      joint.combined.metrics.every((m) => m.key === "gapDispersion" || m.key === "primeSlotFairness") &&
      joint.combined.metrics.every((m) => Number.isInteger(m.score) && m.score >= 0 && m.score <= 100),
  );

  const unknownJoint = await v1(free, `/api/v1/competitions/00000000-0000-0000-0000-000000000000/schedule/health`, "GET");
  check("joint schedule health: unknown competition 404s", unknownJoint.status === 404);
}
