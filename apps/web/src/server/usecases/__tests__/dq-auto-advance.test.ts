// W5 app PR A, B3 batch fix wave (I-3): an in-match disqualification on a league's LAST open line, with and without the
// division's `auto_progress`. RB5-W5 (a disqualified entrant ranks last, like a withdrawal, RB5-W1) and ruling 289 (the in-match
// DQ withdraws her from the stage) say nothing about the flag, so both flag values must give the SAME table: her
// `table_withdrawal` row and her rank last. The flag decides only whether the stage then completes on its own.
//
// differential: today (01888347fa) with `auto_progress` on, `scoreEvent` runs `onDecided` -> `maybeAutoAdvance` for the forfeit
// FIRST and completes the stage; the DQ hook then runs the cascade, which skips a complete stage (C1, RB5-L8) - no row, and she
// can top the final table.
//
// Expected values: RB5-W3/W4 (the DQ match is one she PLAYED - decided by the forfeit - so 3 of 3 played: the walkover policy, no
// result removed), RB5-W5 (ranked last). Sports: badminton and tennis, each from the engine registry (the DQ hook is sport-blind;
// two sports guard against a sport-specific status path through `onDecided`).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, getStandings } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const SPORTS = ["badminton", "tennis"].map((key) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`registry has no ${key}`);
  return { key, variant: Object.keys(m.variants)[0]! };
});

async function dqOnLastLine(sport: { key: string; variant: string }, autoProgress: boolean) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "B3 I-3 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport.key, variant_key: sport.variant, config: {} });
  const es = await createEntrants(auth, d.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
  await sql`update divisions set auto_progress = ${autoProgress} where id = ${d.id}`;
  await startDivision(auth, d.id);
  const v = es[0]!.id;
  const lines = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round, id`;
  const mine = lines.filter((l) => l.home_entrant_id === v || l.away_entrant_id === v);
  expect(mine).toHaveLength(3); // a league of 4, one leg
  const last = mine[mine.length - 1]!;
  for (const l of lines) {
    if (l.id === last.id) continue;
    // She wins every other line of hers; elsewhere the home side wins.
    const loser = l.home_entrant_id === v ? l.away_entrant_id : l.away_entrant_id === v ? l.home_entrant_id : l.away_entrant_id;
    await post(auth, l.id, "core.forfeit", { by: loser, reason: "walkover" });
  }
  await post(auth, last.id, "core.start", {});
  await post(auth, last.id, "core.forfeit", { by: v, reason: "disqualified" });
  const [st] = await sql<{ status: string }[]>`select status from stages where id = ${stage!.id}`;
  const [en] = await sql<{ status: string }[]>`select status from entrants where id = ${v}`;
  const rows = await sql<{ payload: { policy: string; played_at_departure: number; scheduled: number } }[]>`
    select payload from division_events where division_id = ${d.id} and type = 'table_withdrawal' order by seq`;
  const table = (await getStandings(auth, stage!.id)).rows as { entrantId: string; rank?: number }[];
  const ranks = table.map((r) => r.rank ?? 0);
  return {
    stage: st!.status,
    entrant: en!.status,
    rows: rows.map((r) => [r.payload.policy, r.payload.played_at_departure, r.payload.scheduled]),
    herRankIsLast: table.find((r) => r.entrantId === v)!.rank === Math.max(...ranks) && ranks.filter((x) => x === Math.max(...ranks)).length === 1,
  };
}

describe.runIf(HAS_DB)("B3 I-3: an in-match DQ on the last open line ranks her last whatever auto_progress says (RB5-W5)", () => {
  let checked = 0;
  for (const sport of SPORTS) {
    it(`${sport.key}: auto_progress on and off give the same table - one walkover row (3 of 3), ranked last`, async () => {
      const off = await dqOnLastLine(sport, false);
      const on = await dqOnLastLine(sport, true);
      const expected = { entrant: "disqualified", rows: [["walkover", 3, 3]], herRankIsLast: true };
      expect({ entrant: off.entrant, rows: off.rows, herRankIsLast: off.herRankIsLast }, "auto_progress off").toEqual(expected);
      expect({ entrant: on.entrant, rows: on.rows, herRankIsLast: on.herRankIsLast }, "auto_progress on").toEqual(expected);
      // The flag decides only whether the finished stage then completes on its own.
      expect([off.stage, on.stage]).toEqual(["active", "complete"]);
      checked++;
    }, 240_000);
  }
  // The held-back auto-advance is asked again after the hook for every DQ forfeit - a bracket's DQ runs no cascade (W4: its
  // own walkover), so nothing else would complete its finished stage. differential: none today (onDecided asked it), pinned.
  it("a knockout final decided by a DQ forfeit still completes its stage with auto_progress on (no cascade there)", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "B3 I-3 ko " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: SPORTS[0]!.key, variant_key: SPORTS[0]!.variant, config: {} });
    const es = await createEntrants(auth, d.id, Array.from({ length: 2 }, (_, i) => ({ kind: "individual" as const, display_name: `K${i + 1}`, seed: i + 1, members: [] })));
    const [stage] = await createStages(auth, d.id, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
    await sql`update divisions set auto_progress = true where id = ${d.id}`;
    await startDivision(auth, d.id);
    const [final] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stage!.id}`;
    await post(auth, final!.id, "core.start", {});
    await post(auth, final!.id, "core.forfeit", { by: es[0]!.id, reason: "disqualified" });
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${stage!.id}`;
    expect(st!.status).toBe("complete");
  }, 240_000);

  it("anti-vacuity: every sport was driven", () => {
    expect(checked).toBe(SPORTS.length);
  });
});
