// F3 Task 5 (5a/5b, 2026-08-18 plan) — real Postgres, full usecase pipeline.
// Skipped without DATABASE_URL (same convention as the sibling
// stage-orphan-fixtures.test.ts).
//
// The premise this pins (plan's "Corrected premise"): generateStageFixtures
// is additive only, so a withdrawn entrant's name never comes off a
// generated board on its own. getStageRosterDrift derives the mismatch
// (never stores it); rebuildStageFixtures is the one path that can actually
// fix it, refusing outright the moment any fixture already carries a real
// result.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { isRestBye } from "@/lib/fixture-bye";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import {
  createStages,
  generateStageFixtures,
  getStageRosterDrift,
  isRosterDriftEligible,
  rebuildStageFixtures,
} from "../stages"; // isRosterDriftEligible is re-exported from lib/roster-drift-eligibility
import { withdrawEntrantCascade } from "../withdrawal";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** F3 ultrareview finding 5 — the "nothing attached" shape of
 *  StageRosterDrift.attachments, spelled once so a whole-object toEqual
 *  stays a whole-object toEqual (a partial match would stop noticing a
 *  field appearing that should not be there). */
const NO_ATTACH = { officials: 0, lineups: 0, deviceLinks: 0 };

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** A fresh division with N seeded individual entrants (E1..EN) and no stages
 *  yet — the caller defines the stage graph itself, since the eligible-kind
 *  tests (league) and the ineligible-kind test (group -> setup-timing KO)
 *  need different graphs. */
async function seedDivision(auth: AuthCtx, names: string[]): Promise<{ divisionId: string; entrantByName: Map<string, string> }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Drift " + randomUUID().slice(0, 6),
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
  const entrants = await createEntrants(
    auth,
    division.id,
    names.map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  const entrantByName = new Map(entrants.map((e) => [e.display_name, e.id]));
  return { divisionId: division.id, entrantByName };
}

/** Decide a fixture (core.start then generic.result), so its DB status
 *  becomes 'decided' with a real outcome — mirrors stage-progression.test
 *  .ts's decideAllGroupFixtures, inlined for a single fixture. */
