// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * F3 Task 5 (5a/5b, 2026-08-18 plan) — the roster-drift rebuild, over real
 * HTTP (own fresh free session — not an entitlement gate). 5c (a GET read
 * path for the derived signal) is a separate, later task — not built here —
 * so the proof is the rebuild's own observable effect, not a dedicated read:
 * withdraw BEFORE the division starts (a plain status flip on the real
 * withdraw route — generateStageFixtures is additive-only, so Generate alone
 * can never drop the withdrawn entrant's name, the plan's "corrected
 * premise"), then rebuild actually drops it and picks up an entrant
 * registered after the original generate. A second, unrelated division
 * proves the separate 409 refusal once a fixture already carries a result.
 */
export async function stageRosterDriftSuite(): Promise<void> {
  const free = newSession();
  await signIn(free, `delivered+dtx_drift_${tag}@resend.dev`);
  const comp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `DTX Drift ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(free, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "Drift Alice", seed: 1 },
    { kind: "individual", display_name: "Drift Bob", seed: 2 },
    { kind: "individual", display_name: "Drift Cleo", seed: 3 },
  ]);
  const entrantsBefore = v1data<{ id: string; display_name: string }[]>(
    await v1(free, `/api/v1/divisions/${div.id}/entrants`),
  );
  const byName = new Map(entrantsBefore.map((e) => [e.display_name, e.id]));
  const aliceId = byName.get("Drift Alice")!;

  const stage = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1, kind: "league", name: "L", config: {},
    }),
  );
  const gen = v1data<{ created: number }>(await v1(free, `/api/v1/stages/${stage.id}/generate`, "POST"));
  check("roster drift: a 3-entrant league generates all 3 pairings", gen.created === 3);

  // "Additive only" (generateStageFixtures's own doc comment, the plan's
  // corrected premise): withdrawing BEFORE the division starts is a plain
  // status flip on the real withdraw route — no fixture surgery — so
  // Alice's name stays on the board exactly as the plan describes.
  const withdrawn = v1data<{ policy: string }>(await v1(free, `/api/v1/entrants/${aliceId}/withdraw`, "POST"));
  check(
    "roster drift: pre-start withdrawal is a plain status flip, not the mid-tournament cascade",
    withdrawn.policy === "none",
  );

  await v1(free, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "Drift Dee", seed: 4 },
  ]);
  const entrantsAfter = v1data<{ id: string; display_name: string }[]>(
    await v1(free, `/api/v1/divisions/${div.id}/entrants`),
  );
  const deeId = entrantsAfter.find((e) => e.display_name === "Drift Dee")!.id;

  // "5b — a rebuild that can actually fix it": replaces the whole stage,
  // not a top-up. removed=3 (the stale Alice/Bob/Cleo set), created=3 (the
  // fresh Bob/Cleo/Dee round robin).
  const rebuilt = v1data<{
    removed: number;
    created: number;
    fixtures: { home_entrant_id: string | null; away_entrant_id: string | null }[];
  }>(await v1(free, `/api/v1/stages/${stage.id}/rebuild`, "POST"));
  check("roster drift: rebuild removes all 3 stale fixtures and generates 3 fresh ones", rebuilt.removed === 3 && rebuilt.created === 3);
  const referenced = new Set(rebuilt.fixtures.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]));
  check("roster drift: the withdrawn entrant's name is gone from the rebuilt board", !referenced.has(aliceId));
  check("roster drift: the entrant registered after the original generate is now on the board", referenced.has(deeId));

  // Separate division: rebuild refuses once ANY fixture already has a
  // result (hard constraint 1) — never a partial rebuild.
  const div2 = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Played",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(free, `/api/v1/divisions/${div2.id}/entrants`, "POST", [
    { kind: "individual", display_name: "Played One", seed: 1 },
    { kind: "individual", display_name: "Played Two", seed: 2 },
  ]);
  const stage2 = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${div2.id}/stages`, "POST", {
      seq: 1, kind: "league", name: "L2", config: {},
    }),
  );
  const gen2 = v1data<{ fixtures: { id: string }[] }>(await v1(free, `/api/v1/stages/${stage2.id}/generate`, "POST"));
  await v1(free, `/api/v1/divisions/${div2.id}/start`, "POST");
  const f2 = gen2.fixtures[0];
  const state2 = v1data<{ last_seq: number }>(await v1(free, `/api/v1/fixtures/${f2.id}/state`));
  await v1(free, `/api/v1/fixtures/${f2.id}/events`, "POST", {
    expected_seq: state2.last_seq,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 0 },
  });
  const refused = await v1(free, `/api/v1/stages/${stage2.id}/rebuild`, "POST");
  check(
    "roster drift: rebuild refuses 409 STAGE_HAS_RESULTS once a fixture is decided, never a partial rebuild",
    refused.status === 409 && refused.json.error?.code === "STAGE_HAS_RESULTS",
  );
}
