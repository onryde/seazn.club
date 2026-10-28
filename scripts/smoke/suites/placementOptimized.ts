// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, setPlan } from "../harness.ts";

/**
 * Task 11 (placement cutover) — the scenario `autoScheduleSuite`'s own
 * allow-list check deliberately cannot be: a board where the ONLY honest
 * outcome is `engine === "optimized"`, not merely a legal value drawn from a
 * four-member set. `_INDEX.md`'s "The cutover nearly shipped INERT" is why
 * this exists — Task 06 passed 8/8 happy-path tests while running greedy on
 * most real boards, because every one of those boards was small enough (or
 * regular enough) that greedy's own seed was ALREADY the tier solver's
 * optimum, so `engine` stayed "greedy" — correctly — no matter how well the
 * cutover was wired. `isStrictlyBetter` (`build-objectives.ts`) requires a
 * candidate to beat the seed on placed count, then makespan, then worst idle
 * gap, then court imbalance, in that order, before `build.ts`'s D6 gate ever
 * reports "optimized" — so THIS suite needs a board where beating greedy is
 * not just possible but measured.
 *
 * THE BOARD: six entrants, three rounds of three ad-hoc fixtures
 * (`POST /stages/{id}/fixtures`, PROMPT-66 — explicit `round_no`, not the
 * round-robin generator) on a two-court grid with a 45-minute rest floor.
 * Three matches cannot fit in one wave across two courts, so every round
 * spills one match into a second wave; greedy (a single left-to-right pass,
 * no look-ahead) always hands that spillover to the FIRST configured court,
 * every round, with no way to know that alternating it would balance the
 * whole board.
 *
 * SIZED FOR THE SERVICE'S OWN WALL, not just for the claim. A GENERATED
 * round robin hits the identical mechanism at 7 entrants (odd field, one bye
 * per round) but produces 21 fixtures over 7 rounds — measured directly
 * against a live service, THAT board stalls at `tiers_completed: 1/4`,
 * `budget_expired: true`, and falls back to greedy for a reason that has
 * nothing to do with the cutover: `PLACEMENT_WALL_SECONDS_MAX` defaults to
 * 10s (`src/placement/config.py` in onryde/seazn.club.placement), and proving makespan
 * optimal on a 21-fixture/2-court board with a real rest floor does not
 * finish inside it. This 9-fixture hand-built board does, reproducibly:
 *
 *   engine    makespan  worstIdleGap  courtImbalance  courts(A/B)  wall
 *   greedy       240min       105min           90min        6 / 3     -
 *   optimized    150min        30min           30min        5 / 4  ~3-4s
 *
 * (greedy row from `packages/engine`'s own `slotFixtures`/`boardMetrics`
 * against this exact fixture list — no live service needed to see it; the
 * optimized row measured 3/3 identical against a real service through this
 * exact HTTP surface.) `nonAlignedBoard()`
 * (`packages/engine/src/scheduling/__tests__/placement-integration.test.ts`)
 * proves the analogous claim at the engine layer; this is the same claim
 * reached through the real HTTP surface an organiser actually clicks.
 *
 * GATED, deliberately, the same way `v4AiSuite` gates on
 * `SCHEDULING_AI_BASE_URL`: without `PLACEMENT_SERVICE_HOST` set on THIS
 * process, the server under test cannot reach the optimiser either (the same
 * env var is what `build.ts`/`placement-client.ts` read), so every board
 * here would fall back to greedy and the check below would fail for a
 * reason that has nothing to do with the cutover. Skipping loudly (a logged
 * reason, not a silent pass) is the whole point — a four-value allow-list
 * that never actually requires the new value is the exact vacuous shape this
 * programme has found repeatedly.
 */
export async function placementOptimizedSuite(): Promise<void> {
  if (!process.env.PLACEMENT_SERVICE_HOST) {
    console.log(
      "placement optimized: PLACEMENT_SERVICE_HOST unset — skipping the required-optimized " +
        "scenario (the server under test cannot reach the service either, so every board would " +
        "fall back to greedy and the check would fail for an environmental reason, not a real " +
        "one). Run with PLACEMENT_SERVICE_HOST set, against a live service, to exercise this.",
    );
    return;
  }
  const s = newSession();
  const orgId = (await signIn(s, `delivered+smoke-placement-opt-${tag}@resend.dev`)).org_id;
  await setPlan(orgId, "pro", s);
  const optVenue = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `Optimized Venue ${tag}` }),
  );
  const optCourtA = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${optVenue.id}/courts`, "POST", { name: "Court A" }),
  );
  const optCourtB = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${optVenue.id}/courts`, "POST", { name: "Court B" }),
  );

  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Placement Optimized ${tag}`,
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Optimized",
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
      Array.from({ length: 6 }, (_, i) => ({
        kind: "individual",
        display_name: `Opt ${i}${tag}`,
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

  // 3 rounds x 3 matches, no entrant plays twice in a round, no pairing
  // repeats — see the docblock above for why this exact hand-built shape.
  const ROUNDS: [number, number][][] = [
    [[0, 1], [2, 3], [4, 5]],
    [[0, 2], [1, 4], [3, 5]],
    [[0, 3], [1, 5], [2, 4]],
  ];
  const fixtureIds: string[] = [];
  for (let r = 0; r < ROUNDS.length; r++) {
    for (const [a, b] of ROUNDS[r]) {
      const added = v1data<{ fixture_id: string }>(
        await v1(s, `/api/v1/stages/${stage.id}/fixtures`, "POST", {
          home_entrant_id: entrants[a].id,
          away_entrant_id: entrants[b].id,
          round_no: r + 1,
        }),
      );
      fixtureIds.push(added.fixture_id);
    }
  }
  check("placement optimized: 3 rounds of 3 ad-hoc fixtures created (9 total)", fixtureIds.length === 9);

  await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: "2026-09-21T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [optCourtA.id, optCourtB.id],
      perEntrantMinRest: 45,
      blackouts: [],
      sessionWindows: [],
    },
  });

  interface OptRun {
    assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
    metrics?: { placed: number; total: number };
    solver?: { engine: string; status: string };
  }
  const build = v1data<OptRun>(
    await v1(s, `/api/v1/stages/${stage.id}/schedule/auto`, "POST", { only_unlocked: false }),
  );
  check(
    // THE assertion this suite exists for — see the docblock above. Never
    // "placement": that is the SERVICE name, not an engine value, and the
    // rename already produced exactly that confusion once.
    `placement optimized: the optimiser measurably beat greedy (engine="${build?.solver?.engine}")`,
    build?.solver?.engine === "optimized",
  );
  check(
    "placement optimized: the run reported a solved status",
    build?.solver?.status === "ok" || build?.solver?.status === "already_optimal",
  );
  check(
    "placement optimized: every fixture was placed, across both courts, nothing lost",
    (build?.assignments ?? []).length === 9 &&
      build?.metrics?.placed === 9 &&
      build.metrics.total === 9 &&
      new Set((build.assignments ?? []).map((a) => a.court_id)).size === 2,
  );
}
