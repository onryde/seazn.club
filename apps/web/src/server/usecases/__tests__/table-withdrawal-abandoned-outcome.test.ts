// W5 app PR A, B3 batch fix wave (I-5; RB5-W2, RB5-W3, RB5-W4): a league line ended by an ABANDON that still gives a result -
// cricket's rain no result (CK-AB-2: 1 point each) and football's award-policy abandon with a leader (FB-AB-1: the leader wins) -
// is a match the leaver PLAYED. Under half, it is removed with every other result of hers; at half or more, it stands.
//
// Two shapes of that line, both on a real database:
// - as written today: W2b D7 (append-event `fixtureStatusFromFold` rule 2) stores an abandon WITH a result in a draw kind as
//   `decided`, so it already counts. Pinned, no defect expected (the batch review's premise that such a line is `abandoned`
//   does not hold for a line written since D7 - recorded as a false premise).
// - the stored shape before D7 (`status = 'abandoned'` with the outcome kept), rewritten by hand: the shape the review's I-5
//   names. differential: today (01888347fa) it is neither played nor pending - not counted toward the 50 percent, never
//   expunged, so the opponent keeps her points from it.
//
// Expected values: RB5-W2/W3/W4 (the counts and the policy), CK-AB-2 (the declared `points.noResult`), FB-AB-1 (the leader's
// award). Sports: cricket and football - the two sports whose abandon folds to a RESULT in a league (append-event.ts PF-4).
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { getStandings } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const moduleOf = (key: string) => builtinModules.find((x) => x.key === key)!;
const declaredCfg = (sport: string, variant: string) =>
  moduleOf(sport).configSchema.parse(moduleOf(sport).variants[declaredVariant(sport, variant)]) as Record<string, unknown>;

type Line = { id: string; home_entrant_id: string; away_entrant_id: string };

interface Sport {
  key: string;
  variant: string;
  config: () => Record<string, unknown>;
  /** End `line` with an abandon that gives a result; returns the outcome kind the fold stored. */
  abandonWithResult: (auth: AuthCtx, line: Line) => Promise<string>;
}

const SPORTS: Sport[] = [
  {
    key: "cricket",
    variant: "t20",
    config: () => declaredCfg("cricket", "t20"),
    // CK-AB-2: a rain abandon before the minimum overs is a no result.
    abandonWithResult: async (auth, line) => {
      await post(auth, line.id, "core.start");
      const out = await post(auth, line.id, "core.abandon", { reason: "rain" });
      return (out.outcome as { kind: string }).kind;
    },
  },
  {
    key: "football",
    variant: "11-a-side",
    config: () => ({ ...declaredCfg("football", "11-a-side"), abandonPolicy: "award" }),
    // FB-AB-1: an award-policy abandon with a leader is the leader's win.
    abandonWithResult: async (auth, line) => {
      await post(auth, line.id, "core.start");
      await post(auth, line.id, "football.goal", { by: line.home_entrant_id });
      const out = await post(auth, line.id, "core.abandon", { reason: "floodlights" });
      return (out.outcome as { kind: string }).kind;
    },
  },
];

/** A league of 5 (one leg: 4 lines each); the leaver is B1. Her first line ends in an abandon with a result; with `atHalf`, her
 *  second is an ordinary walkover win. `legacy` rewrites the abandoned line to the pre-D7 stored shape. */
