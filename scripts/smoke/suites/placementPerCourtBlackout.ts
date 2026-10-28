// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, setPlan } from "../harness.ts";

/**
 * Task C2 — the per-court-grid capability gap. Before this task,
 * `Blackout.court?` scoped to ONE of several configured courts left those
 * courts offering different start-time grids, which `build.ts`'s
 * `everyCourtSharesGrid` refused outright (`not_searched`/`per_court_grid`)
 * rather than send to placement — the optimiser was switched off for the
 * division, permanently, for as long as the blackout stood, on a board that
 * otherwise looks fine. `placement.model.build_model` now enforces each
 * court's own tick set directly, so the request reaches the solver like any
 * other board.
 *
 * THE BOARD, measured directly against a live local placement service (see
 * `apps/web/e2e/placement-cutover.spec.ts`'s sibling test for the full
 * derivation): two fixtures sharing one entrant, a 40-minute per-entrant
 * rest floor (a MULTIPLE of the lattice's own 10-minute step — an unaligned
 * rest moves the solver's rebalanced board a tick later and its makespan
 * loses to greedy's on a rounding artifact, not on the capability under
 * test), two courts, and a blackout removing the second court's back half.
 * Greedy stacks both matches on the first-tried court (a 60-minute court
 * imbalance); the solver spreads them onto both courts at the identical
 * makespan and idle gap, so imbalance is the only tier that moves — exactly
 * what makes `engine: "optimized"` the correct, deterministic answer here
 * rather than a matter of search luck.
 */
export async function placementPerCourtBlackoutSuite(): Promise<void> {
  if (!process.env.PLACEMENT_SERVICE_HOST) {
    console.log(
      "placement per-court blackout: PLACEMENT_SERVICE_HOST unset — skipping (same reason as " +
        "the placement-optimized suite above: every board would fall back to greedy for an " +
        "environmental reason, not a real one). Run with PLACEMENT_SERVICE_HOST set, against a " +
        "live service, to exercise this.",
    );
    return;
  }
  const s = newSession();
  const orgId = (await signIn(s, `delivered+smoke-placement-pcg-${tag}@resend.dev`)).org_id;
  await setPlan(orgId, "pro", s);
  const perCourtVenue = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `PerCourt Venue ${tag}` }),
  );
  const perCourtC1 = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${perCourtVenue.id}/courts`, "POST", { name: "C1" }),
  );
  const perCourtC2 = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${perCourtVenue.id}/courts`, "POST", { name: "C2" }),
  );

  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Placement PerCourt ${tag}`,
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "PerCourt",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const entrants = v1data<{ id: string }[]>(
    await v1(
      s,
      `/api/v1/divisions/${div.id}/entrants`,
      "POST",
      Array.from({ length: 3 }, (_, i) => ({
        kind: "individual",
        display_name: `PC ${i}${tag}`,
        seed: i + 1,
      })),
    ),
  );
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );

  // a: entrant 0 vs 1. b: entrant 0 vs 2. Both share entrant 0 -- the rest
  // floor below is what fixes their relative start times regardless of court.
  const fixtureIds: string[] = [];
  for (const [home, away] of [
    [0, 1],
    [0, 2],
  ] as [number, number][]) {
    const added = v1data<{ fixture_id: string }>(
      await v1(s, `/api/v1/stages/${stage.id}/fixtures`, "POST", {
        home_entrant_id: entrants[home].id,
        away_entrant_id: entrants[away].id,
        round_no: 1,
      }),
    );
    fixtureIds.push(added.fixture_id);
  }
  check("placement per-court blackout: 2 ad-hoc fixtures created", fixtureIds.length === 2);

  const startAtMs = Date.UTC(2026, 8, 22, 9, 0);
  await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: new Date(startAtMs).toISOString(),
      matchMinutes: 30,
      gapMinutes: 10,
      courts: [perCourtC1.id, perCourtC2.id],
      perEntrantMinRest: 40,
      // C2 alone loses its back half; C1 is untouched -- the two courts'
      // offered start times now genuinely differ, the exact shape that used
      // to be refused before ever reaching placement. blackouts[].court is
      // matched verbatim against an assignment's own court id (calendar.ts),
      // not resolved through a name, so this must be the real id too.
      blackouts: [
        {
          court: perCourtC2.id,
          from: new Date(startAtMs + 90 * 60_000).toISOString(),
          to: new Date(startAtMs + 180 * 60_000).toISOString(),
        },
      ],
      sessionWindows: [],
    },
  });

  interface PerCourtRun {
    assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
    metrics?: { placed: number; total: number };
    solver?: { engine: string; status: string; not_searched_reason?: string };
  }
  const build = v1data<PerCourtRun>(
    await v1(s, `/api/v1/stages/${stage.id}/schedule/auto`, "POST", { only_unlocked: false }),
  );
  check(
    // THE assertion this suite exists for: the request reached the solver
    // and the solver's rebalanced board won, rather than the whole run
    // being refused (`not_searched`/`per_court_grid`) before it was ever
    // asked. Never "placement": that is the SERVICE name, not an engine
    // value.
    `placement per-court blackout: the optimiser measurably beat greedy despite the blackout ` +
      `(engine="${build?.solver?.engine}", status="${build?.solver?.status}", ` +
      `reason="${build?.solver?.not_searched_reason}")`,
    build?.solver?.engine === "optimized" && build?.solver?.status === "ok",
  );
  check(
    "placement per-court blackout: both fixtures placed, one per court",
    (build?.assignments ?? []).length === 2 &&
      build?.metrics?.placed === 2 &&
      build.metrics.total === 2 &&
      new Set((build.assignments ?? []).map((a) => a.court_id)).size === 2,
  );
}
