// Re-review C1 + I1 (2026-09-21). Graduated from the reviewer's probes 4, 5
// and 6, with real oracles in place of the probes' `note()` dumps.
//
// C1: a vacated seat's walkover settles the line (F2, already shipped) but its
// WINNER never advanced. A genuine bye's winner is standing in the next round
// because `destinationSlotsBySeed` expands that seed into BOTH of its slots —
// a vacated seat has no seed to expand, so the next round's slot was never
// fed, and every bracket deeper than one round was left unable to complete.
// All ten shipped template progressions are `timing: "setup"`, so the reach is
// every one of them.
//
// I1: a second Generate used to overwrite the BYE stamp with the descriptor's
// own `slot.winner_group` label, un-settling the line.
//
// Oracles are derived, never typed: the survivor comes from the proposal's own
// destinationSlot map and the row's `winner_to_fixture`/`winner_to_slot` feed,
// so a change to the seeding source of truth moves the test with it.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { isBye } from "@/lib/run-sheet-groups";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
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
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string } | null;
  away_slot_label: { key?: string } | null;
  status: string;
  outcome: { kind?: string; winner?: string } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, status, outcome,
           winner_to_fixture, winner_to_slot
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  koStageId: string;
}

/** `pools` groups of 2, each group's winner qualifying into a `setup`-timed
 *  knockout — the shape every shipped template uses. */
async function setup(pools: number): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "C1 " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: pools * 2 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const stages = await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: pools } } },
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
  await generateStageFixtures(auth, koStageId);
  await generateStageFixtures(auth, groupStageId);
  for (const f of await sql<{ id: string }[]>`select id from fixtures where stage_id = ${groupStageId}`) {
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  }
  await completeStage(auth, groupStageId);
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  return { auth, divisionId: division.id, koStageId };
}

/** Play `fixture` to a decision for whoever is in home. */
async function play(auth: AuthCtx, fixtureId: string): Promise<void> {
  await scoreEvent(auth, fixtureId, {
    expected_seq: (await getFixtureState(auth, fixtureId)).last_seq,
    type: "core.start",
    payload: {},
  });
  await scoreEvent(auth, fixtureId, {
    expected_seq: (await getFixtureState(auth, fixtureId)).last_seq,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 0 },
  });
}

/** Confirm the stage after `departures` qualifiers (lowest-ranked first) have
 *  left, and hand back the rows. */
async function confirmAfterDepartures(rig: Rig, departures: number): Promise<Row[]> {
  const full = await computeSeedProposal(rig.auth, rig.koStageId);
  const ranked = [...full.computed.qualifiers].sort((a, b) => b.rank - a.rank);
  for (let i = 0; i < departures; i++) {
    await withdrawEntrantCascade(rig.auth, ranked[i]!.entrantId);
  }
  const proposal = departures === 0 ? full : (await getSeedProposal(rig.auth, rig.koStageId))!;
  await confirmSeedProposal(rig.auth, rig.koStageId, { proposalId: proposal.id });
  return rowsOf(rig.koStageId);
}

