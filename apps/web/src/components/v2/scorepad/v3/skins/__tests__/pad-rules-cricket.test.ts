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
import { foldMatch, initSquads, type EventEnvelope } from "@seazn/engine/core";
import { cricketPadRules } from "@seazn/engine/pad";
import { cricket, eligibleBowlers, soEligibleBatters, type CricketCfg, type CricketState } from "@seazn/engine/sports/cricket";
import { ballSeq, cricketEnvelopes, cricketLineups, tiedWithSuperOver, type CricketEventSpec } from "../../__tests__/_cricket-fold";
import uiEn from "@/dictionaries/en/ui.json";
import { GuidedSheet, answerStep, currentStep, initialSheetState } from "../../guided-sheet";
import { dedicatedEventTypes, moreActions, softCommitPlan } from "../../pad-host";
import type { GuidedSheetSpec, GuidedSheetStep, PadHostView, TileSpec } from "../../types";
import { bowlerBlocked, bowlerBlockReason, buildContext, buildDock, buildScorebug, buildSheets, buildTiles, refusedEventTypes, resolvePeople, type TFn } from "../cricket";

const t: TFn = (key) => key;
const T20 = cricket.configSchema.parse(cricket.variants.t20);
const HUNDRED = cricket.configSchema.parse(cricket.variants.hundred);
const STRIKER = "H-1";
const NON_STRIKER = "H-2";
const OPENING_BOWLER = "A-11";
const FIELDER = "A-7";

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
/** The payload one answer of an extras sheet records. */
const extraAnswer = (view: PadHostView, sheet: string, answer: string) => walk(buildSheets(view, t)[sheet]!, () => answer).event;

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
          if (step.kind === "person" && step.candidates?.[0] !== undefined) return step.candidates[0];
          throw new Error(`${kind}: unexpected step "${step.id}"`);
        });
        if (fielderAnswer === FIELDER) asked.set(kind, steps);
        const variable = cricketPadRules.variableOutKinds.includes(kind);
        const credited = cricketPadRules.fielderCreditedKinds.includes(kind);
        same(steps.includes("out"), variable, `${kind}: who's out asked`);
        same(steps.includes("fielder") || steps.includes("fielderOptional"), credited, `${kind}: fielder asked`);
        const wicket = (event.payload as { wicket: { out: string; fielder?: string; bowlerCredited: boolean } }).wicket;
        same(wicket.out, variable ? NON_STRIKER : STRIKER, `${kind}: out`);
        same(wicket.bowlerCredited, cricketPadRules.bowlerCreditedKinds.includes(kind), `${kind}: bowlerCredited`);
        // The seam's consumer: the engine takes the sheet's own payload on the write path, and credits the fielder it named.
        const innings = openInnings(foldEmitted(T20, START, event));
        same(innings.fine.dismissed, [wicket.out], `${kind}: the fold dismissed the batter the sheet named`);
        same(innings.fine.fielding?.[FIELDER] !== undefined, credited && fielderAnswer === FIELDER, `${kind}: the fold credited the fielder`);
        if (fielderAnswer === "") {
          same(wicket.fielder, undefined, `${kind}: a declined fielder is not written`);
          declined++;
        }
      }
    }
    // Ruling 242, pinned by name: obstructing asks who is out, then a fielder the scorer may decline; retired asks who is out.
    same(asked.get(OBSTRUCTED), ["kind", "out", "fielderOptional", "incoming"], "obstructed's steps");
    same(asked.get("retired"), ["kind", "out", "incoming"], "retired's steps");
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
        // S2-4 Task 4: every runs answer of an extras sheet folds in a super over.
        for (const option of choiceIds(sheets[action.sheet]!, "runs")) {
          const { event } = walk(sheets[action.sheet]!, () => option);
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
  const answers = (sheet: string) => choiceIds(buildSheets(view(), t)[sheet]!, "runs");

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

describe("the drift guard compared something", () => {
  it("made at least the plan's 16 comparisons", () => {
    console.info(`[pad-rules-cricket] facts compared: ${compared}`);
    expect(compared).toBeGreaterThanOrEqual(16);
  });
});
