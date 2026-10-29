// The W2e deciding-path scenarios (Tasks 19–23; spec §10, D16): LIFECYCLE's loop on a bracket whose every match is
// FORCED down one sport-rule deciding path, so a run that turns green cannot have got there by the policy's rotation.
// OPT-IN: planned only by `--set w1-driving --scenario <key>` (w1-driving-set.ts), never by a committed plan.
//
//   W2E_ET  every match level at full time and won in extra time (G1, football)
//   W2E_SO  every match level through regulation (and extra time, where the stage plays it) and won on the shoot-out,
//           every kick in the order the engine names (G2, football)
//
// The sport's own rule decides every match, so no organiser settle or tie-break is owed (life-bracket-decider-
// exercised is left out, as W2a's BRACKET_EXTRA_BOARD leaves it). The shared bracket assertions apply, and the
// scenario's own check holds each match to its path on the PRODUCT's outcome, read by the sport generator's
// `pathWitness` — the engine's own `decidedInFor` for football — never on the stream the harness posted alone.
import type { MatchOutcome, StageKind } from "@seazn/engine/core";
import { fieldSizeFor } from "../field-size.ts";
import { foldStream } from "../fold.ts";
import type { ObservedRun } from "../observed.ts";
import type { BracketDrive } from "../reference-bracket.ts";
import type { CheckResult } from "../results.ts";
import { sportModule } from "../sport-cfg.ts";
import { STREAM_GENERATORS, matchesRequest } from "../streams/index.ts";
import { idOf, outcomeLabel, type RequestedOutcome } from "../streams/types.ts";
import { bracketRootRows } from "../w2a-cells.ts";
import { w2eApplies, w2ePathUnder } from "../w2e-cells.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, publicStandingsMatch, referenceBracketFinish, resultsAsPosted, stageCompleted, type Item } from "./assertions.ts";
import { Recorder, caseStageCfg, playDivision, setUpDivision, snapshot, type BracketPick } from "./common.ts";
import { W2E_SCENARIO_KEYS, W2E_SCENARIO_PATHS, type Scenario, type W2eScenarioKey } from "./types.ts";

export { W2E_SCENARIO_PATHS };

/** The keys a truth run reports as new scenarios. */
export const W2E_SCENARIOS: readonly string[] = W2E_SCENARIO_KEYS;

/** A W2e scenario planned on a cell it is not for: a table row (no bracket to force), or a sport whose generator
 *  builds none of the key's paths under the bracket presets. The planner never does this (w2e-cells.ts); a caller
 *  that does gets this, by name, before any driver call. */
export class W2eMisplanned extends Error {
  constructor(key: string, row: string, sport: string, why: string) {
    super(`scenario: ${key} was planned on ${row}|${sport} — ${why}`);
    this.name = "W2eMisplanned";
  }
}

/** Every bracket match won by the higher seed, down the first of the key's paths the stage's cfg builds. A stage
 *  whose cfg builds none is a misplanned case, refused by name rather than played as a plain win. */
function pathPick(key: W2eScenarioKey, row: string, sport: string): BracketPick {
  return (f, _n, higher, cfg) => {
    const path = w2ePathUnder(key, sport, cfg);
    if (path === null) throw new W2eMisplanned(key, row, sport, `fixture ${f.id}'s stage cfg builds none of ${W2E_SCENARIO_PATHS[key].join(", ")}`);
    return { kind: "win", winner: higher, path };
  };
}

/** The scenario's own check: one item per bracket match. A match passes when the harness ASKED a win down one of the
 *  key's paths, the product decided it for the side asked, the stream the harness posted folds (strictly) to that
 *  request, and the sport's own witness reads the PRODUCT's outcome as decided down that path. `cfgOf` is the cfg the
 *  drive's stage folds under. An empty run fails (R25). */
