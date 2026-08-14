// C4 (z3 retirement, stage A): REFLOW routed through the placement CP-SAT
// service instead of z3's repair solver.
//
// These specs prove the wiring switch AND the churn-minimization ruling it
// depends on: `reflowExisting` now calls `buildSchedule` with the already-
// placed unlocked cards (`placedNow`) added to `frozen`/`current` alongside
// the locked ones (`pinnedNow`) — the same mechanism POLISH already uses
// (R20). See `docs/superpowers/specs/2026-08-12-release2-prompts/C4-z3-reflow-cpsat.md`
// and the design doc's stage A.
//
// A GENUINE GAP FOUND THIS SESSION, beyond the brief's literal scope: a
// `frozen` id anchored only via `current` (no `.locked`) is NOT safe on
// EVERY `buildSchedule` exit. The success/`improved` path anchors it
// correctly (via `pinnedAssignments`), but every FALLBACK exit —
// `already_optimal`, `verifier_rejected`, `not_searched`, a proved tie —
// reports `seed.assignments`, the PLAIN unpinned greedy seed, which has no
// idea a `current`-only id is supposed to stay put (confirmed empirically:
// a throwaway two-fixture repro against unmodified `build.ts` swapped both
// fixtures' courts). This is the MOST COMMON reflow shape, not a corner —
// any reflow over a mostly-already-placed board lands here whenever the
// solver ties or fails to improve on the naive seed. `reflowExisting`
// therefore RECONCILES: every frozen id's slot in the final board is read
// from `placedNow`/`pinnedNow` directly, never trusted off `buildSchedule`'s
// own `assignments`, regardless of which exit produced them. The tests below
// are what would have caught the naive "just call buildSchedule and forward
// its output" swap.
//
// Real Postgres AND a real placement service are required for these specs
// (see `HAS_SOLVER` below) — the whole point is proving the REAL solver
// respects the pins, not a mock standing in for it.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { applySchedule, autoSchedule, putScheduleSettings } from "../schedule";

const HAS_DB = !!process.env.DATABASE_URL;
/** See `schedule-solver-telemetry.test.ts`'s identical constant and comment:
 *  without a reachable placement service `build.ts` falls back to a greedy
 *  board carrying `status: "solver_unavailable"`, which is correct behaviour
 *  but proves nothing about the real solver honouring a pin. */
const HAS_SOLVER = !!process.env.PLACEMENT_SERVICE_HOST;

const T0 = "2026-08-01T09:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN).toISOString();

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
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function seedStage(
  auth: AuthCtx,
  entrants: number,
  config: Partial<Parameters<typeof putScheduleSettings>[2]["config"]> = {},
): Promise<{ divisionId: string; stageId: string }> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "C4 " + randomUUID().slice(0, 6),
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
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
      ...config,
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { divisionId: division.id, stageId: stage.id };
}

