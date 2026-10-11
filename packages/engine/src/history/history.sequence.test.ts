// Undo / Redo SEQUENCES (TEST-STRATEGY rule 1 + rule 10): what the app's
// executor writes to the fixtures table, event by event, must equal the fold
// at the watermark after EVERY step — whatever the step was, and whatever came
// before it. A disagreement means the next Undo/Redo is computed from a state
// the board does not show.
//
// The executor is re-implemented here independently of `fold`: it replays each
// appended row's own `to` onto a map, which is all the app's `execute()` does
// for a `schedule_edited` row (apps/web/src/server/usecases/history.ts).
// Sport: not applicable — the division ledger consults no sport module.
import { describe, expect, it } from "vitest";
import { fold, redo, undo } from "./history.ts";
import type { LedgerEvent } from "./types.ts";

const NONE: ReadonlySet<string> = new Set();

type Action = "undo" | "redo" | { edit: string; fixture?: string };

interface Board {
  events: LedgerEvent[];
  /** null = the ledger head, exactly as the app persists it after a fresh edit. */
  wm: number | null;
  /** The fixtures table as the executor wrote it, row by row. */
  written: Map<string, string | null>;
}

function writeRow(board: Board, type: string, payload: Record<string, unknown>): void {
  const seq = (board.events[board.events.length - 1]?.seq ?? 0) + 1;
  board.events = [...board.events, { seq, type, payload }];
  if (type !== "schedule_edited") throw new Error(`this executor writes schedule_edited only, got ${type}`);
  const to = payload.to as { at: string | null };
  board.written.set(payload.fixture as string, to.at);
}

/** One organiser action. A fresh edit places a fixture (its own `f<name>`
 *  unless named) at `T<name>`, `from` where the executor last wrote it, and
 *  moves the watermark to the head, as every app emitter does. */
function act(board: Board, action: Action): "ok" | "NOTHING_TO_UNDO" | "NOTHING_TO_REDO" {
  if (typeof action === "object") {
    const fixture = action.fixture ?? `f${action.edit}`;
    const from = board.written.get(fixture) ?? null;
    writeRow(board, "schedule_edited", {
      fixture,
      from: { at: from, court: from === null ? null : "C1" },
      to: { at: `T${action.edit}`, court: "C1" },
    });
    board.wm = null;
    return "ok";
  }
  let step;
  try {
    step = action === "undo" ? undo(board.events, board.wm, NONE) : redo(board.events, board.wm, NONE);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NOTHING_TO_UNDO" || code === "NOTHING_TO_REDO") return code;
    throw err;
  }
  writeRow(board, step.event.type, step.event.payload);
  board.wm = step.newWatermark;
  return "ok";
}

/** The board the executor wrote vs the board the watermark claims, over every
 *  fixture either side has ever seen. */
function sides(board: Board) {
  const state = fold(board.events, board.wm).fixtures;
  const ids = [...new Set([...board.written.keys(), ...Object.keys(state)])].sort();
  return {
    ids,
    written: Object.fromEntries(ids.map((id) => [id, board.written.get(id) ?? null])),
    atWatermark: Object.fromEntries(ids.map((id) => [id, state[id]?.at ?? null])),
  };
}

const label = (a: Action) => (typeof a === "object" ? `edit e${a.edit}` : a);

describe("undo / redo after a fresh edit — the executor's writes agree with the watermark", () => {
  // The recorded defect (engine mutation debt, history lane, finding 1).
  it("edit e1, edit e2, Undo, fresh edit e4, Undo, Undo, Redo, Undo: written board = fold at the watermark after every step", () => {
    const board: Board = { events: [], wm: null, written: new Map() };
    const script: Action[] = [{ edit: "1" }, { edit: "2" }, "undo", { edit: "4" }, "undo", "undo", "redo", "undo"];
    const trail: string[] = [];
    let compared = 0;
    for (const action of script) {
      expect(act(board, action), `${trail.join(", ")} → ${label(action)} was refused`).toBe("ok");
      trail.push(label(action));
      const { ids, written, atWatermark } = sides(board);
      expect(atWatermark, `after ${trail.join(", ")}`).toStrictEqual(written);
      compared += ids.length;
    }
    // anti-vacuity: every step compared at least one fixture
    expect(compared).toBeGreaterThanOrEqual(script.length);
  });

  // Every ordering of {edit, undo, redo} of length LEN, from an empty ledger
  // and from a ledger holding one edit — enumerated, not sampled. Checking
  // after every step covers every shorter ordering as a prefix. The k-th fresh
  // edit places f(k mod 2) at Tk, so later edits move a fixture an earlier,
  // possibly undone or abandoned, edit also moved.
  const LEN = 7;
  const ALPHABET = ["edit", "undo", "redo"] as const;
  function* orderings(n: number): Generator<(typeof ALPHABET)[number][]> {
    if (n === 0) {
      yield [];
      return;
    }
    for (const head of orderings(n - 1)) for (const a of ALPHABET) yield [...head, a];
  }

  for (const start of [0, 1]) {
    it(`every ordering of ${LEN} steps from ${start === 0 ? "an empty ledger" : "one edit"}: written board = fold at the watermark after every step`, () => {
      let sequences = 0;
      let compared = 0;
      const disagree: string[] = [];
      const steps = new Map<string, number>();
      for (const seq of orderings(LEN)) {
        sequences++;
        const board: Board = { events: [], wm: null, written: new Map() };
        let edits = 0;
        const run = (kind: (typeof ALPHABET)[number]) =>
          kind === "edit" ? act(board, { edit: `${++edits}`, fixture: `f${edits % 2}` }) : act(board, kind);
        for (let i = 0; i < start; i++) run("edit");
        const trail: string[] = [];
        for (const kind of seq) {
          const outcome = run(kind);
          steps.set(`${kind}:${outcome}`, (steps.get(`${kind}:${outcome}`) ?? 0) + 1);
          trail.push(outcome === "ok" ? kind : `${kind}(refused)`);
          const { ids, written, atWatermark } = sides(board);
          compared += ids.length;
          if (JSON.stringify(atWatermark) !== JSON.stringify(written)) {
            disagree.push(`after ${start} edit(s), then ${trail.join(", ")}: written ${JSON.stringify(written)}, watermark ${JSON.stringify(atWatermark)}`);
            break; // the first disagreement names the ordering; later steps compound it
          }
        }
      }
      expect(disagree.slice(0, 3), `${disagree.length} of ${sequences} orderings disagree`).toStrictEqual([]);
      // anti-vacuity: the enumeration ran in full, and every action happened
      // AND was refused somewhere (a sweep that never reaches the refusal, or
      // never succeeds, proves half of what it says)
      expect(sequences).toBe(ALPHABET.length ** LEN);
      expect(compared).toBeGreaterThan(0);
      for (const outcome of ["edit:ok", "undo:ok", "redo:ok", "undo:NOTHING_TO_UNDO", "redo:NOTHING_TO_REDO"]) {
        expect(steps.get(outcome) ?? 0, `${outcome} never happened`).toBeGreaterThan(0);
      }
    });
  }
});
