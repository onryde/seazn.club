// W5 app PR A, B3 re-review (round 2). Two ends of one invariant - RB5-W6: a Reinstate takes the footnote away (her
// `table_withdrawal` row is voided) and she ranks by her results again - plus the reverse's auto-advance.
//
// 1. A retried cascade (its status write failed after its ledger row committed, so she reads as in the field and the organiser
//    withdraws her again) appended a SECOND `table_withdrawal` row; Reinstate voided only the latest per stage
//    (`activeTableWithdrawals`), so the earlier one became active again: back in the field, ranked last, footnote shown.
//    differential: today (bcbd233e1a) two unvoided rows after the retry, one left after the Reinstate.
// 2. A ledger that already holds two unvoided rows for her (written before this fix): Reinstate voids EVERY one on an open stage.
// 3. The reverse re-records her removed result through the scorer; with `auto_progress` on, that decision asked the stage to
//    advance while her other lines were still taken out, so the table completed part-way. differential: today the stage is
//    `complete` with her lines still abandoned.
//
// Expected values: RB5-W3 (3 of 5 played: walkover, nothing removed), RB5-W2 (1 of 3: expunge), RB5-W6 (Reinstate: every line
// back, no footnote). Sport: badminton from the engine registry - the ledger rows and the reverse are sport-blind; the per-sport
// sweeps of the cascade are table-expunge / in-match-dq-cascade.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { loadTableWithdrawals } from "@/server/public-site/table-withdrawals";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
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

const BADMINTON = (() => {
  const m = builtinModules.find((x) => x.key === "badminton");
  if (!m) throw new Error("registry has no badminton");
  return { key: "badminton", variant: Object.keys(m.variants)[0]! };
})();

type Line = { id: string; home_entrant_id: string; away_entrant_id: string };

