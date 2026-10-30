// Pad wave P3.2 - `tennisPadRules`, the tennis record of `@seazn/engine/pad`.
//
// Tennis only, by design: it is the nested kernel's one preset (tennis.ts), so there is no other sport to sweep.
//
// Each field is checked against something it does not compute: the zod enums and padSpec fields the fold and the pad
// conformance suite read (toBe where the record IS that object), the strict fold's own refusals (a set score that needs its
// tie-break, a game award inside a breaker), and the ITF Rules of Tennis written out as the rule text says them, never as the
// formula under test (Rule 5 for the calls and the tie-break serve, Rule 10 for the change of ends). Every sweep counts what it
// compared and fails on zero.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import type { ModuleEvent, PadSpec } from "../sport/module.ts";
import {
  NestedInterruptionKind,
  NestedPointKind,
  NestedPointMeta,
  NestedSanctionLevel,
  PLAUSIBLE_INTERRUPTION_SECONDS,
  POINT_CALLS,
  type NestedCfg,
  type NestedState,
} from "../sports/nested/kernel.ts";
import { tennis } from "../sports/tennis/tennis.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { padEnumValues, padNumberBound, tennisPadRules } from "./index.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;
const H = "H";
const A = "A";
type Side = "home" | "away";
const singles: LineupPair = defaultLineupPair(tennis.positions);

const start: ModuleEvent = { type: "core.start", payload: {} };
const point = (side: Side): ModuleEvent => ({ type: "tennis.point", payload: { by: side === "home" ? H : A } });
const summary = (home: number, away: number): ModuleEvent => ({ type: "tennis.set_summary", payload: { home, away } });
const gameAward = (side: Side): ModuleEvent => ({ type: "tennis.game.award", payload: { winner: side === "home" ? H : A } });

const envelopes = (events: readonly ModuleEvent[]): EventEnvelope[] => events.map((event, i) => makeEnvelope(i, event));
const fold = (cfg: NestedCfg, events: readonly ModuleEvent[]): NestedState =>
  foldMatch(tennis, cfg, singles, envelopes(events), STRICT_ALL);

/** What the strict fold says to `events`: the state, or the refusal's code and message. */
function attempt(cfg: NestedCfg, events: readonly ModuleEvent[]): { ok: true; state: NestedState } | { ok: false; code: string; message: string } {
  try {
    return { ok: true, state: fold(cfg, events) };
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return { ok: false, code: error.code, message: error.message };
  }
}

const parse = (raw: unknown): NestedCfg => tennis.configSchema.parse(raw);

/** A sweep reports what it compared; the same count is asserted non-zero beside each report. */
function report(line: string): void {
  // eslint-disable-next-line no-console -- the sweep reports what it checked; the same counts are asserted beside it
  console.info(`[pad/tennis] ${line}`);
}
const specOf = (cfg: NestedCfg): PadSpec => {
  if (tennis.padSpec === undefined) throw new Error("premise: tennis declares a padSpec");
  return tennis.padSpec(cfg);
};

/** Every cfg tennis declares, plus the shapes no variant ships: an advantage set (no tie-break, so no games ceiling) and a
 *  short set whose decider plays its tie-break to 10 (the two tie-break margins in one match). */
function cfgsUnderTest(): { name: string; cfg: NestedCfg }[] {
  const declared = declaredCfgs<NestedCfg>(tennis);
  const variants = tennis.variants;
  return [
    ...declared,
    { name: "advantage sets", cfg: parse({ set: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 } }) },
    { name: "short sets + a final-set tie-break to 10", cfg: parse({ ...variants["short-sets"], finalSet: { tiebreakTo: 10 } }) },
  ];
}

