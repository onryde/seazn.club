// Owner rule (2026-10-19): +5 is offered ONLY INSIDE a board's check-in window - not before it opens, not from its deadline on, to the
// millisecond - and a screen keeps that true on a TICKING clock, not on the snapshot it was drawn from (the arbiter panel's poll is up to
// 20 s apart). The rule itself is the server's `extendRefusal` (window.ts); `liveExtendRefusal` and `liveExtendableCount` re-ask only the
// CLOCK of a snapshot's own refusal and windows. Three things are proven here:
//   1. THE EDGES, written from the rule and the constants: the opening included, the deadline excluded, on a batch-0 board, on a later
//      batch's board (which opens AT its start, with no lead), and on an extended board whose deadline moved.
//   2. THE AGREEMENT: for every snapshot instant and every later instant, over every board state, the live answer equals the server's
//      rule asked at that later instant - the screen is never offering what the server would refuse, nor hiding what it would accept.
//   3. THE COUNT: the windows the Open round control is handed, counted at an instant, equal the boards the server's rule accepts then.
// Single-sport reason: no sport is involved - this is clock arithmetic on a board's anchor.
import { describe, expect, it } from "vitest";
import {
  CHECKIN_EXTEND_MAX,
  CHECKIN_EXTEND_STEP_MS,
  EXTEND_REFUSALS,
  EXTEND_WHY_KEYS,
  extendEdgesOf,
  extensionsLeft,
  inExtendWindow,
  liveExtendRefusal,
  liveExtendableCount,
  nextExtendEdge,
  watchedWindows,
  type CheckinExtendState,
} from "@/lib/checkin-extend";
import {
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_BATCH_SIZE,
  DEADLINE_AFTER_MS,
  WINDOW_OPEN_LEAD_MS,
  boardAnchor,
  extendRefusal,
  extendWindowOf,
  windowFor,
} from "@/server/external-play/window";

const O = new Date("2026-10-19T12:00:00.000Z");
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** What the server hands a screen for a board (arbiter.ts `checkinOf`) - the same three window.ts calls, at the snapshot's instant. */
function snapshot(a: { batch: number; extensions: number; playable: boolean; gameOnFile: boolean }, now: Date): CheckinExtendState {
  const anchor = boardAnchor(O, a.batch * CHECKIN_BATCH_SIZE, true, a.extensions * CHECKIN_EXTEND_STEP_MS);
  const refusal = extendRefusal({ now, anchor, extensions: a.extensions, playable: a.playable, gameOnFile: a.gameOnFile });
  const w = windowFor(anchor);
  return { canExtend: refusal === null, refusal, extensionsLeft: extensionsLeft(a.extensions), opensAt: w.opensAt.toISOString(), deadlineAt: w.deadline.toISOString() };
}

