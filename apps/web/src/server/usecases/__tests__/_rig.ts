// Shared test rig for P11 batch-import (Task 1 onward). Lifts the idioms
// from scoring-deferred.test.ts:60-111 (raw-SQL org seed, then usecase calls
// to build the tournament) so every P11 task's tests share one builder
// instead of re-deriving it.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";

const VARIANT_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

export async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Import " + suffix}, ${"import-" + suffix}) returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0',
            ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(VARIANT_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

/** A division with `entrants` entrants (shared across every stage — there is
 *  one entrant pool per division, not per stage) and `stages` league stages
 *  (default 1), fixtures generated per stage. `start: false` leaves it in
 *  setup, which is what the phase-gate test needs.
 *
 *  Fix round 1 (review finding 1): a single league stage can never yield
 *  exactly 2 fixtures — `roundRobinFixtureCount(n, 1) = n(n-1)/2` skips 2
 *  entirely (n=2 -> 1, n=3 -> 3) — and the original draft's
 *  `startedDivisionWithFixture({fixtures: 2})` mapped to `entrants: 3` in
 *  ONE stage, which is 3 fixtures, not 2. Multiple stages fixes both that
 *  and Task 3's real requirement: `fixtures_stage_ext_key_idx` is unique per
 *  `(stage_id, ext_key)` (V214__fixtures.sql:32-33), so an ext_key-ambiguity
 *  test needs its two same-valued-ext_key fixtures in DIFFERENT stages or
 *  the setup itself throws a duplicate-key violation before import ever
 *  runs. `generateStageFixtures` draws every ACTIVE DIVISION entrant
 *  (stages.ts:1121-1124, `select id, seed from entrants where division_id =
 *  ... and status in ('registered', 'confirmed')`), not a stage-scoped
 *  subset, so N stages sharing the SAME 2
 *  entrants each independently round-robin those 2 into exactly 1 fixture —
 *  N stages -> N fixtures, one per stage, no per-stage entrant partitioning
 *  needed. */
export async function divisionRig(
  auth: AuthCtx,
  opts: { start?: boolean; entrants?: number; doubleRound?: boolean; stages?: number } = {},
): Promise<{
  divisionId: string;
  fixtureIds: string[];
  stages: Array<{ stageId: string; fixtureIds: string[] }>;
}> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Import Cup " + randomUUID().slice(0, 6),
    visibility: "public", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false, ...(opts.doubleRound ? { rounds: 2 } : {}) },
    eligibility: [],
  });
  const names = Array.from({ length: opts.entrants ?? 2 }, (_, i) => String.fromCharCode(65 + i));
  await createEntrants(auth, division.id, names.map((n, i) => ({
    kind: "individual" as const, display_name: n, seed: i + 1, members: [],
  })));
  const stageCount = opts.stages ?? 1;
  const stages: Array<{ stageId: string; fixtureIds: string[] }> = [];
  for (let seq = 1; seq <= stageCount; seq++) {
    const [stage] = await createStages(auth, division.id, {
      seq, kind: "league", name: `L${seq}`, config: {},
    });
    const { fixtures } = await generateStageFixtures(auth, stage.id);
    stages.push({ stageId: stage.id, fixtureIds: fixtures.map((f) => f.id) });
  }
  if (opts.start !== false) await startDivision(auth, division.id);
  return { divisionId: division.id, fixtureIds: stages.flatMap((s) => s.fixtureIds), stages };
}

export async function startedDivisionWithFixture(
  auth: AuthCtx, opts: { fixtures?: number } = {},
): Promise<{
  divisionId: string;
  fixtureId: string;
  fixtureIds: string[];
  stages: Array<{ stageId: string; fixtureIds: string[] }>;
}> {
  const wantTwo = opts.fixtures === 2;
  // 2 entrants total, split across 2 league stages: each stage's round robin
  // over the same 2 division entrants yields exactly 1 fixture
  // (roundRobinFixtureCount(2, 1) === 1), so 2 stages -> 2 fixtures, each in
  // its OWN stage — see divisionRig's doc comment for why one stage cannot
  // do this and why the two fixtures must be in different stages.
  const rig = await divisionRig(auth, wantTwo ? { entrants: 2, stages: 2 } : { entrants: 2 });
  if (wantTwo) {
    const distinctStages = new Set(rig.stages.map((s) => s.stageId));
    if (rig.fixtureIds.length !== 2 || distinctStages.size !== 2) {
      // Throws rather than silently handing Task 3 the wrong shape — this is
      // exactly the failure mode review finding 1 caught: a change to
      // fixture-generation behaviour (or to this rig) that quietly stops
      // producing 2 fixtures in 2 stages must be loud, not a passing test
      // over the wrong fixture count.
      throw new Error(
        `startedDivisionWithFixture({ fixtures: 2 }) rig invariant broken: expected exactly 2 ` +
          `fixtures across 2 distinct stages, got ${rig.fixtureIds.length} fixture(s) across ` +
          `${distinctStages.size} stage(s).`,
      );
    }
  }
  return { ...rig, fixtureId: rig.fixtureIds[0]! };
}

export async function setupDivisionWithFixture(
  auth: AuthCtx,
): Promise<{ divisionId: string; fixtureId: string }> {
  const rig = await divisionRig(auth, { start: false });
  return { divisionId: rig.divisionId, fixtureId: rig.fixtureIds[0]! };
}

/** The smallest stream that reaches a decided outcome for the generic module
 *  (packages/engine/src/sports/generic/generic.ts), verified against the real
 *  module rather than assumed:
 *
 *  - There is no `core.score` event type. `core.*` types are dispatched by
 *    the kernel's own fixed core-event set (core/events.ts) before a sport
 *    module ever sees them; `core.score` throws `unknown core event type
 *    "core.score"` there, before reaching `generic.apply()` at all. The
 *    brief's original draft (`core.score` / `{side, points}`) cannot run.
 *  - The module's only scoring actions are `generic.score` (a running tally,
 *    payload `{by: EntrantId, points, person?}` — `by` needs a real entrant
 *    id, so it cannot be baked into a fixture-agnostic stream like this one)
 *    and `generic.result` (the terminal card, payload
 *    `{p1Score, p2Score}` for `resultMode: "score"`, matching this rig's
 *    `VARIANT_CONFIG`).
 *  - `core.finalize` requires `state.phase === "done"`, which only
 *    `generic.result` (or forfeit/abandon) sets — a stream of `core.start`
 *    plus tally presses alone never reaches "done" and finalize would throw
 *    `WRONG_PHASE`.
 *
 *  So the smallest stream that actually decides, with no entrant-id
 *  dependency (safe to reuse across any fixture/entrant pair), is: start,
 *  an explicit final score, finalize. Confirmed by folding this exact
 *  sequence through `generic` with `foldMatch` — home wins 3-1,
 *  `state.phase === "final"`. */
export function decidingStream(): Array<{ type: string; payload: Record<string, unknown> }> {
  return [
    { type: "core.start", payload: {} },
    { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } },
    { type: "core.finalize", payload: {} },
  ];
}
