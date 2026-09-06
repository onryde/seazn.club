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

  it("a withdrawn entrant referenced by a fixture that ALREADY HAS A RESULT is still reported as a ghost", async () => {
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
    expect(drift.ghosts.map((e) => e.id)).toEqual([entrantByName.get("A")]);
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

  // Task 1 (W3) — swiss's pairRound puts an odd round's sat-out entrant in a
  // `bye` field the generator never maps to a fixture row (swissGen maps only
  // round.pairings — packages/engine/src/scheduling/swiss.ts). Stage-wide
  // `unplaced` used to read that entrant exactly like a genuine late
  // registration and fire the roster-drift banner on a division where
  // nothing had gone wrong — confirmed live in a browser: the banner named
  // the round-1 sit-out ("Active, but not on a fixture yet") and cleared on
  // its own once round 2 gave them a real fixture (docs/superpowers/specs/
  // 2026-09-02-competition-desk-prompts/_INDEX.md, "W3 item 6").
  it("an odd-entrant swiss stage does not report its own sit-out as roster drift", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D", "E"]); // 5 — ODD on purpose
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "swiss", name: "Swiss", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    expect(fixtures.length).toBe(2); // 5 entrants -> 2 pairings, 1 sits out

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.unplaced).toEqual([]);
  });

  // The fix must be SPECIFIC to the round-1 sit-out, not a blanket amnesty
  // for every unreferenced entrant on a swiss stage — a late registration
  // after Generate is exactly the case `unplaced` exists to catch, and it
  // must still be caught even while a legitimate sit-out is also present.
  it("...but a swiss stage still reports a genuine late registration, alongside a legitimate sit-out", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D", "E"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "swiss", name: "Swiss", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id); // round 1: 2 fixtures, one of the five sits out

    const added = await createEntrants(auth, divisionId, [
      { kind: "individual", display_name: "F", seed: 6, members: [] },
    ]);

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.unplaced.map((e) => e.id)).toEqual([added[0]!.id]);
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

  it("a withdrawn entrant on an already-decided fixture is a ghost AND blocks the rebuild (hard constraint 1)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, divisionId);
    await decideFixture(auth, fixtures[0]!.id);
    await patchEntrant(auth, entrantByName.get("A")!, { status: "withdrawn" });

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.ghosts.map((e) => e.id)).toContain(entrantByName.get("A"));

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
  it("an 'abandoned' fixture blocks — it was PLAYED, and match-reports accepts a report on exactly that status", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await sql`update fixtures set status = 'abandoned' where id = ${fixtures[0]!.id}`;

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
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
