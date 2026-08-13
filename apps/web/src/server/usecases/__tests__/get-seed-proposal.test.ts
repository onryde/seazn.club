// getSeedProposal — P6/D4b task B's read-only usecase (plan's ruling: "There
// is no read path for a proposal... A panel that renders on page load
// therefore cannot read its own state, and it must not POST to find out:
// recompute has side effects"). Real Postgres, full pipeline — mirrors
// stage-progression.test.ts's setupGroupsToKnockout shape (2 pools of 2,
// topNPerGroup(1) -> 2 qualifiers, no ties) at a smaller scale since this
// suite only needs to prove the READ semantics, not the compute engine.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import {
  completeStage,
  confirmSeedProposal,
  computeSeedProposal,
  createStages,
  generateStageFixtures,
  getSeedProposal,
} from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

async function setup() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "GetProposal " + randomUUID().slice(0, 6),
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
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const stages = await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
    {
      seq: 2,
      kind: "knockout",
      name: "KO",
      config: {},
      seeding: { source: "previous", take: [{ kind: "topNPerGroup", n: 1 }], placement: "rank_order" },
    },
  ]);
  const groupStageId = stages.find((s) => s.kind === "group")!.id;
  const koStageId = stages.find((s) => s.kind === "knockout")!.id;
  await generateStageFixtures(auth, koStageId); // TBD fixtures up front
  await generateStageFixtures(auth, groupStageId);
  const groupFixtures = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${groupStageId}`;
  for (const f of groupFixtures) {
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  }
  await completeStage(auth, groupStageId); // computes the first draft proposal
  return { auth, koStageId };
}

describe.skipIf(!HAS_DB)("getSeedProposal — read-only, P6/D4b task B", () => {
  it("returns null for a .seeding stage that has never had a proposal computed", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "NoProposal " + randomUUID().slice(0, 6),
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
    const stages = await createStages(auth, division.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        seeding: { source: "previous", take: [{ kind: "topNPerGroup", n: 1 }], placement: "rank_order" },
      },
    ]);
    const koStageId = stages.find((s) => s.kind === "knockout")!.id;
    await generateStageFixtures(auth, koStageId);

    expect(await getSeedProposal(auth, koStageId)).toBeNull();
  });

  it("matches computeSeedProposal's own return value exactly (id, status, computed)", async () => {
    const { auth, koStageId } = await setup();
    const computed = await computeSeedProposal(auth, koStageId);
    const read = await getSeedProposal(auth, koStageId);
    expect(read).toEqual(computed);
  });

  it("after a recompute, returns the NEWEST draft — not the now-stale original", async () => {
    const { auth, koStageId } = await setup();
    const first = await computeSeedProposal(auth, koStageId);
    const second = await computeSeedProposal(auth, koStageId); // marks `first` stale, inserts a new draft
    expect(second.id).not.toBe(first.id);

    const read = await getSeedProposal(auth, koStageId);
    expect(read!.id).toBe(second.id);
    expect(read!.status).toBe("draft");
  });

  it("after confirm, reflects status 'confirmed' on the SAME proposal id (confirm updates, never inserts)", async () => {
    const { auth, koStageId } = await setup();
    const proposal = await computeSeedProposal(auth, koStageId);
    await confirmSeedProposal(auth, koStageId, { proposalId: proposal.id });

    const read = await getSeedProposal(auth, koStageId);
    expect(read!.id).toBe(proposal.id);
    expect(read!.status).toBe("confirmed");
  });

  it("is read-only — repeated calls before any compute insert NO rows (the ruling's core safety property: a panel rendering on page load must not create side effects)", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "ReadOnly " + randomUUID().slice(0, 6),
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
    const stages = await createStages(auth, division.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        seeding: { source: "previous", take: [{ kind: "topNPerGroup", n: 1 }], placement: "rank_order" },
      },
    ]);
    const koStageId = stages.find((s) => s.kind === "knockout")!.id;
    await generateStageFixtures(auth, koStageId);

    await getSeedProposal(auth, koStageId);
    await getSeedProposal(auth, koStageId);
    await getSeedProposal(auth, koStageId);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from stage_seed_proposals where stage_id = ${koStageId}`;
    expect(n).toBe(0);
  });
});
