// stage_auto_actions — the one source of truth for Swiss auto-advance (spec
// docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md §4.2; plan Task 1).
//
// Every later task arms, fires and renders through this table, so the shape IS the contract. What is asserted
// is the behaviour a constraint exists for, never its catalog entry: "one live row per (stage, kind)" is proven
// by a refused second insert, CASCADE by deleting a stage and counting, RLS by reading as app_user from two orgs.
//
// The live set (waiting, pending, paused, blocked) is the controller's ruling on top of spec §4.2, which listed
// only three: a `paused` confirm row (a person is reviewing the proposal) is still the stage's live row, and a
// second one beside it would let the sweep fire the proposal the organiser is editing.
//
// single-sport: generic — the table carries no sport field and every constraint here is sport-blind.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createStages } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";

const HAS_DB = !!process.env.DATABASE_URL;

// From the spec §4.2 table and the controller's ruling — typed here, not read back from the migration.
const LIVE = ["waiting", "pending", "paused", "blocked"] as const;
const FINISHED = ["done", "cancelled"] as const;
const ROUND_KINDS = ["pair_round", "complete_stage"] as const;

type Kind = "pair_round" | "complete_stage" | "confirm_handoff";

interface Seeded {
  orgId: string;
  divisionId: string;
  /** The Swiss stage. */
  stageId: string;
  /** A second stage in the same division (the hand-off target). */
  nextStageId: string;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

async function seedSwiss(): Promise<Seeded> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Auto advance ${tag}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: `open-${tag}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const [swiss, next] = await createStages(auth, division.id, [
    { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null },
    { seq: 2, kind: "league", name: "Final pool", config: {}, progression: null },
  ]);
  return { orgId: auth.orgId, divisionId: division.id, stageId: swiss!.id, nextStageId: next!.id };
}

async function seedProposal(s: Seeded, stageId: string, status: "draft" | "stale" = "draft"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stage_seed_proposals (org_id, stage_id, computed, status)
    values (${s.orgId}, ${stageId}, ${sql.json({ qualifiers: [], ties: [] })}, ${status})
    returning id`;
  return row!.id;
}

interface Action {
  kind: Kind;
  state: string;
  stageId?: string;
  targetRound?: number | null;
  proposalId?: string | null;
}

/** One row, inserted on the privileged pool (as the cross-org sweep writes). A round kind defaults to round 1. */
async function insertAction(s: Seeded, a: Action): Promise<string> {
  const round = a.targetRound !== undefined ? a.targetRound : a.kind === "confirm_handoff" ? null : 1;
  const proposal = a.proposalId ?? null;
  const [row] = await sql<{ id: string }[]>`
    insert into stage_auto_actions (org_id, division_id, stage_id, kind, target_round, target_proposal_id, state)
    values (${s.orgId}, ${s.divisionId}, ${a.stageId ?? s.stageId}, ${a.kind}, ${round}, ${proposal}, ${a.state})
    returning id`;
  return row!.id;
}

