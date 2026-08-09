// #364 Task 1 — the regression pin for lifting `buildScheduleTrace` out of
// ai-console.tsx. The composer is the only place the referee narrative exists
// (there is no server trace field), so a silent reorder or a dropped line is
// invisible to every other suite: the console renders whatever array it is
// handed. These three cases fix the WHOLE sequence — kind and text, in order —
// for the clean, repaired and blocking outcomes, so the move can only be a move.
//
// `msg` is faked as `key:{vars}` rather than routed through the real dictionary:
// what is being pinned is which key is emitted with which vars, and the English
// sentence behind it is free to change without touching this file.
import { describe, expect, it } from "vitest";
import { buildScheduleTrace, type TraceMsgFn, type TraceSource } from "../ai-trace-compose";

const msg: TraceMsgFn = (k, vars) => (vars ? `${k}:${JSON.stringify(vars)}` : String(k));

const row = (n: number): TraceSource["proposal"][number] => ({
  fixture_id: `0000000${n}-0000-4000-8000-000000000000`,
  scheduled_at: `2026-08-09T1${n}:00:00.000Z`,
  court_label: `Court ${n}`,
});

function source(over: Partial<TraceSource> = {}): TraceSource {
  return {
    proposal: [row(1), row(2), row(3)],
    blocking: [],
    warnings: [],
    usage: { input_tokens: 0, output_tokens: 0, repair_rounds: 0 },
    ...over,
  };
}

/** The spine every outcome opens with — draft, plan, referee. */
const SPINE = [
  { t: "step", text: "board.ai.trace.node.draft" },
  { t: "log", text: 'board.ai.trace.line.draft:{"fixtures":3,"courts":2}' },
  { t: "step", text: "board.ai.trace.node.plan" },
  { t: "log", text: 'board.ai.trace.line.plan:{"count":3}' },
  { t: "step", text: "board.ai.trace.node.referee" },
  { t: "log", text: "board.ai.trace.line.verify" },
];

describe("buildScheduleTrace", () => {
  it("narrates a clean run as spine → clean → ready, and flags nothing", () => {
    const { events, flaggedIds } = buildScheduleTrace(source(), 2, msg);

    expect(events).toEqual([
      ...SPINE,
      { t: "clean", text: "board.ai.trace.line.clean" },
      { t: "step", text: "board.ai.trace.node.ready" },
    ]);
    expect(flaggedIds).toEqual([]);
  });

  it("shows the caught conflict's detail and the repair round, then still lands clean", () => {
    const { events, flaggedIds } = buildScheduleTrace(
      source({
        warnings: [{ fixtureId: "f1", reason: "rest", detail: "Alice 12m rest" }],
        usage: { input_tokens: 0, output_tokens: 0, repair_rounds: 2 },
      }),
      2,
      msg,
    );

    expect(events).toEqual([
      ...SPINE,
      { t: "flag", text: 'board.ai.trace.line.flag:{"what":"Alice 12m rest"}' },
      { t: "step", text: "board.ai.trace.node.repair" },
      { t: "log", text: 'board.ai.trace.line.repair:{"rounds":2}' },
      // A repaired warning is resolved: nothing blocking remains, so the spine
      // still settles.
      { t: "clean", text: "board.ai.trace.line.clean" },
      { t: "step", text: "board.ai.trace.node.ready" },
    ]);
    expect(flaggedIds).toEqual(["f1"]);
  });

  it("falls back to the bare reason and ends unresolved when a blocking conflict remains", () => {
    const { events, flaggedIds } = buildScheduleTrace(
      source({ blocking: [{ fixtureId: "f2", reason: "court" }] }),
      2,
      msg,
    );

    expect(events).toEqual([
      ...SPINE,
      // No `detail` on this conflict — the raw reason carries the line.
      { t: "flag", text: 'board.ai.trace.line.flag:{"what":"court"}' },
      { t: "flag", text: 'board.ai.trace.line.blockingRemain:{"count":1}' },
    ]);
    expect(flaggedIds).toEqual(["f2"]);
  });
});
