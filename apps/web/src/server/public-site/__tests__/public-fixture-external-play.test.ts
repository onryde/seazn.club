// The public fixture loader against the REAL fixture_external_play schema.
//
// `loadPublicExternalPlay` selected play_url / white_play_url /
// black_play_url, which V433's table never had: Postgres refuses an unknown
// column when it PARSES the query, whether or not a row matches, and
// getPublicFixture runs that read for every fixture — so every public fixture
// page errored, chess or not. No test ran the real loader against the real
// table; this one does, with and without a bridge row.
//
// Single-sport on purpose: the read is one select by fixture_id, blind to
// the sport, and the no-row case is the one every non-chess page takes.
//
// unstable_cache is a Next server-runtime API — passthrough under vitest, the
// same double public-fixture-venue-tz.test.ts uses. Real Postgres required.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { getPublicFixture } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Copied from public-fixture-venue-tz.test.ts: matchCentre parses the
 *  division config through the module's configSchema, so '{}' is refused. */
const GENERIC_DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** A public org / competition / division / fixture by direct insert — the
 *  venue-tz suite's seed, minus its timezone column. */
async function seedPublicFixture() {
  const s = uniq();
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = "pub-ep-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Pub EP Org " + s}, ${orgSlug}) returning id`;
  const compSlug = "pub-ep-comp-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"Pub EP Comp " + s}, ${compSlug}, 'public', 'live') returning id`;
  const divSlug = "open-" + s;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions
      (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', 'score', 'active',
            ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq)
    values (${orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
    values (${orgId}, ${divisionId}, ${stageId}, 1, 1, 1) returning id`;
  return { orgId, orgSlug, compSlug, divSlug, fixtureId };
}

const seeded: string[] = [];
afterAll(async () => {
  for (const orgId of seeded) await sql`delete from organizations where id = ${orgId}`;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("getPublicFixture reads the online-play bridge from the real schema", () => {
  it("a fixture with NO bridge row loads, with externalPlay null", async () => {
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data, "the seeded fixture must be publicly visible").not.toBeNull();
    expect(data!.fixture.id).toBe(s.fixtureId);
    expect(data!.externalPlay).toBeNull();
  });

  it("a fixture WITH a bridge row loads, and carries its status and nothing else", async () => {
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id)
      values (${s.fixtureId}, ${s.orgId}, now(), 'ready', ${`gm-${uniq()}${uniq()}`})`;
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data).not.toBeNull();
    // toEqual on the whole object: a re-added play URL or last_error key
    // fails here, not just a wrong status. A game on file with no move yet is
    // the start position (the rulebook's), no clocks read, nothing over.
    expect(data!.externalPlay).toEqual({
      status: "ready",
      watch: {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        lastMove: null,
        turn: "white",
        ply: 0,
        whiteMs: null,
        blackMs: null,
        asOf: null,
        clockRunning: false,
        over: false,
        whiteSide: null,
      },
    });
  });

  it("T16: a game in progress carries its view-only board — the ledger's position, clocks as of the last move, White's side", async () => {
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    const lastMoveAt = new Date("2026-10-13T10:00:00.000Z");
    // Labelled SQL: T10's move append writes the ledger (V436); here it stands for two accepted moves, 1.Nf3 Nf6.
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, scheduled_at_basis, status, challenge_id, white_side,
         moves_uci, move_count, white_ms, black_ms, last_move_at)
      values (${s.fixtureId}, ${s.orgId}, now(), 'live', ${`gm-${uniq()}${uniq()}`}, 'away',
              ${sql.json(["g1f3", "g8f6"])}, 2, 598000, 597000, ${lastMoveAt})`;
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    // The FEN after 1.Nf3 Nf6, from the rules (FEN: halfmove clock 2, fullmove 2), not from our replay.
    expect(data!.externalPlay).toEqual({
      status: "live",
      watch: {
        fen: "rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2",
        lastMove: "g8f6",
        turn: "white",
        ply: 2,
        whiteMs: 598000,
        blackMs: 597000,
        asOf: lastMoveAt.toISOString(),
        // Lichess runs the clocks once both sides have moved (ply 2).
        clockRunning: true,
        over: false,
        whiteSide: "away",
      },
    });
  });

  it("T16: a finished game's board is over; a hold with no game has no board", async () => {
    const done = await seedPublicFixture();
    seeded.push(done.orgId);
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, scheduled_at_basis, status, challenge_id, white_side, moves_uci, move_count)
      values (${done.fixtureId}, ${done.orgId}, now(), 'finished', ${`gm-${uniq()}${uniq()}`}, 'home',
              ${sql.json(["e2e4"])}, 1)`;
    const finished = await getPublicFixture(done.orgSlug, done.compSlug, done.divSlug, done.fixtureId);
    expect(finished!.externalPlay!.watch).toMatchObject({ over: true, clockRunning: false, turn: "black", lastMove: "e2e4", ply: 1 });
    const held = await seedPublicFixture();
    seeded.push(held.orgId);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, needs_reason)
      values (${held.fixtureId}, ${held.orgId}, now(), 'needs_organiser', 'not_started')`;
    const data = await getPublicFixture(held.orgSlug, held.compSlug, held.divSlug, held.fixtureId);
    expect(data!.externalPlay).toEqual({ status: "needs_organiser", watch: null });
  });

  it("an organiser's hold never shows its operator text publicly", async () => {
    // last_error is written for operators ("create:outcome_unknown: …",
    // T9); the public page gets the status alone.
    const s = await seedPublicFixture();
    seeded.push(s.orgId);
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, scheduled_at_basis, status, needs_reason, last_error)
      values (${s.fixtureId}, ${s.orgId}, now(), 'needs_organiser', 'provider_error',
              'create:outcome_unknown: operator-only detail')`;
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data!.externalPlay).toEqual({ status: "needs_organiser", watch: null });
    expect(JSON.stringify(data)).not.toContain("operator-only detail");
  });
});