describe("tennisPadRules: the vocabularies are the fold's own enums", () => {
  it("pointKinds, interruptionKinds and sanctionLevels are the zod enums the event schemas parse with", () => {
    expect(tennisPadRules.pointKinds).toBe(NestedPointKind.options);
    expect(tennisPadRules.interruptionKinds).toBe(NestedInterruptionKind.options);
    expect(tennisPadRules.sanctionLevels).toBe(NestedSanctionLevel.options);
    // NestedPointMeta.kind is that same enum (optional), so a kind the record lists is a kind the point schema takes, and no other
    let parsed = 0;
    for (const kind of tennisPadRules.pointKinds) {
      expect(NestedPointMeta.safeParse({ kind }).success, kind).toBe(true);
      parsed++;
    }
    expect(NestedPointMeta.safeParse({ kind: "let" }).success, "a kind the enum does not declare").toBe(false);
    expect(parsed).toBe(4);
  });

  it("they equal the padSpec fields the pad renders, for every cfg (counted)", () => {
    let compared = 0;
    for (const { name, cfg } of cfgsUnderTest()) {
      const spec = specOf(cfg);
      expect(padEnumValues(spec, "tennis.point", "meta.kind"), name).toEqual(tennisPadRules.pointKinds);
      expect(padEnumValues(spec, "tennis.interruption", "kind"), name).toEqual(tennisPadRules.interruptionKinds);
      expect(padEnumValues(spec, "tennis.sanction", "level"), name).toEqual(tennisPadRules.sanctionLevels);
      compared += 3;
    }
    report(`vocabulary facts compared: ${compared}`);
    expect(compared).toBe(cfgsUnderTest().length * 3);
    expect(compared).toBeGreaterThanOrEqual(3 * 8);
  });

  it("the ladder is the ITF Code of Conduct's point penalty schedule, in order (warning, point, game, default)", () => {
    expect(tennisPadRules.sanctionLevels).toEqual(["warning", "point_penalty", "game_penalty", "default"]);
  });
});

describe("tennisPadRules.eventBands", () => {
  it("is the very fidelity map every cfg's padSpec carries, one band per event type the module registers", () => {
    let cfgs = 0;
    for (const { name, cfg } of cfgsUnderTest()) {
      expect(specOf(cfg).fidelity, name).toBe(tennisPadRules.eventBands);
      cfgs++;
    }
    expect(Object.keys(tennisPadRules.eventBands).sort()).toEqual(Object.keys(tennis.eventSchemas ?? {}).sort());
    expect(Object.keys(tennisPadRules.eventBands)).toHaveLength(5);
    expect(cfgs).toBeGreaterThanOrEqual(2);
  });
});

