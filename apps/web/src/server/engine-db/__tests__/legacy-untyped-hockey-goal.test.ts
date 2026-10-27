// W2d T18 fix round 1 (I1) — a hockey match in progress at the deploy holds goals recorded before the goal type became
// required. The strict write path refuses an untyped `hockey.goal` (GOAL_KIND_REQUIRED, HK-TB-2), but only the event
// being APPENDED is judged (`append-event.ts`: the whole ledger folds with `strictFromSeq` = the candidate's seq), so
// the legacy goal replays as the field goal B3 reads it as, and the pad's next writes — another goal, or a void of the
// legacy goal itself — land. The positive pair: a NEW untyped goal on the same ledger is still refused by name.
//
// Driven through `scoreEvent` (the write the pad's POST reaches) on a division the usecases seed. The legacy row is
// written by raw SQL, the one way such a row can exist now — the shape an earlier build's write left behind.
// single-sport: GOAL_KIND_REQUIRED is FIH hockey's alone (the engine's every-sport sweep, goal-kind-required.test.ts).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "@/server/usecases/scoring";
import { seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: AuthCtx, id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await tip(id), type, payload } as never);
const goalsOf = async (id: string) =>
  (await sql<{ state: { goals: { home: number; away: number } } }[]>`select state from match_states where fixture_id = ${id}`)[0]!.state.goals;
const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
};

describe.runIf(HAS_DB)("W2d T18 fix round 1 (I1) — a pre-deploy untyped hockey goal in the ledger", () => {
  it("replays as a goal and blocks nothing: a typed goal, then a void of the legacy goal, both land; a NEW untyped goal is refused by name, and writes nothing", async () => {
    const s = await seedBracket({ sport: "hockey", variant: "fih-outdoor", stageKind: "league", entrants: 2 });
    const id = s.fixtureIds[0]!;
    const [fx] = await sql<{ home: string; away: string }[]>`
      select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`;
    await post(s.auth, id, "core.start");

    // The legacy goal: untyped, as a write before this deploy recorded it.
    const legacyId = randomUUID();
    await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
              values (${legacyId}, ${id}, ${(await tip(id)) + 1}, 'hockey.goal', ${sql.json({ by: fx!.home })}, now())`;

    // 1. The next goal (typed, as every live write is) lands, and the fold counts the legacy goal beside it.
    const typed = await post(s.auth, id, "hockey.goal", { by: fx!.away, kind: "pc" });
    expect(typed.seq).toBe(3);
    expect(await goalsOf(id), "the legacy goal replays as a goal").toEqual({ home: 1, away: 1 });

    // 2. Voiding the legacy goal (the row's own Void, or Take back) is a write the engine takes.
    const voided = await post(s.auth, id, "core.void", { event_id: legacyId });
    expect(voided.seq).toBe(4);
    expect(await goalsOf(id), "the void removed exactly the legacy goal").toEqual({ home: 0, away: 1 });

    // 3. The positive pair: the same ledger refuses a NEW untyped goal by name, and the ledger does not move.
    expect(await codeOf(post(s.auth, id, "hockey.goal", { by: fx!.home })), "a new untyped goal").toBe("GOAL_KIND_REQUIRED");
    expect(await tip(id), "the refusal wrote nothing").toBe(4);
  });
});
