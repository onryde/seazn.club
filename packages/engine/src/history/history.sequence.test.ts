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
// The enumerated sweeps fold a ledger after every step of 2 × 3^7 orderings.
// A wall-clock budget for a loaded machine, not a cap on the enumeration.
const SWEEP_TIMEOUT_MS = 30_000;

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
    }, SWEEP_TIMEOUT_MS);
  }
});

// ---------------------------------------------------------------------------
// The rule (owner ruling 2026-10-11, option B): schedule history is LINEAR,
// like the help page says ("undo steps back one change, redo steps forward").
// A fresh edit made after an Undo keeps that Undo as a change of its own, so
// a later Undo walks back through it — bringing the undone edit back — and a
// save point taken before it stays reachable. Redo replays only the steps Undo
// walked back since the latest fresh edit; a fresh edit leaves nothing to redo.
//
// The model below is written from that rule alone, in terms of what the board
// shows: a timeline of changes, a cursor into it, and the Undo/Redo steps
// taken since the last fresh edit. It never reads the ledger.
// ---------------------------------------------------------------------------
type Change = { fixture: string; at: string | null };

class LinearHistory {
  private timeline: Change[] = [];
  /** Undo/Redo steps since the last fresh edit — they join the timeline at the next one. */
  private steps: Change[] = [];
  private cursor = 0;

  private boardAt(n: number): Map<string, string | null> {
    const board = new Map<string, string | null>();
    for (const c of this.timeline.slice(0, n)) board.set(c.fixture, c.at);
    return board;
  }
  edit(fixture: string, at: string): void {
    this.timeline = [...this.timeline, ...this.steps, { fixture, at }];
    this.steps = [];
    this.cursor = this.timeline.length;
  }
  undo(): "ok" | "NOTHING_TO_UNDO" {
    if (this.cursor === 0) return "NOTHING_TO_UNDO";
    const undone = this.timeline[this.cursor - 1]!;
    this.steps.push({ fixture: undone.fixture, at: this.boardAt(this.cursor - 1).get(undone.fixture) ?? null });
    this.cursor--;
    return "ok";
  }
  redo(): "ok" | "NOTHING_TO_REDO" {
    if (this.cursor === this.timeline.length) return "NOTHING_TO_REDO";
    this.steps.push(this.timeline[this.cursor]!);
    this.cursor++;
    return "ok";
  }
  board(fixtures: readonly string[]): Record<string, string | null> {
    const now = this.boardAt(this.cursor);
    return Object.fromEntries(fixtures.map((id) => [id, now.get(id) ?? null]));
  }
}

