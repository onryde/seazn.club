// S2-7 (TN-TS-1) — `runTossThenStart`: the toss, then `core.start`, at consecutive seqs. The controller's ruling is that
// the toss reaches the ledger BEFORE the Start (a toss after it with nothing scored counts as play, ruling 112), so the
// ORDER and the SEQ each write names are the facts under test, and a refused toss must send no Start.
import { describe, expect, it } from "vitest";
import { runTossThenStart, type SeqStep } from "../start-with-toss";

type Call = { type: string; payload: Record<string, unknown>; expectedSeq: number };

function recorder(answers: boolean[]): { step: SeqStep; calls: Call[] } {
  const calls: Call[] = [];
  const step: SeqStep = async (type, payload, expectedSeq) => {
    calls.push({ type, payload, expectedSeq });
    return answers[calls.length - 1] ?? true;
  };
  return { step, calls };
}

const TOSS = { type: "tennis.toss", payload: { serving: "A" } };

describe("runTossThenStart", () => {
  it("sends the toss at the ledger's seq, THEN core.start at the seq the toss leaves", async () => {
    const { step, calls } = recorder([true, true]);
    expect(await runTossThenStart(7, TOSS, step)).toBe("started");
    expect(calls).toEqual([
      { type: "tennis.toss", payload: { serving: "A" }, expectedSeq: 7 },
      { type: "core.start", payload: {}, expectedSeq: 8 },
    ]);
  });

  it("an empty ledger (seq 0) starts the walk at 0, not at a stale default", async () => {
    const { step, calls } = recorder([true, true]);
    await runTossThenStart(0, TOSS, step);
    expect(calls.map((c) => c.expectedSeq)).toEqual([0, 1]);
  });

  it("a refused toss sends NO Start — the match stays unstarted", async () => {
    const { step, calls } = recorder([false]);
    expect(await runTossThenStart(3, TOSS, step)).toBe("toss-refused");
    expect(calls.map((c) => c.type)).toEqual(["tennis.toss"]);
  });

  it("a refused Start after an accepted toss says so (the toss stays held; the next Start only starts)", async () => {
    const { step, calls } = recorder([true, false]);
    expect(await runTossThenStart(3, TOSS, step)).toBe("start-refused");
    expect(calls.map((c) => c.type)).toEqual(["tennis.toss", "core.start"]);
  });

  it("each call sends exactly one toss and one Start — a second call is a second, separate sequence", async () => {
    const { step, calls } = recorder([true, true, true, true]);
    await runTossThenStart(0, TOSS, step);
    expect(calls.filter((c) => c.type === "tennis.toss")).toHaveLength(1);
    expect(calls.filter((c) => c.type === "core.start")).toHaveLength(1);
  });
});
