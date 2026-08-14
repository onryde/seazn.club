// Regression (design/fix-ui/03-console-division.md "Group-stage 'Générer les
// matchs' gives a misleading success message when it generates nothing"): a
// Groups+Knockout division with too few entrants (2, snake-distributed across
// e.g. 4 configured groups) used to return `{ created: 0, existing: 0 }` from
// generateStageFixtures — the exact same shape the client treats as "already
// generated, run again, nothing changed" (msg schedule.notice.nothingNew,
// green success banner) — even though ZERO fixtures had ever been created and
// the phase card still read "no matches yet". The precondition failure (not
// enough entrants to fill the groups) must throw a distinguishable error
// instead of silently no-op'ing as a success.
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { EngineError } from "@seazn/engine/core";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
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
    insert into organizations (name, slug) values (${"Gp " + suffix}, ${"gp-" + suffix})
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
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

async function seedDivision(auth: AuthCtx, names: string[]) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Gp Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open Singles",
    slug: "open-singles",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    names.map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  return { division, entrants };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)(
  "generateStageFixtures — group-stage precondition (not a silent no-op)",
  () => {
    it("throws STAGE_NOT_READY with reason group_too_few_entrants instead of created:0/existing:0", async () => {
      const { auth } = await seedOrg();
      // 2 entrants, 4 configured groups: passes the >=2 total-entrants gate but
      // snake-distributes to 0/1 entrant per group — nothing to pair.
      const { division } = await seedDivision(auth, ["Alice", "Bob"]);
      const [stage] = await createStages(auth, division.id, {
        seq: 1,
        kind: "group",
        name: "Group stage",
        config: { pools: { count: 4 } },
        qualification: null,
      });

      await expect(generateStageFixtures(auth, stage!.id)).rejects.toMatchObject({
        code: "STAGE_NOT_READY",
      });

      try {
        await generateStageFixtures(auth, stage!.id);
        expect.unreachable("expected generateStageFixtures to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        const e = err as EngineError;
        expect(e.code).toBe("STAGE_NOT_READY");
        expect((e.data as { reason?: string }).reason).toBe("group_too_few_entrants");
      }

      // No fixtures were created by the failed attempt — this is a
      // precondition failure, not a partial/degenerate success.
      const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text from fixtures where stage_id = ${stage!.id}`;
      expect(Number(count)).toBe(0);
    });

    it("still generates normally once enough entrants fill the groups", async () => {
      const { auth } = await seedOrg();
      const names = Array.from({ length: 8 }, (_, i) => `E${i + 1}`);
      const { division } = await seedDivision(auth, names);
      const [stage] = await createStages(auth, division.id, {
        seq: 1,
        kind: "group",
        name: "Group stage",
        config: { pools: { count: 4 } },
        qualification: null,
      });

      const { created } = await generateStageFixtures(auth, stage!.id);
      expect(created).toBeGreaterThan(0);
    });
  },
);

// F2a (P7 follow-up, 2026-08-14): the SEEDED-path analogue of the suite
// above. A `.seeding` stage's entrants are synthetic placed seeds
// (`slot:1..N`, from `.seeding.take` — see stage-seeding.ts, pure/no DB), not
// real division entrants, so the source stage here needs no entrants,
// fixtures, or even generation of its own — only its SHAPE matters, and a
// "league" source's shape (poolKeys: []) doesn't even need that for a
// `rankRange` take rule. generateSeededStageFixtures' only pre-existing
// guard is `placed.length < 2` (the seeding analogue of the plain path's
// `entrants.length < 2`) — it had NO analogue of `group_too_few_entrants`,
// so a group target whose placed seeds snake-distribute unevenly across its
// pools used to commit a PARTIAL fill (some pools get fixtures, a 0/1-seed
// pool doesn't) instead of throwing, and the stranded seed could never be
// seeded afterward (computeSeedProposal 422s SEEDING_RULES_MISSING forever —
// "regenerate them first" cannot work, since `generate()` is deterministic
// and newRows is keyed by ext_key).
describe.skipIf(!HAS_DB)(
  "generateSeededStageFixtures — seeded group-stage precondition (F2a, P7 follow-up)",
  () => {
    async function seedStagedDivision(auth: AuthCtx) {
      const comp = await createCompetition(auth, {
        ends_on: "2030-12-31",
        name: "Gp Seed Cup " + randomUUID().slice(0, 6),
        visibility: "private",
        branding: {},
      });
      return createDivision(auth, comp.id, {
        name: "Open Singles",
        slug: "open-singles-seed-" + randomUUID().slice(0, 6),
        sport_key: "generic",
        variant_key: "score",
        config: GENERIC_CONFIG,
        eligibility: [],
      });
    }

    it("throws STAGE_NOT_READY reason=seeded_pool_too_few_qualifiers BEFORE inserting any row, instead of committing a partial fill that 422s forever", async () => {
      const { auth } = await seedOrg();
      const division = await seedStagedDivision(auth);
      const stages = await createStages(auth, division.id, [
        { seq: 1, kind: "league", name: "Source", config: {}, qualification: null },
        {
          seq: 2,
          kind: "group",
          name: "Groups",
          // 6 qualifiers snake-distributed into 4 pools: A=[1] B=[2] C=[3,6]
          // D=[4,5] — roundRobinGen emits nothing for A/B (1 entrant each),
          // so seeds 1 and 2 are stranded even though gen.length > 0 overall
          // (C and D DO produce fixtures) — the exact partial-fill case a
          // naive `gen.length === 0` check would miss.
          config: { pools: { count: 4 } },
          qualification: null,
          seeding: { source: "previous", take: [{ kind: "rankRange", from: 1, to: 6 }], placement: "rank_order" },
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
        expect(data.groups).toBe(4);
        expect(data.qualifiers).toBe(6);
        // Minor 2 (P7 fix round, whole-branch review): `required` (the
        // Math.max(2, groups * 2) computation, stages.ts:1457) was computed
        // but never asserted by the only test that runs the real guard.
        expect(data.required).toBe(8);
        expect(data.stranded).toBe(2);
      }

      // Nothing partial was committed — the transaction failed cleanly.
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from fixtures where stage_id = ${target.id}`;
      expect(Number(count)).toBe(0);
    });

    it("still generates normally once enough qualifiers fill the pools", async () => {
      const { auth } = await seedOrg();
      const division = await seedStagedDivision(auth);
      const stages = await createStages(auth, division.id, [
        { seq: 1, kind: "league", name: "Source", config: {}, qualification: null },
        {
          seq: 2,
          kind: "group",
          name: "Groups",
          config: { pools: { count: 4 } },
          qualification: null,
          seeding: { source: "previous", take: [{ kind: "rankRange", from: 1, to: 8 }], placement: "rank_order" },
        },
      ]);
      const target = stages.find((s) => s.seq === 2)!;

      const { created } = await generateStageFixtures(auth, target.id);
      expect(created).toBeGreaterThan(0);
    });
  },
);