describe.skipIf(!HAS_DB)("a vacated seat's walkover advances its winner (re-review C1)", () => {
  it("the next round OPENS AT the survivor, not at an empty TBD slot", async () => {
    const rig = await setup(4); // 4 qualifiers -> two semis and a final
    const rows = await confirmAfterDepartures(rig, 1);

    // The line the vacated seat settled. Derived from the data, not named:
    // exactly one fixture is an awarded bye after a single departure.
    const byes = rows.filter((r) => r.outcome?.kind === "award");
    expect(byes).toHaveLength(1);
    const bye = byes[0]!;
    expect(bye.status).toBe("forfeited");
    const survivor = bye.outcome!.winner;
    // The award went to the entrant who IS in the line — the engine's own
    // rule, read back off the row rather than assumed.
    expect(survivor).toBe(bye.home_entrant_id ?? bye.away_entrant_id);
    expect(survivor).not.toBeNull();

    // C1 — the feed this line owns must now hold that survivor. `winner_to_*`
    // is the only advancement channel in this schema; onDecided uses the same
    // pair for a played fixture.
    expect(bye.winner_to_fixture).not.toBeNull();
    expect([1, 2]).toContain(bye.winner_to_slot);
    const next = rows.find((r) => r.id === bye.winner_to_fixture)!;
    const seated = bye.winner_to_slot === 1 ? next.home_entrant_id : next.away_entrant_id;
    expect(seated).toBe(survivor);

    // ...and the label that was standing in for her is gone, so the next
    // round does not also advertise a TBD on the side she now occupies.
    const label = bye.winner_to_slot === 1 ? next.home_slot_label : next.away_slot_label;
    expect(label).toBeNull();
  });

  it("CONTROL — a FULL slate stamps no bye anywhere: only a VACATED seat is a bye", async () => {
    // The vacated stamp is guarded twice — by the `!expandedSlots.has(slot)`
    // filter that builds the list, and by the `*_entrant_id is null` predicate
    // on each UPDATE. Dropping BOTH (the reviewer's N32) relabels seats a
    // qualifier is sitting in, which is what this scans the whole stage for.
    const rig = await setup(4);
    const rows = await confirmAfterDepartures(rig, 0);
    expect(rows).toHaveLength(3); // two semis and a final
    const stamped = rows.flatMap((r) =>
      [r.home_slot_label, r.away_slot_label]
        .filter((l) => l?.key === "bracket.slot.bye")
        .map(() => r.ext_key),
    );
    expect(stamped).toEqual([]);
    expect(rows.filter((r) => r.round_no === 1).every((r) => r.status === "scheduled")).toBe(true);
    expect(rows.some((r) => r.outcome !== null)).toBe(false);
  });

  it("CONTROL — a genuine bye (3 qualifiers, nobody withdraws) seats its winner in the same place", async () => {
    const rig = await setup(3); // 3 qualifiers into a 4-slot bracket
    const rows = await confirmAfterDepartures(rig, 0);
    const bye = rows.find((r) => r.outcome?.kind === "award")!;
    expect(bye.status).toBe("forfeited");
    const next = rows.find((r) => r.id === bye.winner_to_fixture)!;
    const seated = bye.winner_to_slot === 1 ? next.home_entrant_id : next.away_entrant_id;
    expect(seated).toBe(bye.outcome!.winner);
  });

  it("plays through to a champion: 4 qualifiers, one withdraws", async () => {
    const rig = await setup(4);
    const rows = await confirmAfterDepartures(rig, 1);

    // The real semifinal — the one with two live entrants.
    const semi = rows.find(
      (r) => r.round_no === 1 && r.home_entrant_id !== null && r.away_entrant_id !== null,
    )!;
    await play(rig.auth, semi.id);

    const afterSemi = await rowsOf(rig.koStageId);
    const final = afterSemi.find((r) => r.round_no === 2)!;
    // Both seats of the final are real people: one from the played semi, one
    // from the walked-over one. Before C1 the walked-over side was null.
    expect(final.home_entrant_id).not.toBeNull();
    expect(final.away_entrant_id).not.toBeNull();
    expect(final.status).toBe("scheduled");

    await play(rig.auth, final.id);
    const played = (await rowsOf(rig.koStageId)).find((r) => r.round_no === 2)!;
    expect(played.outcome?.winner).toBe(final.home_entrant_id);

    // And the stage can finish — the thing a stuck bracket denied outright.
    await expect(completeStage(rig.auth, rig.koStageId)).resolves.toBeDefined();
    const [stage] = await sql<{ status: string }[]>`
      select status from stages where id = ${rig.koStageId}`;
    // `complete`, not `completed` — the value `seedNextStage`'s own
    // "every stage <> 'complete'" guard reads (stages.ts).
    expect(stage!.status).toBe("complete");
  });

  it("plays through to a champion: 8 qualifiers, one withdraws (three rounds)", async () => {
    const rig = await setup(8);
    let rows = await confirmAfterDepartures(rig, 1);
    // Three rounds: QF, SF, F.
    expect(new Set(rows.map((r) => r.round_no))).toEqual(new Set([1, 2, 3]));
    for (let round = 1; round <= 3; round++) {
      for (const f of rows.filter((r) => r.round_no === round && r.status === "scheduled")) {
        expect(f.home_entrant_id).not.toBeNull();
        expect(f.away_entrant_id).not.toBeNull();
        await play(rig.auth, f.id);
      }
      rows = await rowsOf(rig.koStageId);
    }
    const final = rows.find((r) => r.round_no === 3)!;
    expect(final.outcome?.winner).toBeTruthy();
    await expect(completeStage(rig.auth, rig.koStageId)).resolves.toBeDefined();
  });
});

describe.skipIf(!HAS_DB)("a second Generate does not un-settle a vacated seat (re-review I1)", () => {
  it("the BYE stamp and its award survive a re-Generate", async () => {
    const rig = await setup(2); // 2 qualifiers -> one final
    const before = (await confirmAfterDepartures(rig, 1))[0]!;
    expect(before.status).toBe("forfeited");
    expect(before.outcome?.kind).toBe("award");
    const vacatedSide = before.home_entrant_id === null ? "home" : "away";
    const stampedBefore =
      vacatedSide === "home" ? before.home_slot_label : before.away_slot_label;
    expect(stampedBefore?.key).toBe("bracket.slot.bye");
    expect(isBye(before as never)).toBe(true);

    await generateStageFixtures(rig.auth, rig.koStageId);

    const after = (await rowsOf(rig.koStageId))[0]!;
    expect(after.id).toBe(before.id);
    const stampedAfter = vacatedSide === "home" ? after.home_slot_label : after.away_slot_label;
    expect(stampedAfter?.key).toBe("bracket.slot.bye");
    expect(after.status).toBe("forfeited");
    expect(after.outcome?.kind).toBe("award");
    expect(isBye(after as never)).toBe(true);
  });

  it("CONTROL — a full slate's descriptor labels are still written on a re-Generate", async () => {
    const rig = await setup(2);
    const rows = await confirmAfterDepartures(rig, 0);
    const final = rows[0]!;
    expect(final.home_entrant_id).not.toBeNull();
    expect(final.away_entrant_id).not.toBeNull();
    // A filled seat carries no label — before and after. The I1 guard must not
    // start writing one back onto a seated side.
    expect(final.home_slot_label).toBeNull();
    await generateStageFixtures(rig.auth, rig.koStageId);
    const after = (await rowsOf(rig.koStageId))[0]!;
    expect(after.home_slot_label).toBeNull();
    expect(after.away_slot_label).toBeNull();
    expect(after.home_entrant_id).toBe(final.home_entrant_id);
  });
});
