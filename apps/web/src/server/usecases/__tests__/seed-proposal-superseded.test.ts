// W5 stress fix F5: confirming a draft that a newer `/seed-proposal` POST replaced answered 409 SEEDING_PROPOSAL_STALE
// "standings changed since this proposal was computed": nothing had changed, a newer draft had replaced it. It now says so
// (`reason: "superseded"`, the newer draft's id) and keeps the code, so every reader that takes SEEDING_PROPOSAL_STALE as "look
// again" (the progression panel's refresh, plate-field, quick-match advance, match-day MD_STALE) still does.
//
// Sport-agnostic (the proposal store knows no sport): one sport, the generic one the seeding suites use.
// Real Postgres; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { PROPOSAL_STALE_SUPERSEDED } from "@/lib/seeding-error";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Two pools of two, the group stage played and completed: the knockout holds its first draft. */
async function rig() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "F5 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  await createEntrants(auth, division.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const stages = await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
    { seq: 2, kind: "knockout", name: "KO", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }], placement: "rank_order", timing: "setup" } },
  ]);
  const groupId = stages.find((s) => s.kind === "group")!.id;
  const koId = stages.find((s) => s.kind === "knockout")!.id;
  await generateStageFixtures(auth, koId);
  await generateStageFixtures(auth, groupId);
  for (const f of await sql<{ id: string }[]>`select id from fixtures where stage_id = ${groupId}`) {
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  }
  await completeStage(auth, groupId);
  const [first] = await sql<{ id: string }[]>`select id from stage_seed_proposals where stage_id = ${koId} and status = 'draft'`;
  if (first === undefined) throw new Error("rig: completing the groups drafts the knockout's proposal");
  return { auth, koId, first: first.id };
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (!(e instanceof HttpError)) throw new Error(`expected an HttpError, got ${String(e)}`);
  return e;
}

describe.skipIf(!HAS_DB)("F5: a draft a newer one replaced says so", () => {
  it("the empty case first: a stale draft with NO newer one still says the standings changed (no reason)", { timeout: 60_000 }, async () => {
    const r = await rig();
    // The state the standings-change marker (seed-stale.ts) writes: the draft stale, nothing newer.
    await sql`update stage_seed_proposals set status = 'stale' where id = ${r.first}`;
    const e = await refusal(confirmSeedProposal(r.auth, r.koId, { proposalId: r.first }));
    expect([e.status, e.code]).toEqual([409, "SEEDING_PROPOSAL_STALE"]);
    expect(e.extra?.reason, "no newer draft: not superseded").toBeUndefined();
    expect(e.message).toMatch(/standings changed/);
  });

  it("A, then B: confirming A names B; B confirms; A asked again still names B", { timeout: 60_000 }, async () => {
    const r = await rig();
    const b = await computeSeedProposal(r.auth, r.koId); // the POST /seed-proposal the organiser's Recompute sends
    expect(b.id).not.toBe(r.first);
    const e1 = await refusal(confirmSeedProposal(r.auth, r.koId, { proposalId: r.first }));
    expect([e1.status, e1.code], "the code every look-again reader keys on").toEqual([409, "SEEDING_PROPOSAL_STALE"]);
    expect(e1.extra).toEqual({ reason: PROPOSAL_STALE_SUPERSEDED, newer: b.id });
    expect(e1.message).not.toMatch(/standings changed/);
    const done = await confirmSeedProposal(r.auth, r.koId, { proposalId: b.id });
    expect(done.filled, "B, the newer draft, seats both qualifiers").toBe(2);
    const e2 = await refusal(confirmSeedProposal(r.auth, r.koId, { proposalId: r.first }));
    expect(e2.extra).toEqual({ reason: PROPOSAL_STALE_SUPERSEDED, newer: b.id });
  });

  it("A, B, C: A names the NEWEST draft, C", { timeout: 60_000 }, async () => {
    const r = await rig();
    await computeSeedProposal(r.auth, r.koId);
    const c = await computeSeedProposal(r.auth, r.koId);
    const e = await refusal(confirmSeedProposal(r.auth, r.koId, { proposalId: r.first }));
    expect(e.extra).toEqual({ reason: PROPOSAL_STALE_SUPERSEDED, newer: c.id });
  });
});
