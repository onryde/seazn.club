// A Swiss withdrawal never expunges (owner ruling 2026-09-24, "case 2",
// option A). Found by the Saturday probe (`swiss-walkover-saturday.test.ts`
// S2): withdrawing a Swiss entrant with under half its scheduled games played
// took the table policy's EXPUNGE branch, which `core.abandon`ed its paired
// board — no outcome, so the opponent got nothing — and then stranded the
// division: Pair next refused ("undecided fixtures"), Unpair refused ("played
// results"), and Forfeit refused the abandoned board ("match already over").
//
// The ruling, Swiss only:
//   - results already played stand, earlier walkovers included;
//   - every seated, unplayed board of theirs becomes a walkover WIN for the
//     opponent through `core.forfeit` — the path the award policy already uses;
//   - unseated future rounds are untouched (Pair next simply leaves them out).
// League and group keep the under-50% expunge (withdrawal.test.ts pins that).
//
// Everything here goes through the usecases the buttons call: Start, Generate
// / Pair next, Forfeit and the quick result (`scoreEvent`), the ad-hoc fixture
// (`addFixture`) and Withdraw (`withdrawEntrantCascade`).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState } from "../fixtures";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { addFixture, createStages, generateStageFixtures } from "../stages";
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
  outcome: { kind?: string; winner?: string; method?: string } | null;
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

/** Four individuals S1..S4 in a 2-round badminton swiss, started, round 1
 *  paired. Round 1 folds: S1 v S3, S2 v S4. */
async function pairedRoundOne(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss withdraw " + randomUUID().slice(0, 6),
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
  expect(shape(rig, round(await fixturesOf(rig.stageId), 1))).toEqual(["sw-r1-b1: S1 v S3", "sw-r1-b2: S2 v S4"]);
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

/** The Forfeit button: `by` is the side at fault. */
async function forfeitBy(auth: AuthCtx, fixtureId: string, by: string): Promise<void> {
  const state = await getFixtureState(auth, fixtureId);
  await scoreEvent(auth, fixtureId, {
    expected_seq: state.last_seq,
    type: "core.forfeit",
    payload: { by, reason: "walkover" },
  });
}

/** The scorer's quick result: the HOME side wins 21-10, 21-10. */
async function homeWins(auth: AuthCtx, fixtureId: string): Promise<void> {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  for (const seq of [1, 2]) {
    await scoreEvent(auth, fixtureId, {
      expected_seq: seq,
      type: "badminton.game.summary",
      payload: { home: 21, away: 10 },
    });
  }
}

describe.runIf(HAS_DB)("swiss withdrawal — never expunge, walk the paired boards over", () => {
  it("nothing played yet (the stranded Saturday shape): the paired board walks over, later rounds are untouched, and Pair next goes on without them", async () => {
    const rig = await pairedRoundOne();
    const S2 = rig.id("S2");
    const S4 = rig.id("S4");
    const r1 = round(await fixturesOf(rig.stageId), 1);
    const theirs = boardOf(r1, 1, S2, S4);
    const other = boardOf(r1, 1, rig.id("S1"), rig.id("S3"));

    // 0 played of 1 scheduled: a league would expunge here.
    const out = await withdrawEntrantCascade(rig.auth, S4);
    expect(out).toEqual({
      entrant_id: S4,
      status: "withdrawn",
      policy: "walkover",
      walkovers: 1,
      voided: 0,
      skipped_finalized: 0,
    });

    const after = await fixturesOf(rig.stageId);
    const walkedOver = after.find((f) => f.id === theirs.id)!;
    expect(walkedOver.status, "a walkover, not an abandoned board").toBe("forfeited");
    expect(walkedOver.outcome).toEqual({ kind: "award", winner: S2, method: "entrant withdrew" });
    // The other board and the unseated round 2 are nobody's business here.
    expect(after.find((f) => f.id === other.id)).toMatchObject({ status: "scheduled", outcome: null });
    expect(round(after, 2).map((f) => [f.home_entrant_id, f.away_entrant_id, f.status])).toEqual([
      [null, null, "scheduled"],
      [null, null, "scheduled"],
    ]);

    await homeWins(rig.auth, other.id);
    // The division is NOT stranded: Pair next seats round 2 for the three left.
    const next = await generateStageFixtures(rig.auth, rig.stageId);
    expect(next.reshaped).toEqual({ matches_added: 0, matches_removed: 1, byes_added: 1, byes_removed: 0 });
    const r2 = round(await fixturesOf(rig.stageId), 2);
    expect(shape(rig, r2)).toEqual(["sw-r2-b1: S1 v S2", "sw-r2-bye: S3 bye"]);
    expect(r2.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])).not.toContain(S4);
  });

  it("under half played WITH a result (an earlier walkover win): that result stands and every paired board walks over", async () => {
    const rig = await pairedRoundOne();
    const [S1, S2, S3, S4] = ["S1", "S2", "S3", "S4"].map(rig.id);
    const r1 = round(await fixturesOf(rig.stageId), 1);
    const earlier = boardOf(r1, 1, S2!, S4!);
    await forfeitBy(rig.auth, earlier.id, S2!); // S4 wins round 1 by walkover
    await homeWins(rig.auth, boardOf(r1, 1, S1!, S3!).id);

    await generateStageFixtures(rig.auth, rig.stageId); // Pair round 2
    const r2 = round(await fixturesOf(rig.stageId), 2);
    expect(shape(rig, r2)).toEqual(["sw-r2-b1: S1 v S4", "sw-r2-b2: S2 v S3"]);
    // An ad-hoc board puts S4 at 1 played of 3 scheduled — under half.
    const { fixture_id: adHoc } = await addFixture(rig.auth, rig.stageId, { home_entrant_id: S4!, away_entrant_id: S3! });

    const out = await withdrawEntrantCascade(rig.auth, S4!);
    expect(out).toMatchObject({ policy: "walkover", walkovers: 2, voided: 0, skipped_finalized: 0 });

    const after = await fixturesOf(rig.stageId);
    // The earlier walkover S4 WON stands, untouched.
    expect(after.find((f) => f.id === earlier.id)).toMatchObject({
      status: "forfeited",
      outcome: { kind: "award", winner: S4, method: "walkover" },
    });
    // Both boards S4 was still owed go to the opponents.
    expect(after.find((f) => f.id === boardOf(r2, 2, S1!, S4!).id)).toMatchObject({
      status: "forfeited",
      outcome: { kind: "award", winner: S1, method: "entrant withdrew" },
    });
    expect(after.find((f) => f.id === adHoc)).toMatchObject({
      status: "forfeited",
      outcome: { kind: "award", winner: S3, method: "entrant withdrew" },
    });
    // Nothing of S4's was abandoned.
    expect(after.filter((f) => f.status === "abandoned")).toEqual([]);
  });
});
