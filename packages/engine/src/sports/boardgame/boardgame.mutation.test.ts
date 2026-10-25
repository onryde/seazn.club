// Board-game mutation-debt tests — the survivors a Stryker run left in boardgame.ts: refusal messages and data,
// the fold's key-absence contract, the declarations a pad/standings table reads, and the stats fold's skip guards.
// The module serves chess, draughts, go, carrom and generic 1-v-1 sports; colours-on (chess/draughts) and
// colours-off (go/carrom/generic) and a non-default points scheme are both driven where the answer differs.
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { EngineError } from "../../core/errors.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import type { MatchOutcome, StageCtx } from "../../core/types.ts";
import type { PlayerStatsFoldCtx } from "../../stats/stats.ts";
import {
  boardgame,
  BOARDGAME_TIEBREAKERS,
  BoardgamePairing,
  BoardgameResult,
  padSpec,
  type BoardgameState,
} from "./boardgame.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;
const lineups = defaultLineupPair(boardgame.positions); // entrants H / A
const cfg = boardgame.configSchema.parse({});
const noColours = boardgame.configSchema.parse({ colors: false });
const league: StageCtx = { kind: "league" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}
function fold(events: EventEnvelope[], config = cfg): BoardgameState {
  return foldMatch(boardgame, config, lineups, events, STRICT_ALL);
}
const applyEv = (state: BoardgameState, type: string, payload: unknown = {}): BoardgameState =>
  boardgame.apply(state, makeEnvelope(9, { type, payload }) as EventEnvelope<CoreEv>, { strictFromSeq: 0 } as never);
function refusal(run: () => unknown): EngineError {
  try {
    run();
  } catch (error) {
    return error as EngineError;
  }
  throw new Error("expected the call to be refused");
}
const live = (config = cfg): BoardgameState => fold(stream(["core.start"]), config);
const decided = fold(stream(["core.start"], ["boardgame.result", { winner: "H", method: "resign" }]));
const finalState = fold(stream(["core.start"], ["boardgame.result", { winner: "H", method: "resign" }], ["core.finalize"]));
const abandoned = fold(stream(["core.start"], ["core.abandon", { reason: "power cut" }]));

describe("boardgame: the schemas refuse an all-undefined card by name", () => {
  it("a result whose every key is undefined records no fact", () => {
    for (const payload of [{}, { winner: undefined }, { method: undefined, moves: undefined }]) {
      const r = BoardgameResult.safeParse(payload);
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.message)).toEqual(["a result must record at least one fact"]);
    }
    expect(BoardgameResult.safeParse({ moves: 0 }).success).toBe(true); // one real fact (0 is a fact) passes
  });

  it("a pairing card whose every key is undefined records no fact", () => {
    for (const payload of [{}, { board: undefined }, { white: undefined, homePerson: undefined }]) {
      const r = BoardgamePairing.safeParse(payload);
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.message)).toEqual(["a pairing card must record at least one fact"]);
    }
    expect(BoardgamePairing.safeParse({ board: 1 }).success).toBe(true);
  });
});

