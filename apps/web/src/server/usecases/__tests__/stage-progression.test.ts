// D4a (P5) integration tests — real Postgres, full usecase pipeline: TBD
// generation, propose/confirm, the non-destructive guarantee, double/foreign
// rejection, tie flagging end to end, stale-on-override, and the scoring
// guard on an unfilled TBD fixture. Pure placement/take-kind coverage lives
// in stage-seeding.test.ts (no DB); this file proves the DB plumbing wires
// that engine up correctly.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { EngineError } from "@seazn/engine/core";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import {
  completeStage,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  overrideStandings,
  type FixtureRow,
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

interface Setup {
  auth: AuthCtx;
  divisionId: string;
  entrantBySeed: Map<number, string>;
  groupStageId: string;
  koStageId: string;
}

/**
 * 8 entrants, 4 pools of 2 (seeded-snake: A={1,8} B={2,7} C={3,6} D={4,5}),
 * KO stage declares `.seeding` with topNPerGroup(2) sourced from "previous".
 * Deterministic: the lower seed always wins its (only) group fixture, so
 * standings are 1st=lower seed, 2nd=higher seed in every pool.
 */
async function setupGroupsToKnockout(
  placement: "rank_order" | "snake" | "seeded_map" = "rank_order",
  map?: { slot: string; source: string }[],
): Promise<Setup> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Seed " + randomUUID().slice(0, 6),
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
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 8 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const entrantBySeed = new Map(entrants.map((e) => [e.seed as number, e.id]));

  const stages = await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 4 } } },
    {
      seq: 2,
      kind: "knockout",
      name: "KO",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
        placement,
        ...(map ? { map } : {}),
        timing: "setup",
      },
    },
  ]);
  const groupStage = stages.find((s) => s.kind === "group")!;
  const koStage = stages.find((s) => s.kind === "knockout")!;
  return { auth, divisionId: division.id, entrantBySeed, groupStageId: groupStage.id, koStageId: koStage.id };
}

