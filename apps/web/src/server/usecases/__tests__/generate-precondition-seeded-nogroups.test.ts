// P7 fix round (Major, whole-branch review of F2a): server-side coverage for
// the seeded-stage precondition guard's groups<=1 branch (stages.ts:1456-
// 1471) — the counterpart to the client classifier test added in
// stages-panel-generate-precondition.test.tsx.
//
// Investigated reachability first (this repo's own "prove it, don't assume
// it" rule). groups<=1 fires for EITHER a group-kind stage left at
// pools.count's default of 1, or any non-group kind (knockout, page_playoff,
// double_elim, stepladder, league). Neither can currently strand a seed
// through this repo's own generators:
//   - group/league with poolCount===1 (league, unconditionally) route
//     straight to roundRobinGen() over the FULL entrant list — the circle
//     method (packages/engine/src/scheduling/roundrobin.ts) provably visits
//     every real entrant at least once whenever real.length >= 2, which is
//     already guaranteed by the placed.length < 2 guard above this one.
//   - knockout/double_elim/stepladder always place every entrant (via a bye
//     award line when the bracket size doesn't divide evenly) or throw
//     CONFIG_INVALID on a malformed byes/slotOrder config — never a silent
//     drop (packages/engine/src/scheduling/bracket.ts: buildSingleElim's
//     slotOrder/byeEntrants validation requires every seed 1..n exactly
//     once; stepladder's game construction indexes every ordered[] slot).
//   - page_playoff throws CONFIG_INVALID for anything other than exactly 4
//     entrants, rather than silently using a subset.
// Empirically confirmed too: a seeded knockout target fed 6 qualifiers, and
// a seeded group target left at the pools.count default fed 3 qualifiers,
// both generate successfully today — neither reaches this branch.
//
// Same conclusion as F2 (stage-orphan-fixtures.test.ts) for a different
// hazard on this same follow-up: a defensive guard for a failure mode this
// repo's OWN generators don't currently produce, not a reachable user path
// today. To verify the guard ITSELF — not just its current unreachability —
// without touching stages.ts, this mocks ONLY generateSingleElim (the
// "knockout" case in stages.ts' generate() dispatcher) to return a bracket
// that drops one entrant, i.e. simulates exactly the engine regression this
// guard exists to catch, and confirms generateStageFixtures still throws
// the right STAGE_NOT_READY shape instead of committing a partial fill.
// Every other export of @seazn/engine/scheduling stays real (same partial-
// mock idiom as schedule-ai-solver.test.ts in this directory).
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { EngineError } from "@seazn/engine/core";

vi.mock("@seazn/engine/scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@seazn/engine/scheduling")>()),
  // Simulate an engine regression: a "knockout" bracket that never places
  // the LAST entrant anywhere (no home/away/award line references it) — the
  // exact shape the F2a guard exists to catch before any row is inserted.
  generateSingleElim: (opts: { entrants: readonly string[] }) => ({
    fixtures: [{ id: "mock-r0-i0", round: 0, home: opts.entrants[0], away: opts.entrants[1] }],
    rounds: 1,
  }),
}));

import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createStages, generateStageFixtures } from "../stages";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"GpNg " + suffix}, ${"gp-ng-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function seedStagedDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "GpNg Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  return createDivision(auth, comp.id, {
    name: "Open Singles",
    slug: "open-singles-ng-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)(
  "generateSeededStageFixtures — seeded precondition guard, groups<=1 branch (Major, P7 fix round)",
  () => {
    it("throws STAGE_NOT_READY reason=seeded_pool_too_few_qualifiers with groups=1 when a non-group kind strands a seed", async () => {
      const { auth } = await seedOrg();
      const division = await seedStagedDivision(auth);
      const stages = await createStages(auth, division.id, [
        { seq: 1, kind: "league", name: "Source", config: {}, qualification: null },
        {
          seq: 2,
          kind: "knockout",
          name: "KO",
          config: {},
          qualification: null,
          seeding: { source: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }], placement: "rank_order" },
        },
      ]);
      const target = stages.find((s) => s.seq === 2)!;

      try {
        await generateStageFixtures(auth, target.id);
        expect.unreachable("expected generateStageFixtures to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        const e = err as EngineError;
        expect(e.code).toBe("STAGE_NOT_READY");
        const data = e.data as {
          reason?: string;
          groups?: number;
          qualifiers?: number;
          required?: number;
          stranded?: number;
        };
        expect(data.reason).toBe("seeded_pool_too_few_qualifiers");
        expect(data.groups).toBe(1);
        expect(data.qualifiers).toBe(3);
        expect(data.required).toBe(2);
        expect(data.stranded).toBe(1);
      }

      // Nothing partial was committed — the transaction failed cleanly,
      // same guarantee as the groups>1 case (generate-precondition.test.ts).
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from fixtures where stage_id = ${target.id}`;
      expect(Number(count)).toBe(0);
    });
  },
);