export function everyMatchTookTheDecidingPath(rec: Recorder, key: W2eScenarioKey, cfgOf: (d: BracketDrive) => unknown): CheckResult {
  const paths: readonly string[] = W2E_SCENARIO_PATHS[key];
  const items: Item[] = rec.bracketDrives.map((d): Item => {
    const a: RequestedOutcome = d.asked;
    const product = d.outcome;
    const productNote = `product ${d.status ?? "(no status)"} ${product?.kind ?? "(no outcome)"}${product !== null && "method" in product && product.method !== undefined ? ` ${product.method}` : ""}`;
    const note = (why: string) => `${d.fixtureId}: asked ${outcomeLabel(a)}, ${productNote} — ${why}`;
    if (a.kind !== "win" || a.path === undefined || !paths.includes(a.path)) return { ok: false, note: note(`not a win down ${paths.join(" / ")}`) };
    const path = a.path;
    const req = { sportKey: d.sport, cfg: cfgOf(d), stageKind: d.stageKind as StageKind, home: d.home, away: d.away, outcome: a };
    const winner = idOf(req, a.winner);
    if (d.status !== "decided" || product?.kind !== "win" || product.winner !== winner) return { ok: false, note: note(`the product did not decide it for ${winner}`) };
    const stream = rec.streams.get(d.fixtureId);
    if (stream === undefined || stream.length === 0) return { ok: false, note: note("no stream was recorded for it") };
    const local = foldStream(sportModule(d.sport), req.cfg, d.home, d.away, stream);
    if (matchesRequest(req, local.outcome, local.state) !== "match") return { ok: false, note: note(`the stream posted folds to ${JSON.stringify(local.outcome)}, not a win down '${path}'`) };
    const gen = STREAM_GENERATORS[d.sport];
    if (gen?.pathWitness === undefined) return { ok: false, note: note("the sport's generator witnesses no deciding path") };
    const loser = winner === d.home ? d.away : d.home;
    const shown: MatchOutcome = product.method === undefined ? { kind: "win", winner, loser } : { kind: "win", winner, loser, method: product.method };
    return { ok: gen.pathWitness(path, { outcome: shown, state: local.state, cfg: req.cfg }), note: note(`the product's outcome is not decided down '${path}'`) };
  });
  return assertion("w2e-every-match-took-the-path", items);
}

function scenario(key: W2eScenarioKey): Scenario {
  return {
    key,
    entrantCount: 8,
    canaryCheck: null,
    async run(ctx) {
      const { row, sport } = ctx.spec;
      if (!(bracketRootRows() as readonly string[]).includes(row)) throw new W2eMisplanned(key, row, sport, `the row's root stage is not a bracket kind, so no match plays a decider (only ${bracketRootRows().join(", ")})`);
      if (!w2eApplies(key, sport)) throw new W2eMisplanned(key, row, sport, `this sport's generator builds no such path (${W2E_SCENARIO_PATHS[key].join(", ")}) under the bracket presets (w2e-cells.ts)`);
      const rec = new Recorder();
      const setup = await setUpDivision(ctx, rec, fieldSizeFor(row, key, ctx.spec.template));
      const plays = await playDivision(ctx, rec, setup, { bracketPick: pathPick(key, row, sport) });
      const observed: ObservedRun = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
      const pub = await ctx.driver.publicStandings({ orgSlug: ctx.orgSlug, competitionSlug: setup.competition.slug, divisionSlug: setup.division.slug });
      return {
        observed,
        events: rec.events,
        notes: rec.notes,
        assertions: [
          builtAsPosted(setup.built, observed),
          foldParity(rec),
          resultsAsPosted(rec, observed),
          publicStandingsMatch(observed, pub),
          referenceBracketFinish(rec, observed),
          stageCompleted(observed),
          loopBounded(rec, observed),
          advanceSeededAsDeclared(plays, observed, rec.withdrawn),
          lineupsPut(rec, setup),
          everyMatchTookTheDecidingPath(rec, key, (d) => caseStageCfg(ctx, d.stageKind as StageKind)),
        ],
      };
    },
  };
}

export const w2eScenarios: Readonly<Record<W2eScenarioKey, Scenario>> = Object.freeze({
  W2E_ET: scenario("W2E_ET"),
  W2E_SO: scenario("W2E_SO"),
});