async function decideFixture(auth: AuthCtx, fixtureId: string): Promise<void> {
  await appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
  await appendEvent(auth.orgId, fixtureId, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
}

// F3 ultrareview finding 9 — no DB: the SELECTION rule the division page
// applies to decide which stages to ask about. It used to be an inline
// `progression === null`, which is looser than the usecase's own gate, so a
// division whose first roster-drawn stage is a ladder handed the page the
// ladder (ineligible -> always empty drift) and never asked the league
// stage behind it. Runs without Postgres on purpose: this is the rule, and
// the rule should not need a database to pin.
describe("isRosterDriftEligible — the shared eligibility rule", () => {
  const ladder = { kind: "ladder", progression: null };
  const league = { kind: "league", progression: null };
  const ko = { kind: "knockout", progression: { sources: [] } };

  it("picks the league stage out of a ladder-first division, not the ladder", () => {
    // The old rule: `[ladder, league].find((s) => s.progression === null)`
    // returns the LADDER, and a ladder never reports drift.
    expect([ladder, league].filter(isRosterDriftEligible)).toEqual([league]);
  });

  it("covers EVERY eligible stage, not just the first", () => {
    const second = { kind: "group", progression: null };
    expect([league, second, ko].filter(isRosterDriftEligible)).toEqual([league, second]);
  });

  it("excludes americano (mints its own pair entrants) and any stage with a progression", () => {
    expect(isRosterDriftEligible({ kind: "americano", progression: null })).toBe(false);
    expect(isRosterDriftEligible(ko)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("F3 Task 5 (5a) — getStageRosterDrift", () => {
  it("reports both directions: a withdrawn entrant still referenced (ghost), and a newly active entrant referenced by nothing (unplaced)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);

    // B and C stay active and referenced — the negative case: neither may
    // appear in either list.
    await patchEntrant(auth, entrantByName.get("A")!, { status: "withdrawn" });
    const added = await createEntrants(auth, divisionId, [
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.ghosts.map((e) => e.id)).toEqual([entrantByName.get("A")]);
    expect(drift.unplaced.map((e) => e.id)).toEqual([added[0]!.id]);
    const allNames = [...drift.ghosts, ...drift.unplaced].map((e) => e.display_name);
    expect(allNames).not.toContain("B");
    expect(allNames).not.toContain("C");
  });

  // INVERTED 2026-09-20. This case shipped asserting the opposite — "a
  // withdrawn entrant referenced by a fixture that ALREADY HAS A RESULT is
  // still reported as a ghost" — and that expectation WAS the defect: the
  // banner fired mid-event on a correct post-withdrawal state and offered a
  // destructive rebuild of a board whose only fixture was already played. A
  // ghost is someone still expected to play; a played fixture expects nobody.
  // The full status table and the real withdraw path are swept in the last
  // describe block of this file.
  it("a withdrawn entrant referenced ONLY by a fixture that already has a result is NOT a ghost", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, divisionId);
    await decideFixture(auth, fixtures[0]!.id);

    const [decided] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtures[0]!.id}`;
    expect(decided!.status).toBe("decided");

    await patchEntrant(auth, entrantByName.get("A")!, { status: "withdrawn" });

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.ghosts).toEqual([]);
    // …and A is not quietly moved to the other list either: the result stands,
    // so A is placed, and nothing about this stage needs an organiser's
    // attention. A banner on either side here is a false alarm.
    expect(drift.unplaced).toEqual([]);
  });

  // F3 ultrareview finding 6 — drift is defined against a BOARD. A stage
  // that has never been generated has none, so every active entrant looked
  // "unplaced" and the banner fired on a division where nothing was wrong.
  // The most common state a stage is ever in, so this fired constantly.
  it("a stage whose fixtures have never been generated reports NO drift — an empty board is not a drifted board", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    // deliberately NO generateStageFixtures

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.unplaced).toEqual([]);
    expect(drift.ghosts).toEqual([]);

    // …and the same stage DOES report drift once it has a board, so this is
    // an empty-board carve-out, not a blanket mute.
    await generateStageFixtures(auth, stage!.id);
    const added = await createEntrants(auth, divisionId, [
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);
    const after = await getStageRosterDrift(auth, stage!.id);
    expect(after.unplaced.map((e) => e.id)).toEqual([added[0]!.id]);
  });

  // F3 ultrareview finding 5 — the rebuild deletes fixtures, and three other
  // tables CASCADE off that: referee appointments, team sheets, paired
  // scoring devices. None of them BLOCKS the rebuild (only a recorded result
  // does), so the organiser has to be told what the click costs before they
  // make it. That means the counts have to be real.
  it("counts the organiser setup a rebuild would clear: officials, team sheets, device links", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const fixtureId = fixtures[0]!.id;

    const clean = await getStageRosterDrift(auth, stage!.id);
    expect(clean.attachments).toEqual({ officials: 0, lineups: 0, deviceLinks: 0 });

    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Ref X') returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${auth.orgId}, ${person!.id}, 'Ref X', ${sql.json(["referee"])}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'referee', 'accepted')`;
    const [{ home_entrant_id: entrantId }] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures where id = ${fixtureId}`;
    await sql`insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, order_no)
              values (${fixtureId}, ${entrantId}, ${person!.id}, ${auth.orgId}, 'starting', 1)`;
    await sql`insert into device_links (org_id, fixture_id, token_hash, label, issued_by, expires_at)
              values (${auth.orgId}, ${fixtureId}, 'hash-' || ${randomUUID()}, 'Court 1 tablet',
                      ${auth.userId}, now() + interval '1 day')`;

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.attachments).toEqual({ officials: 1, lineups: 1, deviceLinks: 1 });

    // Scoped to THIS stage's fixtures — a second stage's attachments never
    // inflate the warning the organiser reads for this one.
    const [other] = await createStages(auth, divisionId, {
      seq: 2, kind: "league", name: "L2", config: {}, progression: null,
    });
    await generateStageFixtures(auth, other!.id);
    const otherDrift = await getStageRosterDrift(auth, other!.id);
    expect(otherDrift.attachments).toEqual({ officials: 0, lineups: 0, deviceLinks: 0 });

    // …and none of them blocks: this is a warning, not a guard. The rebuild
    // goes through, and takes them with it (the CASCADE this warns about).
    await rebuildStageFixtures(auth, stage!.id);
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from fixture_officials where fixture_id = ${fixtureId}`;
    expect(count).toBe(0);
  });

  it("a stage with a progression source (not the root) reports no drift at all", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const stages = await createStages(auth, divisionId, [
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
    const koStage = stages.find((s) => s.kind === "knockout")!;
    await generateStageFixtures(auth, koStage.id); // TBD placeholders, no entrant refs

    const drift = await getStageRosterDrift(auth, koStage.id);
    expect(drift).toEqual({ ghosts: [], unplaced: [], attachments: NO_ATTACH });
  });

  // W3 item 6 follow-up — swissGen persists pairRound's `bye` as a real
  // forfeited award row (same shape knockout already uses), so the sit-out
  // is referenced on a fixture and no longer lands in `unplaced`. Two
  // suppression heuristics were tried and rejected (2026-09-06); this is
  // the real fix. Formerly a characterisation ("KNOWN DEFECT") that pinned
  // the live wrong shape — inverted here when the bye row shipped.
  it("an odd-swiss round-1 sit-out is a bye fixture, not unplaced roster drift", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C", "D", "E"]); // 5 — ODD
    // rounds: 2 — the shape this test builds needs both a round-1 sit-out AND
    // a round 2 for that sit-out to be paired into. A Swiss round budget is
    // declared at create time (owner ruling 2026-09-20); `createStages` 422s
    // without it.
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null,
    });
    // Two Generates: the first mints empty shells for every declared round,
    // the second ("Pair next") seats the lowest unseated one — PR #803. And
    // `.fixtures` is the stage's WHOLE fixture list, every round of it, so
    // each round is filtered out of it by `round_no` rather than read whole.
    await generateStageFixtures(auth, stage!.id);
    const round1 = (await generateStageFixtures(auth, stage!.id)).fixtures.filter((f) => f.round_no === 1);
    expect(round1.length).toBe(3); // 2 pairings + 1 bye row
    const bye = round1.find((f) => f.away_entrant_id === null && f.status === "forfeited");
    expect(bye).toBeDefined();
    expect(bye!.home_entrant_id).toBeTruthy();
    expect((bye!.outcome as { kind?: string; winner?: string } | null)?.kind).toBe("award");
    expect((bye!.outcome as { kind?: string; winner?: string } | null)?.winner).toBe(bye!.home_entrant_id);
    const sitOutId = bye!.home_entrant_id!;
    expect([...entrantByName.values()]).toContain(sitOutId);

    const afterRound1 = await getStageRosterDrift(auth, stage!.id);
    expect(afterRound1.unplaced).toEqual([]);
    expect(afterRound1.ghosts).toEqual([]);

    await startDivision(auth, divisionId); // stage already has fixtures — does not regenerate
    // Decide only the real pairings — the bye is already forfeited/awarded.
    for (const f of round1) {
      if (f.status === "forfeited") continue;
      await decideFixture(auth, f.id);
    }
    // Scoped to round 2 on purpose: the sit-out's OWN round-1 bye row carries
    // it as `home_entrant_id`, so an unscoped `some()` over the whole stage
    // answers true whether or not round 2 ever paired them.
    const round2 = (await generateStageFixtures(auth, stage!.id)).fixtures.filter((f) => f.round_no === 2);
    expect(round2.some((f) => f.home_entrant_id === sitOutId || f.away_entrant_id === sitOutId)).toBe(true);

    const afterRound2 = await getStageRosterDrift(auth, stage!.id);
    expect(afterRound2.unplaced).toEqual([]);
  });

  // Rebuilt per round-1 review finding 2: the original version simulated
  // "genuine late registration" with a bare `createEntrants` call after
  // Generate, which bypasses the active-division lock a real late add hits
  // post-start (`entrants.ts` — /entrants 422s "tournament has started" once
  // `startDivision` has run). Reproduced the way the product actually
  // produces an unreferenced-but-active entrant instead: `patchEntrant` to
  // "withdrawn" BEFORE Generate ever runs (so the entrant is excluded from
  // the pairing pool entirely), then back to "registered" with no
  // regenerate — the same four-line pattern this file already uses for its
  // ghost cases, applied before generation instead of after. Proves the
  // bye-row fix is SPECIFIC: a legitimate round-1 sit-out is NOT in
  // `unplaced`, while the reinstated late registration still is.
  it("a swiss stage reports a genuine reinstated-late-registration entrant, not the legitimate sit-out", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C", "D", "E", "F"]);
    // rounds: 1 — this case never looks past round 1, and its fixture query
    // below is not round-scoped, so one round keeps the stage's whole fixture
    // set exactly the three rows (2 pairings + bye) the assertions read.
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 1 }, progression: null,
    });

    await patchEntrant(auth, entrantByName.get("F")!, { status: "withdrawn" });
    await startDivision(auth, divisionId); // mints round-1 shells over A-E only (5 — ODD)
    // Seats them (PR #803's "Pair next"). BEFORE F is reinstated, so F is not
    // in the pairing pool — that is the whole point of the case.
    await generateStageFixtures(auth, stage!.id);
    await patchEntrant(auth, entrantByName.get("F")!, { status: "registered" }); // reinstated, no regenerate

    const round1Rows = await sql<{
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      status: string;
    }[]>`
      select home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stage!.id}`;
    const byeRow = round1Rows.find((r) => r.away_entrant_id === null && r.status === "forfeited");
    expect(byeRow?.home_entrant_id).toBeTruthy();
    const naturalSitOutId = byeRow!.home_entrant_id!;

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.unplaced.map((e) => e.id)).toEqual([entrantByName.get("F")]);
    expect(drift.unplaced.map((e) => e.id)).not.toContain(naturalSitOutId);
  });

  // Round-1 review finding 1's exact repro, verbatim: withdraw before round
  // 1, reinstate AFTER round 2 exists. The original `created_at` heuristic
  // silently swallowed this forever (worse once the round cap is hit —
  // Generate can't fix it either); it must flag.
  it("finding 1 regression: withdraw before round 1, reinstate after round 2 — must still flag", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C", "D", "E"]);
    // rounds: 2 — the repro is "reinstate AFTER round 2 exists", so the stage
    // must have a round 2 to reach.
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null,
    });

    await patchEntrant(auth, entrantByName.get("E")!, { status: "withdrawn" });
    await startDivision(auth, divisionId); // mints shells for both rounds over A-D only (4 — EVEN, no bye)
    await generateStageFixtures(auth, stage!.id); // seats round 1

    // Round-scoped: the stage now also holds round 2's unseated shells, so an
    // unscoped count would be 4 and would not say anything about round 1.
    const round1 = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stage!.id} and round_no = 1`;
    expect(round1.length).toBe(2); // A-B, C-D — no bye, E excluded entirely
    for (const f of round1) await decideFixture(auth, f.id);

    const round2 = await generateStageFixtures(auth, stage!.id); // still over A-D — E stays withdrawn
    expect(round2.created).toBe(2); // A-D repaired for round 2, no bye — E never in the pool at all

    await patchEntrant(auth, entrantByName.get("E")!, { status: "registered" }); // reinstated AFTER round 2

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.unplaced.map((e) => e.id)).toEqual([entrantByName.get("E")]);
  });
});

describe.skipIf(!HAS_DB)("F3 Task 5 (5b) — rebuildStageFixtures", () => {
  it("regression: refuses once any fixture in the stage is decided, even with no roster drift at all", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, divisionId);
    await decideFixture(auth, fixtures[0]!.id);

    const [{ count: before }] = await sql<{ count: string }[]>`
      select count(*)::text from fixtures where stage_id = ${stage!.id}`;

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });

    // Refused means untouched — the guard runs BEFORE the delete, not a
    // rollback after a partial one.
    const [{ count: after }] = await sql<{ count: string }[]>`
      select count(*)::text from fixtures where stage_id = ${stage!.id}`;
    expect(after).toBe(before);
  });

  // Re-seeded 2026-09-20 (was two entrants and one decided fixture). Hard
  // constraint 1 is "a real ghost cannot be rebuilt away once the board
  // carries a result", and a withdrawn entrant whose ONLY fixture is decided
  // stopped being a ghost when the false-banner fix landed — that shape now
  // asserts nothing about the refusal it exists to prove. Three entrants
  // instead: A keeps a decided fixture AND a scheduled one, so A is genuinely
  // still on the board and the recorded result still blocks the rebuild.
  it("a withdrawn entrant still on a scheduled fixture is a ghost AND a recorded result blocks the rebuild (hard constraint 1)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id); // AB, AC, BC
    await startDivision(auth, divisionId);
    const aId = entrantByName.get("A")!;
    // #850: an odd field's entrant also holds a settled REST-bye row; these
    // cases are about A's MATCHES.
    const aFixtures = fixtures.filter(
      (f) => !isRestBye(f, "league") && (f.home_entrant_id === aId || f.away_entrant_id === aId),
    );
    expect(aFixtures).toHaveLength(2);
    await decideFixture(auth, aFixtures[0]!.id); // the other stays scheduled
    await patchEntrant(auth, aId, { status: "withdrawn" });

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.ghosts.map((e) => e.id)).toContain(aId);

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
  });

  it("a generation-time bye (one side never had an opponent) does NOT block — only a two-sided result does", async () => {
    const { auth } = await seedOrg();
    // 3 entrants in a knockout: bracket size 4, one bye in round 1.
    const { divisionId } = await seedDivision(auth, ["A", "B", "C"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const bye = fixtures.find((f) => f.home_entrant_id === null || f.away_entrant_id === null);
    expect(bye).toBeDefined();
    expect(bye!.status).toBe("forfeited");

    const out = await rebuildStageFixtures(auth, stage!.id);
    expect(out.removed).toBe(fixtures.length);
    expect(out.created).toBeGreaterThan(0);
  });

  it("a two-sided 'forfeited' fixture (a withdrawal walkover, not a bye) DOES block — same status as a bye, different shape", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    // 4 entrants: a clean bracket, no byes — every round-1 fixture already
    // has both sides filled. Simulate a walkover the way withdrawal.ts's
    // core.forfeit really leaves it: 'forfeited' status, BOTH entrant ids
    // still populated (the cascade never nulls the FK, only appends a
    // scoring event) — append-event.ts:116 maps core.forfeit to this exact
    // status, so it is indistinguishable from a bye by status alone.
    const round1 = fixtures.filter((f) => f.round_no === Math.min(...fixtures.map((x) => x.round_no)));
    const target = round1[0]!;
    expect(target.home_entrant_id).not.toBeNull();
    expect(target.away_entrant_id).not.toBeNull();
    await sql`
      update fixtures set status = 'forfeited', outcome = ${sql.json({ kind: "award", winner: target.home_entrant_id } as never)}
      where id = ${target.id}`;

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
  });

  // Added after review of the 5a/5b work: the guard originally keyed off
  // `fixtures.status` alone. `delete from fixtures` CASCADEs into
  // score_events, match_states, match_reports, official_marks (and SET NULLs
  // suspensions.fixture_id), so a status-only test can delete real evidence
  // under any status it does not happen to name. These two cases fail against
  // a status-only guard.
  // SPLIT AND NARROWED 2026-09-21 (the cascade). This used to be one test that
  // set `status = 'abandoned'` and nothing else, and it passed because the
  // guard blocked on that status ALONE. That stopped being safe the moment
  // `abandoned` also became the value the GENERATOR writes for a bracket line
  // with nobody left to play it (walkoverDepartedQualifiers, re-review C2):
  // the old guard made every such stage permanently un-rebuildable, and told
  // the organiser their unplayed board "already has recorded results" —
  // observed in a browser on 2026-09-21.
  //
  // A real abandonment leaves an event ledger behind it (the `core.abandon`
  // that produced the status), and a no-result leaves an outcome. The
  // generator's void leaves NEITHER. One test per side, plus the negative.
  it("an 'abandoned' fixture that was PLAYED blocks — its event ledger is real evidence", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await sql`update fixtures set status = 'abandoned' where id = ${fixtures[0]!.id}`;
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload)
      values (${fixtures[0]!.id}, ${auth.orgId}, 1, 'core.abandon', ${sql.json({ reason: "waterlogged" } as never)})`;

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
  });

  it("an 'abandoned' fixture carrying an outcome blocks — a no-result is still a result", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await sql`
      update fixtures set status = 'abandoned',
        outcome = ${sql.json({ kind: "no_result", method: "abandoned" } as never)}
      where id = ${fixtures[0]!.id}`;

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
  });

  it("an 'abandoned' fixture with no outcome and no evidence does NOT block — that shape is the generator's own void", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await sql`update fixtures set status = 'abandoned' where id = ${fixtures[0]!.id}`;

    const out = await rebuildStageFixtures(auth, stage!.id);
    expect(out.removed).toBe(fixtures.length);
  });

  it("a fixture carrying score_events blocks even while its status is still 'scheduled'", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const target = fixtures[0]!;
    // Evidence without a status transition: the guard must not depend on WHEN
    // a status flips relative to the first event landing.
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload)
      values (${target.id}, ${auth.orgId}, 1, 'core.point', ${sql.json({ side: "home" } as never)})`;
    const [{ status }] = await sql<{ status: string }[]>`
      select status from fixtures where id = ${target.id}`;
    expect(status).toBe("scheduled");

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
  });

  it("422 STAGE_NOT_ROOT for a stage that doesn't draw fixtures directly from the active roster", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const stages = await createStages(auth, divisionId, [
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
    const koStage = stages.find((s) => s.kind === "knockout")!;
    await generateStageFixtures(auth, koStage.id);

    await expect(rebuildStageFixtures(auth, koStage.id)).rejects.toMatchObject({
      status: 422,
      code: "STAGE_NOT_ROOT",
    });
  });

  it("end to end: rebuild drops the withdrawn ghost and picks up the new entrant — the board matches the roster again", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id); // AB, AC, BC — 3 fixtures

    await patchEntrant(auth, entrantByName.get("A")!, { status: "withdrawn" });
    const added = await createEntrants(auth, divisionId, [
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);

    const before = await getStageRosterDrift(auth, stage!.id);
    expect(before.ghosts).toHaveLength(1);
    expect(before.unplaced).toHaveLength(1);

    const out = await rebuildStageFixtures(auth, stage!.id);
    expect(out.removed).toBe(3);
    expect(out.created).toBe(3); // B-C-D round robin: BC, BD, CD

    const rows = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
      select home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id}`;
    const referenced = new Set(rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]));
    expect(referenced.has(entrantByName.get("A")!)).toBe(false);
    expect(referenced.has(added[0]!.id)).toBe(true);

    const after = await getStageRosterDrift(auth, stage!.id);
    expect(after).toEqual({ ghosts: [], unplaced: [], attachments: NO_ATTACH });
  });
});

