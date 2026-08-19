// #pins-in-build — a `schedule_locked` (or scope-locked) fixture must stay put
// on EVERY auto-schedule mode, BUILD included.
//
// Before this fix, `pinnedIds` in `schedule.ts` only honoured a lock when
// `body.only_unlocked` was true — but the primary "Auto-schedule" button
// always posts `only_unlocked: false` (it derives `mode: "build"` from that
// same flag; see `AutoScheduleRequest` in `../../api-v1/schemas`), so the
// gate silently zeroed the pinned set on every BUILD call and a locked
// fixture entered the solve fully movable. Owner's reported sequence: click
// Auto-schedule, pin a fixture via the lock toggle, click Auto-schedule
// again — the pin was ignored, time AND court both changed.
//
// `pinnedIds` and POLISH's `frozen` set were two hand-maintained copies of
// the same "is this fixture locked" predicate, and had already diverged on
// exactly this `only_unlocked` clause. `lockedFixtureIds` is the one
// extracted, shared predicate; its own pure-function tests live at the
// bottom of this file, unguarded by DB.
//
// Real Postgres required for the DB-backed describes; skipped without
// DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import {
  applySchedule,
  autoSchedule,
  lockedFixtureIds,
  putScheduleSettings,
  type FixtureLite,
  type LockedScope,
} from "../schedule";
import { createVenue, createCourt } from "../venues";
import { patchFixture } from "../fixtures";
import { setDivisionLocks } from "../history";
import { buildSchedulePack } from "../schedule-ai";

const HAS_DB = !!process.env.DATABASE_URL;

