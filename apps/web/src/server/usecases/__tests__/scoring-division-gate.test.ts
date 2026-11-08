// S2-4 Task 2 (cricket web pad fixes, gap "the toss in a Draft division"): the scoring door refuses every write to a
// division that has not started (Doc 12 §1, `divisionScoringClosed`), and the refusal now says WHY, as
// `EngineError.data.reason = "division_not_started"` (`DIVISION_GATE_REASON`, lib/division-phase.ts). The wire forwards it
// (api-v1/http.ts) and the pad's copy branches on it (lib/scoring-vocab.ts), so a scorer recording the toss in a Draft
// division reads "The competition hasn't started yet…" instead of "That action doesn't apply at this point in the match".
//
// Real DB, real usecase, real cricket module: the toss is the first write a cricket scorer makes, before `core.start`.
//
// single-sport: the gate is sport-agnostic, and cricket is the sport whose first write (the toss) reached it in the field.
import { afterAll, describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { cricketPadRules } from "@seazn/engine/pad";
import { sql } from "@/lib/db";
import { DIVISION_GATE_REASON, divisionScoringClosed } from "@/lib/division-phase";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "../scoring";
import { seedOrg, startedCricketDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

async function cricketFixture(start: boolean): Promise<{ auth: AuthCtx; fixtureId: string; home: string; status: string }> {
  const { auth } = await seedOrg();
  const { divisionId, fixtureId } = await startedCricketDivisionWithFixture(auth, { start });
  const [row] = await sql<{ home_entrant_id: string; status: string }[]>`
    select f.home_entrant_id, d.status from fixtures f join divisions d on d.id = f.division_id
    where f.id = ${fixtureId} and d.id = ${divisionId}`;
  return { auth, fixtureId, home: row!.home_entrant_id, status: row!.status };
}

const toss = (s: { auth: AuthCtx; fixtureId: string; home: string }) =>
  scoreEvent(s.auth, s.fixtureId, {
    expected_seq: 0,
    type: "cricket.toss",
    payload: { wonBy: s.home, elected: cricketPadRules.tossElections[0]! },
  });

async function rows(fixtureId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
  return n;
}

describe.skipIf(!HAS_DB)("S2-4 T2: the division gate says why", () => {
  it("a toss in a Draft division is refused with reason division_not_started", async () => {
    const s = await cricketFixture(false);
    expect(divisionScoringClosed(s.status), `premise: a division in "${s.status}" is closed to scoring`).toBe(true);
    const caught = await toss(s).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("WRONG_PHASE");
    expect((caught as EngineError).data).toMatchObject({ reason: "division_not_started", divisionStatus: s.status });
    expect(DIVISION_GATE_REASON.notStarted).toBe("division_not_started");
    expect(await rows(s.fixtureId), "the refused toss wrote nothing").toBe(0);
  });

  it("the same toss in a started division is recorded (the gate opens; the reason is the gate's alone)", async () => {
    const s = await cricketFixture(true);
    expect(divisionScoringClosed(s.status), `premise: a division in "${s.status}" is open to scoring`).toBe(false);
    await toss(s);
    expect(await rows(s.fixtureId)).toBe(1);
  });
});