/** Decide every group fixture: the lower-seeded entrant always wins. */
async function decideAllGroupFixtures(auth: AuthCtx, groupStageId: string, entrantBySeed: Map<number, string>): Promise<void> {
  const seedOfEntrant = new Map([...entrantBySeed.entries()].map(([seed, id]) => [id, seed]));
  const fixtures = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${groupStageId}`;
  for (const f of fixtures) {
    const homeWins = (seedOfEntrant.get(f.home_entrant_id) ?? 99) < (seedOfEntrant.get(f.away_entrant_id) ?? 99);
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, {
      type: "generic.result",
      payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 },
    });
  }
}

describe.skipIf(!HAS_DB)("D4a/P5 — TBD generation at division setup time", () => {
  it("generates fully-TBD fixtures for a .seeding stage BEFORE its source completes or is even generated; shape/labels: 8-slot bracket, all null entrants, group_rank labels present", async () => {
    const { auth, koStageId } = await setupGroupsToKnockout();
    // The GROUP (source) stage was never generated OR completed — the OLD
    // qualification mechanism would STAGE_NOT_READY here; `.seeding` must
    // not wait on it at all (owner ruling: TBD fixtures at division setup).
    const outcome = await generateStageFixtures(auth, koStageId);
    expect(outcome.created).toBe(7); // 8-team single elim: 4+2+1
    expect(outcome.fixtures.every((f) => f.home_entrant_id === null)).toBe(true);
    const round0 = outcome.fixtures.filter((f) => f.round_no === Math.min(...outcome.fixtures.map((x) => x.round_no)));
    expect(round0).toHaveLength(4);
    const labels = round0.flatMap((f) => [f.home_slot_label, f.away_slot_label]);
    expect(labels.every((l) => l !== null)).toBe(true);
    expect(labels.every((l) => l!.key === "slot.winner_group" || l!.key === "slot.runner_up_group")).toBe(true);
    // Idempotent: re-running produces no new rows.
    const again = await generateStageFixtures(auth, koStageId);
    expect(again.created).toBe(0);
    expect(again.existing).toBe(7);
  });

  it("re-verifies at generation time too — createStages already validated a bad seeded_map at save time", async () => {
    await expect(
      setupGroupsToKnockout("seeded_map", [{ slot: "1", source: "Z9" }]),
    ).rejects.toThrow(/does not match/);
  });
});

describe.skipIf(!HAS_DB)("D4a/P5 — propose + confirm (groups -> complete -> proposal -> confirm -> KO filled)", () => {
  it("completeStage computes a DRAFT proposal (never auto-fills) for a .seeding next stage", async () => {
    const { auth, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockout("rank_order");
    await generateStageFixtures(auth, koStageId); // TBD fixtures exist up front
    await generateStageFixtures(auth, groupStageId);
    await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);

    const result = await completeStage(auth, groupStageId);
    expect(result.completed).toBe(true);
    expect(result.seed_proposal?.status).toBe("draft");
    // Never auto-fills: the KO fixtures are still fully TBD.
    const koFixtures = await sql<{ home_entrant_id: string | null }[]>`
      select home_entrant_id from fixtures where stage_id = ${koStageId}`;
    expect(koFixtures.every((f) => f.home_entrant_id === null)).toBe(true);

    const [proposalRow] = await sql<{ id: string; computed: { qualifiers: { entrantId: string; destinationSlot: string }[]; ties: unknown[] } }[]>`
      select id, computed from stage_seed_proposals where id = ${result.seed_proposal!.id}`;
    expect(proposalRow.computed.qualifiers).toHaveLength(8);
    expect(proposalRow.computed.ties).toEqual([]);

    const confirmed = await confirmSeedProposal(auth, koStageId, { proposalId: proposalRow.id });
    expect(confirmed.filled).toBe(8);

    // Every qualifier landed EXACTLY where the proposal said, and it's a
    // bijection: all 8 winners/runners-up appear, none twice.
    const filledIds = confirmed.fixtures.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null);
    expect(filledIds.sort()).toEqual([...proposalRow.computed.qualifiers.map((q) => q.entrantId)].sort());
    expect(new Set(filledIds).size).toBe(8);

    // rank_order: seed1..4 = group winners E1,E3,E5,E7's respective pools —
    // concretely (pools A={1,8} B={2,7} C={3,6} D={4,5}): winners E1,E2,E3,E4
    // then runners-up E8,E7,E6,E5. Round-0 pairs by seedPositions(8) =
    // [1,8,5,4,3,6,7,2] -> (seed1,seed8)=(E1,E5), (seed5,seed4)=(E8,E4),
    // (seed3,seed6)=(E3,E7), (seed7,seed2)=(E6,E2).
    const e = entrantBySeed;
    const pairs = confirmed.fixtures
      .filter((f) => f.home_entrant_id !== null)
      .map((f) => new Set([f.home_entrant_id, f.away_entrant_id]));
    expect(pairs).toContainEqual(new Set([e.get(1), e.get(5)]));
    expect(pairs).toContainEqual(new Set([e.get(8), e.get(4)]));
    expect(pairs).toContainEqual(new Set([e.get(3), e.get(7)]));
    expect(pairs).toContainEqual(new Set([e.get(6), e.get(2)]));

    // Labels cleared on fill (design's Fill algorithm step 4).
    expect(confirmed.fixtures.filter((f) => f.round_no === 1).every((f) => f.home_slot_label === null && f.away_slot_label === null)).toBe(true);
  });

  it("snake placement interleaves waves — different bracket than rank_order for the SAME standings", async () => {
    const { auth, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockout("snake");
    await generateStageFixtures(auth, koStageId);
    await generateStageFixtures(auth, groupStageId);
    await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);
    await completeStage(auth, groupStageId);
    const [proposal] = await sql<{ id: string }[]>`select id from stage_seed_proposals where stage_id = ${koStageId} and status = 'draft'`;
    const confirmed = await confirmSeedProposal(auth, koStageId, { proposalId: proposal.id });
    // snake: seed order [E1,E2,E3,E4,E5,E6,E7,E8] (wave2 reversed back to
    // ascending) -> seedPositions pairs (1,8)=(E1,E8), (5,4)=(E5,E4),
    // (3,6)=(E3,E6), (7,2)=(E7,E2) — E1 now meets E8 in round 1, NOT E5 as
    // rank_order produced above.
    const e = entrantBySeed;
    const pairs = confirmed.fixtures.filter((f) => f.home_entrant_id !== null).map((f) => new Set([f.home_entrant_id, f.away_entrant_id]));
    expect(pairs).toContainEqual(new Set([e.get(1), e.get(8)]));
  });

  it("non-destructive guarantee: confirm leaves scheduled_at/court/pins BYTE-IDENTICAL on already-scheduled TBD fixtures", async () => {
    // This is the whole reason the design exists (design doc + P05 prompt:
    // "land this one FIRST, red against a naive regenerate-the-stage
    // implementation"). A naive confirm that deletes+regenerates fixtures
    // instead of filling them in place would produce entirely NEW rows (new
    // ids, scheduled_at/court reset) — this test looks up the SAME fixture
    // ids by id and byte-compares every scheduling field, which only a
    // fillSlot-shaped confirm can satisfy.
    const { auth, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockout("rank_order");
    const gen = await generateStageFixtures(auth, koStageId);
    const round0Ids = gen.fixtures
      .filter((f) => f.round_no === Math.min(...gen.fixtures.map((x) => x.round_no)))
      .map((f) => f.id);

    // Organiser pins court/time on day one, before anyone is known (design:
    // "the final's court/time can be pinned on day one, like real cups").
    const pinnedAt = "2026-09-20T10:00:00.000Z";
    for (const [i, id] of round0Ids.entries()) {
      await sql`update fixtures set scheduled_at = ${pinnedAt}, court_label = ${"Court " + (i + 1)},
                 schedule_source = 'manual', schedule_locked = true where id = ${id}`;
    }
    const before = await sql<
      Pick<FixtureRow, "id" | "scheduled_at" | "court_label" | "schedule_source" | "schedule_locked">[]
    >`select id, scheduled_at, court_label, schedule_source, schedule_locked from fixtures where id in ${sql(round0Ids)} order by id`;

    await generateStageFixtures(auth, groupStageId);
    await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);
    await completeStage(auth, groupStageId);
    const [proposal] = await sql<{ id: string }[]>`select id from stage_seed_proposals where stage_id = ${koStageId} and status = 'draft'`;
    await confirmSeedProposal(auth, koStageId, { proposalId: proposal.id });

    const after = await sql<
      Pick<FixtureRow, "id" | "scheduled_at" | "court_label" | "schedule_source" | "schedule_locked">[]
    >`select id, scheduled_at, court_label, schedule_source, schedule_locked from fixtures where id in ${sql(round0Ids)} order by id`;
    expect(after).toEqual(before);
    // AND the entrants really did land (confirm did its actual job too —
    // this isn't passing merely because nothing happened).
    const filled = await sql<{ home_entrant_id: string | null }[]>`
      select home_entrant_id from fixtures where id in ${sql(round0Ids)}`;
    expect(filled.every((f) => f.home_entrant_id !== null)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("D4a/P5 — confirm validation (double-assignment, foreign entrant, ties)", () => {
  it("422 SEEDING_SLOT_DOUBLE_ASSIGNED when an edit assigns the same entrant to two slots", async () => {
    const { auth, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockout("rank_order");
    await generateStageFixtures(auth, koStageId);
    await generateStageFixtures(auth, groupStageId);
    await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);
    const result = await completeStage(auth, groupStageId);
    const [proposal] = await sql<{ id: string; computed: { qualifiers: { destinationSlot: string }[] } }[]>`
      select id, computed from stage_seed_proposals where id = ${result.seed_proposal!.id}`;
    const [slotA, slotB] = proposal.computed.qualifiers.map((q) => q.destinationSlot);
    const err = await confirmSeedProposal(auth, koStageId, {
      proposalId: proposal.id,
      edits: [
        { destinationSlot: slotA!, entrantId: entrantBySeed.get(1)! },
        { destinationSlot: slotB!, entrantId: entrantBySeed.get(1)! },
      ],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("SEEDING_SLOT_DOUBLE_ASSIGNED");
  });

  it("422 SEEDING_EDIT_UNKNOWN_SLOT when an edit references a slot this proposal doesn't have (review finding: was misreported as SEEDING_SLOT_DOUBLE_ASSIGNED)", async () => {
    const { auth, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockout("rank_order");
    await generateStageFixtures(auth, koStageId);
    await generateStageFixtures(auth, groupStageId);
    await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);
    const result = await completeStage(auth, groupStageId);
    const err = await confirmSeedProposal(auth, koStageId, {
      proposalId: result.seed_proposal!.id,
      edits: [{ destinationSlot: `${randomUUID()}:home`, entrantId: entrantBySeed.get(1)! }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("SEEDING_EDIT_UNKNOWN_SLOT");
  });

  it("422 SEEDING_SLOT_FOREIGN_FIXTURE when a resolved slot names a fixture outside this stage (review finding: was misreported as SEEDING_SLOT_DOUBLE_ASSIGNED)", async () => {
    // tiePicks apply unconditionally (bySlot.set with no bySlot.has guard,
    // unlike edits) — the vector this stage's OWN validation is meant to
    // catch, engineered here rather than found live: a slot naming a REAL
    // fixture that belongs to a different stage entirely.
    const { auth, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockoutWithBye();
    await generateStageFixtures(auth, koStageId);
    await generateStageFixtures(auth, groupStageId);
    await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);
    const result = await completeStage(auth, groupStageId);
    const [groupFixture] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${groupStageId} limit 1`;
    const foreignSlot = `${groupFixture.id}:home`;
    // Seeds 4/5/6 are this setup's pool LOSERS (lower seed always wins) — real
    // division entrants, but never one of the proposal's own 3 qualifiers, so
    // this doesn't trip the "same entrant assigned twice" check first.
    const err = await confirmSeedProposal(auth, koStageId, {
      proposalId: result.seed_proposal!.id,
      tiePicks: [{ slots: [foreignSlot], order: [entrantBySeed.get(6)!] }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("SEEDING_SLOT_FOREIGN_FIXTURE");
  });

  it("422 SEEDING_ENTRANT_FOREIGN when an edit names an entrant outside the division", async () => {
    const { auth, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockout("rank_order");
    await generateStageFixtures(auth, koStageId);
    await generateStageFixtures(auth, groupStageId);
    await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);
    const result = await completeStage(auth, groupStageId);
    const [proposal] = await sql<{ id: string; computed: { qualifiers: { destinationSlot: string }[] } }[]>`
      select id, computed from stage_seed_proposals where id = ${result.seed_proposal!.id}`;
    const foreignEntrantId = randomUUID();
    const err = await confirmSeedProposal(auth, koStageId, {
      proposalId: proposal.id,
      edits: [{ destinationSlot: proposal.computed.qualifiers[0]!.destinationSlot, entrantId: foreignEntrantId }],
    }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SEEDING_ENTRANT_FOREIGN");
  });

  it("a cross-group tie is FLAGGED, never silently ordered — confirm without resolving it 422s", async () => {
    // Force a tie: two pools whose 2nd-placed entrant end up LEVEL (both
    // group matches decided by the identical scoreline), so bestNth-style
    // ranking isn't in play here — instead this exercises the SAME
    // tieUnbroken surfacing via a group_rank pick whose SOURCE stage
    // standings themselves carry an unresolved tie (both entrants scored
    // identically across an otherwise-decided pool of >2, engineered via a
    // 3-pool topN=1 setup so pool C's finish is genuinely 2-way level).
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Tie " + randomUUID().slice(0, 6),
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
    // One pool (2 groups), no ties possible from a single-match pool with a
    // decisive result — so instead force the tie directly on the STANDINGS
    // ROW via a rank override that leaves two entrants tied is not
    // supported (overrideStandings requires distinct ranks). The reliable
    // way to reach `tieUnbroken` deterministically is a DRAWN league match
    // (allowDraws), where the cascade genuinely cannot separate two
    // entrants that both drew — reproduced here as a top-2-of-4 league.
    const entrants = await createEntrants(
      auth,
      division.id,
      Array.from({ length: 4 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `T${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const stages = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);
    const league = stages.find((s) => s.kind === "league")!;
    const ko = stages.find((s) => s.kind === "knockout")!;
    await generateStageFixtures(auth, ko.id);
    const gen = await generateStageFixtures(auth, league.id);
    // Every match a draw -> every entrant finishes level on points/diff/for —
    // an inescapable 4-way tie for ranks 1-2, exactly what "never silently
    // ordered" exists to catch.
    const fixtures = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${league.id}`;
    void gen;
    for (const f of fixtures) {
      await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
      await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 1, p2Score: 1 } });
    }
    const result = await completeStage(auth, league.id);
    expect(result.seed_proposal).toBeDefined();
    const [proposal] = await sql<{ id: string; computed: { ties: { slots: string[]; entrantIds: string[] }[] } }[]>`
      select id, computed from stage_seed_proposals where id = ${result.seed_proposal!.id}`;
    expect(proposal.computed.ties.length).toBeGreaterThan(0);

    const unresolved = await confirmSeedProposal(auth, ko.id, { proposalId: proposal.id }).catch((e: unknown) => e);
    expect((unresolved as { code?: string }).code).toBe("SEEDING_TIE_UNRESOLVED");

    // Resolving with an explicit tiePick succeeds.
    const tie = proposal.computed.ties[0]!;
    const resolved = await confirmSeedProposal(auth, ko.id, {
      proposalId: proposal.id,
      tiePicks: [{ slots: tie.slots, order: tie.entrantIds }],
    });
    expect(resolved.filled).toBe(2);
    void entrants;
  });
});

/**
 * 6 entrants, 3 pools of 2 (seeded-snake: A={1,6} B={2,5} C={3,4}), KO stage
 * declares `.seeding` with topNPerGroup(1) sourced from "previous" — 3
 * qualifiers, an ODD count. Every scenario above uses a power-of-two count
 * (8, 4, 2); a knockout bracket for 3 entrants pads to 4 slots with exactly
 * 1 bye — the #554 reproduction: a bye seed owns TWO destination slots (its
 * own bye fixture's `home` slot AND the winner-feed final's slot), which
 * `destinationSlotsBySeed`'s old `Map<number,string>` (last-write-wins, no
 * ORDER BY) could only remember one of.
 */
async function setupGroupsToKnockoutWithBye(): Promise<Setup> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Bye " + randomUUID().slice(0, 6),
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
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 6 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `B${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const entrantBySeed = new Map(entrants.map((e) => [e.seed as number, e.id]));
  const stages = await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 3 } } },
    {
      seq: 2,
      kind: "knockout",
      name: "KO",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    },
  ]);
  const groupStage = stages.find((s) => s.kind === "group")!;
  const koStage = stages.find((s) => s.kind === "knockout")!;
  return { auth, divisionId: division.id, entrantBySeed, groupStageId: groupStage.id, koStageId: koStage.id };
}

describe.skipIf(!HAS_DB)("D4a/P5 — a bye seed owns TWO destination slots (#554)", () => {
  it("confirm leaves NO fixture with a stale slot_label and no entrant — odd qualifier count, 1 bye", async () => {
    const { auth, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockoutWithBye();
    await generateStageFixtures(auth, koStageId);
    await generateStageFixtures(auth, groupStageId);
    await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);

    const result = await completeStage(auth, groupStageId);
    expect(result.seed_proposal?.status).toBe("draft");
    const [proposal] = await sql<{ id: string; computed: { qualifiers: unknown[] } }[]>`
      select id, computed from stage_seed_proposals where id = ${result.seed_proposal!.id}`;
    expect(proposal.computed.qualifiers).toHaveLength(3);

    const confirmed = await confirmSeedProposal(auth, koStageId, { proposalId: proposal.id });

    // THE assertion that catches #554 — checked first, standalone: after
    // confirm, nothing in the stage is left holding a placeholder label with
    // no entrant behind it. That is exactly the "stranded" state the
    // last-write-wins bug produced for whichever of {the bye fixture, the
    // winner-feed target} Postgres didn't return last from the unordered
    // SELECT.
    const fixtures = await sql<{
      id: string;
      home_slot_label: unknown;
      home_entrant_id: string | null;
      away_slot_label: unknown;
      away_entrant_id: string | null;
    }[]>`select id, home_slot_label, home_entrant_id, away_slot_label, away_entrant_id
         from fixtures where stage_id = ${koStageId}`;
    const stranded = fixtures.filter(
      (f) =>
        (f.home_slot_label !== null && f.home_entrant_id === null) ||
        (f.away_slot_label !== null && f.away_entrant_id === null),
    );
    expect(stranded).toEqual([]);

    // Sanity check on the fill count: the bye's seed fills its own bye
    // fixture's slot AND the winner-feed target's slot — 4 slots filled for
    // 3 qualifiers, not 3.
    expect(confirmed.filled).toBe(4);
  });

  it("is deterministic: the same qualifier shape fills the same way across independent fresh runs", async () => {
    async function runOnce(): Promise<{ roundNo: number; homeSeed: number | null; awaySeed: number | null }[]> {
      const { auth, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockoutWithBye();
      await generateStageFixtures(auth, koStageId);
      await generateStageFixtures(auth, groupStageId);
      await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);
      const result = await completeStage(auth, groupStageId);
      const [proposal] = await sql<{ id: string }[]>`
        select id from stage_seed_proposals where id = ${result.seed_proposal!.id}`;
      const confirmed = await confirmSeedProposal(auth, koStageId, { proposalId: proposal.id });
      const seedOfEntrant = new Map([...entrantBySeed.entries()].map(([seed, id]) => [id, seed]));
      // Observable outcome only — never Postgres row order: which ORIGINAL
      // seed (1..6) ended up on which round's home/away side.
      return confirmed.fixtures
        .map((f) => ({
          roundNo: f.round_no,
          homeSeed: f.home_entrant_id ? (seedOfEntrant.get(f.home_entrant_id) ?? null) : null,
          awaySeed: f.away_entrant_id ? (seedOfEntrant.get(f.away_entrant_id) ?? null) : null,
        }))
        .sort((a, b) => a.roundNo - b.roundNo || (a.homeSeed ?? -1) - (b.homeSeed ?? -1));
    }

    const first = await runOnce();
    const second = await runOnce();
    expect(second).toEqual(first);

    // AND the shape actually exercises the doubled-seed path: one original
    // seed (the pool winner that drew the bye) appears in TWO fixtures,
    // never just one — that's the part a lucky, always-same-order Postgres
    // scan could otherwise hide from a bare cross-run equality check.
    const seedCounts = new Map<number, number>();
    for (const f of first) {
      if (f.homeSeed !== null) seedCounts.set(f.homeSeed, (seedCounts.get(f.homeSeed) ?? 0) + 1);
      if (f.awaySeed !== null) seedCounts.set(f.awaySeed, (seedCounts.get(f.awaySeed) ?? 0) + 1);
    }
    expect([...seedCounts.values()].sort()).toEqual([1, 1, 2]);
  });
});

describe.skipIf(!HAS_DB)("D4a/P5 — bye-award bulk UPDATE guards against stranding a slot_label", () => {
  it("refuses rather than silently stranding a slot_label if a plain-stage bye-award winner-feed target ever carries one", async () => {
    // Review finding: generateStageFixtures' bye-award-into-winner-feed pass
    // (the PLAIN, non-`.seeding` path, unlike generateSeededStageFixtures'
    // OWN third pass) writes home/away_entrant_id via a raw bulk UPDATE that
    // bypasses fillSlot — the one other entrant-id writer in this file that
    // doesn't also clear *_slot_label. Verified harmless today only because
    // a plain-stage fixture never carries a label to begin with; nothing
    // enforces that stays true, so this guards the invariant directly
    // instead of trusting the assumption forever.
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "ByeGuard " + randomUUID().slice(0, 6),
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
    // 3 entrants -> bracket of 4, ONE bye (same shape as integration.test.ts's
    // "byes auto-advance" test) — the bye's award propagates straight into
    // the final via the third pass this guards.
    await createEntrants(auth, division.id, [
      { kind: "individual" as const, display_name: "One", seed: 1, members: [] },
      { kind: "individual" as const, display_name: "Two", seed: 2, members: [] },
      { kind: "individual" as const, display_name: "Three", seed: 3, members: [] },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "KO", config: {} });
    const gen = await generateStageFixtures(auth, stage!.id);

    const finalRoundNo = Math.max(...gen.fixtures.map((x) => x.round_no));
    const final = gen.fixtures.find(
      (f) => f.round_no === finalRoundNo && (f.home_entrant_id !== null || f.away_entrant_id !== null),
    );
    expect(final).toBeDefined();
    const side: "home" | "away" = final!.home_entrant_id !== null ? "home" : "away";
    // Baseline premise the finding leans on: a plain-stage fixture never
    // carries a label — confirmed, not assumed.
    expect(side === "home" ? final!.home_slot_label : final!.away_slot_label).toBeNull();

    // Simulate the ONLY way the invariant could break: something stamps a
    // label on this slot while it's open (nothing in the plain path ever
    // does — that's the point). Re-open the slot and stamp it, then re-run
    // generation: the SAME third pass that fed the bye's award into this
    // fixture the first time runs again on every regeneration.
    if (side === "home") {
      await sql`update fixtures set home_entrant_id = null,
                home_slot_label = ${sql.json({ key: "slot.rank_range", params: { rank: 1 } } as never)}
                where id = ${final!.id}`;
    } else {
      await sql`update fixtures set away_entrant_id = null,
                away_slot_label = ${sql.json({ key: "slot.rank_range", params: { rank: 1 } } as never)}
                where id = ${final!.id}`;
    }

    await expect(generateStageFixtures(auth, stage!.id)).rejects.toThrow(/slot_label/i);

    // AND it refused BEFORE writing — label and null-entrant both still sit
    // there, exactly the state that would otherwise go silently stale.
    const [after] = await sql<
      {
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        home_slot_label: unknown;
        away_slot_label: unknown;
      }[]
    >`select home_entrant_id, away_entrant_id, home_slot_label, away_slot_label from fixtures where id = ${final!.id}`;
    expect(side === "home" ? after.home_entrant_id : after.away_entrant_id).toBeNull();
    expect(side === "home" ? after.home_slot_label : after.away_slot_label).not.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("D4a/P5 — standings override marks a draft stale", () => {
  it("overrideStandings on the source stage marks the dependent draft stale and recomputes", async () => {
    // A single-table (league) source: overrideStandings/recomputeStandings
    // targets the stage's ONE unnamed pool, so ranks 1..N are unambiguous —
    // unlike a multi-pool group stage, where a bare (no poolId) override
    // resolves to whichever pool happens to be first.
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Override " + randomUUID().slice(0, 6),
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
    const entrants = await createEntrants(
      auth,
      division.id,
      Array.from({ length: 4 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `O${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const bySeed = new Map(entrants.map((e) => [e.seed as number, e.id]));
    const stages = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);
    const league = stages.find((s) => s.kind === "league")!;
    const ko = stages.find((s) => s.kind === "knockout")!;
    await generateStageFixtures(auth, ko.id);
    await generateStageFixtures(auth, league.id);
    // Decisive results, lower seed always wins — a clean, tie-free table.
    const seedOfEntrant = new Map([...bySeed.entries()].map(([seed, id]) => [id, seed]));
    const fixtures = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${league.id}`;
    for (const f of fixtures) {
      const homeWins = (seedOfEntrant.get(f.home_entrant_id) ?? 99) < (seedOfEntrant.get(f.away_entrant_id) ?? 99);
      await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
      await appendEvent(auth.orgId, f.id, 1, {
        type: "generic.result",
        payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 },
      });
    }

    const result = await completeStage(auth, league.id);
    const originalProposalId = result.seed_proposal!.id;
    const [originalComputed] = await sql<{ computed: { qualifiers: { entrantId: string }[] } }[]>`
      select computed from stage_seed_proposals where id = ${originalProposalId}`;
    // Before override: natural order O1(1st), O2(2nd) qualify.
    expect(originalComputed.computed.qualifiers.map((q) => q.entrantId)).toEqual([bySeed.get(1), bySeed.get(2)]);

    await overrideStandings(auth, league.id, {
      rows: [1, 2, 3, 4].map((rank, i) => ({
        entrant_id: bySeed.get(4 - i)!, // reverse the whole table: O4 1st, O1 4th
        rank,
        reason: "test override",
      })),
    });

    const [original] = await sql<{ status: string }[]>`select status from stage_seed_proposals where id = ${originalProposalId}`;
    expect(original.status).toBe("stale");
    const confirmingStale = await confirmSeedProposal(auth, ko.id, { proposalId: originalProposalId }).catch(
      (e: unknown) => e,
    );
    expect((confirmingStale as { code?: string }).code).toBe("SEEDING_PROPOSAL_STALE");

    const [fresh] = await sql<{ id: string; status: string; computed: { qualifiers: { entrantId: string }[] } }[]>`
      select id, status, computed from stage_seed_proposals where stage_id = ${ko.id} and status = 'draft'`;
    expect(fresh).toBeDefined();
    expect(fresh.id).not.toBe(originalProposalId);
    // The RECOMPUTED draft reflects the override: O4 now qualifies 1st.
    expect(fresh.computed.qualifiers.map((q) => q.entrantId)).toEqual([bySeed.get(4), bySeed.get(3)]);
  });
});

describe.skipIf(!HAS_DB)("D4a/P5 — correcting an already-decided fixture also marks a dependent draft stale", () => {
  it("void + re-score on a decided (not finalized) fixture in a COMPLETE source stage marks the dependent draft stale — not just overrideStandings", async () => {
    // Reviewer finding: markDependentSeedProposalsStale fired only from
    // overrideStandings. LOCKED_FIXTURE_STATUSES (append-event.ts) is only
    // {finalized, cancelled} — "decided" is NOT locked — so a correction via
    // the live scoring path (scoreEvent -> onDecided -> recomputeStandings,
    // scoring.ts) is a legitimate, permitted edit to an already-complete
    // source stage's standings, and it must ALSO stale the dependent draft.
    const { auth, divisionId, groupStageId, koStageId, entrantBySeed } = await setupGroupsToKnockout("rank_order");
    await generateStageFixtures(auth, koStageId);
    await generateStageFixtures(auth, groupStageId);
    await startDivision(auth, divisionId);
    await decideAllGroupFixtures(auth, groupStageId, entrantBySeed);

    const result = await completeStage(auth, groupStageId);
    const proposalId = result.seed_proposal!.id;
    const [before] = await sql<{ status: string }[]>`
      select status from stage_seed_proposals where id = ${proposalId}`;
    expect(before.status).toBe("draft");

    const [fixture] = await sql<{ id: string; status: string }[]>`
      select id, status from fixtures where stage_id = ${groupStageId} order by id limit 1`;
    // Decided, never finalized — exactly the state LOCKED_FIXTURE_STATUSES
    // does NOT block, so this correction is permitted to reach scoreEvent.
    expect(fixture.status).toBe("decided");
    const [decisive] = await sql<{ id: string; seq: number }[]>`
      select id, seq from score_events where fixture_id = ${fixture.id} order by seq desc limit 1`;

    const voided = await scoreEvent(auth, fixture.id, {
      expected_seq: decisive.seq,
      type: "core.void",
      payload: { event_id: decisive.id },
    });
    // Flip the result — a genuine correction, not a no-op replay.
    await scoreEvent(auth, fixture.id, {
      expected_seq: voided.seq,
      type: "generic.result",
      payload: { p1Score: 0, p2Score: 2 },
    });

    const [after] = await sql<{ status: string }[]>`
      select status from stage_seed_proposals where id = ${proposalId}`;
    expect(after.status).toBe("stale");
  });
});

describe.skipIf(!HAS_DB)("D4a/P5 — scoring an unfilled fixture 422s with a typed code", () => {
  it("appendEvent on a TBD fixture throws EngineError WRONG_PHASE", async () => {
    const { auth, koStageId } = await setupGroupsToKnockout();
    const gen = await generateStageFixtures(auth, koStageId);
    const tbdFixture = gen.fixtures[0]!;
    expect(tbdFixture.home_entrant_id).toBeNull();
    const err = await appendEvent(auth.orgId, tbdFixture.id, 0, { type: "core.start", payload: {} }).catch(
      (e: unknown) => e,
    );
    expect(EngineError.is(err)).toBe(true);
    expect((err as EngineError).code).toBe("WRONG_PHASE");
  });
});
