// F2 Task 6 — the DB-integration half of the multi-source acceptance
// criterion (packages/engine/src/competition/progression.test.ts, Task 2,
// covers pure resolution/dedupe at the engine level; this proves
// seedNextStage's DB orchestration wires it correctly end to end).
//
// Finding 1 (this session's F2 plan): multi-source progression NEVER
// actually worked server-side before this session — the old
// `qualification.from` field was declared, zod-validated, and grep-confirmed
// never read anywhere. This is the first real coverage of it.
//
// Two independent completed stages (A, B) in the SAME division, each
// referenced by an EXPLICIT `{stageId}` (not "previous" — Final is not
// seq-adjacent to A) in Final's progression.sources[], each contributing its
// own rank-1 finisher. Decision 4's trigger stays "check the
// immediately-next stage when ANY stage completes" — Final IS seq-adjacent
// to B (seq 2 -> seq 3), so completing B (after A already completed) is
// what fires the auto-seed attempt; completing A first is a no-op (the
// stage immediately after A, by seq, is B, which has no progression).
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { EngineError } from "@seazn/engine/core";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { completeStage, createStages, generateStageFixtures } from "../stages";
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
    insert into organizations (name, slug) values (${"Ms " + suffix}, ${"ms-" + suffix})
    returning id`;
  // pro: 3 stages (A, B, Final) > community's stages.per_division.max.
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

async function seedDivisionWithTwoLeagues(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Ms Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  // Every "league" stage below draws from the WHOLE division entrant list
  // (generateStageFixtures' plain path) — 4 entrants play a full
  // round-robin in EACH of A and B independently (their `fixtures` rows are
  // per-stage, so the two round-robins are separate results even though
  // both involve all 4 people).
  const entrants = await createEntrants(
    auth,
    division.id,
    ["E1", "E2", "E3", "E4"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [a, b] = await createStages(auth, division.id, [
    { seq: 1, kind: "league", name: "A", config: {} },
    { seq: 2, kind: "league", name: "B", config: {} },
  ]);
  return { division, entrants, a: a!, b: b! };
}

/** Decide every fixture in `stageId` so `winnerId` wins every one of its
 *  matches (beats every opponent 2-0) and everyone else draws 1-1 among
 *  themselves — winnerId finishes rank 1 outright, unambiguously, no tie. */
async function decideLeagueWithWinner(auth: AuthCtx, stageId: string, winnerId: string): Promise<void> {
  const fixtures = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stageId}`;
  for (const f of fixtures) {
    const winnerInvolved = f.home_entrant_id === winnerId || f.away_entrant_id === winnerId;
    const homeIsWinner = f.home_entrant_id === winnerId;
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, {
      type: "generic.result",
      payload: winnerInvolved
        ? homeIsWinner
          ? { p1Score: 2, p2Score: 0 }
          : { p1Score: 0, p2Score: 2 }
        : { p1Score: 1, p2Score: 1 },
    });
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("multi-source progression (F2 Decision 4 / Finding 1)", () => {
  it("seeds a stage from TWO different completed source stages, in declaration order, deduped", async () => {
    const { auth } = await seedOrg();
    const { division, entrants, a, b } = await seedDivisionWithTwoLeagues(auth);
    const [e1, e2] = entrants;

    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: a.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "on_complete",
      },
    });

    await generateStageFixtures(auth, a.id);
    await generateStageFixtures(auth, b.id);
    // A's winner is e1; B's winner is e2 — two DIFFERENT entrants, so
    // resolution must succeed (no dedupe collision) and preserve
    // declaration order (A's qualifier first, B's second).
    await decideLeagueWithWinner(auth, a.id, e1!.id);
    await decideLeagueWithWinner(auth, b.id, e2!.id);

    // Completing A is a no-op for Final: A's own seq-adjacent successor is
    // B (seq 2), which has no progression.
    const completedA = await completeStage(auth, a.id);
    expect(completedA.completed).toBe(true);
    expect(completedA.qualified).toBeUndefined();

    // Completing B IS seq-adjacent to Final (seq 3) — this is what fires
    // the multi-source auto-seed, and by now A is already complete too.
    const completedB = await completeStage(auth, b.id);
    expect(completedB.completed).toBe(true);
    expect(completedB.qualified?.stage_id).toBe(final!.id);
    expect(completedB.qualified?.entrants).toEqual([e1!.id, e2!.id]);

    const [row] = await sql<{ config: { qualified?: string[] } }[]>`
      select config from stages where id = ${final!.id}`;
    expect(row!.config.qualified).toEqual([e1!.id, e2!.id]);
  });

  it("rejects an entrant qualifying through two sources — completeStage itself rejects (not swallowed), QUALIFICATION_INVALID", async () => {
    const { auth } = await seedOrg();
    const { division, entrants, a, b } = await seedDivisionWithTwoLeagues(auth);
    const [e1] = entrants;

    const [final] = await createStages(auth, division.id, {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: a.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: b.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "on_complete",
      },
    });
    void final;

    await generateStageFixtures(auth, a.id);
    await generateStageFixtures(auth, b.id);
    // SAME entrant (e1) wins BOTH A and B — resolveProgression must refuse
    // the duplicate rather than silently seeding the Final with one real
    // qualifier and a stray repeat.
    await decideLeagueWithWinner(auth, a.id, e1!.id);
    await decideLeagueWithWinner(auth, b.id, e1!.id);

    await completeStage(auth, a.id); // no-op for Final, same as above
    await expect(completeStage(auth, b.id)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "QUALIFICATION_INVALID"),
    );
    // completeStage's OWN completion (marking B complete, writing its
    // standings) is unaffected by the downstream seeding failure — only the
    // seed attempt itself rejects. Confirm B really did complete.
    const [[bRow]] = await Promise.all([
      sql<{ status: string }[]>`select status from stages where id = ${b.id}`,
    ]);
    expect(bRow!.status).toBe("complete");
  });
});
