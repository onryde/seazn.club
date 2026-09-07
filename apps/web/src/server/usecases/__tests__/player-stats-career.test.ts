// S9/#418 — DB integration + regression coverage for personCareerStats (the
// org-scoped `?group=sport` rollup). Real Postgres required.
//
// The mandatory asymmetric scenario (see this programme's own dispatch):
// ONE person across football (1 division) and badminton (2 divisions, same
// variant_key), with genuinely different metric sets and genuinely
// different division counts per sport — two symmetric divisions cannot
// catch a first-row-wins or wrong-group-by bug, which is exactly how this
// repo's grouping bugs have survived a green suite before.
//
// Snapshot rows are RAW-INSERTED (same pattern listMyPlayerStats's own test
// and player-stats-merged.test.ts's `snapshot()` reader already use) — this
// file is proving the READ/aggregation side (personCareerStats never calls
// recomputePlayerStats and must never re-derive what a snapshot already
// says), not the write side, which player-stats.test.ts already covers
// through the real scoring pipeline. Fixtures are RAW-INSERTED too (mirrors
// entrant-members.test.ts's own seedDivisionWithTwoFixtures), since the
// "matches" count reads fixtures/entrant_members directly, never a
// declared playerStats metric.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, archiveDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { divisionPlayerStats } from "../player-stats";
import { putLineup } from "../fixtures";
import { scoreEvent } from "../scoring";
import { personCareerStats } from "../player-stats";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Career " + suffix}, ${"career-" + suffix})
    returning id`;
  await setOrgPlan(orgId, "pro"); // stats.player.career (the rollup this file exercises) is Pro-gated — W3-A split it from stats.player, the now-free per-division record
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', ${football.version}, ${sql.json(football.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('badminton', 'Badminton', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('badminton', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('volleyball', 'Volleyball', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('volleyball', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

/** A division + ONE stage (raw insert, mirrors entrant-members.test.ts's own
 *  seed) — this file controls fixtures/snapshots directly rather than
 *  running real scoring, so no generateStageFixtures/startDivision needed. */
async function seedDivisionWithStage(
  auth: AuthCtx,
  sportKey: string,
  variantKey: string,
  name: string,
): Promise<{ divisionId: string; stageId: string; competitionId: string }> {
  const suffix = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `${name} Cup ${suffix}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${suffix}`,
    sport_key: sportKey,
    variant_key: variantKey,
    config: {},
  });
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${division.id}, 1, 'league', 'League')
    returning id`;
  return { divisionId: division.id, stageId, competitionId: comp.id };
}

async function makeEntrant(
  auth: AuthCtx,
  divisionId: string,
  kind: "team" | "individual" | "pair",
  displayName: string,
  personIds: string[],
): Promise<string> {
  const entrants = await createEntrants(auth, divisionId, [
    {
      kind,
      display_name: displayName,
      seed: 1,
      members: personIds.map((person_id) => ({
        person_id,
        squad_number: null,
        is_captain: false,
        roles: [],
        default_position_key: null,
      })),
    } as never,
  ]);
  return entrants[0]!.id;
}

let roundCounter = 0;
async function insertFinalizedFixture(
  stageId: string,
  divisionId: string,
  homeEntrantId: string,
  awayEntrantId: string,
): Promise<string> {
  roundCounter += 1;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${stageId}, ${divisionId}, ${roundCounter}, 1, ${homeEntrantId}, ${awayEntrantId}, 'finalized')
    returning id`;
  return id;
}

/** Same raw insert as insertFinalizedFixture, but left 'decided' — the
 *  status a fixture reaches once the fold has an outcome but nobody has
 *  explicitly advanced it to 'finalized' (fixtureStatusFromFold,
 *  engine-db/append-event.ts). Exists to prove review round 2, finding 1:
 *  countMatchesByDivision used to filter on `status = 'finalized'` alone in
 *  all three call sites (player-stats.ts/me.ts/public-site/data.ts), so a
 *  fixture stuck here counted zero matches despite recomputePlayerStats
 *  (which puts NO status filter on its own score_events read) contributing
 *  its stats to the snapshot anyway. */
async function insertDecidedFixture(
  stageId: string,
  divisionId: string,
  homeEntrantId: string,
  awayEntrantId: string,
): Promise<string> {
  roundCounter += 1;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${stageId}, ${divisionId}, ${roundCounter}, 1, ${homeEntrantId}, ${awayEntrantId}, 'decided')
    returning id`;
  return id;
}

