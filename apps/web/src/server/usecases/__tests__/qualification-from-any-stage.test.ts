// L3/#414 pass 3: qualification out of EVERY stage kind, not just tables.
// Real Postgres required; skipped without DATABASE_URL. Passes 1 (engine)
// and 2 (engine-db placement snapshots) are covered by their own suites —
// this file exercises seedNextStage's routing on top of them: KO -> plate
// (losersOfRound), qualifying-KO -> main (topN over bracket placements),
// americano -> KO (personal points, mapped to individual entrants, not the
// stage's own ephemeral pair entrants), ladder -> KO (ladder order), and the
// carry-over guard refusing a non-table source.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import {
  createStages,
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  generateStageFixtures,
  issueChallenge,
} from "../stages";
import { americanoView } from "../americano";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";

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
    insert into organizations (name, slug) values (${"Qfa " + suffix}, ${"qfa-" + suffix})
    returning id`;
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
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

async function seedDivision(auth: AuthCtx, names: string[], individualsWithPersons = false) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Qfa Cup " + randomUUID().slice(0, 6),
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
    await Promise.all(
      names.map(async (name, i) => ({
        kind: "individual" as const,
        display_name: name,
        seed: i + 1,
        members: individualsWithPersons
          ? [
              {
                person_id: (
                  await createPerson(auth, {
                    full_name: name,
                    consent: {},
                    dob: null,
                    gender: null,
                    external_ref: null,
                  })
                ).id,
                is_captain: false,
                roles: [],
                default_position_key: null,
                squad_number: null,
              },
            ]
          : [],
      })),
    ),
  );
  return { comp, division, entrants };
}

async function decide(auth: AuthCtx, fixtureId: string, hs: number, as_: number) {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  return scoreEvent(auth, fixtureId, {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: hs, p2Score: as_ },
  });
}

/** Decide every currently-decidable (both slots filled, not yet decided)
 *  fixture in a stage, regenerating between passes so later-round winner
 *  feeds are wired, until nothing is left to decide. Home always wins by
 *  lower seed — deterministic, so a test can predict who reaches the final
 *  without knowing the bracket's internal pairing order. */
async function decideWholeBracket(
  auth: AuthCtx,
  stageId: string,
  seedOf: Map<string, number>,
): Promise<void> {
  for (let guard = 0; guard < 10; guard++) {
    await generateStageFixtures(auth, stageId).catch(() => undefined);
    const rows = await sql<
      { id: string; home_entrant_id: string | null; away_entrant_id: string | null; status: string }[]
    >`select id, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stageId}`;
    const decidable = rows.filter(
      (f) => f.home_entrant_id && f.away_entrant_id && !["decided", "finalized"].includes(f.status),
    );
    if (decidable.length === 0) return;
    for (const f of decidable) {
      const homeWins = (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99);
      await decide(auth, f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
  }
  throw new Error(`decideWholeBracket(${stageId}): did not converge`);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("qualification from any stage kind (L3/#414 pass 3)", () => {
  it("knockout -> plate: round-1 losers seed the plate, in bracket order", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["A", "B", "C", "D", "E", "F", "G", "H"]);
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
    const [main, plate] = await createStages(auth, division.id, [
      { seq: 1, kind: "knockout", name: "Main", config: {} },
      {
        seq: 2,
        kind: "knockout",
        name: "Plate",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
          placement: "rank_order",
          timing: "on_complete",
        },
      },
    ]);
    await generateStageFixtures(auth, main!.id);
    await startDivision(auth, division.id);
    const r1 = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures
      where stage_id = ${main!.id}
        and round_no = (select min(round_no) from fixtures where stage_id = ${main!.id})
      order by seq_in_round`;
    expect(r1).toHaveLength(4);
    const expectedLosers = r1.map((f) =>
      (seedOf.get(f.home_entrant_id) ?? 99) < (seedOf.get(f.away_entrant_id) ?? 99)
        ? f.away_entrant_id
        : f.home_entrant_id,
    );

    await decideWholeBracket(auth, main!.id, seedOf);
    const done = await completeStage(auth, main!.id);
    expect(done.completed).toBe(true);
    expect(done.qualified?.stage_id).toBe(plate!.id);
    expect(done.qualified?.entrants).toEqual(expectedLosers);

    const plateGen = await generateStageFixtures(auth, plate!.id);
    expect(plateGen.created + plateGen.existing).toBe(3); // 4-entrant single elim
  });

  // F3 review item 5 (RESOLVED) — the on_complete sibling above always
  // worked; this is the SAME shape under timing:"setup" (ko_plate's actual
  // catalogue shape today, since F3 flipped every picker template to
  // day-one fixtures), which routes through sourcesToTables
  // (stage-seeding.ts) instead of seedNextStage's own tablesForCompletedStage
  // — and sourcesToTables never fetched bracket data, so a roundLosers take
  // could never resolve (STAGE_NOT_READY), silently swallowed by
  // completeStage's best-effort catch. An organiser's plate stage stayed on
  // TBD forever with no visible error.
  it("knockout -> plate (timing: setup): computeSeedProposal resolves round-1 losers, confirm seats them in bracket order", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["A", "B", "C", "D", "E", "F", "G", "H"]);
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
    const [main, plate] = await createStages(auth, division.id, [
      { seq: 1, kind: "knockout", name: "Main", config: {} },
      {
        seq: 2,
        kind: "knockout",
        name: "Plate",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);

    // Day-one: the plate's TBD bracket exists before Main has even
    // generated — the whole point of F3's flip to timing:"setup".
    const plateDayOne = await generateStageFixtures(auth, plate!.id);
    expect(plateDayOne.created).toBe(3); // 4-entrant single elim

    await generateStageFixtures(auth, main!.id);
    await startDivision(auth, division.id);
    const r1 = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures
      where stage_id = ${main!.id}
        and round_no = (select min(round_no) from fixtures where stage_id = ${main!.id})
      order by seq_in_round`;
    expect(r1).toHaveLength(4);
    const expectedLosers = r1.map((f) =>
      (seedOf.get(f.home_entrant_id) ?? 99) < (seedOf.get(f.away_entrant_id) ?? 99)
        ? f.away_entrant_id
        : f.home_entrant_id,
    );

    await decideWholeBracket(auth, main!.id, seedOf);

    // "complete": setup timing never auto-fills — completeStage computes a
    // DRAFT proposal instead (ruling 12). Before this fix, this came back
    // undefined (STAGE_NOT_READY swallowed inside computeSeedProposal).
    const done = await completeStage(auth, main!.id);
    expect(done.completed).toBe(true);
    expect(done.seed_proposal).toBeDefined();

    // "propose": explicit recompute — the real endpoint an organiser's UI
    // hits, over the SAME sourcesToTables path the fix lives in.
    const proposal = await computeSeedProposal(auth, plate!.id);
    expect(proposal.computed.qualifiers.map((q) => q.entrantId)).toEqual(expectedLosers);
    expect(proposal.computed.ties).toEqual([]);

    // "confirm": fills the plate's TBD fixtures through the same fillSlot
    // pathway intra-bracket advancement uses.
    const confirmed = await confirmSeedProposal(auth, plate!.id, { proposalId: proposal.id });
    expect(confirmed.filled).toBe(4);
    const seated = new Set(
      confirmed.fixtures
        .flatMap((f) => [f.home_entrant_id, f.away_entrant_id])
        .filter((id): id is string => id !== null),
    );
    for (const loser of expectedLosers) expect(seated.has(loser)).toBe(true);
  });

  it("knockout -> knockout: topN advances by final bracket placement", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
    const [qualifying, main] = await createStages(auth, division.id, [
      { seq: 1, kind: "knockout", name: "Qualifying", config: {} },
      {
        seq: 2,
        kind: "knockout",
        name: "Main",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "on_complete",
        },
      },
    ]);
    await generateStageFixtures(auth, qualifying!.id);
    await startDivision(auth, division.id);
    await decideWholeBracket(auth, qualifying!.id, seedOf);

    // The placement snapshot is written AT completion (engine-db pass 2) —
    // read it back after, not before, completeStage.
    const done = await completeStage(auth, qualifying!.id);
    expect(done.completed).toBe(true);
    expect(done.qualified?.stage_id).toBe(main!.id);

    const [snap] = await sql<{ rows: { entrantId: string; rank: number }[] }[]>`
      select rows from standings_snapshots where stage_id = ${qualifying!.id} and pool_id is null`;
    const expectedTop2 = [...snap!.rows].sort((a, b) => a.rank - b.rank).slice(0, 2).map((r) => r.entrantId);
    expect(done.qualified?.entrants).toEqual(expectedTop2);
  });

  it("americano -> knockout: ranks by personal points, mapped to individual entrants", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["P1", "P2", "P3", "P4"], true);
    const [americano, ko] = await createStages(auth, division.id, [
      {
        seq: 1,
        kind: "americano" as never,
        name: "Americano",
        config: { mode: "americano", courtCount: 1, rounds: 3 },
      },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "on_complete",
        },
      },
    ]);
    const { fixtures } = await generateStageFixtures(auth, americano!.id);
    expect(fixtures).toHaveLength(3); // 1 court x 3 rounds, all 4 players every round
    await startDivision(auth, division.id);

    const pairIds = [...new Set(fixtures.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))].filter(
      (id): id is string => id !== null,
    );
    const pairMembers = await sql<{ entrant_id: string; person_id: string }[]>`
      select entrant_id, person_id from entrant_members where entrant_id in ${sql(pairIds)}`;
    const personsOfPair = (entrantId: string) =>
      pairMembers.filter((m) => m.entrant_id === entrantId).map((m) => m.person_id);

    const expectedPoints = new Map<string, number>();
    for (const [i, f] of fixtures.entries()) {
      const homeScore = (i + 1) * 10;
      const awayScore = 0;
      await decide(auth, f.id, homeScore, awayScore);
      for (const p of personsOfPair(f.home_entrant_id!)) {
        expectedPoints.set(p, (expectedPoints.get(p) ?? 0) + homeScore);
      }
      for (const p of personsOfPair(f.away_entrant_id!)) {
        expectedPoints.set(p, (expectedPoints.get(p) ?? 0) + awayScore);
      }
    }

    const done = await completeStage(auth, americano!.id);
    expect(done.completed).toBe(true);
    expect(done.qualified?.stage_id).toBe(ko!.id);

    // individual entrant <-> person, from the ORIGINAL registered entrants —
    // never the ephemeral pair entrants the fixtures actually ran on.
    const individualMembers = await sql<{ entrant_id: string; person_id: string }[]>`
      select entrant_id, person_id from entrant_members where entrant_id in ${sql(entrants.map((e) => e.id))}`;
    const entrantOfPerson = new Map(individualMembers.map((m) => [m.person_id, m.entrant_id]));
    const nameOfEntrant = new Map(entrants.map((e) => [e.id, e.display_name]));
    const nameOfPerson = new Map(
      individualMembers.map((m) => [m.person_id, nameOfEntrant.get(m.entrant_id)!]),
    );

    // Same tie-break the leaderboard SQL uses (points desc, name asc) — over
    // the SAME ground truth this test chose the scores from, not re-derived
    // from the code under test.
    const ranked = [...expectedPoints.entries()].sort(
      (a, b) => b[1] - a[1] || nameOfPerson.get(a[0])!.localeCompare(nameOfPerson.get(b[0])!),
    );
    expect(ranked).toHaveLength(4); // every player appears (1 court = all 4 play every round)
    const expectedTop2 = ranked.slice(0, 2).map(([personId]) => entrantOfPerson.get(personId)!);
    expect(done.qualified?.entrants).toEqual(expectedTop2);
    // None of the qualified ids is a `pair` entrant.
    for (const id of done.qualified!.entrants) expect(pairIds).not.toContain(id);

    // Regression: exactly one americano ranking implementation — the live
    // display leaderboard agrees with what qualification just used.
    const view = await americanoView(auth, americano!.id);
    expect(view.leaderboard.map((l) => l.person_id)).toEqual(ranked.map(([personId]) => personId));
  });

  it("ladder -> knockout: seeds by ladder order", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["L1", "L2", "L3", "L4", "L5"]);
    const [ladder, ko] = await createStages(auth, division.id, [
      { seq: 1, kind: "ladder" as never, name: "Ladder", config: { challengeRange: 3 } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
          placement: "rank_order",
          timing: "on_complete",
        },
      },
    ]);
    await generateStageFixtures(auth, ladder!.id); // no-op: ladder fixtures are on-demand
    await startDivision(auth, division.id).catch(() => undefined); // ladder may not need start
    const challenge = await issueChallenge(auth, ladder!.id, {
      challenger_id: entrants[2]!.id,
      opponent_id: entrants[0]!.id,
    });
    await decide(auth, challenge.fixture_id, 2, 0); // challenger wins, takes the position

    const [cfg] = await sql<{ config: { ladder_order: string[] } }[]>`
      select config from stages where id = ${ladder!.id}`;
    const order = cfg!.config.ladder_order;

    const done = await completeStage(auth, ladder!.id);
    expect(done.completed).toBe(true);
    expect(done.qualified?.stage_id).toBe(ko!.id);
    expect(done.qualified?.entrants).toEqual(order.slice(0, 4));
  });

  it("carry-over is refused from a bracket, ladder or americano source", async () => {
    const { auth } = await seedOrg();

    {
      const { division } = await seedDivision(auth, ["A", "B"]);
      const [ko] = await createStages(auth, division.id, [
        { seq: 1, kind: "knockout", name: "KO", config: {} },
        {
          seq: 2,
          kind: "knockout",
          name: "Next",
          config: {},
          progression: {
            // to:2, not to:1 — validateProgressionAgainstShapes (F2, engine)
            // now enforces a uniform "at least 2 qualifiers" floor across
            // BOTH timings (previously only .seeding had it); the carry
            // refusal this test targets fires downstream in seedNextStage,
            // so the source stage just needs 2+ real entrants to reach it.
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
            placement: "rank_order",
            timing: "on_complete",
            carry: "points",
          },
        },
      ]);
      const { fixtures } = await generateStageFixtures(auth, ko!.id);
      await startDivision(auth, division.id);
      await decide(auth, fixtures[0]!.id, 2, 0);
      await expect(completeStage(auth, ko!.id)).rejects.toSatisfy((err: unknown) =>
        EngineError.is(err, "CONFIG_INVALID"),
      );
    }

    {
      const { division, entrants } = await seedDivision(auth, ["L1", "L2", "L3"]);
      const [ladder] = await createStages(auth, division.id, [
        { seq: 1, kind: "ladder" as never, name: "Ladder", config: { challengeRange: 2 } },
        {
          seq: 2,
          kind: "knockout",
          name: "Next",
          config: {},
          progression: {
            // to:2, not to:1 — validateProgressionAgainstShapes (F2, engine)
            // now enforces a uniform "at least 2 qualifiers" floor across
            // BOTH timings (previously only .seeding had it); the carry
            // refusal this test targets fires downstream in seedNextStage,
            // so the source stage just needs 2+ real entrants to reach it.
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
            placement: "rank_order",
            timing: "on_complete",
            carry: "points",
          },
        },
      ]);
      await generateStageFixtures(auth, ladder!.id);
      await startDivision(auth, division.id).catch(() => undefined); // ladder may not need start
      const challenge = await issueChallenge(auth, ladder!.id, {
        challenger_id: entrants[1]!.id,
        opponent_id: entrants[0]!.id,
      });
      await decide(auth, challenge.fixture_id, 2, 0);
      await expect(completeStage(auth, ladder!.id)).rejects.toSatisfy((err: unknown) =>
        EngineError.is(err, "CONFIG_INVALID"),
      );
    }

    {
      const { division } = await seedDivision(auth, ["P1", "P2", "P3", "P4"], true);
      const [americano] = await createStages(auth, division.id, [
        {
          seq: 1,
          kind: "americano" as never,
          name: "Am",
          config: { mode: "americano", courtCount: 1, rounds: 1 },
        },
        {
          seq: 2,
          kind: "knockout",
          name: "Next",
          config: {},
          progression: {
            // to:2, not to:1 — validateProgressionAgainstShapes (F2, engine)
            // now enforces a uniform "at least 2 qualifiers" floor across
            // BOTH timings (previously only .seeding had it); the carry
            // refusal this test targets fires downstream in seedNextStage,
            // so the source stage just needs 2+ real entrants to reach it.
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
            placement: "rank_order",
            timing: "on_complete",
            carry: "points",
          },
        },
      ]);
      const { fixtures } = await generateStageFixtures(auth, americano!.id);
      await startDivision(auth, division.id);
      for (const f of fixtures) await decide(auth, f.id, 2, 0);
      await expect(completeStage(auth, americano!.id)).rejects.toSatisfy((err: unknown) =>
        EngineError.is(err, "CONFIG_INVALID"),
      );
    }
  });
});
