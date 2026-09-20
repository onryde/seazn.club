// Swiss shell mint + Pair next — first Generate creates empty fixture rows for
// every configured round; subsequent Generates seat one round at a time.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { EngineError } from "@seazn/engine/core";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent, recomputeStandings } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures, getStandings, unpairSwissRound } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface FixtureRow {
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
  /** postgres.js parses `timestamptz` into a JS Date; the union keeps the
   *  assertion below honest if that ever changes. */
  scheduled_at: Date | string | null;
  ext_key: string | null;
}

async function fixturesOf(stageId: string): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select round_no, home_entrant_id, away_entrant_id, status, outcome, scheduled_at, ext_key
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
}

async function seedSwissStage(
  auth: AuthCtx,
  config: Record<string, unknown>,
  entrantCount = 4,
): Promise<{ divisionId: string; stageId: string }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss shells " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config,
    progression: null,
  });
  return { divisionId: division.id, stageId: stage!.id };
}

function isSeated(f: FixtureRow): boolean {
  if (f.outcome && typeof f.outcome === "object" && "kind" in f.outcome && (f.outcome as { kind: string }).kind === "award") {
    return true;
  }
  return f.home_entrant_id !== null && f.away_entrant_id !== null;
}

async function playRoundHomeWins(orgId: string, stageId: string, roundNo: number): Promise<void> {
  const rows = await sql<{ id: string; away_entrant_id: string | null }[]>`
    select id, away_entrant_id from fixtures
    where stage_id = ${stageId} and round_no = ${roundNo}`;
  for (const f of rows) {
    if (f.away_entrant_id === null) continue;
    await appendEvent(orgId, f.id, 0, { type: "core.start", payload: {}, recordedBy: null });
    await appendEvent(orgId, f.id, 1, { type: "badminton.game.summary", payload: { home: 21, away: 10 }, recordedBy: null });
    await appendEvent(orgId, f.id, 2, { type: "badminton.game.summary", payload: { home: 21, away: 12 }, recordedBy: null });
  }
}

describe.runIf(HAS_DB)("swiss shell fixtures — mint all rounds on first Generate", () => {
  it("Generate mints shells for all rounds without seating anyone", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);

    const rows = await fixturesOf(stageId);
    expect(rows).toHaveLength(6); // 3 rounds × 2 boards (4 entrants)
    expect(rows.every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);
    expect(rows.every((f) => f.status === "scheduled")).toBe(true);
    expect(rows.every((f) => f.outcome === null)).toBe(true);
  });

  it("Generate without config.rounds returns CONFIG_INVALID", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, {});

    await expect(generateStageFixtures(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "CONFIG_INVALID"),
    );
  });

  it("second Generate pairs round 1 without duplicating rows", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);

    const first = await fixturesOf(stageId);
    expect(first).toHaveLength(6);

    const paired = await generateStageFixtures(auth, stageId);
    expect(paired.created).toBe(2);

    const after = await fixturesOf(stageId);
    expect(after).toHaveLength(6);
    expect(after.filter((f) => f.round_no === 1).every(isSeated)).toBe(true);
    expect(after.filter((f) => f.round_no > 1).every((f) => !isSeated(f))).toBe(true);
  });
});

describe.runIf(HAS_DB)("swiss shell fixtures — Pair next seating", () => {
  it("Pair seats only the lowest unseated round", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);

    const paired = await generateStageFixtures(auth, stageId);
    expect(paired.created).toBe(2);

    const rows = await fixturesOf(stageId);
    expect(rows.filter((f) => f.round_no === 1).every(isSeated)).toBe(true);
    expect(rows.filter((f) => f.round_no > 1).every((f) => !isSeated(f))).toBe(true);
  });

  it("Pair refuses while previous seated round has undecided matches", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);

    await generateStageFixtures(auth, stageId);

    await expect(generateStageFixtures(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
  });

  it("Pair ignores unseated future shells when checking readiness", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);

    await generateStageFixtures(auth, stageId);
    await playRoundHomeWins(auth.orgId, stageId, 1);

    const paired = await generateStageFixtures(auth, stageId);
    expect(paired.created).toBe(2);
    expect((await fixturesOf(stageId)).filter((f) => f.round_no === 2).every(isSeated)).toBe(true);
  });

  it("Pair R1 requires an explicit second Generate (no auto-seat on mint)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);

    const rows = await fixturesOf(stageId);
    expect(rows.every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);
  });

  it("odd-field bye awards win points on the standings table (not just pairing score)", async () => {
    // Regression for Gus on Swiss 7: pairing counted the bye (+1 Swiss score)
    // while rankedStageStandings left played=0/points=0 because loadStageInputs
    // required both seats + a match_state before calling standingsDelta.
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 2 }, 3);
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const bye = (await fixturesOf(stageId)).find(
      (f) => f.ext_key?.endsWith("-bye") && f.outcome !== null,
    );
    expect(bye?.home_entrant_id).toBeTruthy();
    const byeWinner = bye!.home_entrant_id!;

    await playRoundHomeWins(auth.orgId, stageId, 1);
    const rows = await recomputeStandings(auth.orgId, stageId);
    const byeRow = rows.find((r) => r.entrantId === byeWinner);
    expect(byeRow).toMatchObject({ played: 1, won: 1, points: 2 });
  });

  it("Unpair clears bye points from the standings snapshot", async () => {
    // getStandings returns standings_snapshots when present; Unpair used to
    // clear the bye fixture but leave the snapshot, so Dan kept the R3 bye
    // points until the next scored match.
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 2 }, 3);
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const bye = (await fixturesOf(stageId)).find(
      (f) => f.ext_key?.endsWith("-bye") && f.outcome !== null,
    );
    const byeWinner = bye!.home_entrant_id!;
    // Pair next recomputes; pin the snapshot carries the bye win via getStandings.
    const seated = await getStandings(auth, stageId);
    const seatedRows = seated.rows as { entrantId: string; played: number; won: number; points: number }[];
    expect(seatedRows.find((r) => r.entrantId === byeWinner)).toMatchObject({
      played: 1,
      won: 1,
      points: 2,
    });

    await unpairSwissRound(auth, stageId);
    const after = await getStandings(auth, stageId);
    const afterRows = after.rows as { entrantId: string; played: number; won: number; points: number }[];
    // Unpair cleared every seat (only R1 was seated), so the fold's entrant
    // set is empty and the bye winner may be absent entirely — what must not
    // happen is the old snapshot still crediting the award.
    const afterBye = afterRows.find((r) => r.entrantId === byeWinner);
    expect(afterBye?.points ?? 0).toBe(0);
    expect(afterBye?.played ?? 0).toBe(0);
    expect(afterBye?.won ?? 0).toBe(0);
  });
});

