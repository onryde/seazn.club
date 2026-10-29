// W2e Tasks 19–24 (A3; spec §10, D9; INV §5 G1–G8, G12): generator breadth, one stream per task, each sweep titled with
// its G-id. Every stream is folded STRICTLY through the real module (lib/fold.ts, strictFromSeq 1). What decided it is
// read from the engine's own declarations — the module's decider rule keys (`deciderKeysFor`) and `reachableDecidedIn`,
// `decidedInFor` over its win-method table, the shoot-out order the module binds (`footballNextKicker`) — never from the
// generators. Every sweep counts what it checked, per sport and per variant, and zero is a failure (TEST-STRATEGY
// anti-vacuity). `ALL_OUTCOMES` stays frozen: the new shapes run here, in their own sweeps (spec §10).
import { decidedInFor } from "@seazn/engine/competition";
import { EngineError, FORFEIT_REASONS, StageKind, sanctionEndingIssues, scorerMayForfeit } from "@seazn/engine/core";
import { BO1_MATCH_TIEBREAK, checkFixtureOverride, deciderKeysFor, stageKeysFor, writeConfigIssues } from "@seazn/engine/sport";
import { CricketBall, CricketCfg, dlsTarget, soBattingSideAt, type CricketState } from "@seazn/engine/sports/cricket";
import { football, footballNextKicker, type ShootoutKick } from "@seazn/engine/sports/football";
import { describe, expect, it, vi } from "vitest";
import { mergeRulesOverride } from "../../../apps/web/src/server/engine-db/fixture-cfg.ts";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { foldStream } from "../lib/fold.ts";
import { resolveSchemaCfg, resolveSportCfg, sportModule, stageCfg, variantKeys } from "../lib/sport-cfg.ts";
import { STREAM_GENERATORS, generateStream, matchesRequest, partialPlay } from "../lib/streams/index.ts";
import { endingReasonOf, sanctionDeclOf, sanctionEndWitness, sanctionToken, type SanctionAsk, type SanctionFold } from "../lib/streams/sanction.ts";
import { levelKindOf } from "../lib/reference-bracket.ts";
import { SO_PAIRS, superOverStream, type SuperOverPair } from "../lib/streams/cricket.ts";
import { KNOWN_UNSUPPORTED } from "../lib/streams/known-unsupported.ts";
import { setbasedGenerator } from "../lib/streams/setbased.ts";
import { tennisGenerator } from "../lib/streams/tennis.ts";
import {
  ALL_OUTCOMES, DECIDING_PATHS, GeneratorUnsupported, OutcomeUnreachable, PROBE_LINEUPS, START, canon, evidenceState, localEvidence, outcomeLabel, productEvidence,
  type DecidingPath, type PathFold, type ProductFold, type RequestedOutcome, type Side, type StreamEvent, type StreamLineups, type StreamRequest,
} from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { capBinds, decidingSetReachable, foldSet, majority, setSportsOf, type SetCfg, type SetFoldState } from "./set-oracles.ts";
import { engineRefuses, foldTennis, tbIsClosestFinish, tennisSetsWonBy, withLastTb, type TennisCfg, type TennisFoldState } from "./tennis-oracles.ts";

// The product's own override merge lives in a `server-only` file that reaches its siblings by the app's `@/` alias, neither of
// which the matrix's vitest (no config of its own) resolves: both are stubbed to the REAL thing, so `mergeRulesOverride` below
// is the product's function, not a copy (Task 20 M1).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stage-decider-off", async () => await import("../../../apps/web/src/lib/stage-decider-off.ts"));
// A synthetic sport key whose module declares one level twice (below, G12 M-2): every real key passes through to the real registry.
const TWICE_DECLARED = "twice-declared-sanction";
vi.mock("../lib/sport-cfg.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/sport-cfg.ts")>();
  const twice = { ...real.sportModule("badminton"), sanctionEnding: { eventType: "badminton.sanction", endLevels: ["black"], promptLevels: ["black"] } };
  return { ...real, sportModule: (key: string) => (key === "twice-declared-sanction" ? twice : real.sportModule(key)) };
});

const SIDES: readonly Side[] = ["home", "away"];
const ID: Readonly<Record<Side, string>> = { home: "H", away: "A" };
const req = (sportKey: string, cfg: unknown, stageKind: StageKind, outcome: RequestedOutcome): StreamRequest =>
  ({ sportKey, cfg, stageKind, home: ID.home, away: ID.away, outcome });