describe("boardgame: refusals say what was refused, and carry their data", () => {
  it("a result outside live is WRONG_PHASE naming the phase", () => {
    const pre = boardgame.init(cfg, lineups);
    for (const [state, phase] of [[pre, "pre"], [decided, "done"], [finalState, "final"]] as const) {
      const e = refusal(() => applyEv(state, "boardgame.result", { winner: "H" }));
      expect(e.code).toBe("WRONG_PHASE");
      expect(e.message).toBe(`result not allowed in phase "${phase}"`);
    }
  });

  it("a named person on a drawn result is refused with the person in its data", () => {
    const e = refusal(() => applyEv(live(), "boardgame.result", { winner: null, method: "agreement", winnerPerson: "H-p1" }));
    expect(e.code).toBe("INVALID_EVENT");
    expect(e.message).toBe("winnerPerson requires a decisive winner");
    expect(e.data).toEqual({ winnerPerson: "H-p1" });
  });

  it("an entrant outside the lineup is refused by name, in a result and in a pairing card", () => {
    for (const run of [
      () => applyEv(live(), "boardgame.result", { winner: "Z", method: "resign" }),
      () => applyEv(live(), "boardgame.pairing", { white: "Z" }),
    ]) {
      const e = refusal(run);
      expect(e.code).toBe("INVALID_EVENT");
      expect(e.message).toBe('unknown entrant "Z"');
      expect(e.data).toEqual({ entrantId: "Z" });
    }
  });

  it("a payload that fails its schema is refused naming the event type, with the issues", () => {
    const tiebreakState = fold(
      stream(["core.start"], ["boardgame.result", { winner: null, method: "agreement" }]),
      boardgame.configSchema.parse({ ...boardgame.bracketDeciders(cfg) }),
    );
    expect(tiebreakState.phase).toBe("tiebreak"); // the third type needs its phase to reach the parse
    const cases: Array<[BoardgameState, string, unknown]> = [
      [live(), "boardgame.result", { winner: "H", method: "not-a-method" }],
      [live(), "boardgame.pairing", { board: 0 }],
      [tiebreakState, "boardgame.tiebreak", { rung: "rapid" }],
    ];
    for (const [state, type, payload] of cases) {
      const e = refusal(() => applyEv(state, type, payload));
      expect(e.code, type).toBe("INVALID_EVENT");
      expect(e.message, type).toBe(`invalid ${type} payload`);
      const issues = (e.data as { issues: unknown[] }).issues;
      expect(Array.isArray(issues) && issues.length > 0, type).toBe(true);
    }
  });

  it("a pairing card outside pre/live is WRONG_PHASE naming the phase", () => {
    for (const [state, phase] of [[decided, "done"], [finalState, "final"], [abandoned, "abandoned"]] as const) {
      const e = refusal(() => applyEv(state, "boardgame.pairing", { board: 1 }));
      expect(e.code).toBe("WRONG_PHASE");
      expect(e.message).toBe(`pairing not allowed in phase "${phase}"`);
    }
    // the positive pair: pre and live both accept one
    expect(applyEv(boardgame.init(cfg, lineups), "boardgame.pairing", { board: 3 }).board).toBe(3);
    expect(applyEv(live(), "boardgame.pairing", { board: 4 }).board).toBe(4);
  });

  it("a colour on a no-colours division is refused (write path) with the entrant in its data, and kept on replay", () => {
    const e = refusal(() => fold(stream(["boardgame.pairing", { white: "H" }]), noColours));
    expect(e.code).toBe("INVALID_EVENT");
    expect(e.message).toBe("this division plays without colours");
    expect(e.data).toEqual({ white: "H" });
    // replay (no strict option) must keep reading the recorded fact: the switch only governs the write path
    const replayed = foldMatch(boardgame, noColours, lineups, stream(["boardgame.pairing", { white: "A" }]));
    expect(replayed.colorOfHome).toBe("B");
  });

  it("core.start twice, or after the game, is WRONG_PHASE", () => {
    for (const state of [live(), decided, finalState, abandoned]) {
      const e = refusal(() => applyEv(state, "core.start"));
      expect(e.code).toBe("WRONG_PHASE");
      expect(e.message).toBe("already started");
    }
  });

  it("core.abandon is refused in each over-phase and accepted in pre and live", () => {
    for (const state of [decided, finalState, abandoned]) {
      const e = refusal(() => applyEv(state, "core.abandon", { reason: "power cut" }));
      expect(e.code).toBe("WRONG_PHASE");
      expect(e.message).toBe("match already over");
    }
    for (const state of [boardgame.init(cfg, lineups), live()]) {
      const out = applyEv(state, "core.abandon", { reason: "power cut" });
      expect(out.phase).toBe("abandoned");
      expect(out.replayFlagged).toBe(true);
    }
  });

  it("core.finalize on an undecided fixture is WRONG_PHASE; a decided one finalizes", () => {
    const e = refusal(() => applyEv(live(), "core.finalize"));
    expect(e.code).toBe("WRONG_PHASE");
    expect(e.message).toBe("cannot finalize an undecided fixture");
    expect(applyEv(decided, "core.finalize").phase).toBe("final");
  });

  it("core.note and core.award change nothing (PGN upload rides them), in every phase", () => {
    for (const state of [boardgame.init(cfg, lineups), live(), decided]) {
      for (const type of ["core.note", "core.award"]) expect(applyEv(state, type, { text: "1. e4" }), type).toBe(state);
    }
  });

  it("an event type the module does not know is INVALID_EVENT naming it", () => {
    const e = refusal(() => applyEv(live(), "boardgame.bogus"));
    expect(e.code).toBe("INVALID_EVENT");
    expect(e.message).toBe('unknown event type "boardgame.bogus"');
  });
});

