// B5 fix wave fix rounds 3-4 (m5; controller ruling, owner standing "apply rec", the reviewer's option a): a Swiss bye is a scored
// result - a point awarded - so the refold Pair next runs to show the bye it seats opens its OWN step, the table just before the
// bye against the table just after it, and the digest's climber for that step is the bye's holder. Whether a pass seated a bye is
// read off the rows THAT pass seated, never the stage's: an odd field a withdrawal has made even keeps round 1's bye in the stage,
// and its next pairing (no bye) stays a roster step.
// Driven through the real producers: the Swiss seated and paired by `generateStageFixtures` (the desk's Pair button), results by
// `scoreEvent`, the withdrawal by `withdrawEntrantCascade`, the climber by the digest's own `assembleDigestStandings`.
// Deterministic: every entrant carries a seed (`seedStage`), so no draw runs and both pairings are fixed - round 1 is 1v3, 2v4 and
// a bye for 5; the bye holder is read off the seated rows, never assumed. The table's own lot (its final tiebreak) is id-derived,
// so no assertion rests on how a tie inside a score group falls: ranks are read back from the stored step.
// Single sport (generic score): the cause of a refold reads the pairing's seats, never a sport field.
import { describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { assembleDigestStandings } from "../org-posts";
import { withdrawEntrantCascade } from "../withdrawal";
import { decide, fixturesOf, pairNextSwissRound, seedStage } from "./_sheets-rig";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

type Row = { entrantId: string; rank: number; points: number };
type Step = { rows: Row[]; previous_rows: Row[] | null };
const isBye = (f: { home_entrant_id: string | null; away_entrant_id: string | null }) =>
  (f.home_entrant_id === null) !== (f.away_entrant_id === null);

async function swissAfterRoundOne(n: number) {
  const { auth } = await seedOrg("pro");
  const names = Array.from({ length: n }, (_, i) => `S${i + 1} ${Math.random().toString(36).slice(2, 6)}`);
  const { stage } = await seedStage(auth, "swiss", names, { rounds: 3 });
  const seeded = await sql<{ id: string; seed: number | null }[]>`select id, seed from entrants where display_name = any(${names})`;
  expect(seeded.filter((e) => e.seed !== null), "premise: every entrant seeded, so no draw runs").toHaveLength(n);
  const r1 = (await fixturesOf(stage.id)).filter((f) => f.round_no === 1);
  const played = r1.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
  for (const f of played) await decide(auth, f.id);
  const climbers = async () =>
    (await withTenant(auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: stage.id, division_name: "Open" }]))).flatMap((s) =>
      s.climber === undefined || s.climber === null ? [] : [s.climber],
    );
  const step = async () =>
    (await sql<Step[]>`select rows, previous_rows from standings_snapshots where stage_id = ${stage.id} and pool_id is null`)[0]!;
  const round = async (no: number) => (await fixturesOf(stage.id)).filter((f) => f.round_no === no);
  return { auth, stageId: stage.id, r1, played, climbers, step, round };
}

describe.skipIf(!HAS_DB)("B5 fix round 4 m5 a Swiss bye opens its own climber step", () => {
  it("an odd Swiss of 5: Pair next seats round 2 WITH a bye - the step is the table just before the bye against just after it, and the digest names the bye's holder", async () => {
    const s = await swissAfterRoundOne(5);
    expect(s.played, "premise: round 1 plays two matches").toHaveLength(2);
    expect(s.r1.filter(isBye), "premise: and seats one bye").toHaveLength(1);
    const before = await s.step();
    await pairNextSwissRound(s.auth, s.stageId);
    const byes = (await s.round(2)).filter(isBye);
    expect(byes, "premise: round 2 seats one bye").toHaveLength(1);
    const holder = byes[0]!.home_entrant_id ?? byes[0]!.away_entrant_id!;
    const after = await s.step();
    expect(after.rows, "premise: the bye's point changed the table").not.toEqual(before.rows);
    // Its own step: it starts at the table round 1 left (not rebased as a roster change, not extending round 1's step).
    expect(after.previous_rows, "the step starts just before the bye").toEqual(before.rows);
    const rank = (t: Row[] | null, id: string) => t?.find((r) => r.entrantId === id)?.rank;
    const pts = (t: Row[] | null, id: string) => t?.find((r) => r.entrantId === id)?.points;
    expect(pts(after.rows, holder)! > pts(after.previous_rows, holder)!, "premise: the bye scored its holder").toBe(true);
    const named = await s.climbers();
    expect(named, "the digest names one climber for the bye's step").toHaveLength(1);
    const [{ id }] = await sql<{ id: string }[]>`select id from entrants where display_name = ${named[0]!.entrantName}`;
    expect(id, "and it is the bye's holder").toBe(holder);
    // With its stored ranks across that step (read back, never typed).
    expect([named[0]!.from, named[0]!.to]).toEqual([rank(after.previous_rows, holder), rank(after.rows, holder)]);
  });

  it("an odd Swiss of 5 a withdrawal has made even: round 1's bye is still in the stage, Pair next seats round 2 with NO bye - a roster step", async () => {
    const s = await swissAfterRoundOne(5);
    expect(s.r1.filter(isBye), "premise: round 1's bye is in the stage").toHaveLength(1);
    // A round-1 loser leaves: four are left to pair.
    const loser = s.played[0]!.away_entrant_id!;
    await withdrawEntrantCascade(s.auth, loser);
    const before = await s.step();
    await pairNextSwissRound(s.auth, s.stageId);
    const r2 = await s.round(2);
    expect(r2.filter(isBye), "premise: round 2 seats no bye").toHaveLength(0);
    expect(r2.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null), "premise: round 2 seats two boards").toHaveLength(2);
    const after = await s.step();
    // Non-vacuity: the pairing's refold moves the table (the withdrawal is folded in), so its cause decides the step - a step
    // rolled as a result here named the withdrawn entrant a climber.
    expect(after.rows, "premise: the pairing's refold changed the table").not.toEqual(before.rows);
    expect(after.previous_rows, "a roster step: rebased onto the table it wrote").toEqual(after.rows);
    expect(await s.climbers(), "so the digest names no climber").toEqual([]);
  });

  it("an even Swiss of 4: Pair next seats no bye - the pairing changes nothing in the table, and the step stays as it is", async () => {
    const s = await swissAfterRoundOne(4);
    expect(s.played, "premise: round 1 plays two matches, no bye").toHaveLength(2);
    const before = await s.step();
    const named = await s.climbers();
    await pairNextSwissRound(s.auth, s.stageId);
    const r2 = await s.round(2);
    expect(r2.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null), "premise: round 2 seated, no bye").toHaveLength(2);
    expect(await s.step(), "no bye: the table and its step are untouched").toEqual(before);
    expect(await s.climbers()).toEqual(named);
  });
});