const T0 = "2026-08-01T09:00:00.000Z";
const MIN = 60_000;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<AuthCtx> {
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
  for (const feature of [
    "scheduling.constraints",
    "scheduling.board",
    "scheduling.multi_division",
    // Pro layer (Jul3/03 §7) — `setDivisionLocks` gates a non-empty
    // `locked_scopes` behind this, used by the scope-lock tests below.
    "schedule.versioning",
  ]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** A 4-entrant league on two courts — enough fixtures for a real placement
 *  problem, matching the fixture family `schedule-polish-current.test.ts` and
 *  `schedule-solver-telemetry.test.ts` already use for this usecase. */
async function seedStage(
  auth: AuthCtx,
  entrants: number,
): Promise<{ stageId: string; divisionId: string; created: number; courts: [string, string] }> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Locks " + randomUUID().slice(0, 6),
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
    Array.from({ length: entrants }, (_, i) => ({
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
  // P9 pass 3a: 2 real courts — `ScheduleConfig.courts` has been `CourtId[]`
  // (real uuids) since pass 1, so a free-text "C1"/"C2" string is no longer
  // legal on the config. Court NAMES are kept as "C1"/"C2" (cosmetic only —
  // nothing below matches on them) purely so a human reading a failure still
  // recognises which court is which.
  const venue = await createVenue(auth, { name: "Main", sort: 0 });
  const court1 = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });
  const court2 = await createCourt(auth, venue.id, { name: "C2", sort: 1, tags: [] });
  const courts: [string, string] = [court1.id, court2.id];
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts,
      perEntrantMinRest: 30,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const generated = await generateStageFixtures(auth, stage.id);
  return { stageId: stage.id, divisionId: division.id, created: generated.created, courts };
}

/**
 * C1 fix-loop (G2/3rd instance). `seedStage`'s board (4 entrants, 2 courts,
 * `perEntrantMinRest` equal to `matchMinutes`) is the same ZERO-SLACK shape
 * `schedule-delta-blocking.test.ts`'s round-order suite documents: every round
 * packs back to back with nothing free anywhere, so displacing a fixture to an
 * atypical slot is only UNCONDITIONALLY safe in ONE DIRECTION — and which
 * direction that is follows from which round the card belongs to.
 *
 * This used to be `round1FixtureId`, paired with a BACKWARD park: a round-1
 * fixture, moved earlier, has no preceding round to violate H6 (round order)
 * against. `parkSlot` now parks FORWARD (see there for why backward could not
 * be made robust), so the safe end flips with it — a LAST-round fixture, moved
 * later, has no subsequent round to violate H6 against, whatever the rest of
 * the board looks like. Keeping round 1 while parking forward would jump the
 * card over its own successors and manufacture exactly the `order` conflict
 * both choices exist to avoid.
 *
 * Read off `round_no`, never `first.assignments[0]`: solver output order is not
 * round-sorted, so indexing the proposal could pick a middle-round card and
 * produce a genuine round-order violation — one that was invisible only because
 * the delta gate's round-robin blind spot could not see it before. `round_no`
 * is a fixture-generation-time fact (`generateStageFixtures`, inside
 * `seedStage`), so it holds regardless of where the solver put the card.
 */
async function lastRoundFixtureId(stageId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from fixtures
    where stage_id = ${stageId}
      and round_no = (select max(round_no) from fixtures where stage_id = ${stageId})
    limit 1`;
  return row!.id;
}

/**
 * Eight hours AFTER the board's own last card — read off the board that is
 * actually there, and deliberately FORWARD of it. Both halves of that sentence
 * were paid for.
 *
 * IT USED TO BE `at(-480)`: eight hours before the CONFIG's `startAt`, which is
 * a fixed instant (`2026-08-01T01:00Z`) that assumed where the board would be.
 * That assumption is no longer true, and the failure it produced is the whole
 * of the "1-in-3 intermittent `assertNoNewBlocking`":
 *
 *   * `config.startAt` is NOT the solver's floor. The apply gate's window comes
 *     from `applyWindow`, which floors at START-OF-DAY of `config.startAt` in
 *     the org zone — `2026-08-01T00:00Z`, not 09:00 — and `boundSolverWindow`
 *     returns a two-finite-bound window untouched. So the solver's grid opens
 *     at midnight while GREEDY's cursor opens at 09:00
 *     (`calendar.ts:759`, `ready = max(config.startAt, window.notBefore)`).
 *   * Under C2's day-aware rungs the solver compacts to that midnight, on
 *     either the seed day or the next, run to run — both boards verify clean,
 *     so nothing downstream picks a side.
 *   * Board on the NEXT day: `at(-480)` is empty, park lands, test green.
 *     Board on the SEED day: the board IS 00:00/01:00/02:00 on both courts, so
 *     `at(-480)` — 01:00 — is a genuine C2 double-booking plus two entrant
 *     overlaps, and `assertNoNewBlocking` refused it, correctly. Measured over
 *     5 auto applies: 3 next-day (pass), 2 seed-day (fail).
 *
 * The suite only ever looked stable because `isStrictlyBetter` kept discarding
 * the solver's midnight board for greedy's 09:00 one. It is a TEST premise that
 * broke, not the product: every board involved verifies clean.
 *
 * WHY FORWARD, not simply "8h before the board's earliest card". That was the
 * first fix and it is not robust: when the solver picks the seed day its
 * earliest card sits EXACTLY ON the window floor, so no legal slot exists
 * before it at all, and the park is refused with `window` — "outside the
 * competition window" — instead of `court`. Forward has no such edge: the
 * window's ceiling is the competition's `ends_on` (2030), four years out.
 *
 * Forward is safe for the same reason backward was, mirrored — see
 * `lastRoundFixtureId`.
 */
async function parkSlot(stageId: string): Promise<string> {
  const [row] = await sql<{ latest: Date | null }[]>`
    select max(scheduled_at) as latest from fixtures where stage_id = ${stageId}`;
  const latest = row?.latest;
  if (!latest) throw new Error("parkSlot: the board is empty — apply an auto board first");
  return new Date(latest.getTime() + 480 * MIN).toISOString();
}

/**
 * Moves a round-1 fixture to a slot no compacting solver would choose on its
 * own — see `parkSlot` — on the second court, then locks it. A re-solve that
 * ignores the lock relocates the card back into the compact region the rest of
 * the board occupies; one that honours it must not move it AT ALL. Mirrors the
 * exact technique `schedule-solver-telemetry.test.ts`'s parked-card specs use,
 * for the same reason: two runs of the same solver over the same input can
 * otherwise coincide by construction, which would make "unchanged" true
 * whether or not the lock was ever read.
 *
 * `courtId` is a real `courts.id` (P9 pass 3a) — see `seedStage`'s own
 * `courts` tuple.
 *
 * Returns the slot it parked at, because the caller must assert against the
 * instant actually used — a second `parkSlot()` call would re-read a board the
 * park itself has since changed.
 */
async function parkAndLock(
  auth: AuthCtx,
  stageId: string,
  fixtureId: string,
  courtId: string,
): Promise<string> {
  const parkedAt = await parkSlot(stageId);
  await applySchedule(auth, stageId, {
    assignments: [{ fixture_id: fixtureId, scheduled_at: parkedAt, court_id: courtId }],
    source: "manual",
  });
  await patchFixture(auth, fixtureId, { schedule_locked: true });
  return parkedAt;
}

/**
 * Companion to `parkAndLock`: locks via the division's `locked_scopes` (a
 * court scope), never touching the fixture's own `schedule_locked` — the
 * arm `lockedFixtureIds` (and Task 2's AI-draft predicate, and the Task 1
 * apply-time check) must honour from a scope alone. Parks the fixture on the
 * scoped court first, same atypical slot as `parkAndLock`, so the lock has
 * something to bite and "it stayed" cannot be a compacting solver's
 * coincidence.
 *
 * P9 pass-3a-FIX: `locked_scopes.courts` holds a real `courts.id` now (V374's
 * third migration block) — `scopeLocked` (schedule.ts) matches on
 * `court_id`, never the legacy free-text `court_label`. The DB-backed tests
 * that call this helper are this fix's own regression: on a revert to the
 * pre-fix `scopeLocked` (matching `court_label`, which nothing writes any
 * more since pass 3a's FULL cutover), the scope lock below matches nothing
 * and the "locked" fixture moves.
 */
async function parkAndScopeLock(
  auth: AuthCtx,
  stageId: string,
  divisionId: string,
  fixtureId: string,
  courtId: string,
): Promise<string> {
  const parkedAt = await parkSlot(stageId);
  await applySchedule(auth, stageId, {
    assignments: [{ fixture_id: fixtureId, scheduled_at: parkedAt, court_id: courtId }],
    source: "manual",
  });
  await setDivisionLocks(auth, divisionId, { locked_scopes: [{ courts: [courtId] }] });
  return parkedAt;
}

describe.skipIf(!HAS_DB)("BUILD honours a lock (owner report, 2026-08-12)", () => {
  it("a schedule_locked fixture stays at its time AND court across a second Auto-schedule click", async () => {
    const auth = await seedOrg();
    const { stageId, created, courts } = await seedStage(auth, 4);

    // Click 1: "Auto-schedule" — `only_unlocked: false` is exactly what the
    // primary button posts (`use-board-actions.ts`'s `autoRun`, which
    // `schemas.ts` derives `mode: "build"` from). Applied for real so the
    // park-and-lock below has a board to act on.
    const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    expect(first.assignments).toHaveLength(created);
    await applySchedule(auth, stageId, {
      assignments: first.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    });

    // Pin one fixture via the lock toggle, at a deliberately atypical slot.
    const targetId = await lastRoundFixtureId(stageId);
    const parkedAt = await parkAndLock(auth, stageId, targetId, courts[1]);

    // Click 2: "Auto-schedule" again — the owner's exact reported sequence,
    // same body as click 1.
    const second = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });

    const proposed = second.assignments.find((a) => a.fixture_id === targetId);
    // BOTH time and court, matching the owner's report precisely ("Its time
    // AND court both changed").
    expect(proposed?.scheduled_at).toBe(parkedAt);
    expect(proposed?.court_id).toBe(courts[1]);
  }, 180_000);
});

describe.skipIf(!HAS_DB)("REFLOW and POLISH keep honouring a lock, unchanged by the BUILD fix", () => {
  it("reflow and polish still leave a locked fixture exactly where it is", async () => {
    const auth = await seedOrg();
    const { stageId, created, courts } = await seedStage(auth, 4);

    const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    expect(first.assignments).toHaveLength(created);
    await applySchedule(auth, stageId, {
      assignments: first.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    });

    const targetId = await lastRoundFixtureId(stageId);
    const parkedAt = await parkAndLock(auth, stageId, targetId, courts[1]);

    // REFLOW: the exact shape the Re-flow button sends
    // (`only_unlocked: true`, no explicit mode — the default derivation).
    const reflow = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    const reflowed = reflow.assignments.find((a) => a.fixture_id === targetId);
    expect(reflowed?.scheduled_at).toBe(parkedAt);
    expect(reflowed?.court_id).toBe(courts[1]);

    // POLISH: the exact shape the Polish button sends
    // (`only_unlocked: true, mode: "polish"`, per schedule-board-polish.test.tsx).
    const polish = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "polish" });
    const polished = polish.assignments.find((a) => a.fixture_id === targetId);
    expect(polished?.scheduled_at).toBe(parkedAt);
    expect(polished?.court_id).toBe(courts[1]);
  }, 180_000);
});

describe.skipIf(!HAS_DB)("ignore_locks is the explicit escape hatch", () => {
  it("keeps a lock by default and moves it only when ignore_locks is set, both reflected in locked_kept", async () => {
    const auth = await seedOrg();
    const { stageId, created, courts } = await seedStage(auth, 4);

    const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    expect(first.assignments).toHaveLength(created);
    await applySchedule(auth, stageId, {
      assignments: first.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    });

    const targetId = await lastRoundFixtureId(stageId);
    const parkedAt = await parkAndLock(auth, stageId, targetId, courts[1]);

    // Without the escape hatch: the fix under test — stays put, and the
    // response says exactly one fixture was held for being locked.
    const kept = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    const keptCard = kept.assignments.find((a) => a.fixture_id === targetId);
    expect(keptCard?.scheduled_at).toBe(parkedAt);
    expect(keptCard?.court_id).toBe(courts[1]);
    expect(kept.solver.locked_kept).toBe(1);

    // WITH the escape hatch: the one explicit way to override a lock — moves,
    // and the response says nothing was held back.
    const moved = await autoSchedule(auth, stageId, {
      only_unlocked: false,
      mode: "build",
      ignore_locks: true,
    });
    const movedCard = moved.assignments.find((a) => a.fixture_id === targetId);
    expect(movedCard?.scheduled_at).not.toBe(parkedAt);
    expect(moved.solver.locked_kept).toBe(0);
  }, 180_000);
});

describe.skipIf(!HAS_DB)(
  "a locked_scopes scope lock is honoured end-to-end in BUILD (gap review flagged)",
  () => {
    // P9 pass-3a-FIX Task 1's regression: see `parkAndScopeLock`'s own doc
    // comment for exactly why this fails on a revert of `scopeLocked`.
    it("a court scope lock — no schedule_locked flag involved — keeps its fixture in place across a second Auto-schedule click", async () => {
      const auth = await seedOrg();
      const { stageId, divisionId, created, courts } = await seedStage(auth, 4);

      const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
      expect(first.assignments).toHaveLength(created);
      await applySchedule(auth, stageId, {
        assignments: first.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_id: a.court_id,
        })),
        source: "auto",
      });

      const targetId = await lastRoundFixtureId(stageId);
      const parkedAt = await parkAndScopeLock(auth, stageId, divisionId, targetId, courts[1]);

      // Same click the owner's report reproduced — `only_unlocked: false`,
      // `mode: "build"` — but this time the lock comes ONLY from the
      // division's `locked_scopes`; the fixture's own `schedule_locked`
      // stays false throughout.
      const second = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
      const proposed = second.assignments.find((a) => a.fixture_id === targetId);
      expect(proposed?.scheduled_at).toBe(parkedAt);
      expect(proposed?.court_id).toBe(courts[1]);
    }, 180_000);
  },
);

describe.skipIf(!HAS_DB)(
  "a scope-locked fixture is fed to the AI draft with its locked anchor AND marked pinned (#pins-in-build Task 2 + Task 4)",
  () => {
    it("buildSchedulePack's generate-mode draft keeps a court-scope-locked fixture at its parked slot, and PackFixture.pinned is true for it", async () => {
      const auth = await seedOrg();
      const { stageId, divisionId, created, courts } = await seedStage(auth, 4);

      const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
      expect(first.assignments).toHaveLength(created);
      await applySchedule(auth, stageId, {
        assignments: first.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_id: a.court_id,
        })),
        source: "auto",
      });

      const targetId = await lastRoundFixtureId(stageId);
      const parkedAt = await parkAndScopeLock(auth, stageId, divisionId, targetId, courts[1]);

      const { pack } = await buildSchedulePack(auth, divisionId, {
        now: Date.parse(T0),
        mode: "generate",
        instruction: "Schedule the remaining fixtures.",
      });
      const drafted = pack.draft.find((d) => d.fixture_id === targetId);
      expect(drafted, `draft is missing fixture ${targetId}`).toBeDefined();
      expect(drafted!.scheduled_at).not.toBeNull();
      // Compared on the instant, not the rendered string: the pack renders
      // in the ORG zone (`zonedIso`), which may not spell the same offset
      // `at()` does even when it names the same instant.
      expect(Date.parse(drafted!.scheduled_at as string)).toBe(Date.parse(parkedAt));
      // `.court_label` is `schedule-ai.ts`'s own wire field name (pass 3b,
      // not converted by this pass) — but the VALUE flowing through it is
      // already a real court_id: `toAssignment` (schedule.ts) has fed
      // `f.court_id` into the engine's `Assignment.court` since pass 1, and
      // this field is that same value passed straight through.
      expect(drafted!.court_label).toBe(courts[1]);

      // Task 4: `PackFixture.pinned` (feeds `structuralCheck` and
      // `toEngineAssignments`'s `pinnedIds`) used to be `f.schedule_locked`
      // alone — a scope-locked-only fixture read as NOT pinned there even
      // though the draft anchor above already held it. Not `.toBe(true)` by
      // accident: `targetId` is asserted absent from `schedule_locked`
      // via `parkAndScopeLock`, which never touches the fixture's own flag.
      const pinnedFixture = pack.fixtures.movable.find((f) => f.id === targetId);
      expect(pinnedFixture, `movable is missing fixture ${targetId}`).toBeDefined();
      expect(pinnedFixture!.pinned).toBe(true);
    }, 180_000);
  },
);

describe("lockedFixtureIds (the unified lock predicate)", () => {
  const base: FixtureLite = {
    id: "f1",
    stage_id: "s1",
    division_id: "d1",
    pool_id: null,
    round_no: 1,
    seq_in_round: 1,
    ext_key: null,
    home_entrant_id: null,
    away_entrant_id: null,
    scheduled_at: "2026-08-01T09:00:00.000Z",
    // P9 pass-3a-FIX: court_id/venue_id are what scopeLocked reads now.
    // court_label/venue are LEGACY and null here on purpose — the dedicated
    // test below pins that they are no longer consulted at all.
    court_id: "c1",
    venue_id: null,
    court_label: null,
    venue: null,
    status: "scheduled",
    schedule_locked: false,
    winner_to_fixture: null,
    loser_to_fixture: null,
  };
  const scopeOnC9: LockedScope[] = [{ courts: ["c9"] }];

  it("includes a schedule_locked, placed fixture", () => {
    const f = { ...base, schedule_locked: true };
    expect(lockedFixtureIds([f], [], false)).toEqual(new Set(["f1"]));
  });

  it("excludes a fixture that is neither schedule_locked nor scope-locked", () => {
    expect(lockedFixtureIds([base], [], false)).toEqual(new Set());
  });

  /** The case the two hand-maintained copies of this predicate both had to
   *  get right independently — a lock that comes from the division's
   *  `locked_scopes`, not from the fixture's own `schedule_locked` flag. */
  it("includes a fixture caught only by a scope lock, not schedule_locked", () => {
    const f = { ...base, court_id: "c9" };
    expect(lockedFixtureIds([f], scopeOnC9, false)).toEqual(new Set(["f1"]));
  });

  it("excludes a schedule_locked fixture with no placement to anchor to", () => {
    const noTime = { ...base, schedule_locked: true, scheduled_at: null };
    expect(lockedFixtureIds([noTime], [], false)).toEqual(new Set());
    const noCourt = { ...base, schedule_locked: true, court_id: null };
    expect(lockedFixtureIds([noCourt], [], false)).toEqual(new Set());
  });

  it("ignoreLocks suppresses every lock, schedule_locked and scope-locked alike", () => {
    const f = { ...base, schedule_locked: true, court_id: "c9" };
    expect(lockedFixtureIds([f], scopeOnC9, true)).toEqual(new Set());
  });

  it("only_unlocked has no say here — the predicate takes no such argument", () => {
    // Regression guard, structural rather than behavioural: the whole bug was
    // `only_unlocked` gating this exact test. There is no parameter left to
    // gate it with.
    expect(lockedFixtureIds.length).toBe(3);
  });

  // P9 pass-3a-FIX Task 1's regression at the pure-function level (companion
  // to the DB-backed one on `parkAndScopeLock`, above): `scopeLocked` used to
  // match a division's `locked_scopes` against the LEGACY `court_label`
  // column, which pass 3a stopped writing — a court scope lock silently
  // matched nothing from that point on. This fails on a revert to that
  // behaviour: `stale` below carries the scope's string on `court_label` but
  // NOT on `court_id`, which a court_label-reading scopeLocked would wrongly
  // include.
  it("matches on court_id, never the legacy court_label column", () => {
    const stale = { ...base, court_label: "c9", court_id: "not-c9" };
    expect(lockedFixtureIds([stale], scopeOnC9, false)).toEqual(new Set());
    const real = { ...base, court_label: null, court_id: "c9" };
    expect(lockedFixtureIds([real], scopeOnC9, false)).toEqual(new Set(["f1"]));
  });
});