async function countFor(stageId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from stage_auto_actions where stage_id = ${stageId}`;
  return r!.n;
}

describe.skipIf(!HAS_DB)("stage_auto_actions: one live row per (stage, kind)", () => {
  it.each(LIVE)("second live row for the same (stage, kind) is refused while the first is %s", async (first) => {
    const s = await seedSwiss();
    await insertAction(s, { kind: "pair_round", state: first, targetRound: 1 });
    // A second row in EVERY live state, at a different round: the key is (stage, kind), whatever the target.
    let refused = 0;
    for (const second of LIVE) {
      await expect(
        insertAction(s, { kind: "pair_round", state: second, targetRound: 2 }),
        `${first} then ${second}`,
      ).rejects.toMatchObject({ code: "23505", constraint_name: "stage_auto_actions_one_live" });
      refused++;
    }
    expect(refused).toBe(LIVE.length);
    expect(await countFor(s.stageId)).toBe(1);
  });

  it("a second live confirm on the same target stage is refused even for a different proposal", async () => {
    const s = await seedSwiss();
    const oldDraft = await seedProposal(s, s.nextStageId, "stale");
    const newDraft = await seedProposal(s, s.nextStageId, "draft");
    await insertAction(s, { kind: "confirm_handoff", state: "paused", stageId: s.nextStageId, proposalId: oldDraft });
    await expect(
      insertAction(s, { kind: "confirm_handoff", state: "pending", stageId: s.nextStageId, proposalId: newDraft }),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "stage_auto_actions_one_live" });
  });

  it("the key is (stage, kind): another kind on the same stage, and the same kind on another stage, are both allowed", async () => {
    const s = await seedSwiss();
    await insertAction(s, { kind: "pair_round", state: "pending" });
    await insertAction(s, { kind: "complete_stage", state: "waiting", targetRound: 3 });
    await insertAction(s, { kind: "pair_round", state: "pending", stageId: s.nextStageId });
    expect(await countFor(s.stageId)).toBe(2);
    expect(await countFor(s.nextStageId)).toBe(1);
  });

  it("a done or cancelled row does not block a new live row", async () => {
    const s = await seedSwiss();
    // History accumulates: finished rows never collide with each other either.
    let finished = 0;
    for (const state of FINISHED) {
      await insertAction(s, { kind: "pair_round", state, targetRound: 1 });
      await insertAction(s, { kind: "pair_round", state, targetRound: 2 });
      finished += 2;
    }
    expect(finished).toBe(2 * FINISHED.length);
    await insertAction(s, { kind: "pair_round", state: "pending", targetRound: 3 });
    expect(await countFor(s.stageId)).toBe(finished + 1);
    // …and the index is still live behind them: the next live row is refused.
    await expect(insertAction(s, { kind: "pair_round", state: "waiting", targetRound: 3 })).rejects.toMatchObject({
      code: "23505",
      constraint_name: "stage_auto_actions_one_live",
    });
  });
});

describe.skipIf(!HAS_DB)("stage_auto_actions: closed sets and the target shape", () => {
  it("every declared state is accepted and an unknown one is refused", async () => {
    const s = await seedSwiss();
    let accepted = 0;
    for (const state of [...LIVE, ...FINISHED]) {
      const id = await insertAction(s, { kind: "pair_round", state });
      await sql`delete from stage_auto_actions where id = ${id}`;
      accepted++;
    }
    expect(accepted).toBe(6);
    await expect(insertAction(s, { kind: "pair_round", state: "running" })).rejects.toMatchObject({
      code: "23514",
      constraint_name: "stage_auto_actions_state_valid",
    });
  });

  it("an unknown kind is refused", async () => {
    const s = await seedSwiss();
    await expect(
      insertAction(s, { kind: "reopen_stage" as Kind, state: "pending", targetRound: 1 }),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "stage_auto_actions_kind_valid" });
  });

  it("confirm_handoff without a proposal id is refused", async () => {
    const s = await seedSwiss();
    const draft = await seedProposal(s, s.nextStageId);
    for (const bad of [
      { targetRound: null, proposalId: null },
      { targetRound: 1, proposalId: null },
      { targetRound: 1, proposalId: draft }, // a proposal AND a round is not a confirm either
    ]) {
      await expect(
        insertAction(s, { kind: "confirm_handoff", state: "pending", stageId: s.nextStageId, ...bad }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: "23514", constraint_name: "stage_auto_actions_target_shape" });
    }
    // The positive pair: a proposal and no round is the confirm shape.
    await insertAction(s, { kind: "confirm_handoff", state: "pending", stageId: s.nextStageId, proposalId: draft });
    expect(await countFor(s.nextStageId)).toBe(1);
  });

  it.each(ROUND_KINDS)("%s with a proposal id is refused, and so is one with no round", async (kind) => {
    const s = await seedSwiss();
    const draft = await seedProposal(s, s.stageId);
    for (const bad of [
      { targetRound: 1, proposalId: draft },
      { targetRound: null, proposalId: draft },
      { targetRound: null, proposalId: null },
    ]) {
      await expect(insertAction(s, { kind, state: "pending", ...bad }), JSON.stringify(bad)).rejects.toMatchObject({
        code: "23514",
        constraint_name: "stage_auto_actions_target_shape",
      });
    }
    // The positive pair: a round and no proposal is the shape for both round kinds.
    await insertAction(s, { kind, state: "pending", targetRound: 2 });
    expect(await countFor(s.stageId)).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("stage_auto_actions: lifetime follows the stage and the proposal", () => {
  it("deleting the stage deletes its rows, and only its rows", async () => {
    const s = await seedSwiss();
    await insertAction(s, { kind: "pair_round", state: "done", targetRound: 1 });
    await insertAction(s, { kind: "pair_round", state: "pending", targetRound: 2 });
    await insertAction(s, { kind: "complete_stage", state: "waiting", targetRound: 3 });
    const draft = await seedProposal(s, s.nextStageId);
    await insertAction(s, { kind: "confirm_handoff", state: "pending", stageId: s.nextStageId, proposalId: draft });
    expect(await countFor(s.stageId)).toBe(3);

    await sql`delete from stages where id = ${s.stageId}`;

    expect(await countFor(s.stageId)).toBe(0);
    expect(await countFor(s.nextStageId), "the other stage's row survives").toBe(1);
  });

  it("deleting the proposal deletes the confirm row that targets it", async () => {
    const s = await seedSwiss();
    const draft = await seedProposal(s, s.nextStageId);
    await insertAction(s, { kind: "confirm_handoff", state: "pending", stageId: s.nextStageId, proposalId: draft });
    await insertAction(s, { kind: "pair_round", state: "pending", stageId: s.nextStageId, targetRound: 1 });
    expect(await countFor(s.nextStageId)).toBe(2);

    await sql`delete from stage_seed_proposals where id = ${draft}`;

    const left = await sql<{ kind: string }[]>`select kind from stage_auto_actions where stage_id = ${s.nextStageId}`;
    expect(left.map((r) => r.kind)).toEqual(["pair_round"]);
  });
});

describe.skipIf(!HAS_DB)("stage_auto_actions: tenant isolation (app_user)", () => {
  it("app_user in another org reads zero rows; the same query in the row's org reads one", async () => {
    const s = await seedSwiss();
    const other = await seedSwiss();
    const id = await insertAction(s, { kind: "pair_round", state: "pending" });
    const read = (orgId: string) =>
      withTenant(orgId, (tx) => tx<{ id: string }[]>`select id from stage_auto_actions where id = ${id}`);

    expect(await read(other.orgId)).toHaveLength(0);
    expect((await read(s.orgId)).map((r) => r.id)).toEqual([id]);
  });

  it("app_user writes only its own org's rows: insert and update in the row's org, refused or untouched from another", async () => {
    const s = await seedSwiss();
    const other = await seedSwiss();
    const insertAs = (orgId: string) =>
      withTenant(orgId, (tx) =>
        tx<{ id: string }[]>`
          insert into stage_auto_actions (org_id, division_id, stage_id, kind, target_round, state)
          values (${s.orgId}, ${s.divisionId}, ${s.stageId}, 'pair_round', 1, 'pending')
          returning id`,
      );

    await expect(insertAs(other.orgId)).rejects.toMatchObject({ code: "42501" });
    expect(await countFor(s.stageId)).toBe(0);

    const [mine] = await insertAs(s.orgId);
    expect(mine!.id).toBeTruthy();

    const updateAs = (orgId: string) =>
      withTenant(orgId, (tx) =>
        tx<{ id: string }[]>`update stage_auto_actions set state = 'cancelled' where id = ${mine!.id} returning id`,
      );
    expect(await updateAs(other.orgId)).toHaveLength(0);
    expect(await updateAs(s.orgId)).toHaveLength(1);
    const [row] = await sql<{ state: string }[]>`select state from stage_auto_actions where id = ${mine!.id}`;
    expect(row!.state).toBe("cancelled");
  });
});
