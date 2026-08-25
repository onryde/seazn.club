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

/** A division with `entrants` entrants and one league stage. `start: false`
 *  leaves it in setup, which is what the phase-gate test needs. */
export async function divisionRig(
  auth: AuthCtx,
  opts: { start?: boolean; entrants?: number; doubleRound?: boolean } = {},
): Promise<{ divisionId: string; fixtureIds: string[] }> {
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
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  if (opts.start !== false) await startDivision(auth, division.id);
  return { divisionId: division.id, fixtureIds: fixtures.map((f) => f.id) };
}

export async function startedDivisionWithFixture(
  auth: AuthCtx, opts: { fixtures?: number } = {},
): Promise<{ divisionId: string; fixtureId: string; fixtureIds: string[] }> {
  const rig = await divisionRig(auth, { entrants: opts.fixtures === 2 ? 3 : 2 });
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
