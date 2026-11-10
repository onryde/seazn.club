// W4 T21 (AN-1, X-CH-8; competition-desk _RULES: empty case first, a red attention outranks the phase). Prod held an
// eight-entrant knockout whose seven matches were all decided while its stage stayed open — the division's auto-advance
// was off, so nothing completed it, the bracket never ranked, and the desk read "Finished" with nothing asking for the
// one action that ranks it. Real Postgres, real doors: the generator, `scoreEvent`, `getCompetitionDesk`, and the
// existing `completeStage` that the row points at.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { scoreEvent } from "@/server/usecases/scoring";
import { completeStage } from "@/server/usecases/stages";
import { getCompetitionDesk } from "../competition-desk";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const seq = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: Parameters<typeof scoreEvent>[0], id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await seq(id), type, payload } as never);

type Rig = Awaited<ReturnType<typeof seedBracket>>;

/** Every seated, unplayed fixture of the stage, decided home 3-1, round by round, until the bracket stops seating any —
 *  `stopBefore` leaves that many of the stage's matches unplayed (the last ones: the final first). */
async function playOut(t: Rig, stopBefore = 0): Promise<number> {
  const [{ n: total }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${t.stageId}`;
  let played = 0;
  for (let pass = 0; pass < 10; pass++) {
    const open = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${t.stageId} and status = 'scheduled'
         and home_entrant_id is not null and away_entrant_id is not null
       order by round_no, fixture_no`;
    if (open.length === 0) break;
    for (const f of open) {
      if (played >= total - stopBefore) return played;
      await post(t.auth, f.id, "core.start");
      const out = await post(t.auth, f.id, "generic.result", { p1Score: 3, p2Score: 1 });
      expect(out.status, "rig: a played match is decided").toBe("decided");
      played++;
    }
  }
  return played;
}

async function deskRow(t: Rig) {
  const d = (await getCompetitionDesk(t.auth, t.competitionId)).divisions.get(t.divisionId);
  expect(d, "the division is on the desk").toBeDefined();
  return { ...d!, finalDecided: d!.attention.filter((a) => a.kind === "final_decided") };
}

describe.skipIf(!HAS_DB)("X-CH-8 the desk asks to complete a decided bracket (W4 T21, AN-1)", () => {
  it("empty case first: a fresh, started knockout raises no final_decided", async () => {
    const t = await seedBracket({ sport: "generic", variant: declaredVariant("generic", "score"), stageKind: "knockout", entrants: 8 });
    expect((await deskRow(t)).finalDecided).toEqual([]);
  });

  it('X-CH-8 a decided final on an active stage raises "Final decided — complete the stage"', async () => {
    const t = await seedBracket({ sport: "generic", variant: declaredVariant("generic", "score"), stageKind: "knockout", entrants: 8 });
    // AN-1's premise, read off the row rather than assumed: auto-advance is off, so nothing completes the stage.
    const [{ auto_progress }] = await sql<{ auto_progress: boolean }[]>`select auto_progress from divisions where id = ${t.divisionId}`;
    expect(auto_progress, "premise: the division's auto-advance is off").toBe(false);

    // The negative pair first: six of seven decided, the final still to play — no row.
    expect(await playOut(t, 1), "six matches played").toBe(6);
    expect((await deskRow(t)).finalDecided, "the final is not played yet").toEqual([]);

    expect(await playOut(t), "the final played").toBe(1);
    const [{ decided, total, status }] = await sql<{ decided: number; total: number; status: string }[]>`
      select count(*) filter (where f.status = 'decided')::int as decided, count(*)::int as total, s.status
        from fixtures f join stages s on s.id = f.stage_id where f.stage_id = ${t.stageId} group by s.status`;
    expect({ decided, total, status }, "premise: all seven decided, the stage still open").toEqual({ decided: 7, total: 7, status: "active" });

    const d = await deskRow(t);
    expect(d.finalDecided).toEqual([{ kind: "final_decided", stageName: "S1" }]);
    // The red row outranks the phase: alone, the phase reads Finished — the AN-1 desk.
    expect(d.phase).toBe("finished");
    expect(d.attention[0], "the red row leads").toEqual({ kind: "final_decided", stageName: "S1" });

    // Sequence: the row's own door — the existing Complete stage — ranks the bracket, and the row is gone.
    const done = await completeStage(t.auth, t.stageId, { publish: false });
    expect(done.completed).toBe(true);
    // Ranked: the completion writes the bracket's placement snapshot, eight rows for eight entrants.
    const [snap] = await sql<{ n: number }[]>`
      select jsonb_array_length(rows)::int as n from standings_snapshots where stage_id = ${t.stageId} and pool_id is null`;
    expect(snap?.n, "the completed stage is ranked").toBe(8);
    expect((await deskRow(t)).finalDecided, "completed: no row").toEqual([]);
  });
});
