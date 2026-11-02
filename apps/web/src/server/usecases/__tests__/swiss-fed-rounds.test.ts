// W3 T15 carry (batch-4 re-review n2): "Add a round" and "Finish the Swiss now" on a Swiss FED by an earlier stage.
// Batch-4 ruling (3) offers both in More for ANY running Swiss — a root Swiss and a fed one alike — so each is proved end
// to end through the usecase on a fed Swiss: a league of SIX whose top FOUR qualify (`timing: "on_complete"`, the real
// producer of `config.qualified`). The field is therefore the four qualifiers, not the division's six, and every expected
// count below is the rulebook's over FOUR — so a reader that took the division's field would answer differently:
//   - a round of a Swiss of n seats ⌊n/2⌋ boards (rulebook §3.1): 2 for four, 3 for six;
//   - a Swiss of n plays at most n − 1 rounds without a rematch (the hard max, SW-H2): 3 for four, 5 for six.
// Sports: badminton (the house racket sport) and boardgame (chess), as every T13/T15 Swiss case.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, createStages, generateStageFixtures } from "../stages";
import { addSwissRound, finishSwissNow, listSwissRoundControls } from "../swiss-rounds-admin";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const SPORTS = [
  { sport: "badminton", variant: "bwf" },
  { sport: "boardgame", variant: "classical" },
] as const;
type Sport = (typeof SPORTS)[number];

