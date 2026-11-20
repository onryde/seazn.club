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
import { bestNthBasisNote, stageBasisNotes } from "@/lib/bestnth-basis-note";
import { completedSeedingFailedText } from "@/lib/completed-seeding-failed";
import { loadBestNthBases } from "@/server/public-site/bestnth-basis";
import { bestNthSourceOf } from "../pool-results";
import { sourcePoolKeys } from "../stage-seeding";
import { completeStage, computeSeedProposal, createStages, generateStageFixtures, getSeedProposal } from "../stages";
import { declaredCrossGroup, post, publicT, scene, type Meeting, type Scene } from "./_groups-ko-scene";
import { shuffle } from "@seazn/engine/core";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { seedOrg } from "./_seed";
import { lotSeed, type StandingsRow } from "@seazn/engine/competition";

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
    expect(bases.get(s.srcId)?.bases, "the source stage's basis, read off the live proposal").toEqual([slot!.basis]);
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
    expect((await loadBestNthBases(s.divId)).get(s.srcId)?.bases, "the re-proposal's basis").toEqual([slot!.basis]);
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
      if (timing === "on_complete") {
        // Task 5 part 3 (owed item 1): the on_complete knockout is drawn across the pools, and B2 - the best runner-up - would meet
        // B1 in the 4-draw with no way out (RB5-D10, X-PD-4, owner 288). The refusal names pool B supplying two of the three seats:
        // B2 is the runner-up the engine chose, read by the draw's own rule.
        const err = await completeStage(s.auth, s.srcId).then(
          () => null,
          (e: unknown) => e as { code?: string; extra?: Record<string, unknown> },
        );
        expect(err?.code, "completed, but the seeding is refused by name").toBe("STAGE_COMPLETED_SEEDING_FAILED");
        expect(err?.extra, "B2 is the best runner-up: pool B supplies two seats").toMatchObject({ cause: "SEEDING_POOL_SEPARATION_IMPOSSIBLE", pool: "B", count: 2, entrants: 3, shape: "single_elim" });
        return;
      }
      const done = await completeStage(s.auth, s.srcId);
      expect(done.completed).toBe(true);
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

  it("C9 X-UP-4 a walkover leaver ranks last in her pool (RB5-W1), so the drop takes her results first", async () => {
    // 9 into 2 (A 5, B 4). A1 - the TOP seed - plays her first two meetings (beats A2, A3), then withdraws: half of her four
    // lines played, so RB5-W2 awards the other two as walkovers (to A4, A5) and she is NOT expunged (effective size stays 5,
    // k = 1). By results she has 2 wins and A5 has 1 (a walkover win), so a results-only order would put A5 at the bottom.
    // RB5-W1 ranks the leaver LAST: the drop is her result. // differential: a cascade-order pick drops A5.
    const s = await scene({ ...NINE, timing: "setup", leaver: (pools) => pools[0]!.members[0]!, leaverPlays: 2 });
    const { A } = await ninePremises(s);
    const leaver = A[0]!;
    const [ledger] = await sql<{ policy: string }[]>`
      select payload->>'policy' as policy from division_events where division_id = ${s.divId} and type = 'table_withdrawal' and payload->>'entrant_id' = ${leaver}`;
    expect(ledger?.policy, "RB5-W2: half played, so her remaining lines are awarded").toBe("walkover");
    expect([...(await sourceOf(s)).expunged], "a walkover leaver is no expunged row").toEqual([]);
    expect((await completeStage(s.auth, s.srcId)).completed).toBe(true);
    const [slot] = await bestNthSlots(s);
    expect(slot!.basis!.dropped, "k = 5 - 4 = 1: the results left out are those against the leaver").toEqual([{ pool: "A", against: [leaver] }]);
    expect(slot!.basis!.matchesCounted).toBe(3);
    const tables = await poolRows(s);
    const a = [...tables.find((t) => t.key === "A")!.rows].sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
    const wins = (id: string) => a.find((r) => r.entrantId === id)!.won;
    expect(wins(leaver), "the premise: by results she is above A5").toBeGreaterThan(wins(A[4]!));
    expect(a.map((r) => r.entrantId).at(-1), "RB5-W1: the leaver's row is pool A's last on the table too").toBe(leaver);
  });

  it("X-UP-4 the dropped bottom row is the pool's own cascade's last, stored lots included", async () => {
    // 9 into 2 (A 5, B 4). A4 and A5 lose every other meeting 0-1 and draw each other 0-0: level on every key of the pool's own
    // cascade, so a stored lots draw orders them. The stage's rngSeed is chosen from the ENGINE's own lots rule (lotSeed over the
    // sorted pair, then shuffle) so the draw puts A4 - the higher seed, listed first - LAST. k = 1 for A: the drop is A4.
    // Then, once pool A is played out and the draw STORED, the stage's rngSeed moves to one whose fresh draw would put A5 last;
    // pool B's results refold the stage after it, and the stored draw still decides (RB5-U4 "stored lots included").
    // differential: a row-order (seed / listed) pick, or a fresh draw that ignores the stored one, drops A5.
    let pair: string[] = [];
    let moved = false;
    const plan = (size: number): Meeting[] =>
      sweepTo((n) => (n === 5 ? [1, 0] : [3, 0]))(size).map((m) => (size === 5 && m.w === 3 && m.l === 4 ? { ...m, score: [0, 0] as const } : m));
    const s = await scene({
      sport: "generic", entrants: 9, poolCount: 2, qualified: 3, timing: "setup", plan,
      rngSeed: (pools) => {
        pair = [pools[0]!.members[3]!, pools[0]!.members[4]!];
        const ids = [...pair].sort();
        for (let rng = 1; rng < 500; rng++) if (shuffle(lotSeed(rng, ids), ids).at(-1) === pair[0]) return rng;
        throw new Error("no rngSeed under 500 draws A4 last");
      },
      afterPool: async (key, _pools, srcId) => {
        if (key !== "A") return;
        const ids = [...pair].sort();
        let other = 0;
        for (let rng = 1; rng < 500 && other === 0; rng++) if (shuffle(lotSeed(rng, ids), ids).at(-1) === pair[1]) other = rng;
        expect(other, "an rngSeed whose fresh draw puts A5 last").toBeGreaterThan(0);
        await sql`update stages set config = config || ${sql.json({ rngSeed: other } as never)} where id = ${srcId}`;
        moved = true;
      },
    });
    const { A } = await ninePremises(s);
    expect(pair, "the level pair is A4, A5").toEqual([A[3], A[4]]);
    expect(moved, "the rngSeed moved before pool B was played").toBe(true);
    expect((await completeStage(s.auth, s.srcId)).completed).toBe(true);
    const [pa] = await sql<{ id: string }[]>`select id from pools where stage_id = ${s.srcId} and key = 'A'`;
    const draws = await sql<{ drawn_order: string[] }[]>`
      select drawn_order from stage_lots_draws where stage_id = ${s.srcId} and pool_id = ${pa!.id} order by drawn_at desc, id desc`;
    const stored = draws.find((d) => [...d.drawn_order].sort().join() === [...pair].sort().join());
    expect(stored?.drawn_order, "the pool's stored lots draw for the level pair puts A4 last").toEqual([A[4], A[3]]);
    const a = [...(await poolRows(s)).find((t) => t.key === "A")!.rows].sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
    expect(a.slice(3).map((r) => r.entrantId), "the table reads the draw").toEqual([A[4], A[3]]);
    const [slot] = await bestNthSlots(s);
    expect(slot!.basis!.dropped, "RB5-U4: the stored lots' last is the bottom row").toEqual([{ pool: "A", against: [A[3]] }]);
  });

  it("C4 a second-tier group fed with carry full: the basis line says the matches compared IN the stage, not the carried played", async () => {
    // group (9 into 2: 5/4) -> group (on_complete, carry "full": each qualifier opens with her first-tier played - 4 from A, 3
    // from B) -> knockout (setup, the winners and both best runners-up). The tier-2 group takes 7 (top 3 per pool + the best
    // 4th), drawn 3/4: k = 1 for the larger pool, so each runner-up is compared on (3 - 1) x 1 = 2 tier-2 matches (RB5-U1).
    // The engine's `matchesCounted` is the largest `played` of a compared row, the carried opening included (B2-B4 m3), so it
    // reads 2 + 3 or 2 + 4. differential: the footnote printed `matchesCounted` ("compared on 6 matches").
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "C4", visibility: "private", branding: {} });
    const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
      select key, config from sport_variants where sport_key = 'generic' and is_system order by key limit 1`;
    const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: variant!.key, config: variant!.config } as never);
    await createEntrants(auth, div.id, Array.from({ length: 9 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
    const [t1, t2, ko] = await createStages(auth, div.id, [
      { seq: 1, kind: "group", name: "Tier 1", config: { legs: 1, pools: { count: 2 } } },
      { seq: 2, kind: "group", name: "Tier 2", config: { legs: 1, pools: { count: 2 } }, progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 3 }, { kind: "bestNth", nth: 4, count: 1 }] }], placement: "rank_order", timing: "on_complete", carry: "full" } },
      { seq: 3, kind: "knockout", name: "Knockout", config: { thirdPlace: false }, progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 2 }] }], placement: "rank_order", timing: "setup" } },
    ] as never);
    await generateStageFixtures(auth, ko!.id);
    await generateStageFixtures(auth, t1!.id);
    await startDivision(auth, div.id);
    const seedOf = new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${div.id}`).map((e) => [e.id, e.seed]));
    // every meeting of a stage to the better first-tier seed, 1-0
    const playOut = async (stageId: string) => {
      const fx = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stageId}`;
      expect(fx.length, "the stage has lines").toBeGreaterThan(0);
      for (const f of fx) {
        await post(auth, f.id, "core.start");
        const homeWins = seedOf.get(f.home_entrant_id)! < seedOf.get(f.away_entrant_id)!;
        await post(auth, f.id, "generic.result", homeWins ? { p1Score: 1, p2Score: 0 } : { p1Score: 0, p2Score: 1 });
      }
    };
    await playOut(t1!.id);
    expect((await completeStage(auth, t1!.id)).completed).toBe(true);
    const [cfg] = await sql<{ config: { carry_deltas?: { entrantId: string; played: number }[]; qualified?: string[] } }[]>`select config from stages where id = ${t2!.id}`;
    const openings = cfg!.config.carry_deltas ?? [];
    expect(openings.length, "the carry opened every tier-2 row").toBe(7);
    expect(new Set(openings.map((d) => d.played)), "carry full: first-tier played 4 (pool of 5) and 3 (pool of 4)").toEqual(new Set([4, 3]));
    await generateStageFixtures(auth, t2!.id);
    const tierPools = await sql<{ key: string; n: number }[]>`
      select p.key, count(distinct e)::int as n from pools p join fixtures f on f.pool_id = p.id, unnest(array[f.home_entrant_id, f.away_entrant_id]) e
       where p.stage_id = ${t2!.id} group by p.key order by p.key`;
    expect(tierPools.map((p) => p.n).sort(), "7 into 2: one pool of 3, one of 4").toEqual([3, 4]);
    await playOut(t2!.id);
    expect((await completeStage(auth, t2!.id)).completed).toBe(true);
    const proposal = await getSeedProposal(auth, ko!.id);
    const slots = proposal!.computed.qualifiers.filter((q) => q.basis !== undefined);
    expect(slots, "both best runners-up").toHaveLength(2);
    const basis = slots[0]!.basis!;
    const larger = tierPools.find((p) => p.n === 4)!.key;
    expect(basis.dropped.map((d) => d.pool), "k = 1 for the larger tier-2 pool").toEqual([larger]);
    const compared = (3 - 1) * 1;
    expect(basis.matchesCounted, "the premise: the engine's count includes the carried opening").toBeGreaterThan(compared);

    const bases = (await loadBestNthBases(div.id)).get(t2!.id);
    expect(bases?.bases, "the tier-2 stage's basis").toEqual([basis]);
    const rows = (await sql<{ key: string; rows: StandingsRow[] }[]>`select p.key, ss.rows from standings_snapshots ss join pools p on p.id = ss.pool_id where ss.stage_id = ${t2!.id} order by p.key`).map((r) => ({ key: r.key, rows: r.rows }));
    const names = Object.fromEntries((await sql<{ id: string; display_name: string }[]>`select id, display_name from entrants where division_id = ${div.id}`).map((e) => [e.id, e.display_name]));
    const [note] = stageBasisNotes(t2!.id, bases, rows, names, [], publicT("en"), "en");
    expect(note!.line, "compared on the tier-2 matches, never the carried played").toMatch(new RegExp(`^Best runners-up compared on ${compared} matches \\(`));
  });
});