describe("W2e request vocabulary (Task 19: the interface Tasks 20–24 build on)", () => {
  it("empty case first: ALL_OUTCOMES is W2b's seven, frozen, and names no deciding path and no sanction ending", () => {
    expect(ALL_OUTCOMES.map(outcomeLabel)).toEqual(["win-home", "win-away", "draw", "forfeit-away-walkover", "forfeit-home-retired", "abandon", "tie"]);
    expect(Object.isFrozen(ALL_OUTCOMES)).toBe(true);
    expect(ALL_OUTCOMES.filter((o) => o.kind === "sanctionEnd" || (o.kind === "win" && o.path !== undefined))).toEqual([]);
    expect(KNOWN_UNSUPPORTED).toEqual([]);
  });

  it("labels: a path win is win-<side>-<path>, a sanction ending sanction-<by>-<level>; every one distinct, none colliding with an older label", () => {
    // The closed list, from the plan's interface (Tasks 19–24 table), frozen.
    expect([...DECIDING_PATHS]).toEqual(["extraTime", "shootout", "overtime", "gws", "superOver", "dls", "decidingSet", "cap", "tiebreakSet", "shortSetTb"]);
    expect(Object.isFrozen(DECIDING_PATHS)).toBe(true);
    const fresh: RequestedOutcome[] = [];
    for (const winner of SIDES) for (const path of DECIDING_PATHS) {
      const o: RequestedOutcome = { kind: "win", winner, path };
      expect(outcomeLabel(o)).toBe(`win-${winner}-${path}`);
      fresh.push(o);
    }
    for (const by of SIDES) for (const level of ["black", "default", "expulsion"]) {
      const o: RequestedOutcome = { kind: "sanctionEnd", by, level };
      expect(outcomeLabel(o)).toBe(`sanction-${by}-${level}`);
      fresh.push(o);
    }
    // A win that names no path is W1's label, byte for byte (committed case ids).
    expect(outcomeLabel({ kind: "win", winner: "home" })).toBe("win-home");
    const labels = [...ALL_OUTCOMES, ...fresh].map(outcomeLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(fresh.length).toBe(2 * DECIDING_PATHS.length + 2 * 3);
  });

  it("a path request to a sport whose generator builds no path is refused by name (GeneratorUnsupported), never built as a plain win — over the registry, counted", () => {
    let refused = 0;
    let witnessed = 0;
    for (const sportKey of SPORT_KEYS) {
      const gen = STREAM_GENERATORS[sportKey]!;
      const variant = offlineBuilderDefault(sportKey);
      const cfg = stageCfg(sportKey, resolveSportCfg(sportKey, variant), "knockout", variant);
      if (gen.pathWitness !== undefined) { witnessed++; continue; }
      for (const path of DECIDING_PATHS) {
        const ask = () => generateStream(req(sportKey, cfg, "knockout", { kind: "win", winner: "home", path }));
        expect(ask, `${sportKey} ${path}`).toThrow(GeneratorUnsupported);
        expect(ask, `${sportKey} ${path}`).toThrow(/builds no deciding path/);
        refused++;
      }
    }
    console.info(`w2e: ${witnessed} sport(s) witness a deciding path; ${refused} path request(s) refused by name on the rest`);
    expect(STREAM_GENERATORS.football!.pathWitness, "Task 19: football builds its paths").toBeDefined();
    expect(witnessed).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("canon is the ONE canonical form the witnesses and the cells compare with (Task 23 M4): key order is immaterial at every depth, undefined members are dropped, arrays keep their order, and different values differ", () => {
    expect(canon({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canon({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(canon({ a: 1, b: undefined })).toBe(canon({ a: 1 }));
    expect(canon([1, 2])).not.toBe(canon([2, 1]));
    expect(canon({ a: null })).not.toBe(canon({}));
    expect(canon({ a: 1 })).not.toBe(canon({ a: "1" }));
    expect(canon(undefined)).toBe("null");
    expect(canon("x")).toBe('"x"');
    expect(canon({})).toBe("{}");
    // The real shapes it compares: a cfg parsed from a preset and one parsed from overrides.
    expect(canon(resolveSportCfg("tennis", "tour"))).toBe(canon(JSON.parse(JSON.stringify(resolveSportCfg("tennis", "tour")))));
  });

  it("a path is witnessed on the fold's STATE as well as its outcome: matchesRequest refuses a path request handed no state, by name", () => {
    const cfg = stageCfg("football", resolveSportCfg("football", "11-a-side"), "knockout", "11-a-side");
    const r = req("football", cfg, "knockout", { kind: "win", winner: "home", path: "shootout" });
    const folded = foldStream(football, cfg, ID.home, ID.away, generateStream(r));
    expect(matchesRequest(r, folded.outcome, folded.state)).toBe("match");
    expect(() => matchesRequest(r, folded.outcome)).toThrow(/path 'shootout' is witnessed on the folded state/);
    // A request that names no path is matched on the outcome alone, as before W2e.
    expect(matchesRequest(req("football", cfg, "knockout", { kind: "win", winner: "home" }), folded.outcome)).toBe("match");
  });

  it("FoldEvidence names its source (Task 22 M1): evidenceState reads the local fold's state or the product's, and a witness handed PRODUCT evidence is never answered from the local fold - a product that did not reach the path fails where the same stream's local fold reaches it", () => {
    expect(evidenceState(localEvidence({ a: 1 }))).toEqual({ a: 1 });
    expect(evidenceState(productEvidence({ summary: { s: 1 }, state: { b: 2 } }))).toEqual({ b: 2 });
    // The set sports' and tennis's witnesses read their state through evidenceState: the local evidence of the path's own stream
    // passes, the product evidence of a plain win (no deciding set, no tie-break set) fails, with the same outcome and cfg.
    const cases: readonly [string, DecidingPath][] = [["badminton", "decidingSet"], ["volleyball", "decidingSet"], ["tennis", "tiebreakSet"]];
    let checked = 0;
    for (const [sport, path] of cases) {
      const variant = offlineBuilderDefault(sport);
      const cfg = stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant);
      const events = generateStream(req(sport, cfg, "knockout", { kind: "win", winner: "home", path }));
      const plain = foldStream(sportModule(sport), cfg, ID.home, ID.away, generateStream(req(sport, cfg, "knockout", { kind: "win", winner: "home" })));
      const own = foldStream(sportModule(sport), cfg, ID.home, ID.away, events);
      const at = `${sport} ${path}`;
      const fold = (evidence: PathFold["evidence"]): PathFold => ({ sportKey: sport, outcome: own.outcome!, cfg, evidence });
      const productOfState = (state: unknown): ProductFold => JSON.parse(JSON.stringify({ summary: sportModule(sport).summary(state as never), state })) as ProductFold;
      expect(STREAM_GENERATORS[sport]!.pathWitness!(path, fold(localEvidence(own.state))), `${at} local`).toBe(true);
      expect(STREAM_GENERATORS[sport]!.pathWitness!(path, fold(productEvidence(productOfState(own.state)))), `${at} product of the same stream`).toBe(true);
      expect(STREAM_GENERATORS[sport]!.pathWitness!(path, fold(productEvidence(productOfState(plain.state)))), `${at} product of a plain win`).toBe(false);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
});

// ---------------------------------------------------------------------------
// Task 19 — G1 (football extra time), G2 (football shoot-out).

const FB = "football";
/** A decider rule key is ON when its value is `true` (the shoot-out) or an `{enabled: true}` object (extra time). */
const isOn = (v: unknown): boolean => v === true || (typeof v === "object" && v !== null && (v as { enabled?: unknown }).enabled === true);
/** The deciding paths a football cfg switches on: the module's own decider rule keys (`deciderKeysFor`) whose value is on.
 *  Football's decider keys ARE path names (extraTime, shootout) — pinned below, so a renamed key reds here. */
function declaredPaths(cfg: unknown, kind: StageKind, variant: string): DecidingPath[] {
  return deciderKeysFor(football, kind, variant).filter((k) => isOn((cfg as Record<string, unknown>)[k])).map((k) => k as DecidingPath);
}
/** What decided each path, in the engine's own vocabulary (sport/module.ts `DecidedIn`): football's extra time is decided
 *  "in overtime" (`ot`), the penalty shoot-out "by a shoot-out" (`so`). */
const DECIDED_IN: Readonly<Record<"extraTime" | "shootout", "ot" | "so">> = { extraTime: "ot", shootout: "so" };
/** Every football variant × every stage kind the engine declares, under the cfg the product folds that stage's fixtures
 *  under (`stageCfg`: the division's variant, then the stage preset the create door writes — a bracket's extra time and
 *  penalties, X-SR-6, FB-SO-1). */
const CELLS = variantKeys(FB).flatMap((variant) =>
  StageKind.options.map((kind) => ({ variant, kind, cfg: stageCfg(FB, resolveSportCfg(FB, variant), kind, variant) as Record<string, unknown> })));
const fold = (cfg: unknown, events: Parameters<typeof foldStream>[4]) => foldStream(football, cfg, ID.home, ID.away, events);

describe("G1 G2 football: a win down extra time, a win down the shoot-out (Task 19)", () => {
  it("empty case first: football's decider keys are the two path names, and a cfg that switches neither on (every table stage) refuses both by name — as does a path football has no rule for", () => {
    expect([...deciderKeysFor(football, "knockout", null)].sort()).toEqual(["extraTime", "shootout"]);
    let refused = 0;
    for (const { variant, kind, cfg } of CELLS) {
      if (declaredPaths(cfg, kind, variant).length > 0) continue;
      for (const path of ["extraTime", "shootout"] as const) {
        expect(() => generateStream(req(FB, cfg, kind, { kind: "win", winner: "home", path })), `${variant}/${kind} ${path}`).toThrow(OutcomeUnreachable);
        refused++;
      }
    }
    expect(refused, "some football stage switches no decider on").toBeGreaterThan(0);
    const ko = CELLS.find((c) => c.variant === "11-a-side" && c.kind === "knockout")!;
    let foreign = 0;
    for (const path of DECIDING_PATHS.filter((p) => !deciderKeysFor(football, "knockout", null).includes(p))) {
      expect(() => generateStream(req(FB, ko.cfg, "knockout", { kind: "win", winner: "home", path })), path).toThrow(OutcomeUnreachable);
      expect(() => generateStream(req(FB, ko.cfg, "knockout", { kind: "win", winner: "home", path })), path).toThrow(`football has no '${path}' deciding path`);
      foreign++;
    }
    expect(foreign).toBe(DECIDING_PATHS.length - 2);
  });

  it("G1 G2: every football variant whose cfg declares extra time or a shoot-out builds a win down EACH declared path, for both winners, under a strict fold — decided in the engine's own 'ot' / 'so', counted per variant", () => {
    const perVariant = new Map<string, number>();
    let declaringCells = 0;
    for (const { variant, kind, cfg } of CELLS) {
      const paths = declaredPaths(cfg, kind, variant);
      // The engine's own reachability agrees with the cfg's switches.
      const reach = football.reachableDecidedIn(cfg as never, kind);
      expect(reach.has("ot"), `${variant}/${kind} ot`).toBe(paths.includes("extraTime"));
      expect(reach.has("so"), `${variant}/${kind} so`).toBe(paths.includes("shootout"));
      if (paths.length === 0) continue;
      declaringCells++;
      for (const path of paths) for (const winner of SIDES) {
        const at = `${variant}/${kind} ${path} ${winner}`;
        const r = req(FB, cfg, kind, { kind: "win", winner, path });
        const events = generateStream(r);
        const folded = fold(cfg, events); // strict: an out-of-order kick or a marker in the wrong phase throws
        expect(folded.outcome, at).toMatchObject({ kind: "win", winner: ID[winner], loser: ID[winner === "home" ? "away" : "home"] });
        expect(decidedInFor(football, folded.outcome), at).toBe(DECIDED_IN[path as "extraTime" | "shootout"]);
        expect(reach.has(decidedInFor(football, folded.outcome)!), at).toBe(true);
        expect(matchesRequest(r, folded.outcome, folded.state), at).toBe("match");
        // It decides on its LAST event: nothing is posted to a match already over.
        expect(fold(cfg, events.slice(0, -1)).outcome, at).toBeNull();
        // A second call builds the same stream.
        expect(generateStream(r), at).toEqual(events);
        perVariant.set(variant, (perVariant.get(variant) ?? 0) + 1);
      }
    }
    console.info(`G1 G2 football: ${declaringCells} cell(s) declare a decider; wins per variant ${JSON.stringify(Object.fromEntries(perVariant))}`);
    expect(declaringCells).toBeGreaterThan(0);
    for (const v of variantKeys(FB)) expect(perVariant.get(v) ?? 0, `${v}: no deciding-path win was checked`).toBeGreaterThan(0);
  });

  it("G2: every kick is taken by the side the engine names next (footballNextKicker over the kicks before it), the kicks run past the cfg's attempts into sudden death, and the engine took every one", () => {
    let kicksChecked = 0;
    let streams = 0;
    const attemptsSeen = new Set<number>();
    for (const { variant, kind, cfg } of CELLS) {
      if (!declaredPaths(cfg, kind, variant).includes("shootout")) continue;
      // The kicks before sudden death: the stage preset's `shootoutAttempts`, else what the engine declares an absent key means.
      const attempts = (cfg.shootoutAttempts as number | undefined) ?? (football.ruleKeys!.shootoutAttempts!.whenAbsent as number);
      attemptsSeen.add(attempts);
      for (const winner of SIDES) {
        const at = `${variant}/${kind} ${winner}`;
        const events = generateStream(req(FB, cfg, kind, { kind: "win", winner, path: "shootout" }));
        const kicks = events.filter((e) => e.type === "football.shootout.kick").map((e) => e.payload as { by: string; scored: boolean });
        const taken: ShootoutKick[] = [];
        for (const k of kicks) {
          const side: Side = k.by === ID.home ? "home" : "away";
          const next = footballNextKicker(taken);
          if (next !== null) expect(side, `${at} kick ${taken.length + 1}`).toBe(next);
          taken.push({ side, scored: k.scored });
          kicksChecked++;
        }
        expect(kicks.length, `${at}: sudden death (more than ${attempts} kicks a side)`).toBeGreaterThan(2 * attempts);
        // The shoot-out follows extra time when the cfg plays extra time (resolveFullTime), and comes straight after FT otherwise.
        const markers = events.filter((e) => e.type === "football.period").map((e) => (e.payload as { phase: string }).phase);
        expect(markers.includes("ET_FT"), at).toBe(isOn(cfg.extraTime));
        expect(events.some((e) => e.type === "football.goal"), `${at}: level into the kicks`).toBe(false);
        const state = fold(cfg, events).state as { shootout: { kicks: ShootoutKick[] } | null };
        expect(state.shootout?.kicks.map((k) => [k.side, k.scored]), at).toEqual(taken.map((k) => [k.side, k.scored]));
        streams++;
      }
    }
    console.info(`G2 football: ${streams} shoot-out stream(s), ${kicksChecked} kick(s) in the engine's order; attempts seen ${[...attemptsSeen].sort().join(", ")}`);
    expect(streams).toBeGreaterThan(0);
    // The right answer differs from a typed constant: the youth formats take 3 kicks, the rest 5 (FB-SO-1).
    expect(attemptsSeen.size, "more than one attempts count was exercised").toBeGreaterThan(1);
  });

  it("the right answer differs from the wrong one: a win down one path matches no request for the other, a regulation win matches no path, the wrong winner matches nothing, and a path win still matches a plain win request", () => {
    const { cfg } = CELLS.find((c) => c.variant === offlineBuilderDefault(FB) && c.kind === "knockout")!;
    const ask = (winner: Side, path?: DecidingPath) => req(FB, cfg, "knockout", path === undefined ? { kind: "win", winner } : { kind: "win", winner, path });
    const played = (r: StreamRequest) => fold(cfg, generateStream(r));
    const et = played(ask("home", "extraTime"));
    const so = played(ask("home", "shootout"));
    const reg = played(ask("home"));
    expect(decidedInFor(football, reg.outcome)).toBe("regulation");
    const rows: [string, StreamRequest, ReturnType<typeof played>, "match" | "mismatch"][] = [
      ["et as et", ask("home", "extraTime"), et, "match"],
      ["so as so", ask("home", "shootout"), so, "match"],
      ["et as so", ask("home", "shootout"), et, "mismatch"],
      ["so as et", ask("home", "extraTime"), so, "mismatch"],
      ["regulation as et", ask("home", "extraTime"), reg, "mismatch"],
      ["regulation as so", ask("home", "shootout"), reg, "mismatch"],
      ["et, other winner", ask("away", "extraTime"), et, "mismatch"],
      ["so, other winner", ask("away", "shootout"), so, "mismatch"],
      ["so as gws (not football's)", ask("home", "gws"), so, "mismatch"],
      ["et as a plain win", ask("home"), et, "match"],
      ["so as a plain win", ask("home"), so, "match"],
    ];
    for (const [label, r, f, want] of rows) expect(matchesRequest(r, f.outcome, f.state), label).toBe(want);
    expect(rows.filter((x) => x[3] === "mismatch").length).toBe(7);
  });

  it("G1 G2 off the presets: extra time on and the shoot-out off builds extra time and refuses the kicks; the kicks on and extra time off go from full time straight to the kicks", () => {
    const etOnly = resolveSportCfg(FB, "11-a-side", { extraTime: { enabled: true, halfMinutes: 15 }, shootout: false });
    expect(declaredPaths(etOnly, "knockout", "11-a-side")).toEqual(["extraTime"]);
    const et = generateStream(req(FB, etOnly, "knockout", { kind: "win", winner: "away", path: "extraTime" }));
    expect(decidedInFor(football, fold(etOnly, et).outcome)).toBe("ot");
    expect(() => generateStream(req(FB, etOnly, "knockout", { kind: "win", winner: "away", path: "shootout" }))).toThrow(OutcomeUnreachable);
    const soOnly = resolveSportCfg(FB, "11-a-side", { extraTime: { enabled: false, halfMinutes: 15 }, shootout: true });
    expect(declaredPaths(soOnly, "knockout", "11-a-side")).toEqual(["shootout"]);
    const so = generateStream(req(FB, soOnly, "knockout", { kind: "win", winner: "away", path: "shootout" }));
    expect(so.some((e) => e.type === "football.period" && String((e.payload as { phase: string }).phase).startsWith("ET_"))).toBe(false);
    expect(decidedInFor(football, fold(soOnly, so).outcome)).toBe("so");
    expect(() => generateStream(req(FB, soOnly, "knockout", { kind: "win", winner: "away", path: "extraTime" }))).toThrow(OutcomeUnreachable);
  });
});

// ---------------------------------------------------------------------------
// Task 20 — G2 (hockey's shoot-out), G3 (ice hockey's overtime and game-winning shots).

type PeriodSport = "hockey" | "icehockey";
const PERIOD: readonly PeriodSport[] = ["hockey", "icehockey"];
/** What the period kernel publishes about a fold (summary().detail, kernel.ts): the phase, the next whistle, whose shoot-out
 *  turn it is, the periods' goals and the shoot-out tally. The pad reads these same fields. */
interface PeriodDetail {
  phase: string; nextAdvance: string | null; shootoutNext: Side | null;
  periods: { phase: string; home: number; away: number }[]; shootout?: { home: number; away: number };
}
const foldP = (sport: PeriodSport, cfg: unknown, events: Parameters<typeof foldStream>[4]) => {
  const f = foldStream(sportModule(sport), cfg, ID.home, ID.away, events);
  return { ...f, detail: sportModule(sport).summary(f.state as never).detail as unknown as PeriodDetail };
};
/** The engine's own name for a cfg's shoot-out: the label of the pad panel that carries the sport's attempt event
 *  (`preset.shootoutLabel`: "SO" for FIH, "GWS" for the IIHF). null when the cfg plays no shoot-out (no panel). */
function shootoutLabel(sport: PeriodSport, cfg: unknown): string | null {
  const spec = sportModule(sport).padSpec?.(cfg as never);
  return spec?.panels.find((p) => p.actions.some((a) => a.type === `${sport}.shootout.attempt`))?.labelKey.label ?? null;
}
/** The request vocabulary's name for each label the engine prints: a shoot-out is "shootout", the IIHF's GWS is "gws". */
const LABEL_PATH: Readonly<Record<string, DecidingPath>> = { SO: "shootout", GWS: "gws" };
/** What decided each path, in the engine's own vocabulary (DecidedIn): overtime is "ot", a shoot-out or the GWS "so". */
const PERIOD_DECIDED_IN: Readonly<Partial<Record<DecidingPath, "ot" | "so">>> = { overtime: "ot", shootout: "so", gws: "so" };
const isSet = (v: unknown): boolean => v !== null && v !== undefined;
/** The deciding paths a period cfg switches on: each of the module's own decider rule keys (`deciderKeysFor`) whose cfg
 *  value is set, named by the engine's own label for the shoot-out. Throws on a decider key it does not know. */
function periodPaths(sport: PeriodSport, cfg: unknown, kind: StageKind, variant: string): DecidingPath[] {
  const c = cfg as { overtime: unknown; shootout: unknown };
  return deciderKeysFor(sportModule(sport), kind, variant).flatMap((k): DecidingPath[] => {
    if (k === "overtime") return isSet(c.overtime) ? ["overtime"] : [];
    if (k === "shootout") return isSet(c.shootout) ? [LABEL_PATH[shootoutLabel(sport, cfg)!]!] : [];
    throw new Error(`${sport}: decider key '${k}' is not one the period sweep knows`);
  });
}
/** Every period variant × every stage kind the engine declares, under the cfg the product folds that stage's fixtures under. */
const PERIOD_CELLS = PERIOD.flatMap((sport) => variantKeys(sport).flatMap((variant) =>
  StageKind.options.map((kind) => ({ sport, variant, kind, cfg: stageCfg(sport, resolveSportCfg(sport, variant), kind, variant) as Record<string, unknown> }))));
const win = (sport: PeriodSport, cfg: unknown, kind: StageKind, winner: Side, path?: DecidingPath) =>
  req(sport, cfg, kind, path === undefined ? { kind: "win", winner } : { kind: "win", winner, path });
/** The paths each sport OWNS, by the engine's declarations: its decider rule keys, the shoot-out named by its label. */
function ownPathsOf(sport: PeriodSport): DecidingPath[] {
  const ko = PERIOD_CELLS.find((c) => c.sport === sport && c.variant === offlineBuilderDefault(sport) && c.kind === "knockout")!;
  return deciderKeysFor(sportModule(sport), "knockout", null).map((k) => (k === "overtime" ? "overtime" : LABEL_PATH[shootoutLabel(sport, ko.cfg)!]!));
}

const icehockeyModule = () => sportModule("icehockey");

describe("G2 G3 hockey and icehockey: a win by overtime, by the shoot-out, by the GWS (Task 20)", () => {
  it("empty case first: the decider keys and the engine's own shoot-out labels, then a cfg that switches nothing on, and a path the sport has no rule for, each refuse by name as OutcomeUnreachable — never GeneratorUnsupported (Task 19 carry a)", () => {
    expect([...deciderKeysFor(sportModule("hockey"), "knockout", null)].sort()).toEqual(["shootout"]);
    expect([...deciderKeysFor(sportModule("icehockey"), "knockout", null)].sort()).toEqual(["overtime", "shootout"]);
    const ko = (sport: PeriodSport) => PERIOD_CELLS.find((c) => c.sport === sport && c.variant === offlineBuilderDefault(sport) && c.kind === "knockout")!;
    expect([shootoutLabel("hockey", ko("hockey").cfg), shootoutLabel("icehockey", ko("icehockey").cfg)]).toEqual(["SO", "GWS"]);
    expect(ownPathsOf("hockey")).toEqual(["shootout"]);
    expect(ownPathsOf("icehockey")).toEqual(["overtime", "gws"]);
    // A cfg that switches no decider on refuses EVERY path.
    let off = 0;
    for (const { sport, variant, kind, cfg } of PERIOD_CELLS) {
      if (periodPaths(sport, cfg, kind, variant).length > 0) continue;
      for (const path of DECIDING_PATHS) {
        expect(() => generateStream(req(sport, cfg, kind, { kind: "win", winner: "home", path })), `${sport}/${variant}/${kind} ${path}`).toThrow(OutcomeUnreachable);
        off++;
      }
    }
    expect(off, "some period stage switches no decider on").toBeGreaterThan(0);
    // A path the sport has no rule for: OutcomeUnreachable naming the sport and the path, on a cfg that DOES play deciders.
    let foreign = 0;
    for (const sport of PERIOD) {
      const own = ownPathsOf(sport);
      const { cfg } = PERIOD_CELLS.find((c) => c.sport === sport && c.variant === offlineBuilderDefault(sport) && c.kind === "knockout")!;
      for (const path of DECIDING_PATHS.filter((p) => !own.includes(p))) {
        const ask = () => generateStream(req(sport, cfg, "knockout", { kind: "win", winner: "home", path }));
        expect(ask, `${sport} ${path}`).toThrow(OutcomeUnreachable);
        // The message names the sport's own paths, by the engine's labels: hockey's shoot-out is 'shootout', ice hockey's the 'gws'.
        expect(ask, `${sport} ${path}`).toThrow(`${sport} has no '${path}' deciding path (its deciders: ${own.join(", ")})`);
        foreign++;
      }
    }
    // hockey's shoot-out is 'shootout' and not 'gws'; icehockey's is the GWS and not 'shootout' (the engine's labels differ).
    expect(foreign).toBe(PERIOD.length * DECIDING_PATHS.length - PERIOD.reduce((n, s) => n + ownPathsOf(s).length, 0));
  });

  it("G2 G3: every variant whose cfg declares overtime or a shoot-out builds a win down EACH declared path, for both winners, under a strict fold — decided in the engine's own 'ot' / 'so', the goal or the kicks in the right phase, counted per variant", () => {
    const perVariant = new Map<string, number>();
    const perPath = new Map<DecidingPath, number>();
    let declaringCells = 0;
    for (const { sport, variant, kind, cfg } of PERIOD_CELLS) {
      const m = sportModule(sport);
      const paths = periodPaths(sport, cfg, kind, variant);
      // The engine's own reachability agrees with the cfg's switches.
      const reach = m.reachableDecidedIn(cfg as never, kind);
      expect(reach.has("ot"), `${sport}/${variant}/${kind} ot`).toBe(paths.includes("overtime"));
      expect(reach.has("so"), `${sport}/${variant}/${kind} so`).toBe(paths.includes("shootout") || paths.includes("gws"));
      if (paths.length === 0) continue;
      declaringCells++;
      for (const path of paths) for (const winner of SIDES) {
        const at = `${sport}/${variant}/${kind} ${path} ${winner}`;
        const r = win(sport, cfg, kind, winner, path);
        const events = generateStream(r);
        const folded = foldP(sport, cfg, events); // strict: a marker or an attempt in the wrong phase, or out of turn, throws
        expect(folded.outcome, at).toMatchObject({ kind: "win", winner: ID[winner], loser: ID[winner === "home" ? "away" : "home"] });
        expect(decidedInFor(m, folded.outcome), at).toBe(PERIOD_DECIDED_IN[path]);
        expect(reach.has(decidedInFor(m, folded.outcome)!), at).toBe(true);
        expect(matchesRequest(r, folded.outcome, folded.state), at).toBe("match");
        // The win happened in the phase its path names, read off the engine's own periods and tally.
        const ot = folded.detail.periods.filter((p) => p.phase.startsWith("OT"));
        const regulation = folded.detail.periods.filter((p) => !p.phase.startsWith("OT"));
        expect(regulation.every((p) => p.home === 0 && p.away === 0), `${at}: level through regulation`).toBe(true);
        expect(ot.length > 0, `${at}: an overtime period was played iff the cfg has overtime`).toBe(isSet(cfg.overtime));
        if (path === "overtime") {
          expect(ot.reduce((n, p) => n + p.home + p.away, 0), `${at}: exactly the winner's goal, in overtime`).toBe(1);
          expect(ot.reduce((n, p) => n + p[winner], 0), at).toBe(1);
          expect(folded.detail.shootout, `${at}: no shoot-out`).toBeUndefined();
        } else {
          expect(ot.every((p) => p.home === 0 && p.away === 0), `${at}: overtime scoreless`).toBe(true);
          expect(folded.detail.shootout![winner], `${at}: the winner leads the tally`).toBeGreaterThan(folded.detail.shootout![winner === "home" ? "away" : "home"]);
        }
        // It decides on its LAST event, and a second call builds the same stream.
        expect(foldP(sport, cfg, events.slice(0, -1)).outcome, at).toBeNull();
        expect(generateStream(r), at).toEqual(events);
        perVariant.set(`${sport}/${variant}`, (perVariant.get(`${sport}/${variant}`) ?? 0) + 1);
        perPath.set(path, (perPath.get(path) ?? 0) + 1);
      }
    }
    console.info(`G2 G3 period: ${declaringCells} cell(s) declare a decider; wins per variant ${JSON.stringify(Object.fromEntries(perVariant))}; per path ${JSON.stringify(Object.fromEntries(perPath))}`);
    expect(declaringCells).toBeGreaterThan(0);
    for (const sport of PERIOD) for (const v of variantKeys(sport)) expect(perVariant.get(`${sport}/${v}`) ?? 0, `${sport}/${v}: no deciding-path win was checked`).toBeGreaterThan(0);
    for (const path of ["overtime", "shootout", "gws"] as const) expect(perPath.get(path) ?? 0, `${path}: never built`).toBeGreaterThan(0);
  });

  it("G2 G3 shooter order: the oracle is the engine's shootoutNext (read off the fold of every prefix) plus the strict fold of the whole stream — every attempt is taken by the side shootoutNext names, the first round is opened by the first taker, the opener of later pairs differs from the IFAB opener, the attempts run past the cfg's into sudden death — at attempts 3 and 5", () => {
    let kicksChecked = 0;
    let streams = 0;
    const divergent = new Map<PeriodSport, number>();
    const attemptsSeen = new Set<number>();
    const cells: { at: string; sport: PeriodSport; cfg: unknown }[] = PERIOD_CELLS
      .filter((c) => periodPaths(c.sport, c.cfg, c.kind, c.variant).some((p) => p === "shootout" || p === "gws"))
      .map((c) => ({ at: `${c.sport}/${c.variant}/${c.kind}`, sport: c.sport, cfg: c.cfg }));
    // Off the presets: the match key `shootout.attempts` may only LOWER the stage's (matchBound 'shorter'): 3, where the presets
    // hold 5. The cfg is built the way the product builds a match's own format - the stage's resolved cfg with the match's
    // override laid over it (fixture-cfg.ts mergeRulesOverride) - and the engine's own writer check (checkFixtureOverride)
    // accepts 3 and refuses a longer count, so the 3 is a value a match can really hold.
    let overridden = 0;
    for (const [sport, variant] of [["hockey", "fih-shootout"], ["icehockey", "iihf"]] as const) {
      const stage = stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant) as { shootout: { attempts: number } };
      const m = sportModule(sport);
      // A match's override carries the WHOLE top-level value (changedLeaves compares every leaf under it), so the other
      // `shootout` leaves ride along unchanged: hockey's clockSeconds would otherwise read as a change of its own.
      const withAttempts = (attempts: number) => ({ shootout: { ...stage.shootout, attempts } });
      expect(checkFixtureOverride(m, "knockout", variant, stage, withAttempts(3)), `${sport}: 3 is accepted`).toEqual({ ok: true, changed: ["shootout.attempts"] });
      expect(checkFixtureOverride(m, "knockout", variant, stage, withAttempts(stage.shootout.attempts + 1)), `${sport}: more than the stage's is refused`).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "shootout.attempts" });
      // The override is nested (whole top-level values), never a dotted key: a dotted one is no rule at all.
      expect(checkFixtureOverride(m, "knockout", variant, stage, { "shootout.attempts": 3 }), `${sport}: a dotted key`).toMatchObject({ ok: false, code: "UNKNOWN_RULE_KEY" });
      const merged = mergeRulesOverride(stage, withAttempts(3));
      expect((merged.shootout as { attempts: number }).attempts, `${sport}: the override reached the cfg`).toBe(3);
      expect(stage.shootout.attempts, `${sport}: the stage's own cfg is untouched`).toBe(5);
      cells.push({ at: `${sport}/${variant} attempts 3`, sport, cfg: merged });
      overridden++;
    }
    expect(overridden).toBe(2);
    for (const { at: cell, sport, cfg } of cells) {
      const attempts = (cfg as { shootout: { attempts: number } }).shootout.attempts;
      attemptsSeen.add(attempts);
      const path = LABEL_PATH[shootoutLabel(sport, cfg)!]!;
      for (const winner of SIDES) {
        const at = `${cell} ${winner}`;
        const events = generateStream(win(sport, cfg, "knockout", winner, path));
        const kicks: { side: Side; scored: boolean }[] = [];
        events.forEach((e, idx) => {
          if (e.type !== `${sport}.shootout.attempt`) return;
          const p = e.payload as { by: string; scored: boolean };
          const side: Side = p.by === ID.home ? "home" : "away";
          const next = foldP(sport, cfg, events.slice(0, idx)).detail.shootoutNext;
          if (kicks.length === 0) expect(next, `${at}: either side may open`).toBeNull();
          else { expect(side, `${at} attempt ${kicks.length + 1}`).toBe(next); kicksChecked++; }
          kicks.push({ side, scored: p.scored });
        });
        expect(kicks.length, `${at}: sudden death (more than ${attempts} attempts a side)`).toBeGreaterThan(2 * attempts);
        const opener = kicks[0]!.side;
        kicks.forEach((k, i) => {
          if (i % 2 !== 0) return; // a pair's opener
          if (i < 2 * attempts) expect(k.side, `${at}: pair ${i / 2 + 1} of the first round is opened by the first taker`).toBe(opener);
          else if (k.side !== opener) divergent.set(sport, (divergent.get(sport) ?? 0) + 1);
        });
        expect(foldP(sport, cfg, events).outcome, at).toMatchObject({ kind: "win", method: "shootout" });
        streams++;
      }
    }
    console.info(`G2 G3 period: ${streams} shoot-out stream(s), ${kicksChecked} attempt(s) in the engine's order; attempts seen ${[...attemptsSeen].sort().join(", ")}; later-pair openers off the IFAB opener ${JSON.stringify(Object.fromEntries(divergent))}`);
    expect(streams).toBeGreaterThan(0);
    expect(kicksChecked).toBeGreaterThan(0);
    expect([...attemptsSeen].sort()).toEqual([3, 5]);
    // The right answer differs from the typed one: FIH flips the opener per series and the IIHF's tie-break is opened by the
    // side that shot second, so a stream that kept the IFAB opener would be refused by the strict fold — in BOTH sports.
    for (const sport of PERIOD) expect(divergent.get(sport) ?? 0, `${sport}: no later pair was opened off the IFAB opener`).toBeGreaterThan(0);
  });

  it("the right answer differs from the wrong one: a win down one path matches no request for another, a regulation win matches no path, the wrong winner matches nothing, hockey's shoot-out is not the GWS and the GWS is not a 'shootout', and a path win still matches a plain win request", () => {
    const cell = (sport: PeriodSport) => PERIOD_CELLS.find((c) => c.sport === sport && c.variant === offlineBuilderDefault(sport) && c.kind === "knockout")!.cfg;
    // [label, sport, path played (home wins), path asked, winner asked, expected]
    const rows: [string, PeriodSport, DecidingPath | undefined, DecidingPath | undefined, Side, "match" | "mismatch"][] = [];
    const played = new Map<string, ReturnType<typeof foldP>>();
    const play = (sport: PeriodSport, path?: DecidingPath) => {
      const k = `${sport}/${path ?? "regulation"}`;
      if (!played.has(k)) played.set(k, foldP(sport, cell(sport), generateStream(win(sport, cell(sport), "knockout", "home", path))));
      return played.get(k)!;
    };
    rows.push(
      ["ot as ot", "icehockey", "overtime", "overtime", "home", "match"],
      ["gws as gws", "icehockey", "gws", "gws", "home", "match"],
      ["ot as gws", "icehockey", "overtime", "gws", "home", "mismatch"],
      ["gws as ot", "icehockey", "gws", "overtime", "home", "mismatch"],
      ["gws as shootout (hockey's name)", "icehockey", "gws", "shootout", "home", "mismatch"],
      ["regulation as ot", "icehockey", undefined, "overtime", "home", "mismatch"],
      ["regulation as gws", "icehockey", undefined, "gws", "home", "mismatch"],
      ["ot, other winner", "icehockey", "overtime", "overtime", "away", "mismatch"],
      ["gws, other winner", "icehockey", "gws", "gws", "away", "mismatch"],
      ["gws as extra time (football's)", "icehockey", "gws", "extraTime", "home", "mismatch"],
      ["ot as a plain win", "icehockey", "overtime", undefined, "home", "match"],
      ["gws as a plain win", "icehockey", "gws", undefined, "home", "match"],
      ["so as shootout", "hockey", "shootout", "shootout", "home", "match"],
      ["so as gws (icehockey's name)", "hockey", "shootout", "gws", "home", "mismatch"],
      ["so as overtime", "hockey", "shootout", "overtime", "home", "mismatch"],
      ["regulation as shootout", "hockey", undefined, "shootout", "home", "mismatch"],
      ["so, other winner", "hockey", "shootout", "shootout", "away", "mismatch"],
      ["so as a plain win", "hockey", "shootout", undefined, "home", "match"],
    );
    for (const [label, sport, played_, asked, askedWinner, want] of rows) {
      const f = play(sport, played_);
      expect(matchesRequest(win(sport, cell(sport), "knockout", askedWinner, asked), f.outcome, f.state), label).toBe(want);
    }
    expect(decidedInFor(sportModule("icehockey"), play("icehockey").outcome)).toBe("regulation");
    expect(rows.filter((r) => r[5] === "mismatch").length).toBe(12);
  });

  it("G2 G3 off the presets: fixed extra periods are walked label by label, overtime without a shoot-out refuses the GWS, a shoot-out without overtime goes from full time straight to the attempts, and a hand-set hockey overtime is refused (the sport has no overtime decider)", () => {
    // icehockey with two fixed overtime periods (kind 'periods'): the OT1 whistle, OT2, then FT decides — or the attempts follow.
    const fixed = resolveSportCfg("icehockey", "iihf", { overtime: { kind: "periods", count: 2, minutes: 5 } });
    const otWin = generateStream(req("icehockey", fixed, "knockout", { kind: "win", winner: "away", path: "overtime" }));
    const tos = otWin.filter((e) => e.type === "icehockey.period.advance").map((e) => (e.payload as { to: string }).to);
    expect(tos, "regulation, then OT2 and the final whistle").toEqual(["P2", "P3", "FT", "OT2", "FT"]);
    const f = foldP("icehockey", fixed, otWin);
    expect(decidedInFor(icehockeyModule(), f.outcome)).toBe("ot");
    expect(f.detail.periods.map((p) => p.phase)).toEqual(["P1", "P2", "P3", "OT1", "OT2"]);
    const gws = generateStream(req("icehockey", fixed, "knockout", { kind: "win", winner: "away", path: "gws" }));
    expect(gws.filter((e) => e.type === "icehockey.period.advance").map((e) => (e.payload as { to: string }).to), "both overtime periods are played out level").toEqual(["P2", "P3", "FT", "OT2", "FT"]);
    expect(decidedInFor(icehockeyModule(), foldP("icehockey", fixed, gws).outcome)).toBe("so");
    // overtime on, shoot-out off: the overtime builds, the GWS is refused (the cfg does not switch it on).
    const noSo = resolveSportCfg("icehockey", "iihf", { shootout: null });
    expect(decidedInFor(icehockeyModule(), foldP("icehockey", noSo, generateStream(req("icehockey", noSo, "knockout", { kind: "win", winner: "home", path: "overtime" }))).outcome)).toBe("ot");
    expect(() => generateStream(req("icehockey", noSo, "knockout", { kind: "win", winner: "home", path: "gws" }))).toThrow(/the cfg does not switch the shoot-out on/);
    // shoot-out on, overtime off: no overtime whistle; the overtime is refused.
    const noOt = resolveSportCfg("icehockey", "iihf", { overtime: null });
    const direct = generateStream(req("icehockey", noOt, "knockout", { kind: "win", winner: "home", path: "gws" }));
    expect(direct.filter((e) => e.type === "icehockey.period.advance").map((e) => (e.payload as { to: string }).to)).toEqual(["P2", "P3", "FT"]);
    expect(decidedInFor(icehockeyModule(), foldP("icehockey", noOt, direct).outcome)).toBe("so");
    expect(() => generateStream(req("icehockey", noOt, "knockout", { kind: "win", winner: "home", path: "overtime" }))).toThrow(/the cfg does not switch overtime on/);
    // hockey: the shoot-out off refuses it; an overtime a hand-built cfg carries is not a decider hockey has.
    const hk = resolveSportCfg("hockey", "fih-shootout", { shootout: null });
    expect(() => generateStream(req("hockey", hk, "knockout", { kind: "win", winner: "home", path: "shootout" }))).toThrow(/the cfg does not switch the shoot-out on/);
    const hkOt = resolveSportCfg("hockey", "fih-shootout", { overtime: { kind: "sudden_death", minutes: 5 } });
    expect(() => generateStream(req("hockey", hkOt, "knockout", { kind: "win", winner: "home", path: "overtime" }))).toThrow("hockey has no 'overtime' deciding path");
  });
});


// ---------------------------------------------------------------------------
// Task 21 — G4 (cricket's super over, under each still-tied policy), G5 (cricket's DLS).

const CKT = "cricket";
type CkStream = Parameters<typeof foldStream>[4];
/** The fields of a cricket cfg the sweeps read (the module's own schema: CricketCfg). */
interface CkCfg { ballsPerOver: number; ballsPerInnings: number | null; inningsPerSide: number; superOver: boolean; superOverStillTied: string; dls: { enabled: boolean } }
const ckModule = () => sportModule(CKT);
/** The still-tied policies, from the engine's own cfg enum (CricketCfg.superOverStillTied). */
const SO_POLICIES: readonly string[] = CricketCfg.shape.superOverStillTied.unwrap().options;
/** What the rulebook (ICC super-over conditions; the cfg's own doc, cricket.ts superOverStillTied) says each policy does when
 *  a pair of super overs is LEVEL on runs: repeat plays another pair; boundary_count decides on boundaries (and stands level if
 *  those are level too); shared stands. The method and the innings played for a win by the FIRST pair's decision, and by a level pair. */
const POLICY_RULE: Readonly<Record<string, { levelWinMethod: string; levelWinInnings: number; decisiveMethod: string }>> = {
  repeat: { levelWinMethod: "super_over", levelWinInnings: 4, decisiveMethod: "super_over" },
  boundary_count: { levelWinMethod: "boundary_count", levelWinInnings: 2, decisiveMethod: "super_over" },
  shared: { levelWinMethod: "super_over", levelWinInnings: 2, decisiveMethod: "super_over" },
};
/** `lineups`: the probe persons by default; `null` folds under none (empty slots), as the harness did before Task 21. */
const foldK = (cfg: unknown, events: CkStream, lineups: StreamLineups | null = PROBE_LINEUPS) => {
  const f = foldStream(ckModule(), cfg, ID.home, ID.away, events, lineups ?? undefined);
  return { outcome: f.outcome, state: f.state as CricketState };
};
/** The cfg a cricket knockout folds under: the division's variant, with `over` laid on it, then the stage preset. */
const ckKnockout = (variant: string, over: Record<string, unknown> = {}): CkCfg => stageCfg(CKT, resolveSportCfg(CKT, variant, over), "knockout", variant) as CkCfg;
const ckReq = (cfg: unknown, outcome: RequestedOutcome, lineups: StreamLineups | null = PROBE_LINEUPS): StreamRequest =>
  ({ ...req(CKT, cfg, "knockout", outcome), ...(lineups === null ? {} : { lineups }) });
const ckWin = (cfg: unknown, winner: Side, path: DecidingPath, lineups: StreamLineups | null = PROBE_LINEUPS): StreamRequest => ckReq(cfg, { kind: "win", winner, path }, lineups);
/** The variants the ENGINE says play a super over in a knockout (the decider rule key, and the 'so' decidedIn its preset reaches),
 *  and those it lets a stage set DLS on - both read off the module, never off a generator. */
const SO_VARIANTS = variantKeys(CKT).filter((v) => deciderKeysFor(ckModule(), "knockout", v).includes("superOver") && ckModule().reachableDecidedIn(ckKnockout(v) as never, "knockout").has("so"));
const DLS_VARIANTS = variantKeys(CKT).filter((v) => stageKeysFor(ckModule(), "knockout", v).includes("dls") && (ckKnockout(v).ballsPerInnings ?? 0) > 0 && ckKnockout(v).inningsPerSide === 1);
/** Every ball of a stream's super overs, with the innings it belongs to (0-based across the match's super overs). */
const SO_BALL = "cricket.superover.ball";
const soBallsOf = (events: CkStream) => events.filter((e) => e.type === SO_BALL).map((e) => e.payload as { over: number; ballInOver: number; striker: string; nonStriker: string; bowler: string; runs: { bat: number }; boundary?: 4 | 6 });
const boundariesOf = (st: CricketState, side: Side): number => (st.superOver?.innings ?? []).filter((i) => i.battingSide === side).reduce((n, i) => n + i.boundaries, 0);

describe("G4 G5 cricket: a win by super over (each still-tied policy) and a win by DLS (Task 21)", () => {
  it("empty case first: the engine's variants and policies, then everything a cfg or a request cannot build is refused BY NAME - no lineups, a path cricket has no rule for, super over switched off, DLS where there is no single limited innings", () => {
    expect(SO_POLICIES, "the engine's still-tied policies").toEqual(["repeat", "boundary_count", "shared"]);
    expect(SO_VARIANTS, "the limited-overs variants that play a super over (the test match plays none)").toEqual(["t20", "odi", "hundred"]);
    expect(DLS_VARIANTS).toEqual(["t20", "odi", "hundred"]);
    expect([...deciderKeysFor(ckModule(), "knockout", null)].sort()).toEqual(["superOver"]);
    let refused = 0;
    // No lineups: a super over names persons (striker, non-striker, bowler), so it cannot be built without the lineups the harness PUT.
    for (const variant of SO_VARIANTS) {
      const ask = () => generateStream(ckWin(ckKnockout(variant), "home", "superOver", null));
      expect(ask, variant).toThrow(OutcomeUnreachable);
      expect(ask, variant).toThrow(/lineup/);
      refused++;
    }
    // Super over switched off (a league stage, or the division cfg with the preset undone) refuses it; the test variant plays none.
    for (const variant of SO_VARIANTS) {
      const off = { ...ckKnockout(variant), superOver: false };
      expect(() => generateStream(ckWin(off, "home", "superOver")), variant).toThrow(/the cfg does not switch the super over on/);
      refused++;
    }
    expect(() => generateStream(ckWin(ckKnockout("test"), "home", "superOver"))).toThrow(OutcomeUnreachable);
    refused++;
    // DLS: a two-innings cfg and an unlimited one have no single limited innings to revise.
    expect(() => generateStream(ckWin(ckKnockout("test"), "home", "dls"))).toThrow(/revise applies to single-innings limited-overs/);
    refused++;
    // A path cricket has no rule for names the sport's own: its deciders are the engine's (superOver) and dls.
    for (const path of DECIDING_PATHS.filter((p) => p !== "superOver" && p !== "dls")) {
      const ask = () => generateStream(ckWin(ckKnockout("t20"), "home", path));
      expect(ask, path).toThrow(OutcomeUnreachable);
      expect(ask, path).toThrow(`cricket has no '${path}' deciding path (its deciders: superOver, dls)`);
      refused++;
    }
    expect(refused).toBe(SO_VARIANTS.length * 2 + 2 + (DECIDING_PATHS.length - 2));
    // The super over's balls are the engine's: without the lineups the engine itself refuses them, so the lineup requirement is real.
    const events = generateStream(ckWin(ckKnockout("t20"), "home", "superOver"));
    expect(() => foldK(ckKnockout("t20"), events, null)).toThrow(/is not in the fielding lineup/);
  });

  it("G4: a win down the super over, for each variant x each still-tied policy x both winners - decided in 'so' (engine), by the policy's method, in the innings the policy plays, the one over of the cfg's own size, every ball a legal CricketBall by the lineup's persons", () => {
    const perVariant = new Map<string, number>();
    const perPolicy = new Map<string, number>();
    let balls = 0;
    for (const variant of SO_VARIANTS) for (const policy of SO_POLICIES) for (const winner of SIDES) {
      const cfg = ckKnockout(variant, { superOverStillTied: policy });
      const at = `${variant}/${policy}/${winner}`;
      expect(cfg.superOver, at).toBe(true);
      expect(cfg.superOverStillTied, at).toBe(policy);
      const r = ckWin(cfg, winner, "superOver");
      const events = generateStream(r);
      const { outcome, state } = foldK(cfg, events);
      expect(outcome, at).toMatchObject({ kind: "win", winner: ID[winner], method: POLICY_RULE[policy]!.levelWinMethod });
      expect(decidedInFor(ckModule(), outcome!), at).toBe("so");
      expect(state.phase, at).toBe("done");
      expect(state.superOver!.innings.length, at).toBe(POLICY_RULE[policy]!.levelWinInnings);
      expect(state.superOver!.innings.every((i) => i.closed), at).toBe(true);
      expect(state.margin?.kind, at).toBe(POLICY_RULE[policy]!.levelWinMethod);
      expect(matchesRequest(r, outcome, state), at).toBe("match");
      expect(matchesRequest(ckWin(cfg, winner === "home" ? "away" : "home", "superOver"), outcome, state), `${at}: the other winner`).toBe("mismatch");
      // One over of the cfg's own size: the Hundred's five-ball set, a six-ball over elsewhere (ballsPerOver, the engine's cfg).
      state.superOver!.innings.forEach((i, k) => {
        expect(i.legalBalls, `${at} innings ${k}`).toBeLessThanOrEqual(cfg.ballsPerOver);
        if (k % 2 === 0) expect(i.legalBalls, `${at} innings ${k}: the first of a pair bats its whole over`).toBe(cfg.ballsPerOver);
        expect(i.battingSide, `${at} innings ${k}: the engine's alternation`).toBe(soBattingSideAt({ battingFirst: "home" }, k));
      });
      const sob = soBallsOf(events);
      let k = -1;
      for (const b of sob) {
        const parsed = CricketBall.safeParse(b);
        expect(parsed.success, `${at}: ${JSON.stringify(b)}`).toBe(true);
        if (b.ballInOver === 1) k++;
        const bat = soBattingSideAt({ battingFirst: "home" }, k);
        const field = bat === "home" ? "away" : "home";
        expect(PROBE_LINEUPS[bat], `${at}: striker`).toContain(b.striker);
        expect(PROBE_LINEUPS[bat], `${at}: non-striker`).toContain(b.nonStriker);
        expect(PROBE_LINEUPS[field], `${at}: bowler`).toContain(b.bowler);
        expect(b.over, at).toBe(0);
        balls++;
      }
      expect(balls).toBeGreaterThan(0);
      expect(k + 1, `${at}: innings with a ball`).toBe(state.superOver!.innings.length);
      perVariant.set(variant, (perVariant.get(variant) ?? 0) + 1);
      perPolicy.set(policy, (perPolicy.get(policy) ?? 0) + 1);
    }
    console.info(`w2e-streams G4: ${balls} super-over ball(s); per variant ${JSON.stringify([...perVariant])}, per policy ${JSON.stringify([...perPolicy])}`);
    for (const v of SO_VARIANTS) expect(perVariant.get(v) ?? 0, `variant ${v}`).toBe(SO_POLICIES.length * 2);
    for (const p of SO_POLICIES) expect(perPolicy.get(p) ?? 0, `policy ${p}`).toBe(SO_VARIANTS.length * 2);
    expect(ckKnockout("hundred").ballsPerOver, "the Hundred plays five-ball sets, and its super over is one of them").toBe(5);
  });

  it("G4 still tied: under EACH superOverStillTied value a level pair does what the policy says - repeat opens another pair (undecided, in the super over), shared stands level, boundary_count decides on the BALL-BY-BALL boundaries (a main-innings summary carries none) or stands level when those are level", () => {
    const seen = new Map<string, number>();
    let checked = 0;
    for (const variant of SO_VARIANTS) for (const policy of SO_POLICIES) {
      const cfg = ckKnockout(variant, { superOverStillTied: policy });
      const bpo = cfg.ballsPerOver;
      const at = `${variant}/${policy}`;
      const pair = (p: (b: number) => SuperOverPair): SuperOverPair => p(bpo);
      const level = superOverStream(ckReq(cfg, { kind: "tie" }), [pair(SO_PAIRS.level)]);
      // A level pair really is level on runs: by the pair's own balls, not by the engine's say-so.
      const lp = pair(SO_PAIRS.level);
      expect(lp.first.reduce((a, b) => a + b, 0), `${at}: level pair`).toBe(lp.second.reduce((a, b) => a + b, 0));
      const f = foldK(cfg, level);
      if (policy === "repeat") {
        expect(f.outcome, `${at}: repeat leaves the match undecided`).toBeNull();
        expect(f.state.phase, at).toBe("super_over");
        expect(f.state.superOver!.innings.length, at).toBe(2);
        // ...and the NEXT pair opens on the next ball, the sides batting in the engine's alternation: another pair decides it.
        const again = superOverStream(ckReq(cfg, { kind: "tie" }), [pair(SO_PAIRS.level), pair(SO_PAIRS.firstWins)]);
        const g = foldK(cfg, again);
        expect(g.outcome, at).toMatchObject({ kind: "win", method: "super_over" });
        expect(g.state.superOver!.innings.map((i) => i.battingSide), at).toEqual([0, 1, 2, 3].map((k) => soBattingSideAt({ battingFirst: "home" }, k)));
      } else if (policy === "shared") {
        expect(f.outcome, at).toEqual({ kind: "tie" });
        expect(f.state.phase, at).toBe("done");
      } else {
        // No boundary on either side: level on boundaries too, so it stands.
        expect(f.outcome, at).toEqual({ kind: "tie" });
        const equal = foldK(cfg, superOverStream(ckReq(cfg, { kind: "tie" }), [pair(SO_PAIRS.levelEqualBoundaries)]));
        expect(equal.outcome, `${at}: two boundaries each`).toEqual({ kind: "tie" });
        expect(boundariesOf(equal.state, "home"), at).toBe(boundariesOf(equal.state, "away"));
        expect(boundariesOf(equal.state, "home"), `${at}: the equal case has boundaries to count`).toBeGreaterThan(0);
        // The side with MORE boundaries wins, whichever side it is; the main innings carry none (summaries name no boundaries).
        for (const [label, p] of [["first batter", SO_PAIRS.levelFirstMore], ["second batter", SO_PAIRS.levelSecondMore]] as const) {
          const events = superOverStream(ckReq(cfg, { kind: "tie" }), [pair(p)]);
          const g = foldK(cfg, events);
          const h = boundariesOf(g.state, "home");
          const a = boundariesOf(g.state, "away");
          expect(h, `${at} ${label}`).not.toBe(a);
          expect(g.outcome, `${at} ${label}`).toMatchObject({ kind: "win", winner: h > a ? ID.home : ID.away, method: "boundary_count" });
          expect(decidedInFor(ckModule(), g.outcome!), at).toBe("so");
          expect(g.state.innings.reduce((n, i) => n + i.boundaries, 0), `${at}: no main-innings boundary - only ball-by-ball ones count`).toBe(0);
          expect(events.filter((e) => e.type === "cricket.innings.summary").every((e) => !("boundaries" in (e.payload as object))), at).toBe(true);
          expect(soBallsOf(events).filter((b) => b.boundary !== undefined).length, `${at} ${label}`).toBe(h + a);
          checked++;
        }
      }
      seen.set(policy, (seen.get(policy) ?? 0) + 1);
      checked++;
    }
    for (const p of SO_POLICIES) expect(seen.get(p) ?? 0, `policy ${p}`).toBe(SO_VARIANTS.length);
    expect(checked).toBeGreaterThan(SO_POLICIES.length * SO_VARIANTS.length);
  });

  it("G4 tie: a 'tie' request is reachable exactly where the engine can end a super over level (canEndLevel: shared and boundary_count, not repeat), folds to a tie, and is refused by name without lineups", () => {
    let reachable = 0;
    let refused = 0;
    for (const variant of SO_VARIANTS) for (const policy of SO_POLICIES) {
      const cfg = ckKnockout(variant, { superOverStillTied: policy });
      const at = `${variant}/${policy}`;
      const can = ckModule().canEndLevel!(cfg as never);
      expect(can, `${at}: the engine's own declaration`).toBe(policy !== "repeat");
      if (can) {
        const events = generateStream(ckReq(cfg, { kind: "tie" }));
        expect(foldK(cfg, events).outcome, at).toEqual({ kind: "tie" });
        expect(matchesRequest(ckReq(cfg, { kind: "tie" }), foldK(cfg, events).outcome), at).toBe("match");
        reachable++;
        expect(() => generateStream(ckReq(cfg, { kind: "tie" }, null)), `${at} without lineups`).toThrow(OutcomeUnreachable);
      } else {
        expect(() => generateStream(ckReq(cfg, { kind: "tie" })), at).toThrow(OutcomeUnreachable);
        expect(() => generateStream(ckReq(cfg, { kind: "tie" })), at).toThrow(/super over/);
      }
      refused++;
    }
    expect(reachable).toBe(SO_VARIANTS.length * (SO_POLICIES.length - 1));
    expect(refused).toBe(SO_VARIANTS.length * SO_POLICIES.length);
    // The level question the bracket policy asks (levelReachable) needs no lineups and stays "no" for a super over: unchanged by Task 21.
    expect(() => generateStream(ckReq(ckKnockout("t20", { superOverStillTied: "shared" }), { kind: "level" }, null))).toThrow(OutcomeUnreachable);
  });

  it("G5: a win by DLS, for each limited-overs variant x DLS off (the umpires' manual target) and on (the engine's own computation) x both winners - interruption, then the revise, then a chase inside the revised target's bound", () => {
    const perVariant = new Map<string, number>();
    const flavours = new Set<string>();
    for (const variant of DLS_VARIANTS) for (const dlsOn of [false, true]) for (const winner of SIDES) {
      const cfg = ckKnockout(variant, { dls: { enabled: dlsOn, edition: "standard" } });
      const at = `${variant}/dls ${dlsOn ? "on" : "off"}/${winner}`;
      expect(cfg.dls.enabled, at).toBe(dlsOn);
      const r = ckWin(cfg, winner, "dls", null);
      const events = generateStream(r);
      expect(events.map((e) => e.type), at).toEqual(["core.start", "cricket.innings.summary", "cricket.interruption", "cricket.revise", "cricket.innings.summary"]);
      const { outcome, state } = foldK(cfg, events, null);
      expect(outcome, at).toMatchObject({ kind: "win", winner: ID[winner], method: "dls" });
      expect(decidedInFor(ckModule(), outcome!), `${at}: a revised target is no extra play`).toBe("regulation");
      const first = state.innings[0]!;
      const chase = state.innings[1]!;
      expect(state.targetSource, at).toBe(dlsOn ? "dls" : "manual");
      if (dlsOn) expect(state.revisedTarget, `${at}: the engine's own Standard Edition target`).toBe(dlsTarget(first.runs, state.r1!, state.r2!));
      expect(state.revisedTarget!, `${at}: the revision lowered the target`).toBeLessThan(first.runs + 1);
      const revise = events.find((e) => e.type === "cricket.revise")!.payload as { oversPerSide: number; target?: number };
      expect(state.quota, `${at}: the shortened quota is overs x the cfg's ballsPerOver`).toBe(revise.oversPerSide * cfg.ballsPerOver);
      expect(revise.oversPerSide * cfg.ballsPerOver, `${at}: a real shortening`).toBeLessThan(cfg.ballsPerInnings!);
      expect(chase.legalBalls, at).toBeLessThanOrEqual(state.quota!);
      // CK-CH-1: a chase ends at the winning run - its total is within target - 1 + 7, the engine's bound (read here as the guard).
      expect(chase.runs, at).toBeLessThanOrEqual(state.revisedTarget! - 1 + 7);
      if (winner === "home") {
        expect(chase.runs, `${at}: the chase fell short of the revised target`).toBeLessThan(state.revisedTarget! - 1);
        expect(state.margin?.kind, at).toBe("runs");
      } else {
        expect(chase.runs, `${at}: the chase reached the revised target...`).toBeGreaterThanOrEqual(state.revisedTarget!);
        expect(chase.runs, `${at}: ...which the unrevised target would NOT have been`).toBeLessThan(first.runs + 1);
        expect(state.margin?.kind, at).toBe("wickets");
        expect(state.margin).toMatchObject({ value: expect.any(Number) as number });
      }
      expect(matchesRequest(r, outcome, state), at).toBe("match");
      expect(matchesRequest(ckWin(cfg, winner === "home" ? "away" : "home", "dls"), outcome, state), `${at}: the other winner`).toBe("mismatch");
      // A plain win by the same chase, no revision, is NOT a DLS win: the same request for a regulation win carries no targetSource.
      const plain = foldK(cfg, generateStream(ckReq(cfg, { kind: "win", winner }, null)), null);
      expect((plain.outcome as { method?: string }).method, `${at}: a regulation win`).toBe("regulation");
      expect(matchesRequest(r, plain.outcome, plain.state), `${at}: the witness refuses a regulation win as DLS`).toBe("mismatch");
      flavours.add(`${dlsOn}`);
      perVariant.set(variant, (perVariant.get(variant) ?? 0) + 1);
    }
    for (const v of DLS_VARIANTS) expect(perVariant.get(v) ?? 0, `variant ${v}`).toBe(4);
    expect([...flavours].sort()).toEqual(["false", "true"]);
  });

  // Task 21 review M1: the cricket witness is a CONJUNCTION. Each conjunct is perturbed alone on the state a real stream folds to,
  // so a witness that dropped one still answers true on the others and is caught here.
  it("the cricket path witness holds each of its conjuncts: a super over needs a done match, WHOLE closed pairs of innings (not none, not odd, not open) and the margin its method names, decided in 'so'; DLS needs the dls method AND a revised target with a source the engine writes - each perturbed alone on a real stream's state, both entry points", () => {
    const wit = STREAM_GENERATORS[CKT]!.pathWitness!;
    const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    interface St { phase: string; margin: { kind: string } | null; superOver: { innings: { closed: boolean }[] } | null; targetSource: string | null; revisedTarget: number | null }
    let rows = 0;
    const judge = (path: DecidingPath, cfg: CkCfg, outcome: unknown, state: unknown, want: boolean, label: string): void => {
      const fold = (evidence: PathFold["evidence"]): PathFold => ({ sportKey: CKT, outcome: outcome as never, cfg, evidence });
      // Both entry points answer the same: the local strict fold's state and the product's served copy of it.
      expect(wit(path, fold(localEvidence(state))), `${path} ${label} (local)`).toBe(want);
      expect(wit(path, fold(productEvidence({ summary: null, state }))), `${path} ${label} (product)`).toBe(want);
      rows++;
    };
    for (const policy of SO_POLICIES) {
      const cfg = ckKnockout("t20", { superOverStillTied: policy });
      const { outcome, state } = foldK(cfg, generateStream(ckWin(cfg, "home", "superOver")));
      const st = state as unknown as St;
      judge("superOver", cfg, outcome, st, true, `${policy}: the real fold`);
      const edit = (e: (s: St) => void): St => { const c = clone(st); e(c); return c; };
      judge("superOver", cfg, outcome, edit((c) => { c.phase = "live"; }), false, `${policy}: not done`);
      judge("superOver", cfg, outcome, edit((c) => { c.superOver = null; }), false, `${policy}: no super over on the state`);
      judge("superOver", cfg, outcome, edit((c) => { c.superOver = { innings: [] }; }), false, `${policy}: no innings`);
      judge("superOver", cfg, outcome, edit((c) => { c.superOver!.innings.push({ closed: true }); }), false, `${policy}: an odd number of innings (a pair is open)`);
      judge("superOver", cfg, outcome, edit((c) => { c.superOver!.innings[c.superOver!.innings.length - 1]!.closed = false; }), false, `${policy}: the last innings is still open`);
      judge("superOver", cfg, outcome, edit((c) => { c.margin = { kind: "runs" }; }), false, `${policy}: a margin the method does not name`);
      judge("superOver", cfg, outcome, edit((c) => { c.margin = null; }), false, `${policy}: no margin`);
      // The outcome is held to the engine's decidedIn as well: the same state under a regulation win is not a super-over win.
      judge("superOver", cfg, { ...(outcome as object), method: "regulation" }, st, false, `${policy}: decided in regulation`);
      // ...and alone: a state whose margin AGREES with a regulation method (so the margin conjunct holds) but whose outcome the engine
      // does not call a super-over decision.
      judge("superOver", cfg, { ...(outcome as object), method: "regulation" }, edit((c) => { c.margin = { kind: "regulation" }; }), false, `${policy}: a regulation win over a state that holds super-over innings`);
      // A method cricket does not write at all is no evidence either - answered false, never thrown out of the witness.
      judge("superOver", cfg, { ...(outcome as object), method: "runs" }, edit((c) => { c.margin = { kind: "runs" }; }), false, `${policy}: a method cricket does not write`);
    }
    for (const dlsOn of [false, true]) {
      const cfg = ckKnockout("t20", { dls: { enabled: dlsOn, edition: "standard" } });
      const { outcome, state } = foldK(cfg, generateStream(ckWin(cfg, "home", "dls", null)), null);
      const st = state as unknown as St;
      judge("dls", cfg, outcome, st, true, `dls ${dlsOn ? "on" : "off"}: the real fold (source ${String(st.targetSource)})`);
      const edit = (e: (s: St) => void): St => { const c = clone(st); e(c); return c; };
      judge("dls", cfg, { ...(outcome as object), method: "regulation" }, st, false, `dls ${dlsOn ? "on" : "off"}: the regulation method`);
      judge("dls", cfg, outcome, edit((c) => { c.targetSource = null; }), false, `dls ${dlsOn ? "on" : "off"}: no target source`);
      judge("dls", cfg, outcome, edit((c) => { c.targetSource = "organiser"; }), false, `dls ${dlsOn ? "on" : "off"}: a source the engine does not write`);
      judge("dls", cfg, outcome, edit((c) => { c.revisedTarget = null; }), false, `dls ${dlsOn ? "on" : "off"}: no revised target`);
      judge("dls", cfg, outcome, edit((c) => { (c as { revisedTarget: unknown }).revisedTarget = "120"; }), false, `dls ${dlsOn ? "on" : "off"}: a revised target that is no number`);
    }
    // A path cricket has no rule for, and a state that is no object, answer false rather than throw.
    judge("extraTime", ckKnockout("t20"), { kind: "win", winner: ID.home, method: "regulation" }, {}, false, "a path cricket does not build");
    judge("dls", ckKnockout("t20"), { kind: "win", winner: ID.home, method: "dls" }, null, false, "no state at all");
    expect(rows, "anti-vacuity: rows judged").toBe(SO_POLICIES.length * 11 + 2 * 6 + 2);
  });

  it("G5 bound: the chase total is the engine's CHASE_OVERSHOOT edge - target - 1 + 7 is accepted, one more is refused with the engine's code - so the generator's chase stays inside a guard that is reached", () => {
    let edges = 0;
    for (const variant of DLS_VARIANTS) {
      const cfg = ckKnockout(variant);
      const events = generateStream(ckWin(cfg, "away", "dls", null));
      const target = foldK(cfg, events.slice(0, -1), null).state.revisedTarget!;
      const withChase = (runs: number) => [...events.slice(0, -1), { ...events.at(-1)!, payload: { ...(events.at(-1)!.payload as object), runs } }];
      expect(() => foldK(cfg, withChase(target - 1 + 7), null), `${variant}: the bound itself`).not.toThrow();
      let code: string | undefined;
      try { foldK(cfg, withChase(target - 1 + 7 + 1), null); } catch (e) { code = EngineError.is(e) ? e.code : String(e); }
      expect(code, `${variant}: one past the bound`).toBe("CHASE_OVERSHOOT");
      edges++;
    }
    expect(edges).toBe(DLS_VARIANTS.length);
  });

  it("G4 G5 vocabulary: ALL_OUTCOMES is still W2b's seven and nothing is known-unsupported - the new shapes run in their own sweeps", () => {
    expect(ALL_OUTCOMES.map(outcomeLabel)).toEqual(["win-home", "win-away", "draw", "forfeit-away-walkover", "forfeit-home-retired", "abandon", "tie"]);
    expect(ALL_OUTCOMES).toHaveLength(7);
    expect(KNOWN_UNSUPPORTED).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// Task 22 — G6 (a win in the deciding set), G7 (a win by the score cap): badminton, volleyball, table tennis.
// Neither path is NAMED by the outcome (every set sport's win is method 'regulation', decided 'regulation'), so both are state
// only: the witness reads the sets the fold holds — the PRODUCT's state when the fold carries it (Task 21).

/** The set sports, by the ENGINE's own mark (set-oracles.ts). */
const SET_SPORTS: readonly string[] = setSportsOf(SPORT_KEYS);
/** Every set variant × every stage kind the engine declares, under the cfg the product folds that stage's fixtures under. */
const SET_CELLS = SET_SPORTS.flatMap((sport) => variantKeys(sport).flatMap((variant) =>
  StageKind.options.map((kind) => ({ sport, variant, kind, cfg: stageCfg(sport, resolveSportCfg(sport, variant), kind, variant) as SetCfg }))));
const foldS = (sport: string, cfg: unknown, events: readonly StreamEvent[]) => foldSet(sport, cfg, events, ID.home, ID.away);
const otherSide = (s: Side): Side => (s === "home" ? "away" : "home");
const setWin = (sport: string, cfg: unknown, winner: Side, path?: DecidingPath): StreamRequest =>
  req(sport, cfg, "knockout", path === undefined ? { kind: "win", winner } : { kind: "win", winner, path });
/** The sets a side won, by the higher score of each CLOSED set. */
const setsWonBy = (st: SetFoldState, side: Side): number => st.sets.filter((s) => s.closed && s[side] > s[otherSide(side)]).length;
/** A cfg the product could WRITE: the variant with `over` laid on it, parsed by the module's schema and not refused by the write
 *  door (the engine's set-target floors, ruling 31) - so no stream below is built from a below-floor setTo. */
function okCfg(sport: string, variant: string, over: Record<string, unknown> = {}): SetCfg {
  const cfg = stageCfg(sport, resolveSportCfg(sport, variant, over), "knockout", variant);
  expect(writeConfigIssues(sportModule(sport), cfg), `${sport}/${variant} ${JSON.stringify(over)} is a cfg a write door refuses`).toEqual([]);
  return cfg as SetCfg;
}
/** The write door's set-target floor FOUND from the engine's own refusal: the smallest `setTo = finalSetTo` it accepts (1 = none). */
function floorOf(sport: string, variant: string): number {
  for (let n = 1; n <= 40; n++) if (writeConfigIssues(sportModule(sport), resolveSchemaCfg(sport, variant, { setTo: n, finalSetTo: n })).length === 0) return n;
  throw new Error(`${sport}/${variant}: no set target up to 40 passes the write door`);
}
const productOfFold = (sport: string, cfg: unknown, events: readonly StreamEvent[]): ProductFold => {
  const { state } = foldStream(sportModule(sport), cfg, ID.home, ID.away, events);
  return JSON.parse(JSON.stringify({ summary: sportModule(sport).summary(state as never), state })) as ProductFold;
};
/** A PathFold for `events` folded locally, handed `product` as the product's evidence (null = none: the generator's own request match). */
const pathFoldOf = (sport: string, cfg: unknown, events: readonly StreamEvent[], product: ProductFold | null): PathFold => {
  const f = foldStream(sportModule(sport), cfg, ID.home, ID.away, events);
  return { sportKey: sport, outcome: f.outcome!, cfg, evidence: product === null ? localEvidence(f.state) : productEvidence(product) };
};
const witnessOf = (sport: string, path: DecidingPath, fold: PathFold): boolean => STREAM_GENERATORS[sport]!.pathWitness!(path, fold);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const SET_PATHS = ["decidingSet", "cap"] as const;

describe("G6 G7 set sports: a win in the deciding set, a win by the score cap (Task 22)", () => {
  it("empty case first: the set sports are the engine's and the generator serves exactly them; none declares a decider rule key or reaches anything but regulation, so the outcome cannot name either path - both are state only", () => {
    expect(SET_SPORTS.length).toBeGreaterThan(0);
    expect([...SET_SPORTS].sort(), "the engine's set sports are the generator's").toEqual([...setbasedGenerator.sportKeys].sort());
    expect(SET_SPORTS.every((s) => STREAM_GENERATORS[s]!.pathWitness !== undefined), "each builds paths").toBe(true);
    let cells = 0;
    for (const { sport, variant, kind, cfg } of SET_CELLS) {
      const m = sportModule(sport);
      expect(deciderKeysFor(m, kind, variant), `${sport}/${variant}/${kind}`).toEqual([]);
      expect([...m.reachableDecidedIn(cfg as never, kind)], `${sport}/${variant}/${kind}`).toEqual(["regulation"]);
      cells++;
    }
    expect(cells).toBe(SET_CELLS.length);
    expect(cells).toBeGreaterThan(SET_SPORTS.length);
  });

  it("everything a request or a cfg cannot build is refused BY NAME as OutcomeUnreachable, never GeneratorUnsupported: a path the sport has no rule for, a cap the cfg does not declare, a cap that never binds, a deciding set a best of one lacks", () => {
    const foreign = DECIDING_PATHS.filter((p) => !(SET_PATHS as readonly string[]).includes(p));
    let refused = 0;
    for (const sport of SET_SPORTS) {
      const cfg = okCfg(sport, offlineBuilderDefault(sport));
      for (const path of foreign) {
        const ask = () => generateStream(setWin(sport, cfg, "home", path));
        expect(ask, `${sport} ${path}`).toThrow(OutcomeUnreachable);
        expect(ask, `${sport} ${path}`).toThrow(`${sport} has no '${path}' deciding path (its deciders: decidingSet, cap)`);
        refused++;
      }
    }
    expect(refused).toBe(SET_SPORTS.length * foreign.length);
    expect(foreign.length).toBe(DECIDING_PATHS.length - 2);
    // A cap the cfg does not declare: every cell whose cap is null (volleyball, table tennis), and the engine's oracle agrees.
    let noCap = 0;
    for (const { sport, variant, kind, cfg } of SET_CELLS) {
      if (cfg.cap !== null) continue;
      expect(capBinds(sport, cfg), `${sport}/${variant}/${kind}`).toBe(false);
      const ask = () => generateStream(setWin(sport, cfg, "home", "cap"));
      expect(ask, `${sport}/${variant}/${kind}`).toThrow(OutcomeUnreachable);
      expect(ask, `${sport}/${variant}/${kind}`).toThrow(/the cfg declares no cap/);
      noCap++;
    }
    expect(noCap).toBeGreaterThan(0);
    // A cap that never binds: a lead of one already wins (winBy 1), so the set ends before the deuce - the engine's fold says so.
    const oneUp = okCfg("badminton", "bwf", { winBy: 1 });
    expect(oneUp.cap, "a cap is declared...").toBe(30);
    expect(capBinds("badminton", oneUp), "...and never decides a set").toBe(false);
    expect(() => generateStream(setWin("badminton", oneUp, "home", "cap"))).toThrow(/a lead of one already wins/);
    // A deciding set a best of one lacks: its only set IS the match (the engine's oracle: no level sets are possible).
    let bo1 = 0;
    for (const sport of SET_SPORTS) {
      const cfg = okCfg(sport, offlineBuilderDefault(sport), { bestOf: 1 });
      expect(decidingSetReachable(sport, cfg), sport).toBe(false);
      expect(() => generateStream(setWin(sport, cfg, "home", "decidingSet")), sport).toThrow(OutcomeUnreachable);
      expect(() => generateStream(setWin(sport, cfg, "home", "decidingSet")), sport).toThrow(/bestOf 1 has no deciding set/);
      bo1++;
    }
    expect(bo1).toBe(SET_SPORTS.length);
    // ...while a best of one with a cap still has its one set capped.
    const bo1Cap = okCfg("badminton", "bwf", { bestOf: 1 });
    const one = foldS("badminton", bo1Cap, generateStream(setWin("badminton", bo1Cap, "away", "cap")));
    expect(one.state.sets).toEqual([{ home: bo1Cap.cap! - 1, away: bo1Cap.cap!, closed: true }]);
  });

  it("G6: every set sport x variant builds a win IN THE DECIDING SET for both winners - the sets level at majority-1 each, the last to the deciding target (finalSetTo, not setTo) - under a strict fold, with an outcome no different from a straight-sets win's, counted per variant", () => {
    const perVariant = new Map<string, number>();
    let differing = 0;
    for (const { sport, variant, kind, cfg } of SET_CELLS) {
      const at0 = `${sport}/${variant}/${kind}`;
      expect(decidingSetReachable(sport, cfg), at0).toBe(true);
      const m = sportModule(sport);
      const k = majority(cfg.bestOf);
      for (const winner of SIDES) {
        const at = `${at0} ${winner}`;
        const r = setWin(sport, cfg, winner, "decidingSet");
        const events = generateStream(r);
        const f = foldS(sport, cfg, events);
        expect(f.outcome, at).toMatchObject({ kind: "win", winner: ID[winner], loser: ID[otherSide(winner)] });
        // State only: the outcome is the straight-sets win's, byte for byte, and decided 'regulation' - the outcome cannot say it.
        expect(f.outcome, at).toEqual(foldS(sport, cfg, generateStream(setWin(sport, cfg, winner))).outcome);
        expect(decidedInFor(m, f.outcome!), at).toBe("regulation");
        const sets = f.state.sets;
        expect(sets.length, `${at}: every set of the best of ${cfg.bestOf} was played`).toBe(cfg.bestOf);
        expect(sets.every((s) => s.closed), at).toBe(true);
        expect(setsWonBy(f.state, winner), at).toBe(k);
        expect(setsWonBy(f.state, otherSide(winner)), at).toBe(k - 1);
        const before = { ...f.state, sets: sets.slice(0, -1) };
        expect(setsWonBy(before, "home"), `${at}: level before the last set`).toBe(k - 1);
        expect(setsWonBy(before, "away"), `${at}: level before the last set`).toBe(k - 1);
        expect(sets.at(-1)![winner] > sets.at(-1)![otherSide(winner)], `${at}: the winner took the last set`).toBe(true);
        // Each set ends exactly at its target: setTo, and the DECIDING set's own finalSetTo.
        sets.forEach((s, i) => expect(Math.max(s.home, s.away), `${at} set ${i + 1}`).toBe(i === cfg.bestOf - 1 ? cfg.finalSetTo : cfg.setTo));
        expect(matchesRequest(r, f.outcome, f.state), at).toBe("match");
        expect(matchesRequest(setWin(sport, cfg, otherSide(winner), "decidingSet"), f.outcome, f.state), `${at}: the other winner`).toBe("mismatch");
        expect(matchesRequest(setWin(sport, cfg, winner, "cap"), f.outcome, f.state), `${at}: not a cap win`).toBe("mismatch");
        expect(foldS(sport, cfg, events.slice(0, -1)).outcome, `${at}: decides on its last event`).toBeNull();
        expect(generateStream(r), `${at}: a second call`).toEqual(events);
        if (cfg.finalSetTo !== cfg.setTo) differing++;
        perVariant.set(`${sport}/${variant}`, (perVariant.get(`${sport}/${variant}`) ?? 0) + 1);
      }
    }
    console.info(`G6 set sports: wins per variant ${JSON.stringify(Object.fromEntries(perVariant))}; ${differing} win(s) whose deciding set is played to a different target`);
    for (const sport of SET_SPORTS) for (const v of variantKeys(sport)) expect(perVariant.get(`${sport}/${v}`) ?? 0, `${sport}/${v}: no deciding-set win was checked`).toBeGreaterThan(0);
    // The right answer differs from the wrong one: volleyball plays its deciding set to 15, not the 25 (or 21) of the others.
    expect(differing, "some variant's deciding set is played to a different target than its other sets").toBeGreaterThan(0);
    const vb = SET_CELLS.find((c) => c.sport === "volleyball" && c.variant === "indoor" && c.kind === "knockout")!;
    expect(vb.cfg.finalSetTo).not.toBe(vb.cfg.setTo);
    // ...and the engine refuses the wrong constant: the deciding set played to setTo is not a reachable final score there.
    const events = generateStream(setWin("volleyball", vb.cfg, "home", "decidingSet"));
    const last = events.at(-1)!;
    const wrong = [...events.slice(0, -1), { ...last, payload: { home: vb.cfg.setTo, away: 0 } }];
    expect(() => foldS("volleyball", vb.cfg, wrong)).toThrow(/not a reachable final score/);
  });

  it("G7: a win BY THE CAP wherever the engine's own rally fold says the cap decides a set (and a refusal by name where it does not): every set the winner takes ends cap : cap-1, under a strict fold, with an outcome no different from a straight-sets win's", () => {
    const perVariant = new Map<string, number>();
    let binding = 0;
    let unbound = 0;
    for (const { sport, variant, kind, cfg } of SET_CELLS) {
      const at0 = `${sport}/${variant}/${kind}`;
      const binds = capBinds(sport, cfg);
      if (!binds) {
        expect(() => generateStream(setWin(sport, cfg, "home", "cap")), at0).toThrow(OutcomeUnreachable);
        unbound++;
        continue;
      }
      binding++;
      const m = sportModule(sport);
      for (const winner of SIDES) {
        const at = `${at0} ${winner}`;
        const r = setWin(sport, cfg, winner, "cap");
        const events = generateStream(r);
        const f = foldS(sport, cfg, events);
        expect(f.outcome, at).toMatchObject({ kind: "win", winner: ID[winner], loser: ID[otherSide(winner)] });
        expect(f.outcome, at).toEqual(foldS(sport, cfg, generateStream(setWin(sport, cfg, winner))).outcome);
        expect(decidedInFor(m, f.outcome!), at).toBe("regulation");
        const sets = f.state.sets;
        expect(sets.length, `${at}: straight sets`).toBe(majority(cfg.bestOf));
        for (const [i, s] of sets.entries()) {
          expect(s.closed, `${at} set ${i + 1}`).toBe(true);
          expect([s[winner], s[otherSide(winner)]], `${at} set ${i + 1}: the cap, then one short of it`).toEqual([cfg.cap, cfg.cap! - 1]);
        }
        expect(matchesRequest(r, f.outcome, f.state), at).toBe("match");
        expect(matchesRequest(setWin(sport, cfg, otherSide(winner), "cap"), f.outcome, f.state), `${at}: the other winner`).toBe("mismatch");
        expect(matchesRequest(setWin(sport, cfg, winner, "decidingSet"), f.outcome, f.state), `${at}: not a deciding-set win`).toBe("mismatch");
        expect(foldS(sport, cfg, events.slice(0, -1)).outcome, `${at}: decides on its last event`).toBeNull();
        expect(generateStream(r), `${at}: a second call`).toEqual(events);
        perVariant.set(`${sport}/${variant}`, (perVariant.get(`${sport}/${variant}`) ?? 0) + 1);
      }
    }
    console.info(`G7 set sports: ${binding} cell(s) where the cap binds, ${unbound} where it does not; wins per variant ${JSON.stringify(Object.fromEntries(perVariant))}`);
    expect(binding).toBeGreaterThan(0);
    expect(unbound).toBeGreaterThan(0);
    // Every variant whose cfg declares a cap (with winBy 2) was checked, and only those: badminton's three.
    const declaring = new Set(SET_CELLS.filter((c) => c.cfg.cap !== null && c.cfg.winBy >= 2).map((c) => `${c.sport}/${c.variant}`));
    expect([...perVariant.keys()].sort()).toEqual([...declaring].sort());
    expect([...declaring].every((v) => v.startsWith("badminton/")), "only badminton ships a cap").toBe(true);
    expect(declaring.size).toBe(variantKeys("badminton").length);
  });

  it("G7 the right answer differs from the wrong one: 21-20 ends a set under bwf-3x15 (cap 21) and 30-29 under bwf (cap 30) - and the strict fold refuses each under the other's cfg; the rulebook anchors both (BWF Laws 7.4 / 7.5: at 29-all the 30th point wins; the 3x15 format: at 20-all the 21st)", () => {
    const cfgs = new Map(variantKeys("badminton").map((v) => [v, okCfg("badminton", v)] as const));
    const streams = new Map([...cfgs].map(([v, cfg]) => [v, generateStream(setWin("badminton", cfg, "home", "cap"))] as const));
    const scoreOf = (e: StreamEvent) => (e.payload as { home: number; away: number });
    // The rulebook's numbers, typed once as the independent anchor (the cfg's declared cap is the engine's, the code under test).
    expect(scoreOf(streams.get("bwf-3x15")![1]!)).toEqual({ home: 21, away: 20 });
    expect(scoreOf(streams.get("bwf")![1]!)).toEqual({ home: 30, away: 29 });
    expect(new Set([...cfgs.values()].map((c) => c.cap)).size, "the variants' caps differ").toBe(cfgs.size);
    let refused = 0;
    for (const [a, eventsA] of streams) for (const [b, cfgB] of cfgs) {
      if (a === b) continue;
      expect(() => foldS("badminton", cfgB, eventsA), `${a}'s capped set under ${b}`).toThrow(/not a reachable final score/);
      expect(matchesRequest(setWin("badminton", cfgB, "home", "cap"), { kind: "win", winner: ID.home, loser: ID.away, method: "regulation" }, foldS("badminton", cfgs.get(a)!, eventsA).state), `${a}'s state asked as ${b}`).toBe("mismatch");
      refused++;
    }
    expect(refused).toBe(cfgs.size * (cfgs.size - 1));
    // 3x15's declared shape is 15 / 15 / 21: the deciding-set override equals setTo, and the cap sits above both.
    const x = cfgs.get("bwf-3x15")!;
    expect([x.setTo, x.finalSetTo, x.cap]).toEqual([15, 15, 21]);
    // ...and a decidingSet win under 3x15 is played to 15, which is not a cap ending (15-x, x <= 10 ... a plain win).
    const ds = foldS("badminton", x, generateStream(setWin("badminton", x, "home", "decidingSet"))).state;
    expect(ds.sets.at(-1)!.home).toBe(x.finalSetTo);
    expect(ds.sets.at(-1)!.home).not.toBe(x.cap);
  });

  it("one generator, three sports: a cap can be declared on volleyball too (its own rule key lets a match set one), at a set target at the write door's floor, and every cfg used here passes the engine's write door - table tennis, whose ruleKeys bar a cap, never gets one", () => {
    // The floors, found from the engine's refusal: volleyball and table tennis have one, badminton none.
    expect(floorOf("badminton", "bwf")).toBe(1);
    const vbFloor = floorOf("volleyball", "indoor");
    const ttFloor = floorOf("tabletennis", "bo5");
    expect(vbFloor).toBeGreaterThan(1);
    expect(ttFloor).toBeGreaterThan(1);
    expect(writeConfigIssues(sportModule("volleyball"), resolveSchemaCfg("volleyball", "indoor", { setTo: vbFloor - 1 })), "one below the floor is refused").not.toEqual([]);
    let built = 0;
    // At the floor: the shortest legal sets still build both paths for both winners, and the strict fold takes them.
    for (const [sport, variant, floor] of [["volleyball", "indoor", vbFloor], ["volleyball", "beach", vbFloor], ["tabletennis", "bo5", ttFloor]] as const) {
      const cfg = okCfg(sport, variant, { setTo: floor, finalSetTo: floor });
      for (const winner of SIDES) {
        const f = foldS(sport, cfg, generateStream(setWin(sport, cfg, winner, "decidingSet")));
        expect(f.outcome, `${sport}/${variant} at the floor ${winner}`).toMatchObject({ kind: "win", winner: ID[winner] });
        expect(f.state.sets.length).toBe(cfg.bestOf);
        built++;
      }
    }
    // Volleyball with a cap: the set kernel's cap, on a sport that ships none.
    const vbCap = okCfg("volleyball", "indoor", { cap: 28 });
    expect(Object.hasOwn(sportModule("volleyball").ruleKeys!, "cap"), "volleyball's matches may set a cap").toBe(true);
    expect(Object.hasOwn(sportModule("tabletennis").ruleKeys!, "cap"), "table tennis's may not").toBe(false);
    // Task 22 M3: the cap is a value a match can really hold - the engine's own writer check (checkFixtureOverride) accepts a
    // volleyball match's `cap` override and refuses table tennis's by name, and the cfg the product folds under (the stage's
    // resolved cfg with the override laid over it, fixture-cfg.ts mergeRulesOverride) is the cfg this test plays.
    const vbStage = stageCfg("volleyball", resolveSportCfg("volleyball", "indoor"), "knockout", "indoor") as Record<string, unknown>;
    const ttStage = stageCfg("tabletennis", resolveSportCfg("tabletennis", "bo5"), "knockout", "bo5") as Record<string, unknown>;
    expect(checkFixtureOverride(sportModule("volleyball"), "knockout", "indoor", vbStage, { cap: 28 }), "volleyball: a match may set a cap").toEqual({ ok: true, changed: ["cap"] });
    expect(checkFixtureOverride(sportModule("tabletennis"), "knockout", "bo5", ttStage, { cap: 28 }), "table tennis: a cap is no rule of its").toMatchObject({ ok: false, code: "UNKNOWN_RULE_KEY", path: "cap" });
    expect(mergeRulesOverride(vbStage, { cap: 28 }).cap, "the override reached the cfg the product folds under").toBe(28);
    expect(mergeRulesOverride(vbStage, { cap: 28 }), "...and it is the cfg played here").toEqual(vbCap);
    expect(capBinds("volleyball", vbCap)).toBe(true);
    for (const winner of SIDES) {
      const f = foldS("volleyball", vbCap, generateStream(setWin("volleyball", vbCap, winner, "cap")));
      expect(f.state.sets.every((s) => s[winner] === 28 && s[otherSide(winner)] === 27), `volleyball cap ${winner}`).toBe(true);
      expect(f.state.sets.length).toBe(majority(vbCap.bestOf));
      built++;
    }
    // The deciding set of that volleyball cfg still plays to finalSetTo (15), under a cap of 28.
    const vbDs = foldS("volleyball", vbCap, generateStream(setWin("volleyball", vbCap, "home", "decidingSet")));
    expect(Math.max(vbDs.state.sets.at(-1)!.home, vbDs.state.sets.at(-1)!.away)).toBe(vbCap.finalSetTo);
    expect(vbCap.finalSetTo).not.toBe(vbCap.cap);
    built++;
    // A best of 7 (table tennis bo7): three sets level, a seventh to decide.
    const bo7 = okCfg("tabletennis", "bo7");
    const f7 = foldS("tabletennis", bo7, generateStream(setWin("tabletennis", bo7, "away", "decidingSet")));
    expect([setsWonBy(f7.state, "home"), setsWonBy(f7.state, "away"), f7.state.sets.length]).toEqual([3, 4, 7]);
    built++;
    expect(built).toBe(3 * 2 + 2 + 1 + 1);
  });

  it("the witness reads the PRODUCT's state when the fold carries it: a product that never reached the deciding set or the cap reds a stream the local fold proves, the product's state is believed over the local fold's, a right path under the wrong key reds, and a half or inconsistent product reds", () => {
    const triples: readonly (readonly [string, string, DecidingPath])[] = [
      ["badminton", "bwf-3x15", "decidingSet"], ["badminton", "bwf-3x15", "cap"], ["badminton", "bwf", "cap"], ["badminton", "bwf", "decidingSet"],
      ["volleyball", "indoor", "decidingSet"], ["volleyball", "beach", "decidingSet"], ["tabletennis", "bo5", "decidingSet"], ["tabletennis", "bo7", "decidingSet"],
    ];
    let rows = 0;
    for (const [sport, variant, path] of triples) {
      const cfg = okCfg(sport, variant);
      const at = `${sport}/${variant} ${path}`;
      const events = generateStream(setWin(sport, cfg, "home", path));
      const plain = generateStream(setWin(sport, cfg, "home"));
      const own = productOfFold(sport, cfg, events);
      const straight = productOfFold(sport, cfg, plain);
      const row = (label: string, want: boolean, local: readonly StreamEvent[], product: ProductFold | null, asked: DecidingPath = path) => {
        expect(witnessOf(sport, asked, pathFoldOf(sport, cfg, local, product)), `${at}: ${label}`).toBe(want);
        rows++;
      };
      row("the product's own state", true, events, own);
      row("no product: the generator's own request match reads the local fold", true, events, null);
      row("a product that never reached the path (a straight-sets win) although the local fold did", false, events, straight);
      row("the product's state is believed over the local fold's", true, plain, own);
      row("the local fold plain and no product", false, plain, null);
      // Right path under the wrong key: the same stream asked as the other path, or as a path the sport lacks.
      for (const other of SET_PATHS.filter((p) => p !== path)) row(`asked as '${other}'`, false, events, own, other);
      row("asked as a shoot-out", false, events, own, "shootout");
      // A half or inconsistent product.
      row("no summary", false, events, { summary: null, state: own.state });
      row("no state", false, events, { summary: own.summary, state: null });
      row("a state that is no object", false, events, { summary: own.summary, state: "done" });
      const strip = clone(own) as { summary: { detail: { sets: { home: number }[] } } };
      strip.summary.detail.sets[0]!.home += 1;
      row("a summary whose set strip is not the state's", false, events, strip as unknown as ProductFold);
      const otherCfg = clone(own) as { state: { cfg: SetCfg } };
      otherCfg.state.cfg.setTo += 1;
      row("a state folded under another cfg than the one asked", false, events, otherCfg as unknown as ProductFold);
      const otherWinner = clone(own) as { state: { outcome: { winner: string } } };
      otherWinner.state.outcome.winner = ID.away;
      row("a state whose own outcome names the other winner", false, events, otherWinner as unknown as ProductFold);
      const live = clone(own) as { state: { phase: string } };
      live.state.phase = "live";
      row("a match not yet done", false, events, live as unknown as ProductFold);
      const open = clone(own) as { state: { sets: { closed: boolean }[] } };
      open.state.sets[open.state.sets.length - 1]!.closed = false;
      row("a last set still open", false, events, open as unknown as ProductFold);
      type SetRow = { home: number; away: number; closed: boolean };
      const withSets = (edit: (sets: SetRow[]) => void): ProductFold => {
        const c = clone(own) as { summary: { detail: { sets: SetRow[] } }; state: { sets: SetRow[] } };
        edit(c.state.sets);
        edit(c.summary.detail.sets);
        return c as unknown as ProductFold;
      };
      // Task 22 M5: a state (and a summary strip) with NO sets - nothing was played - is no evidence of any path, and a state that
      // seats neither entrant as the outcome's winner cannot say which side's set table to read.
      row("a state with no sets at all", false, events, withSets((sets) => { sets.length = 0; }));
      const strangers = clone(own) as { state: { entrants: { home: string; away: string } } };
      strangers.state.entrants = { home: "stranger-1", away: "stranger-2" };
      row("a state whose entrants do not include the outcome's winner", false, events, strangers as unknown as ProductFold);
      if (path === "decidingSet") {
        // A set table with a closed TIED set in it (no engine state has one): the two count guards each stand alone - one set
        // short of a loser's win, and one set past the best of N.
        row("a loser's set replaced by a tie (the sets are not level before the last)", false, events, withSets((sets) => { sets[0] = { home: 5, away: 5, closed: true }; }));
        row("a tied set past the best of N (the counts are right, the table is too long)", false, events, withSets((sets) => { sets.unshift({ home: 5, away: 5, closed: true }); }));
      }
    }
    // A cap that EQUALS the set target (a legal cfg: the engine's cap field is 15..35): a plain win to 21 also reaches the cap's
    // number, but a lead of five is no cap ending - only a lead shorter than winBy is (cap : cap-1). The cap stream is.
    const flat = okCfg("badminton", "bwf", { cap: 21 });
    expect([flat.setTo, flat.cap, capBinds("badminton", flat)], "the cap sits ON the target and still binds").toEqual([21, 21, true]);
    const plainFlat = generateStream(setWin("badminton", flat, "home"));
    const capFlat = generateStream(setWin("badminton", flat, "home", "cap"));
    expect(witnessOf("badminton", "cap", pathFoldOf("badminton", flat, capFlat, null)), "21-20 under a cap of 21").toBe(true);
    expect(witnessOf("badminton", "cap", pathFoldOf("badminton", flat, plainFlat, null)), "a plain win to 21 is not a cap ending").toBe(false);
    expect(witnessOf("badminton", "cap", pathFoldOf("badminton", flat, plainFlat, productOfFold("badminton", flat, plainFlat))), "...nor on the product's state").toBe(false);
    rows += 3;
    // Task 22 M2: the cap witness holds the set that ENDED the match to the cap, whatever the earlier sets were. (The generator's own
    // cap stream caps every set its winner takes - the G7 sweep asserts each - but a real match can level 1-1 and then end 30-29 in
    // its deciding set, and that is a cap ending too; a capped FIRST set under an ordinary last one is not.)
    let capShapes = 0;
    for (const variant of ["bwf", "bwf-3x15"]) {
      const cfg = okCfg("badminton", variant);
      const at = `badminton/${variant}`;
      const ds = generateStream(setWin("badminton", cfg, "home", "decidingSet"));
      expect(ds.map((e) => e.type), `${at}: START, three sets`).toHaveLength(4);
      const capped = { ...ds[3]!, payload: { home: cfg.cap, away: cfg.cap! - 1 } };
      const levelThenCap = [ds[0]!, ds[1]!, ds[2]!, capped];
      const f = foldS("badminton", cfg, levelThenCap);
      expect(f.state.sets.map((x) => [x.home, x.away]), `${at}: 1-1, then the deciding set at the cap`).toEqual([[f.state.sets[0]!.home, f.state.sets[0]!.away], [f.state.sets[1]!.home, f.state.sets[1]!.away], [cfg.cap, cfg.cap! - 1]]);
      expect([setsWonBy(f.state, "home"), setsWonBy(f.state, "away")], `${at}: sets level before the last`).toEqual([2, 1]);
      for (const asked of ["cap", "decidingSet"] as const) {
        expect(witnessOf("badminton", asked, pathFoldOf("badminton", cfg, levelThenCap, null)), `${at}: a 1-1 match ended at the cap is a '${asked}' ending (local)`).toBe(true);
        expect(witnessOf("badminton", asked, pathFoldOf("badminton", cfg, levelThenCap, productOfFold("badminton", cfg, levelThenCap))), `${at}: ...and so on the product's state`).toBe(true);
      }
      expect(matchesRequest(setWin("badminton", cfg, "home", "cap"), f.outcome, f.state), `${at}: the request match agrees`).toBe("match");
      // A capped first set under an ordinary deciding set: the cap did not end the match.
      const firstCapped = [ds[0]!, { ...ds[2]!, payload: { home: cfg.cap, away: cfg.cap! - 1 } }, ds[1]!, ds[3]!];
      const g = foldS("badminton", cfg, firstCapped);
      expect(g.outcome, `${at}: still a home win`).toMatchObject({ kind: "win", winner: ID.home });
      expect(witnessOf("badminton", "cap", pathFoldOf("badminton", cfg, firstCapped, null)), `${at}: a capped FIRST set under an ordinary last one is no cap ending`).toBe(false);
      expect(witnessOf("badminton", "cap", pathFoldOf("badminton", cfg, firstCapped, productOfFold("badminton", cfg, firstCapped))), `${at}: ...nor on the product's state`).toBe(false);
      expect(witnessOf("badminton", "decidingSet", pathFoldOf("badminton", cfg, firstCapped, null)), `${at}: but it IS a deciding-set win`).toBe(true);
      capShapes++;
      rows += 7; // four level-then-cap witness rows, three first-set-capped rows
    }
    expect(capShapes, "anti-vacuity: both cap variants").toBe(2);
    console.info(`G6 G7 witness: ${rows} row(s) over ${triples.length} path win(s)`);
    expect(rows).toBeGreaterThan(triples.length * 10);
  });

  it("G6 G7 vocabulary: ALL_OUTCOMES is still W2b's seven and nothing is known-unsupported - the new shapes run in their own sweep", () => {
    expect(ALL_OUTCOMES.map(outcomeLabel)).toEqual(["win-home", "win-away", "draw", "forfeit-away-walkover", "forfeit-home-retired", "abandon", "tie"]);
    expect(ALL_OUTCOMES).toHaveLength(7);
    expect(ALL_OUTCOMES.filter((o) => o.kind === "win" && o.path !== undefined)).toEqual([]);
    expect(KNOWN_UNSUPPORTED).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task 23 — G8 (a win down a tie-break set, a win down the short-set tie-break): tennis. Neither path is NAMED by the outcome
// (a tennis win is method 'regulation', decided 'regulation' however its sets ended), so both are state only: the witness reads
// the closed sets the fold holds - the PRODUCT's state when the fold carries it (Task 21) - and which rules closed the last one.

const TENNIS = "tennis";
const TN_PATHS = ["tiebreakSet", "shortSetTb"] as const;
type TnPath = (typeof TN_PATHS)[number];
const TN_VARIANTS = variantKeys(TENNIS);
/** RULEBOOK ANCHORS, typed once as the independent answer (the cfg's declarations are the engine's, the code under test reads
 *  them): which tie-break a shipped variant ends its sets with. ITF Rules of Tennis: the set tie-break at 6-all, first to 7 by
 *  2 (tour, the grand slam's, the doubles norm); the deciding set of the slam plays its own tie-break to 10, and the doubles norm
 *  replaces it with a match tie-break to 10 (Appendix VI). Appendix VI short sets: first to 4 games, the tie-break at 3-all
 *  (Fast4) or at 4-all ("short-sets"), first to 5 with a deciding point at 4-all (Tennis Canada, Rules of the Court 2026
 *  pp.33-35, which reproduces Appendix VI; the ITF PDF itself was not retrievable, a0-findings E30). */
const TN_RULEBOOK: Readonly<Record<string, readonly TnPath[]>> = {
  tour: ["tiebreakSet"], "grand-slam": ["tiebreakSet"], "doubles-noad-mtb10": ["tiebreakSet"], fast4: ["shortSetTb"], "short-sets": ["shortSetTb"],
};
/** Every tennis variant x every stage kind the engine declares, under the cfg the product folds that stage's fixtures under. */
const TN_CELLS = TN_VARIANTS.flatMap((variant) =>
  StageKind.options.map((kind) => ({ variant, kind, cfg: stageCfg(TENNIS, resolveSportCfg(TENNIS, variant), kind, variant) as TennisCfg })));
const foldT = (cfg: unknown, events: readonly StreamEvent[]) => foldTennis(cfg, events, ID.home, ID.away);
const tnWin = (cfg: unknown, winner: Side, path?: DecidingPath): StreamRequest => req(TENNIS, cfg, "knockout", path === undefined ? { kind: "win", winner } : { kind: "win", winner, path });
/** A tennis cfg the product could WRITE: the variant with `over` laid on it, parsed by the module's schema and not refused by the
 *  write door (TN-CF-1) - so no stream below is built from a cfg the product would refuse at create. */
function tnCfg(variant: string, over: Record<string, unknown> = {}): TennisCfg {
  const resolved = resolveSportCfg(TENNIS, variant, over) as Record<string, unknown>;
  // Task 23 M6, fail-closed: an override the schema drops (a misspelt key, a field the cfg does not have) would leave the variant
  // unchanged and the test green on the cfg it never meant to build. Every key must reach the cfg, with the value laid on it.
  for (const [k, v] of Object.entries(over)) {
    expect(Object.hasOwn(resolved, k), `${variant}: the override key '${k}' was dropped by the cfg schema (a typo, not a test)`).toBe(true);
    if (typeof v === "object" && v !== null) expect(resolved[k], `${variant}: override '${k}' reached the cfg`).toMatchObject(v);
    else expect(resolved[k], `${variant}: override '${k}' reached the cfg`).toEqual(v);
  }
  // The door sees the DIVISION's cfg (what the editor writes) and the stage's folds are the same cfg under the presets: both lawful.
  expect(writeConfigIssues(sportModule(TENNIS), resolved), `${variant} ${JSON.stringify(over)} is a cfg a write door refuses`).toEqual([]);
  const cfg = stageCfg(TENNIS, resolved, "knockout", variant);
  expect(writeConfigIssues(sportModule(TENNIS), cfg), `${variant} ${JSON.stringify(over)} (under the knockout presets) is a cfg a write door refuses`).toEqual([]);
  return cfg as TennisCfg;
}
/** The rules the tie-break of a set was played under, read off the cfg's declarations (nested/kernel.ts `rulesFor`, W2e RB2A-12):
 *  an ordinary set's own target and margin (`set.tiebreakWinBy`, else the match's), the deciding set's override
 *  (`finalSet.tiebreakTo`, at the MATCH margin - the short set's margin is not carried over, Task 13), the match tie-break's
 *  (`finalSet.matchTiebreakTo`, at the match margin). */
function tbRules(cfg: TennisCfg, deciding: boolean): { to: number; winBy: number } {
  if (deciding && typeof cfg.finalSet === "object" && "matchTiebreakTo" in cfg.finalSet) return { to: cfg.finalSet.matchTiebreakTo, winBy: cfg.tiebreak.winBy };
  if (deciding && typeof cfg.finalSet === "object" && "tiebreakTo" in cfg.finalSet) return { to: cfg.finalSet.tiebreakTo, winBy: cfg.tiebreak.winBy };
  return { to: cfg.set.tiebreakTo, winBy: cfg.set.tiebreakWinBy ?? cfg.tiebreak.winBy };
}
const isDecidingAt = (cfg: TennisCfg, before: TennisFoldState["sets"]): boolean =>
  tennisSetsWonBy(before, "home") === majority(cfg.bestOf) - 1 && tennisSetsWonBy(before, "away") === majority(cfg.bestOf) - 1;

describe("G8 tennis: a win down a tie-break set, a win down the short-set tie-break (Task 23)", () => {
  it("empty case first: the engine's tennis variants all have a rulebook verdict, tennis declares no decider rule key and reaches nothing but regulation (so the outcome cannot name either path - both are state only), and a path win's outcome is the plain win's", () => {
    expect(TN_VARIANTS.length).toBeGreaterThan(0);
    expect([...TN_VARIANTS].sort(), "a new tennis variant owes a rulebook verdict here").toEqual(Object.keys(TN_RULEBOOK).sort());
    expect([...tennisGenerator.sportKeys]).toEqual([TENNIS]);
    expect(STREAM_GENERATORS[TENNIS]!.pathWitness, "tennis builds paths").toBeDefined();
    const m = sportModule(TENNIS);
    let cells = 0;
    for (const { variant, kind, cfg } of TN_CELLS) {
      expect(deciderKeysFor(m, kind, variant), `${variant}/${kind}`).toEqual([]);
      expect([...m.reachableDecidedIn(cfg as never, kind)], `${variant}/${kind}`).toEqual(["regulation"]);
      cells++;
    }
    expect(cells).toBe(TN_VARIANTS.length * StageKind.options.length);
    let paths = 0;
    for (const { variant, cfg } of TN_CELLS.filter((c) => c.kind === "knockout")) for (const path of TN_RULEBOOK[variant]!) {
      for (const winner of SIDES) {
        expect(foldT(cfg, generateStream(tnWin(cfg, winner, path))).outcome, `${variant} ${path} ${winner}`).toEqual(foldT(cfg, generateStream(tnWin(cfg, winner))).outcome);
        paths++;
      }
    }
    expect(paths).toBe(2 * Object.values(TN_RULEBOOK).flat().length);
  });

  it("everything a request or a cfg cannot build is refused BY NAME as OutcomeUnreachable, never GeneratorUnsupported: a path tennis has no rule for, the other tennis path where the cfg declares none, a tie-break a cfg without one cannot end a set with, and TN-CF-1's best of one with a match tie-break (no stream may use it)", () => {
    // A path tennis has no rule for - and a tennis path asked of any OTHER sport whose generator builds paths: all OutcomeUnreachable.
    const foreign = DECIDING_PATHS.filter((p) => !(TN_PATHS as readonly string[]).includes(p));
    let refused = 0;
    for (const variant of TN_VARIANTS) {
      const cfg = tnCfg(variant);
      for (const path of foreign) {
        const ask = () => generateStream(tnWin(cfg, "home", path));
        expect(ask, `${variant} ${path}`).toThrow(OutcomeUnreachable);
        expect(ask, `${variant} ${path}`).toThrow(`tennis has no '${path}' deciding path (its deciders: tiebreakSet, shortSetTb)`);
        refused++;
      }
    }
    expect(refused).toBe(TN_VARIANTS.length * foreign.length);
    expect(foreign.length).toBe(DECIDING_PATHS.length - 2);
    let elsewhere = 0;
    for (const sportKey of SPORT_KEYS) {
      if (sportKey === TENNIS || STREAM_GENERATORS[sportKey]!.pathWitness === undefined) continue;
      const variant = offlineBuilderDefault(sportKey);
      const cfg = stageCfg(sportKey, resolveSportCfg(sportKey, variant), "knockout", variant);
      for (const path of TN_PATHS) {
        expect(() => generateStream({ ...req(sportKey, cfg, "knockout", { kind: "win", winner: "home", path }), lineups: PROBE_LINEUPS }), `${sportKey} ${path}`).toThrow(OutcomeUnreachable);
        elsewhere++;
      }
    }
    expect(elsewhere, "the sports that build paths refuse tennis's by name").toBeGreaterThan(2 * TN_PATHS.length);
    // The other tennis path, where the cfg declares none: each variant builds exactly its rulebook paths.
    let lacking = 0;
    for (const { variant, kind, cfg } of TN_CELLS) for (const path of TN_PATHS) {
      if (TN_RULEBOOK[variant]!.includes(path)) continue;
      expect(() => generateStream(tnWin(cfg, "home", path)), `${variant}/${kind} ${path}`).toThrow(OutcomeUnreachable);
      lacking++;
    }
    expect(lacking).toBe(StageKind.options.length * (TN_VARIANTS.length * TN_PATHS.length - Object.values(TN_RULEBOOK).flat().length));
    // An advantage set (tiebreakAt null) ends no set in a tie-break: with the deciding set an ordinary set, neither path exists...
    const advantage = tnCfg("tour", { set: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 } });
    for (const path of TN_PATHS) expect(() => generateStream(tnWin(advantage, "home", path)), `advantage set ${path}`).toThrow(/OutcomeUnreachable|cannot reach/);
    // ...but a match tie-break still stands in for the deciding set, so the doubles norm keeps a tiebreakSet win (the engine says
    // the set sheet needs no games tie-break for it).
    const advantageMtb = tnCfg("doubles-noad-mtb10", { set: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 } });
    const viaMtb = foldT(advantageMtb, generateStream(tnWin(advantageMtb, "home", "tiebreakSet")));
    expect(viaMtb.state.sets.at(-1)!.mtb, "the deciding set is the match tie-break").toBe(true);
    expect(viaMtb.state.sets.every((s) => s.tb === undefined), "no set ended in a games tie-break").toBe(true);
    expect(() => generateStream(tnWin(advantageMtb, "home", "shortSetTb"))).toThrow(OutcomeUnreachable);
    // TN-CF-1 (RB2A-13): a best of one with a match tie-break is refused when a config is written, so no stream is built from it.
    const bo1Mtb = resolveSchemaCfg(TENNIS, "doubles-noad-mtb10", { bestOf: 1 }); // the schema alone: the write door refuses this one (TN-CF-1), a STORED one still loads
    expect(writeConfigIssues(sportModule(TENNIS), bo1Mtb), "the engine's write door refuses it").toEqual([BO1_MATCH_TIEBREAK]);
    for (const path of TN_PATHS) {
      expect(() => generateStream(tnWin(bo1Mtb, "home", path)), path).toThrow(OutcomeUnreachable);
      expect(() => generateStream(tnWin(bo1Mtb, "home", path)), path).toThrow(/TN-CF-1/);
    }
    // ...while a best of one whose deciding set is a SET with a final-set tie-break is no match tie-break and is built.
    const bo1Final = tnCfg("tour", { bestOf: 1, finalSet: { tiebreakTo: 10 } });
    const one = foldT(bo1Final, generateStream(tnWin(bo1Final, "away", "tiebreakSet")));
    expect(one.state.sets, "a single set, the deciding one, ended in the tie-break to the final-set target").toHaveLength(1);
    expect(one.state.sets[0]!.tb![ "away" ]).toBe(10);
    // ...and a best of one short set is its own short-set tie-break win.
    const bo1Short = tnCfg("short-sets", { bestOf: 1 });
    expect(foldT(bo1Short, generateStream(tnWin(bo1Short, "home", "shortSetTb"))).state.sets).toHaveLength(1);
  });

  it("G8: every tennis variant x stage kind builds a win down each tie-break path the rulebook gives it (tiebreakSet, shortSetTb) for both winners - the last set closed by a tie-break at its own target and margin (the engine's edges), the deciding set played where its rules differ (the slam's tie-break to 10, the match tie-break) - under a strict fold, counted per variant and per path", () => {
    const perVariant = new Map<string, number>();
    const perPath = new Map<TnPath, number>();
    let refusedPaths = 0;
    let decider = 0;
    let mtbs = 0;
    let finalSetTbs = 0;
    for (const { variant, kind, cfg } of TN_CELLS) {
      for (const path of TN_PATHS) {
        const at0 = `${variant}/${kind} ${path}`;
        if (!TN_RULEBOOK[variant]!.includes(path)) { refusedPaths++; continue; }
        for (const winner of SIDES) {
          const at = `${at0} ${winner}`;
          const loser = otherSide(winner);
          const r = tnWin(cfg, winner, path);
          const events = generateStream(r);
          const f = foldT(cfg, events);
          expect(f.outcome, at).toMatchObject({ kind: "win", winner: ID[winner], loser: ID[loser] });
          // State only: the outcome is the plain win's, byte for byte, decided 'regulation' - the outcome cannot say it.
          expect(f.outcome, at).toEqual(foldT(cfg, generateStream(tnWin(cfg, winner))).outcome);
          expect(decidedInFor(sportModule(TENNIS), f.outcome!), at).toBe("regulation");
          const sets = f.state.sets;
          const last = sets.at(-1)!;
          const deciding = isDecidingAt(cfg, sets.slice(0, -1));
          expect(last[winner] > last[loser], `${at}: the winner took the match-deciding set`).toBe(true);
          // The deciding set is PLAYED where its rules differ from an ordinary set's (the engine's finalSet declaration), and only then.
          const decidingDiffers = cfg.finalSet !== "same" && cfg.bestOf >= 3 && path === "tiebreakSet";
          expect(sets.length, `${at}: straight sets, or the whole best of ${cfg.bestOf}`).toBe(decidingDiffers ? cfg.bestOf : majority(cfg.bestOf));
          expect(deciding, at).toBe(decidingDiffers);
          // What closed the last set, by the cfg's declarations; the engine's own edges pin the target and the margin.
          const rules = tbRules(cfg, deciding);
          if (last.mtb === true) {
            expect(deciding && typeof cfg.finalSet === "object" && "matchTiebreakTo" in cfg.finalSet, `${at}: a match tie-break only stands in for the deciding set`).toBe(true);
            expect(last.tb, at).toBeUndefined();
            expect([last[winner], last[loser]], `${at}: the match tie-break's closest finish`).toEqual([rules.to, rules.to - rules.winBy]);
            mtbs++;
          } else {
            expect(cfg.set.tiebreakAt, at).not.toBeNull();
            expect([last[winner], last[loser]], `${at}: tiebreakAt+1 : tiebreakAt`).toEqual([cfg.set.tiebreakAt! + 1, cfg.set.tiebreakAt!]);
            expect([last.tb![winner], last.tb![loser]], `${at}: the tie-break's closest finish`).toEqual([rules.to, rules.to - rules.winBy]);
            if (deciding && typeof cfg.finalSet === "object" && "tiebreakTo" in cfg.finalSet) finalSetTbs++;
          }
          expect(tbIsClosestFinish(cfg, events), `${at}: the engine accepts it as streamed and refuses it a point short of the target and of the margin`).toEqual({ accepted: true, targetEdge: true, marginEdge: true });
          // Which tie-break: the short-set tie-break is the SET's own margin (declared); the tie-break set's is the match's, or the match tie-break.
          const shortTb = last.mtb !== true && cfg.set.tiebreakWinBy !== undefined && !(deciding && typeof cfg.finalSet === "object" && "tiebreakTo" in cfg.finalSet);
          expect(shortTb, `${at}: the path names the margin the last set was closed under`).toBe(path === "shortSetTb");
          // Every set the winner took ended in the tie-break where the cfg has one; every set the loser took is plain games.
          for (const [i, s] of sets.entries()) {
            if (s.mtb === true) continue;
            if (s[winner] > s[loser]) expect(s.tb !== undefined, `${at} set ${i + 1}: the winner's set`).toBe(cfg.set.tiebreakAt !== null);
            else expect(s.tb, `${at} set ${i + 1}: the loser's set`).toBeUndefined();
          }
          expect(matchesRequest(r, f.outcome, f.state), at).toBe("match");
          expect(matchesRequest(tnWin(cfg, loser, path), f.outcome, f.state), `${at}: the other winner`).toBe("mismatch");
          for (const other of TN_PATHS.filter((p) => p !== path)) expect(matchesRequest(tnWin(cfg, winner, other), f.outcome, f.state), `${at}: asked as '${other}'`).toBe("mismatch");
          expect(foldT(cfg, events.slice(0, -1)).outcome, `${at}: decides on its last event`).toBeNull();
          expect(generateStream(r), `${at}: a second call`).toEqual(events);
          if (deciding) decider++;
          perVariant.set(variant, (perVariant.get(variant) ?? 0) + 1);
          perPath.set(path, (perPath.get(path) ?? 0) + 1);
        }
      }
    }
    console.info(`G8 tennis: wins per variant ${JSON.stringify(Object.fromEntries(perVariant))}, per path ${JSON.stringify(Object.fromEntries(perPath))}; ${decider} reached the deciding set (${mtbs} match tie-breaks, ${finalSetTbs} final-set tie-breaks); ${refusedPaths} (cell, path) pairs refused by name`);
    for (const v of TN_VARIANTS) expect(perVariant.get(v) ?? 0, `${v}: no tie-break win was checked`).toBeGreaterThan(0);
    for (const p of TN_PATHS) expect(perPath.get(p) ?? 0, `${p}: no win was checked`).toBeGreaterThan(0);
    expect(decider, "some variant plays its deciding set").toBeGreaterThan(0);
    expect(mtbs, "the doubles norm's match tie-break").toBeGreaterThan(0);
    expect(finalSetTbs, "the slam's final-set tie-break").toBeGreaterThan(0);
    expect(refusedPaths).toBeGreaterThan(0);
  });

  it("G8 the right answer differs from the wrong one: tour's 7-6, Fast4's 4-3 and the short-sets variant's 5-4 each end a set in a tie-break - and the strict fold refuses each under the others' cfgs; the rulebook anchors all three (the ITF set tie-break at 6-all; App VI's short-set tie-break at 3-all and at 4-all)", () => {
    // The rulebook's numbers, typed once as the independent anchor.
    const ANCHOR: Readonly<Record<string, { games: [number, number]; tb: [number, number]; path: TnPath }>> = {
      tour: { games: [7, 6], tb: [7, 5], path: "tiebreakSet" },
      fast4: { games: [4, 3], tb: [5, 4], path: "shortSetTb" },
      "short-sets": { games: [5, 4], tb: [5, 4], path: "shortSetTb" },
    };
    const cfgs = new Map(Object.keys(ANCHOR).map((v) => [v, tnCfg(v)] as const));
    const streams = new Map([...cfgs].map(([v, cfg]) => [v, generateStream(tnWin(cfg, "home", ANCHOR[v]!.path))] as const));
    for (const [v, a] of Object.entries(ANCHOR)) {
      const set = foldT(cfgs.get(v), streams.get(v)!).state.sets[0]!;
      expect([set.home, set.away], `${v}: the tie-break set`).toEqual(a.games);
      expect([set.tb!.home, set.tb!.away], `${v}: its tie-break`).toEqual(a.tb);
    }
    expect(new Set([...cfgs.values()].map((c) => c.set.tiebreakAt)).size, "the variants' tie-break triggers differ").toBe(cfgs.size);
    let refused = 0;
    for (const [a, eventsA] of streams) for (const [b, cfgB] of cfgs) {
      if (a === b) continue;
      expect(engineRefuses(cfgB, eventsA), `${a}'s tie-break set under ${b}`).toBe(true);
      expect(matchesRequest(tnWin(cfgB, "home", ANCHOR[a]!.path), { kind: "win", winner: ID.home, loser: ID.away, method: "regulation" }, foldT(cfgs.get(a), eventsA).state), `${a}'s state asked under ${b}'s cfg`).toBe("mismatch");
      refused++;
    }
    expect(refused).toBe(cfgs.size * (cfgs.size - 1));
    // ...and a games-only 7-6 (no tie-break block) is refused where the trigger is 6, while Fast4's trigger makes 7-6 a plain set it cannot be.
    const tour = cfgs.get("tour")!;
    expect(engineRefuses(tour, [START, { type: "tennis.set_summary", payload: { home: 7, away: 6 } }]), "7-6 without its tie-break under tour").toBe(true);
  });

  it("G8 the right answer differs from the wrong one: the match tie-break is to 10 (closest finish 10-8) and the set tie-break to 7 (7-5) - each constant is refused where the other is played, and the tie-break block is refused in the match tie-break's place", () => {
    const doubles = tnCfg("doubles-noad-mtb10");
    const tour = tnCfg("tour");
    const stream = generateStream(tnWin(doubles, "home", "tiebreakSet"));
    const deciding = stream.at(-1)!;
    const setTb = stream.find((e) => (e.payload as { tb?: unknown }).tb !== undefined)!;
    // The rulebook's: App VI's match tie-break is first to 10 points by 2; the set tie-break first to 7 by 2.
    expect(deciding.payload).toEqual({ home: 10, away: 8 });
    expect((setTb.payload as { tb: unknown }).tb).toEqual({ home: 7, away: 5 });
    let refused = 0;
    // The match tie-break's finish as an ordinary set's games (tour plays its deciding set as an ordinary set).
    const asGames = [...stream.slice(0, -1), deciding];
    expect(engineRefuses(tour, asGames), "10-8 as games under tour").toBe(true); refused++;
    // The set tie-break's finish as the match tie-break's points (target 10 not reached).
    const asMtb = [...stream.slice(0, -1), { type: deciding.type, payload: { home: 7, away: 5 } }];
    expect(engineRefuses(doubles, asMtb), "7-5 as the match tie-break under doubles").toBe(true); refused++;
    // A tie-break block in the match tie-break's place.
    const withTb = [...stream.slice(0, -1), { type: deciding.type, payload: { home: 7, away: 6, tb: { home: 7, away: 5 } } }];
    expect(() => foldT(doubles, withTb)).toThrow(/match tie-break summary carries its points in home\/away, not tb/); refused++;
    // Positive control: the long set tie-break (deuce) admits 10-8 at a target of 7, which is why the anchors are CLOSEST finishes.
    const long = [START, { type: deciding.type, payload: { home: 7, away: 6, tb: { home: 10, away: 8 } } }, { type: deciding.type, payload: { home: 7, away: 6, tb: { home: 10, away: 8 } } }];
    expect(engineRefuses(tour, long), "a deuce tie-break to 12-10").toBe(false);
    expect(refused).toBe(3);
  });

  it("G8 the final-set tie-break keeps the MATCH margin (Task 13): a short-set cfg whose deciding set plays a tie-break to 10 closes its ordinary sets at margin 1 (5-4) and its deciding set at margin 2 (10-8, never 10-9) - one cfg, both paths, each its own closest finish", () => {
    const cfg = tnCfg("short-sets", { finalSet: { tiebreakTo: 10 } });
    expect([cfg.set.tiebreakWinBy, cfg.tiebreak.winBy], "the set's own margin (1) beside the match's (2)").toEqual([1, 2]);
    const shortStream = generateStream(tnWin(cfg, "home", "shortSetTb"));
    const standardStream = generateStream(tnWin(cfg, "home", "tiebreakSet"));
    const shortFold = foldT(cfg, shortStream);
    const standardFold = foldT(cfg, standardStream);
    // The short-set tie-break win: straight sets, the last an ordinary set, closed 5-4 (a lead of ONE).
    expect(shortFold.state.sets).toHaveLength(majority(cfg.bestOf));
    expect(shortFold.state.sets.at(-1)!.tb).toEqual({ home: 5, away: 4 });
    // The tie-break set win: the deciding set reached, closed to the FINAL-SET target by two.
    expect(standardFold.state.sets).toHaveLength(cfg.bestOf);
    expect(standardFold.state.sets.at(-1)!.tb).toEqual({ home: 10, away: 8 });
    expect(tbIsClosestFinish(cfg, shortStream)).toEqual({ accepted: true, targetEdge: true, marginEdge: true });
    expect(tbIsClosestFinish(cfg, standardStream)).toEqual({ accepted: true, targetEdge: true, marginEdge: true });
    // The short set's margin is NOT carried into the deciding set: 10-9 is refused there, while a lead of one is a finished tie-break in an ordinary set.
    expect(engineRefuses(cfg, withLastTb(standardStream, 0, 1)), "10-9 in the deciding set").toBe(true);
    expect(engineRefuses(cfg, withLastTb(shortStream, 0, 0)), "5-4 in an ordinary short set").toBe(false);
    // ...and the right path under the wrong key: each stream's state is the other path's miss.
    expect(matchesRequest(tnWin(cfg, "home", "tiebreakSet"), shortFold.outcome, shortFold.state), "the short-set win asked as a tie-break set").toBe("mismatch");
    expect(matchesRequest(tnWin(cfg, "home", "shortSetTb"), standardFold.outcome, standardFold.state), "the tie-break set win asked as short-set").toBe("mismatch");
    expect(matchesRequest(tnWin(cfg, "home", "shortSetTb"), shortFold.outcome, shortFold.state)).toBe("match");
    expect(matchesRequest(tnWin(cfg, "home", "tiebreakSet"), standardFold.outcome, standardFold.state)).toBe("match");
  });

  it("tnCfg fails closed: an override key the schema drops, and a cfg the write door refuses, are refused by name instead of building the unmodified variant", () => {
    expect(() => tnCfg("tour", { bestOff: 1 }), "a misspelt key").toThrow(/dropped by the cfg schema/);
    expect(() => tnCfg("tour", { bestOf: 2 }), "a cfg the write door refuses (an even best of)").toThrow();
    expect(tnCfg("tour", { bestOf: 1 }).bestOf, "a lawful override reaches the cfg").toBe(1);
    expect(tnCfg("grand-slam", { finalSet: { tiebreakTo: 7 } }).finalSet, "a nested override reaches the cfg").toMatchObject({ tiebreakTo: 7 });
  });

  it("the witness reads the PRODUCT's state when the fold carries it: a product that never reached the path reds a stream the local fold proves, the product's state is believed over the local fold's, a right path under the wrong key reds, a plain win reds, product null falls back to the local fold, and a half or inconsistent product reds", () => {
    const double = tnCfg("short-sets", { finalSet: { tiebreakTo: 10 } });
    const triples: readonly (readonly [string, TennisCfg, DecidingPath, DecidingPath | null])[] = [
      ["tour", tnCfg("tour"), "tiebreakSet", null], ["grand-slam", tnCfg("grand-slam"), "tiebreakSet", null], ["doubles-noad-mtb10", tnCfg("doubles-noad-mtb10"), "tiebreakSet", null],
      ["fast4", tnCfg("fast4"), "shortSetTb", null], ["short-sets", tnCfg("short-sets"), "shortSetTb", null],
      ["short-sets+final tb", double, "tiebreakSet", "shortSetTb"], ["short-sets+final tb", double, "shortSetTb", "tiebreakSet"],
    ];
    let rows = 0;
    for (const [name, cfg, path, otherBuilt] of triples) {
      const at = `${name} ${path}`;
      const events = generateStream(tnWin(cfg, "home", path));
      const plain = generateStream(tnWin(cfg, "home"));
      const own = productOfFold(TENNIS, cfg, events);
      const straight = productOfFold(TENNIS, cfg, plain);
      const row = (label: string, want: boolean, local: readonly StreamEvent[], product: ProductFold | null, asked: DecidingPath = path) => {
        expect(witnessOf(TENNIS, asked, pathFoldOf(TENNIS, cfg, local, product)), `${at}: ${label}`).toBe(want);
        rows++;
      };
      row("the product's own state", true, events, own);
      row("no product: the generator's own request match reads the local fold", true, events, null);
      row("a product that never reached the path (a plain win) although the local fold did", false, events, straight);
      row("the product's state is believed over the local fold's", true, plain, own);
      row("the local fold plain and no product", false, plain, null);
      row("a plain win's own state asked as the path", false, plain, straight);
      // Right path under the wrong key: the other tennis path (where this cfg ends in the other class too, its own stream is the true one), or a path tennis lacks.
      for (const other of TN_PATHS.filter((p) => p !== path)) row(`asked as '${other}'`, false, events, own, other);
      for (const foreign of ["decidingSet", "cap", "shootout"] as const) row(`asked as '${foreign}'`, false, events, own, foreign);
      if (otherBuilt !== null) {
        const theirs = generateStream(tnWin(cfg, "home", otherBuilt));
        row(`the product reached '${otherBuilt}', not this path`, false, events, productOfFold(TENNIS, cfg, theirs));
        row(`the other path's own stream under its own key (control)`, true, theirs, productOfFold(TENNIS, cfg, theirs), otherBuilt);
      }
      // A half or inconsistent product.
      row("no summary", false, events, { summary: null, state: own.state });
      row("no state", false, events, { summary: own.summary, state: null });
      row("a state that is no object", false, events, { summary: own.summary, state: "done" });
      type SetRow = { home: number; away: number; closed?: boolean; tb?: { home: number; away: number }; mtb?: boolean };
      const withSets = (edit: (sets: SetRow[]) => void, extra?: (c: { state: { cfg: TennisCfg; outcome: { winner: string }; phase: string } }) => void): ProductFold => {
        const c = clone(own) as { summary: { detail: { sets: SetRow[] } }; state: { sets: SetRow[]; cfg: TennisCfg; outcome: { winner: string }; phase: string } };
        edit(c.state.sets);
        edit(c.summary.detail.sets);
        extra?.(c);
        return c as unknown as ProductFold;
      };
      const stripEdit = clone(own) as { summary: { detail: { sets: { home: number }[] } } };
      stripEdit.summary.detail.sets[0]!.home += 1;
      row("a summary whose set strip is not the state's", false, events, stripEdit as unknown as ProductFold);
      const noStrip = clone(own) as { summary: { detail: { sets?: unknown } } };
      delete noStrip.summary.detail.sets;
      row("a summary carrying no set strip", false, events, noStrip as unknown as ProductFold);
      const otherCfg = clone(own) as { state: { cfg: TennisCfg } };
      otherCfg.state.cfg.set.tiebreakTo += 1;
      row("a state folded under another tie-break target than the one asked", false, events, otherCfg as unknown as ProductFold);
      // Task 23 M3: each field the witness holds the state's cfg to, perturbed ALONE (a cfg equal in all the others), so a witness that
      // dropped one of them is caught by its own row and not covered for by the target row above.
      type CfgBag = Record<string, unknown> & { set: Record<string, unknown>; tiebreak: { winBy: number } };
      const perturbed = (label: string, edit: (cfg: CfgBag) => void): void => {
        const c = clone(own) as unknown as { state: { cfg: CfgBag } };
        edit(c.state.cfg);
        row(`a state folded under another ${label} than the one asked`, false, events, c as unknown as ProductFold);
      };
      perturbed("bestOf", (cfg) => { cfg.bestOf = (cfg.bestOf as number) + 2; });
      perturbed("finalSet rule", (cfg) => { cfg.finalSet = typeof cfg.finalSet === "string" ? { tiebreakTo: 9 } : "same"; });
      perturbed("match tie-break margin (tiebreak.winBy)", (cfg) => { cfg.tiebreak = { ...cfg.tiebreak, winBy: cfg.tiebreak.winBy + 1 }; });
      perturbed("set target (set.gamesTo)", (cfg) => { cfg.set = { ...cfg.set, gamesTo: (cfg.set.gamesTo as number) + 1 }; });
      perturbed("set margin (set.winBy)", (cfg) => { cfg.set = { ...cfg.set, winBy: (cfg.set.winBy as number) + 1 }; });
      perturbed("tie-break trigger (set.tiebreakAt)", (cfg) => { cfg.set = { ...cfg.set, tiebreakAt: (cfg.set.tiebreakAt as number) + 1 }; });
      const noCfg = clone(own) as { state: { cfg?: unknown } };
      delete noCfg.state.cfg;
      row("a state carrying no cfg at all", false, events, noCfg as unknown as ProductFold);
      const noMargin = clone(own) as { state: { cfg: TennisCfg } };
      if (noMargin.state.cfg.set.tiebreakWinBy !== undefined) { delete noMargin.state.cfg.set.tiebreakWinBy; row("a state folded without the short set's own margin", false, events, noMargin as unknown as ProductFold); }
      const otherWinner = clone(own) as { state: { outcome: { winner: string } } };
      otherWinner.state.outcome.winner = ID.away;
      row("a state whose own outcome names the other winner", false, events, otherWinner as unknown as ProductFold);
      row("a match not yet done", false, events, withSets(() => undefined, (c) => { c.state.phase = "live"; }));
      row("no closed set at all", false, events, withSets((sets) => { sets.length = 0; }));
      row("the last set is the loser's (home and away swapped)", false, events, withSets((sets) => { const l = sets.at(-1)!; [l.home, l.away] = [l.away, l.home]; if (l.tb !== undefined) l.tb = { home: l.tb.away, away: l.tb.home }; }));
      row("the last set ended in games alone (its tie-break dropped)", false, events, withSets((sets) => { const l = sets.at(-1)!; delete l.tb; delete l.mtb; }));
      const l0 = (clone(own) as { state: { sets: SetRow[] } }).state.sets.at(-1)!;
      if (l0.tb !== undefined) {
        row("a tie-break set whose games are not tiebreakAt+1 : tiebreakAt", false, events, withSets((sets) => { sets.at(-1)!.home += 1; }));
        row("a tie-break a point short of its target", false, events, withSets((sets) => { const l = sets.at(-1)!; l.tb = { home: l.tb!.home - 1, away: l.tb!.away - 1 }; }));
        row("a tie-break won by the other side than the set", false, events, withSets((sets) => { const l = sets.at(-1)!; l.tb = { home: l.tb!.away, away: l.tb!.home }; }));
        row("a tie-break with a lead short of the margin", false, events, withSets((sets) => { const l = sets.at(-1)!; l.tb = { home: l.tb!.home, away: l.tb!.home - 1 + (l.tb!.home - l.tb!.away === 1 ? 1 : 0) }; }));
        row("a tie-break set claiming a match tie-break as well", false, events, withSets((sets) => { sets.at(-1)!.mtb = true; }));
      } else {
        row("a match tie-break set claiming a tie-break block", false, events, withSets((sets) => { sets.at(-1)!.tb = { home: 7, away: 5 }; }));
        row("a match tie-break standing in a set that is not the deciding one", false, events, withSets((sets) => { sets.shift(); }));
      }
    }
    console.info(`G8 witness: ${rows} row(s) over ${triples.length} path win(s)`);
    expect(rows).toBeGreaterThan(triples.length * 15);
  });

  it("G8 vocabulary: ALL_OUTCOMES is still W2b's seven and nothing is known-unsupported - the new shapes run in their own sweep", () => {
    expect(ALL_OUTCOMES.map(outcomeLabel)).toEqual(["win-home", "win-away", "draw", "forfeit-away-walkover", "forfeit-home-retired", "abandon", "tie"]);
    expect(ALL_OUTCOMES).toHaveLength(7);
    expect(ALL_OUTCOMES.filter((o) => o.kind === "win" && o.path !== undefined)).toEqual([]);
    expect(KNOWN_UNSUPPORTED).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// Task 24 - G12 (a sanction that ends the match; X-SE-1, D3 (1), D12, D13).

/** The sports whose module DECLARES a sanction ending - derived from the declarations, never listed. */
const SE_SPORTS = SPORT_KEYS.filter((s) => sportModule(s).sanctionEnding !== undefined);
const seDecl = (sport: string) => sportModule(sport).sanctionEnding!;
const END_SPORTS = SE_SPORTS.filter((s) => seDecl(s).endLevels.length > 0);
const PROMPT_SPORTS = SE_SPORTS.filter((s) => seDecl(s).promptLevels.length > 0);
/** Every ending level of a sport, each with the class of the declaration it comes from. */
const endingLevels = (sport: string): { level: string; cls: "end" | "prompt" }[] =>
  [...seDecl(sport).endLevels.map((level) => ({ level, cls: "end" as const })), ...seDecl(sport).promptLevels.map((level) => ({ level, cls: "prompt" as const }))];
/** The rulebook's answer, typed ONCE (rule 19: pin what a control opens at, so the constant the right answer differs from is
 *  in the test): BD-SE-1 and TN-SE-1 end by `disqualified`; VB-SE-1 (D12) ends by the incomplete-team `retired` (VB-RT-1). */
const RULEBOOK_REASON: Readonly<Record<string, "disqualified" | "retired">> = { badminton: "disqualified", tennis: "disqualified", volleyball: "retired" };
/** Every cell a sanction ending is asked on: each sport x variant x stage kind, under the cfg the stage's fixtures fold under. */
const SE_CELLS = SE_SPORTS.flatMap((sport) => variantKeys(sport).flatMap((variant) =>
  StageKind.options.map((kind) => ({ sport, variant, kind, cfg: stageCfg(sport, resolveSportCfg(sport, variant), kind, variant) as unknown }))));
const seReq = (cell: { sport: string; kind: StageKind; cfg: unknown }, by: Side, level: string): StreamRequest => req(cell.sport, cell.cfg, cell.kind, { kind: "sanctionEnd", by, level });
const other = (s: Side): Side => (s === "home" ? "away" : "home");
const foldSE = (sport: string, cfg: unknown, events: readonly StreamEvent[]) => foldStream(sportModule(sport), cfg, ID.home, ID.away, events);
const ask = (by: Side, level: string): SanctionAsk => ({ by, level, home: ID.home, away: ID.away });
/** The code the strict fold refuses `events` with, or null when it folds. */
const refusalCode = (sport: string, cfg: unknown, events: readonly StreamEvent[]): string | null => {
  try { foldSE(sport, cfg, events); return null; } catch (e) { if (EngineError.is(e)) return e.code; throw e; }
};
/** The sanction/card/suspension controls a module's pad declares (padSpec): the engine's own list of the tokens a scorer can
 *  record - the sanction ladder of the set and nested kernels, football's cards, the period kernel's suspensions - each with the
 *  enum field that names its level and that field's values. */
function sanctionControls(sport: string): { type: string; field: string; values: readonly string[] }[] {
  const spec = sportModule(sport).padSpec?.(resolveSportCfg(sport, offlineBuilderDefault(sport)) as never);
  const out: { type: string; field: string; values: readonly string[] }[] = [];
  for (const action of spec?.panels.flatMap((p) => p.actions) ?? []) {
    if (!/\.(sanction|card|suspension\.start)$/.test(action.type)) continue;
    const field = action.fields.find((f) => f.kind === "enum" && ["level", "color", "class"].includes(f.path));
    if (field === undefined || field.kind !== "enum") throw new Error(`${sport}: ${action.type} has no level/color/class enum field`);
    out.push({ type: action.type, field: field.path, values: field.values });
  }
  return out;
}

describe("G12 a sanction that ends the match (Task 24)", () => {
  it("empty case first: the sanction-ending sports are the modules' declarations (printed with their count), each declaration is lawful, and a sport that declares none refuses every sanction ending by name", () => {
    console.info(`G12: ${SE_SPORTS.length} sanction-ending sport(s) from the modules' declarations: ${SE_SPORTS.map((s) => `${s} (end [${seDecl(s).endLevels}], prompt [${seDecl(s).promptLevels}])`).join("; ")}`);
    expect(SE_SPORTS.length).toBeGreaterThan(0);
    expect(END_SPORTS.length, "a sport with end levels").toBeGreaterThan(0);
    expect(PROMPT_SPORTS.length, "a sport with prompt levels only").toBeGreaterThan(0);
    expect(END_SPORTS.filter((s) => seDecl(s).promptLevels.length > 0), "no sport is both").toEqual([]);
    for (const sport of SE_SPORTS) {
      expect(sanctionEndingIssues(seDecl(sport)), sport).toEqual([]);
      expect(sanctionDeclOf(sport), sport).toBe(seDecl(sport));
    }
    let refused = 0;
    for (const sport of SPORT_KEYS.filter((s) => !SE_SPORTS.includes(s))) {
      expect(sanctionDeclOf(sport), sport).toBeNull();
      const cfg = stageCfg(sport, resolveSportCfg(sport, offlineBuilderDefault(sport)), "knockout", offlineBuilderDefault(sport));
      const ask = () => generateStream({ ...req(sport, cfg, "knockout", { kind: "sanctionEnd", by: "home", level: "default" }), lineups: PROBE_LINEUPS });
      expect(ask, sport).toThrow(OutcomeUnreachable);
      expect(ask, sport).toThrow(/declares no sanction that ends a match/);
      refused++;
    }
    expect(refused).toBe(SPORT_KEYS.length - SE_SPORTS.length);
    expect(refused).toBeGreaterThan(0);
  });

  it("G12 sweep: every ending level of every sanction sport, on every variant and stage kind, by both sides, is START + the sport's partial play + its own sanction + the forfeit that ends it - strict-folded to an award to the OTHER side for the reason the rulebook gives the level", () => {
    const perSport = new Map<string, number>();
    const perVariant = new Map<string, number>();
    for (const cell of SE_CELLS) {
      const decl = seDecl(cell.sport);
      for (const by of SIDES) for (const { level, cls } of endingLevels(cell.sport)) {
        const r = seReq(cell, by, level);
        const events = generateStream(r);
        const at = `${cell.sport}/${cell.variant}/${cell.kind} ${outcomeLabel(r.outcome)}`;
        // The shape: the sport's own partial play (partialPlay: START + play, undecided), the module's sanction event, the ending.
        const play = partialPlay(r);
        expect(events.slice(0, play.length), at).toEqual(play);
        expect(events.slice(play.length), at).toEqual([
          { type: decl.eventType, payload: { by: ID[by], level } },
          { type: "core.forfeit", payload: { by: ID[by], reason: RULEBOOK_REASON[cell.sport] } },
        ]);
        // The rulebook's reason is the engine's D13 rule's answer, and no other reason is (the differential: the wrong reason is refused).
        expect(endingReasonOf(cell.sport, level), at).toBe(RULEBOOK_REASON[cell.sport]);
        for (const reason of FORFEIT_REASONS) {
          expect(scorerMayForfeit(sportModule(cell.sport), { type: decl.eventType, payload: { by: ID[by], level } }, { by: ID[by], reason }), `${at} reason ${reason} (${cls})`).toBe(reason === RULEBOOK_REASON[cell.sport]);
        }
        // Strict fold: undecided on the sanction alone, an award to the other side with the reason after the ending.
        expect(foldSE(cell.sport, cell.cfg, events.slice(0, -1)).outcome, at).toBeNull();
        const folded = foldSE(cell.sport, cell.cfg, events);
        expect(folded.outcome, at).toEqual({ kind: "award", winner: ID[other(by)], loser: ID[by], reason: RULEBOOK_REASON[cell.sport] });
        expect(matchesRequest(r, folded.outcome, folded.state), at).toBe("match");
        perSport.set(cell.sport, (perSport.get(cell.sport) ?? 0) + 1);
        const vk = `${cell.sport}/${cell.variant}`;
        perVariant.set(vk, (perVariant.get(vk) ?? 0) + 1);
      }
    }
    console.info(`G12 sweep: ${[...perSport].map(([k, n]) => `${k} ${n}`).join(", ")}`);
    for (const sport of SE_SPORTS) expect(perSport.get(sport) ?? 0, `${sport} sanction endings`).toBeGreaterThan(0);
    for (const sport of SE_SPORTS) for (const variant of variantKeys(sport)) expect(perVariant.get(`${sport}/${variant}`) ?? 0, `${sport}/${variant}`).toBeGreaterThan(0);
    expect(perSport.size).toBe(SE_SPORTS.length);
  });

  it("the ending is pending (X-SE-1): after an END level nothing but the forfeit or an abandon folds - ENDING_SANCTION_PENDING for a rally, and a prompt level (volleyball) leaves the match open to play on", () => {
    let ended = 0;
    let prompted = 0;
    for (const cell of SE_CELLS.filter((c) => c.kind === "knockout" || c.kind === "league")) {
      for (const { level, cls } of endingLevels(cell.sport)) {
        const r = seReq(cell, "home", level);
        const events = generateStream(r);
        const play = partialPlay(r);
        const sanctioned = events.slice(0, -1);
        const rally = play.at(-1)!; // a scoring event of the sport: the partial's own last
        const at = `${cell.sport}/${cell.variant}/${cell.kind} ${level}`;
        if (cls === "end") {
          expect(refusalCode(cell.sport, cell.cfg, [...sanctioned, rally]), `${at} then a scoring event`).toBe("ENDING_SANCTION_PENDING");
          expect(refusalCode(cell.sport, cell.cfg, [...sanctioned, { type: "core.abandon", payload: { reason: "x" } }]), `${at} then an abandon`).toBeNull();
          expect(foldSE(cell.sport, cell.cfg, events).outcome?.kind, at).toBe("award");
          ended++;
        } else {
          // A prompt level: the match plays on, and only the forfeit's retired reason ends it (VB-SE-1: "no" to "can the team still field six?").
          expect(refusalCode(cell.sport, cell.cfg, [...sanctioned, rally]), `${at} then a scoring event`).toBeNull();
          expect(foldSE(cell.sport, cell.cfg, sanctioned).outcome, at).toBeNull();
          prompted++;
        }
      }
    }
    console.info(`G12 pending: ${ended} end-level and ${prompted} prompt-level stream(s) checked`);
    expect(ended).toBeGreaterThan(0);
    expect(prompted).toBeGreaterThan(0);
  });

  it("a non-ending sanction never ends a stream: every other level of every sanction, card and suspension control the pads declare folds undecided and takes play on, and a sanction ending at it is refused BY NAME", () => {
    let tokens = 0;
    let refused = 0;
    const sports = SPORT_KEYS.filter((s) => sanctionControls(s).length > 0);
    for (const sport of sports) {
      const variant = offlineBuilderDefault(sport);
      const cfg = stageCfg(sport, resolveSportCfg(sport, variant), "league", variant);
      const gen = STREAM_GENERATORS[sport]!;
      const play = partialPlay({ sportKey: sport, cfg, stageKind: "league", home: ID.home, away: ID.away, outcome: { kind: "forfeit", by: "home", reason: "retired", at: "after_start" } });
      const ends = new Set(sportModule(sport).sanctionEnding?.endLevels ?? []);
      for (const control of sanctionControls(sport)) {
        for (const value of control.values.filter((v) => !ends.has(v))) {
          const token: StreamEvent = { type: control.type, payload: { by: ID.home, [control.field]: value } };
          expect(foldSE(sport, cfg, [...play, token]).outcome, `${sport} ${control.type} ${value}`).toBeNull();
          // And play goes on: the sport's own partial scoring event after it folds (nothing is pending).
          expect(refusalCode(sport, cfg, [...play, token, gen.partial({ sportKey: sport, cfg, stageKind: "league", home: ID.home, away: ID.away, outcome: { kind: "abandon" } })[0]!]), `${sport} ${control.type} ${value} then play`).toBeNull();
          tokens++;
          if (control.type === sportModule(sport).sanctionEnding?.eventType) {
            // A level the declaration does not end on (a record, or a prompt level whose ending the question gates): by name.
            const dueEnding = endingReasonOf(sport, value) !== null;
            const attempt = () => generateStream({ ...req(sport, cfg, "league", { kind: "sanctionEnd", by: "home", level: value }), lineups: PROBE_LINEUPS });
            if (dueEnding) { expect(attempt, `${sport} ${value}`).not.toThrow(); } else { expect(attempt, `${sport} ${value}`).toThrow(OutcomeUnreachable); expect(attempt, `${sport} ${value}`).toThrow(/ends nothing here/); refused++; }
          }
        }
      }
    }
    console.info(`G12 non-ending: ${tokens} token(s) over ${sports.length} sport(s) [${sports}], ${refused} sanction ending(s) refused by name`);
    expect(sports.length).toBeGreaterThan(SE_SPORTS.length); // the cards and suspensions of sports with no ending count too
    expect(tokens).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    // A level the sport's pad does not declare at all is no sanction: refused by name too.
    const cfg = stageCfg("badminton", resolveSportCfg("badminton", offlineBuilderDefault("badminton")), "league", offlineBuilderDefault("badminton"));
    expect(() => generateStream(req("badminton", cfg, "league", { kind: "sanctionEnd", by: "home", level: "no-such-level" }))).toThrow(/ends nothing here/);
  });

  it("the sanction ending decides the same drive as a forfeit would, as an AWARD: levelKindOf plays no level result for it (the decision for the former silent null), over every sanction sport", () => {
    let checked = 0;
    for (const cell of SE_CELLS.filter((c) => c.kind === "knockout")) {
      for (const { level } of endingLevels(cell.sport)) {
        const r = seReq(cell, "away", level);
        const events = generateStream(r);
        expect(foldSE(cell.sport, cell.cfg, events).outcome?.kind, `${cell.sport}/${cell.variant}`).toBe("award");
        expect(levelKindOf(cell.sport, cell.cfg, ID.home, ID.away, r.outcome, events), `${cell.sport}/${cell.variant}/${level}`).toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("matchesRequest judges a sanction ending on the outcome AND the state: a plain forfeit, the other side, the other reason, another level, a state that ended another way - each is a mismatch; a request handed no state is refused by name", () => {
    let rows = 0;
    for (const cell of SE_CELLS.filter((c) => c.kind === "knockout")) {
      for (const { level } of endingLevels(cell.sport)) {
        const by: Side = "home";
        const r = seReq(cell, by, level);
        const events = generateStream(r);
        const good = foldSE(cell.sport, cell.cfg, events);
        const reason = RULEBOOK_REASON[cell.sport]!;
        const at = `${cell.sport}/${cell.variant}/${level}`;
        const row = (name: string, outcome: unknown, state: unknown, want: "match" | "mismatch") => { expect(matchesRequest(r, outcome as never, state), `${at}: ${name}`).toBe(want); rows++; };
        row("control: the stream's own fold", good.outcome, good.state, "match");
        row("no outcome yet", null, good.state, "mismatch");
        row("a win", { kind: "win", winner: ID.away, loser: ID.home, method: "regulation" }, good.state, "mismatch");
        row("an award to the sanctioned side", { kind: "award", winner: ID.home, loser: ID.away, reason }, good.state, "mismatch");
        row("an award for another reason", { kind: "award", winner: ID.away, loser: ID.home, reason: reason === "retired" ? "disqualified" : "retired" }, good.state, "mismatch");
        row("a walkover award", { kind: "award", winner: ID.away, loser: ID.home, reason: "walkover" }, good.state, "mismatch");
        // Each side of the award is held on its own: a winner nobody seated, and a loser the award does not name.
        row("an award whose winner is neither entrant (the loser is right)", { kind: "award", winner: "stranger", loser: ID.home, reason }, good.state, "mismatch");
        row("an award with no loser (a bye's shape)", { kind: "award", winner: ID.away, loser: null, reason }, good.state, "mismatch");
        // A plain forfeit with the same reason: same outcome, but no sanction on the state's record.
        const plain = foldSE(cell.sport, cell.cfg, [...partialPlay(r), { type: "core.forfeit", payload: { by: ID.home, reason } }]);
        row("a plain forfeit with the same reason (no sanction on record)", plain.outcome, plain.state, "mismatch");
        const st = (edit: (s: { sanctions: { by: string; level: string }[]; phase: string; outcome: { reason: string }; entrants: { home: string; away: string } }) => void): unknown => { const c = clone(good.state) as never; edit(c); return c; };
        row("a state that seats the entrants the other way round (its `home` is not this match's home)", good.outcome, st((s) => { s.entrants = { home: ID.away, away: ID.home }; }), "mismatch");
        row("the sanction recorded against the other side", good.outcome, st((s) => { s.sanctions[s.sanctions.length - 1]!.by = "away"; }), "mismatch");
        row("the sanction at another level", good.outcome, st((s) => { s.sanctions[s.sanctions.length - 1]!.level = "warning"; }), "mismatch");
        row("no sanction on the state", good.outcome, st((s) => { s.sanctions = []; }), "mismatch");
        row("a state with no sanctions key", good.outcome, st((s) => { delete (s as { sanctions?: unknown }).sanctions; }), "mismatch");
        row("a state not done", good.outcome, st((s) => { s.phase = "live"; }), "mismatch");
        row("a state whose own outcome is another reason", good.outcome, st((s) => { s.outcome.reason = reason === "retired" ? "disqualified" : "retired"; }), "mismatch");
        row("a state that is no object", good.outcome, "done", "mismatch");
        expect(() => matchesRequest(r, good.outcome), at).toThrow(/is witnessed on the folded state/);
      }
    }
    console.info(`G12 witness (local): ${rows} row(s)`);
    expect(rows).toBeGreaterThan(SE_SPORTS.length * 10);
  });

  it("the witness's two entry points: local evidence and PRODUCT evidence are named, and a product check reads the product's state alone - a clean local fold beside a product that never recorded the sanction fails", () => {
    let checked = 0;
    for (const sport of SE_SPORTS) {
      const variant = offlineBuilderDefault(sport);
      const cfg = stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant);
      for (const { level } of endingLevels(sport)) {
        const r = req(sport, cfg, "knockout", { kind: "sanctionEnd", by: "away", level });
        const events = generateStream(r);
        const good = foldSE(sport, cfg, events);
        const plain = foldSE(sport, cfg, [...partialPlay(r), { type: "core.forfeit", payload: { by: ID.away, reason: RULEBOOK_REASON[sport] } }]);
        const productOf = (state: unknown): ProductFold => clone({ summary: sportModule(sport).summary(good.state as never), state }) as ProductFold;
        const fold = (evidence: SanctionFold["evidence"], outcome: SanctionFold["outcome"] = good.outcome as SanctionFold["outcome"]): SanctionFold => ({ sportKey: sport, outcome, evidence });
        expect(sanctionEndWitness(fold(localEvidence(good.state)), ask("away", level)), `${sport} ${level} local`).toBe(true);
        expect(sanctionEndWitness(fold(productEvidence(productOf(good.state))), ask("away", level)), `${sport} ${level} product`).toBe(true);
        // The product recorded a plain forfeit (no sanction): its outcome is the award, its state is not the sanction's.
        expect(sanctionEndWitness(fold(productEvidence(productOf(plain.state))), ask("away", level)), `${sport} ${level} product without the sanction`).toBe(false);
        expect(sanctionEndWitness(fold(productEvidence(productOf(null))), ask("away", level)), `${sport} ${level} product state null`).toBe(false);
        // The same sanction asked of the other side.
        expect(sanctionEndWitness(fold(productEvidence(productOf(good.state))), ask("home", level)), `${sport} ${level} other side`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(SE_SPORTS.length - 1);
  });

  it("G12 vocabulary: ALL_OUTCOMES is still W2b's seven, the label is sanction-<by>-<level>, and nothing is known-unsupported - the new shape runs in its own sweep", () => {
    expect(ALL_OUTCOMES.map(outcomeLabel)).toEqual(["win-home", "win-away", "draw", "forfeit-away-walkover", "forfeit-home-retired", "abandon", "tie"]);
    expect(ALL_OUTCOMES).toHaveLength(7);
    expect(ALL_OUTCOMES.filter((o) => o.kind === "sanctionEnd")).toEqual([]);
    expect(outcomeLabel({ kind: "sanctionEnd", by: "home", level: "default" })).toBe("sanction-home-default");
    expect(KNOWN_UNSUPPORTED).toEqual([]);
    expect(sanctionToken("tennis", "e1", "default")).toEqual({ type: "tennis.sanction", payload: { by: "e1", level: "default" } });
    expect(() => sanctionToken("football", "e1", "red")).toThrow(/declares no sanction event/);
  });

  it("endingReasonOf refuses a declaration that names a level as BOTH an end and a prompt level (two endings admitted), by sport, level and both reasons; a lawful level answers one reason and an unnamed level none (counted)", () => {
    // The synthetic module is the real badminton one with its declaration's `black` level in both lists, so the engine's D13 rule
    // (scorerMayForfeit) admits `disqualified` (end level) AND `retired` (prompt level) after the same sanction.
    const admitted = FORFEIT_REASONS.filter((reason) => scorerMayForfeit(sportModule(TWICE_DECLARED), { type: "badminton.sanction", payload: { by: "side", level: "black" } }, { by: "side", reason }));
    expect(admitted, "premise: the engine's own rule admits two endings after that level").toEqual(["retired", "disqualified"]);
    expect(() => endingReasonOf(TWICE_DECLARED, "black")).toThrow(/twice-declared-sanction's 'black' sanction admits several endings \(retired, disqualified\)/);
    // The same synthetic module at a level it names nowhere: no ending, no throw (the guard is the two-reasons case, not every call).
    expect(endingReasonOf(TWICE_DECLARED, "a-level-nothing-names")).toBeNull();
    // The real declarations are single-valued at every level they name: the guard does not fire on them (counted).
    let judged = 0;
    for (const sport of SE_SPORTS) for (const level of [...seDecl(sport).endLevels, ...seDecl(sport).promptLevels]) {
      expect(() => endingReasonOf(sport, level), `${sport} ${level}`).not.toThrow();
      judged++;
    }
    expect(judged).toBeGreaterThan(0);
  });
});