describe.skipIf(!HAS_DB)("REFLOW on the placement service (C4)", () => {
  // Test 1 (the wiring switch itself — "the placement client was called,
  // never repairSchedule") lives in the dedicated
  // `schedule-reflow-cpsat-wiring.test.ts`: it needs a file-scoped
  // `vi.mock` call-count interception, which must not leak into this
  // file's real-solver-dependent scenarios below. An earlier version of
  // this test asserted on `z3LoadCount()`/`solver.status` instead and was
  // VACUOUS — an all-unplaced board never needs z3 to boot even under the
  // unmodified z3-repair code (repairSchedule's "clean, no WASM" fast path
  // fires because a freshly greedy-seeded board has nothing to repair), so
  // it passed before AND after the swap for unrelated reasons. Direct call
  // interception has no such blind spot.

  // -------------------------------------------------------------------
  // 2. Churn minimization: the owner's ruling, proven rather than described.
  // -------------------------------------------------------------------
  it(
    "an already-placed unlocked card keeps its exact slot when reflow has other work to do",
    async () => {
      const auth = await seedOrg();
      const { stageId } = await seedStage(auth, 4);

      const built = await autoSchedule(auth, stageId, {
        only_unlocked: false,
        mode: "build",
      });
      await applySchedule(auth, stageId, {
        assignments: built.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
        })),
        source: "auto",
      });

      // Empty exactly one fixture's slot — "other work to do" (an unplaced
      // card) alongside five already-legally-placed, UNLOCKED ones. None of
      // the five is schedule_locked, so under the naive "just forward
      // buildSchedule's output" swap this session's finding warns about,
      // ANY of them could silently move.
      const before = await sql<
        { id: string; scheduled_at: Date; court_label: string }[]
      >`select id, scheduled_at, court_label from fixtures where stage_id = ${stageId} order by id`;
      const toClear = before[0]!;
      await sql`
        update fixtures set scheduled_at = null, court_label = null
        where id = ${toClear.id}`;

      const out = await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "reflow",
      });

      const proposed = new Map(out.assignments.map((a) => [a.fixture_id, a]));
      for (const row of before) {
        if (row.id === toClear.id) continue;
        // Byte-identical: exact instant AND exact court, not merely "still
        // scheduled somewhere".
        expect(proposed.get(row.id)?.scheduled_at).toBe(row.scheduled_at.toISOString());
        expect(proposed.get(row.id)?.court_label).toBe(row.court_label);
      }

      // The other half: the run demonstrably did something.
      expect(proposed.get(toClear.id)?.scheduled_at).not.toBeUndefined();

      // Consequence of the ruling, stated as its own assertion: REFLOW can
      // only place cards with no slot yet, so `moved` now always equals
      // `seeded` (see the `lost`/`moved` comment in `reflowExisting`).
      expect(out.solver.moved).toBe(out.solver.seeded);
    },
    120_000,
  );

  // -------------------------------------------------------------------
  // 3. The trade-off's edge: two already-placed unlocked cards collide.
  // -------------------------------------------------------------------
  it(
    "two already-placed unlocked cards on a colliding slot: does not crash, reports the conflict",
    async () => {
      const auth = await seedOrg();
      const { stageId } = await seedStage(auth, 4);

      const built = await autoSchedule(auth, stageId, {
        only_unlocked: false,
        mode: "build",
      });
      await applySchedule(auth, stageId, {
        assignments: built.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
        })),
        source: "auto",
      });

      // Force two UNLOCKED, already-placed cards onto one court at one
      // instant. Written straight to the table, not through `applySchedule`
      // — the write gate would (correctly) refuse to create this board, and
      // refusing to create one is not the same as never having to read one
      // (same technique `schedule-reflow-verifier-widening.test.ts` uses).
      const rows = await sql<{ id: string; scheduled_at: Date; court_label: string }[]>`
        select id, scheduled_at, court_label from fixtures
        where stage_id = ${stageId} order by id`;
      const [a, b] = rows;
      await sql`
        update fixtures set scheduled_at = ${a!.scheduled_at}, court_label = ${a!.court_label}
        where id = ${b!.id}`;

      // Ruling under test: REFLOW can no longer rearrange already-placed
      // unlocked cards to resolve a conflict AMONG them (owner-accepted
      // trade-off) — so this must not throw, and must not silently drop
      // either card.
      const out = await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "reflow",
      });

      expect(out.assignments.map((x) => x.fixture_id)).toEqual(
        expect.arrayContaining([a!.id, b!.id]),
      );
      const collision = out.conflicts.filter(
        (c) => c.fixture_id === a!.id || c.fixture_id === b!.id,
      );
      expect(collision.length).toBeGreaterThan(0);
      expect(collision.some((c) => c.blocking)).toBe(true);
    },
    120_000,
  );

  // -------------------------------------------------------------------
  // 4. Round-order closure: the gap named in the round-ordering spec.
  // -------------------------------------------------------------------
  it.skipIf(!HAS_SOLVER)(
    "never ships a round-order violation, even where a naive seed would have created one",
    async () => {
      const auth = await seedOrg();
      // Single court: the ONLY slot that respects round order against the
      // round-2 pin below is [T0, T0+30) — exactly one, for exactly two
      // free round-1 fixtures. A naive/order-blind greedy pass (what z3's
      // repair solver seeds unplaced cards with) places the first round-1
      // fixture there and is then FORCED to place the second one after the
      // round-2 pin — a genuine order violation z3 cannot see and would
      // ship. CP-SAT, which enforces round order pin-vs-movable (C1), can
      // place at most one of the two respecting order and must leave the
      // other genuinely unplaced (`no_slot`) rather than violate order.
      const { stageId } = await seedStage(auth, 4, {
        courts: ["C1"],
        sessionWindows: [{ from: T0, to: at(600) }],
      });

      const rows = await sql<{ id: string; round_no: number }[]>`
        select id, round_no from fixtures where stage_id = ${stageId} order by round_no, id`;
      const byRound = new Map<number, string[]>();
      for (const r of rows) {
        (byRound.get(r.round_no) ?? byRound.set(r.round_no, []).get(r.round_no)!).push(r.id);
      }
      const [r1a, r1b] = byRound.get(1)!;
      const [pin, round2Other] = byRound.get(2)!;
      const [round3a, round3b] = byRound.get(3)!;

      // Everything except round 1 is placed up front, internally
      // round-order-consistent, and leaves EXACTLY one legal (<=30) slot on
      // the single court for round 1's two free fixtures.
      await applySchedule(auth, stageId, {
        assignments: [
          { fixture_id: pin!, scheduled_at: at(30), court_label: "C1" },
          { fixture_id: round2Other!, scheduled_at: at(90), court_label: "C1" },
          { fixture_id: round3a!, scheduled_at: at(300), court_label: "C1" },
          { fixture_id: round3b!, scheduled_at: at(330), court_label: "C1" },
        ],
        source: "auto",
      });

      const out = await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "reflow",
      });

      // The four frozen cards never moved (churn-minimization again, on a
      // different board shape).
      const proposed = new Map(out.assignments.map((x) => [x.fixture_id, x]));
      expect(proposed.get(pin!)?.scheduled_at).toBe(at(30));
      expect(proposed.get(round2Other!)?.scheduled_at).toBe(at(90));
      expect(proposed.get(round3a!)?.scheduled_at).toBe(at(300));
      expect(proposed.get(round3b!)?.scheduled_at).toBe(at(330));

      // THE ASSERTION: no order violation ships, ever — not even for the
      // round-1 fixture that could not legally fit before the pin.
      expect(out.conflicts.some((c) => c.code === "warn.order")).toBe(false);

      // MEASURED (not assumed): this run's `solver.engine` is `"greedy"` —
      // the fallback exit — which reports the naive, pin-BLIND greedy seed
      // for the two FREE round-1 fixtures (the reconciliation above only
      // corrects FROZEN ids). Naive greedy fills r1a@T0 first (nothing
      // stops it) and, not knowing the pin reserves T0+30, tries to place
      // r1b there too — landing exactly on the reconciled pin's slot. That
      // is a court/person_overlap collision, correctly REPORTED rather than
      // silently shipped (the same "does not crash, does report" contract
      // as the two-frozen-cards-collide case above) — and it is still not
      // an ORDER violation, which is the property this test exists to
      // prove. Asserted structurally (whichever of r1a/r1b sorts first is
      // the clean one), not by hard-coded id, since only the ORDERING
      // relationship is guaranteed, not which generated id it lands on.
      const r1aConflicts = out.conflicts.filter((c) => c.fixture_id === r1a);
      const r1bConflicts = out.conflicts.filter((c) => c.fixture_id === r1b);
      expect([r1aConflicts.length === 0, r1bConflicts.length === 0].filter(Boolean)).toHaveLength(
        1,
      );
      const [cleanId, dirtyConflicts] =
        r1aConflicts.length === 0 ? [r1a, r1bConflicts] : [r1b, r1aConflicts];
      expect(proposed.get(cleanId!)?.scheduled_at).toBe(at(0));
      expect(dirtyConflicts.some((c) => c.blocking)).toBe(true);
      expect(dirtyConflicts.every((c) => c.code !== "warn.order")).toBe(true);
    },
    120_000,
  );
});
