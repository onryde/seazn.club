// CD-T13-SW (W2b Task 8, Appendix A BG-WO-2): the chess copy of `swiss-withdrawal-walkover.test.ts`'s walkover case.
// A Swiss withdrawal never expunges (owner ruling 2026-09-24): the withdrawn player's paired, unplayed board walks
// over to the opponent through `core.forfeit{by, reason: "withdrew"}`. Before W2b the cascade posted the English
// reason "entrant withdrew", which the strict forfeit schema refuses (finding 14) — in chess the whole withdrawal 422'd
// on the first paired board. Swiss is a table stage: a drawn board is a result (no tie-break), so the boards here are
// played to a decisive result.
//
// Through the usecases the buttons call: Start, Generate / Pair next, the quick result (`scoreEvent`) and Withdraw.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { applyRoundOneColourLot, swissColourLot, swissDrawSeed } from "@/lib/swiss-draw";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
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
  id: string;
  ext_key: string | null;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string | null; reason?: string } | null;
}

async function fixturesOf(stageId: string): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select id, ext_key, round_no, home_entrant_id, away_entrant_id, status, outcome
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
}

interface Rig {
  auth: AuthCtx;
  stageId: string;
  id: (name: string) => string;
  name: (id: string | null) => string;
}

/** Four individuals S1..S4 in a 2-round CLASSICAL chess swiss, started, round 1 paired: S1 v S3, S2 v S4. A new boardgame
 *  Swiss stores `chess: true` (W3 T8, BG-SW-1), so round 1 is coloured by the stage's lot: board 1's upper player takes
 *  the lot's colour, board 2's the other (home is White). */
async function pairedRoundOne(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss chess withdraw " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "boardgame",
    variant_key: "classical",
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `S${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 2 },
    progression: null,
  });
  await startDivision(auth, division.id); // mints the shells
  await generateStageFixtures(auth, stage!.id); // Pair round 1
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const byId = new Map(entrants.map((e) => [e.id, e.display_name]));
  const rig: Rig = {
    auth,
    stageId: stage!.id,
    id: (n) => byName.get(n)!,
    name: (i) => (i === null ? "-" : (byId.get(i) ?? i)),
  };
  const fold = applyRoundOneColourLot(
    [{ home: "S1", away: "S3" }, { home: "S2", away: "S4" }],
    swissColourLot(swissDrawSeed(rig.stageId)),
  );
  expect(shape(rig, round(await fixturesOf(rig.stageId), 1))).toEqual(fold.map((p, i) => `sw-r1-b${i + 1}: ${p.home} v ${p.away}`));
  return rig;
}

const round = (rows: FixtureRow[], r: number) => rows.filter((f) => f.round_no === r);
const shape = (rig: Rig, rows: FixtureRow[]) =>
  rows.map((f) =>
    f.away_entrant_id === null && f.ext_key?.endsWith("-bye")
      ? `${f.ext_key}: ${rig.name(f.home_entrant_id)} bye`
      : `${f.ext_key}: ${rig.name(f.home_entrant_id)} v ${rig.name(f.away_entrant_id)}`,
  );
const boardOf = (rows: FixtureRow[], r: number, a: string, b: string) =>
  rows.find(
    (f) =>
      f.round_no === r &&
      [f.home_entrant_id, f.away_entrant_id].includes(a) &&
      [f.home_entrant_id, f.away_entrant_id].includes(b),
  )!;

/** The scorer's quick result: `winner` wins by resignation, whichever side they sit. */
async function quickWin(auth: AuthCtx, fixtureId: string, winner: string): Promise<void> {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(auth, fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner, method: "resign" } });
}

describe.runIf(HAS_DB)("CD-T13-SW: a chess swiss withdrawal walks the paired board over", () => {
  it("CD-T13-SW: nothing played yet — the paired board walks over with reason withdrew, later rounds are untouched, and Pair next goes on without them", async () => {
    const rig = await pairedRoundOne();
    const S2 = rig.id("S2");
    const S4 = rig.id("S4");
    const r1 = round(await fixturesOf(rig.stageId), 1);
    const theirs = boardOf(r1, 1, S2, S4);
    const other = boardOf(r1, 1, rig.id("S1"), rig.id("S3"));

    const out = await withdrawEntrantCascade(rig.auth, S4);
    expect(out).toEqual({
      entrant_id: S4,
      status: "withdrawn",
      policy: "walkover",
      walkovers: 1,
      voided: 0,
      skipped_finalized: 0,
      walked_over_held: 0,
      left_to_organiser: [],
    });

    const after = await fixturesOf(rig.stageId);
    const walkedOver = after.find((f) => f.id === theirs.id)!;
    expect(walkedOver.status, "a walkover, not an abandoned board").toBe("forfeited");
    expect(walkedOver.outcome).toEqual({ kind: "award", winner: S2, loser: S4, reason: "withdrew" });
    const ledger = await sql<{ type: string; payload: unknown }[]>`
      select type, payload from score_events where fixture_id = ${theirs.id} order by seq`;
    expect(ledger, "one forfeit before the game — no start is posted for it (BG-WO-2)").toEqual([
      { type: "core.forfeit", payload: { by: S4, reason: "withdrew" } },
    ]);
    expect(after.find((f) => f.id === other.id)).toMatchObject({ status: "scheduled", outcome: null });
    expect(round(after, 2).map((f) => [f.home_entrant_id, f.away_entrant_id, f.status])).toEqual([
      [null, null, "scheduled"],
      [null, null, "scheduled"],
    ]);

    const S1 = rig.id("S1");
    await quickWin(rig.auth, other.id, S1);
    // Not stranded: the two 1-point winners pair, S3 takes the bye, S4 is left out. Chess colours (P-A5): S1 alternates
    // from its round-1 colour, and S2's walkover gave S2 none, so S1 is White in round 2 exactly when it was Black in round 1.
    const next = await generateStageFixtures(rig.auth, rig.stageId);
    expect(next.reshaped).toEqual({ matches_added: 0, matches_removed: 1, byes_added: 1, byes_removed: 0 });
    const r2 = round(await fixturesOf(rig.stageId), 2);
    const s1WasWhite = other.home_entrant_id === S1;
    expect(shape(rig, r2)).toEqual([s1WasWhite ? "sw-r2-b1: S2 v S1" : "sw-r2-b1: S1 v S2", "sw-r2-bye: S3 bye"]);
    expect(r2.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])).not.toContain(S4);
  });
});
