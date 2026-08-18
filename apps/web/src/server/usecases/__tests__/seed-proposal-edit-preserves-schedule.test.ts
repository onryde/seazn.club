// Regression (P6/D4b task B acceptance criteria): "confirm does NOT alter
// scheduled_at/court/pins of the TBD fixtures it fills — the non-destructive
// guarantee is the entire reason this design exists." stage-progression.
// test.ts (P5) already proves this for the UNEDITED confirm path
// (`{proposalId}` alone). This file proves it ALSO holds for task B's new
// edit-in-place path (`edits[]`) — P5's own suite never sends an edit, so it
// cannot see a confirm that both reassigns AND reschedules in one call. Real
// Postgres, full pipeline; does not modify stage-progression.test.ts or any
// P5 server file — read-only consumer of confirmSeedProposal/stages.ts.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("confirmSeedProposal + edits[] preserves scheduling (P6/D4b task B regression)", () => {
  it("swapping the two qualifiers via edits[] fills the SWAPPED entrant while scheduled_at/court/pins stay byte-identical", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "EditSchedule " + randomUUID().slice(0, 6),
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
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);
    const groupStageId = stages.find((s) => s.kind === "group")!.id;
    const koStageId = stages.find((s) => s.kind === "knockout")!.id;

    // TBD KO fixture exists up front (owner ruling) — pin its court/time
    // before anyone qualifies, exactly like an organiser locking in the
    // final's slot on day one.
    await generateStageFixtures(auth, koStageId);
    const pinnedAt = "2026-09-20T10:00:00.000Z";
    await sql`
      update fixtures set scheduled_at = ${pinnedAt}, court_label = 'Center Court',
             schedule_source = 'manual', schedule_locked = true
      where stage_id = ${koStageId}`;
    const before = await sql<
      { id: string; scheduled_at: string; court_label: string; schedule_source: string; schedule_locked: boolean }[]
    >`select id, scheduled_at, court_label, schedule_source, schedule_locked from fixtures where stage_id = ${koStageId} order by id`;
    expect(before).toHaveLength(1);
    const koFixtureId = before[0]!.id;

    // Decide both group fixtures (lower seed wins each 2-entrant pool),
    // complete the stage -> auto-computes the draft proposal.
    await generateStageFixtures(auth, groupStageId);
    const groupFixtures = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${groupStageId}`;
    for (const f of groupFixtures) {
      await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
      await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    }
    await completeStage(auth, groupStageId);

    const [proposal] = await sql<{
      id: string;
      computed: { qualifiers: { entrantId: string; destinationSlot: string }[] };
    }[]>`select id, computed from stage_seed_proposals where stage_id = ${koStageId} and status = 'draft'`;
    expect(proposal.computed.qualifiers).toHaveLength(2);
    const [q0, q1] = proposal.computed.qualifiers;

    // The organiser's edit-in-place: swap who fills each slot relative to
    // what the engine computed (exactly the shape ProgressionPanel's
    // buildEditsPayload produces from its editsBySlot map).
    const swapEdits = [
      { destinationSlot: q0!.destinationSlot, entrantId: q1!.entrantId },
      { destinationSlot: q1!.destinationSlot, entrantId: q0!.entrantId },
    ];
    const result = await confirmSeedProposal(auth, koStageId, { proposalId: proposal.id, edits: swapEdits });
    expect(result.filled).toBe(2);

    const after = await sql<
      { id: string; scheduled_at: string; court_label: string; schedule_source: string; schedule_locked: boolean }[]
    >`select id, scheduled_at, court_label, schedule_source, schedule_locked from fixtures where stage_id = ${koStageId} order by id`;
    // Non-destructive guarantee, under an EDIT: same row, same schedule.
    expect(after).toEqual(before);

    // AND the SWAPPED assignment actually landed — not the computed default.
    const [fixtureAfter] = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where id = ${koFixtureId}`;
    const [side0, side1] = [q0!.destinationSlot.split(":")[1], q1!.destinationSlot.split(":")[1]];
    const landedForQ0Slot = side0 === "home" ? fixtureAfter!.home_entrant_id : fixtureAfter!.away_entrant_id;
    const landedForQ1Slot = side1 === "home" ? fixtureAfter!.home_entrant_id : fixtureAfter!.away_entrant_id;
    expect(landedForQ0Slot).toBe(q1!.entrantId); // swapped, not q0's own computed entrant
    expect(landedForQ1Slot).toBe(q0!.entrantId);
    void entrants;
  });
});