describe("liveExtendRefusal - the edges of the window, from the rule and the constants", () => {
  // Batch 0 opens WINDOW_OPEN_LEAD_MS before the round's open and closes DEADLINE_AFTER_MS after it; batch 2 opens AT O + 2 gaps (a
  // later batch has no lead) and closes DEADLINE_AFTER_MS after that. An extended board closes k steps later.
  const cases: { name: string; batch: number; extensions: number; opens: Date; closes: Date }[] = [
    { name: "batch 0", batch: 0, extensions: 0, opens: at(O, -WINDOW_OPEN_LEAD_MS), closes: at(O, DEADLINE_AFTER_MS) },
    { name: "batch 2 (opens AT its start)", batch: 2, extensions: 0, opens: at(O, 2 * CHECKIN_BATCH_GAP_MS), closes: at(O, 2 * CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS) },
    { name: "batch 0, twice extended", batch: 0, extensions: 2, opens: at(O, -WINDOW_OPEN_LEAD_MS), closes: at(O, DEADLINE_AFTER_MS + 2 * CHECKIN_EXTEND_STEP_MS) },
  ];

  it("one ms before the opening: not open; AT it: open; one ms before the deadline: open; AT it: closed - read from a snapshot taken long before", () => {
    let checked = 0;
    for (const c of cases) {
      // The snapshot was drawn a minute before the window opened: the server said `not_open`, and the screen has been showing that.
      const state = snapshot({ batch: c.batch, extensions: c.extensions, playable: true, gameOnFile: false }, at(c.opens, -60_000));
      expect(state.refusal, `${c.name}: premise: the snapshot said not_open`).toBe("not_open");
      expect(liveExtendRefusal(state, at(c.opens, -1).getTime()), `${c.name}: 1 ms before the opening`).toBe("not_open");
      expect(liveExtendRefusal(state, c.opens.getTime()), `${c.name}: AT the opening`).toBeNull();
      expect(liveExtendRefusal(state, at(c.closes, -1).getTime()), `${c.name}: 1 ms before the deadline`).toBeNull();
      expect(liveExtendRefusal(state, c.closes.getTime()), `${c.name}: AT the deadline`).toBe("closed");
      expect(liveExtendRefusal(state, at(c.closes, 60_000).getTime()), `${c.name}: a minute past it`).toBe("closed");
      checked += 5;
    }
    expect(checked, "anti-vacuity: 3 boards x 5 instants").toBe(15);
  });

  it("a snapshot that said the window was OPEN keeps saying so until the deadline, then closes - without a refresh", () => {
    const c = cases[0]!;
    const state = snapshot({ batch: 0, extensions: 0, playable: true, gameOnFile: false }, O);
    expect(state.canExtend).toBe(true);
    expect(liveExtendRefusal(state, at(c.closes, -1).getTime())).toBeNull();
    expect(liveExtendRefusal(state, c.closes.getTime())).toBe("closed");
  });

  it("what a clock cannot change stays the snapshot's word: a game on file, a board that is over, a snapshot that already said closed", () => {
    for (const [why, facts] of [
      ["game_started", { playable: true, gameOnFile: true }],
      ["not_playable", { playable: false, gameOnFile: false }],
    ] as const) {
      const state = snapshot({ batch: 0, extensions: 0, playable: facts.playable, gameOnFile: facts.gameOnFile }, O);
      expect(state.refusal).toBe(why);
      for (const t of [at(O, -WINDOW_OPEN_LEAD_MS - 1), at(O, 1), at(O, DEADLINE_AFTER_MS + 1)]) {
        expect(liveExtendRefusal(state, t.getTime()), `${why} at ${t.toISOString()}`).toBe(why);
      }
    }
    const closed = snapshot({ batch: 0, extensions: 0, playable: true, gameOnFile: false }, at(O, DEADLINE_AFTER_MS + 1));
    expect(closed.refusal).toBe("closed");
    expect(liveExtendRefusal(closed, at(O, 1).getTime()), "a clock running behind the server's cannot reopen a closed window").toBe("closed");
  });

  it("a board with no presses left is capped inside its window and closed outside it - and a not-yet-open one with none left is capped once it opens", () => {
    const capped = snapshot({ batch: 0, extensions: CHECKIN_EXTEND_MAX, playable: true, gameOnFile: false }, O);
    expect(capped.refusal).toBe("cap_reached");
    expect(liveExtendRefusal(capped, at(O, 1).getTime())).toBe("cap_reached");
    expect(liveExtendRefusal(capped, at(O, DEADLINE_AFTER_MS + CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS).getTime()), "closed outranks capped").toBe("closed");
    const early = snapshot({ batch: 2, extensions: CHECKIN_EXTEND_MAX, playable: true, gameOnFile: false }, O);
    expect(early.refusal, "premise: not open yet masks the cap").toBe("not_open");
    expect(liveExtendRefusal(early, at(O, 2 * CHECKIN_BATCH_GAP_MS).getTime()), "at its opening: capped, not extendable").toBe("cap_reached");
  });
});