// ---------------------------------------------------------------------------
// The banner that fired on a CORRECT post-withdrawal state (found 2026-09-20
// by driving a six-player Swiss division). Round 1 played out, the organiser
// withdraws Ada through the normal withdraw path, Pair next works — and the
// stage card immediately said "Fixtures don't match the roster / No longer
// active, still on a fixture: Ada" and offered a destructive rebuild. Ada's
// ONLY fixture was her round-1 match, status `forfeited`: decided, played,
// and its result is supposed to stand.
//
// A GHOST is an entrant who is no longer active AND IS STILL EXPECTED TO
// PLAY, so only a fixture in a pending status can make one. The five history
// statuses cannot: `decided`/`finalized`/`forfeited`/`abandoned` are played,
// `cancelled` never will be.
//
// The `unplaced` side deliberately keeps the UNFILTERED referenced set. An
// entrant holding only a played fixture IS placed, so narrowing that side too
// would swap this false banner for the opposite one. The test below pins that
// asymmetry, because it is the whole reason the two sides read different sets.
//
// Not a suppression heuristic: the two that were reviewed out in 2026-09-06 (a
// `created_at` predicate, a round-membership rule) hid entrants who really
// were owed a fixture. This one only excuses an entrant whose every fixture is
// finished, which is exactly the population that can never be owed one.

