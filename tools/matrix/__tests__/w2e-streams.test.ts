// W2e Tasks 19–24 (A3; spec §10, D9; INV §5 G1–G8, G12): generator breadth, one stream per task, each sweep titled with
// its G-id. Every stream is folded STRICTLY through the real module (lib/fold.ts, strictFromSeq 1). What decided it is
// read from the engine's own declarations — the module's decider rule keys (`deciderKeysFor`) and `reachableDecidedIn`,
// `decidedInFor` over its win-method table, the shoot-out order the module binds (`footballNextKicker`) — never from the
// generators. Every sweep counts what it checked, per sport and per variant, and zero is a failure (TEST-STRATEGY
// anti-vacuity). `ALL_OUTCOMES` stays frozen: the new shapes run here, in their own sweeps (spec §10).
import { decidedInFor } from "@seazn/engine/competition";
import { StageKind } from "@seazn/engine/core";
import { checkFixtureOverride, deciderKeysFor } from "@seazn/engine/sport";
import { football, footballNextKicker, type ShootoutKick } from "@seazn/engine/sports/football";
import { describe, expect, it, vi } from "vitest";
import { mergeRulesOverride } from "../../../apps/web/src/server/engine-db/fixture-cfg.ts";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { foldStream } from "../lib/fold.ts";
import { resolveSportCfg, sportModule, stageCfg, variantKeys } from "../lib/sport-cfg.ts";
import { STREAM_GENERATORS, generateStream, matchesRequest } from "../lib/streams/index.ts";
import { KNOWN_UNSUPPORTED } from "../lib/streams/known-unsupported.ts";
import {
  ALL_OUTCOMES, DECIDING_PATHS, GeneratorUnsupported, OutcomeUnreachable, outcomeLabel,
  type DecidingPath, type RequestedOutcome, type Side, type StreamRequest,
} from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";

// The product's own override merge lives in a `server-only` file that reaches its siblings by the app's `@/` alias, neither of
// which the matrix's vitest (no config of its own) resolves: both are stubbed to the REAL thing, so `mergeRulesOverride` below
// is the product's function, not a copy (Task 20 M1).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stage-decider-off", async () => await import("../../../apps/web/src/lib/stage-decider-off.ts"));

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

  it("G12 is Task 24's: until it lands, generateStream refuses a sanctionEnd by name and matchesRequest throws by name — it never answers", () => {
    let checked = 0;
    for (const sportKey of SPORT_KEYS) {
      const r = req(sportKey, resolveSportCfg(sportKey, offlineBuilderDefault(sportKey)), "league", { kind: "sanctionEnd", by: "home", level: "x" });
      expect(() => generateStream(r), sportKey).toThrow(GeneratorUnsupported);
      expect(() => generateStream(r), sportKey).toThrow(/Task 24/);
      for (const outcome of [null, { kind: "award", winner: ID.away, loser: ID.home, reason: "disqualified" }] as const) {
        expect(() => matchesRequest(r, outcome as never), `${sportKey} ${JSON.stringify(outcome)}`).toThrow(/Task 24/);
      }
      checked++;
    }
    expect(checked).toBe(SPORT_KEYS.length);
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
