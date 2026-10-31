import "server-only";
// server/sponsors/operator-log.ts — R4 sponsors on stream, S5: the operator's Hide graphics, Play next and Skip, as the
// sponsor planner reads them (`OperatorLogEntry`, lib/sponsor-plan.ts).
//
// DELIBERATE CROSS-PLAN SEAM (preflight row 43): there is no operator yet. The console plan's C1 creates the log table
// (fixture_stream_operator_log) and C3 makes this function read it; until then it answers [] and reads nothing, so
// the planner sees no hidden graphics, no Play next choice and no skip — exactly a stream with no operator. The test
// that pins this answer is rewritten by C3.
import type { Tx, sql } from "@/lib/db";
import type { OperatorLogEntry } from "@/lib/sponsor-plan";

export async function operatorLogFor(exec: Tx | typeof sql, fixtureId: string): Promise<OperatorLogEntry[]> {
  void exec;
  void fixtureId;
  return [];
}