describe("liveExtendRefusal agrees with the server's rule at every later instant", () => {
  it("for every board state, every snapshot instant and every later instant on a grid straddling both edges", () => {
    const states: { batch: number; extensions: number; playable: boolean; gameOnFile: boolean }[] = [];
    for (const batch of [0, 2]) {
      for (let extensions = 0; extensions <= CHECKIN_EXTEND_MAX; extensions++) {
        for (const playable of [true, false]) for (const gameOnFile of [false, true]) states.push({ batch, extensions, playable, gameOnFile });
      }
    }
    // The grid: both edges of every window in play, one ms either side of each, plus the middle of each.
    const edges = new Set<number>();
    for (const s of states) {
      const w = windowFor(boardAnchor(O, s.batch * CHECKIN_BATCH_SIZE, true, s.extensions * CHECKIN_EXTEND_STEP_MS));
      for (const e of [w.opensAt.getTime(), w.deadline.getTime()]) for (const d of [-1, 0, 1]) edges.add(e + d);
      edges.add(Math.floor((w.opensAt.getTime() + w.deadline.getTime()) / 2));
    }
    const grid = [...edges].sort((a, b) => a - b);
    let checked = 0;
    const seen = new Set<string>();
    for (const s of states) {
      for (let i = 0; i < grid.length; i++) {
        const state = snapshot(s, new Date(grid[i]!));
        for (let j = i; j < grid.length; j++) {
          const now = new Date(grid[j]!);
          const want = extendRefusal({
            now,
            anchor: boardAnchor(O, s.batch * CHECKIN_BATCH_SIZE, true, s.extensions * CHECKIN_EXTEND_STEP_MS),
            extensions: s.extensions,
            playable: s.playable,
            gameOnFile: s.gameOnFile,
          });
          expect(liveExtendRefusal(state, now.getTime()), `${JSON.stringify(s)} snapshot ${new Date(grid[i]!).toISOString()} now ${now.toISOString()}`).toBe(want);
          seen.add(String(want));
          checked += 1;
        }
      }
    }
    expect(checked, "anti-vacuity: the grid was walked").toBeGreaterThan(1000);
    expect([...seen].sort(), "every answer the rule can give was met, so the agreement is not trivially one answer").toEqual([...EXTEND_REFUSALS, "null"].sort());
  });
});

describe("the windows a round screen is handed, counted on a clock", () => {
  it("the count of windows holding an instant equals the boards the server's rule accepts at it - over a mixed round, at every edge", () => {
    // A mixed round: batch 0 open and plain, batch 0 extended once, a capped board, one with a game, a withdrawn one, a later batch.
    const boards = [
      { batch: 0, extensions: 0, playable: true, gameOnFile: false },
      { batch: 0, extensions: 1, playable: true, gameOnFile: false },
      { batch: 0, extensions: CHECKIN_EXTEND_MAX, playable: true, gameOnFile: false },
      { batch: 0, extensions: 0, playable: true, gameOnFile: true },
      { batch: 0, extensions: 0, playable: false, gameOnFile: false },
      { batch: 2, extensions: 0, playable: true, gameOnFile: false },
      { batch: 5, extensions: 2, playable: true, gameOnFile: false },
    ];
    const anchorOf = (b: (typeof boards)[number]) => boardAnchor(O, b.batch * CHECKIN_BATCH_SIZE, true, b.extensions * CHECKIN_EXTEND_STEP_MS);
    const edges = new Set<number>();
    for (const b of boards) {
      const w = windowFor(anchorOf(b));
      for (const e of [w.opensAt.getTime(), w.deadline.getTime()]) for (const d of [-1, 0, 1]) edges.add(e + d);
    }
    let checked = 0;
    const counts = new Set<number>();
    for (const t of [...edges].sort((a, b) => a - b)) {
      const now = new Date(t);
      const accepted = boards.filter((b) => extendRefusal({ now, anchor: anchorOf(b), extensions: b.extensions, playable: b.playable, gameOnFile: b.gameOnFile }) === null).length;
      // The windows are drawn at some EARLIER instant (the snapshot), and counted later: only the clock moves between.
      const snapAt = new Date(t - 90_000);
      const windows = boards.flatMap((b) => {
        const w = extendWindowOf({ now: snapAt, anchor: anchorOf(b), extensions: b.extensions, playable: b.playable, gameOnFile: b.gameOnFile });
        return w === null ? [] : [w];
      });
      expect(liveExtendableCount(windows, t), `at ${now.toISOString()}`).toBe(accepted);
      counts.add(accepted);
      checked += 1;
    }
    expect(checked, "anti-vacuity: instants counted").toBeGreaterThan(20);
    expect(counts.size, "the count moved as the clock did: it was not one number throughout").toBeGreaterThan(2);
  });

  it("a board nothing but the clock stands in the way of has a window; one the clock cannot help has none", () => {
    const anchor = boardAnchor(O, 0, true, 0);
    const base = { now: O, anchor, extensions: 0, playable: true, gameOnFile: false };
    expect(extendWindowOf(base)).toEqual({ opensAt: windowFor(anchor).opensAt.toISOString(), deadlineAt: windowFor(anchor).deadline.toISOString() });
    expect(extendWindowOf({ ...base, now: at(O, -2 * WINDOW_OPEN_LEAD_MS) }), "not open yet: the clock will open it").not.toBeNull();
    expect(extendWindowOf({ ...base, now: at(O, DEADLINE_AFTER_MS) }), "closed: nothing reopens it").toBeNull();
    expect(extendWindowOf({ ...base, gameOnFile: true }), "a game on file").toBeNull();
    expect(extendWindowOf({ ...base, playable: false }), "a board that is over").toBeNull();
    expect(extendWindowOf({ ...base, extensions: CHECKIN_EXTEND_MAX }), "no presses left").toBeNull();
  });

  it("inExtendWindow includes the opening and excludes the deadline", () => {
    const w = { opensAt: O.toISOString(), deadlineAt: at(O, 1000).toISOString() };
    expect([O.getTime() - 1, O.getTime(), O.getTime() + 999, O.getTime() + 1000].map((t) => inExtendWindow(w, t))).toEqual([false, true, true, false]);
  });
});