async function insertSnapshot(
  divisionId: string,
  personId: string,
  sportKey: string,
  stats: Record<string, number>,
): Promise<void> {
  await sql`
    insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
    values (${divisionId}, ${personId}, ${sportKey}, ${sql.json(stats as never)}, 1)`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("personCareerStats (S9/#418)", () => {
  it("ASYMMETRIC: 2 sports, 3 divisions (1 football + 2 badminton), real cross-division summation, variants != divisions, matches summed, team-entrant sport produces NO phantom row", async () => {
    const { auth } = await seedOrg();
    const person = await createPerson(auth, {
      full_name: "Robin Career",
      consent: { public_name: true },
      dob: null,
      gender: null,
      external_ref: null,
    });
    const filler = async (name: string) =>
      createPerson(auth, { full_name: name, consent: {}, dob: null, gender: null, external_ref: null });

    // --- football: ONE division ---
    const fb = await seedDivisionWithStage(auth, "football", "default", "Open");
    const fbOpponent = await filler("FB Opponent");
    const fbMine = await makeEntrant(auth, fb.divisionId, "team", "Robin FC", [person.id]);
    const fbTheirs = await makeEntrant(auth, fb.divisionId, "team", "Opponent FC", [fbOpponent.id]);
    await insertFinalizedFixture(fb.stageId, fb.divisionId, fbMine, fbTheirs);
    await insertFinalizedFixture(fb.stageId, fb.divisionId, fbMine, fbTheirs);
    await insertSnapshot(fb.divisionId, person.id, "football", { goals: 3, assists: 1 });

    // --- badminton: TWO divisions, SAME variant_key ('default') ---
    const bd1 = await seedDivisionWithStage(auth, "badminton", "default", "Spring");
    const bd1Opp = await filler("BD1 Opponent");
    const bd1Mine = await makeEntrant(auth, bd1.divisionId, "individual", "Robin Spring", [person.id]);
    const bd1Theirs = await makeEntrant(auth, bd1.divisionId, "individual", "Opponent Spring", [bd1Opp.id]);
    await insertFinalizedFixture(bd1.stageId, bd1.divisionId, bd1Mine, bd1Theirs);
    await insertFinalizedFixture(bd1.stageId, bd1.divisionId, bd1Mine, bd1Theirs);
    await insertFinalizedFixture(bd1.stageId, bd1.divisionId, bd1Mine, bd1Theirs);
    await insertSnapshot(bd1.divisionId, person.id, "badminton", { points_won: 15, sets_won: 2 });

    const bd2 = await seedDivisionWithStage(auth, "badminton", "default", "Summer");
    const bd2Opp = await filler("BD2 Opponent");
    const bd2Mine = await makeEntrant(auth, bd2.divisionId, "individual", "Robin Summer", [person.id]);
    const bd2Theirs = await makeEntrant(auth, bd2.divisionId, "individual", "Opponent Summer", [bd2Opp.id]);
    await insertFinalizedFixture(bd2.stageId, bd2.divisionId, bd2Mine, bd2Theirs);
    await insertSnapshot(bd2.divisionId, person.id, "badminton", { points_won: 8, sets_won: 1, sets_lost: 1 });

    // --- volleyball: TEAM-kind entrant, person IS a real roster member,
    // but NO snapshot row (mirrors the real "team credits nobody" outcome,
    // S8/#417). A real finalized fixture exists so this is a genuine
    // "played but not credited" case, not just "never played".
    const vb = await seedDivisionWithStage(auth, "volleyball", "default", "Rec");
    const vbTeammate = await filler("VB Teammate");
    const vbOpp1 = await filler("VB Opp1");
    const vbOpp2 = await filler("VB Opp2");
    const vbMine = await makeEntrant(auth, vb.divisionId, "team", "Team Robin", [person.id, vbTeammate.id]);
    const vbTheirs = await makeEntrant(auth, vb.divisionId, "team", "Team Opponent", [vbOpp1.id, vbOpp2.id]);
    await insertFinalizedFixture(vb.stageId, vb.divisionId, vbMine, vbTheirs);
    // deliberately: no insertSnapshot() call for volleyball

    const result = await personCareerStats(auth, person.id);

    // Volleyball must be COMPLETELY absent — no phantom card despite a real
    // roster membership and a real finalized fixture.
    expect(result.sports.map((s) => s.sport_key).sort()).toEqual(["badminton", "football"]);

    const fbCard = result.sports.find((s) => s.sport_key === "football")!;
    expect(fbCard.divisions).toBe(1);
    expect(fbCard.variants).toBe(1);
    expect(fbCard.matches).toBe(2);
    const fbByKey = Object.fromEntries(fbCard.metrics.map((m) => [m.key, m.value]));
    expect(fbByKey.goals).toBe(3);
    expect(fbByKey.assists).toBe(1);
    expect(fbByKey.points).toBe(4); // derived: goals + assists

    const bdCard = result.sports.find((s) => s.sport_key === "badminton")!;
    expect(bdCard.divisions).toBe(2);
    // BOTH badminton divisions share variant_key 'default' — 2 divisions,
    // 1 variant. This is the assertion that would fail if divisions and
    // variants were wrongly conflated into the same count.
    expect(bdCard.variants).toBe(1);
    expect(bdCard.matches).toBe(4); // 3 (Spring) + 1 (Summer)
    const bdByKey = Object.fromEntries(bdCard.metrics.map((m) => [m.key, m.value]));
    expect(bdByKey.points_won).toBe(23); // 15 + 8 — real summation, not first-row-wins (15) or last (8)
    expect(bdByKey.sets_won).toBe(3); // 2 + 1
    expect(bdByKey.sets_lost).toBe(1); // 0 (absent in Spring) + 1 (Summer)
  });

  it("a person with zero snapshots gets an empty sports list, not a 404", async () => {
    const { auth } = await seedOrg();
    const person = await createPerson(auth, {
      full_name: "Nobody Yet",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    expect(await personCareerStats(auth, person.id)).toEqual({ sports: [] });
  });

  it("an unknown person id 404s", async () => {
    const { auth } = await seedOrg();
    await expect(personCareerStats(auth, randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  // Regression (d): the career path must issue NO recompute. Mechanism: a
  // STALE-SNAPSHOT proof (per the dispatch brief's own suggested option) —
  // score a second real goal AFTER the snapshot is written, through the
  // real scoring pipeline, WITHOUT calling anything that recomputes. If
  // personCareerStats ever gains a recompute, this second goal would show
  // up and the "still 1" assertion below would fail. The closing
  // divisionPlayerStats call proves the underlying ledger genuinely WOULD
  // report 2 goals once something DOES recompute it — so "still 1" here is
  // not an artifact of a broken second event, it is proof that
  // personCareerStats specifically never triggered the recompute that
  // would have picked it up.
  it("issues NO recompute — a snapshot written before a later real goal stays stale through personCareerStats, though the ledger genuinely has 2", async () => {
    const { auth } = await seedOrg();
    const scorer = await createPerson(auth, {
      full_name: "Stale Scorer",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    const opponent = await createPerson(auth, {
      full_name: "Stale Opponent",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    const fb = await seedDivisionWithStage(auth, "football", "default", "Stale");
    const mine = await makeEntrant(auth, fb.divisionId, "team", "Scorer FC", [scorer.id]);
    const theirs = await makeEntrant(auth, fb.divisionId, "team", "Opponent FC", [opponent.id]);
    // A real fixture through the scoring path — score directly against a
    // fixture row created the same raw way as the asymmetric test above;
    // scoreEvent only needs a real fixture id + division in an
    // 'active'-compatible state, and football validates a goal's scorer
    // against the on-pitch lineup (putLineup), same precondition
    // player-stats.test.ts's own seedDivision satisfies.
    await sql`update divisions set status = 'active' where id = ${fb.divisionId}`;
    const fixtureId = await insertScheduledScoreableFixture(fb.stageId, fb.divisionId, mine, theirs);
    await putLineup(auth, fixtureId, mine, {
      slots: [{ person_id: scorer.id, slot: "starting" as const, position_key: null, order_no: 1, roles: [] }],
    });
    await putLineup(auth, fixtureId, theirs, {
      slots: [{ person_id: opponent.id, slot: "starting" as const, position_key: null, order_no: 1, roles: [] }],
    });

    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "football.goal",
      payload: { by: mine, scorer: scorer.id },
    });
    // Force the FIRST recompute + snapshot write (the only usecase that
    // ever writes player_stat_snapshots) — same as production: a division
    // read recomputes, personCareerStats never does.
    const before = await divisionPlayerStats(auth, fb.divisionId, {});
    expect(before.rows.find((r) => r.person_id === scorer.id)?.stats.goals).toBe(1);

    // A SECOND goal, through the real scoring path — no recompute-triggering
    // call follows it before personCareerStats runs.
    await scoreEvent(auth, fixtureId, {
      expected_seq: 2,
      type: "football.goal",
      payload: { by: mine, scorer: scorer.id },
    });

    const career = await personCareerStats(auth, scorer.id);
    const goals = career.sports.find((s) => s.sport_key === "football")!.metrics.find((m) => m.key === "goals");
    expect(goals?.value).toBe(1); // STILL 1 — the second goal was never folded in here

    // Close the loop: the ledger genuinely has 2 once something DOES recompute.
    const after = await divisionPlayerStats(auth, fb.divisionId, {});
    expect(after.rows.find((r) => r.person_id === scorer.id)?.stats.goals).toBe(2);
  });

  // Review round 2, finding 1: countMatchesByDivision (now the ONE shared
  // implementation behind personCareerStats/listMyCareerStats/getPublicPlayer
  // — finding 2) used to filter `status = 'finalized'` alone. A fixture left
  // 'decided' and never explicitly finalized still has a real outcome and a
  // real snapshot (recomputePlayerStats puts NO status filter on its own
  // score_events read — see player-stats.ts's sibling `decided` count at the
  // top of divisionPlayerStats), so it must still count as a match. Proven
  // once, through personCareerStats, because all three callers now share
  // this exact code path — there is only one implementation left to break.
  it("REVIEW ROUND 2, finding 1: a fixture left DECIDED (never explicitly finalized) still counts as a match", async () => {
    const { auth } = await seedOrg();
    const person = await createPerson(auth, {
      full_name: "Decided Only",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    const opponent = await createPerson(auth, {
      full_name: "Decided Opponent",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    const fb = await seedDivisionWithStage(auth, "football", "default", "Decided");
    const mine = await makeEntrant(auth, fb.divisionId, "team", "Decided FC", [person.id]);
    const theirs = await makeEntrant(auth, fb.divisionId, "team", "Decided Opp FC", [opponent.id]);
    await insertDecidedFixture(fb.stageId, fb.divisionId, mine, theirs);
    await insertSnapshot(fb.divisionId, person.id, "football", { goals: 1 });

    const career = await personCareerStats(auth, person.id);
    const fbCard = career.sports.find((s) => s.sport_key === "football");
    expect(fbCard).toBeDefined();
    expect(fbCard!.matches).toBe(1); // was 0 under a 'finalized'-only filter
  });

  // Review round 2, finding 3: the prior "keeper split" coverage
  // (server/__tests__/player-stats-career.test.ts) was a PURE unit test on
  // groupCareerStatsBySport with fabricated snapshot rows, on the stated
  // premise that nothing in apps/web ever emits core.lineup.position so a
  // real DB scenario wasn't reachable. That premise is FALSE: a STARTING
  // lineup slot with position_key: "GK" is enough on its own —
  // putLineup (usecases/fixtures.ts) writes position_key straight into the
  // `lineups` table, loadLineupPair/loadLineupPairsForDivision
  // (engine-db/lineups.ts) read it back onto LineupSlot.positionKey, and
  // core/lineup.ts's initSquads/memberFromSlot seed SquadState from exactly
  // that field for any 'starting' slot — no core.lineup.* event ever needs
  // to fire. footballKeeperStatsFold (football.ts) resolves keeperOf(side)
  // from that seeded state alone. This test drives that path for real: one
  // person keeps goal in one division and plays outfield in another,
  // through real lineups + real scored events + a real recompute, and
  // proves the union lands on ONE football career card. The existing pure
  // unit test stays as the cheap guard for the group/sum logic itself; this
  // is the one that proves the DB criterion.
  it("REVIEW ROUND 2, finding 3: a real keeper season and a real outfield season, same person, land on ONE football card", async () => {
    const { auth } = await seedOrg();
    const person = await createPerson(auth, {
      full_name: "Two-Way Robin",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    const keeperOpponent = await createPerson(auth, {
      full_name: "Keeper Opponent",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    const outfieldOpponent = await createPerson(auth, {
      full_name: "Outfield Opponent",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });

    // --- Division A: person keeps goal, concedes exactly one goal ---
    const gk = await seedDivisionWithStage(auth, "football", "default", "Keeper Season");
    const gkMine = await makeEntrant(auth, gk.divisionId, "team", "Keeper FC", [person.id]);
    const gkTheirs = await makeEntrant(auth, gk.divisionId, "team", "Keeper Opp FC", [keeperOpponent.id]);
    // Entrants first, THEN active — createEntrants locks the roster once a
    // division has started (same order the "issues NO recompute" test above
    // already proves works).
    await sql`update divisions set status = 'active' where id = ${gk.divisionId}`;
    const gkFixtureId = await insertScheduledScoreableFixture(gk.stageId, gk.divisionId, gkMine, gkTheirs);
    await putLineup(auth, gkFixtureId, gkMine, {
      slots: [{ person_id: person.id, slot: "starting" as const, position_key: "GK", order_no: 1, roles: [] }],
    });
    await putLineup(auth, gkFixtureId, gkTheirs, {
      slots: [
        { person_id: keeperOpponent.id, slot: "starting" as const, position_key: null, order_no: 1, roles: [] },
      ],
    });
    await scoreEvent(auth, gkFixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    // The away side (gkTheirs) scores on home (gkMine) — the fold's
    // conceding side is the OPPONENT of `by`, so this concedes against
    // Robin, the home GK (football.ts's footballKeeperStatsFold).
    await scoreEvent(auth, gkFixtureId, {
      expected_seq: 1,
      type: "football.goal",
      payload: { by: gkTheirs, scorer: keeperOpponent.id },
    });
    // Force the recompute + snapshot write — the only usecase that writes
    // player_stat_snapshots; personCareerStats itself never recomputes.
    const gkStats = await divisionPlayerStats(auth, gk.divisionId, {});
    expect(gkStats.rows.find((r) => r.person_id === person.id)?.stats.goals_conceded).toBe(1);

    // --- Division B: the SAME person, outfield, scores a goal ---
    const of = await seedDivisionWithStage(auth, "football", "default", "Outfield Season");
    const ofMine = await makeEntrant(auth, of.divisionId, "team", "Outfield FC", [person.id]);
    const ofTheirs = await makeEntrant(auth, of.divisionId, "team", "Outfield Opp FC", [outfieldOpponent.id]);
    await sql`update divisions set status = 'active' where id = ${of.divisionId}`;
    const ofFixtureId = await insertScheduledScoreableFixture(of.stageId, of.divisionId, ofMine, ofTheirs);
    await putLineup(auth, ofFixtureId, ofMine, {
      slots: [{ person_id: person.id, slot: "starting" as const, position_key: null, order_no: 1, roles: [] }],
    });
    await putLineup(auth, ofFixtureId, ofTheirs, {
      slots: [
        { person_id: outfieldOpponent.id, slot: "starting" as const, position_key: null, order_no: 1, roles: [] },
      ],
    });
    await scoreEvent(auth, ofFixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, ofFixtureId, {
      expected_seq: 1,
      type: "football.goal",
      payload: { by: ofMine, scorer: person.id },
    });
    const ofStats = await divisionPlayerStats(auth, of.divisionId, {});
    expect(ofStats.rows.find((r) => r.person_id === person.id)?.stats.goals).toBe(1);

    // --- The proof: ONE football card, both metric families present ---
    const career = await personCareerStats(auth, person.id);
    const footballCards = career.sports.filter((s) => s.sport_key === "football");
    expect(footballCards).toHaveLength(1); // not two half-populated cards
    const byKey = Object.fromEntries(footballCards[0]!.metrics.map((m) => [m.key, m.value]));
    expect(byKey.goals_conceded).toBe(1); // from the DB-real keeper season
    expect(byKey.goals).toBe(1); // from the DB-real outfield season
    expect(footballCards[0]!.divisions).toBe(2);
  });

  // Review round 2, "decide and report": personCareerStats joined divisions
  // with NO archived_at filter while listMyCareerStats/listMyPlayerStats
  // (me.ts) both filter archived divisions out — an unexplained divergence
  // between this route and its own cross-org twin. Decision: ALIGN — the
  // dominant convention across this repo's own division reads (divisions.ts's
  // own listing default, card-stats.ts, division-slots.ts, competitions.ts)
  // is to hide archived divisions from an aggregate/listing read by default,
  // and a "career total" silently going backwards the moment an unrelated
  // org archives an old competition is exactly the silent-data-flicker shape
  // that convention exists to prevent. usecases/player-stats.ts's OWN
  // personStats (the per-division, non-summed sibling reader in this same
  // file) is a SEPARATE, pre-existing function that also has no archived_at
  // filter — deliberately left untouched this round: fixing it was not asked
  // for and would change the behavior of an endpoint outside this review's
  // stated scope.
  it("REVIEW ROUND 2, archived-divisions decision: an archived division's snapshot is excluded from the career total", async () => {
    const { auth } = await seedOrg();
    const person = await createPerson(auth, {
      full_name: "Archive Case",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    const fb = await seedDivisionWithStage(auth, "football", "default", "ToArchive");
    await insertSnapshot(fb.divisionId, person.id, "football", { goals: 9 });

    const before = await personCareerStats(auth, person.id);
    expect(before.sports.find((s) => s.sport_key === "football")).toBeDefined();

    await archiveDivision(auth, fb.divisionId);
    const after = await personCareerStats(auth, person.id);
    expect(after.sports.find((s) => s.sport_key === "football")).toBeUndefined();
  });
});

/** Fixture in a status the real scoring path accepts (scoreEvent validates
 *  fixture/division state, not just existence) — 'scheduled' is what a
 *  freshly generated fixture starts as; this file skips generateStageFixtures
 *  entirely (raw-inserted fixtures throughout), so this helper exists for
 *  tests that need a fixture BOTH raw-inserted AND scoreable. (Renamed from
 *  insertFinalizedFixtureButScoreable, review round 2 finding 4 — the old
 *  name claimed a 'finalized' status it never actually inserted.) */
async function insertScheduledScoreableFixture(
  stageId: string,
  divisionId: string,
  homeEntrantId: string,
  awayEntrantId: string,
): Promise<string> {
  roundCounter += 1;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${stageId}, ${divisionId}, ${roundCounter}, 1, ${homeEntrantId}, ${awayEntrantId}, 'scheduled')
    returning id`;
  return id;
}
