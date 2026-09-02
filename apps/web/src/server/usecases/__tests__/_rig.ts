// Shared test rig for P11 batch-import (Task 1 onward). Lifts the idioms
// from scoring-deferred.test.ts:60-111 (raw-SQL org seed, then usecase calls
// to build the tournament) so every P11 task's tests share one builder
// instead of re-deriving it.
import { randomUUID } from "node:crypto";
import { cricket } from "@seazn/engine/sports/cricket";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { putLineup } from "../fixtures";
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
  opts: { start?: boolean; entrants?: number; stages?: number } = {},
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
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
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

/**
 * Task 5 addition (review finding #5(d)) — additive to everything above, not
 * a replacement: every existing export here keeps its exact prior
 * behaviour, since six other test files depend on this rig staying put.
 *
 * W1 (entitlements v18, 2026-09-02): scoring detail is free on every plan now
 * (owner ruling 2026-08-30) — `cricket.ball` / `cricket.superover.ball` /
 * `cricket.retire` no longer require `scoring.ball_by_ball` at all, so this
 * rig's ORIGINAL reason for existing (proving `import.entitlement` fires for
 * a fidelity-gated type `generic` can never reach) is gone; the fidelity
 * variant of that test was deleted in the same commit that removed
 * `requiredFeatureForEvent`. This rig stays exactly as it was built —
 * `startedCricketDivisionWithFixture` is now used ONLY by the SECOND,
 * unrelated gate: `cricket.revise` with no manual umpire target under a
 * DLS-enabled division still requires `cricket.dls` (scoring.ts's
 * `requiresDlsEntitlement`, untouched by W1) — see
 * `event-import-dryrun.test.ts`'s DLS tests, the rig's only remaining
 * callers.
 *
 * Seeded the same way `entitlements-v2.test.ts` already does (real
 * precedent, not a new pattern): `cricket.version`/`cricket.positions` for
 * the sports-catalog row, `cricket.variants.t20` for the variant. `team`
 * entrants — cricket rejects individual entrants at the write path.
 */
