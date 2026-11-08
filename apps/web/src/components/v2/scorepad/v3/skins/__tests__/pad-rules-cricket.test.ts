// Pad wave P2 — THE CRICKET DRIFT GUARD.
//
// The cricket skin used to carry its own copies of cricket's rule sets (the dismissal modes, the extras, which modes credit a
// fielder or the bowler, which batter can be out, what stands on a free hit, the toss / retire / review / close options, the
// penalty and wide runs, balls per over). They are now the engine's (`cricketPadRules`, @seazn/engine/pad). This file drives the
// skin's REAL builders (sheets, tiles, dock) over states the real fold produced, compares what they OFFER with the engine record,
// and folds what they EMIT back through the engine — never the record against a constant the skin re-exports (Review Focus 1:
// that comparison is always green). Every comparison is counted; the last test fails if fewer than the plan's 16 were made.
//
// single-sport: cricket's dismissal modes, extras and free hit exist in no other sport.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { foldMatch, initSquads, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { cricketPadRules } from "@seazn/engine/pad";
import { cricket, eligibleBowlers, soEligibleBatters, type CricketCfg, type CricketState } from "@seazn/engine/sports/cricket";
import { ballSeq, cricketEnvelopes, cricketLineups, tiedWithSuperOver, type CricketEventSpec } from "../../__tests__/_cricket-fold";
import uiEn from "@/dictionaries/en/ui.json";
import { GuidedSheet, answerStep, currentStep, initialSheetState } from "../../guided-sheet";
import { dedicatedEventTypes, moreActions, softCommitPlan } from "../../pad-host";
import { TileGrid } from "../../tile-grid";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { GuidedSheetSpec, GuidedSheetStep, PadHostView, TileSpec } from "../../types";
import { bowlerBlocked, bowlerBlockReason, buildContext, buildDock, buildScorebug, buildSheets, buildTiles, KEEPER_POSITION, KEEPER_ROLE, refusedEventTypes, resolvePeople, type TFn } from "../cricket";

const t: TFn = (key) => key;
const T20 = cricket.configSchema.parse(cricket.variants.t20);
const HUNDRED = cricket.configSchema.parse(cricket.variants.hundred);
const STRIKER = "H-1";
const NON_STRIKER = "H-2";
const OPENING_BOWLER = "A-11";
const FIELDER = "A-7";
/** The fielding side's keeper: `cricketLineups()` gives the away side's second name the `wicketkeeper` role. */
const KEEPER = "A-2";

/** MCC Law 37.1.1 "Either batter is out Obstructing the field" (owner ruling Q1b: the skin asks who), and the house rulebook's
 *  fielder credit for it (DOMAIN.md, Dismissals; owner ruling Q1: the skin asks for the fielder). The one mode this batch moved. */
const OBSTRUCTED = "obstructed";
/** DOMAIN.md, "Free hit armed and consumed": "only run-out/obstruction may dismiss on it". A rulebook anchor, so a free-hit set
 *  that drifts in the ENGINE (the skin follows it) still goes red here. */
const RULEBOOK_FREE_HIT = ["obstructed", "runout"];
/** Ruling 242 (CK-WK-3): either batter can be out run out (Law 38.1), obstructing the field (Law 37.1.1) or retired (Law 25.4.1). */
const LAWS_EITHER_BATTER = ["obstructed", "retired", "runout"];
/** Ruling 242 (CK-WK-2): the fielder-credited mode the Laws name no fielder for, whose fielder the scorer may decline. */
const LAWS_NO_FIELDER_NAMED = ["obstructed"];

let compared = 0;
/** One compared fact: an equality between what the skin's builder produced and what the engine declares or folds. */
function same<T>(actual: T, expected: T, what: string): void {
  expect(actual, what).toEqual(expected);
  compared++;
}

function viewOf(cfg: CricketCfg, specs: readonly CricketEventSpec[]): PadHostView {
  const events: EventEnvelope[] = cricketEnvelopes(specs);
  return {
    cfg,
    state: foldMatch(cricket, cfg, cricketLineups(), events),
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads: initSquads(cricketLineups()),
    events,
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
  };
}

/** The ledger plus one emitted event, the emitted one folded on the write path (strict), exactly as the server will. */
function foldEmitted(cfg: CricketCfg, specs: readonly CricketEventSpec[], event: { type: string; payload: unknown }): CricketState {
  const all: CricketEventSpec[] = [...specs, [event.type, event.payload]];
  return foldMatch(cricket, cfg, cricketLineups(), cricketEnvelopes(all), { strictFromSeq: specs.length });
}

function openInnings(state: CricketState) {
  const innings = state.innings.at(-1);
  if (innings?.fine == null) throw new Error("premise: a ball-by-ball innings is open");
  return { ...innings, fine: innings.fine };
}

function choiceIds(spec: GuidedSheetSpec, stepId: string): string[] {
  const step = spec.steps.find((s) => s.id === stepId);
  if (step?.kind !== "choice") throw new Error(`expected a choice step "${stepId}"`);
  return step.options.map((o) => o.id);
}

/** Drives the REAL guided-sheet step machine to the end, answering each step `answer` picks. */
function walk(spec: GuidedSheetSpec, answer: (step: GuidedSheetStep) => string) {
  let state = initialSheetState();
  const asked: string[] = [];
  for (let i = 0; i < 12; i++) {
    const step = currentStep(spec, state);
    if (step === null) throw new Error(`sheet stalled after ${asked.join(" > ")}`);
    asked.push(step.id);
    const advance = answerStep(spec, state, answer(step));
    if (advance.done) return { asked, event: advance.event };
    state = advance.state;
  }
  throw new Error(`sheet never finished: ${asked.join(" > ")}`);
}

const ball = (over: number, ballInOver: number, extra: Record<string, unknown> = {}): CricketEventSpec => [
  "cricket.ball",
  { over, ballInOver, striker: STRIKER, nonStriker: NON_STRIKER, bowler: OPENING_BOWLER, runs: { bat: 0 }, ...extra },
];
const START: readonly CricketEventSpec[] = [["core.start"]];
/** S2-4 Task 3: nobody is picked for the scorer, so a test that taps a ball tile before the fold names the people picks
 *  them, as the scorer must. These are the people `ball` names, so a fold of the tile's payload continues that innings. */
const OPENERS: Readonly<Record<string, string>> = { striker: STRIKER, nonStriker: NON_STRIKER, bowler: OPENING_BOWLER };
/** `viewOf` with the scorer's pending picks. */
function pickedOf(cfg: CricketCfg, specs: readonly CricketEventSpec[], picks: Readonly<Record<string, string>> = OPENERS): PadHostView {
  return { ...viewOf(cfg, specs), contextOverrides: picks };
}
/** The super over's first batters and bowler in the tied fixtures below: away bats first (the side that batted second),
 *  and the first eligible names in each order — the people the pad used to fill in itself. */
const SUPER_OVER_PICKS: Readonly<Record<string, string>> = { striker: "A-1", nonStriker: "A-2", bowler: "H-1" };
const FREE_HIT_PENDING: readonly CricketEventSpec[] = [...START, ball(0, 1, { runs: { bat: 0, extras: { kind: "noball", runs: 1 } } })];

const tilePayload = (tile: TileSpec | undefined): Record<string, unknown> => {
  const action = tile?.action;
  if (action === undefined || !("event" in action)) throw new Error(`tile ${tile?.id} emits no event`);
  return action.event.payload as Record<string, unknown>;
};

/** S2-4 Task 4: the four extras whose tile opens a sheet asking the runs (the penalty is recorded on the tap). */
const EXTRA_SHEETS: readonly string[] = ["wide", "noball", "bye", "legbye"];
/** Answers an extras sheet: `option` at its runs step, then (after the wide's or no-ball's "+ Out", S2-4 Task 6) each
 *  step's first choice or candidate, a fielder with no candidates being the fielding side's seventh name. */
const extrasWalker = (option: string) => (step: GuidedSheetStep): string => {
  if (step.id === "runs") return option;
  if (step.kind === "choice") return step.options[0]!.id;
  if (step.kind === "person") return step.candidates?.[0] ?? `${step.side === "home" ? "H" : "A"}-7`;
  throw new Error(`unexpected step "${step.id}"`);
};
/** The payload one answer of an extras sheet records. */
const extraAnswer = (view: PadHostView, sheet: string, answer: string) => walk(buildSheets(view, t)[sheet]!, extrasWalker(answer)).event;

