// A withdrawn entrant must not be seeded into a bracket by the
// `timing: "setup"` propose -> confirm -> fill path.
//
// A withdrawal is a STATUS FLIP, not a delete: the row survives, and the
// standings SNAPSHOT deliberately keeps her (engine-db/competition.ts derives
// its entrant set from fixture home/away ids, with no status filter, so the
// row she earned stays on the public board behind a "Withdrawn" chip). The
// consequence is that anything taking its membership from the STANDINGS
// inherits withdrawn entrants. The `timing: "on_complete"` path is already
// safe by intersection (`qualified.filter((id) => activeIds.has(id))`,
// generateStageFixturesWrite); the propose/confirm pair was not.
//
// Two layers, tested separately here because a mutant of either must red on
// its own (a refusal alone leaves the organiser a dead end; a proposal filter
// alone leaves the API open):
//   - computeSeedProposal must not OFFER a departed entrant, and
//   - confirmSeedProposal must REFUSE one, whatever route it arrives by
//     (the computed slate, an `edits[]` override, or a `tiePicks[]` order).
//
// Out of scope by owner ruling: promoting the next-ranked entrant into the
// vacated place. A smaller bracket is the accepted behaviour today.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { HttpError } from "@/lib/errors";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import {
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  getSeedProposal,
} from "../stages";
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

/** 4 entrants, 2 pools of 2, topNPerGroup(1) -> 2 qualifiers into a
 *  `timing: "setup"` knockout. Same shape as get-seed-proposal.test.ts's
 *  setup(); every group fixture is decided 2-0 to the home side, so the two
 *  pool winners are deterministic and there are no ties to resolve. */
async function setup() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Withdrawn " + randomUUID().slice(0, 6),
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
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
        placement: "rank_order",
        timing: "setup",
      },
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
  await completeStage(auth, groupStageId);
  return { auth, divisionId: division.id, groupStageId, koStageId };
}

/** 4 entrants, a single-leg league where EVERY match is drawn, feeding a
 *  `timing: "setup"` knockout by rankRange(1..2). Everyone finishes level on
 *  points, goal difference and goals for, so the engine cannot separate them
 *  and flags an inescapable 4-way tie for the 2 qualifying slots — the shape
 *  stage-progression.test.ts uses for the same reason. A tie is the one
 *  place where filtering a departed entrant can turn a refusal into a DEAD
 *  END (the organiser is asked to resolve a tie for a seat that has no
 *  candidate left), so it needs cases of its own. */
