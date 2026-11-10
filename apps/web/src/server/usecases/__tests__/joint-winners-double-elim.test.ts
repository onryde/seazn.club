// W4 B5b review N-1 (pins the m-4 change): a double-elimination grand final feeds its own reset, which a joint grand
// final would leave owed for good (C32, parked), so the server refuses it. The rule lives in ONE place now - the shared
// predicate, fed `stage_kind` by the usecase - so this drives a real double-elimination grand final through the usecase:
// seated and unplayed -> JOINT_WINNERS_NOT_A_FINAL (and nothing written); decided -> JOINT_WINNERS_FINAL_DECIDED.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { playBadminton } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { declareJointWinners } from "../joint-winners";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Line {
  id: string;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  is_final: boolean;
  third_place: boolean;
  conditional: boolean;
  joint_winners_at: Date | null;
}
const linesOf = (stageId: string) =>
  sql<Line[]>`select id, status, home_entrant_id, away_entrant_id, is_final, third_place, conditional, joint_winners_at
              from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

describe.skipIf(!HAS_DB)("W4 B5b N-1: a double-elimination grand final takes no joint ruling", () => {
  it("seated and unplayed: NOT_A_FINAL, nothing written; decided: FINAL_DECIDED", async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "double_elim", entrants: 4, stageConfig: { bracketReset: true } });
    // Play every line but the grand final (and its conditional reset) until the grand final is seated.
    for (let guard = 0; guard < 12; guard++) {
      const lines = await linesOf(s.stageId);
      const gf = lines.find((l) => l.is_final && !l.conditional && !l.third_place)!;
      if (gf.home_entrant_id !== null && gf.away_entrant_id !== null) break;
      const open = lines.filter((l) => !l.is_final && !l.conditional && l.status === "scheduled" && l.home_entrant_id !== null && l.away_entrant_id !== null);
      expect(open.length, "rig: a line to play while the grand final is unseated").toBeGreaterThan(0);
      for (const l of open) await playBadminton(s.auth, l.id, true);
    }
    const gf = (await linesOf(s.stageId)).find((l) => l.is_final && !l.conditional && !l.third_place)!;
    expect([gf.home_entrant_id, gf.away_entrant_id].every((x) => x !== null), "premise: both grand finalists seated").toBe(true);
    expect(gf.status, "premise: the grand final is unplayed").toBe("scheduled");

    await expect(declareJointWinners(s.auth, gf.id)).rejects.toMatchObject({ code: "JOINT_WINNERS_NOT_A_FINAL" });
    const after = (await linesOf(s.stageId)).find((l) => l.id === gf.id)!;
    expect([after.status, after.joint_winners_at], "the refusal wrote nothing").toEqual(["scheduled", null]);

    await playBadminton(s.auth, gf.id, true);
    expect((await linesOf(s.stageId)).find((l) => l.id === gf.id)!.status, "premise: the grand final is decided").toBe("decided");
    await expect(declareJointWinners(s.auth, gf.id)).rejects.toMatchObject({ code: "JOINT_WINNERS_FINAL_DECIDED" });
  });
});