describe("tennisPadRules.interruptionMaxSeconds", () => {
  it("is the kernel's plausibility sentinel, the bound of the padSpec duration field for every cfg", () => {
    expect(tennisPadRules.interruptionMaxSeconds).toBe(PLAUSIBLE_INTERRUPTION_SECONDS);
    // one hour: no ITF rule sets it (the allowances themselves are recorded, never refused), so it is pinned as the kernel's
    // documented design value, and moving it is a reviewed decision rather than a silent one
    expect(tennisPadRules.interruptionMaxSeconds).toBe(60 * 60);
    let compared = 0;
    for (const { name, cfg } of cfgsUnderTest()) {
      expect(padNumberBound(specOf(cfg), "tennis.interruption", "duration"), name).toEqual({ min: 0, max: tennisPadRules.interruptionMaxSeconds });
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(2);
  });

  it("is a bound the pad offers, never one the fold enforces: a break longer than it still folds (recorded, never refused)", () => {
    const cfg = parse({});
    const over = { type: "tennis.interruption", payload: { kind: "medical", by: H, duration: tennisPadRules.interruptionMaxSeconds + 1 } };
    const result = attempt(cfg, [start, over]);
    expect(result.ok).toBe(true);
  });
});

describe("tennisPadRules.pointCalls", () => {
  it("is ITF Rule 5(a)'s count of a standard game: no point, 15, 30, 40", () => {
    expect(tennisPadRules.pointCalls).toBe(POINT_CALLS);
    expect(tennisPadRules.pointCalls).toEqual(["0", "15", "30", "40"]);
  });

  it("is what the fold's own spoken game score says at every score short of deuce (counted)", () => {
    const cfg = parse({});
    let compared = 0;
    for (let home = 0; home <= 3; home++) {
      for (let away = 0; away <= 3; away++) {
        if (home === 3 && away === 3) continue; // deuce speaks its own words
        const events = [start, ...Array<ModuleEvent>(home).fill(point("home")), ...Array<ModuleEvent>(away).fill(point("away"))];
        const game = (tennis.summary(fold(cfg, events)).detail as { game?: unknown } | undefined)?.game;
        expect(game, `${home}-${away}`).toBe(`${tennisPadRules.pointCalls[home]}–${tennisPadRules.pointCalls[away]}`);
        compared++;
      }
    }
    expect(compared).toBe(15);
  });
});

describe("tennisPadRules.gamesFieldBound / tiebreakFieldBound", () => {
  it("are the padSpec set-score bounds, a function of the cfg (counted, and not one constant)", () => {
    const games = new Set<number>();
    const tb = new Set<number>();
    let compared = 0;
    for (const { name, cfg } of cfgsUnderTest()) {
      const spec = specOf(cfg);
      expect(tennisPadRules.gamesFieldBound(cfg), `${name} home`).toBe(padNumberBound(spec, "tennis.set_summary", "home").max);
      expect(tennisPadRules.gamesFieldBound(cfg), `${name} away`).toBe(padNumberBound(spec, "tennis.set_summary", "away").max);
      expect(tennisPadRules.tiebreakFieldBound(cfg), `${name} tb.home`).toBe(padNumberBound(spec, "tennis.set_summary", "tb.home").max);
      expect(tennisPadRules.tiebreakFieldBound(cfg), `${name} tb.away`).toBe(padNumberBound(spec, "tennis.set_summary", "tb.away").max);
      games.add(tennisPadRules.gamesFieldBound(cfg));
      tb.add(tennisPadRules.tiebreakFieldBound(cfg));
      compared += 4;
    }
    report(`bound facts compared: ${compared}; games bounds ${[...games].join(",")}; tb bounds ${[...tb].join(",")}`);
    expect(compared).toBe(cfgsUnderTest().length * 4);
    // a bound read once from the default cfg would give one value here
    expect(games.size).toBeGreaterThanOrEqual(3);
    expect(tb.size).toBeGreaterThanOrEqual(3);
  });

  it("read the stored cfg through the schema: {} is the tour default, the same as its parsed form", () => {
    expect(tennisPadRules.gamesFieldBound({})).toBe(tennisPadRules.gamesFieldBound(parse({})));
    expect(tennisPadRules.tiebreakFieldBound({})).toBe(tennisPadRules.tiebreakFieldBound(parse({})));
    expect(() => tennisPadRules.gamesFieldBound({ bestOf: 2 })).toThrow(/odd/);
  });

  it("admit the scores the fold takes: the tie-break set score with its tie-break, and the match tie-break's closing score", () => {
    let checked = 0;
    for (const { name, cfg } of cfgsUnderTest()) {
      const at = cfg.set.tiebreakAt;
      if (at !== null) {
        // the longest ordinary tie-break the fold takes as a final score, won by its margin past the target
        const to = cfg.set.tiebreakTo;
        const tbLoser = to - (cfg.set.tiebreakWinBy ?? cfg.tiebreak.winBy);
        const tbSet: ModuleEvent = { type: "tennis.set_summary", payload: { home: at + 1, away: at, tb: { home: to, away: tbLoser } } };
        expect(attempt(cfg, [start, tbSet]).ok, `${name}: ${at + 1}-${at} (${to}-${tbLoser}) folds`).toBe(true);
        expect(at + 1, name).toBeLessThanOrEqual(tennisPadRules.gamesFieldBound(cfg));
        expect(to, name).toBeLessThanOrEqual(tennisPadRules.tiebreakFieldBound(cfg));
        checked++;
      }
      const finalSet = cfg.finalSet;
      if (finalSet !== "same" && "matchTiebreakTo" in finalSet) {
        expect(finalSet.matchTiebreakTo, name).toBeLessThanOrEqual(tennisPadRules.gamesFieldBound(cfg));
        checked++;
      }
      if (finalSet !== "same" && "tiebreakTo" in finalSet) {
        expect(finalSet.tiebreakTo, name).toBeLessThanOrEqual(tennisPadRules.tiebreakFieldBound(cfg));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});

describe("tennisPadRules.bestOf", () => {
  it("is the cfg's own bestOf: the variant's declaration where it makes one, the schema default otherwise (counted)", () => {
    const variants = tennis.variants;
    const schemaDefault = parse({}).bestOf;
    const seen = new Set<number>();
    let compared = 0;
    for (const [name, variant] of Object.entries(variants)) {
      expect(tennisPadRules.bestOf(variant), name).toBe(variant.bestOf ?? schemaDefault);
      seen.add(tennisPadRules.bestOf(variant));
      compared++;
    }
    expect(compared).toBe(Object.keys(variants).length);
    expect([...seen].sort()).toEqual([3, 5]); // grand-slam's best of five is a case where the right answer is not the default
  });
});

// ---------------------------------------------------------------------------
// The fold's own refusals as the oracle.
// ---------------------------------------------------------------------------

/** Set summaries that bring a match under `cfg` to its deciding set: alternate straight sets, each to the set's games target. */
function toDecider(cfg: NestedCfg): ModuleEvent[] {
  const need = Math.ceil(cfg.bestOf / 2) - 1;
  const out: ModuleEvent[] = [];
  for (let i = 0; i < need; i++) out.push(summary(cfg.set.gamesTo, 0), summary(0, cfg.set.gamesTo));
  return out;
}

describe("tennisPadRules.setScoreTakesTiebreak: exactly the set scores the strict fold refuses without their tie-break points", () => {
  it("first set and deciding set, every cfg, every score up to the field bound (counted)", () => {
    let cells = 0;
    let takes = 0;
    for (const { name, cfg } of cfgsUnderTest()) {
      for (const [where, before] of [
        ["first set", [start]],
        ["deciding set", [start, ...toDecider(cfg)]],
      ] as const) {
        const state = fold(cfg, before);
        expect(state.phase, `${name} ${where}: premise, play is live`).toBe("live");
        const limit = Math.min(tennisPadRules.gamesFieldBound(cfg), 15);
        let takesHere = 0;
        for (let home = 0; home <= limit; home++) {
          for (let away = 0; away <= limit; away++) {
            const result = attempt(cfg, [...before, summary(home, away)]);
            const refusedForItsTiebreak = !result.ok && result.code === "INVALID_EVENT" && /include its points as tb/.test(result.message);
            expect(tennisPadRules.setScoreTakesTiebreak(state, cfg, home, away), `${name} ${where} ${home}-${away}`).toBe(refusedForItsTiebreak);
            if (refusedForItsTiebreak) takesHere++;
            cells++;
          }
        }
        // the two tie-break set scores, either way round, wherever the set has a tie-break; none in an advantage set or a match tie-break
        const decider = where === "deciding set";
        const mtb = decider && cfg.finalSet !== "same" && "matchTiebreakTo" in cfg.finalSet;
        expect(takesHere, `${name} ${where}`).toBe(cfg.set.tiebreakAt === null || mtb ? 0 : 2);
        takes += takesHere;
      }
    }
    report(`set-score cells compared: ${cells}, of which take a tie-break: ${takes}`);
    expect(cells).toBeGreaterThan(1000);
    expect(takes).toBeGreaterThan(0);
  });

  it("a pre-fold state ({}) reads as the first set of the match", () => {
    const cfg = parse({});
    expect(tennisPadRules.setScoreTakesTiebreak({}, cfg, 7, 6)).toBe(true);
    expect(tennisPadRules.setScoreTakesTiebreak({}, cfg, 6, 4)).toBe(false);
    // best of one: the first set IS the decider, so a match tie-break decider takes no tb even at 7-6
    const bo1Mtb = parse({ bestOf: 1, finalSet: { matchTiebreakTo: 10 } });
    expect(tennisPadRules.setScoreTakesTiebreak({}, bo1Mtb, 7, 6)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A walk through real play, step by step: Rule 10 (ends), Rule 5(b) (tie-break serve), and the game-award refusal.
// ---------------------------------------------------------------------------

/** One scripted beat: the event, and what it does as the script KNOWS it (the oracle's input, never read off the fold). */
interface Beat {
  event: ModuleEvent;
  /** "point" mid-game; "game" closes a game (and maybe its set); "tb" a tie-break or match tie-break point. */
  kind: "start" | "point" | "game" | "tb" | "mtb" | "summary";
  /** The beat closes the set (game, tb) or the match (mtb, or a set that decides it). */
  closesSet?: boolean;
  closesMatch?: boolean;
  /** For a summary: its two game counts. */
  games?: readonly [number, number];
}

const beat = (event: ModuleEvent, kind: Beat["kind"], extra: Partial<Beat> = {}): Beat => ({ event, kind, ...extra });
/** A game won to love: three points that close nothing, then the one that closes the game. */
function loveGame(side: Side, extra: Partial<Beat> = {}): Beat[] {
  return [beat(point(side), "point"), beat(point(side), "point"), beat(point(side), "point"), beat(point(side), "game", extra)];
}
/** `n` games alternating home, away, home, ... from `first`. */
function alternateGames(n: number, first: Side = "home"): Beat[] {
  const other: Side = first === "home" ? "away" : "home";
  return Array.from({ length: n }, (_, i) => loveGame(i % 2 === 0 ? first : other)).flat();
}

/**
 * ITF Rule 10, as its text reads, run over the script: "The players shall change ends at the end of the first, third and every
 * subsequent odd game of each set. The players shall also change ends at the end of each set unless the total number of games in
 * that set is even, in which case the players change ends at the end of the first game of the next set. During a tie-break game,
 * players shall change ends after every six points." Rule 5(b): they also change ends at the end of the tie-break game, which
 * counts as one game of its set. A match tie-break (it replaces the deciding set) changes ends every six points the same way.
 * `changed` answers "was the last changeover an ends change"; there is none before the first game, and none once the match is
 * over.
 */
function rule10(beats: readonly Beat[]): boolean[] {
  const out: boolean[] = [];
  let changed = false;
  let gameInSet = 0;
  let breakerPoints = 0;
  let over = false;
  for (const b of beats) {
    switch (b.kind) {
      case "start":
      case "point":
        break;
      case "game": {
        gameInSet++;
        const oddGame = gameInSet % 2 === 1;
        if (b.closesSet === true) {
          const setClause = gameInSet % 2 === 1; // the set's total of games is the number of its last game
          if (setClause !== oddGame) throw new Error("the two clauses of Rule 10 disagree"); // they cannot: a guard, not a comment
          gameInSet = 0;
        }
        changed = oddGame;
        if (b.closesMatch === true) over = true;
        break;
      }
      case "tb": {
        breakerPoints++;
        if (b.closesSet === true) {
          gameInSet++; // the tie-break is a game of its set
          changed = true; // "and at the end of the tie-break game"
          if (gameInSet % 2 !== 1) throw new Error("premise: a tie-break set has an odd total of games");
          gameInSet = 0;
          breakerPoints = 0;
          if (b.closesMatch === true) over = true;
        } else {
          changed = breakerPoints % 6 === 0;
        }
        break;
      }
      case "mtb":
        breakerPoints++;
        if (b.closesMatch === true) over = true;
        changed = breakerPoints % 6 === 0;
        break;
      case "summary": {
        const [h, a] = b.games!;
        changed = (h + a) % 2 === 1; // the set clause
        gameInSet = 0;
        if (b.closesMatch === true) over = true;
        break;
      }
    }
    out.push(over ? false : changed);
  }
  return out;
}

/** The ITF Rule 5(b) server of tie-break point `k` (1-based): the player due serves the first, then two each in turn. */
const tbServerIsFirst = (k: number): boolean => Math.floor(k / 2) % 2 === 0;

interface Walk {
  name: string;
  cfg: NestedCfg;
  beats: Beat[];
}

function walks(): Walk[] {
  const tour = parse({});
  const slam = parse(tennis.variants["grand-slam"]);
  const mtb10 = parse(tennis.variants["doubles-noad-mtb10"]);
  const fast4 = parse(tennis.variants["fast4"]);
  const tbTo16 = [
    // 6-6 in tie-break points, then 7-7, then home takes two: 9-7, sixteen points - the 6th, 12th changes and a 13th+ point
    ...Array.from({ length: 6 }, () => [beat(point("home"), "tb"), beat(point("away"), "tb")]).flat(),
    beat(point("home"), "tb"),
    beat(point("away"), "tb"),
    beat(point("home"), "tb"),
    beat(point("home"), "tb", { closesSet: true }),
  ];
  return [
    {
      // a tie-break set (13 games: an ends change at its end), then an even set (none at its end, one after the next set's first game)
      name: "tour: 7-6 (9-7), 4-6, then into the third set",
      cfg: tour,
      beats: [
        beat(start, "start"),
        ...alternateGames(12),
        ...tbTo16,
        ...alternateGames(8, "away"),
        ...loveGame("away"),
        ...loveGame("away", { closesSet: true }),
        ...alternateGames(3),
      ],
    },
    {
      // an odd set that is not a tie-break set: the ends change at its end AND after the next set's first game
      name: "grand slam: 6-3, then into the second set",
      cfg: slam,
      beats: [
        beat(start, "start"),
        ...alternateGames(6),
        ...loveGame("home"),
        ...loveGame("home"),
        ...loveGame("home", { closesSet: true }),
        ...alternateGames(3, "away"),
      ],
    },
    {
      // a tie-break won 7-5 in points: twelve, the 6th a change, the last both the 12th point and the end of the tie-break game
      name: "tour: 7-6 (7-5), then into the second set",
      cfg: tour,
      beats: [
        beat(start, "start"),
        ...alternateGames(12),
        ...Array.from({ length: 5 }, () => [beat(point("home"), "tb"), beat(point("away"), "tb")]).flat(),
        beat(point("home"), "tb"),
        beat(point("home"), "tb", { closesSet: true }),
        ...alternateGames(2),
      ],
    },
    {
      // a short-set tie-break at 3-all (6 games before it: no change before its first point), first to 5 with a deciding point
      // at 4-all (App VI section 2, a margin of one): nine points, the 6th a change, the 9th the end of the tie-break game
      name: "fast4: 4-3 (5-4)",
      cfg: fast4,
      beats: [
        beat(start, "start"),
        ...alternateGames(6),
        ...Array.from({ length: 4 }, () => [beat(point("home"), "tb"), beat(point("away"), "tb")]).flat(),
        beat(point("home"), "tb", { closesSet: true }),
        ...alternateGames(2),
      ],
    },
    {
      // a match tie-break after an odd second set (the ends change before its first point), run past 12 points, to the match's end
      name: "doubles no-ad, match tie-break to 10: 6-0, 3-6, [11-9]",
      cfg: mtb10,
      beats: [
        beat(start, "start"),
        ...Array.from({ length: 5 }, () => loveGame("home")).flat(),
        ...loveGame("home", { closesSet: true }),
        ...loveGame("home"),
        ...loveGame("away"),
        ...loveGame("home"),
        ...loveGame("away"),
        ...loveGame("home"),
        ...loveGame("away"),
        ...loveGame("away"),
        ...loveGame("away"),
        ...loveGame("away", { closesSet: true }),
        ...Array.from({ length: 9 }, () => [beat(point("home"), "mtb"), beat(point("away"), "mtb")]).flat(),
        beat(point("home"), "mtb"),
        beat(point("home"), "mtb", { closesMatch: true }),
      ],
    },
    {
      // coarse scoring, then rally play: a 6-3 summary (odd: read off the summary alone), then 4-6 by rally (even), then two games
      name: "tour: a 6-3 summary, 4-6 by rally, then into the third set",
      cfg: tour,
      beats: [
        beat(start, "start"),
        beat(summary(6, 3), "summary", { games: [6, 3] }),
        ...loveGame("home"),
        ...loveGame("away"),
        ...loveGame("home"),
        ...loveGame("away"),
        ...loveGame("home"),
        ...loveGame("away"),
        ...loveGame("away"),
        ...loveGame("home"),
        ...loveGame("away"),
        ...loveGame("away", { closesSet: true }),
        // 4-6 by rally: an even set, so no change at its end
        ...alternateGames(2),
      ],
    },
  ];
}

/** Folds every prefix of a walk: the state after each beat. Also proves the script's premises (a closing beat closes). */
function statesOf(walk: Walk): NestedState[] {
  const events: ModuleEvent[] = [];
  const states: NestedState[] = [];
  let setsClosed = 0;
  for (const b of walk.beats) {
    events.push(b.event);
    const state = fold(walk.cfg, events);
    const closed = state.sets.length;
    const scriptCloses = b.closesSet === true || b.closesMatch === true || b.kind === "summary";
    expect(closed - setsClosed, `${walk.name} @${events.length}: premise, the script knows when a set closes`).toBe(scriptCloses ? 1 : 0);
    expect(state.phase, `${walk.name} @${events.length}: premise, the script knows when the match ends`).toBe(b.closesMatch === true ? "done" : "live");
    setsClosed = closed;
    states.push(state);
  }
  return states;
}

describe("tennisPadRules.endsChanged: ITF Rule 10, step by step through real play", () => {
  it("matches the rule's text after every beat of every walk (counted, both answers seen)", () => {
    let steps = 0;
    let trues = 0;
    for (const walk of walks()) {
      const expected = rule10(walk.beats);
      const states = statesOf(walk);
      states.forEach((state, i) => {
        expect(tennisPadRules.endsChanged(state), `${walk.name} after beat ${i + 1} (${walk.beats[i]!.kind})`).toBe(expected[i]);
        steps++;
        if (expected[i]) trues++;
      });
    }
    report(`Rule 10 steps compared: ${steps}, ends changed at ${trues}`);
    expect(steps).toBeGreaterThan(300);
    expect(trues).toBeGreaterThan(20);
    expect(steps - trues).toBeGreaterThan(20);
  });

  it("the cases the rule turns on, by name: a tie-break, a match tie-break, and set boundaries", () => {
    const tour = parse({});
    const at = (events: ModuleEvent[]) => tennisPadRules.endsChanged(fold(tour, events));
    const twelveGames = Array.from({ length: 12 }, (_, i) => Array<ModuleEvent>(4).fill(point(i % 2 === 0 ? "home" : "away"))).flat();
    const tbPoints = (n: number) => Array.from({ length: n }, (_, i) => point(i % 2 === 0 ? "home" : "away"));
    // tie-break: no change entering it (game 12 is even); a change after the 6th point and after the 12th; none after the 7th
    expect(at([start, ...twelveGames])).toBe(false);
    expect(at([start, ...twelveGames, ...tbPoints(5)])).toBe(false);
    expect(at([start, ...twelveGames, ...tbPoints(6)])).toBe(true);
    expect(at([start, ...twelveGames, ...tbPoints(7)])).toBe(false);
    expect(at([start, ...twelveGames, ...tbPoints(11)])).toBe(false);
    expect(at([start, ...twelveGames, ...tbPoints(12)])).toBe(true);
    // set boundaries: after an odd set the ends change at its end; after an even one they do not
    expect(at([start, summary(6, 3)])).toBe(true);
    expect(at([start, summary(6, 4)])).toBe(false);
    // match tie-break: the change at the end of an odd second set comes before its first point; then every six points
    const mtb10 = parse(tennis.variants["doubles-noad-mtb10"]);
    const inMtb = (n: number) => tennisPadRules.endsChanged(fold(mtb10, [start, summary(6, 0), summary(3, 6), ...tbPoints(n)]));
    expect(inMtb(0)).toBe(true);
    expect(inMtb(1)).toBe(false);
    expect(inMtb(6)).toBe(true);
    expect(inMtb(7)).toBe(false);
    expect(tennisPadRules.endsChanged(fold(mtb10, [start, summary(6, 0), summary(4, 6)]))).toBe(false);
  });

  it("no change before play, after the match, or for a state that is not a fold's (the empty case)", () => {
    const tour = parse({});
    expect(tennisPadRules.endsChanged(fold(tour, []))).toBe(false); // pre
    expect(tennisPadRules.endsChanged(fold(tour, [start]))).toBe(false);
    // decided in straight sets, the last of them odd: no changeover follows the last game
    const decided = fold(tour, [start, summary(6, 4), summary(6, 3)]);
    expect(decided.phase).toBe("done");
    expect(tennisPadRules.endsChanged(decided)).toBe(false);
    expect(tennisPadRules.endsChanged({})).toBe(false);
    expect(tennisPadRules.endsChanged(null)).toBe(false);
    expect(tennisPadRules.endsChanged({ phase: "live", games: { home: 1, away: 0 } })).toBe(false);
  });
});

describe("tennisPadRules.tiebreakServeRotatesAfter: ITF Rule 5(b), through the fold's own serve", () => {
  it("rotates after the 1st point and every second point after it, as the fold's serving does (counted)", () => {
    let compared = 0;
    for (const walk of walks()) {
      const states = statesOf(walk);
      let breakerPoint = 0;
      let firstServer: Side | null = null;
      walk.beats.forEach((b, i) => {
        if (b.kind !== "tb" && b.kind !== "mtb") {
          breakerPoint = 0;
          firstServer = null;
          return;
        }
        const before = states[i - 1]!;
        breakerPoint++;
        if (breakerPoint === 1) firstServer = before.serving;
        // the rule's server of this point and of the next, from the breaker's first server alone
        const serverOf = (k: number): Side => (tbServerIsFirst(k) ? firstServer! : firstServer === "home" ? "away" : "home");
        expect(before.serving, `${walk.name}: premise, the fold serves point ${breakerPoint} as Rule 5(b) says`).toBe(serverOf(breakerPoint));
        const ruleRotates = serverOf(breakerPoint + 1) !== serverOf(breakerPoint);
        expect(tennisPadRules.tiebreakServeRotatesAfter(breakerPoint), `${walk.name} point ${breakerPoint}`).toBe(ruleRotates);
        if (b.closesSet !== true && b.closesMatch !== true) {
          expect(states[i]!.serving !== before.serving, `${walk.name}: the fold rotates after point ${breakerPoint} exactly then`).toBe(ruleRotates);
        }
        compared++;
      });
    }
    report(`tie-break serve points compared: ${compared}`);
    expect(compared).toBeGreaterThan(40);
  });
});

describe("tennisPadRules.breakerInForce: exactly when the strict fold refuses a game award", () => {
  it("at every live step of every walk (counted, both answers seen)", () => {
    let compared = 0;
    let inForce = 0;
    for (const walk of walks()) {
      const states = statesOf(walk);
      const events: ModuleEvent[] = [];
      walk.beats.forEach((b, i) => {
        events.push(b.event);
        const state = states[i]!;
        if (state.phase !== "live") return;
        const result = attempt(walk.cfg, [...events, gameAward("home")]);
        const refused = !result.ok && result.code === "GAME_AWARD_DURING_TIEBREAK";
        if (!result.ok) expect(result.code, `${walk.name} @${i + 1}: refused for the breaker or not at all`).toBe("GAME_AWARD_DURING_TIEBREAK");
        expect(tennisPadRules.breakerInForce(state), `${walk.name} @${i + 1}`).toBe(refused);
        compared++;
        if (refused) inForce++;
      });
    }
    report(`game-award steps compared: ${compared}, in a breaker: ${inForce}`);
    expect(compared).toBeGreaterThan(300);
    expect(inForce).toBeGreaterThan(40);
  });

  it("is false for a state that is not a fold's", () => {
    expect(tennisPadRules.breakerInForce({})).toBe(false);
    expect(tennisPadRules.breakerInForce(undefined)).toBe(false);
    // a score with no game kind is not a fold's game points: nothing says a breaker is in force
    expect(tennisPadRules.breakerInForce({ points: { home: 3, away: 2 } })).toBe(false);
  });
});
