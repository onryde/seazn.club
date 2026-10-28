// W2e Task 16 (rows BD-SV-1, BD-DV-1, TT-SE-1, TT-TO-1, VB-RO-1): the set sports' record-only mechanics, the ITTF penalty
// point entered as a rally, and badminton's team ties that are not built. Every describe/it title carries its row id as a whole
// token (packages/engine/test/rules-reference.ts reads them).
//
// Expected values come from the rulebook and the rule rows, never from the code under test:
//  - the serve rule the engine's reader cites as BWF Laws of Badminton 10.3 (the side that wins a rally serves the next one), as
//    badminton.ts cites it (R5-1) and NOT re-read from the Laws text in W2e: the "who serves" expectation is the product rule, written
//    from the winners of the rallies played, not recomputed with the kernel's arithmetic;
//  - ITTF Laws of Table Tennis, from the repo's DOMAIN.tabletennis.md:75-77 (yellow card = warning, red card = penalty) and not
//    re-read from the official text, which was not retrievable in W2e; secondary sources differ on how a penalty is scored. What the
//    tests pin is the ENGINE's behaviour: the sanction moves no score on its own, and the point the umpire awards is entered as ONE
//    rally, so a game reaching 11 with two clear closes on it;
//  - the rows' own text (rules/badminton.md, tabletennis.md, volleyball.md): what is recorded, and that nothing recorded moves
//    a score;
//  - RB2A-32 (rulebook-W2-sets-cricket.md:702): badminton team ties are not built ("run each rubber as its own division").
//
// Every fold is PAD-SHAPED (`strictFromSeq: 0`) unless a test says otherwise: the write path.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, type EventEnvelope } from "../../core/events.ts";
import { matchEndFacts, pendingEndingSanction } from "../../core/sanction-ending.ts";
import type { Lineup, LineupPair, LineupSlot } from "../../core/types.ts";
import type { PadSpec } from "../../sport/module.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import { effectiveEntrantModel, entrantKindCap } from "../../sport/entrant-model.ts";
import { expectSanctionMovesNoScore, sanctionEventTypeOf, sanctionLevelsOf } from "../../testkit/sanction-score.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import { setBasedServeContext, type SetBasedCfg, type SetBasedState } from "./kernel.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

const STRICT = { strictFromSeq: 0 } as const;

type Spec = [type: string, payload?: unknown, voids?: string];
type SetSport = typeof badminton | typeof tabletennis | typeof volleyball;

const START: Spec = ["core.start"];
const stream = (specs: readonly Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));
const cfgOf = (m: SetSport, variant?: string): SetBasedCfg => m.configSchema.parse(variant === undefined ? {} : m.variants[variant]);
const lineupsOf = (m: SetSport, cfg: SetBasedCfg): LineupPair => defaultLineupPair(resolvePositions(m, cfg));
const fold = (m: SetSport, cfg: SetBasedCfg, lineups: LineupPair, specs: readonly Spec[]): SetBasedState =>
  foldMatch(m, cfg, lineups, stream(specs), STRICT);

/** One rally per winner, in order. */
const rallies = (m: SetSport, ...winners: string[]): Spec[] => winners.map((wonBy): Spec => [`${m.key}.rally`, { wonBy }]);
const times = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));

/** The code of the EngineError a fold throws, or null when it folds. Anything else rethrows. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}

/** Everything a score is read from: the headline, the per-side lines, the sets and points of the detail, and the outcome. */
function scoreView(m: SetSport, state: SetBasedState): unknown {
  const summary = m.summary(state);
  const detail = summary.detail as { sets: unknown; points: unknown };
  return { headline: summary.headline, perSide: summary.perSide, sets: detail.sets, points: detail.points, outcome: m.outcome(state) };
}

/** The sanction levels the sport's pad offers (the umpire's cards), read off its declared pad. */
function offeredLevels(m: SetSport): readonly string[] {
  const spec: PadSpec = m.padSpec!(m.configSchema.parse({}));
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      if (action.type !== `${m.key}.sanction`) continue;
      const field = action.fields.find((f) => f.path === "level");
      if (field?.kind === "enum") return field.values;
    }
  }
  throw new Error(`${m.key}: its pad offers no sanction level`);
}