describe("the wicket sheet offers the engine's modes", () => {
  it("every mode, in the engine's order; with a free hit pending, the engine's free-hit set (folded, not hand-built)", () => {
    same(choiceIds(buildSheets(viewOf(T20, START), t).wicket, "kind"), [...cricketPadRules.wicketKinds], "kind options");
    const freeHit = viewOf(T20, FREE_HIT_PENDING);
    expect(openInnings(freeHit.state as CricketState).fine.freeHitPending, "premise: the fold has a free hit pending").toBe(true);
    const offered = choiceIds(buildSheets(freeHit, t).wicket, "kind");
    same([...offered].sort(), [...cricketPadRules.freeHitDismissalKinds].sort(), "free-hit kind options");
    same([...offered].sort(), RULEBOOK_FREE_HIT, "free-hit kind options are the rulebook's");
    // Order kept: the narrowed list is the engine's mode list filtered, never re-ordered (Review Focus 3).
    same(offered, cricketPadRules.wicketKinds.filter((k) => offered.includes(k)), "free-hit options keep the engine's order");
  });

  it("CK-WK-2 CK-WK-3 CK-WK-5 asks who is out exactly for variableOutKinds and the fielder exactly for fielderCreditedKinds (optional exactly for fielderOptionalKinds), and every payload folds", () => {
    same([...cricketPadRules.variableOutKinds].sort(), LAWS_EITHER_BATTER, "either-batter modes are the Laws'");
    same([...cricketPadRules.fielderOptionalKinds].sort(), LAWS_NO_FIELDER_NAMED, "optional-fielder modes are the Laws'");
    const asked = new Map<string, string[]>();
    let declined = 0;
    for (const kind of cricketPadRules.wicketKinds) {
      const optional = cricketPadRules.fielderOptionalKinds.includes(kind);
      // Pass 1 names the fielder; pass 2 (only where the step is optional) declines it with the sheet's own "" answer.
      for (const fielderAnswer of optional ? [FIELDER, ""] : [FIELDER]) {
        const spec = buildSheets(pickedOf(T20, START), t).wicket;
        const { asked: steps, event } = walk(spec, (step) => {
          if (step.id === "kind") return kind;
          if (step.id === "out") return NON_STRIKER; // the other batter: only a mode either batter can be out in asks
          if (step.id === "fielder" || step.id === "fielderOptional") {
            same(step.kind === "person" && step.optional === true, optional, `${kind}: the fielder step is optional`);
            return fielderAnswer;
          }
          // S2-4 Task 5: a stumping names the keeper (the lineup's), and a run out its runs completed (none, here).
          if (step.id === "keeper") return KEEPER;
          if (step.id === "completed") return "0";
          if (step.kind === "person" && step.candidates?.[0] !== undefined) return step.candidates[0];
          throw new Error(`${kind}: unexpected step "${step.id}"`);
        });
        if (fielderAnswer === FIELDER) asked.set(kind, steps);
        const variable = cricketPadRules.variableOutKinds.includes(kind);
        const credited = cricketPadRules.fielderCreditedKinds.includes(kind);
        const creditedTo = kind === "stumped" ? KEEPER : FIELDER;
        same(steps.includes("out"), variable, `${kind}: who's out asked`);
        same(steps.includes("fielder") || steps.includes("fielderOptional") || steps.includes("keeper"), credited, `${kind}: fielder asked`);
        const wicket = (event.payload as { wicket: { out: string; fielder?: string; bowlerCredited: boolean } }).wicket;
        same(wicket.out, variable ? NON_STRIKER : STRIKER, `${kind}: out`);
        same(wicket.bowlerCredited, cricketPadRules.bowlerCreditedKinds.includes(kind), `${kind}: bowlerCredited`);
        // The seam's consumer: the engine takes the sheet's own payload on the write path, and credits the fielder it named.
        const innings = openInnings(foldEmitted(T20, START, event));
        same(innings.fine.dismissed, [wicket.out], `${kind}: the fold dismissed the batter the sheet named`);
        same(innings.fine.fielding?.[creditedTo] !== undefined, credited && fielderAnswer === FIELDER, `${kind}: the fold credited the fielder`);
        if (fielderAnswer === "") {
          same(wicket.fielder, undefined, `${kind}: a declined fielder is not written`);
          declined++;
        }
      }
    }
    // Ruling 242, pinned by name: obstructing asks who is out, then a fielder the scorer may decline; retired asks who is out.
    same(asked.get(OBSTRUCTED), ["kind", "out", "fielderOptional", "incoming"], "obstructed's steps");
    same(asked.get("retired"), ["kind", "out", "incoming"], "retired's steps");
    // S2-4 Task 5 (gaps 5, 6): a stumping asks the keeper, not a fielder; a run out asks the runs completed.
    same(asked.get("stumped"), ["kind", "keeper", "incoming"], "stumped's steps");
    same(asked.get("runout"), ["kind", "out", "fielder", "completed", "incoming"], "run out's steps");
    same(asked.get("caught"), ["kind", "fielder", "incoming"], "caught's steps");
    console.info(`[pad-rules-cricket] wicket modes walked: ${asked.size}, fielder declined: ${declined}`);
    expect(asked.size).toBe(10);
    expect(declined).toBe(LAWS_NO_FIELDER_NAMED.length);
  });

  it("on a free hit the sheet's run out and obstructing payloads fold on the write path (review m3)", () => {
    let folded = 0;
    for (const kind of cricketPadRules.freeHitDismissalKinds) {
      const spec = buildSheets(viewOf(T20, FREE_HIT_PENDING), t).wicket;
      const { event } = walk(spec, (step) => {
        if (step.id === "kind") return kind;
        if (step.id === "out") return STRIKER;
        if (step.id === "fielder" || step.id === "fielderOptional") return FIELDER;
        if (step.id === "completed") return "0"; // S2-4 Task 5: a run out asks the runs completed
        if (step.kind === "person" && step.candidates?.[0] !== undefined) return step.candidates[0];
        throw new Error(`${kind}: unexpected step "${step.id}"`);
      });
      const innings = openInnings(foldEmitted(T20, FREE_HIT_PENDING, event));
      same(innings.fine.dismissed, [STRIKER], `${kind} on a free hit: folded`);
      folded++;
    }
    expect(folded).toBe(RULEBOOK_FREE_HIT.length);
  });
});

/** A sheet's person step answered with its first candidate (the pad's suggestion first: the next batter, the keeper). */
const firstCandidate = (step: GuidedSheetStep): string => {
  if (step.kind === "person" && step.candidates?.[0] !== undefined) return step.candidates[0];
  throw new Error(`unexpected step "${step.id}"`);
};
/** The ledger after `n` wickets, each a bowled the scorer records through the wicket sheet (the next batter its first
 *  candidate), with the bowler changed at every over's end as the Laws require. `bpo` is the cfg's balls per over. */
function afterWickets(cfg: CricketCfg, n: number, bpo = 6): CricketEventSpec[] {
  const specs: CricketEventSpec[] = [...START];
  for (let i = 0; i < n; i++) {
    const legal = (viewOf(cfg, specs).state as CricketState).innings.at(-1)?.legalBalls ?? 0;
    const picks = i === 0 ? OPENERS : legal % bpo === 0 ? { bowler: Math.floor(legal / bpo) % 2 === 0 ? OPENING_BOWLER : "A-10" } : {};
    const { event } = walk(buildSheets(pickedOf(cfg, specs, picks), t).wicket, (step) => (step.id === "kind" ? "bowled" : firstCandidate(step)));
    specs.push([event.type, event.payload]);
  }
  return specs;
}
/** The away side's team sheet changed by `edit`, the home side's as `cricketLineups()` builds it. */
function awaySheet(edit: (slot: LineupPair["away"]["slots"][number]) => LineupPair["away"]["slots"][number]): LineupPair {
  const lineups = cricketLineups();
  return { ...lineups, away: { ...lineups.away, slots: lineups.away.slots.map(edit) } };
}
const withoutRoles = <S extends { roles?: readonly string[] }>(slot: S): S => ({ ...slot, roles: undefined });

