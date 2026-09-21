// A withdrawn entrant must not be either side of a ladder challenge.
//
// `issueChallenge` initialises `config.ladder_order` from the FIELD
// (`status in ('registered','confirmed')`) — but only on first use. After
// that the array is never pruned, and a withdrawal is a status flip that
// leaves her row (and her rung) in place, so the pre-existing guard
// (`ci < 0 || oi < 0`, "both players must be on the ladder") is a presence
// check that a departed entrant passes.
//
// Fixed at READ time rather than by pruning `config.ladder_order` on
// withdrawal: a pruned array cannot be un-pruned, and an entrant CAN be
// un-withdrawn (patchEntrant), which would otherwise cost her the rung she
// earned — `ladder_order` only initialises when it is empty, so she would
// never be re-seated at all. Read-time filtering also cannot leave stale
// config behind, which is the failure mode the prune has.
//
// BOTH directions are covered: she can be the challenger or the opponent,
// and a guard that only looks at one side is half a fix.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, issueChallenge } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** A 5-rung ladder with `challengeRange: 4`, so every pair in the test is in
 *  range and a refusal can only come from the guard under test — never from
 *  the range check standing in for it. */
async function ladder(): Promise<{ auth: AuthCtx; stageId: string; ids: string[] }> {
  const { auth } = await seedOrg("pro");
  await setOrgPlan(auth.orgId, "pro");
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Ladder " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 5 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `L${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "ladder" as never,
    name: "Club ladder",
    config: { challengeRange: 4 },
  });
  await generateStageFixtures(auth, stage!.id); // no-op: ladder fixtures are on demand
  return { auth, stageId: stage!.id, ids: entrants.map((e) => e.id) };
}

/** Force `config.ladder_order` to exist BEFORE the withdrawal, which is the
 *  only shape the defect lives in: the array is written once from the live
 *  field and never pruned again. A first challenge is how a real ladder gets
 *  its order, so this drives the real producer rather than writing config by
 *  hand. */
async function seatTheLadder(auth: AuthCtx, stageId: string, ids: string[]): Promise<string[]> {
  const out = await issueChallenge(auth, stageId, { challenger_id: ids[1]!, opponent_id: ids[0]! });
  return out.ladder_order;
}

describe.skipIf(!HAS_DB)("a withdrawn entrant is not challengeable (ladder)", () => {
  it("refuses a challenge ISSUED BY a withdrawn entrant, though she is still on the ladder array", async () => {
    const { auth, stageId, ids } = await ladder();
    const order = await seatTheLadder(auth, stageId, ids);
    expect(order).toContain(ids[4]!);

    await withdrawEntrantCascade(auth, ids[4]!);

    // Still present in the persisted order — the defect's precondition, not
    // an incidental detail: a prune-on-withdrawal fix would make this false
    // and the guard below untested.
    const [row] = await sql<{ config: { ladder_order: string[] } }[]>`
      select config from stages where id = ${stageId}`;
    expect(row!.config.ladder_order).toContain(ids[4]!);

    const err = await issueChallenge(auth, stageId, {
      challenger_id: ids[4]!,
      opponent_id: ids[2]!,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toMatch(/withdraw|no longer in this division/i);
  });

  it("refuses a challenge ISSUED TO a withdrawn entrant — the other direction", async () => {
    const { auth, stageId, ids } = await ladder();
    await seatTheLadder(auth, stageId, ids);
    await withdrawEntrantCascade(auth, ids[0]!);

    const err = await issueChallenge(auth, stageId, {
      challenger_id: ids[3]!,
      opponent_id: ids[0]!,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toMatch(/withdraw|no longer in this division/i);
  });

  it("refuses a DISQUALIFIED entrant too — the guard covers both departed statuses", async () => {
    const { auth, stageId, ids } = await ladder();
    await seatTheLadder(auth, stageId, ids);
    await sql`update entrants set status = 'disqualified' where id = ${ids[0]!}`;

    const err = await issueChallenge(auth, stageId, {
      challenger_id: ids[3]!,
      opponent_id: ids[0]!,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
  });

  it("still ALLOWS a challenge between two active entrants, and creates its fixture — the guard refuses the departed, not the field", async () => {
    const { auth, stageId, ids } = await ladder();
    await seatTheLadder(auth, stageId, ids);
    await withdrawEntrantCascade(auth, ids[4]!);

    const out = await issueChallenge(auth, stageId, {
      challenger_id: ids[3]!,
      opponent_id: ids[1]!,
    });
    const [fx] = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
      select home_entrant_id, away_entrant_id from fixtures where id = ${out.fixture_id}`;
    expect(fx!.home_entrant_id).toBe(ids[3]!);
    expect(fx!.away_entrant_id).toBe(ids[1]!);
  });

  it("creates NO fixture when the challenge is refused", async () => {
    const { auth, stageId, ids } = await ladder();
    await seatTheLadder(auth, stageId, ids);
    const [{ n: before }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${stageId}`;
    await withdrawEntrantCascade(auth, ids[4]!);

    await issueChallenge(auth, stageId, { challenger_id: ids[4]!, opponent_id: ids[2]! }).catch(
      () => null,
    );

    const [{ n: after }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${stageId}`;
    expect(after).toBe(before);
  });

  it("an un-withdrawn entrant keeps the rung she held — the fix prunes nothing", async () => {
    const { auth, stageId, ids } = await ladder();
    const order = await seatTheLadder(auth, stageId, ids);
    const rung = order.indexOf(ids[4]!);
    expect(rung).toBeGreaterThanOrEqual(0);

    await withdrawEntrantCascade(auth, ids[4]!);
    await sql`update entrants set status = 'confirmed' where id = ${ids[4]!}`;

    const out = await issueChallenge(auth, stageId, {
      challenger_id: ids[4]!,
      opponent_id: ids[2]!,
    });
    expect(out.ladder_order.indexOf(ids[4]!)).toBe(rung);
  });
});
