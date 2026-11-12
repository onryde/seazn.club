// S2-7 (TN-TS-1, engine 8.0.0) — Start with a toss: the toss, THEN `core.start`, as two ordinary appends at consecutive
// seqs. The controller's ruling: a toss after the Start with nothing scored counts as play (ruling 112 — it blocks a
// walkover and admits a zero-point retirement), so the toss must reach the ledger first.
//
// Each append takes the seq the one before it leaves (`append-event.ts`: an accepted event is `expected_seq + 1`), the
// same running-seq walk `runVoidBack` (cricket-wicket-void.ts) takes, so the second write never races the first one's
// resync. A refused toss sends no Start: the match stays unstarted and the scorer answers again. A refused Start leaves
// the toss held, and the next Start finds it held (`startNeedsToss` answers no) and only starts.

/** One append at an explicit expected seq; true when the server accepted it. */
export type SeqStep = (type: string, payload: Record<string, unknown>, expectedSeq: number) => Promise<boolean>;

export type StartWithTossResult = "started" | "toss-refused" | "start-refused";

export async function runTossThenStart(
  fromSeq: number,
  toss: { type: string; payload: Record<string, unknown> },
  step: SeqStep,
): Promise<StartWithTossResult> {
  if (!(await step(toss.type, toss.payload, fromSeq))) return "toss-refused";
  if (!(await step("core.start", {}, fromSeq + 1))) return "start-refused";
  return "started";
}