async function setupTiedLeague() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "TiedWithdraw " + randomUUID().slice(0, 6),
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
  await createEntrants(
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
  const leagueId = stages.find((s) => s.kind === "league")!.id;
  const koStageId = stages.find((s) => s.kind === "knockout")!.id;
  await generateStageFixtures(auth, koStageId);
  await generateStageFixtures(auth, leagueId);
  const fixtures = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${leagueId}`;
  for (const f of fixtures) {
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 1, p2Score: 1 } });
  }
  await completeStage(auth, leagueId);
  return { auth, koStageId };
}

/** The entrant ids the CURRENT proposal offers, in slate order. */
async function offeredIds(auth: Awaited<ReturnType<typeof setup>>["auth"], koStageId: string): Promise<string[]> {
  const proposal = await computeSeedProposal(auth, koStageId);
  return proposal.computed.qualifiers.map((q) => q.entrantId);
}

async function statusOf(entrantId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`select status from entrants where id = ${entrantId}`;
  return row!.status;
}

describe.skipIf(!HAS_DB)("a withdrawn entrant is not seedable (timing: 'setup')", () => {
  it("computeSeedProposal offers a qualifier it has NOT withdrawn, and drops her once she has", async () => {
    const { auth, koStageId } = await setup();

    // Positive half first: before any withdrawal, both pool winners are
    // offered. Without this the negative assertion below is satisfiable by a
    // filter that drops everyone.
    const before = await offeredIds(auth, koStageId);
    expect(before).toHaveLength(2);

    const departing = before[0]!;
    await withdrawEntrantCascade(auth, departing);
    expect(await statusOf(departing)).toBe("withdrawn");

    const after = await offeredIds(auth, koStageId);
    expect(after).not.toContain(departing);
    // The surviving qualifier keeps her place — a smaller bracket, not an
    // empty one, and nobody is promoted into the vacancy (owner ruling).
    expect(after).toEqual([before[1]!]);
  });

  it("computeSeedProposal keeps the surviving qualifier's SEED and destination slot unchanged — the vacancy is left open, not closed up", async () => {
    const { auth, koStageId } = await setup();
    const full = await computeSeedProposal(auth, koStageId);
    const survivor = full.computed.qualifiers[1]!;

    await withdrawEntrantCascade(auth, full.computed.qualifiers[0]!.entrantId);

    const after = await computeSeedProposal(auth, koStageId);
    expect(after.computed.qualifiers).toHaveLength(1);
    expect(after.computed.qualifiers[0]!.entrantId).toBe(survivor.entrantId);
    expect(after.computed.qualifiers[0]!.rank).toBe(survivor.rank);
    expect(after.computed.qualifiers[0]!.destinationSlot).toBe(survivor.destinationSlot);
  });

  it("confirmSeedProposal REFUSES an `edits[]` override naming a withdrawn entrant, with a typed 422", async () => {
    // The route the proposal filter cannot reach. The slate is FRESH (the
    // status flip recomputed it) and correctly omits her — but `edits[]` is
    // an organiser override over any entrant in the division, and the panel's
    // non-tied select is populated from the whole roster. This guard is what
    // stands between that control and a departed entrant in the bracket.
    const { auth, divisionId, koStageId } = await setup();
    const qualifierIds = new Set(
      (await computeSeedProposal(auth, koStageId)).computed.qualifiers.map((q) => q.entrantId),
    );
    // A NON-qualifier (a pool runner-up): she has no computed slot of her
    // own, so a refusal here can only be the departed-status guard and never
    // SEEDING_SLOT_DOUBLE_ASSIGNED.
    const all = await sql<{ id: string }[]>`select id from entrants where division_id = ${divisionId}`;
    const runnerUp = all.map((e) => e.id).find((id) => !qualifierIds.has(id))!;
    await withdrawEntrantCascade(auth, runnerUp);

    const fresh = (await getSeedProposal(auth, koStageId))!;
    expect(fresh.status).toBe("draft");
    const target = fresh.computed.qualifiers[0]!;

    const err = await confirmSeedProposal(auth, koStageId, {
      proposalId: fresh.id,
      edits: [{ destinationSlot: target.destinationSlot, entrantId: runnerUp }],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).code).toBe("SEEDING_ENTRANT_WITHDRAWN");

    // And nothing was filled — the refusal is a refusal, not a partial write.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures
      where stage_id = ${koStageId} and (home_entrant_id is not null or away_entrant_id is not null)`;
    expect(n).toBe(0);
  });

  it("confirmSeedProposal REFUSES a `tiePicks[]` order naming a withdrawn entrant — the second override route", async () => {
    const { auth, koStageId } = await setupTiedLeague();
    const before = await computeSeedProposal(auth, koStageId);
    const placed = new Set(before.computed.qualifiers.map((q) => q.entrantId));
    const departing = before.computed.ties[0]!.entrantIds.find((id) => !placed.has(id))!;
    await withdrawEntrantCascade(auth, departing);

    const fresh = (await getSeedProposal(auth, koStageId))!;
    const tie = fresh.computed.ties[0]!;
    // The offer no longer lists her — and a client that sends her anyway is refused.
    expect(tie.entrantIds).not.toContain(departing);

    const err = await confirmSeedProposal(auth, koStageId, {
      proposalId: fresh.id,
      tiePicks: [{ slots: tie.slots, order: [departing, ...tie.entrantIds] }],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).code).toBe("SEEDING_ENTRANT_WITHDRAWN");
  });

  it("confirmSeedProposal still FILLS when nobody has withdrawn — the guard refuses the departed, not the field", async () => {
    const { auth, koStageId } = await setup();
    const proposal = await computeSeedProposal(auth, koStageId);
    const out = await confirmSeedProposal(auth, koStageId, { proposalId: proposal.id });
    expect(out.filled).toBe(2);
  });

  it("confirmSeedProposal REFUSES a departed entrant on its OWN computed slate when the status was set outside patchEntrant", async () => {
    // A raw status write (a DB-level correction, or any future path that does
    // not go through patchEntrant) does NOT stale the draft, so the slate
    // itself still names her. The guard is the last line and must hold
    // regardless of how she got there — this is also the disqualified half of
    // the departed-status pair.
    const { auth, koStageId } = await setup();
    const proposal = await computeSeedProposal(auth, koStageId);
    const target = proposal.computed.qualifiers[0]!.entrantId;
    await sql`update entrants set status = 'disqualified' where id = ${target}`;

    const err = await confirmSeedProposal(auth, koStageId, { proposalId: proposal.id }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("SEEDING_ENTRANT_WITHDRAWN");
  });

  it("still raises SEEDING_RULES_MISSING when a DEPARTED qualifier is the one whose destination slot has gone missing", async () => {
    // The fixtures-don't-match-the-rules check runs over the FULL resolved
    // slate, before the departed filter. Run it after, and the one signal
    // that the generated TBD fixtures no longer match the seeding rules is
    // swallowed by the very entrant whose absence hid it — the organiser
    // gets a quietly short bracket instead of "regenerate your fixtures".
    const { auth, koStageId } = await setup();
    const proposal = await computeSeedProposal(auth, koStageId);
    const orphaned = proposal.computed.qualifiers[1]!;

    // Strip the slot label seed-2 resolves through, so that seed alone has
    // no destination slot (destinationSlotsBySeed keys off *_slot_label.seed).
    const [fixtureId, side] = orphaned.destinationSlot.split(":");
    if (side === "home") {
      await sql`update fixtures set home_slot_label = null where id = ${fixtureId!}`;
    } else {
      await sql`update fixtures set away_slot_label = null where id = ${fixtureId!}`;
    }
    await withdrawEntrantCascade(auth, orphaned.entrantId);

    const err = await computeSeedProposal(auth, koStageId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("SEEDING_RULES_MISSING");
  });
});

