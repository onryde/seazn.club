// W4 app B, T18 fix I-1: reversing a decided title (Undo joint winners; Reinstate a finalist of a vacant final) is refused
// VACANT_TITLE_ALREADY_SEEDED only when a later stage REALLY drew from this stage's ranks. A Plate (`firstLosses` only) is
// confirmed after round 2 and never depends on the final, so it must not block (RB4-C3, X-CH-4). Real Postgres; the plate rig's
// own Knockout + Plate division, scored through the scorer's events; the dependent stage of the negative case is a real
// rank-taking stage (`rankRange` 1-2 of the knockout), confirmed.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe", async (io) => ({
  ...(await io<typeof import("@/lib/stripe")>()),
  getStripe: vi.fn(() => {
    throw new Error("this suite makes no Stripe call");
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

import { sql } from "@/lib/db";
import { patchEntrant, writeEntrantPatch } from "../entrants";
import { declareJointWinners, undoJointWinners } from "../joint-winners";
import { completeStage } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { BADMINTON_PICK, FOOTBALL_PICK, linesOf, plateRig, playRound, type PlateRig } from "./_plate-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const stageStatus = async (id: string) => (await sql<{ status: string }[]>`select status from stages where id = ${id}`)[0]!.status;
const plateState = async (rig: PlateRig) => ({
  proposals: await sql`select status from stage_seed_proposals where stage_id = ${rig.plateId} order by created_at, id`,
  lines: await sql`select id, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${rig.plateId} order by id`,
  status: await stageStatus(rig.plateId),
});

/** A 4-entrant Knockout + Plate, round 1 played (the plate's field is complete and auto-confirmed), the final seated and unplayed. */
async function plateConfirmedFinalSeated(pick: typeof FOOTBALL_PICK) {
  const rig = await plateRig(4, { autoProgress: true, ...pick });
  await playRound(rig, 1);
  const [proposal] = await sql<{ status: string }[]>`select status from stage_seed_proposals where stage_id = ${rig.plateId}`;
  expect(proposal?.status, "premise: the plate is confirmed before the title is touched").toBe("confirmed");
  const final = (await linesOf(rig.mainId)).find((l) => l.home_entrant_id && l.away_entrant_id && l.round_no === 2)!;
  expect(final, "premise: the final is seated").toBeDefined();
  return { rig, final };
}

describe.skipIf(!HAS_DB)("W4 B5b T18 fix I-1: a Plate never blocks a title reversal", () => {
  for (const pick of [FOOTBALL_PICK, BADMINTON_PICK]) {
    it(`(a) Knockout + Plate, plate confirmed, final ruled joint: Undo succeeds, the title is undecided, the plate is untouched (${pick.sport.key})`, async () => {
      const { rig, final } = await plateConfirmedFinalSeated(pick);
      await declareJointWinners(rig.auth, final.id);
      expect(await stageStatus(rig.mainId), "premise: the joint ruling completed the main stage").toBe("complete");
      const plateBefore = await plateState(rig);
      const out = await undoJointWinners(rig.auth, final.id);
      expect(out).toEqual({ fixture_id: final.id, status: "scheduled" });
      expect(await stageStatus(rig.mainId)).toBe("active");
      const [row] = await sql<{ status: string; joint_winners_at: Date | null }[]>`select status, joint_winners_at from fixtures where id = ${final.id}`;
      expect([row!.status, row!.joint_winners_at]).toEqual(["scheduled", null]);
      expect(await plateState(rig), "the plate is exactly as it was").toEqual(plateBefore);
    });

    it(`(b) Knockout + Plate, both finalists withdraw (vacant), Reinstate one: the title reverses to that finalist, the plate is untouched (${pick.sport.key})`, async () => {
      const { rig, final } = await plateConfirmedFinalSeated(pick);
      const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
      await writeEntrantPatch(rig.auth, a, { status: "withdrawn" });
      await withdrawEntrantCascade(rig.auth, b, { as: "withdrawn" });
      expect((await completeStage(rig.auth, rig.mainId)).completed, "premise: the vacant final completes the stage").toBe(true);
      const plateBefore = await plateState(rig);
      await patchEntrant(rig.auth, a, { status: "confirmed" });
      const [row] = await sql<{ status: string; outcome: { kind?: string } | null }[]>`select status, outcome from fixtures where id = ${final.id}`;
      // The other finalist is still out: the reinstated one is awarded the title (a walkover), the stage stays complete.
      expect(row!.outcome, "the vacant title reversed to the reinstated finalist").toMatchObject({ kind: "award", winner: a, loser: b });
      expect(await plateState(rig), "the plate is exactly as it was").toEqual(plateBefore);
    });
  }

  it("(c) a later stage that TAKES this stage's ranks (rankRange 1-2), confirmed, still refuses Undo and Reinstate by name", async () => {
    const { rig, final } = await plateConfirmedFinalSeated(FOOTBALL_PICK);
    // A rank-taking dependent: a knockout stage after the plate that takes ranks 1-2 of the main knockout, its seed proposal confirmed.
    const [next] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name, status, config, progression)
      select division_id, org_id, 3, 'knockout', 'Finals', 'pending', '{}'::jsonb,
             ${sql.json({ timing: "setup", placement: "rank_order", sources: [{ stage: { stageId: rig.mainId }, take: [{ kind: "rankRange", from: 1, to: 2 }] }] } as never)}
        from stages where id = ${rig.mainId} returning id`;
    await sql`insert into stage_seed_proposals (org_id, stage_id, computed, status, confirmed_at)
              select org_id, ${next!.id}, '{}'::jsonb, 'confirmed', now() from stages where id = ${rig.mainId}`;
    await declareJointWinners(rig.auth, final.id);
    await expect(undoJointWinners(rig.auth, final.id)).rejects.toMatchObject({ status: 409, code: "VACANT_TITLE_ALREADY_SEEDED" });
    expect(await stageStatus(rig.mainId), "the refusal left the stage complete").toBe("complete");
  });
});
