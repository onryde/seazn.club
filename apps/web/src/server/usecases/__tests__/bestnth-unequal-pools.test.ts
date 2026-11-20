// W5 app PR B Task 4 (ST-G3; ruling 286, RB5-U1..U8; X-UP-1..5, K19): best runners-up across UNEQUAL pools, always compared on
// the smallest supplying pool's matches - each larger pool's candidate without her results against that pool's bottom
// k = effective size - min (RB5-U1) - on a basis the proposal stores per slot and the Standings footnote states, with an
// expunged leaver counted in no pool's size (RB5-U5) and a best-Nth nobody can supply refused by name, never swallowed (K19).
//
// Every scene runs the REAL producers (`_groups-ko-scene.ts`): the groups_ko template, a real pool draw, real results through
// `scoreEvent`, real withdrawals and Reinstates through their doors, a real late entrant, the real completion. Expected seats
// and bases come from the rulebook (RB5-U1's k, RB5-U5's effective size, RB5-U7's suppliers) and generic's declared cross-group
// order (points, diff, for, lots - asserted from the engine in every scene that reads it), never from the resolver. Each scene's
// results are chosen so the right answer differs from 9.x's raw-row or k = 1 answer. Footnote copy is the public dictionary's.
// single-sport (generic): its for/against ledger makes a dropped result move a visible key; the second sport is
// pool-results-seam.test.ts's boardgame scene (same builders).
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { ApiV1Error } from "@/lib/client-v1";
import { bestNthBasisNote } from "@/lib/bestnth-basis-note";
import { completedSeedingFailedText } from "@/lib/completed-seeding-failed";
import { loadBestNthBases } from "@/server/public-site/bestnth-basis";
import { bestNthSourceOf } from "../pool-results";
import { sourcePoolKeys } from "../stage-seeding";
import { completeStage, computeSeedProposal, getSeedProposal } from "../stages";
import { declaredCrossGroup, publicT, scene, type Meeting, type Scene } from "./_groups-ko-scene";
import type { StandingsRow } from "@seazn/engine/competition";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Every meeting of a pool of `size` to the higher seed (lower place), by `score`. */
const sweepTo = (score: (size: number) => readonly [number, number]) => (size: number): Meeting[] =>
  Array.from({ length: size }, (_, w) => Array.from({ length: size - w - 1 }, (_, i): Meeting => ({ w, l: w + i + 1, score: score(size) }))).flat();

const bestNthSlots = async (s: Scene) => {
  const proposal = await getSeedProposal(s.auth, s.koId);
  expect(proposal?.status, "the completion proposed the knockout").toBe("draft");
  return proposal!.computed.qualifiers.filter((q) => q.source.group === undefined);
};
const namesOf = async (s: Scene) =>
  Object.fromEntries((await sql<{ id: string; display_name: string }[]>`select id, display_name from entrants where division_id = ${s.divId}`).map((e) => [e.id, e.display_name]));
const poolRows = async (s: Scene) =>
  (await sql<{ key: string; rows: StandingsRow[] }[]>`select p.key, ss.rows from standings_snapshots ss join pools p on p.id = ss.pool_id where ss.stage_id = ${s.srcId} order by p.key`).map(
    (r) => ({ key: r.key, rows: r.rows }),
  );
const sourceOf = (s: Scene) => withTenant(s.auth.orgId, async (tx) => bestNthSourceOf(tx, s.srcId, await sourcePoolKeys(tx, s.srcId)));

// 9 entrants into 2 pools draw 5/4 (snake: A gets the odd one); groups_ko with 3 qualifiers takes both winners and the better
// runner-up (topNPerGroup 1 + bestNth nth 2 count 1, format-templates.ts). Pool A's meetings go 1-0 to the higher seed, pool B's 3-0.
//   A2 raw: beats A3, A4, A5 1-0, loses to A1 0-1 -> 3 wins, diff +2.   Without A5 (k = 5 - 4 = 1): 2 wins, for 2 against 1, +1.
//   B2:     beats B3, B4 3-0, loses to B1 0-3 -> 2 wins, for 6 against 3, +3.
// RB5-U1 + X-UP-2: compared on 3 matches each, level on points, diff decides -> B2. On the raw rows (9.x) A2's third win seats her.
const NINE = { sport: "generic" as const, entrants: 9, poolCount: 2, qualified: 3, plan: sweepTo((size) => (size === 5 ? [1, 0] : [3, 0])) };