describe.skipIf(!HAS_DB)("a status flip refreshes the draft proposal the organiser is looking at", () => {
  // Without this the refusal is a dead end on the real screen: a withdrawal
  // leaves the frozen standings snapshot alone, so `standingsHash` does not
  // move and the draft stays 'draft' — and progression-panel.tsx renders
  // Recompute on its null and stale branches only, never on a draft. The
  // organiser's one button would be Confirm, and Confirm would 422 forever.
  it("withdrawing a qualifier recomputes the draft, so the panel stops naming her without the organiser doing anything", async () => {
    const { auth, koStageId } = await setup();
    const before = await computeSeedProposal(auth, koStageId);
    const departing = before.computed.qualifiers[0]!.entrantId;

    await withdrawEntrantCascade(auth, departing);

    // Read it the way the page does — getSeedProposal, no recompute.
    const shown = await getSeedProposal(auth, koStageId);
    expect(shown!.id).not.toBe(before.id);
    expect(shown!.status).toBe("draft");
    expect(shown!.computed.qualifiers.map((q) => q.entrantId)).not.toContain(departing);

    // And it is confirmable as it stands — no refusal to recover from.
    const out = await confirmSeedProposal(auth, koStageId, { proposalId: shown!.id });
    expect(out.filled).toBe(1);
  });

  it("un-withdrawing her puts her back in the offer — the refresh runs in both directions", async () => {
    const { auth, koStageId } = await setup();
    const before = await computeSeedProposal(auth, koStageId);
    const departing = before.computed.qualifiers[0]!.entrantId;
    await withdrawEntrantCascade(auth, departing);
    expect((await getSeedProposal(auth, koStageId))!.computed.qualifiers).toHaveLength(1);

    await patchEntrant(auth, departing, { status: "registered" });

    const shown = await getSeedProposal(auth, koStageId);
    expect(shown!.status).toBe("draft");
    expect(shown!.computed.qualifiers.map((q) => q.entrantId)).toContain(departing);
    expect(shown!.computed.qualifiers).toHaveLength(2);
  });

  it("leaves the draft STALE when the refresh's own recompute cannot run, rather than current and still naming her", async () => {
    // The refresh is best-effort, so the recompute can fail — and if it does,
    // marking the row stale is the only thing standing between the organiser
    // and a 'draft' panel that names a departed qualifier behind a Confirm
    // button that will 422. The stale branch is the one carrying Recompute.
    const { auth, koStageId } = await setup();
    const before = await computeSeedProposal(auth, koStageId);
    const departing = before.computed.qualifiers[0]!.entrantId;

    // Break this stage's seeding resolution: with no slot labels,
    // destinationSlotsBySeed comes back empty and computeSeedProposal throws
    // SEEDING_RULES_MISSING — before it reaches its OWN draft-staling write.
    await sql`update fixtures set home_slot_label = null, away_slot_label = null
              where stage_id = ${koStageId}`;

    await withdrawEntrantCascade(auth, departing);

    const shown = await getSeedProposal(auth, koStageId);
    expect(shown!.id).toBe(before.id); // the recompute failed: no new draft
    expect(shown!.status).toBe("stale"); // ...and the old one is not offered as current
  });

  it("a patch that does NOT cross the field boundary leaves the draft alone", async () => {
    const { auth, koStageId } = await setup();
    const before = await computeSeedProposal(auth, koStageId);
    const someone = before.computed.qualifiers[0]!.entrantId;

    // registered -> confirmed: both sides of the boundary are 'in the field',
    // so this must not churn a fresh proposal row.
    await patchEntrant(auth, someone, { status: "confirmed" });

    const shown = await getSeedProposal(auth, koStageId);
    expect(shown!.id).toBe(before.id);
    expect(shown!.status).toBe("draft");
  });
});

