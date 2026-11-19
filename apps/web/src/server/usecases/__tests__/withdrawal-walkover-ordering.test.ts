// W5 app PR A, B4 fix wave (C1): a withdrawal cascade's OWN walkover must not complete the table before she has left it.
//
// The cascade settles her open lines one `scoreEvent` at a time and writes her departed status LAST. A walkover that was the
// stage's last open line used to run that write's auto-advance (`onDecided` -> `maybeAutoAdvance`, and the quick match's own
// advance) at once, so the league completed while she was still in the field: `stage_completed.places` ranked her by her
// results, and the on_complete cut seated her in the next stage. The cascade's writes now hold their advance back and the end of
// the cascade asks it once per stage it wrote to, after her status write (the shape of a Reinstate's reverse, B3).
//
// differential (probe P-A, c959c9d428): with `auto_progress` ON the league completed inside the cascade with her at rank 1 and the
// final was drawn "P3 (withdrawn) v P1"; with it OFF the final was P1 v P2.
//
// Expected values from the rulebook: RB5-W3 (2 of 3 played: half or more, so her results stand and her open line walks over),
// RB5-W1 (a withdrawn entrant is ranked last), RB5-K1 (she leaves the knockout cut: the next eligible takes the seat).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { completeStage, createStages } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Two sports from the engine registry: the ordering is sport-blind, the second guards a sport-specific status path. */
const SPORTS = ["badminton", "tennis"].map((key) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`registry has no ${key}`);
  return { key, variant: Object.keys(m.variants)[0]! };
});

type Line = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
const linesOf = (stageId: string) =>
  sql<Line[]>`select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
const between = (lines: Line[], a: string, b: string) =>
  lines.find((l) => (l.home_entrant_id === a && l.away_entrant_id === b) || (l.home_entrant_id === b && l.away_entrant_id === a))!;

async function division(sport: { key: string; variant: string }, n: number, stages: unknown, autoProgress: boolean) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "B4 C1 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport.key, variant_key: sport.variant, config: {} });
  const es = await createEntrants(auth, d.id, Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
  const st = await createStages(auth, d.id, stages as never);
  await sql`update divisions set auto_progress = ${autoProgress} where id = ${d.id}`;
  return { auth, d, ids: es.map((e) => e.id), stageIds: [...st].sort((a, b) => a.seq - b.seq).map((s) => s.id) };
}

/** The `stage_completed` rows the division ledger holds for `stageId`, each as its places (entrant id by rank). */
async function completedPlaces(divisionId: string, stageId: string): Promise<{ entrantId: string; rank: number }[][]> {
  const rows = await sql<{ payload: { stageId?: string; places?: { entrantId: string; rank: number }[] } }[]>`
    select payload from division_events where division_id = ${divisionId} and type = 'stage_completed' order by seq`;
  return rows.filter((r) => r.payload.stageId === stageId).map((r) => r.payload.places ?? []);
}

describe.runIf(HAS_DB)("C1: a withdrawal's own walkover holds auto-advance until she has left (RB5-W1, RB5-W3, RB5-K1)", () => {
  let checked = 0;
  const RUNS = SPORTS.flatMap((sport) => [false, true].map((autoProgress) => ({ sport, autoProgress })));

  for (const { sport, autoProgress } of RUNS) {
    it(`${sport.key}, auto_progress ${autoProgress ? "on" : "off"}: her walkover on the league's LAST open line - the final seats P1 v P2, never her, and the completed league ranks her last`, async () => {
      const cut = { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "on_complete" };
      const r = await division(sport, 4, [
        { seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null },
        { seq: 2, kind: "knockout", name: "Final", config: {}, progression: cut },
      ], autoProgress);
      await startDivision(r.auth, r.d.id);
      const [p1, p2, v, p4] = r.ids as [string, string, string, string];
      const league = await linesOf(r.stageIds[0]!);
      expect(league, "premise: a league of 4, one leg").toHaveLength(6);
      // P3 beats P1 and P2 (she tops the table by results); P1 beats P2 and P4; P2 beats P4. Her line v P4 is the last open one.
      for (const [w, l] of [[v, p1], [v, p2], [p1, p2], [p1, p4], [p2, p4]] as const) {
        await post(r.auth, between(league, w, l).id, "core.forfeit", { by: l, reason: "walkover" });
      }
      const out = await withdrawEntrantCascade(r.auth, v);
      expect({ policy: out.policy, walkovers: out.walkovers }, "RB5-W3: 2 of 3 played, her open line walks over").toEqual({ policy: "walkover", walkovers: 1 });
      const [stage] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageIds[0]!}`;
      // The flag decides only WHETHER the finished league completes on its own; who it ranks is the same either way.
      expect(stage!.status, "auto_progress decides whether the league completed by itself").toBe(autoProgress ? "complete" : "active");
      if (!autoProgress) await completeStage(r.auth, r.stageIds[0]!, { publish: false });

      const places = await completedPlaces(r.d.id, r.stageIds[0]!);
      expect(places, "one stage_completed for the league").toHaveLength(1);
      const last = places[0]!.reduce((m, p) => Math.max(m, p.rank), 0);
      // differential: today, auto_progress on, she is rank 1 here.
      expect(places[0]!.find((p) => p.entrantId === v)?.rank, "RB5-W1: the completed league ranks her last").toBe(last);
      expect(places[0]!.filter((p) => p.rank === last).map((p) => p.entrantId), "and alone").toEqual([v]);

      const final = await linesOf(r.stageIds[1]!);
      expect(final, "one final").toHaveLength(1);
      // differential: today, auto_progress on, "P3 (withdrawn) v P1".
      expect([final[0]!.home_entrant_id, final[0]!.away_entrant_id].sort(), "RB5-K1: the next eligible (P2) takes her seat").toEqual([p1, p2].sort());
      checked++;
    }, 240_000);
  }

  // The end of the cascade now asks EVERY stage it wrote to - a bracket's walkover no longer advances its stage on its own write.
  // differential: none today (the per-write advance completed it); a witness for the end loop (mutation: drop the bracket stages
  // from it and this goes red).
  it("a knockout final walked over by her withdrawal still completes its stage with auto_progress on", async () => {
    const r = await division(SPORTS[0]!, 2, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null }, true);
    await startDivision(r.auth, r.d.id);
    const [k1, k2] = r.ids as [string, string];
    const out = await withdrawEntrantCascade(r.auth, k1);
    expect({ policy: out.policy, walkovers: out.walkovers }).toEqual({ policy: "walkover", walkovers: 1 });
    const [stage] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageIds[0]!}`;
    expect(stage!.status, "the walked-over final completes the knockout").toBe("complete");
    const places = await completedPlaces(r.d.id, r.stageIds[0]!);
    expect(places.map((p) => p.find((x) => x.rank === 1)?.entrantId), "the champion is the side who stayed").toEqual([k2]);
  }, 240_000);

  // A second call: the departed entrant is owed nothing, and nothing completes twice.
  it("a second withdrawal of the same entrant is refused and writes no second stage_completed", async () => {
    const r = await division(SPORTS[0]!, 2, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null }, true);
    await startDivision(r.auth, r.d.id);
    await withdrawEntrantCascade(r.auth, r.ids[0]!);
    await expect(withdrawEntrantCascade(r.auth, r.ids[0]!)).rejects.toMatchObject({ status: 409 });
    expect(await completedPlaces(r.d.id, r.stageIds[0]!)).toHaveLength(1);
  }, 240_000);

  it("anti-vacuity: every sport x flag was driven", () => {
    expect(checked).toBe(RUNS.length);
  });
});
