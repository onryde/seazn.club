// B5 fix wave fix round 3 (re-review 2 m5; controller ruling, owner standing "apply rec" + "fix now"): a Swiss bye is a scored
// result - a point awarded - so the refold Pair next runs to show the bye it seats keeps the table's RESULT step instead of
// rebasing it as a roster change (fix round 2's `writeSnapshot` causes). In an odd field the organiser pairs the next round
// straight after the last result, so before this the weekly digest's climber for the round just played was always erased.
// Driven through the real producers: the Swiss seated and paired by `generateStageFixtures` (the desk's Pair button), results by
// `scoreEvent`, the climber by the digest's own `assembleDigestStandings`. Expected values: the climber the digest named for the
// round BEFORE the pairing (read, never typed), and the stored step (read back).
// Single sport (generic score): the cause of a refold reads the pairing's seats, never a sport field.
import { describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { assembleDigestStandings } from "../org-posts";
import { decide, fixturesOf, pairNextSwissRound, seedStage } from "./_sheets-rig";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

async function swissAfterRoundOne(n: number) {
  const { auth } = await seedOrg("pro");
  const names = Array.from({ length: n }, (_, i) => `S${i + 1} ${Math.random().toString(36).slice(2, 6)}`);
  const { stage } = await seedStage(auth, "swiss", names, { rounds: 3 });
  const r1 = (await fixturesOf(stage.id)).filter((f) => f.round_no === 1);
  const played = r1.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
  for (const f of played) await decide(auth, f.id);
  const climber = async () =>
    (await withTenant(auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: stage.id, division_name: "Open" }]))).flatMap((s) =>
      s.climber === undefined ? [] : [s.climber],
    );
  const step = async () =>
    (await sql<{ rows: unknown; previous_rows: unknown }[]>`select rows, previous_rows from standings_snapshots where stage_id = ${stage.id} and pool_id is null`)[0]!;
  return { auth, stageId: stage.id, r1, played, climber, step };
}

describe.skipIf(!HAS_DB)("B5 fix round 3 m5 a Swiss bye counts as a result step for climbers", () => {
  it("an odd Swiss of 5: round 1 played, Pair next seats round 2 WITH a bye - the step round 1's last result opened is kept and still names a climber", async () => {
    const s = await swissAfterRoundOne(5);
    expect(s.played, "premise: round 1 plays two matches (and one bye)").toHaveLength(2);
    const before = await s.climber();
    expect(before, "premise: the digest names round 1's climber before the pairing").toHaveLength(1);
    const stepBefore = await s.step();
    await pairNextSwissRound(s.auth, s.stageId);
    const r2 = (await fixturesOf(s.stageId)).filter((f) => f.round_no === 2);
    const byes = r2.filter((f) => (f.home_entrant_id === null) !== (f.away_entrant_id === null));
    expect(byes, "premise: round 2 seats one bye").toHaveLength(1);
    const stepAfter = await s.step();
    expect(stepAfter.rows, "premise: the bye's point changed the table").not.toEqual(stepBefore.rows);
    // The bye joins the step round 1's last result opened: its start is untouched (not rebased as a roster change, not rolled
    // into a step of the bye alone).
    expect(stepAfter.previous_rows, "the step still starts before round 1's last result").toEqual(stepBefore.previous_rows);
    // differential: at dfe452820e the bye's refold rebased the step and the digest named nobody.
    const after = await s.climber();
    expect(after, "the digest still names a climber for the round just played").toHaveLength(1);
    // Named with its stored ranks across that step (read back, never typed). It is round 1's climber unless the bye moved its
    // holder further - the bye is a counted win, so its holder may be the step's biggest mover.
    const rank = (t: unknown, name: string) => (t as { entrantId: string; rank: number }[]).find((x) => x.entrantId === name)?.rank;
    const [{ id }] = await sql<{ id: string }[]>`select id from entrants where display_name = ${after[0]!.entrantName}`;
    expect([after[0]!.from, after[0]!.to]).toEqual([rank(stepAfter.previous_rows, id), rank(stepAfter.rows, id)]);
    const byeHolder = byes[0]!.home_entrant_id ?? byes[0]!.away_entrant_id;
    expect(after[0]!.entrantName === before[0]!.entrantName || id === byeHolder, "round 1's climber, or the bye's holder").toBe(true);
  });

  it("an even Swiss of 4: Pair next seats no bye - the pairing changes nothing in the table, and the step stays as it is", async () => {
    const s = await swissAfterRoundOne(4);
    expect(s.played, "premise: round 1 plays two matches, no bye").toHaveLength(2);
    const stepBefore = await s.step();
    const before = await s.climber();
    await pairNextSwissRound(s.auth, s.stageId);
    const r2 = (await fixturesOf(s.stageId)).filter((f) => f.round_no === 2);
    expect(r2.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null), "premise: round 2 seated, no bye").toHaveLength(2);
    expect(await s.step(), "no bye: the table and its step are untouched").toEqual(stepBefore);
    expect(await s.climber()).toEqual(before);
  });
});
