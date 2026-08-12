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
import { patchFixture } from "../fixtures";
import { setDivisionLocks } from "../history";
import { buildSchedulePack } from "../schedule-ai";

const HAS_DB = !!process.env.DATABASE_URL;

const T0 = "2026-08-01T09:00:00.000Z";
const MIN = 60_000;
const at = (m: number) => new Date(Date.parse(T0) + m * MIN).toISOString();

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
): Promise<{ stageId: string; divisionId: string; created: number }> {
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
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["C1", "C2"],
      perEntrantMinRest: 30,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const generated = await generateStageFixtures(auth, stage.id);
  return { stageId: stage.id, divisionId: division.id, created: generated.created };
}

/**
 * Moves one fixture to a slot no compacting solver would choose on its own —
 * ten hours out, on the second court — then locks it. A re-solve that ignores
 * the lock relocates the card back into the compact region the rest of the
 * board occupies; one that honours it must not move it AT ALL. Mirrors the
 * exact technique `schedule-solver-telemetry.test.ts`'s parked-card specs use,
 * for the same reason: two runs of the same solver over the same input can
 * otherwise coincide by construction, which would make "unchanged" true
 * whether or not the lock was ever read.
 */
async function parkAndLock(auth: AuthCtx, stageId: string, fixtureId: string): Promise<void> {
  await applySchedule(auth, stageId, {
    assignments: [{ fixture_id: fixtureId, scheduled_at: at(600), court_label: "C2" }],
    source: "manual",
  });
  await patchFixture(auth, fixtureId, { schedule_locked: true });
}

/**
 * Companion to `parkAndLock`: locks via the division's `locked_scopes` (a
 * court scope), never touching the fixture's own `schedule_locked` — the
 * arm `lockedFixtureIds` (and Task 2's AI-draft predicate, and the Task 1
 * apply-time check) must honour from a scope alone. Parks the fixture on the
 * scoped court first, same atypical slot as `parkAndLock`, so the lock has
 * something to bite and "it stayed" cannot be a compacting solver's
 * coincidence.
 */
async function parkAndScopeLock(
  auth: AuthCtx,
  stageId: string,
  divisionId: string,
  fixtureId: string,
): Promise<void> {
  await applySchedule(auth, stageId, {
    assignments: [{ fixture_id: fixtureId, scheduled_at: at(600), court_label: "C2" }],
    source: "manual",
  });
  await setDivisionLocks(auth, divisionId, { locked_scopes: [{ courts: ["C2"] }] });
}

describe.skipIf(!HAS_DB)("BUILD honours a lock (owner report, 2026-08-12)", () => {
  it("a schedule_locked fixture stays at its time AND court across a second Auto-schedule click", async () => {
    const auth = await seedOrg();
    const { stageId, created } = await seedStage(auth, 4);

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
        court_label: a.court_label,
      })),
      source: "auto",
    });

    // Pin one fixture via the lock toggle, at a deliberately atypical slot.
    const target = first.assignments[0]!;
    await parkAndLock(auth, stageId, target.fixture_id);

    // Click 2: "Auto-schedule" again — the owner's exact reported sequence,
    // same body as click 1.
    const second = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });

    const proposed = second.assignments.find((a) => a.fixture_id === target.fixture_id);
    // BOTH time and court, matching the owner's report precisely ("Its time
    // AND court both changed").
    expect(proposed?.scheduled_at).toBe(at(600));
    expect(proposed?.court_label).toBe("C2");
  }, 180_000);
});

describe.skipIf(!HAS_DB)("REFLOW and POLISH keep honouring a lock, unchanged by the BUILD fix", () => {
  it("reflow and polish still leave a locked fixture exactly where it is", async () => {
    const auth = await seedOrg();
    const { stageId, created } = await seedStage(auth, 4);

    const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    expect(first.assignments).toHaveLength(created);
    await applySchedule(auth, stageId, {
      assignments: first.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });

    const target = first.assignments[0]!;
    await parkAndLock(auth, stageId, target.fixture_id);

    // REFLOW: the exact shape the Re-flow button sends
    // (`only_unlocked: true`, no explicit mode — the default derivation).
    const reflow = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    const reflowed = reflow.assignments.find((a) => a.fixture_id === target.fixture_id);
    expect(reflowed?.scheduled_at).toBe(at(600));
    expect(reflowed?.court_label).toBe("C2");

    // POLISH: the exact shape the Polish button sends
    // (`only_unlocked: true, mode: "polish"`, per schedule-board-polish.test.tsx).
    const polish = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "polish" });
    const polished = polish.assignments.find((a) => a.fixture_id === target.fixture_id);
    expect(polished?.scheduled_at).toBe(at(600));
    expect(polished?.court_label).toBe("C2");
  }, 180_000);
});