async function league(entrants: number) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "B3 r2 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: BADMINTON.key, variant_key: BADMINTON.variant, config: {} });
  const es = await createEntrants(auth, d.id, Array.from({ length: entrants }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
  await startDivision(auth, d.id);
  const v = es[0]!.id;
  const lines = await sql<Line[]>`select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round, id`;
  const mine = lines.filter((l) => l.home_entrant_id === v || l.away_entrant_id === v);
  const other = (l: Line) => (l.home_entrant_id === v ? l.away_entrant_id : l.home_entrant_id);
  return { auth, divisionId: d.id, stageId: stage!.id, v, lines, mine, other };
}

/** Her `table_withdrawal` rows with no `table_withdrawal_voided` row naming them - every one, not only the latest per stage. */
const unvoided = async (divisionId: string, entrantId: string) =>
  (
    await sql<{ n: number }[]>`
      select count(*)::int as n from division_events w
       where w.division_id = ${divisionId} and w.type = 'table_withdrawal' and w.payload->>'entrant_id' = ${entrantId}
         and not exists (select 1 from division_events x where x.division_id = w.division_id and x.type = 'table_withdrawal_voided'
                          and (x.payload->>'voids_seq')::int = w.seq)`
  )[0]!.n;
const allRows = async (divisionId: string, entrantId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId} and type = 'table_withdrawal'
     and payload->>'entrant_id' = ${entrantId}`)[0]!.n;
const statusOf = async (id: string) => (await sql<{ s: string }[]>`select status as s from entrants where id = ${id}`)[0]!.s;

describe.runIf(HAS_DB)("B3 re-review: a retried cascade and a Reinstate leave no stale table_withdrawal row (RB5-W6)", () => {
  it("a retried cascade keeps ONE active row; the Reinstate after it leaves none, and no footnote", async () => {
    const r = await league(6);
    expect(r.mine).toHaveLength(5);
    for (const l of r.mine.slice(0, 3)) await post(r.auth, l.id, "core.forfeit", { by: r.other(l), reason: "walkover" }); // she wins 3
    await withdrawEntrantCascade(r.auth, r.v);
    expect(await unvoided(r.divisionId, r.v), "premise: the first cascade wrote her row").toBe(1);
    // Her status write failed after the row committed: she reads as in the field, and the organiser withdraws her again.
    await sql`update entrants set status = 'confirmed' where id = ${r.v}`;
    await withdrawEntrantCascade(r.auth, r.v);
    expect(await statusOf(r.v)).toBe("withdrawn");
    expect(await allRows(r.divisionId, r.v), "rig: the retry appended its own row").toBe(2);
    expect(await unvoided(r.divisionId, r.v), "the retry voided the row before it: exactly one is active").toBe(1);
    expect((await loadTableWithdrawals(r.divisionId)).filter((x) => x.entrant_id === r.v).map((x) => [x.policy, x.played_at_departure, x.scheduled])).toEqual([
      ["walkover", 3, 5],
    ]);

    await patchEntrant(r.auth, r.v, { status: "confirmed" });
    expect(await statusOf(r.v), "Reinstated").toBe("confirmed");
    expect(await unvoided(r.divisionId, r.v), "RB5-W6: no row of hers is active").toBe(0);
    expect((await loadTableWithdrawals(r.divisionId)).filter((x) => x.entrant_id === r.v), "and no footnote names her").toEqual([]);
    // Sequence: withdrawn again after the Reinstate - one fresh active row, the voided ones stay voided.
    await withdrawEntrantCascade(r.auth, r.v);
    expect(await unvoided(r.divisionId, r.v)).toBe(1);
  }, 300_000);

  it("a ledger already holding two unvoided rows for her (written before this fix): the Reinstate voids every one", async () => {
    const r = await league(6);
    for (const l of r.mine.slice(0, 3)) await post(r.auth, l.id, "core.forfeit", { by: r.other(l), reason: "walkover" });
    await withdrawEntrantCascade(r.auth, r.v);
    // The pre-fix shape: a second, unvoided copy of her row (a retry before the cascade voided the one before).
    await sql`insert into division_events (division_id, seq, type, payload, actor_id)
      select w.division_id, (select max(seq) + 1 from division_events where division_id = w.division_id), w.type, w.payload, w.actor_id
        from division_events w where w.division_id = ${r.divisionId} and w.type = 'table_withdrawal' and w.payload->>'entrant_id' = ${r.v}`;
    expect(await unvoided(r.divisionId, r.v), "rig: two unvoided rows").toBe(2);
    await patchEntrant(r.auth, r.v, { status: "confirmed" });
    expect(await unvoided(r.divisionId, r.v), "both voided").toBe(0);
    expect((await loadTableWithdrawals(r.divisionId)).filter((x) => x.entrant_id === r.v)).toEqual([]);
  }, 300_000);

  it("the reverse asks the stage to advance once, at the end: auto_progress switched on after an expunge, the Reinstate puts every line back and the stage stays open", async () => {
    const r = await league(4);
    expect(r.mine).toHaveLength(3);
    const [played, ...rest] = r.mine;
    await post(r.auth, played!.id, "core.forfeit", { by: r.other(played!), reason: "walkover" }); // she wins her first: 1 of 3
    for (const l of r.lines.filter((x) => !r.mine.includes(x))) await post(r.auth, l.id, "core.forfeit", { by: l.away_entrant_id, reason: "walkover" });
    await withdrawEntrantCascade(r.auth, r.v); // RB5-W2: under half, every line of hers is taken out
    const [st0] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageId}`;
    expect(st0!.status, "rig: auto_progress is off, so the stage waits").toBe("active");
    await sql`update divisions set auto_progress = true where id = ${r.divisionId}`;

    const out = await patchEntrant(r.auth, r.v, { status: "confirmed" });
    expect(out.reinstate?.not_restored ?? [], "every line came back").toEqual([]);
    const rows = await sql<{ id: string; status: string }[]>`select id, status from fixtures where id in ${sql(r.mine.map((l) => l.id))}`;
    const byId = new Map(rows.map((x) => [x.id, x.status]));
    expect(byId.get(played!.id), "her win is re-recorded").toBe("forfeited");
    expect(rest.map((l) => byId.get(l.id)), "her two unplayed lines are owed again").toEqual(["scheduled", "scheduled"]);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageId}`;
    expect(st!.status, "two lines are owed: the stage is not finished").toBe("active");
  }, 300_000);

  it("the end-of-reverse ask is made: a finished table reinstated with auto_progress switched on completes then (Jul3/08 §5), not before", async () => {
    // The other side of the case above: once every line is back, the one ask at the end is what advances a finished stage. A
    // walkover-policy withdrawal (3 of 3 played, RB5-W3) re-records nothing, so no score write would ask.
    const r = await league(4);
    for (const l of r.lines) {
      const loser = r.mine.includes(l) ? r.other(l) : l.away_entrant_id; // she wins all 3; elsewhere the home side
      await post(r.auth, l.id, "core.forfeit", { by: loser, reason: "walkover" });
    }
    await withdrawEntrantCascade(r.auth, r.v);
    const [st0] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageId}`;
    expect(st0!.status, "rig: auto_progress off, the finished stage waits").toBe("active");
    await sql`update divisions set auto_progress = true where id = ${r.divisionId}`;
    await patchEntrant(r.auth, r.v, { status: "confirmed" });
    expect(await unvoided(r.divisionId, r.v)).toBe(0);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageId}`;
    expect(st!.status, "the Reinstate's one ask completed it").toBe("complete");
  }, 300_000);
});