describe.runIf(HAS_DB)("swiss shell fixtures — Unpair", () => {
  it("Unpair clears latest seated round and keeps schedule columns", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);

    const pinnedAt = "2030-06-15T14:00:00.000Z";
    const [shell] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} and round_no = 1 and ext_key = 'sw-r1-b1'`;
    await sql`update fixtures set scheduled_at = ${pinnedAt} where id = ${shell!.id}`;

    await generateStageFixtures(auth, stageId);
    expect((await fixturesOf(stageId)).filter((f) => f.round_no === 1).every(isSeated)).toBe(true);

    const out = await unpairSwissRound(auth, stageId);
    expect(out).toEqual({ cleared: 2, round: 1 });

    const after = await fixturesOf(stageId);
    expect(after.filter((f) => f.round_no === 1).every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);
    expect(after.filter((f) => f.round_no === 1).every((f) => f.status === "scheduled" && f.outcome === null)).toBe(true);
    const pinned = after.find((f) => f.ext_key === "sw-r1-b1")?.scheduled_at;
    expect(pinned instanceof Date ? pinned.toISOString() : pinned).toBe(pinnedAt);
  });

  it("Unpair refuses when a seated board has score_events while still scheduled", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const [target] = await sql<{ id: string; status: string }[]>`
      select id, status from fixtures
      where stage_id = ${stageId} and round_no = 1 and away_entrant_id is not null
      limit 1`;
    expect(target!.status).toBe("scheduled");
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload)
      values (${target!.id}, ${auth.orgId}, 1, 'core.point', ${sql.json({ side: "home" } as never)})`;

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
  });

  // --- C1 (2026-09-20 review) -----------------------------------------
  // Every case below sets its evidence by DIRECT SQL and appends NO events,
  // so each one is killed by exactly one clause of the guard. The suite's
  // pre-existing "decided"/"score_events" cases both go through appendEvent,
  // which writes score_events AND config_snapshot AND a match_state — so the
  // score_events clause refuses first there and no other clause is pinned.

  /** The seated (two-sided) board ids of round 1, in seq order. */
  async function seatedRound1(stageId: string): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
      select id from fixtures
      where stage_id = ${stageId} and round_no = 1
        and home_entrant_id is not null and away_entrant_id is not null
      order by seq_in_round`;
    return rows.map((r) => r.id);
  }

  it("Unpair refuses a TWO-SIDED forfeit award in the round — no events at all", async () => {
    // THE C1 REPRO. `swiss-shell.ts` called any `outcome.kind === "award"` a
    // bye, which both skipped this row in the played-result guard AND
    // excluded it from the score_events guard, so Unpair nulled a real
    // retirement's entrants, status and outcome in one click. Written by SQL
    // with no score_events precisely so the status guard is the ONLY thing
    // that can refuse: mutate `swissRoundHasPlayedResult` to `return false`
    // and this test is the one that reds.
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const [board] = await seatedRound1(stageId);
    const [row] = await sql<{ away_entrant_id: string }[]>`
      select away_entrant_id from fixtures where id = ${board!}`;
    await sql`
      update fixtures set status = 'forfeited',
        outcome = ${sql.json({ kind: "award", winner: row!.away_entrant_id } as never)}
      where id = ${board!}`;

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );

    // …and the result is still there. A green refusal that had already
    // cleared the row would be worthless.
    const after = await fixturesOf(stageId);
    const kept = after.find((f) => f.round_no === 1 && f.status === "forfeited");
    expect(kept?.home_entrant_id).not.toBeNull();
    expect(kept?.away_entrant_id).not.toBeNull();
    expect(kept?.outcome).toEqual({ kind: "award", winner: row!.away_entrant_id });
  });

  it("Unpair refuses a row set 'decided' by SQL with NO score_events", async () => {
    // Pins the `decided` arm of the status guard on its own — the suite's
    // other decided case plays through appendEvent, where score_events
    // refuses first and this arm is dead weight.
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const [board] = await seatedRound1(stageId);
    await sql`update fixtures set status = 'decided' where id = ${board!}`;

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
  });

  it("Unpair refuses a frozen config_snapshot while the row is still 'scheduled'", async () => {
    // Monotonic evidence. `fixtures.status` walks BACKWARDS to 'scheduled'
    // when a core.start is voided (append-event.ts fixtureStatusFromFold),
    // so status can never be the sole test. config_snapshot is written once,
    // at the first event, and never cleared.
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const [board] = await seatedRound1(stageId);
    await sql`
      update fixtures set config_snapshot = ${sql.json({ bestOf: 3 } as never)}, config_snapshot_at = now()
      where id = ${board!}`;

    const [check] = await sql<{ status: string }[]>`select status from fixtures where id = ${board!}`;
    expect(check!.status).toBe("scheduled");

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
  });

  it("Unpair refuses a match_state with no score_events and a 'scheduled' status", async () => {
    // Pins the match_states clause the old guard did not consult at all.
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const [board] = await seatedRound1(stageId);
    await sql`
      insert into match_states (fixture_id, org_id, last_seq, state, summary)
      values (${board!}, ${auth.orgId}, 0, ${sql.json({} as never)}, ${sql.json({} as never)})`;

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
  });

  /** persons → officials → fixture_officials, the chain `official_marks` and
   *  `match_reports` both hang off. */
  async function seedFixtureOfficial(orgId: string, fixtureId: string): Promise<{ foId: string; officialId: string }> {
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${orgId}, 'Ref Person') returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${orgId}, ${person!.id}, 'The Ref', ${sql.json(["referee"] as never)}) returning id`;
    const [fo] = await sql<{ id: string }[]>`
      insert into fixture_officials (fixture_id, official_id, org_id, role_key, source, response)
      values (${fixtureId}, ${official!.id}, ${orgId}, 'referee', 'manual', 'accepted') returning id`;
    return { foId: fo!.id, officialId: official!.id };
  }

  it("Unpair refuses a fixture carrying an official_marks row", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const [board] = await seatedRound1(stageId);
    const { foId, officialId } = await seedFixtureOfficial(auth.orgId, board!);
    await sql`
      insert into official_marks (org_id, fixture_official_id, official_id, fixture_id, mark)
      values (${auth.orgId}, ${foId}, ${officialId}, ${board!}, 4)`;

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
  });

  it("Unpair refuses a fixture carrying a match_reports row", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const [board] = await seatedRound1(stageId);
    const { foId, officialId } = await seedFixtureOfficial(auth.orgId, board!);
    await sql`
      insert into match_reports (org_id, fixture_official_id, official_id, fixture_id, status, body, incidents)
      values (${auth.orgId}, ${foId}, ${officialId}, ${board!}, 'draft', 'as it happened', ${sql.json([] as never)})`;

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
  });

  it("Unpair refuses a fixture named by a suspension", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const [board] = await seatedRound1(stageId);
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Banned Player') returning id`;
    await sql`
      insert into suspensions (org_id, division_id, person_id, fixture_id, status, source,
                               reason, matches_total, matches_served)
      values (${auth.orgId}, ${divisionId}, ${person!.id}, ${board!}, 'active', 'manual',
              'violent conduct', 2, 0)`;

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
  });

  it("Unpair refuses when a match in that round is decided", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);
    await playRoundHomeWins(auth.orgId, stageId, 1);

    await expect(unpairSwissRound(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "STAGE_NOT_READY"),
    );
  });

  it("Unpair allows a round that only has a bye award + unplayed seated boards", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 2 }, 3);
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const before = await fixturesOf(stageId);
    expect(before.some((f) => f.ext_key?.endsWith("-bye") && f.outcome !== null)).toBe(true);

    const out = await unpairSwissRound(auth, stageId);
    expect(out.round).toBe(1);
    expect(out.cleared).toBeGreaterThan(0);

    const after = await fixturesOf(stageId);
    expect(after.filter((f) => f.round_no === 1).every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);
    expect(after.find((f) => f.ext_key?.endsWith("-bye"))?.outcome).toBeNull();
  });

  it("Unpair on knockout stage fails", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    const [ko] = await createStages(auth, divisionId, {
      seq: 2,
      kind: "knockout",
      name: "KO",
      config: {},
      progression: null,
    });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, ko!.id);

    await expect(unpairSwissRound(auth, ko!.id)).rejects.toMatchObject({ status: 422 });
  });
});
