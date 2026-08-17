// L3/#414 pass 2 — every stage kind now writes a placement snapshot at
// completion (engine-db/competition.ts: the parseStageKind boundary, the
// bracket branch rebuilt from ext_key + outcome, and a new ladder branch).
// Requires a real Postgres — skipped when DATABASE_URL is absent, same
// contract as integration.test.ts.
//
// Bracket-kind fixtures are seeded with the exact ext_key/round_no/
// winner_to_fixture shapes packages/engine/src/scheduling/bracket.ts's
// generators actually produce (never through usecases/stages.ts's own
// generator, which is pass 3's territory) — these tests prove the DB->engine
// RECONSTRUCTION path (ext_key parsing, winner/loser derivation, isFinal
// refinement), not bracketRanks's ranking algorithm itself, which is already
// covered at the engine layer (packages/engine/src/competition/stage.test.ts).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent, completeStageIfReady } from "../index";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
} as const;

async function seedDivision(): Promise<{ orgId: string; divisionId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id
  `;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing
  `;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id
  `;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"div-" + suffix}, 'generic', 'score',
            ${sql.json(DIVISION_CONFIG)}, '1.0.0')
    returning id
  `;
  return { orgId, divisionId };
}

async function seedStage(
  divisionId: string,
  kind: string,
  config: Record<string, unknown> | null = null,
): Promise<string> {
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name, config)
    values (${divisionId}, 1, ${kind}, ${kind}, ${sql.json((config ?? {}) as never)})
    returning id
  `;
  return stageId;
}

async function seedEntrant(divisionId: string, name: string, seed: number): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', ${name}, ${seed})
    returning id
  `;
  return id;
}

interface FixtureSeed {
  ext_key: string;
  round_no: number;
  home?: string | null;
  away?: string | null;
  winnerTo?: string; // ext_key of the fixture this one's winner feeds
  outcome?: { kind: "win"; winner: string; loser: string };
}

// Two passes, matching stages.ts's own generator shape: every row first (so
// ext_key -> uuid is known), then winner_to_fixture wiring + outcomes second
// (winner_to_fixture is itself a fixture id, so it can't be set in pass one).
async function seedBracketFixtures(
  stageId: string,
  divisionId: string,
  defs: FixtureSeed[],
): Promise<Map<string, string>> {
  const byExtKey = new Map<string, string>();
  for (const [i, def] of defs.entries()) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id,
                             away_entrant_id, ext_key, status)
      values (${stageId}, ${divisionId}, ${def.round_no}, ${i + 1}, ${def.home ?? null},
              ${def.away ?? null}, ${def.ext_key}, 'scheduled')
      returning id
    `;
    byExtKey.set(def.ext_key, id);
  }
  for (const def of defs) {
    const id = byExtKey.get(def.ext_key) as string;
    if (def.winnerTo !== undefined) {
      const targetId = byExtKey.get(def.winnerTo);
      if (targetId === undefined) throw new Error(`unknown winnerTo ext_key ${def.winnerTo}`);
      await sql`update fixtures set winner_to_fixture = ${targetId} where id = ${id}`;
    }
    if (def.outcome !== undefined) {
      await sql`update fixtures set status = 'decided', outcome = ${sql.json(def.outcome)} where id = ${id}`;
    }
  }
  return byExtKey;
}

// Table-kind fixtures (league/group/swiss/americano) MUST be decided through
// the real fold: completeTableStage reads TableFixture.result, which
// loadStageInputs only populates when a fixture has BOTH `outcome` AND a
// folded `match_states.state` (`f.outcome && f.state && ...` in
// competition.ts). Hand-writing `outcome` via raw SQL with no match_states
// row (fine for bracket/ladder, which read outcome directly) leaves `result`
// undefined here, so every entrant folds to identical all-zero stats and the
// tiebreaker cascade's fallback order decides the "winner" — a test that
// passes independent of who actually won. Score it for real instead.
async function seedDecidedFixture(
  orgId: string,
  stageId: string,
  divisionId: string,
  roundNo: number,
  seqInRound: number,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
): Promise<string> {
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, ${roundNo}, ${seqInRound}, ${home}, ${away})
    returning id
  `;
  await appendEvent(orgId, fixtureId, 0, { type: "core.start", payload: {} });
  await appendEvent(orgId, fixtureId, 1, {
    type: "generic.result",
    payload: { p1Score: homeScore, p2Score: awayScore },
  });
  return fixtureId;
}