async function seedCricketCatalog(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('cricket', 'Cricket', ${cricket.version}, ${sql.json(cricket.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('cricket', 't20', 'T20', ${sql.json(cricket.variants.t20 as never)}, true)
    on conflict do nothing`;
}

/** A started cricket division with one fixture and two team entrants — the
 *  minimal shape `import.entitlement` needs (a fixture past the unassigned-
 *  entrant guard, so `runStream` actually reaches the entitlement check). No
 *  lineups are seeded: the entitlement check (design doc §4 step 3) runs
 *  BEFORE the dry-run fold that would need them, so a stream that never
 *  reaches the fold does not need one either. */
export async function startedCricketDivisionWithFixture(
  auth: AuthCtx,
): Promise<{ divisionId: string; fixtureId: string }> {
  await seedCricketCatalog();
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Import Cricket Cup " + randomUUID().slice(0, 6),
    visibility: "public", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "cricket", variant_key: "t20", config: {}, 
  });
  await createEntrants(auth, division.id, [
    { kind: "team" as const, display_name: "A", seed: 1, members: [] },
    { kind: "team" as const, display_name: "B", seed: 2, members: [] },
  ]);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L1", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  await startDivision(auth, division.id);
  return { divisionId: division.id, fixtureId: fixtures[0]!.id };
}

// ---------------------------------------------------------------------------
// W1 (entitlements v18, scoring-free.test.ts) — a rig generic over ALL 11
// `builtinModules`, not one sport at a time like the helpers above. The R9
// ruling ("scoring detail is free on every plan") is a claim about EVERY
// shipped module, so its own test needs a rig that can stand one up for any
// of them without a per-sport branch to keep in sync by hand.
// ---------------------------------------------------------------------------

const builtinByKey = new Map(builtinModules.map((m) => [m.key, m]));

/** Upserts the ONE module's own `sports`/`sport_variants` rows — idempotent,
 *  same `on conflict do nothing` idiom `seedOrg`/`seedCricketCatalog` above
 *  use. A real deploy already has every module synced (`scripts/sync-
 *  sports.ts`, run after `db:apply`) but a bare test DB may not, so this
 *  rig seeds its own module rather than assume the environment already did —
 *  the ONE thing it does NOT reuse from `sync-sports.ts` is the prune step,
 *  which is a global-catalog concern this per-module helper has no business
 *  performing. */
async function seedModuleCatalog(sportModule: AnySportModule): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${sportModule.key}, ${sportModule.key}, ${sportModule.version}, ${sql.json(sportModule.positions as never)})
    on conflict (key) do nothing`;
  for (const [variantKey, config] of Object.entries(sportModule.variants)) {
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values (${sportModule.key}, ${variantKey}, ${variantKey}, ${sql.json((config ?? {}) as never)}, true)
      on conflict do nothing`;
  }
}

/**
 * A fresh COMMUNITY org (no subscription row — `seedOrg`'s own convention:
 * the entitlement resolver's fallback), one started league division and one
 * generated fixture for `moduleKey`, plus real (not stubbed) entrant and
 * person ids to attribute an event to — generic over any `builtinModules`
 * key, the way `startedDivisionWithFixture` above is NOT (it hardcodes
 * `generic`).
 *
 * Entrant kind: `effectiveEntrantModel(module.entrantModel).defaultKind` —
 * the SAME resolver `entrants.ts`'s own `loadEntrantShape` uses, so this rig
 * can never roster a kind a division would itself reject. Both sides carry
 * real persons (`new_person` inline members, `entrants.ts`'s own
 * `resolveInlineMembers`), not an empty roster like `entitlements-v2.test.ts`'s
 * `makeFixture` uses: several modules' top-band actions attribute to a
 * PERSON, not a side (`PadAttributionItem`'s `"person"` kind,
 * `packages/engine/src/sport/module.ts`), and an empty roster leaves no id to
 * point one at.
 *
 * `cfg` is `division.config` — already the schema-parsed variant preset
 * (`createDivision`'s own decision log, restated in `fidelity.ts`), so the
 * caller can hand it straight to `module.padSpec!(...)` without re-resolving
 * anything.
 */
export async function makeCommunityRig(moduleKey: string): Promise<{
  auth: AuthCtx;
  fixtureId: string;
  entrantIds: [string, string];
  personIds: string[];
  /** Same persons as `personIds`, split by which side's roster they were
   *  created on — several modules' top-band actions need a person from a
   *  SPECIFIC side (football's `goalkeeper` must be the DEFENDING side's
   *  keeper; cricket's `bowler` must be in the FIELDING lineup, `striker`/
   *  `nonStriker` in the BATTING one), which a flat pool cannot express. */
  personIdsBySide: [string[], string[]];
  cfg: unknown;
}> {
  const sportModule = builtinByKey.get(moduleKey);
  if (!sportModule) throw new Error(`makeCommunityRig: no builtin module "${moduleKey}" (check builtinModules)`);
  await seedModuleCatalog(sportModule);
  const { auth } = await seedOrg();
  const suffix = randomUUID().slice(0, 6);
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: `MC ${sportModule.key} ${suffix}`, visibility: "private", branding: {},
  });
  const variantKey = Object.keys(sportModule.variants)[0];
  if (!variantKey) throw new Error(`makeCommunityRig: module "${sportModule.key}" declares no named variants`);
  const division = await createDivision(auth, competition.id, {
    name: `Div ${suffix}`, sport_key: sportModule.key, variant_key: variantKey, config: {},
  } as never);
  const eff = effectiveEntrantModel(sportModule.entrantModel);
  // Structural caps (entrant-model.ts's own `entrantKindCap`): individual=1,
  // pair=2, team=unbounded — 2 is always legal and gives a distinct 2nd
  // person per side for any attribution item that needs one.
  const memberCount = eff.defaultKind === "individual" ? 1 : 2;
  // Every optional `NewPersonMemberInput` field is spelled out explicitly:
  // this call goes straight to the usecase, bypassing the zod schema (and
  // its `.default(...)`s) that a real HTTP request would apply — an omitted
  // `roles`/`is_captain` here is `undefined` at runtime, not `[]`/`false`,
  // and postgres.js's `tx.json(undefined)` throws UNDEFINED_VALUE inside
  // `insertMembers` (found by running this rig against a real DB).
  const membersFor = (label: string) =>
    Array.from({ length: memberCount }, (_, i) => ({
      new_person: { full_name: `${label}${i + 1} ${suffix}`, dob: null, gender: null },
      squad_number: null,
      default_position_key: null,
      is_captain: false,
      roles: [] as string[],
    }));
  const entrants = await createEntrants(auth, division.id, [
    { kind: eff.defaultKind, display_name: "A", seed: 1, members: membersFor("A") },
    { kind: eff.defaultKind, display_name: "B", seed: 2, members: membersFor("B") },
  ] as never);
  const entrantIds: [string, string] = [entrants[0]!.id, entrants[1]!.id];
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "league", name: "L", config: {},
  } as never);
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  const fixtureId = fixtures[0]!.id;
  // `createEntrants`' own return shape carries no member ids (CreatedEntrant
  // extends EntrantRow only) — the inline `new_person` rows are resolved
  // server-side inside that same call, so this is the only way to learn them.
  const memberRows = await sql<{ entrant_id: string; person_id: string }[]>`
    select entrant_id, person_id from entrant_members where entrant_id in ${sql(entrantIds)}`;
  // Rostering (`entrant_members`, above) is a DIVISION-level fact; the engine
  // fold checks a PER-FIXTURE lineup instead (`lineups`, `loadLineupPair`) —
  // an entrant with real members but no declared lineup still folds as "no
  // one on the pitch" (found running this rig for real: football's own
  // `taker … is not on the pitch` refusal, and cricket's `batting order …
  // needs at least 2 players`, both engine-level, nothing to do with
  // entitlements). `putLineup` requires the fixture still be "scheduled" —
  // called here, before `startDivision` below moves it on.
  for (const entrantId of entrantIds) {
    const slots = memberRows
      .filter((r) => r.entrant_id === entrantId)
      .map((r) => ({ person_id: r.person_id, slot: "starting" as const, roles: [] as string[] }));
    if (slots.length > 0) await putLineup(auth, fixtureId, entrantId, { slots } as never);
  }
  await startDivision(auth, division.id);
  const personIdsBySide: [string[], string[]] = [
    memberRows.filter((r) => r.entrant_id === entrantIds[0]).map((r) => r.person_id),
    memberRows.filter((r) => r.entrant_id === entrantIds[1]).map((r) => r.person_id),
  ];
  return {
    auth,
    fixtureId,
    entrantIds,
    personIds: memberRows.map((r) => r.person_id),
    personIdsBySide,
    cfg: division.config,
  };
}