/** The rulebook's numbers over the FED field (four qualifiers), typed here — never read off the code under test. */
const FIELD = 4;
const DIVISION = 6;
const BOARDS_PER_ROUND = Math.floor(FIELD / 2);
const HARD_MAX = FIELD - 1;

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}
const rowsOf = (stageId: string) =>
  sql<Row[]>`select id, ext_key, round_no, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
const seatedBoards = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r && !isBye(f) && f.home_entrant_id && f.away_entrant_id);
const roundsIn = (rows: readonly Row[]) => [...new Set(rows.map((f) => f.round_no))].sort((a, b) => a - b);

async function homeWins(auth: AuthCtx, sport: Sport, f: Row): Promise<void> {
  let seq = 0;
  await scoreEvent(auth, f.id, { expected_seq: seq++, type: "core.start", payload: {} });
  if (sport.sport === "boardgame") {
    await scoreEvent(auth, f.id, { expected_seq: seq, type: "boardgame.result", payload: { winner: f.home_entrant_id, method: "resign" } });
  } else {
    await scoreEvent(auth, f.id, { expected_seq: seq++, type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    await scoreEvent(auth, f.id, { expected_seq: seq, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
  }
}

/** A league of six, all played and completed: its top four are seeded into the Swiss (`config.qualified`), which is
 *  drawn; round 1 is then paired (if the draw did not) and played. */
async function fedSwiss(sport: Sport, rounds: number) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Fed " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: sport.sport, variant_key: sport.variant, config: {} });
  const kind = (builtinModules.find((m) => m.key === sport.sport)!.entrantModel?.defaultKind ?? "individual") as "individual" | "pair" | "team";
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: DIVISION }, (_, i) => ({
      kind,
      display_name: `F${i + 1}`,
      seed: i + 1,
      members: Array.from({ length: Math.min(2, entrantKindCap(kind)) }, (_, m) => ({
        new_person: { full_name: `F${i + 1} m${m + 1} ${randomUUID().slice(0, 4)}` },
        is_captain: false,
        roles: [],
      })),
    })),
  );
  const [league] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
  const [swiss] = await createStages(auth, division.id, {
    seq: 2,
    kind: "swiss",
    name: "Swiss",
    config: { rounds },
    progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: FIELD }] }], placement: "rank_order", timing: "on_complete" },
  });
  await startDivision(auth, division.id);
  if ((await rowsOf(league!.id)).length === 0) await generateStageFixtures(auth, league!.id);
  const games = (await rowsOf(league!.id)).filter((f) => f.home_entrant_id && f.away_entrant_id);
  expect(games, "premise: a round robin of six").toHaveLength((DIVISION * (DIVISION - 1)) / 2);
  for (const f of games) await homeWins(auth, sport, f);
  expect(await completeStage(auth, league!.id, { publish: false })).toMatchObject({ completed: true });
  const [s] = await sql<{ config: { qualified?: string[] } }[]>`select config from stages where id = ${swiss!.id}`;
  expect(s!.config.qualified, "premise: the Swiss is FED — its field is the league's top four").toHaveLength(FIELD);
  if (seatedBoards(await rowsOf(swiss!.id), 1).length === 0) await generateStageFixtures(auth, swiss!.id);
  const r1 = seatedBoards(await rowsOf(swiss!.id), 1);
  expect(r1, "premise: round 1 seats the four qualifiers on ⌊4/2⌋ boards").toHaveLength(BOARDS_PER_ROUND);
  expect(new Set(r1.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))).toEqual(new Set(s!.config.qualified));
  for (const f of r1) await homeWins(auth, sport, f);
  return { auth, divisionId: division.id, swissId: swiss!.id };
}

describe.runIf(HAS_DB)("n2 (batch-4 ruling 3): Add a round and Finish on a Swiss FED by an earlier stage", () => {
  for (const sport of SPORTS) {
    it(`Add a round: the desk offers it, it mints round 3 over the four qualifiers (⌊4/2⌋ boards), and a 4th is refused above the hard max of 3 — 409, Finish being the way out (${sport.sport})`, async () => {
      const rig = await fedSwiss(sport, 2);
      const desk = (await listSwissRoundControls(rig.auth, rig.divisionId))[rig.swissId]!;
      expect(desk.addRound, "offered on a fed Swiss, judged over its own field").toEqual({ canAddRound: true, refusal: null, field: FIELD, hardMax: HARD_MAX });
      expect(await addSwissRound(rig.auth, rig.swissId)).toEqual({ rounds: 3, shells_added: BOARDS_PER_ROUND });
      const rows = await rowsOf(rig.swissId);
      expect(roundsIn(rows)).toEqual([1, 2, 3]);
      expect(rows.filter((f) => f.round_no === 3 && !isBye(f)), "round 3's shells").toHaveLength(BOARDS_PER_ROUND);
      // The positive pair's other side: past the hard max of the FED field, refused with its numbers. Round 1 is decided,
      // so Finish is the other way out — resolvable, hence 409 (the house rule: 422 only when nothing else resolves it).
      await expect(addSwissRound(rig.auth, rig.swissId)).rejects.toMatchObject({
        status: 409,
        code: "SWISS_ROUNDS_ABOVE_MAX",
        extra: { field: FIELD, hardMax: HARD_MAX, canFinish: true },
      });
      expect(roundsIn(await rowsOf(rig.swissId)), "the refusal wrote nothing").toEqual([1, 2, 3]);
    }, 300_000);

    it(`Finish the Swiss now: the desk offers it after round 1, and it ends the Swiss there — rounds 2 and 3's ⌊4/2⌋ shells each go, the stage completes (${sport.sport})`, async () => {
      const rig = await fedSwiss(sport, 3);
      const desk = (await listSwissRoundControls(rig.auth, rig.divisionId))[rig.swissId]!;
      expect(desk.finish).toMatchObject({ canFinish: true, refusal: null, finishedAfter: 1 });
      const going = (await rowsOf(rig.swissId)).filter((f) => f.round_no > 1);
      expect(going, "premise: rounds 2 and 3 are unplayed shells, ⌊4/2⌋ each").toHaveLength(2 * BOARDS_PER_ROUND);
      expect(await finishSwissNow(rig.auth, rig.swissId)).toMatchObject({ finished_after: 1, shells_removed: going.length, completed: true });
      expect(roundsIn(await rowsOf(rig.swissId))).toEqual([1]);
      const [stage] = await sql<{ status: string; config: { rounds?: number } }[]>`select status, config from stages where id = ${rig.swissId}`;
      expect([stage!.status, stage!.config.rounds]).toEqual(["complete", 1]);
    }, 300_000);
  }
});