describe.skipIf(!HAS_DB)("a flagged tie never becomes a dead end when one of the tied entrants departs", () => {
  it("drops a departed entrant from the tie's CANDIDATES while keeping the tie itself", async () => {
    const { auth, koStageId } = await setupTiedLeague();
    const before = await computeSeedProposal(auth, koStageId);
    expect(before.computed.ties).toHaveLength(1);
    expect(before.computed.ties[0]!.entrantIds).toHaveLength(4);

    // A tied entrant the engine did NOT provisionally place, so only the
    // candidate list changes — the slate and the tie's slots do not.
    const placed = new Set(before.computed.qualifiers.map((q) => q.entrantId));
    const departing = before.computed.ties[0]!.entrantIds.find((id) => !placed.has(id))!;
    await withdrawEntrantCascade(auth, departing);

    const after = await computeSeedProposal(auth, koStageId);
    expect(after.computed.ties).toHaveLength(1);
    const tie = after.computed.ties[0]!;
    expect(tie.entrantIds).not.toContain(departing);
    expect(tie.entrantIds).toHaveLength(3);
    // Not over-refused: both seats are still contested, so both are still asked about.
    expect(tie.slots).toEqual(before.computed.ties[0]!.slots);
    expect(after.computed.qualifiers).toHaveLength(2);
  });

  it("drops the VACATED seat from the tie's slots, so no tie asks about a seat with no candidate", async () => {
    const { auth, koStageId } = await setupTiedLeague();
    const before = await computeSeedProposal(auth, koStageId);
    const [keep, vacate] = before.computed.qualifiers;
    await withdrawEntrantCascade(auth, vacate!.entrantId);

    const after = await computeSeedProposal(auth, koStageId);
    expect(after.computed.qualifiers).toHaveLength(1);
    const tie = after.computed.ties[0]!;
    expect(tie.slots).toEqual([keep!.destinationSlot]);
    expect(tie.slots).not.toContain(vacate!.destinationSlot);

    // And the organiser can actually finish: resolving the one remaining
    // tied seat confirms, rather than 422ing on a seat nobody can fill.
    const out = await confirmSeedProposal(auth, koStageId, {
      proposalId: after.id,
      edits: [{ destinationSlot: keep!.destinationSlot, entrantId: tie.entrantIds[0]! }],
    });
    expect(out.filled).toBe(1);
  });

  it("drops the tie ENTIRELY once one candidate is left, and the confirm then goes through", async () => {
    const { auth, koStageId } = await setupTiedLeague();
    const before = await computeSeedProposal(auth, koStageId);
    const survivor = before.computed.qualifiers[0]!;
    for (const id of before.computed.ties[0]!.entrantIds) {
      if (id !== survivor.entrantId) await withdrawEntrantCascade(auth, id);
    }

    const after = await computeSeedProposal(auth, koStageId);
    // One candidate is no ambiguity to resolve — dropping it is not the
    // "silently ordered tie" the design forbids, there is nothing to order.
    expect(after.computed.ties).toEqual([]);
    expect(after.computed.qualifiers.map((q) => q.entrantId)).toEqual([survivor.entrantId]);

    // The dead end this whole block exists to prevent: with the tie still
    // flagged over two seats, this confirm 422s SEEDING_TIE_UNRESOLVED and
    // no edit the organiser can send will satisfy it.
    const out = await confirmSeedProposal(auth, koStageId, { proposalId: after.id });
    expect(out.filled).toBe(1);
  });
});