describe("the short reason shown in place of a missing +5 button", () => {
  it("every refusal has a table entry: four have words (the four the owner named) and a board that is over says nothing", () => {
    expect(Object.keys(EXTEND_WHY_KEYS).sort(), "the table is closed over the refusals").toEqual([...EXTEND_REFUSALS].sort());
    expect(EXTEND_WHY_KEYS.not_playable).toBeNull();
    const worded = EXTEND_REFUSALS.filter((r) => EXTEND_WHY_KEYS[r] !== null);
    expect(worded, "anti-vacuity: the four reasons").toHaveLength(4);
    expect(new Set(worded.map((r) => EXTEND_WHY_KEYS[r])).size, "each its own words").toBe(4);
  });
});

describe("the edges a screen schedules its next read on", () => {
  const W = (opens: number, closes: number) => ({ opensAt: new Date(opens).toISOString(), deadlineAt: new Date(closes).toISOString() });

  it("extendEdgesOf: every opening and deadline, sorted, each once; nothing for no windows", () => {
    expect(extendEdgesOf([]), "the empty case").toEqual([]);
    expect(extendEdgesOf([W(30, 50), W(10, 50), W(30, 90)])).toEqual([10, 30, 50, 90]);
  });

  it("nextExtendEdge: the first edge STRICTLY after now - an edge at now has happened - and null when all are behind", () => {
    const edges = [10, 30, 50];
    expect(nextExtendEdge([], 0), "the empty case").toBeNull();
    expect(nextExtendEdge(edges, 9)).toBe(10);
    expect(nextExtendEdge(edges, 10), "AT an edge: the next one").toBe(30);
    expect(nextExtendEdge(edges, 49)).toBe(50);
    expect(nextExtendEdge(edges, 50), "AT the last: none left").toBeNull();
    expect(nextExtendEdge(edges, 51)).toBeNull();
  });

  it("watchedWindows: only boards the CLOCK can still change - not a game, a finished board or a closed window", () => {
    const base = { extensionsLeft: 2, opensAt: "2026-10-19T12:00:00.000Z", deadlineAt: "2026-10-19T12:20:00.000Z" };
    const mk = (refusal: CheckinExtendState["refusal"]): CheckinExtendState => ({ ...base, canExtend: refusal === null, refusal });
    expect(watchedWindows([]), "the empty case").toEqual([]);
    expect(watchedWindows([null, mk("not_playable"), mk("game_started"), mk("closed")]), "settled by something a clock cannot move").toEqual([]);
    expect(watchedWindows([mk(null), mk("not_open"), mk("cap_reached"), null]), "clock-dependent").toHaveLength(3);
    expect(EXTEND_REFUSALS.length, "premise: five refusals, three settled").toBe(5);
  });
});
