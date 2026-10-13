// W2c X-AB-5 (fix round 1): the withdrawal report lists a table stage's board that was ABANDONED with no result and is
// still owed the organiser's settle (`left_to_organiser`) - and NOT a board a withdrawal EXPUNGED. The expunge case is the
// realistic trap: A leaves a league with nothing played (under half: the cascade expunges A's boards, each an abandon with
// `expunge: true`), then B leaves - and the board A-B is a stored `abandoned` row with an active abandon and no outcome,
// exactly what a scorer's abandon looks like. Only the payload tells them apart; the report must not ask the organiser to
// settle a match that left the table. Real Postgres; every door is a use-case (Start, Abandon, Withdraw).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { scoreEvent } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Board = { id: string; status: string; home: string; away: string };
const boardsOf = (stageId: string) =>
  sql<Board[]>`select id, status, home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${stageId} order by fixture_no`;
const ledger = (id: string) => sql<{ type: string; payload: { expunge?: boolean } | null }[]>`select type, payload from score_events where fixture_id = ${id} order by seq`;

describe.skipIf(!HAS_DB)("a league withdrawal's report and the boards already expunged (X-AB-5)", () => {
  it("a board an EARLIER withdrawal expunged is not reported as owed a settle; a scorer's abandon on another board of the same league is", async () => {
    const t = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 4 });
    const all = await boardsOf(t.stageId);
    expect(all, "four entrants, one round robin").toHaveLength(6);
    const ids = [...new Set(all.flatMap((b) => [b.home, b.away]))];
    expect(ids).toHaveLength(4);
    const [A, B, C, D] = ids as [string, string, string, string];
    const between = (x: string, y: string) => all.find((b) => [b.home, b.away].includes(x) && [b.home, b.away].includes(y))!;

    // C and D's board: a scorer's abandon (a real replay - nobody decided) - the rows below must report THIS one only.
    const cd = between(C, D);
    await scoreEvent(t.auth, cd.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(t.auth, cd.id, { expected_seq: 1, type: "core.abandon", payload: { reason: "rain" } });
    expect((await boardsOf(t.stageId)).find((b) => b.id === cd.id)!.status, "rig: the scorer's abandon").toBe("abandoned");

    // A leaves with nothing decided: the league's under-half policy EXPUNGES A's boards.
    const first = await withdrawEntrantCascade(t.auth, A);
    expect(first.policy, "rig: an early withdrawal expunges").toBe("expunge");
    const ab = between(A, B);
    const abLedger = await ledger(ab.id);
    expect(
      abLedger.some((e) => e.type === "core.abandon" && e.payload?.expunge === true),
      "rig: A-B carries an expunge abandon",
    ).toBe(true);
    expect((await boardsOf(t.stageId)).find((b) => b.id === ab.id)!.status).toBe("abandoned");
    // The first report already lists the scorer's abandoned C-D board? No: C-D is not A's board, and A's own expunged boards are not owed.
    expect(first.left_to_organiser, "A's own expunged boards are nobody's to settle").toEqual([]);

    // B leaves next. B's boards: A-B (expunged by A's departure - NOT owed), B-C and B-D (still to play).
    const second = await withdrawEntrantCascade(t.auth, B);
    expect(second.left_to_organiser, "the expunged A-B board is not reported").not.toContain(ab.id);
    // The positive pair: C withdraws - C-D is C's board, a scorer's abandon still awaiting its settle, and it IS reported.
    const third = await withdrawEntrantCascade(t.auth, C);
    expect(third.left_to_organiser, "the scorer's abandon on C-D is reported").toEqual([cd.id]);
  }, 180_000);
});