async function rig(sport: Sport, opts: { atHalf: boolean; legacy: boolean }) {
  const s = await seedBracket({ sport: sport.key, variant: sport.variant, stageKind: "league", entrants: 5, divisionConfig: sport.config() });
  const [leaver] = await sql<{ id: string }[]>`select id from entrants where division_id = (select division_id from stages where id = ${s.stageId}) order by seed limit 1`;
  const v = leaver!.id;
  const lines = await sql<Line[]>`select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${s.stageId} order by round_no, seq_in_round, id`;
  const mine = lines.filter((l) => l.home_entrant_id === v || l.away_entrant_id === v);
  expect(mine).toHaveLength(4);
  const abandoned = mine[0]!;
  const kind = await sport.abandonWithResult(s.auth, abandoned);
  expect(kind, "rig: the abandon gave a result").not.toBe("none");
  const [row] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${abandoned.id}`;
  expect(row!.outcome, "rig: the abandoned line carries an outcome").not.toBeNull();
  expect(row!.status, "rig: written since W2b D7, an abandon with a result in a league is decided").toBe("decided");
  if (opts.legacy) await sql`update fixtures set status = 'abandoned' where id = ${abandoned.id}`;
  if (opts.atHalf) {
    const won = mine[1]!;
    await post(s.auth, won.id, "core.forfeit", { by: won.home_entrant_id === v ? won.away_entrant_id : won.home_entrant_id, reason: "walkover" });
  }
  const opponent = abandoned.home_entrant_id === v ? abandoned.away_entrant_id : abandoned.home_entrant_id;
  return { ...s, v, abandoned, opponent };
}

async function activeExpunge(fixtureId: string): Promise<boolean> {
  const evs = await sql<{ id: string; type: string; payload: Record<string, unknown>; voids_event_id: string | null }[]>`
    select id, type, payload, voids_event_id from score_events where fixture_id = ${fixtureId}`;
  const voided = new Set(evs.map((e) => e.voids_event_id).filter(Boolean));
  return evs.some((e) => !voided.has(e.id) && e.type === "core.abandon" && e.payload.expunge === true);
}

async function ledgerRows(stageId: string) {
  const rows = await sql<{ payload: { policy: string; played_at_departure: number; scheduled: number } }[]>`
    select payload from division_events where type = 'table_withdrawal' and payload ->> 'stage_id' = ${stageId} order by seq`;
  return rows.map((r) => [r.payload.policy, r.payload.played_at_departure, r.payload.scheduled]);
}

const opponentPlayed = async (auth: AuthCtx, stageId: string, opponent: string) =>
  ((await getStandings(auth, stageId)).rows as { entrantId: string; played: number }[]).find((r) => r.entrantId === opponent)!.played;

describe.runIf(HAS_DB)("B3 I-5: a league line abandoned WITH a result counts as played (RB5-W2/W3/W4)", () => {
  let checked = 0;
  for (const sport of SPORTS) {
    for (const legacy of [false, true]) {
      const shape = legacy ? "stored before W2b D7 (abandoned + outcome)" : "as written today (decided)";
      it(`${sport.key}, ${shape}: under half (1 of 4) every result of hers is removed, the abandoned one included`, async () => {
        const r = await rig(sport, { atHalf: false, legacy });
        expect(await opponentPlayed(r.auth, r.stageId, r.opponent), "rig: the opponent played her").toBe(1);
        await withdrawEntrantCascade(r.auth, r.v);
        expect(await ledgerRows(r.stageId)).toEqual([["expunge", 1, 4]]);
        expect(await activeExpunge(r.abandoned.id), "the abandoned line is expunged").toBe(true);
        expect(await opponentPlayed(r.auth, r.stageId, r.opponent), "her result is out of the opponent's row").toBe(0);
        checked++;
      }, 240_000);
      it(`${sport.key}, ${shape}: at half (2 of 4) her results stand, the abandoned one included`, async () => {
        const r = await rig(sport, { atHalf: true, legacy });
        const events = async () => (await sql<{ n: number }[]>`select count(*)::int n from score_events where fixture_id = ${r.abandoned.id}`)[0]!.n;
        const before = await events();
        await withdrawEntrantCascade(r.auth, r.v);
        expect(await ledgerRows(r.stageId)).toEqual([["walkover", 2, 4]]);
        expect(await activeExpunge(r.abandoned.id)).toBe(false);
        expect(await events(), "nothing written on the abandoned line").toBe(before);
        // Today's shape reaches the table; the older stored shape is not folded by today's table at all (the refold reads the
        // status column), so only "nothing written" is the withdrawal's to answer for there.
        if (!legacy) expect(await opponentPlayed(r.auth, r.stageId, r.opponent), "the abandoned result stands").toBe(1);
        checked++;
      }, 240_000);
    }
  }
  it("anti-vacuity: every sport x shape x side was driven", () => {
    expect(checked).toBe(SPORTS.length * 2 * 2);
  });
});