describe.skipIf(!HAS_DB)("ignore_locks is the explicit escape hatch", () => {
  it("keeps a lock by default and moves it only when ignore_locks is set, both reflected in locked_kept", async () => {
    const auth = await seedOrg();
    const { stageId, created } = await seedStage(auth, 4);

    const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    expect(first.assignments).toHaveLength(created);
    await applySchedule(auth, stageId, {
      assignments: first.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });

    const target = first.assignments[0]!;
    await parkAndLock(auth, stageId, target.fixture_id);

    // Without the escape hatch: the fix under test — stays put, and the
    // response says exactly one fixture was held for being locked.
    const kept = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    const keptCard = kept.assignments.find((a) => a.fixture_id === target.fixture_id);
    expect(keptCard?.scheduled_at).toBe(at(600));
    expect(keptCard?.court_label).toBe("C2");
    expect(kept.solver.locked_kept).toBe(1);

    // WITH the escape hatch: the one explicit way to override a lock — moves,
    // and the response says nothing was held back.
    const moved = await autoSchedule(auth, stageId, {
      only_unlocked: false,
      mode: "build",
      ignore_locks: true,
    });
    const movedCard = moved.assignments.find((a) => a.fixture_id === target.fixture_id);
    expect(movedCard?.scheduled_at).not.toBe(at(600));
    expect(moved.solver.locked_kept).toBe(0);
  }, 180_000);
});

describe.skipIf(!HAS_DB)(
  "a locked_scopes scope lock is honoured end-to-end in BUILD (gap review flagged)",
  () => {
    it("a court scope lock — no schedule_locked flag involved — keeps its fixture in place across a second Auto-schedule click", async () => {
      const auth = await seedOrg();
      const { stageId, divisionId, created } = await seedStage(auth, 4);

      const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
      expect(first.assignments).toHaveLength(created);
      await applySchedule(auth, stageId, {
        assignments: first.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
        })),
        source: "auto",
      });

      const target = first.assignments[0]!;
      await parkAndScopeLock(auth, stageId, divisionId, target.fixture_id);

      // Same click the owner's report reproduced — `only_unlocked: false`,
      // `mode: "build"` — but this time the lock comes ONLY from the
      // division's `locked_scopes`; `target`'s own `schedule_locked` stays
      // false throughout.
      const second = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
      const proposed = second.assignments.find((a) => a.fixture_id === target.fixture_id);
      expect(proposed?.scheduled_at).toBe(at(600));
      expect(proposed?.court_label).toBe("C2");
    }, 180_000);
  },
);

describe.skipIf(!HAS_DB)(
  "a scope-locked fixture is fed to the AI draft with its locked anchor AND marked pinned (#pins-in-build Task 2 + Task 4)",
  () => {
    it("buildSchedulePack's generate-mode draft keeps a court-scope-locked fixture at its parked slot, and PackFixture.pinned is true for it", async () => {
      const auth = await seedOrg();
      const { stageId, divisionId, created } = await seedStage(auth, 4);

      const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
      expect(first.assignments).toHaveLength(created);
      await applySchedule(auth, stageId, {
        assignments: first.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
        })),
        source: "auto",
      });

      const target = first.assignments[0]!;
      await parkAndScopeLock(auth, stageId, divisionId, target.fixture_id);

      const { pack } = await buildSchedulePack(auth, divisionId, {
        now: Date.parse(T0),
        mode: "generate",
        instruction: "Schedule the remaining fixtures.",
      });
      const drafted = pack.draft.find((d) => d.fixture_id === target.fixture_id);
      expect(drafted, `draft is missing fixture ${target.fixture_id}`).toBeDefined();
      expect(drafted!.scheduled_at).not.toBeNull();
      // Compared on the instant, not the rendered string: the pack renders
      // in the ORG zone (`zonedIso`), which may not spell the same offset
      // `at()` does even when it names the same instant.
      expect(Date.parse(drafted!.scheduled_at as string)).toBe(Date.parse(at(600)));
      expect(drafted!.court_label).toBe("C2");

      // Task 4: `PackFixture.pinned` (feeds `structuralCheck` and
      // `toEngineAssignments`'s `pinnedIds`) used to be `f.schedule_locked`
      // alone — a scope-locked-only fixture read as NOT pinned there even
      // though the draft anchor above already held it. Not `.toBe(true)` by
      // accident: `target.fixture_id` is asserted absent from `schedule_locked`
      // via `parkAndScopeLock`, which never touches the fixture's own flag.
      const pinnedFixture = pack.fixtures.movable.find((f) => f.id === target.fixture_id);
      expect(pinnedFixture, `movable is missing fixture ${target.fixture_id}`).toBeDefined();
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
    court_label: "C1",
    venue: null,
    status: "scheduled",
    schedule_locked: false,
    winner_to_fixture: null,
    loser_to_fixture: null,
  };
  const scopeOnC9: LockedScope[] = [{ courts: ["C9"] }];

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
    const f = { ...base, court_label: "C9" };
    expect(lockedFixtureIds([f], scopeOnC9, false)).toEqual(new Set(["f1"]));
  });

  it("excludes a schedule_locked fixture with no placement to anchor to", () => {
    const noTime = { ...base, schedule_locked: true, scheduled_at: null };
    expect(lockedFixtureIds([noTime], [], false)).toEqual(new Set());
    const noCourt = { ...base, schedule_locked: true, court_label: null };
    expect(lockedFixtureIds([noCourt], [], false)).toEqual(new Set());
  });

  it("ignoreLocks suppresses every lock, schedule_locked and scope-locked alike", () => {
    const f = { ...base, schedule_locked: true, court_label: "C9" };
    expect(lockedFixtureIds([f], scopeOnC9, true)).toEqual(new Set());
  });

  it("only_unlocked has no say here — the predicate takes no such argument", () => {
    // Regression guard, structural rather than behavioural: the whole bug was
    // `only_unlocked` gating this exact test. There is no parameter left to
    // gate it with.
    expect(lockedFixtureIds.length).toBe(3);
  });
});
