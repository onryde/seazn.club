// m9 (B2b review): result-sourcing ("the loser of match X referees match Y") read `f.status === "decided"` alone, so a fixture
// that is FINALIZED or settled by a forfeit (V432's settled set) stayed pending forever. Real Postgres, through sourceOfficials.
// single-sport: badminton - the sourcing reads status and outcome, no sport field.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { playBadminton, rowsOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { sourceOfficials } from "../officials";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.runIf(HAS_DB)("m9 result sourcing reads every settled status", () => {
  it("empty case: an unplayed fixture is pending (not decided yet)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const [first] = await rowsOf(s.stageId);
    const out = await sourceOfficials(s.auth, s.stageId, { sources: [{ kind: "result", fromFixture: first!.id, side: "loser" }] });
    expect(out.resolved).toEqual([]);
    expect(out.pending.length).toBe(1);
  }, 240_000);

  it("a decided, a finalized and a forfeited fixture each resolve their loser; a scheduled one stays pending (counted, 3)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id !== null && r.away_entrant_id !== null).slice(0, 2);
    expect(semis.length, "rig: two seated semi-finals").toBe(2);
    for (const f of semis) await playBadminton(s.auth, f.id, true);
    const played = await rowsOf(s.stageId);
    let checked = 0;
    for (const status of ["decided", "finalized", "forfeited"]) {
      const f = played.find((r) => r.id === semis[0]!.id)!;
      await sql`update fixtures set status = ${status} where id = ${f.id}`;
      const loser = f.outcome!.winner === f.home_entrant_id ? f.away_entrant_id : f.home_entrant_id;
      const out = await sourceOfficials(s.auth, s.stageId, { sources: [{ kind: "result", fromFixture: f.id, side: "loser" }] });
      expect(out.resolved.map((r) => r.entrant_id), `status ${status}`).toEqual([loser]);
      checked++;
    }
    expect(checked).toBe(3);
    await sql`update fixtures set status = 'scheduled' where id = ${semis[0]!.id}`;
    const pending = await sourceOfficials(s.auth, s.stageId, { sources: [{ kind: "result", fromFixture: semis[0]!.id, side: "loser" }] });
    expect(pending.resolved, "a scheduled fixture is not settled").toEqual([]);
  }, 240_000);
});
