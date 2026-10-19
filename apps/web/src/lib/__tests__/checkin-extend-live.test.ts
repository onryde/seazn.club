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
  EXTEND_ROUND_MIXED_WHY_KEY,
  EXTEND_WHY_KEYS,
  emptyExtendTally,
  extendEdgesOf,
  extensionsLeft,
  inExtendWindow,
  liveExtendRefusal,
  liveExtendableCount,
  liveRoundRefusals,
  nextExtendEdge,
  roundWhy,
  watchedWindows,
  type CheckinExtendState,
  type ExtendRefusal,
  type ExtendWindow,
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
    expect(extendWindowOf(base)).toEqual({
      opensAt: windowFor(anchor).opensAt.toISOString(),
      deadlineAt: windowFor(anchor).deadline.toISOString(),
      extensionsLeft: CHECKIN_EXTEND_MAX,
    });
    expect(extendWindowOf({ ...base, now: at(O, -2 * WINDOW_OPEN_LEAD_MS) }), "not open yet: the clock will open it").not.toBeNull();
    expect(extendWindowOf({ ...base, now: at(O, DEADLINE_AFTER_MS) }), "closed: nothing reopens it").toBeNull();
    expect(extendWindowOf({ ...base, gameOnFile: true }), "a game on file").toBeNull();
    expect(extendWindowOf({ ...base, playable: false }), "a board that is over").toBeNull();
    expect(extendWindowOf({ ...base, extensions: CHECKIN_EXTEND_MAX }), "no presses left: still a window (the clock still moves its verdict), with none left to give").toMatchObject({ extensionsLeft: 0 });
    expect(extendWindowOf({ ...base, extensions: CHECKIN_EXTEND_MAX, now: at(O, DEADLINE_AFTER_MS + CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS) }), "no presses left and closed").toBeNull();
  });

  it("inExtendWindow includes the opening and excludes the deadline", () => {
    const w = { opensAt: O.toISOString(), deadlineAt: at(O, 1000).toISOString(), extensionsLeft: 1 };
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
  const W = (opens: number, closes: number) => ({ opensAt: new Date(opens).toISOString(), deadlineAt: new Date(closes).toISOString(), extensionsLeft: 1 });

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

// ── the round's reason: what the round says where "+5 min to the round" is not offered (owner, 2026-10-19) ──────────────────────────
describe("roundWhy - one cause says its own words; a mix says the round's", () => {
  const SPOKEN = EXTEND_REFUSALS.filter((r) => EXTEND_WHY_KEYS[r] !== null);

  it("the empty cases first: a round that lists no boards, one whose every board is over, and one where a board would accept a press say nothing", () => {
    expect(roundWhy([]), "no boards").toBeNull();
    expect(roundWhy(["not_playable", "not_playable"]), "every board over").toBeNull();
    expect(roundWhy(["closed", null]), "a board would accept a press: the round has its button").toBeNull();
    expect(roundWhy([null]), "one extendable board").toBeNull();
    expect(roundWhy(["game_started", "closed", null]), "a mix with an extendable board").toBeNull();
  });

  it("ONE cause, however many boards give it, is that cause's own words - and boards that are over do not make it a mix", () => {
    let checked = 0;
    for (const r of SPOKEN) {
      for (const boards of [[r], [r, r, r], [r, "not_playable"], ["not_playable", r, r]] as ExtendRefusal[][]) {
        expect(roundWhy(boards), `${r} x ${boards.length}`).toEqual({ code: r, key: EXTEND_WHY_KEYS[r] });
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 causes x 4 rounds").toBe(16);
  });

  it("TWO causes, every pair of the four, in either order, is the one sentence true of all of them: 'No board can be extended right now'", () => {
    let pairs = 0;
    for (const a of SPOKEN) {
      for (const b of SPOKEN) {
        if (a === b) continue;
        expect(roundWhy([a, b]), `${a} + ${b}`).toEqual({ code: "mixed", key: EXTEND_ROUND_MIXED_WHY_KEY });
        pairs += 1;
      }
    }
    expect(pairs, "anti-vacuity: 4 x 3 ordered pairs").toBe(12);
    expect(roundWhy(["game_started", "closed", "not_playable", "cap_reached"])?.code, "three causes and a board that is over").toBe("mixed");
  });
});

describe("liveRoundRefusals - the Open round control's reading of its two facts, on a clock", () => {
  const w = (opens: number, closes: number, left = CHECKIN_EXTEND_MAX): ExtendWindow => ({ opensAt: new Date(opens).toISOString(), deadlineAt: new Date(closes).toISOString(), extensionsLeft: left });

  it("the empty case, and the tally expanded one entry per board", () => {
    expect(liveRoundRefusals(emptyExtendTally(), [], 5), "no boards").toEqual([]);
    const tally = { ...emptyExtendTally(), game_started: 2, closed: 1 };
    expect(liveRoundRefusals(tally, [], null).sort(), "a tally of three boards is three refusals").toEqual(["closed", "game_started", "game_started"]);
  });

  it("a window board follows the clock: not_open one ms before its opening, extendable AT it and until the last ms, closed AT its deadline", () => {
    const win = w(1000, 2000);
    const at = (t: number) => liveRoundRefusals(emptyExtendTally(), [win], t);
    expect([at(999), at(1000), at(1999), at(2000), at(5000)]).toEqual([["not_open"], [null], [null], ["closed"], ["closed"]]);
  });

  it("a window board with no press left is capped inside its window, closed from its deadline on, and not_open before it - never extendable", () => {
    const win = w(1000, 2000, 0);
    const at = (t: number) => liveRoundRefusals(emptyExtendTally(), [win], t);
    expect([at(999), at(1000), at(1999), at(2000)]).toEqual([["not_open"], ["cap_reached"], ["cap_reached"], ["closed"]]);
  });

  it("before the viewer's clock is known the windows read as the snapshot saw them: not_open, or capped when none is left", () => {
    expect(liveRoundRefusals(emptyExtendTally(), [w(1000, 2000), w(1000, 2000, 0)], null)).toEqual(["not_open", "cap_reached"]);
  });
});

describe("the arbiter panel's reading and the Open round control's reading of the same round are one reading, and both are the server's", () => {
  type B = { batch: number; extensions: number; playable: boolean; gameOnFile: boolean };
  const open: B = { batch: 0, extensions: 0, playable: true, gameOnFile: false };
  const ROUNDS: Record<string, B[]> = {
    "mixed (open, extended, capped, started, over, two later batches)": [
      open,
      { ...open, extensions: 1 },
      { ...open, extensions: CHECKIN_EXTEND_MAX },
      { ...open, gameOnFile: true },
      { ...open, playable: false },
      { ...open, batch: 2 },
      { ...open, batch: 5, extensions: 2 },
    ],
    "every board capped": [{ ...open, extensions: CHECKIN_EXTEND_MAX }, { ...open, extensions: CHECKIN_EXTEND_MAX }],
    "every board has a game": [{ ...open, gameOnFile: true }, { ...open, gameOnFile: true, batch: 2 }],
    "every board over": [{ ...open, playable: false }, { ...open, playable: false, batch: 2 }],
    "later batches only": [{ ...open, batch: 3 }, { ...open, batch: 5 }],
    "no boards": [],
  };
  const anchorOf = (b: B) => boardAnchor(O, b.batch * CHECKIN_BATCH_SIZE, true, b.extensions * CHECKIN_EXTEND_STEP_MS);
  const truth = (b: B, now: Date) => extendRefusal({ now, anchor: anchorOf(b), extensions: b.extensions, playable: b.playable, gameOnFile: b.gameOnFile });

  it("at every instant from the snapshot on, over every round: the three agree on the sentence, and the control's two facts cover every board once", () => {
    let checked = 0;
    const seen = new Set<string>();
    for (const [name, boards] of Object.entries(ROUNDS)) {
      const edges = new Set<number>();
      for (const b of boards) {
        const win = windowFor(anchorOf(b));
        for (const e of [win.opensAt.getTime(), win.deadline.getTime()]) for (const d of [-1, 0, 1]) edges.add(e + d);
      }
      const grid = [O.getTime() - 3 * WINDOW_OPEN_LEAD_MS, ...[...edges].sort((a, b) => a - b), O.getTime() + 2 * 60 * 60_000];
      // The snapshot: drawn at the first instant, as the server's `extendReach` draws it (windows for what only the clock decides, the
      // rest counted by the reason given); the arbiter's panel is handed each board's own state.
      const snapAt = new Date(grid[0]!);
      const states = boards.map((b) => snapshot(b, snapAt));
      const windows: ExtendWindow[] = [];
      const tally = emptyExtendTally();
      for (const b of boards) {
        const win = extendWindowOf({ now: snapAt, anchor: anchorOf(b), extensions: b.extensions, playable: b.playable, gameOnFile: b.gameOnFile });
        const refusal = truth(b, snapAt);
        if (win !== null) windows.push(win);
        else tally[refusal!] += 1;
      }
      expect(windows.length + Object.values(tally).reduce((a, n) => a + n, 0), `${name}: every board is in the windows or the tally, once`).toBe(boards.length);
      for (const t of grid) {
        const now = new Date(t);
        const want = roundWhy(boards.map((b) => truth(b, now)));
        const arbiter = roundWhy(states.map((c) => liveExtendRefusal(c, t)));
        const control = roundWhy(liveRoundRefusals(tally, windows, t));
        expect(arbiter, `${name} @ ${now.toISOString()}: the arbiter panel`).toEqual(want);
        expect(control, `${name} @ ${now.toISOString()}: the Open round control`).toEqual(want);
        seen.add(want === null ? "none" : want.code);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: instants x rounds").toBeGreaterThan(60);
    expect([...seen].sort(), "every sentence the round can say was met, and the silent ones too").toEqual(["cap_reached", "closed", "game_started", "mixed", "none", "not_open"].sort());
  });
});