describe("S2-4 T5: the wicket sheet asks the keeper, the runs completed, and the next batter only when one walks in", () => {
  it("stumped offers the keeper: by role, else by WK position, else the side without the bowler", () => {
    const AWAY = Array.from({ length: 11 }, (_, i) => `A-${i + 1}`);
    const cases: [name: string, lineups: LineupPair, keepers: string[]][] = [
      ["by role", awaySheet((slot) => (slot.personId === "A-5" ? { ...slot, roles: [KEEPER_ROLE] } : withoutRoles(slot))), ["A-5"]],
      ["by position", awaySheet((slot) => (slot.personId === "A-6" ? { ...withoutRoles(slot), positionKey: KEEPER_POSITION } : withoutRoles(slot))), ["A-6"]],
      ["no keeper named", awaySheet(withoutRoles), AWAY.filter((id) => id !== OPENING_BOWLER)],
    ];
    let folded = 0;
    for (const [name, lineups, keepers] of cases) {
      const view = { ...pickedOf(T20, START), squads: initSquads(lineups) };
      let offered: readonly string[] | undefined;
      const { asked, event } = walk(buildSheets(view, t).wicket, (step) => {
        if (step.id === "kind") return "stumped";
        if (step.id === "keeper" && step.kind === "person") offered = step.candidates;
        return firstCandidate(step);
      });
      same(offered, keepers, `${name}: the keeper step's candidates`);
      same(asked.includes("fielder"), false, `${name}: a stumping asks no other fielder`);
      const wicket = (event.payload as { wicket: { fielder?: string } }).wicket;
      same(wicket.fielder, keepers[0], `${name}: the stumping credits the keeper`);
      const innings = openInnings(foldEmitted(T20, START, event));
      same(innings.fine.dismissed, [STRIKER], `${name}: the fold dismissed the striker`);
      same(innings.fine.fielding?.[keepers[0]!] !== undefined, true, `${name}: the fold credited the keeper`);
      folded++;
    }
    expect(folded).toBe(3);
  });

  it("a run out asks runs completed 0-3 and the batting side gets them", () => {
    const offered = new Set<string>();
    let folded = 0;
    for (const n of [0, 1, 2, 3]) {
      const spec = buildSheets(pickedOf(T20, START), t).wicket;
      const { event } = walk(spec, (step) => {
        if (step.id === "kind") return "runout";
        if (step.id === "out") return NON_STRIKER;
        if (step.id === "fielder") return FIELDER;
        if (step.id === "completed" && step.kind === "choice") {
          for (const option of step.options) offered.add(option.id);
          return String(n);
        }
        return firstCandidate(step);
      });
      same((event.payload as { runs: { bat: number } }).runs.bat, n, `completed ${n}: runs.bat`);
      const innings = openInnings(foldEmitted(T20, START, event));
      same(innings.runs, n, `completed ${n}: the fold's runs go up by ${n}`);
      same(innings.fine.dismissed, [NON_STRIKER], `completed ${n}: the batter named is out`);
      folded++;
    }
    same([...offered], ["0", "1", "2", "3"], "the runs completed offered");
    expect(folded).toBe(4);
  });

  it("the next batter is asked on an ordinary wicket and not on the innings' last legal ball, at all out, or on the super over's second wicket", () => {
    const SIX = tiedWithSuperOver();
    const lastBallOfInnings: CricketEventSpec[] = [...START, ...[1, 2, 3, 4, 5].map((n) => ball(0, n))];
    const tied: CricketEventSpec[] = [
      ...START,
      ...[1, 2, 3, 4, 5, 6].map((n): CricketEventSpec => ["cricket.ball", { over: 0, ballInOver: n, striker: "H-1", nonStriker: "H-2", bowler: "A-11", runs: { bat: 0 } }]),
      ...[1, 2, 3, 4, 5, 6].map((n): CricketEventSpec => ["cricket.ball", { over: 0, ballInOver: n, striker: "A-1", nonStriker: "A-2", bowler: "H-11", runs: { bat: 0 } }]),
    ];
    expect((viewOf(SIX, tied).state as CricketState).phase, "premise: a super over").toBe("super_over");
    const firstSuperOverWicket = walk(buildSheets(pickedOf(SIX, tied, SUPER_OVER_PICKS), t).wicket, (step) =>
      step.id === "kind" ? "bowled" : firstCandidate(step),
    ).event;
    const oneDownInSuperOver: CricketEventSpec[] = [...tied, [firstSuperOverWicket.type, firstSuperOverWicket.payload]];
    const nineDown = afterWickets(T20, 9);
    expect(openInnings(viewOf(T20, nineDown).state as CricketState).wickets, "premise: nine down").toBe(9);
    const cases: [name: string, view: PadHostView, cfg: CricketCfg, specs: CricketEventSpec[], asks: boolean][] = [
      ["an ordinary wicket", pickedOf(T20, START), T20, [...START], true],
      ["the innings' last legal ball", viewOf(SIX, lastBallOfInnings), SIX, lastBallOfInnings, false],
      ["the tenth wicket (all out)", viewOf(T20, nineDown), T20, nineDown, false],
      ["the super over's second wicket", viewOf(SIX, oneDownInSuperOver), SIX, oneDownInSuperOver, false],
    ];
    let folded = 0;
    for (const [name, view, cfg, specs, asks] of cases) {
      const { asked, event } = walk(buildSheets(view, t).wicket, (step) => (step.id === "kind" ? "bowled" : firstCandidate(step)));
      same(asked.includes("incoming"), asks, `${name}: who walks in is asked`);
      const after = foldEmitted(cfg, specs, event);
      // The ball folds as the server will, and (where nobody was asked) it did close the innings or the super over.
      if (!asks) same(after.phase !== (view.state as CricketState).phase || (after.superOver ?? after).innings.at(-1)?.closed === true, true, `${name}: the innings is over`);
      folded++;
    }
    expect(folded).toBe(4);
  });

  it("a run out whose completed runs win the chase asks no next batter", () => {
    const SIX = tiedWithSuperOver();
    // Home make 1 off their six balls, so away need 2.
    const firstInnings: CricketEventSpec[] = [...START, ...[1, 2, 3, 4, 5].map((n) => ball(0, n)), ball(0, 6, { runs: { bat: 1 } })];
    const chase = pickedOf(SIX, firstInnings, { striker: "A-1", nonStriker: "A-2", bowler: "H-11" });
    let checked = 0;
    for (const [completed, asks] of [["2", false], ["0", true]] as const) {
      const { asked, event } = walk(buildSheets(chase, t).wicket, (step) => {
        if (step.id === "kind") return "runout";
        if (step.id === "out") return "A-1";
        if (step.id === "fielder") return "H-7";
        if (step.id === "completed") return completed;
        return firstCandidate(step);
      });
      same(asked.includes("incoming"), asks, `completed ${completed}: who walks in is asked`);
      const after = foldEmitted(SIX, firstInnings, event);
      same(after.innings.at(-1)?.runs, Number(completed), `completed ${completed}: the fold's runs`);
      same(after.innings.at(-1)?.closed, !asks, `completed ${completed}: the chase is won only with 2`);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a wicket on the chase's last ball whose runs tie it into a super over asks no next batter (review I1)", () => {
    const SIX = tiedWithSuperOver();
    // Home make 1 off their six balls; away are 0 off five, so a run out with 1 completed on the sixth ties the match.
    const fiveOfSix: CricketEventSpec[] = [
      ...START,
      ...[1, 2, 3, 4, 5].map((n) => ball(0, n)),
      ball(0, 6, { runs: { bat: 1 } }),
      ...[1, 2, 3, 4, 5].map((n): CricketEventSpec => ["cricket.ball", { over: 0, ballInOver: n, striker: "A-1", nonStriker: "A-2", bowler: "H-11", runs: { bat: 0 } }]),
    ];
    const lastBall = viewOf(SIX, fiveOfSix);
    let checked = 0;
    for (const [completed, asks] of [["1", false], ["0", false]] as const) {
      const { asked, event } = walk(buildSheets(lastBall, t).wicket, (step) => {
        if (step.id === "kind") return "runout";
        if (step.id === "out") return "A-1";
        if (step.id === "fielder") return "H-7";
        if (step.id === "completed") return completed;
        return firstCandidate(step);
      });
      same(asked.includes("incoming"), asks, `last ball, completed ${completed}: who walks in is asked`);
      const after = foldEmitted(SIX, fiveOfSix, event);
      same(after.innings.at(-1)?.closed, true, `last ball, completed ${completed}: the main innings is over`);
      same(after.phase, completed === "1" ? "super_over" : "done", `completed ${completed}: a tie goes to a super over, a loss ends it`);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the keeper keys are in the engine's position catalog (preflight W10)", () => {
    same((cricket.positions.roles ?? []).some((role) => role.key === KEEPER_ROLE), true, "the keeper role is the catalog's");
    same(cricket.positions.groups.some((group) => group.key === KEEPER_POSITION), true, "the keeper position is the catalog's");
    // Pinned by name too, so a renamed catalog key goes red here rather than leaving the pad on a key nothing sets.
    same([KEEPER_ROLE, KEEPER_POSITION], ["wicketkeeper", "WK"], "the keys");
  });
});

describe("the obstructing fielder's decline control reads cricket's own label (review I-A)", () => {
  /** The decline control's text, rendered by the real GuidedSheet on `step` alone (its `when` dropped so it is step one). */
  const declineText = (view: PadHostView, spec: GuidedSheetSpec, step: GuidedSheetStep): string | undefined => {
    const html = renderToStaticMarkup(
      createElement(GuidedSheet, {
        spec: { ...spec, steps: [{ ...step, when: undefined }] },
        views: { home: { squad: view.squads.home }, away: { squad: view.squads.away } },
        personNames: {},
        t: (key: string) => key,
        onComplete: () => undefined,
      }),
    );
    return /data-role="v3-person-none"[^>]*>([^<]*)</.exec(html)?.[1];
  };

  it("the obstructed fielder step declines with \"No fielder\" (pad.cricket.sheet.wicket.fielder.none); a step that names no label, as the sin-bin's servedBy, keeps the shared pad.sheet.person.none", () => {
    const view = viewOf(T20, START);
    const spec = buildSheets(view, t).wicket;
    const step = spec.steps.find((s) => s.id === "fielderOptional");
    if (step === undefined || step.kind !== "person") throw new Error("premise: the obstructed fielder step is a person step");
    same(step.noneLabel, "pad.cricket.sheet.wicket.fielder.none", "the step's own label");
    same(declineText(view, spec, step), "pad.cricket.sheet.wicket.fielder.none", "the rendered decline control");
    // The shared default, unchanged for every step that sets no label (period-shared's servedBy sets none).
    same(declineText(view, spec, { ...step, noneLabel: undefined }), "pad.sheet.person.none", "a step with no label");
    // A required step renders no decline control at all.
    same(declineText(view, spec, { ...step, optional: undefined }), undefined, "a required step has no decline control");
    // The copy differs: the sin-bin's sentence is about who serves a penalty.
    expect(uiEn["pad.cricket.sheet.wicket.fielder.none"]).not.toBe(uiEn["pad.sheet.person.none"]);
  });
});

describe("the free hit is the fold's (review I2)", () => {
  const freeHitChip = (view: PadHostView) => buildScorebug(view, t).strip.find((item) => item.id === "freeHit");

  it("a no ball, taken back: the next delivery shows no free hit and offers every mode, and a bowled from the sheet folds", () => {
    const specs: CricketEventSpec[] = [...START, ball(0, 1), ball(0, 2, { runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }), ["core.void", {}, "e-2"]];
    const view = viewOf(T20, specs);
    expect(openInnings(view.state as CricketState).fine.freeHitPending, "premise: the fold cleared it").toBe(false);
    same(freeHitChip(view), undefined, "no free-hit chip after the take-back");
    same(choiceIds(buildSheets(view, t).wicket, "kind"), [...cricketPadRules.wicketKinds], "every mode offered after the take-back");
    const { event } = walk(buildSheets(view, t).wicket, (step) => {
      if (step.id === "kind") return "bowled";
      if (step.kind === "person" && step.candidates?.[0] !== undefined) return step.candidates[0];
      throw new Error(`bowled: unexpected step "${step.id}"`);
    });
    same(openInnings(foldEmitted(T20, specs, event)).wickets, 1, "a bowled after the take-back folds");
  });

  it("a no ball in a super over shows the free hit and narrows the sheet, even when the main match is unlimited-overs (the engine's super over is white-ball)", () => {
    const cfgs = [
      ["one over a side", tiedWithSuperOver()],
      ["unlimited overs", cricket.configSchema.parse({ superOver: true, ballsPerInnings: null })],
    ] as const;
    let checked = 0;
    for (const [name, cfg] of cfgs) {
      const main: CricketEventSpec[] = cfg.ballsPerInnings === null
        ? [["core.start"], ["cricket.ball", { over: 0, ballInOver: 1, striker: "H-1", nonStriker: "H-2", bowler: "A-11", runs: { bat: 1 } }], ["cricket.innings.close", { reason: "other" }],
          ["cricket.ball", { over: 0, ballInOver: 1, striker: "A-1", nonStriker: "A-2", bowler: "H-11", runs: { bat: 1 } }], ["cricket.innings.close", { reason: "other" }]]
        : [["core.start"], ...[1, 2, 3, 4, 5, 6].map((n): CricketEventSpec => ["cricket.ball", { over: 0, ballInOver: n, striker: "H-1", nonStriker: "H-2", bowler: "A-11", runs: { bat: 0 } }]),
          ...[1, 2, 3, 4, 5, 6].map((n): CricketEventSpec => ["cricket.ball", { over: 0, ballInOver: n, striker: "A-1", nonStriker: "A-2", bowler: "H-11", runs: { bat: 0 } }])];
      const tied = pickedOf(cfg, main, SUPER_OVER_PICKS);
      expect((tied.state as CricketState).phase, `${name}: premise, a super over`).toBe("super_over");
      const noBallTile = buildTiles(tied, t).find((tile) => tile.id === "extra-noball");
      expect(noBallTile?.action, `${name}: the no-ball tile opens its sheet`).toEqual({ sheet: "noball" });
      const { event: noBall } = walk(buildSheets(tied, t).noball, () => "bat:0");
      same(noBall.type, "cricket.superover.ball", `${name}: the no-ball sheet records a super-over ball`);
      const specs: CricketEventSpec[] = [...main, ["cricket.superover.ball", noBall.payload]];
      const view = viewOf(cfg, specs);
      same(freeHitChip(view)?.id, "freeHit", `${name}: the super-over no ball shows the free hit`);
      same([...choiceIds(buildSheets(view, t).wicket, "kind")].sort(), RULEBOOK_FREE_HIT, `${name}: the sheet narrows to the free-hit modes`);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("CK-SO-3 in a super over the pad offers only what the fold accepts (review, trace c)", () => {
  it.each([
    ["no DLS", {}],
    ["DLS on (Revise in padSpec)", { dls: { enabled: true, edition: "standard" } }],
  ] as const)("%s: every enabled tile and the wicket sheet fold on the write path, and every More action is a type the engine accepts in a super over", (_name, overrides) => {
    const cfg = tiedWithSuperOver(overrides);
    const side = (striker: string, nonStriker: string, bowler: string): CricketEventSpec[] =>
      [1, 2, 3, 4, 5, 6].map((n) => ["cricket.ball", { over: 0, ballInOver: n, striker, nonStriker, bowler, runs: { bat: 0 } }]);
    const main: CricketEventSpec[] = [["core.start"], ...side("H-1", "H-2", "A-11"), ...side("A-1", "A-2", "H-11")];
    const view = pickedOf(cfg, main, SUPER_OVER_PICKS);
    expect((view.state as CricketState).phase, "premise: a super over").toBe("super_over");
    const tiles = buildTiles(view, t);
    const sheets = buildSheets(view, t);
    let offered = 0;
    for (const tile of tiles) {
      if (tile.disabled === true || tile.action === undefined) continue;
      const action = tile.action;
      if ("event" in action) {
        expect(() => foldEmitted(cfg, main, action.event), `tile ${tile.id}`).not.toThrow();
        offered++;
      } else if ("sheet" in action && EXTRA_SHEETS.includes(action.sheet)) {
        // S2-4 Task 4: every runs answer of an extras sheet folds in a super over (Task 6: "+ Out" too, with its first kind).
        for (const option of choiceIds(sheets[action.sheet]!, "runs")) {
          const { event } = walk(sheets[action.sheet]!, extrasWalker(option));
          expect(() => foldEmitted(cfg, main, event), `${action.sheet} sheet: ${option}`).not.toThrow();
          offered++;
        }
      } else if ("sheet" in action && action.sheet === "wicket") {
        const { event } = walk(sheets.wicket, (step) => {
          if (step.id === "kind") return "bowled";
          if (step.kind === "person" && step.candidates?.[0] !== undefined) return step.candidates[0];
          throw new Error(`super-over wicket: unexpected step "${step.id}"`);
        });
        expect(() => foldEmitted(cfg, main, event), "the wicket sheet").not.toThrow();
        offered++;
      }
    }
    const dedicated = dedicatedEventTypes(tiles, sheets, [], buildScorebug(view, t));
    const padSpec = cricket.padSpec?.(cfg);
    if (padSpec === undefined) throw new Error("premise: cricket declares a padSpec");
    const ctx = { state: view.state, summary: {}, phase: "live" as const, band: 3 as const };
    const more = moreActions(padSpec, ctx, dedicated, new Set(refusedEventTypes(view)));
    for (const action of more) {
      same(cricketPadRules.superOverEventTypes.includes(action.type), true, `More offers ${action.type} in a super over`);
      offered++;
    }
    // Not vacuous: padSpec still lists actions here (New ball, Powerplay, Interruption, and Revise with DLS); every one the
    // skin withholds is one the engine refuses in a super over.
    const unfiltered = moreActions(padSpec, ctx, dedicated, new Set());
    const withheld = unfiltered.filter((action) => !more.some((kept) => kept.type === action.type));
    for (const action of withheld) same(cricketPadRules.superOverEventTypes.includes(action.type), false, `More withholds ${action.type}`);
    for (const type of ["cricket.newball", "cricket.powerplay", "cricket.interruption"]) {
      expect(withheld.map((action) => action.type), `${type} is withheld`).toContain(type);
    }
    if ("dls" in overrides) expect(withheld.map((action) => action.type)).toContain("cricket.revise");
    console.info(`[pad-rules-cricket] super over (${_name}): ${offered} offered actions folded/checked, ${withheld.length} More actions withheld`);
    expect(offered).toBeGreaterThanOrEqual(5);
    expect(withheld.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the tiles, dock and option sheets offer the engine's sets", () => {
  it("CK-EX-1 CK-EX-2 CK-PR-2 one extra tile per engine extra kind; the wide records wideDefaultRuns and the penalty penaltyRuns, both as the fold scores them", () => {
    const view = pickedOf(T20, START);
    const tiles = buildTiles(view, t);
    // S2-4 Task 4: the penalty tile records its ball; the other four extras open a sheet, whose first answer records it.
    const kindOf = (payload: Record<string, unknown>) => (payload.runs as { extras?: { kind: string } }).extras?.kind;
    const extraPayloads = new Map<string, Record<string, unknown>>();
    for (const tile of tiles) {
      const action = tile.action;
      if (action === undefined) continue;
      if ("event" in action) {
        const kind = kindOf(action.event.payload as Record<string, unknown>);
        if (kind !== undefined) extraPayloads.set(kind, action.event.payload as Record<string, unknown>);
      } else if ("sheet" in action && EXTRA_SHEETS.includes(action.sheet)) {
        const first = choiceIds(buildSheets(view, t)[action.sheet]!, "runs")[0]!;
        const payload = extraAnswer(view, action.sheet, first).payload as Record<string, unknown>;
        extraPayloads.set(kindOf(payload) ?? "", payload);
      }
    }
    same([...extraPayloads.keys()].sort(), [...cricketPadRules.extraKinds].sort(), "extra kinds a tile or its sheet records");

    const runsOf = (kind: string) => (extraPayloads.get(kind)!.runs as { extras: { runs: number } }).extras.runs;
    same(runsOf("wide"), cricketPadRules.wideDefaultRuns, "a wide with no run records wideDefaultRuns");
    same(runsOf("noball"), cricketPadRules.noBallDefaultRuns, "a no-ball off the bat records noBallDefaultRuns");
    const noBall = openInnings(foldEmitted(T20, START, { type: "cricket.ball", payload: extraPayloads.get("noball")! }));
    same([noBall.runs, noBall.legalBalls, noBall.fine.freeHitPending], [cricketPadRules.noBallDefaultRuns, 0, true], "a no-ball, folded");
    same(runsOf("penalty"), cricketPadRules.penaltyRuns, "penalty tile runs");
    const wide = openInnings(foldEmitted(T20, START, { type: "cricket.ball", payload: extraPayloads.get("wide")! }));
    same([wide.runs, wide.legalBalls, wide.fine.striker], [cricketPadRules.wideDefaultRuns, 0, STRIKER], "a wide, folded");
    const penalty = openInnings(foldEmitted(T20, START, { type: "cricket.ball", payload: extraPayloads.get("penalty")! }));
    same(penalty.runs, cricketPadRules.penaltyRuns, "a penalty tile, folded");
  });

  it("CK-BD-1 a run tile and a no ball's runs off the bat carry `boundary` exactly for the engine's boundary values", () => {
    const view = pickedOf(T20, START);
    const tiles = buildTiles(view, t).filter((tile) => /^run\d+$/.test(tile.id));
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      const payload = tilePayload(tile);
      const runs = (payload.runs as { bat: number }).bat;
      same(payload.boundary, cricketPadRules.boundaryValues.includes(runs) ? runs : undefined, `${tile.id} boundary`);
    }
    const options = choiceIds(buildSheets(view, t).noball, "runs");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const payload = extraAnswer(view, "noball", option).payload as { runs: { bat: number }; boundary?: number };
      const offBat = option.startsWith("bat:") ? payload.runs.bat : null;
      same(payload.boundary, offBat !== null && cricketPadRules.boundaryValues.includes(offBat) ? offBat : undefined, `no-ball ${option} boundary`);
    }
  });

  it("toss, retire, review and innings-close sheets offer the engine's option sets, in its order", () => {
    const sheets = buildSheets(viewOf(T20, START), t);
    same(choiceIds(sheets.toss, "elected"), [...cricketPadRules.tossElections], "toss elected");
    same(choiceIds(sheets.retire, "reason"), [...cricketPadRules.retireReasons], "retire reason");
    same(choiceIds(sheets.review, "kind"), [...cricketPadRules.reviewKinds], "review kind");
    same(choiceIds(sheets.review, "outcome"), [...cricketPadRules.reviewOutcomes], "review outcome");
    same(choiceIds(sheets.inningsClose, "reason"), [...cricketPadRules.inningsCloseReasons], "innings-close reason");
  });
});

describe("CK-BO-2 balls per over is the cfg's, at two cfgs", () => {
  it("after five legal balls the next delivery is numbered by the cfg's over (T20 6, the hundred 5), and the fold takes it", () => {
    const numbering = new Map<string, [number, number]>();
    for (const [name, cfg] of [["t20", T20], ["hundred", HUNDRED]] as const) {
      same(cricketPadRules.ballsPerOver(cfg), cfg.ballsPerOver, `${name}: ballsPerOver`);
      const specs: CricketEventSpec[] = [...START, ...[1, 2, 3, 4, 5].map((n) => ball(0, n))];
      // A-1 is picked for the next over: the hundred's sixth ball opens over 2, and its bowler is asked, not defaulted. At
      // T20 the over is still open, so the fold's own bowler (A-11) wins over the pick.
      const dot = tilePayload(buildTiles(pickedOf(cfg, specs, { bowler: "A-1" }), t).find((tile) => tile.id === "run0"));
      numbering.set(name, [dot.over as number, dot.ballInOver as number]);
      // The fold checks over/ballInOver (and a new over's bowler) against ITS cfg on the write path: a skin that assumed six
      // balls would be refused at the hundred.
      same(openInnings(foldEmitted(cfg, specs, { type: "cricket.ball", payload: dot })).legalBalls, 6, `${name}: the sixth legal ball folds`);
    }
    same(numbering.get("t20"), [0, 6], "t20: the sixth ball of over 0");
    same(numbering.get("hundred"), [1, 1], "hundred: the first ball of over 1");
  });
});

/** Five dot balls of the first over (the over in progress), and six (the over just ended, the next bowler not yet named). */
function firstOver(balls: number): CricketEventSpec[] {
  const next = ballSeq(T20.ballsPerOver);
  return [...START, ...Array.from({ length: balls }, () => next("cricket.ball", { striker: STRIKER, nonStriker: NON_STRIKER, bowler: OPENING_BOWLER }))];
}
const MID_OVER: readonly CricketEventSpec[] = firstOver(5);
const OVER_END: readonly CricketEventSpec[] = firstOver(6);
const ctxOf = (view: PadHostView) => ({ state: view.state, summary: {}, phase: "live" as const, band: 3 as const });

describe("S2-4 T1: the bowler change has no surface yet", () => {
  it("S2-4 T1: More never lists cricket.bowler.change", () => {
    let checked = 0;
    for (const specs of [START, MID_OVER, OVER_END]) {
      const view = viewOf(T20, specs);
      const more = moreActions(
        cricket.padSpec!(T20),
        ctxOf(view),
        dedicatedEventTypes(buildTiles(view, t), buildSheets(view, t), [], buildScorebug(view, t)),
        new Set(refusedEventTypes(view)),
      );
      expect(more.map((a) => a.type)).not.toContain("cricket.bowler.change");
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("S2-4 T2: the toss names the teams", () => {
  it("the toss names the teams, by entrant id, and folds", () => {
    const names = { home: "Northfield Cricket Club", away: "Southgate Strollers" };
    const view = { ...viewOf(T20, []), phase: "pre" as const, entrantNames: names };
    const toss = buildSheets(view, t).toss;
    const won = toss.steps.find((s) => s.id === "wonBy");
    if (won?.kind !== "choice") throw new Error("premise: the toss asks who won as a choice");
    same(choiceIds(toss, "wonBy"), [view.squads.home.entrantId, view.squads.away.entrantId], "toss options are the entrant ids");
    same(won.options.map((o) => o.labelText), [names.home, names.away], "toss options read the team names");
    // The key stays as the fallback label, so a side with no name still reads Home / Away.
    same(won.options.map((o) => o.label), ["scorepad.attribution.home", "scorepad.attribution.away"], "toss fallback keys");
    const nameless = buildSheets({ ...view, entrantNames: { home: names.home } }, t).toss.steps.find((s) => s.id === "wonBy");
    if (nameless?.kind !== "choice") throw new Error("premise: the toss asks who won as a choice");
    same(nameless.options.map((o) => o.labelText), [names.home, undefined], "a side with no name has no labelText");
    // The seam's consumer: the walked payload folds, before core.start, on the write path.
    let folded = 0;
    for (const side of ["home", "away"] as const) {
      const entrant = view.squads[side].entrantId;
      expect(cricketPadRules.tossElections, "premise: bat is an election the engine offers").toContain("bat");
      const { event } = walk(toss, (step) => (step.id === "wonBy" ? entrant : "bat"));
      const folded_ = foldEmitted(T20, [], event);
      same([folded_.tossTaken, folded_.battingFirst], [true, side], `${side}: the fold took the toss, and the winner bats`);
      folded++;
    }
    expect(folded).toBe(2);
  });
});

describe("S2-4 gaps 1-2: nothing is picked for the scorer", () => {
  /** Every tile that emits a ball (runs, the wide, the minor extras) or opens the wicket sheet: the tiles a missing
   *  person would make the fold refuse. */
  const BALL_TILE = /^(run\d+|wide|wicket|extra-.+)$/;
  const ballTiles = (view: PadHostView) => buildTiles(view, t).filter((tile) => BALL_TILE.test(tile.id));
  /** A translator that keeps the vars, so a message's over number is asserted, not just its key. */
  const tv: TFn = (key, vars) => (vars === undefined ? key : `${key} ${JSON.stringify(vars)}`);
  const slot = (view: PadHostView, id: string) => buildContext(view, tv)?.slots.find((s) => s.id === id);
  const withPicks = (view: PadHostView, picks: Record<string, string>): PadHostView => ({ ...view, contextOverrides: picks });
  /** `overs.length` complete overs of dots at `cfg`'s over length, bowled by `overs[i]`, ends swapping each over as the
   *  Laws have them (Law 17.2: the ends change, so the other batter faces the next over). */
  function oversBy(cfg: CricketCfg, overs: readonly string[], extraBalls = 0): CricketEventSpec[] {
    const next = ballSeq(cfg.ballsPerOver);
    const out: CricketEventSpec[] = [...START];
    overs.forEach((bowler, i) => {
      const [striker, nonStriker] = i % 2 === 0 ? [STRIKER, NON_STRIKER] : [NON_STRIKER, STRIKER];
      for (let b = 0; b < cfg.ballsPerOver; b++) out.push(next("cricket.ball", { striker, nonStriker, bowler }));
    });
    const [striker, nonStriker] = overs.length % 2 === 0 ? [STRIKER, NON_STRIKER] : [NON_STRIKER, STRIKER];
    for (let b = 0; b < extraBalls; b++) out.push(next("cricket.ball", { striker, nonStriker, bowler: OPENING_BOWLER }));
    return out;
  }

  it("before the first ball the openers and the bowler are unpicked and every ball tile is disabled, with the reason on the strip", () => {
    const view = viewOf(T20, START);
    same(resolvePeople(view.state as CricketState, {}, T20), { battingSide: "home", bowlingSide: "away", striker: "", nonStriker: "", bowler: "" }, "nobody is picked");
    const tiles = ballTiles(view);
    expect(tiles.length, "the pad offers ball tiles to block").toBeGreaterThan(0);
    for (const tile of tiles) same(tile.disabled, true, `${tile.id} waits for the picks`);
    same(slot(view, "striker")?.message, "pad.cricket.context.openers.unpicked", "the striker slot asks for the openers");
    same(slot(view, "bowler")?.message, 'pad.cricket.context.bowler.unpicked {"over":1}', "the bowler slot asks for over 1's bowler");
    // Two of the three picked is still not enough: each person is asked.
    for (const missing of ["striker", "nonStriker", "bowler"] as const) {
      const picks: Record<string, string> = { striker: "H-3", nonStriker: "H-1", bowler: "A-9" };
      delete picks[missing];
      same(ballTiles(withPicks(view, picks)).every((tile) => tile.disabled === true), true, `without the ${missing}, every ball tile waits`);
    }
  });

  it("with the three picked, the first ball names them and folds", () => {
    // Not the order's first two, nor its first bowler: a default would name H-1/H-2/A-1 and fail here.
    const view = withPicks(viewOf(T20, START), { striker: "H-3", nonStriker: "H-1", bowler: "A-9" });
    const tiles = ballTiles(view);
    for (const tile of tiles) same(tile.disabled, undefined, `${tile.id} is open once the three are picked`);
    same(slot(view, "striker")?.message, undefined, "no openers message once picked");
    same(slot(view, "bowler")?.message, undefined, "no bowler message once picked");
    const run1 = tilePayload(tiles.find((tile) => tile.id === "run1"));
    same([run1.striker, run1.nonStriker, run1.bowler], ["H-3", "H-1", "A-9"], "the payload names the picks");
    const innings = openInnings(foldEmitted(T20, START, { type: "cricket.ball", payload: run1 }));
    same(innings.fine.dismissed, [], "the fold dismissed nobody");
    same([innings.fine.bowlerBalls["A-9"], innings.fine.batterRuns["H-3"], innings.fine.currentBowler], [1, 1, "A-9"], "the fold credited A-9 and H-3");
  });

  it("at an over's end the bowler is unpicked; the picker greys the last over's bowler (prevOver) and a bowler at quota (quota)", () => {
    const quota = T20.maxOversPerBowler;
    if (quota === undefined) throw new Error("premise: T20 sets a bowler's quota");
    // The opening bowler bowls every other over to his quota; A-10 the overs between; A-9 the last one.
    const overs: string[] = [];
    for (let i = 0; i < quota; i++) overs.push(OPENING_BOWLER, "A-10");
    overs.splice(overs.length - 1, 1, "A-9");
    const view = viewOf(T20, oversBy(T20, overs));
    const state = view.state as CricketState;
    const fine = openInnings(state).fine;
    expect(fine.currentBowler, "premise: the over has ended").toBeNull();
    const people = resolvePeople(state, {}, T20);
    same(people.bowler, "", "nobody is picked for the next over");
    same(bowlerBlockReason(state, people, T20), "unpicked", "the reason is the pick, not a block");
    same(slot(view, "bowler")?.message, `pad.cricket.context.bowler.unpicked {"over":${overs.length + 1}}`, "the slot asks for the next over's bowler");
    for (const tile of ballTiles(view)) same(tile.disabled, true, `${tile.id} waits for the bowler`);
    const order = state.orders?.away ?? [];
    const eligible = new Set(eligibleBowlers(order, fine, quota, T20.ballsPerOver));
    const ineligible = order.filter((id) => !eligible.has(id)).sort();
    same(ineligible, ["A-11", "A-9"], "the engine rules out the last over's bowler and the one at quota");
    const blocked = bowlerBlocked(t, state, people, T20);
    same(Object.keys(blocked).sort(), ineligible, "the picker greys exactly those");
    same(blocked["A-9"], "pad.cricket.context.bowler.blocked.prevOver.short", "A-9 bowled the last over");
    same(blocked[OPENING_BOWLER], "pad.cricket.context.bowler.blocked.quota.short", "the opening bowler is at quota");
    // Picking an eligible bowler opens the tiles, and the ball folds.
    const picked = withPicks(view, { bowler: "A-10" });
    const dot = tilePayload(ballTiles(picked).find((tile) => tile.id === "run0"));
    same(openInnings(foldEmitted(T20, oversBy(T20, overs), { type: "cricket.ball", payload: dot })).fine.currentBowler, "A-10", "the picked bowler opens the over");
  });

  it("a hundred over ends at five balls", () => {
    expect(HUNDRED.ballsPerOver, "premise: the hundred's over is five balls").toBe(5);
    const four = viewOf(HUNDRED, oversBy(HUNDRED, [], 4));
    same(resolvePeople(four.state as CricketState, {}, HUNDRED).bowler, OPENING_BOWLER, "after 4 balls the over's bowler bowls on");
    for (const tile of ballTiles(four)) same(tile.disabled, undefined, `after 4: ${tile.id} is open`);
    const fiveSpecs = oversBy(HUNDRED, [OPENING_BOWLER]);
    const five = viewOf(HUNDRED, fiveSpecs);
    same(resolvePeople(five.state as CricketState, {}, HUNDRED).bowler, "", "after 5 balls the next bowler is asked");
    const blockedTiles = ballTiles(five);
    expect(blockedTiles.length).toBeGreaterThan(0);
    for (const tile of blockedTiles) same(tile.disabled, true, `after 5: ${tile.id} waits for the bowler`);
    same(slot(five, "bowler")?.message, 'pad.cricket.context.bowler.unpicked {"over":2}', "over 2 waits for its bowler");
    const dot = tilePayload(ballTiles(withPicks(five, { bowler: "A-10" })).find((tile) => tile.id === "run0"));
    same([dot.over, dot.ballInOver, dot.bowler], [1, 1, "A-10"], "the sixth ball opens over 2");
    same(openInnings(foldEmitted(HUNDRED, fiveSpecs, { type: "cricket.ball", payload: dot })).legalBalls, 6, "and folds");
  });

  it("mid-over the fold's bowler wins over a stale pending pick", () => {
    const overEnd = oversBy(T20, [OPENING_BOWLER]);
    // Take back the over's last ball: `makeEnvelope` ids are e-<index>, and the sixth ball is index 6.
    const specs: CricketEventSpec[] = [...overEnd, ["core.void", {}, `e-${overEnd.length - 1}`]];
    const view = withPicks(viewOf(T20, specs), { bowler: "A-9" });
    const fine = openInnings(view.state as CricketState).fine;
    expect([openInnings(view.state as CricketState).legalBalls, fine.currentBowler], "premise: the over is open again").toEqual([5, OPENING_BOWLER]);
    same(resolvePeople(view.state as CricketState, view.contextOverrides, T20).bowler, OPENING_BOWLER, "the fold's bowler, not the pick");
    const dot = tilePayload(ballTiles(view).find((tile) => tile.id === "run0"));
    same(dot.bowler, OPENING_BOWLER, "the next ball names the over's bowler");
    same(openInnings(foldEmitted(T20, specs, { type: "cricket.ball", payload: dot })).legalBalls, 6, "and the fold takes it");
  });

  it("a fresh super-over innings asks for both batters and the bowler; a single vacant end after a wicket still defaults to the one eligible batter", () => {
    const cfg = tiedWithSuperOver();
    const side = (striker: string, nonStriker: string, bowler: string): CricketEventSpec[] =>
      [1, 2, 3, 4, 5, 6].map((n) => ["cricket.ball", { over: 0, ballInOver: n, striker, nonStriker, bowler, runs: { bat: 0 } }]);
    const main: CricketEventSpec[] = [["core.start"], ...side("H-1", "H-2", "A-11"), ...side("A-1", "A-2", "H-11")];
    const fresh = viewOf(cfg, main);
    expect((fresh.state as CricketState).phase, "premise: a super over").toBe("super_over");
    const people = resolvePeople(fresh.state as CricketState, {}, cfg);
    same([people.striker, people.nonStriker, people.bowler], ["", "", ""], "a fresh super-over innings asks for all three");
    for (const tile of ballTiles(fresh)) same(tile.disabled, true, `super over: ${tile.id} waits for the picks`);
    same(slot(fresh, "striker")?.message, "pad.cricket.context.openers.unpicked", "the strip asks for both batters");
    // One end picked is not both: the other end is still asked, never drawn from the order.
    same(resolvePeople(fresh.state as CricketState, { striker: `${people.battingSide === "home" ? "H" : "A"}-1` }, cfg).nonStriker, "", "the other end stays unpicked");

    const bat = people.battingSide === "home" ? "H" : "A";
    const bowl = people.battingSide === "home" ? "A" : "H";
    const wicket: CricketEventSpec = [
      "cricket.superover.ball",
      { over: 0, ballInOver: 1, striker: `${bat}-1`, nonStriker: `${bat}-2`, bowler: `${bowl}-11`, runs: { bat: 0 }, wicket: { kind: "bowled", out: `${bat}-1`, bowlerCredited: true } },
    ];
    const afterWicket = viewOf(cfg, [...main, wicket]);
    const state = afterWicket.state as CricketState;
    const fine = state.superOver?.innings.at(-1)?.fine;
    if (fine == null) throw new Error("premise: a ball-by-ball super-over innings is open");
    expect([fine.striker, fine.nonStriker], "premise: the fold left the striker's end vacant").toEqual([null, `${bat}-2`]);
    const order = state.orders?.[people.battingSide] ?? [];
    const eligible = soEligibleBatters(order, fine.dismissed, state.superOver?.dismissed?.[people.battingSide] ?? [], [`${bat}-2`]);
    expect(eligible.length, "premise: someone may walk in").toBeGreaterThan(0);
    const resolved = resolvePeople(state, {}, cfg);
    same([resolved.striker, resolved.nonStriker, resolved.bowler], [eligible[0], `${bat}-2`, `${bowl}-11`], "the vacant end defaults to the first eligible batter");
    const dot = tilePayload(ballTiles(afterWicket).find((tile) => tile.id === "run0"));
    expect(() => foldEmitted(cfg, [...main, wicket], { type: "cricket.superover.ball", payload: dot }), "the replacement's ball folds").not.toThrow();
  });
});

/** MCC Law 19.7: a boundary scores 4 or 6. A rulebook anchor, so the engine's `boundaryValues` drifting goes red here. */
const LAWS_BOUNDARIES = [4, 6];

describe("S2-4 T4: extras open sheets, with no timer", () => {
  const view = () => pickedOf(T20, START);
  /** The runs answers; the wide's and no-ball's "+ Out" is Task 6's, below. */
  const answers = (sheet: string) => choiceIds(buildSheets(view(), t)[sheet]!, "runs").filter((id) => id !== "out");

  it("a wide asks the runs run, 0-4, and the innings takes wideDefaultRuns + n", () => {
    const options = answers("wide");
    same(options, ["0", "1", "2", "3", "4"], "the wide's runs-run options");
    let folded = 0;
    for (const option of options) {
      const n = Number(option);
      const event = extraAnswer(view(), "wide", option);
      const innings = openInnings(foldEmitted(T20, START, event));
      same([innings.runs, innings.legalBalls], [cricketPadRules.wideDefaultRuns + n, 0], `a wide and ${n} run`);
      folded++;
    }
    expect(folded).toBe(5);
  });

  it("a no-ball asks runs off the bat or runs run; both fold and a free hit follows", () => {
    const options = answers("noball");
    same(options, ["bat:0", "bat:1", "bat:2", "bat:3", "bat:4", "bat:6", "ran:1", "ran:2", "ran:3", "ran:4"], "the no-ball's options");
    let folded = 0;
    const boundaries: number[] = [];
    for (const option of options) {
      const [how, n] = [option.split(":")[0], Number(option.split(":")[1])];
      const event = extraAnswer(view(), "noball", option);
      const payload = event.payload as { runs: { bat: number; extras: { kind: string; runs: number } }; boundary?: number };
      same(payload.runs, how === "bat"
        ? { bat: n, extras: { kind: "noball", runs: cricketPadRules.noBallDefaultRuns } }
        : { bat: 0, extras: { kind: "noball", runs: cricketPadRules.noBallDefaultRuns + n } }, `no-ball ${option}: runs`);
      if (payload.boundary !== undefined) boundaries.push(payload.boundary);
      const innings = openInnings(foldEmitted(T20, START, event));
      same([innings.runs, innings.legalBalls, innings.fine.freeHitPending], [cricketPadRules.noBallDefaultRuns + n, 0, true], `no-ball ${option}: folded, free hit next`);
      folded++;
    }
    expect(folded).toBe(10);
    same(boundaries, LAWS_BOUNDARIES, "a boundary only on 4 and 6 off the bat (W7)");
  });

  it("a bye and a leg-bye ask 1-4 into the extra's runs", () => {
    let folded = 0;
    for (const kind of ["bye", "legbye"]) {
      const options = answers(kind);
      same(options, ["1", "2", "3", "4"], `${kind}: options`);
      for (const option of options) {
        const n = Number(option);
        const event = extraAnswer(view(), kind, option);
        same((event.payload as { runs: unknown }).runs, { bat: 0, extras: { kind, runs: n } }, `${kind} ${n}: runs`);
        const innings = openInnings(foldEmitted(T20, START, event));
        same([innings.runs, innings.legalBalls], [n, 1], `${kind} ${n}: folded, a legal ball`);
        folded++;
      }
    }
    expect(folded).toBe(8);
  });

  it("no cricket ball soft-commits", () => {
    const v = view();
    const payloads: { type: string; payload: Record<string, unknown>; what: string }[] = [];
    const sheets = buildSheets(v, t);
    for (const tile of buildTiles(v, t)) {
      const action = tile.action;
      if (action === undefined || tile.disabled === true) continue;
      if ("event" in action) payloads.push({ ...action.event, payload: action.event.payload as Record<string, unknown>, what: tile.id });
      else if ("sheet" in action && EXTRA_SHEETS.includes(action.sheet)) {
        for (const option of choiceIds(sheets[action.sheet]!, "runs")) {
          const event = extraAnswer(v, action.sheet, option);
          payloads.push({ type: event.type, payload: event.payload as Record<string, unknown>, what: `${action.sheet} ${option}` });
        }
      }
    }
    for (const kind of cricketPadRules.wicketKinds) {
      const { event } = walk(sheets.wicket, (step) => {
        if (step.id === "kind") return kind;
        if (step.kind === "choice") return step.options[0]!.id;
        if (step.kind === "person") return step.candidates?.[0] ?? FIELDER;
        throw new Error(`${kind}: unexpected step "${step.id}"`);
      });
      payloads.push({ type: event.type, payload: event.payload as Record<string, unknown>, what: `wicket ${kind}` });
    }
    for (const { type, payload, what } of payloads) same(softCommitPlan(buildDock(type, t, payload), payload), "send", `${what} is sent at once`);
    console.info(`[pad-rules-cricket] cricket payloads checked for no hold: ${payloads.length}`);
    expect(payloads.length).toBeGreaterThanOrEqual(25);
  });
});

describe("S2-4 review I2: while a sheet is open, a tap on a run or extra tile records nothing (controller ruling)", () => {
  /** Taps every tile through the real TileGrid and Tile: each rendered Tile is called and its button's onClick fired, as
   *  a scorer's tap does (the harness has no DOM, and Tile's own early return is what a direct call meets). Returns what
   *  the grid reported: events sent and sheets opened, by tile id. */
  function tapAll(view: PadHostView) {
    const recorded: string[] = [];
    const opened: string[] = [];
    const island = renderIsland(TileGrid as never, {
      tiles: buildTiles(view, t),
      phase: "live",
      t,
      onAction: (_action: unknown, tile: TileSpec) => recorded.push(tile.id),
      onOpenSheet: (sheet: string) => opened.push(sheet),
    } as never);
    let tapped = 0;
    for (const el of island.tree()) {
      const tile = (el.props as { tile?: TileSpec }).tile;
      if (tile === undefined || !BALL_TILE.test(tile.id)) continue;
      const button = (el.type as (props: unknown) => { props: { onClick: () => void; disabled: boolean } })(el.props);
      button.props.onClick();
      tapped++;
    }
    return { recorded, opened, tapped };
  }
  /** The tiles that record a ball or open a ball's sheet: the runs, the wide, the extras and the wicket. */
  const BALL_TILE = /^(run\d|wide|extra-|wicket$)/;

  it("with a sheet open, a tap on a run tile records nothing; with none open the same taps do (anti-vacuity)", () => {
    const view = pickedOf(T20, START);
    const shut = tapAll(view);
    expect(shut.tapped, "premise: the runs, wide, four extras and wicket were tapped").toBeGreaterThanOrEqual(12);
    same(shut.recorded.includes("run1"), true, "no sheet open: run 1 records its ball");
    same(shut.opened.includes("wide"), true, "no sheet open: Wide opens its sheet");

    const open = tapAll({ ...view, sheetOpen: true });
    same(open.tapped, shut.tapped, "the same tiles are on screen with a sheet open");
    same(open.recorded, [], "a sheet open: no tap records a ball");
    same(open.opened, [], "a sheet open: no tap opens a second sheet");
  });
});

describe("S2-4 T6: + Out off a wide or a no-ball offers only the engine's kinds", () => {
  /** Walks an extras sheet's "+ Out" with `kind`: the striker is the batter out where the mode lets either be, the
   *  fielder is FIELDER, the keeper and the next batter the first offered, and the runs completed `completed`. */
  const outWalker = (kind: string, completed = "0") => (step: GuidedSheetStep): string => {
    if (step.id === "runs") return "out";
    if (step.id === "kind") return kind;
    if (step.id === "out") return STRIKER;
    if (step.id === "fielder" || step.id === "fielderOptional") return FIELDER;
    if (step.id === "completed") return completed;
    return firstCandidate(step);
  };
  const DEFAULT_RUNS = { wide: cricketPadRules.wideDefaultRuns, noball: cricketPadRules.noBallDefaultRuns } as const;

  it.each([
    ["CK-WD-1", "wide", cricketPadRules.wideDismissalKinds],
    ["CK-NB-1", "noball", cricketPadRules.noBallDismissalKinds],
  ] as const)("%s on the web: Out off a %s offers exactly the engine's set, and each folds", (_id, sheet, engineSet) => {
    const spec = buildSheets(pickedOf(T20, START), t)[sheet]!;
    same(choiceIds(spec, "runs").includes("out"), true, `${sheet}: the sheet offers + Out`);
    const offered = choiceIds(spec, "kind");
    same([...offered].sort(), [...engineSet].sort(), `${sheet}: the kinds offered are the engine's`);
    same(offered, cricketPadRules.wicketKinds.filter((k) => offered.includes(k)), `${sheet}: in the engine's order`);
    let folded = 0;
    for (const kind of offered) {
      const { event } = walk(spec, outWalker(kind));
      const payload = event.payload as { runs: unknown; wicket: { kind: string; out: string } };
      same(payload.runs, { bat: 0, extras: { kind: sheet, runs: DEFAULT_RUNS[sheet] } }, `${sheet} ${kind}: the extra's own run`);
      const innings = openInnings(foldEmitted(T20, START, event));
      same(innings.fine.dismissed, [STRIKER], `${sheet} ${kind}: the fold dismissed the batter`);
      same(innings.legalBalls, 0, `${sheet} ${kind}: not a legal ball`);
      folded++;
    }
    expect(folded).toBe(engineSet.length);
  });

  it("with a free hit pending, Out off a wide or a no-ball narrows further to the free-hit set", () => {
    let checked = 0;
    for (const sheet of ["wide", "noball"] as const) {
      const set = sheet === "wide" ? cricketPadRules.wideDismissalKinds : cricketPadRules.noBallDismissalKinds;
      const offered = choiceIds(buildSheets(viewOf(T20, FREE_HIT_PENDING), t)[sheet]!, "kind");
      same([...offered].sort(), set.filter((k) => cricketPadRules.freeHitDismissalKinds.includes(k)).sort(), `${sheet} on a free hit`);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a run out off a wide or a no-ball puts the runs completed into that extra's runs", () => {
    let folded = 0;
    for (const sheet of ["wide", "noball"] as const) {
      const { event } = walk(buildSheets(pickedOf(T20, START), t)[sheet]!, outWalker("runout", "2"));
      const runs = (event.payload as { runs: unknown }).runs;
      same(runs, { bat: 0, extras: { kind: sheet, runs: DEFAULT_RUNS[sheet] + 2 } }, `${sheet}: runs completed in the extra`);
      const innings = openInnings(foldEmitted(T20, START, event));
      same(innings.runs, DEFAULT_RUNS[sheet] + 2, `${sheet}: the fold's runs`);
      same(innings.fine.dismissed, [STRIKER], `${sheet}: run out`);
      folded++;
    }
    expect(folded).toBe(2);
  });

  it("a stumping off a wide on the last legal ball still asks who walks in (Review Focus 2)", () => {
    const SIX = tiedWithSuperOver();
    const fiveBalls: CricketEventSpec[] = [...START, ...[1, 2, 3, 4, 5].map((n) => ball(0, n))];
    const { asked, event } = walk(buildSheets(viewOf(SIX, fiveBalls), t).wide, outWalker("stumped"));
    same(asked.includes("incoming"), true, "a wide is not the last legal ball: the innings goes on");
    const innings = openInnings(foldEmitted(SIX, fiveBalls, event));
    same([innings.closed, innings.legalBalls, innings.wickets], [false, 5, 1], "the fold: still open, five legal balls, one down");
  });

  it("the bye and leg-bye sheets have no + Out (owner 2026-11-07)", () => {
    const sheets = buildSheets(pickedOf(T20, START), t);
    same(choiceIds(sheets.bye!, "runs").includes("out"), false, "bye");
    same(choiceIds(sheets.legbye!, "runs").includes("out"), false, "leg bye");
    same(sheets.bye!.steps.length + sheets.legbye!.steps.length, 2, "one step each");
  });
});

describe("the drift guard compared something", () => {
  it("made at least the plan's 16 comparisons", () => {
    console.info(`[pad-rules-cricket] facts compared: ${compared}`);
    expect(compared).toBeGreaterThanOrEqual(16);
  });
});