const detailOf = (m: SetSport, state: SetBasedState): Record<string, unknown> => m.summary(state).detail as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------------
// BD-SV-1 (M1) - the serve order is recorded; record-only
// ---------------------------------------------------------------------------------------------------------------------

describe("BD-SV-1 badminton records who serves, and the record moves no score", () => {
  const cfg = cfgOf(badminton);
  const lineups = lineupsOf(badminton, cfg);

  it("BD-SV-1 the rally winner serves next (the product rule, cited as BWF 10.3), a named server is tallied, and the same rallies score the same without any of it", () => {
    // Winners of the rallies, in order. The server of rally n+1 is the winner of rally n (the law); rally 1's server is the anchor.
    const winners = ["H", "H", "A", "A", "H", "A", "H"];
    const servers = ["H", ...winners.slice(0, -1)];
    const declared: Spec[] = [
      START,
      ...winners.map((wonBy, i): Spec => ["badminton.rally", { wonBy, serving: servers[i], server: `${servers[i]}-p1` }]),
    ];
    const plain: Spec[] = [START, ...rallies(badminton, ...winners)];

    // The reader names the side that serves next after every prefix: the winner of the last rally played.
    for (let played = 1; played <= winners.length; played++) {
      const events = stream(declared.slice(0, played + 1));
      const state = foldMatch(badminton, cfg, lineups, events, STRICT);
      expect(setBasedServeContext(badminton, state, events), `after ${played} rallies`).toMatchObject({
        servingSide: winners[played - 1],
        serveOrderKnown: true,
      });
    }

    // Recorded: each named server is credited with the rallies served (tallied per person), from the ledger.
    const state = fold(badminton, cfg, lineups, declared);
    const servedBy = (side: string) => servers.filter((s) => s === side).length;
    expect(servedBy("H") + servedBy("A")).toBe(winners.length);
    expect(state.persons?.["H-p1"]?.serves).toBe(servedBy("H"));
    expect(state.persons?.["A-p1"]?.serves).toBe(servedBy("A"));

    // Record-only: the declared stream and the plain one score identically.
    expect(scoreView(badminton, state)).toEqual(scoreView(badminton, fold(badminton, cfg, lineups, plain)));
  });

  it("BD-SV-1 a recorded serving side that contradicts the rally winners is reported unknown, never refused, and moves no score", () => {
    // H wins rally 1, so H serves rally 2; the pad says A served it. The engine neither refuses nor patches the score.
    const contradicting: Spec[] = [
      START,
      ["badminton.rally", { wonBy: "H", serving: "H" }],
      ["badminton.rally", { wonBy: "A", serving: "A" }],
    ];
    const events = stream(contradicting);
    const state = foldMatch(badminton, cfg, lineups, events, STRICT);
    expect(setBasedServeContext(badminton, state, events)).toMatchObject({ serveOrderKnown: false, unknownBecause: "recorded-disagrees" });
    expect(scoreView(badminton, state)).toEqual(scoreView(badminton, fold(badminton, cfg, lineups, [START, ...rallies(badminton, "H", "A")])));
  });

  it("BD-SV-1 a rally carrying the serve is refused before the match starts, and with no serve declared the ledger alone still names the next server", () => {
    expect(codeOf(() => fold(badminton, cfg, lineups, [["badminton.rally", { wonBy: "H", serving: "H" }]]))).toBe("WRONG_PHASE");
    // Before any rally the reader does not know who opens (the one fact the ledger cannot supply); after one, side-out answers.
    const open = stream([START]);
    expect(setBasedServeContext(badminton, foldMatch(badminton, cfg, lineups, open, STRICT), open).serveOrderKnown).toBe(false);
    const played = stream([START, ...rallies(badminton, "A")]);
    expect(setBasedServeContext(badminton, foldMatch(badminton, cfg, lineups, played, STRICT), played)).toMatchObject({ servingSide: "A", serveOrderKnown: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// BD-DV-1 (RB2A-32) - badminton team ties are not built
// ---------------------------------------------------------------------------------------------------------------------

describe("BD-DV-1 a badminton division offers individual and pair entrants, and no team", () => {
  it("BD-DV-1 the declared entrant model is individual and pair, defaulting to individual, and a pair holds two", () => {
    const model = effectiveEntrantModel(badminton.entrantModel);
    expect(model.kinds).toEqual(["individual", "pair"]);
    expect(model.defaultKind).toBe("individual");
    expect(model.kinds).not.toContain("team");
    expect(entrantKindCap("individual", model)).toBe(1);
    expect(entrantKindCap("pair", model)).toBe(2);
  });

  it("BD-DV-1 the contrast is real: volleyball offers teams, so a model that excludes them is a choice of the sport", () => {
    expect(effectiveEntrantModel(volleyball.entrantModel).kinds).toContain("team");
    expect(effectiveEntrantModel(null).kinds).toContain("team");
  });

  it("BD-DV-1 the module fields one unit a side, a player or a pair", () => {
    // A team tie is a SET of matches between two clubs (BWF GCR 16.3); the badminton module scores one match between two units.
    expect(badminton.positions.lineup.size).toBe(1);
  });

  it("BD-DV-1 limit: the refusal is the sport's default model - a division's own entrant kinds can widen it to teams", () => {
    // The entrants door (apps/web server/usecases/entrants.ts) refuses a kind outside the division's EFFECTIVE model. The division's
    // `config.entrants.kinds` override feeds that model, so an organiser who ticks "Team" in the division settings gets team entrants
    // in a badminton division - for single matches, not ties. RB2A-32 said "refuse for now"; this is the product's reach.
    const widened = effectiveEntrantModel(badminton.entrantModel, { entrants: { kinds: ["team"] } });
    expect(widened.kinds).toEqual(["team"]);
    // And with no override the declaration stands.
    expect(effectiveEntrantModel(badminton.entrantModel, {}).kinds).toEqual(["individual", "pair"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// TT-SE-1 (A2) - an ITTF penalty point is entered as a rally; the sanction alone moves no score; no match-ending level
// ---------------------------------------------------------------------------------------------------------------------

describe("TT-SE-1 a table tennis penalty awards its point as a separate rally, and the sanction event alone moves no score", () => {
  const cfg = cfgOf(tabletennis);
  const lineups = lineupsOf(tabletennis, cfg);
  const sanction = (by: string, level: string): Spec => ["tabletennis.sanction", { by, level }];

  /** Game 1 at `home`-`away`, taken rally by rally: the home rallies first, then the away ones. */
  const gameAt = (home: number, away: number): Spec[] => [
    START,
    ...rallies(tabletennis, ...times(home, () => "H"), ...times(away, () => "A")),
  ];
  const openGame = (state: SetBasedState) => state.sets[0];

  it("TT-SE-1 the umpire's two cards are the warning and the penalty above it", () => {
    // ITTF: yellow card = warning, red card = penalty (DOMAIN.tabletennis.md:75-77). The pad's ladder is exactly those two, in order.
    expect(offeredLevels(tabletennis)).toEqual(["warning", "penalty"]);
  });

  it("TT-SE-1 at game point the penalty on the opponent closes nothing by itself: the rally the scorer then enters closes the game", () => {
    // H leads 10-5 in game 1: one more point and H has 11 with two clear. A penalty against A concedes that point to H.
    const before = fold(tabletennis, cfg, lineups, gameAt(10, 5));
    expect(openGame(before)).toMatchObject({ home: 10, away: 5, closed: false });
    const sanctioned = fold(tabletennis, cfg, lineups, [...gameAt(10, 5), sanction("A", "penalty")]);
    expect(scoreView(tabletennis, sanctioned), "the sanction alone").toEqual(scoreView(tabletennis, before));
    expect(openGame(sanctioned)).toMatchObject({ home: 10, away: 5, closed: false });
    expect(sanctioned.setsWon).toEqual({ home: 0, away: 0 });

    // The point is the rally the scorer enters: the game closes at 11-5, on that rally and on nothing else.
    const awarded = fold(tabletennis, cfg, lineups, [...gameAt(10, 5), sanction("A", "penalty"), ...rallies(tabletennis, "H")]);
    expect(openGame(awarded)).toMatchObject({ home: 11, away: 5, closed: true });
    expect(awarded.setsWon).toEqual({ home: 1, away: 0 });
  });

  it("TT-SE-1 the point counts once: a second penalty adds none, and the rally entered before the sanction adds exactly one", () => {
    // Mid-game 6-4 to H. Penalty against H -> the opponent's point is the rally A wins: 6-5, not 6-6.
    const base = gameAt(6, 4);
    const twice = fold(tabletennis, cfg, lineups, [...base, sanction("H", "penalty"), sanction("H", "penalty"), ...rallies(tabletennis, "A")]);
    expect(openGame(twice)).toMatchObject({ home: 6, away: 5 });
    // The scorer may enter the point first and the card after: the same score, the card adding nothing.
    const pointFirst = fold(tabletennis, cfg, lineups, [...base, ...rallies(tabletennis, "A"), sanction("H", "penalty")]);
    expect(scoreView(tabletennis, pointFirst)).toEqual(scoreView(tabletennis, twice));
    // A warning is the same: a record, no point.
    const warned = fold(tabletennis, cfg, lineups, [...base, sanction("H", "warning")]);
    expect(scoreView(tabletennis, warned)).toEqual(scoreView(tabletennis, fold(tabletennis, cfg, lineups, base)));
  });

  it("TT-SE-1 a sanction at every level the payload takes moves no score, over every declared config and walk", () => {
    const levels = sanctionLevelsOf(tabletennis);
    expect(levels).toEqual(["warning", "penalty", "expulsion", "disqualification"]);
    expect(sanctionEventTypeOf(tabletennis)).toBe("tabletennis.sanction");
    let checked = 0;
    for (const level of levels) {
      const states = expectSanctionMovesNoScore(tabletennis, level);
      expect(states, level).toBeGreaterThan(0);
      checked += states;
    }
    expect(checked).toBeGreaterThan(levels.length);
  });

  it("TT-SE-1 table tennis has no match-ending sanction level: after any level the match is undecided, nothing is pending, and play goes on", () => {
    expect(tabletennis.sanctionEnding).toBeUndefined();
    const levels = sanctionLevelsOf(tabletennis);
    let checked = 0;
    for (const level of levels) {
      for (const by of ["H", "A"]) {
        const played: Spec[] = [...gameAt(3, 2), sanction(by, level)];
        const events = stream(played);
        const folded = foldMatchWithStoppage(tabletennis, cfg, lineups, events, STRICT);
        expect(tabletennis.outcome(folded.state), `${level} against ${by}`).toBeNull();
        expect(pendingEndingSanction(tabletennis, events, matchEndFacts(tabletennis, folded, events)), `${level} against ${by}`).toBeNull();
        // The write path takes the next rally: strict on the LAST event only, as append-event.ts folds it.
        const next = stream([...played, ["tabletennis.rally", { wonBy: "H" }]]);
        const after = foldMatchWithStoppage(tabletennis, cfg, lineups, next, { strictFromSeq: next.length - 1 });
        expect(openGame(after.state), `${level} against ${by}`).toMatchObject({ home: 4, away: 2 });
        checked++;
      }
    }
    expect(checked).toBe(levels.length * 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// TT-TO-1 (M2) - time-outs are recorded; record-only
// ---------------------------------------------------------------------------------------------------------------------

describe("TT-TO-1 table tennis records time-outs as they happen, and they move no score", () => {
  const cfg = cfgOf(tabletennis);
  const lineups = lineupsOf(tabletennis, cfg);
  const timeout = (by: string): Spec => ["tabletennis.timeout", { by }];
  const play: Spec[] = [START, ...rallies(tabletennis, "H", "H", "A", "H", "A", "H")];

  it("TT-TO-1 each time-out is counted for its side, and the score is exactly what the same rallies give without them", () => {
    const control = fold(tabletennis, cfg, lineups, play);
    const first = fold(tabletennis, cfg, lineups, [...play, timeout("H")]);
    expect(detailOf(tabletennis, first).timeouts).toEqual({ home: 1, away: 0 });
    expect(scoreView(tabletennis, first)).toEqual(scoreView(tabletennis, control));

    const both = fold(tabletennis, cfg, lineups, [...play, timeout("H"), timeout("A")]);
    expect(detailOf(tabletennis, both).timeouts).toEqual({ home: 1, away: 1 });
    expect(scoreView(tabletennis, both)).toEqual(scoreView(tabletennis, control));

    // The play after the time-outs lands where it would have landed without them.
    const resumed = fold(tabletennis, cfg, lineups, [...play, timeout("H"), timeout("A"), ...rallies(tabletennis, "A")]);
    expect(scoreView(tabletennis, resumed)).toEqual(scoreView(tabletennis, fold(tabletennis, cfg, lineups, [...play, ...rallies(tabletennis, "A")])));
  });

  it("TT-TO-1 limit: the engine caps none - a second and third time-out by the same side are recorded (the ITTF Regulations give a player or pair one)", () => {
    const control = fold(tabletennis, cfg, lineups, play);
    const many = fold(tabletennis, cfg, lineups, [...play, timeout("H"), timeout("A"), timeout("H"), timeout("H")]);
    expect(detailOf(tabletennis, many).timeouts).toEqual({ home: 3, away: 1 });
    expect(scoreView(tabletennis, many)).toEqual(scoreView(tabletennis, control));
  });

  it("TT-TO-1 a time-out is taken in live play only: refused before the start and once the match is decided", () => {
    expect(codeOf(() => fold(tabletennis, cfg, lineups, [timeout("H")]))).toBe("WRONG_PHASE");
    // Best of 5 to 11: H wins three straight games.
    const decided: Spec[] = [START, ...rallies(tabletennis, ...times(33, () => "H"))];
    expect(tabletennis.outcome(fold(tabletennis, cfg, lineups, decided))).toMatchObject({ kind: "win", winner: "H" });
    expect(codeOf(() => fold(tabletennis, cfg, lineups, [...decided, timeout("A")]))).toBe("ALREADY_DECIDED");
  });

  it("TT-TO-1 voiding a time-out takes it back out of the tally, and badminton, which records none, refuses it", () => {
    const voided = fold(tabletennis, cfg, lineups, [...play, timeout("H"), ["core.void", {}, `e-${play.length}`]]);
    expect(detailOf(tabletennis, voided).timeouts).toBeUndefined();
    // Another sport on the same kernel: BWF play has no time-outs, so badminton's write path takes none.
    const bd = cfgOf(badminton);
    expect(codeOf(() => fold(badminton, bd, lineupsOf(badminton, bd), [START, ["badminton.timeout", { by: "H" }]]))).toBe("INVALID_EVENT");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// VB-RO-1 (M3) - technical time-outs, substitutions and the libero are recorded; record-only
// ---------------------------------------------------------------------------------------------------------------------

describe("VB-RO-1 volleyball records technical time-outs, substitutions and the libero, and none of them moves a score", () => {
  const cfg = cfgOf(volleyball);
  const COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
  /** Six on court, a libero and one more on the bench: the sheet FIVB's libero replacement is taken from. */
  const side = (entrantId: string): Lineup => {
    const starters: LineupSlot[] = COURT.map((positionKey, i) => ({ personId: `${entrantId}-p${i + 1}`, positionKey, slot: "starting", orderNo: i + 1 }));
    const bench: LineupSlot[] = [
      { personId: `${entrantId}-lib`, slot: "bench", orderNo: 7, roles: ["libero"] },
      { personId: `${entrantId}-b2`, slot: "bench", orderNo: 8 },
    ];
    return { entrantId, slots: [...starters, ...bench] };
  };
  const lineups: LineupPair = { home: side("H"), away: side("A") };
  const play: Spec[] = [START, ...rallies(volleyball, "H", "A", "H", "H", "A", "H")];
  const control = fold(volleyball, cfg, lineups, play);

  it("VB-RO-1 limit: a technical time-out is counted in the side's one time-out tally, beside its team time-outs, and moves no score", () => {
    const state = fold(volleyball, cfg, lineups, [
      ...play,
      ["volleyball.timeout", { by: "H", technical: true }],
      ["volleyball.timeout", { by: "H" }],
      ["volleyball.timeout", { by: "A", technical: true }],
    ]);
    // One tally per side: the fold keeps no separate technical count and caps nothing.
    expect(detailOf(volleyball, state).timeouts).toEqual({ home: 2, away: 1 });
    expect(scoreView(volleyball, state)).toEqual(scoreView(volleyball, control));
    // In live play only.
    expect(codeOf(() => fold(volleyball, cfg, lineups, [["volleyball.timeout", { by: "H", technical: true }]]))).toBe("WRONG_PHASE");
  });

  it("VB-RO-1 limit: substitutions are counted without a cap - a seventh in one set is taken - and the per-set count restarts with the next set; beach records none", () => {
    const sub = (n: number): Spec => ["volleyball.sub", { by: "H", off: `H-p${(n % 6) + 1}`, on: "H-b2" }];
    const seven = fold(volleyball, cfg, lineups, [...play, ...times(7, sub)]);
    const subs = detailOf(volleyball, seven).subs as { home: number; away: number; thisSet: { home: number; away: number } };
    expect(subs).toMatchObject({ home: 7, away: 0, thisSet: { home: 7, away: 0 } });
    expect(scoreView(volleyball, seven)).toEqual(scoreView(volleyball, control));

    // Set 1 to 25: 21 more rallies for H finish it from 4-2 (`play` has H 4, A 2), and the next set's count starts at zero.
    const toSetEnd = fold(volleyball, cfg, lineups, [...play, ...times(7, sub), ...rallies(volleyball, ...times(21, () => "H"))]);
    expect(toSetEnd.setsWon).toEqual({ home: 1, away: 0 });
    expect(detailOf(volleyball, toSetEnd).subs).toMatchObject({ home: 7, thisSet: { home: 0, away: 0 } });

    // The beach variant (a pair, no bench) records no substitution (FIVB beach rules).
    const beach = cfgOf(volleyball, "beach");
    expect(codeOf(() => fold(volleyball, beach, lineupsOf(volleyball, beach), [START, ["volleyball.sub", { by: "H", off: "H-p1", on: "H-p2" }]]))).toBe("INVALID_EVENT");
  });

  it("VB-RO-1 a libero replacement is recorded against the libero exemption, never the substitution count, and moves no score", () => {
    const liberoOn: Spec = [
      "core.lineup.replacement",
      { side: "H", off: "H-p3", on: { personId: "H-lib", positionKey: "MB", slot: "starting", orderNo: 7, roles: ["libero"] }, exemption: "libero" },
    ];
    const liberoOff: Spec = [
      "core.lineup.replacement",
      { side: "H", off: "H-lib", on: { personId: "H-p3", positionKey: "MB", slot: "starting", orderNo: 3 }, exemption: "libero" },
    ];
    const liberoBack: Spec = [
      "core.lineup.replacement",
      { side: "H", off: "H-p3", on: { personId: "H-lib", positionKey: "MB", slot: "starting", orderNo: 7 }, exemption: "libero" },
    ];
    const state = fold(volleyball, cfg, lineups, [...play, liberoOn, ...rallies(volleyball, "A"), liberoOff, liberoBack]);
    expect(state.squads?.home.exemptUsed).toEqual({ libero: 3 });
    expect(state.squads?.home.subsUsed).toBe(0);
    // The three replacements and one rally between them: the score is the control's plus that rally, nothing else.
    expect(scoreView(volleyball, state)).toEqual(scoreView(volleyball, fold(volleyball, cfg, lineups, [...play, ...rallies(volleyball, "A")])));
    // An ordinary substitute cannot use the libero channel: the replacement must involve the libero.
    const notLibero: Spec = [
      "core.lineup.replacement",
      { side: "H", off: "H-p3", on: { personId: "H-b2", positionKey: "MB", slot: "starting", orderNo: 8 }, exemption: "libero" },
    ];
    expect(codeOf(() => fold(volleyball, cfg, lineups, [...play, notLibero]))).toBe("LINEUP_INVALID");
  });
});