async function ninePremises(s: Scene) {
  expect(s.pools.map((p) => p.members.length), "9 into 2 pools draws 5/4").toEqual([5, 4]);
  expect(await declaredCrossGroup("generic"), "generic's declared cross-group order").toEqual(["points", "diff", "for", "lots"]);
  return { A: s.pools[0]!.members, B: s.pools[1]!.members };
}

describe.skipIf(!HAS_DB)("best-Nth across unequal pools (W5 app PR B Task 4)", () => {
  it("X-UP-1 9 in 2 pools: the best runner-up is chosen on the dropped basis; X-UP-2 the reduced set runs the cross-pool cascade; X-UP-3 the source table shows the basis and a re-proposal replaces it", async () => {
    const s = await scene({ ...NINE, timing: "setup" });
    const { A, B } = await ninePremises(s);
    expect((await completeStage(s.auth, s.srcId)).completed).toBe(true);
    const [slot, ...more] = await bestNthSlots(s);
    expect(more, "one best runner-up").toHaveLength(0);
    // differential: the raw rows (9.x) seat A2.
    expect(slot!.entrantId, "RB5-U1: B2 on diff once A2's result v A5 is left out").toBe(B[1]);
    expect(slot!.pool, "the engine's own pool rides the slot").toBe("B");
    expect(slot!.basis, "the comparison basis, stored per slot").toEqual({ nth: 2, matchesCounted: 3, dropped: [{ pool: "A", against: [A[4]] }], levelWith: [] });

    // X-UP-3: the page's read of it, and the footnote it prints under the source's tables (R24 pick 16 B; the copy is public.json's).
    const bases = await loadBestNthBases(s.divId);
    expect(bases.get(s.srcId), "the source stage's basis, read off the live proposal").toEqual([slot!.basis]);
    const names = await namesOf(s);
    const t = publicT("en");
    const note = bestNthBasisNote(slot!.basis!, await poolRows(s), names, new Set(), t, "en");
    expect(note).toEqual({
      line: "Best runners-up compared on 3 matches (results v 5th in Group A not counted)",
      leftOutTitle: "Results left out",
      leftOut: [`${names[A[1]!]} v ${names[A[4]!]} (5th in Group A)`, `${names[B[1]!]}: nothing left out, Group B is the smallest group`],
    });

    // A stale latest proposal shows no footnote (its source moved and nothing re-proposed it yet) ...
    await sql`update stage_seed_proposals set status = 'stale' where stage_id = ${s.koId}`;
    expect((await loadBestNthBases(s.divId)).get(s.srcId), "a stale proposal's basis is never read").toBeUndefined();
    // ... and a re-proposal writes its own slots: the footnote reads the new row.
    const again = await computeSeedProposal(s.auth, s.koId);
    expect(again.status).toBe("draft");
    const rows = await sql<{ id: string; status: string }[]>`select id, status from stage_seed_proposals where stage_id = ${s.koId} order by created_at`;
    expect(rows.map((r) => r.status), "the replaced row stays stale, the re-proposal is live").toEqual(["stale", "draft"]);
    expect((await loadBestNthBases(s.divId)).get(s.srcId), "the re-proposal's basis").toEqual([slot!.basis]);
  });

  it("X-UP-1 pools of 5 and 3: k = 2 bottom results dropped", async () => {
    // 7 into 2 pools snakes 3/4 (A B B A A B B); a late entrant joins pool B after Start (RB5-L11, catch-up lines): A 3, B 5.
    //   B's meetings go 1-0 to the higher seed (the late entrant is B's last), A's 2-0.
    //   B2 without B4 and B5 (k = 5 - 3 = 2): beats B3 1-0, loses to B1 0-1 -> 1 win, diff 0, for 1.
    //   A2: beats A3 2-0, loses to A1 0-2 -> 1 win, diff 0, for 2.   Level on points and diff, `for` decides -> A2.
    // differential: today (9.x) k = 1: B2 keeps her win over B4 and is seated on points.
    const s = await scene({ sport: "generic", entrants: 7, poolCount: 2, qualified: 3, timing: "setup", lateInto: "B", plan: sweepTo((size) => (size === 5 ? [1, 0] : [2, 0])) });
    expect(s.pools.map((p) => p.members.length), "3/4, then the late entrant into B").toEqual([3, 5]);
    expect(await declaredCrossGroup("generic")).toEqual(["points", "diff", "for", "lots"]);
    const [A, B] = [s.pools[0]!.members, s.pools[1]!.members];
    expect((await completeStage(s.auth, s.srcId)).completed).toBe(true);
    const [slot] = await bestNthSlots(s);
    expect(slot!.entrantId, "RB5-U1: k = 2, so A2 on goals for").toBe(A[1]);
    expect(slot!.basis).toEqual({ nth: 2, matchesCounted: 2, dropped: [{ pool: "B", against: [B[3], B[4]] }], levelWith: [] });
  });

  it("X-UP-1 a stored config with normaliseUnequalPools: false still compares on the dropped basis (ruling 286)", async () => {
    // differential: on 9.x it throws SEEDING_BESTNTH_UNEQUAL_POOLS (progression.ts:829).
    let flags = 0;
    const s = await scene({
      ...NINE,
      timing: "setup",
      progression: (p) => {
        const sources = (p.sources as { take: { kind: string }[] }[]).map((src) => ({
          ...src,
          take: src.take.map((r) => (r.kind === "bestNth" ? (flags++, { ...r, normaliseUnequalPools: false }) : r)),
        }));
        return { ...p, sources };
      },
    });
    expect(flags, "the stored take carries the flag off").toBe(1);
    const { A, B } = await ninePremises(s);
    expect((await completeStage(s.auth, s.srcId)).completed).toBe(true);
    const [slot] = await bestNthSlots(s);
    expect(slot!.entrantId).toBe(B[1]);
    expect(slot!.basis!.dropped).toEqual([{ pool: "A", against: [A[4]] }]);
  });

  for (const timing of ["setup", "on_complete"] as const) {
    it(`X-UP-5 an expunged bottom team drops nothing further (${timing})`, async () => {
      // A5 withdraws after Start with 0 of 4 played: RB5-W2 expunges her (every line void). Pool A's effective size is 4, so
      // k = 0 for both pools: nothing more is dropped and no footnote. A2: beats A3, A4, loses to A1 -> 2 wins, +1; B2 2 wins, +3.
      // differential: without `expunged` the engine counts her row (5 v 4), k = 1, and drops results v her - the basis then
      // names a dropped bottom row and the footnote says so.
      const s = await scene({ ...NINE, timing, leaver: (pools) => pools[0]!.members[4]! });
      const { A, B } = await ninePremises(s);
      const leaver = A[4]!;
      const [ledger] = await sql<{ policy: string }[]>`
        select payload->>'policy' as policy from division_events where division_id = ${s.divId} and type = 'table_withdrawal' and payload->>'entrant_id' = ${leaver}`;
      expect(ledger?.policy, "RB5-W2: under half played, so expunged").toBe("expunge");
      expect([...(await sourceOf(s)).expunged], "both builders' source read names her").toEqual([leaver]);
      const done = await completeStage(s.auth, s.srcId);
      expect(done.completed).toBe(true);
      if (timing === "on_complete") {
        expect(done.qualified!.entrants.slice(2), "B2 seated").toEqual([B[1]]);
        return;
      }
      const [slot] = await bestNthSlots(s);
      expect(slot!.entrantId).toBe(B[1]);
      expect(slot!.basis, "k = 0: nothing dropped").toEqual({ nth: 2, matchesCounted: 3, dropped: [], levelWith: [] });
      expect(bestNthBasisNote(slot!.basis!, await poolRows(s), await namesOf(s), new Set([leaver]), publicT("en"), "en"), "no footnote").toBeNull();
    });
  }

  it("X-UP-5 a reinstated entrant is not expunged", async () => {
    // A5 withdraws (expunged), then is Reinstated before any result: her table_withdrawal row is voided, her lines are owed again
    // and she plays them. The pool's effective size is its row count again (5 v 4): k = 1, as X-UP-1's scene.
    // differential: without the active-row filter the voided row still names her, and the engine refuses `expunged_has_results`.
    const s = await scene({ ...NINE, timing: "setup", leaver: (pools) => pools[0]!.members[4]!, reinstate: true });
    const { A, B } = await ninePremises(s);
    const kinds = await sql<{ type: string }[]>`select type from division_events where division_id = ${s.divId} and type in ('table_withdrawal', 'table_withdrawal_voided') order by seq`;
    expect(kinds.map((k) => k.type), "withdrawn, then the Reinstate voided the row").toEqual(["table_withdrawal", "table_withdrawal_voided"]);
    expect([...(await sourceOf(s)).expunged], "nobody expunged").toEqual([]);
    expect((await completeStage(s.auth, s.srcId)).completed).toBe(true);
    const [slot] = await bestNthSlots(s);
    expect(slot!.entrantId).toBe(B[1]);
    expect(slot!.basis!.dropped, "k = 1 again: results v A5 left out").toEqual([{ pool: "A", against: [A[4]] }]);
  });

  for (const timing of ["setup", "on_complete"] as const) {
    it(`K19 RB5-U7 a best-Nth no pool can supply is refused by name, never swallowed (${timing})`, async () => {
      // 6 into 2 pools of 3, 5 qualifiers: both pools' top 2 and the best 3rd (topNPerGroup 2 + bestNth nth 3 count 1). Each
      // pool's bottom seed withdraws at 0 played (expunged): effective sizes 2 and 2, so no pool has a 3rd (RB5-U7).
      // differential: on_complete swallowed the engine's STAGE_NOT_READY best_nth_no_supplier - the stage completed and the
      // knockout was never seeded, said by nobody (class 6).
      const s = await scene({ sport: "generic", entrants: 6, poolCount: 2, qualified: 5, timing, plan: sweepTo(() => [1, 0]), leaver: (pools) => pools.map((p) => p.members[2]!) });
      expect(s.pools.map((p) => p.members.length)).toEqual([3, 3]);
      const err = await completeStage(s.auth, s.srcId).then(
        () => null,
        (e: unknown) => e as { status?: number; code?: string; extra?: Record<string, unknown> },
      );
      expect(err, "the completion says the seeding failed").toMatchObject({ status: 409, code: "STAGE_COMPLETED_SEEDING_FAILED" });
      expect(err!.extra, "the cause by name, with the engine's numbers").toMatchObject({ cause: "SEEDING_BESTNTH_NO_SUPPLIER", rank: 3, available: 2 });
      const [st] = await sql<{ status: string }[]>`select status from stages where id = ${s.srcId}`;
      expect(st!.status, "the source stage did complete").toBe("complete");
      // The desk's "completed, but" line, in the reader's language (errors.json), never the engine's English.
      const desk = (key: string, vars?: Record<string, string | number>) => (key === "schedule.error.completedSeedingFailed" ? `BUT ${vars!.reason}` : key);
      const wire = new ApiV1Error("x", 409, "STAGE_COMPLETED_SEEDING_FAILED", err!.extra);
      expect(completedSeedingFailedText(wire, desk as never, "en")).toBe(
        "BUT No group has a player in place 3 to compare (the largest has 2 after withdrawals), so the best-of-place qualifiers can't be picked. Lower the number of qualifiers, or change the format.",
      );
    });
  }
});