describe("undo / redo follow ONE linear timeline (owner ruling 2026-10-11)", () => {
  // Hand-derived from the rule, step by step, for the recorded defect.
  it("edit e1, edit e2, Undo, fresh edit e4: Undo ×2 brings e2 back, Redo ×2 replays those two Undos, then nothing to redo", () => {
    const board: Board = { events: [], wm: null, written: new Map() };
    const ids = ["f1", "f2", "f4"];
    const shows = () => Object.fromEntries(ids.map((id) => [id, board.written.get(id) ?? null]));
    const atWatermark = () => {
      const state = fold(board.events, board.wm).fixtures;
      return Object.fromEntries(ids.map((id) => [id, state[id]?.at ?? null]));
    };
    const script: [Action, Record<string, string | null>][] = [
      [{ edit: "1" }, { f1: "T1", f2: null, f4: null }],
      [{ edit: "2" }, { f1: "T1", f2: "T2", f4: null }],
      ["undo", { f1: "T1", f2: null, f4: null }], // e2 undone
      [{ edit: "4" }, { f1: "T1", f2: null, f4: "T4" }], // the Undo is history now
      ["undo", { f1: "T1", f2: null, f4: null }], // e4 undone
      ["undo", { f1: "T1", f2: "T2", f4: null }], // the Undo of e2 undone: e2 is back
      ["redo", { f1: "T1", f2: null, f4: null }], // that Undo replayed: e2 gone again
      ["redo", { f1: "T1", f2: null, f4: "T4" }], // e4 replayed
    ];
    for (const [i, [action, expected]] of script.entries()) {
      expect(act(board, action), `step ${i + 1}`).toBe("ok");
      expect(shows(), `step ${i + 1}: what the board shows`).toStrictEqual(expected);
      expect(atWatermark(), `step ${i + 1}: fold at the watermark`).toStrictEqual(expected);
    }
    expect(act(board, "redo")).toBe("NOTHING_TO_REDO");
    // and the whole walk back still ends at the empty board: e4, the Undo of
    // e2, e2, e1 — four steps — then nothing to undo
    for (let i = 0; i < 4; i++) expect(act(board, "undo"), `walk back ${i + 1}`).toBe("ok");
    expect(shows()).toStrictEqual({ f1: null, f2: null, f4: null });
    expect(act(board, "undo")).toBe("NOTHING_TO_UNDO");
  });

  // Every ordering of {edit, undo, redo} of length LEN from an empty ledger
  // and from one edit, against the model: the same refusal, and the board the
  // executor wrote = the fold at the watermark = the model's board, after every
  // step. k-th edit: f(k mod 2) at Tk, so edits overlap on a fixture.
  const LEN = 7;
  const ALPHABET = ["edit", "undo", "redo"] as const;
  type Kind = (typeof ALPHABET)[number];
  function* orderings(n: number): Generator<Kind[]> {
    if (n === 0) {
      yield [];
      return;
    }
    for (const head of orderings(n - 1)) for (const a of ALPHABET) yield [...head, a];
  }
  const stamped = (e: LedgerEvent | undefined) =>
    e !== undefined && (e.payload.__undo_of !== undefined || e.payload.__redo_of !== undefined);

  for (const start of [0, 1]) {
    it(`every ordering of ${LEN} steps from ${start === 0 ? "an empty ledger" : "one edit"} matches the linear model`, () => {
      const FIXTURES = ["f0", "f1"];
      let sequences = 0;
      let compared = 0;
      const disagree: string[] = [];
      const seen = new Map<string, number>();
      const count = (key: string) => seen.set(key, (seen.get(key) ?? 0) + 1);
      for (const seq of orderings(LEN)) {
        sequences++;
        const board: Board = { events: [], wm: null, written: new Map() };
        const model = new LinearHistory();
        let edits = 0;
        const all: Kind[] = [...Array<Kind>(start).fill("edit"), ...seq];
        for (const [i, kind] of all.entries()) {
          let want: string = "ok";
          if (kind === "edit") {
            edits++;
            model.edit(`f${edits % 2}`, `T${edits}`);
          } else {
            want = kind === "undo" ? model.undo() : model.redo();
          }
          const got = kind === "edit" ? act(board, { edit: `${edits}`, fixture: `f${edits % 2}` }) : act(board, kind);
          count(`${kind}:${got}`);
          if (got === "ok" && kind !== "edit") {
            // the steps this rule is about: an Undo or Redo of a row that is
            // itself an Undo/Redo — only reachable after a fresh edit
            const appended = board.events[board.events.length - 1]!;
            const target = appended.payload[kind === "undo" ? "__undo_of" : "__redo_of"];
            if (stamped(board.events.find((e) => e.seq === target))) count(`${kind} of an undo/redo row`);
          }
          const expected = model.board(FIXTURES);
          const written = Object.fromEntries(FIXTURES.map((id) => [id, board.written.get(id) ?? null]));
          const state = fold(board.events, board.wm).fixtures;
          const atWm = Object.fromEntries(FIXTURES.map((id) => [id, state[id]?.at ?? null]));
          compared++;
          const ok =
            got === want &&
            JSON.stringify(written) === JSON.stringify(expected) &&
            JSON.stringify(atWm) === JSON.stringify(expected);
          if (!ok) {
            disagree.push(
              `${all.slice(0, i + 1).join(", ")}: got ${got}, rule ${want}; written ${JSON.stringify(written)}, ` +
                `watermark ${JSON.stringify(atWm)}, rule ${JSON.stringify(expected)}`,
            );
            break;
          }
        }
      }
      expect(disagree.slice(0, 3), `${disagree.length} of ${sequences} orderings break the rule`).toStrictEqual([]);
      // anti-vacuity: the full enumeration ran; every action succeeded AND was
      // refused somewhere; and the sweep reached the path the rule is about
      expect(sequences).toBe(ALPHABET.length ** LEN);
      expect(compared).toBeGreaterThan(sequences);
      for (const key of [
        "edit:ok",
        "undo:ok",
        "redo:ok",
        "undo:NOTHING_TO_UNDO",
        "redo:NOTHING_TO_REDO",
        "undo of an undo/redo row",
        "redo of an undo/redo row",
      ]) {
        expect(seen.get(key) ?? 0, `${key} never happened`).toBeGreaterThan(0);
      }
    }, SWEEP_TIMEOUT_MS);
  }
});
