// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * C1 fix-loop (G2/3rd instance) — the drag/keyboard move path's round-robin
 * blind spot, over REAL HTTP. The unit suite (schedule-delta-blocking.test.ts)
 * already proves `moveFixture`'s delta gate detects a round-order violation
 * against an untouched sibling in isolation; what only smoke can prove is the
 * WIRING — that a real PATCH against a real running server, through real
 * auth/routing/JSON, actually 409s and actually writes nothing, and that the
 * identically-shaped legal PATCH actually succeeds.
 *
 * Round-robin (`kind: "league"`) over 4 entrants — 6 fixtures, 3 rounds of 2
 * — applied in explicit, round-ascending, hourly slots via a single manual
 * `schedule/apply` (deterministic; no solver involved, so this suite cannot
 * flake on `solver_busy`). `generate`'s own fixture order is round-ascending
 * (`generateStageFixtures`'s `order by round_no, seq_in_round`), so the
 * first two ids are round 1 and the last two are round 3 — matching the
 * convention the unit suite and the e2e spec both rely on.
 */
export async function scheduleRoundOrderDeltaGateSuite(): Promise<void> {
  const free = newSession();
  const roundOrderOrgId = (await signIn(free, `delivered+dtx_roundorder_${tag}@resend.dev`)).org_id;
  const roundOrderVenue = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${roundOrderOrgId}/venues`, "POST", {
      name: `Round Order Venue ${tag}`,
    }),
  );
  const roundOrderCourt1 = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${roundOrderOrgId}/venues/${roundOrderVenue.id}/courts`, "POST", {
      name: "Court 1",
    }),
  );
  const roundOrderCourt2 = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${roundOrderOrgId}/venues/${roundOrderVenue.id}/courts`, "POST", {
      name: "Court 2",
    }),
  );
  const roundOrderCourt3 = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${roundOrderOrgId}/venues/${roundOrderVenue.id}/courts`, "POST", {
      name: "Court 3",
    }),
  );
  const roundOrderCourts = [roundOrderCourt1, roundOrderCourt2, roundOrderCourt3];
  const comp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `DTX Round Order ${tag}`,
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Round Order",
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
    await v1(free, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "L",
      config: {},
    }),
  );
  const gen = v1data<{ fixtures: { id: string }[] }>(
    await v1(free, `/api/v1/stages/${stage.id}/generate`, "POST"),
  );
  check("round order: generate produced a 4-entrant round robin (6 fixtures)", gen.fixtures.length === 6);
  const round1Id = gen.fixtures[0].id;
  const laterRoundId = gen.fixtures[gen.fixtures.length - 1].id;

  const T0 = Date.UTC(2026, 10, 2, 9, 0);
  const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
  await v1(free, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: at(0),
      matchMinutes: 30,
      gapMinutes: 0,
      courts: roundOrderCourts.map((c) => c.id),
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });
  // Applied in explicit, already-correct round-ascending slots — one card
  // per fixture, an hour apart, matching gen.fixtures' own round order.
  const applied = await v1(free, `/api/v1/stages/${stage.id}/schedule/apply`, "POST", {
    assignments: gen.fixtures.map((f, i) => ({
      fixture_id: f.id,
      scheduled_at: at(i * 60),
      court_id: roundOrderCourt1.id,
    })),
    source: "manual",
  });
  check("round order: the initial round-ascending board applies cleanly (200)", applied.status === 200);

  // THE REFUSAL. The later round moved to an hour before round 1 on a
  // court nobody else uses — no court/person overlap possible, so a 409
  // here can only be the round-order gate.
  const before = await v1(free, `/api/v1/fixtures/${laterRoundId}`);
  const beforeAt = (before.json.data as { scheduled_at: string }).scheduled_at;
  const refused = await v1(free, `/api/v1/fixtures/${laterRoundId}`, "PATCH", {
    scheduled_at: at(-60),
    court_id: roundOrderCourt3.id,
  });
  // `/api/v1`'s error envelope (server/api-v1/http.ts) spreads `extra`
  // straight onto `error` — `error: { code, message, ...extra }` — not
  // nested under an `.extra` key, so `conflicts` sits at `error.conflicts`.
  const refusedConflicts =
    (refused.json.error)
      ?.conflicts ?? [];
  check(
    "round order: dragging the later round before an untouched round-1 sibling is REFUSED (409, warn.order, blocking)",
    refused.status === 409 &&
      refusedConflicts.some((c) => c.code === "warn.order" && c.blocking === true),
  );
  const afterRefusal = await v1(free, `/api/v1/fixtures/${laterRoundId}`);
  check(
    "round order: the refused write actually wrote nothing — the fixture is still at its original slot",
    (afterRefusal.json.data as { scheduled_at: string }).scheduled_at === beforeAt,
  );

  // THE CONTROL. The identically-shaped move, legal because it stays inside
  // round order (still after round 1, still before the whole board's own
  // span otherwise) — must not be caught by the same gate that just refused
  // the illegal one, proving the 409 above was about round order and not
  // some incidental clash on Court 3.
  const allowed = await v1(free, `/api/v1/fixtures/${laterRoundId}`, "PATCH", {
    scheduled_at: at(600),
    court_id: roundOrderCourt3.id,
  });
  check("round order: the identically-shaped legal move is allowed (200)", allowed.status === 200);

  // Round 1 itself — never touched by any move above — is still exactly
  // where the initial apply put it: the refused write's own siblings did
  // not get silently nudged as a side effect of the widened checked set.
  const round1After = await v1(free, `/api/v1/fixtures/${round1Id}`);
  check(
    "round order: round 1, never moved, is still at its original slot after the refused sibling drag",
    (round1After.json.data as { scheduled_at: string }).scheduled_at === at(0),
  );
}