async function snapshotRanks(stageId: string, poolId: string | null = null): Promise<string[] | null> {
  const [snap] = await sql<{ rows: { entrantId: string; rank: number }[] }[]>`
    select rows from standings_snapshots where stage_id = ${stageId} and pool_id is not distinct from ${poolId}
  `;
  if (!snap) return null;
  return [...snap.rows].sort((a, b) => a.rank - b.rank).map((r) => r.entrantId);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("L3/#414 pass 2 — placement snapshot per stage kind", () => {
  it("league: writes a single-pool snapshot", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "league");
    const [a, b] = await Promise.all([seedEntrant(divisionId, "A", 1), seedEntrant(divisionId, "B", 2)]);
    await seedDecidedFixture(orgId, stageId, divisionId, 1, 1, a, b, 2, 1);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    expect(await snapshotRanks(stageId)).toEqual([a, b]);
  });

  it("group: writes a snapshot PER POOL", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "group");
    const [{ id: poolA }] = await sql<{ id: string }[]>`
      insert into pools (stage_id, key, name) values (${stageId}, 'A', 'Pool A') returning id`;
    const [{ id: poolB }] = await sql<{ id: string }[]>`
      insert into pools (stage_id, key, name) values (${stageId}, 'B', 'Pool B') returning id`;
    const [a, b, c, d] = await Promise.all([
      seedEntrant(divisionId, "A", 1),
      seedEntrant(divisionId, "B", 2),
      seedEntrant(divisionId, "C", 3),
      seedEntrant(divisionId, "D", 4),
    ]);
    const f1 = await seedDecidedFixture(orgId, stageId, divisionId, 1, 1, a, b, 2, 1);
    await sql`update fixtures set pool_id = ${poolA} where id = ${f1}`;
    const f2 = await seedDecidedFixture(orgId, stageId, divisionId, 1, 2, c, d, 2, 1);
    await sql`update fixtures set pool_id = ${poolB} where id = ${f2}`;

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    expect(await snapshotRanks(stageId, poolA)).toEqual([a, b]);
    expect(await snapshotRanks(stageId, poolB)).toEqual([c, d]);
  });

  it("swiss: completes once its configured rounds settle, writes a snapshot", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "swiss", { rounds: 1 });
    const [a, b] = await Promise.all([seedEntrant(divisionId, "A", 1), seedEntrant(divisionId, "B", 2)]);
    await seedDecidedFixture(orgId, stageId, divisionId, 1, 1, a, b, 2, 1);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    expect(await snapshotRanks(stageId)).toEqual([a, b]);
  });

  it("americano: still folds through the league adapter (display snapshot shape unchanged)", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "americano");
    const [a, b] = await Promise.all([seedEntrant(divisionId, "A", 1), seedEntrant(divisionId, "B", 2)]);
    await seedDecidedFixture(orgId, stageId, divisionId, 1, 1, a, b, 2, 1);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    expect(await snapshotRanks(stageId)).toEqual([a, b]);
  });

  it("knockout: rebuilds the bracket from ext_key + outcome, INCLUDING a thirdPlace playoff", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "knockout", { thirdPlace: true });
    const [a, b, c, d] = await Promise.all([
      seedEntrant(divisionId, "A", 1),
      seedEntrant(divisionId, "B", 2),
      seedEntrant(divisionId, "C", 3),
      seedEntrant(divisionId, "D", 4),
    ]);

    // Real generateSingleElim(thirdPlace: true) shape for 4 entrants: two
    // round-0 semis feeding the round-1 final, plus a same-round thirdPlace
    // game between the semifinal losers (se-3p) — see bracket.ts.
    await seedBracketFixtures(stageId, divisionId, [
      {
        ext_key: "se-r0-i0",
        round_no: 1,
        home: a,
        away: b,
        winnerTo: "se-r1-i0",
        outcome: { kind: "win", winner: a, loser: b },
      },
      {
        ext_key: "se-r0-i1",
        round_no: 1,
        home: c,
        away: d,
        winnerTo: "se-r1-i0",
        outcome: { kind: "win", winner: c, loser: d },
      },
      // thirdPlace: the upset — B (semi 1 loser) beats D (semi 2 loser).
      { ext_key: "se-3p", round_no: 2, home: b, away: d, outcome: { kind: "win", winner: b, loser: d } },
      { ext_key: "se-r1-i0", round_no: 2, home: a, away: c, outcome: { kind: "win", winner: a, loser: c } },
    ]);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    // 1=A (final winner), 2=C (final loser), 3=B (3rd-place winner — an
    // upset over D, so a naive "later round = better" fallback with no
    // thirdPlace parsing would have ranked D above B here instead).
    expect(await snapshotRanks(stageId)).toEqual([a, c, b, d]);
    expect(result.events).toEqual([
      { type: "stage_completed", stageId, finalRanks: [a, c, b, d] },
    ]);
  });

  it("knockout: a thirdPlace fixture never masquerades as the decider, even sharing the final's round_no", async () => {
    // Regression for a real bug this pass's own test suite caught: se-3p and
    // the true final both persist with winner_to_fixture = null (neither
    // fixture's winner feeds anywhere else) AND the same round_no
    // (bracket.ts: the thirdPlace game's `round` is literally `rounds - 1`,
    // identical to the final's). The naive "winner_to_fixture is null =>
    // isFinal" heuristic alone can't tell them apart — thirdPlace (parsed
    // from ext_key, never guessed) is what settles it. Also proves stage
    // completion does NOT wait on the thirdPlace game: it's still 'scheduled'
    // here and the stage completes anyway, ranks 3/4 falling back to
    // elimination order (packages/engine/src/competition/stage.ts
    // bracketRanks already degrades gracefully when no thirdPlace result is
    // available — same contract as a knockout with thirdPlace disabled).
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "knockout", { thirdPlace: true });
    const [a, b, c, d] = await Promise.all([
      seedEntrant(divisionId, "A", 1),
      seedEntrant(divisionId, "B", 2),
      seedEntrant(divisionId, "C", 3),
      seedEntrant(divisionId, "D", 4),
    ]);

    await seedBracketFixtures(stageId, divisionId, [
      {
        ext_key: "se-r0-i0",
        round_no: 1,
        home: a,
        away: b,
        winnerTo: "se-r1-i0",
        outcome: { kind: "win", winner: a, loser: b },
      },
      {
        ext_key: "se-r0-i1",
        round_no: 1,
        home: c,
        away: d,
        winnerTo: "se-r1-i0",
        outcome: { kind: "win", winner: c, loser: d },
      },
      // thirdPlace fixture exists but is NOT decided yet.
      { ext_key: "se-3p", round_no: 2, home: b, away: d },
      { ext_key: "se-r1-i0", round_no: 2, home: a, away: c, outcome: { kind: "win", winner: a, loser: c } },
    ]);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    // 1=A, 2=C off the true final; 3/4 fall back to elimination order (both B
    // and D lost at round 1, so the tiebreak — seed, then id — decides among
    // equals rather than the (unplayed) 3rd-place result).
    expect(await snapshotRanks(stageId)).toEqual([a, c, b, d]);
  });

  it("double_elim: reads the WB/GF lanes off ext_key and ranks the grand final", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "double_elim");
    const [a, b] = await Promise.all([seedEntrant(divisionId, "A", 1), seedEntrant(divisionId, "B", 2)]);

    // Real generateDoubleElim shape for 2 entrants: no losers-bracket games
    // exist at all (lbRounds = 0), so the WB round-0 game feeds straight into
    // "gf" (the LB-champion slot is the WB final's loser directly).
    await seedBracketFixtures(stageId, divisionId, [
      {
        ext_key: "wb-r0-i0",
        round_no: 1,
        home: a,
        away: b,
        winnerTo: "gf",
        outcome: { kind: "win", winner: a, loser: b },
      },
      { ext_key: "gf", round_no: 2, home: a, away: b, outcome: { kind: "win", winner: a, loser: b } },
    ]);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    expect(await snapshotRanks(stageId)).toEqual([a, b]);
  });

  it("stepladder: ranks by elimination round, not merely win/loss", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "stepladder");
    const [a, b, c] = await Promise.all([
      seedEntrant(divisionId, "A", 1),
      seedEntrant(divisionId, "B", 2),
      seedEntrant(divisionId, "C", 3),
    ]);

    // Real generateStepladder shape for 3 entrants: the two lowest seeds
    // (B, C) play game 0; the winner climbs to meet the top seed (A) in the
    // final. C upsets B, then loses the final to A.
    await seedBracketFixtures(stageId, divisionId, [
      {
        ext_key: "sl-g0",
        round_no: 1,
        home: b,
        away: c,
        winnerTo: "sl-g1",
        outcome: { kind: "win", winner: c, loser: b },
      },
      { ext_key: "sl-g1", round_no: 2, home: a, away: c, outcome: { kind: "win", winner: a, loser: c } },
    ]);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    // 1=A, 2=C (lost the final, round 2), 3=B (lost game 0, round 1 — earlier
    // elimination ranks lower).
    expect(await snapshotRanks(stageId)).toEqual([a, c, b]);
  });

  it("page_playoff: ranks Qualifier1/Eliminator/Qualifier2/Final IPL-style", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "page_playoff");
    const [s1, s2, s3, s4] = await Promise.all([
      seedEntrant(divisionId, "S1", 1),
      seedEntrant(divisionId, "S2", 2),
      seedEntrant(divisionId, "S3", 3),
      seedEntrant(divisionId, "S4", 4),
    ]);

    // Real generatePagePlayoff shape: pp-q1 (1v2) and pp-elim (3v4) at round
    // 0; pp-q2 (q1 loser vs elim winner) at round 1; pp-final at round 2.
    await seedBracketFixtures(stageId, divisionId, [
      {
        ext_key: "pp-q1",
        round_no: 1,
        home: s1,
        away: s2,
        winnerTo: "pp-final",
        outcome: { kind: "win", winner: s1, loser: s2 },
      },
      {
        ext_key: "pp-elim",
        round_no: 1,
        home: s3,
        away: s4,
        winnerTo: "pp-q2",
        outcome: { kind: "win", winner: s3, loser: s4 },
      },
      {
        ext_key: "pp-q2",
        round_no: 2,
        home: s2,
        away: s3,
        winnerTo: "pp-final",
        outcome: { kind: "win", winner: s3, loser: s2 },
      },
      {
        ext_key: "pp-final",
        round_no: 3,
        home: s1,
        away: s3,
        outcome: { kind: "win", winner: s1, loser: s3 },
      },
    ]);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    // 1=S1 (final winner), 2=S3 (final loser, via Q2), 3=S2 (lost Q2, round
    // 2), 4=S4 (lost the Eliminator, round 1 — earliest exit).
    expect(await snapshotRanks(stageId)).toEqual([s1, s3, s2, s4]);
  });

  it("ladder: completes once every challenge settles; finalRanks = config.ladder_order", async () => {
    const { orgId, divisionId } = await seedDivision();
    const [a, b, c] = await Promise.all([
      seedEntrant(divisionId, "A", 1),
      seedEntrant(divisionId, "B", 2),
      seedEntrant(divisionId, "C", 3),
    ]);
    // C already climbed past B (usecases/scoring.ts's swap-on-win) by the
    // time this stage completes.
    const stageId = await seedStage(divisionId, "ladder", { ladder_order: [a, c, b] });
    await seedBracketFixtures(stageId, divisionId, [
      { ext_key: "ch-1", round_no: 1, home: c, away: b, outcome: { kind: "win", winner: c, loser: b } },
    ]);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(true);
    expect(await snapshotRanks(stageId)).toEqual([a, c, b]);
  });

  it("ladder: refuses completion while a challenge fixture is still open", async () => {
    const { orgId, divisionId } = await seedDivision();
    const [a, b, c] = await Promise.all([
      seedEntrant(divisionId, "A", 1),
      seedEntrant(divisionId, "B", 2),
      seedEntrant(divisionId, "C", 3),
    ]);
    const stageId = await seedStage(divisionId, "ladder", { ladder_order: [a, b, c] });
    await seedBracketFixtures(stageId, divisionId, [{ ext_key: "ch-1", round_no: 1, home: c, away: b }]);

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(false);
    expect(await snapshotRanks(stageId)).toBeNull();
    const [stage] = await sql<{ status: string }[]>`select status from stages where id = ${stageId}`;
    expect(stage.status).not.toBe("complete");
  });

  it("ladder: zero fixtures ever issued is not complete — nothing to rank yet", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "ladder");

    const result = await completeStageIfReady(orgId, stageId);
    expect(result.completed).toBe(false);
    expect(await snapshotRanks(stageId)).toBeNull();
  });
});