describe("boardgame: what a result and a pairing card write into state", () => {
  it("a decisive result with no method is a regulation win; a named method is kept", () => {
    const bare = fold(stream(["core.start"], ["boardgame.result", { winner: "A" }]));
    expect(bare.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
    expect(bare.method).toBeNull();
    expect(fold(stream(["core.start"], ["boardgame.result", { winner: "A", method: "time" }])).outcome).toMatchObject({ method: "time" });
  });

  it("a result without moves/winnerPerson leaves those keys out of state; with them, writes them", () => {
    const bare = fold(stream(["core.start"], ["boardgame.result", { winner: "H", method: "resign" }]));
    expect(Object.keys(bare)).not.toContain("moves");
    expect(Object.keys(bare)).not.toContain("winnerPerson");
    const full = fold(stream(["core.start"], ["boardgame.result", { winner: "H", method: "resign", moves: 31, winnerPerson: "H-p1" }]));
    expect(full).toMatchObject({ moves: 31, winnerPerson: "H-p1" });
    const onlyMoves = fold(stream(["core.start"], ["boardgame.result", { winner: null, method: "agreement", moves: 40 }]));
    expect(onlyMoves.moves).toBe(40);
    expect(Object.keys(onlyMoves)).not.toContain("winnerPerson");
  });

  it("the legacy forfeit methods mark the game forfeited; every other method does not", () => {
    const f = (payload: unknown) => fold(stream(["core.start"], ["boardgame.result", payload])).forfeited;
    expect(f({ winner: "H", method: "forfeit" })).toBe(true);
    expect(f({ winner: null, method: "double_forfeit" })).toBe(true);
    for (const payload of [{ winner: "H", method: "resign" }, { winner: null, method: "agreement" }, { winner: "H" }]) {
      expect(f(payload), JSON.stringify(payload)).toBe(false);
    }
  });

  it("a pairing card writes only the facts it carries (golden-safe: absent keys stay absent)", () => {
    const pre = boardgame.init(cfg, lineups);
    const onlyColour = applyEv(pre, "boardgame.pairing", { white: "A" });
    expect(onlyColour.colorOfHome).toBe("B");
    expect(Object.keys(onlyColour)).not.toContain("players");
    expect(Object.keys(onlyColour)).not.toContain("board");

    const onlyBoard = applyEv(pre, "boardgame.pairing", { board: 7 });
    expect(onlyBoard.board).toBe(7);
    expect(Object.keys(onlyBoard)).not.toContain("players");

    const onlyHome = applyEv(pre, "boardgame.pairing", { homePerson: "H-p1" });
    expect(onlyHome.players).toStrictEqual({ home: "H-p1" });
    expect(Object.keys(onlyHome)).not.toContain("board");
    const onlyAway = applyEv(pre, "boardgame.pairing", { awayPerson: "A-p1" });
    expect(onlyAway.players).toStrictEqual({ away: "A-p1" });

    // a second card merges into the first rather than replacing it
    const both = applyEv(onlyHome, "boardgame.pairing", { awayPerson: "A-p1", board: 2 });
    expect(both.players).toStrictEqual({ home: "H-p1", away: "A-p1" });
    expect(both.board).toBe(2);
  });

  it("the summary detail carries only the facts recorded, and all of them once recorded", () => {
    const bare = boardgame.summary(boardgame.init(cfg, lineups)).detail as Record<string, unknown>;
    expect(Object.keys(bare).sort()).toEqual(["colorOfHome"]); // colours on; nothing else was recorded
    const noColour = boardgame.summary(boardgame.init(noColours, lineups)).detail as Record<string, unknown>;
    expect(Object.keys(noColour)).toEqual([]);

    const full = fold(
      stream(
        ["core.start"],
        ["boardgame.pairing", { homePerson: "H-p1", awayPerson: "A-p1", board: 5 }],
        ["boardgame.result", { winner: "H", method: "checkmate", moves: 28, winnerPerson: "H-p1" }],
      ),
    );
    expect(boardgame.summary(full).detail).toStrictEqual({
      method: "checkmate",
      colorOfHome: "W",
      players: { home: "H-p1", away: "A-p1" },
      board: 5,
      moves: 28,
      winnerPerson: "H-p1",
    });
    // an abandoned game flags itself
    expect(boardgame.summary(abandoned).detail).toMatchObject({ abandoned: true });
  });
});

describe("boardgame: colour history, colours on and off", () => {
  it("with colours off neither side holds a colour (the away side too)", () => {
    const state = fold(stream(["core.start"], ["boardgame.result", { winner: "H", method: "resign" }]), noColours);
    const [home, away] = boardgame.standingsDelta(state.outcome!, noColours, league, state);
    expect(home.metrics).toEqual({ wins: 1, white: 0, black: 0 });
    expect(away.metrics).toEqual({ wins: 0, white: 0, black: 0 });
  });

  it("a legacy forfeit result is out of colour history on both sides while colours are on", () => {
    const state = fold(stream(["core.start"], ["boardgame.result", { winner: "A", method: "forfeit" }]));
    expect(state.colorOfHome).toBe("W"); // colours ARE on: the exclusion is the forfeit's, not the cfg's
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect(home.metrics).toEqual({ wins: 0, white: 0, black: 0 });
    expect(away.metrics).toEqual({ wins: 1, white: 0, black: 0 });
  });

  it("the positive pair: a played decisive game books White to one side and Black to the other, by pairing", () => {
    const state = fold(
      stream(["core.start"], ["boardgame.pairing", { white: "A" }], ["boardgame.result", { winner: "H", method: "resign" }]),
    );
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect(home.metrics).toEqual({ wins: 1, white: 0, black: 1 });
    expect(away.metrics).toEqual({ wins: 0, white: 1, black: 0 });
  });
});

describe("boardgame: standingsDelta for an outcome nobody played out", () => {
  const fresh = boardgame.init(cfg, lineups);

  it("no_result ranks both sides a played game with nothing won, drawn, lost or scored", () => {
    const [home, away] = boardgame.standingsDelta({ kind: "no_result" }, cfg, league, fresh);
    expect(home).toEqual({ entrantId: "H", played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: { wins: 0, white: 1, black: 0 } });
    expect(away).toEqual({ entrantId: "A", played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: { wins: 0, white: 0, black: 1 } });
  });

  it("an outcome the module cannot rank is refused naming its kind", () => {
    const e = refusal(() => boardgame.standingsDelta({ kind: "tie" } as MatchOutcome, cfg, league, fresh));
    expect(e.code).toBe("INVALID_EVENT");
    expect(e.message).toBe('board-game module cannot rank outcome "tie"');
  });
});

describe("boardgame: declarations a table and a pad read", () => {
  it("the Swiss cascade is the full FIDE order (chess.md §4)", () => {
    expect(BOARDGAME_TIEBREAKERS).toEqual(["points", "buchholz_cut1", "buchholz", "sberger", "direct", "wins", "lots"]);
    expect(boardgame.defaultTiebreakers).toEqual(BOARDGAME_TIEBREAKERS);
  });

  it("the standings metrics: wins is shown, the colour tallies are pairing metadata and hidden", () => {
    expect(boardgame.metrics).toEqual([
      { key: "wins", label: "Wins", direction: "desc" },
      { key: "white", label: "Games as White", direction: "desc", display: false },
      { key: "black", label: "Games as Black", direction: "desc", display: false },
    ]);
  });

  it("declaredPointsSets is {win+loss, 2*draw, 0} (spec 04 §9.3) for a scheme where win+loss differs from win-loss", () => {
    const scheme = boardgame.configSchema.parse({ scoring: { win: 3, draw: 1, loss: 1 } });
    expect([...boardgame.declaredPointsSets(scheme)].sort((a, b) => a - b)).toEqual([0, 2, 4]);
    expect([...boardgame.declaredPointsSets(cfg)].sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it("the three clock families are presets over `variant` only", () => {
    expect(boardgame.variants).toEqual({
      classical: { variant: "classical" },
      rapid: { variant: "rapid" },
      blitz: { variant: "blitz" },
    });
    for (const [name, overlay] of Object.entries(boardgame.variants)) {
      expect(boardgame.configSchema.parse(overlay).variant, name).toBe(name);
    }
  });

  it("the person-credit declarations carry their labels", () => {
    const stats = boardgame.playerStats!;
    expect(stats.metrics.map((m) => [m.key, m.label, m.field])).toEqual([
      ["games", "Games", "homePerson"],
      ["games", "Games", "awayPerson"],
      ["wins", "Wins", "winnerPerson"],
    ]);
    const folded = stats.folded!.keys;
    expect(folded).toEqual([
      { key: "draws", label: "Draws" },
      { key: "losses", label: "Losses" },
      { key: "white", label: "Games as White" },
      { key: "black", label: "Games as Black" },
      { key: "wins", label: "Wins" },
    ]);
    // one word choice per concept: the folded colour labels are the standings metrics' own
    for (const key of ["white", "black"]) {
      expect(folded.find((k) => k.key === key)?.label, key).toBe(boardgame.metrics.find((m) => m.key === key)?.label);
    }
  });
});

describe("boardgame padSpec: what each panel and action declares", () => {
  const actionsOf = (spec: ReturnType<typeof padSpec>) => spec.panels.map((p) => p.actions);

  it("colours on: pre-match pairing card, decisive result, drawn result", () => {
    const spec = padSpec(cfg);
    expect(spec.panels).toHaveLength(3);
    expect(spec.panels[0]).toMatchObject({
      labelKey: { key: "pad.boardgame.panel.pre", label: "Pre-match" },
      phase: "pre",
      layout: "primary",
      actions: [
        {
          type: "boardgame.pairing",
          labelKey: { key: "pad.boardgame.action.pairing", label: "Pairing card" },
          fields: [{ kind: "number", path: "board", min: 1 }],
          attribution: [
            { kind: "side", path: "white" },
            { kind: "person", path: "homePerson" },
            { kind: "person", path: "awayPerson" },
          ],
        },
      ],
    });
    expect(spec.panels[1]).toMatchObject({
      labelKey: { key: "pad.boardgame.panel.result", label: "Result" },
      phase: "live",
      layout: "primary",
      actions: [
        {
          type: "boardgame.result",
          labelKey: { key: "pad.boardgame.action.result", label: "Result" },
          fields: [{ kind: "enum", path: "method" }],
          attribution: [
            { kind: "side", path: "winner" },
            { kind: "person", path: "winnerPerson" },
          ],
        },
      ],
    });
    expect(spec.panels[2]).toMatchObject({
      labelKey: { key: "pad.boardgame.panel.draw", label: "Draw / no result" },
      phase: "live",
      layout: "grid",
      actions: [
        {
          type: "boardgame.result",
          labelKey: { key: "pad.boardgame.action.draw", label: "Draw / no result" },
          fields: [{ kind: "enum", path: "method" }],
          attribution: [],
        },
      ],
    });
    // no tie-break overlay: no panel is gated
    for (const panel of spec.panels) expect(panel.gate, panel.labelKey.key).toBeUndefined();
  });

  it("colours off (go / carrom / generic): the pairing card names the two people and no colour", () => {
    const spec = padSpec(noColours);
    expect(actionsOf(spec)[0]).toMatchObject([
      {
        type: "boardgame.pairing",
        attribution: [
          { kind: "person", path: "homePerson" },
          { kind: "person", path: "awayPerson" },
        ],
      },
    ]);
    // the rest of the spec does not depend on colours
    expect(spec.panels.map((p) => p.labelKey.key)).toEqual(padSpec(cfg).panels.map((p) => p.labelKey.key));
  });
});

describe("boardgame stats fold: an event it must not credit", () => {
  const ctx: PlayerStatsFoldCtx = {
    entrants: [
      { id: "H", kind: "individual" },
      { id: "A", kind: "individual" },
    ],
    personsOf: (id) => (id === "H" ? ["H-p1"] : id === "A" ? ["A-p1"] : []),
  };
  const folded = (events: EventEnvelope[]) => boardgame.playerStats!.folded!.fold(events, ctx);

  it("positive pair: a decisive result credits the loser", () => {
    expect(folded(stream(["core.start"], ["boardgame.result", { winner: "H", method: "resign" }]))).toEqual([
      { personId: "A-p1", stats: { losses: 1 } },
    ]);
  });

  it("an event of another type is not read as a result, even carrying a valid result payload", () => {
    expect(folded(stream(["core.start"], ["core.note", { winner: "H", method: "checkmate" }]))).toEqual([]);
  });

  it("a result that fails its schema is skipped, not thrown on", () => {
    expect(folded(stream(["core.start"], ["boardgame.result", { winner: "H", method: "not-a-method" }]))).toEqual([]);
  });

  it("a draw (winner null or omitted) credits both rosters a draw and nobody a loss", () => {
    for (const payload of [{ winner: null, method: "agreement" }, { method: "stalemate" }]) {
      expect(folded(stream(["core.start"], ["boardgame.result", payload])), JSON.stringify(payload)).toEqual([
        { personId: "H-p1", stats: { draws: 1 } },
        { personId: "A-p1", stats: { draws: 1 } },
      ]);
    }
  });

  it("a double forfeit (winner null or omitted) credits nobody", () => {
    for (const payload of [{ winner: null, method: "double_forfeit" }, { method: "double_forfeit" }]) {
      expect(folded(stream(["core.start"], ["boardgame.result", payload])), JSON.stringify(payload)).toEqual([]);
    }
  });
});