/** Every value `fixtures.status` can hold, and whether a fixture in that
 *  status still expects its two entrants to turn up. Written out here rather
 *  than derived from the production set on purpose — a table that reads its
 *  answer off the code under test cannot witness a change to it. Its
 *  COMPLETENESS against the live check constraint is asserted below, so a
 *  status added to the vocabulary reds this file instead of silently
 *  defaulting to one side. */
const GHOST_BY_FIXTURE_STATUS = [
  ["scheduled", true],
  ["in_play", true],
  ["decided", false],
  ["finalized", false],
  ["abandoned", false],
  ["forfeited", false],
  ["cancelled", false],
] as const satisfies ReadonlyArray<readonly [string, boolean]>;

describe.skipIf(!HAS_DB)("getStageRosterDrift — a finished fixture is history, not an obligation", () => {
  it("the status table covers the WHOLE live fixtures.status vocabulary — no status gets a side by default", async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'fixtures' and c.contype = 'c'
        and pg_get_constraintdef(c.oid) like '%status = ANY%'`;
    expect(row?.def).toBeTruthy();
    const vocabulary = [...row!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    expect(vocabulary.length).toBeGreaterThan(1); // a one-element parse is a broken regex, not a vocabulary
    expect([...vocabulary].sort()).toEqual(GHOST_BY_FIXTURE_STATUS.map(([s]) => s).toSorted());
  });

  it.each(GHOST_BY_FIXTURE_STATUS)(
    "a withdrawn entrant whose ONLY fixture is '%s' is a ghost: %s",
    async (status, stillExpectedToPlay) => {
      const { auth } = await seedOrg();
      const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B"]);
      const [stage] = await createStages(auth, divisionId, {
        seq: 1, kind: "league", name: "L", config: {}, progression: null,
      });
      const { fixtures } = await generateStageFixtures(auth, stage!.id);
      expect(fixtures).toHaveLength(1); // A v B — one fixture, so it really is A's ONLY one

      // Written straight onto the row: several of these seven statuses have no
      // product path that reaches them from a two-entrant league, and the
      // query under test reads nothing but `status` and the two seat columns,
      // so this is the whole input space. The real withdraw path is driven
      // end to end in the last case of this block.
      await sql`update fixtures set status = ${status} where id = ${fixtures[0]!.id}`;
      const [seeded] = await sql<{ status: string }[]>`
        select status from fixtures where id = ${fixtures[0]!.id}`;
      expect(seeded!.status).toBe(status); // a case whose seed did not take proves nothing

      await patchEntrant(auth, entrantByName.get("A")!, { status: "withdrawn" });

      const drift = await getStageRosterDrift(auth, stage!.id);
      expect(drift.ghosts.map((e) => e.display_name)).toEqual(stillExpectedToPlay ? ["A"] : []);
      // B is active and sits on that same fixture whatever its status, so B is
      // placed in every row of this table — the side the fix must not move.
      expect(drift.unplaced).toEqual([]);
    },
  );

  it("a withdrawn entrant on a played fixture AND a scheduled one is STILL a ghost — the mixed case", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id); // AB, AC, BC
    const aId = entrantByName.get("A")!;
    // #850: an odd field's entrant also holds a settled REST-bye row; these
    // cases are about A's MATCHES.
    const aFixtures = fixtures.filter(
      (f) => !isRestBye(f, "league") && (f.home_entrant_id === aId || f.away_entrant_id === aId),
    );
    expect(aFixtures).toHaveLength(2); // one to bury, one left owed
    await sql`update fixtures set status = 'decided' where id = ${aFixtures[0]!.id}`;

    await patchEntrant(auth, aId, { status: "withdrawn" });

    // A's OTHER fixture is still scheduled, so A is genuinely still on the
    // board and the banner is right. A rule that looked at one fixture of
    // theirs — or at the newest — would get this wrong.
    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.ghosts.map((e) => e.display_name)).toEqual(["A"]);
  });

  it("an ACTIVE entrant whose only fixture is already played is PLACED, not unplaced — the other false banner", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await sql`update fixtures set status = 'decided' where id = ${fixtures[0]!.id}`;

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.unplaced).toEqual([]);
    expect(drift.ghosts).toEqual([]);
  });

  it("the reported defect, through the REAL withdraw path: a mid-league withdrawal leaves no banner at all", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id); // 6 — a 4-way round robin
    await startDivision(auth, divisionId);
    const aId = entrantByName.get("A")!;
    // #850: an odd field's entrant also holds a settled REST-bye row; these
    // cases are about A's MATCHES.
    const aFixtures = fixtures.filter(
      (f) => !isRestBye(f, "league") && (f.home_entrant_id === aId || f.away_entrant_id === aId),
    );
    expect(aFixtures).toHaveLength(3);
    // TWO of A's three played before the withdrawal, so withdrawal.ts's 50%
    // rule picks `walkover` and leaves the played results standing. Under 50%
    // it would EXPUNGE them instead (void + abandon), which is a different
    // fixture shape and would not test what this case is for.
    await decideFixture(auth, aFixtures[0]!.id);
    await decideFixture(auth, aFixtures[1]!.id);

    const out = await withdrawEntrantCascade(auth, aId);
    expect(out.policy).toBe("walkover");

    const aStatuses = (
      await sql<{ status: string }[]>`
        select status from fixtures
        where stage_id = ${stage!.id} and (home_entrant_id = ${aId} or away_entrant_id = ${aId})
        order by status`
    ).map((r) => r.status);
    expect(aStatuses).toEqual(["decided", "decided", "forfeited"]); // every one of them history

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.ghosts).toEqual([]);
    expect(drift.unplaced).toEqual([]);
  });
});
